/**
 * What the reading of documents is built out of, kept apart from the endpoint
 * that serves it.
 *
 * The certificate reading, the two matrices and the OPMS export all ask the same
 * few things: put a question to the model and get JSON back, work out what of a
 * document can be sent, and read what the certificate store already holds. That
 * is what is here.
 *
 * It sits outside the route files because two of them need it — the
 * endpoint the portal calls, and the background worker that runs the OPMS
 * comparison, which is far too long to answer a request with.
 */

import { Buffer } from "node:buffer";
import { getStore } from "../compat/blobs.js";
import { getEnv } from "../env.js";
import { vessel } from "../vessel.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { fileStore } from "../db/documents.js";
import { NO_EXPIRY_CODES as NO_EXPIRY_LIST } from "../../../source/shared/names.js";
import { OUT_OF_CREDIT, READING_UNAVAILABLE, KEY_PROBLEM } from "../../../source/shared/reading-lines.js";

// Certificates are read with a vision model — most of them are scans rather than
// text PDFs, and a scan of a 1998 certificate of competency is not something a
// regular expression reads.
export const MODEL = "claude-sonnet-5";

// Stamped into every reading. Change it when the prompt or the shape below
// changes and every certificate is read again rather than answered from a cache
// that was built to different rules.
export const READING_VERSION = "r1";

// Only what a vision model can actually look at. A .docx or .xlsx certificate
// is recorded as unreadable rather than sent and charged for.
export const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Matrix items that carry no expiry date at all, for every crew member.
 *
 * The validity periods matrix is a document the office files and the model
 * reads, so anything it doesn't list leaves the question open. A handful of
 * items don't need asking: they are sat once and never lapse, and that is a
 * fact about the item rather than something to be read off a scan. Writing them
 * down here settles them for the whole crew whether or not a validity periods
 * matrix is on file, and whether or not the certificate itself thought to say so.
 *
 * The list itself lives in source/shared/names.js, which the page runs too, so
 * the page and the server can never disagree about it.
 *
 *   VS-04  Helm CONNECT - Crew Basic + Jobs — e-learning, completed once, no expiry.
 */
export const NO_EXPIRY_CODES = new Set(NO_EXPIRY_LIST);

/**
 * Items whose expiry is printed on the certificate itself and only there. The
 * AMSA medical says on its own face whether it runs one year or two, so the
 * validity periods matrix (whose "general guide" text would read as 1 year)
 * must never be used to work its expiry out — the printed date is the answer,
 * and a reading without one is a certificate to chase, not a date to derive.
 *   QL-17  AMSA Certificate of Medical Fitness — Form 303.
 * Mirrored by hand in index.html as CERT_STATED; change one, change the other.
 */
export const CERT_STATED_CODES = new Set(["QL-17"]);

export const certStatesOwnExpiry = (code: string | null | undefined) =>
  CERT_STATED_CODES.has(String(code || "").trim().toUpperCase());

/** Whether an item is one of the above — codes are compared upper case. */
export const neverLapses = (code: string | null | undefined) =>
  NO_EXPIRY_CODES.has(String(code || "").trim().toUpperCase());

/* How big a certificate can be and still be read.
 *
 * Base64 adds a third again to whatever is sent, so this becomes about 13 MB
 * on the wire, against a limit of 32 MB for the whole request. It was 4 MB,
 * which was cautious past the point of being useful: seven of the crew
 * genuinely had certificates between 4 and 5.2 MB - a dogging ticket, a
 * medical, an MSIC - and each was left unread and reported as "too large to
 * read. Re-save it under 4 MB", which asks somebody to degrade a compliance
 * record to suit a number the portal picked for itself.
 *
 * A scan that will not fit even at this size is a scan worth re-saving. These
 * were not. */
export const MAX_READ_BYTES = 10 * 1024 * 1024;

// A workbook turned into text runs long — every sheet, every row. This is about
// 15,000 tokens per document, which leaves the model room to answer.
export const MAX_SHEET_CHARS = 60000;

