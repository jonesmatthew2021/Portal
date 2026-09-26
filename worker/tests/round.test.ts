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
import analyse, { compareMatrix, conditionsFrom, extract, holderFrom, refile, topUpParticulars } from "../src/routes/analyse.js";
import readOne from "../src/routes/read-one.js";
import restoreFile from "../src/routes/restore-file.js";
import { MAX_BYTES } from "../src/lib/shared-state.js";
import { OUT_OF_CREDIT, READING_UNAVAILABLE, READING_VERSION, certificateStanding, codeFor, columnsFor } from "../src/lib/analysis.js";
import { KeptInPlace, ensureDocumentColumns, filingName, forgetDocumentColumns, purgeDocument, relocateToRemovedBlob, removeDocument, restoreDocument, safeName } from "../src/db/documents.js";
import { replaceSingleFile } from "../src/db/single-file.js";
import { saveDocument } from "../src/lib/shared-state.js";
import { runMatrixRound, roundRunning, leaseHolder, takeLease, dropLease, renewLease, keepEquivalences, SETTLE_MS } from "../src/lib/round.js";
import { readMatrixOnce, startMatrixReadJob, runMatrixReadJob, readMatrixReadJob } from "../src/lib/matrix.js";
import { todayThere } from "../src/lib/analysis.js";
import sync, { apply, outranks, sheetOrder, survey } from "../src/routes/sync.js";
import roundRoute, { BUDGET_MS, LEASE_FOR_MS, progressAnswer } from "../src/routes/round.js";
import files, { toRecord } from "../src/routes/files.js";
import fileRoute from "../src/routes/file.js";
import renameFile from "../src/routes/rename-file.js";
import importSingle from "../src/routes/import-single.js";
import worker, { hourWaits, hourDeadline, syncLastAnswer } from "../src/index.js";
import { graphBudget } from "../src/files/store.js";
import { writeZip, readZip, partOf, partText, datedWorkbookName } from "../../source/shared/workbook.js";
import { placedLine } from "../../source/shared/filed-as.js";
import { asKnownPerson, crewRegister, readAsLine, readerPick, whoseCertificate } from "../../source/shared/names.js";
import { backupDue, backupName, namesToDrop, folderAllowed, nightlyBackup } from "../src/lib/backup.js";
import { REMINDER_USERS_SQL, NO_EMAIL, UNFINISHED, OUT_OF_TIME, reminderLimits, reminderWaits, weeklyReminders } from "../src/lib/reminders.js";
import { vessel, vesselNow } from "../src/vessel.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { settleRound, applySettled } from "../../source/shared/matrix-rules.js";
/* The fakes these tests stand on - the database, the bucket, the library
   answered by hand - live in helpers.ts, where the sync tests share them. */
import {
  fakeDb, drizzleOn, fakeBucket, liveRow, keptRow, bytesOf, portalDb, graphLibrary, sharepointEnv, quiet, withClock,
  type Answer, type Asked, type Row,
} from "./helpers.js";

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

/* A database holding these rows and answering the replace's own
   statements: the column check, the live rows, who holds an address, and
   the writes. */
