import { getEnv } from "../env.js";

/**
 * The @netlify/blobs surface the ported code uses, re-spoken over D1.
 *
 * Every named store the Netlify build kept JSON in — certificate readings,
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
  setJSON(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  getMetadata(key: string): Promise<{ key: string } | null>;
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

  const write = async (key: string, value: string) => {
    await d1()
      .prepare(
        "INSERT INTO blobs (store, key, value, updated_at) VALUES (?1, ?2, ?3, ?4) " +
          "ON CONFLICT (store, key) DO UPDATE SET value = ?3, updated_at = ?4",
      )
      .bind(store, key, value, Date.now())
      .run();
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
    async setJSON(key, value) {
      await write(key, JSON.stringify(value));
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
