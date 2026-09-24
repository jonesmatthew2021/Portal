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
import analyse, { compareMatrix, refile } from "../src/routes/analyse.js";
import { KeptInPlace, ensureDocumentColumns, forgetDocumentColumns, purgeDocument, relocateToRemovedBlob, removeDocument, restoreDocument } from "../src/db/documents.js";
import { replaceSingleFile } from "../src/db/single-file.js";
import { saveDocument } from "../src/lib/shared-state.js";
import { runMatrixRound, roundRunning, leaseHolder, takeLease, dropLease, renewLease, keepEquivalences } from "../src/lib/round.js";
import { todayThere } from "../src/lib/analysis.js";
import sync, { apply, outranks, sheetOrder, survey } from "../src/routes/sync.js";
import roundRoute, { BUDGET_MS, LEASE_FOR_MS, progressAnswer } from "../src/routes/round.js";
import files from "../src/routes/files.js";
import renameFile from "../src/routes/rename-file.js";
import importSingle from "../src/routes/import-single.js";
import worker, { hourWaits, hourDeadline, syncLastAnswer } from "../src/index.js";
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

test("the refile labels certificates in batches, not a statement each", async () => {
  /* Two of Billy's scans read as Kachin's: two rows to label, one batch. */
  const rows = [{ ...billysTicket }, { ...billysTicket, id: "c3", filename: "master again.pdf" }];
  const batches: number[] = [];
  const db = fakeDb((sql) => {
    if (/FROM documents WHERE category = 'certificate'/.test(sql)) return { results: rows };
    if (/SELECT key, value FROM blobs/.test(sql)) return { results: [{ key: "r1/abc.json", value: JSON.stringify(reading) }] };
    if (/SELECT value FROM blobs/.test(sql)) return { results: [] };
    if (/SELECT data FROM portal_state/.test(sql)) return { results: [] };
    if (/^UPDATE documents SET person/.test(sql)) return { changes: 1 };
    return undefined;
  });
  const plain = db.batch.bind(db);
  db.batch = async (stmts) => { batches.push(stmts.length); return plain(stmts); };
  setEnv({ DB: db, FILE_STORE: "r2" } as never);
  const out = (await (await refile(["SITTIYOS, Kachin"])).json()) as { moved: { id: string; to: string }[] };
  assert.deepEqual(out.moved.map((m) => [m.id, m.to]), [["c1", "SITTIYOS, Kachin"], ["c3", "SITTIYOS, Kachin"]]);
  assert.deepEqual(batches, [2], "both labels went in one batch");
  assert.equal(db.asked.filter((a) => /^UPDATE documents SET person/.test(a.sql)).length, 2, "…and nowhere else");
});