function documentsDb(rows: (ReturnType<typeof liveRow> | ReturnType<typeof keptRow>)[]) {
  const asked: Asked[] = [];
  const db = fakeDb((sql, args) => {
    if (/PRAGMA table_info/.test(sql)) return { results: [{ name: "adopted_from_folder" }, { name: "kept_in_place" }, { name: "evidence_kind" }, { name: "named_by_portal" }] };
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
/* A workbook with one crew row: Evans, QL-01 blank, QL-17 = 47500 (2030-01-17),
   and any further column codes named after them, blank. */
const smallWorkbook = (more: string[] = []) => writeZip([
  zipPart("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`),
  zipPart("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="CREW EXPIRY" sheetId="1" r:id="rId1"/></sheets></workbook>`),
  zipPart("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
  zipPart("xl/sharedStrings.xml", `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"></sst>`),
  zipPart("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${String.fromCharCode(70 + more.length)}3"/><sheetData>
<row r="1"><c r="B1" t="inlineStr"><is><t>CREW</t></is></c><c r="E1" t="inlineStr"><is><t>QL-01</t></is></c><c r="F1" t="inlineStr"><is><t>QL-17</t></is></c>${more.map((code, i) => `<c r="${String.fromCharCode(71 + i)}1" t="inlineStr"><is><t>${code}</t></is></c>`).join("")}</row>
<row r="2"><c r="B2" t="inlineStr"><is><t>Name</t></is></c></row>
<row r="3"><c r="B3" t="inlineStr"><is><t>bRENTON</t></is></c><c r="C3" t="inlineStr"><is><t>Master</t></is></c><c r="F3" t="n"><v>47500</v></c></row>
</sheetData></worksheet>`),
]);


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
  /** The filed-as cases: two more columns on the matrix and in the workbook
   *  - VS-04 Helm CONNECT, which never lapses on this vessel, and QL-04
   *  Master <45m NC, which is dated - and the one certificate untagged,
   *  named for the column given here, and read by the model as a course
   *  the matrix has no column for. */
  filedAs?: "VS-04" | "QL-04";
  /** The certificate's filename as the office wrote it, in place of the
   *  portal's own canonical spelling - so the refile has a name to tidy. */
  filedName?: string;
} = {}) => {
  const tmKey = over.theirs ? "opms/CREW QUALIFICATION EXPIRY.xlsx" : "opms/20260901 - CREW QUALIFICATION EXPIRY.xlsx";
  const filedCols: [string, string, string][] = [["VS-04", "Helm CONNECT", "Vessel"], ["QL-04", "Master <45m NC", "Qualifications"]];
  const filedTitle = over.filedAs ? filedCols.find((c) => c[0] === over.filedAs)![1] : "";
  const scanName = over.filedName || (over.filedAs ? `EVANS, Brenton - ${over.filedAs} ${filedTitle}.pdf` : "master.pdf");
  const scanKey = `opms/Brenton - OPMS/${scanName}`;
  const bucket = fakeBucket({ [scanKey]: "a scan" }, ["opms", "removed", "opms/Brenton - OPMS", "opms/skills"]);
  await bucket.put(tmKey, await smallWorkbook(over.filedAs ? filedCols.map((c) => c[0]) : []).arrayBuffer());
  if (over.skills) await bucket.put(skillsKey, await skillsWorkbook().arrayBuffer());
  bucket.made.length = 0;
  const portal = portalDb(
    {
      quals: {
        cols: [["QL-01", "Master", "Qualifications"], ["QL-17", "Medical", "Medical"], ...(over.filedAs ? filedCols : [])],
        rows: [["EVANS, Brenton", "Master", "", ["", "2030-01-17", ...(over.filedAs ? ["", ""] : [])]]],
      },
      people: [{ name: "EVANS, Brenton", aliases: ["bRENTON"] }],
      filledFromCert: over.filledFromCert || {},
      orphanSeen: over.orphanSeen || {},
      history: [],
    },
    [
      { ...billysTicket, id: "c2", person: "bRENTON", checksum: "evans-master", blobKey: scanKey, filename: scanKey.split("/").pop(), sizeBytes: 6,
        qualCode: over.filedAs ? null : over.qualCode === undefined ? billysTicket.qualCode : over.qualCode },
      { ...liveRow("tm1", tmKey, over.theirs ? 1 : 0), sizeBytes: 5000 },
      ...(over.skills ? [{ ...liveRow("sk1", skillsKey, 1), category: "skills-matrix", sizeBytes: 4000 }] : []),
    ],
    { "r1/evans-master.json": { ...reading, holderName: "Brenton Evans", expiresOn: "2031-05-26",
      ...(over.filedAs ? { certificateTitle: "Crew Intermediate course", qualCode: null } : {}) } },
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

test("filed as: the column in the filename fills the cell where the model gave none, and says so", async () => {
  /* Five "VS-04 Helm CONNECT" files on the live portal are the Crew
     Intermediate course, which the column's title does not name, so the
     model gave no code and the cell stayed empty although the office filed
     the paper for exactly that cell. The filed column is the office's word. */
  const { portal } = await oneManPortal({ filedAs: "VS-04" });
  const doc = portal.doc();
  const nameOf = asKnownPerson(doc.people);
  const out = await compareMatrix(doc.quals, null, nameOf);
  // VS-04 never lapses on this vessel (the vessel file's noExpiryCodes), so
  // a certificate on file is held: "Y", and the date is only a note.
  assert.ok(vessel.noExpiryCodes.includes("VS-04"), "the fixture's premise");
  assert.deepEqual(out.settled, [{ person: "EVANS, Brenton", code: "VS-04", value: "Y" }], "VS-04 is filled from the filed column");
  assert.deepEqual(out.claimed, ["EVANS, BRENTON::VS-04"]);
  assert.deepEqual(out.notes.filter((n) => n.kind === "filed-as").map((n) => n.detail),
    ["EVANS, Brenton — VS-04: filed as Helm CONNECT, reads as Crew Intermediate course"], "the disagreement is said, for management");

  // The page's cells: the same cell, and the same line to say.
  const page = await certificateStanding();
  assert.deepEqual(page.dates.map((d) => [d.person, d.code, d.expires, d.issued]), [["EVANS, BRENTON", "VS-04", null, "2026-02-17"]]);
  assert.deepEqual(page.filedAs, [{ person: "EVANS, BRENTON", code: "VS-04", title: "Helm CONNECT", readsAs: "Crew Intermediate course", fileId: "c2" }]);

  // A dated column, and the model reading it as another item: the filed
  // column still takes the certificate's date, and the line names what it read.
  const dated = await oneManPortal({ filedAs: "QL-04" });
  dated.portal.blobs.set("certificate-readings|r1/evans-master.json", JSON.stringify({ ...reading, holderName: "Brenton Evans", expiresOn: "2031-05-26", certificateTitle: "ECDIS generic", qualCode: "QL-13" }));
  const other = await compareMatrix(dated.portal.doc().quals, null, nameOf);
  assert.deepEqual(other.settled, [{ person: "EVANS, Brenton", code: "QL-04", value: "2031-05-26" }], "QL-04 takes the certificate's date, over the model's QL-13");
  assert.deepEqual(other.notes.filter((n) => n.kind === "filed-as").map((n) => n.detail),
    ["EVANS, Brenton — QL-04: filed as Master <45m NC, reads as ECDIS generic"]);
  assert.deepEqual((await certificateStanding()).dates.map((d) => [d.code, d.expires]), [["QL-04", "2031-05-26"]], "and the page's cells agree");
  setEnv({ DB: portal.db, FILE_STORE: "r2" } as never);

  // The model agrees: no line.
  portal.blobs.set("certificate-readings|r1/evans-master.json", JSON.stringify({ ...reading, holderName: "Brenton Evans", expiresOn: "2031-05-26", certificateTitle: "Helm CONNECT", qualCode: "VS-04" }));
  const agreed = await compareMatrix(doc.quals, null, nameOf);
  assert.deepEqual(agreed.settled, [{ person: "EVANS, Brenton", code: "VS-04", value: "Y" }]);
  assert.deepEqual(agreed.notes.filter((n) => n.kind === "filed-as"), [], "no disagreement, no line");
  assert.deepEqual((await certificateStanding()).filedAs, []);

  // Unreadable: a filename is not evidence that a paper exists.
  portal.blobs.set("certificate-readings|r1/evans-master.json", JSON.stringify({ version: "r1", at: "", model: null, readable: false, reason: "too poor to read" }));
  const blind = await compareMatrix(doc.quals, null, nameOf);
  assert.deepEqual(blind.settled, [], "nothing filled from the name");
  assert.deepEqual(blind.notes.map((n) => n.kind), ["unreadable"], "the unreadable note as before, and no filed-as line");
  assert.deepEqual((await certificateStanding()).dates, []);

  // Printed in another man's name: the wrong man's document is said for
  // what it is, once, and is not a filing to question as well - the round
  // and the page say the filed-as line for exactly the documents that fill a cell.
  portal.blobs.set("certificate-readings|r1/evans-master.json", JSON.stringify({ ...reading, holderName: "Kachin Sittiyos", expiresOn: "2031-05-26", certificateTitle: "Crew Intermediate course", qualCode: null }));
  const his = await compareMatrix(doc.quals, null, nameOf);
  assert.deepEqual(his.settled, [], "another man's document fills nothing");
  assert.deepEqual(his.notes.map((n) => n.kind), ["name-mismatch"], "the name note alone: no filed-as line in the round");
  const hisPage = await certificateStanding();
  assert.deepEqual(hisPage.filedAs, [], "and none on the page");
  assert.deepEqual(hisPage.notOnMatrix, [], "nor is it listed as his document the matrix lacks a column for");

  // A name the portal wrote itself is the model's guess, not a filing: the
  // sheet and the model decide, and there is no filing to question.
  portal.rows.find((r) => r.id === "c2")!.namedByPortal = 1;
  portal.blobs.set("certificate-readings|r1/evans-master.json", JSON.stringify({ ...reading, holderName: "Brenton Evans", expiresOn: "2031-05-26", certificateTitle: "Crew Intermediate course", qualCode: null }));
  const own = await compareMatrix(doc.quals, null, nameOf);
  assert.deepEqual(own.settled, [], "the portal's own name fills nothing where the model gave no code");
  assert.deepEqual(own.notes.map((n) => n.kind), ["no-code"], "read as nothing on the matrix, as before the filing rule");
  assert.deepEqual((await certificateStanding()).filedAs, []);
});

test("filed as: the hour puts a filed column that never lapses on the matrix as held, and in the office's workbook", async () => {
  /* The live case: five "VS-04 Helm CONNECT" files the model read as the
     Crew Intermediate course. VS-04 carries no expiry on this vessel, so
     the filed column is held - "Y" - on the matrix and in the workbook. */
  const { portal, bucket } = await oneManPortal({ filedAs: "VS-04" });
  const env = { DB: portal.db, FILES: bucket, FILE_STORE: "r2" };
  await worker.scheduled({} as never, env as never);
  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.roundError, null);
  assert.equal(hourly.applied, 1, "one cell applied");
  assert.equal(hourly.written, 1, "one cell written into the workbook");
  const doc = portal.doc();
  assert.deepEqual(doc.quals.rows[0][3], ["", "2030-01-17", "Y", ""], "VS-04 is held; nothing else moved");
  assert.deepEqual(doc.filledFromCert, { "EVANS, BRENTON::VS-04": true });
  const named = datedWorkbookName("20260901 - CREW QUALIFICATION EXPIRY.xlsx", todayThere());
  const written = await (await bucket.get("opms/" + named))!.arrayBuffer();
  const back = await partText(partOf(readZip(written), "xl/worksheets/sheet1.xml"));
  assert.ok(/<c r="G3"[^>]*><is><t[^>]*>Y<\/t>/.test(back), "the VS-04 column of the office's row reads Y");
  assert.ok(!/<c r="H3"/.test(back), "QL-04, filed nowhere, is left blank");
});

test("filed as: the hour puts the filed column on the matrix and in the office's workbook, and an unchanged hour saves nothing", async () => {
  const { portal, bucket } = await oneManPortal({ filedAs: "QL-04" });
  const env = { DB: portal.db, FILES: bucket, FILE_STORE: "r2" };
  await worker.scheduled({} as never, env as never);
  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.roundError, null);
  assert.equal(hourly.applied, 1, "one date applied");
  assert.equal(hourly.written, 1, "one cell written into the workbook");
  const doc = portal.doc();
  assert.deepEqual(doc.quals.rows[0][3], ["", "2030-01-17", "", "2031-05-26"], "QL-04 carries the certificate's date; nothing else moved");
  assert.deepEqual(doc.filledFromCert, { "EVANS, BRENTON::QL-04": true });
  const named = datedWorkbookName("20260901 - CREW QUALIFICATION EXPIRY.xlsx", todayThere());
  const written = await (await bucket.get("opms/" + named))!.arrayBuffer();
  const back = await partText(partOf(readZip(written), "xl/worksheets/sheet1.xml"));
  assert.ok(/<c r="H3"[^>]*><is><t[^>]*>2031-05-26<\/t>/.test(back), "the QL-04 column of the office's row got the date");
  assert.ok(/<c r="F3" t="n"><v>47500<\/v>/.test(back), "the medical the office typed is left as typed");
  const rev = portal.state.rev;

  // Nothing changes: the next hour saves nothing at all.
  await worker.scheduled({} as never, env as never);
  assert.equal(JSON.parse(portal.blobs.get("sync|last-hourly")!).applied, 0);
  assert.equal(portal.state.rev, rev, "no save on an unchanged hour");
});

test("filed as: the refile tidies the office's own name and keeps the office's word, hour after hour", async () => {
  /* The trap: the refile renames every read certificate to the portal's
     "<PERSON> - <CODE> <Title>.pdf", and marks a renamed row as the
     portal's naming so the model's guess is never read back as a filing.
     But for an office-named file the code IS the office's - codeFor took it
     off the name - and marking it threw the office's word away after one
     hourly refile: the cell emptied and the filed-as line went quiet. */
  const { portal, bucket } = await oneManPortal({ filedAs: "VS-04", filedName: "Brenton - vs-04 helm connect.pdf" });
  // A key so the hour runs its refile; the certificate is already read, so
  // the model is never asked.
  const env = { DB: portal.db, FILES: bucket, FILE_STORE: "r2", ANTHROPIC_API_KEY: "k" };
  await worker.scheduled({} as never, env as never);

  const ticket = portal.rows.find((r) => r.id === "c2")!;
  assert.equal(ticket.filename, "EVANS, Brenton - VS-04 Helm CONNECT.pdf", "tidied into the portal's own spelling");
  assert.equal(ticket.blobKey, "opms/Brenton - OPMS/EVANS, Brenton - VS-04 Helm CONNECT.pdf");
  assert.ok(bucket.text("opms/Brenton - OPMS/EVANS, Brenton - VS-04 Helm CONNECT.pdf"), "the file moved with it");
  assert.equal(bucket.text("opms/Brenton - OPMS/Brenton - vs-04 helm connect.pdf"), null, "and the old name is not left behind");
  assert.ok(!ticket.namedByPortal, "the code was the office's, so the name is still the office's word");
  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.refiled, 2, "the label and the rename");
  assert.equal(hourly.applied, 1, "and the same hour's round fills the filed column");
  assert.deepEqual(portal.doc().quals.rows[0][3], ["", "2030-01-17", "Y", ""], "VS-04 is held");
  const doc = portal.doc();
  const out = await compareMatrix(doc.quals, null, asKnownPerson(doc.people));
  assert.deepEqual(out.notes.filter((n) => n.kind === "filed-as").map((n) => n.detail),
    ["EVANS, Brenton — VS-04: filed as Helm CONNECT, reads as Crew Intermediate course"], "the round still says the disagreement");
  assert.deepEqual((await certificateStanding()).filedAs.map((f) => [f.code, f.readsAs]), [["VS-04", "Crew Intermediate course"]], "and so does the page");
  const rev = portal.state.rev;

  // The next hour, refile and all: nothing to rename, nothing to save.
  await worker.scheduled({} as never, env as never);
  const again = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(again.refiled, 0, "a name already right is left alone");
  assert.equal(again.applied, 0);
  assert.equal(portal.state.rev, rev, "no save on an unchanged hour");
  assert.equal(ticket.filename, "EVANS, Brenton - VS-04 Helm CONNECT.pdf");
  assert.ok(!ticket.namedByPortal, "still the office's");
  assert.deepEqual(portal.doc().quals.rows[0][3], ["", "2030-01-17", "Y", ""], "VS-04 is still held");
});

test("a name the portal wrote from the model's guess is marked as its own, so the Equivalence sheet can still move it", async () => {
  /* The other side of the rule: "master.pdf" carries no column, so the code
     in the new name is the model's (QL-01), and the row is marked. A sheet
     filed later says the ticket belongs in QL-17, and because the name is
     the portal's and not a filing, the sheet wins and the file follows. */
  const { portal, bucket } = await oneManPortal({ qualCode: null });
  const env = { DB: portal.db, FILES: bucket, FILE_STORE: "r2", ANTHROPIC_API_KEY: "k" };
  await worker.scheduled({} as never, env as never);
  const ticket = portal.rows.find((r) => r.id === "c2")!;
  assert.equal(ticket.filename, "EVANS, Brenton - QL-01 Master.pdf", "named from the model's code");
  assert.equal(ticket.namedByPortal, 1, "and marked as the portal's naming");
  assert.equal(portal.doc().quals.rows[0][3][0], "2031-05-26", "QL-01 takes the date");

  // The skills matrix arrives, with its Equivalence sheet.
  await bucket.put(skillsKey, await skillsWorkbook().arrayBuffer());
  portal.rows.push({ ...liveRow("sk1", skillsKey, 1), category: "skills-matrix", sizeBytes: 4000 });
  await worker.scheduled({} as never, env as never);
  assert.equal(ticket.filename, "EVANS, Brenton - QL-17 Medical.pdf", "the sheet moved it: the portal's own name was no filing to stand in the way");
  assert.equal(ticket.namedByPortal, 1);
  assert.ok(bucket.text("opms/Brenton - OPMS/EVANS, Brenton - QL-17 Medical.pdf"));
  assert.equal(bucket.text("opms/Brenton - OPMS/EVANS, Brenton - QL-01 Master.pdf"), null);
});

test("a slash in a column's title is a dash in the filing name, never a path to strip", async () => {
  /* Three titles carry a slash - "STCW Reg II/5 & III/5", "STCW Reg II/1 &
     II/2", "STCW Reg IV/2" - and safeName keeps only what follows the last
     one, because its job is to take a folder path off an uploaded name. So
     the refile renamed 26 live certificates to "2.pdf", "2 (2).pdf" and
     "5).pdf", in SharePoint too. */
  assert.equal(safeName("EVANS, Brenton - QL-14 GMDSS - STCW Reg IV/2.pdf"), "2.pdf", "the trap, as it was");
  assert.equal(filingName("EVANS, Brenton", "QL-14", "GMDSS - STCW Reg IV/2"), "EVANS, Brenton - QL-14 GMDSS - STCW Reg IV-2");
  assert.equal(safeName(filingName("EVANS, Brenton", "QL-14", "GMDSS - STCW Reg IV/2") + ".pdf"), "EVANS, Brenton - QL-14 GMDSS - STCW Reg IV-2.pdf", "the whole title kept");
  assert.equal(filingName("X", "QL-10", "Rating (STCW Reg II/5 & III/5)"), "X - QL-10 Rating (STCW Reg II-5 & III-5)");
  assert.equal(filingName("X", "QL-13", "ECDIS - STCW Reg II\\1"), "X - QL-13 ECDIS - STCW Reg II-1", "a backslash the same");
  assert.equal(safeName("C:\\fakepath\\scan.pdf"), "scan.pdf", "an uploaded name is still cleaned exactly as before");
  assert.equal(safeName("folder/sub/scan.pdf"), "scan.pdf");

  // A certificate the bug had renamed to "2.pdf": the next refile gives it
  // its full name, the old name is not left behind, and a name already
  // right is not renamed again the hour after.
  const { portal, bucket } = await oneManPortal({ qualCode: null });
  const ticket = portal.rows.find((r) => r.id === "c2")!;
  ticket.filename = "2.pdf"; ticket.blobKey = "opms/Brenton - OPMS/2.pdf"; ticket.namedByPortal = 1;
  await bucket.put("opms/Brenton - OPMS/2.pdf", bytesOf("a scan"));
  await bucket.delete("opms/Brenton - OPMS/master.pdf");
  portal.blobs.set("certificate-readings|r1/evans-master.json", JSON.stringify({ ...reading, holderName: "Brenton Evans", certificateTitle: "GMDSS General Operator's Certificate", qualCode: "QL-14", codeConfidence: "high" }));
  const doc = portal.doc();
  doc.quals.cols.push(["QL-14", "GMDSS - STCW Reg IV/2", "Qualifications"]);
  doc.quals.rows[0][3].push("");
  portal.state.data = JSON.stringify(doc);

  const first = (await (await refile(["EVANS, Brenton"])).json()) as { moved: { from: string | null; filename: string }[] };
  assert.deepEqual(first.moved.map((m) => m.filename), ["2.pdf", "EVANS, Brenton - QL-14 GMDSS - STCW Reg IV-2.pdf"], "the label, then the full name");
  assert.equal(ticket.filename, "EVANS, Brenton - QL-14 GMDSS - STCW Reg IV-2.pdf");
  assert.equal(ticket.blobKey, "opms/Brenton - OPMS/EVANS, Brenton - QL-14 GMDSS - STCW Reg IV-2.pdf");
  assert.ok(bucket.text("opms/Brenton - OPMS/EVANS, Brenton - QL-14 GMDSS - STCW Reg IV-2.pdf"), "the bytes under the full name");
  assert.equal(bucket.text("opms/Brenton - OPMS/2.pdf"), null, "and not under the cut one");

  const second = (await (await refile(["EVANS, Brenton"])).json()) as { moved: unknown[] };
  assert.deepEqual(second.moved, [], "named right: the comparison uses the same dashed title, so it is not renamed every hour");
});

test("a name somebody typed is the office's word: a hand rename takes the portal's mark off, and the refile leaves it", async () => {
  /* The refile names a certificate from the model's code and marks the row
     as the portal's naming. Somebody in the office then renamed it by hand,
     to the column they file it under - and the mark stayed, so the next
     refile read the name as the portal's guess and renamed it straight back. */
  const { portal, bucket } = await oneManPortal({ qualCode: null });
  const env = { DB: portal.db, FILES: bucket, FILE_STORE: "r2", ANTHROPIC_API_KEY: "k" };
  await worker.scheduled({} as never, env as never);
  const ticket = portal.rows.find((r) => r.id === "c2")!;
  assert.equal(ticket.filename, "EVANS, Brenton - QL-01 Master.pdf", "the premise: named from the model's code");
  assert.equal(ticket.namedByPortal, 1, "and marked as the portal's naming");

  const res = await renameTo("c2", "EVANS, Brenton - QL-17 Medical.pdf");
  assert.equal(res.status, 200, await res.text());
  assert.equal(ticket.filename, "EVANS, Brenton - QL-17 Medical.pdf");
  assert.equal(ticket.namedByPortal ?? null, null, "a name a person typed is not the portal's");

  await worker.scheduled({} as never, env as never);
  assert.equal(ticket.filename, "EVANS, Brenton - QL-17 Medical.pdf", "the next refile leaves the office's name where it is");
  assert.ok(bucket.text("opms/Brenton - OPMS/EVANS, Brenton - QL-17 Medical.pdf"), "and the bytes with it");
  assert.equal(bucket.text("opms/Brenton - OPMS/EVANS, Brenton - QL-01 Master.pdf"), null);
});

test("a long name keeps the title's closing bracket, and the refile after renames nothing", async () => {
  /* safeName caps a name at 120 characters. The QL-10 title is 88 of them,
     so for a longer person name the filing name lost its tail -
     "…(STCW Reg II-5 &.pdf" - and a cut name reads as a different
     qualification. The title is shortened instead, from the front of its
     list of capacities, so the name ends whole. */
  const long = "WOLLASTONCRAFT-SMYTHE, Brenton";
  const title = "Integrated Rating, Able Seafarer - Deck, Able Seafarer - Engineer (STCW Reg II/5 & III/5)";
  assert.equal(long.length, 30, "the premise");
  const base = filingName(long, "QL-10", title);
  assert.ok((base + ".pdf").length <= 120, `fits: ${(base + ".pdf").length}`);
  assert.equal(safeName(base + ".pdf"), base + ".pdf", "nothing is cut off it afterwards");
  assert.match(base, /^WOLLASTONCRAFT-SMYTHE, Brenton - QL-10 Integrated Rating.* \(STCW Reg II-5 & III-5\)$/, "the name ends whole");
  assert.equal(filingName("EVANS, Brenton", "QL-10", title), "EVANS, Brenton - QL-10 Integrated Rating, Able Seafarer - Deck, Able Seafarer - Engineer (STCW Reg II-5 & III-5)", "a name that fits is left as it was");

  // The file the cap had cut, put right by the next refile - and then left.
  const { portal, bucket } = await oneManPortal({ qualCode: null });
  const ticket = portal.rows.find((r) => r.id === "c2")!;
  // safeName cut the base, then the extension went on: "…(STCW Reg II-5 &.pdf".
  const cut = safeName(`${long} - QL-10 ${title.replace(/\//g, "-")}`) + ".pdf";
  assert.ok(!cut.endsWith(").pdf"), "the premise: the old name was cut - " + cut);
  ticket.filename = cut; ticket.blobKey = "opms/Brenton - OPMS/" + cut; ticket.namedByPortal = 1;
  await bucket.put(ticket.blobKey as string, bytesOf("a scan"));
  await bucket.delete("opms/Brenton - OPMS/master.pdf");
  portal.blobs.set("certificate-readings|r1/evans-master.json", JSON.stringify({ ...reading, holderName: "Brenton Wollastoncraft-Smythe", certificateTitle: "Integrated Rating", qualCode: "QL-10", codeConfidence: "high" }));
  const doc = portal.doc();
  doc.quals.cols.push(["QL-10", title, "Qualifications"]);
  doc.quals.rows[0][0] = long;
  doc.quals.rows[0][3].push("");
  doc.people = [{ name: long, aliases: ["bRENTON"] }];
  portal.state.data = JSON.stringify(doc);

  await refile([long]);
  assert.equal(ticket.filename, base + ".pdf", "renamed to the whole name");
  assert.ok(bucket.text("opms/Brenton - OPMS/" + base + ".pdf"));
  assert.equal(bucket.text("opms/Brenton - OPMS/" + cut), null, "and the cut name is not left behind");
  const again = (await (await refile([long])).json()) as { moved: unknown[] };
  assert.deepEqual(again.moved, [], "the next refile renames nothing");
});

/* ------------------------------------------------------------------------ *
 * Whose a certificate is: the reader picks off the register.
 * ------------------------------------------------------------------------ */

/** Evans's portal with two more men on the matrix and the register -
 *  SITTIYOS, Kachin and JITENDER, Rohin - and loose scans filed under
 *  nobody the register knows, each with the reading given. */
const crewPortal = async (loose: { id: string; reading: Record<string, unknown> }[], aliases: Record<string, string[]> = {}) => {
  const made = await oneManPortal({ qualCode: null });
  // Evans's own ticket gone, so every cell says only these.
  made.portal.rows.splice(made.portal.rows.findIndex((r) => r.id === "c2"), 1);
  await made.bucket.delete("opms/Brenton - OPMS/master.pdf");
  const doc = made.portal.doc();
  doc.quals.rows.push(["SITTIYOS, Kachin", "Cook", "", ["", ""]], ["JITENDER, Rohin", "GPH", "", ["", ""]]);
  doc.people = [
    { name: "EVANS, Brenton", aliases: ["bRENTON"] },
    { name: "SITTIYOS, Kachin", aliases: aliases["SITTIYOS, Kachin"] || [] },
    { name: "JITENDER, Rohin", aliases: [] },
  ];
  made.portal.state.data = JSON.stringify(doc);
  for (const { id, reading: r } of loose) {
    const key = `opms/Loose - OPMS/${id}.pdf`;
    await made.bucket.put(key, bytesOf("a scan"));
    made.portal.rows.push({ ...billysTicket, id, person: "Loose", folder: "loose", checksum: id, blobKey: key, filename: `${id}.pdf`, sizeBytes: 6, qualCode: null });
    made.portal.blobs.set(`certificate-readings|r1/${id}.json`, JSON.stringify({ ...reading, expiresOn: "2031-05-26", columns: [{ code: "QL-01", confidence: "high", why: null }], ...r }));
  }
  made.bucket.made.length = 0;
  const env = { DB: made.portal.db, FILES: made.bucket, FILE_STORE: "r2", ANTHROPIC_API_KEY: "k" };
  return { ...made, env };
};
const cellOf = (portal: { doc: () => { quals: { rows: [string, string, string, string[]][] } } }, person: string) =>
  portal.doc().quals.rows.find((r) => r[0] === person)![3][0];

test("whose it is: the reader's pick stands where the printed name alone does not say, and the office is asked to add the name", async () => {
  const { portal, env } = await crewPortal([
    // Initials: the register reads the surname alone as the one Jitender.
    { id: "jit", reading: { holderName: "R. JITENDER", holder: { person: "JITENDER, Rohin", confidence: "high", why: "surname and initial", others: [] } } },
    // A nickname nobody has typed onto Crew Details: the reader knows it.
    { id: "bill", reading: { holderName: "Bill", holder: { person: "SITTIYOS, Kachin", confidence: "high", why: "Bill is what Kachin goes by", others: [] } } },
  ]);
  await worker.scheduled({} as never, env as never);
  assert.equal(portal.rows.find((r) => r.id === "jit")!.person, "JITENDER, Rohin", "labelled for the man the register reads the initials as");
  assert.equal(portal.rows.find((r) => r.id === "bill")!.person, "SITTIYOS, Kachin", "labelled for the reader's pick");
  assert.equal(cellOf(portal, "JITENDER, Rohin"), "2031-05-26", "his cell filled");
  assert.equal(cellOf(portal, "SITTIYOS, Kachin"), "2031-05-26", "and Kachin's");

  const page = await certificateStanding();
  assert.deepEqual(page.dates.map((d) => [d.person, d.code, d.expires]).sort(),
    [["JITENDER, ROHIN", "QL-01", "2031-05-26"], ["SITTIYOS, KACHIN", "QL-01", "2031-05-26"]], "the page's cells agree with the round");
  const doc = portal.doc();
  const lines = [
    // The initial is his, but not his name letter for letter: checked.
    `Master <500GT read as JITENDER, Rohin's — check, and add "R. JITENDER" to their names on Crew Details`,
    `Master <500GT read as SITTIYOS, Kachin's — add "Bill" to their names on Crew Details`,
  ];
  assert.deepEqual(page.readAs.map((r) => readAsLine(r.certificate, doc.people.find((p: { name: string }) => p.name.toUpperCase() === r.person)!.name, r.printed, r.line)).sort(),
    lines, "a line each, for the names the register does not carry");
  const out = await compareMatrix(doc.quals, null, asKnownPerson(doc.people));
  assert.deepEqual(out.notes.filter((n) => n.kind === "read-as").map((n) => n.detail).sort(), lines, "the round says the same sentences");
});

test("whose it is: a spelling on Crew Details places the certificate without the reader", async () => {
  // Matthew's example was "Bill" against the alias "Billy": the register
  // matches a spelling whole, so the alias here is the printed spelling.
  const { portal, env } = await crewPortal([
    { id: "billy", reading: { holderName: "Billy", holder: null } },
  ], { "SITTIYOS, Kachin": ["Billy"] });
  await worker.scheduled({} as never, env as never);
  assert.equal(portal.rows.find((r) => r.id === "billy")!.person, "SITTIYOS, Kachin");
  assert.equal(cellOf(portal, "SITTIYOS, Kachin"), "2031-05-26");
  assert.deepEqual((await certificateStanding()).readAs, [], "nothing to add: the name is already his");
});

test("whose it is: a medium pick is checked, and never lands on a man the printed name has nothing in common with", async () => {
  const { portal, env } = await crewPortal([
    // A surname and a misspelt given name: the reader's medium, sharing the surname.
    { id: "kach", reading: { holderName: "Kachn SITTIYOS-WONG", holder: { person: "SITTIYOS, Kachin", confidence: "medium", why: "surname matches, given name misspelt", others: [] } } },
    // A medium pick with nothing in common: refused.
    { id: "rose", reading: { holderName: "Rohan Jitendra", holder: { person: "EVANS, Brenton", confidence: "medium", why: "a guess", others: [] } } },
    // Two could fit: never two people.
    // The printed name shares his surname and the reader is sure, but it
    // listed Rohin too: the doubt alone refuses it.
    { id: "two", reading: { holderName: "K. SITTIYOS", holder: { person: "SITTIYOS, Kachin", confidence: "high", why: "surname and initial", others: ["JITENDER, Rohin"] } } },
  ]);
  await worker.scheduled({} as never, env as never);
  assert.equal(portal.rows.find((r) => r.id === "kach")!.person, "SITTIYOS, Kachin", "a medium pick that shares his surname places it");
  assert.equal(portal.rows.find((r) => r.id === "rose")!.person, "Loose", "a medium pick that shares nothing places nothing");
  assert.equal(portal.rows.find((r) => r.id === "two")!.person, "Loose", "a pick with somebody else in mind is no pick");
  assert.equal(cellOf(portal, "SITTIYOS, Kachin"), "2031-05-26");
  assert.equal(cellOf(portal, "EVANS, Brenton"), "", "nothing in Evans's cell");
  const page = await certificateStanding();
  assert.deepEqual(page.readAs.map((r) => readAsLine(r.certificate, "SITTIYOS, Kachin", r.printed, r.line)),
    [`Master <500GT read as SITTIYOS, Kachin's — check, and add "Kachn SITTIYOS-WONG" to their names on Crew Details`], "the medium line says check");
  // Two candidates: no pick, whatever the confidence.
  assert.equal(readerPick("R. SITTIYOS", { person: "SITTIYOS, Kachin", confidence: "high", others: ["JITENDER, Rohin"] }, portal.doc().people), null, "never two people");
});

test("whose it is: the reader never takes a certificate printed in another crew member's name", async () => {
  /* Filed in Kachin's folder, printed "Brenton Evans", and the reader
     picks Kachin: the printed name is somebody on the register, so the
     pick is not asked at all, and the note says whose name it is in. */
  const { portal } = await crewPortal([]);
  const key = "opms/Billy - OPMS/theirs.pdf";
  portal.rows.push({ ...billysTicket, id: "theirs", person: "SITTIYOS, Kachin", checksum: "theirs", blobKey: key, filename: "theirs.pdf", qualCode: null });
  portal.blobs.set("certificate-readings|r1/theirs.json", JSON.stringify({ ...reading, holderName: "Brenton Evans", expiresOn: "2031-05-26",
    columns: [{ code: "QL-01", confidence: "high", why: null }], holder: { person: "SITTIYOS, Kachin", confidence: "high", why: "filed in his folder", others: [] } }));
  const doc = portal.doc();
  const out = await compareMatrix(doc.quals, null, asKnownPerson(doc.people));
  assert.deepEqual(out.claimed, [], "Kachin's cell takes nothing");
  assert.deepEqual(out.notes.filter((n) => n.kind === "name-mismatch").map((n) => n.detail),
    ["Filed under SITTIYOS, Kachin, but the certificate is in the name of Brenton Evans."], "the existing note");
  assert.deepEqual((await certificateStanding()).dates, [], "and the page's cells agree");
  assert.equal(whoseCertificate("Brenton Evans", { person: "SITTIYOS, Kachin", confidence: "high", others: [] }, "SITTIYOS, Kachin", "SITTIYOS, Kachin", doc.people).his, false);
});

test("whose it is: the reader is shown the register numbered, and its number comes back as the register's name", async () => {
  const { portal } = await unreadPortal(1);
  const doc = portal.doc();
  doc.people = [{ name: "EVANS, Brenton", aliases: ["bRENTON"] }, { name: "SITTIYOS, Kachin", aliases: [] }];
  portal.state.data = JSON.stringify(doc);
  const model = modelAnswers(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Bill", holder: { person: 2, confidence: "high", why: "Bill is Kachin", others: [1, 9] } }) }));
  try {
    await extract([["QL-01", "Master"]], 4);
  } finally {
    model.restore();
  }
  assert.ok(model.calls[0].includes("1. EVANS, Brenton (also: bRENTON)") && model.calls[0].includes("2. SITTIYOS, Kachin"), "the crew, numbered, with their other spellings");
  // The MSIC card's "FEB 30" is the last day of that month (Matthew, 26 Sep 2026): the question says so.
  assert.ok(/FEB 30[\s\S]*last day of that month[\s\S]*2030-02-28/.test(model.calls[0]), "the MSIC expiry rule is in the question");
  const stored = JSON.parse(portal.blobs.get("certificate-readings|r1/unread-1.json")!);
  assert.deepEqual(stored.holder, { person: "SITTIYOS, Kachin", confidence: "high", why: "Bill is Kachin", others: ["EVANS, Brenton", "9"] },
    "the number is the register's name; a number off the list is kept as said, so the doubt is not lost");
});

/* ------------------------------------------------------------------------ *
 * What a certificate is for: every column the reader gives, on its word.
 * ------------------------------------------------------------------------ */

/** Evans's portal with more columns on the matrix and his own ticket gone,
 *  and the documents given - each with the filename the office gave it and
 *  a reading that lists its columns. */
const smartPortal = async (docs: { id: string; filename: string; reading: Record<string, unknown>; qualCode?: string }[]) => {
  const made = await oneManPortal({ qualCode: null });
  made.portal.rows.splice(made.portal.rows.findIndex((r) => r.id === "c2"), 1);
  await made.bucket.delete("opms/Brenton - OPMS/master.pdf");
  const doc = made.portal.doc();
  const more: [string, string, string][] = [
    ["VS-04", "Helm CONNECT - Crew Basic + Jobs", "Vessel Specific"],
    ["QL-04", "Master <45m NC", "Qualification"],
    ["QL-08", "Master <24m NC", "Qualification"],
    ["PT-02", "Enter and Work in Confined Spaces - RIIWHS202E", "Permit to Work"],
    ["PT-03", "Work Safely at Heights - RIIWHS204E", "Permit to Work"],
    ["CS-04", "Cargo System - Trainer - Practical", "Cargo System"],
  ];
  doc.quals.cols.push(...more);
  doc.quals.rows[0][3].push(...more.map(() => ""));
  made.portal.state.data = JSON.stringify(doc);
  for (const d of docs) {
    const key = `opms/Brenton - OPMS/${d.filename}`;
    await made.bucket.put(key, bytesOf("a scan"));
    made.portal.rows.push({ ...billysTicket, id: d.id, person: "EVANS, Brenton", folder: "brenton", checksum: d.id, blobKey: key, filename: d.filename, sizeBytes: 6, qualCode: d.qualCode ?? null });
    made.portal.blobs.set(`certificate-readings|r1/${d.id}.json`, JSON.stringify({ ...reading, holderName: "Brenton Evans", expiresOn: "2031-05-26", ...d.reading }));
  }
  made.bucket.made.length = 0;
  const env = { DB: made.portal.db, FILES: made.bucket, FILE_STORE: "r2", ANTHROPIC_API_KEY: "k" };
  return { ...made, env };
};
const evansCell = (portal: { doc: () => { quals: { cols: string[][]; rows: [string, string, string, string[]][] } } }, code: string) => {
  const doc = portal.doc();
  return doc.quals.rows[0][3][doc.quals.cols.findIndex((c) => c[0] === code)];
};
const roundNotes = async (portal: { doc: () => { quals: Parameters<typeof compareMatrix>[0]; people: { name: string; aliases: string[] }[] } }, kind: string) => {
  const doc = portal.doc();
  const out = await compareMatrix(doc.quals, null, asKnownPerson(doc.people));
  return out.notes.filter((n) => n.kind === kind).map((n) => n.detail);
};

test("what it is for: a course a level above the one the office filed it for fills the filed column, and says so for a quick look", async () => {
  const { portal, env } = await smartPortal([{ id: "helm", filename: "EVANS, Brenton - VS-04 Helm CONNECT - Crew Basic + Jobs.pdf",
    reading: { certificateTitle: "Crew Intermediate - Helm CONNECT", qualCode: "VS-04", codeConfidence: "medium",
      columns: [{ code: "VS-04", confidence: "medium", why: "Crew Intermediate satisfies Crew Basic" }] } }]);
  await worker.scheduled({} as never, env as never);
  assert.equal(evansCell(portal, "VS-04"), "Y", "filled - VS-04 never lapses on this vessel, so held");
  const line = "EVANS, Brenton — VS-04: placed by the reading (Crew Intermediate satisfies Crew Basic)";
  assert.deepEqual(await roundNotes(portal, "placed"), [line], "the round says it in the one line");
  assert.deepEqual(await roundNotes(portal, "filed-as"), [], "and the office's filing is not questioned: the reader agrees by a level");
  const page = await certificateStanding();
  assert.deepEqual(page.placed.map((p) => placedLine("EVANS, Brenton", p.code, p.why)), [line], "the page's cells say the same");
  assert.deepEqual(page.filedAs, []);

  // Tagged on its card: the person's word, and the line goes.
  portal.rows.find((r) => r.id === "helm")!.qualCode = "VS-04";
  assert.deepEqual((await certificateStanding()).placed, [], "a hand tag clears it");
  assert.deepEqual(await roundNotes(portal, "placed"), []);
  // A surer reading replaces it: the line goes too.
  portal.rows.find((r) => r.id === "helm")!.qualCode = null;
  portal.blobs.set("certificate-readings|r1/helm.json", JSON.stringify({ ...reading, holderName: "Brenton Evans", expiresOn: "2031-05-26",
    certificateTitle: "Helm CONNECT - Crew Basic + Jobs", columns: [{ code: "VS-04", confidence: "high", why: null }] }));
  assert.deepEqual((await certificateStanding()).placed, [], "a high reading clears it");
});

test("what it is for: a ticket the reader is sure is another column fills both, and the office's filing is said to disagree", async () => {
  const { portal, env } = await smartPortal([{ id: "wk", filename: "EVANS, Brenton - QL-04 Master _45m NC.pdf",
    reading: { certificateTitle: "Watchkeeper Deck", qualCode: "QL-08", codeConfidence: "high",
      columns: [{ code: "QL-08", confidence: "high", why: "Watchkeeper Deck corresponds to Master <24m NC" }, { code: "QL-04", confidence: "low", why: "not a Master <45m NC certificate" }] } }]);
  await worker.scheduled({} as never, env as never);
  assert.equal(evansCell(portal, "QL-08"), "2031-05-26", "the reader's sure column");
  assert.equal(evansCell(portal, "QL-04"), "2031-05-26", "and the office's filed column, by the filed-as rule");
  assert.deepEqual(await roundNotes(portal, "filed-as"), ["EVANS, Brenton — QL-04: filed as Master <45m NC, reads as Watchkeeper Deck"], "the disagreement is visible");
  assert.deepEqual(await roundNotes(portal, "placed"), [], "a sure column needs no look");
  const wk = portal.rows.find((r) => r.id === "wk")!;
  assert.equal(wk.filename, "EVANS, Brenton - QL-04 Master _45m NC.pdf", "the office's name is left as the office's: the refile does not rename it for the reader's column");
  assert.ok(!wk.namedByPortal, "and it stays the office's word");
  // The row's own read code is the document's first column - the office's
  // filed QL-04 - never the second column it also fills.
  const readCodes = portal.db.asked.filter((a) => /UPDATE documents\s+SET read_code/.test(a.sql) && a.args[0] === "wk").map((a) => a.args[1]);
  assert.ok(readCodes.length > 0, "the row's read code is written");
  assert.deepEqual([...new Set(readCodes)], ["QL-04"], "and it is the filed column's");
  const page = await certificateStanding();
  assert.deepEqual(page.dates.map((d) => d.code).sort(), ["QL-04", "QL-08"], "the page's cells fill the same two");
  assert.deepEqual(page.filedAs.map((f) => f.code), ["QL-04"]);
});

test("what it is for: a statement with two units fills both columns, with nothing to look at", async () => {
  const { portal, env } = await smartPortal([{ id: "units", filename: "statement.pdf",
    reading: { certificateTitle: "Statement of Attainment", units: ["RIIWHS202E", "RIIWHS204E"], qualCode: "PT-02", codeConfidence: "high",
      columns: [{ code: "PT-02", confidence: "high", why: "RIIWHS202E printed" }, { code: "PT-03", confidence: "high", why: "RIIWHS204E printed" }] } }]);
  await worker.scheduled({} as never, env as never);
  assert.equal(evansCell(portal, "PT-02"), "2031-05-26");
  assert.equal(evansCell(portal, "PT-03"), "2031-05-26", "both columns, the reader and the covers rule agreeing, counted once");
  assert.deepEqual(await roundNotes(portal, "placed"), []);
  assert.deepEqual((await certificateStanding()).dates.map((d) => d.code).sort(), ["PT-02", "PT-03"]);
});

test("what it is for: a guess fills nothing, and a reading made before the new question is placed as it always was", async () => {
  const { portal, env } = await smartPortal([
    { id: "guess", filename: "scan.pdf", reading: { certificateTitle: "Some course", qualCode: null, codeConfidence: null, columns: [{ code: "QL-08", confidence: "low", why: "a guess" }] } },
    // The old shape: one code, sure, no columns key.
    { id: "old", filename: "old.pdf", reading: { certificateTitle: "Master <45m NC", qualCode: "QL-04", codeConfidence: "high" } },
  ]);
  await worker.scheduled({} as never, env as never);
  assert.equal(evansCell(portal, "QL-08"), "", "a guess fills nothing");
  assert.equal(evansCell(portal, "QL-04"), "2031-05-26", "the old reading's one code, as before");
  assert.deepEqual((await certificateStanding()).notOnMatrix, [], "a guess is still the reader's answer that the paper is the matrix's business");
});

test("a hand tag fills its column whatever the reader says, and the reader's disagreement is said", async () => {
  /* Matthew, 26 Sep 2026: the column picked on the upload page is the
     column, and where the AI thinks the person picked the wrong one, a
     warning. Tagged QL-04, read as a Watchkeeper Deck ticket (QL-08, sure):
     QL-04 fills from the tag, QL-08 does not, and Needs attention says so. */
  const { portal, env } = await smartPortal([{ id: "tagged", filename: "scan.pdf", qualCode: "QL-04",
    reading: { certificateTitle: "Watchkeeper Deck", qualCode: "QL-08", codeConfidence: "high",
      columns: [{ code: "QL-08", confidence: "high", why: "Watchkeeper Deck corresponds to Master <24m NC" }] } }]);
  await worker.scheduled({} as never, env as never);
  assert.equal(evansCell(portal, "QL-04"), "2031-05-26", "the tagged column, from the tag");
  assert.equal(evansCell(portal, "QL-08"), "", "a tag alone places the document");
  assert.deepEqual(await roundNotes(portal, "filed-as"), ["EVANS, Brenton — QL-04: filed as Master <45m NC, reads as Watchkeeper Deck"], "the disagreement is said");
  const page = await certificateStanding();
  assert.deepEqual(page.filedAs.map((f) => [f.code, f.readsAs, f.fileId]), [["QL-04", "Watchkeeper Deck", "tagged"]], "and the page's cells carry it, with the file");

  // The reader agrees, or has nothing to offer: no line.
  const agreed = await smartPortal([
    { id: "ok", filename: "scan.pdf", qualCode: "QL-04", reading: { certificateTitle: "Master <45m NC", qualCode: "QL-04", codeConfidence: "high", columns: [{ code: "QL-04", confidence: "high", why: null }] } },
    { id: "blank", filename: "scan2.pdf", qualCode: "QL-08", reading: { certificateTitle: "Some course", qualCode: null, codeConfidence: null, columns: [] } },
  ]);
  await worker.scheduled({} as never, agreed.env as never);
  assert.deepEqual(await roundNotes(agreed.portal, "filed-as"), []);
  assert.equal(evansCell(agreed.portal, "QL-08"), "2031-05-26", "the tag fills the column the reader could not name");
});

test("two documents neither running the longer: the one issued last holds the cell, on the page and in the round", async () => {
  /* Nineteen induction forms uploaded on 26 Sep 2026, each renewing a 2024
     form on file: neither prints an expiry, so the contest was a tie and
     the first-filed - the old one - kept the cell, expired. The later
     issued is the one in force. */
  const { portal, env } = await smartPortal([
    { id: "old", filename: "old.pdf", reading: { certificateTitle: "Vessel Induction - New Crew", qualCode: "QL-04", codeConfidence: "high",
      issuedOn: "2024-04-19", expiresOn: null, columns: [{ code: "QL-04", confidence: "high", why: null }] } },
    { id: "new", filename: "new.pdf", reading: { certificateTitle: "Vessel Induction - New Crew", qualCode: "QL-04", codeConfidence: "high",
      issuedOn: "2026-09-18", expiresOn: null, columns: [{ code: "QL-04", confidence: "high", why: null }] } },
  ]);
  await worker.scheduled({} as never, env as never);
  // The refile has renamed both by now, so the note is held to its words.
  const said = await roundNotes(portal, "superseded");
  assert.equal(said.length, 1);
  assert.match(said[0], /^Two certificates on file for QL-04\. Neither runs the longer, and .+ was issued last, so .+ is treated as the one it replaced\.$/);
  const page = await certificateStanding();
  assert.deepEqual(page.dates.filter((d) => d.code === "QL-04").map((d) => [d.fileId, d.issued]), [["new", "2026-09-18"]], "the page's cells open the new one");
  // Two on file: the old one is set aside, named beside the one that holds the cell.
  assert.deepEqual(page.superseded.map((s) => [s.fileId, s.code, s.person]), [["old", "QL-04", "EVANS, BRENTON"]]);
  assert.match(page.superseded[0].kept, /QL-04/, "the one in force, by name");
  assert.deepEqual(page.superseded[0].holds, [], "and it holds nothing else: a double up the list may offer");
  // Filed the other way round, the same answer.
  const swapped = await smartPortal([
    { id: "new", filename: "new.pdf", reading: { qualCode: "QL-04", codeConfidence: "high", issuedOn: "2026-09-18", expiresOn: null, columns: [{ code: "QL-04", confidence: "high", why: null }] } },
    { id: "old", filename: "old.pdf", reading: { qualCode: "QL-04", codeConfidence: "high", issuedOn: "2024-04-19", expiresOn: null, columns: [{ code: "QL-04", confidence: "high", why: null }] } },
  ]);
  await worker.scheduled({} as never, swapped.env as never);
  assert.deepEqual((await certificateStanding()).dates.filter((d) => d.code === "QL-04").map((d) => d.fileId), ["new"]);
  // A printed expiry still decides where there is one.
  const dated = await smartPortal([
    { id: "long", filename: "long.pdf", reading: { qualCode: "QL-04", codeConfidence: "high", issuedOn: "2024-04-19", expiresOn: "2031-05-26", columns: [{ code: "QL-04", confidence: "high", why: null }] } },
    { id: "short", filename: "short.pdf", reading: { qualCode: "QL-04", codeConfidence: "high", issuedOn: "2026-09-18", expiresOn: "2028-09-18", columns: [{ code: "QL-04", confidence: "high", why: null }] } },
  ]);
  await worker.scheduled({} as never, dated.env as never);
  assert.equal(evansCell(dated.portal, "QL-04"), "2031-05-26", "the longer runs");
});

test("double ups: a certificate set aside for one column but holding others is no double up, and both sides say so", async () => {
  /* 27 Sep 2026. Sixteen documents were on the Double ups list for the one
     column a newer document had taken while they still held others - a
     Master ticket "replaced" for one column and still holding QL-01, QL-02,
     QL-03, QL-08 and QL-13 - and deleting them blanked 28 cells. Here a
     Master ticket the reader is sure answers for QL-04 as well loses QL-04
     to the QL-04 certificate that runs the longer, and still holds its own
     QL-01: the page's superseded entry says what it holds, the round's note
     says the same, and the list on Documents leaves it out. */
  const { portal, env } = await smartPortal([
    { id: "master", filename: "master.pdf", reading: { certificateTitle: "Certificate of Competency - Master", qualCode: "QL-01", codeConfidence: "high",
      issuedOn: "2022-09-27", expiresOn: "2027-09-26",
      columns: [{ code: "QL-01", confidence: "high", why: null }, { code: "QL-04", confidence: "high", why: null }] } },
    { id: "nc", filename: "nc.pdf", reading: { certificateTitle: "Certificate of Competency - Master <45m Near Coastal", qualCode: "QL-04", codeConfidence: "high",
      issuedOn: "2026-03-10", expiresOn: "2031-03-09", columns: [{ code: "QL-04", confidence: "high", why: null }] } },
  ]);
  await worker.scheduled({} as never, env as never);
  assert.equal(evansCell(portal, "QL-01"), "2027-09-26", "the ticket holds its own column");
  assert.equal(evansCell(portal, "QL-04"), "2031-03-09", "the QL-04 certificate holds QL-04");
  const said = await roundNotes(portal, "superseded");
  assert.equal(said.length, 1);
  // The refile has renamed both by now, so the note is held to its words.
  assert.match(said[0], /^Two certificates on file for QL-04\. .* runs the longer, so .* is treated as the one it replaced\. It still holds QL-01, so it is not a double up\.$/);
  const page = await certificateStanding();
  assert.deepEqual(page.dates.filter((d) => d.code === "QL-01" || d.code === "QL-04").map((d) => [d.code, d.fileId]).sort(), [["QL-01", "master"], ["QL-04", "nc"]],
    "the page's cells open the same documents");
  assert.deepEqual(page.superseded.map((s) => [s.fileId, s.code, s.holds]), [["master", "QL-04", ["QL-01"]]],
    "set aside for QL-04, and what it still holds is said");
  // Two plain copies of the one certificate: the one set aside holds nothing.
  const twice = await smartPortal([
    { id: "old", filename: "old.pdf", reading: { qualCode: "QL-04", codeConfidence: "high", issuedOn: "2024-04-19", expiresOn: "2029-04-18", columns: [{ code: "QL-04", confidence: "high", why: null }] } },
    { id: "new", filename: "new.pdf", reading: { qualCode: "QL-04", codeConfidence: "high", issuedOn: "2026-09-18", expiresOn: "2031-09-17", columns: [{ code: "QL-04", confidence: "high", why: null }] } },
  ]);
  await worker.scheduled({} as never, twice.env as never);
  assert.deepEqual((await certificateStanding()).superseded.map((s) => [s.fileId, s.holds]), [["old", []]], "a true double up holds nothing");
  assert.doesNotMatch((await roundNotes(twice.portal, "superseded"))[0], /still holds/, "and the round's note adds nothing");
});

test("wrong dates: a Master ticket listing IV/2 never stands for GMDSS, and never cuts the GMDSS recognition back", async () => {
  /* 27 Sep 2026. Two AMSA Master tickets were placed on QL-14 by the reader
     on "GMDSS endorsement IV/2 listed" - the one door the vessel file's rule
     ("IV/2 in a ticket's regulation list fills nothing") left open - and
     then, standing in the same column as the men's GMDSS certificates of
     recognition, were taken for the foreign certificate behind them and cut
     the GMDSS cells back to the Master tickets' expiry: 2027 against a
     GMDSS certificate printing 2031. */
  const { portal, env } = await smartPortal([
    { id: "master", filename: "master.pdf", reading: { certificateTitle: "Certificate of Competency - Master", qualCode: "QL-01", codeConfidence: "high",
      issuer: "Australian Maritime Safety Authority", issuedOn: "2022-09-27", expiresOn: "2027-09-26",
      columns: [{ code: "QL-01", confidence: "high", why: null }, { code: "QL-14", confidence: "medium", why: "GMDSS endorsement IV/2 listed on certificate" }] } },
    { id: "gmdss", filename: "gmdss.pdf", reading: { certificateTitle: "Certificate of Recognition - GMDSS General Operator", qualCode: "QL-14", codeConfidence: "high",
      issuer: "Australian Maritime Safety Authority", isRecognition: true, recognises: { authority: "MCA", country: "United Kingdom", number: "UK-1", expiresOn: null },
      issuedOn: "2026-03-10", expiresOn: "2031-03-09", columns: [{ code: "QL-14", confidence: "high", why: null }] } },
  ]);
  const doc = portal.doc();
  doc.quals.cols.push(["QL-14", "GMDSS - STCW Reg IV/2", "Qualification"]);
  doc.quals.rows[0][3].push("");
  portal.state.data = JSON.stringify(doc);
  await worker.scheduled({} as never, env as never);
  assert.equal(evansCell(portal, "QL-14"), "2031-03-09", "the GMDSS cell runs as the GMDSS certificate prints");
  assert.equal(evansCell(portal, "QL-01"), "2027-09-26", "and the ticket still holds its own column");
  assert.deepEqual(await roundNotes(portal, "superseded"), [], "the ticket never stood for QL-14, so nothing was set aside");
  assert.deepEqual(await roundNotes(portal, "placed"), [], "and no 'placed by the reading' line for it either");
  const page = await certificateStanding();
  assert.deepEqual(page.dates.filter((d) => d.code === "QL-14").map((d) => [d.expires, d.fileId]), [["2031-03-09", "gmdss"]], "the page's cell agrees");
  // A GMDSS certificate is still its own column on the reader's word.
  assert.deepEqual(columnsFor({ qualCode: null, filename: "x.pdf" }, { qualCode: "QL-14", columns: [{ code: "QL-14", confidence: "medium", why: null }] } as never, [], [["QL-14", "GMDSS"]]).map((c) => c.code),
    ["QL-14"], "the document that IS the GMDSS certificate");
  assert.deepEqual(columnsFor({ qualCode: null, filename: "x.pdf" }, { qualCode: "QL-01", columns: [{ code: "QL-01", confidence: "high", why: null }, { code: "QL-14", confidence: "high", why: "IV/2" }] } as never, [], [["QL-01", "Master"], ["QL-14", "GMDSS"]]).map((c) => c.code),
    ["QL-01"], "never the reader's word for another document, however sure");
  // And an AMSA ticket that does stand in a recognition's column (a hand tag here) is never the foreign one behind it.
  setEnv({ DB: coversDb([
    { row: { id: "amsa", qualCode: "QL-01" }, reading: { ...evansCoC, issuer: "Australian Maritime Safety Authority", expiresOn: "2027-01-01", endorsements: [] } },
    { row: { id: "rec", qualCode: "QL-01" }, reading: recognitionOf({ issuer: "Australian Maritime Safety Authority", recognises: { authority: "MCA", country: "United Kingdom", number: "UK-9921", expiresOn: null } }) },
  ]), FILE_STORE: "r2" } as never);
  const out = await compareMatrix(coversMatrix, null, evansOnly);
  assert.deepEqual(out.settled.filter((x) => x.code === "QL-01"), [{ person: "EVANS, Brenton", code: "QL-01", value: "2030-06-30" }],
    "the recognition runs to its own date, not cut to the AMSA ticket's 2027");
  setEnv({ DB: coversDb([
    { row: { id: "amsa", qualCode: "QL-01" }, reading: { ...evansCoC, issuer: "Australian Maritime Safety Authority", expiresOn: "2027-01-01", endorsements: [] } },
    { row: { id: "rec", qualCode: "QL-01" }, reading: recognitionOf({ issuer: "Australian Maritime Safety Authority", recognises: { authority: "MCA", country: "United Kingdom", number: "UK-9921", expiresOn: null } }) },
  ]), FILE_STORE: "r2" } as never);
  assert.deepEqual((await certificateStanding()).dates.map((d) => [d.code, d.expires, d.fileId]), [["QL-01", "2030-06-30", "rec"]], "and the page's cell agrees");
});

test("wrong dates: a reader's 'maybe' never displaces the column's own certificate, and is no double up", async () => {
  /* 27 Sep 2026. Evgeny Evdokimov's advanced resuscitation statement was
     placed on QL-18 on a medium ("includes HLTAID009 CPR"), was issued a
     fortnight after his First Aid certificate, and took the First Aid cell
     on the later issue date - and the Double ups list then offered his First
     Aid certificate for deletion. The column's own certificate holds it. */
  const { portal, env } = await smartPortal([
    { id: "firstaid", filename: "EVANS, Brenton - QL-04 Master _45m NC.pdf", reading: { certificateTitle: "Master <45m NC", qualCode: "QL-04", codeConfidence: "high",
      issuedOn: "2026-09-10", expiresOn: null, columns: [{ code: "QL-04", confidence: "high", why: null }] } },
    { id: "resus", filename: "resus.pdf", reading: { certificateTitle: "Statement of Attainment - advanced course", qualCode: "QL-08", codeConfidence: "high",
      issuedOn: "2026-09-24", expiresOn: null,
      columns: [{ code: "QL-08", confidence: "high", why: null }, { code: "QL-04", confidence: "medium", why: "includes the lower grade" }] } },
  ]);
  await worker.scheduled({} as never, env as never);
  const said = await roundNotes(portal, "superseded");
  assert.equal(said.length, 1);
  assert.match(said[0], /^.* was only placed on QL-04 by the reading, and .* is the QL-04 certificate itself, so it holds the cell.( It still holds QL-08, so it is not a double up.)?$/);
  const page = await certificateStanding();
  assert.deepEqual(page.dates.filter((d) => d.code === "QL-04").map((d) => [d.fileId, d.issued]), [["firstaid", "2026-09-10"]],
    "the page's cell opens the certificate itself, not the later 'maybe'");
  assert.deepEqual(page.superseded.map((s) => [s.fileId, s.code, s.placedOnly]), [["resus", "QL-04", true]],
    "the 'maybe' is set aside as only placed there - no double up, no '2 on file'");
  // Filed the other way round, the same answer.
  const swapped = await smartPortal([
    { id: "resus", filename: "resus.pdf", reading: { certificateTitle: "Statement of Attainment - advanced course", qualCode: "QL-08", codeConfidence: "high",
      issuedOn: "2026-09-24", expiresOn: null,
      columns: [{ code: "QL-08", confidence: "high", why: null }, { code: "QL-04", confidence: "medium", why: "includes the lower grade" }] } },
    { id: "firstaid", filename: "EVANS, Brenton - QL-04 Master _45m NC.pdf", reading: { certificateTitle: "Master <45m NC", qualCode: "QL-04", codeConfidence: "high",
      issuedOn: "2026-09-10", expiresOn: null, columns: [{ code: "QL-04", confidence: "high", why: null }] } },
  ]);
  await worker.scheduled({} as never, swapped.env as never);
  assert.deepEqual((await certificateStanding()).dates.filter((d) => d.code === "QL-04").map((d) => d.fileId), ["firstaid"]);
  // Two 'maybes' fall to the dates as before: the later one holds the cell.
  const both = await smartPortal([
    { id: "a", filename: "a.pdf", reading: { qualCode: "QL-08", codeConfidence: "high", issuedOn: "2025-01-01", expiresOn: null,
      columns: [{ code: "QL-08", confidence: "high", why: null }, { code: "QL-04", confidence: "medium", why: "x" }] } },
    { id: "b", filename: "b.pdf", reading: { qualCode: "QL-01", codeConfidence: "high", issuedOn: "2026-01-01", expiresOn: null,
      columns: [{ code: "QL-01", confidence: "high", why: null }, { code: "QL-04", confidence: "medium", why: "y" }] } },
  ]);
  await worker.scheduled({} as never, both.env as never);
  assert.deepEqual((await certificateStanding()).superseded.filter((s) => s.code === "QL-04").map((s) => [s.fileId, s.placedOnly]), [["a", false]],
    "the same standing: the later issued holds it, and the other is a plain set-aside");
  // A 'maybe' printing the very dates of the certificate that beat it is a copy of it: still a double up.
  const copy = await smartPortal([
    { id: "firstaid", filename: "EVANS, Brenton - QL-04 Master _45m NC.pdf", reading: { certificateTitle: "Master <45m NC", qualCode: "QL-04", codeConfidence: "high",
      issuedOn: "2026-09-10", expiresOn: "2031-09-09", columns: [{ code: "QL-04", confidence: "high", why: null }] } },
    { id: "again", filename: "scan0001.pdf", reading: { certificateTitle: "Master <45m NC", qualCode: "QL-04", codeConfidence: "medium",
      issuedOn: "2026-09-10", expiresOn: "2031-09-09", columns: [{ code: "QL-04", confidence: "medium", why: "a second scan of it" }] } },
  ]);
  await worker.scheduled({} as never, copy.env as never);
  assert.deepEqual((await certificateStanding()).superseded.map((s) => [s.fileId, s.code, s.placedOnly]), [["again", "QL-04", false]],
    "the second scan is a double up the list may offer");
});

test("wrong dates: an MSIC card runs to the last day of the month it prints, however the reading took the day", async () => {
  /* Every Australian MSIC card prints a month and a two-digit year ("FEB 30")
     and runs to the last day of that month (Matthew, 26 Sep 2026). On
     27 Sep 2026 ten cards on the matrix read the 1st and one leap-year
     February read the 28th. */
  const card = (id: string, expiresOn: string) => ({ row: { id, qualCode: "VS-01" },
    reading: { ...evansCoC, certificateTitle: "Maritime Security Identification Card", qualCode: "VS-01", issuer: "AusCheck", expiresOn, endorsements: [] } });
  const msicMatrix = { cols: [["VS-01", "Maritime Security Identification Card", "Vessel Specific"]] as [string, string, string][],
    rows: [["EVANS, Brenton", "Master", "", [""]]] as [string, string, string, string[]][] };
  setEnv({ DB: coversDb([card("c1", "2029-10-01")]), FILE_STORE: "r2" } as never);
  assert.deepEqual((await compareMatrix(msicMatrix, null, evansOnly)).settled, [{ person: "EVANS, Brenton", code: "VS-01", value: "2029-10-31" }], "the 1st of October is 31 October");
  setEnv({ DB: coversDb([card("c1", "2029-10-01")]), FILE_STORE: "r2" } as never);
  assert.deepEqual((await certificateStanding()).dates.map((d) => [d.code, d.expires]), [["VS-01", "2029-10-31"]], "and the page's cell agrees");
  setEnv({ DB: coversDb([card("c2", "2028-02-28")]), FILE_STORE: "r2" } as never);
  assert.deepEqual((await compareMatrix(msicMatrix, null, evansOnly)).settled.map((x) => x.value), ["2028-02-29"], "a leap-year February runs to the 29th");
  // Only the card itself: a document that merely mentions an MSIC keeps its own day.
  setEnv({ DB: coversDb([{ row: { id: "m", qualCode: "QL-01" }, reading: { ...evansCoC, expiresOn: "2031-05-01", endorsements: [] } }]), FILE_STORE: "r2" } as never);
  assert.deepEqual((await compareMatrix(coversMatrix, null, evansOnly)).settled.filter((x) => x.code === "QL-01").map((x) => x.value), ["2031-05-01"], "a Master ticket keeps the day it prints");
});

test("wrong dates: a column reached by a printed unit code runs no longer than the office's period for it", async () => {
  /* 27 Sep 2026. Dylan Evans's three-year first-aid statement lists the
     advanced resuscitation unit too (HLTAID015), and the office's skills
     matrix gives that column one year. The cover took the statement's own
     2029 and beat his own QL-19 certificate running to 2027. */
  const first = { ...evansCoC, certificateTitle: "Statement of Attainment - Provide First Aid", qualCode: "QL-18", issuer: "Allens Training",
    issuedOn: "2026-04-30", expiresOn: "2029-04-30", endorsements: [], units: ["HLTAID011", "HLTAID015"] };
  const own = (expiresOn: string | null, issuedOn: string) => ({ ...evansCoC, certificateTitle: "Statement of Attainment - Advanced Resuscitation",
    qualCode: "QL-19", issuer: "Allens Training", issuedOn, expiresOn, endorsements: [], units: ["HLTAID015"] });
  const matrix = { cols: [["QL-18", "Provide First Aid - HLTAID011", "Qualification"], ["QL-19", "Adv Resuscitation and Oxygen Therapy - HLTAID015", "Qualification"]] as [string, string, string][],
    rows: [["EVANS, Brenton", "Master", "", ["", ""]]] as [string, string, string, string[]][] };
  const periods = [{ code: "QL-18", item: "Provide First Aid - HLTAID011", months: 36 }, { code: "QL-19", item: "Adv Resuscitation and Oxygen Therapy - HLTAID015", months: 12 }];
  const run = async (certs: { row: Partial<Row>; reading: unknown }[]) => {
    setEnv({ DB: coversDb(certs, undefined, periods), FILE_STORE: "r2" } as never);
    const round = Object.fromEntries((await compareMatrix(matrix, null, evansOnly)).settled.map((x) => [x.code, x.value]));
    setEnv({ DB: coversDb(certs, undefined, periods), FILE_STORE: "r2" } as never);
    const page = await certificateStanding();
    return { round, page };
  };
  // The statement alone: QL-19 one year from its issue, not the statement's three.
  const alone = await run([{ row: { id: "fa", qualCode: "QL-18" }, reading: first }]);
  assert.deepEqual(alone.round, { "QL-18": "2029-04-30", "QL-19": "2027-04-30" }, "QL-19 held to the office's one year");
  assert.deepEqual(alone.page.dates.filter((d) => d.code === "QL-19").map((d) => [d.expires, d.covered]), [["2027-04-30", true]], "and the page's cell agrees");
  // His own QL-19 printing its date: it runs as long, so it holds its own cell.
  const printed = await run([{ row: { id: "fa", qualCode: "QL-18" }, reading: first }, { row: { id: "adv", qualCode: "QL-19" }, reading: own("2027-04-30", "2026-04-30") }]);
  assert.equal(printed.round["QL-19"], "2027-04-30");
  assert.deepEqual(printed.page.dates.filter((d) => d.code === "QL-19").map((d) => d.fileId), ["adv"], "the cell opens his own QL-19");
  // His own QL-19 printing no expiry, issued after the statement: counted on its worked date, it holds the cell.
  const worked = await run([{ row: { id: "fa", qualCode: "QL-18" }, reading: { ...first, issuedOn: "2024-05-03", expiresOn: "2027-05-03" } },
    { row: { id: "adv", qualCode: "QL-19" }, reading: own(null, "2026-05-06") }]);
  assert.equal(worked.round["QL-19"], "2027-05-06", "his own certificate, worked from its issue date and the office's year");
  assert.deepEqual(worked.page.dates.filter((d) => d.code === "QL-19").map((d) => d.fileId), ["adv"], "and the page's cell opens it");
  // With no validity periods filed, nothing to cap by: the statement's own date, as before.
  setEnv({ DB: coversDb([{ row: { id: "fa", qualCode: "QL-18" }, reading: first }]), FILE_STORE: "r2" } as never);
  assert.deepEqual((await compareMatrix(matrix, null, evansOnly)).settled.map((x) => [x.code, x.value]), [["QL-18", "2029-04-30"], ["QL-19", "2029-04-30"]]);
});

test("not placed: a document read but not put on the matrix says why on the page's list", async () => {
  const { env } = await smartPortal([
    { id: "blur", filename: "blur.pdf", reading: { readable: false, reason: "Too blurred to read.", columns: [] } },
    { id: "his", filename: "his.pdf", reading: { holderName: "Rohin JITENDER", qualCode: "QL-04", codeConfidence: "high", columns: [{ code: "QL-04", confidence: "high", why: null }] } },
    { id: "nodate", filename: "card.pdf", qualCode: "QL-08", reading: { certificateTitle: "Maritime Security Identification Card", qualCode: "QL-08", codeConfidence: "high", issuedOn: null, expiresOn: null, columns: [{ code: "QL-08", confidence: "high", why: null }] } },
  ]);
  await worker.scheduled({} as never, env as never);
  const page = await certificateStanding();
  assert.deepEqual(page.notPlaced.map((n) => [n.fileId, n.why, n.printed, n.code, n.reason]).sort(), [
    ["blur", "unreadable", null, null, "Too blurred to read."],
    ["his", "name", "Rohin JITENDER", "QL-04", null],
    ["nodate", "no-date", null, "QL-08", null],
  ]);
});

test("an issue date that has not come yet is no date: dropped as it is read, and folded to none where it was stored", async () => {
  /* A medical read as issued "2076-05-04" (26 Sep 2026): the scan's slip
     would have run a validity period out to 2081, and hid the cell among
     the dated ones. Read now, the date is dropped; stored before, it is
     folded to none as the readings load, so the cell is listed as one no
     date could be read off. */
  const { portal, env } = await smartPortal([
    { id: "med", filename: "medical.pdf", qualCode: "QL-17", reading: { certificateTitle: "Certificate of Medical Fitness", qualCode: "QL-17", codeConfidence: "high",
      issuedOn: "2076-05-04", expiresOn: null, columns: [{ code: "QL-17", confidence: "high", why: null }] } },
  ]);
  await worker.scheduled({} as never, env as never);
  assert.equal(evansCell(portal, "QL-17"), "2030-01-17", "the office's typed date stands: nothing worked from a date in the future");
  const page = await certificateStanding();
  assert.deepEqual(page.notPlaced.map((n) => [n.fileId, n.why, n.code]), [["med", "no-date", "QL-17"]], "listed as read with no date");
  assert.deepEqual(page.dates.filter((d) => d.code === "QL-17").map((d) => d.issued), [null], "and the page's cells carry no issue date for it");

  // Read now: the reader's future date is dropped on the way in.
  const fresh = await unreadPortal(1);
  fresh.portal.rows.splice(fresh.portal.rows.findIndex((r) => r.id === "c2"), 1);
  const model = modelAnswers(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans", issuedOn: "2076-05-04", expiresOn: null,
    columns: [{ code: "QL-01", confidence: "high", why: null }] }) }));
  try {
    await extract([["QL-01", "Master"], ["QL-17", "Medical"]], 4);
  } finally {
    model.restore();
  }
  const stored = JSON.parse(fresh.portal.blobs.get("certificate-readings|r1/unread-1.json")!);
  assert.equal(stored.issuedOn, null, "no issue date, rather than one in 2076");
});

test("a register page counts only for the columns the office keeps in a register", async () => {
  /* The office records the cargo-system approvals in a register, not on a
     certificate (the vessel file's registerEvidenced: CS-03 and CS-04). A
     register page filed for CS-04 that the reader holds to be evidence for
     it fills the cell, with the line for a quick look. */
  const { portal, env } = await smartPortal([{ id: "reg", filename: "EVANS, Brenton - CS-04 Cargo System - Trainer - Practical.pdf",
    reading: { certificateTitle: "Cargo system approvals register", registerPage: true, qualCode: "CS-04", codeConfidence: "medium",
      columns: [{ code: "CS-04", confidence: "medium", why: "listed as an approved trainer on the register" }] } }]);
  await worker.scheduled({} as never, env as never);
  assert.equal(evansCell(portal, "CS-04"), "Y", "filled - held, since CS-04 never lapses on this vessel");
  assert.deepEqual(await roundNotes(portal, "placed"), ["EVANS, Brenton — CS-04: placed by the reading (listed as an approved trainer on the register)"]);

  // The same page filed for QL-01, read today: not a certificate, so nothing.
  const other = await unreadPortal(1);
  other.portal.rows.splice(other.portal.rows.findIndex((r) => r.id === "c2"), 1);
  const u1 = other.portal.rows.find((r) => r.id === "u1")!;
  u1.filename = "EVANS, Brenton - QL-01 Master.pdf";
  const model = modelAnswers(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans", registerPage: true,
    columns: [{ code: "QL-01", confidence: "medium", why: "listed on the register" }] }) }));
  try {
    await extract([["QL-01", "Master"], ["QL-17", "Medical"]], 4);
  } finally {
    model.restore();
  }
  const doc = other.portal.doc();
  const out = await compareMatrix(doc.quals, null, asKnownPerson(doc.people));
  assert.deepEqual(out.claimed, [], "nothing filled - not even by the column in its name");
  assert.deepEqual(out.notes.filter((n) => n.kind === "unreadable").map((n) => n.detail), ["A register page or listing, not a certificate."]);
});

test("a hand tag on a column that never lapses stands whatever the reader makes of the document", async () => {
  /* Evan Farmer's cargo-system practical assessment, filed by hand for the
     column (Matthew, 25 Sep 2026): the office's evidence for CS-03/CS-04 is
     an assessment form or an email, no certificate and no expiry, and the
     man read as Missing what he holds. CS-04 never lapses on this vessel
     (the office's own sheet), so the person's tag is the whole answer: the
     cell is held, on the reader's "no" as much as on its reading. */
  const { portal, env } = await smartPortal([
    // Read as a form, not a certificate: no column, no date.
    { id: "form", filename: "assessment.pdf", qualCode: "CS-04",
      reading: { certificateTitle: "Cargo loading & discharge system - operator - practical assessment", qualCode: null, codeConfidence: null, columns: [], expiresOn: null } },
  ]);
  await worker.scheduled({} as never, env as never);
  assert.equal(evansCell(portal, "CS-04"), "Y", "held on the tag, no date needed");
  assert.deepEqual((await certificateStanding()).dates.map((d) => [d.code, d.expires]), [["CS-04", null]], "the page's cells agree");

  // The reader would not call it a certificate at all: the tag still stands.
  const no = await smartPortal([
    { id: "no", filename: "assessment.pdf", qualCode: "CS-04", reading: { readable: false, reason: "Not a certificate.", expiresOn: null, columns: [] } },
  ]);
  await worker.scheduled({} as never, no.env as never);
  assert.equal(evansCell(no.portal, "CS-04"), "Y", "held on the person's word");
  assert.deepEqual(await roundNotes(no.portal, "unreadable"), [], "and not listed as unreadable: it stands");
  assert.deepEqual((await certificateStanding()).dates.map((d) => d.code), ["CS-04"]);

  // A register page tagged for a register column stands the same way.
  const reg = await smartPortal([
    { id: "reg", filename: "register.pdf", qualCode: "CS-04",
      reading: { readable: false, reason: "A register page or listing, not a certificate.", registerPage: true, expiresOn: null, columns: [] } },
  ]);
  await worker.scheduled({} as never, reg.env as never);
  assert.equal(evansCell(reg.portal, "CS-04"), "Y");

  // The same "no" with no tag: unreadable, as it always was.
  const untagged = await smartPortal([
    { id: "plain", filename: "EVANS, Brenton - CS-04 Cargo System - Trainer - Practical.pdf", reading: { readable: false, reason: "Not a certificate.", expiresOn: null, columns: [] } },
  ]);
  await worker.scheduled({} as never, untagged.env as never);
  assert.equal(evansCell(untagged.portal, "CS-04"), "", "a filename is not a person's tag");
  assert.deepEqual(await roundNotes(untagged.portal, "unreadable"), ["Not a certificate."]);

  // A tag on a dated column needs a date: the reader's "no" stands there,
  // unless a date was typed against the row.
  const dated = await smartPortal([
    { id: "d1", filename: "scan1.pdf", qualCode: "QL-04", reading: { readable: false, reason: "Too poor to read.", expiresOn: null, columns: [] } },
    { id: "d2", filename: "scan2.pdf", qualCode: "QL-08", reading: { readable: false, reason: "Too poor to read.", expiresOn: null, columns: [] } },
    // A register page is never a Master's ticket, whoever tagged it.
    { id: "d3", filename: "scan3.pdf", qualCode: "QL-01", reading: { readable: false, reason: "A register page or listing, not a certificate.", registerPage: true, expiresOn: null, columns: [] } },
  ]);
  dated.portal.rows.find((r) => r.id === "d2")!.expiresOn = "2029-03-01";
  dated.portal.rows.find((r) => r.id === "d3")!.expiresOn = "2029-03-01";
  await worker.scheduled({} as never, dated.env as never);
  assert.equal(evansCell(dated.portal, "QL-04"), "", "no date to give");
  assert.equal(evansCell(dated.portal, "QL-08"), "2029-03-01", "the typed date is the person's word");
  assert.equal(evansCell(dated.portal, "QL-01"), "", "a register page fills no Master's cell");
  assert.deepEqual(await roundNotes(dated.portal, "unreadable"), ["Too poor to read.", "A register page or listing, not a certificate."]);
  assert.deepEqual((await certificateStanding()).dates.map((d) => [d.code, d.expires]), [["QL-08", "2029-03-01"]], "the page's cells agree");
});

test("a unit code covers a column that never lapses: held, with no date, by the round and the page alike", async () => {
  /* QL-20 (SITXFSA005) never lapses on this vessel and its unit code is
     printed on a statement read as PT-02. The cover holds QL-20 - "Y", no
     date - and the page's cells link the cell to the statement. A document
     that IS the column still wins the cell. */
  const { portal, env } = await smartPortal([{ id: "units", filename: "statement.pdf",
    reading: { certificateTitle: "Statement of Attainment", units: ["RIIWHS202E", "SITXFSA005"], qualCode: "PT-02", codeConfidence: "high",
      columns: [{ code: "PT-02", confidence: "high", why: "RIIWHS202E printed" }] } }]);
  const doc = portal.doc();
  doc.quals.cols.push(["QL-20", "Use hygienic practices for food safety - SITXFSA005", "Qualification"]);
  doc.quals.rows[0][3].push("");
  portal.state.data = JSON.stringify(doc);
  await worker.scheduled({} as never, env as never);
  assert.equal(evansCell(portal, "PT-02"), "2031-05-26", "its own column, dated");
  assert.equal(evansCell(portal, "QL-20"), "Y", "the covered column, held");
  assert.deepEqual(await roundNotes(portal, "no-expiry-item"), [], "the statement's own date is not read as one the column has not got");
  const page = await certificateStanding();
  assert.deepEqual(page.dates.filter((d) => d.code === "QL-20").map((d) => [d.expires, d.covered, d.fileId]), [[null, true, "units"]], "held by the cover, opening the statement");
});

test("whose it is: a name with no word to compare is placed only on a sure pick, and the office is asked to add it", async () => {
  /* Initials alone, or a script the letters A-Z do not cover, share no word
     with anybody: a maybe on such a name fills nothing. */
  const { portal, env } = await crewPortal([
    { id: "maybe", reading: { holderName: "李伟", holder: { person: "SITTIYOS, Kachin", confidence: "medium", why: "a guess from the photo", others: [] } } },
    { id: "initials", reading: { holderName: "K. S.", holder: { person: "EVANS, Brenton", confidence: "medium", why: "a guess", others: [] } } },
  ]);
  await worker.scheduled({} as never, env as never);
  assert.equal(portal.rows.find((r) => r.id === "maybe")!.person, "Loose", "a maybe on a name with nothing to compare places nothing");
  assert.equal(portal.rows.find((r) => r.id === "initials")!.person, "Loose");
  assert.equal(cellOf(portal, "SITTIYOS, Kachin"), "", "nothing in Kachin's cell");
  assert.equal(cellOf(portal, "EVANS, Brenton"), "", "nothing in Evans's");
  assert.deepEqual((await certificateStanding()).dates.filter((d) => d.person !== "LOOSE"), [], "and the page's cells agree");

  const sure = await crewPortal([
    { id: "sure", reading: { holderName: "李伟", holder: { person: "SITTIYOS, Kachin", confidence: "high", why: "the reader knows the name", others: [] } } },
  ]);
  await worker.scheduled({} as never, sure.env as never);
  assert.equal(sure.portal.rows.find((r) => r.id === "sure")!.person, "SITTIYOS, Kachin");
  assert.deepEqual((await certificateStanding()).readAs.map((r) => readAsLine(r.certificate, "SITTIYOS, Kachin", r.printed, r.line)),
    [`Master <500GT read as SITTIYOS, Kachin's — add "李伟" to their names on Crew Details`], "placed, with the line to add the name");
});

test("whose it is: two EVANSes, or a given name that is none of his, is never placed quietly", async () => {
  /* The register has two EVANSes and will not choose between them for
     "G. EVANS". The reader's sure pick is placed, and said on Needs
     attention to be checked; its maybe is refused. */
  const { portal, env } = await crewPortal([
    { id: "sure", reading: { holderName: "G. EVANS", holder: { person: "EVANS, Brenton", confidence: "high", why: "surname printed", others: [] } } },
    { id: "maybe", reading: { holderName: "G. EVANS", holder: { person: "EVANS, Brenton", confidence: "medium", why: "surname printed", others: [] } } },
  ]);
  const doc = portal.doc();
  doc.people.push({ name: "EVANS, Gareth", aliases: [] });
  portal.state.data = JSON.stringify(doc);
  await worker.scheduled({} as never, env as never);
  assert.equal(portal.rows.find((r) => r.id === "sure")!.person, "EVANS, Brenton", "the sure pick is placed");
  assert.equal(portal.rows.find((r) => r.id === "maybe")!.person, "Loose", "the maybe is not");
  const check = `Master <500GT read as EVANS, Brenton's — check, and add "G. EVANS" to their names on Crew Details`;
  assert.deepEqual((await certificateStanding()).readAs.map((r) => readAsLine(r.certificate, "EVANS, Brenton", r.printed, r.line)), [check],
    "and it is on Needs attention to be checked");
  assert.deepEqual(await roundNotes(portal, "read-as"), [check], "the round says the same");

  // Gareth not on the register at all: the printed given name is none of Brenton's.
  const off = await crewPortal([
    { id: "gareth", reading: { holderName: "Gareth EVANS", holder: { person: "EVANS, Brenton", confidence: "high", why: "surname printed", others: [] } } },
    { id: "garethMaybe", reading: { holderName: "Gareth EVANS", holder: { person: "EVANS, Brenton", confidence: "medium", why: "surname printed", others: [] } } },
  ]);
  await worker.scheduled({} as never, off.env as never);
  assert.equal(off.portal.rows.find((r) => r.id === "garethMaybe")!.person, "Loose", "a maybe with another given name is refused");
  assert.deepEqual((await certificateStanding()).readAs.map((r) => readAsLine(r.certificate, "EVANS, Brenton", r.printed, r.line)),
    [`Master <500GT read as EVANS, Brenton's — check, and add "Gareth EVANS" to their names on Crew Details`], "a sure one is checked");
});

test("whose it is: a surname alone is not placed on the one man the register has by that name, without the reader", async () => {
  /* "D. EVANS" printed, and the reader says it is nobody on the list:
     David is simply not on the register. The one Evans it has is not
     given David's certificate. */
  const { portal, env } = await crewPortal([
    { id: "david", reading: { holderName: "D. EVANS", holder: { person: null, confidence: "low", why: "David Evans is not on the list", others: [] } } },
  ]);
  await worker.scheduled({} as never, env as never);
  assert.equal(portal.rows.find((r) => r.id === "david")!.person, "Loose", "left where it is");
  assert.equal(cellOf(portal, "EVANS, Brenton"), "", "nothing in Evans's cell");
  const page = await certificateStanding();
  assert.deepEqual(page.dates, [], "and the page's cells agree");
  assert.deepEqual(page.readAs, []);
});

test("whose it is: a certificate in a crew member's folder is not moved to another man on the reader's memory alone", async () => {
  /* Filed in Kachin's folder, printed "Bill", and the reader sure it is
     Evans: nothing printed ties it to Evans, so the office's folder is not
     overruled, and the existing note says the name does not fit. */
  const { portal, env, bucket } = await crewPortal([]);
  const key = "opms/Billy - OPMS/bill.pdf";
  await bucket.put(key, bytesOf("a scan"));
  portal.rows.push({ ...billysTicket, id: "bill", person: "SITTIYOS, Kachin", checksum: "bill", blobKey: key, filename: "bill.pdf", qualCode: null });
  portal.blobs.set("certificate-readings|r1/bill.json", JSON.stringify({ ...reading, holderName: "Bill", expiresOn: "2031-05-26",
    columns: [{ code: "QL-01", confidence: "high", why: null }], holder: { person: "EVANS, Brenton", confidence: "high", why: "Bill could be Brenton", others: [] } }));
  await worker.scheduled({} as never, env as never);
  assert.equal(portal.rows.find((r) => r.id === "bill")!.person, "SITTIYOS, Kachin", "not relabelled");
  assert.equal(cellOf(portal, "EVANS, Brenton"), "", "nothing in Evans's cell");
  assert.equal(cellOf(portal, "SITTIYOS, Kachin"), "", "nor Kachin's: the printed name is not his");
  assert.deepEqual(await roundNotes(portal, "name-mismatch"), ["Filed under SITTIYOS, Kachin, but the certificate is in the name of Bill."]);
});

/* A sure pick of Kachin on a certificate printed with another crew member's
   name - Rohin's or Evans's, whole or in part - loose or in Kachin's own
   folder. Nothing lands in Kachin's cell, the loose ones stay loose, and the
   office is never asked to add another man's name to Kachin's. */
for (const [printed, where] of [
  ["R. JITENDER", "loose"],
  ["JITENDER", "loose"],
  ["Rohin", "loose"],
  ["R. JITENDER", "Kachin's folder"],
  ["EVANS", "Kachin's folder"],
  ["Rohin JITENDER", "Kachin's folder"],
] as const) {
  test(`whose it is: "${printed}" ${where}, and the reader sure it is Kachin - nothing lands on Kachin`, async () => {
    const said = { holderName: printed, holder: { person: "SITTIYOS, Kachin", confidence: "high", why: "the reader thinks so", others: [] } };
    const { portal, env, bucket } = await crewPortal(where === "loose" ? [{ id: "w", reading: said }] : []);
    if (where !== "loose") {
      const key = "opms/Billy - OPMS/w.pdf";
      await bucket.put(key, bytesOf("a scan"));
      portal.rows.push({ ...billysTicket, id: "w", person: "SITTIYOS, Kachin", checksum: "w", blobKey: key, filename: "w.pdf", qualCode: null });
      portal.blobs.set("certificate-readings|r1/w.json", JSON.stringify({ ...reading, expiresOn: "2031-05-26", columns: [{ code: "QL-01", confidence: "high", why: null }], ...said }));
    }
    await worker.scheduled({} as never, env as never);
    assert.equal(cellOf(portal, "SITTIYOS, Kachin"), "", "nothing in Kachin's cell");
    const row = portal.rows.find((r) => r.id === "w")!;
    if (where === "loose") assert.equal(row.person, "Loose", "left where it is, labelled for nobody");
    else if (printed === "Rohin JITENDER") assert.equal(row.person, "JITENDER, Rohin", "Crew Details spells it as Rohin's: it goes to him");
    else {
      assert.equal(row.person, "SITTIYOS, Kachin", "left in his folder");
      assert.deepEqual(await roundNotes(portal, "name-mismatch"), [`Filed under SITTIYOS, Kachin, but the certificate is in the name of ${printed}.`]);
    }
    const page = await certificateStanding();
    assert.deepEqual(page.dates.filter((d) => d.person === "SITTIYOS, KACHIN"), [], "and the page's cells agree");
    assert.deepEqual(page.readAs, [], "and nobody is asked to add the name to his");
    assert.deepEqual(await roundNotes(portal, "read-as"), []);
  });
}

test("whose it is: a certificate in Brenton's folder printed in the name of the other EVANS on Crew Details is not Brenton's", async () => {
  /* Two EVANSes on Crew Details, Gareth not on the matrix. "Gareth EVANS"
     is Gareth's as the register spells it: EVANS being Brenton's word too
     does not put it in Brenton's cell, and the existing note says so. */
  const { portal, env, bucket } = await crewPortal([]);
  const doc = portal.doc();
  doc.people.push({ name: "EVANS, Gareth", aliases: [] });
  portal.state.data = JSON.stringify(doc);
  const key = "opms/Brenton - OPMS/gareth.pdf";
  await bucket.put(key, bytesOf("a scan"));
  portal.rows.push({ ...billysTicket, id: "gareth", person: "EVANS, Brenton", folder: "brenton", checksum: "gareth", blobKey: key, filename: "gareth.pdf", qualCode: null });
  portal.blobs.set("certificate-readings|r1/gareth.json", JSON.stringify({ ...reading, holderName: "Gareth EVANS", expiresOn: "2031-05-26",
    columns: [{ code: "QL-01", confidence: "high", why: null }], holder: { person: "EVANS, Gareth", confidence: "high", why: "his full name", others: [] } }));
  await worker.scheduled({} as never, env as never);
  assert.equal(cellOf(portal, "EVANS, Brenton"), "", "nothing in Brenton's cell");
  assert.equal(portal.rows.find((r) => r.id === "gareth")!.person, "EVANS, Brenton", "left in his folder: Gareth has no row to take it");
  assert.deepEqual(await roundNotes(portal, "name-mismatch"), ["Filed under EVANS, Brenton, but the certificate is in the name of Gareth EVANS."]);
  assert.deepEqual((await certificateStanding()).dates, [], "and the page's cells agree");
});

test("whose it is: \"G. EVANS\" in Brenton's folder, the reader sure it is Gareth, goes to Gareth checked and never quietly to Brenton", async () => {
  const { portal, env, bucket } = await crewPortal([]);
  const doc = portal.doc();
  doc.people.push({ name: "EVANS, Gareth", aliases: [] });
  doc.quals.rows.push(["EVANS, Gareth", "GPH", "", ["", ""]]);
  portal.state.data = JSON.stringify(doc);
  const key = "opms/Brenton - OPMS/g.pdf";
  await bucket.put(key, bytesOf("a scan"));
  portal.rows.push({ ...billysTicket, id: "g", person: "EVANS, Brenton", folder: "brenton", checksum: "g", blobKey: key, filename: "g.pdf", qualCode: null });
  portal.blobs.set("certificate-readings|r1/g.json", JSON.stringify({ ...reading, holderName: "G. EVANS", expiresOn: "2031-05-26",
    columns: [{ code: "QL-01", confidence: "high", why: null }], holder: { person: "EVANS, Gareth", confidence: "high", why: "initial G", others: [] } }));
  await quiet(() => worker.scheduled({} as never, env as never));
  assert.equal(cellOf(portal, "EVANS, Brenton"), "", "nothing in Brenton's cell");
  assert.equal(cellOf(portal, "EVANS, Gareth"), "2031-05-26", "Gareth's");
  assert.equal(portal.rows.find((r) => r.id === "g")!.person, "EVANS, Gareth", "labelled his");
  assert.deepEqual(await roundNotes(portal, "read-as"), ["Master <500GT read as EVANS, Gareth's — check, and add \"G. EVANS\" to their names on Crew Details"]);
  assert.deepEqual((await certificateStanding()).dates.map((d) => d.person), ["EVANS, GARETH"], "and the page's cells agree");
});

test("a register page filed under another column's name fills only the register column the reader gave", async () => {
  /* The office named the page for QL-01, but a register page is evidence
     only for the register columns: the filename's QL-01 must not take a
     date from it, whatever the reader said - even a reading stored before
     the question held a register page to its register columns, which still
     lists QL-01. */
  const { portal, env } = await smartPortal([{ id: "reg", filename: "EVANS, Brenton - QL-01 Master.pdf",
    reading: { certificateTitle: "Cargo system approvals register", registerPage: true, qualCode: "CS-04", codeConfidence: "medium",
      columns: [{ code: "CS-04", confidence: "medium", why: "listed as an approved trainer" }, { code: "QL-01", confidence: "medium", why: "listed" }] } }]);
  await worker.scheduled({} as never, env as never);
  assert.equal(evansCell(portal, "CS-04"), "Y", "the register column the reader gave - held, since CS-04 never lapses");
  assert.notEqual(evansCell(portal, "QL-01"), "2031-05-26", "and never the column in its name");
  assert.deepEqual((await certificateStanding()).dates.map((d) => d.code), ["CS-04"], "the page's cells agree");

  /* Filed for CS-04 itself, but the reader gave CS-04 nothing: the filing
     alone does not make a register page evidence. */
  const bare = await smartPortal([{ id: "reg2", filename: "EVANS, Brenton - CS-04 Cargo System - Trainer - Practical.pdf",
    reading: { certificateTitle: "Cargo system approvals register", registerPage: true, qualCode: null, codeConfidence: null, columns: [] } }]);
  await worker.scheduled({} as never, bare.env as never);
  assert.equal(evansCell(bare.portal, "CS-04"), "", "the filed register column is not filled on the filing alone");
  assert.deepEqual((await certificateStanding()).dates, []);
});

test("a register page is never more than medium, and a guess about one is no evidence", async () => {
  /* A register page is a listing, not the certificate: the reader's "high"
     is kept as "medium", so the cell fills with the line for a look; its
     "low" leaves nothing, and the page is unreadable as such a page always
     was - the same answer as the reader listing nothing. */
  const { portal } = await unreadPortal(2);
  portal.rows.splice(portal.rows.findIndex((r) => r.id === "c2"), 1);
  const said: Record<string, string> = { "unread-1.pdf": "high", "unread-2.pdf": "low" };
  const model = modelAnswers((n) => {
    const name = (/Filename: ([^\n\\]+)/.exec(model.calls[n - 1]) || [])[1];
    return { status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans", registerPage: true,
      columns: [{ code: "CS-04", confidence: said[name], why: "listed on the register" }] }) };
  });
  try {
    await extract([["QL-01", "Master"], ["CS-04", "Cargo System - Trainer - Practical"]], 4);
  } finally {
    model.restore();
  }
  const one = JSON.parse(portal.blobs.get("certificate-readings|r1/unread-1.json")!);
  assert.deepEqual(one.columns, [{ code: "CS-04", confidence: "medium", why: "listed on the register" }], "high is held to medium");
  assert.equal(one.readable, true);
  const two = JSON.parse(portal.blobs.get("certificate-readings|r1/unread-2.json")!);
  assert.equal(two.readable, false, "a guess about a register page is no evidence");
  assert.deepEqual(two.columns, []);
});