/**
 * How much room one answer is given.
 *
 * max_tokens covers the thinking and the answer together, and the questions
 * asked here are long ones: a comparison over a whole crew can run to a hundred
 * findings of nine fields each, which is well past twenty thousand tokens before
 * the model has thought about anything. Sixteen thousand was not enough and the
 * answers came back cut off partway.
 *
 * It is a ceiling rather than a reservation — nothing is charged for room that
 * isn't used — so the long questions are given nearly all of what the model will
 * write in one answer, which is 64,000 tokens.
 */
export const MAX_ANSWER_TOKENS = 60000;

export type Row = typeof documents.$inferSelect;

export type Matrix = {
  cols: [string, string, string][];
  rows: [string, string, string, string[]][];
};

/** What the model is asked to come back with for one certificate. */
export type Reading = {
  version: string;
  at: string;
  model: string | null;
  readable: boolean;
  reason?: string;
  holderName?: string | null;
  certificateTitle?: string | null;
  issuer?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  neverExpires?: boolean;
  qualCode?: string | null;
  codeConfidence?: "high" | "medium" | "low" | null;
  notes?: string | null;
};

export function readingStore() {
  // Strong consistency: the portal asks what has been read the moment after a
  // batch is written, and "nothing yet" would send it round the loop forever.
  return getStore({ name: "certificate-readings", consistency: "strong" });
}

/**
 * Every certificate reading there is, in one question to the database.
 *
 * A pass over the filing used to ask for each certificate's reading in turn.
 * On a ship with fifteen hundred certificates on file that is fifteen hundred
 * calls before a single file is touched, which is most of the wait and most of
 * what a request is allowed. They all sit in one table, so they come back
 * together and are looked up in memory after.
 */
export async function allReadings(): Promise<Map<string, Reading>> {
  const out = new Map<string, Reading>();
  const rows = await getEnv()
    .DB.prepare("SELECT key, value FROM blobs WHERE store = ?1")
    .bind("certificate-readings")
    .all<{ key: string; value: string }>();
  for (const r of rows.results || []) {
    try {
      out.set(r.key, JSON.parse(r.value) as Reading);
    } catch (e) {
      // A reading that won't parse is no reading; it is read again next run.
    }
  }
  return out;
}

export function readingKey(row: Row) {
  // Keyed by the bytes, so the same certificate filed twice under two names is
  // read once, and a renewal is a different key rather than an overwrite.
  return `${READING_VERSION}/${row.checksum || row.id}.json`;
}

/**
 * The matrix readings, and the check made from them.
 *
 * These live here rather than beside the endpoint that writes them because they
 * are read from three places now: the analysis endpoint, which makes them, and
 * the AI Checker, which is shown whatever has already been worked out rather
 * than being made to work it out again. Nothing here runs a reading — it is the
 * store, the version stamped into it, and the keys things are kept under.
 *
 * Change MATRIX_VERSION when a matrix prompt or answer shape changes and
 * everything is read again rather than answered from a cache built to different
 * rules. The prompts themselves are in `routes/analyse.ts`.
 */
export const MATRIX_VERSION = "m2";

export function matrixStore() {
  // Strong consistency: the portal reads one document, then the other, then asks
  // for the check in three quick calls, and each needs to see what the last wrote.
  return getStore({ name: "matrix-readings", consistency: "strong" });
}

export type MatrixReading = {
  version: string;
  at: string;
  model: string;
  which: string;
  documentId: string;
  filename: string;
  reading: Record<string, unknown>;
};

export const matrixReadingKey = (which: string, id: string) =>
  `${MATRIX_VERSION}/${which}-${id}.json`;

// The check is kept against the documents it was made from, the validity periods
// matrix included — so filing one, or replacing it, asks the question again
// rather than handing back an answer worked out without it.
export const matrixCheckKey = (trainingId: string, skillsId: string, validityId: string | null) =>
  `${MATRIX_VERSION}/check-${trainingId}-${skillsId}-${validityId || "none"}.json`;

