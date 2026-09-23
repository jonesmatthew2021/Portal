/**
 * The shift allocation guideline against the training matrix.
 *
 * The guideline is not a list of names. It says how many holders of certain
 * training matrix items must be on each shift — day and night — for the swing,
 * and for every swing after it, sometimes naming which positions may count.
 * Whether the vessel meets it is answered by the training matrix: the Swing
 * Compliance page sends up each rostered person's standing — the items they
 * hold valid across the swing, what runs out while they are onboard, and which
 * watch they are on — the sheet on file is read, and the model says requirement
 * by requirement where the swing has enough and where it is short.
 *
 * It runs as a job rather than as a request, the same way the OPMS comparison
 * does and for the same reason: the whole question — a sheet, a swing's crew
 * and forty-odd requirements — is more than a request is allowed to wait for,
 * and a request that waits anyway is cut off by the platform and reaches the
 * portal as a bare 504 with nothing in it. So the endpoint writes down what was
 * asked and hands the work to the `shift-run` background function, which has
 * fifteen minutes, and the portal asks after the job until it is done.
 *
 * The answer is kept against the sheet it was read from and the crew standing
 * it was read against, so asking again with nothing changed is answered from
 * the store without a job at all — and replacing the sheet, moving anyone on
 * the roster, or the matrix moving underneath, asks afresh.
 */

import { getStore } from "../compat/blobs.js";
import { liveSingleFileRow } from "../db/documents.js";
import {
  askJson,
  contentFor,
  MAX_ANSWER_TOKENS,
  MODEL,
  todayThere,
} from "./analysis.js";

const SHIFT_VERSION = "sa3";

export function shiftStore() {
  // Strong consistency, like the others: the page asks after the answer the
  // moment it is written.
  return getStore({ name: "shift-allocation-readings", consistency: "strong" });
}

export const shiftKeyFor = (documentId: string) => `${SHIFT_VERSION}/check-${documentId}.json`;

// The model is given five minutes to answer. It is one long question — a sheet,
// a swing's crew and every requirement on it — and the worker running it has
// fifteen, so this sits inside that with room to spare.
const SHIFT_TIMEOUT_MS = 300000;