test("the reader's doubt that somebody else could be the holder is kept, however it was written", async () => {
  const crew = [{ name: "EVANS, Brenton", aliases: [] }, { name: "SITTIYOS, Kachin", aliases: [] }];
  const people = crew;
  for (const others of [["EVANS, Gareth"], 3, [9], "somebody"] as unknown[]) {
    const holder = holderFrom({ person: 2, confidence: "high", why: "Bill is Kachin", others }, crew);
    assert.ok(holder && holder.others.length > 0, `kept: ${JSON.stringify(others)}`);
    assert.equal(readerPick("K. SITTIYOS", holder, people), null, `and the pick is no pick: ${JSON.stringify(others)}`);
  }
  // Nobody else, or only the pick itself, is no doubt.
  for (const others of [[], null, "", [2], ["SITTIYOS, Kachin"]] as unknown[]) {
    const holder = holderFrom({ person: 2, confidence: "high", why: "Kachin", others }, crew);
    assert.deepEqual(holder!.others, [], `no doubt: ${JSON.stringify(others)}`);
    // The pick stands - checked, K being his only by an initial.
    assert.deepEqual(readerPick("K. SITTIYOS", holder, people), { person: "SITTIYOS, Kachin", line: "check" });
  }
});

test("an MSIC card read with no expiry is looked at once more, first, and takes the expiry the second look reads", async () => {
  /* Every Australian MSIC prints its expiry as "FEB 30" - the last day of
     that month (Matthew, 26 Sep 2026). A card read before the question
     said so, with no expiry, is asked again once, ahead of the rest; the
     expiry the second look reads is the one date a second look may add. */
  const { portal, bucket } = await unreadPortal(0);
  const withBoxes = portal.doc();
  withBoxes.people = [{ id: "p1", name: "EVANS, Brenton", aliases: ["bRENTON"], msic: "MSIC 1", dob: "1980-01-01" }];
  portal.state.data = JSON.stringify(withBoxes);
  const old = (id: string, filename: string, r: Record<string, unknown>) => {
    portal.rows.push({ ...billysTicket, id, person: "EVANS, Brenton", folder: "brenton", checksum: id, blobKey: `opms/Brenton - OPMS/${filename}`, filename, sizeBytes: 6, qualCode: null });
    portal.blobs.set(`certificate-readings|r1/${id}.json`, JSON.stringify({ ...reading, holderName: "Brenton Evans", ...r }));
  };
  for (const name of ["msic.pdf", "dated-msic.pdf", "nocode.pdf"]) await bucket.put(`opms/Brenton - OPMS/${name}`, bytesOf("a scan"));
  // Read already for its columns, so nothing else would ask it again.
  const asked = { columns: [{ code: "VS-01", confidence: "high", why: "MSIC card" }], holder: null, endorsements: [], units: [], capacities: [] };
  old("msic", "msic.pdf", { certificateTitle: "Maritime Security Identification Card", qualCode: "VS-01", codeConfidence: "high", expiresOn: null, ...asked });
  old("dated", "dated-msic.pdf", { certificateTitle: "Maritime Security Identification Card", qualCode: "VS-01", codeConfidence: "high", expiresOn: "2029-05-31", ...asked });
  old("nocode", "nocode.pdf", { qualCode: null, codeConfidence: "low" });
  const model = modelAnswers(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans", certificateTitle: "Maritime Security Identification Card",
    qualCode: "VS-01", codeConfidence: "high", expiresOn: "2030-02-28", columns: [{ code: "VS-01", confidence: "high", why: "MSIC card" }], holder: { person: 1, confidence: "high", why: "name printed", others: [] } }) }));
  const codes: [string, string][] = [["QL-01", "Master"], ["VS-01", "Maritime Security Identification Card"]];
  const filenameOf = (call: string) => (/Filename: ([^\n\\]+)/.exec(call) || [])[1];
  try {
    const first = await topUpParticulars(codes, { cap: 1, timeLeft: () => true });
    assert.equal(first.read, 1);
    assert.deepEqual(model.calls.map(filenameOf), ["msic.pdf"], "the card with no expiry goes first, ahead of the columns queue");
    const topped = JSON.parse(portal.blobs.get("certificate-readings|r1/msic.json")!);
    assert.equal(topped.expiresOn, "2030-02-28", "the second look's expiry is taken where the first read none");
    assert.equal(topped.expiryAsked, true);
    await topUpParticulars(codes, { cap: 5, timeLeft: () => true });
    // Then the columns queue (nocode) and the back-fill of his own ticket's keys (master) - the card asked once, and the dated card never.
    assert.deepEqual(model.calls.map(filenameOf), ["msic.pdf", "nocode.pdf", "master.pdf"], "asked once, and the dated card never");
  } finally {
    model.restore();
  }
});

test("the readings made before the question asked for every column are read again once, a few an hour, the ones with no code first", async () => {
  /* 297 readable certificates on the live portal have no code: they go
     first, the files the slash bug once named "2.pdf" at the very front;
     then the ones whose filed column the reading disagrees with; then the
     rest. Twenty an hour at most, and once each: the new keys, or the mark
     a look that could not read the scan leaves, are all the memory there is. */
  const { portal, bucket } = await unreadPortal(0);
  // His boxes typed on Crew Details, so no look is paid for his particulars
  // and the queue here is the columns' alone.
  const withBoxes = portal.doc();
  withBoxes.people = [{ id: "p1", name: "EVANS, Brenton", aliases: ["bRENTON"], msic: "MSIC 1", dob: "1980-01-01" }];
  portal.state.data = JSON.stringify(withBoxes);
  const old = (id: string, filename: string, r: Record<string, unknown>) => {
    portal.rows.push({ ...billysTicket, id, person: "EVANS, Brenton", folder: "brenton", checksum: id, blobKey: `opms/Brenton - OPMS/${filename}`, filename, sizeBytes: 6, qualCode: null });
    portal.blobs.set(`certificate-readings|r1/${id}.json`, JSON.stringify({ ...reading, holderName: "Brenton Evans", ...r }));
  };
  for (const [id, name] of [["rest", "rest.pdf"], ["filed", "EVANS, Brenton - QL-17 Medical.pdf"], ["nocode", "nocode.pdf"], ["two", "2 (2).pdf"]]) {
    await bucket.put(`opms/Brenton - OPMS/${name}`, bytesOf("a scan"));
  }
  old("rest", "rest.pdf", { qualCode: "QL-01", codeConfidence: "high" });
  old("filed", "EVANS, Brenton - QL-17 Medical.pdf", { qualCode: "QL-01", codeConfidence: "high" });
  old("nocode", "nocode.pdf", { qualCode: null, codeConfidence: "low", expiresOn: "2030-01-01" });
  old("two", "2 (2).pdf", { qualCode: null, codeConfidence: "low" });
  // A loose scan in a name the register does not know: exactly what the
  // pick off the register is for, so it is looked at too.
  portal.rows.push({ ...billysTicket, id: "stranger", person: "Other", folder: "other", checksum: "stranger", blobKey: "opms/Other/stranger.pdf", filename: "stranger.pdf", sizeBytes: 6, qualCode: null });
  portal.blobs.set("certificate-readings|r1/stranger.json", JSON.stringify({ ...reading, holderName: "Bill" }));
  await bucket.put("opms/Other/stranger.pdf", bytesOf("a scan"));
  // Already asked the new question: never read again.
  old("asked", "asked.pdf", { columns: [{ code: "QL-01", confidence: "high", why: null }], holder: null, endorsements: [], units: [], capacities: [] });
  // Evans's own ticket (tagged QL-01) has an old reading too, in his own
  // name: the tag places it, so the columns queue does not pay for it; the
  // back-fill of a certificate of competency's keys still looks once.
  const model = modelAnswers((n) => {
    const asked = model.calls[n - 1];
    if (asked.includes("nocode.pdf")) return { status: 400, body: BAD_PDF_BODY };
    return { status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans", expiresOn: "2099-12-31",
      columns: [{ code: "QL-01", confidence: "medium", why: "a Master ticket" }], holder: { person: 1, confidence: "high", why: "name printed", others: [] } }) };
  });
  const codes: [string, string][] = [["QL-01", "Master"], ["QL-17", "Medical"]];
  const filenameOf = (call: string) => (/Filename: ([^\n\\]+)/.exec(call) || [])[1];
  try {
    // One an hour, so the order is the queue's and nothing else's.
    let read = 0;
    for (let hour = 0; hour < 6; hour++) read += (await topUpParticulars(codes, { cap: 1, timeLeft: () => true })).read;
    assert.deepEqual(model.calls.map(filenameOf), ["2 (2).pdf", "nocode.pdf", "EVANS, Brenton - QL-17 Medical.pdf", "rest.pdf", "stranger.pdf", "master.pdf"],
      "the once-misnamed file first, then no code, then the filing the reading disagrees with, then the rest, the loose scan included - and his own ticket, tagged by hand in his own name, only last, for the keys the back-fill asks of a certificate of competency: the tag alone places it, so the columns queue does not pay for it");
    assert.equal(read, 6, "one each");
    const capped = await topUpParticulars(codes, { cap: 20, timeLeft: () => true });
    assert.equal(capped.read, 0);
    assert.equal(model.calls.length, 6, "each read once, the one it could not read included, and the one already asked never");
  } finally {
    model.restore();
  }
  const two = JSON.parse(portal.blobs.get("certificate-readings|r1/two.json")!);
  assert.deepEqual(two.columns, [{ code: "QL-01", confidence: "medium", why: "a Master ticket" }], "the new keys are added");
  assert.equal(two.holder.person, "EVANS, Brenton", "whose it is, off the register");
  assert.equal(two.qualCode, null, "nothing the first look read is moved, its one code included");
  assert.equal(two.expiresOn, reading.expiresOn, "nor its date");
  assert.equal(codeFor({ filename: "2 (2).pdf" }, two, [], [["QL-01", "Master"]]), "QL-01", "the columns place it now, so the refile can name it");
  const nocode = JSON.parse(portal.blobs.get("certificate-readings|r1/nocode.json")!);
  assert.equal("columns" in nocode, false, "a look that could not read the scan adds no columns: the first reading stands");
  assert.equal(nocode.columnsAsked, true, "but it is marked, so it is not paid for again");
  assert.equal(nocode.expiresOn, "2030-01-01");
});

