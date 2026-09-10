/**
 * What the reading of documents is built out of, kept apart from the endpoint
 * that serves it.
 *
 * The certificate reading, the two matrices and the OPMS export all ask the same
 * few things: put a question to the model and get JSON back, work out what of a
 * document can be sent, and read what the certificate store already holds. That
 * is what is here.
 *
 * It sits outside `netlify/functions` because two functions need it — the
 * endpoint the portal calls, and the background worker that runs the OPMS
 * comparison, which is far too long to answer a request with.
 */

import { getStore } from "../compat/blobs.js";
import { getEnv } from "../env.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { fileStore } from "../db/documents.js";

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
 * The same list is mirrored in index.html, next to `useValidityLookup` — the
 * portal is a static page with no bundler, so it can't import from here. Change
 * one and change the other.
 *
 *   VS-04  Helm CONNECT - Crew Basic + Jobs — e-learning, completed once, no expiry.
 */
export const NO_EXPIRY_CODES = new Set(["VS-04"]);

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

// Base64 adds a third again to whatever is sent, and the whole prompt has to
// fit. Anything bigger is left unread with the reason on it.
export const MAX_READ_BYTES = 4 * 1024 * 1024;

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
 * rules. The prompts themselves are in `netlify/functions/analyse.mts`.
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

// The vessel and everyone filing for it are on Western Australian time, so "today"
// — which is what an expiry is measured against — is the day it is there rather
// than whatever UTC has reached. en-CA formats as YYYY-MM-DD.
const VESSEL_TZ = "Australia/Perth";
export const todayThere = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: VESSEL_TZ }).format(new Date());

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
  const view = new Uint8Array(bytes);
  let out = "";
  // In chunks: one spread of a four megabyte array is enough to blow the stack.
  for (let i = 0; i < view.length; i += 0x8000) {
    out += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(out);
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
async function readStream(res: Response) {
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
          error?: { message?: string };
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
          refused = new Error(event.error?.message || "The model stopped partway through its answer.");
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

  if (!text && refused) throw refused;
  return { text, stop, broke: broke || !!refused };
}

/**
 * The model's API saying no to the request itself, as opposed to being busy or
 * unreachable. It carries the status so a caller can tell the two apart: a 400
 * is about what was sent — an invalid document, most often — and the same
 * request gets the same answer every time it is made, so it is never worth
 * asking again.
 */
export class ModelRefusal extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`The model couldn't be reached (${status}). ${detail.slice(0, 200)}`.trim());
    this.status = status;
    this.detail = detail;
  }
}

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
 * out of room, or out of time. What comes back with it is what had been written
 * by then, which is worth showing with a line saying so: the alternative is
 * throwing away a run of several minutes over its last, half-written line.
 */
export async function askJson(opts: {
  system: string;
  content: unknown[];
  maxTokens: number;
  effort: "low" | "medium" | "high";
  timeoutMs?: number;
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
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await send();
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ModelRefusal(res.status, detail);
    }

    const { text, stop, broke } = await readStream(res);
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

export async function liveCertificates() {
  return db
    .select()
    .from(documents)
    .where(and(eq(documents.category, "certificate"), isNull(documents.removedAt)))
    .orderBy(desc(documents.createdAt));
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
export async function certificateStanding() {
  const certs = await liveCertificates();
  const store = readingStore();

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
    const code = row.qualCode || (reading.codeConfidence !== "low" ? reading.qualCode : null) || null;
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
