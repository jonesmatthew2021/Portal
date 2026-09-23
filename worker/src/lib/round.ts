import { asKnownPerson, crewRowsOnly } from "../../../source/shared/names.js";
import { applySettled, readExpiryRules, settleRound } from "../../../source/shared/matrix-rules.js";
import {
  datedWorkbookName, listSheets, partOf, partText, readSheetRows, readZip, updateFiledWorkbook, XLSX_MIME,
} from "../../../source/shared/workbook.js";
import { compareMatrix } from "../routes/analyse.js";
import { readDocument, saveDocument, type SharedDocument } from "./shared-state.js";
import { matrixReadingKey, matrixStore, todayThere, type Matrix } from "./analysis.js";
import { getStore } from "../compat/blobs.js";
import { fileStore, legacyRemovedKeyFor, removedKeyFor } from "../db/documents.js";
import { liveRowsOf, replaceSingleFile } from "../db/single-file.js";

/**
 * The round on the hour: the certificates' dates put on the crew matrix and
 * written into the office's workbook, by the worker itself, with no browser
 * open anywhere.
 *
 * It is the same round Update the spreadsheet runs from the page (see
 * UpdateTrainingMatrixInPlace in source/index.html), mirrored here so the
 * portal keeps itself current: the expiry rules read off the skills matrix
 * where none are held yet, the certificates compared against the matrix as
 * the register names people, what they settle laid over the matrix and
 * saved against the revision it was read at, and - only when a cell
 * actually moved - the office's CREW QUALIFICATION EXPIRY workbook written
 * in place and filed under today's date.
 *
 * Nothing here throws out. Whatever goes wrong is written into the outcome
 * the SharePoint page shows, because a round that fails in silence is how
 * the matrix once sat empty for three hours with nobody told. And the
 * workbook is the one thing this must never lose: it is written through
 * replaceSingleFile, whose order of work is fixed for exactly that reason.
 */
export type RoundOutcome = {
  applied: number;
  cleared: number;
  settled: number;
  written: number | null;
  workbook: string | null;
  leftAsTyped: number;
  held: string | null;
  roundError: string | null;
  roundSkipped: string | null;
  validityProblem: string | null;
};

/* Two writers of the one workbook is how a file gets lost. One lease in the
   sync store says who is writing: the worker's hour takes it around the
   whole of its work - the sync, which can swap the workbook, the reading,
   and the round - and the page's Update portal, Import new files and
   workbook upload each take it for their own turn and answer 409 while it
   is held. It outlives the hour's own time budget by a margin, and is run
   out at the end whatever happened.

   It is taken against the version mark the store puts on every write, so
   of two takers that read it free in the same instant only one has it -
   the very first take is an insert that only one can make, and every
   take after is a conditional write against the mark it read. The row is
   left in place when it runs out, rather than deleted, so there is always
   a mark to take it against; and it is run out the same way, against the
   mark, so a lease that has since passed to somebody else is never run
   out under them. */
const LEASE_KEY = "round-lease";
export const LEASE_MS = 15 * 60 * 1000;
export type Lease = { until: number; by: string; token: string };

/** Whether somebody holds the lease right now - what GET /api/sync/last says. */
export async function roundRunning(): Promise<boolean> {
  const lease = (await getStore("sync").get(LEASE_KEY, { type: "json" })) as Lease | null;
  return !!lease && lease.until > Date.now();
}

/** The lease taken, or null where somebody holds it or took it first. */
export async function takeLease(by: string, token = crypto.randomUUID()): Promise<Lease | null> {
  const leases = getStore("sync");
  const lease = { until: Date.now() + LEASE_MS, by, token } satisfies Lease;
  const held = await leases.getWithMetadata(LEASE_KEY, { type: "json" });
  const running = held ? (held.data as Lease | null) : null;
  if (running && running.until > Date.now()) return null;
  if (!held) {
    // No mark yet to take it against: the first take ever. An insert that
    // only one of two takers can make.
    const { written } = await leases.setJSONIfAbsent(LEASE_KEY, lease);
    return written ? lease : null;
  }
  const { modified } = await leases.setJSON(LEASE_KEY, lease, { onlyIfMatch: held.etag });
  return modified ? lease : null;
}

/** The lease run out - only where it is still this holder's, and only
 *  against the mark it was read at, so one that passed to somebody else
 *  between the read and the write is left as theirs. */