test("a second look never quietly takes away a column the first look placed, and a register page found on it fills nothing it is not evidence for", async () => {
  const { portal, bucket } = await unreadPortal(0);
  const withBoxes = portal.doc();
  withBoxes.people = [{ id: "p1", name: "EVANS, Brenton", aliases: ["bRENTON"], msic: "MSIC 1", dob: "1980-01-01" }];
  portal.state.data = JSON.stringify(withBoxes);
  portal.rows.splice(portal.rows.findIndex((r) => r.id === "c2"), 1);
  const old = async (id: string, filename: string, r: Record<string, unknown>) => {
    await bucket.put(`opms/Brenton - OPMS/${filename}`, bytesOf("a scan"));
    portal.rows.push({ ...billysTicket, id, person: "EVANS, Brenton", folder: "brenton", checksum: id, blobKey: `opms/Brenton - OPMS/${filename}`, filename, sizeBytes: 6, qualCode: null });
    portal.blobs.set(`certificate-readings|r1/${id}.json`, JSON.stringify({ ...reading, holderName: "Brenton Evans", ...r }));
  };
  // The first look was sure it is QL-01; the second calls that a guess.
  await old("sure", "scan.pdf", { qualCode: "QL-01", codeConfidence: "high" });
  // Filed for QL-01 and read as it the first time; the second look finds a register page.
  await old("reg", "EVANS, Brenton - QL-01 Master.pdf", { qualCode: "QL-01", codeConfidence: "high" });
  const model = modelAnswers((n) => {
    const asked = model.calls[n - 1];
    if (asked.includes("scan.pdf")) {
      return { status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans", columns: [{ code: "QL-01", confidence: "low", why: "unsure" }], holder: null }) };
    }
    return { status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans", registerPage: true,
      columns: [{ code: "QL-01", confidence: "medium", why: "listed on the register" }], holder: null }) };
  });
  const codes: [string, string][] = [["QL-01", "Master"], ["QL-17", "Medical"]];
  try {
    await topUpParticulars(codes, { cap: 20, timeLeft: () => true });
  } finally {
    model.restore();
  }
  assert.equal(model.calls.length, 2);
  const sure = JSON.parse(portal.blobs.get("certificate-readings|r1/sure.json")!);
  assert.deepEqual(sure.columns, [{ code: "QL-01", confidence: "medium", why: "read so the first time" }],
    "the first look's column is kept, as medium, so it stays filled and is shown for a look");
  const cols = portal.doc().quals.cols;
  assert.equal(codeFor({ filename: "scan.pdf" }, sure, [], cols), "QL-01", "still placed");
  const reg = JSON.parse(portal.blobs.get("certificate-readings|r1/reg.json")!);
  assert.equal(reg.registerPage, true, "the second look's register page is kept");
  assert.equal(codeFor({ filename: "EVANS, Brenton - QL-01 Master.pdf" }, reg, [], cols), null, "and it fills nothing, not even the column in its name");
  const page = await certificateStanding();
  assert.deepEqual(page.dates.map((d) => d.code), ["QL-01"], "the page's cells: the one kept column, from the first scan only");
  assert.deepEqual(page.placed.map((p) => placedLine("EVANS, Brenton", p.code, p.why)), ["EVANS, Brenton — QL-01: placed by the reading (read so the first time)"]);
});

test("a look for the columns that fails on the scan's own account is tried once more, and then not paid for again", async () => {
  const { portal, bucket } = await unreadPortal(0);
  const withBoxes = portal.doc();
  withBoxes.people = [{ id: "p1", name: "EVANS, Brenton", aliases: ["bRENTON"], msic: "MSIC 1", dob: "1980-01-01" }];
  portal.state.data = JSON.stringify(withBoxes);
  portal.rows.splice(portal.rows.findIndex((r) => r.id === "c2"), 1);
  await bucket.put("opms/Brenton - OPMS/garbled.pdf", bytesOf("a scan"));
  portal.rows.push({ ...billysTicket, id: "garbled", person: "EVANS, Brenton", folder: "brenton", checksum: "garbled", blobKey: "opms/Brenton - OPMS/garbled.pdf", filename: "garbled.pdf", sizeBytes: 6, qualCode: null });
  portal.blobs.set("certificate-readings|r1/garbled.json", JSON.stringify({ ...reading, holderName: "Brenton Evans", qualCode: null, codeConfidence: null }));
  // An answer that is not the JSON asked for.
  const model = modelAnswers(() => ({ status: 200, body:
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "I cannot help with that" } })}\n\n` +
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n` }));
  const codes: [string, string][] = [["QL-01", "Master"], ["QL-17", "Medical"]];
  const hours: number[] = [];
  try {
    for (let hour = 0; hour < 4; hour++) hours.push((await quiet(() => topUpParticulars(codes, { cap: 20, timeLeft: () => true }))).failed);
  } finally {
    model.restore();
  }
  assert.equal(model.calls.length, 2, "paid for twice at most");
  assert.deepEqual(hours, [1, 1, 0, 0]);
  const held = JSON.parse(portal.blobs.get("certificate-readings|r1/garbled.json")!);
  assert.equal(held.columnsAsked, true, "marked as asked");
  assert.equal("columns" in held, false, "and the first reading stands as it was");
});

test("on file, not on the matrix: a readable document with no column anywhere is listed, and nothing else is", async () => {
  /* 214 documents on the live portal name no column at all - MRN contractor
     inductions, psychosocial hazards, MHE quizzes - and the matrix has no
     column for them. Whether any becomes a column is the office's call;
     the list is so the call can be made. */
  const { portal } = await oneManPortal({ filedAs: "QL-04" });
  const scan = (id: string, filename: string, checksum: string) => ({
    ...billysTicket, id, person: "bRENTON", filename, checksum, qualCode: null, blobKey: `opms/Brenton - OPMS/${filename}`,
  });
  portal.rows.push(
    scan("hs", "MRN Marine Contractor HS.pdf", "hs"),
    scan("hrw", "licence.pdf", "hrw"),
    scan("blur", "blurry.pdf", "blur"),
    scan("quiz", "MHE quiz.pdf", "quiz"),
    scan("letter", "extension.pdf", "letter"),
    scan("his", "kachin.pdf", "his"),
    scan("unsure", "unsure.pdf", "unsure"),
  );
  const read = (over: Record<string, unknown>) => JSON.stringify({ ...reading, holderName: "Brenton Evans", qualCode: null, endorsements: [], units: [], capacities: [], ...over });
  portal.blobs.set("certificate-readings|r1/hs.json", read({ certificateTitle: "MRN Marine Contractor H&S", expiresOn: "2027-01-01" }));
  // A licence that covers a column of this matrix is on the matrix.
  portal.blobs.set("certificate-readings|r1/hrw.json", read({ certificateTitle: "Licence to Perform High Risk Work", expiresOn: "2030-04-01", units: ["DG"] }));
  portal.blobs.set("certificate-readings|r1/blur.json", JSON.stringify({ version: "r1", at: "", model: null, readable: false, reason: "too poor to read" }));
  // A letter with no code is a letter, not a certificate the matrix lacks a
  // column for; and a document printed in another man's name is not his.
  portal.blobs.set("certificate-readings|r1/letter.json", read({ certificateTitle: "Extension of certificate", evidenceKind: "extension", expiresOn: "2026-12-01" }));
  portal.blobs.set("certificate-readings|r1/his.json", read({ certificateTitle: "MinRes Psychosocial Hazards", holderName: "Kachin Sittiyos", expiresOn: "2027-06-01" }));
  // A code the reader gave but was not sure of fills no cell, and is still
  // the reader's answer that the paper is one of the matrix's items: the
  // round's business, not a document the matrix lacks a column for.
  portal.blobs.set("certificate-readings|r1/unsure.json", read({ certificateTitle: "Master", qualCode: "QL-01", codeConfidence: "low", expiresOn: "2029-01-01" }));
  // Unread: nothing to say yet.
  const doc = portal.doc();
  doc.quals.cols.push(["HR-01", "Dogging (DG)", "High risk work"]);
  doc.quals.rows[0][3].push("");
  portal.state.data = JSON.stringify(doc);
  const page = await certificateStanding();
  assert.deepEqual(page.notOnMatrix, [{ person: "EVANS, Brenton", title: "MRN Marine Contractor H&S", filename: "MRN Marine Contractor HS.pdf", fileId: "hs" }],
    "the induction alone: the filed QL-04 ticket, the covering licence, the unreadable scan, the unread quiz, the letter, the other man's document and the unsure reading are not on the list");
  assert.deepEqual(page.dates.map((d) => d.code).sort(), ["HR-01", "QL-04"], "and the unsure reading fills no cell either");
  // A reading with no printed title lists the file by its name.
  portal.blobs.set("certificate-readings|r1/hs.json", read({ certificateTitle: null, expiresOn: "2027-01-01" }));
  assert.deepEqual((await certificateStanding()).notOnMatrix.map((x) => x.title), ["MRN Marine Contractor HS.pdf"]);
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

test("a certificate gone from the library is cleared on the first round that finds it gone, and the workbook follows", async () => {
  /* Matthew, 26 Sep 2026: every hour, or when Update matrix is pressed -
     not the second hour. Evans's QL-17 was filled from a certificate that
     no longer claims it and was never seen as an orphan before. */
  const { portal } = await oneManPortal({ filledFromCert: { "EVANS, BRENTON::QL-17": true } });
  const out = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.equal(out.cleared, 1, "cleared on the first sighting");
  assert.equal(portal.doc().quals.rows[0][3][1], "", "the orphaned date is off the matrix");
  assert.equal(out.written, 2, "the workbook took the new date and the blank");
  // An old sightings note on the document is left as it is and read by nothing.
  const noted = await oneManPortal({ filledFromCert: { "EVANS, BRENTON::QL-17": true }, orphanSeen: { "EVANS, BRENTON::QL-17": "2026-09-24T02" } });
  const again = await runMatrixRound({ by: "the round on the hour", timeLeft: () => true, mirroredThisHour: 0 });
  assert.equal(again.cleared, 1);
  assert.deepEqual(noted.portal.doc().orphanSeen, { "EVANS, BRENTON::QL-17": "2026-09-24T02" }, "left as it was");
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

test("an upload for a column the person already holds a certificate for is asked about first, and Replace takes the old one off the books", async () => {
  /* Matthew, 26 Sep 2026: "if there is an old one in the folder in
     SharePoint, pop up a window warning the user, and give the option to
     delete the old one". Evans's folder holds master.pdf, tagged QL-01. */
  const { portal, bucket } = await oneManPortal();
  // His ticket sits in his own folder (the fixture's row keeps Billy's token).
  portal.rows.find((r) => r.id === "c2")!.folder = "brenton";
  const upload = (over: Record<string, string>, name = "EVANS, Brenton - QL-01 Master.pdf") => {
    const form = new FormData();
    // Each upload its own bytes, so only the column can be the clash.
    form.append("file", new File([bytesOf("the renewed ticket: " + name)], name, { type: "application/pdf" }));
    form.append("category", "certificate");
    form.append("person", "bRENTON");
    form.append("uploadedBy", "Matthew");
    Object.entries(over).forEach(([k, v]) => form.append(k, v));
    return files(new Request("http://portal/api/files", { method: "POST", body: form }));
  };
  // Tagged for the column the old one holds: asked, nothing written.
  const asked = await upload({ qualCode: "QL-01" });
  assert.equal(asked.status, 409);
  const said = (await asked.json()) as { duplicate: boolean; reason: string; column: { code: string; title: string } | null; existing: { filename: string; code: string | null; sameBytes: boolean }[] };
  assert.equal(said.duplicate, true, JSON.stringify(said));
  assert.equal(said.reason, "column", "not the same bytes, not the same name: the same column");
  assert.deepEqual(said.column, { code: "QL-01", title: "Master" });
  assert.deepEqual(said.existing.map((e) => [e.filename, e.code, e.sameBytes]), [["master.pdf", "QL-01", false]], "the old one, named");
  assert.equal(portal.rows.filter((r) => r.category === "certificate" && !r.removedAt).length, 1, "nothing filed yet");
  // The code in the file's name is a filing too, where nothing was picked.
  const byName = await upload({});
  assert.equal(byName.status, 409);
  assert.equal(((await byName.json()) as { reason: string }).reason, "column");
  // Another column, or a paper standing in for a certificate: no clash.
  const other = await upload({ qualCode: "QL-17" }, "medical.pdf");
  assert.equal(other.status, 201, await other.text());
  const paper = await upload({ qualCode: "QL-01", evidenceKind: "extension" }, "letter.pdf");
  assert.equal(paper.status, 201, await paper.text());
  // Replace: the old one comes off the books - kept, not destroyed - and the new one is filed.
  const replaced = await upload({ qualCode: "QL-01", onDuplicate: "replace" });
  assert.equal(replaced.status, 201, await replaced.text());
  const old = portal.rows.find((r) => r.id === "c2")!;
  assert.ok(old.removedAt, "the old certificate is taken off the books");
  assert.ok(String(old.blobKey).startsWith("removed/"), "its bytes are parked, not destroyed");
  const fresh = portal.rows.find((r) => r.category === "certificate" && !r.removedAt && r.qualCode === "QL-01" && String(r.filename).startsWith("EVANS, Brenton - QL-01"));
  assert.ok(fresh, "the renewed ticket is on the books under the column");
  assert.equal(bucket.text(String(fresh!.blobKey)), "the renewed ticket: EVANS, Brenton - QL-01 Master.pdf");
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
  // The weekly reminders look at their setting in the document once,
  // before the lease is tried (they take none): that one read, and
  // nothing else of the books, before or after the hour stood down.
  const books = portal.db.asked.slice(before).filter((a) => /portal_state|FROM documents/.test(a.sql));
  // The lease held, no take is ever written: its first look is the try.
  const firstTake = portal.db.asked.slice(before).findIndex((a) => /^SELECT value, etag FROM blobs/.test(a.sql) && a.args[1] === "round-lease");
  assert.deepEqual(books.map((a) => a.sql), ["SELECT data, rev FROM portal_state WHERE id = ?1"], "nothing was read or written past the lease");
  assert.ok(portal.db.asked.slice(before).indexOf(books[0]) < firstTake, "the reminders' look came before the lease was tried");
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).by, "Update portal", "the page's lease is untouched");
});

test("the hour is on the record, and the library's waits under its budget, before the sync asks the library anything", async () => {
  /* An invocation the platform cuts off inside the sync must still leave
     this hour's line. So at the sync's first read of the books the record
     is already written, saying the round has not run yet, and the driver's
     budget is already set to the hour's settling time. */
  const { portal, bucket } = await oneManPortal();
  const env = { DB: portal.db, FILES: bucket, FILE_STORE: "r2" };
  const seen: { record: unknown; budget: number; now: number } | { record: null } = { record: null };
  const restore = beforeStatement(portal.db, (sql) => /^select .+ from "documents"$/.test(sql), async () => {
    Object.assign(seen, { record: JSON.parse(portal.blobs.get("sync|last-hourly") || "null"), budget: graphBudget.until, now: Date.now() });
  });
  const tick = Date.now();
  try {
    await worker.scheduled({} as never, env as never);
  } finally {
    restore();
  }
  assert.ok(seen.record, "the sync's first read found the hour already on the record");
  const first = seen as { record: { roundSkipped: string; syncError: null; at: number }; budget: number; now: number };
  assert.equal(first.record.roundSkipped, "round not yet run");
  assert.equal(first.record.syncError, null);
  assert.ok(first.record.at >= tick, "this hour, not last hour's line");
  // Nine minutes from the lease less the two and a half the round keeps.
  assert.ok(first.budget >= first.now + 6 * 60 * 1000 && first.budget <= first.now + 6.5 * 60 * 1000, "the driver's budget is the hour's settling time: " + (first.budget - first.now));
  assert.equal(graphBudget.until, 0, "and cleared when the hour is done");
  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.applied, 1, "the hour went on to run the round");
  assert.equal(hourly.roundSkipped, null);
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
  assert.equal(ticket.namedByPortal, 1, "marked as the portal's own name, so its code is never read back as the office's filing");
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


test("a write into an existing folder goes to the folder by its id and makes nothing on the way", async () => {
  const graph = graphLibrary(new Set(["United Operations Team", "United Operations Team/Backups"]));
  try {
    setEnv(sharepointEnv() as never);
    const { fileStore } = await import("../src/files/store.js");
    const store = fileStore();
    const id = graph.idOf("United Operations Team/Backups");
    assert.deepEqual(await store.hasFolder("library/United Operations Team/Backups"), { id }, "the folder is there, by its id");
    assert.equal(await store.hasFolder("library/United Operations Team/Nowhere"), null, "…and this one is not");
    graph.calls.length = 0;

    // The folder is there: one PUT to its id, and no folder asked about or made.
    await store.set("library/United Operations Team/Backups/Crew Portal backup 2026-09-24.json", bytesOf("{}"), { intoFolderId: id });
    assert.deepEqual(graph.puts(), [`/v1.0/drives/d1/items/${id}:/Crew Portal backup 2026-09-24.json:/content`], "by the folder's id, never by a path the library could grow to fit");
    assert.deepEqual(graph.posts(), [], "no folder made");
    assert.deepEqual(graph.made, [], "not by the write either");
    assert.deepEqual(graph.calls.filter((c) => c.method === "GET"), [], "and none looked for");

    // An id the library never gave: the write is Graph's own 404, and still no folder.
    graph.calls.length = 0;
    await assert.rejects(
      store.set("library/United Operations Team/Nowhere/Crew Portal backup 2026-09-24.json", bytesOf("{}"), { intoFolderId: "nothing" }),
      /SharePoint write failed \(404\)/,
    );
    assert.deepEqual(graph.posts(), [], "no folder made");
    assert.deepEqual(graph.made, []);
    assert.equal(graph.puts().length, 1, "the one write, refused");
  } finally {
    graph.restore();
  }
});

test("a folder that goes between the look and the write: the write fails, and still no folder is made", async () => {
  const exists = new Set(["United Operations Team", "United Operations Team/Backups"]);
  const graph = graphLibrary(exists);
  try {
    setEnv(sharepointEnv() as never);
    const { fileStore } = await import("../src/files/store.js");
    const store = fileStore();
    const where = await store.hasFolder("library/United Operations Team/Backups");
    assert.ok(where);
    // Somebody in Teams deletes the folder in the instant between.
    exists.delete("United Operations Team/Backups");
    await assert.rejects(
      store.set("library/United Operations Team/Backups/Crew Portal backup 2026-09-24.json", bytesOf("{}"), { intoFolderId: where.id }),
      /SharePoint write failed \(404\)/,
    );
    assert.deepEqual(graph.posts(), [], "no folder made");
    assert.deepEqual(graph.made, [], "and the write, by id, could not grow one back");
    assert.equal(exists.has("United Operations Team/Backups"), false, "the library is as the person left it");
  } finally {
    graph.restore();
  }
});

test("the backup itself writes by the folder's id, so the library's own upload by path never gets the chance to make a folder", async () => {
  const exists = new Set(["United Operations Team", "United Operations Team/Backups"]);
  const graph = graphLibrary(exists);
  try {
    setEnv({ ...sharepointEnv(), DB: (await backupPortal()).portal.db, BACKUP_FOLDER, BACKUP_HOUR: "2", SHAREPOINT_FAUNA_FOLDER: "United Operations Team/Fauna" } as never);
    const rec = await nightlyBackup(TEN_PAST_TWO);
    assert.equal(rec?.error, null, rec?.error || "");
    assert.equal(rec?.day, "2026-09-24");
    assert.deepEqual(graph.puts(), [`/v1.0/drives/d1/items/${graph.idOf("United Operations Team/Backups")}:/Crew Portal backup 2026-09-24.json:/content`]);
    assert.deepEqual(graph.made, [], "no folder made by any road");
    assert.deepEqual(graph.posts(), []);

    // The folder gone before the next night: refused on the record, nothing made.
    exists.delete("United Operations Team/Backups");
    graph.calls.length = 0;
    const realError = console.error;
    console.error = () => {};
    let gone;
    try { gone = await nightlyBackup(TEN_PAST_TWO + 86_400_000); } finally { console.error = realError; }
    assert.equal(gone?.error, "the folder United Operations Team/Backups is not in the library");
    assert.equal(gone?.day, "2026-09-24", "the day stays the last that landed");
    assert.deepEqual(graph.puts(), [], "nothing written");
    assert.deepEqual(graph.made, []);
  } finally {
    graph.restore();
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
  assert.equal(late.asked.filter((a) => /ALTER TABLE/.test(a.sql)).length, 4, "all four columns were tried, and none stopped the request");
  forgetDocumentColumns();
});

/* ------------------------------------------------------------------------ *
 * Which qualification expiry sheet is the newer: the date on the front,
 * then the library's modified time, and never the alphabet.
 * ------------------------------------------------------------------------ */
/* ------------------------------------------------------------------------ *
 * The model's account, not the scan: a refusal about credit, the rate, a
 * busy model or the key stores nothing against the certificate, so it is
 * read the moment the account is in order. Only a document the model
 * turned away is written down as unreadable.
 * ------------------------------------------------------------------------ */

/** The model, answered by hand: every POST to /v1/messages gets what
 *  `answer` says for it, and is written down. */
function modelAnswers(answer: (n: number) => { status: number; body: string }) {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/v1/messages")) return realFetch(input, init);
    calls.push(String(init?.body || ""));
    const { status, body } = answer(calls.length);
    return new Response(body, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}
const apiError = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });
const CREDIT_BODY = apiError("invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");
const BAD_PDF_BODY = apiError("invalid_request_error", "messages.0.content.0.pdf.source.base64.data: The PDF specified was not valid.");
const RATE_BODY = apiError("rate_limit_error", "This request would exceed the rate limit of 50 requests per minute.");
/** A whole reading, streamed the way the model streams it. */
const readingStream = (reading: Record<string, unknown>) =>
  `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: JSON.stringify(reading) } })}\n\n` +
  `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`;

/** Evans's portal with `n` certificates on the books that have no reading
 *  yet, and the model switched on. */
const unreadPortal = async (n = 1, over: Parameters<typeof oneManPortal>[0] = {}) => {
  const made = await oneManPortal(over);
  for (let i = 1; i <= n; i++) {
    const key = `opms/Brenton - OPMS/unread-${i}.pdf`;
    await made.bucket.put(key, bytesOf("a scan nobody has read"));
    made.portal.rows.push({ ...billysTicket, id: `u${i}`, person: "EVANS, Brenton", checksum: `unread-${i}`, blobKey: key, filename: `unread-${i}.pdf`, sizeBytes: 22, qualCode: null });
  }
  made.bucket.made.length = 0;
  const env = { DB: made.portal.db, FILES: made.bucket, FILE_STORE: "r2", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://model.test" };
  setEnv(env as never);
  return { ...made, env };
};
const readingWrites = (db: { asked: Asked[] }) =>
  db.asked.filter((a) => /^INSERT INTO blobs/.test(a.sql) && a.args[0] === "certificate-readings");

test("out of credit: the batch stores nothing, and says why in one line", async () => {
  const { portal } = await unreadPortal(2);
  const model = modelAnswers(() => ({ status: 400, body: CREDIT_BODY }));
  try {
    const out = (await (await extract([["QL-01", "Master"]], 4)).json()) as { extracted: number; attempted: number; stopped: { kind: string; line: string } | null; failures: { error: string; kind: string }[] };
    assert.equal(out.attempted, 2);
    assert.equal(out.extracted, 0);
    assert.deepEqual(out.stopped, { kind: "credit", line: OUT_OF_CREDIT });
    assert.deepEqual(out.failures.map((f) => [f.kind, f.error]), [["credit", OUT_OF_CREDIT], ["credit", OUT_OF_CREDIT]]);
  } finally {
    model.restore();
  }
  assert.deepEqual(readingWrites(portal.db), [], "no reading was stored: the certificates queue again after a top-up");
});

test("a reading asks for the document's number and the holder's date of birth, and always carries both keys", async () => {
  // Three certificates: one printing both, one printing neither, one the
  // model turns away. Every reading made now has both keys, null where the
  // page has nothing, so a reading without them is one made before.
  const { portal } = await unreadPortal(3);
  const model = modelAnswers((n) => n === 3
    ? { status: 400, body: BAD_PDF_BODY }
    : { status: 200, body: readingStream(n === 1
      ? { ...reading, documentNumber: "  msic   01234 ", holderBirthDate: "1980-03-10T00:00:00" }
      : { ...reading, documentNumber: "", holderBirthDate: "10/03/1980" }) });
  try {
    await extract([["QL-01", "Master"]], 4);
  } finally {
    model.restore();
  }
  assert.ok(model.calls.every((c) => c.includes("documentNumber") && c.includes("holderBirthDate")), "the question asks for both");
  const stored = [1, 2, 3].map((i) => JSON.parse(portal.blobs.get(`certificate-readings|r1/unread-${i}.json`)!));
  const got = stored.map((r) => [r.readable, r.documentNumber, r.holderBirthDate]);
  // Which call answered which certificate is the batch's order, so sorted.
  assert.deepEqual(got.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [
    [false, null, null],
    [true, "msic   01234", "1980-03-10"],
    [true, null, null],
  ], "trimmed as printed, a date only as YYYY-MM-DD, and null where there is none");
  assert.ok(stored.every((r) => "documentNumber" in r && "holderBirthDate" in r), "every reading carries both keys");
  assert.equal(READING_VERSION, "r1", "no reading made before is thrown away");
});

test("a reading asks what else the certificate covers, whether it is a recognition, the medical's own dates and any cover standing in for a certificate", async () => {
  /* One question, every key, always present: a reading without a key is one
     made before it was asked for, and that is the only thing the hour's
     top-up has to go on. The lists are held to what a certificate can
     honestly print, and a printed limitation to twenty words. */
  const { portal } = await unreadPortal(2);
  const model = modelAnswers((n) => ({ status: 200, body: readingStream(n === 1
    ? { ...reading,
      endorsements: [
        { text: "  II/2 (incl. generic ECDIS)  ", until: null },
        "VI/2 (2) s. A-VI/2 (5-8)",
        { text: "VI/6 (1) s. A-VI/6 (4)", until: "26.05.2031" },
        { text: "", until: "2031-05-26" },
      ],
      units: ["HLTAID011", " hltaid011 ", "SITXFSA005"],
      capacities: ["  Master ", "GMDSS Radio Operator", "", 7],
      isRecognition: false, recognises: { authority: "AMSA", country: "India" },
      assessedOn: "2026-02-10", conditions: null, evidenceKind: "nonsense" }
    : { ...reading, certificateTitle: "Certificate of Recognition of GMDSS",
      endorsements: "not a list", units: null, capacities: "Master",
      isRecognition: true, recognises: { authority: "Directorate General of Shipping", country: "India", number: "IND-12345", expiresOn: "2029-10-07" },
      assessedOn: "not a date",
      conditions: "fit for particular duties only and must wear corrective lenses at all times while on watch and keep a spare pair aboard the vessel at sea",
      evidenceKind: "Issue-Letter" }) }));
  try {
    await extract([["QL-01", "Master"]], 4);
  } finally {
    model.restore();
  }
  const asked = model.calls[0];
  for (const key of ["endorsements", "units", "capacities", "isRecognition", "recognises", "assessedOn", "conditions", "evidenceKind"]) {
    assert.ok(asked.includes(key), "the question asks for " + key);
  }
  const first = JSON.parse(portal.blobs.get("certificate-readings|r1/unread-1.json")!);
  assert.deepEqual(first.endorsements, [
    { text: "II/2 (incl. generic ECDIS)", until: null },
    { text: "VI/2 (2) s. A-VI/2 (5-8)", until: null },
    { text: "VI/6 (1) s. A-VI/6 (4)", until: null },
  ], "trimmed as printed, a plain string still an endorsement, a date only as YYYY-MM-DD, and nothing for an empty line");
  assert.deepEqual(first.units, ["HLTAID011", "SITXFSA005"], "the same unit code twice is one code");
  assert.deepEqual(first.capacities, ["Master", "GMDSS Radio Operator"], "the capacities as printed, trimmed, and nothing for an empty line");
  assert.equal(first.recognises, null, "nothing said about a foreign certificate on a document that is not a recognition");
  assert.equal(first.assessedOn, "2026-02-10");
  assert.equal(first.evidenceKind, null, "a kind that is not one of the five is none");

  const second = JSON.parse(portal.blobs.get("certificate-readings|r1/unread-2.json")!);
  assert.deepEqual(second.endorsements, [], "an answer that is not a list is no endorsements");
  assert.deepEqual(second.units, []);
  assert.deepEqual(second.capacities, [], "and no capacities");
  assert.equal(second.isRecognition, true);
  assert.deepEqual(second.recognises, { authority: "Directorate General of Shipping", country: "India", number: "IND-12345", expiresOn: "2029-10-07" },
    "what the recognition prints about the certificate behind it");
  assert.equal(second.assessedOn, null);
  assert.equal(second.conditions!.split(" ").length, 20, "a printed limitation is kept to twenty words");
  // And to 200 characters, for an answer that came back as one unspaced
  // block: one word, and the whole page would go on the viewer.
  const third = { ...reading, conditions: "x".repeat(4000) };
  assert.equal(conditionsFrom(third.conditions)!.length, 200, "and to two hundred characters, however few words it is");
  assert.equal(second.evidenceKind, "issue-letter", "however the model cased it");
  for (const r of [first, second]) {
    for (const key of ["endorsements", "units", "capacities", "isRecognition", "recognises", "assessedOn", "conditions", "evidenceKind"]) {
      assert.ok(key in r, key + " is on every reading made now");
    }
  }
  assert.equal(READING_VERSION, "r1", "and no reading made before is thrown away for them");
});

test("the question asks for every column the document is evidence for, with the office's equivalences and its filed column", async () => {
  /* The old question asked for one code and told the model to give none
     where two could fit, so 297 readable certificates on the live portal
     came back with no code at all. Now it lists every column it sees, each
     with how sure it is and why, and weighs the column the office filed the
     document under. The old code is kept, from the first sure-or-by-a-level
     column, for everything that still reads it. */
  const { portal } = await unreadPortal(3);
  const u1 = portal.rows.find((r) => r.id === "u1")!;
  u1.filename = "EVANS, Brenton - VS-04 Helm CONNECT.pdf";
  portal.blobs.set("matrix-readings|equivalences.json", JSON.stringify({ rows: [{ held: "Master <500GT", code: "QL-03" }, { held: "Something off the list", code: "QL-99" }] }));
  const codes: [string, string][] = [["QL-01", "Master"], ["QL-03", "Master <100m NC"], ["QL-17", "Medical"], ["VS-04", "Helm CONNECT"]];
  const model = modelAnswers((n) => {
    const asked = model.calls[n - 1];
    if (asked.includes("Helm CONNECT.pdf")) {
      return { status: 200, body: readingStream({ ...reading, qualCode: undefined, codeConfidence: undefined, certificateTitle: "Crew Intermediate - Helm CONNECT",
        columns: [
          { code: "vs-04", confidence: "medium", why: "Crew Intermediate is a higher level of the course the office filed this under, so it satisfies the lower one" },
          { code: "QL-99", confidence: "high", why: "not a column" },
          { code: "QL-01", confidence: "sure", why: "a guess" },
          { code: "VS-04", confidence: "low", why: "the same column again, less sure" },
        ] }) };
    }
    if (asked.includes("unread-2.pdf")) {
      // The old shape, one code: still read, as that one column.
      return { status: 200, body: readingStream({ ...reading, qualCode: "QL-01", codeConfidence: "high" }) };
    }
    // A register page filed for a column no register stands for.
    return { status: 200, body: readingStream({ ...reading, qualCode: undefined, codeConfidence: undefined, registerPage: true, columns: [{ code: "QL-01", confidence: "medium", why: "listed on the register" }] }) };
  });
  try {
    await extract(codes, 4);
  } finally {
    model.restore();
  }
  const helm = model.calls.find((c) => c.includes("Helm CONNECT.pdf"))!;
  assert.ok(helm.includes("columns") && helm.includes("confidence") && helm.includes("registerPage"), "the question asks for the columns and whether it is a register page");
  assert.ok(!helm.includes('"qualCode"'), "and no longer for one code");
  assert.ok(helm.includes("Master <500GT counts as QL-03"), "the office's Equivalence sheet goes in, one line a column");
  assert.ok(!helm.includes("Something off the list"), "only for columns on the matrix");
  assert.ok(helm.includes("Filed under column: VS-04"), "the column the office filed it under");
  assert.ok(!model.calls.find((c) => c.includes("unread-2.pdf"))!.includes("Filed under column"), "and none where the name files it under nothing");
  assert.ok(!helm.includes(vessel.covers[0].when), "the vessel file's covers rows are not given: they are applied by rule after");

  const read = (id: string) => JSON.parse(portal.blobs.get(`certificate-readings|r1/${id}.json`)!);
  const first = read("unread-1");
  assert.deepEqual(first.columns, [
    { code: "VS-04", confidence: "medium", why: "Crew Intermediate is a higher level of the course the office filed this under, so" },
    { code: "QL-01", confidence: "low", why: "a guess" },
  ], "only the matrix's codes, as it writes them; an unknown confidence is a guess; the reason held to fifteen words; a code given twice kept at the surer");
  assert.equal(first.qualCode, "VS-04", "the old code from the first column held by a level or better");
  assert.equal(first.codeConfidence, "medium");

  const second = read("unread-2");
  assert.deepEqual(second.columns, [{ code: "QL-01", confidence: "high", why: null }], "an answer in the old shape is one column");
  assert.equal(second.qualCode, "QL-01");

  const third = read("unread-3");
  assert.equal(third.readable, false, "a register page filed for a column no register stands for is not a certificate");
  assert.equal(third.reason, "A register page or listing, not a certificate.");
  assert.deepEqual(third.columns, []);
  assert.equal(third.qualCode, null);
});

test("a PDF the model turns away is stored as unreadable, with the plain reason, and stops nothing", async () => {
  const { portal } = await unreadPortal(1);
  const model = modelAnswers(() => ({ status: 400, body: BAD_PDF_BODY }));
  try {
    const out = (await (await extract([["QL-01", "Master"]], 4)).json()) as { extracted: number; stopped: unknown; failures: unknown[] };
    assert.equal(out.extracted, 1, "an unreadable reading counts as read: the batch moves on");
    assert.equal(out.stopped, null);
    assert.deepEqual(out.failures, []);
  } finally {
    model.restore();
  }
  assert.equal(readingWrites(portal.db).length, 1, "one reading stored");
  const stored = JSON.parse(portal.blobs.get("certificate-readings|r1/unread-1.json")!);
  assert.equal(stored.readable, false);
  assert.match(stored.reason, /^The model turned this file away: The PDF specified was not valid\./, "the field prefix is off the reason");
});

test("a paper that stands in for a certificate is readable, and the question says so", async () => {
  /* The question used to tell the model that a document which "is not a
     certificate" is unreadable, and three rules later asked it which of the
     five papers a non-certificate is. A model that followed the first rule
     marked every letter unreadable and no evidenceKind ever fired. */
  const { portal } = await unreadPortal(1);
  const model = modelAnswers(() => ({ status: 200, body: readingStream({ ...reading, qualCode: null,
    certificateTitle: "Extension of certificate of competency", evidenceKind: "extension", expiresOn: "2026-11-25" }) }));
  try {
    await extract([["QL-01", "Master"]], 4);
  } finally {
    model.restore();
  }
  const stored = JSON.parse(portal.blobs.get("certificate-readings|r1/unread-1.json")!);
  assert.equal(stored.readable, true, "a paper answered readable is stored readable");
  assert.equal(stored.evidenceKind, "extension", "and carries its kind");
  // The question itself, as it went to the model (the body is JSON, so its
  // newlines are escaped).
  const asked = model.calls[0].replace(/\\n/g, " ").replace(/\s+/g, " ");
  assert.ok(!/is not a certificate, or is a certificate for something not on the list/.test(asked),
    "the old rule, which made every paper unreadable, is gone");
  assert.ok(/one of the five papers/.test(asked), "the five papers are named as readable");
  assert.ok(/for something not on the list is readable/.test(asked), "a certificate the matrix has no column for is still read");
  assert.ok(/each class code alone/.test(asked), "the licence classes are asked for one per entry, the code alone");
});

test("a licence with no column of its own takes the date typed against it, in the round and on the page alike", async () => {
  /* A high risk work licence is no one column: its DG class fills HR-01 by
     the covers table. It used to be dated from the reading alone, so the
     expiry the person typed at upload - which beats the reading for every
     certificate with a column of its own - was ignored for the licence. */
  const people = [{ name: "EVANS, Brenton", aliases: ["bRENTON"] }];
  const quals = { cols: [["HR-01", "Dogging (DG)", "High risk work"]] as [string, string, string][],
    rows: [["EVANS, Brenton", "Master", "", [""]]] as [string, string, string, string[]][] };
  const licence: Record<string, unknown> = { ...billysTicket, id: "hrw", person: "bRENTON", filename: "licence.pdf", qualCode: null, expiresOn: "2030-04-01", checksum: "hrw" };
  const read = { ...reading, holderName: "Brenton Evans", certificateTitle: "Licence to Perform High Risk Work",
    qualCode: null, expiresOn: "2029-01-01", units: ["DG"], endorsements: [], capacities: [] };
  const portal = portalDb({ quals, people }, [licence], { "r1/hrw.json": read });
  setEnv({ DB: portal.db, FILE_STORE: "r2" } as never);
  const out = await compareMatrix(quals, null, asKnownPerson(people));
  assert.deepEqual(out.settled, [{ person: "EVANS, Brenton", code: "HR-01", value: "2030-04-01" }], "the round takes the typed date");
  const page = await certificateStanding();
  assert.deepEqual(page.dates.map((d) => [d.code, d.expires, d.covered]), [["HR-01", "2030-04-01", true]], "and so do the page's cells");
  // Nothing typed: the reading's date, as before.
  licence.expiresOn = null;
  const plain = await compareMatrix(quals, null, asKnownPerson(people));
  assert.deepEqual(plain.settled, [{ person: "EVANS, Brenton", code: "HR-01", value: "2029-01-01" }]);
  assert.deepEqual((await certificateStanding()).dates.map((d) => d.expires), ["2029-01-01"]);
});

test("a paper filed by hand carries its kind and the column it is about, on the row and in the listing", async () => {
  /* After a hand tag makes a document the certificate, a paper had to be
     uploaded untagged, so which column a letter was about rested on the
     model's guess alone. The upload page's picker now says what paper it
     is; the row keeps the kind beside the column, and the listing hands
     both back. */
  const { portal } = await oneManPortal();
  const patch = (id: string, edit: Record<string, unknown>) => fileRoute(
    new Request(`http://portal/api/files/${id}?admin=1`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ edit }) }),
    { params: { id } },
  );
  const res = await patch("c2", { qualCode: "QL-01", evidenceKind: "extension" });
  assert.equal(res.status, 200, await res.clone().text());
  const said = (await res.json()) as { qualCode: string | null; evidenceKind: string | null };
  assert.equal(said.qualCode, "QL-01");
  assert.equal(said.evidenceKind, "extension", "the answer carries the kind");
  const row = portal.rows.find((r) => r.id === "c2")!;
  assert.equal(row.evidenceKind, "extension", "the row keeps it");

  assert.equal((toRecord(row as never) as { evidenceKind?: string | null }).evidenceKind, "extension", "the listing's record hands it to the page");

  const bad = await patch("c2", { evidenceKind: "letter-from-a-mate" });
  assert.equal(bad.status, 400, "a kind that is not one of the five is refused");
  assert.equal(portal.rows.find((r) => r.id === "c2")!.evidenceKind, "extension", "and nothing changed");

  const cleared = await patch("c2", { evidenceKind: "" });
  assert.equal(cleared.status, 200);
  assert.equal(portal.rows.find((r) => r.id === "c2")!.evidenceKind, null, "an empty choice is the certificate again");
});

test("over the rate: the batch stores nothing and says the reading is unavailable", async () => {
  const { portal } = await unreadPortal(1);
  const model = modelAnswers(() => ({ status: 429, body: RATE_BODY }));
  try {
    const out = (await (await extract([["QL-01", "Master"]], 4)).json()) as { extracted: number; stopped: unknown };
    assert.equal(out.extracted, 0);
    assert.deepEqual(out.stopped, { kind: "rate", line: READING_UNAVAILABLE });
  } finally {
    model.restore();
  }
  assert.deepEqual(readingWrites(portal.db), [], "nothing stored");
});

test("a 400 about the portal's own request, or one the portal cannot read, stores nothing and stops nothing", async () => {
  // The API refusing a parameter the portal sends is a fact about the
  // request, not the scan: the certificate stays unread and is tried
  // again once the request is right, rather than written down as turned
  // away and needing a paid re-read to undo.
  const rejected = await unreadPortal(1);
  const parameter = modelAnswers(() => ({ status: 400, body: apiError("invalid_request_error", "thinking.type: adaptive is not supported on this model") }));
  try {
    const out = (await (await extract([["QL-01", "Master"]], 4)).json()) as { extracted: number; stopped: unknown; failures: { kind: string }[] };
    assert.equal(out.extracted, 0);
    assert.equal(out.stopped, null);
    assert.deepEqual(out.failures.map((f) => f.kind), ["other"]);
  } finally {
    parameter.restore();
  }
  assert.deepEqual(readingWrites(rejected.portal.db), [], "nothing stored: the certificate queues again");

  const unreadable = await unreadPortal(1);
  const html = modelAnswers(() => ({ status: 400, body: "<html><body>Bad Request</body></html>" }));
  try {
    const out = (await (await extract([["QL-01", "Master"]], 4)).json()) as { extracted: number; stopped: unknown; failures: { kind: string }[] };
    assert.equal(out.extracted, 0);
    assert.equal(out.stopped, null);
    assert.deepEqual(out.failures.map((f) => f.kind), ["other"]);
  } finally {
    html.restore();
  }
  assert.deepEqual(readingWrites(unreadable.portal.db), [], "nothing stored for an answer the portal cannot read");
});

/** A stream the model cut with an error event, after `before` of an answer. */
const cutStream = (type: string, before = "") =>
  (before ? `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: before } })}\n\n` : "") +
  `data: ${JSON.stringify({ type: "error", error: { type, message: type } })}\n\n`;

test("an error on the stream itself is sorted like a status, and a reading it cut is no reading", async () => {
  // Nothing had come: overloaded on the stream is the model busy.
  const empty = await unreadPortal(1);
  const busy = modelAnswers(() => ({ status: 200, body: cutStream("overloaded_error") }));
  try {
    const out = (await (await extract([["QL-01", "Master"]], 4)).json()) as { extracted: number; stopped: unknown; failures: { kind: string }[] };
    assert.equal(out.extracted, 0);
    assert.deepEqual(out.stopped, { kind: "busy", line: READING_UNAVAILABLE });
  } finally {
    busy.restore();
  }
  assert.deepEqual(readingWrites(empty.portal.db), [], "nothing stored");

  // Half a reading had come, then the rate: what came is not a reading of
  // the certificate, and is not stored as one.
  const cut = await unreadPortal(1);
  const rate = modelAnswers(() => ({ status: 200, body: cutStream("rate_limit_error", '{"holderName":"Brenton Evans","certificateTitle":"Master') }));
  try {
    const out = (await (await extract([["QL-01", "Master"]], 4)).json()) as { extracted: number; stopped: unknown; failures: { kind: string }[] };
    assert.equal(out.extracted, 0);
    assert.deepEqual(out.stopped, { kind: "rate", line: READING_UNAVAILABLE });
    assert.deepEqual(out.failures.map((f) => f.kind), ["rate"]);
  } finally {
    rate.restore();
  }
  assert.deepEqual(readingWrites(cut.portal.db), [], "the half reading was not stored");

  // The account, on the stream: the hour can see it and stop.
  const account = await unreadPortal(1);
  const key = modelAnswers(() => ({ status: 200, body: cutStream("authentication_error") }));
  try {
    const out = (await (await extract([["QL-01", "Master"]], 4)).json()) as { stopped: { kind: string } | null };
    assert.equal(out.stopped?.kind, "key");
  } finally {
    key.restore();
  }
  assert.deepEqual(readingWrites(account.portal.db), []);
});

/** Evans's portal with both matrices on file and the model switched on,
 *  for the long readers. */
const matrixPortal = async () => {
  const made = await oneManPortal({ skills: true });
  setEnv({ DB: made.portal.db, FILES: made.bucket, FILE_STORE: "r2", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://model.test" } as never);
  return made;
};
// Half a training matrix reading: one person finished, the next key begun.
const HALF_A_READING = '{"people":[{"name":"Brenton Evans","problems":[]}],"no';

test("a long reading the model cut partway keeps what came, and says it was cut short; a certificate cut the same way is no reading", async () => {
  // The training matrix: the model overloaded on the stream after half an
  // answer. What was finished is kept, with the note over it, as it was
  // before refusals on the stream were sorted like a status.
  const { portal } = await matrixPortal();
  const busy = modelAnswers(() => ({ status: 200, body: cutStream("overloaded_error", HALF_A_READING) }));
  try {
    const out = (await readMatrixOnce("training", "Name | QL-01\nEVANS, Brenton | 2030-01-17", true)) as { cached: boolean; reading: { people?: unknown[]; notes?: string[] } };
    assert.equal(out.cached, false);
    assert.deepEqual(out.reading.people, [{ name: "Brenton Evans", problems: [] }], "what was finished before the cut is kept");
    assert.match(String(out.reading.notes?.[0]), /cut short/, "and the reading says so");
  } finally {
    busy.restore();
  }
  assert.ok(portal.blobs.has("matrix-readings|m2/training-tm1.json"), "held like any other reading");

  // The same stream put to a certificate: nothing is stored.
  const cut = await unreadPortal(1);
  const again = modelAnswers(() => ({ status: 200, body: cutStream("overloaded_error", HALF_A_READING) }));
  try {
    const out = (await (await extract([["QL-01", "Master"]], 4)).json()) as { extracted: number; stopped: unknown };
    assert.equal(out.extracted, 0);
    assert.deepEqual(out.stopped, { kind: "busy", line: READING_UNAVAILABLE });
  } finally {
    again.restore();
  }
  assert.deepEqual(readingWrites(cut.portal.db), [], "a certificate reading cut by the model is no reading");
});

test("a matrix reading refused for credit finishes its job with the one out-of-credit line", async () => {
  await matrixPortal();
  const model = modelAnswers(() => ({ status: 400, body: CREDIT_BODY }));
  try {
    const job = await startMatrixReadJob({ which: "training", text: "Name | QL-01", force: true });
    await runMatrixReadJob(job.id);
    const done = await readMatrixReadJob(job.id);
    assert.equal(done?.state, "error");
    assert.equal(done?.error, OUT_OF_CREDIT, "the shared sentence, not the API's JSON");
  } finally {
    model.restore();
  }
});

test("a spend limit that wears a 429 is not asked again: the hour makes one call a certificate and stops", async () => {
  const { portal, env } = await unreadPortal(2);
  const model = modelAnswers(() => ({ status: 429, body: apiError("rate_limit_error", "You have reached your monthly spend limit.") }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    model.restore();
  }
  assert.equal(model.calls.length, 2, "one call for each of the two, and no retry after the account said no");
  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.readError, OUT_OF_CREDIT);
  assert.deepEqual(readingWrites(portal.db), [], "nothing stored");
});

test("the hour stops reading on the first credit answer, says so in red, and still runs the round", async () => {
  const { portal, env } = await unreadPortal(2);
  const model = modelAnswers(() => ({ status: 400, body: CREDIT_BODY }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    model.restore();
  }
  assert.equal(model.calls.length, 2, "one batch of two, and not another call after the answer");
  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.readError, OUT_OF_CREDIT);
  assert.equal(hourly.readStopped, null);
  assert.equal(hourly.read, 0);
  assert.equal(hourly.applied, 1, "the round still ran on what had been read before");
  assert.equal(hourly.roundError, null);
  assert.deepEqual(readingWrites(portal.db), [], "nothing stored against the certificates");
  assert.equal(portal.blobs.has("sync|credit"), false, "nothing kept about the credit between hours");

  // Topped up: the next hour reads both with nothing reset, and the line is gone.
  // The new readings print his date of birth, so his older Master ticket is
  // not read again for that - but it was read before the endorsements were
  // asked for, and it is a certificate of competency, so the back-fill looks
  // at it once. Three calls: the two certificates, and his ticket.
  const answers = modelAnswers(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans", certificateTitle: "Master <500GT", expiresOn: "2032-01-01", holderBirthDate: "1980-03-10" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    answers.restore();
  }
  assert.equal(answers.calls.length, 3, "the two unread certificates were put to the model, and his ticket once for the keys it is missing");
  const next = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(next.readError, null);
  assert.equal(next.readTried, true, "the hour says it read");
  assert.equal(next.read, 2);
  assert.equal(readingWrites(portal.db).length, 3, "their readings are stored now, and his ticket's is written back with the keys it was missing");
});

test("a busy model stops the hour's reading as an aside, not an error, and the next hour reads as normal", async () => {
  const { portal, env } = await unreadPortal(1);
  const busy = modelAnswers(() => ({ status: 529, body: apiError("overloaded_error", "Overloaded") }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    busy.restore();
  }
  let hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.readStopped, READING_UNAVAILABLE);
  assert.equal(hourly.readError, null);
  assert.equal(hourly.read, 0);
  assert.equal(hourly.applied, 1, "the round ran");
  assert.deepEqual(readingWrites(portal.db), [], "nothing stored");

  // Next hour the model answers: the certificate is read with no reset,
  // and the line is gone from the record.
  // The new reading prints his date of birth, so his older Master ticket is
  // not read again for that - only once, by the back-fill, for the keys it
  // was read before the question asked for.
  const answers = modelAnswers(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans", certificateTitle: "Master <500GT", expiresOn: "2032-01-01", holderBirthDate: "1980-03-10" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    answers.restore();
  }
  assert.equal(answers.calls.length, 2, "the one unread certificate, and his ticket once for the keys it is missing");
  hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.readError, null);
  assert.equal(hourly.readStopped, null);
  assert.equal(hourly.read, 1);
  assert.equal(readingWrites(portal.db).length, 2, "its reading is stored now, and his ticket's is written back with the keys it was missing");
});

const readOneNow = (id: string, discardUnreadable: boolean) => readOne(
  new Request("http://portal/api/certificates/read-one", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, discardUnreadable }) }),
);