test("the comparison writes a certificate's row only where the row does not already say the same", async () => {
  const nameOf = asKnownPerson([{ name: "SITTIYOS, Kachin", aliases: ["bILLY"] }]);
  const noted = (db: { asked: Asked[] }) => db.asked.filter((a) => /UPDATE documents\s+SET read_code/.test(a.sql));

  // A row that has never been written: one note goes down.
  const fresh = certificatesDb();
  setEnv({ DB: fresh, FILE_STORE: "r2" } as never);
  await compareMatrix(matrix, null, nameOf);
  assert.equal(noted(fresh).length, 1, "the reading is written onto the row");
  assert.deepEqual(noted(fresh)[0].args.slice(0, 6), ["c1", "QL-01", "2031-02-17", "2026-02-17", "AMSA", "Master <500GT"]);

  // The same row an hour later, already carrying exactly that: nothing written.
  const already = { ...billysTicket, readCode: "QL-01", readExpires: "2031-02-17", readIssued: "2026-02-17", readIssuer: "AMSA", readTitle: "Master <500GT" };
  const quiet = fakeDb((sql) => {
    if (/FROM documents WHERE category = 'certificate'/.test(sql)) return { results: [already] };
    if (/SELECT key, value FROM blobs/.test(sql)) return { results: [{ key: "r1/abc.json", value: JSON.stringify(reading) }] };
    if (/SELECT value FROM blobs/.test(sql)) return { results: [] };
    return undefined;
  });
  setEnv({ DB: quiet, FILE_STORE: "r2" } as never);
  const out = await compareMatrix(matrix, null, nameOf);
  assert.deepEqual(out.settled, [{ person: "SITTIYOS, Kachin", code: "QL-01", value: "2031-02-17" }], "the answer is the same");
  assert.deepEqual(noted(quiet), [], "and a quiet hour writes nothing");
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
/* What changed on the books - the documents table; the lease's own row in
   the sync store is not the books. */
const writes = (db: { asked: Asked[] }) => db.asked.filter((a) => /^(UPDATE|INSERT INTO) documents/.test(a.sql));
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

/* A skills matrix whose Equivalence sheet says a "Master <500GT" ticket
   belongs in the QL-17 column - which is not what the ticket's own reading
   says (QL-01), so a certificate filed by the sheet lands somewhere
   different from one filed without it. */
const skillsWorkbook = () => writeZip([
  zipPart("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`),
  zipPart("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Skills" sheetId="1" r:id="rId1"/><sheet name="Equivalence" sheetId="2" r:id="rId2"/></sheets></workbook>`),
  zipPart("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`),
  zipPart("xl/sharedStrings.xml", `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"></sst>`),
  zipPart("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Skills</t></is></c></row></sheetData></worksheet>`),
  zipPart("xl/worksheets/sheet2.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="B1" t="inlineStr"><is><t>Requirement</t></is></c><c r="C1" t="inlineStr"><is><t>Accepted</t></is></c></row>
<row r="2"><c r="B2" t="inlineStr"><is><t>QL-17  Medical</t></is></c><c r="C2" t="inlineStr"><is><t>QLE-03 Master <500GT</t></is></c></row>
<row r="3"><c r="B3" t="inlineStr"><is><t>QL-17 Medical</t></is></c><c r="C3" t="inlineStr"><is><t>QLE-03 Master <500GT again</t></is></c></row>
<row r="4"><c r="B4" t="inlineStr"><is><t>QL-99 Not a column</t></is></c><c r="C4" t="inlineStr"><is><t>QLE-04 Something</t></is></c></row>
<row r="5"><c r="B5" t="inlineStr"><is><t>QL-17 Medical</t></is></c><c r="C5" t="inlineStr"><is><t>QL-01 Master</t></is></c></row>
</sheetData></worksheet>`),
]);
const skillsKey = "opms/skills/SKILLS MATRIX.xlsx";

const oneManPortal = async (over: {
  orphanSeen?: Record<string, string>; filledFromCert?: Record<string, boolean>;
  /** The workbook as the office's own file, adopted from the folder. */
  theirs?: boolean;
  /** A skills matrix on file too, with the Equivalence sheet above. */
  skills?: boolean;
  /** The ticket's code as the office typed it (null: left to the reading). */
  qualCode?: string | null;
} = {}) => {
  const tmKey = over.theirs ? "opms/CREW QUALIFICATION EXPIRY.xlsx" : "opms/20260901 - CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ "opms/Brenton - OPMS/master.pdf": "a scan" }, ["opms", "removed", "opms/Brenton - OPMS", "opms/skills"]);
  await bucket.put(tmKey, await smallWorkbook().arrayBuffer());
  if (over.skills) await bucket.put(skillsKey, await skillsWorkbook().arrayBuffer());
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
      { ...billysTicket, id: "c2", person: "bRENTON", checksum: "evans-master", blobKey: "opms/Brenton - OPMS/master.pdf", sizeBytes: 6,
        qualCode: over.qualCode === undefined ? billysTicket.qualCode : over.qualCode },
      { ...liveRow("tm1", tmKey, over.theirs ? 1 : 0), sizeBytes: 5000 },
      ...(over.skills ? [{ ...liveRow("sk1", skillsKey, 1), category: "skills-matrix", sizeBytes: 4000 }] : []),
    ],
    { "r1/evans-master.json": { ...reading, holderName: "Brenton Evans", expiresOn: "2031-05-26" } },
  );
  setEnv({ DB: portal.db, FILES: bucket, FILE_STORE: "r2" } as never);
  return { portal, bucket, tmKey };
};

test("the round puts a certificate's date on the matrix and writes the office's workbook", async () => {
  const { portal, bucket, tmKey } = await oneManPortal();
  const said: number[] = [];
  const out = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0, say: (pct) => { said.push(pct); } });
  assert.equal(out.roundError, null, "no error");
  assert.equal(out.roundSkipped, null, "nothing skipped");
  assert.equal(out.workbookProblem, null);
  assert.equal(out.applied, 1, "one date applied");
  assert.equal(out.cleared, 0);
  assert.equal(out.written, 1, "one cell written into the workbook");
  const named = datedWorkbookName("20260901 - CREW QUALIFICATION EXPIRY.xlsx", todayThere());
  assert.equal(out.workbook, named, "filed under today's date");
  assert.equal(out.leftAsTyped, 0);
  assert.deepEqual(said, [20, 30, 60, 75, 85], "the round says where it has got to, in order - a word between the rewrite and the filing too");
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(out.at), "it says when it began");
  assert.deepEqual(out.changes, [{ person: "EVANS, Brenton", code: "QL-01", title: "Master", from: "", to: "2031-05-26" }], "the cell it moved");
  assert.equal(out.summary?.certificates, 1);
  assert.equal(out.summary?.read, 1);
  assert.equal(out.summary?.unread, 0);
  assert.equal(out.summary?.validitySheet, null);

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
  assert.equal(out.workbookId, rowsNow[1].id, "the outcome names the new workbook's row");
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
  assert.deepEqual(again.changes, [], "nothing moved");
  assert.equal(again.workbookId, null);
  assert.equal(portal.state.rev, 3, "an idle hour bumps no revision");
});

test("a workbook too big to rewrite on the server is a problem with the workbook, not a skipped round", async () => {
  /* The matrix still takes the date; the workbook is owed it, and the
     reason is said where the page can tell it from an hour that merely
     ran out of time - no hour will make a 7 MB file smaller. */
  const { portal, bucket, tmKey } = await oneManPortal();
  const tm = portal.rows.find((r) => r.id === "tm1")!;
  tm.sizeBytes = 7 * 1024 * 1024;
  const out = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.equal(out.roundError, null);
  assert.equal(out.roundSkipped, null, "the round itself ran");
  assert.match(out.workbookProblem || "", /too big/);
  assert.ok(!/press Update/.test(out.workbookProblem || ""), "no instruction to press a button");
  assert.equal(out.applied, 1, "the matrix took the date");
  assert.equal(out.workbook, null);
  assert.equal(out.workbookId, null);
  assert.deepEqual(portal.doc().workbookPending, ["EVANS, BRENTON|QL-01"], "the cell is owed to the workbook");
  assert.ok(bucket.text(tmKey), "the workbook on file is where it was");

  // A workbook that is not one: the same kind of answer.
  tm.sizeBytes = 5000; tm.filename = "CREW QUALIFICATION EXPIRY.pdf";
  const again = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.match(again.workbookProblem || "", /not a workbook/);
  assert.equal(again.roundSkipped, null);
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

test("a workbook write that fails is owed, and the next hour with nothing new pays it", async () => {
  const { portal, bucket, tmKey } = await oneManPortal();
  // The seed put was the bucket's first write; the round's first is the
  // new workbook to its dated address, and that one is refused.
  bucket.failOn = 2;
  const out = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.equal(out.applied, 1, "the matrix took the date");
  assert.match(out.roundError || "", /refused the write/);
  assert.equal(out.workbook, null);
  assert.deepEqual(portal.doc().workbookPending, ["EVANS, BRENTON|QL-01"], "the cell is written down as owed to the workbook");
  assert.ok(bucket.text(tmKey), "the workbook on file is where it was");

  // The next hour: nothing new on the matrix, but the workbook is owed.
  bucket.failOn = 0;
  const again = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.equal(again.roundError, null);
  assert.equal(again.applied, 0, "nothing new this hour");
  assert.equal(again.written, 1, "…and the owed cell reached the workbook");
  const named = datedWorkbookName("20260901 - CREW QUALIFICATION EXPIRY.xlsx", todayThere());
  assert.equal(again.workbook, named);
  assert.deepEqual(portal.doc().workbookPending, [], "nothing owed any more");
  assert.equal(portal.doc().history[0].action, "Updated the training matrix from the certificates");
  const written = await (await bucket.get("opms/" + named))!.arrayBuffer();
  const back = await partText(partOf(readZip(written), "xl/worksheets/sheet1.xml"));
  assert.ok(/<c r="E3"[^>]*><is><t[^>]*>2031-05-26<\/t>/.test(back), "the office's row got the date an hour late");

  // And the hour after that is idle: nothing owed, nothing written.
  const idle = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.equal(idle.written, null, "no workbook step");
  assert.equal(idle.roundError, null);
});

test("out of time before the workbook is owed the same way", async () => {
  const { portal } = await oneManPortal();
  let asked = 0;
  const out = await runMatrixRound({ by: "the round on the hour", timeLeft: () => ++asked < 2, mirroredThisHour: 0 });
  assert.match(out.roundSkipped || "", /the next hour writes it/);
  assert.deepEqual(portal.doc().workbookPending, ["EVANS, BRENTON|QL-01"]);
  const again = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.equal(again.written, 1);
  assert.deepEqual(portal.doc().workbookPending, []);
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
  const heldSaid = (await held.json()) as { error: string; by: string | null };
  assert.equal(heldSaid.error, "The round on the hour is writing the workbook; try again when it has finished.", "names the holder, promises no time");
  assert.equal(heldSaid.by, "the round on the hour", "…and carries the holder's name beside the sentence, as the round's 409 does");
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).by, "the round on the hour", "the hour's lease is untouched");

  // The holder may be a person's round from the page, not the hour: the
  // sentence names them, never the hour.
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "matthew", token: "x" }));
  const theirs = await sync(post());
  assert.equal(theirs.status, 409);
  const theirsSaid = (await theirs.json()) as { error: string; by: string | null };
  assert.equal(theirsSaid.error, "Matthew is writing the workbook; try again when it has finished.");
  assert.equal(theirsSaid.by, "matthew", "the person named, as the lease has them");
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
  const heldSaid = (await held.json()) as { error: string; by: string | null };
  assert.equal(heldSaid.error, "The round on the hour is writing the workbook; try again when it has finished.", "the same sentence as every other writer: the holder named, no time promised");
  assert.equal(heldSaid.by, "the round on the hour", "…and the holder's name beside it, as the round's 409 carries, so the page holds its buttons under the name from the first refusal");
  assert.equal(bucket.text("opms/20260930 - CREW QUALIFICATION EXPIRY.xlsx"), null, "nothing was written");

  // A person's round from the page holding it: named as the lease has them.
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "Kachin", token: "x" }));
  const theirs = await files(upload());
  assert.equal(theirs.status, 409);
  const theirsSaid = (await theirs.json()) as { error: string; by: string | null };
  assert.equal(theirsSaid.error, "Kachin is writing the workbook; try again when it has finished.");
  assert.equal(theirsSaid.by, "Kachin");

  portal.blobs.set("sync|round-lease", JSON.stringify({ until: 0, by: "the round on the hour", token: "x" }));
  const res = await files(upload());
  assert.equal(res.status, 201, await res.text());
  assert.equal(bucket.text("opms/20260930 - CREW QUALIFICATION EXPIRY.xlsx"), "uploaded workbook");
  const lease = JSON.parse(portal.blobs.get("sync|round-lease")!);
  assert.equal(lease.by, "Matthew", "the upload ran under its own lease");
  assert.equal(lease.until, 0, "…and gave it back");
});

/** The store's conditional write on the lease - the drop - refused by the
 *  database, the way a D1 hiccup refuses it; every other statement answers
 *  as before. */
function refuseLeaseDrop(portal: { db: ReturnType<typeof fakeDb> }) {
  const plain = portal.db.prepare;
  portal.db.prepare = (sql: string) => {
    const s = plain(sql);
    if (!/^UPDATE blobs SET value/.test(sql)) return s;
    const bind = s.bind;
    s.bind = (...a: unknown[]) => {
      const b = bind(...a);
      // The drop is the write that runs the lease out; a take writes a
      // fresh one and goes through.
      if (a[1] !== "round-lease" || JSON.parse(String(a[2])).until !== 0) return b;
      b.run = async () => { throw new Error("D1 is having a bad morning"); };
      return b;
    };
    return s;
  };
  return () => { portal.db.prepare = plain; };
}

/** Somebody else's work landing in the gap: `hook` runs once, just before
 *  the first statement `when` picks out goes to the database. The hour's
 *  round finishing its replace in the instant a route takes the lease is
 *  the case it is for. */
function beforeStatement(
  db: ReturnType<typeof fakeDb>,
  when: (sql: string, args: unknown[]) => boolean,
  hook: () => Promise<void>,
) {
  const plain = db.prepare;
  let fired = false;
  db.prepare = (sql: string) => {
    const s = plain(sql);
    const bind = s.bind;
    s.bind = (...a: unknown[]) => {
      const b = bind(...a);
      if (fired || !when(sql, a)) return b;
      for (const m of ["run", "all", "raw"] as const) {
        const real = b[m].bind(b);
        b[m] = (async () => {
          if (!fired) { fired = true; await hook(); }
          return real();
        }) as never;
      }
      return b;
    };
    return s;
  };
  return () => { db.prepare = plain; };
}
const isLeaseTake = (sql: string, args: unknown[]) =>
  /^(INSERT INTO|UPDATE) blobs/.test(sql) && args[1] === "round-lease" && JSON.parse(String(args[2])).until !== 0;

test("a completed replace or sync is not turned into an error by a lease drop that fails", async () => {
  /* No lease row yet, so the take is the insert and the drop the
     conditional write - which the database refuses. The work is done by
     then: the page must hear that, not a 500. */
  const { portal, bucket } = await oneManPortal();
  const quiet = console.error;
  console.error = () => {};
  const restore = refuseLeaseDrop(portal);
  try {
    const form = new FormData();
    form.append("file", new File([bytesOf("uploaded workbook")], "20260930 - CREW QUALIFICATION EXPIRY.xlsx", { type: "application/x" }));
    form.append("category", "training-matrix");
    form.append("onDuplicate", "replace");
    form.append("uploadedBy", "Matthew");
    const res = await files(new Request("http://portal/api/files", { method: "POST", body: form }));
    assert.equal(res.status, 201, await res.text());
    assert.equal(bucket.text("opms/20260930 - CREW QUALIFICATION EXPIRY.xlsx"), "uploaded workbook", "the replace landed");
    const lease = JSON.parse(portal.blobs.get("sync|round-lease")!);
    assert.equal(lease.by, "Matthew");
    assert.ok(lease.until > Date.now(), "the lease was not dropped, and runs out on its own");

    // The lease's row is left run out by hand, so the sync can take it.
    portal.blobs.set("sync|round-lease", JSON.stringify({ ...lease, until: 0 }));
    const synced = await sync(new Request("http://portal/api/sync", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ by: "Update portal" }),
    }));
    assert.equal(synced.status, 200, await synced.text());
    assert.equal(JSON.parse(portal.blobs.get("sync|last-run")!).by, "Update portal", "the sync ran and is on the record");

    // Import from SharePoint, the same way: the sync's lease run out by
    // hand, the import's own take goes in, its drop is refused, and the
    // page still hears that the file was taken.
    portal.blobs.set("sync|round-lease", JSON.stringify({ ...JSON.parse(portal.blobs.get("sync|round-lease")!), until: 0 }));
    const loose = "opms/20261001 - CREW QUALIFICATION EXPIRY.xlsx";
    await bucket.put(loose, bytesOf("dropped in by hand"));
    const imported = await importFrom(loose);
    assert.equal(imported.status, 200, await imported.text());
    const importLease = JSON.parse(portal.blobs.get("sync|round-lease")!);
    assert.equal(importLease.by, "Matthew", "the import ran under its own lease");
    assert.ok(importLease.until > Date.now(), "the drop was refused, so the lease runs out on its own");
    const live = portal.rows.filter((r) => r.category === "training-matrix" && !r.removedAt);
    assert.deepEqual(live.map((r) => r.blobKey), [loose], "and the import landed");
  } finally {
    restore();
    console.error = quiet;
  }

  // And the rename, on a database that refuses the drop the same way.
  const from = "opms/20260924 - CREW QUALIFICATION EXPIRY (2).xlsx";
  const renames = fakeBucket({ [from]: "the round's" });
  const db = renameDb([liveRow("tm2", from)], { until: 0, by: "the round on the hour", token: "x" }, { refuseDrop: true });
  setEnv({ DB: db, FILES: renames, FILE_STORE: "r2" } as never);
  console.error = () => {};
  try {
    const renamed = await renameTo("tm2", "20260924 - CREW QUALIFICATION EXPIRY.xlsx");
    assert.equal(renamed.status, 200, await renamed.text());
  } finally {
    console.error = quiet;
  }
  assert.deepEqual(renames.keys(), ["opms/20260924 - CREW QUALIFICATION EXPIRY.xlsx"], "the move landed");
  assert.equal(db.lease().by, "IT", "the rename ran under its own lease");
  assert.ok(db.lease().until > Date.now(), "the drop was refused, so the lease runs out on its own");
  const tried = leaseWrites(db).map((a) => JSON.parse(String(a.args[2])) as { until: number });
  assert.equal(tried.length, 2, "the drop was tried");
  assert.equal(tried[1].until, 0);
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
  // The record is written twice: once before the reading can spend the
  // hour's calls, saying the round has not run yet, and once at the end.
  const records = portal.db.asked
    .filter((a) => /^INSERT INTO blobs/.test(a.sql) && a.args[1] === "last-hourly")
    .map((a) => JSON.parse(String(a.args[2])));
  assert.equal(records.length, 2, "the hour is on the record before the reading and after the round");
  assert.equal(records[0].roundSkipped, "round not yet run");
  assert.equal(records[0].at, records[1].at, "the same hour both times");
  assert.equal(records[1].applied, 1);

  // An hour that finds the lease held for the next ten minutes waits its
  // five - twenty tries, fifteen seconds apart, none of them slept here -
  // and then stands down whole: no sync either.
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 10 * 60000, by: "Update portal", token: "y" }));
  const before = portal.db.asked.length;
  const waited: number[] = [];
  const realSleep = hourWaits.sleep;
  hourWaits.sleep = async (ms) => { waited.push(ms); };
  try {
    await worker.scheduled({} as never, env as never);
  } finally {
    hourWaits.sleep = realSleep;
  }
  assert.deepEqual(waited, Array(20).fill(15000), "twenty waits of fifteen seconds before giving up");
  assert.equal(JSON.parse(portal.blobs.get("sync|last-hourly")!).roundSkipped, "another round is still running");
  assert.ok(!portal.db.asked.slice(before).some((a) => /portal_state|FROM documents/.test(a.sql)), "nothing was read or written past the lease");
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).by, "Update portal", "the page's lease is untouched");
});

test("a lease that runs out while the hour is waiting is taken on a later try", async () => {
  const { portal, bucket } = await oneManPortal();
  const env = { DB: portal.db, FILES: bucket, FILE_STORE: "r2" };
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 5 * 60000, by: "Update portal", token: "y" }));
  // The page's turn ends during the third wait.
  let waits = 0;
  const realSleep = hourWaits.sleep;
  hourWaits.sleep = async () => {
    if (++waits === 3) portal.blobs.set("sync|round-lease", JSON.stringify({ until: 0, by: "Update portal", token: "y" }));
  };
  try {
    await worker.scheduled({} as never, env as never);
  } finally {
    hourWaits.sleep = realSleep;
  }
  assert.equal(waits, 3, "taken on the try after the third wait, and no more waiting");
  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.roundSkipped, null, "the hour ran");
  assert.equal(hourly.applied, 1, "…and the round with it");
  const lease = JSON.parse(portal.blobs.get("sync|round-lease")!);
  assert.equal(lease.by, "the round on the hour", "under the hour's own lease");
  assert.equal(lease.until, 0, "run out at the end");
});

test("the hour waits out a round somebody started from the page, three minutes long, and still runs", async () => {
  const { portal, bucket } = await oneManPortal();
  const env = { DB: portal.db, FILES: bucket, FILE_STORE: "r2" };
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 10 * 60000, by: "Matthew", token: "y" }));
  // Matthew's round gives the lease back three minutes in: twelve waits of
  // fifteen seconds, none of them slept here.
  let waits = 0;
  const realSleep = hourWaits.sleep;
  hourWaits.sleep = async () => {
    if (++waits === 12) portal.blobs.set("sync|round-lease", JSON.stringify({ until: 0, by: "Matthew", token: "y" }));
  };
  try {
    await worker.scheduled({} as never, env as never);
  } finally {
    hourWaits.sleep = realSleep;
  }
  assert.equal(waits, 12, "taken on the try after the twelfth wait");
  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.syncError, null, "the sync ran");
  assert.equal(hourly.applied, 1, "and the round");
  assert.equal(hourly.roundSkipped, null);
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).by, "the round on the hour");
});

test("the hour's budget shrinks with the wait: nine minutes from the lease, never past twelve from the tick", () => {
  const tick = 1_000_000;
  const min = 60 * 1000;
  assert.equal(hourDeadline(tick, tick), tick + 9 * min, "taken at once: nine minutes");
  assert.equal(hourDeadline(tick, tick + 2 * min), tick + 11 * min, "two minutes' wait: eleven from the tick");
  assert.equal(hourDeadline(tick, tick + 5 * min), tick + 12 * min, "five minutes' wait: capped at twelve, not fourteen");
  assert.ok(hourDeadline(tick, tick + 5 * min) <= tick + 15 * min - 3 * min, "three of the fifteen always left for the write in flight");
});

test("an hour that waited five minutes and runs long stops before the workbook rather than past the fifteenth minute", async () => {
  /* The clock here is a fake: each wait for the lease moves it fifteen
     seconds, the lease is freed on the twentieth (five minutes in), and the
     matrix save moves it seven minutes more - past twelve from the tick,
     though not past nine from the lease. The workbook is left owed. */
  const { portal, bucket, tmKey } = await oneManPortal();
  const env = { DB: portal.db, FILES: bucket, FILE_STORE: "r2" };
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 10 * 60000, by: "Matthew", token: "y" }));
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  let waits = 0;
  const realSleep = hourWaits.sleep;
  hourWaits.sleep = async () => {
    offset += 15000;
    if (++waits === 20) portal.blobs.set("sync|round-lease", JSON.stringify({ until: 0, by: "Matthew", token: "y" }));
  };
  const restore = beforeStatement(portal.db, (sql) => /UPDATE portal_state SET data/.test(sql), async () => { offset += 7 * 60000; });
  try {
    await worker.scheduled({} as never, env as never);
  } finally {
    hourWaits.sleep = realSleep;
    Date.now = realNow;
    restore();
  }
  assert.equal(waits, 20, "taken on the try after the twentieth wait");
  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.applied, 1, "the matrix took the date");
  assert.match(hourly.roundSkipped || "", /out of time before the workbook/);
  assert.equal(hourly.workbook, null);
  assert.deepEqual(portal.doc().workbookPending, ["EVANS, BRENTON|QL-01"], "the cell is owed to the workbook");
  assert.ok(bucket.text(tmKey), "the workbook on file is where it was");
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).until, 0, "the lease was still given back");
});

/* ------------------------------------------------------------------------ *
 * The skills matrix's Equivalence sheet, kept by the worker itself. It says
 * which column a certificate belongs in, and so what the file is renamed
 * to - so it is read before the refile, and a certificate the sheet
 * re-homes takes its name the first hour, not the next.
 * ------------------------------------------------------------------------ */
const equivalenceWrites = (db: { asked: Asked[] }) =>
  db.asked.filter((a) => /^(INSERT INTO|UPDATE) blobs/.test(a.sql) && a.args[1] === "equivalences.json");

test("the Equivalence sheet is read off the skills matrix once, and a re-homed certificate is renamed the first hour", async () => {
  const { portal, bucket } = await oneManPortal({ skills: true, qualCode: null });
  // A key so the hour runs its reading and refile; every certificate is
  // already read, so the model is never asked.
  const env = { DB: portal.db, FILES: bucket, FILE_STORE: "r2", ANTHROPIC_API_KEY: "k" };
  await worker.scheduled({} as never, env as never);

  const kept = JSON.parse(portal.blobs.get("matrix-readings|equivalences.json")!);
  assert.deepEqual(kept.rows, [{ held: "Master <500GT", code: "QL-17" }],
    "one row: the first for a held code wins, a wanted code off the matrix is dropped, a column answering for a column is not this table's");
  assert.equal(kept.skillsId, "sk1", "kept against the skills matrix it was read from");
  assert.equal(equivalenceWrites(portal.db).length, 1);

  const ticket = portal.rows.find((r) => r.id === "c2")!;
  assert.equal(ticket.filename, "EVANS, Brenton - QL-17 Medical.pdf", "renamed under the column the sheet gives it, this hour");
  assert.equal(ticket.blobKey, "opms/Brenton - OPMS/EVANS, Brenton - QL-17 Medical.pdf", "in the folder it was in");
  assert.ok(bucket.text("opms/Brenton - OPMS/EVANS, Brenton - QL-17 Medical.pdf"), "the file moved with it");
  assert.equal(bucket.text("opms/Brenton - OPMS/master.pdf"), null);
  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.refiled, 2, "the label and the rename");
  assert.equal(hourly.readError, null);

  // The next hour finds it held for this skills matrix and reads nothing.
  await worker.scheduled({} as never, env as never);
  assert.equal(equivalenceWrites(portal.db).length, 1, "not written again");
  assert.deepEqual(JSON.parse(portal.blobs.get("matrix-readings|equivalences.json")!).rows, kept.rows);
});

test("equivalences the page stored, with no skills matrix named, are read again off the sheet and kept against it", async () => {
  const { portal } = await oneManPortal({ skills: true });
  portal.blobs.set("matrix-readings|equivalences.json", JSON.stringify({ rows: [{ held: "Something else", code: "QL-01" }], at: "2026-09-01T00:00:00Z" }));
  const first = await keepEquivalences();
  assert.equal(first.written, true);
  assert.equal(first.rows, 1);
  assert.equal(first.problem, null);
  const again = await keepEquivalences();
  assert.equal(again.written, false, "held for this skills matrix already");
  assert.equal(again.rows, 1);
  assert.equal(equivalenceWrites(portal.db).length, 1);

  // No skills matrix on file: nothing to read, nothing to say.
  const bare = await oneManPortal();
  assert.deepEqual(await keepEquivalences(), { rows: 0, written: false, problem: null });
  assert.equal(bare.portal.blobs.has("matrix-readings|equivalences.json"), false);
});

/** How many times the skills workbook's bytes were fetched. */
function countingGets(bucket: { get: (key: string) => Promise<unknown> }, key: string) {
  const real = bucket.get.bind(bucket);
  let n = 0;
  bucket.get = async (k: string) => { if (k === key) n++; return real(k); };
  return () => n;
}

test("a sheet that gives nothing against the matrix's columns writes nothing over the page's rows", async () => {
  /* The page never posts an empty table (storeEquivalences posts only when
     it has rows), and neither does this: the sheet's rows all want QL-17,
     and with QL-17 not a column they are all dropped. What the page stored
     stands, and is not read again for the same skills matrix and columns. */
  const { portal, bucket } = await oneManPortal({ skills: true });
  const doc = portal.doc(); doc.quals.cols = [["QL-01", "Master", "Qualifications"]]; portal.state.data = JSON.stringify(doc);
  portal.blobs.set("matrix-readings|equivalences.json", JSON.stringify({ rows: [{ held: "Something else", code: "QL-01" }], at: "2026-09-01T00:00:00Z" }));
  const gets = countingGets(bucket, skillsKey);
  const out = await keepEquivalences();
  assert.deepEqual(out, { rows: 1, written: false, problem: null });
  assert.equal(equivalenceWrites(portal.db).length, 0, "no write of the table at all");
  assert.deepEqual(JSON.parse(portal.blobs.get("matrix-readings|equivalences.json")!).rows, [{ held: "Something else", code: "QL-01" }], "the page's rows stand");
  assert.equal(gets(), 1, "the workbook was read once");
  assert.deepEqual(await keepEquivalences(), out, "the same answer again");
  assert.equal(gets(), 1, "…without reading the workbook again");

  // Nothing held at all: the same read, and a problem said.
  portal.blobs.delete("matrix-readings|equivalences.json");
  portal.blobs.delete("matrix-readings|m2/equivalences-tried-sk1.json");
  const none = await keepEquivalences();
  assert.equal(none.rows, 0);
  assert.equal(none.written, false);
  assert.match(none.problem || "", /gave no usable rows/);
  assert.equal(portal.blobs.has("matrix-readings|equivalences.json"), false, "still no empty table");
  assert.equal(gets(), 2);
  assert.match((await keepEquivalences()).problem || "", /gave no usable rows/, "remembered, and said again");
  assert.equal(gets(), 2, "…without a read");
  // The page then stores rows of its own: the problem is over, and the
  // remembered read still spares the workbook.
  portal.blobs.set("matrix-readings|equivalences.json", JSON.stringify({ rows: [{ held: "Something else", code: "QL-01" }], at: "2026-09-01T00:00:00Z" }));
  assert.deepEqual(await keepEquivalences(), { rows: 1, written: false, problem: null });
  assert.equal(gets(), 2);
});

test("a table the server stamped against columns since changed does not quiet a sheet that now gives nothing", async () => {
  /* The hour read the sheet against QL-01 and stamped what it kept. The
     crew matrix's columns then change to QL-50, and the sheet gives nothing
     against them. The old table stays (never an empty one over it), but it
     maps certificates to a column that is off the matrix now, so the
     problem is said - every hour, from the remembered read - rather than
     the stamped table passing for the page's own answer. */
  const { portal, bucket } = await oneManPortal({ skills: true });
  portal.blobs.set("matrix-readings|equivalences.json", JSON.stringify({
    rows: [{ held: "Master <500GT", code: "QL-01" }], at: "2026-09-01T00:00:00Z", skillsId: "sk1", colsKey: "QL-01",
  }));
  const doc = portal.doc(); doc.quals.cols = [["QL-50", "Not on the sheet", "Qualifications"]]; portal.state.data = JSON.stringify(doc);
  const gets = countingGets(bucket, skillsKey);
  const out = await keepEquivalences();
  assert.equal(out.rows, 1, "the stamped table stands");
  assert.equal(out.written, false);
  assert.match(out.problem || "", /no usable rows/, "…but the problem is said over it");
  assert.equal(JSON.parse(portal.blobs.get("matrix-readings|equivalences.json")!).colsKey, "QL-01", "no empty table written, no restamp");
  assert.match((await keepEquivalences()).problem || "", /no usable rows/, "said again from the remembered read");
  assert.equal(gets(), 1, "…without reading the workbook again");
});

test("a skills matrix with no bytes on file is looked at again next hour, not remembered", async () => {
  const { portal, bucket } = await oneManPortal({ skills: true });
  await bucket.delete(skillsKey);
  const gets = countingGets(bucket, skillsKey);
  const first = await keepEquivalences();
  assert.match(first.problem || "", /no bytes on file/);
  assert.equal(portal.blobs.has("matrix-readings|m2/equivalences-tried-sk1.json"), false, "not remembered");
  // The bytes land (the sync mends the replace): the sheet is read.
  await bucket.put(skillsKey, await skillsWorkbook().arrayBuffer());
  const then = await keepEquivalences();
  assert.deepEqual(then, { rows: 1, written: true, problem: null });
  assert.equal(gets(), 2);
});

test("a crew matrix with no columns keeps no Equivalence table, from prepare or the round", async () => {
  const { portal, bucket } = await oneManPortal({ skills: true });
  const doc = portal.doc(); doc.quals = { cols: [], rows: [] }; portal.state.data = JSON.stringify(doc);
  const gets = countingGets(bucket, skillsKey);
  const eq = await keepEquivalences();
  assert.equal(eq.rows, 0);
  assert.match(eq.problem || "", /no items yet/);
  assert.equal(gets(), 0, "the workbook was not even read for the Equivalence sheet");
  assert.equal(portal.blobs.has("matrix-readings|equivalences.json"), false, "nothing stamped against this skills matrix");
  // prepare says the same (its own read of the workbook is for the expiry rules).
  const out = (await (await postRound({}, "/api/round/prepare")).json()) as { equivalences: number; problem: string | null };
  assert.equal(out.equivalences, 0);
  assert.match(out.problem || "", /no items yet/);
  assert.equal(portal.blobs.has("matrix-readings|equivalences.json"), false);
});

test("the Equivalence table is read again when the crew matrix's columns change, and the page's identical rows are only stamped", async () => {
  const { portal, bucket } = await oneManPortal({ skills: true });
  // The page stored the very rows the sheet gives, without saying which
  // skills matrix: one read, and only the stamp is added.
  portal.blobs.set("matrix-readings|equivalences.json", JSON.stringify({ rows: [{ held: "Master <500GT", code: "QL-17" }], at: "2026-09-01T00:00:00Z" }));
  const gets = countingGets(bucket, skillsKey);
  const first = await keepEquivalences();
  assert.deepEqual(first, { rows: 1, written: false, problem: null }, "the same rows are not counted as written");
  const kept = JSON.parse(portal.blobs.get("matrix-readings|equivalences.json")!);
  assert.equal(kept.skillsId, "sk1");
  assert.equal(kept.colsKey, "QL-01|QL-17");
  assert.equal(gets(), 1);
  await keepEquivalences();
  assert.equal(gets(), 1, "current: not read again");

  // A column added to the crew matrix: read again against the new columns.
  const doc = portal.doc(); doc.quals.cols.push(["QL-20", "Something new", "Qualifications"]); portal.state.data = JSON.stringify(doc);
  await keepEquivalences();
  assert.equal(gets(), 2, "read again for the new column");
  assert.equal(JSON.parse(portal.blobs.get("matrix-readings|equivalences.json")!).colsKey, "QL-01|QL-17|QL-20");
});

test("the page's equivalences action can say which skills matrix it read, and then the hour reads nothing", async () => {
  const { portal, bucket } = await oneManPortal({ skills: true });
  const req = new Request("http://portal/api/analyse", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "equivalences", rows: [{ held: "Master <500GT", code: "QL-17" }], skillsId: "sk1" }),
  });
  assert.deepEqual(await (await analyse(req)).json(), { stored: 1 });
  const kept = JSON.parse(portal.blobs.get("matrix-readings|equivalences.json")!);
  assert.equal(kept.skillsId, "sk1");
  assert.equal(kept.colsKey, "QL-01|QL-17");
  const gets = countingGets(bucket, skillsKey);
  assert.deepEqual(await keepEquivalences(), { rows: 1, written: false, problem: null });
  assert.equal(gets(), 0, "held for this skills matrix and these columns: the workbook is not read");
});

test("a skills matrix that is not a workbook is said on the hour's record, and on the round's answer", async () => {
  const { portal, bucket } = await oneManPortal({ skills: true });
  portal.rows.find((r) => r.id === "sk1")!.filename = "SKILLS MATRIX.pdf";
  await worker.scheduled({} as never, { DB: portal.db, FILES: bucket, FILE_STORE: "r2" } as never);
  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.match(hourly.equivalenceProblem || "", /not a workbook/);
  assert.equal(hourly.roundError, null, "the round itself ran");
  assert.equal(hourly.applied, 1);

  const page = await oneManPortal({ skills: true });
  page.portal.rows.find((r) => r.id === "sk1")!.filename = "SKILLS MATRIX.pdf";
  const out = (await (await postRound({ by: "Matthew" })).json()) as { equivalenceProblem: string | null };
  assert.match(out.equivalenceProblem || "", /not a workbook/);
  assert.match(JSON.parse(page.portal.blobs.get("sync|last-hourly")!).equivalenceProblem || "", /not a workbook/);
});

/* ------------------------------------------------------------------------ *
 * The round started from the page: POST /api/round runs the same round the
 * hour runs, under the same lease, and answers with the whole outcome.
 * ------------------------------------------------------------------------ */
const manager = { id: "u1", role: "management", name: "Matthew Jones", email: "m@portal" } as never;
const postRound = (body: Record<string, unknown> = {}, path = "/api/round") => roundRoute(
  new Request("http://portal" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  manager, path,
);
const progressWrites = (db: { asked: Asked[] }) =>
  db.asked.filter((a) => /^(INSERT INTO|UPDATE) blobs/.test(a.sql) && a.args[1] === "round-progress")
    .map((a) => JSON.parse(String(a.args[2])) as { pct: number; word: string; done: boolean; by: string });

test("POST /api/round runs the round in the caller's name and answers with everything it did", async () => {
  const { portal, bucket } = await oneManPortal();
  const res = await postRound({ by: "Matthew" });
  const out = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.applied, 1);
  assert.equal(out.roundError, null);
  assert.equal(out.roundSkipped, null);
  assert.deepEqual(out.changes, [{ person: "EVANS, Brenton", code: "QL-01", title: "Master", from: "", to: "2031-05-26" }]);
  const named = datedWorkbookName("20260901 - CREW QUALIFICATION EXPIRY.xlsx", todayThere());
  assert.equal(out.workbook, named);
  const newRow = portal.rows.find((r) => r.category === "training-matrix" && !r.removedAt)!;
  assert.equal(out.workbookId, newRow.id, "the new workbook's row");
  assert.equal((out.summary as { certificates: number }).certificates, 1);
  assert.equal(portal.doc().quals.rows[0][3][0], "2031-05-26", "the cell moved");
  assert.ok(bucket.text("opms/" + named), "the dated workbook is in the library");
  assert.equal(portal.doc().history[1].by, "Matthew", "the log names who ran it");

  const lease = JSON.parse(portal.blobs.get("sync|round-lease")!);
  assert.equal(lease.by, "Matthew");
  assert.equal(lease.until, 0, "given back");

  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.by, "Matthew");
  assert.equal(hourly.applied, 1);
  assert.equal(hourly.roundSkipped, null);
  assert.equal(hourly.read, 0);
  assert.equal(hourly.refiled, 0);
  assert.ok(!("changes" in hourly) && !("summary" in hourly), "the record carries the counts, not the cells");
  assert.equal(typeof hourly.at, "number");

  const progress = JSON.parse(portal.blobs.get("sync|round-progress")!);
  assert.equal(progress.pct, 100);
  assert.equal(progress.word, "Done");
  assert.equal(progress.done, true);
  assert.equal(progress.by, "Matthew");
  assert.deepEqual(progressWrites(portal.db).map((p) => p.pct), [1, 20, 30, 60, 75, 85, 100], "said in order, under its own key");
  assert.equal(progressWrites(portal.db).find((p) => p.pct === 85)?.word, "Filing the workbook in the library", "the word before the replace in the library");
  assert.equal(portal.blobs.has("sync|progress"), false, "the sync's key is untouched");
});

test("the round from the page holds a short lease, is kept alive past the browser, and carries the page's runId", async () => {
  /* The platform can cancel a request whose browser has gone, so the lease
     must run out before the hour's five-minute wait for it does, and the
     work is handed to waitUntil as well as awaited. */
  const { portal } = await oneManPortal();
  const kept: Promise<unknown>[] = [];
  const before = Date.now();
  const res = await roundRoute(
    new Request("http://portal/api/round", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ by: "Matthew", runId: "run-7" }) }),
    manager, "/api/round", (work) => { kept.push(work); },
  );
  const out = (await res.json()) as { runId: string; applied: number };
  assert.equal(res.status, 200);
  assert.equal(out.runId, "run-7", "the answer carries the page's mark");
  assert.equal(out.applied, 1);
  assert.equal(kept.length, 1, "the work was registered with the platform");
  assert.equal(await kept[0], res, "…and it is the very answer");
  const take = JSON.parse(String(leaseWrites(portal.db)[0].args[2])) as { until: number };
  assert.ok(take.until <= before + LEASE_FOR_MS + 1000, "the lease stands for the budget plus two minutes, not the hour's fifteen");
  assert.ok(take.until > before + BUDGET_MS, "…but outlives the budget");
  assert.ok(LEASE_FOR_MS - BUDGET_MS >= 2 * 60 * 1000, "two minutes for the write in flight: the budget only decides whether the workbook step may start");
  assert.ok(LEASE_FOR_MS < 5 * 60 * 1000, "shorter than the hour's wait for it");
  const words = progressWrites(portal.db) as unknown as { runId: string }[];
  assert.ok(words.length >= 2 && words.every((w) => w.runId === "run-7"), "every word carries the runId");
});

test("the round from the page keeps its lease alive on every word, so a lapsed lease only ever means a dead round", async () => {
  /* A fake clock: the matrix save moves it a minute and a half (inside the
     budget, so the workbook step still starts), and the workbook step's
     first read three minutes more - four and a half in all, past the
     LEASE_FOR_MS the lease was taken for, as a slow store or a long write
     might. The lease as taken would have lapsed by the workbook's filing
     word, and a second press, or the hour, could have taken it over a
     write still in flight. The round renews it on every word of progress,
     so at that word it is still the round's own, and a second taker is
     refused. */
  const { portal } = await oneManPortal();
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const seen = { lease: null as { until: number; by: string; token: string } | null, now: 0, running: false, holder: null as string | null, secondTake: null as unknown };
  const clock = beforeStatement(portal.db, (sql) => /UPDATE portal_state SET data/.test(sql), async () => { offset += 90 * 1000; });
  let pastSeventyFive = false;
  const word = beforeStatement(portal.db,
    (sql, a) => /^(INSERT INTO|UPDATE) blobs/.test(sql) && a[1] === "round-progress" && (JSON.parse(String(a[2])) as { pct: number }).pct === 75,
    async () => { pastSeventyFive = true; });
  const write = beforeStatement(portal.db,
    (sql, a) => pastSeventyFive && /FROM documents WHERE category = \?1 AND removed_at IS NULL/.test(sql) && a[0] === "training-matrix",
    async () => { offset += 3 * 60 * 1000; });
  const look = beforeStatement(portal.db,
    (sql, a) => /^(INSERT INTO|UPDATE) blobs/.test(sql) && a[1] === "round-progress" && (JSON.parse(String(a[2])) as { pct: number }).pct === 85,
    async () => {
      seen.lease = JSON.parse(portal.blobs.get("sync|round-lease")!);
      seen.now = Date.now();
      seen.running = await roundRunning();
      seen.holder = await leaseHolder();
      seen.secondTake = await takeLease("Matthew again", undefined, LEASE_FOR_MS);
    });
  try {
    const res = await postRound({ by: "Matthew", runId: "run-11" });
    assert.equal(res.status, 200, await res.text());
  } finally {
    Date.now = realNow;
    clock();
    word();
    write();
    look();
  }
  const take = JSON.parse(String(leaseWrites(portal.db)[0].args[2])) as { until: number; token: string };
  assert.ok(seen.lease, "the workbook step was reached");
  assert.ok(LEASE_FOR_MS < 270 * 1000, "the clock moved four and a half minutes, past the lease as taken");
  assert.ok(take.until < seen.now, "the lease as taken had lapsed by the workbook's filing word");
  assert.equal(seen.lease!.token, take.token, "…and the lease held then is still the round's own");
  assert.equal(seen.lease!.by, "Matthew");
  assert.ok(seen.lease!.until > seen.now, "renewed: it stands");
  assert.ok(seen.lease!.until <= seen.now + LEASE_FOR_MS + 1000, "…for the same again, not the hour's fifteen");
  assert.equal(seen.running, true, "so the lease reads as held");
  assert.equal(seen.holder, "Matthew", "…under the round's name, and the page's rule does not call it cut off");
  assert.equal(seen.secondTake, null, "a second press mid-write is refused: never two writers");
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).until, 0, "given back at the end all the same");
  const renewals = leaseWrites(portal.db).map((a) => JSON.parse(String(a.args[2])) as { until: number; token: string });
  assert.ok(renewals.filter((l) => l.token === take.token && l.until > 0).length >= 2, "taken once and renewed on the words that followed");
});

test("a lease is renewed by its holder alone: a foreign token changes nothing", async () => {
  const { portal } = await oneManPortal();
  const held = { until: Date.now() + 60000, by: "Matthew", token: "mine" };
  portal.blobs.set("sync|round-lease", JSON.stringify(held));
  assert.equal(await renewLease("not-mine", LEASE_FOR_MS), false, "not the holder's token: refused");
  assert.deepEqual(JSON.parse(portal.blobs.get("sync|round-lease")!), held, "…and the lease is as it was");
  assert.equal(await renewLease("mine", LEASE_FOR_MS), true, "the holder's own: renewed");
  const now = JSON.parse(portal.blobs.get("sync|round-lease")!) as { until: number; by: string; token: string };
  assert.equal(now.token, "mine");
  assert.equal(now.by, "Matthew");
  assert.ok(now.until >= held.until + LEASE_FOR_MS - 60000 - 1000, "…for the full span again");
  // A holder whose lease lapsed with nobody taking it can still renew: the
  // round is alive, and the token is still the last taker's.
  portal.blobs.set("sync|round-lease", JSON.stringify({ ...held, until: Date.now() - 1000 }));
  assert.equal(await renewLease("mine", LEASE_FOR_MS), true, "lapsed but not taken: the round that holds it carries on");
  assert.equal(await renewLease("mine", LEASE_FOR_MS), true);
  portal.blobs.delete("sync|round-lease");
  assert.equal(await renewLease("mine", LEASE_FOR_MS), false, "no lease at all: nothing to renew");
});

test("a lease that passed to the hour between the workbook's words leaves the workbook to the hour, and the cells stay owed", async () => {
  /* The bytes read and the rewrite between the 75 and 85 words are the
     round's longest silence. Here the lease lapses in it and the hour
     takes it (the lease blob is the hour's by the time the workbook's row
     is read). The 85 word's renewal then finds the lease no longer the
     round's, so the round does not run the replace on the office's
     workbook beside the hour: the matrix stays saved, the cell is owed,
     the record names who has the lease, and the hour's lease is left as
     the hour's. Then, the lease free, the next round pays the cell - so a
     live lease never trips the same check. */
  const { portal, bucket, tmKey } = await oneManPortal();
  let pastSeventyFive = false;
  const word = beforeStatement(portal.db,
    (sql, a) => /^(INSERT INTO|UPDATE) blobs/.test(sql) && a[1] === "round-progress" && (JSON.parse(String(a[2])) as { pct: number }).pct === 75,
    async () => { pastSeventyFive = true; });
  const taken = beforeStatement(portal.db,
    (sql, a) => pastSeventyFive && /FROM documents WHERE category = \?1 AND removed_at IS NULL/.test(sql) && a[0] === "training-matrix",
    async () => { portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "the round on the hour", token: "hour" })); });
  let out: Record<string, unknown>;
  try {
    const res = await postRound({ by: "Matthew", runId: "run-12" });
    out = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200, JSON.stringify(out));
  } finally {
    word();
    taken();
  }
  assert.equal(out.applied, 1, "the matrix took the date before the lease passed");
  assert.equal(out.roundError, null, "nothing failed: the round stood aside");
  assert.equal(out.roundSkipped, "the lease passed to the round on the hour mid-round; the workbook was not written", "the reason names the holder");
  assert.equal(out.workbook, null, "no workbook filed");
  assert.equal(out.written, null);
  const named = datedWorkbookName("20260901 - CREW QUALIFICATION EXPIRY.xlsx", todayThere());
  assert.equal(bucket.text("opms/" + named), null, "the replace never ran: no dated copy in the library");
  assert.ok(bucket.text(tmKey), "…and the office's workbook is where it was");
  assert.equal(portal.doc().quals.rows[0][3][0], "2031-05-26", "the matrix keeps the date");
  assert.deepEqual(portal.doc().workbookPending, ["EVANS, BRENTON|QL-01"], "the cell is written down as owed to the workbook");
  assert.deepEqual(progressWrites(portal.db).map((p) => p.pct), [1, 20, 30, 60, 75, 85, 100], "the 85 word was said - it is the renewal that found the lease gone");
  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.roundSkipped, "the lease passed to the round on the hour mid-round; the workbook was not written", "…and the record says so");
  const lease = JSON.parse(portal.blobs.get("sync|round-lease")!) as { by: string; token: string; until: number };
  assert.equal(lease.by, "the round on the hour", "the hour's lease is left as the hour's");
  assert.equal(lease.token, "hour");
  assert.ok(lease.until > 0, "…and not run out by the round's own drop");

  // The hour done and the lease free: the next round from the page finds
  // its lease its own at every word and pays the owed cell.
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: 0, by: "the round on the hour", token: "hour" }));
  const again = await postRound({ by: "Matthew", runId: "run-13" });
  const paid = (await again.json()) as Record<string, unknown>;
  assert.equal(again.status, 200, JSON.stringify(paid));
  assert.equal(paid.roundSkipped, null, "a lease held all the way through trips nothing");
  assert.equal(paid.applied, 0, "nothing new on the matrix");
  assert.equal(paid.written, 1, "…and the owed cell reached the workbook");
  assert.equal(paid.workbook, named);
  assert.ok(bucket.text("opms/" + named), "the dated workbook is in the library now");
  assert.deepEqual(portal.doc().workbookPending, [], "nothing owed any more");
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).until, 0, "given back");
});

test("GET /api/sync/last says whether the lease is held and by whom, so a wait names whoever has it at each look", async () => {
  const { portal } = await oneManPortal();
  const free = await syncLastAnswer();
  assert.equal(free.running, false);
  assert.equal(free.holder, null);
  assert.equal(free.sync, null);
  assert.equal(free.hourly, null);
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "the round on the hour", token: "x" }));
  const hours = await syncLastAnswer();
  assert.equal(hours.running, true);
  assert.equal(hours.holder, "the round on the hour");
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "Kachin", token: "y" }));
  assert.equal((await syncLastAnswer()).holder, "Kachin", "the lease passed to a person: the next look names them");
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: 0, by: "Kachin", token: "y" }));
  const done = await syncLastAnswer();
  assert.equal(done.running, false);
  assert.equal(done.holder, null, "given back: nobody named");
});

test("with no name sent and nobody signed in, the round is the page's", async () => {
  const { portal } = await oneManPortal();
  const res = await roundRoute(
    new Request("http://portal/api/round", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    null, "/api/round",
  );
  assert.equal(res.status, 200);
  assert.equal(portal.doc().history[0].by, "the page");
  assert.equal(JSON.parse(portal.blobs.get("sync|last-hourly")!).by, "the page");
});

test("GET /api/round/progress answers the last word, whether the lease is held, and by whom", async () => {
  const { portal } = await oneManPortal();
  assert.deepEqual(await progressAnswer(), { pct: 0, word: "No round has run yet", done: true, running: false, holder: null });

  // Asked mid-round - as the 60 word lands - the answer says the lease is
  // held under the record's own `by`. That, not `running` alone, is how a
  // page tells its round's lease from one the hour took after it died.
  const plain = portal.db.prepare;
  const seen = { midRound: null as Record<string, unknown> | null };
  portal.db.prepare = (sql: string) => {
    const s = plain(sql);
    if (!/^(INSERT INTO|UPDATE) blobs/.test(sql)) return s;
    const bind = s.bind;
    s.bind = (...a: unknown[]) => {
      const b = bind(...a);
      if (a[1] !== "round-progress" || (JSON.parse(String(a[2])) as { pct: number }).pct !== 60) return b;
      const run = b.run.bind(b);
      b.run = async () => {
        const out = await run();
        portal.db.prepare = plain;
        seen.midRound = await progressAnswer();
        return out;
      };
      return b;
    };
    return s;
  };
  await postRound({ by: "Matthew" });
  portal.db.prepare = plain;
  const midRound = seen.midRound;
  assert.ok(midRound, "the 60 word was said");
  assert.equal(midRound.running, true);
  assert.equal(midRound.holder, "Matthew", "the lease is held under the record's by");
  assert.equal(midRound.by, "Matthew");
  assert.equal(midRound.done, false);

  const after = await progressAnswer();
  assert.equal(after.pct, 100);
  assert.equal(after.done, true);
  assert.equal(after.by, "Matthew");
  assert.equal(after.running, false);
  assert.equal(after.holder, null, "the round dropped its lease: nobody holds it");
  assert.equal(typeof after.runId, "string", "a runId of the server's own when the page sent none");
  assert.equal(portal.blobs.has("sync|round-progress"), true);

  // The hour taking the lease after a page's round died: running is true,
  // but the holder is not the record's by - the page's rule calls it dead.
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "the round on the hour", token: "x" }));
  const hours = await progressAnswer();
  assert.equal(hours.running, true);
  assert.equal(hours.holder, "the round on the hour");
  assert.equal(hours.by, "Matthew", "the record is still the page's round's");
});

test("a workbook the server cannot write is on the record as a skipped round, so the open tab writes it", async () => {
  /* The tab reads roundSkipped and roundError alone (shouldTabRound in
     source/index.html) to decide whether to run the round itself, and its
     own button rewrites a workbook of any size in the browser. */
  const hour = await oneManPortal();
  hour.portal.rows.find((r) => r.id === "tm1")!.sizeBytes = 7 * 1024 * 1024;
  await worker.scheduled({} as never, { DB: hour.portal.db, FILES: hour.bucket, FILE_STORE: "r2" } as never);
  const hourly = JSON.parse(hour.portal.blobs.get("sync|last-hourly")!);
  assert.match(hourly.workbookProblem || "", /too big/);
  assert.equal(hourly.roundSkipped, hourly.workbookProblem, "said on roundSkipped too");
  assert.equal(hourly.applied, 1, "the matrix took the date");

  const page = await oneManPortal();
  page.portal.rows.find((r) => r.id === "tm1")!.sizeBytes = 7 * 1024 * 1024;
  const out = (await (await postRound({ by: "Matthew" })).json()) as { roundSkipped: string | null; workbookProblem: string | null };
  assert.equal(out.roundSkipped, null, "the round's own answer keeps them apart");
  assert.match(out.workbookProblem || "", /too big/);
  const record = JSON.parse(page.portal.blobs.get("sync|last-hourly")!);
  assert.equal(record.roundSkipped, record.workbookProblem);
  assert.match(record.roundSkipped || "", /too big/);
});

test("POST /api/round while the hour holds the lease is refused, and says who holds it", async () => {
  const { portal } = await oneManPortal();
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "the round on the hour", token: "x" }));
  const res = await postRound({ by: "Matthew", runId: "run-9" });
  assert.equal(res.status, 409);
  const out = (await res.json()) as { error: string; by: string; runId: string };
  assert.match(out.error, /^The round on the hour is writing the workbook/, "a sentence the page can show as it is");
  assert.ok(!/in a minute/.test(out.error), "no promise of a minute: the hour holds the lease far longer");
  assert.equal(out.by, "the round on the hour");
  assert.equal(out.runId, "run-9");
  assert.equal(portal.blobs.has("sync|round-progress"), false, "no progress record written");
  assert.equal(portal.state.rev, 1, "the document is untouched");
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).by, "the round on the hour", "the hour's lease stands");
});

test("refused for the lease, a store that cannot say who holds it still answers 409, with nobody named", async () => {
  /* The take reads the lease held; the second read - the one that names
     the holder for the sentence - is refused by the store. That is a 409
     with the plain sentence, never a 500: the page's rule for a 409 body
     with no `by` is to wait, and a 500 would read as a broken round. */
  const { portal } = await oneManPortal();
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "the round on the hour", token: "x" }));
  const plain = portal.db.prepare;
  let reads = 0;
  portal.db.prepare = (sql: string) => {
    const s = plain(sql);
    if (!/SELECT value, etag FROM blobs/.test(sql)) return s;
    const bind = s.bind;
    s.bind = (...a: unknown[]) => {
      const b = bind(...a);
      if (a[1] !== "round-lease" || ++reads !== 2) return b;
      b.all = async () => { throw new Error("D1 is having a bad morning"); };
      b.first = async () => { throw new Error("D1 is having a bad morning"); };
      return b;
    };
    return s;
  };
  const res = await postRound({ by: "Matthew", runId: "run-10" });
  portal.db.prepare = plain;
  assert.equal(res.status, 409, "refused, not fallen over");
  const out = (await res.json()) as { error: string; by: string | null; runId: string };
  assert.equal(out.error, "Another round is writing the workbook; try again when it has finished.");
  assert.equal(out.by, null, "nobody named: the read was refused");
  assert.equal(out.runId, "run-10");
  assert.equal(reads, 2, "the take read it, then the naming read was the one refused");
  assert.equal(portal.state.rev, 1, "the document is untouched");
});

test("the round from the page and the round on the hour leave the same document", async () => {
  const hour = await oneManPortal();
  await worker.scheduled({} as never, { DB: hour.portal.db, FILES: hour.bucket, FILE_STORE: "r2" } as never);
  const page = await oneManPortal();
  const res = await postRound({});
  assert.equal(res.status, 200);
  const a = hour.portal.doc(), b = page.portal.doc();
  assert.deepEqual(b.quals, a.quals);
  assert.deepEqual(b.filledFromCert, a.filledFromCert);
  assert.deepEqual(b.orphanSeen, a.orphanSeen);
  assert.deepEqual(b.workbookPending, a.workbookPending);
  assert.deepEqual(
    b.history.map((h: { action: string; detail: string }) => [h.action, h.detail]),
    a.history.map((h: { action: string; detail: string }) => [h.action, h.detail]),
  );
  assert.equal(b.history[0].by, "Matthew Jones", "with no name sent, the person signed in");
  assert.equal(a.history[0].by, "the round on the hour");
});

test("POST /api/round/prepare keeps the rules without the lease, and is idempotent", async () => {
  const { portal } = await oneManPortal({ skills: true });
  const first = await postRound({}, "/api/round/prepare");
  const out = (await first.json()) as { equivalences: number; validity: boolean; problem: string | null };
  assert.equal(first.status, 200, JSON.stringify(out));
  assert.equal(out.equivalences, 1);
  assert.equal(out.validity, false, "the skills matrix here has no Guidance Information sheet");
  assert.match(out.problem || "", /Guidance Information/);
  assert.deepEqual(await (await postRound({}, "/api/round/prepare")).json(), out, "the same answer again");
  assert.equal(equivalenceWrites(portal.db).length, 1, "the sheet was read once");
  assert.equal(leaseWrites(portal.db).length, 0, "no lease taken");
  assert.equal(portal.state.rev, 1, "nothing saved");

  const bare = await oneManPortal();
  assert.deepEqual(await (await postRound({}, "/api/round/prepare")).json(), { equivalences: 0, validity: false, problem: null });
  assert.equal(bare.portal.state.rev, 1);
});

/* ------------------------------------------------------------------------ *
 * Renaming a filed document never writes over anything. The page used to
 * rename a workbook filed as "… (2).xlsx" back onto the wanted name - the
 * very name the replace had stepped round because the office's file, a
 * removed copy or a loose file holds it.
 * ------------------------------------------------------------------------ */
function renameDb(rows: Row[], lease: unknown = null, opts: { refuseDrop?: boolean } = {}) {
  // The one row of the sync store the rename touches, carried across
  // writes so the drop reads back what the take wrote.
  let held = lease as { by: string; until: number } | null;
  const db = fakeDb((sql, args) => {
    if (/SELECT id, filename, blob_key, adopted_from_folder FROM documents WHERE id = \?1 AND removed_at IS NULL/.test(sql)) {
      return { results: rows.filter((r) => r.id === args[0] && !r.removedAt).map((r) => ({ id: r.id, filename: r.filename, blob_key: r.blobKey, adopted_from_folder: r.adoptedFromFolder ?? null })) };
    }
    if (/SELECT id FROM documents WHERE blob_key = \?1 AND id != \?2/.test(sql)) {
      return { results: rows.filter((r) => r.blobKey === args[0] && r.id !== args[1]).map((r) => ({ id: r.id })) };
    }
    // The round lease, as the rename takes it: a row with its version mark
    // where one is given, and the take and the drop going in.
    if (/SELECT value, etag FROM blobs/.test(sql)) return { results: held ? [{ value: JSON.stringify(held), etag: "mark" }] : [] };
    if (/^(INSERT INTO|UPDATE) blobs/.test(sql)) {
      const next = JSON.parse(String(args[2])) as { by: string; until: number };
      // The drop is the write that runs the lease out; a database having a
      // bad morning refuses it, and the lease stays as the take left it.
      if (opts.refuseDrop && next.until === 0) throw new Error("D1 is having a bad morning");
      held = next;
      return { changes: 1 };
    }
    // A write lands only on a row that is there and live, as the real
    // database's "AND removed_at IS NULL" makes it.
    if (/^UPDATE documents SET filename/.test(sql)) return { changes: rows.some((r) => r.id === args[0] && !r.removedAt) ? 1 : 0 };
    return undefined;
  });
  return Object.assign(db, { lease: () => held! });
}
const renameTo = (id: string, to: string) => renameFile(
  new Request("http://portal/api/rename-file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, to }) }),
  { role: "it", email: "it@portal", name: "IT" } as never,
);

test("a rename onto a name a removed copy holds is refused, and nothing moves", async () => {
  const wanted = "opms/20260924 - CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ [wanted]: "OFFICE", "opms/20260924 - CREW QUALIFICATION EXPIRY (2).xlsx": "the round's" });
  const db = renameDb([keptRow("old", wanted), liveRow("tm2", "opms/20260924 - CREW QUALIFICATION EXPIRY (2).xlsx")]);
  setEnv({ DB: db, FILES: bucket, FILE_STORE: "r2" } as never);
  const res = await renameTo("tm2", "20260924 - CREW QUALIFICATION EXPIRY.xlsx");
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /already in that folder/);
  assert.equal(bucket.text(wanted), "OFFICE", "the office's bytes are untouched");
  assert.equal(bucket.text("opms/20260924 - CREW QUALIFICATION EXPIRY (2).xlsx"), "the round's", "and the round's file is where it was");
  assert.deepEqual(writes(db), [], "nothing on the books changed");
});

test("a rename onto a file in the folder on no row is refused too", async () => {
  const wanted = "opms/20260924 - CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ [wanted]: "dropped in by hand", "opms/20260924 - CREW QUALIFICATION EXPIRY (2).xlsx": "the round's" });
  const db = renameDb([liveRow("tm2", "opms/20260924 - CREW QUALIFICATION EXPIRY (2).xlsx")]);
  setEnv({ DB: db, FILES: bucket, FILE_STORE: "r2" } as never);
  const res = await renameTo("tm2", "20260924 - CREW QUALIFICATION EXPIRY.xlsx");
  assert.equal(res.status, 409);
  assert.equal(bucket.text(wanted), "dropped in by hand");
});

test("the office's own file is never renamed, and nothing is renamed while the hour holds the workbook", async () => {
  const theirs = "opms/CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({ [theirs]: "the office's copy" });
  setEnv({ DB: renameDb([liveRow("tm1", theirs, 1)]), FILES: bucket, FILE_STORE: "r2" } as never);
  const office = await renameTo("tm1", "20260924 - CREW QUALIFICATION EXPIRY.xlsx");
  assert.equal(office.status, 409);
  assert.match(((await office.json()) as { error: string }).error, /the office's own file/);

  const heldDb = renameDb([liveRow("tm1", theirs)], { until: Date.now() + 60000, by: "the round on the hour", token: "x" });
  setEnv({ DB: heldDb, FILES: bucket, FILE_STORE: "r2" } as never);
  const held = await renameTo("tm1", "20260924 - CREW QUALIFICATION EXPIRY.xlsx");
  assert.equal(held.status, 409);
  const heldSaid = (await held.json()) as { error: string; by: string };
  assert.equal(heldSaid.error, "The round on the hour is writing the workbook; try again when it has finished.", "names the holder, promises no time");
  assert.equal(heldSaid.by, "the round on the hour", "and says who beside it, for the page's buttons");
  assert.deepEqual(bucket.keys(), [theirs], "nothing moved either time");
  assert.deepEqual(writes(heldDb), [], "nothing on the books changed");
  assert.deepEqual(leaseWrites(heldDb), [], "and the hour's lease was not touched");
});

test("a rename onto a free name moves the file and the row follows it, under a lease of its own", async () => {
  const from = "opms/20260924 - CREW QUALIFICATION EXPIRY (2).xlsx";
  const bucket = fakeBucket({ [from]: "the round's" });
  // The hour's lease from earlier, run out: the rename takes it over.
  const db = renameDb([liveRow("tm2", from)], { until: 0, by: "the round on the hour", token: "x" });
  setEnv({ DB: db, FILES: bucket, FILE_STORE: "r2" } as never);
  const res = await renameTo("tm2", "20260924 - CREW QUALIFICATION EXPIRY.xlsx");
  assert.equal(res.status, 200, await res.text());
  assert.deepEqual(bucket.keys(), ["opms/20260924 - CREW QUALIFICATION EXPIRY.xlsx"], "moved, not copied");
  assert.deepEqual(writes(db)[0].args, ["tm2", "20260924 - CREW QUALIFICATION EXPIRY.xlsx", "opms/20260924 - CREW QUALIFICATION EXPIRY.xlsx"]);
  const lease = leaseWrites(db).map((a) => JSON.parse(String(a.args[2])) as { by: string; until: number });
  assert.equal(lease.length, 2, "taken once and dropped once");
  assert.equal(lease[0].by, "IT", "taken in the renamer's name");
  assert.ok(lease[0].until > Date.now());
  assert.equal(lease[1].until, 0, "…and run out at the end");
});

test("a rename whose row went off the books between the read and the lease is refused, and nothing is written", async () => {
  /* The row used to be read once, before the lease. The hour's round could
     finish its replace in between - the row parked flat, its file moved -
     and the rename then moved the parked copy, or nothing, and wrote the
     new name onto a row that was off the books. Here the replace lands in
     the instant the rename takes the lease. */
  const from = "opms/20260924 - CREW QUALIFICATION EXPIRY (2).xlsx";
  const parked = "removed/tm2 - 20260924 - CREW QUALIFICATION EXPIRY (2).xlsx";
  const bucket = fakeBucket({ [from]: "the round's" });
  const rows: Row[] = [liveRow("tm2", from)];
  const db = renameDb(rows, { until: 0, by: "the round on the hour", token: "x" });
  const restore = beforeStatement(db, isLeaseTake, async () => {
    rows[0].removedAt = 5; rows[0].blobKey = parked;
    await bucket.put(parked, bytesOf("the round's"));
    await bucket.delete(from);
  });
  setEnv({ DB: db, FILES: bucket, FILE_STORE: "r2" } as never);
  try {
    const res = await renameTo("tm2", "20260924 - CREW QUALIFICATION EXPIRY.xlsx");
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /has changed; reload and try again/);
  } finally {
    restore();
  }
  assert.deepEqual(bucket.keys(), [parked], "nothing was written to the store");
  assert.deepEqual(writes(db), [], "nothing on the books changed");
  const lease = leaseWrites(db).map((a) => JSON.parse(String(a.args[2])) as { until: number });
  assert.equal(lease.length, 2, "the lease was taken and given back");
  assert.equal(lease[1].until, 0);

  // The same row taken off the books later still - after the read under
  // the lease, while the copy is being written. The books refuse the
  // write, the copy is taken out again, and nothing is left pointing at it.
  const again: Row[] = [liveRow("tm2", from)];
  const later = renameDb(again, { until: 0, by: "the round on the hour", token: "x" });
  const store = fakeBucket({ [from]: "the round's" });
  const restoreLater = beforeStatement(later, (sql) => /^SELECT id FROM documents WHERE blob_key/.test(sql), async () => {
    again[0].removedAt = 5;
  });
  setEnv({ DB: later, FILES: store, FILE_STORE: "r2" } as never);
  try {
    const res = await renameTo("tm2", "20260924 - CREW QUALIFICATION EXPIRY.xlsx");
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /has changed; reload and try again/);
  } finally {
    restoreLater();
  }
  assert.deepEqual(store.keys(), [from], "the copy written under the new name was taken out again");
  assert.match(writes(later)[0].sql, /AND removed_at IS NULL/, "the write lands only on a live row");
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

/* Import from SharePoint files the office's own file as the office's, and
   steps the current one down the way a removal does - so the next sync
   finds one live, revives nothing, and swaps nothing of the office's. */
const importFrom = (key: string) => importSingle(
  new Request("http://portal/api/import-single", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: "training-matrix", key }) }),
  "Matthew",
);

test("Import from SharePoint over the office's live workbook: theirs kept in place, the new one theirs too, one live after the sync", async () => {
  const { portal, bucket, tmKey } = await oneManPortal({ theirs: true });
  const newer = "opms/20260923 - CREW QUALIFICATION EXPIRY.xlsx";
  await bucket.put(newer, bytesOf("the office's newer export"));
  const res = await importFrom(newer);
  const out = (await res.json()) as { record: { filename: string }; restored: boolean; error?: string };
  assert.equal(res.status, 200, out.error || "");
  assert.equal(out.record.filename, "20260923 - CREW QUALIFICATION EXPIRY.xlsx");

  const office = portal.rows.find((r) => r.id === "tm1")!;
  assert.ok(office.removedAt, "the office's old row is off the books");
  assert.equal(office.keptInPlace, 1, "…kept in place");
  assert.equal(office.blobKey, tmKey, "…its file where the office put it");
  assert.ok(bucket.text(tmKey), "and the bytes still there");
  const taken = portal.rows.find((r) => r.blobKey === newer)!;
  assert.equal(taken.adoptedFromFolder, 1, "the imported file is the office's: never to be moved");
  assert.equal(taken.removedAt, null);

  const seen = await survey();
  assert.deepEqual(seen.returned, [], "the sync revives nothing");
  await apply(seen);
  const live = portal.rows.filter((r) => r.category === "training-matrix" && !r.removedAt);
  assert.deepEqual(live.map((r) => r.blobKey), [newer], "exactly one training matrix is live");
  assert.deepEqual(bucket.made, [], "no folder was made");
});

test("Import from SharePoint over the portal's own dated copy parks it flat, and refuses while the hour holds the workbook", async () => {
  const { portal, bucket, tmKey } = await oneManPortal();
  const loose = "opms/20260930 - CREW QUALIFICATION EXPIRY.xlsx";
  await bucket.put(loose, bytesOf("dropped in by hand"));
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: Date.now() + 60000, by: "the round on the hour", token: "x" }));
  const before = portal.db.asked.length;
  const refused = await importFrom(loose);
  assert.equal(refused.status, 409, "refused while the lease stands");
  const refusedSaid = (await refused.json()) as { error: string; by: string };
  assert.equal(refusedSaid.error, "The round on the hour is writing the workbook; try again when it has finished.", "names the holder, promises no time");
  assert.equal(refusedSaid.by, "the round on the hour", "and says who beside it, for the page's buttons");
  assert.equal(portal.rows.find((r) => r.id === "tm1")!.removedAt, null, "nothing stepped down");
  assert.ok(!portal.db.asked.slice(before).some((a) => /^(UPDATE|INSERT)/.test(a.sql)), "nothing written at all");
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).by, "the round on the hour", "the hour's lease is untouched");

  portal.blobs.set("sync|round-lease", JSON.stringify({ until: 0, by: "the round on the hour", token: "x" }));
  assert.equal((await importFrom(loose)).status, 200);
  const lease = JSON.parse(portal.blobs.get("sync|round-lease")!);
  assert.equal(lease.by, "Matthew", "the import ran under its own lease");
  assert.equal(lease.until, 0, "…and gave it back");
  const mine = portal.rows.find((r) => r.id === "tm1")!;
  assert.ok(mine.removedAt);
  assert.equal(mine.keptInPlace, null);
  assert.equal(mine.blobKey, "removed/tm1 - 20260901 - CREW QUALIFICATION EXPIRY.xlsx", "the portal's own copy is parked flat");
  assert.equal(bucket.text(tmKey), null, "and its old name is free");
  assert.deepEqual(bucket.made, [], "no folder was made");
});

test("Import from SharePoint reads the books under the lease, so a round that finished in the gap is seen", async () => {
  /* The rows used to be read before the lease was taken. The hour's round
     could finish its replace and drop its lease in between, and the import
     then worked off a stale picture: it stepped down the row the round had
     already parked, and never saw the round's own new row - so two
     workbooks stayed live. Here the round's replace lands in the very
     instant the import takes the lease. */
  const { portal, bucket, tmKey } = await oneManPortal();
  const loose = "opms/20260930 - CREW QUALIFICATION EXPIRY.xlsx";
  await bucket.put(loose, bytesOf("dropped in by hand"));
  const rounds = "opms/20260924 - CREW QUALIFICATION EXPIRY.xlsx";
  const parked = "removed/tm1 - 20260901 - CREW QUALIFICATION EXPIRY.xlsx";
  const restore = beforeStatement(portal.db, isLeaseTake, async () => {
    // The round's replace: the portal's old copy parked flat, the round's
    // own file filed live beside it.
    const mine = portal.rows.find((r) => r.id === "tm1")!;
    mine.removedAt = 5; mine.removedBy = "the round on the hour"; mine.blobKey = parked;
    await bucket.put(parked, bytesOf("the old copy"));
    await bucket.delete(tmKey);
    portal.rows.push({ ...liveRow("tm2", rounds), uploadedBy: "the round on the hour" });
    await bucket.put(rounds, bytesOf("the round's"));
  });
  const before = portal.db.asked.length;
  try {
    const res = await importFrom(loose);
    assert.equal(res.status, 200, await res.text());
  } finally {
    restore();
  }
  const log = portal.db.asked.slice(before);
  const take = log.findIndex((a) => isLeaseTake(a.sql, a.args));
  const read = log.findIndex((a) => /^select .+ from "documents"/.test(a.sql));
  assert.ok(take >= 0 && read > take, "the rows are read after the lease is taken, not before");

  const live = portal.rows.filter((r) => r.category === "training-matrix" && !r.removedAt);
  assert.deepEqual(live.map((r) => r.blobKey), [loose], "exactly one training matrix is live: the one imported");
  const theirs = portal.rows.find((r) => r.id === "tm2")!;
  assert.ok(theirs.removedAt, "the round's own row, the one actually live, is the one stepped down");
  assert.equal(theirs.blobKey, "removed/tm2 - 20260924 - CREW QUALIFICATION EXPIRY.xlsx", "…parked flat");
  assert.equal(bucket.text(theirs.blobKey), "the round's");
  assert.equal(bucket.text(rounds), null, "and its name is free");
  const mine = portal.rows.find((r) => r.id === "tm1")!;
  assert.equal(mine.blobKey, parked, "the row the round parked is left as the round left it");
  assert.equal(mine.removedBy, "the round on the hour", "…not stepped down a second time");
  assert.equal(bucket.text(parked), "the old copy");
  assert.deepEqual(bucket.made, [], "no folder was made");
});

test("the sync's swap steps down every live training matrix, not only the newest", async () => {
  /* Two live rows - the portal's own dated copy, newest, and behind it the
     office's adopted file that should have stepped down long ago - and a
     newer export dropped in the folder. */
  const { portal, bucket, tmKey } = await oneManPortal();
  const theirs = "opms/CREW QUALIFICATION EXPIRY.xlsx";
  await bucket.put(theirs, bytesOf("the office's own"));
  portal.rows.push({ ...liveRow("tm0", theirs, 1), createdAt: 0 });
  const newer = "opms/20260923 - CREW QUALIFICATION EXPIRY.xlsx";
  await bucket.put(newer, bytesOf("the office's newer export"));
  bucket.made.length = 0;

  const seen = await survey();
  assert.equal(seen.trainingSheet?.key, newer);
  const done = await apply(seen);
  assert.deepEqual(done.adopted.map((a) => a.key), [newer]);
  const live = portal.rows.filter((r) => r.category === "training-matrix" && !r.removedAt);
  assert.deepEqual(live.map((r) => r.blobKey), [newer], "exactly one live");
  const mine = portal.rows.find((r) => r.id === "tm1")!;
  assert.equal(mine.blobKey, "removed/tm1 - 20260901 - CREW QUALIFICATION EXPIRY.xlsx", "the portal's own copy parked flat");
  assert.equal(bucket.text(tmKey), null);
  const office = portal.rows.find((r) => r.id === "tm0")!;
  assert.ok(office.removedAt, "the older twin stepped down too");
  assert.deepEqual([office.keptInPlace, office.blobKey], [1, theirs], "…the office's file kept in place");
  assert.equal(bucket.text(theirs), "the office's own");
  assert.deepEqual(bucket.made, [], "no folder was made");
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
 * The SharePoint driver makes a folder only under the portal's own, and
 * says so; anywhere else in the library, a write that would need one is
 * refused with the folder named.
 * ------------------------------------------------------------------------ */
test("the library driver refuses to make a folder outside the portal's own, and says when it makes one under it", async () => {
  /* Graph, answered by hand: sign-in, the site, its one library, and a
     folder listing in which the office's folders exist and nothing below
     them does. Every request is written down. */
  const calls: { method: string; path: string }[] = [];
  const exists = new Set([
    "United Operations Team",
    "United Operations Team/OPMS Documents",
    "United Operations Team/Crew Portal",
  ]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    const path = decodeURIComponent(url.replace(/^https:\/\/[^/]+/, ""));
    calls.push({ method, path });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path.includes("/oauth2/")) return json({ access_token: "t", expires_in: 3600 });
    if (/^\/v1\.0\/sites\/[^/]+:\/sites\/\w+$/.test(path)) return json({ id: "site1" });
    if (path === "/v1.0/sites/site1/drives") return json({ value: [{ id: "d1", name: "Documents" }] });
    if (method === "GET") {
      const m = /^\/v1\.0\/drives\/d1\/root:\/(.+)$/.exec(path);
      return m && exists.has(m[1]) ? json({ id: "f", size: 0 }) : json({ error: "not found" }, 404);
    }
    if (method === "POST" && path.endsWith(":/children")) {
      const parent = /root:\/(.+):\/children$/.exec(path)![1];
      exists.add(`${parent}/${JSON.parse(String(init!.body)).name}`);
      return json({ id: "new" }, 201);
    }
    if (method === "PUT") return json({ id: "put" });
    return json({ error: "unexpected " + method + " " + path }, 500);
  }) as typeof fetch;
  const said: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
  try {
    setEnv({
      FILE_STORE: "sharepoint", MS_TENANT_ID: "tenant", MS_CLIENT_ID: "app", MS_CLIENT_SECRET: "secret",
      SHAREPOINT_HOSTNAME: "x.sharepoint.com", SHAREPOINT_SITE_PATH: "/sites/Team", SHAREPOINT_LIBRARY: "Documents",
      SHAREPOINT_ROOT: "United Operations Team/Crew Portal",
      SHAREPOINT_MAP: JSON.stringify({ "opms/": "United Operations Team/OPMS Documents/" }),
    } as never);
    const { fileStore } = await import("../src/files/store.js");

    // A certificate for somebody the library has no folder for: refused.
    await assert.rejects(
      fileStore().set("opms/NOBODY, Here/x.pdf", bytesOf("scan")),
      /the folder United Operations Team\/OPMS Documents\/NOBODY, Here is not in the library/,
    );
    const made = () => calls.filter((c) => c.method === "POST" && c.path.endsWith(":/children")).map((c) => c.path);
    assert.deepEqual(made(), [], "no folder was made");
    assert.ok(!calls.some((c) => c.method === "PUT"), "and nothing was written");

    // A parked copy under the portal's own folder: the folder is made, and said.
    await fileStore().set("removed/tm1 - old.xlsx", bytesOf("parked"));
    assert.deepEqual(
      made(),
      ["/v1.0/drives/d1/root:/United Operations Team/Crew Portal:/children"],
      "one folder made, under the portal's own",
    );
    assert.ok(calls.some((c) => c.method === "PUT" && c.path.endsWith("/Crew Portal/removed/tm1 - old.xlsx:/content")), "then the file written");
    assert.deepEqual(said, ["made the folder United Operations Team/Crew Portal/removed in the library"]);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
});

/* ------------------------------------------------------------------------ *
 * The two columns the worker adds itself, on a database that has no
 * documents table yet: nothing to alter, and the request goes through.
 * ------------------------------------------------------------------------ */
test("a fresh database with no documents table is let through, not altered", async () => {
  forgetDocumentColumns();
  const db = fakeDb((sql) => {
    if (/PRAGMA table_info/.test(sql)) return { results: [] };
    return undefined;
  });
  setEnv({ DB: db } as never);
  await ensureDocumentColumns();
  assert.deepEqual(db.asked.filter((a) => /ALTER TABLE/.test(a.sql)), [], "no ALTER on a table that is not there");

  // The table appears missing a moment later, to the ALTER itself.
  forgetDocumentColumns();
  const late = fakeDb((sql) => {
    if (/PRAGMA table_info/.test(sql)) return { results: [{ name: "id" }] };
    if (/ALTER TABLE/.test(sql)) throw new Error("D1_ERROR: no such table: documents");
    return undefined;
  });
  setEnv({ DB: late } as never);
  await ensureDocumentColumns();
  assert.equal(late.asked.filter((a) => /ALTER TABLE/.test(a.sql)).length, 2, "both columns were tried, and neither stopped the request");
  forgetDocumentColumns();
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

test("an undated drop never outranks a dated current sheet, however recently it was touched", () => {
  const dated = { key: "opms/20260901 - CREW QUALIFICATION EXPIRY.xlsx", modified: "2026-09-01T00:00:00Z" };
  const touched = { key: "opms/CREW QUALIFICATION EXPIRY.xlsx", modified: "2026-09-24T09:00:00Z" };
  assert.equal(outranks(touched, dated), false, "touched this morning, still not the newer sheet");
  assert.equal(outranks(touched, { key: dated.key }), false, "…nor when the current one's time is unknown");
  assert.deepEqual([touched, dated].sort(sheetOrder).map((f) => f.key), [dated.key, touched.key], "the dated one still sorts first");
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
