/**
 * The AI Checker: a free-form conversation with the model, run as a job.
 *
 * The other AI on the portal is all narrow questions with fixed JSON answers —
 * read this certificate, hold these matrices against each other. This is the
 * open end of it: whatever needs asking, put to the same model through the same
 * gateway.
 *
 * It runs as a job rather than as the answer to the request that asked it, the
 * same way the OPMS and shift comparisons do and for the same reason: a
 * synchronous function is allowed sixty seconds, and a question that hands the
 * model a PDF and asks it to think about it is regularly longer than that. A
 * request that waits anyway is cut off by the platform and reaches the browser
 * as a bare 504 with nothing in it — no answer, and no way to tell a question
 * that was too big from a portal that is broken. So `/api/ai-checker` writes
 * down what was asked and hands it to the `ai-checker-run` background function,
 * which has fifteen minutes; the answer is written to the job record as it
 * arrives, word by word, and the browser reads it from there. What the crew see
 * is what they saw before — an answer that types itself out — with no ceiling
 * on how long it is allowed to take.
 *
 * What it can see is the whole portal. An account of what the portal holds goes
 * up with every question — the sections of the shared record and how much is in
 * each, what is filed under what, how many certificates are on file and how many
 * have been read, which analyses have already been made — and a set of tools go
 * with it, so the model can go and read the parts the question is actually about:
 * the record section by section, the file index, what the certificates say, any
 * one file opened up and looked at, and the analyses the portal already holds.
 * That reach, and the limits on it, are in `lib/portal.ts`; it only ever reads,
 * and it never starts one of the portal's long analysis runs.
 *
 * Answering is therefore several calls to the model rather than one: it asks for
 * something, is given it, and asks again, until it has enough to answer. That is
 * why the whole thing runs in a background function with fifteen minutes rather
 * than in the request that asked it. Between rounds the job record carries a
 * short line saying what is being looked at, so a question that takes a minute
 * doesn't look to whoever asked like a portal that has stopped.
 *
 * A question can carry files as well as words — images and PDFs, sent up as
 * base64 and handed to the model as its own image and document blocks, so
 * "what does this say" works on a photographed certificate or a PDF the same as
 * on pasted text. Spreadsheets come up a different way: a .xlsx is a zip and no
 * model can be handed one, so the browser opens the workbook with the reader the
 * portal already loads for its own uploads and sends what the sheets say as
 * text, which arrives here as an attachment carrying words instead of bytes.
 *
 * Nothing is kept beyond the run. The conversation lives in the browser that is
 * having it and is sent up whole with every question; the job record holds it
 * only while the answer is being written, and is swept up afterwards.
 */

import { getStore } from "../compat/blobs.js";
import { getEnv } from "../env.js";
import { MODEL, ModelRefusal, plainLine, refusalSays } from "./analysis.js";
import { newReach, PORTAL_TOOLS, portalOverview, runPortalTool, stepFor } from "./portal.js";

// Enough for a long answer without letting one question sit on the account's
// tokens-per-minute ceiling. max_tokens covers the model's thinking as well.
const MAX_ANSWER_TOKENS = 8000;

// The conversation is sent up whole every time, so it has to be kept within
// reason: the last turns are the ones that matter, and a runaway thread is
// better cut short here than refused by the model for its size.
const MAX_TURNS = 30;
const MAX_CHARS_PER_TURN = 12000;
const MAX_CHARS_TOTAL = 100000;

// What a question may attach: the images the model can look at, and PDFs it
// can read. Everything else is turned away by name rather than passed on to
// fail obscurely upstream.
const ATTACH_TYPES = new Set([
  "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp",
]);

// Spreadsheets, which arrive as the text of their sheets rather than as a file:
// the browser reads the workbook and sends the rows, because a .xlsx is a zip
// and there is nothing in it a model can look at.
const SHEET_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/vnd.ms-excel",
  "text/csv",
]);
// A workbook read as text runs long — every sheet, every row. Roughly 15,000
// tokens for one and 30,000 across a request, which leaves the model room to
// think and answer even with a thread behind it.
const MAX_SHEET_CHARS = 60000;
const MAX_SHEET_CHARS_TOTAL = 120000;

const MAX_FILES_PER_TURN = 4;
// Base64 characters, not bytes: roughly 3.2MB and 3.4MB of file respectively.
// The browser applies the same discipline before sending — these are the
// backstop for a request that arrives from anywhere else.
const MAX_FILE_B64 = 4400000;
const MAX_ATTACH_B64_TOTAL = 4600000;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

// The model's own deadline, well inside the worker's fifteen minutes. Nothing
// here should come close to it; it is the backstop against an upstream that
// accepted the question and then went quiet.
const CHECKER_TIMEOUT_MS = 600000;

// A question is put to the gateway more than once before it is given up on. A
// request that never arrives — a socket closed partway through the upload, a
// name that would not resolve, the gateway itself having a moment — costs
// nothing to send again, and is the whole of what went wrong most times this
// goes wrong. The narrow AI on the portal has always asked twice; this asked
// once, so a single blip on a question the crew had waited minutes for was the
// end of it.
const GATEWAY_ATTEMPTS = 3;
const RETRY_WAIT_MS = [1500, 4000];