test("a phone photo met by an empty account stays on the books, and the phone hears the one line", async () => {
  const { portal, bucket } = await unreadPortal(1);
  const model = modelAnswers(() => ({ status: 400, body: CREDIT_BODY }));
  try {
    const res = await readOneNow("u1", true);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: OUT_OF_CREDIT, kind: "credit" });
  } finally {
    model.restore();
  }
  assert.deepEqual(readingWrites(portal.db), [], "no reading stored");
  const row = portal.rows.find((r) => r.id === "u1")!;
  assert.equal(row.removedAt, null, "not discarded: the photo is read on the hour once there is credit");
  assert.equal(bucket.text("opms/Brenton - OPMS/unread-1.pdf"), "a scan nobody has read", "and the file is where it was");
});

test("a phone photo the model cannot read is still taken off again when the phone asked for that", async () => {
  const { portal, bucket } = await unreadPortal(1);
  const model = modelAnswers(() => ({ status: 400, body: BAD_PDF_BODY }));
  try {
    const res = await quiet(() => readOneNow("u1", true));
    const said = await res.text();
    assert.equal(res.status, 200, said);
    const out = JSON.parse(said) as { discarded: boolean; readable: boolean };
    assert.equal(out.discarded, true);
    assert.equal(out.readable, false);
  } finally {
    model.restore();
  }
  const row = portal.rows.find((r) => r.id === "u1")!;
  assert.ok(row.removedAt, "off the books");
  assert.equal(row.removedBy, "not clear — retake");
  assert.equal(bucket.text("opms/Brenton - OPMS/unread-1.pdf"), null, "the photo is parked, not left live");
  assert.deepEqual(bucket.made, [], "no folder was made");
});

/* ------------------------------------------------------------------------ *
 * The nightly backup's rules: the vessel's clock decides the day, a backup is owed once
 * a day after the hour, the file is named for its day, a month of dailies
 * and a year of monthlies are kept by name alone, and a folder the portal
 * files into is refused.
 * ------------------------------------------------------------------------ */
test("the vessel's clock decides the backup's day and hour", () => {
  // The vessel file says Australia/Perth, eight hours ahead of UTC.
  assert.equal(vessel.timezone, "Australia/Perth");
  assert.deepEqual(vesselNow(Date.parse("2026-09-24T15:59:00Z")), { day: "2026-09-24", hour: 23, weekday: 4 });
  assert.deepEqual(vesselNow(Date.parse("2026-09-24T16:00:00Z")), { day: "2026-09-25", hour: 0, weekday: 5 });
  assert.deepEqual(vesselNow(Date.parse("2026-09-23T18:10:00Z")), { day: "2026-09-24", hour: 2, weekday: 4 }, "ten past two in the morning where the vessel is");
});

test("a backup is owed after the hour, once a day, and again every hour until it lands", () => {
  const two = { day: "2026-09-24", hour: 2 };
  assert.equal(backupDue(null, two, 2), true, "never backed up: due at 02:10");
  assert.equal(backupDue(null, { day: "2026-09-24", hour: 1 }, 2), false, "not at 01:10");
  assert.equal(backupDue({ day: "2026-09-23" }, two, 2), true, "yesterday's on the record: due");
  assert.equal(backupDue({ day: "2026-09-24" }, two, 2), false, "today's on the record: not again");
  assert.equal(backupDue({ day: "2026-09-24" }, { day: "2026-09-24", hour: 14 }, 2), false, "…nor later in the day");
  assert.equal(backupDue({ day: null, error: "the library refused the write" } as never, two, 2), true, "a record with an error and no day is one that never landed: due");
  assert.equal(backupDue({ day: "2026-09-23", error: "the library refused the write" } as never, { day: "2026-09-24", hour: 3 }, 2), true, "…and so is one whose day is yesterday's");
});

test("the backup is named for its day", () => {
  assert.equal(backupName("2026-09-24"), "Crew Portal backup 2026-09-24.json");
});

test("a month of dailies and a year of monthlies are kept, by name and never by listing", () => {
  const n = (d: string) => `Crew Portal backup ${d}.json`;
  assert.deepEqual(namesToDrop("2026-10-01"), [
    n("2026-08-31"), n("2026-08-30"), n("2026-08-29"), n("2026-08-28"), n("2026-08-27"), n("2026-08-26"), n("2026-08-25"),
    n("2025-09-01"),
  ], "seven dailies from 31 to 37 days back, and the monthly 13 months back");
  assert.deepEqual(namesToDrop("2026-10-31"), [
    n("2026-09-30"), n("2026-09-29"), n("2026-09-28"), n("2026-09-27"), n("2026-09-26"), n("2026-09-25"), n("2026-09-24"),
    n("2025-09-01"),
  ]);
  assert.deepEqual(namesToDrop("2026-10-02"), [
    n("2026-08-31"), n("2026-08-30"), n("2026-08-29"), n("2026-08-28"), n("2026-08-27"), n("2026-08-26"),
    n("2025-09-01"),
  ], "31 days back is the first of September: that one stays as the month's");
  assert.deepEqual(namesToDrop("2026-01-15"), [
    n("2025-12-15"), n("2025-12-14"), n("2025-12-13"), n("2025-12-12"), n("2025-12-11"), n("2025-12-10"), n("2025-12-09"),
    n("2024-12-01"),
  ], "across a year end");
});

test("a folder the portal files into is refused, against the real map in wrangler.toml", () => {
  const toml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "wrangler.toml"), "utf8");
  const setting = (name: string) => /"([^"]*)"/.exec(toml.split("\n").find((l) => l.startsWith(name + " = "))!)![1];
  const env = {
    SHAREPOINT_MAP: /SHAREPOINT_MAP = """([\s\S]*?)"""/.exec(toml)![1],
    SHAREPOINT_FAUNA_FOLDER: setting("SHAREPOINT_FAUNA_FOLDER"),
    SHAREPOINT_ROOT: setting("SHAREPOINT_ROOT"),
  };
  assert.equal(setting("BACKUP_FOLDER"), "", "ships empty: the owner names the folder");
  assert.equal(setting("BACKUP_HOUR"), "2");
  assert.deepEqual(folderAllowed("United Operations Team/Backups", env), { ok: true });
  assert.deepEqual(folderAllowed("/United Operations Team/Backups/", env), { ok: true }, "slashes either end are nothing");
  const refused = (folder: string, because: RegExp) => {
    const said = folderAllowed(folder, env);
    assert.equal(said.ok, false, folder + " should be refused");
    assert.match((said as { reason: string }).reason, /is one the portal files into/);
    assert.match((said as { reason: string }).reason, because);
  };
  refused("United Operations Team/Crew Certificate Verifications", /Crew Certificate Verifications/);
  refused("United Operations Team/Crew Certificate Verifications/Backups", /Crew Certificate Verifications/);
  refused("United Operations Team/OPMS Documents/Backups", /OPMS Documents/);
  refused("United Operations Team/Crew Portal/Matrix", /Matrix/);
  refused("United Operations Team/Handover Notes", /Handover Notes/);
  refused("United Operations Team/Fauna", /Fauna/);
  refused("united operations team/fauna/backups", /Fauna/);
  refused("United Operations Team/Crew Portal/Backups", /Crew Portal/);
  // What Crew Details points at joins the list: the certificate home and a man's own folder.
  const alsoFiled = ["United Operations Team/Somewhere Else", "United Operations Team/Certs/Kyle"];
  assert.equal(folderAllowed("United Operations Team/Somewhere Else/Backups", env, alsoFiled).ok, false);
  assert.equal(folderAllowed("United Operations Team/Certs/Kyle", env, alsoFiled).ok, false);
  assert.equal(folderAllowed("United Operations Team/Certs/Backups", env, alsoFiled).ok, true, "beside a man's folder is fine");
  assert.equal(folderAllowed("", env).ok, false, "no folder named");
  // A folder that holds the portal's own folders is refused too: the
  // channel's root, where the file would sit loose beside everyone's.
  const holds = (folder: string, because: RegExp) => {
    const said = folderAllowed(folder, env, alsoFiled);
    assert.equal(said.ok, false, folder + " should be refused");
    assert.match((said as { reason: string }).reason, /holds the portal's own folders/);
    assert.match((said as { reason: string }).reason, because);
    assert.match((said as { reason: string }).reason, /pick one beside them/);
  };
  holds("United Operations Team", /United Operations Team\//);
  holds("united operations team/", /United Operations Team\//);
  holds("United Operations Team/Certs", /Certs\/Kyle/);
});

/* ------------------------------------------------------------------------ *
 * The backup on the hour: one file into the owner's folder before the
 * lease, the books in it byte for byte and nothing that must not be, and
 * the hour's own work untouched whatever the backup did.
 * ------------------------------------------------------------------------ */
const BACKUP_FOLDER = "United Operations Team/Backups";
const backupKey = (day: string) => `library/${BACKUP_FOLDER}/Crew Portal backup ${day}.json`;
/** 02:10 on 24 Sep 2026 where the vessel is, and 01:10. */
const TEN_PAST_TWO = Date.parse("2026-09-23T18:10:00Z");
const TEN_PAST_ONE = Date.parse("2026-09-23T17:10:00Z");
/** Evans's portal with the backup folder in the library and a user on the books. */
const backupPortal = async () => {
  const bucket = fakeBucket({ "opms/Brenton - OPMS/master.pdf": "a scan" }, ["opms", "removed", "opms/Brenton - OPMS", "library/" + BACKUP_FOLDER]);
  const tmKey = "opms/20260901 - CREW QUALIFICATION EXPIRY.xlsx";
  await bucket.put(tmKey, await smallWorkbook().arrayBuffer());
  bucket.made.length = 0;
  const portal = portalDb(
    {
      quals: { cols: [["QL-01", "Master", "Qualifications"], ["QL-17", "Medical", "Medical"]], rows: [["EVANS, Brenton", "Master", "", ["", "2030-01-17"]]] },
      people: [{ name: "EVANS, Brenton", aliases: ["bRENTON"] }], filledFromCert: {}, orphanSeen: {}, history: [],
    },
    [
      { ...billysTicket, id: "c2", person: "bRENTON", checksum: "evans-master", blobKey: "opms/Brenton - OPMS/master.pdf", sizeBytes: 6 },
      { ...liveRow("tm1", tmKey), sizeBytes: 5000 },
    ],
    { "r1/evans-master.json": { ...reading, holderName: "Brenton Evans", expiresOn: "2031-05-26" } },
    [{ id: "u1", email: "m@portal", name: "Matthew Jones", role: "management", disabled: 0, created_at: 1, created_by: null, last_login: null, phone: null }],
  );
  const env = getEnvFor(portal, bucket);
  setEnv(env as never);
  return { portal, bucket, env, tmKey };
};
const backupRecord = (portal: { blobs: Map<string, string> }) => JSON.parse(portal.blobs.get("sync|last-backup") || "null");

test("at ten past two the hour writes the backup into the owner's folder, whole, and then does its own work", async () => {
  const { portal, bucket } = await backupPortal();
  // The document as it stood before the hour: the round moves it on after the backup.
  const before = portal.state.data;
  await withClock(TEN_PAST_TWO, () => worker.scheduled({} as never, getEnvFor(portal, bucket) as never));
  const text = bucket.text(backupKey("2026-09-24"));
  assert.ok(text, "the file is in the folder");
  assert.deepEqual(bucket.made, [], "no folder was made");
  assert.ok(text!.includes(before), "the shared document is in it byte for byte");
  assert.notEqual(portal.state.data, before, "and the round moved the document on afterwards");
  const file = JSON.parse(text!);
  assert.deepEqual(Object.keys(file), ["portal", "backupVersion", "at", "perthDay", "rev", "counts", "document", "documents", "users", "readings", "fauna"]);
  assert.equal(file.portal, vessel.slug, "marked with the vessel file's slug");
  assert.equal(file.backupVersion, 1);
  assert.equal(file.perthDay, "2026-09-24");
  assert.equal(file.at, "2026-09-23T18:10:00.000Z");
  assert.equal(file.rev, 1, "the revision the document was at when it was copied");
  assert.deepEqual(file.counts, { documents: 2, users: 1, readings: 1, fauna: 0 });
  assert.deepEqual(file.documents.map((d: { id: string }) => d.id), ["c2", "tm1"]);
  assert.deepEqual(file.users, [{ id: "u1", email: "m@portal", name: "Matthew Jones", role: "management", disabled: 0, created_at: 1, created_by: null, last_login: null, phone: null }]);
  assert.deepEqual(Object.keys(file.readings), ["certificate-readings", "matrix-readings", "shift-allocation-readings", "opms-checks"]);
  assert.equal(file.readings["certificate-readings"]["r1/evans-master.json"].holderName, "Brenton Evans");
  assert.deepEqual(file.fauna, [], "no fauna table yet is no sightings");
  for (const never of ["sessions", "login_codes", "login_events", "portal_state_history", "round-lease", "last-hourly", "MS_CLIENT_SECRET"]) {
    assert.ok(!text!.includes(never), never + " is not in the file");
  }
  // The backup's own statements, before the lease was taken: none of them
  // near the sign-in tables or the history.
  const leaseAt = portal.db.asked.findIndex((a) => isLeaseTake(a.sql, a.args));
  assert.ok(leaseAt > 0, "the lease was taken after the backup");
  assert.ok(!portal.db.asked.slice(0, leaseAt).some((a) => /sessions|login_codes|login_events|portal_state_history/.test(a.sql)), "nothing asked of the sign-in tables or the history");
  assert.ok(!portal.db.asked.slice(0, leaseAt).some((a) => /LIKE|children/.test(a.sql)), "no listing");
  const rec = backupRecord(portal);
  assert.equal(rec.day, "2026-09-24");
  assert.equal(rec.name, "Crew Portal backup 2026-09-24.json");
  assert.equal(rec.bytes, new TextEncoder().encode(text!).length);
  assert.equal(rec.error, null);
  assert.equal(rec.rev, 1);
  // And the hour's own work ran as it always does.
  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.syncError, null);
  assert.equal(hourly.applied, 1, "the round ran");
  assert.deepEqual(portal.doc().workbookPending ?? [], [], "the workbook was written");

  // The same hour again: nothing more is written, and the record stands.
  await withClock(TEN_PAST_TWO + 60000, () => worker.scheduled({} as never, getEnvFor(portal, bucket) as never));
  assert.equal(backupRecord(portal).at, TEN_PAST_TWO, "the record is the first hour's");
  assert.equal(bucket.text(backupKey("2026-09-24")), text, "the file is untouched");
  assert.ok(!portal.db.asked.slice(leaseAt).some((a) => a.sql === "SELECT * FROM documents ORDER BY created_at, id"), "the books were not read for a backup again");
});

/** The env for a scheduled run against this portal and bucket. */
function getEnvFor(portal: { db: unknown }, bucket: unknown) {
  return { DB: portal.db, FILES: bucket, FILE_STORE: "r2", BACKUP_FOLDER, BACKUP_HOUR: "2",
    SHAREPOINT_ROOT: "United Operations Team/Crew Portal", SHAREPOINT_MAP: JSON.stringify({ "opms/": "United Operations Team/OPMS Documents/" }),
    SHAREPOINT_FAUNA_FOLDER: "United Operations Team/Fauna" };
}

test("at ten past one nothing is backed up, and with no folder named nothing is either", async () => {
  const { portal, bucket } = await backupPortal();
  await withClock(TEN_PAST_ONE, () => worker.scheduled({} as never, getEnvFor(portal, bucket) as never));
  assert.equal(bucket.text(backupKey("2026-09-24")), null);
  assert.equal(backupRecord(portal), null, "no record either");
  assert.equal(JSON.parse(portal.blobs.get("sync|last-hourly")!).applied, 1, "the hour ran");

  await withClock(TEN_PAST_TWO, () => worker.scheduled({} as never, { ...getEnvFor(portal, bucket), BACKUP_FOLDER: "" } as never));
  assert.equal(bucket.text(backupKey("2026-09-24")), null, "BACKUP_FOLDER empty: the backup is off");
  assert.equal(backupRecord(portal), null);
});

test("a backup that cannot be written goes on the record with no day, and the hour still runs", async () => {
  const { portal, bucket } = await backupPortal();
  bucket.failOn = bucket.puts() + 1;
  await withClock(TEN_PAST_TWO, () => quiet(() => worker.scheduled({} as never, getEnvFor(portal, bucket) as never)));
  assert.equal(bucket.text(backupKey("2026-09-24")), null, "nothing landed");
  const rec = backupRecord(portal);
  assert.equal(rec.error, "the library refused the write");
  assert.equal(rec.day, null, "no day: it is owed again next hour");
  assert.equal(rec.at, TEN_PAST_TWO);
  const hourly = JSON.parse(portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.syncError, null, "the sync ran");
  assert.equal(hourly.applied, 1, "and the round");

  // Next hour the write goes through, and the day is written.
  await withClock(TEN_PAST_TWO + 3_600_000, () => worker.scheduled({} as never, getEnvFor(portal, bucket) as never));
  assert.ok(bucket.text(backupKey("2026-09-24")), "landed on the second try");
  assert.equal(backupRecord(portal).day, "2026-09-24");
  assert.equal(backupRecord(portal).error, null);
});

test("a folder the portal files into is refused on the record, and a folder not in the library too", async () => {
  const { portal, bucket } = await backupPortal();
  const into = await withClock(TEN_PAST_TWO, () => quiet(async () => {
    setEnv({ ...getEnvFor(portal, bucket), BACKUP_FOLDER: "United Operations Team/OPMS Documents/Backups" } as never);
    return nightlyBackup(Date.now());
  }));
  assert.match(into!.error!, /is one the portal files into \(United Operations Team\/OPMS Documents\); pick another/);
  assert.equal(into!.day, null);
  assert.deepEqual(bucket.keys().filter((k) => k.startsWith("library/")), [], "nothing written");
  // The certificate home Crew Details set, and a man's own folder, count too.
  portal.state.data = JSON.stringify({ ...portal.doc(), certRoot: "United Operations Team/Certs", people: [{ name: "EVANS, Brenton", certFolder: "United Operations Team/Elsewhere/Brenton" }] });
  const home = await withClock(TEN_PAST_TWO, () => quiet(async () => {
    setEnv({ ...getEnvFor(portal, bucket), BACKUP_FOLDER: "United Operations Team/Certs/Backups" } as never);
    return nightlyBackup(Date.now());
  }));
  assert.match(home!.error!, /United Operations Team\/Certs/);
  const his = await withClock(TEN_PAST_TWO, () => quiet(async () => {
    setEnv({ ...getEnvFor(portal, bucket), BACKUP_FOLDER: "United Operations Team/Elsewhere/Brenton" } as never);
    return nightlyBackup(Date.now());
  }));
  assert.match(his!.error!, /Elsewhere\/Brenton/);
  assert.deepEqual(bucket.made, [], "no folder was made");
});

test("the backup lands even while somebody holds the lease, and the hour stands down as before", async () => {
  const { portal, bucket } = await backupPortal();
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: TEN_PAST_TWO + 10 * 60000, by: "Update portal", token: "y" }));
  const realSleep = hourWaits.sleep;
  hourWaits.sleep = async () => {};
  try {
    await withClock(TEN_PAST_TWO, () => worker.scheduled({} as never, getEnvFor(portal, bucket) as never));
  } finally {
    hourWaits.sleep = realSleep;
  }
  assert.ok(bucket.text(backupKey("2026-09-24")), "the backup is in the folder");
  assert.equal(backupRecord(portal).day, "2026-09-24");
  assert.equal(JSON.parse(portal.blobs.get("sync|last-hourly")!).roundSkipped, "another round is still running");
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).by, "Update portal", "the page's lease is untouched");
  assert.equal(graphBudget.until, 0, "the library's budget is cleared on the way out, though the hour stood down before its lease");
});

test("the library's waits are under the hour's budget from the tick, before the backup asks the library anything", async () => {
  /* The backup runs before the lease, and its calls on the library - the
     look for its folder, the write into it, the drops of old dailies -
     are Graph calls like any other. Without a budget over them a throttled
     library could hold the hour in the backup for minutes before the
     lease is even tried. So the budget is set from the tick first, twelve
     minutes less the settling time, and drawn in once the lease is held.
     On R2 the backup's first call on the library is its write, so that
     is where the budget is read. */
  const { portal, bucket } = await backupPortal();
  const seen: number[] = [];
  const realPut = bucket.put;
  bucket.put = async (key, value) => {
    if (key.startsWith("library/")) seen.push(graphBudget.until);
    return realPut.call(bucket, key, value);
  };
  try {
    await withClock(TEN_PAST_TWO, () => worker.scheduled({} as never, getEnvFor(portal, bucket) as never));
  } finally {
    bucket.put = realPut;
  }
  assert.ok(bucket.text(backupKey("2026-09-24")), "the backup landed");
  assert.deepEqual(seen, [TEN_PAST_TWO + 12 * 60 * 1000 - SETTLE_MS], "the outer bound, from the tick, at the backup's write");
  assert.equal(graphBudget.until, 0, "and cleared when the hour is done");
  assert.equal(JSON.parse(portal.blobs.get("sync|last-hourly")!).applied, 1, "the hour went on to run the round");
});

test("after the backup lands, a month of dailies and a year of monthlies remain, by name", async () => {
  const { portal, bucket } = await backupPortal();
  const seed = ["2026-08-25", "2026-08-24", "2026-08-23", "2026-08-18", "2026-08-17", "2026-08-01", "2025-09-01", "2025-08-01", "2025-07-01"];
  for (const d of seed) await bucket.put(backupKey(d), bytesOf("old"));
  bucket.made.length = 0;
  await withClock(TEN_PAST_TWO, () => worker.scheduled({} as never, getEnvFor(portal, bucket) as never));
  const left = bucket.keys().filter((k) => k.startsWith("library/")).map((k) => /backup (\d{4}-\d{2}-\d{2})/.exec(k)![1]);
  assert.deepEqual(left, ["2025-07-01", "2025-09-01", "2026-08-01", "2026-08-17", "2026-08-25", "2026-09-24"],
    "30 days back stays, 31 to 37 go, the monthlies stay but the one 13 months back; a file older than the week's window is never touched, since nothing is listed");
  assert.deepEqual(bucket.made, [], "no folder was made");
});

/* ------------------------------------------------------------------------ *
 * A backup put back: the document as a save under a name of its own, and
 * the other parts only when asked, bound and batched.
 * ------------------------------------------------------------------------ */