export const ISO = /^\d{4}-\d{2}-\d{2}$/;

// The vessel and everyone filing for it are on the vessel's own time (the vessel
// file), so "today" — which is what an expiry is measured against — is the day
// it is there rather than whatever UTC has reached. en-CA formats as YYYY-MM-DD.
export const todayThere = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: vessel.timezone }).format(new Date());

export const ext = (name: string) => (name.split(".").pop() || "").toLowerCase();

export function mediaFor(row: Row) {
  const e = ext(row.filename);
  const type = (row.contentType || "").toLowerCase();
  if (e === "pdf" || type.includes("pdf")) return { kind: "pdf" as const, media: "application/pdf" };
  if (IMAGE_TYPES[e]) return { kind: "image" as const, media: IMAGE_TYPES[e] };
  if (type.startsWith("image/")) return { kind: "image" as const, media: type.split(";")[0] };
  return null;
}

export function base64(bytes: ArrayBuffer) {
  // Node's Buffer, which the worker runtime provides natively: one call,
  // C++ speed, correct for every byte. The two roads not taken both failed
  // in production: the chunked String.fromCharCode loop was real JavaScript
  // CPU (a 4 MB scan blew the per-request budget), and TextDecoder("latin1")
  // is really windows-1252, which maps some bytes outside the range btoa
  // will accept and threw on scans containing them.
  return Buffer.from(bytes).toString("base64");
}

/** Pull the object out of whatever the model wrapped it in. */
export function parseJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * What can be read out of an answer that stopped partway.
 *
 * A comparison over a whole crew is minutes of work, and an answer cut off at
 * the last line is not nothing: every finding written before it stopped was
 * arrived at exactly as it would have been in a whole answer. So the half-written
 * item at the end is dropped, whatever it was sitting inside is closed off, and
 * the rest is read as normal.
 *
 * Null where nothing had been finished yet — a partial answer that starts and
 * ends mid-sentence is not worth guessing at.
 */
export function salvageJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  const open: string[] = [];
  let inString = false;
  let escaped = false;
  // The end of the last value that finished cleanly, and what was still open
  // around it — everything up to there can be kept whatever follows it.
  let cut = -1;
  let stillOpen: string[] = [];

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") open.push("}");
    else if (ch === "[") open.push("]");
    else if (ch === "}" || ch === "]") {
      open.pop();
      cut = i + 1;
      stillOpen = [...open];
    }
  }

  if (cut < 0) return null;

  try {
    const parsed = JSON.parse(text.slice(start, cut) + stillOpen.reverse().join(""));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);export const date = (v: unknown) => {
  const s = str(v);
  return s && ISO.test(s.slice(0, 10)) ? s.slice(0, 10) : null;
};

/**
 * The answer as it arrives, rather than all at once when it is finished.
 *
 * The long questions here take minutes to answer, and an answer waited for in
 * one piece is a connection sitting silent for all of that time — which is what
 * a proxy in the middle drops. Streamed, there is something coming down the wire
 * the whole way, and a run that is cut off partway still has everything written
 * before the cut.
 *
 * Only the words of the answer are gathered. The model's thinking arrives on the
 * same stream and is no part of what was asked for.
 */
