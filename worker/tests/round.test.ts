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
import { runMatrixRound, roundRunning } from "../src/lib/round.js";
import { todayThere } from "../src/lib/analysis.js";
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
  Object.entries(readings).forEach(([k, v]) => blobs.set("certificate-readings|" + k, JSON.stringify(v)));
  const db = fakeDb((sql, args) => {
    if (/PRAGMA table_info/.test(sql)) return { results: [{ name: "adopted_from_folder" }, { name: "kept_in_place" }] };
    if (/SELECT data, rev FROM portal_state/.test(sql)) return { results: [{ ...state }] };
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
    if (/^INSERT INTO blobs/.test(sql)) { blobs.set(args[0] + "|" + args[1], String(args[2])); return { changes: 1 }; }
    if (/^DELETE FROM blobs/.test(sql)) { blobs.delete(args[0] + "|" + args[1]); return { changes: 1 }; }
    if (/FROM documents WHERE category = 'certificate' AND removed_at IS NULL/.test(sql)) return { results: rows.filter((r) => r.category === "certificate" && !r.removedAt) };
    if (/FROM documents WHERE category = \?1 AND removed_at IS NULL/.test(sql)) return { results: rows.filter((r) => r.category === args[0] && !r.removedAt) };
    if (/SELECT id FROM documents WHERE blob_key = \?1 AND removed_at IS NULL/.test(sql)) return { results: rows.filter((r) => r.blobKey === args[0] && !r.removedAt).map((r) => ({ id: r.id })) };
    if (/SELECT id FROM documents WHERE blob_key = \?1 AND removed_at IS NOT NULL/.test(sql)) return { results: rows.filter((r) => r.blobKey === args[0] && !!r.removedAt).map((r) => ({ id: r.id })) };
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
    return undefined;
  });
  return { db, state, blobs, doc: () => JSON.parse(state.data), rows };
}

const oneManPortal = async (over: { orphanSeen?: Record<string, string>; filledFromCert?: Record<string, boolean> } = {}) => {
  const tmKey = "opms/20260901 - CREW QUALIFICATION EXPIRY.xlsx";
  const bucket = fakeBucket({});
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
      { ...billysTicket, id: "c2", person: "bRENTON", checksum: "evans-master", blobKey: "opms/Brenton - OPMS/master.pdf" },
      { ...liveRow("tm1", tmKey), sizeBytes: 5000 },
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
  assert.ok(![...portal.blobs.keys()].some((k) => k.endsWith("|round-lease")), "the lease is dropped at the end");

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
