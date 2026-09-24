/**
 * The OPMS export against the portal's own records.
 *
 * Three accounts of the same crew: our skills matrix, the certificates scanned
 * onto the portal, and a spreadsheet exported from OPMS, which is somebody
 * else's system. They are meant to agree and they drift apart, and when they
 * disagree one of the two sides is wrong. Which one decides who has to fix it,
 * so the answer comes back in two columns — what we have wrong, and what OPMS
 * has wrong — with the certificates as the thing that tells them apart.
 *
 * It runs as a job rather than as a request. Holding a whole export against a
 * whole crew is a single long question to the model, and a request that waits
 * for it is killed by the platform at sixty seconds and reaches the portal as a
 * bare 504. So the endpoint writes down what was asked and hands the work to a
 * background function, which has fifteen minutes, and the portal asks after it
 * until it is done. The answer is kept exactly as it was before — the job is how
 * it is run, not what it is.
 */

import { getStore } from "../compat/blobs.js";
import { liveSingleFileRow } from "../db/documents.js";
import {
  askJson,
  blankish,
  contentFor,
  errorLine,
  isDate,
  isHeld,
  isNotHeld,
  liveCertificates,
  MAX_ANSWER_TOKENS,
  MODEL,
  neverLapses,
  readingKey,
  readingStore,
  todayThere,
  type Matrix,
  type Reading,
} from "./analysis.js";

const OPMS_VERSION = "o2";

function opmsStore() {
  // Strong consistency: an admin who runs this twice in a row should be answered
  // from the first run rather than told there is nothing there yet.
  return getStore({ name: "opms-checks", consistency: "strong" });
}

// Certificates read as one line each. Fifty is a full vessel; the cap is there so
// a store that has collected years of scans can't fill the request on its own.
const MAX_CERT_LINES = 400;

// The model is given ten minutes to answer. It is a long question — three
// accounts of a whole crew — and the answer to it is long as well: a hundred
// findings written out is minutes of writing on its own. The worker running it
// has fifteen, and the portal asks after it for fourteen, so this sits inside
// both with room to spare.
const OPMS_TIMEOUT_MS = 600000;

/**
 * A short, stable stamp for everything the answer was made from other than the
 * OPMS export itself — our matrix and the certificate readings.
 *
 * The answer is kept against it, so pressing the button twice costs one call, and
 * a corrected matrix or a newly read certificate asks the question again instead
 * of handing back an answer that was true an hour ago. FNV-1a: not a checksum
 * anything depends on, just a key that changes when the inputs do.
 */