const aBackup = (over: Record<string, unknown> = {}) => ({
  portal: vessel.slug, backupVersion: 1, at: "2026-09-22T18:10:00.000Z", perthDay: "2026-09-23", rev: 7,
  counts: { documents: 0, users: 0, readings: 0, fauna: 0 },
  document: JSON.stringify({ quals: { cols: [["QL-01", "Master", "Qualifications"]], rows: [["EVANS, Brenton", "Master", "", ["2029-01-01"]]] }, people: [{ name: "EVANS, Brenton", aliases: [] }] }),
  documents: [], users: [], readings: {}, fauna: [],
  ...over,
});
const putBack = (body: unknown, who = manager, query = "") => restoreFile(
  new Request("http://portal/api/state/restore-file" + query, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
  who,
);
const historyRows = (db: { asked: Asked[] }) => db.asked.filter((a) => /^INSERT INTO portal_state_history/.test(a.sql));

test("management puts a backup's document back as a save of its own, and the rest is said to be left alone", async () => {
  const { portal } = await oneManPortal();
  const res = await putBack(aBackup());
  const out = (await res.json()) as { rev: number; from: string; restored: string[]; notRestored: string[]; error?: string };
  assert.equal(res.status, 200, out.error || "");
  assert.equal(out.rev, 2, "rev 1 to 2: a save on top, so every open tab reloads");
  assert.equal(out.from, "2026-09-23");
  assert.deepEqual(out.restored, ["document"]);
  assert.deepEqual(out.notRestored, ["documents", "users", "readings", "fauna"], "it says what it did not touch");
  assert.equal(portal.state.rev, 2);
  assert.deepEqual(portal.doc().quals.rows, [["EVANS, Brenton", "Master", "", ["2029-01-01"]]], "the backup's document stands");
  const rows = historyRows(portal.db);
  assert.equal(rows.length, 1, "one history row");
  assert.equal(rows[0].args[4], "Matthew Jones restored the backup of 2026-09-23", "under a name of its own, so the minute's coalescing cannot fold it into an earlier save");
  assert.ok(!portal.db.asked.some((a) => /INSERT OR REPLACE/.test(a.sql)), "no other table was written");
});

test("crew cannot put a backup back", async () => {
  const { portal } = await oneManPortal();
  const res = await putBack(aBackup(), { id: "u2", role: "crew", name: "Deckhand", email: "d@portal" } as never);
  assert.equal(res.status, 403);
  assert.equal(portal.state.rev, 1, "nothing written");
});

test("a file that is not this vessel's backup is refused whole, and nothing is written", async () => {
  const { portal } = await oneManPortal();
  const wrong = await putBack(aBackup({ portal: "someone-else" }));
  assert.equal(wrong.status, 400);
  assert.match(((await wrong.json()) as { error: string }).error, new RegExp("isn't a " + vessel.shortName + " backup"));
  const version = await putBack(aBackup({ backupVersion: 2 }));
  assert.equal(version.status, 400);
  const noDoc = await putBack(aBackup({ document: undefined }));
  assert.equal(noDoc.status, 400);
  const notJson = await putBack("{not json");
  assert.equal(notJson.status, 400);
  const unknownPart = await putBack(aBackup({ what: ["sessions"] }));
  assert.equal(unknownPart.status, 400, "a part the portal does not keep in a backup cannot be asked for");
  assert.equal(portal.state.rev, 1, "nothing written");
  assert.ok(!portal.db.asked.some((a) => /^UPDATE portal_state|INSERT OR REPLACE/.test(a.sql)), "no write of any kind");
});

test("a document over what the database holds is refused as too large", async () => {
  const { portal } = await oneManPortal();
  const res = await putBack(aBackup({ document: JSON.stringify({ pad: "x".repeat(MAX_BYTES) }) }));
  assert.equal(res.status, 413);
  assert.equal(portal.state.rev, 1, "nothing written");
});

test("asked for the readings, they go in bound and eighty at a time", async () => {
  const { portal } = await oneManPortal();
  const readings: Record<string, unknown> = {};
  for (let i = 0; i < 200; i++) readings[`r1/sum-${i}.json`] = { ...reading, holderName: "Person " + i };
  const batches: number[] = [];
  const realBatch = portal.db.batch.bind(portal.db);
  portal.db.batch = async (stmts) => { batches.push(stmts.length); return realBatch(stmts); };
  const res = await putBack(aBackup({ readings: { "certificate-readings": readings, "matrix-readings": { "equivalences.json": { note: "not JSON as stored", text: "{broken" } } } }), manager, "?what=readings");
  const out = (await res.json()) as { restored: string[]; notRestored: string[]; rows: Record<string, number>; error?: string };
  assert.equal(res.status, 200, out.error || "");
  assert.deepEqual(out.restored, ["document", "readings"]);
  assert.deepEqual(out.notRestored, ["documents", "users", "fauna"]);
  assert.equal(out.rows.readings, 201);
  // The first batch is the history's own (the row and the trim); the rest are the readings.
  assert.deepEqual(batches.slice(1), [80, 80, 41], "eighty at a time through the database's own batch");
  const writes = portal.db.asked.filter((a) => /^INSERT OR REPLACE INTO blobs/.test(a.sql));
  assert.equal(writes.length, 201);
  assert.ok(writes.every((a) => a.sql === "INSERT OR REPLACE INTO blobs (store, key, value, updated_at, etag) VALUES (?1, ?2, ?3, ?4, ?5)"), "every value bound, none in the SQL");
  assert.equal(JSON.parse(portal.blobs.get("certificate-readings|r1/sum-7.json")!).holderName, "Person 7");
  assert.equal(portal.blobs.get("matrix-readings|equivalences.json"), "{broken", "a value the backup kept as text goes back as that text");
  assert.equal(portal.state.rev, 2, "and the document went in first");
});

test("a store the file names for itself is refused whole: the readings are the four the portal keeps", async () => {
  const { portal } = await oneManPortal();
  portal.blobs.set("sync|round-lease", JSON.stringify({ until: 1, by: "nobody", token: "t" }));
  const res = await putBack(aBackup({ readings: { "certificate-readings": {}, sync: { "round-lease": { until: 9e15, by: "a file", token: "x" } } } }), manager, "?what=readings");
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /can't put back the store "sync"/);
  assert.equal(portal.state.rev, 1, "the document was not written either: refused before anything");
  assert.ok(!portal.db.asked.some((a) => /INSERT OR REPLACE/.test(a.sql)), "nothing written");
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).by, "nobody", "the lease is as it was");
  // A store the file names but was not asked for is not looked at.
  const notAsked = await putBack(aBackup({ readings: { sync: { "round-lease": {} } } }));
  assert.equal(notAsked.status, 200, "the document alone was asked for");
});

test("a wiped database takes the document back as its first revision", async () => {
  const { portal } = await oneManPortal();
  portal.stateRow.present = false;
  const res = await putBack(aBackup());
  const out = (await res.json()) as { rev: number; error?: string };
  assert.equal(res.status, 200, out.error || "");
  assert.equal(out.rev, 1, "the first revision on an empty portal");
  assert.deepEqual(portal.doc().quals.rows, [["EVANS, Brenton", "Master", "", ["2029-01-01"]]]);
  assert.equal(historyRows(portal.db).length, 1);
  // And on a portal that has a document, the seed changes nothing.
  const again = await putBack(aBackup());
  assert.equal(((await again.json()) as { rev: number }).rev, 2);
});

test("asked for the file index and the users, only the portal's own columns are written, by name from the portal's list", async () => {
  const { portal } = await oneManPortal();
  const written: Asked[] = [];
  const realBatch = portal.db.batch.bind(portal.db);
  const plain = portal.db.prepare;
  // The fake knows nothing of these statements; they are caught on the way in.
  portal.db.prepare = (sql: string) => {
    if (!/^INSERT OR REPLACE INTO (documents|users)/.test(sql)) return plain(sql);
    const s = { bind: (...args: unknown[]) => ({ ...s, run: async () => { written.push({ sql, args }); return { results: [], meta: { changes: 1 } }; } }), run: async () => ({ results: [], meta: { changes: 1 } }) };
    return s as never;
  };
  portal.db.batch = async (stmts) => realBatch(stmts);
  const res = await putBack(aBackup({
    documents: [{ id: "d9", category: "certificate", blob_key: "opms/X/y.pdf", filename: "y.pdf", size_bytes: 5, created_at: 3, evil: "DROP TABLE", removed_at: null }],
    users: [{ id: "u9", email: "x@portal", name: "X", role: "crew", disabled: 0, created_at: 1, password: "never a column" }],
    what: ["documents", "users"],
  }));
  const out = (await res.json()) as { rows: Record<string, number>; error?: string };
  assert.equal(res.status, 200, out.error || "");
  assert.deepEqual(out.rows, { documents: 1, users: 1 });
  assert.deepEqual(written.map((w) => w.sql), [
    "INSERT OR REPLACE INTO documents (id, category, blob_key, filename, size_bytes, created_at, removed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    "INSERT OR REPLACE INTO users (id, email, name, role, disabled, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ], "the columns the portal knows, in the portal's order; nothing the file made up");
  assert.deepEqual(written[0].args, ["d9", "certificate", "opms/X/y.pdf", "y.pdf", 5, 3, null]);
});

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

/* ------------------------------------------------------------------------ *
 * The weekly certificate-expiry emails on the hour: each crew member's own
 * list and the summary to management and IT, sent from the tick at ten
 * past the set hour on the set weekday, before the lease, once a day, and
 * never at all while the switch is off. Sending to the wrong person, or
 * twice, is what these hold against.
 * ------------------------------------------------------------------------ */
/** Monday 28 Sep 2026 where the vessel is, at ten past seven and ten past six;
 *  and Tuesday at ten past seven. */
const MONDAY_0710 = Date.parse("2026-09-27T23:10:00Z");
const MONDAY_0610 = Date.parse("2026-09-27T22:10:00Z");
const TUESDAY_0710 = Date.parse("2026-09-28T23:10:00Z");
const REMINDERS_ON = { on: true, days: 90, weekday: 1, hour: 7 };
const REMINDER_USERS = [
  { id: "u1", email: "brenton@example.com", name: "Brenton Evans", role: "crew", disabled: 0 },
  { id: "u2", email: "kachin@example.com", name: "Kachin Sittiyos", role: "crew", disabled: 0 },
  { id: "u3", email: "boss@example.com", name: "Matthew Jones", role: "management", disabled: 0 },
  { id: "u4", email: "help@example.com", name: "IT Help", role: "it", disabled: 0 },
  { id: "u5", email: "gone@example.com", name: "Sam Sample", role: "crew", disabled: 1 },
  { id: "u6", email: "nobody@example.com", name: "Alan Stranger", role: "crew", disabled: 0 },
];

/** The users table as the reminders ask it: only the one statement, laid
 *  out by the columns it names - so a statement that names another column,
 *  or asks another way, is refused rather than answered. */
function withUsersTable(db: { prepare(sql: string): unknown; asked: { sql: string; args: unknown[] }[] }, users: Record<string, unknown>[]) {
  return {
    ...db,
    prepare(sql: string) {
      if (!/\bFROM users\b/.test(sql) || /created_at/.test(sql)) return db.prepare(sql);
      if (sql !== REMINDER_USERS_SQL) throw new Error("the reminders asked the users table something unexpected: " + sql);
      const cols = /^SELECT (.+) FROM users WHERE disabled = 0$/.exec(sql)![1].split(", ");
      const results = users.filter((u) => u.disabled === 0).map((u) => Object.fromEntries(cols.map((c) => [c, u[c]])));
      const stmt = {
        bind: () => stmt,
        all: async () => { db.asked.push({ sql, args: [] }); return { results, meta: { changes: 0 } }; },
        first: async () => results[0] ?? null,
      };
      return stmt;
    },
  };
}

/** A fake of Cloudflare's email binding: every send written down, and any
 *  address in `refuses` refused. */
function fakeEmail(refuses: string[] = []) {
  const sent: { to: string; from: string; subject: string; text: string; html: string }[] = [];
  return {
    sent,
    async send(m: { to: string; from: string; subject: string; text: string; html: string }) {
      if (refuses.includes(m.to)) throw new Error("the service refused " + m.to);
      sent.push(m);
    },
  };
}

/** Evans's portal with Kachin on the matrix too, the reminders set as
 *  `reminders` (left off the document entirely where "missing"), and the
 *  grants above. */
const reminderPortal = async (reminders: unknown = REMINDERS_ON, quals17 = ["2026-10-12", "2026-09-25"]) => {
  const bucket = fakeBucket({ "opms/Brenton - OPMS/master.pdf": "a scan" }, ["opms", "removed", "opms/Brenton - OPMS"]);
  const tmKey = "opms/20260901 - CREW QUALIFICATION EXPIRY.xlsx";
  await bucket.put(tmKey, await smallWorkbook().arrayBuffer());
  bucket.made.length = 0;
  const doc: Record<string, unknown> = {
    quals: {
      cols: [["QL-01", "Master", "Qualifications"], ["QL-17", "AMSA Medical", "Medical"], ["VS-04", "Induction", "E-Learning"]],
      rows: [
        ["EVANS, Brenton", "Master", "", ["", quals17[0], "2026-09-30"]],
        ["SITTIYOS, Kachin", "Cook", "", ["", quals17[1], ""]],
      ],
    },
    people: [{ name: "EVANS, Brenton", aliases: ["bRENTON"] }, { name: "SITTIYOS, Kachin", aliases: [] }],
    filledFromCert: {}, orphanSeen: {}, history: [],
  };
  if (reminders !== "missing") doc.reminders = reminders;
  const portal = portalDb(
    doc,
    [
      { ...billysTicket, id: "c2", person: "bRENTON", checksum: "evans-master", blobKey: "opms/Brenton - OPMS/master.pdf", sizeBytes: 6 },
      { ...liveRow("tm1", tmKey), sizeBytes: 5000 },
    ],
    { "r1/evans-master.json": { ...reading, holderName: "Brenton Evans", expiresOn: "2031-05-26" } },
    REMINDER_USERS,
  );
  return { portal, bucket, db: withUsersTable(portal.db, REMINDER_USERS) };
};
const reminderEnv = (r: { portal: { db: unknown }; bucket: unknown; db: unknown }, email: unknown) =>
  ({ ...getEnvFor(r.portal, r.bucket), BACKUP_FOLDER: "", DB: r.db, ...(email ? { EMAIL: email } : {}) });
const reminderRecord = (portal: { blobs: Map<string, string> }) => JSON.parse(portal.blobs.get("sync|last-reminder") || "null");
const hourAt = (at: number, env: unknown) => withClock(at, () => worker.scheduled({} as never, env as never));

test("at ten past seven on Monday each crew member is sent their own list and management and IT the summary, before the lease", async () => {
  const r = await reminderPortal();
  const email = fakeEmail();
  await hourAt(MONDAY_0710, reminderEnv(r, email));
  const ship = `${vessel.name} ${vessel.nameAccent}`;
  assert.deepEqual(email.sent.map((m) => [m.to, m.subject]), [
    ["brenton@example.com", `Your certificates expiring within 90 days - ${ship}`],
    ["kachin@example.com", `Your certificates expiring within 90 days - ${ship}`],
    ["boss@example.com", `Crew certificates expiring within 90 days - ${ship}`],
    ["help@example.com", `Crew certificates expiring within 90 days - ${ship}`],
  ], "Brenton and Kachin their own; management and IT the summary; the disabled grant and the stranger nothing");
  assert.ok(email.sent.every((m) => m.from === vessel.mailFrom), "from the vessel file's address");
  assert.equal(email.sent[0].text,
    `Your certificates on the ${ship} crew matrix (EVANS, Brenton) that have expired or expire within 90 days, as at 28 Sep 2026:\n\n` +
    "QL-17 AMSA Medical — expires 12 Oct 2026 (14 days)\n\n" +
    `https://${vessel.domain}\n`, "Brenton's list is Brenton's alone, and VS-04 is never on it");
  assert.ok(!email.sent[0].text.includes("SITTIYOS") && !email.sent[1].text.includes("EVANS"), "nobody sees the other's list");
  assert.match(email.sent[1].text, /QL-17 AMSA Medical — expired 3 days ago \(25 Sep 2026\)/);
  assert.equal(email.sent[2].text, email.sent[3].text, "one summary, sent to each");
  assert.match(email.sent[2].text, /2 items, 2 people:\n\nEVANS, Brenton\n {2}QL-17 AMSA Medical — expires 12 Oct 2026 \(14 days\)\n\nSITTIYOS, Kachin\n {2}QL-17 AMSA Medical — expired 3 days ago/);
  assert.ok(email.sent.every((m) => m.html.includes(`https://${vessel.domain}`)));

  assert.deepEqual(reminderRecord(r.portal), {
    day: "2026-09-28", at: MONDAY_0710, window: 90, own: 2, summary: 2, failed: [], unanswered: [], skipped: null, error: null,
  });
  // Asked before the lease, and the hour's own work ran after.
  const asked = r.portal.db.asked;
  const usersAt = asked.findIndex((a) => a.sql === REMINDER_USERS_SQL);
  const leaseAt = asked.findIndex((a) => isLeaseTake(a.sql, a.args));
  assert.ok(usersAt >= 0 && leaseAt > usersAt, "the reminders went before the lease was taken");
  const hourly = JSON.parse(r.portal.blobs.get("sync|last-hourly")!);
  assert.equal(hourly.syncError, null, "the sync ran");
  assert.equal(hourly.applied, 1, "and the round");
  assert.deepEqual(r.bucket.made, [], "no folder was made");

  // The same Monday again, an hour on: nothing more.
  await hourAt(MONDAY_0710 + 3_600_000, reminderEnv(r, email));
  assert.equal(email.sent.length, 4, "not sent twice");
  assert.equal(reminderRecord(r.portal).at, MONDAY_0710, "the record is the first send's");
});

test("before the hour, on another day, or with the switch off, nothing is sent", async () => {
  const early = await reminderPortal();
  const email = fakeEmail();
  await hourAt(MONDAY_0610, reminderEnv(early, email));
  assert.equal(email.sent.length, 0, "not at ten past six");
  assert.equal(reminderRecord(early.portal), null);

  const tuesday = await reminderPortal();
  await hourAt(TUESDAY_0710, reminderEnv(tuesday, email));
  assert.equal(email.sent.length, 0, "not on Tuesday");
  assert.equal(reminderRecord(tuesday.portal), null);

  for (const setting of ["missing", { ...REMINDERS_ON, on: false }, { ...REMINDERS_ON, on: "true" }]) {
    const off = await reminderPortal(setting);
    await hourAt(MONDAY_0710, reminderEnv(off, email));
    assert.equal(email.sent.length, 0, "off sends nothing: " + JSON.stringify(setting));
    assert.equal(reminderRecord(off.portal), null, "and writes no record");
    assert.ok(!off.portal.db.asked.some((a) => a.sql === REMINDER_USERS_SQL), "nor asks who could be sent anything");
    assert.equal(JSON.parse(off.portal.blobs.get("sync|last-hourly")!).applied, 1, "the hour ran");
  }

  // Another weekday and hour are honoured the same way.
  const wednesday = await reminderPortal({ on: true, days: 30, weekday: 3, hour: 9 });
  await hourAt(MONDAY_0710, reminderEnv(wednesday, email));
  assert.equal(email.sent.length, 0, "set for Wednesday: nothing on Monday");
  await hourAt(Date.parse("2026-09-30T01:10:00Z"), reminderEnv(wednesday, email));
  assert.deepEqual(email.sent.map((m) => m.to), ["brenton@example.com", "kachin@example.com", "boss@example.com", "help@example.com"], "09:10 Wednesday");
  assert.match(email.sent[0].subject, /within 30 days/);
  assert.equal(reminderRecord(wednesday.portal).window, 30);
});

test("a send the service refuses is counted, and everybody else's still go", async () => {
  const r = await reminderPortal();
  const email = fakeEmail(["kachin@example.com"]);
  await quiet(() => hourAt(MONDAY_0710, reminderEnv(r, email)));
  assert.deepEqual(email.sent.map((m) => m.to), ["brenton@example.com", "boss@example.com", "help@example.com"]);
  const rec = reminderRecord(r.portal);
  assert.deepEqual(rec.failed, ["kachin@example.com"]);
  assert.equal(rec.own, 1);
  assert.equal(rec.summary, 2);
  assert.equal(rec.day, "2026-09-28", "the day stands: the others are not sent again");
  await quiet(() => hourAt(MONDAY_0710 + 3_600_000, reminderEnv(r, fakeEmail())));
  assert.equal(reminderRecord(r.portal).at, MONDAY_0710, "nothing sent again that day");
});

test("with no email binding the record says so, nothing throws, and the hour runs", async () => {
  const r = await reminderPortal();
  await quiet(() => hourAt(MONDAY_0710, reminderEnv(r, null)));
  const rec = reminderRecord(r.portal);
  assert.equal(rec.error, NO_EMAIL);
  assert.equal(rec.day, null, "nothing went, so the next hour tries again");
  assert.equal(rec.own + rec.summary, 0);
  assert.equal(JSON.parse(r.portal.blobs.get("sync|last-hourly")!).applied, 1, "the hour ran");
  // The binding back, the next hour sends.
  const email = fakeEmail();
  await hourAt(MONDAY_0710 + 3_600_000, reminderEnv(r, email));
  assert.equal(email.sent.length, 4);
  assert.equal(reminderRecord(r.portal).day, "2026-09-28");
});

test("an all-clear week sends nothing and says so; a day already claimed sends nothing", async () => {
  const clear = await reminderPortal(REMINDERS_ON, ["2027-06-01", "2027-07-01"]);
  const email = fakeEmail();
  await hourAt(MONDAY_0710, reminderEnv(clear, email));
  assert.equal(email.sent.length, 0);
  assert.deepEqual(reminderRecord(clear.portal), {
    day: "2026-09-28", at: MONDAY_0710, window: 90, own: 0, summary: 0, failed: [], unanswered: [], skipped: "nothing expiring", error: null,
  });

  // A run cut off mid-send leaves its claim: the rest of the day sends nothing.
  const cut = await reminderPortal();
  cut.portal.blobs.set("sync|last-reminder", JSON.stringify({ day: "2026-09-28", at: MONDAY_0710, window: 90, own: 0, summary: 0, failed: [], skipped: null, error: UNFINISHED }));
  await hourAt(MONDAY_0710 + 3_600_000, reminderEnv(cut, email));
  assert.equal(email.sent.length, 0, "a claimed day is never sent again");
  assert.equal(reminderRecord(cut.portal).error, UNFINISHED);
});

test("two runs of the same tick send once between them: the claim is on the record before the first email goes", async () => {
  const r = await reminderPortal();
  const seen: { day: string; error: string | null }[] = [];
  const email = fakeEmail();
  // What the record said at the moment each email went.
  const watching = {
    sent: email.sent,
    async send(m: { to: string; from: string; subject: string; text: string; html: string }) {
      seen.push(reminderRecord(r.portal));
      return email.send(m);
    },
  };
  setEnv(reminderEnv(r, watching) as never);
  const both = await withClock(MONDAY_0710, () => Promise.all([weeklyReminders(MONDAY_0710), weeklyReminders(MONDAY_0710)]));
  assert.equal(email.sent.length, 4, "four emails between the two runs, not eight");
  assert.equal(both.filter((b) => b === null).length, 1, "one run found the day claimed and did nothing");
  assert.equal(seen[0].day, "2026-09-28", "the day was claimed before the first email");
  assert.equal(seen[0].error, UNFINISHED, "and the claim says so until the sends are done");
  assert.equal(reminderRecord(r.portal).error, null);
});

test("a run that falls over after an email has gone keeps the day: the next hour sends nothing", async () => {
  const r = await reminderPortal();
  const email = fakeEmail();
  // IT's address reads as itself twice - when the grants are sorted - and
  // then throws, after Brenton's, Kachin's and the manager's have gone:
  // something going wrong outside a send, part way through.
  let looks = 0;
  const trips = { toString() { if (++looks > 2) throw new Error("the list fell over part way"); return "help@example.com"; } };
  const users = REMINDER_USERS.map((u) => (u.role === "it" ? { ...u, email: trips } : u));
  const env = { ...reminderEnv(r, email), DB: withUsersTable(r.portal.db, users) };
  await quiet(() => hourAt(MONDAY_0710, env));
  assert.deepEqual(email.sent.map((m) => m.to), ["brenton@example.com", "kachin@example.com", "boss@example.com"]);
  const rec = reminderRecord(r.portal);
  assert.equal(rec.day, "2026-09-28", "the day stands, because emails went");
  assert.equal(rec.error, "the list fell over part way");
  assert.equal(rec.own, 2, "what went is on the record");
  assert.equal(rec.summary, 1);
  assert.equal(JSON.parse(r.portal.blobs.get("sync|last-hourly")!).applied, 1, "the hour ran");
  const again = fakeEmail();
  await hourAt(MONDAY_0710 + 3_600_000, reminderEnv(r, again));
  assert.equal(again.sent.length, 0, "nobody is sent it twice");
});

test("the sends stop at their time limit: whoever was not reached is named, and nobody is sent it twice", async () => {
  const r = await reminderPortal();
  const email = fakeEmail();
  // The first send takes a minute and a second.
  const slow = {
    sent: email.sent,
    async send(m: { to: string; from: string; subject: string; text: string; html: string }) {
      await email.send(m);
      Date.now = () => MONDAY_0710 + 61_000;
    },
  };
  await hourAt(MONDAY_0710, reminderEnv(r, slow));
  assert.deepEqual(email.sent.map((m) => m.to), ["brenton@example.com"], "no send started past the minute");
  const rec = reminderRecord(r.portal);
  assert.deepEqual(rec.failed, ["kachin@example.com", "boss@example.com", "help@example.com"], "the rest are named on the record");
  assert.equal(rec.own, 1);
  assert.equal(rec.day, "2026-09-28", "Brenton's went, so the day stands");
  assert.equal(JSON.parse(r.portal.blobs.get("sync|last-hourly")!).applied, 1, "the round still ran");
  const again = fakeEmail();
  await hourAt(MONDAY_0710 + 3_600_000, reminderEnv(r, again));
  assert.equal(again.sent.length, 0, "Brenton is not sent it twice");

  // Out of time before the first send: nothing went, so the next hour tries.
  const late = await reminderPortal();
  const real = reminderLimits.sendingForMs;
  reminderLimits.sendingForMs = -1;
  try {
    await quiet(() => hourAt(MONDAY_0710, reminderEnv(late, email)));
  } finally {
    reminderLimits.sendingForMs = real;
  }
  assert.equal(reminderRecord(late.portal).error, OUT_OF_TIME);
  assert.equal(reminderRecord(late.portal).day, null, "the day handed back");
  const next = fakeEmail();
  await hourAt(MONDAY_0710 + 3_600_000, reminderEnv(late, next));
  assert.equal(next.sent.length, 4, "the next hour sends them");
});

test("a send that never answers is given up on: the rest still go, the claim stands, and the hour runs", async () => {
  // Kachin's send never returns - the service took it and said nothing.
  const hanging = () => {
    const email = fakeEmail();
    return {
      sent: email.sent,
      send: (m: { to: string; from: string; subject: string; text: string; html: string }) =>
        m.to === "kachin@example.com" ? new Promise<void>(() => {}) : email.send(m),
    };
  };
  const waited: number[] = [];
  const realSleep = reminderWaits.sleep;
  try {
    // The wait for an answer ends on the next turn here, as if its time
    // had passed: a send that answers at all has answered by then.
    const aTurn = () => new Promise<void>((done) => setTimeout(done, 0));
    reminderWaits.sleep = async (ms: number) => { waited.push(ms); await aTurn(); };
    const r = await reminderPortal();
    const email = hanging();
    await quiet(() => hourAt(MONDAY_0710, reminderEnv(r, email)));
    assert.ok(waited.includes(reminderLimits.answerWithinMs), "each send waited on for its limit");
    assert.ok(reminderLimits.answerWithinMs > 0 && reminderLimits.answerWithinMs < reminderLimits.sendingForMs);
    assert.deepEqual(email.sent.map((m) => m.to), ["brenton@example.com", "boss@example.com", "help@example.com"], "everybody else's went");
    const rec = reminderRecord(r.portal);
    assert.deepEqual(rec.unanswered, ["kachin@example.com"], "Kachin is named as unanswered");
    assert.deepEqual(rec.failed, [], "and not as failed: the service may still deliver his");
    assert.equal(rec.own, 1);
    assert.equal(rec.summary, 2);
    assert.equal(rec.error, null);
    assert.equal(rec.day, "2026-09-28", "the claim stands");
    const hourly = JSON.parse(r.portal.blobs.get("sync|last-hourly")!);
    assert.equal(hourly.syncError, null, "the sync ran");
    assert.equal(hourly.applied, 1, "and the round, and the hour's line is written");
    const again = fakeEmail();
    await hourAt(MONDAY_0710 + 3_600_000, reminderEnv(r, again));
    assert.equal(again.sent.length, 0, "a second tick sends nothing");

    // The wait on Kachin's used up the minute: the two after are named as
    // not reached, and the hour still runs.
    reminderWaits.sleep = async (ms: number, stop?: AbortSignal) => {
      await aTurn();
      if (!stop?.aborted) Date.now = () => MONDAY_0710 + ms + 45_000;
    };
    const late = await reminderPortal();
    const email2 = hanging();
    await quiet(() => hourAt(MONDAY_0710, reminderEnv(late, email2)));
    assert.deepEqual(email2.sent.map((m) => m.to), ["brenton@example.com"]);
    assert.deepEqual(reminderRecord(late.portal).unanswered, ["kachin@example.com"]);
    assert.deepEqual(reminderRecord(late.portal).failed, ["boss@example.com", "help@example.com"], "never sent, so failed");
    assert.equal(reminderRecord(late.portal).day, "2026-09-28");
    assert.equal(JSON.parse(late.portal.blobs.get("sync|last-hourly")!).applied, 1, "the round still ran");
  } finally {
    reminderWaits.sleep = realSleep;
  }
});

test("the weekday moved after the week's send: nothing more that week", async () => {
  const r = await reminderPortal();
  const email = fakeEmail();
  await hourAt(MONDAY_0710, reminderEnv(r, email));
  assert.equal(email.sent.length, 4);
  // Management moves the reminders to Thursday.
  const doc = JSON.parse(r.portal.state.data);
  r.portal.state.data = JSON.stringify({ ...doc, reminders: { ...REMINDERS_ON, weekday: 4 } });
  const thursday = Date.parse("2026-09-30T23:10:00Z");
  await hourAt(thursday, reminderEnv(r, email));
  assert.equal(email.sent.length, 4, "not again three days later");
  await hourAt(thursday + 7 * 86_400_000, reminderEnv(r, email));
  assert.equal(email.sent.length, 8, "the Thursday after, as set");
});

test("the reminders ask the users table only for columns it has", () => {
  const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"), "utf8");
  const table = /CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\);/.exec(schema)![1];
  const has = table.split("\n").map((l) => /^\s+([a-z_]+)\s+[A-Z]/.exec(l)?.[1]).filter(Boolean);
  assert.deepEqual(has, ["id", "email", "name", "role", "disabled", "created_at", "created_by", "last_login", "phone"]);
  const m = /^SELECT (.+) FROM users WHERE (\w+) = 0$/.exec(REMINDER_USERS_SQL)!;
  for (const c of [...m[1].split(", "), m[2]]) assert.ok(has.includes(c), c + " is a column of users");
});

/* ------------------------------------------------------------------------ *
 * A man's MSIC number and date of birth, off his certificates: filled in
 * the round's own save (the hour's and Update matrix's alike), a typed box
 * left as typed, and the readings made before the question was asked
 * topped up a few an hour - once each, and never on an account that has
 * said no.
 * ------------------------------------------------------------------------ */

/** A certificate for the particulars tests: filed under `person` in
 *  Brenton's folder, answering to `code`, with `reading` held for it (or
 *  none, where it has never been read). */
type PCert = { id: string; checksum: string; code: string | null; person?: string; filedOn?: string; reading?: Record<string, unknown> | null };
/** A reading made as the question is asked now: every key there, empty
 *  where the document printed nothing, so nothing about it is read again. */
const newReading = (over: Record<string, unknown>) => {
  const r: Record<string, unknown> = {
    ...reading, holderName: "Brenton Evans", documentNumber: null, holderBirthDate: null,
    endorsements: [], units: [], capacities: [], isRecognition: false, recognises: null,
    assessedOn: null, conditions: null, evidenceKind: null, holder: null, ...over,
  };
  // Made now, so it lists its columns: the one code it carries, as sure as it was.
  if (!("columns" in over)) r.columns = r.qualCode ? [{ code: r.qualCode, confidence: r.codeConfidence || "high", why: null }] : [];
  return r;
};
/** A reading made before any of those keys was asked for: not one of them.
 *  It does carry the columns and the holder, though they were asked for
 *  later still: the one look every older reading gets for those is its own
 *  story (the "read again once, a few an hour" test), and these tests are
 *  about what the particulars and the back-fill pay for. */
const oldReading = (over: Record<string, unknown>) => {
  const r: Record<string, unknown> = { ...reading, holderName: "Brenton Evans", holder: null, ...over };
  for (const key of ["documentNumber", "holderBirthDate", "endorsements", "units", "capacities",
    "isRecognition", "recognises", "assessedOn", "conditions", "evidenceKind"]) delete r[key];
  if (!("columns" in over)) r.columns = r.qualCode ? [{ code: r.qualCode, confidence: r.codeConfidence || "high", why: null }] : [];
  return r;
};
const EVANS_P = { id: "p1", name: "EVANS, Brenton", aliases: ["bRENTON"] };