async function readStream(res: Response, keepPartial: boolean) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("The model answered with nothing at all.");

  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let stop: string | null = null;
  let refused: Error | null = null;
  // True where the answer stopped for a reason of its own — the stream was cut,
  // or the time ran out — rather than because the model had finished.
  let broke = false;

  try {
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

        let event: {
          type?: string;
          delta?: { type?: string; text?: string; stop_reason?: string };
          error?: { type?: string; message?: string };
        };
        try {
          event = JSON.parse(payload);
        } catch {
          // A half-arrived line is picked up on the next read.
          continue;
        }

        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          text += event.delta.text || "";
        } else if (event.type === "message_delta" && event.delta?.stop_reason) {
          stop = event.delta.stop_reason;
        } else if (event.type === "error") {
          // The model can turn the call away partway, on the stream itself:
          // overloaded, a rate limit, the account, the key, its own fault.
          // Those are the same answers a status would have given, so every
          // one goes the same way - a refusal, sorted in one place by the
          // status its type stands for - rather than a plain error that
          // reads as unreadable, or one the hour cannot see is about the
          // account.
          refused = new ModelRefusal(STREAM_ERROR_STATUS[event.error?.type || ""] ?? 529, JSON.stringify(event));
          break reading;
        }
      }
    }
  } catch (e) {
    // The time running out, or the connection going. Neither is a reason to
    // throw away what had already arrived.
    refused = e instanceof Error ? e : new Error(String(e));
    broke = true;
  }

  // A refusal from the model is the end of a certificate reading whatever
  // had come down the wire before it: a reading cut by the model's own no
  // is not a reading, and stored as one it would stand as the truth about
  // the certificate. The long readers - the matrices, OPMS, the shift sheet
  // - ask to keep what came (keepPartial): every finding written before the
  // model was cut off was worked out in full, the screen says the answer
  // was cut short, and minutes of work are not thrown away over an
  // overloaded event at the end. The connection going, or the time running
  // out, is kept the same way for everyone.
  if (refused instanceof ModelRefusal && !(keepPartial && text)) throw refused;
  if (!text && refused) throw refused;
  return { text, stop, broke: broke || !!refused };
}

/** The status each of the API's error types would have worn as an
 *  answer, for an error that arrives on the stream instead. */
const STREAM_ERROR_STATUS: Record<string, number> = {
  invalid_request_error: 400, authentication_error: 401, billing_error: 402, permission_error: 403,
  not_found_error: 404, rate_limit_error: 429, api_error: 500, overloaded_error: 529,
};

/**
 * What a refusal is about, sorted once, here, for everything that reads.
 *
 *   credit    the account has no credit, or is over its spend limit
 *   rate      too many calls a minute; the next hour is fine
 *   busy      the model is overloaded or failing on its own side
 *   key       the key was refused
 *   document  the document itself was turned away - an invalid PDF, most
 *             often - and the same file gets the same answer every time
 *   other     nothing the portal recognises; nothing is ever stored for it
 *
 * The message is read before the status. "Your credit balance is too low"
 * came back as a 400, the same status as a corrupted file, and once as a
 * 429 - and read by status alone it was written down against 791
 * certificates as a fact about the scans.
 */
export type RefusalKind = "credit" | "rate" | "busy" | "key" | "document" | "other";

export function refusalKind(status: number, detail: string): RefusalKind {
  let parsed: { error?: { type?: unknown; message?: unknown } } | null = null;
  try {
    const p = JSON.parse(detail) as unknown;
    parsed = p && typeof p === "object" ? (p as { error?: { type?: unknown; message?: unknown } }) : null;
  } catch {
    parsed = null;
  }
  const type = typeof parsed?.error?.type === "string" ? parsed.error.type : "";
  const message = typeof parsed?.error?.message === "string" ? parsed.error.message : "";
  if (type === "billing_error" || /credit balance|spend limit|purchase credits|billing|quota|payment|insufficient funds|usage limit/i.test(message)) return "credit";
  if (status === 429) return "rate";
  if (status === 529 || status >= 500) return "busy";
  if (status === 401 || status === 403) return "key";
  if (status === 400 && parsed && type === "invalid_request_error" && aboutTheDocument(message)) return "document";
  return "other";
}

/**
 * Whether a 400 is about the document that was sent, as against the
 * request around it. invalid_request_error is the API's word for anything
 * wrong with a request, and "document" is the only kind ever stored
 * against a certificate for good, so the message has to say so. One that
 * leads with the field it is about - "messages.0.content.0.pdf.source.
 * base64.data: The PDF specified was not valid." - is about the document
 * only when the field is in the messages; "thinking.type: ..." or
 * "model: ..." is the portal's own request, the day the API changes under
 * it, and would otherwise be written down against every certificate in
 * the batch. One with no field is about the document only when it names
 * it - a PDF, an image, too long.
 */