// How many times round the loop one question may go: ask the model, hand it what
// it asked the portal for, ask again. Twelve is far more than any real question
// needs — a thorough one is three or four — and is there as the backstop against
// a model that keeps looking things up instead of answering. Each round is a
// whole call, and the conversation, every tool answer in it included, goes up
// again on every one of them.
const MAX_TOOL_ROUNDS = 12;

// How many questions may be answered at once. Nothing else here bounds the
// number of jobs that can exist together — every other cap is on a single
// conversation — and each one is several calls to the model with a PDF or two
// riding along, so an unbounded number of them is an unbounded bill and an
// unbounded load on the gateway. Five is generously more than the crew this
// portal serves would ever have asking at the same moment.
const MAX_RUNNING_JOBS = 5;

// How long a job marked "running" is believed to still be running. A worker
// that dies partway through never writes the job's ending, so the record reads
// "running" until pruneJobs sweeps it an hour on — and five of those would lock
// everybody out for the rest of that hour. A background function has fifteen
// minutes from the platform, so anything older than twenty is dead, whatever
// its record says.
const MAX_RUNNING_AGE_MS = 20 * 60 * 1000;

const SYSTEM = `You are the AI Checker on the Coolibah crew portal — a shared web portal used by the marine crew of a vessel operated by United Marine. It is the one place on the portal where anything at all can be asked, and crew members ask you anything: drafting text, checking working, explaining regulations or procedures, doing sums, summarising something they paste in or attach, general questions, and questions about the portal's own records and documents.

You can see the portal. An account of what it holds is put in front of you with every question, and you have tools that go and read it: the shared record the portal keeps — the crew establishment, who is onboard and on which watch, the swing rotation and the dates given for each swing, handover notes, correspondence threads, the suggestion board, comments, the matrix items, and the log of who changed what — the index of every file uploaded to the portal, what each crew certificate on file says, any one of those files opened up so you can look at the document itself, and the analyses the portal has already worked out.

How to work:
- Look before you answer. A question about the roster, a note, a certificate, a
  document, or anything the portal records is answered by going and reading it —
  not from what an earlier message happened to mention, and never from a guess.
  Where the first look raises a second question, take the second look.
- Say what an answer came from: the document, the section of the record, or the
  analysis. Whoever asked has to be able to check it. Where an analysis was made
  on an earlier date, give the date — something filed since may have overtaken it.
- You read the portal. You never change it. If somebody asks you to file, edit,
  remove or upload something, say plainly that you can't and say where on the
  portal it is done.
- You cannot run the portal's analyses. Reading the certificates, reading the
  matrices and comparing the OPMS export are long jobs started deliberately from
  the portal's own pages; you can only read the answers already made. Where one
  hasn't been made, say so and say which page makes it.
- A certificate is the document itself, so it outranks any spreadsheet or record
  that disagrees with it. Where they disagree, say so plainly and say which is
  which rather than picking one quietly.
- A certificate nobody has read is not the same thing as a certificate nobody
  holds, and a file that isn't on the portal is not proof that a qualification is
  missing. Be exact about that difference every time it comes up.
- The record holds personal information about named crew. Answer the question
  that was asked, and don't volunteer people's details beyond it.

How to answer:
- Be direct and practical. Lead with the answer, then whatever supports it.
- Plain text only — no markdown headings, tables, bold or code fences. Simple
  hyphen lists and blank lines between paragraphs are fine; the portal shows
  your answer exactly as written.
- Dates in Australia are day-first. The crew work in Australian Western
  Standard Time, and the day it is there is given to you with every question.
- A question may carry attached files — images, PDFs, and spreadsheets. A
  spreadsheet reaches you as the text of its sheets, each one under a "### SHEET:"
  line with the rows below it as comma-separated values, so read it as a grid:
  the first rows are usually headings, and a long row of commas is empty cells.
  Read attachments and answer from what they actually contain. If an attachment
  is unreadable or seems to be missing, say so rather than guessing at it.
- Never invent facts, figures or regulations, and never invent what the portal
  holds. Say plainly when you don't know, when something isn't on the portal, or
  when something should be checked against the official source.`;

export type Attachment = { name: string; type: string; data?: string; text?: string };
export type Turn = { role: "user" | "assistant"; content: string; attachments?: Attachment[] };

