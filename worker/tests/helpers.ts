/**
 * The fakes the worker's tests stand on: a database that answers from a
 * table of statements, an R2 bucket in memory, a whole portal over the two,
 * and Microsoft Graph answered by hand. Lifted out of round.test.ts so the
 * sync tests (sync.test.ts) can stand on the same ground.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------------ *
 * A D1 that answers from a table of statements.
 *
 * `answer` is given the SQL and its bound values and hands back what the
 * real database would: rows for a select, a change count for a write. What
 * it is not asked about it refuses, so a test cannot pass on a query nobody
 * thought about. Drizzle's own reads go through .raw(), which is refused
 * outright - the code under test reads with plain statements.
 * ------------------------------------------------------------------------ */
export type Answer = { results?: unknown[]; changes?: number; columns?: string[] };
export type Asked = { sql: string; args: unknown[] };

export function fakeDb(answer: (sql: string, args: unknown[]) => Answer | undefined, asked: Asked[] = []) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => stmt(sql, next),
    async all() {
      asked.push({ sql, args });
      const a = answer(sql, args);
      if (!a) throw new Error("the test's database was not told how to answer: " + sql.slice(0, 80));
      return { results: a.results || [], meta: { changes: a.changes || 0 } };
    },
    async first() {
      const { results } = await this.all();
      return results[0] ?? null;
    },
    async run() {
      asked.push({ sql, args });
      const a = answer(sql, args);
      if (!a) throw new Error("the test's database was not told how to answer: " + sql.slice(0, 80));
      return { results: a.results || [], meta: { changes: a.changes || 0 } };
    },
    /* Drizzle reads rows by position, in the order the statement names the
       columns; an answer that names them (drizzleOn, below) is laid out
       that way, and one that does not is refused. */
    async raw() {
      asked.push({ sql, args });
      const a = answer(sql, args);
      if (!a) throw new Error("the test's database was not told how to answer: " + sql.slice(0, 80));
      if (!a.columns) throw new Error("drizzle asked for rows by position and the answer named no columns: " + sql.slice(0, 80));
      return (a.results || []).map((r) => a.columns!.map((c) => (r as Record<string, unknown>)[c]));
    },
  });
  return {
    prepare: (sql: string) => stmt(sql),
    async batch(stmts: { run(): Promise<unknown> }[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    asked,
  };
}

/* ------------------------------------------------------------------------ *
 * Drizzle's own SQL, for the sync and the file routes, which read and write
 * the documents table through the ORM. The shapes it uses are few - a
 * select whose where is "col = ?", "is null" and "is not null" joined by
 * and, with an order by and a limit; an update by id, with or without
 * returning; a delete by id; an insert - so they are read here against the
 * same rows the plain statements answer from, rather than refused.
 * ------------------------------------------------------------------------ */
export type Row = Record<string, unknown>;
const camel = (c: string) => c.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase());
export function drizzleOn(rows: Row[]) {
  const cols = (list: string) => [...list.matchAll(/"(\w+)"/g)].map((m) => camel(m[1]));
  return (sql: string, args: unknown[]): Answer | undefined => {
    const a = [...args];
    const where = (clause: string | undefined) => {
      const tests = clause ? clause.replace(/[()]/g, "").split(" and ") : [];
      const checks = tests.map((t): ((r: Row) => boolean) => {
        const m = /^"documents"\."(\w+)" (= \?|is null|is not null)$/.exec(t.trim());
        if (!m) throw new Error("the test's database cannot read: " + t);
        const col = camel(m[1]);
        if (m[2] === "= ?") { const v = a.shift(); return (r) => r[col] === v; }
        return m[2] === "is null" ? (r) => r[col] == null : (r) => r[col] != null;
      });
      return (r: Row) => checks.every((c) => c(r));
    };
    let m: RegExpExecArray | null;
    if ((m = /^select (.+?) from "documents"(?: where (.+?))?(?: order by "documents"\."(\w+)" (asc|desc))?( limit \?)?$/.exec(sql))) {
      const columns = cols(m[1]);
      let out = rows.filter(where(m[2]));
      if (m[3]) {
        const col = camel(m[3]);
        const sign = m[4] === "desc" ? -1 : 1;
        out = [...out].sort((x, y) => (Number(x[col] ?? 0) - Number(y[col] ?? 0)) * sign);
      }
      if (m[5]) out = out.slice(0, Number(a.shift()));
      return { results: out, columns };
    }
    if ((m = /^update "documents" set (.+?) where "documents"\."id" = \?(?: returning (.+))?$/.exec(sql))) {
      const sets = cols(m[1]);
      const values = sets.map(() => a.shift());
      const id = a.shift();
      const row = rows.find((r) => r.id === id);
      if (row) sets.forEach((c, i) => { row[c] = values[i]; });
      return m[2] ? { results: row ? [row] : [], columns: cols(m[2]), changes: row ? 1 : 0 } : { changes: row ? 1 : 0 };
    }
    if (/^delete from "documents" where "documents"\."id" = \?$/.test(sql)) {
      const i = rows.findIndex((r) => r.id === a[0]);
      if (i >= 0) rows.splice(i, 1);
      return { changes: i >= 0 ? 1 : 0 };
    }
    if ((m = /^insert into "documents" \((.+?)\) values \((.+?)\)(?: returning (.+))?$/.exec(sql))) {
      const names = cols(m[1]);
      const slots = m[2].split(", ");
      const row: Row = {};
      names.forEach((c, i) => { row[c] = slots[i] === "?" ? a.shift() : null; });
      rows.push(row);
      return m[3] ? { results: [row], columns: cols(m[3]), changes: 1 } : { changes: 1 };
    }
    return undefined;
  };
}

