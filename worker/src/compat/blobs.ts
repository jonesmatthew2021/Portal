import { getEnv } from "../env.js";

/**
 * The named-blob-store surface the ported code uses, re-spoken over D1.
 *
 * Every named store the earlier build kept JSON in — certificate readings,
 * matrix readings, job records, held answers — asked for strong consistency:
 * a record is read back the instant after it is written, usually by a poll
 * loop. D1 gives exactly that, so the records live in one `blobs` table keyed
 * by (store, key) and this wrapper keeps the call sites unchanged.
 *
 * Only what the portal actually calls is here: get (json / text /
 * arrayBuffer), set, setJSON, delete, getMetadata, list({ prefix }).
 * File bytes never come through this — they have their own store
 * (src/files/store.ts).
 */

type GetOpts = { type?: "json" | "text" | "arrayBuffer" };

export type BlobStore = {
  get(key: string, opts?: GetOpts): Promise<unknown>;
  set(key: string, value: string | ArrayBuffer): Promise<void>;
  setJSON(
    key: string,
    value: unknown,
    opts?: { onlyIfMatch?: string },
  ): Promise<{ modified: boolean; etag: string | null }>;
  delete(key: string): Promise<void>;
  getMetadata(key: string): Promise<{ key: string } | null>;
  getWithMetadata(
    key: string,
    opts?: GetOpts,
  ): Promise<{ data: unknown; etag: string } | null>;
  list(opts?: { prefix?: string }): Promise<{ blobs: { key: string }[] }>;
};

export function getStore(opts: { name: string; consistency?: string } | string): BlobStore {
  const store = typeof opts === "string" ? opts : opts.name;
  const d1 = () => getEnv().DB;

  const read = async (key: string) => {
    const row = await d1()
      .prepare("SELECT value FROM blobs WHERE store = ?1 AND key = ?2")
      .bind(store, key)
      .first<{ value: string }>();
    return row ? row.value : null;
  };

  // Every write stamps a fresh etag — the version mark the conditional write
  // below compares against, which is what makes two racing job claims settle
  // to exactly one winner.
  const write = async (key: string, value: string) => {
    const etag = crypto.randomUUID();
    await d1()
      .prepare(
        "INSERT INTO blobs (store, key, value, updated_at, etag) VALUES (?1, ?2, ?3, ?4, ?5) " +
          "ON CONFLICT (store, key) DO UPDATE SET value = ?3, updated_at = ?4, etag = ?5",
      )
      .bind(store, key, value, Date.now(), etag)
      .run();
    return etag;
  };

  // The compare-and-swap the earlier blob store offered: the row only moves if it
  // still carries the etag the caller read. D1 runs the statement atomically,
  // so of two racers only one can find the etag standing. A row written
  // before etags existed carries none; the stand-in getWithMetadata hands
  // out for it matches exactly that, so such a row can still be taken.
  const writeIfMatch = async (key: string, value: string, onlyIfMatch: string) => {
    const etag = crypto.randomUUID();
    const res = await d1()
      .prepare(
        "UPDATE blobs SET value = ?3, updated_at = ?4, etag = ?5 " +
          "WHERE store = ?1 AND key = ?2 AND (etag = ?6 OR (etag IS NULL AND ?6 = 'pre-etag'))",
      )
      .bind(store, key, value, Date.now(), etag, onlyIfMatch)
      .run();
    const modified = (res.meta?.changes ?? 0) > 0;
    return { modified, etag: modified ? etag : null };
  };

  return {
    async get(key, o) {
      const value = await read(key);
      if (value == null) return null;
      if (o?.type === "json") {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }
      if (o?.type === "arrayBuffer") return new TextEncoder().encode(value).buffer;
      return value;
    },
    async set(key, value) {
      const text =
        typeof value === "string" ? value : new TextDecoder().decode(new Uint8Array(value));
      await write(key, text);
    },
    async setJSON(key, value, opts) {
      if (opts?.onlyIfMatch) return await writeIfMatch(key, JSON.stringify(value), opts.onlyIfMatch);
      return { modified: true, etag: await write(key, JSON.stringify(value)) };
    },
    async delete(key) {
      await d1()
        .prepare("DELETE FROM blobs WHERE store = ?1 AND key = ?2")
        .bind(store, key)
        .run();
    },
    async getMetadata(key) {
      const row = await d1()
        .prepare("SELECT key FROM blobs WHERE store = ?1 AND key = ?2")
        .bind(store, key)
        .first<{ key: string }>();
      return row ? { key: row.key } : null;
    },
    async getWithMetadata(key, o) {
      const row = await d1()
        .prepare("SELECT value, etag FROM blobs WHERE store = ?1 AND key = ?2")
        .bind(store, key)
        .first<{ value: string; etag: string | null }>();
      if (!row) return null;
      let data: unknown = row.value;
      if (o?.type === "json") {
        try {
          data = JSON.parse(row.value);
        } catch {
          data = null;
        }
      }
      // A row written before etags existed gets one lazily-shaped stand-in;
      // the next write stamps a real one.
      return { data, etag: row.etag || "pre-etag" };
    },
    async list(o) {
      const prefix = (o && o.prefix) || "";
      const rows = await d1()
        .prepare("SELECT key FROM blobs WHERE store = ?1 AND key LIKE ?2 || '%'")
        .bind(store, prefix)
        .all<{ key: string }>();
      return { blobs: (rows.results || []).map((r) => ({ key: r.key })) };
    },
  };
}