function aboutTheDocument(message: string): boolean {
  const field = /^([\w.[\]-]+):\s/.exec(message)?.[1] || "";
  if (field) return field.startsWith("messages.");
  return /\b(pdf|image|document|media|base64|too long|exceeds|could not (be )?process)/i.test(message);
}

/**
 * The model's API saying no to the request, as opposed to being unreachable.
 * It carries the status and what the refusal is about (refusalKind), so a
 * caller can tell a document that will never read from an account that
 * will read it fine once it is in order.
 */
export class ModelRefusal extends Error {
  status: number;
  detail: string;
  kind: RefusalKind;
  constructor(status: number, detail: string) {
    super(`The model couldn't be reached (${status}). ${detail.slice(0, 200)}`.trim());
    this.status = status;
    this.detail = detail;
    this.kind = refusalKind(status, detail);
  }
}

/**
 * The one short sentence a refusal is shown as: the shared line for the
 * account's kinds (source/shared/reading-lines.js, where the page reads
 * them too), the API's own reason for a document it turned away, and the
 * error as it stands for anything else.
 */
export function plainLine(e: ModelRefusal): string {
  switch (e.kind) {
    case "credit": return OUT_OF_CREDIT;
    case "rate":
    case "busy": return READING_UNAVAILABLE;
    case "key": return KEY_PROBLEM;
    case "document": return refusalSays(e) || e.message;
    default: return e.message;
  }
}

/** What a job that fell over says on its screen: the account's short
 *  sentence when the model refused, otherwise the error's own words. One
 *  place for the four long readers (matrix, matrix check, OPMS, shift). */
export function errorLine(e: unknown): string {
  return e instanceof ModelRefusal ? plainLine(e) : e instanceof Error ? e.message : String(e);
}

export { OUT_OF_CREDIT, READING_UNAVAILABLE, KEY_PROBLEM };

/**
 * What the API's refusal actually says, out of the JSON it arrives wrapped in.
 *
 * The message often leads with the field it is about —
 * "messages.0.content.0.pdf.source.base64.data: The PDF specified was not
 * valid." — and the field means nothing to whoever uploaded the scan, so it is
 * taken off. Null where the refusal wasn't the JSON shape the API uses.
 */
export function refusalSays(e: ModelRefusal): string | null {
  try {
    const parsed = JSON.parse(e.detail) as { error?: { message?: unknown } };
    const m = parsed?.error?.message;
    if (typeof m !== "string" || !m.trim()) return null;
    return m.replace(/^[\w.[\]-]+:\s*/, "").trim() || m.trim();
  } catch {
    return null;
  }
}

/**
 * One question to the model, answered as JSON.
 *
 * Everything here asks for a JSON object and nothing else, so the request, the
 * one retry that is worth making, and the reading of the answer are in one place
 * rather than repeated per caller.
 *
 * `truncated` says the answer stopped before the model had finished writing it —
 * out of room, or out of time, or (with `keepPartial`) the model's own refusal
 * partway. What comes back with it is what had been written by then, which is
 * worth showing with a line saying so: the alternative is throwing away a run
 * of several minutes over its last, half-written line.
 */
