/**
 * The hourly round, piece by piece, against a database and a file store
 * that live in this file.
 *
 * The round puts the certificates' dates on the crew matrix and writes the
 * office's CREW QUALIFICATION EXPIRY workbook by itself, with nobody
 * watching. Every case here is a way that could go wrong quietly: a
 * certificate filed under one spelling claiming nothing, a workbook lost
 * halfway through a replace, a date cleared on its first sighting, the
 * portal making a folder in the library.
 *
 *   npx tsx --test tests/round.test.ts      (or: node tools/check.mjs)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setEnv } from "../src/env.js";
import { compareMatrix } from "../src/routes/analyse.js";
import { relocateToRemovedBlob } from "../src/db/documents.js";
import { replaceSingleFile } from "../src/db/single-file.js";
import { saveDocument } from "../src/lib/shared-state.js";
import { asKnownPerson } from "../../source/shared/names.js";

/* ------------------------------------------------------------------------ *
 * A D1 that answers from a table of statements.
 *
 * `answer` is given the SQL and its bound values and hands back what the
 * real database would: rows for a select, a change count for a write. What
 * it is not asked about it refuses, so a test cannot pass on a query nobody
 * thought about. Drizzle's own reads go through .raw(), which is refused
 * outright - the code under test reads with plain statements.
 * ------------------------------------------------------------------------ */
type Answer = { results?: unknown[]; changes?: number };
type Asked = { sql: string; args: unknown[] };