/* ------------------------------------------------------------------------ *
 * An R2 bucket in memory, which is what fileStore() drives when FILE_STORE
 * is "r2". It writes down every folder a write would have had to make -
 * the office's library is SharePoint, where a write into a folder that is
 * not there makes the folder, and the portal is not allowed to make one.
 * `failOn` makes the nth write throw, for the tests that pull the floor
 * out halfway through.
 * ------------------------------------------------------------------------ */
export function fakeBucket(seed: Record<string, string>, folders: string[] = ["opms", "removed"]) {
  const bytes = new Map<string, Uint8Array>();
  const have = new Set(folders);
  const made: string[] = [];
  let writes = 0;
  const enc = new TextEncoder();
  Object.entries(seed).forEach(([k, v]) => bytes.set(k, enc.encode(v)));
  const bucket = {
    made,
    failOn: 0,
    puts: () => writes,
    text: (key: string) => { const b = bytes.get(key); return b ? new TextDecoder().decode(b) : null; },
    keys: () => [...bytes.keys()].sort(),
    async get(key: string) {
      const b = bytes.get(key);
      return b ? { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, body: null } : null;
    },
    async put(key: string, value: ArrayBuffer | Uint8Array) {
      writes++;
      if (bucket.failOn && writes === bucket.failOn) throw new Error("the library refused the write");
      const folder = key.split("/").slice(0, -1).join("/");
      if (folder && !have.has(folder)) { have.add(folder); made.push(folder); }
      bytes.set(key, new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value)));
    },
    async delete(key: string) { bytes.delete(key); },
    async head(key: string) { const b = bytes.get(key); return b ? { size: b.length } : null; },
    async list(opts: { prefix?: string }) {
      const objects = [...bytes.entries()]
        .filter(([k]) => k.startsWith(opts.prefix || ""))
        .map(([k, v]) => ({ key: k, size: v.length, uploaded: new Date(0) }));
      return { objects, truncated: false };
    },
  };
  return bucket;
}

