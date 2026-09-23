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
import analyse, { compareMatrix } from "../src/routes/analyse.js";
import { KeptInPlace, purgeDocument, relocateToRemovedBlob, removeDocument, restoreDocument } from "../src/db/documents.js";
import { replaceSingleFile } from "../src/db/single-file.js";
import { saveDocument } from "../src/lib/shared-state.js";
import { runMatrixRound, roundRunning, takeLease, dropLease } from "../src/lib/round.js";
import { todayThere } from "../src/lib/analysis.js";
import sync, { apply, outranks, sheetOrder, survey } from "../src/routes/sync.js";
import files from "../src/routes/files.js";
import worker from "../src/index.js";
import { writeZip, readZip, partOf, partText, datedWorkbookName } from "../../source/shared/workbook.js";
import { asKnownPerson, crewRegister } from "../../source/shared/names.js";
import { settleRound, applySettled } from "../../source/shared/matrix-rules.js";

/* ------------------------------------------------------------------------ *
 * A D1 that answers from a table of statements.
 *
 * `answer` is given the SQL and its bound values and hands back what the
 * real database would: rows for a select, a change count for a write. What
 * it is not asked about it refuses, so a test cannot pass on a query nobody
 * thought about. Drizzle's own reads go through .raw(), which is refused
 * outright - the code under test reads with plain statements.
 * ------------------------------------------------------------------------ */