/** One attachment off the wire, or null if it isn't one this function takes. */
function attachmentFrom(raw: unknown): Attachment | null {
  if (!raw || typeof raw !== "object") return null;
  const name = (raw as { name?: unknown }).name;
  const type = (raw as { type?: unknown }).type;
  const data = (raw as { data?: unknown }).data;
  const text = (raw as { text?: unknown }).text;
  if (typeof name !== "string" || !name.trim()) return null;
  if (typeof type !== "string") return null;
  const sheet = SHEET_TYPES.has(type);
  if (!sheet && !ATTACH_TYPES.has(type)) return null;
  const named = { name: name.trim().slice(0, 200), type };

  // A name-only marker is legitimate: the browser drops the bytes of older
  // attachments to keep the request within bounds, and sends the name so the
  // model still knows the file was part of the conversation.
  if (sheet) {
    if (text === undefined || text === null || text === "") return named;
    if (typeof text !== "string") return null;
    return { ...named, text: text.slice(0, MAX_SHEET_CHARS) };
  }
  if (data === undefined || data === null || data === "") return named;
  if (typeof data !== "string") return null;
  // Too large to forward, but not nothing: the name is kept so the attachment
  // survives into the turn as a name-only marker, the same shape the browser
  // itself sends for a file it has already dropped the bytes of. `messageFrom`
  // already turns a name-only marker into a "gone" notice the model can see —
  // silently returning null here instead would drop the file without a trace.
  if (data.length > MAX_FILE_B64) return named;
  if (!B64.test(data)) return null;
  return { ...named, data };
}

/** The conversation as sent up, trimmed to what is worth forwarding. */
export function turnsFrom(body: unknown): Turn[] | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { messages?: unknown }).messages;
  if (!Array.isArray(raw) || !raw.length) return null;

  const turns: Turn[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") return null;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string") return null;
    const text = content.slice(0, MAX_CHARS_PER_TURN).trim();

    let attachments: Attachment[] | undefined;
    const rawFiles = (m as { attachments?: unknown }).attachments;
    if (role === "user" && Array.isArray(rawFiles) && rawFiles.length) {
      attachments = rawFiles.slice(0, MAX_FILES_PER_TURN)
        .map(attachmentFrom)
        .filter((a): a is Attachment => a !== null);
      if (!attachments.length) attachments = undefined;
    }

    // A turn that says nothing and carries nothing has nothing to forward.
    if (!text && !attachments) continue;
    turns.push({ role, content: text, attachments });
  }
  if (!turns.length || turns[turns.length - 1].role !== "user") return null;

  // The most recent turns, kept whole, until the caps are met.
  const kept: Turn[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && kept.length < MAX_TURNS; i--) {
    chars += turns[i].content.length;
    if (chars > MAX_CHARS_TOTAL && kept.length) break;
    kept.unshift(turns[i]);
  }
  // The model requires the thread to open with the user speaking.
  while (kept.length && kept[0].role !== "user") kept.shift();
  if (!kept.length) return null;

  // Attachment bytes are budgeted separately from the words, newest first, so
  // one big PDF early in a thread can't crowd out the file the question that
  // just arrived is actually about. Sheet text has its own budget for the same
  // reason. Anything over the line keeps its name and loses its contents, same
  // as the browser does on its side.
  let b64Left = MAX_ATTACH_B64_TOTAL;
  let sheetLeft = MAX_SHEET_CHARS_TOTAL;
  for (let i = kept.length - 1; i >= 0; i--) {
    const files = kept[i].attachments;
    if (!files) continue;
    kept[i] = {
      ...kept[i],
      attachments: files.map((a) => {
        if (a.text && a.text.length <= sheetLeft) { sheetLeft -= a.text.length; return a; }
        if (a.data && a.data.length <= b64Left) { b64Left -= a.data.length; return a; }
        return { name: a.name, type: a.type };
      }),
    };
  }
  return kept;
}

/** One content block on the wire. Deliberately loose: several kinds go through here. */
type Block = Record<string, unknown>;

/** One message on the wire. */
type Wire = { role: string; content: string | Block[] };

/** A turn as the model takes it: bare text, or blocks when files ride along. */
function messageFrom(t: Turn): Wire {
  if (!t.attachments || !t.attachments.length) return { role: t.role, content: t.content };

  const blocks: Block[] = [];
  const gone: string[] = [];
  for (const a of t.attachments) {
    // A spreadsheet is already words by the time it gets here, and goes in
    // ahead of the question so the model reads the sheets then what was asked.
    if (SHEET_TYPES.has(a.type)) {
      if (!a.text) { gone.push(a.name); continue; }
      blocks.push({ type: "text", text: `${a.name}, read as text sheet by sheet:\n\n${a.text}` });
      continue;
    }
    if (!a.data) { gone.push(a.name); continue; }
    if (a.type === "application/pdf") {
      blocks.push({ type: "document", source: { type: "base64", media_type: a.type, data: a.data } });
    } else {
      blocks.push({ type: "image", source: { type: "base64", media_type: a.type, data: a.data } });
    }
  }

  const text = [
    t.content,
    gone.length
      ? `[${gone.join(", ")} ${gone.length > 1 ? "were" : "was"} attached to this question but ${gone.length > 1 ? "are" : "is"} no longer included in the conversation — too much attachment data to resend. Say so if the question needs ${gone.length > 1 ? "them" : "it"}.]`
      : "",
  ].filter(Boolean).join("\n\n");
  if (text) blocks.push({ type: "text", text });

  return { role: t.role, content: blocks };
}

// ---------------------------------------------------------------------------
// The job: what was asked, the answer as it is written, and asking after it
// ---------------------------------------------------------------------------