/* A live row of the office's workbook, the shape the documents table holds. */
export const liveRow = (id: string, key: string, adopted = 0) => ({
  id, category: "training-matrix", bucket: null, blobKey: key, filename: key.split("/").pop(),
  contentType: null, sizeBytes: 3, title: null, uploadedBy: "the office", tag: null, source: null,
  party: null, rank: null, swing: null, filedOn: "2026-09-01", sessionId: null, person: null,
  folder: null, qualCode: null, expiresOn: null, checksum: null, createdAt: 1, removedAt: null,
  removedBy: null, adoptedFromFolder: adopted, keptInPlace: null,
});

/* A removed row of the office's own workbook, kept where the office put it. */
export const keptRow = (id: string, key: string) => ({ ...liveRow(id, key, 1), removedAt: 5, keptInPlace: 1 });

export const bytesOf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

/** A whole portal: the shared document, the file rows, the readings, the
 *  named stores - stateful, so a second round sees what the first left.
 *  Store rows are keyed "store|key". */
export function portalDb(doc: Record<string, unknown>, rows: Record<string, unknown>[], readings: Record<string, unknown>, users: Record<string, unknown>[] = []) {
  const state = { data: JSON.stringify(doc), rev: 1 };
  // Whether the portal_state row is there at all: a wiped database has none.
  const stateRow = { present: true };
  const blobs = new Map<string, string>();
  // The version mark the store stamps on every write, for the lease's take.
  const etags = new Map<string, string>();
  Object.entries(readings).forEach(([k, v]) => blobs.set("certificate-readings|" + k, JSON.stringify(v)));
  const drizzle = drizzleOn(rows);
  const db = fakeDb((sql, args) => {
    if (/PRAGMA table_info/.test(sql)) return { results: [{ name: "adopted_from_folder" }, { name: "kept_in_place" }, { name: "evidence_kind" }, { name: "named_by_portal" }] };
    if (/SELECT data, rev FROM portal_state/.test(sql)) return { results: stateRow.present ? [{ ...state }] : [] };
    // The restore's seed of an empty row where there is none.
    if (sql === "INSERT INTO portal_state (id, data, rev, updated_at) VALUES (?1, '{}', 0, ?2) ON CONFLICT (id) DO NOTHING") {
      if (stateRow.present) return { changes: 0 };
      stateRow.present = true; state.data = "{}"; state.rev = 0;
      return { changes: 1 };
    }
    if (/SELECT data FROM portal_state/.test(sql)) return { results: [{ data: state.data }] };
    if (/SELECT folder, blob_key AS blobKey FROM documents/.test(sql)) {
      return { results: rows.filter((r) => r.category === "certificate" && !r.removedAt && r.folder).map((r) => ({ folder: r.folder, blobKey: r.blobKey })) };
    }
    if (/SELECT value, etag FROM blobs WHERE store = \?1 AND key = \?2/.test(sql)) {
      const v = blobs.get(args[0] + "|" + args[1]);
      return { results: v === undefined ? [] : [{ value: v, etag: etags.get(args[0] + "|" + args[1]) ?? null }] };
    }
    if (/^UPDATE blobs SET value = \?3/.test(sql)) {
      const k = args[0] + "|" + args[1];
      // A row written before etags existed matches the store's stand-in for one.
      const mark = etags.get(k);
      const matches = mark === args[5] || (mark === undefined && args[5] === "pre-etag");
      if (!blobs.has(k) || !matches) return { changes: 0 };
      blobs.set(k, String(args[2])); etags.set(k, String(args[4]));
      return { changes: 1 };
    }
    if (/UPDATE portal_state SET data/.test(sql)) {
      if (!stateRow.present || args[3] !== state.rev) return { changes: 0 };
      state.data = String(args[1]); state.rev++;
      return { changes: 1 };
    }
    if (/CREATE TABLE IF NOT EXISTS portal_state_history/.test(sql)) return { changes: 0 };
    if (/FROM portal_state_history/.test(sql)) return { results: [] };
    if (/portal_state_history/.test(sql)) return { changes: 1 };
    if (/SELECT value FROM blobs WHERE store = \?1 AND key = \?2/.test(sql)) {
      const v = blobs.get(args[0] + "|" + args[1]);
      return { results: v === undefined ? [] : [{ value: v }] };
    }
    if (/SELECT key, value FROM blobs WHERE store = \?1/.test(sql)) {
      return { results: [...blobs.entries()].filter(([k]) => k.startsWith(args[0] + "|")).map(([k, value]) => ({ key: k.slice(k.indexOf("|") + 1), value })) };
    }
    // The reading store's listing, which the certificate reading opens with.
    if (/SELECT key FROM blobs WHERE store = \?1 AND key LIKE/.test(sql)) {
      return { results: [...blobs.keys()].filter((k) => k.startsWith(args[0] + "|" + args[1])).map((k) => ({ key: k.slice(k.indexOf("|") + 1) })) };
    }
    // The refile's label: whose certificate a row is.
    if (/^UPDATE documents SET person = \?2 WHERE id = \?1/.test(sql)) {
      const r = rows.find((x) => x.id === args[0]);
      if (r) r.person = args[1];
      return { changes: r ? 1 : 0 };
    }
    // The hand rename (routes/rename-file.ts): the row, whoever holds the
    // address, and the rename itself - which takes the portal's mark off
    // only where the statement says so.
    if (/^SELECT id, filename, blob_key, adopted_from_folder FROM documents WHERE id = \?1 AND removed_at IS NULL/.test(sql)) {
      return { results: rows.filter((r) => r.id === args[0] && !r.removedAt).map((r) => ({ id: r.id, filename: r.filename, blob_key: r.blobKey, adopted_from_folder: r.adoptedFromFolder ?? null })) };
    }
    if (/^SELECT id FROM documents WHERE blob_key = \?1 AND id != \?2/.test(sql)) {
      return { results: rows.filter((r) => r.blobKey === args[0] && r.id !== args[1]).map((r) => ({ id: r.id })) };
    }
    if (/^UPDATE documents SET filename = \?2/.test(sql)) {
      const r = rows.find((x) => x.id === args[0] && !x.removedAt);
      if (r) {
        r.filename = args[1];
        if (/blob_key = \?3/.test(sql)) r.blobKey = args[2];
        if (/named_by_portal = NULL/.test(sql)) r.namedByPortal = null;
      }
      return { changes: r ? 1 : 0 };
    }
    // The restore's rows, bound and batched.
    if (/^INSERT OR REPLACE INTO blobs/.test(sql)) {
      blobs.set(args[0] + "|" + args[1], String(args[2])); etags.set(args[0] + "|" + args[1], String(args[4]));
      return { changes: 1 };
    }
    if (/^INSERT INTO blobs/.test(sql)) {
      const k = args[0] + "|" + args[1];
      // The insert-if-absent: a row already there is left alone, and the
      // database says nothing went in.
      if (/DO NOTHING/.test(sql) && blobs.has(k)) return { changes: 0 };
      blobs.set(k, String(args[2])); etags.set(k, String(args[4]));
      return { changes: 1 };
    }
    if (/^DELETE FROM blobs/.test(sql)) { blobs.delete(args[0] + "|" + args[1]); return { changes: 1 }; }
    if (/FROM documents WHERE category = 'certificate' AND removed_at IS NULL/.test(sql)) return { results: rows.filter((r) => r.category === "certificate" && !r.removedAt) };
    if (/FROM documents WHERE category = \?1 AND removed_at IS NULL/.test(sql)) return { results: rows.filter((r) => r.category === args[0] && !r.removedAt) };
    if (/SELECT id, removed_at AS removedAt, kept_in_place AS keptInPlace FROM documents WHERE blob_key = \?1/.test(sql)) {
      return { results: rows.filter((r) => r.blobKey === args[0]).map((r) => ({ id: r.id, removedAt: r.removedAt ?? null, keptInPlace: r.keptInPlace ?? null })) };
    }
    if (/UPDATE documents\s+SET read_code/.test(sql)) return { changes: 1 };
    // The backup's reads: every document row in a fixed order, the users,
    // and a fauna table a portal with no sightings has never made.
    if (sql === "SELECT * FROM documents ORDER BY created_at, id") {
      return { results: [...rows].sort((a, b) => (Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0)) || String(a.id).localeCompare(String(b.id))) };
    }
    if (sql === "SELECT id, email, name, role, disabled, created_at, created_by, last_login, phone FROM users") return { results: users };
    if (sql === "SELECT * FROM fauna_sightings") throw new Error("D1_ERROR: no such table: fauna_sightings");
    if (/^UPDATE documents SET removed_at/.test(sql)) {
      const r = rows.find((x) => x.id === args[0]);
      if (r) { r.removedAt = args[1]; r.blobKey = args[3]; r.keptInPlace = args[4]; }
      return { changes: 1 };
    }
    if (/^INSERT INTO documents/.test(sql)) {
      rows.push({ id: args[0], category: args[1], blobKey: args[2], filename: args[3], contentType: args[4], sizeBytes: args[5],
        title: args[6], uploadedBy: args[7], filedOn: args[8], sessionId: args[9], createdAt: args[10], removedAt: null, adoptedFromFolder: null, keptInPlace: null });
      return { changes: 1 };
    }
    return drizzle(sql, args);
  });
  return { db, state, stateRow, blobs, etags, doc: () => JSON.parse(state.data), rows };
}

