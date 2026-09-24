/**
 * The training matrix, the skills matrix and the validity periods matrix — read
 * on their own and then held against one another.
 *
 * The skills matrix is the rulebook: what the crew are required to hold, how the
 * items have to be spread across the shifts, and whatever else has to be abided
 * by. The validity periods matrix is its companion — how long each item lasts
 * once it has been done, and when it has to be done again. The training matrix is
 * where the crew stand today. None of them says anything much on its own — the
 * point is the set of them together, and that is what the check works out.
 *
 * It sits outside the route files, the same as `lib/opms.ts` and
 * `lib/shift.ts`, because reading one document and holding the readings against
 * each other are each one long question to the model, and a request that waits
 * for one is cut off by the platform at sixty seconds and reaches the portal as a
 * bare 504 with nothing in it. So `/api/analyse` writes the job down and calls
 * `matrix-read-run` or `matrix-check-run`, which are background functions and
 * have fifteen minutes; what came of it is written to the job record, and the
 * portal asks after it until it is there.
 *
 * The two matrices are required at all times and nothing runs without them. The
 * validity periods matrix is not: with none filed the check is what it always
 * was, and with one filed the periods it gives are what "due" is measured
 * against. A workbook can't be looked at by a vision model, so the portal reads
 * it in the browser with SheetJS and sends the sheets as text. A PDF or a scan is
 * sent as the file itself. Nothing here writes to the portal: what the documents
 * say goes back, and it is the portal that decides what is shown.
 */

import { getStore } from "../compat/blobs.js";
import { RED_DAYS } from "../../../source/shared/bands.js";
import { liveSingleFileRow, singleFileCategory } from "../db/documents.js";
import {
  askJson,
  contentFor,
  errorLine,
  MATRIX_VERSION,
  matrixCheckKey,
  matrixReadingKey,
  matrixStore,
  MAX_ANSWER_TOKENS,
  MODEL,
  todayThere,
  type MatrixReading,
} from "./analysis.js";

// Which document each part of the work is about, and how it is spoken about on
// the way back out. The validity periods are read off the skills matrix itself:
// the office folded the old separate validity spreadsheet into it, so the
// "validity" reading is a second, different question put to the same document —
// the latest skills matrix is always the source. With the periods read, they
// are what "due" is measured against instead of a flat ninety days.
export const MATRIX_DOCS: Record<string, { category: string; label: string }> = {
  training: { category: "training-matrix", label: "training matrix" },
  skills: { category: "skills-matrix", label: "skills matrix" },
  validity: { category: "skills-matrix", label: "validity periods" },
};

/** Raised where a document required at all times isn't on the portal. */
export class MatrixMissing extends Error {
  missing: string[];
  constructor(message: string, missing: string[]) {
    super(message);
    this.name = "MatrixMissing";
    this.missing = missing;
  }
}

/** Raised where the check is asked for before every reading it needs exists. */
export class MatrixUnread extends Error {
  unread: string[];
  constructor(message: string, unread: string[]) {
    super(message);
    this.name = "MatrixUnread";
    this.unread = unread;
  }
}

// Both the training matrix and the skills matrix are required at all times, so
// nothing here runs against one of them alone — an answer built from half the
// picture reads as though it were the whole one.
export const bothRequiredMessage = (missing: string[]) =>
  `The ${missing.join(" and the ")} ${missing.length === 1 ? "is" : "are"} not on the portal. Both documents are required at all times, and the analysis is against the two of them together.`;

/** The documents as they stand on the portal, and which of the required two are missing. */
export async function matrixDocuments() {
  const [training, skills] = await Promise.all([
    liveSingleFileRow("training-matrix"),
    liveSingleFileRow("skills-matrix"),
  ]);

  const missing = [
    training ? null : singleFileCategory("training-matrix")!.label,
    skills ? null : singleFileCategory("skills-matrix")!.label,
  ].filter((x): x is string => !!x);

  // The validity periods live in the skills matrix, so the same file answers
  // twice — once for what is required, once for how long each item lasts. The
  // readings stay separate because they are different questions.
  return { training, skills, validity: skills, missing };
}