function fakeDb(answer: (sql: string, args: unknown[]) => Answer | undefined, asked: Asked[] = []) {
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
    async raw() {
      throw new Error("drizzle reads are not faked here");
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
 * An R2 bucket in memory, which is what fileStore() drives when FILE_STORE
 * is "r2". It writes down every folder a write would have had to make -
 * the office's library is SharePoint, where a write into a folder that is
 * not there makes the folder, and the portal is not allowed to make one.
 * `failOn` makes the nth write throw, for the tests that pull the floor
 * out halfway through.
 * ------------------------------------------------------------------------ */
function fakeBucket(seed: Record<string, string>, folders: string[] = ["opms", "removed"]) {
  const bytes = new Map<string, Uint8Array>();
  const have = new Set(folders);
  const made: string[] = [];
  let writes = 0;
  const enc = new TextEncoder();
  Object.entries(seed).forEach(([k, v]) => bytes.set(k, enc.encode(v)));
  const bucket = {
    made,
    failOn: 0,
    text: (key: string) => { const b = bytes.get(key); return b ? new TextDecoder().decode(b) : null; },
    keys: () => [...bytes.keys()].sort(),
    async get(key: string) {
      const b = bytes.get(key);
      return b ? { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), body: null } : null;
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

/* The one reading these tests need: a Master ticket printed in Kachin's
   name and filed, as the office files it, under "bILLY". */
const reading = {
  version: "r1", at: "", model: "", readable: true,
  holderName: "Kachin Sittiyos", certificateTitle: "Master <500GT", issuer: "AMSA",
  issuedOn: "2026-02-17", expiresOn: "2031-02-17", neverExpires: false,
  qualCode: "QL-01", codeConfidence: "high", notes: null,
};
const billysTicket = {
  id: "c1", category: "certificate", bucket: "billy", blobKey: "opms/Billy - OPMS/master.pdf",
  filename: "master.pdf", contentType: "application/pdf", sizeBytes: 100, title: null,
  uploadedBy: null, tag: null, source: null, party: null, rank: null, swing: null,
  filedOn: "2026-09-01", sessionId: null, person: "bILLY", folder: "billy",
  qualCode: "QL-01", expiresOn: null, checksum: "abc", createdAt: 1, removedAt: null, removedBy: null,
};

const certificatesDb = () => fakeDb((sql) => {
  if (/FROM documents WHERE category = 'certificate'/.test(sql)) return { results: [billysTicket] };
  if (/SELECT key, value FROM blobs/.test(sql)) return { results: [{ key: "r1/abc.json", value: JSON.stringify(reading) }] };
  if (/SELECT value FROM blobs/.test(sql)) return { results: [] };
  if (/UPDATE documents/.test(sql)) return { changes: 1 };
  return undefined;
});

const matrix = {
  cols: [["QL-01", "Master", "Qualifications"]] as [string, string, string][],
  rows: [["SITTIYOS, Kachin", "Cook", "", [""]]] as [string, string, string, string[]][],
};

test("a certificate filed under an alias claims the register's row", async () => {
  setEnv({ DB: certificatesDb(), FILE_STORE: "r2" } as never);
  const nameOf = asKnownPerson([{ name: "SITTIYOS, Kachin", aliases: ["bILLY"] }]);
  const out = await compareMatrix(matrix, null, nameOf);
  assert.deepEqual(out.claimed, ["SITTIYOS, KACHIN::QL-01"], "the claim is keyed by the register's name");
  assert.deepEqual(out.settled, [{ person: "SITTIYOS, Kachin", code: "QL-01", value: "2031-02-17" }],
    "the date settles on the row under the row's own name");
  assert.equal(out.notes.length, 0, "nothing to note: the alias is the man");
});

test("without a register the route compares names as they are", async () => {
  setEnv({ DB: certificatesDb(), FILE_STORE: "r2" } as never);
  const out = await compareMatrix(matrix, null);
  assert.deepEqual(out.claimed, [], "bILLY is not on this matrix");
  assert.equal(out.notes[0]?.kind, "not-on-matrix");
});

/* ------------------------------------------------------------------------ *
 * Removed copies are parked flat. The portal makes no folders.
 * ------------------------------------------------------------------------ */
test("a removed copy is parked flat under removed/, and no folder is made", async () => {
  const bucket = fakeBucket({ "opms/20260901 - CREW QUALIFICATION EXPIRY.xlsx": "old workbook" });
  setEnv({ DB: fakeDb(() => undefined), FILES: bucket, FILE_STORE: "r2" } as never);
  const row = {
    id: "tm1", category: "training-matrix", blobKey: "opms/20260901 - CREW QUALIFICATION EXPIRY.xlsx",
    filename: "20260901 - CREW QUALIFICATION EXPIRY.xlsx",
  };
  const parked = await relocateToRemovedBlob(row as never);
  assert.equal(parked, "removed/tm1 - 20260901 - CREW QUALIFICATION EXPIRY.xlsx", "one file straight under removed/");
  assert.equal(bucket.text(parked), "old workbook", "the bytes went with it");
  assert.equal(bucket.text(row.blobKey), null, "and the live name is free");
  assert.deepEqual(bucket.made, [], "no folder was made for it");
});

/* ------------------------------------------------------------------------ *
 * Replacing the one workbook on file. The old copy is never lost.
 * ------------------------------------------------------------------------ */
const liveRow = (id: string, key: string, adopted = 0) => ({
  id, category: "training-matrix", bucket: null, blobKey: key, filename: key.split("/").pop(),
  contentType: null, sizeBytes: 3, title: null, uploadedBy: "the office", tag: null, source: null,
  party: null, rank: null, swing: null, filedOn: "2026-09-01", sessionId: null, person: null,
  folder: null, qualCode: null, expiresOn: null, checksum: null, createdAt: 1, removedAt: null,
  removedBy: null, adoptedFromFolder: adopted, keptInPlace: null,
});

/* A database holding these live rows and answering the replace's own
   statements: the column check, the live rows, who holds an address, and
   the writes. */
function documentsDb(rows: ReturnType<typeof liveRow>[]) {
  const asked: Asked[] = [];
  const db = fakeDb((sql, args) => {
    if (/PRAGMA table_info/.test(sql)) return { results: [{ name: "adopted_from_folder" }, { name: "kept_in_place" }] };
    if (/FROM documents WHERE category = \?1 AND removed_at IS NULL/.test(sql)) return { results: rows.filter((r) => r.category === args[0]) };
    if (/SELECT id FROM documents WHERE blob_key = \?1/.test(sql)) return { results: rows.filter((r) => r.blobKey === args[0]).map((r) => ({ id: r.id })) };
    if (/^UPDATE documents|^INSERT INTO documents/.test(sql)) return { changes: 1 };
    return undefined;
  }, asked);
  return db;
}
const writes = (db: { asked: Asked[] }) => db.asked.filter((a) => /^UPDATE|^INSERT/.test(a.sql));
const bytesOf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const todaysWorkbook = (over: Partial<Parameters<typeof replaceSingleFile>[0]> = {}) => ({
  category: "training-matrix", bytes: bytesOf("new workbook"), filename: "20260924 - CREW QUALIFICATION EXPIRY.xlsx",
  contentType: "application/x", uploadedBy: "the round on the hour", filedOn: "2026-09-24", ...over,
});

test("a replace that fails halfway leaves the old workbook live and where it was", async () => {
  const key = "opms/CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ [key]: "old workbook" });
  const db = documentsDb([liveRow("tm1", key)]);
  setEnv({ DB: db, FILES: bucket, FILE_STORE: "r2" } as never);
  // The first write is the new bytes to a pending address (the old copy holds
  // the name); the second is the old copy being parked - and that one fails.
  bucket.failOn = 2;
  await assert.rejects(
    replaceSingleFile(todaysWorkbook({ filename: "CREW QUALIFICATION EXPIRY.xlsx" })),
    /refused the write/,
  );
  assert.equal(bucket.text(key), "old workbook", "the live address still holds the old bytes");
  assert.deepEqual(bucket.keys(), [key], "the pending copy was cleaned up and nothing was parked");
  assert.deepEqual(writes(db), [], "nothing on the books changed");
  assert.deepEqual(bucket.made, [], "no folder was made");
});

test("a clean replace parks the old copy flat and lands the new one in one batch", async () => {
  const old = "opms/20260901 - CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ [old]: "old workbook" });
  const db = documentsDb([liveRow("tm1", old)]);
  setEnv({ DB: db, FILES: bucket, FILE_STORE: "r2" } as never);
  const { row, replaced } = await replaceSingleFile(todaysWorkbook());
  assert.equal(row.blobKey, "opms/20260924 - CREW QUALIFICATION EXPIRY.xlsx");
  assert.equal(bucket.text(row.blobKey), "new workbook");
  assert.equal(bucket.text("removed/tm1 - 20260901 - CREW QUALIFICATION EXPIRY.xlsx"), "old workbook", "parked flat");
  assert.equal(bucket.text(old), null, "the old address is free");
  assert.deepEqual(bucket.made, [], "no folder was made");
  assert.deepEqual(replaced, [{ id: "tm1", filename: "20260901 - CREW QUALIFICATION EXPIRY.xlsx" }]);
  const w = writes(db);
  assert.equal(w.length, 2, "one mark and one insert");
  assert.deepEqual(w[0].args.slice(3), ["removed/tm1 - 20260901 - CREW QUALIFICATION EXPIRY.xlsx", null], "the row points at the parked copy");
  assert.equal(w[1].args[2], row.blobKey, "the new row points at the new bytes");
});

test("the database refusing the batch puts the old bytes back", async () => {
  const old = "opms/20260901 - CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ [old]: "old workbook" });
  const db = documentsDb([liveRow("tm1", old)]);
  db.batch = async () => { throw new Error("D1 is having a bad morning"); };
  setEnv({ DB: db, FILES: bucket, FILE_STORE: "r2" } as never);
  await assert.rejects(replaceSingleFile(todaysWorkbook()), /bad morning/);
  assert.equal(bucket.text(old), "old workbook", "the old copy is back on its live address");
  assert.equal(bucket.text("opms/20260924 - CREW QUALIFICATION EXPIRY.xlsx"), null, "the new bytes are gone");
});

test("a file the office put in the folder is never moved", async () => {
  const theirs = "opms/CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ [theirs]: "the office's copy" });
  const db = documentsDb([liveRow("tm1", theirs, 1)]);
  setEnv({ DB: db, FILES: bucket, FILE_STORE: "r2" } as never);
  const { row } = await replaceSingleFile(todaysWorkbook({ keepOutgoing: true }));
  assert.equal(bucket.text(theirs), "the office's copy", "their file is exactly where it was");
  assert.equal(bucket.text(row.blobKey), "new workbook");
  assert.deepEqual(bucket.keys(), [row.blobKey, theirs].sort(), "nothing parked");
  const mark = writes(db)[0];
  assert.deepEqual([mark.args[3], mark.args[4]], [theirs, 1], "its row is off the books, key unchanged, kept in place");
});

test("the new file takes a suffix rather than writing over the office's file of the same name", async () => {
  const theirs = "opms/20260924 - CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ [theirs]: "the office's copy" });
  const db = documentsDb([liveRow("tm1", theirs, 1)]);
  setEnv({ DB: db, FILES: bucket, FILE_STORE: "r2" } as never);
  const { row } = await replaceSingleFile(todaysWorkbook());
  assert.equal(row.filename, "20260924 - CREW QUALIFICATION EXPIRY (2).xlsx");
  assert.equal(bucket.text(theirs), "the office's copy");
});

/* ------------------------------------------------------------------------ *
 * Saving the shared document from the worker: a save that lands on a
 * stale revision is worked out again on the fresh one.
 * ------------------------------------------------------------------------ */
test("a save that finds the document moved on reads again and tries once more", async () => {
  let reads = 0;
  let updates = 0;
  const db = fakeDb((sql, args) => {
    if (/SELECT data, rev FROM portal_state/.test(sql)) {
      reads++;
      return { results: [{ data: JSON.stringify({ n: reads, history: [] }), rev: reads === 1 ? 7 : 8 }] };
    }
    if (/UPDATE portal_state SET data/.test(sql)) {
      updates++;
      // The first save is refused: somebody saved rev 8 in between.
      return { changes: updates === 1 ? 0 : 1 };
    }
    return undefined;
  });
  setEnv({ DB: db } as never);
  const remembered: number[] = [];
  const seen: number[] = [];
  const out = await saveDocument(
    (doc) => { seen.push(doc.n as number); return { ...doc, touched: true }; },
    "the round on the hour",
    { remember: async (rev) => { remembered.push(rev); } },
  );
  assert.equal(updates, 2, "the update was attempted twice");
  assert.deepEqual(seen, [1, 2], "the change was worked out again on the fresh copy, not the stale one");
  const tried = db.asked.filter((a) => /UPDATE portal_state/.test(a.sql)).map((a) => a.args[3]);
  assert.deepEqual(tried, [7, 8], "each attempt was against the revision it had just read");
  assert.deepEqual(out, { rev: 9, changed: true });
  assert.deepEqual(remembered, [9], "the history is told once, with the revision that landed");
});

test("a change that answers null writes nothing", async () => {
  const db = fakeDb((sql) => {
    if (/SELECT data, rev FROM portal_state/.test(sql)) return { results: [{ data: "{}", rev: 3 }] };
    return undefined;
  });
  setEnv({ DB: db } as never);
  const out = await saveDocument(() => null, "the round on the hour", { remember: async () => {} });
  assert.deepEqual(out, { rev: 3, changed: false });
  assert.equal(db.asked.filter((a) => /UPDATE/.test(a.sql)).length, 0, "no update was even attempted");
});