export async function askJson(opts: {
  system: string;
  content: unknown[];
  maxTokens: number;
  effort: "low" | "medium" | "high";
  timeoutMs?: number;
  /** Keep an answer the model's own refusal cut partway, as `truncated`,
   *  rather than throwing it away. Off by default: a certificate reading
   *  cut by a refusal is no reading. */
  keepPartial?: boolean;
}): Promise<{ json: Record<string, unknown>; truncated: boolean }> {
  const key = getEnv().ANTHROPIC_API_KEY;
  const base = getEnv().ANTHROPIC_BASE_URL;
  if (!key || !base) {
    throw new Error(
      "AI is not switched on for this deploy yet - set the ANTHROPIC_API_KEY secret and ANTHROPIC_BASE_URL on the worker.",
    );
  }

  // One deadline for the whole thing rather than one per attempt, so a retry
  // can't quietly double how long a caller is kept waiting. Aborting mid-answer
  // is survivable — what has arrived by then is kept.
  const stopwatch = new AbortController();
  const deadline = setTimeout(() => stopwatch.abort(), opts.timeoutMs ?? 20000);

  const send = () =>
    fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        // The model thinks before it answers whether it is asked to or not, and
        // max_tokens covers the thinking and the answer together — hence the
        // room well past what the JSON itself needs.
        max_tokens: opts.maxTokens,
        thinking: { type: "adaptive" },
        output_config: { effort: opts.effort },
        system: opts.system,
        messages: [{ role: "user", content: opts.content }],
        stream: true,
      }),
      signal: stopwatch.signal,
    });

  try {
    let res = await send();
    // One retry, and only for the two answers that mean "ask me again": the
    // account's tokens-per-minute ceiling, and the provider having a moment.
    // Sorted before it is asked again, though: a spend limit wears a 429
    // too, and a call after the account has said no is a call for nothing.
    if (res.status === 429 || res.status >= 500) {
      const detail = await res.text().catch(() => "");
      if (refusalKind(res.status, detail) === "credit") throw new ModelRefusal(res.status, detail);
      await new Promise((r) => setTimeout(r, 1500));
      res = await send();
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ModelRefusal(res.status, detail);
    }

    const { text, stop, broke } = await readStream(res, opts.keepPartial === true);
    const stopped = stop === "max_tokens" || broke;
    // A whole answer first. Where it stopped partway, what had been written by
    // then is closed off and kept rather than lost.
    const parsed = parseJson(text) || salvageJson(text);
    if (!parsed) {
      // A half-written answer and a nonsense answer read the same to parseJson,
      // and only one of them is worth saying anything about. Say which.
      if (stop === "max_tokens") {
        throw new Error(
          "The model ran out of room before it had written anything that could be read. There is more in the documents than one answer holds — take out what isn't needed and run it again.",
        );
      }
      if (broke) {
        throw new Error(
          "The answer stopped partway and nothing readable had come back. Run it again — if it stops again there is more in the documents than one answer holds.",
        );
      }
      throw new Error("The model's answer couldn't be read as JSON.");
    }
    return { json: parsed, truncated: stopped };
  } finally {
    clearTimeout(deadline);
  }
}

export async function liveCertificates(): Promise<Row[]> {
  // Raw D1 on purpose: mapping 1,400 rows through the ORM costs enough CPU
  // to brush the free plan's per-request budget, and this listing runs at
  // the top of every certificate-reading batch. Plain aliased rows cost
  // almost nothing (same treatment as the /api/files listing).
  const res = await getEnv()
    .DB.prepare(
      `SELECT id, category, bucket, blob_key AS blobKey, filename,
              content_type AS contentType, size_bytes AS sizeBytes, title,
              uploaded_by AS uploadedBy, tag, source, party, rank, swing,
              filed_on AS filedOn, session_id AS sessionId, person, folder,
              qual_code AS qualCode, expires_on AS expiresOn, checksum,
              read_code AS readCode, read_expires AS readExpires, read_issued AS readIssued,
              read_issuer AS readIssuer, read_title AS readTitle,
              created_at AS createdAt, removed_at AS removedAt,
              removed_by AS removedBy
       FROM documents WHERE category = 'certificate' AND removed_at IS NULL
       ORDER BY created_at DESC`,
    )
    .all();
  return (res.results || []) as unknown as Row[];
}

export const blankish = (v: string | null | undefined) => !v || v.trim() === "" || v.trim() === "?";
export const isHeld = (v: string | null | undefined) => (v || "").trim().toUpperCase() === "Y";
export const isNotHeld = (v: string | null | undefined) => (v || "").trim().toUpperCase() === "N";
export const isDate = (v: string | null | undefined) => !!v && ISO.test(v.trim().slice(0, 10));