const MATRIX_SYSTEM = `You read a vessel's crew training and skills matrices and return JSON only.

You are given one document. It is either a spreadsheet that has been turned into
text sheet by sheet, or a PDF or scan of the same thing. It is a working document
kept by a marine crewing team: expect merged headings, blank spacer rows, codes
in one row and titles in another, and dates written day-first.

Return exactly the JSON object you are asked for and nothing else — no prose, no
markdown fence.

Rules:
- Dates: Australian documents are day-first. "10/03/2028" is 2028-03-10. Return
  every date as YYYY-MM-DD.
- Report what the document says. Never invent a person, an item, a period or a
  rule that isn't on the page, and never calculate a date that isn't printed.
- null is the right answer where the document doesn't say.
- Keep every string short — a phrase or a sentence, not a paragraph.`;

const TRAINING_SHAPE = `{
  "readable": true|false,
  "reason": string|null,            // only when readable is false
  "what": string,                   // one line: what this document is
  "asAt": "YYYY-MM-DD"|null,        // the date the document says it is current to
  "crewCount": number|null,         // how many crew are listed
  "itemCount": number|null,         // how many training items are tracked
  "items": [string],                // the training items, as titled (max 60)
  "crew": [                         // every person listed (max 60)
    {
      "name": string,
      "position": string|null,
      "complete": number|null,      // items recorded as current
      "problems": [                 // ONLY items that are not current: expired,
        {                           // not held, blank where a date is expected,
          "item": string,           // or unreadable. Max 12 per person.
          "status": "expired"|"not-held"|"expiring"|"blank"|"unclear",
          "expires": "YYYY-MM-DD"|null,
          "detail": string|null
        }
      ]
    }
  ],
  "notes": [string]                 // anything about the document itself (max 6)
}`;

const SKILLS_SHAPE = `{
  "readable": true|false,
  "reason": string|null,            // only when readable is false
  "what": string,                   // one line: what this document is
  "requirements": [                 // what the crew must hold (max 80)
    {
      "item": string,
      "code": string|null,
      "appliesTo": string,          // the rank, role or "all crew"
      "validity": string|null,      // how long it stays valid, as written
      "renewal": string|null,       // when it has to be renewed by, as written
      "mandatory": true|false,
      "notes": string|null
    }
  ],
  "shiftAllocation": [              // how items must be spread across shifts (max 30)
    {
      "shift": string,              // the swing, watch or crew the rule is about
      "requirement": string,        // what that shift must have
      "howMany": string|null,       // "2 per shift", "1 per watch", as written
      "notes": string|null
    }
  ],
  "otherRequirements": [string],    // anything else that has to be abided by (max 20)
  "notes": [string]                 // anything about the document itself (max 6)
}`;

const VALIDITY_SHAPE = `{
  "readable": true|false,
  "reason": string|null,            // only when readable is false
  "what": string,                   // one line: what this document is
  "periods": [                      // how long each item stays valid (max 80)
    {
      "item": string,
      "code": string|null,
      "appliesTo": string|null,      // the rank, role or "all crew", where it says
      "validFor": string|null,       // "2 years", "12 months", as written
      "months": number|null,         // the same period in whole months, where it is plain
      "neverExpires": true|false,    // true only where the document says it doesn't lapse
      "renewalWindow": string|null,   // how far ahead it must be renewed, as written
      "refresher": string|null,       // any refresher or recurrency rule, as written
      "notes": string|null
    }
  ],
  "otherRules": [string],           // anything else about currency or renewal (max 20)
  "notes": [string]                 // anything about the document itself (max 6)
}`;

const CHECK_SHAPE = `{
  "headline": string,               // one sentence: where the crew stand
  "compliant": true|false,          // false if anything is being breached today
  "findings": [                     // max 60, worst first
    {
      "severity": "breach"|"due"|"gap"|"query",
      "person": string|null,        // null when it is about the crew as a whole
      "requirement": string,
      "detail": string,             // what is wrong, in one sentence
      "action": string|null         // what would fix it
    }
  ],
  "shiftAllocation": [              // max 30
    {
      "shift": string,
      "requirement": string,
      "required": string,           // what the skills matrix asks for
      "held": string,               // what the training matrix shows
      "ok": true|false,
      "shortfall": string|null
    }
  ],
  "counts": {
    "requirements": number,
    "crew": number,
    "breaches": number,
    "due": number,
    "gaps": number
  },
  "notes": [string]                 // what couldn't be checked, and why (max 8)
}`;