/* ------------------------------------------------------------------------ *
 * Microsoft Graph, answered by hand.
 * ------------------------------------------------------------------------ */

/** A file in the fake library, by its real path. `size` left out is a
 *  listing that names no size, which the sync must never take for a match. */
export type FakeFile = { path: string; size?: number; modified?: string; bytes?: string };

/** What a listing call can be made to do instead of answering: a status
 *  (429 with a Retry-After, 503, 404), or a page cut short - its
 *  @odata.nextLink dropped, so the walk stops with files unseen. */
export type ListingFault = { status: number; retryAfter?: number } | { cut: true };

/** Graph, answered by hand: the folders in `exists` are folders, each with
 *  an id of its own, and so is every folder a file's path implies; every
 *  call is written down. A PUT by path makes whatever folders the path is
 *  missing - as Graph's upload by path is known to - and says so in
 *  `made`; a PUT by a folder's id lands only while that folder is still
 *  there.
 *
 *  A folder's children are listed `pageSize` at a time behind
 *  @odata.nextLink, exactly as the live driver walks them, and a file's
 *  bytes are read at :/content. `fault` makes a listing answer with a
 *  status or a cut page instead, for the calls `when` picks out. */
export function graphLibrary(exists: Set<string>, library: { files?: FakeFile[]; pageSize?: number } = {}) {
  const calls: { method: string; path: string }[] = [];
  const made: string[] = [];
  const files: FakeFile[] = library.files || [];
  const pageSize = library.pageSize || 200;
  /** Every listing call, in order: the folder ("" for the root) and where
   *  in it the page began. A retry is a call of its own. */
  const listings: { folder: string; skip: number }[] = [];
  const faults: { fault: ListingFault; when: (folder: string, skip: number, nth: number) => boolean; left: number }[] = [];
  /** Calls of any kind, listings or not, that answer with a status instead. */
  const refusals: { status: number; when: (method: string, path: string) => boolean; left: number }[] = [];
  const ids = new Map<string, string>();
  const idOf = (folder: string) => {
    if (!ids.has(folder)) ids.set(folder, "item" + (ids.size + 1));
    return ids.get(folder)!;
  };
  const folderOf = (id: string) => [...ids.entries()].find(([, v]) => v === id)?.[0];
  // The folders there are: the ones named, and every one a file sits in.
  const folders = () => {
    const all = new Set(exists);
    for (const f of files) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) all.add(parts.slice(0, i).join("/"));
    }
    return all;
  };
  const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
  const encode = (path: string) => path.split("/").map(encodeURIComponent).join("/");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    // Read as the driver sent it where it cannot be decoded: a stray "%"
    // is a call Graph would still answer, and the fake must too.
    const raw = url.replace(/^https:\/\/[^/]+/, "");
    let path: string;
    try { path = decodeURIComponent(raw); } catch { path = raw; }
    calls.push({ method, path });
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    const refusal = refusals.find((r) => r.left > 0 && r.when(method, path));
    if (refusal) {
      refusal.left--;
      return json({ error: { code: "serviceNotAvailable" } }, refusal.status);
    }
    if (path.includes("/oauth2/")) return json({ access_token: "t", expires_in: 3600 });
    if (/^\/v1\.0\/sites\/[^/]+:\/sites\/\w+$/.test(path)) return json({ id: "site1" });
    if (path === "/v1.0/sites/site1/drives") return json({ value: [{ id: "d1", name: "Documents" }] });
    if (method === "GET") {
      // A folder's children, one page at a time.
      const listing = /^\/v1\.0\/drives\/d1\/root(?::\/(.*?):)?\/children\?(.*)$/.exec(path);
      if (listing) {
        const folder = listing[1] ?? "";
        const skip = Number(new URLSearchParams(listing[2]).get("$skip") || 0);
        listings.push({ folder, skip });
        const fault = faults.find((f) => f.left > 0 && f.when(folder, skip, listings.length));
        if (fault) fault.left--;
        if (fault && "status" in fault.fault) {
          const headers: Record<string, string> = fault.fault.retryAfter ? { "Retry-After": String(fault.fault.retryAfter) } : {};
          return json({ error: { code: fault.fault.status === 429 ? "tooManyRequests" : "serviceNotAvailable" } }, fault.fault.status, headers);
        }
        if (folder && !folders().has(folder)) return json({ error: { code: "itemNotFound" } }, 404);
        const children = [
          ...[...folders()].filter((f) => f && parentOf(f) === folder).sort().map((f) => ({ name: f.split("/").pop()!, id: idOf(f), folder: {} })),
          ...files.filter((f) => parentOf(f.path) === folder).map((f) => ({
            name: f.path.split("/").pop()!, id: idOf(f.path), file: {},
            ...(f.size === undefined ? {} : { size: f.size }),
            ...(f.modified ? { lastModifiedDateTime: f.modified } : {}),
          })),
        ];
        const page = children.slice(skip, skip + pageSize);
        const more = skip + pageSize < children.length && !(fault && "cut" in fault.fault);
        const next = folder
          ? `https://graph.microsoft.com/v1.0/drives/d1/root:/${encode(folder)}:/children?$top=${pageSize}&$skip=${skip + pageSize}`
          : `https://graph.microsoft.com/v1.0/drives/d1/root/children?$top=${pageSize}&$skip=${skip + pageSize}`;
        return json({ value: page, ...(more ? { "@odata.nextLink": next } : {}) });
      }
      // A file's bytes.
      const content = /^\/v1\.0\/drives\/d1\/root:\/(.+):\/content$/.exec(path);
      if (content) {
        const f = files.find((x) => x.path === content[1]);
        return f ? new Response(f.bytes ?? "", { status: 200 }) : json({ error: "not found" }, 404);
      }
      // The item itself: a folder, a file, or nothing.
      const m = /^\/v1\.0\/drives\/d1\/root:\/(.+)$/.exec(path);
      if (m && folders().has(m[1])) return json({ id: idOf(m[1]), folder: {} });
      const f = m && files.find((x) => x.path === m[1]);
      return f ? json({ id: idOf(f.path), file: {}, ...(f.size === undefined ? {} : { size: f.size }) }) : json({ error: "not found" }, 404);
    }
    if (method === "POST" && path.endsWith(":/children")) {
      const parent = /root:\/(.+):\/children$/.exec(path)![1];
      const folder = `${parent}/${JSON.parse(String(init!.body)).name}`;
      exists.add(folder); made.push(folder);
      return json({ id: idOf(folder) }, 201);
    }
    if (method === "PUT") {
      const byId = /^\/v1\.0\/drives\/d1\/items\/([^:]+):\/[^/]+:\/content$/.exec(path);
      if (byId) {
        const folder = folderOf(byId[1]);
        return folder && exists.has(folder) ? json({ id: "put" }, 201) : json({ error: { code: "itemNotFound", message: "The resource could not be found." } }, 404);
      }
      const parent = /root:\/(.+)\/[^/]+:\/content$/.exec(path)![1];
      if (!exists.has(parent)) { exists.add(parent); made.push(parent); }
      return json({ id: "put" }, 201);
    }
    if (method === "DELETE") {
      const m = /^\/v1\.0\/drives\/d1\/root:\/(.+)$/.exec(path);
      const i = m ? files.findIndex((x) => x.path === m[1]) : -1;
      if (i >= 0) files.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    return json({ error: "unexpected " + method + " " + path }, 500);
  }) as typeof fetch;
  const posts = () => calls.filter((c) => c.method === "POST" && c.path.endsWith(":/children")).map((c) => c.path);
  const puts = () => calls.filter((c) => c.method === "PUT").map((c) => c.path);
  /** The next `times` listing calls that `when` picks out answer with
   *  `fault` instead. `nth` counts every listing call so far, this one included. */
  const fault = (what: ListingFault, when: (folder: string, skip: number, nth: number) => boolean, times = 1) => {
    faults.push({ fault: what, when, left: times });
  };
  /** The next `times` calls of any kind that `when` picks out, by method
   *  and path, answer `status` instead - the way to turn away a write or
   *  a look, which `fault` cannot reach. */
  const refuse = (status: number, when: (method: string, path: string) => boolean, times = 1) => {
    refusals.push({ status, when, left: times });
  };
  return { calls, made, posts, puts, idOf, listings, fault, refuse, files, restore: () => { globalThis.fetch = realFetch; } };
}