/**
 * The dates the certificates on file actually carry, per person and matrix code.
 *
 * The certification screens show two date columns — issued and expires — and the
 * matrix itself only holds one value per cell, so the issue dates have to come
 * from the readings the extract step already keeps. No AI and no writes: this
 * only reads what is cached, so it costs nothing and answers in one call. The AI
 * Checker reads it too, which is why it is here rather than beside the endpoint.
 *
 * The same rules as the comparison decide which certificate speaks for an item:
 * the uploader's own matrix code beats the model's guess, the model's guess is
 * only used when it wasn't a low-confidence one, and where two certificates
 * claim the same item the one that runs the longer is the one in force.
 */
/**
 * The skills matrix's Equivalence page, as the portal keeps it: certificates
 * that are not themselves matrix items, each against the most senior column
 * the office accepts them for. "Master <500GT" is no column of the matrix,
 * but the page says it stands for Master <100m NC — so that is the column
 * its dates belong in, however the certificate is worded.
 */
export type Equivalence = { held: string; code: string };
export const EQUIV_KEY = "equivalences.json";

/** The crew matrix's column codes as one string, for stamping what was
 *  read against them (keepEquivalences in lib/round.ts): the Equivalence
 *  sheet's parse keeps only rows that land on a column, so a column added
 *  later means a read again. Empty where the matrix has no columns. */