// The model is given five minutes to read a single document. It is a long
// question — a whole workbook, sheet by sheet — and the worker running it has
// fifteen, so this sits inside that with room to spare, the same margin
// `lib/shift.ts` gives its own single-document reading.
const MATRIX_READ_TIMEOUT_MS = 300000;

// Holding three already-read documents against each other is a shorter question
// than reading one of them from the file, but the crew and the requirements can
// both run long, so this is given the same room as the shift allocation check.
const MATRIX_CHECK_TIMEOUT_MS = 300000;

/**
 * Read one of the documents and keep the reading.
 *
 * The reading is kept against the document's own id, so it is read once however
 * many times the check is run, and a replacement document is a new id rather than
 * an overwrite — upload a newer matrix and it is read afresh.
 */
export async function readMatrixOnce(which: string, text: string | null, force: boolean) {
  const doc = MATRIX_DOCS[which];
  const { training, skills, validity, missing } = await matrixDocuments();
  // The two required matrices gate the readings that feed the compliance check.
  // The validity periods matrix stands on its own as well — the certificate
  // comparison reads it to work out expiry dates, whatever else is on file.
  if (missing.length && which !== "validity") throw new MatrixMissing(bothRequiredMessage(missing), missing);

  const row = which === "training" ? training! : which === "skills" ? skills! : validity;
  if (!row) {
    throw new MatrixMissing(`No ${doc.label} is on the portal, so there is nothing to read.`, [doc.label]);
  }

  const store = matrixStore();
  const key = matrixReadingKey(which, row.id);

  if (!force) {
    const already = (await store.get(key, { type: "json" })) as MatrixReading | null;
    if (already) return { ...already, which, cached: true };
  }

  const { block, trimmed } = await contentFor(row, text);

  const instruction =
    which === "training"
      ? `This is the ${doc.label} — where the crew's training stands at the moment.

Return exactly this JSON object:

${TRAINING_SHAPE}

The problems list is the point of this reading: for each person, only the items
that are not current. A person with nothing wrong has an empty list.`
      : which === "skills"
      ? `This is the ${doc.label} — what the crew are required to hold, how long each
item stays valid, how the items must be spread across the shifts, and anything
else that has to be abided by.

Return exactly this JSON object:

${SKILLS_SHAPE}

Read this as the rulebook rather than as a record of any one person. Where a row
gives a validity period, a renewal interval or a per-shift number, that is what
matters most.`
      : `This is the ${doc.label} — how long each item stays valid once it has been
done, and when it has to be done again. It is the companion to the skills matrix:
the skills matrix says what must be held, this says for how long.

Return exactly this JSON object:

${VALIDITY_SHAPE}

Read it item by item. A period is only what the document prints — "2 years", "12
months", "every 5 years" — never one you work out from a date, and \`months\` is
only for a period that is plainly a number of months. Where an item is marked as
not lapsing, say so with neverExpires rather than inventing a period for it.`;

  const { json: reading, truncated } = await askJson({
    system: MATRIX_SYSTEM,
    content: [block, { type: "text", text: instruction }],
    maxTokens: MAX_ANSWER_TOKENS,
    // An answer the model cut partway is kept and said to be cut short.
    keepPartial: true,
    effort: "low",
    timeoutMs: MATRIX_READ_TIMEOUT_MS,
  });

  if (truncated) {
    const notes = Array.isArray(reading.notes) ? reading.notes : [];
    reading.notes = [
      `The reading of ${row.filename} was cut short — what is here is the top of the document rather than all of it.`,
      ...notes,
    ];
  }

  if (trimmed) {
    const notes = Array.isArray(reading.notes) ? reading.notes : [];
    reading.notes = [
      `Only the first part of ${row.filename} was read — the document is longer than one reading holds.`,
      ...notes,
    ];
  }

  const held: MatrixReading = {
    version: MATRIX_VERSION,
    at: new Date().toISOString(),
    model: MODEL,
    which,
    documentId: row.id,
    filename: row.filename,
    reading,
  };

  await store.setJSON(key, held);
  return { ...held, which, cached: false };
}