type Answer = { results?: unknown[]; changes?: number; columns?: string[] };
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
type Row = Record<string, unknown>;
const camel = (c: string) => c.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase());
function drizzleOn(rows: Row[]) {
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
    if ((m = /^insert into "documents" \((.+?)\) values \((.+?)\)$/.exec(sql))) {
      const names = cols(m[1]);
      const slots = m[2].split(", ");
      const row: Row = {};
      names.forEach((c, i) => { row[c] = slots[i] === "?" ? a.shift() : null; });
      rows.push(row);
      return { changes: 1 };
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

/* A removed row of the office's own workbook, kept where the office put it. */
const keptRow = (id: string, key: string) => ({ ...liveRow(id, key, 1), removedAt: 5, keptInPlace: 1 });

/* A database holding these rows and answering the replace's own
   statements: the column check, the live rows, who holds an address, and
   the writes. */
function documentsDb(rows: (ReturnType<typeof liveRow> | ReturnType<typeof keptRow>)[]) {
  const asked: Asked[] = [];
  const db = fakeDb((sql, args) => {
    if (/PRAGMA table_info/.test(sql)) return { results: [{ name: "adopted_from_folder" }, { name: "kept_in_place" }] };
    if (/FROM documents WHERE category = \?1 AND removed_at IS NULL/.test(sql)) return { results: rows.filter((r) => r.category === args[0] && !r.removedAt) };
    if (/SELECT id, removed_at AS removedAt, kept_in_place AS keptInPlace FROM documents WHERE blob_key = \?1/.test(sql)) {
      return { results: rows.filter((r) => r.blobKey === args[0]).map((r) => ({ id: r.id, removedAt: r.removedAt ?? null, keptInPlace: r.keptInPlace ?? null })) };
    }
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

/* The new file under the SAME name the live one holds - the round's second
   write of a day - goes through the pending address: (a) the new bytes to
   "~pending <id> - <name>", (b) the old copy parked and the new bytes moved
   onto the name, (c) the books. These four pull the floor out at each step. */
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

test("the same name again: the new bytes wait at a pending address, then take the name in one move", async () => {
  const key = "opms/20260924 - CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ [key]: "this morning's" });
  const db = documentsDb([liveRow("tm1", key)]);
  setEnv({ DB: db, FILES: bucket, FILE_STORE: "r2" } as never);
  const { row } = await replaceSingleFile(todaysWorkbook());
  assert.equal(row.blobKey, key, "the new row holds the same name");
  assert.equal(bucket.text(key), "new workbook", "…with the new bytes under it");
  assert.equal(bucket.text("removed/tm1 - 20260924 - CREW QUALIFICATION EXPIRY.xlsx"), "this morning's", "the old copy is parked flat");
  assert.ok(!bucket.keys().some((k) => k.includes("~pending")), "no pending copy is left behind");
  assert.deepEqual(bucket.made, [], "no folder was made");
});

test("the same name again, and the move onto it fails: the old copy is back and the pending copy gone", async () => {
  const key = "opms/20260924 - CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ [key]: "this morning's" });
  const db = documentsDb([liveRow("tm1", key)]);
  setEnv({ DB: db, FILES: bucket, FILE_STORE: "r2" } as never);
  // Write 1 the pending copy, 2 the old copy parked, 3 the move onto the name.
  bucket.failOn = 3;
  await assert.rejects(replaceSingleFile(todaysWorkbook()), /refused the write/);
  assert.equal(bucket.text(key), "this morning's", "the live address holds the old bytes again");
  assert.ok(!bucket.keys().some((k) => k.includes("~pending")), "the pending copy is gone");
  assert.deepEqual(writes(db), [], "nothing on the books changed");
});

test("the same name again, and the books refuse the batch: the old bytes are back on the name", async () => {
  const key = "opms/20260924 - CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ [key]: "this morning's" });
  const db = documentsDb([liveRow("tm1", key)]);
  db.batch = async () => { throw new Error("D1 is having a bad morning"); };
  setEnv({ DB: db, FILES: bucket, FILE_STORE: "r2" } as never);
  await assert.rejects(replaceSingleFile(todaysWorkbook()), /bad morning/);
  assert.equal(bucket.text(key), "this morning's", "the old copy is back on its live address");
  assert.ok(!bucket.keys().some((k) => k.includes("~pending")), "no pending copy is left behind");
});

/* Nothing is ever written over: not the office's file kept in place after
   the round replaced it, and not a file the office dropped in the folder
   that is on no row at all. Both push the new one to the next suffix. */
test("the office's workbook, kept in place after a replace, is not written over by the next", async () => {
  const theirs = "opms/20260924 - CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ [theirs]: "OFFICE", "opms/20260923 - CREW QUALIFICATION EXPIRY.xlsx": "yesterday's" });
  const db = documentsDb([keptRow("old", theirs), liveRow("tm2", "opms/20260923 - CREW QUALIFICATION EXPIRY.xlsx")]);
  setEnv({ DB: db, FILES: bucket, FILE_STORE: "r2" } as never);
  const { row } = await replaceSingleFile(todaysWorkbook());
  assert.equal(row.filename, "20260924 - CREW QUALIFICATION EXPIRY (2).xlsx", "the next suffix");
  assert.equal(bucket.text(theirs), "OFFICE", "the office's bytes are untouched");
  assert.equal(bucket.text(row.blobKey), "new workbook");
});

test("a file in the folder that is on no row is not written over either", async () => {
  const loose = "opms/20260924 - CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ [loose]: "dropped in by hand", "opms/20260923 - CREW QUALIFICATION EXPIRY.xlsx": "yesterday's" });
  const db = documentsDb([liveRow("tm2", "opms/20260923 - CREW QUALIFICATION EXPIRY.xlsx")]);
  setEnv({ DB: db, FILES: bucket, FILE_STORE: "r2" } as never);
  const { row } = await replaceSingleFile(todaysWorkbook());
  assert.equal(row.filename, "20260924 - CREW QUALIFICATION EXPIRY (2).xlsx", "the next suffix");
  assert.equal(bucket.text(loose), "dropped in by hand", "the loose file is untouched");
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

/* ------------------------------------------------------------------------ *
 * What a round takes back: a date comes off only on its second sighting as
 * an orphan, a value settled this round always beats a clearing, and a
 * rename in between changes nothing.
 * ------------------------------------------------------------------------ */
test("an orphan is cleared on its second consecutive sighting, not its first", () => {
  const filled = { "A::QL-01": true, "B::QL-02": true };
  const first = settleRound({ filledFromCert: filled, claimed: ["A::QL-01"], unread: 0, settled: [], seenBefore: {}, now: "2026-09-24T03" });
  assert.deepEqual(first.orphans, [], "first sighting: no clear");
  assert.deepEqual(first.seenNow, { "B::QL-02": "2026-09-24T03" }, "…but noted");
  assert.deepEqual(Object.keys(first.noteNow).sort(), ["A::QL-01", "B::QL-02"], "…and still in the note");

  const second = settleRound({ filledFromCert: filled, claimed: ["A::QL-01"], unread: 0, settled: [], seenBefore: first.seenNow, now: "2026-09-24T04" });
  assert.deepEqual(second.settled, [{ person: "B", code: "QL-02", value: "", clear: true }], "second sighting: cleared");
  assert.deepEqual(Object.keys(second.noteNow), ["A::QL-01"]);

  const back = settleRound({ filledFromCert: filled, claimed: ["A::QL-01", "B::QL-02"], unread: 0, settled: [], seenBefore: first.seenNow, now: "2026-09-24T04" });
  assert.deepEqual(back.orphans, [], "claimed again in between: dropped");
  assert.deepEqual(back.seenNow, {});
});

test("a value settled for a cell this round beats any clearing of it", () => {
  const out = settleRound({
    filledFromCert: { "B::QL-02": true }, claimed: [], unread: 0,
    settled: [{ person: "b", code: "ql-02", value: "2030-01-01" }],
    seenBefore: { "B::QL-02": "2026-09-24T03" }, now: "2026-09-24T04",
  });
  assert.deepEqual(out.orphans, [], "not an orphan: a value speaks for it");
  assert.deepEqual(out.settled, [{ person: "b", code: "ql-02", value: "2030-01-01" }]);
  const ordered = settleRound({ filledFromCert: {}, claimed: [], unread: 0,
    settled: [{ person: "C", code: "QL-03", value: "2030-01-01" }, { person: "C", code: "QL-03", clear: true }] });
  assert.deepEqual(ordered.settled.map((x) => !!x.clear), [true, false], "clears first, values after");
});

test("the rename race: noted under the old spelling, claimed under the new, valued this round", () => {
  const reg = crewRegister([{ name: "SITTIYOS, Kachin", aliases: ["bILLY"] }]);
  const race = settleRound({
    filledFromCert: { "BILLY::QL-01": true },
    claimed: ["SITTIYOS, KACHIN::QL-01"],
    unread: 0,
    settled: [{ person: "SITTIYOS, Kachin", code: "QL-01", value: "2031-02-17" }],
    seenBefore: { "BILLY::QL-01": "2026-09-24T03" },
    now: "2026-09-24T04",
    nameOf: reg.nameOf,
  });
  assert.deepEqual(race.orphans, [], "no clear");
  assert.deepEqual(Object.keys(race.noteNow), ["SITTIYOS, KACHIN::QL-01"], "the note is keyed under the register's name");
  assert.deepEqual(race.seenNow, {});
  const laid = applySettled(
    { cols: [["QL-01", "Master"]], rows: [["bILLY", "Cook", "", ["2031-02-17"]]] },
    race.settled, reg.nameOf,
  );
  assert.equal(laid.next.rows[0][3][0], "2031-02-17", "the cell keeps the value");
});

test("with no sightings kept, the page's button still clears on first sighting", () => {
  const out = settleRound({ filledFromCert: { "B::QL-02": true }, claimed: [], unread: 0, settled: [] });
  assert.deepEqual(out.orphans, ["B::QL-02"]);
  assert.deepEqual(out.seenNow, {});
});

/* ------------------------------------------------------------------------ *
 * The round, end to end, on a portal that lives in this file: one man on
 * the matrix, one certificate for him filed under the office's spelling,
 * one workbook on file.
 * ------------------------------------------------------------------------ */
const enc = new TextEncoder();
const zipPart = (name: string, text: string) => {
  const body = enc.encode(text);
  return { name, method: 0, flag: 0, time: 0, date: 0, crc: 0, csize: body.length, usize: body.length, body };
};
/* A workbook with one crew row: Evans, QL-01 blank, QL-17 = 47500 (2030-01-17). */
const smallWorkbook = () => writeZip([
  zipPart("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`),
  zipPart("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="CREW EXPIRY" sheetId="1" r:id="rId1"/></sheets></workbook>`),
  zipPart("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
  zipPart("xl/sharedStrings.xml", `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"></sst>`),
  zipPart("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:F3"/><sheetData>
<row r="1"><c r="B1" t="inlineStr"><is><t>CREW</t></is></c><c r="E1" t="inlineStr"><is><t>QL-01</t></is></c><c r="F1" t="inlineStr"><is><t>QL-17</t></is></c></row>
<row r="2"><c r="B2" t="inlineStr"><is><t>Name</t></is></c></row>
<row r="3"><c r="B3" t="inlineStr"><is><t>bRENTON</t></is></c><c r="C3" t="inlineStr"><is><t>Master</t></is></c><c r="F3" t="n"><v>47500</v></c></row>
</sheetData></worksheet>`),
]);

/** A whole portal: the shared document, the file rows, the readings, the
 *  named stores - stateful, so a second round sees what the first left.
 *  Store rows are keyed "store|key". */
function portalDb(doc: Record<string, unknown>, rows: Record<string, unknown>[], readings: Record<string, unknown>) {
  const state = { data: JSON.stringify(doc), rev: 1 };
  const blobs = new Map<string, string>();
  // The version mark the store stamps on every write, for the lease's take.
  const etags = new Map<string, string>();
  Object.entries(readings).forEach(([k, v]) => blobs.set("certificate-readings|" + k, JSON.stringify(v)));
  const drizzle = drizzleOn(rows);
  const db = fakeDb((sql, args) => {
    if (/PRAGMA table_info/.test(sql)) return { results: [{ name: "adopted_from_folder" }, { name: "kept_in_place" }] };
    if (/SELECT data, rev FROM portal_state/.test(sql)) return { results: [{ ...state }] };
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
      if (args[3] !== state.rev) return { changes: 0 };
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
  return { db, state, blobs, etags, doc: () => JSON.parse(state.data), rows };
}

const oneManPortal = async (over: {
  orphanSeen?: Record<string, string>; filledFromCert?: Record<string, boolean>;
  /** The workbook as the office's own file, adopted from the folder. */
  theirs?: boolean;
} = {}) => {
  const tmKey = over.theirs ? "opms/CREW QUALIFICATION EXPIRY.xlsx" : "opms/20260901 - CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ "opms/Brenton - OPMS/master.pdf": "a scan" });
  await bucket.put(tmKey, await smallWorkbook().arrayBuffer());
  bucket.made.length = 0;
  const portal = portalDb(
    {
      quals: {
        cols: [["QL-01", "Master", "Qualifications"], ["QL-17", "Medical", "Medical"]],
        rows: [["EVANS, Brenton", "Master", "", ["", "2030-01-17"]]],
      },
      people: [{ name: "EVANS, Brenton", aliases: ["bRENTON"] }],
      filledFromCert: over.filledFromCert || {},
      orphanSeen: over.orphanSeen || {},
      history: [],
    },
    [
      { ...billysTicket, id: "c2", person: "bRENTON", checksum: "evans-master", blobKey: "opms/Brenton - OPMS/master.pdf", sizeBytes: 6 },
      { ...liveRow("tm1", tmKey, over.theirs ? 1 : 0), sizeBytes: 5000 },
    ],
    { "r1/evans-master.json": { ...reading, holderName: "Brenton Evans", expiresOn: "2031-05-26" } },
  );
  setEnv({ DB: portal.db, FILES: bucket, FILE_STORE: "r2" } as never);
  return { portal, bucket, tmKey };
};

test("the round puts a certificate's date on the matrix and writes the office's workbook", async () => {
  const { portal, bucket, tmKey } = await oneManPortal();
  const out = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.equal(out.roundError, null, "no error");
  assert.equal(out.roundSkipped, null, "nothing skipped");
  assert.equal(out.applied, 1, "one date applied");
  assert.equal(out.cleared, 0);
  assert.equal(out.written, 1, "one cell written into the workbook");
  const named = datedWorkbookName("20260901 - CREW QUALIFICATION EXPIRY.xlsx", todayThere());
  assert.equal(out.workbook, named, "filed under today's date");
  assert.equal(out.leftAsTyped, 0);

  const doc = portal.doc();
  assert.equal(doc.quals.rows[0][3][0], "2031-05-26", "the matrix carries the certificate's date");
  assert.deepEqual(doc.filledFromCert, { "EVANS, BRENTON::QL-01": true }, "the cell is noted as filled from a certificate");
  assert.equal(doc.matrixUpdated, todayThere());
  assert.deepEqual(doc.history.map((h: { action: string }) => h.action),
    ["Updated the training matrix from the certificates", "Updated the crew matrix from the certificates"]);
  assert.equal(doc.history[1].detail, "1 date changed · 0 cleared");
  assert.equal(portal.state.rev, 3, "two saves: the matrix, then the workbook's line in the log");

  assert.ok(bucket.text("opms/" + named), "the new workbook is on its dated address");
  assert.ok(bucket.text("removed/tm1 - 20260901 - CREW QUALIFICATION EXPIRY.xlsx"), "the old one is parked flat");
  assert.equal(bucket.text(tmKey), null);
  assert.deepEqual(bucket.made, [], "no folder was made");
  const rowsNow = portal.rows.filter((r) => r.category === "training-matrix");
  assert.deepEqual(rowsNow.map((r) => [r.filename, !!r.removedAt]), [["20260901 - CREW QUALIFICATION EXPIRY.xlsx", true], [named, false]]);
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).until, 0, "the lease is run out at the end");
  assert.equal(await roundRunning(), false);

  /* Read the written workbook back: E3 carries the date, F3 was left alone. */
  const written = await (await bucket.get("opms/" + named))!.arrayBuffer();
  const back = await partText(partOf(readZip(written), "xl/worksheets/sheet1.xml"));
  assert.ok(/<c r="E3"[^>]*><is><t[^>]*>2031-05-26<\/t>/.test(back), "the office's row, under its own spelling, got the date");
  assert.ok(back.includes("bRENTON"), "the office's spelling stays");

  // The next hour has nothing to do and writes nothing at all.
  const again = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.equal(again.applied, 0);
  assert.equal(again.written, null, "no workbook step on an idle hour");
  assert.equal(again.roundError, null);
  assert.equal(portal.state.rev, 3, "an idle hour bumps no revision");
});

test("an hour in which files went off the books holds the clearing", async () => {
  /* Evans's QL-17 was filled from a certificate that no longer claims it,
     and it was an orphan last hour too - it would be cleared this hour, but
     the sync just wrote files off, so it waits. */
  const { portal } = await oneManPortal({
    filledFromCert: { "EVANS, BRENTON::QL-17": true },
    orphanSeen: { "EVANS, BRENTON::QL-17": "2026-09-24T02" },
  });
  const out = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 3 });
  assert.equal(out.held, "clearing held: 3 files went off the books this hour");
  assert.equal(out.cleared, 0, "nothing cleared while held");
  assert.equal(portal.doc().quals.rows[0][3][1], "2030-01-17", "the date stays");
  assert.deepEqual(portal.doc().orphanSeen, { "EVANS, BRENTON::QL-17": "2026-09-24T02" }, "a held hour is no sighting, and forgets none");
});

test("a held hour with nothing else to do is an idle hour", async () => {
  /* The same, but Evans's QL-01 is already on the matrix and noted as the
     certificate's: nothing to apply, nothing to clear while held. The
     sighting stays as it was and the document is not saved for nothing. */
  const { portal } = await oneManPortal({
    filledFromCert: { "EVANS, BRENTON::QL-01": true, "EVANS, BRENTON::QL-17": true },
    orphanSeen: { "EVANS, BRENTON::QL-17": "2026-09-24T02" },
  });
  const doc = portal.doc(); doc.quals.rows[0][3][0] = "2031-05-26"; portal.state.data = JSON.stringify(doc);
  const out = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 3 });
  assert.equal(out.applied + out.cleared, 0);
  assert.equal(portal.state.rev, 1, "no revision bump");
  assert.deepEqual(portal.doc().orphanSeen, { "EVANS, BRENTON::QL-17": "2026-09-24T02" });
});

test("out of time before the workbook: the matrix is saved and the workbook waits", async () => {
  const { portal, bucket, tmKey } = await oneManPortal();
  let asked = 0;
  // Time enough to compare, none left by the workbook.
  const out = await runMatrixRound({ by: "the round on the hour", timeLeft: () => ++asked < 2, mirroredThisHour: 0 });
  assert.equal(out.applied, 1, "the matrix took the date");
  assert.equal(out.written, null, "the workbook was not touched");
  assert.match(out.roundSkipped || "", /out of time before the workbook/);
  assert.equal(portal.doc().quals.rows[0][3][0], "2031-05-26");
  assert.ok(bucket.text(tmKey), "the workbook on file is where it was");
});

test("a second sighting clears the date, and the workbook follows", async () => {
  const { portal } = await oneManPortal({
    filledFromCert: { "EVANS, BRENTON::QL-17": true },
    orphanSeen: { "EVANS, BRENTON::QL-17": "2026-09-24T02" },
  });
  const out = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.equal(out.cleared, 1);
  assert.equal(portal.doc().quals.rows[0][3][1], "", "the orphaned date is off the matrix");
  assert.deepEqual(portal.doc().orphanSeen, {}, "and out of the sightings");
  assert.equal(out.written, 2, "the workbook took the new date and the blank");
});

test("a round that finds another running stands down", async () => {
  const { portal } = await oneManPortal();
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "a tab", token: "x" }));
  const out = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.equal(out.roundSkipped, "another round is still running");
  assert.equal(portal.state.rev, 1, "nothing written");
  assert.ok(await roundRunning(), "and the other's lease is left alone");
});

test("a lease that has run out is taken over, against its version mark", async () => {
  const { portal } = await oneManPortal();
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: 0, by: "last hour", token: "x" }));
  const out = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.equal(out.roundSkipped, null, "the round ran");
  const lease = JSON.parse(portal.blobs.get("sync|round-lease")!);
  assert.equal(lease.by, "the round on the hour", "the lease was this round's");
  assert.equal(lease.until, 0, "and is run out again at the end");
  const took = portal.db.asked.filter((a) => /^UPDATE blobs SET value/.test(a.sql) && a.args[1] === "round-lease");
  assert.ok(took.length >= 1, "it was taken by a conditional write, not written over");
});

test("a lease taken by somebody else in the same instant is not taken twice", async () => {
  const { portal } = await oneManPortal();
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: 0, by: "last hour", token: "x" }));
  // Between this round reading the lease free and writing its own, another
  // isolate's write lands: the mark moves, and the conditional write misses.
  const plain = portal.db.prepare;
  let reads = 0;
  portal.db.prepare = (sql: string) => {
    const s = plain(sql);
    if (!/SELECT value, etag FROM blobs/.test(sql)) return s;
    const bind = s.bind;
    s.bind = (...a: unknown[]) => {
      const b = bind(...a);
      if (++reads !== 1) return b;
      const all = b.all.bind(b);
      b.all = async () => {
        const out = await all();
        portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "the other", token: "y" }));
        portal.etags.set("sync|round-lease", "the other's mark");
        return out;
      };
      b.first = async () => (await b.all()).results[0] ?? null;
      return b;
    };
    return s;
  };
  const out = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.equal(out.roundSkipped, "another round is still running");
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).by, "the other", "the other's lease stands");
  assert.equal(portal.state.rev, 1, "nothing written");
});

/* ------------------------------------------------------------------------ *
 * One lease for everyone who writes the workbook: the hour, Update portal,
 * Import new files and the upload. Two takers in the same instant never
 * both hold it, and a lease that has passed to somebody else is never run
 * out under them.
 * ------------------------------------------------------------------------ */
test("two takers with no lease ever taken: exactly one holds it", async () => {
  const { portal } = await oneManPortal();
  // Both read the store empty before either writes; the insert-if-absent
  // lets one in and tells the other no.
  const [a, b] = await Promise.all([takeLease("the round on the hour"), takeLease("Update portal")]);
  assert.equal([a, b].filter(Boolean).length, 1, "one lease between them");
  const held = JSON.parse(portal.blobs.get("sync|round-lease")!);
  assert.equal(held.token, (a || b)!.token, "the store carries the winner's");
  assert.ok(await roundRunning());
  assert.equal(await takeLease("a third"), null, "and nobody else gets it while it stands");
});

test("a lease that has passed to somebody else is not run out under them", async () => {
  const { portal } = await oneManPortal();
  const mine = (await takeLease("the round on the hour"))!;
  // A stale token: the lease is somebody else's now.
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "the other", token: "y" }));
  await dropLease(mine.token);
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).by, "the other", "the other's lease stands");
  assert.ok(await roundRunning());

  // The race: it is still mine when the drop reads it, and passes to the
  // other between that read and the write. The conditional write misses.
  portal.blobs.set("sync|round-lease", JSON.stringify(mine));
  portal.etags.set("sync|round-lease", "my mark");
  const plain = portal.db.prepare;
  let reads = 0;
  portal.db.prepare = (sql: string) => {
    const s = plain(sql);
    if (!/SELECT value, etag FROM blobs/.test(sql)) return s;
    const bind = s.bind;
    s.bind = (...a: unknown[]) => {
      const b = bind(...a);
      if (++reads !== 1) return b;
      const all = b.all.bind(b);
      b.all = async () => {
        const out = await all();
        portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "the other", token: "y" }));
        portal.etags.set("sync|round-lease", "the other's mark");
        return out;
      };
      b.first = async () => (await b.all()).results[0] ?? null;
      return b;
    };
    return s;
  };
  await dropLease(mine.token);
  portal.db.prepare = plain;
  const now = JSON.parse(portal.blobs.get("sync|round-lease")!);
  assert.equal(now.by, "the other");
  assert.ok(now.until > Date.now(), "still running: the drop found the mark moved and left it");
});

/* The lease's shape from the outside: the sync, the upload and the hour. */
const leaseWrites = (db: { asked: Asked[] }) =>
  db.asked.filter((a) => /^(INSERT INTO|UPDATE) blobs/.test(a.sql) && a.args[1] === "round-lease");

test("Update portal takes the lease for its turn and gives it back; while somebody holds it, it is refused", async () => {
  const { portal } = await oneManPortal();
  const post = () => new Request("http://portal/api/sync", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ by: "Update portal" }),
  });
  const res = await sync(post());
  assert.equal(res.status, 200, await res.text());
  const lease = JSON.parse(portal.blobs.get("sync|round-lease")!);
  assert.equal(lease.by, "Update portal", "the sync ran under its own lease");
  assert.equal(lease.until, 0, "…and gave it back");
  assert.ok(leaseWrites(portal.db).length >= 2, "taken and run out through the store's conditional writes");

  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "the round on the hour", token: "x" }));
  const held = await sync(post());
  assert.equal(held.status, 409);
  assert.match(((await held.json()) as { error: string }).error, /try again in a minute/);
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).by, "the round on the hour", "the hour's lease is untouched");
});

test("the workbook upload takes the lease too, and is refused while somebody holds it", async () => {
  const { portal, bucket } = await oneManPortal();
  const upload = () => {
    const form = new FormData();
    form.append("file", new File([bytesOf("uploaded workbook")], "20260930 - CREW QUALIFICATION EXPIRY.xlsx", { type: "application/x" }));
    form.append("category", "training-matrix");
    form.append("onDuplicate", "replace");
    form.append("uploadedBy", "Matthew");
    return new Request("http://portal/api/files", { method: "POST", body: form });
  };
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "the round on the hour", token: "x" }));
  const held = await files(upload());
  assert.equal(held.status, 409);
  assert.equal(bucket.text("opms/20260930 - CREW QUALIFICATION EXPIRY.xlsx"), null, "nothing was written");

  portal.blobs.set("sync|round-lease", JSON.stringify({ until: 0, by: "the round on the hour", token: "x" }));
  const res = await files(upload());
  assert.equal(res.status, 201, await res.text());
  assert.equal(bucket.text("opms/20260930 - CREW QUALIFICATION EXPIRY.xlsx"), "uploaded workbook");
  const lease = JSON.parse(portal.blobs.get("sync|round-lease")!);
  assert.equal(lease.by, "Matthew", "the upload ran under its own lease");
  assert.equal(lease.until, 0, "…and gave it back");
});

test("the hour runs the sync and the round under one lease, taken once and run out at the end", async () => {
  const { portal, bucket } = await oneManPortal();
  const env = { DB: portal.db, FILES: bucket, FILE_STORE: "r2" };
  await worker.scheduled({} as never, env as never);
  const takes = leaseWrites(portal.db);
  assert.equal(takes.length, 2, "one take and one drop for the whole hour");
  const lease = JSON.parse(portal.blobs.get("sync|round-lease")!);
  assert.equal(lease.by, "the round on the hour");
  assert.equal(lease.until, 0, "run out at the end");
  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.syncError, null, "the sync ran");
  assert.equal(hourly.applied, 1, "and the round ran under the same lease, not refused by it");
  assert.equal(hourly.roundSkipped, null);
  assert.equal(JSON.parse(portal.blobs.get("sync|last-run")!).by, "hourly schedule");

  // An hour that finds the lease held stands down whole - no sync either.
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "Update portal", token: "y" }));
  const before = portal.db.asked.length;
  await worker.scheduled({} as never, env as never);
  assert.equal(JSON.parse(portal.blobs.get("sync|last-hourly")!).roundSkipped, "another round is still running");
  assert.ok(!portal.db.asked.slice(before).some((a) => /portal_state|FROM documents/.test(a.sql)), "nothing was read or written past the lease");
});

/* ------------------------------------------------------------------------ *
 * The office's own workbook, adopted from the folder, across the round and
 * the next sync. The round writes its own beside it and marks the office's
 * row removed, kept in place; the sync then finds the office's file still
 * in the folder - and must not put it back on the books, or swap the
 * round's own file for it.
 * ------------------------------------------------------------------------ */
test("the office's workbook stays off the books after the round replaces it, sync after sync", async () => {
  const { portal, bucket, tmKey } = await oneManPortal({ theirs: true });
  const theirs = bucket.text(tmKey);
  const out = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.equal(out.roundError, null);
  assert.equal(out.applied, 1);
  const named = datedWorkbookName("CREW QUALIFICATION EXPIRY.xlsx", todayThere());
  assert.equal(out.workbook, named);
  assert.equal(bucket.text(tmKey), theirs, "the office's file is exactly where it was");
  const office = portal.rows.find((r) => r.id === "tm1")!;
  assert.ok(office.removedAt, "the office's row is off the books");
  assert.equal(office.keptInPlace, 1, "…kept in place");
  assert.equal(office.blobKey, tmKey, "…still pointing at its own file");

  // The sync, an hour later, over the same folder.
  const seen = await survey();
  assert.deepEqual(seen.returned, [], "the office's row is not written back on: it was removed on purpose");
  assert.equal(seen.trainingSheet?.key, "opms/" + named, "the newest loose sheet is the round's own");
  const done = await apply(seen);
  assert.equal(done.returned, 0);
  assert.deepEqual(done.adopted, [], "nothing adopted: the round's own file is already live");
  const live = portal.rows.filter((r) => r.category === "training-matrix" && !r.removedAt);
  assert.deepEqual(live.map((r) => r.filename), [named], "exactly one training matrix is live");
  assert.equal(portal.rows.find((r) => r.id === "tm1")!.removedAt, office.removedAt, "the office's row is as the round left it");

  // And the round again, with nothing new: an idle hour, no clash, no error.
  const again = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.equal(again.roundError, null);
  assert.equal(again.roundSkipped, null);
  assert.equal(again.applied, 0);
  assert.equal(bucket.text(tmKey), theirs, "the office's file is still exactly where it was");
});

test("a pending copy left by a replace that was cut off is nobody's training matrix", async () => {
  const { bucket } = await oneManPortal();
  await bucket.put("opms/~pending 1234abcd - 20260930 - CREW QUALIFICATION EXPIRY.xlsx", bytesOf("half a replace"));
  const seen = await survey();
  assert.equal(seen.trainingSheet?.key, "opms/20260901 - CREW QUALIFICATION EXPIRY.xlsx", "the pending copy is passed over");
  assert.ok(!Object.keys(seen.sheetSeen).some((k) => k.includes("~pending")));
});

/* ------------------------------------------------------------------------ *
 * The page's Update the spreadsheet after the round: its comparison reads
 * names through the register the way the round does, so a cell the round
 * filled is claimed again and never taken for an orphan.
 * ------------------------------------------------------------------------ */
test("the page's comparison after the round claims the same cells, and its round clears nothing", async () => {
  const { portal } = await oneManPortal();
  await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  const doc = portal.doc();
  assert.deepEqual(doc.filledFromCert, { "EVANS, BRENTON::QL-01": true });

  // The route, as the page calls it: the matrix as the page holds it, with
  // the register's names on the rows.
  const req = new Request("http://portal/api/analyse", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "compare", cols: doc.quals.cols, rows: doc.quals.rows, sheet: null }),
  });
  const res = await (await analyse(req)).json() as { claimed: string[]; settled: unknown[]; summary: { unread: number }; notes: { kind: string }[] };
  assert.deepEqual(res.claimed, ["EVANS, BRENTON::QL-01"], "the certificate filed under bRENTON claims Evans's row");
  assert.ok(!res.notes.some((n) => n.kind === "not-on-matrix"), "nobody is 'not on the matrix'");

  // And the page's own settling over it, as UpdateTrainingMatrixInPlace runs it.
  const round = settleRound({
    filledFromCert: doc.filledFromCert, claimed: res.claimed, unread: res.summary.unread,
    settled: res.settled as never, nameOf: asKnownPerson(doc.people),
  });
  assert.deepEqual(round.orphans, [], "nothing the round filled is an orphan to the page");
  const laid = applySettled(doc.quals, round.settled);
  assert.deepEqual(laid.applied.filter((a) => a.to === ""), [], "nothing is cleared");
  assert.equal(laid.next.rows[0][3][0], "2031-05-26", "the date stands");
});

/* ------------------------------------------------------------------------ *
 * The removed list's buttons on the office's own file: never deleted for
 * good, never moved on restore, and taking it off the books leaves it be.
 * ------------------------------------------------------------------------ */
function officeFileDb(rows: Row[]) {
  const drizzle = drizzleOn(rows);
  return fakeDb((sql, args) => drizzle(sql, args));
}

test("delete for good refuses the office's file kept in place", async () => {
  const theirs = "opms/CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ [theirs]: "the office's copy" });
  const rows: Row[] = [keptRow("old", theirs)];
  setEnv({ DB: officeFileDb(rows), FILES: bucket, FILE_STORE: "r2" } as never);
  await assert.rejects(purgeDocument(rows[0] as never), KeptInPlace);
  assert.equal(bucket.text(theirs), "the office's copy", "the office's file is untouched");
  assert.equal(rows.length, 1, "and the row is still on the books");
});

test("restoring the office's file kept in place moves nothing", async () => {
  const theirs = "opms/CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ [theirs]: "the office's copy" });
  const rows: Row[] = [keptRow("old", theirs)];
  setEnv({ DB: officeFileDb(rows), FILES: bucket, FILE_STORE: "r2" } as never);
  const back = await restoreDocument(rows[0] as never);
  assert.equal(back.blobKey, theirs, "the row points where it always did");
  assert.equal(back.removedAt, null, "and is live again");
  assert.equal(back.keptInPlace, null);
  assert.deepEqual(bucket.keys(), [theirs], "nothing moved");
  assert.deepEqual(bucket.made, [], "no folder was made");
});

test("taking the office's adopted file off the books leaves it where the office put it", async () => {
  const theirs = "opms/spreadsheet/OPMS export.xlsx";
  const bucket = fakeBucket({ [theirs]: "the office's export" }, ["opms", "opms/spreadsheet", "removed"]);
  const rows: Row[] = [{ ...liveRow("op1", theirs, 1), category: "opms-sheet" }];
  setEnv({ DB: officeFileDb(rows), FILES: bucket, FILE_STORE: "r2" } as never);
  const gone = await removeDocument(rows[0] as never, "Matthew");
  assert.equal(gone.blobKey, theirs, "the row still points at the office's file");
  assert.equal(gone.keptInPlace, 1, "kept in place");
  assert.deepEqual(bucket.keys(), [theirs], "nothing was parked");
});

/* ------------------------------------------------------------------------ *
 * Which qualification expiry sheet is the newer: the date on the front,
 * then the library's modified time, and never the alphabet.
 * ------------------------------------------------------------------------ */
test("a dated sheet beats an undated one whatever the alphabet says", () => {
  const dated = { key: "opms/20260901 - CREW QUALIFICATION EXPIRY.xlsx", modified: "2026-09-01T00:00:00Z" };
  const undated = { key: "opms/CREW QUALIFICATION EXPIRY.xlsx", modified: "2026-08-01T00:00:00Z" };
  assert.equal(outranks(undated, dated), false, "an older undated export does not outrank the dated one");
  assert.equal(outranks(dated, undated), true, "the newer dated one outranks it");
  assert.deepEqual([undated, dated].sort(sheetOrder).map((f) => f.key), [dated.key, undated.key], "and sorts first");
});

test("two dated sheets: the later date wins; the same date falls to the modified time", () => {
  const a = { key: "opms/20260901 - X.xlsx", modified: "2026-09-24T00:00:00Z" };
  const b = { key: "opms/20260924 - X.xlsx", modified: "2026-09-01T00:00:00Z" };
  assert.equal(outranks(b, a), true, "the later date on the front wins, whatever was touched last");
  assert.equal(outranks(a, b), false);
  const c = { key: "opms/20260924 - X (2).xlsx", modified: "2026-09-24T05:00:00Z" };
  assert.equal(outranks(c, b), true, "the same date: the one touched later is the newer");
});

test("neither dated: the later modified time wins, and with none known nothing does", () => {
  const older = { key: "opms/Z qualification expiry.xlsx", modified: "2026-09-01T00:00:00Z" };
  const newer = { key: "opms/A qualification expiry.xlsx", modified: "2026-09-20T00:00:00Z" };
  assert.equal(outranks(newer, older), true);
  assert.equal(outranks(older, newer), false, "'Z' after 'A' counts for nothing");
  assert.equal(outranks({ key: "opms/A.xlsx" }, { key: "opms/B.xlsx" }), false, "unknown times: no swap");
  assert.equal(outranks(newer, newer), false, "a sheet never outranks itself");
});