// Which crew standing an answer was made against. Two payloads that stringify
// the same are the same question, so the hash of the string is enough to tell
// "asked already" from "someone has been moved, or the matrix has, since".
export function crewFingerprint(crew: unknown) {
  const s = JSON.stringify(crew);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Is the shift allocation sheet on the portal at all? Asked before a job is started. */
export async function shiftSheetRow() {
  return liveSingleFileRow("shift-allocation");
}

export const NO_SHIFT_SHEET =
  "No shift allocation sheet is on the portal. Upload it on the Swings page and the comparison runs against it.";

/** Raised where there is nothing to run against, rather than nothing that worked. */
export class ShiftMissing extends Error {
  missing: string[];
  constructor(message: string, missing: string[]) {
    super(message);
    this.name = "ShiftMissing";
    this.missing = missing;
  }
}

const SHIFT_SYSTEM = `You read a marine crew shift allocation guideline and hold it against the crew's training matrix standing, returning JSON only.

You are given one document — the shift allocation guideline the office keeps.
It is NOT a list of names. It says how many holders of certain training matrix
items are required on each shift — day and night, often written "Shift 1" and
"Shift 2" — for the swing and every swing after it. The vessel works two
shifts: the day shift runs 1200–2400 and the night shift 2400–1200. Where the
sheet writes shifts as times rather than names, 1200–2400 (or "Shift 1") is
the day shift and 2400–1200 (or "Shift 2") is the night shift. Some
requirements name the positions that may count ("GPH", "Any Position", "Chief
Officer or Second Mate"), and some are written as a rule in words rather than
a number ("All must hold at least one of the listed certificates"). It is
either a spreadsheet turned into text sheet by sheet, or a PDF or scan of the
same thing. Expect merged headings, blank spacer rows, and items written
slightly differently from the matrix.

Alongside it you are given the crew rostered onto one swing, each with their
standing on the training matrix: the items they hold valid across the whole
swing, the items that run out while they are onboard, and the watch (day or
night) they are on where one has been set.

Return exactly the JSON object you are asked for and nothing else — no prose, no
markdown fence.

Rules:
- Work requirement by requirement as the sheet gives them, and shift by shift
  where the sheet gives each shift its own number.
- Count a person toward a requirement only when their "holds" list shows the
  item valid for the whole swing. An item in their "expiring" list runs out
  while they are onboard — do not count it, and say so in detail where it is
  the difference between met and short.
- Where a requirement names positions, count only crew in those positions, and
  read the position names against the vessel's shift allocation matrix given
  with the crew — the positions each shift carries.
- Where a requirement lists alternatives, holding any one of them counts.
- A requirement written as a rule rather than a number is checked as the rule
  says, against the crew given.
- A crew member with no shift set counts toward the swing as a whole; where a
  per-shift number can't be settled because watches aren't set, say "unclear"
  with why rather than guessing the split.
- A crew member whose "holds" is null is not on the matrix — never count them,
  and note them where they would have mattered.
- Report what the document says. Never invent a requirement, an item or a
  number that isn't on the page.
- null is the right answer where the document doesn't say.
- Keep every string short — a phrase or a sentence, not a paragraph.`;

const SHIFT_SHAPE = `{
  "readable": true|false,
  "reason": string|null,           // only when readable is false
  "what": string,                  // one line: what this document is
  "headline": string,              // one sentence: how the swing stands against the guideline
  "aligned": true|false,           // false if anything below is short or unclear
  "requirements": [                // one entry per requirement per shift where the sheet splits them (max 40)
    {
      "item": string,              // the training matrix item(s) as the sheet names them, e.g. "QL-16 Fast Rescue Craft (FRC)"
      "shift": "day"|"night"|"both"|"swing",  // "day" is 1200–2400 and "night" 2400–1200; "both" when one number covers each shift alike; "swing" when the sheet doesn't split
      "positions": string|null,    // who may count, as the sheet says ("GPH", "Any Position"), null when it doesn't say
      "required": string,          // the number or the rule, exactly as the sheet gives it
      "have": number|null,         // how many rostered crew meet it on the matrix; null when it can't be counted
      "holders": [string],         // the crew counted, by name (max 12)
      "status": "met"|"short"|"unclear",
      "detail": string|null        // one sentence, only where something is short or unclear — who is missing, what runs out, what couldn't be settled
    }
  ],
  "counts": {
    "requirements": number,        // requirement rows checked
    "met": number,
    "short": number,
    "unclear": number
  },
  "notes": [string]                // anything about the document itself, or crew who couldn't be counted (max 8)
}`;

/** The answer as it is kept, and as the portal is given it. */
export type ShiftHeld = {
  version: string;
  at: string;
  model: string | null;
  sheet: { id: string; filename: string; uploaded: unknown };
  crewFingerprint: string;
  check: Record<string, unknown>;
};

/**
 * The answer already held for the sheet on file and this crew standing, if
 * there is one. Asked by the endpoint before a job is started, so a question
 * already answered costs a blob read rather than a run.
 */
export async function heldShiftAnswer(crew: unknown) {
  const row = await shiftSheetRow();
  if (!row) return { row: null, held: null };
  const held = (await shiftStore().get(shiftKeyFor(row.id), { type: "json" })) as ShiftHeld | null;
  return {
    row,
    held: held && held.crewFingerprint === crewFingerprint(crew) ? held : null,
  };
}

/** Read the guideline on file against the crew standing the portal sent. */
export async function runShiftCheck(text: string | null, crew: unknown, force: boolean) {
  const row = await shiftSheetRow();
  if (!row) throw new ShiftMissing(NO_SHIFT_SHEET, ["shift allocation sheet"]);

  const store = shiftStore();
  const key = shiftKeyFor(row.id);
  const fingerprint = crewFingerprint(crew);

  if (!force) {
    const already = (await store.get(key, { type: "json" })) as ShiftHeld | null;
    // Only an answer made from this same crew standing counts as already given —
    // a crew change or a matrix change since is a different question.
    if (already && already.crewFingerprint === fingerprint) {
      return { cached: true, held: already };
    }
  }

  const { block, trimmed } = await contentFor(row, text);

  const instruction = `This is the shift allocation guideline on file (${row.filename}). Hold it
against the crew the portal has rostered onto one swing, using each person's
training matrix standing given below.

THE ROSTERED CREW AND THEIR TRAINING MATRIX STANDING:
${JSON.stringify(crew)}

Today is ${todayThere()}.

Return exactly this JSON object:

${SHIFT_SHAPE}

How to read the crew data:
- "swing" is the swing being checked, with its dates.
- "items" is the training matrix's own list of items, code then title — the
  sheet names items by these codes, so match against them.
- "positions" is the vessel's own shift allocation matrix — every position it
  carries and the shift each one stands: "both" for the Master, Second Mate,
  Assistant Engineer and GPH, "day" (Shift 1) for Chief Officer (A) and one
  Shift Primary Engineer, "night" (Shift 2) for Chief Officer (B) and the
  other Shift Primary Engineer — the Chief Engineer and the First Engineer
  each stand one of these berths — and "neither" for the Cook, who is a day
  worker. Read a requirement
  that names positions against this list, and where a requirement is written
  per shift count only the positions that shift carries.
- Each crew entry gives the person as the matrix writes them, their position,
  their watch ("day" — the 1200–2400 shift — "night" — the 2400–1200 shift —
  or null when no watch has been set), "holds" — the item codes valid for the
  whole swing — and "expiring" — items that run out while they are onboard,
  with the date. A person whose "holds" is null couldn't be matched to the
  matrix at all.
- Where the sheet doesn't obviously carry this kind of requirement at all, say
  so in notes rather than forcing verdicts out of it.`;

  const { json: result, truncated } = await askJson({
    system: SHIFT_SYSTEM,
    content: [block, { type: "text", text: instruction }],
    maxTokens: MAX_ANSWER_TOKENS,
    effort: "medium",
    timeoutMs: SHIFT_TIMEOUT_MS,
  });

  if (truncated) {
    const notes = Array.isArray(result.notes) ? result.notes : [];
    result.notes = [
      "The answer was cut short — what is listed was worked out in full, but there may be more underneath it.",
      ...notes,
    ];
  }
  if (trimmed) {
    const notes = Array.isArray(result.notes) ? result.notes : [];
    result.notes = [
      `Only the first part of ${row.filename} was read — the document is longer than one reading holds.`,
      ...notes,
    ];
  }

  const held: ShiftHeld = {
    version: SHIFT_VERSION,
    at: new Date().toISOString(),
    model: MODEL,
    sheet: { id: row.id, filename: row.filename, uploaded: row.filedOn },
    crewFingerprint: fingerprint,
    check: result,
  };

  await store.setJSON(key, held);
  return { cached: false, held };
}

/** Forget the held answers, so the next check reads the sheet again. */
export async function resetShiftAllocation() {
  const store = shiftStore();
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
export type ShiftJob = {
  id: string;
  at: string;
  state: "running" | "done" | "error";
  finishedAt?: string;
  cached?: boolean;
  error?: string;
  missing?: string[];
  result?: ShiftHeld;
  // Set the moment a worker invocation claims the job to actually run it — see
  // runShiftJob. Absent while the job is merely "running" as startShiftJob
  // wrote it, i.e. asked for but not yet picked up by a worker.
  claimedAt?: string;
};

/** What the portal asked for, kept where the worker can pick it up. */
type ShiftJobInput = {
  text: string | null;
  crew: unknown;
  force: boolean;
};

function jobStore() {
  // Strong consistency: the portal starts a run and asks after it a second
  // later, and "no such job" would look to it like the run had been lost.
  return getStore({ name: "shift-jobs", consistency: "strong" });
}

const jobKey = (id: string) => `job/${id}.json`;
const inputKey = (id: string) => `input/${id}.json`;

// Records are kept long enough to be read by whoever started the run and no
// longer. Nothing reads a finished run's answer from here — it is held with the
// other answers, keyed by the sheet it was made from — so six hours is generous.
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
 * The sheet text and the crew standing go into the store rather than into the
 * call that starts the worker: a background function is handed at most 256 KB,
 * and a workbook read as text is comfortably more than that.
 */
export async function startShiftJob(input: ShiftJobInput) {
  const store = jobStore();
  const id = newJobId();

  await store.setJSON(inputKey(id), input);
  const job: ShiftJob = { id, at: new Date().toISOString(), state: "running" };
  await store.setJSON(jobKey(id), job);

  // Housekeeping, not part of the run: a sweep that fails must not stop a
  // comparison from being made.
  await pruneJobs().catch(() => {});

  return job;
}

export async function readShiftJob(id: string) {
  return (await jobStore().get(jobKey(id), { type: "json" })) as ShiftJob | null;
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
export async function runShiftJob(id: string) {
  const store = jobStore();
  const current = await store.getWithMetadata(jobKey(id), { type: "json" });
  if (!current || !current.etag) return;
  const job = current.data as ShiftJob;
  // Already picked up by another invocation, or not a job waiting to be run.
  if (job.state !== "running" || job.claimedAt) return;

  const claimed: ShiftJob = { ...job, claimedAt: new Date().toISOString() };
  const claim = await store.setJSON(jobKey(id), claimed, { onlyIfMatch: current.etag });
  // The etag moved under us: some other invocation claimed it first. Leave the
  // input and the job record exactly as that invocation is dealing with them.
  if (!claim.modified) return;

  const input = (await store.get(inputKey(id), { type: "json" })) as ShiftJobInput | null;
  // The sheet text and the crew are the largest thing in the store and are of
  // no use to anybody once they have been read.
  await store.delete(inputKey(id)).catch(() => {});

  const finish = async (patch: Partial<ShiftJob>) => {
    await store.setJSON(jobKey(id), { ...claimed, finishedAt: new Date().toISOString(), ...patch });
  };

  if (!input) {
    await finish({ state: "error", error: "What the comparison was asked to run against was lost. Run it again." });
    return;
  }

  try {
    const { cached, held } = await runShiftCheck(input.text, input.crew, input.force === true);
    await finish({ state: "done", cached, result: held });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const missing = e instanceof ShiftMissing ? e.missing : undefined;
    await finish({ state: "error", error, missing });
  }
}