/**
 * Hold the training status against the skills requirements, and against the
 * validity periods where one has been filed.
 *
 * The two matrices have to be there — this is the step that only means anything
 * with them together. The validity periods matrix is added to the question when
 * the portal holds one: it is what turns "expires in March" into "expired, and
 * this item only runs two years anyway". The answer is kept against the set of
 * documents it was made from, so it survives a refresh, reads the same for
 * everyone, and is asked again when any of them is replaced.
 */
/** What the checker is told "due" means: the window the documents give, or
 *  the red band's days where they give none - read from bands.js, so the
 *  checker's "due" is the same number of days as the matrix's red. */
export const dueMeans = (withValidity: boolean) =>
  withValidity
    ? `the validity periods matrix or the skills matrix gives — the periods matrix first where the two differ — or expiring within ${RED_DAYS} days if neither gives one`
    : `the skills matrix gives, or expiring within ${RED_DAYS} days if it gives none`;

export async function checkMatricesOnce(force: boolean) {
  const { training, skills, validity, missing } = await matrixDocuments();
  if (missing.length) throw new MatrixMissing(bothRequiredMessage(missing), missing);

  const store = matrixStore();
  const key = matrixCheckKey(training!.id, skills!.id, validity ? validity.id : null);

  if (!force) {
    const already = (await store.get(key, { type: "json" })) as Record<string, unknown> | null;
    if (already) return { cached: true, ...already };
  }

  const [trainingRead, skillsRead, validityRead] = (await Promise.all([
    store.get(matrixReadingKey("training", training!.id), { type: "json" }),
    store.get(matrixReadingKey("skills", skills!.id), { type: "json" }),
    validity ? store.get(matrixReadingKey("validity", validity.id), { type: "json" }) : null,
  ])) as (MatrixReading | null)[];

  const unread = [
    trainingRead ? null : "training matrix",
    skillsRead ? null : "skills matrix",
    !validity || validityRead ? null : "validity periods (off the skills matrix)",
  ].filter((x): x is string => !!x);
  if (unread.length) {
    throw new MatrixUnread(`The ${unread.join(" and the ")} hasn't been read yet.`, unread);
  }

  const instruction = `${validityRead ? "Three documents have" : "Two documents have"} been read. Hold them against one another.

The skills matrix is the rulebook — what must be held, for how long it stays
valid, how many of each item every shift must have, and what else must be abided
by. The training matrix is where the crew stand today.${
    validityRead
      ? `
The validity periods matrix says how long each item lasts once it has been done,
and when it has to be done again. Where it and the skills matrix both give a
period for an item, they should agree; where they don't, that is a query.`
      : ""
  }

SKILLS MATRIX (${skills!.filename}):
${JSON.stringify(skillsRead!.reading)}
${
  validityRead
    ? `
VALIDITY PERIODS MATRIX (${validity!.filename}):
${JSON.stringify(validityRead.reading)}
`
    : ""
}
TRAINING MATRIX (${trainingRead!.filename}), current as at whatever it says:
${JSON.stringify(trainingRead!.reading)}

Today is ${todayThere()}.

Return exactly this JSON object:

${CHECK_SHAPE}

How to weigh it:
- "breach"  something required is expired or not held — the requirement is not
            being met today.
- "due"     valid now, but inside the renewal window ${dueMeans(!!validityRead)}.
- "gap"     a requirement the training matrix says nothing about, or a shift that
            is short of what it must have.
- "query"   the documents disagree, or one of them is unclear enough that
            somebody has to look.