export async function dropLease(token: string) {
  const leases = getStore("sync");
  const held = await leases.getWithMetadata(LEASE_KEY, { type: "json" });
  const lease = held ? (held.data as Lease | null) : null;
  if (!held || !lease || lease.token !== token) return;
  await leases.setJSON(LEASE_KEY, { ...lease, until: 0 }, { onlyIfMatch: held.etag });
}

// The office's workbook is rewritten in memory, and a Worker has a fixed
// amount of that. Six megabytes is well past the real workbook and well
// inside the room; anything bigger is left to the page's own button.
const MAX_WORKBOOK_BYTES = 6 * 1024 * 1024;

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Quals = { cols: string[][]; rows: [string, string, string, string[]][] };

/** Two notes say the same thing: the same keys with the same values. */
function sameRecord(a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && (a || {})[k] === (b || {})[k]);
}

/** One line in the portal's change log, as the page writes them. */
const historyEntry = (by: string, action: string, detail: string) => ({
  id: "h" + Date.now() + Math.random(),
  at: new Date().toISOString().slice(0, 16),
  by,
  section: "Admin",
  action,
  detail,
});
const HISTORY_LIMIT = 500;

/**
 * The expiry rules, read off the skills matrix's Guidance Information sheet
 * and kept under the same key and in the same shape the page's
 * "validity-rules" action writes - only where nothing is held for the live
 * skills matrix yet. Anything that goes wrong is a problem to report, never
 * a reason to stop: without rules the dates come from what the certificates
 * print, which is what they always meant.
 */
async function keepValidityRules(): Promise<string | null> {
  const [skills] = await liveRowsOf("skills-matrix");
  if (!skills) return null;
  const key = matrixReadingKey("validity", skills.id);
  if (await matrixStore().get(key, { type: "json" })) return null;
  if (!/\.(xlsx|xlsm)$/i.test(skills.filename)) {
    return `${skills.filename} is not a workbook, so the expiry rules could not be read off it.`;
  }
  const bytes = await fileStore().get(skills.blobKey, { type: "arrayBuffer" });
  if (!bytes) return `${skills.filename} has no bytes on file, so the expiry rules could not be read off it.`;
  const entries = readZip(bytes);
  const sheets = listSheets(
    await partText(partOf(entries, "xl/workbook.xml")),
    await partText(partOf(entries, "xl/_rels/workbook.xml.rels")),
  );
  const guidance = sheets.find((s) => /guidance information/i.test(s.name));
  if (!guidance) return `${skills.filename} has no Guidance Information sheet, so the expiry rules could not be read off it.`;
  const rules = readExpiryRules(await readSheetRows(entries, guidance.path));
  if (!rules.length) return `No expiry rules could be found on ${skills.filename}.`;
  const periods = rules.map((p) => ({
    code: p.code,
    item: p.title || "",
    months: p.months ?? null,
    neverExpires: !!p.never,
    statesOwn: !!p.own,
    validFor: p.said || "",
  }));
  const reading = { readable: true, at: new Date().toISOString(), by: "read from the sheet", periods };
  await matrixStore().setJSON(key, { which: "validity", id: skills.id, filename: skills.filename, reading });
  return null;
}