export const sharepointEnv = (over: Record<string, unknown> = {}) => ({
  FILE_STORE: "sharepoint", MS_TENANT_ID: "tenant", MS_CLIENT_ID: "app", MS_CLIENT_SECRET: "secret",
  SHAREPOINT_HOSTNAME: "x.sharepoint.com", SHAREPOINT_SITE_PATH: "/sites/Team", SHAREPOINT_LIBRARY: "Documents",
  SHAREPOINT_ROOT: "United Operations Team/Crew Portal",
  SHAREPOINT_MAP: JSON.stringify({ "opms/": "United Operations Team/OPMS Documents/" }),
  ...over,
});

/** The library's real layout, as wrangler.toml deploys it: the portal's own
 *  folder and the map from its filing families to the team's folders. Read
 *  off the file itself so a test walks the folders the live sync walks. */
export function wranglerVars(): { SHAREPOINT_ROOT: string; SHAREPOINT_MAP: string } {
  const toml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "wrangler.toml"), "utf8");
  const root = /^SHAREPOINT_ROOT\s*=\s*"([^"]*)"/m.exec(toml);
  const map = /^SHAREPOINT_MAP\s*=\s*"""([\s\S]*?)"""/m.exec(toml);
  if (!root || !map) throw new Error("wrangler.toml no longer names SHAREPOINT_ROOT and SHAREPOINT_MAP");
  // Parsed and written back out, so a map that does not parse fails here
  // and not quietly inside the driver.
  return { SHAREPOINT_ROOT: root[1], SHAREPOINT_MAP: JSON.stringify(JSON.parse(map[1])) };
}

export const quiet = async <T>(work: () => Promise<T>) => {
  const realError = console.error;
  console.error = () => {};
  try { return await work(); } finally { console.error = realError; }
};

export const withClock = async <T>(at: number, work: () => Promise<T>) => {
  const realNow = Date.now;
  Date.now = () => at;
  try { return await work(); } finally { Date.now = realNow; }
};