/**
 * The state of one question, which is all the browser can see of it.
 *
 * "running" is written before the model is called, so a browser that asks the
 * moment after it started is told the question exists rather than that there is
 * no such job. `text` is the answer so far and grows as it is written — the
 * browser takes what it hasn't already got and appends it, which is how an
 * answer still types itself out with a job in the middle.
 */
export type CheckerJob = {
  id: string;
  at: string;
  state: "running" | "done" | "error";
  text: string;
  finishedAt?: string;
  error?: string;
  // The answer stopped before the model had finished writing it — out of room,
  // or the stream broke. What had arrived stands, with a line saying so.
  note?: string;
  // What is being looked at right now, in the present tense, while the answer is
  // still being worked on. A question that sends the model through the roster,
  // then the certificates, then a scan is a minute of nothing arriving, and
  // without this the page looks stuck rather than busy. It is dropped the moment
  // the answer itself starts arriving, and is never part of the answer.
  step?: string;
  // When the worker that is actually going to run this job claimed it. The
  // handover from `/api/ai-checker` to the worker is a call across the network
  // and can fail after being accepted rather than before, so the browser is
  // sometimes handed a path to start the same worker itself just in case it
  // wasn't. Two calls can both end up trying to run the same job; this is the
  // mark the first one leaves so the second can tell and step aside rather than
  // run the model a second time over the same record.
  claimedAt?: string;
};

function jobStore() {
  // Strong consistency: the browser asks a question and reads the answer a
  // second later, and "no such job" would look to it like the question had
  // been lost.
  return getStore({ name: "ai-checker-jobs", consistency: "strong" });
}

const jobKey = (id: string) => `job/${id}.json`;
const inputKey = (id: string) => `input/${id}.json`;

// Records are kept long enough to be read by the browser that asked and no
// longer. Nothing else ever reads them: the conversation belongs to the browser
// having it, and the portal keeps no history of what anyone asked.
const KEEP_JOBS_MS = 60 * 60 * 1000;

/**
 * The id carries the time it was made, in base 36, so old records can be swept
 * up from the list of keys alone without reading every one of them.
 */