export async function runMatrixRound(opts: {
  by: string;
  timeLeft: () => boolean;
  mirroredThisHour: number;
  /** The lease the caller already holds for the hour (scheduled() takes
   *  one around the sync, the reading and the round together). Without
   *  one the round takes a lease for itself and gives it back at the end. */
  lease?: Lease;
}): Promise<RoundOutcome> {
  const out: RoundOutcome = {
    applied: 0, cleared: 0, settled: 0, written: null, workbook: null, leftAsTyped: 0,
    held: null, roundError: null, roundSkipped: null, validityProblem: null,
  };
  const skip = (why: string) => { out.roundSkipped = why; return out; };

  let own: Lease | null = null;
  try {
    if (!opts.lease) {
      own = await takeLease(opts.by);
      if (!own) return skip("another round is still running");
    }

    // (a) the matrix as the register names people. No crew, no round.
    const cur = await readDocument();
    if (!cur) return skip("no shared document yet");
    const quals = crewRowsOnly(cur.doc.quals as Quals | null, cur.doc.people) as Quals | null;
    if (!quals || !(quals.cols || []).length || !(quals.rows || []).length) return skip("the crew matrix has no items");

    // (b) the expiry rules, where none are held for the skills matrix on file.
    try {
      out.validityProblem = await keepValidityRules();
    } catch (e) {
      out.validityProblem = `The expiry rules could not be read off the skills matrix, so expiry dates were taken from the certificates alone. ${said(e)}`;
    }

    // (c) the certificates against the matrix.
    if (!opts.timeLeft()) return skip("out of time before comparing; the next hour carries on");
    const res = await compareMatrix(
      { cols: quals.cols, rows: quals.rows } as Matrix,
      null,
      asKnownPerson(cur.doc.people),
    );

    // (d) clearing is held for an hour in which files went off the books:
    // the sync just wrote certificates off, and a cell whose certificate
    // "has gone" this hour may only be one the listing lost sight of.
    if (opts.mirroredThisHour > 0) {
      out.held = `clearing held: ${opts.mirroredThisHour} file${opts.mirroredThisHour === 1 ? "" : "s"} went off the books this hour`;
    }
    const unread = out.held ? 1 : res.summary.unread;

    // (e) what the certificates settle, laid over the matrix as it is at the
    // moment of saving - never over the copy this round began from. The
    // note of filled cells and the sightings are read from that same fresh
    // copy, so a save that races a page's save is worked out again on what
    // the page left.
    const hour = new Date().toISOString().slice(0, 13);
    let changedKeys = new Set<string>();
    // Cells an earlier hour put on the matrix that never reached the
    // workbook - read from the same fresh copy the change is worked out on.
    let owedBefore: string[] = [];
    const saved = await saveDocument((doc) => {
      owedBefore = owedCells(doc);
      const nameOf = asKnownPerson(doc.people);
      const as = (n: string) => nameOf(n) || n;
      const live = doc.quals && Array.isArray(doc.quals.rows) && doc.quals.rows.length ? (doc.quals as Quals) : null;
      if (!live) return null;

      const round = settleRound({
        filledFromCert: doc.filledFromCert,
        claimed: res.claimed,
        unread,
        settled: res.settled,
        seenBefore: doc.orphanSeen || {},
        now: hour,
        nameOf,
      });
      const done = applySettled(live, round.settled, nameOf);
      out.applied = done.applied.filter((a) => a.to !== "").length;
      out.cleared = done.applied.filter((a) => a.to === "").length;
      out.settled = done.only.size;
      changedKeys = new Set(done.applied.map((a) => `${as(a.person).trim().toUpperCase()}|${a.code}`));

      // An idle hour writes nothing: no revision bump, no history copy.
      if (!done.applied.length
        && sameRecord(round.noteNow, doc.filledFromCert)
        && sameRecord(round.seenNow, doc.orphanSeen)) return null;

      doc.quals = done.next;
      if (out.applied) doc.matrixUpdated = todayThere();
      doc.filledFromCert = round.noteNow;
      doc.orphanSeen = round.seenNow;
      doc.lastDocUpdate = new Date().toISOString();
      if (done.applied.length) {
        const entry = historyEntry(
          opts.by,
          out.applied ? "Updated the crew matrix from the certificates" : "Cleared dates whose certificates have gone",
          `${out.applied} ${out.applied === 1 ? "date" : "dates"} changed · ${out.cleared} cleared`,
        );
        doc.history = [entry, ...(Array.isArray(doc.history) ? doc.history : [])].slice(0, HISTORY_LIMIT);
      }
      return doc;
    }, opts.by);
    if (!saved.changed) { out.applied = 0; out.cleared = 0; }

    /* (f) the office's workbook - when a cell moved this hour, or one moved
       in an earlier hour and never reached it.

       The matrix is saved first and the workbook written after, so a write
       that fails, or is skipped for time, leaves the workbook behind the
       matrix. It used to stay behind until some other cell changed, with
       every hour in between reporting clean. So what is still owed to the
       workbook is written on the document (workbookPending) whenever the
       write does not land, and taken off it in the same save that records
       the workbook written. */
    const owed = new Set([...changedKeys, ...owedBefore]);
    if (!owed.size) return out;
    let landed = false;
    try {
      if (!opts.timeLeft()) return skip("out of time before the workbook; the next hour writes it");
      landed = await writeWorkbook(opts, out, owed);
      return out;
    } finally {
      try {
        if (!landed) await rememberOwed(opts.by, owed);
        else if (!out.workbook && owedBefore.length) await rememberOwed(opts.by, new Set());
      } catch (e) {
        console.error("what the workbook is still owed was not written down:", e);
      }
    }
  } catch (e) {
    out.roundError = said(e);
    console.error("the round on the hour failed:", e);
    return out;
  } finally {
    try {
      if (own) await dropLease(own.token);
    } catch (e) {
      console.error("the round's lease was not dropped:", e);
    }
  }
}