export const equivalenceColsKey = (cols: unknown): string =>
  (Array.isArray(cols) ? cols : [])
    .map((c) => String(Array.isArray(c) ? c[0] : "").trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .join("|");

export async function equivalences(): Promise<Equivalence[]> {
  const held = (await matrixStore().get(EQUIV_KEY, { type: "json" })) as { rows?: Equivalence[] } | null;
  return Array.isArray(held?.rows) ? (held!.rows as Equivalence[]) : [];
}

// Words a certificate prints that the sheet leaves out, or the other way
// round — they tell no ticket from another.
const EQ_NOISE = new Set(["certificate", "of", "competency", "coc", "the", "a", "and"]);
const eqWords = (s: string) =>
  s.toLowerCase().normalize("NFKD")
    // "500GT" on the sheet and "500 GT" on a certificate are the same words.
    .replace(/([0-9])(?=[a-z])/g, "$1 ").replace(/([a-z])(?=[0-9])/g, "$1 ")
    .split(/[^a-z0-9]+/).filter((w) => w && !EQ_NOISE.has(w));

/** The column the equivalence page re-homes this title to, or null. An entry
 * only fires when its whole name appears in the title, and the longest name
 * wins — so "Master <500GT" beats a plain "Master", and a compound ticket
 * beats both. */
export function equivalentCode(title: string | null | undefined, table: Equivalence[]): string | null {
  if (!title || !table.length) return null;
  const have = new Set(eqWords(title));
  let best: { code: string; n: number } | null = null;
  for (const entry of table) {
    const need = eqWords(entry.held);
    if (!need.length || !need.every((w) => have.has(w))) continue;
    if (!best || need.length > best.n) best = { code: entry.code, n: need.length };
  }
  return best ? best.code : null;
}

/** The one answer to "which column does this certificate speak to": the
 * uploader's own tagging first, then the equivalence page's say over the
 * model's guess — that guess is exactly what the page corrects. */
export function codeFor(
  row: { qualCode?: string | null },
  reading: Reading | null,
  table: Equivalence[],
): string | null {
  if (row.qualCode) return row.qualCode;
  if (!reading) return null;
  return (
    equivalentCode(reading.certificateTitle, table) ||
    // Some tickets print a bare "Certificate of Competency" and put the
    // capacity elsewhere on the page - the reader keeps that in its notes,
    // so the notes get a say when the title alone names nothing.
    equivalentCode(
      reading.certificateTitle && reading.notes
        ? `${reading.certificateTitle} ${reading.notes}`
        : reading.notes,
      table,
    ) ||
    (reading.codeConfidence !== "low" ? reading.qualCode || null : null)
  );
}

export async function certificateStanding() {
  const certs = await liveCertificates();
  const store = readingStore();
  const eqTable = await equivalences();

  const readings = await Promise.all(
    certs.map(async (row) => ({
      row,
      reading: (await store.get(readingKey(row), { type: "json" })) as Reading | null,
    })),
  );

  const claim = new Map<
    string,
    { issued: string | null; expires: string | null; issuer: string | null; fileId: string | null }
  >();

  for (const { row, reading } of readings) {
    if (!reading || !reading.readable || !row.person || !row.person.trim()) continue;
    const code = codeFor(row, reading, eqTable);
    if (!code || !code.trim()) continue;

    // A date typed against the certificate on the portal beats the model's
    // reading of the scan, same as in the comparison. An item recorded as
    // carrying no expiry has none to show either way.
    const typed = isDate(row.expiresOn) ? row.expiresOn!.trim().slice(0, 10) : null;
    const expires = neverLapses(code) ? null : typed || reading.expiresOn || null;
    const issued = reading.issuedOn || null;
    // The issuing authority as read off the scan, for the not-Australian flag
    // on the certification checker.
    const issuer = (reading.issuer || "").trim() || null;

    const key = `${row.person.trim().toUpperCase()}::${code.trim().toUpperCase()}`;
    const sitting = claim.get(key);
    if (sitting) {
      if ((sitting.expires || "") >= (expires || "")) {
        // The one already claimed runs the longer; an issue date or issuer is
        // still worth carrying over where the one in force didn't print one.
        // The file the line links to stays the one in force.
        if (!sitting.issued && issued) sitting.issued = issued;
        if (!sitting.issuer && issuer) sitting.issuer = issuer;
        continue;
      }
      claim.set(key, { issued: issued || sitting.issued, expires, issuer: issuer || sitting.issuer, fileId: row.id });
      continue;
    }
    claim.set(key, { issued, expires, issuer, fileId: row.id });
  }

  return {
    at: new Date().toISOString(),
    // `fileId` names the scan each line's dates were read from, so the
    // certification screens can put a link to the certificate itself on the line.
    dates: [...claim.entries()].map(([key, v]) => {
      const at = key.indexOf("::");
      return {
        person: key.slice(0, at), code: key.slice(at + 2),
        issued: v.issued, expires: v.expires, issuer: v.issuer, fileId: v.fileId,
      };
    }),
  };
}

/**
 * What the model is given for one document: the sheets as text where the portal
 * could read them, and the file itself where it couldn't.
 */
export async function contentFor(row: Row, text: string | null) {
  if (text && text.trim()) {
    const trimmed = text.length > MAX_SHEET_CHARS;
    return {
      block: {
        type: "text",
        text: `${row.filename}, read as text sheet by sheet:\n\n${text.slice(0, MAX_SHEET_CHARS)}${
          trimmed ? "\n\n[The document is longer than this and was cut off here.]" : ""
        }`,
      },
      trimmed,
    };
  }

  const shape = mediaFor(row);
  if (!shape) {
    throw new Error(
      `${row.filename} isn't a spreadsheet the portal could read, or a PDF or image the model can look at. Save it as .xlsx, .csv or PDF and upload it again.`,
    );
  }
  if (row.sizeBytes > MAX_READ_BYTES) {
    throw new Error(`${row.filename} is too large to read. Re-save it under 4 MB and upload it again.`);
  }

  const bytes = await fileStore().get(row.blobKey, { type: "arrayBuffer" });
  if (!bytes) throw new Error(`${row.filename} is no longer in the store. Upload it again.`);

  const source = { type: "base64", media_type: shape.media, data: base64(bytes) };
  return {
    block: shape.kind === "pdf" ? { type: "document", source } : { type: "image", source },
    trimmed: false,
  };
}