const newJobId = () => `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

const startedAt = (id: string) => {
  const at = parseInt(id.split("-")[0] || "", 36);
  return Number.isFinite(at) ? at : 0;
};

/** Sweep up the questions answered long ago, and anything they were asked with. */
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

/** Raised when the portal already has as many questions running as it allows. */
export class CheckerBusy extends Error {}

/**
 * How many questions are currently being answered.
 *
 * There's no ledger of this kept anywhere — the job records are the only
 * account of what's going on — so it's read the same way `pruneJobs` sweeps
 * them: list what's under `job/` and look at each one. The list stays short
 * because finished jobs are only kept an hour and this cap keeps more from
 * ever piling up, so reading every one of them is cheap.
 */
async function countRunningJobs() {
  const store = jobStore();
  const { blobs } = await store.list({ prefix: "job/" });
  const cutoff = Date.now() - MAX_RUNNING_AGE_MS;
  let running = 0;
  for (const blob of blobs) {
    const job = (await store.get(blob.key, { type: "json" }).catch(() => null)) as CheckerJob | null;
    // A "running" job older than MAX_RUNNING_AGE_MS is a worker that died
    // without writing its ending, not a question being answered — it must not
    // hold a slot against the crew until the sweep gets to it.
    if (job && job.state === "running" && Date.parse(job.at) > cutoff) running++;
  }
  return running;
}

/**
 * Write down the conversation and mark the question as going, ready for the
 * worker.
 *
 * The conversation goes into the store rather than into the call that starts the
 * worker: a background function is handed at most 256 KB, and a question with a
 * PDF on it is several megabytes.
 */
export async function startCheckerJob(turns: Turn[]) {
  const store = jobStore();

  // Checked before anything is written down: turning a question away here costs
  // nothing, where writing it down and starting a worker for it that then has to
  // be turned away costs a job slot and a background function for no answer.
  if ((await countRunningJobs()) >= MAX_RUNNING_JOBS) {
    throw new CheckerBusy("Too many checks are running right now. Wait a moment and try again.");
  }

  const id = newJobId();

  await store.setJSON(inputKey(id), { turns });
  const job: CheckerJob = { id, at: new Date().toISOString(), state: "running", text: "" };
  await store.setJSON(jobKey(id), job);

  // Housekeeping, not part of the run: a sweep that fails must not stop a
  // question from being asked.
  await pruneJobs().catch(() => {});

  return job;
}

export async function readCheckerJob(id: string) {
  return (await jobStore().get(jobKey(id), { type: "json" })) as CheckerJob | null;
}

// How often the answer so far is written down while it is arriving. Often enough
// that it still reads as typing, seldom enough that a long answer isn't a
// thousand writes: whichever of these comes first.
const FLUSH_MS = 700;
const FLUSH_CHARS = 350;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What actually went wrong underneath a request that never arrived.
 *
 * Node reports every network failure as the same three words — "fetch failed" —
 * and puts the reason for it on the error underneath: a refused connection, a
 * name that would not resolve, a socket closed mid-upload, a deadline. Passing
 * on only the message tells whoever reads it nothing, and told nobody anything:
 * "The AI could not be reached: fetch failed" is what the crew saw and what the
 * function log said, and neither names a thing that can be acted on. So the
 * chain underneath is walked and what it is called is kept.
 */
function causeOf(e: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let at: unknown = e;
  while (at instanceof Error && !seen.has(at)) {
    seen.add(at);
    const code = (at as { code?: unknown }).code;
    const named = typeof code === "string" && code ? code : at.message;
    if (named && !parts.includes(named)) parts.push(named);
    at = (at as { cause?: unknown }).cause;
  }
  return parts.join(" — ") || String(e);
}

/**
 * One assistant turn as it came off the stream, kept exactly as it arrived.
 *
 * "Exactly" is the whole point of this shape. A turn that ends in a request for
 * something from the portal has to be sent back up with the answer, and the
 * model's thinking blocks are part of it: they carry a signature over their own
 * contents, and one that has been tidied, reordered or dropped is a 400 on the
 * next call rather than an answer. So the blocks are collected in the order they
 * were written and handed back untouched — including the thinking blocks that
 * arrive with nothing in them, which is what a model asked not to show its
 * thinking sends.
 */
type Turned = {
  blocks: Block[];
  calls: { id: string; name: string; input: Record<string, unknown> }[];
  stop: string | null;
  broke: boolean;
};

type SseEvent = {
  type?: string;
  index?: number;
  content_block?: Record<string, unknown>;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  error?: { message?: string };
};

/**
 * Read one turn off the model's stream.
 *
 * The words of the answer are handed out as they arrive, so the portal can show
 * an answer being written; everything else is assembled — the thinking, the
 * signatures over it, and what the model is asking the portal for, which comes
 * as a JSON document a few characters at a time and is only worth anything once
 * the last of it has landed.
 *
 * A stream that stops partway is not an error here. Whatever had arrived is
 * handed back with `broke` set, because half an answer that says so is worth more
 * to whoever asked than a failure that throws the lot away.
 */
async function readTurn(
  body: ReadableStream<Uint8Array>,
  onText: (chunk: string) => Promise<void>,
): Promise<Turned> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const blocks: Block[] = [];
  // Where each block the stream is talking about sits in the list, and the tool
  // input as it arrives, both keyed by the index the stream gives them.
  const seat = new Map<number, number>();
  const partial = new Map<number, string>();
  let stop: string | null = null;
  let broke = false;

  reading: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let event: SseEvent;
      try {
        event = JSON.parse(payload) as SseEvent;
      } catch {
        // A half-arrived line is picked up on the next read.
        continue;
      }

      const index = event.index ?? 0;

      if (event.type === "content_block_start" && event.content_block) {
        const started: Block = { ...event.content_block };
        if (started.type === "tool_use") {
          started.input = {};
          partial.set(index, "");
        }
        seat.set(index, blocks.push(started) - 1);
        continue;
      }

      if (event.type === "content_block_delta" && event.delta) {
        const where = seat.get(index);
        if (where === undefined) continue;
        const block = blocks[where];
        const d = event.delta;
        if (d.type === "text_delta" && d.text) {
          block.text = `${(block.text as string) || ""}${d.text}`;
          await onText(d.text);
        } else if (d.type === "thinking_delta" && d.thinking) {
          block.thinking = `${(block.thinking as string) || ""}${d.thinking}`;
        } else if (d.type === "signature_delta" && d.signature) {
          block.signature = `${(block.signature as string) || ""}${d.signature}`;
        } else if (d.type === "input_json_delta") {
          partial.set(index, `${partial.get(index) || ""}${d.partial_json || ""}`);
        }
        continue;
      }

      if (event.type === "message_delta" && event.delta?.stop_reason) {
        stop = event.delta.stop_reason;
        continue;
      }

      if (event.type === "error") {
        console.error(`ai-checker: the stream carried an error (${event.error?.message || "no reason given"}).`);
        broke = true;
        break reading;
      }
    }
  }

  // A stream that was given up on partway is closed off rather than left open:
  // this is a background function and nothing else will come along and tidy it.
  if (broke) await reader.cancel().catch(() => {});

  // What the model is asking the portal for, now that the whole of each request
  // has arrived. An input that won't parse is treated as an empty one: the tool
  // says what it needed and the model asks again, which is a better round than a
  // question abandoned over a truncated brace.
  const calls: Turned["calls"] = [];
  for (const [index, where] of seat) {
    const block = blocks[where];
    if (block.type !== "tool_use") continue;
    const raw = (partial.get(index) || "").trim();
    let input: Record<string, unknown> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
      } catch {
        input = {};
      }
    }
    block.input = input;
    calls.push({ id: String(block.id || ""), name: String(block.name || ""), input });
  }

  return { blocks, calls, stop, broke };
}

/**
 * Where the conversation is cached from, moved along as it grows.
 *
 * Every round sends the whole conversation up again — the question, everything
 * the model has read off the portal since, and any document it has opened — so by
 * the third or fourth round most of the request is words the gateway has already
 * been given. Marking the end of it lets that part be answered from cache instead
 * of read again. The mark is the only thing that moves: the previous one is taken
 * off first, because it is the position that says where the cached part ends and
 * two of them would divide it in the wrong place.
 *
 * The instructions and the tool definitions are marked separately and never move,
 * which is the larger saving — they are identical on every question the portal
 * ever asks.
 */
function markCache(messages: Wire[]) {
  for (const m of messages) {
    if (Array.isArray(m.content)) for (const b of m.content) delete b.cache_control;
  }
  const last = messages[messages.length - 1];
  if (!Array.isArray(last?.content) || !last.content.length) return;
  const block = last.content[last.content.length - 1];
  // Never on a thinking block: those go back up exactly as they arrived.
  if (block.type === "thinking" || block.type === "redacted_thinking") return;
  block.cache_control = { type: "ephemeral" };
}

/**
 * Put the question to the model, let it read the portal, and write the answer
 * down as it arrives.
 *
 * Answering is a loop rather than a call: the model asks for what it needs off
 * the portal, is handed it, and asks again until it has enough. Whatever it
 * writes along the way is written to the job record as it arrives, so the portal
 * still shows an answer being typed, and between rounds the record carries a line
 * saying what is being looked at so a long question doesn't look like a stopped
 * one.
 *
 * Nothing is thrown out of here. A background function that throws is retried by
 * the platform a minute later, which would put the same question a second time
 * and bill for it; a failure that is written down is one the browser can show
 * and whoever asked can act on.
 */
/** The model was busy or over its rate. Nothing asks the checker's
 *  question again by itself - the hour re-reads certificates, not this -
 *  so the shared "tried again next hour" line would not be true here. */
export const AI_BUSY = "The AI is busy — ask again in a minute";

/** The one line the checker says for a refusal: no credit and a refused
 *  key in the same sentence as everywhere else (plainLine), a busy model
 *  in this screen's own, and a question the model turned away as it was. */
export function checkerRefusalLine(refusal: ModelRefusal): string {
  if (refusal.kind === "credit" || refusal.kind === "key") return plainLine(refusal);
  if (refusal.kind === "rate" || refusal.kind === "busy") return AI_BUSY;
  const said = refusalSays(refusal);
  return `The AI turned the question away (${refusal.status}).${said ? ` ${said}` : ""}`;
}

export async function runCheckerJob(id: string) {
  const store = jobStore();

  // The handover from `/api/ai-checker` to this worker is a call across the
  // network, and a call that fails proves only that the answer wasn't read
  // back — the worker may already have been accepted and be running by the
  // time it looked like it hadn't started. `/api/ai-checker` hands the browser
  // a path to start the same worker itself for exactly that case, so this can
  // be asked to run the same job twice at once. Both would keep their own
  // `text` and each would overwrite the job record whole, garbling the answer
  // between them with nothing to say why.
  //
  // So the job is claimed before anything else happens: read it, and write a
  // claim mark back conditioned on the record not having moved since. The
  // blob store's conditional write is atomic — of two calls racing to write the same
  // condition, only one can ever have it hold — so exactly one of two
  // concurrent invocations wins the claim and the other finds out its write
  // didn't take and stops here, before any AI work or further writes.
  const found = await store.getWithMetadata(jobKey(id), { type: "json" });
  if (!found || !found.etag) return;
  let job = found.data as CheckerJob;
  // Not yet claimed by anybody else — the state this invocation needs to be
  // the one that gets to run it.
  if (job.claimedAt) return;
  let etag: string = found.etag;

  const claimed: CheckerJob = { ...job, claimedAt: new Date().toISOString() };
  const claim = await store.setJSON(jobKey(id), claimed, { onlyIfMatch: etag });
  if (!claim.modified || !claim.etag) {
    // Lost the race (or the write didn't come back with an etag to keep
    // proving ownership with) — either way, this invocation doesn't own the
    // job and must not touch it again.
    return;
  }
  job = claimed;
  etag = claim.etag;

  const input = (await store.get(inputKey(id), { type: "json" })) as { turns?: Turn[] } | null;
  // The conversation is the largest thing in the store — a question with a PDF
  // on it is megabytes — and is of no use to anybody once it has been read.
  await store.delete(inputKey(id)).catch(() => {});

  let text = "";
  let step = "";
  // Set the moment a write loses the claim — the etag moved under us, which
  // means some other invocation of this same job now owns the record. Once
  // this is true every further write is skipped: there is nothing here left
  // that is safe to do to a record another run owns.
  let lost = false;
  const write = async (patch: Partial<CheckerJob>) => {
    if (lost) return;
    const result = await store.setJSON(
      jobKey(id),
      { ...job, text, ...(step ? { step } : {}), ...patch },
      { onlyIfMatch: etag },
    );
    if (!result.modified || !result.etag) {
      lost = true;
      console.error(`ai-checker job ${id}: lost the claim on the job record mid-run — another invocation must hold it now. Stopping.`);
      return;
    }
    etag = result.etag;
  };
  const finish = async (patch: Partial<CheckerJob>) => {
    step = "";
    await write({ finishedAt: new Date().toISOString(), ...patch });
  };

  const turns = input?.turns;
  if (!turns || !turns.length) {
    await finish({ state: "error", error: "What was asked was lost before it could be answered. Ask again." });
    return;
  }

  const key = getEnv().ANTHROPIC_API_KEY;
  const base = getEnv().ANTHROPIC_BASE_URL;
  if (!key || !base) {
    await finish({
      state: "error",
      error: "AI isn't available on this deploy yet. AI Gateway switches on once the project has a production deploy.",
    });
    return;
  }

  const stopwatch = new AbortController();
  const deadline = setTimeout(() => stopwatch.abort(), CHECKER_TIMEOUT_MS);

  // How much file is riding on this question, for the message if it cannot be
  // sent at all: a question carrying files is a request of several megabytes,
  // and one that keeps failing to go out is worth trying smaller.
  const attachedB64 = turns.reduce(
    (sum, t) => sum + (t.attachments?.reduce((n, a) => n + (a.data?.length || 0), 0) || 0),
    0,
  );

  // How often the answer so far is written down, and the line about what is being
  // looked at cleared the moment real words start arriving — the two must never be
  // on the page at once.
  let flushedAt = Date.now();
  let flushedLen = 0;
  const onText = async (chunk: string) => {
    text += chunk;
    const clearing = step !== "";
    if (clearing) step = "";
    if (clearing || text.length - flushedLen >= FLUSH_CHARS || Date.now() - flushedAt >= FLUSH_MS) {
      // A write that fails is not an answer that failed: the next flush, or the
      // finish below, carries everything written so far anyway.
      await write({ state: "running" }).catch(() => {});
      flushedAt = Date.now();
      flushedLen = text.length;
    }
  };
  const saying = async (line: string) => {
    step = line;
    await write({ state: "running" }).catch(() => {});
  };

  let stop: string | null = null;
  let broke = false;
  let ranOut = false;

  try {
    const messages: Wire[] = turns.map(messageFrom);

    // The account of the portal rides on the question rather than sitting in the
    // standing instructions, and this is why: it carries today's date at the
    // vessel and live counts of everything, so in the instructions it would
    // change on every request and nothing in front of it could ever be answered
    // from cache. Here, the instructions and the tool definitions are identical
    // every time and the whole front of the request is cacheable.
    let overview = "";
    try {
      overview = await portalOverview();
    } catch (e) {
      console.error(`ai-checker job ${id}: the portal couldn't be summarised (${causeOf(e)}).`);
      overview =
        "THE PORTAL AS IT STANDS could not be read while putting this question together. Your tools may still work — try one. If they fail as well, say that the portal's records couldn't be reached rather than answering as though the portal were empty.";
    }

    const last = messages[messages.length - 1];
    const said = typeof last.content === "string" ? last.content : null;
    last.content = [
      { type: "text", text: overview },
      ...(said ? [{ type: "text", text: said } as Block] : []),
      ...(Array.isArray(last.content) ? (last.content as Block[]) : []),
    ];

    // The instructions and the tools are one cacheable lump, marked once and
    // never moved: they are the same on every question anyone ever asks.
    const system = [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }];

    // What one question has already opened and looked at, carried across the
    // rounds so the limit is on the question rather than on each round of it.
    const reach = newReach();

    for (let round = 1; ; round++) {
      // Belt and braces: nothing should reach here having lost the claim, since
      // a losing invocation returns before any of this runs. But a further
      // round of calling the model and paying for it is worth skipping if it
      // ever somehow did.
      if (lost) return;
      markCache(messages);
      const request = JSON.stringify({
        model: MODEL,
        max_tokens: MAX_ANSWER_TOKENS,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        system,
        tools: PORTAL_TOOLS,
        messages,
        stream: true,
      });

      let upstream: Response | null = null;
      let wentWrong = "";
      for (let attempt = 1; attempt <= GATEWAY_ATTEMPTS; attempt++) {
        try {
          // The gateway address is given with a trailing slash, which would
          // otherwise make this //v1/messages.
          const res = await fetch(`${base.replace(/\/+$/, "")}/v1/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
            },
            body: request,
            signal: stopwatch.signal,
          });

          // The account's tokens-per-minute ceiling, and the gateway having a
          // moment, are the two answers that mean ask again. Anything else it says
          // is an answer, and is read below.
          if ((res.status === 429 || res.status >= 500) && attempt < GATEWAY_ATTEMPTS) {
            await res.body?.cancel().catch(() => {});
            wentWrong = `status ${res.status}`;
          } else {
            upstream = res;
            break;
          }
        } catch (e) {
          // Our own deadline rather than anything the gateway did, and not worth
          // asking again: the time is already spent.
          if (stopwatch.signal.aborted) {
            if (text.trim()) {
              await finish({
                state: "done",
                note: "[The answer stopped here — this one took longer than the portal waits. Ask again, or ask something narrower.]",
              });
            } else {
              await finish({
                state: "error",
                error:
                  "The AI took too long over this one and it was given up on. Ask again, or ask something narrower.",
              });
            }
            return;
          }
          wentWrong = causeOf(e);
        }

        // The worker returns nothing to anybody, so without this a failure to
        // reach the gateway leaves no trace on the platform at all.
        console.error(
          `ai-checker job ${id}: round ${round}, attempt ${attempt} of ${GATEWAY_ATTEMPTS} did not reach the AI (${wentWrong}).`,
        );
        if (attempt < GATEWAY_ATTEMPTS) await wait(RETRY_WAIT_MS[attempt - 1] ?? 4000);
      }

      if (!upstream) {
        // Where the model had already written some of the answer before the round
        // that failed, what it wrote stands and is said to be unfinished. Nothing
        // is gained by throwing away a page of working.
        if (text.trim()) {
          await finish({
            state: "done",
            note: `[The answer stopped here — the AI couldn't be reached to finish it (${wentWrong}). Ask again to get the rest.]`,
          });
          return;
        }
        const megabytes = Math.round((attachedB64 * 3) / 4 / 1048576);
        await finish({
          state: "error",
          error:
            `The AI couldn't be reached — asked ${GATEWAY_ATTEMPTS} times (${wentWrong}). ` +
            (megabytes >= 1
              ? `This question sends about ${megabytes}MB of attached files up with it; if it keeps failing, ask it again with fewer or smaller files.`
              : "Ask again in a moment."),
        });
        return;
      }

      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => "");
        const refusal = new ModelRefusal(upstream.status, detail);
        console.error(`ai-checker job ${id}: the AI turned the question away on round ${round} (${upstream.status}).`);
        if (text.trim()) {
          await finish({
            state: "done",
            note: `[The answer stopped here — the AI turned away the call that would have finished it (${upstream.status}). Ask again to get the rest.]`,
          });
          return;
        }
        await finish({ state: "error", error: checkerRefusalLine(refusal) });
        return;
      }

      const turned = await readTurn(upstream.body, onText);
      stop = turned.stop;
      broke = turned.broke;

      // Anything but a request for something off the portal is the end of it.
      if (broke || turned.stop !== "tool_use" || !turned.calls.length) break;

      if (round >= MAX_TOOL_ROUNDS) {
        ranOut = true;
        break;
      }

      // The turn goes back up exactly as it arrived — thinking, signatures and
      // requests in the order they were written. Only a text block with nothing
      // in it is left out, which the model is not allowed to be sent.
      messages.push({
        role: "assistant",
        content: turned.blocks.filter((b) => b.type !== "text" || String(b.text || "").trim() !== ""),
      });

      // Every answer for this turn goes back in one message. Splitting them
      // teaches the model to stop asking for two things at once, which is the
      // difference between one round and three.
      const answers: Block[] = [];
      const documents: Block[] = [];
      for (const call of turned.calls) {
        await saying(stepFor(call.name, call.input));
        const outcome = await runPortalTool(call.name, call.input, reach);
        answers.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: outcome.text,
          ...(outcome.failed ? { is_error: true } : {}),
        });
        // A document can't be put inside the answer to a request, so it goes into
        // the same turn just behind it — the shape the certificate reading has
        // always used.
        if (outcome.blocks) documents.push(...outcome.blocks);
      }
      messages.push({ role: "user", content: [...answers, ...documents] });
    }
  } catch (e) {
    // The deadline, or the connection going. Neither is a reason to throw away
    // what had already arrived — but it is worth saying which, because an answer
    // that stops halfway looks the same either way from the portal.
    console.error(
      `ai-checker job ${id}: the answer stopped after ${text.length} characters (${stopwatch.signal.aborted ? "the deadline" : causeOf(e)}).`,
    );
    broke = true;
  } finally {
    clearTimeout(deadline);
  }

  // Left exactly as the model wrote it, whitespace and all: the browser reads
  // the answer by how much of it it already holds, and tidying the stored text
  // at the end would shift every offset it has been given. It trims what it
  // shows instead.
  if (!text.trim()) {
    await finish({
      state: "error",
      error: broke
        ? "The answer stopped before any of it had arrived. Ask again."
        : ranOut
          ? "The AI went as far through the portal as it is allowed for one question and never got to an answer. Ask something narrower — one person, one document, one thing at a time."
          : "The AI sent nothing back. Ask again.",
    });
    return;
  }

  const note = ranOut
    ? "[The answer stopped here — the AI went as far through the portal as it is allowed for one question. Ask for the rest, or ask something narrower.]"
    : stop === "max_tokens"
      ? "[The answer stopped here — it reached the length limit. Ask for the rest, or ask something narrower.]"
      : stop === "refusal"
        ? "[The AI stopped there and declined to go on with this one.]"
        : stop === "model_context_window_exceeded"
          ? "[The answer stopped here — this conversation, with everything it has read off the portal, has grown too large for one question. Start a new conversation, or ask about fewer documents at a time.]"
          : broke
            ? "[The answer stopped here — the connection to the AI dropped before it finished. Ask again to get the rest.]"
            : undefined;

  await finish({ state: "done", ...(note ? { note } : {}) });
}