/** The cells the document says the workbook is still owed. */
function owedCells(doc: SharedDocument): string[] {
  return Array.isArray(doc.workbookPending)
    ? doc.workbookPending.filter((k): k is string => typeof k === "string" && !!k)
    : [];
}

/** What the workbook is still owed, written on the document: the cells
 *  given, joined to any already there. An empty set clears it. Saved only
 *  where that changes anything, so an hour that owes nothing new bumps no
 *  revision. */
async function rememberOwed(by: string, owed: Set<string>) {
  await saveDocument((doc) => {
    const had = owedCells(doc);
    const next = owed.size ? [...new Set([...had, ...owed])].sort() : [];
    if (next.length === had.length && next.every((k, i) => k === [...had].sort()[i])) return null;
    doc.workbookPending = next;
    return doc;
  }, by);
}

/**
 * The workbook on file, written in place with the cells this round changed
 * (and any still owed from before) and any it finds blank, then filed
 * under today's date through replaceSingleFile - which also decides the
 * address it lands on, taking the next suffix where the wanted name is the
 * office's file or a removed copy's. Every reason not to is said in
 * roundSkipped rather than thrown; the matrix is already saved by now, and
 * the page's own button can always write the workbook from it.
 *
 * Answers whether the workbook now carries every cell it was owed: yes
 * when it was written, and yes when there was nothing to write because it
 * already had them; no when the write was skipped.
 */
async function writeWorkbook(
  opts: { by: string }, out: RoundOutcome, changedKeys: Set<string>,
): Promise<boolean> {
  const [tm] = await liveRowsOf("training-matrix");
  if (!tm) { out.roundSkipped = "no training matrix on file"; return false; }
  if (!/\.(xlsx|xlsm)$/i.test(tm.filename)) {
    out.roundSkipped = `${tm.filename} is not a workbook the server can write; press Update the spreadsheet in a tab`;
    return false;
  }
  if (tm.sizeBytes > MAX_WORKBOOK_BYTES) {
    out.roundSkipped = `${tm.filename} is ${(tm.sizeBytes / (1024 * 1024)).toFixed(1)} MB, too big to rewrite on the server; press Update the spreadsheet in a tab`;
    return false;
  }

  const store = fileStore();
  let bytes = await store.get(tm.blobKey, { type: "arrayBuffer" });
  if (!bytes) {
    /* The live address is empty: a replace that was cut off after parking
       the old copy. The parked copy is put back on the live address - flat
       first, then the old folder form - and the round carries on with it. */
    for (const parked of [removedKeyFor(tm), legacyRemovedKeyFor(tm)]) {
      const found = await store.get(parked, { type: "arrayBuffer" });
      if (found) { await store.set(tm.blobKey, found); bytes = found; break; }
    }
    if (!bytes) { out.roundSkipped = "the workbook on file has no bytes"; return false; }
  }

  const today = todayThere();
  const named = datedWorkbookName(tm.filename, today);

  // The matrix as it is now, after this round's save and anything since.
  const fresh = await readDocument();
  if (!fresh) { out.roundSkipped = "no shared document yet"; return false; }
  const next = crewRowsOnly(fresh.doc.quals as Quals | null, fresh.doc.people) as Quals | null;
  if (!next || !(next.rows || []).length) { out.roundSkipped = "the crew matrix has no items"; return false; }
  const nameOf = asKnownPerson(fresh.doc.people);

  const { blob, report } = await updateFiledWorkbook(bytes, next, null, null, {
    mode: "applied-and-blanks", keys: changedKeys, nameOf,
  });
  out.leftAsTyped = report.leftAsTyped;
  // Nothing to write: the workbook already carries every cell it was owed.
  if (!blob) { out.written = 0; return true; }

  const { row } = await replaceSingleFile({
    category: "training-matrix",
    bytes: await blob.arrayBuffer(),
    filename: named,
    contentType: XLSX_MIME,
    uploadedBy: opts.by,
    filedOn: today,
    keepOutgoing: !!tm.adoptedFromFolder,
  });
  out.written = report.written;
  out.workbook = row.filename;

  // The workbook is written: the line in the log, and nothing owed to it
  // any more, in the one save.
  await saveDocument((doc: SharedDocument) => {
    const entry = historyEntry(
      opts.by,
      "Updated the training matrix from the certificates",
      `${row.filename} · ${report.written} ${report.written === 1 ? "cell" : "cells"}`,
    );
    doc.history = [entry, ...(Array.isArray(doc.history) ? doc.history : [])].slice(0, HISTORY_LIMIT);
    doc.workbookPending = [];
    return doc;
  }, opts.by);
  return true;
}