Only compare what the documents cover. Where the skills matrix asks for
something the training matrix doesn't track, that is a gap in the record, not a
breach by a person — say so in the detail. Put every requirement the training
matrix can't answer into notes rather than inventing a verdict for it.${
    validityRead
      ? `
Where an item's validity period is known and the training matrix carries a date
that doesn't fit it — a two-year item dated five years out, say — that is a query
against the record rather than a person's breach.`
      : ""
  }`;

  const { json: result, truncated } = await askJson({
    system: MATRIX_SYSTEM,
    content: [{ type: "text", text: instruction }],
    maxTokens: MAX_ANSWER_TOKENS,
    // An answer the model cut partway is kept and said to be cut short.
    keepPartial: true,
    effort: "medium",
    timeoutMs: MATRIX_CHECK_TIMEOUT_MS,
  });

  if (truncated) {
    const notes = Array.isArray(result.notes) ? result.notes : [];
    result.notes = [
      "The answer was cut short — what is listed is the worst of it and was worked out in full, but there may be more underneath it.",
      ...notes,
    ];
  }

  const held = {
    version: MATRIX_VERSION,
    at: new Date().toISOString(),
    model: MODEL,
    training: { id: training!.id, filename: training!.filename, uploaded: training!.filedOn },
    skills: { id: skills!.id, filename: skills!.filename, uploaded: skills!.filedOn },
    validity: validity
      ? { id: validity.id, filename: validity.filename, uploaded: validity.filedOn }
      : null,
    check: result,
  };

  await store.setJSON(key, held);
  return { cached: false, ...held };
}

// ---------------------------------------------------------------------------
// Job bookkeeping shared by the read job and the check job
// ---------------------------------------------------------------------------

// Records are kept long enough to be read by whoever started the run and no
// longer. Nothing reads a finished run's answer from here — it is held with the
// other answers, keyed by the document(s) it was made from — so six hours is
// generous, the same as `lib/opms.ts` and `lib/shift.ts` give their own jobs.
const KEEP_JOBS_MS = 6 * 60 * 60 * 1000;

const jobKey = (id: string) => `job/${id}.json`;
const inputKey = (id: string) => `input/${id}.json`;

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
async function pruneJobs(store: ReturnType<typeof getStore>) {
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

// ---------------------------------------------------------------------------
// The read job: what was asked, what came of it, and asking after it
// ---------------------------------------------------------------------------

/**
 * The state of one reading run, which is all the portal can see of it.
 *
 * "running" is written before the work starts, so a portal that asks the moment
 * after it started is told the run exists rather than that there is no such job.
 */
export type MatrixReadJob = {
  id: string;
  at: string;
  state: "running" | "done" | "error";
  finishedAt?: string;
  cached?: boolean;
  error?: string;
  missing?: string[];
  result?: Record<string, unknown>;
  // Set the moment a worker invocation claims the job to actually run it — see
  // runMatrixReadJob. Absent while the job is merely "running" as
  // startMatrixReadJob wrote it, i.e. asked for but not yet picked up by a worker.
  claimedAt?: string;
};

/** What the portal asked for, kept where the worker can pick it up. */
type MatrixReadJobInput = { which: string; text: string | null; force: boolean };

function readJobStore() {
  // Strong consistency: the portal starts a run and asks after it a second
  // later, and "no such job" would look to it like the run had been lost.
  return getStore({ name: "matrix-read-jobs", consistency: "strong" });
}

/**
 * Write down what was asked and mark the run as going, ready for the worker.
 *
 * The sheet text goes into the store rather than into the call that starts the
 * worker: a background function is handed at most 256 KB, and a workbook read as
 * text is comfortably more than that.
 */
export async function startMatrixReadJob(input: MatrixReadJobInput) {
  const store = readJobStore();
  const id = newJobId();

  await store.setJSON(inputKey(id), input);
  const job: MatrixReadJob = { id, at: new Date().toISOString(), state: "running" };
  await store.setJSON(jobKey(id), job);

  // Housekeeping, not part of the run: a sweep that fails must not stop a
  // reading from being made.
  await pruneJobs(store).catch(() => {});

  return job;
}

export async function readMatrixReadJob(id: string) {
  return (await readJobStore().get(jobKey(id), { type: "json" })) as MatrixReadJob | null;
}

/**
 * Run the reading job the id names, and write down what came of it.
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
export async function runMatrixReadJob(id: string) {
  const store = readJobStore();
  const current = await store.getWithMetadata(jobKey(id), { type: "json" });
  if (!current || !current.etag) return;
  const job = current.data as MatrixReadJob;
  // Already picked up by another invocation, or not a job waiting to be run.
  if (job.state !== "running" || job.claimedAt) return;

  const claimed: MatrixReadJob = { ...job, claimedAt: new Date().toISOString() };
  const claim = await store.setJSON(jobKey(id), claimed, { onlyIfMatch: current.etag });
  // The etag moved under us: some other invocation claimed it first. Leave the
  // input and the job record exactly as that invocation is dealing with them.
  if (!claim.modified) return;

  const input = (await store.get(inputKey(id), { type: "json" })) as MatrixReadJobInput | null;
  // The document text is the largest thing in the store and is of no use to
  // anybody once it has been read.
  await store.delete(inputKey(id)).catch(() => {});

  const finish = async (patch: Partial<MatrixReadJob>) => {
    await store.setJSON(jobKey(id), { ...claimed, finishedAt: new Date().toISOString(), ...patch });
  };

  if (!input) {
    await finish({ state: "error", error: "What the reading was asked to run against was lost. Run it again." });
    return;
  }

  try {
    const result = await readMatrixOnce(input.which, input.text, input.force === true);
    await finish({ state: "done", cached: (result as { cached: boolean }).cached, result });
  } catch (e) {
    // The account's refusals in their one short sentence, the same as
    // everywhere else; anything else as it stands.
    const error = errorLine(e);
    const missing = e instanceof MatrixMissing ? e.missing : undefined;
    await finish({ state: "error", error, missing });
  }
}

// ---------------------------------------------------------------------------
// The check job: what was asked, what came of it, and asking after it
// ---------------------------------------------------------------------------

/** The state of one check run, which is all the portal can see of it. */
export type MatrixCheckJob = {
  id: string;
  at: string;
  state: "running" | "done" | "error";
  finishedAt?: string;
  cached?: boolean;
  error?: string;
  missing?: string[];
  unread?: string[];
  result?: Record<string, unknown>;
  // Set the moment a worker invocation claims the job to actually run it — see
  // runMatrixCheckJob. Absent while the job is merely "running" as
  // startMatrixCheckJob wrote it, i.e. asked for but not yet picked up by a worker.
  claimedAt?: string;
};

/** What the portal asked for, kept where the worker can pick it up. */
type MatrixCheckJobInput = { force: boolean };

function checkJobStore() {
  // Strong consistency, the same as the read job's store.
  return getStore({ name: "matrix-check-jobs", consistency: "strong" });
}

export async function startMatrixCheckJob(input: MatrixCheckJobInput) {
  const store = checkJobStore();
  const id = newJobId();

  await store.setJSON(inputKey(id), input);
  const job: MatrixCheckJob = { id, at: new Date().toISOString(), state: "running" };
  await store.setJSON(jobKey(id), job);

  await pruneJobs(store).catch(() => {});

  return job;
}

export async function readMatrixCheckJob(id: string) {
  return (await checkJobStore().get(jobKey(id), { type: "json" })) as MatrixCheckJob | null;
}

export async function runMatrixCheckJob(id: string) {
  const store = checkJobStore();
  const current = await store.getWithMetadata(jobKey(id), { type: "json" });
  if (!current || !current.etag) return;
  const job = current.data as MatrixCheckJob;
  // Already picked up by another invocation, or not a job waiting to be run.
  if (job.state !== "running" || job.claimedAt) return;

  const claimed: MatrixCheckJob = { ...job, claimedAt: new Date().toISOString() };
  const claim = await store.setJSON(jobKey(id), claimed, { onlyIfMatch: current.etag });
  // The etag moved under us: some other invocation claimed it first. Leave the
  // input and the job record exactly as that invocation is dealing with them.
  if (!claim.modified) return;

  const input = (await store.get(inputKey(id), { type: "json" })) as MatrixCheckJobInput | null;
  await store.delete(inputKey(id)).catch(() => {});

  const finish = async (patch: Partial<MatrixCheckJob>) => {
    await store.setJSON(jobKey(id), { ...claimed, finishedAt: new Date().toISOString(), ...patch });
  };

  if (!input) {
    await finish({ state: "error", error: "What the check was asked to run against was lost. Run it again." });
    return;
  }

  try {
    const result = await checkMatricesOnce(input.force === true);
    await finish({ state: "done", cached: (result as { cached: boolean }).cached, result });
  } catch (e) {
    // The account's refusals in their one short sentence, the same as
    // everywhere else; anything else as it stands.
    const error = errorLine(e);
    const missing = e instanceof MatrixMissing ? e.missing : undefined;
    const unread = e instanceof MatrixUnread ? e.unread : undefined;
    await finish({ state: "error", error, missing, unread });
  }
}