const particularsPortal = async (o: {
  people?: Record<string, unknown>[];
  fromCert?: Record<string, unknown>;
  certs?: PCert[];
  /** The model switched on (answered by hand in the test). */
  model?: boolean;
} = {}) => {
  const made = await oneManPortal();
  const doc = made.portal.doc();
  doc.people = o.people || [EVANS_P];
  if (o.fromCert) doc.particularsFromCert = o.fromCert;
  made.portal.state.data = JSON.stringify(doc);
  for (const c of o.certs || []) {
    const key = `opms/Brenton - OPMS/${c.checksum}.pdf`;
    await made.bucket.put(key, bytesOf("a scan"));
    made.portal.rows.push({ ...billysTicket, id: c.id, person: c.person || "EVANS, Brenton", checksum: c.checksum, blobKey: key,
      filename: `${c.checksum}.pdf`, sizeBytes: 6, qualCode: c.code, filedOn: c.filedOn || "2026-09-01" });
    if (c.reading) made.portal.blobs.set(`certificate-readings|r1/${c.checksum}.json`, JSON.stringify(c.reading));
  }
  made.bucket.made.length = 0;
  const env = { DB: made.portal.db, FILES: made.bucket, FILE_STORE: "r2",
    ...(o.model ? { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://model.test" } : {}) };
  setEnv(env as never);
  return { ...made, env };
};
const person = (portal: { doc: () => { people: Record<string, unknown>[] } }, id = "p1") => portal.doc().people.find((p) => p.id === id)!;
const hourly = (portal: { blobs: Map<string, string> }) => JSON.parse(portal.blobs.get("sync|last-hourly")!);

/** Which certificates a run put to the model, by filename - the refile has
 *  renamed them by then. */
const filesAsked = (model: { calls: string[] }) => model.calls.map((c) => /Filename: (.+?)\\n/.exec(c)?.[1]);
/** Evans's own Master ticket, which every one of these portals carries with
 *  a reading made before the endorsements were asked for - so the back-fill
 *  looks at it once, whatever else the hour does. Left out where the test is
 *  about the cards. */
const MASTER_FILE = "EVANS, Brenton - QL-01 Master.pdf";
const cardsAsked = (model: { calls: string[] }) => filesAsked(model).filter((f) => f !== MASTER_FILE);

/** The model, answered by which certificate it was sent. */
const modelByFile = (answer: (filename: string) => { status: number; body: string }) => {
  const box: { m: ReturnType<typeof modelAnswers> | null } = { m: null };
  box.m = modelAnswers((n) => answer(/Filename: (.+?)\\n/.exec(box.m!.calls[n - 1])?.[1] || ""));
  return box.m;
};

test("the hour fills an empty MSIC box off his newest card and his date of birth where his certificates agree, and an idle hour saves nothing", async () => {
  const { portal, env } = await particularsPortal({ certs: [
    { id: "v1", checksum: "old-card", code: "VS-01", filedOn: "2024-01-01",
      reading: newReading({ qualCode: "VS-01", documentNumber: "msic 1111", expiresOn: "2027-01-01", holderBirthDate: "1980-03-10" }) },
    { id: "v2", checksum: "new-card", code: "VS-01", filedOn: "2026-06-01",
      reading: newReading({ qualCode: "VS-01", documentNumber: " msic  2222 ", expiresOn: "2030-01-01", holderBirthDate: "1980-03-10" }) },
    { id: "m1", checksum: "medical", code: "QL-17",
      reading: newReading({ qualCode: "QL-17", holderName: "evans brenton", holderBirthDate: "1980-10-03" }) },
  ] });
  await worker.scheduled({} as never, env as never);
  assert.equal(person(portal).msic, "MSIC 2222", "the card that runs out last, as the box writes it");
  assert.equal(person(portal).dob, "1980-03-10", "two of his three certificates say 10 Mar 1980");
  assert.deepEqual(portal.doc().particularsFromCert, { p1: { msic: "MSIC 2222", dob: "1980-03-10" } }, "and what went in is remembered");
  assert.equal(hourly(portal).particularsRead, 0, "nothing was read again: every reading already carried both");

  const rev = portal.state.rev;
  await worker.scheduled({} as never, env as never);
  assert.equal(portal.state.rev, rev, "the next hour has nothing new: no save at all");
});

test("Update matrix fills the boxes too, and a save with nothing else to carry carries only them", async () => {
  const { portal } = await particularsPortal({ certs: [
    { id: "v1", checksum: "card", code: "VS-01", reading: newReading({ qualCode: "VS-01", documentNumber: "MSIC 3333", expiresOn: "2030-01-01" }) },
  ] });
  // The matrix already carries the certificates' date: only the box can move.
  const doc = portal.doc();
  doc.quals.rows[0][3][0] = "2031-05-26";
  doc.filledFromCert = { "EVANS, BRENTON::QL-01": true };
  portal.state.data = JSON.stringify(doc);
  const before = portal.doc();
  const res = await postRound({ by: "Matthew" });
  assert.equal(res.status, 200);
  const after = portal.doc();
  assert.equal(person(portal).msic, "MSIC 3333");
  const { people: _p, particularsFromCert: _f, ...rest } = after;
  const { people: _q, particularsFromCert: _g, ...was } = before;
  assert.deepEqual(rest, was, "nothing else on the document moved - no history line, no stamp");
});

test("a box somebody typed is left as typed, and a renewed card's number replaces the old card's", async () => {
  const typed = await particularsPortal({
    people: [{ ...EVANS_P, msic: "TYPED 1", dob: "" }],
    certs: [{ id: "v1", checksum: "card", code: "VS-01",
      reading: newReading({ qualCode: "VS-01", documentNumber: "MSIC 1111", expiresOn: "2027-01-01", holderBirthDate: "1980-03-10" }) }],
  });
  await worker.scheduled({} as never, typed.env as never);
  assert.equal(person(typed.portal).msic, "TYPED 1", "typed by hand: left as typed");
  assert.equal(person(typed.portal).dob, "1980-03-10", "the empty box beside it is filled");
  assert.deepEqual(typed.portal.doc().particularsFromCert, { p1: { dob: "1980-03-10" } }, "the typed box is not the certificates'");

  const renewed = await particularsPortal({
    people: [{ ...EVANS_P, msic: "MSIC 1111" }],
    fromCert: { p1: { msic: "MSIC 1111" } },
    certs: [
      { id: "v1", checksum: "old-card", code: "VS-01", reading: newReading({ qualCode: "VS-01", documentNumber: "MSIC 1111", expiresOn: "2027-01-01" }) },
      { id: "v2", checksum: "new-card", code: "VS-01", reading: newReading({ qualCode: "VS-01", documentNumber: "MSIC 2222", expiresOn: "2031-01-01" }) },
    ],
  });
  await worker.scheduled({} as never, renewed.env as never);
  assert.equal(person(renewed.portal).msic, "MSIC 2222", "the box held the old card's number as the certificates put it: the new card's replaces it");
  assert.deepEqual(renewed.portal.doc().particularsFromCert, { p1: { msic: "MSIC 2222", was: { msic: ["MSIC 1111"] } } });
});

test("a card filed under one man and printed in another's name gives neither of them anything", async () => {
  const { portal, env } = await particularsPortal({
    people: [EVANS_P, { id: "p2", name: "SITTIYOS, Kachin", aliases: [] }],
    certs: [{ id: "v1", checksum: "kachins-card", code: "VS-01",
      reading: newReading({ qualCode: "VS-01", holderName: "Kachin Sittiyos", documentNumber: "MSIC 9999", expiresOn: "2030-01-01", holderBirthDate: "1975-05-05" }) }],
  });
  await worker.scheduled({} as never, env as never);
  assert.equal(person(portal).msic, undefined, "not Evans's: the name on it is Kachin's");
  assert.equal(person(portal).dob, undefined);
  assert.equal(person(portal, "p2").msic, undefined, "not Kachin's either: it is not filed under him");
  assert.equal(portal.doc().particularsFromCert, undefined, "nothing written");
});

test("the readings made before are read again once for the particulars, keep everything else they said, and are never read again", async () => {
  const { portal, env } = await particularsPortal({ model: true, certs: [
    { id: "v1", checksum: "card", code: "VS-01", reading: oldReading({ qualCode: "VS-01", expiresOn: "2030-01-01" }) },
    { id: "m1", checksum: "medical", code: "QL-17", reading: oldReading({ qualCode: "QL-17", expiresOn: "2027-01-01" }) },
  ] });
  // Evans's Master ticket (evans-master, from oneManPortal) was read before too.
  const model = modelByFile((file) => ({ status: 200, body: readingStream(
    file === "card.pdf" ? { ...reading, holderName: "Brenton Evans", documentNumber: "msic 4444", expiresOn: "2099-01-01" }
      : file === "master.pdf" ? { ...reading, holderName: "Brenton Evans", holderBirthDate: "1980-03-10", expiresOn: "2099-01-01" }
        : { ...reading, holderName: "Brenton Evans", holderBirthDate: "1980-03-10" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    model.restore();
  }
  assert.equal(model.calls.length, 2, "the card for its number, the Master ticket for his date of birth - the medical not needed");
  assert.equal(hourly(portal).particularsRead, 2, "the count is on the hour's record");
  const card = JSON.parse(portal.blobs.get("certificate-readings|r1/card.json")!);
  assert.equal(card.documentNumber, "msic 4444");
  // The first reading's "2030-01-01" as the card runs: the last day of the month it prints (msicExpiry, 27 Sep 2026).
  assert.equal(card.expiresOn, "2030-01-31", "the second look moved nothing else: the date the matrix reads is the first reading's month, never the second look's 2099");
  assert.equal(card.version, "r1");
  assert.equal(JSON.parse(portal.blobs.get("certificate-readings|r1/evans-master.json")!).holderBirthDate, "1980-03-10");
  assert.equal("holderBirthDate" in JSON.parse(portal.blobs.get("certificate-readings|r1/medical.json")!), false, "the medical was never asked");
  assert.equal(person(portal).msic, "MSIC 4444", "and the round filled the boxes the same hour");
  assert.equal(person(portal).dob, "1980-03-10");

  /* The next hour his boxes are filled and the cards are spent, so nothing
     is asked for them. His medical is asked once, and only once: it was read
     before the question asked for the examination's own date and the
     conditions printed on it (MO76 s 16(1), s 7(1)(b)), and it is the
     document that prints them. */
  const again = modelByFile(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans", assessedOn: "2026-02-10", conditions: "daylight only" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    again.restore();
  }
  // Named as the refile named it on the first hour.
  assert.deepEqual(filesAsked(again), ["EVANS, Brenton - QL-17 Medical.pdf"], "the medical, for its own dates and conditions");
  const medical = JSON.parse(portal.blobs.get("certificate-readings|r1/medical.json")!);
  assert.deepEqual([medical.assessedOn, medical.conditions], ["2026-02-10", "daylight only"]);
  assert.equal(medical.expiresOn, "2027-01-01", "and the date the matrix reads is still the first reading's");

  const third = modelByFile(() => ({ status: 200, body: readingStream(reading) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    third.restore();
  }
  assert.equal(third.calls.length, 0, "the hour after that asks the model nothing at all");
  assert.equal(hourly(portal).particularsRead, 0);
});

test("the back-fill looks once at the certificates that can answer for the keys that came after the particulars, and at nothing else", async () => {
  /* Both boxes typed, so nothing is read for them: what is read is read for
     the keys the readings are missing. A ticket and a training statement can
     print endorsements and unit codes; a document titled a recognition can
     print the certificate behind it; the medical and the near-coastal cards
     print an assessment date and conditions. An induction certificate can
     print none of those, and is not paid for - and no certificate is read
     for the alternative evidence alone: that rides along. */
  const { portal, env } = await particularsPortal({ model: true,
    people: [{ ...EVANS_P, msic: "TYPED 1", dob: "1980-01-01" }],
    certs: [
      { id: "r1", checksum: "recognition", code: "QL-14", reading: oldReading({ qualCode: "QL-14", certificateTitle: "Certificate of Recognition of GMDSS" }) },
      { id: "s1", checksum: "first-aid", code: "QL-18", reading: oldReading({ qualCode: "QL-18" }) },
      { id: "n1", checksum: "nc-card", code: "QL-03", reading: oldReading({ qualCode: "QL-03" }) },
      { id: "i1", checksum: "induction", code: "PI-01", reading: oldReading({ qualCode: "PI-01" }) },
      { id: "v1", checksum: "card", code: "VS-01", reading: newReading({ qualCode: "VS-01" }) },
    ] });
  const model = modelByFile((file) => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans",
    endorsements: [{ text: "II/2 (incl. generic ECDIS)", until: null }], units: ["HLTAID011", "HLTAID015"],
    isRecognition: /recognition/i.test(file), assessedOn: "2026-02-10", conditions: "daylight only", evidenceKind: "extension" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    model.restore();
  }
  assert.deepEqual(filesAsked(model).sort(), ["EVANS, Brenton - QL-01 Master.pdf", "first-aid.pdf", "nc-card.pdf", "recognition.pdf"],
    "his ticket, the near-coastal card, the recognition and the statement - not the induction, and not the card read since");
  const stored = (checksum: string) => JSON.parse(portal.blobs.get(`certificate-readings|r1/${checksum}.json`)!);
  assert.deepEqual(stored("first-aid").units, ["HLTAID011", "HLTAID015"], "the statement's unit codes");
  assert.deepEqual(stored("first-aid").endorsements, [{ text: "II/2 (incl. generic ECDIS)", until: null }]);
  assert.equal(stored("recognition").isRecognition, true);
  assert.equal(stored("nc-card").conditions, "daylight only", "the near-coastal card's printed condition");
  assert.equal(stored("nc-card").assessedOn, "2026-02-10");
  assert.equal(stored("nc-card").evidenceKind, "extension", "and the evidence key rides along with it");
  assert.equal("endorsements" in stored("induction"), false, "the induction was never asked");
  assert.equal(hourly(portal).particularsRead, 4);
  assert.ok(model.calls.every((c) => /high risk work licence/i.test(c)), "the question asks for the classes printed on a high risk work licence");

  // And the next hour asks nothing: every key they were missing is there.
  const again = modelByFile(() => ({ status: 200, body: readingStream(reading) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    again.restore();
  }
  assert.equal(again.calls.length, 0);
});

test("the back-fill looks once at a high risk work licence, named for a column or not, for the classes it prints", async () => {
  /* Seventeen licences on file print several classes on one card and were
     read before the units were asked for; twelve of them are named for no
     column at all, so a pass that goes by the certificate's column would
     never reach them. A licence is known by its title, and by the two
     columns the vessel file reads the classes into. */
  const { portal, env } = await particularsPortal({ model: true,
    people: [{ ...EVANS_P, msic: "TYPED 1", dob: "1980-01-01" }],
    certs: [
      { id: "h1", checksum: "hrwl-unnamed", code: null,
        reading: oldReading({ qualCode: null, codeConfidence: "low", certificateTitle: "National Licence to Perform High Risk Work" }) },
      { id: "h2", checksum: "hrwl-tagged", code: "HR-01", reading: oldReading({ qualCode: "HR-01", certificateTitle: "Licence to Perform High Risk Work" }) },
      { id: "h3", checksum: "hrwl-read", code: null,
        reading: newReading({ qualCode: null, codeConfidence: "low", certificateTitle: "Licence to Perform High Risk Work", units: ["LF"] }) },
    ] });
  const model = modelByFile(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans", qualCode: null,
    certificateTitle: "Licence to Perform High Risk Work", endorsements: [], units: ["C6", "DG", "LF", "RB", "WP"] }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    model.restore();
  }
  const stored = (checksum: string) => JSON.parse(portal.blobs.get(`certificate-readings|r1/${checksum}.json`)!);
  assert.deepEqual(stored("hrwl-unnamed").units, ["C6", "DG", "LF", "RB", "WP"], "the licence named for no column is read for its classes");
  assert.deepEqual(stored("hrwl-tagged").units, ["C6", "DG", "LF", "RB", "WP"], "and so is the one tagged for dogging");
  assert.deepEqual(stored("hrwl-read").units, ["LF"], "one read since the question asked for units is left as it was");
  assert.equal(hourly(portal).particularsRead, 3, "his Master ticket and the two licences, once each");
});

test("the back-fill looks once at a certificate of competency read before the capacities were asked for, and not at a statement", async () => {
  /* Evgeny's ticket prints Master and GMDSS Radio Operator as its
     capacities. A ticket read for its endorsements before the question
     asked for the capacities is looked at once more; a training statement,
     which prints no capacity, is not paid for. */
  const withoutCapacities = (over: Record<string, unknown>) => {
    const r = newReading(over);
    delete (r as Record<string, unknown>).capacities;
    return r;
  };
  const { portal, env } = await particularsPortal({ model: true,
    people: [{ ...EVANS_P, msic: "TYPED 1", dob: "1980-01-01" }],
    certs: [
      { id: "t2", checksum: "chief-mate", code: "QL-02",
        reading: withoutCapacities({ qualCode: "QL-02", endorsements: [{ text: "II/2", until: null }] }) },
      { id: "s1", checksum: "first-aid", code: "QL-18", reading: withoutCapacities({ qualCode: "QL-18", units: ["HLTAID011"] }) },
      { id: "t3", checksum: "master-read", code: "QL-01", reading: newReading({ qualCode: "QL-01", capacities: ["Master"] }) },
    ] });
  const model = modelByFile(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans",
    endorsements: [{ text: "II/2", until: null }], capacities: ["Chief Mate", "GMDSS Radio Operator"] }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    model.restore();
  }
  const stored = (checksum: string) => JSON.parse(portal.blobs.get(`certificate-readings|r1/${checksum}.json`)!);
  assert.deepEqual(stored("chief-mate").capacities, ["Chief Mate", "GMDSS Radio Operator"], "the ticket is read once for its capacities");
  assert.deepEqual(stored("chief-mate").endorsements, [{ text: "II/2", until: null }], "and the endorsements it already had are left as they were");
  assert.equal("capacities" in stored("first-aid"), false, "the statement was never asked: it prints no capacity");
  assert.deepEqual(stored("master-read").capacities, ["Master"], "one read since is left as it was");
  assert.equal(hourly(portal).particularsRead, 2, "his old Master ticket and the Chief Mate, once each");
});

test("a box somebody typed is never paid for: its certificates are not read again", async () => {
  const { portal, env } = await particularsPortal({ model: true,
    people: [{ ...EVANS_P, msic: "TYPED 1", dob: "1980-01-01" }],
    certs: [{ id: "v1", checksum: "card", code: "VS-01", reading: oldReading({ qualCode: "VS-01" }) }] });
  const model = modelByFile(() => ({ status: 200, body: readingStream(reading) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    model.restore();
  }
  /* His card is not looked at: both boxes were typed. His Master ticket is,
     once - not for the boxes, but because it is a certificate of competency
     read before the endorsements printed on it were asked for. */
  assert.equal(model.calls.filter((c) => c.includes("card.pdf")).length, 0, "nothing is paid for a typed box");
  assert.deepEqual(model.calls.map((c) => /Filename: (.+?)\\n/.exec(c)?.[1]), ["EVANS, Brenton - QL-01 Master.pdf"]);
});

test("no more than twenty certificates are read again in an hour; the rest wait for the next", async () => {
  const crew = Array.from({ length: 25 }, (_, i) => {
    const letters = String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26));
    return { id: `c${i}`, name: `CREW, ${letters}man`, aliases: [] as string[] };
  });
  const { portal, env } = await particularsPortal({ model: true, people: crew,
    certs: crew.map((p, i) => ({ id: `v${i}`, checksum: `card-${i}`, code: "VS-01", person: p.name,
      reading: oldReading({ qualCode: "VS-01", holderName: p.name }) })) });
  // The second look reads each card in its own man's name.
  const crewOn = (file: string) => crew[Number(/card-(\d+)/.exec(file)?.[1])]?.name ?? null;
  const first = modelByFile((file) => ({ status: 200, body: readingStream({ ...reading, holderName: crewOn(file), documentNumber: file }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    first.restore();
  }
  assert.equal(first.calls.length, 20, "twenty this hour");
  assert.equal(hourly(portal).particularsRead, 20);
  const second = modelByFile((file) => ({ status: 200, body: readingStream({ ...reading, holderName: crewOn(file), documentNumber: file }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    second.restore();
  }
  // His own Master ticket's older reading has its one look for the columns
  // and whose it is too, now there is room under the cap.
  assert.equal(second.calls.filter((c) => /card-\d+/.test(c)).length, 5, "the other five the next");
  assert.equal(portal.doc().people.filter((p: { msic?: string }) => p.msic).length, 25, "every box filled by then");
});

test("the account saying no stops the topping up: nothing stored, the line in red, and the round still runs", async () => {
  const { portal, env } = await particularsPortal({ model: true, certs: [
    { id: "v1", checksum: "card", code: "VS-01", reading: oldReading({ qualCode: "VS-01" }) },
  ] });
  const model = modelAnswers(() => ({ status: 400, body: CREDIT_BODY }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    model.restore();
  }
  assert.ok(model.calls.length >= 1 && model.calls.length <= 2, "no more asked once the account said no");
  const h = hourly(portal);
  assert.equal(h.readError, OUT_OF_CREDIT);
  assert.equal(h.particularsRead, 0);
  assert.equal(h.applied, 1, "the round still ran");
  assert.deepEqual(readingWrites(portal.db), [], "nothing stored against the certificates: they are asked again once there is credit");
  assert.equal("documentNumber" in JSON.parse(portal.blobs.get("certificate-readings|r1/card.json")!), false);
});

test("a card whose first look named nobody, read again and found in another man's name, gives the man it is filed under nothing", async () => {
  const { portal, env } = await particularsPortal({ model: true,
    people: [EVANS_P, { id: "p2", name: "SITTIYOS, Kachin", aliases: [] }],
    certs: [{ id: "k1", checksum: "kcard", code: "VS-01", reading: oldReading({ qualCode: "VS-01", holderName: null }) }] });
  const model = modelByFile((file) => ({ status: 200, body: readingStream(file === "kcard.pdf"
    ? { ...reading, holderName: "Kachin Sittiyos", qualCode: "VS-01", documentNumber: "MSIC 9999", holderBirthDate: "1975-05-05" }
    : { ...reading, holderName: "Brenton Evans" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    model.restore();
  }
  assert.ok(model.calls.some((c) => c.includes("kcard.pdf")), "the card was asked about");
  assert.equal(person(portal).msic, undefined, "Kachin's number is not put in Evans's box");
  assert.equal(person(portal).dob, undefined, "nor Kachin's date of birth");
  assert.equal(person(portal, "p2").msic, undefined, "nor in Kachin's: it is not filed under him");
  const kept = JSON.parse(portal.blobs.get("certificate-readings|r1/kcard.json")!);
  assert.deepEqual([kept.holderName, kept.documentNumber, kept.holderBirthDate, kept.particularsAsked], [null, null, null, true],
    "the reading carries both keys, null, so it is not asked again; the other man's name is not kept, so nothing is moved on it");
  assert.equal(portal.rows.find((r: { id?: unknown }) => r.id === "k1")!.person, "EVANS, Brenton", "the certificate is where it was filed");

  const again = modelByFile(() => ({ status: 200, body: readingStream(reading) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    again.restore();
  }
  assert.equal(again.calls.filter((c) => c.includes("kcard.pdf")).length, 0, "and it is never asked again");
});

test("a card whose first look named nobody, read again and found in his own name, fills his box and keeps his name", async () => {
  const { portal, env } = await particularsPortal({ model: true,
    certs: [{ id: "v1", checksum: "card", code: "VS-01", reading: oldReading({ qualCode: "VS-01", holderName: null }) }] });
  const model = modelByFile((file) => ({ status: 200, body: readingStream(file === "card.pdf"
    ? { ...reading, holderName: "Brenton Evans", qualCode: "VS-01", documentNumber: "MSIC 5555" }
    : { ...reading, holderName: "Brenton Evans" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    model.restore();
  }
  assert.equal(person(portal).msic, "MSIC 5555");
  assert.equal(JSON.parse(portal.blobs.get("certificate-readings|r1/card.json")!).holderName, "Brenton Evans",
    "the name the second look read is kept, so the rule can see whose card it is");
});

test("his date of birth is looked for on three certificates at most, and not again the next hour", async () => {
  // Evans's Master ticket and four more, all read before the question was asked.
  const { portal, env } = await particularsPortal({ model: true,
    certs: ["QL-02", "QL-03", "QL-04", "QL-05"].map((code, i) => ({ id: `t${i}`, checksum: `ticket-${i}`, code, reading: oldReading({ qualCode: code }) })) });
  const model = modelByFile(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    model.restore();
  }
  /* Three for his date of birth and no more - and the other two tickets read
     once each all the same, because each was read before the endorsements
     printed on it were asked for. Five reads, five certificates, one look
     apiece: what the same one question says about his date of birth on those
     two is written down without being paid for twice. */
  assert.equal(model.calls.length, 5, "three asked for his date of birth, and the other two tickets once each for the keys they are missing");
  assert.equal(hourly(portal).particularsRead, 5);
  const next = modelByFile(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    next.restore();
  }
  assert.equal(next.calls.length, 0, "the next hour asks nothing: his three are spent");
});

test("a ticket uploaded since that prints no date of birth does not end the search for it", async () => {
  const { portal, env } = await particularsPortal({ model: true, certs: [
    { id: "n1", checksum: "first-aid", code: "QL-18", reading: newReading({ qualCode: "QL-18" }) },
    { id: "m1", checksum: "medical", code: "QL-17", reading: oldReading({ qualCode: "QL-17" }) },
  ] });
  const model = modelByFile((file) => ({ status: 200, body: readingStream(/medical/i.test(file)
    ? { ...reading, holderName: "Brenton Evans", holderBirthDate: "1980-03-10" }
    : { ...reading, holderName: "Brenton Evans" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    model.restore();
  }
  assert.equal(model.calls.length, 2, "his Master ticket, then his medical");
  assert.equal(model.calls.filter((c) => c.includes("first-aid.pdf")).length, 0, "the new ticket already said it prints none");
  assert.equal(person(portal).dob, "1980-03-10", "the medical's date goes in");
});

test("the topping up starts nothing once the hour's time is up, and asks nothing about a card in another man's name", async () => {
  const codes = vessel.qualColumns.map((c) => [c[0], c[1]] as [string, string]);
  await particularsPortal({ model: true,
    certs: [{ id: "t1", checksum: "ticket-2", code: "QL-02", reading: oldReading({ qualCode: "QL-02" }) }] });
  const model = modelByFile(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans" }) }));
  try {
    const none = await quiet(() => topUpParticulars(codes, { cap: 20, timeLeft: () => false }));
    assert.equal(none.read, 0);
    assert.equal(model.calls.length, 0, "no time from the start: nothing asked");
    let looks = 0;
    const one = await quiet(() => topUpParticulars(codes, { cap: 20, timeLeft: () => ++looks <= 2 }));
    assert.equal(model.calls.length, 1, "time ran out after his first certificate: his second is not started");
    assert.equal(one.read, 1);
  } finally {
    model.restore();
  }

  await particularsPortal({ model: true,
    people: [{ ...EVANS_P, dob: "1980-01-01" }, { id: "p2", name: "SITTIYOS, Kachin", aliases: [] }],
    certs: [{ id: "k1", checksum: "kcard", code: "VS-01", reading: oldReading({ qualCode: "VS-01", holderName: "Kachin Sittiyos" }) }] });
  const other = modelByFile(() => ({ status: 200, body: readingStream(reading) }));
  try {
    // Only his own Master ticket, for the keys it is missing: nothing at all
    // for the card, for either man.
    const out = await quiet(() => topUpParticulars(codes, { cap: 20, timeLeft: () => true }));
    assert.equal(out.read, 1);
  } finally {
    other.restore();
  }
  assert.equal(other.calls.filter((c) => c.includes("kcard.pdf")).length, 0,
    "filed under Evans, printed in Kachin's name: not worth paying to ask about for either");
  // The pass is called here on its own, so nothing has renamed his ticket.
  assert.deepEqual(filesAsked(other), ["master.pdf"]);
});

test("a reading read again that the store will not keep costs that certificate its turn, and the rest go on", async () => {
  const { portal, env } = await particularsPortal({ model: true,
    people: [{ ...EVANS_P, dob: "1980-01-01" }, { id: "p2", name: "SITTIYOS, Kachin", aliases: [], dob: "1975-05-05" }],
    certs: [
      { id: "v1", checksum: "bad", code: "VS-01", reading: oldReading({ qualCode: "VS-01" }) },
      { id: "v2", checksum: "good", code: "VS-01", person: "SITTIYOS, Kachin", reading: oldReading({ qualCode: "VS-01", holderName: "Kachin Sittiyos" }) },
    ] });
  // The store refuses the one write: the bad card's reading.
  type Stmt = { bind: (...a: unknown[]) => Stmt; run: () => Promise<unknown> };
  const db = portal.db as unknown as { prepare: (sql: string) => Stmt };
  const prepare = db.prepare;
  db.prepare = (sql: string) => {
    const st = prepare(sql);
    if (!/^INSERT INTO blobs/.test(sql)) return st;
    return { ...st, bind: (...args: unknown[]) => {
      const bound = st.bind(...args);
      if (args[1] !== "r1/bad.json") return bound;
      return { ...bound, run: async () => { throw new Error("the store refused the write"); } };
    } };
  };
  const model = modelByFile((file) => ({ status: 200, body: readingStream(file === "bad.pdf"
    ? { ...reading, holderName: "Brenton Evans", documentNumber: "MSIC 1" }
    : { ...reading, holderName: "Kachin Sittiyos", documentNumber: "MSIC 2" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    model.restore();
    db.prepare = prepare;
  }
  // The two cards, and his Master ticket once for the keys it is missing.
  assert.equal(model.calls.length, 3);
  const h = hourly(portal);
  assert.equal(h.particularsRead, 2, "the ones kept are counted - the card the store refused is not");
  assert.equal(h.readError, null, "a store fault is not the account's: the reading's line is not red");
  assert.equal(h.particularsError, null, "and the pass itself did not fail");
  assert.equal(person(portal, "p2").msic, "MSIC 2", "Kachin's box is filled");
  assert.equal(person(portal).msic, undefined, "Evans's waits for the next hour");
  assert.equal("documentNumber" in JSON.parse(portal.blobs.get("certificate-readings|r1/bad.json")!), false, "so his card is asked again then");
});

test("a fault in the topping up is its own line on the hour's record, not the reading's red, and the round still runs", async () => {
  const { portal, env } = await particularsPortal({ model: true,
    certs: [{ id: "v1", checksum: "card", code: "VS-01", reading: oldReading({ qualCode: "VS-01" }) }] });
  // The first statement the top-up itself asks for fails.
  type Stmt = Record<string, unknown>;
  const db = portal.db as unknown as { prepare: (sql: string) => Stmt };
  const prepare = db.prepare;
  let failed = false;
  db.prepare = (sql: string) => {
    const st = prepare(sql);
    if (failed || !String(new Error().stack).includes("topUpParticulars")) return st;
    failed = true;
    const refuse = async () => { throw new Error("the database is away"); };
    const broken: Stmt = { ...st, all: refuse, first: refuse, run: refuse, raw: refuse };
    broken.bind = () => broken;
    return broken;
  };
  const model = modelByFile(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    model.restore();
    db.prepare = prepare;
  }
  assert.ok(failed, "the top-up's statement was the one refused");
  const h = hourly(portal);
  assert.equal(h.particularsError, "the database is away");
  assert.equal(h.readError, null, "the certificate reading is not painted red for it");
  assert.equal(h.applied, 1, "the round still ran");
});

test("a date the rule throws out does not end the search for his date of birth: the next certificate is read and the box fills", async () => {
  // His medical, read since the question was asked, printed its issue date
  // where the birth date goes: six years ago, which no man's birth date is.
  // His Master ticket (evans-master, read before) prints the real one.
  const { portal, env } = await particularsPortal({ model: true, certs: [
    { id: "m1", checksum: "medical", code: "QL-17", reading: newReading({ qualCode: "QL-17", holderBirthDate: "2020-01-01" }) },
  ] });
  const model = modelByFile(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans", holderBirthDate: "1980-03-10" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, env as never));
  } finally {
    model.restore();
  }
  assert.equal(model.calls.length, 1, "the medical's date is no answer, so his Master ticket is read");
  assert.ok(model.calls[0].includes("Master.pdf"), "the Master ticket, as the refile named it");
  assert.equal(person(portal).dob, "1980-03-10", "and the box fills");
});

test("two dates that tie are no answer: the search goes on until a third certificate breaks the tie", async () => {
  // A tie already standing: the medical (read since) has the day and month
  // the wrong way round, the Chief Mate ticket (read since) has them right.
  // The Master ticket, read before, is read again and breaks it.
  const standing = await particularsPortal({ model: true, certs: [
    { id: "m1", checksum: "medical", code: "QL-17", reading: newReading({ qualCode: "QL-17", holderBirthDate: "1980-10-03" }) },
    { id: "t1", checksum: "chief-mate", code: "QL-02", reading: newReading({ qualCode: "QL-02", expiresOn: "2028-01-01", holderBirthDate: "1980-03-10" }) },
  ] });
  const one = modelByFile(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans", holderBirthDate: "1980-03-10" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, standing.env as never));
  } finally {
    one.restore();
  }
  assert.equal(one.calls.length, 1, "one each is no answer, so the Master ticket is read");
  assert.equal(person(standing.portal).dob, "1980-03-10", "two of three agree");

  // And the next hour asks nothing: the rule has its answer.
  const next = modelByFile(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, standing.env as never));
  } finally {
    next.restore();
  }
  assert.equal(next.calls.length, 0);
});

test("the card looked at for his number is the one the rule reads from: a newer card the first look could not name is looked at once, and then the newest card in his name without the number", async () => {
  // An older card in his name, read before the number was asked for; and a
  // newer card read since, with the key but no name the model could make out.
  const cards = (over: Record<string, unknown> = {}): PCert[] => [
    { id: "a", checksum: "old-named", code: "VS-01", filedOn: "2024-01-01", reading: oldReading({ qualCode: "VS-01", expiresOn: "2027-01-01" }) },
    { id: "b", checksum: "new-nameless", code: "VS-01", filedOn: "2026-06-01",
      reading: newReading({ qualCode: "VS-01", holderName: null, expiresOn: "2030-01-01", ...over }) },
  ];
  // His date of birth typed, so only the card is looked for.
  const two = [{ ...EVANS_P, dob: "1980-01-01" }, { id: "p2", name: "SITTIYOS, Kachin", aliases: [] }];
  const answer = (file: string, nameless: Record<string, unknown>) => ({ status: 200, body: readingStream(
    file === "new-nameless.pdf" ? { ...reading, qualCode: "VS-01", ...nameless } : { ...reading, qualCode: "VS-01", holderName: "Brenton Evans", documentNumber: "MSIC 1111" }) });

  // The nameless card turns out to be another man's: the older card in his name is read next, and its number goes in.
  const other = await particularsPortal({ model: true, people: two, certs: cards() });
  const m1 = modelByFile((file) => answer(file, { holderName: "Kachin Sittiyos", documentNumber: "MSIC 9999" }));
  try {
    await quiet(() => worker.scheduled({} as never, other.env as never));
  } finally {
    m1.restore();
  }
  assert.deepEqual(cardsAsked(m1), ["new-nameless.pdf", "old-named.pdf"], "the newer card first, then the named one");
  assert.equal(person(other.portal).msic, "MSIC 1111");
  assert.equal(person(other.portal, "p2").msic, undefined);
  const b = JSON.parse(other.portal.blobs.get("certificate-readings|r1/new-nameless.json")!);
  assert.deepEqual([b.holderName, b.documentNumber, b.particularsAsked], [null, null, true], "the other man's name and number are not kept, and it is not looked at again");

  // The nameless card turns out to be his: it is the card he holds now, so the older card is not read.
  const his = await particularsPortal({ model: true, people: two, certs: cards() });
  const m2 = modelByFile((file) => answer(file, { holderName: "Brenton Evans", documentNumber: "MSIC 2222" }));
  try {
    await quiet(() => worker.scheduled({} as never, his.env as never));
  } finally {
    m2.restore();
  }
  assert.deepEqual(cardsAsked(m2), ["new-nameless.pdf"], "his newest card, named now, has the number: the older card is not needed");
  assert.equal(person(his.portal).msic, "MSIC 2222");

  // The nameless card was looked at once already (another man's, or unreadable): only the named card is read.
  const looked = await particularsPortal({ model: true, people: two, certs: cards({ documentNumber: null, particularsAsked: true }) });
  const m3 = modelByFile((file) => answer(file, {}));
  try {
    await quiet(() => worker.scheduled({} as never, looked.env as never));
  } finally {
    m3.restore();
  }
  assert.deepEqual(cardsAsked(m3), ["old-named.pdf"]);
  assert.equal(person(looked.portal).msic, "MSIC 1111");
});

test("an older card in his name is not read again once a newer card already carries the number the rule reads", async () => {
  /* The rule takes the number off the newest card printed in his name
     (particularsFor). The newer card carries it already, so the older card
     was read again for a number that could never be used: the box is filled
     from the newer card either way. His date of birth is typed, so the cards
     are all this hour has to look at - and his Master ticket, once, for the
     endorsements printed on it. */
  const two = [{ ...EVANS_P, msic: "MSIC 2222", dob: "1980-01-01" }];
  const older = (over: Record<string, unknown> = {}): PCert[] => [
    { id: "a", checksum: "old-named", code: "VS-01", filedOn: "2024-01-01",
      reading: oldReading({ qualCode: "VS-01", expiresOn: "2027-01-01", ...over }) },
    { id: "b", checksum: "new-numbered", code: "VS-01", filedOn: "2026-06-01",
      reading: newReading({ qualCode: "VS-01", documentNumber: "MSIC 2222", expiresOn: "2030-01-01" }) },
  ];
  const answered = await particularsPortal({ model: true, people: two, fromCert: { p1: { msic: "MSIC 2222" } }, certs: older() });
  const m1 = modelByFile(() => ({ status: 200, body: readingStream({ ...reading, qualCode: "VS-01", holderName: "Brenton Evans", documentNumber: "MSIC 1111" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, answered.env as never));
  } finally {
    m1.restore();
  }
  assert.deepEqual(cardsAsked(m1), [], "no card is read: the newer card is already the rule's answer");
  assert.equal(person(answered.portal).msic, "MSIC 2222");

  /* The other way round - the card without the number is the newer one - and
     it is read, because that is the card the rule reads from. */
  const wanted = await particularsPortal({ model: true, people: two, fromCert: { p1: { msic: "MSIC 2222" } }, certs: [
    { id: "a", checksum: "new-named", code: "VS-01", filedOn: "2026-06-01", reading: oldReading({ qualCode: "VS-01", expiresOn: "2031-01-01" }) },
    { id: "b", checksum: "old-numbered", code: "VS-01", filedOn: "2024-01-01",
      reading: newReading({ qualCode: "VS-01", documentNumber: "MSIC 2222", expiresOn: "2027-01-01" }) },
  ] });
  const m2 = modelByFile(() => ({ status: 200, body: readingStream({ ...reading, qualCode: "VS-01", holderName: "Brenton Evans", documentNumber: "MSIC 3333" }) }));
  try {
    await quiet(() => worker.scheduled({} as never, wanted.env as never));
  } finally {
    m2.restore();
  }
  assert.deepEqual(cardsAsked(m2), ["new-named.pdf"], "the newer card is read for its number");
  assert.equal(person(wanted.portal).msic, "MSIC 3333", "and the box takes the card he holds now");
});

/* ------------------------------------------------------------------------ *
 * One certificate fills every column it covers, in the round and on the
 * page's cells. The rule is source/shared/covers.js and the table is the
 * vessel file's; these are the wiring - that a covered column joins the same
 * contest as any other certificate, links to the certificate that filled it,
 * and is claimed, so a certificate taken off the books takes its covered
 * dates with it like any other.
 * ------------------------------------------------------------------------ */

/** Brenton Evans's new-style AMSA Master certificate of competency, as the
 *  reading lists what is printed on it. The ECDIS line is inside the II/2
 *  endorsement; the VI/2 (1) line is survival craft, not fast rescue craft. */
const evansCoC = {
  version: "r1", at: "", model: "", readable: true,
  holderName: "Brenton Evans", certificateTitle: "Certificate of Competency - Master", issuer: "AMSA",
  issuedOn: "2026-05-26", expiresOn: "2031-05-26", neverExpires: false,
  qualCode: "QL-01", codeConfidence: "high", notes: null,
  endorsements: [
    { text: "II/2 (incl. generic ECDIS)", until: null },
    { text: "II/5", until: null },
    { text: "VI/1 s. A-VI/1 (2)", until: null },
    { text: "VI/2 (1) s. A-VI/2 (1-4)", until: null },
    { text: "VI/4 (1) s. A-VI/4 (1-3)", until: null },
    { text: "IV/2", until: null },
  ],
  units: [] as string[],
};

const coversCols = [
  ["QL-01", "Master", "Qualification"],
  ["QL-12", "Certificate of Safety Training (COST)", "Qualification"],
  ["QL-13", "ECDIS", "Qualification"],
  ["QL-14", "GMDSS", "Qualification"],
  ["QL-16", "Fast Rescue Craft (FRC)", "Qualification"],
] as [string, string, string][];

const coversMatrix = {
  cols: coversCols,
  rows: [["EVANS, Brenton", "Master", "", ["", "", "", "", ""]]] as [string, string, string, string[]][],
};

/** A database holding the certificates given, each with its reading, and the
 *  crew register the evidence rule reads names through. */
const coversDb = (certs: { row: Partial<Row>; reading: unknown }[], people: unknown[] = [{ name: "EVANS, Brenton", aliases: [] }], periods?: unknown[]) => {
  const rows = certs.map((c, i) => ({
    ...billysTicket, id: "cov" + i, person: "EVANS, Brenton", folder: "evans",
    bucket: "evans", checksum: "sum" + i, filename: "cert" + i + ".pdf",
    blobKey: "opms/Evans - OPMS/cert" + i + ".pdf", qualCode: null, expiresOn: null,
    ...c.row,
  }));
  const readings = certs.map((c, i) => ({ key: "r1/sum" + i + ".json", value: JSON.stringify(c.reading) }));
  /* The office's validity periods, where a test gives them: read off the
     skills matrix filed on the portal, as the round and the page read them. */
  const skills = periods ? [{ ...billysTicket, id: "sk", category: "skills-matrix", filename: "skills.xlsx", removedAt: null, createdAt: 1 }] : [];
  const blobs = periods
    ? [...readings, { key: "m2/validity-sk.json", value: JSON.stringify({ reading: { readable: true, periods } }) }]
    : readings;
  const orm = drizzleOn(skills);
  return fakeDb((sql, args) => {
    if (periods && /from "documents"/i.test(sql) && args.includes("skills-matrix")) return orm(sql, args);
    if (/FROM documents WHERE category = 'certificate'/.test(sql)) return { results: rows };
    if (/SELECT key, value FROM blobs/.test(sql)) return { results: readings };
    // The page's own dates ask for one reading at a time, by its key.
    if (/SELECT value FROM blobs/.test(sql)) return { results: blobs.filter((r) => args.includes(r.key)) };
    if (/UPDATE documents/.test(sql)) return { changes: 1 };
    if (/FROM portal_state/.test(sql)) return { results: [{ data: JSON.stringify({ people }), rev: 1 }] };
    return undefined;
  });
};
const evansOnly = asKnownPerson([{ name: "EVANS, Brenton", aliases: [] }]);

test("covers: one Master ticket fills the ECDIS column too, and nothing else on it fills anything", async () => {
  setEnv({ DB: coversDb([{ row: { qualCode: "QL-01" }, reading: evansCoC }]), FILE_STORE: "r2" } as never);
  const out = await compareMatrix(coversMatrix, null, evansOnly);
  const dates = Object.fromEntries(out.settled.map((s) => [s.code, s.value]));
  assert.deepEqual(dates, { "QL-01": "2031-05-26", "QL-13": "2031-05-26" },
    "his own column and the ECDIS the endorsement covers, both dated as the ticket is dated");
  assert.deepEqual(out.claimed.sort(), ["EVANS, BRENTON::QL-01", "EVANS, BRENTON::QL-13"],
    "the covered cell is claimed, so taking the certificate off the books takes its date off too");
  for (const code of ["QL-12", "QL-14", "QL-16"]) {
    assert.equal(out.settled.some((s) => s.code === code), false,
      code + " is filled by its own certificate and never by a line on this one");
  }
});

test("covers: a standalone ECDIS certificate joins the same contest, and the longer of the two wins", async () => {
  const ecdis = (expiresOn: string) => ({
    ...evansCoC, certificateTitle: "ECDIS", qualCode: "QL-13", expiresOn,
    endorsements: [] as { text: string; until: string | null }[],
  });
  /* Its own certificate runs the longer: the cell takes its date and links to
     it, exactly as two certificates for one column are decided today. */
  setEnv({ DB: coversDb([
    { row: { id: "coc", qualCode: "QL-01" }, reading: evansCoC },
    { row: { id: "own", qualCode: "QL-13" }, reading: ecdis("2033-01-01") },
  ]), FILE_STORE: "r2" } as never);
  let out = await compareMatrix(coversMatrix, null, evansOnly);
  assert.equal(out.settled.find((s) => s.code === "QL-13")!.value, "2033-01-01");
  assert.equal(out.items.find((i) => i.code === "QL-13")!.certificate!.id, "own",
    "and the cell links to the ECDIS certificate itself");

  // The covered date runs the longer: it wins, and the cell links to the ticket.
  setEnv({ DB: coversDb([
    { row: { id: "coc", qualCode: "QL-01" }, reading: evansCoC },
    { row: { id: "own", qualCode: "QL-13" }, reading: ecdis("2028-01-01") },
  ]), FILE_STORE: "r2" } as never);
  out = await compareMatrix(coversMatrix, null, evansOnly);
  assert.equal(out.settled.find((s) => s.code === "QL-13")!.value, "2031-05-26");
  assert.equal(out.items.find((i) => i.code === "QL-13")!.certificate!.id, "coc",
    "the covered column links to the certificate that filled it");
});

test("covers: a ticket printed in another man's name fills nothing, its own column or any other", async () => {
  setEnv({ DB: coversDb([
    { row: { qualCode: "QL-01" }, reading: { ...evansCoC, holderName: "Kachin Sittiyos" } },
  ]), FILE_STORE: "r2" } as never);
  const out = await compareMatrix(coversMatrix, null, evansOnly);
  assert.deepEqual(out.settled, [], "the holder check comes first, and it covers nothing");
  assert.equal(out.notes.filter((n) => n.kind === "name-mismatch").length, 1);
});

test("covers: a training statement's unit codes fill their own columns, and the round writes no read code for them", async () => {
  const cols = [
    ["QL-18", "Provide First Aid - HLTAID011", "Qualification"],
    ["QL-19", "Adv Resuscitation and Oxygen Therapy - HLTAID015", "Qualification"],
  ] as [string, string, string][];
  const statement = {
    ...evansCoC, certificateTitle: "Statement of Attainment", qualCode: "QL-18",
    expiresOn: "2029-06-30", endorsements: [], units: ["HLTAID011", "HLTAID015"],
  };
  const db = coversDb([{ row: { qualCode: "QL-18" }, reading: statement }]);
  setEnv({ DB: db, FILE_STORE: "r2" } as never);
  const out = await compareMatrix(
    { cols, rows: [["EVANS, Brenton", "Master", "", ["", ""]]] as [string, string, string, string[]][] },
    null, evansOnly,
  );
  assert.deepEqual(out.settled.map((s) => [s.code, s.value]).sort(),
    [["QL-18", "2029-06-30"], ["QL-19", "2029-06-30"]],
    "one statement, both columns, its own date");
  const noted = db.asked.filter((a) => /UPDATE documents\s+SET read_code/.test(a.sql));
  assert.deepEqual(noted.map((n) => n.args[1]), ["QL-18"],
    "the row's own read code is written once and the covered column never writes over it");
});

test("covers: a high risk work licence with no column of its own still fills the columns its classes cover", async () => {
  /* The licence prints "DG, LF, RI, CV" and the model rightly names no
     single column for it, so it holds no cell of its own - and until now
     only a certificate holding its own column covered anything, which left
     every one of the seventeen licences filling nothing. The classes are
     printed codes: the reading lists them as units and the vessel file's
     rows read DG into HR-01 and CV into HR-02, dated as the licence is. */
  const cols = [
    ["HR-01", "HRWL - Dogging - Dogging (DG)", "High Risk Work Licence (HRWL)"],
    ["HR-02", "HRWL - Vehicle loading crane (CV)", "High Risk Work Licence (HRWL)"],
    ["PT-02", "Enter and Work in Confined Spaces - RIIWHS202E", "Permit to Work"],
  ] as [string, string, string][];
  const licence = {
    ...evansCoC, certificateTitle: "Licence to Perform High Risk Work", issuer: "WorkSafe WA",
    qualCode: null, codeConfidence: "low", issuedOn: "2025-04-01", expiresOn: "2030-04-01",
    endorsements: [], units: ["DG", "LF", "RI", "CV"],
  };
  const db = coversDb([{ row: { id: "hrwl", qualCode: null }, reading: licence }]);
  setEnv({ DB: db, FILE_STORE: "r2" } as never);
  const out = await compareMatrix(
    { cols, rows: [["EVANS, Brenton", "GPH", "", ["", "", ""]]] as [string, string, string, string[]][] },
    null, evansOnly,
  );
  assert.deepEqual(out.settled.map((s) => [s.code, s.value]).sort(), [["HR-01", "2030-04-01"], ["HR-02", "2030-04-01"]],
    "dogging and the crane, both to the licence's own expiry, and nothing on a column its classes do not name");
  assert.deepEqual(out.claimed.sort(), ["EVANS, BRENTON::HR-01", "EVANS, BRENTON::HR-02"], "claimed, so taking the licence off takes its dates off");
  assert.equal(out.notes.some((n) => n.kind === "no-code"), false, "a licence that covers two columns is not 'nothing on the matrix'");
  assert.equal(out.items.find((i) => i.code === "HR-01")!.certificate!.id, "hrwl", "the cell links to the licence");
  assert.deepEqual(db.asked.filter((a) => /UPDATE documents\s+SET read_code/.test(a.sql)), [],
    "no read code is written for it: the licence IS no one column");

  // The page's own dates say the same, or the grid and the round would disagree.
  setEnv({ DB: coversDb([{ row: { id: "hrwl", qualCode: null }, reading: licence }]), FILE_STORE: "r2" } as never);
  const page = await certificateStanding();
  assert.deepEqual(page.dates.map((d) => [d.code, d.expires, d.fileId, d.covered]).sort(),
    [["HR-01", "2030-04-01", "hrwl", true], ["HR-02", "2030-04-01", "hrwl", true]]);

  // A licence printing neither class, and no column of its own, is still nothing on the matrix.
  setEnv({ DB: coversDb([{ row: { id: "hrwl", qualCode: null }, reading: { ...licence, units: ["LF", "WP"] } }]), FILE_STORE: "r2" } as never);
  const none = await compareMatrix(
    { cols, rows: [["EVANS, Brenton", "GPH", "", ["", "", ""]]] as [string, string, string, string[]][] },
    null, evansOnly,
  );
  assert.deepEqual(none.settled, []);
  assert.equal(none.notes.filter((n) => n.kind === "no-code").length, 1, "and the account of the run says so");

  // One printed in another man's name covers nothing, its own column or any other.
  setEnv({ DB: coversDb([{ row: { id: "hrwl", qualCode: null }, reading: { ...licence, holderName: "Kachin Sittiyos" } }]), FILE_STORE: "r2" } as never);
  const hers = await compareMatrix(
    { cols, rows: [["EVANS, Brenton", "GPH", "", ["", "", ""]]] as [string, string, string, string[]][] },
    null, evansOnly,
  );
  assert.deepEqual(hers.settled, []);
  assert.equal(hers.notes.filter((n) => n.kind === "name-mismatch").length, 1);
});

test("covers: the page's own dates carry the covered column, linked to the certificate that filled it", async () => {
  setEnv({ DB: coversDb([{ row: { id: "coc", qualCode: "QL-01" }, reading: evansCoC }]), FILE_STORE: "r2" } as never);
  const out = await certificateStanding();
  const by = Object.fromEntries(out.dates.map((d) => [d.code, d]));
  assert.deepEqual(Object.keys(by).sort(), ["QL-01", "QL-13"],
    "the cells the page draws carry the covered column too, or the grid and the round would disagree");
  assert.equal(by["QL-13"].expires, "2031-05-26");
  assert.equal(by["QL-13"].fileId, "coc", "Open on the ECDIS cell opens the ticket that covers it");
  assert.equal(by["QL-13"].issued, "2026-05-26", "with the covering certificate's own issue date");
});

/* ------------------------------------------------------------------------ *
 * The certificate of recognition in a cell. A foreign ticket counts on this
 * vessel only through AMSA's recognition of it (MO505 s 4, s 7(2)), and the
 * recognition can never outlive the certificate behind it.
 * ------------------------------------------------------------------------ */
const recognitionOf = (over: Record<string, unknown> = {}) => ({
  ...evansCoC, certificateTitle: "Certificate of Recognition - Master",
  expiresOn: "2030-06-30", endorsements: [], units: [],
  isRecognition: true,
  recognises: { authority: "MCA", country: "United Kingdom", number: "UK-9921", expiresOn: "2029-03-01" },
  ...over,
});

test("recognition: the cell takes the earlier of the recognition and the certificate it recognises", async () => {
  setEnv({ DB: coversDb([{ row: { id: "rec", qualCode: "QL-01" }, reading: recognitionOf() }]), FILE_STORE: "r2" } as never);
  const out = await compareMatrix(coversMatrix, null, evansOnly);
  assert.deepEqual(out.settled, [{ person: "EVANS, Brenton", code: "QL-01", value: "2029-03-01" }],
    "the foreign certificate runs out first, so that is the day the cell stops counting");
  assert.equal(out.items.find((i) => i.code === "QL-01")!.certificate!.id, "rec",
    "and the cell opens the recognition, which is the document that counts here");
});

test("recognition: the foreign certificate on file beats what the recognition printed, and the cell still opens the recognition", async () => {
  const foreign = {
    ...evansCoC, certificateTitle: "Master (MCA)", issuer: "MCA",
    expiresOn: "2027-05-05", endorsements: [], units: [], isRecognition: false,
  };
  setEnv({ DB: coversDb([
    { row: { id: "foreign", qualCode: "QL-01" }, reading: foreign },
    { row: { id: "rec", qualCode: "QL-01" }, reading: recognitionOf() },
  ]), FILE_STORE: "r2" } as never);
  const out = await compareMatrix(coversMatrix, null, evansOnly);
  assert.deepEqual(out.settled, [{ person: "EVANS, Brenton", code: "QL-01", value: "2027-05-05" }],
    "the certificate in hand runs shorter than what the recognition printed, so it governs");
  assert.equal(out.items.find((i) => i.code === "QL-01")!.certificate!.id, "rec",
    "the recognition is the document that counts, whichever of the two runs the longer");
  /* The foreign certificate is no double up: the cell's date is cut to it,
     and with it gone the recognition would run to what it printed. So the
     page's entry says it is the one behind the recognition, and the list on
     Documents leaves it out (27 Sep 2026). */
  setEnv({ DB: coversDb([
    { row: { id: "foreign", qualCode: "QL-01" }, reading: foreign },
    { row: { id: "rec", qualCode: "QL-01" }, reading: recognitionOf() },
  ]), FILE_STORE: "r2" } as never);
  const page = await certificateStanding();
  assert.deepEqual(page.dates.map((d) => [d.code, d.expires, d.fileId]), [["QL-01", "2027-05-05", "rec"]], "the page's cell: the recognition, cut to the foreign ticket");
  assert.deepEqual(page.superseded.map((s) => [s.fileId, s.code, s.behind, s.holds]), [["foreign", "QL-01", true, []]],
    "set aside as the certificate behind the recognition, holding nothing itself");
  // Filed the other way round, the same answer.
  setEnv({ DB: coversDb([
    { row: { id: "rec", qualCode: "QL-01" }, reading: recognitionOf() },
    { row: { id: "foreign", qualCode: "QL-01" }, reading: foreign },
  ]), FILE_STORE: "r2" } as never);
  assert.deepEqual((await certificateStanding()).superseded.map((s) => [s.fileId, s.behind]), [["foreign", true]]);
});

test("recognition: nothing is ever recognised into the safety training or the cook column", async () => {
  setEnv({ DB: coversDb([
    { row: { id: "rec", qualCode: "QL-12" }, reading: recognitionOf({ certificateTitle: "Certificate of Recognition - Basic Safety Training" }) },
  ]), FILE_STORE: "r2" } as never);
  const out = await compareMatrix(coversMatrix, null, evansOnly);
  assert.deepEqual(out.settled, [], "MO70 s 7(2)(b) does not let AMSA recognise a foreign basic safety certificate");
  assert.deepEqual(out.claimed, [], "and nothing claims the cell, so nothing of the office's is written over");
});

test("recognition: an endorsement on a recognition runs no longer than the foreign endorsement", async () => {
  /* MO70 s 37(4): the endorsement on a recognition runs for the remainder of
     the foreign certificate's. So the covered column takes the earlier-of
     rule the recognition's own column takes. */
  setEnv({ DB: coversDb([
    { row: { id: "rec", qualCode: "QL-01" }, reading: recognitionOf({ endorsements: [{ text: "II/2 (incl. generic ECDIS)", until: null }] }) },
  ]), FILE_STORE: "r2" } as never);
  const out = await compareMatrix(coversMatrix, null, evansOnly);
  assert.deepEqual(out.settled.map((s) => [s.code, s.value]).sort(),
    [["QL-01", "2029-03-01"], ["QL-13", "2029-03-01"]],
    "both the recognition's own column and the one it covers stop when the foreign certificate does");
});

test("recognition: where nothing is known about the certificate behind it, the cell says so", async () => {
  setEnv({ DB: coversDb([
    { row: { id: "rec", qualCode: "QL-01" }, reading: recognitionOf({ recognises: null }) },
  ]), FILE_STORE: "r2" } as never);
  const out = await certificateStanding();
  const one = out.dates.find((d) => d.code === "QL-01")!;
  assert.equal(one.expires, "2030-06-30", "the recognition's own date is all there is, so the cell takes it");
  assert.equal(one.recognition, true);
  assert.equal(one.foreignUnknown, true, "and the office is told the certificate behind it is not on the portal");

  setEnv({ DB: coversDb([{ row: { id: "rec", qualCode: "QL-01" }, reading: recognitionOf() }]), FILE_STORE: "r2" } as never);
  const told = await certificateStanding();
  const two = told.dates.find((d) => d.code === "QL-01")!;
  assert.equal(two.expires, "2029-03-01", "where it prints the foreign expiry, the earlier of the two governs on the page too");
  assert.equal(two.foreignUnknown, false);
});

/* ------------------------------------------------------------------------ *
 * The medical. A medical expires the moment a further one is issued
 * (MO76 s 16(3)), so of two on file the one ISSUED last governs - even where
 * the older one prints the later expiry. Taking the later date would put a
 * man to sea on a certificate a doctor has already replaced.
 * ------------------------------------------------------------------------ */
const medCols = [["QL-17", "AMSA Certificate of Medical Fitness - Form 303", "Qualification"]] as [string, string, string][];
const medMatrix = {
  cols: medCols,
  rows: [["EVANS, Brenton", "Master", "", [""]]] as [string, string, string, string[]][],
};
const medical = (over: Record<string, unknown>) => ({
  ...evansCoC, certificateTitle: "Certificate of Medical Fitness", qualCode: "QL-17",
  endorsements: [], units: [], assessedOn: null, conditions: null, ...over,
});

test("the medical: the one issued last governs, even where the older prints the later expiry", async () => {
  const certs = [
    // Issued first, runs to 2028. A full two-year certificate.
    { row: { id: "old", qualCode: "QL-17" }, reading: medical({ issuedOn: "2026-01-10", expiresOn: "2028-01-10" }) },
    // Issued after an injury: shorter, but it is the one in force.
    { row: { id: "new", qualCode: "QL-17" }, reading: medical({ issuedOn: "2026-06-02", expiresOn: "2027-06-02", conditions: "Fit for particular duties only" }) },
  ];
  setEnv({ DB: coversDb(certs), FILE_STORE: "r2" } as never);
  const out = await compareMatrix(medMatrix, null, evansOnly);
  assert.deepEqual(out.settled, [{ person: "EVANS, Brenton", code: "QL-17", value: "2027-06-02" }],
    "the medical issued last is the one in force, whatever the older one prints");
  assert.equal(out.items.find((i) => i.code === "QL-17")!.certificate!.id, "new");

  setEnv({ DB: coversDb(certs), FILE_STORE: "r2" } as never);
  const dates = await certificateStanding();
  const one = dates.dates.find((d) => d.code === "QL-17")!;
  assert.equal(one.expires, "2027-06-02", "and the page's cell agrees with the round");
  assert.equal(one.fileId, "new");
  assert.equal(one.conditions, "Fit for particular duties only",
    "the limitation printed on it rides along, for the certificate viewer");
});

test("the medical: the assessment date rides along, and a condition on any certificate does", async () => {
  setEnv({ DB: coversDb([
    { row: { id: "med", qualCode: "QL-17" }, reading: medical({ issuedOn: "2026-06-05", assessedOn: "2026-06-02", expiresOn: "2028-06-02" }) },
  ]), FILE_STORE: "r2" } as never);
  const out = await certificateStanding();
  const one = out.dates.find((d) => d.code === "QL-17")!;
  assert.equal(one.assessedOn, "2026-06-02", "MO76 s 16(1) runs its term from the examination, not the issue");
  assert.equal(one.conditions, null, "and a document that prints no limitation says none");
});

test("the medical: two issued the same day fall back to the later expiry, and every other column still does", async () => {
  setEnv({ DB: coversDb([
    { row: { id: "a", qualCode: "QL-17" }, reading: medical({ issuedOn: "2026-06-02", expiresOn: "2027-06-02" }) },
    { row: { id: "b", qualCode: "QL-17" }, reading: medical({ issuedOn: "2026-06-02", expiresOn: "2028-06-02" }) },
  ]), FILE_STORE: "r2" } as never);
  let out = await compareMatrix(medMatrix, null, evansOnly);
  assert.deepEqual(out.settled, [{ person: "EVANS, Brenton", code: "QL-17", value: "2028-06-02" }],
    "nothing in s 16(3) to separate them, so the longer stands as it always did");

  // A ticket is not a medical: two of them are still decided by the longer.
  setEnv({ DB: coversDb([
    { row: { id: "a", qualCode: "QL-01" }, reading: { ...evansCoC, issuedOn: "2026-06-02", expiresOn: "2031-05-26", endorsements: [] } },
    { row: { id: "b", qualCode: "QL-01" }, reading: { ...evansCoC, issuedOn: "2026-08-02", expiresOn: "2029-01-01", endorsements: [] } },
  ]), FILE_STORE: "r2" } as never);
  out = await compareMatrix(coversMatrix, null, evansOnly);
  assert.deepEqual(out.settled, [{ person: "EVANS, Brenton", code: "QL-01", value: "2031-05-26" }],
    "a certificate of competency is not replaced by a later issue the way a medical is");
});

/* ------------------------------------------------------------------------ *
 * The papers that carry a man while his certificate is out. The rule and its
 * clauses are source/shared/evidence.js; this is the wiring that puts what it
 * answers where the cells can show it.
 * ------------------------------------------------------------------------ */
test("evidence: an extension letter on file reaches the page's cells, with what carries him and until when", async () => {
  const today = todayThere();
  const inAMonth = new Date(new Date(today + "T00:00:00Z").getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const lastMonth = new Date(new Date(today + "T00:00:00Z").getTime() - 30 * 86400000).toISOString().slice(0, 10);
  setEnv({ DB: coversDb([
    // His Master ticket, run out last month.
    { row: { id: "coc", qualCode: "QL-01" }, reading: { ...evansCoC, endorsements: [], expiresOn: lastMonth, evidenceKind: null, isRecognition: false } },
    // AMSA's letter extending it, read as being about the same column and
    // filed untagged: a hand tag would say it is the certificate itself.
    { row: { id: "letter", qualCode: null }, reading: {
      ...evansCoC, certificateTitle: "Extension of certificate", endorsements: [],
      issuedOn: today, expiresOn: inAMonth, evidenceKind: "extension", isRecognition: false,
    } },
  ]), FILE_STORE: "r2" } as never);
  const out = await certificateStanding();
  assert.deepEqual(out.covers, [{ person: "EVANS, Brenton", code: "QL-01", kind: "extension", until: inAMonth, fileId: "letter" }],
    "the cell can show amber and say what carries him, instead of a plain red");

  // Never a certificate of safety training: MO70 s 15(3) does not list it.
  setEnv({ DB: coversDb([
    { row: { id: "cost", qualCode: "QL-12" }, reading: { ...evansCoC, qualCode: "QL-12", endorsements: [], expiresOn: lastMonth, evidenceKind: null, isRecognition: false } },
    { row: { id: "letter", qualCode: null }, reading: {
      ...evansCoC, qualCode: "QL-12", endorsements: [], issuedOn: today, expiresOn: inAMonth,
      evidenceKind: "extension", isRecognition: false,
    } },
  ]), FILE_STORE: "r2" } as never);
  assert.deepEqual((await certificateStanding()).covers, [],
    "AMSA cannot extend a certificate of safety training, so no letter ever covers that column");
});

test("evidence: a portal with no such paper on file walks the readings once and answers nothing", async () => {
  setEnv({ DB: coversDb([{ row: { id: "coc", qualCode: "QL-01" }, reading: evansCoC }]), FILE_STORE: "r2" } as never);
  const out = await certificateStanding();
  assert.deepEqual(out.covers, [], "which is every hour until somebody files one");
});

test("evidence: the letter's own date never lands in the cell, on the round or on the page", async () => {
  /* The paper is not the certificate. AMSA's letter carries the man to the
     day the cover runs out; the certificate still expired on the day printed
     on it, and that is the day the matrix and the office's workbook must
     say. A letter read as the certificate would put a green date on a cell
     the law has already stopped covering. */
  const certs = [
    { row: { id: "coc", qualCode: "QL-01" }, reading: {
      ...evansCoC, endorsements: [], units: [], expiresOn: "2026-06-01",
      evidenceKind: null, isRecognition: false,
    } },
    { row: { id: "letter", qualCode: null }, reading: {
      ...evansCoC, certificateTitle: "Extension of certificate", endorsements: [], units: [],
      issuedOn: "2026-06-01", expiresOn: "2026-12-01", evidenceKind: "extension", isRecognition: false,
    } },
  ];
  setEnv({ DB: coversDb(certs), FILE_STORE: "r2" } as never);
  const out = await compareMatrix(coversMatrix, null, evansOnly);
  assert.deepEqual(out.settled, [{ person: "EVANS, Brenton", code: "QL-01", value: "2026-06-01" }],
    "the certificate's own printed expiry, not the letter's");
  assert.deepEqual(out.claimed, ["EVANS, BRENTON::QL-01"], "and the letter claims no cell of its own");
  assert.equal(out.items.find((i) => i.code === "QL-01")!.certificate!.id, "coc");
  assert.equal(out.notes.some((n) => /stands in for a certificate/.test(n.detail)), true,
    "the account of the run says what the letter is");

  setEnv({ DB: coversDb(certs), FILE_STORE: "r2" } as never);
  const page = await certificateStanding();
  assert.deepEqual(page.dates.map((d) => [d.code, d.expires, d.fileId]), [["QL-01", "2026-06-01", "coc"]],
    "the page's cell agrees with the round: one date, off the certificate itself");
  assert.deepEqual(page.covers.map((c) => [c.code, c.kind, c.fileId]), [["QL-01", "extension", "letter"]],
    "and the letter reaches the page only as a cover");
});

test("evidence: a hand tag beats the model's evidenceKind - a row tagged QL-01 is the Master certificate whatever the reading calls it", async () => {
  /* The model sometimes reads an ordinary certificate as one of the five
     papers. Left to the reading, that certificate stopped filling its cell
     and the date the portal had put there was cleared as an orphan on its
     second sighting. The person who tagged the row chose the item off the
     list; that beats a model's guess about what kind of paper it is, the
     same way it beats the model's code. So a tagged row is a certificate
     for its column, on the round, on the page's dates and in the evidence
     rule - and a paper is filed untagged. */
  const certs = [
    { row: { id: "tagged", qualCode: "QL-01" }, reading: {
      ...evansCoC, endorsements: [], units: [], issuedOn: "2026-05-26", expiresOn: "2031-05-26",
      evidenceKind: "extension", isRecognition: false,
    } },
  ];
  setEnv({ DB: coversDb(certs), FILE_STORE: "r2" } as never);
  const out = await compareMatrix(coversMatrix, null, evansOnly);
  assert.deepEqual(out.settled, [{ person: "EVANS, Brenton", code: "QL-01", value: "2031-05-26" }], "the tagged row fills QL-01");
  assert.deepEqual(out.claimed, ["EVANS, BRENTON::QL-01"]);
  assert.equal(out.notes.some((n) => /stands in for a certificate/.test(n.detail)), false, "and nothing calls it a paper");

  setEnv({ DB: coversDb(certs), FILE_STORE: "r2" } as never);
  const page = await certificateStanding();
  assert.deepEqual(page.dates.map((d) => [d.code, d.expires, d.fileId]), [["QL-01", "2031-05-26", "tagged"]], "the page's cell agrees");
  assert.deepEqual(page.covers, [], "and it is no cover: a document is the certificate or a paper, never both");
});

test("covers: the page's cells refuse a ticket printed in another man's name too", async () => {
  /* The mirror of the round's own test above. The two used to disagree: the
     round rejected the document with a name-mismatch note and settled
     nothing, while the page's cells handed the grid a green date and a
     working Open link to somebody else's ticket - in its own column and in
     every column it covers. */
  setEnv({ DB: coversDb([
    { row: { qualCode: "QL-01" }, reading: { ...evansCoC, holderName: "Kachin Sittiyos" } },
  ]), FILE_STORE: "r2" } as never);
  const out = await certificateStanding();
  assert.deepEqual(out.dates, [], "nothing in his cells off another man's certificate");
});

test("covers: two spellings of one man are one set of cells, and the recognition is cut back", async () => {
  /* His foreign ticket is filed under "Brenton Evans" and AMSA's recognition
     of it under "EVANS, Brenton". Keyed on the folder's spelling the two
     landed under different keys, the earlier-of rule never ran, and the page
     showed the recognition's own date - three years longer than the
     certificate behind it (MO70 s 33(2), s 37(4)) - and flagged the foreign
     certificate as one the portal does not hold. */
  const people = [{ name: "EVANS, Brenton", aliases: ["Brenton Evans"] }];
  const foreign = {
    ...evansCoC, certificateTitle: "Master (MCA)", issuer: "MCA", holderName: "Brenton Evans",
    expiresOn: "2027-05-05", endorsements: [], units: [], isRecognition: false,
  };
  const rec = recognitionOf({ recognises: { authority: "MCA", country: "United Kingdom", number: "UK-9921", expiresOn: null } });
  const certs = [
    { row: { id: "foreign", person: "Brenton Evans", qualCode: "QL-01" }, reading: foreign },
    { row: { id: "rec", person: "EVANS, Brenton", qualCode: "QL-01" }, reading: rec },
  ];
  setEnv({ DB: coversDb(certs, people), FILE_STORE: "r2" } as never);
  const out = await certificateStanding();
  assert.deepEqual(out.dates.map((d) => [d.person, d.code, d.expires, d.recognition, d.foreignUnknown]),
    [["EVANS, BRENTON", "QL-01", "2027-05-05", true, false]],
    "one man, one cell, cut back to the certificate the recognition is for");

  setEnv({ DB: coversDb(certs, people), FILE_STORE: "r2" } as never);
  const round = await compareMatrix(coversMatrix, null, asKnownPerson(people));
  assert.deepEqual(round.settled, [{ person: "EVANS, Brenton", code: "QL-01", value: "2027-05-05" }],
    "and the round says the same, which is what it always said");
});

test("recognition: a covered column is decided on the cut date, so the round and the grid agree", async () => {
  /* His recognition prints 2030-06-30 and says the MCA certificate behind it
     runs to 2029-03-01, so everything it carries stops on the earlier day
     (MO70 s 33(2), s 37(4)). He also holds a standalone ECDIS certificate to
     2029-06-01. The round used to compare the recognition's UNCUT date
     against it, hand the ECDIS cell to the recognition, and only then cut it
     back to 2029-03-01 - three months of a cell the standalone certificate
     should have held, and the page's own cells said something different. */
  const certs = [
    { row: { id: "rec", qualCode: "QL-01" }, reading: recognitionOf({ endorsements: [{ text: "II/2 (incl. generic ECDIS)", until: null }] }) },
    { row: { id: "own", qualCode: "QL-13" }, reading: {
      ...evansCoC, certificateTitle: "ECDIS", qualCode: "QL-13", expiresOn: "2029-06-01",
      endorsements: [], units: [], isRecognition: false,
    } },
  ];
  setEnv({ DB: coversDb(certs), FILE_STORE: "r2" } as never);
  const out = await compareMatrix(coversMatrix, null, evansOnly);
  assert.deepEqual(out.settled.map((s) => [s.code, s.value]).sort(),
    [["QL-01", "2029-03-01"], ["QL-13", "2029-06-01"]],
    "the standalone ECDIS certificate runs the longer of the two, so it holds its own column");
  assert.equal(out.items.find((i) => i.code === "QL-13")!.certificate!.id, "own",
    "and the cell opens that certificate");

  setEnv({ DB: coversDb(certs), FILE_STORE: "r2" } as never);
  const page = await certificateStanding();
  const by = Object.fromEntries(page.dates.map((d) => [d.code, d]));
  assert.equal(by["QL-13"].expires, "2029-06-01", "which is what the page's cells said all along");
  assert.equal(by["QL-13"].fileId, "own");
});

test("recognition: an expired recognition never displaces a certificate that is still running", async () => {
  /* MO505 s 7(2) gives standing to an AMSA seafarer certificate OR to a
     certificate of recognition. Nothing in the orders makes a spent
     recognition beat a current Australian certificate in the same column, and
     the recognition used to win whatever the two dates were - so a man
     holding a current ticket read as expired, in red, on a recognition he had
     long since replaced. */
  const current = {
    ...evansCoC, certificateTitle: "Certificate of Competency - Master", issuer: "AMSA",
    expiresOn: "2031-05-26", endorsements: [], units: [], isRecognition: false,
  };
  const spent = recognitionOf({ expiresOn: "2024-01-01", recognises: { authority: "MCA", country: "United Kingdom", number: "UK-9921", expiresOn: "2024-01-01" } });
  const certs = [
    { row: { id: "rec", qualCode: "QL-01" }, reading: spent },
    { row: { id: "amsa", qualCode: "QL-01" }, reading: current },
  ];
  setEnv({ DB: coversDb(certs), FILE_STORE: "r2" } as never);
  const out = await compareMatrix(coversMatrix, null, evansOnly);
  assert.deepEqual(out.settled, [{ person: "EVANS, Brenton", code: "QL-01", value: "2031-05-26" }],
    "the certificate he holds, not the recognition he has finished with");
  assert.equal(out.items.find((i) => i.code === "QL-01")!.certificate!.id, "amsa", "and the cell opens it");
  assert.equal(out.notes.some((n) => n.kind === "superseded" && /runs the longer/.test(n.detail)), true,
    "the recognition is the one it replaced, and said so in those words");

  setEnv({ DB: coversDb(certs), FILE_STORE: "r2" } as never);
  const page = await certificateStanding();
  assert.deepEqual(page.dates.map((d) => [d.expires, d.fileId, d.recognition]), [["2031-05-26", "amsa", false]],
    "and the page's cells say the same");
});

test("covers: only the ticket in force covers another column", async () => {
  /* Two Master tickets, the older carrying a fast rescue craft endorsement the
     newer does not. The older is the one the newer replaced, so nothing in
     force carries fast rescue craft and QL-16 stays empty: a date off a
     ticket he no longer holds is a date nobody could produce the paper for. */
  const certs = [
    { row: { id: "old", qualCode: "QL-01" }, reading: {
      ...evansCoC, expiresOn: "2029-01-01", units: [],
      endorsements: [{ text: "VI/2 (2) s. A-VI/2 (5-8)", until: null }],
    } },
    { row: { id: "new", qualCode: "QL-01" }, reading: { ...evansCoC, expiresOn: "2031-05-26", endorsements: [], units: [] } },
  ];
  setEnv({ DB: coversDb(certs), FILE_STORE: "r2" } as never);
  const out = await compareMatrix(coversMatrix, null, evansOnly);
  assert.deepEqual(out.settled, [{ person: "EVANS, Brenton", code: "QL-01", value: "2031-05-26" }],
    "the newer ticket, and no fast rescue craft off the one it replaced");

  setEnv({ DB: coversDb(certs), FILE_STORE: "r2" } as never);
  const page = await certificateStanding();
  assert.deepEqual(page.dates.map((d) => d.code), ["QL-01"], "the page's cells the same");
});

test("covers: a covered date that beats a certificate of its own says which certificate it replaced", async () => {
  /* The tested case the other way round: a standalone ECDIS certificate
     expiring 2028 against a ticket covering ECDIS to 2031. The ticket holds
     the cell - but the certificate it displaced is named, and its own row
     still records what it is, or after somebody deletes it nothing could say
     which cell it had been holding up. */
  const db = coversDb([
    { row: { id: "coc", qualCode: "QL-01" }, reading: evansCoC },
    { row: { id: "own", filename: "ecdis.pdf", qualCode: "QL-13" }, reading: {
      ...evansCoC, certificateTitle: "ECDIS", qualCode: "QL-13", expiresOn: "2028-01-01",
      endorsements: [], units: [],
    } },
  ]);
  setEnv({ DB: db, FILE_STORE: "r2" } as never);
  const out = await compareMatrix(coversMatrix, null, evansOnly);
  assert.equal(out.settled.find((s) => s.code === "QL-13")!.value, "2031-05-26");
  assert.equal(out.notes.some((n) => n.kind === "superseded" && /ecdis\.pdf/.test(n.detail)), true,
    "the displaced certificate is named");
  const wrote = db.asked.filter((a) => /UPDATE documents\s+SET read_code/.test(a.sql));
  assert.deepEqual(wrote.map((n) => [n.args[0], n.args[1], n.args[2]]).sort(),
    [["coc", "QL-01", "2031-05-26"], ["own", "QL-13", "2028-01-01"]],
    "and its row still says it is an ECDIS certificate expiring 2028");
});

test("a certificate no folder places is still topped up, under the man its own face names", async () => {
  /* A scan parked under a name the crew register does not know - a loose one
     under "Other" - was in nobody's list, so its reading stayed as it was
     made for good and the covers, recognition and conditions rules went on
     saying nothing about it. Where the document's own name is a man the
     register does know, it gets the same one look, under him, inside the same
     cap. */
  const codes = vessel.qualColumns.map((c) => [c[0], c[1]] as [string, string]);
  const { portal } = await particularsPortal({ model: true, people: [{ ...EVANS_P, dob: "1980-01-01" }], certs: [
    { id: "o1", checksum: "loose-ticket", code: "QL-02", person: "Other",
      reading: oldReading({ qualCode: "QL-02" }) },
    { id: "s1", checksum: "stranger", code: "QL-02", person: "Other",
      reading: oldReading({ qualCode: "QL-02", holderName: "Somebody Else" }) },
  ] });
  const model = modelByFile(() => ({ status: 200, body: readingStream({ ...reading, holderName: "Brenton Evans" }) }));
  let out;
  try {
    out = await quiet(() => topUpParticulars(codes, { cap: 20, timeLeft: () => true }));
  } finally {
    model.restore();
  }
  const asked = filesAsked(model);
  assert.equal(asked.includes("loose-ticket.pdf"), true, "the loose ticket is looked at once, under the man it names");
  assert.equal(asked.includes("stranger.pdf"), false, "and one naming nobody the register knows is not paid for");
  const kept = JSON.parse(portal.blobs.get("certificate-readings|r1/loose-ticket.json")!);
  assert.deepEqual(kept.endorsements, [], "the keys it was missing are added");
  assert.equal(out!.read >= 1, true);
});