function stamp(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** A matrix cell as a value rather than as a cell: a date, "held", "not held". */
const recordValue = (v: string | null | undefined) => {
  if (blankish(v)) return null;
  if (isHeld(v)) return "held";
  if (isNotHeld(v)) return "not held";
  return isDate(v) ? (v || "").trim().slice(0, 10) : (v || "").trim();
};

/** The portal's own record, one line per person, blank cells left out. */
function ourRecordText(matrix: Matrix) {
  const cols = matrix.cols || [];
  return (matrix.rows || [])
    .map((r) => {
      const held = (r[3] || [])
        .map((v, i) => {
          const value = recordValue(v);
          return cols[i] && value ? `${cols[i][0]} (${cols[i][1]}) = ${value}` : null;
        })
        .filter(Boolean);
      const who = [r[0], r[1] || null, r[2] ? `SAM ${r[2]}` : null].filter(Boolean).join(", ");
      return `- ${who}: ${held.length ? held.join("; ") : "nothing recorded"}`;
    })
    .join("\n");
}

/** The items the matrix tracks, so an OPMS column heading can be matched to one. */
const itemListText = (cols: Matrix["cols"]) =>
  cols.map((c) => `${c[0]} — ${c[1]}${c[2] ? ` [${c[2]}]` : ""}`).join("\n");

/**
 * Every certificate on file as one line each, from the readings already made.
 *
 * Nothing is read here: this is what the reading store has. What it doesn't have
 * is counted and said, because a run over half-read certificates would otherwise
 * look like a run over all of them.
 */
async function certificateEvidence() {
  const certs = await liveCertificates();
  const store = readingStore();
  const readings = await Promise.all(
    certs.map(async (row) => ({
      row,
      reading: (await store.get(readingKey(row), { type: "json" })) as Reading | null,
    })),
  );

  const lines: string[] = [];
  let unread = 0;
  let unreadable = 0;

  for (const { row, reading } of readings) {
    if (!reading) {
      unread++;
      continue;
    }
    if (!reading.readable) {
      unreadable++;
      continue;
    }
    // The uploader's own tagging first, the model's only where nobody said —
    // the same order the certificate comparison uses.
    const code = row.qualCode || (reading.codeConfidence !== "low" ? reading.qualCode : null) || null;
    // An item recorded as carrying no expiry doesn't lapse for anybody, so it is
    // put that way whatever date the scan happened to print — otherwise the
    // comparison is handed a date for something that has no expiry to compare.
    const noExpiry = neverLapses(code) || (!reading.expiresOn && reading.neverExpires);
    const bits = [
      `filed under ${row.person || "nobody"}`,
      reading.certificateTitle || "untitled",
      code ? `matrix item ${code}` : "no matrix item",
      noExpiry
        ? "carries no expiry"
        : reading.expiresOn
          ? `expires ${reading.expiresOn}`
          : "no expiry could be read",
      reading.issuedOn ? `issued ${reading.issuedOn}` : null,
      reading.holderName && reading.holderName !== row.person ? `named ${reading.holderName}` : null,
      row.filename,
    ].filter(Boolean);
    lines.push(`- ${bits.join(" | ")}`);
  }

  return {
    lines: lines.slice(0, MAX_CERT_LINES),
    capped: Math.max(0, lines.length - MAX_CERT_LINES),
    read: lines.length,
    unread,
    unreadable,
    total: certs.length,
  };
}

const OPMS_SYSTEM = `You compare a vessel's own crew records against a spreadsheet
exported from OPMS, a separate system kept by another party, and return JSON only.

You are given three accounts of the same crew: the vessel's skills matrix, the
certificates scanned and filed against it, and the OPMS export. They are meant to
say the same thing and they drift apart.

Return exactly the JSON object you are asked for and nothing else — no prose, no
markdown fence.

Rules:
- Dates: the OPMS export is an Australian document and is day-first. "10/03/2028"
  is 2028-03-10. The vessel's own record and the certificate list are already
  YYYY-MM-DD. Quote dates back as they were given to you.
- Report only disagreements. Never list something the three accounts agree on.
- Never invent a person, an item or a date that isn't in front of you.
- Keep every string short — a phrase or a sentence, not a paragraph.
- Put the most serious first in every list. An expired or missing qualification
  comes before a date that is out by a few days, so that a long answer is
  worth reading from the top.`;

const OPMS_CHECK_SHAPE = `{
  "headline": string,               // one sentence: how far apart the two systems are
  "ours": [                         // OUR mistake — the portal's record is wrong (max 60, worst first)
    {
      "person": string|null,        // null when it is about the crew as a whole
      "item": string,               // the item, as the matrix titles it
      "code": string|null,          // the matrix code, where there is one
      "opmsSays": string,           // what the OPMS export has
      "weSay": string,              // what our matrix has
      "evidence": string|null,      // the certificate that settles it, and what it says
      "detail": string,             // what is wrong, in one sentence
      "action": string|null,        // what would fix it
      "confidence": "high"|"medium"|"low"
    }
  ],
  "opms": [ ... same shape ... ],   // OPMS's mistake — their export is wrong (max 60, worst first)
  "unattributed": [ ... same shape ... ],  // neither side can be shown wrong (max 40, worst first)
  "counts": {
    "people": number,               // people the two systems have in common
    "compared": number,             // person-and-item pairs you could compare
    "agree": number,                // pairs that matched
    "ours": number,
    "opms": number,
    "unattributed": number
  },
  "notes": [string]                 // what couldn't be compared, and why (max 8)
}`;

/** The answer as it is kept, and as the portal is given it. */
export type OpmsHeld = {
  version: string;
  at: string;
  model: string | null;
  // True where the model reached the end of its room mid-answer, so what is held
  // is the top of the comparison rather than all of it.
  truncated?: boolean;
  sheet: { id: string; filename: string; uploaded: unknown };
  certificates: {
    total: number;
    read: number;
    unread: number;
    unreadable: number;
    capped: number;
  };
  check: Record<string, unknown>;
};

/** Raised where there is nothing to run against, rather than nothing that worked. */
export class OpmsMissing extends Error {
  missing: string[];
  constructor(message: string, missing: string[]) {
    super(message);
    this.name = "OpmsMissing";
    this.missing = missing;
  }
}

/** Is the OPMS export on the portal at all? Asked before a job is started. */
export async function opmsSheetRow() {
  return liveSingleFileRow("opms-sheet");
}

export const NO_OPMS_SHEET =
  "No OPMS spreadsheet is on the portal. Upload the latest export from OPMS and run it again.";

// A handful of answers is all this store ever holds — one per run whose inputs
// differed — so reading them all to find the newest is a few blob reads. The cap
// is there so a store that has collected a year of runs can't turn one question
// into a hundred of them.
const MAX_HELD_OPMS = 12;

/**
 * The most recent OPMS comparison the portal holds, whatever it was run against.
 *
 * The check is kept under a key built from the export on file *and* a stamp of
 * everything else it was made from — our matrix and our certificate readings —
 * so the key can only be rebuilt by whoever has the matrix in front of them.
 * That is the portal, which is why the pages ask for this answer by running the
 * check and being handed the cached one. The AI Checker has no matrix to offer
 * and must not start a run costing minutes and money in the middle of answering
 * a question, so it asks the store instead: the newest answer in it, and the
 * date it was made, which is enough to say "this is what was found on the 3rd,
 * and it may be out of date" honestly.
 */
export async function heldOpmsAnswer() {
  const store = opmsStore();
  const { blobs } = await store.list({ prefix: `${OPMS_VERSION}/` });
  if (!blobs.length) return null;

  const held = (await Promise.all(
    blobs.slice(0, MAX_HELD_OPMS).map((b) => store.get(b.key, { type: "json" })),
  )) as (OpmsHeld | null)[];

  let newest: OpmsHeld | null = null;
  for (const one of held) {
    if (!one || !one.at) continue;
    if (!newest || one.at > newest.at) newest = one;
  }
  return newest;
}

/**
 * Hold the OPMS export against our matrix and our certificates.
 *
 * `text` is the export read sheet by sheet in the browser, because a model can't
 * be handed a .xlsx. Where it is a PDF or a scan there is no text and the file
 * itself goes up.
 */
export async function runOpmsCheck(matrix: Matrix, text: string | null, force: boolean) {
  const row = await opmsSheetRow();
  if (!row) throw new OpmsMissing(NO_OPMS_SHEET, ["OPMS spreadsheet"]);

  const evidence = await certificateEvidence();
  const store = opmsStore();
  // The unread/unreadable/total counts are part of the question, not just the
  // write-up of it: a certificate freshly uploaded but not yet read changes
  // none of the lines above, but it changes what the answer ought to say about
  // how much of the file was actually read. Left out of the key, a newly filed
  // certificate would be invisible to the cache until something else changed.
  const key = `${OPMS_VERSION}/check-${row.id}-${stamp(
    JSON.stringify([
      matrix.cols,
      matrix.rows,
      evidence.lines,
      evidence.unread,
      evidence.unreadable,
      evidence.total,
    ]),
  )}.json`;

  if (!force) {
    const already = (await store.get(key, { type: "json" })) as OpmsHeld | null;
    if (already) return { cached: true, held: already };
  }

  const { block, trimmed } = await contentFor(row, text);

  const instruction = `Three accounts of the same crew. Hold them against each other.

THE ITEMS OUR MATRIX TRACKS, by code:
${itemListText(matrix.cols || [])}

OUR SKILLS MATRIX — the portal's own record, one line per person:
${ourRecordText(matrix)}

OUR CERTIFICATES — the scans filed on the portal, read one by one. This is the
evidence: a certificate is the document itself, so it outranks both spreadsheets.
${evidence.lines.length ? evidence.lines.join("\n") : "No certificate on file has been read."}
${evidence.capped ? `\n[${evidence.capped} further certificates are on file and were left out of this list.]` : ""}
${evidence.unread ? `\n[${evidence.unread} certificates on file have not been read yet, so they settle nothing here.]` : ""}
${evidence.unreadable ? `\n[${evidence.unreadable} certificates on file couldn't be read.]` : ""}

THE OPMS EXPORT (${row.filename}) is attached above. It is somebody else's system,
laid out their way: work out for yourself which of its columns line up with the
items listed above, and match its people to ours by name and by SAM number where
it carries one.

Today is ${todayThere()}.

Return exactly this JSON object:

${OPMS_CHECK_SHAPE}

Which column a disagreement goes in. The certificates settle it — a scan is the
document itself, so it outranks both spreadsheets, and the test is which
spreadsheet agrees with the scan:
- "opms"    our matrix says what the certificate says and OPMS says something
            else. OPMS is the one that is wrong. Also OPMS when OPMS carries an
            item or a date for somebody that no certificate and no record of ours
            supports, or OPMS is missing somebody we hold current certificates for.
- "ours"    OPMS says what the certificate says and our matrix says something
            else. Our own spreadsheets are the ones that are wrong. Also ours
            when we have nothing recorded where OPMS and a certificate both say
            the person holds it.
- "unattributed"  the two disagree and no certificate covers the item, so neither
            side can be shown to be wrong. Say what each side has and leave it
            there. This is the right answer whenever you would otherwise guess.

How to weigh it:
- Where a certificate settles it, say so in "evidence" and set confidence "high".
  Without a certificate, confidence is "medium" at best.
- Ignore differences that are only in the writing: the same date in another
  format, capitals, punctuation, an item OPMS titles differently that is plainly
  the same item. These are not mistakes on either side.
- A blank in either system is not a claim that the person doesn't hold the item.
  Treat a blank against a filed certificate as a record that wasn't kept up, and
  a blank on both sides as nothing at all.
- Somebody in OPMS who is not on our matrix, and somebody on our matrix who is
  not in OPMS, are worth reporting — as "ours" if they are not our crew, as
  "opms" if we hold current certificates for them, and unattributed if the two
  documents don't tell you which.
- Put anything you couldn't compare — a column you couldn't match to an item, a
  sheet you couldn't make sense of — into notes rather than into a column.`;

  const { json: result, truncated } = await askJson({
    system: OPMS_SYSTEM,
    content: [block, { type: "text", text: instruction }],
    maxTokens: MAX_ANSWER_TOKENS,
    // An answer the model cut partway is kept and said to be cut short.
    keepPartial: true,
    effort: "medium",
    timeoutMs: OPMS_TIMEOUT_MS,
  });

  if (truncated) {
    const notes = Array.isArray(result.notes) ? result.notes : [];
    result.notes = [
      "The answer was cut short — this is as far down the crew as it got before it ran out of room. What is listed was compared in full and is the most serious of it; there may be more underneath. The counts below are the model's own and may be of the whole comparison rather than of what is shown.",
      ...notes,
    ];
  }

  if (trimmed) {
    const notes = Array.isArray(result.notes) ? result.notes : [];
    result.notes = [
      `Only the first part of ${row.filename} was read — the export is longer than one reading holds.`,
      ...notes,
    ];
  }

  const held: OpmsHeld = {
    version: OPMS_VERSION,
    at: new Date().toISOString(),
    model: MODEL,
    truncated,
    sheet: { id: row.id, filename: row.filename, uploaded: row.filedOn },
    certificates: {
      total: evidence.total,
      read: evidence.read,
      unread: evidence.unread,
      unreadable: evidence.unreadable,
      capped: evidence.capped,
    },
    check: result,
  };

  await store.setJSON(key, held);
  return { cached: false, held };
}

/** Forget the held answers, so the next run asks the question again. */
export async function resetOPMS() {
  const store = opmsStore();
  let cleared = 0;
  const { blobs } = await store.list();
  for (const blob of blobs) {
    await store.delete(blob.key);
    cleared++;
  }
  return cleared;
}

// ---------------------------------------------------------------------------
// The job: what was asked, what came of it, and asking after it
// ---------------------------------------------------------------------------

/**
 * The state of one run, which is all the portal can see of it.
 *
 * "running" is written before the work starts, so a portal that asks the moment
 * after it started is told the run exists rather than that there is no such job.
 */
export type OpmsJob = {
  id: string;
  at: string;
  state: "running" | "done" | "error";
  finishedAt?: string;
  cached?: boolean;
  error?: string;
  missing?: string[];
  result?: OpmsHeld;
  // Set the moment a worker invocation claims the job to actually run it — see
  // runOpmsJob. Absent while the job is merely "running" as startOpmsJob wrote
  // it, i.e. asked for but not yet picked up by a worker.
  claimedAt?: string;
};

/** What the portal asked for, kept where the worker can pick it up. */
type OpmsJobInput = {
  cols: Matrix["cols"];
  rows: Matrix["rows"];
  text: string | null;
  force: boolean;
};

function jobStore() {
  // Strong consistency: the portal starts a run and asks after it a second
  // later, and "no such job" would look to it like the run had been lost.
  return getStore({ name: "opms-jobs", consistency: "strong" });
}

const jobKey = (id: string) => `job/${id}.json`;
const inputKey = (id: string) => `input/${id}.json`;

// Records are kept long enough to be read by whoever started the run and no
// longer. Nothing reads a finished run's answer from here — it is held with the
// other answers, keyed by what it was made from — so six hours is generous.
const KEEP_JOBS_MS = 6 * 60 * 60 * 1000;

/**
 * The id carries the time it was made, in base 36, so old records can be swept
 * up from the list of keys alone without reading every one of them.
 */
const newJobId = () => `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

const startedAt = (id: string) => {
  const at = parseInt(id.split("-")[0] || "", 36);
  return Number.isFinite(at) ? at : 0;
};

/** Sweep up the runs that finished long ago, and anything they were made from. */
async function pruneJobs() {
  const store = jobStore();
  const cutoff = Date.now() - KEEP_JOBS_MS;
  for (const prefix of ["job/", "input/"]) {
    const { blobs } = await store.list({ prefix });
    for (const blob of blobs) {
      const id = blob.key.slice(prefix.length).replace(/\.json$/, "");
      const at = startedAt(id);
      // An id whose stamp can't be read is left alone rather than guessed at.
      if (at && at < cutoff) await store.delete(blob.key);
    }
  }
}

/**
 * Write down what was asked and mark the run as going, ready for the worker.
 *
 * The matrix and the export go into the store rather than into the call that
 * starts the worker: a background function is handed at most 256 KB, and a
 * crew matrix and a workbook read as text are comfortably more than that.
 */
export async function startOpmsJob(input: OpmsJobInput) {
  const store = jobStore();
  const id = newJobId();

  await store.setJSON(inputKey(id), input);
  const job: OpmsJob = { id, at: new Date().toISOString(), state: "running" };
  await store.setJSON(jobKey(id), job);

  // Housekeeping, not part of the run: a sweep that fails must not stop a
  // comparison from being made.
  await pruneJobs().catch(() => {});

  return job;
}

export async function readOpmsJob(id: string) {
  return (await jobStore().get(jobKey(id), { type: "json" })) as OpmsJob | null;
}

/**
 * Run the job the id names, and write down what came of it.
 *
 * Nothing is thrown out of here. A background function that throws is retried by
 * the platform a minute later, which would put the same long question to the
 * model again; a failure that is written down is a failure the portal can show
 * and an admin can act on.
 *
 * The endpoint that starts this has two paths that can each reach the worker
 * for the same job: a server-to-server call, and the browser calling the
 * worker directly as the fallback for where the first is blocked. Both can
 * land here for the same id, so the very first thing done is to claim the job
 * with a conditional write keyed off the etag just read — only one invocation's
 * write can match it. The invocation that loses the race returns immediately,
 * before it deletes the input or writes anything, rather than finding the
 * input already gone and turning that into an error over a job the winner may
 * by then have finished successfully.
 */
export async function runOpmsJob(id: string) {
  const store = jobStore();
  const current = await store.getWithMetadata(jobKey(id), { type: "json" });
  if (!current || !current.etag) return;
  const job = current.data as OpmsJob;
  // Already picked up by another invocation, or not a job waiting to be run.
  if (job.state !== "running" || job.claimedAt) return;

  const claimed: OpmsJob = { ...job, claimedAt: new Date().toISOString() };
  const claim = await store.setJSON(jobKey(id), claimed, { onlyIfMatch: current.etag });
  // The etag moved under us: some other invocation claimed it first. Leave the
  // input and the job record exactly as that invocation is dealing with them.
  if (!claim.modified) return;

  const input = (await store.get(inputKey(id), { type: "json" })) as OpmsJobInput | null;
  // The export and the matrix are the largest thing in the store and are of no
  // use to anybody once they have been read.
  await store.delete(inputKey(id)).catch(() => {});

  const finish = async (patch: Partial<OpmsJob>) => {
    await store.setJSON(jobKey(id), { ...claimed, finishedAt: new Date().toISOString(), ...patch });
  };

  if (!input) {
    await finish({ state: "error", error: "What the comparison was asked to run against was lost. Run it again." });
    return;
  }

  try {
    const { cached, held } = await runOpmsCheck(
      { cols: input.cols, rows: input.rows },
      input.text,
      input.force === true,
    );
    await finish({ state: "done", cached, result: held });
  } catch (e) {
    // The account's refusals in their one short sentence, the same as
    // everywhere else; anything else as it stands.
    const error = errorLine(e);
    const missing = e instanceof OpmsMissing ? e.missing : undefined;
    await finish({ state: "error", error, missing });
  }
}
