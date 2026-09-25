
import {
  canonicaliseCertificate,
  fileStore,
  filingName,
  liveSingleFileRow,
  refileCertificate,
  safeName,
} from "../db/documents.js";
import { imageToPdf } from "../lib/pdf-wrap.js";
import { readDocument } from "../lib/shared-state.js";
import { asKnownPerson, crewRegister, nameIsSomebodyElse, readAsLine, readerPlaces, whoseCertificate } from "../../../source/shared/names.js";
import { isMsicCard, msicAsWritten, msicCodeIn, newestCard, openToCertificates, particularsFor, particularsKeyOf, ticketCodesIn } from "../../../source/shared/particulars.js";
import { coveredCells, unitColumnsIn } from "../../../source/shared/covers.js";
import { paperKind } from "../../../source/shared/evidence.js";
import { filedAsLine, filedCodeIn, placedLine } from "../../../source/shared/filed-as.js";
import { isRecognitionReading, recognisedUntil, recognitionFills } from "../../../source/shared/recognition.js";
import { vessel } from "../vessel.js";
import { getEnv } from "../env.js";
import {
  askJson,
  base64,
  blankish,
  EQUIV_KEY,
  equivalenceColsKey,
  equivalences,
  certificateStanding,
  codeFor,
  columnsFor,
  registerColumns,
  tagStands,
  filedAsFor,
  contentFor,
  date,
  EVIDENCE_KINDS,
  type EvidenceKind,
  isDate,
  isHeld,
  isNotHeld,
  liveCertificates,
  matrixCheckKey,
  matrixReadingKey,
  allReadings,
  matrixStore,
  MAX_READ_BYTES,
  mediaFor,
  MODEL,
  ModelRefusal,
  plainLine,
  type RefusalKind,
  neverLapses,
  READING_VERSION,
  readingKey,
  readingStore,
  refusalSays,
  str,
  todayThere,
  type Matrix,
  type MatrixReading,
  type Equivalence,
  type Reading,
  type ReadingColumn,
  type ReadingHolder,
  type Row,
  certStatesOwnExpiry,
} from "../lib/analysis.js";
import {
  MATRIX_DOCS,
  matrixDocuments,
  readMatrixCheckJob,
  readMatrixReadJob,
  startMatrixCheckJob,
  startMatrixReadJob,
} from "../lib/matrix.js";
import {
  NO_OPMS_SHEET,
  opmsSheetRow,
  readOpmsJob,
  resetOPMS,
  startOpmsJob,
} from "../lib/opms.js";
import {
  heldShiftAnswer,
  NO_SHIFT_SHEET,
  readShiftJob,
  resetShiftAllocation,
  shiftKeyFor,
  shiftSheetRow,
  shiftStore,
  startShiftJob,
} from "../lib/shift.js";

/**
 * Reading the crew's certificates and holding them against the spreadsheets.
 *
 * The portal keeps two things that are meant to say the same thing: a folder of
 * scanned certificates per crew member, and the crew qualification spreadsheet
 * the matrix is built from. They drift — a renewal is filed and the spreadsheet
 * isn't touched, or a date is typed into the spreadsheet a year out. This is
 * what finds the drift.
 *
 * It is separate steps, because reading fifty scans takes far longer than a
 * function is allowed to run:
 *
 *   extract — read a few certificates that haven't been read yet, and keep each
 *             reading in the blob store under the certificate's checksum. The
 *             portal calls this over and over until nothing is left unread, so
 *             the work survives a lost connection and is never paid for twice.
 *   refile  — move any certificate that is in the wrong person's folder into the
 *             folder of the person whose name the certificate itself carries.
 *   compare — hold every reading against the spreadsheet the portal is showing,
 *             and against the certificates spreadsheet on file, and say where
 *             they disagree. No AI, no writes: the same certificates and the
 *             same spreadsheet always give the same answer.
 *   reset   — throw the readings away, so the next extract reads everything
 *             again from the files themselves.
 *
 * Only `refile` writes anything. Nothing here changes the matrix or the
 * spreadsheet: what the certificates say goes back to the portal, and it is the
 * portal that decides what is written where.
 *
 * The second half of this file does the same job for the matrices the portal
 * holds about the crew as a whole — the training matrix, the skills matrix and the
 * validity periods matrix — in the same shape: read each document once, keep the
 * reading, then hold the readings against each other. See "The training matrix and
 * the skills matrix" below.
 *
 * Last comes the OPMS export, which is the same idea again with a third account
 * in it: our matrix, our certificates and a spreadsheet out of somebody else's
 * system, and an answer split by whose mistake each disagreement is. That one is
 * in `lib/opms.ts` and does not run here: it is a single question long enough to
 * outlast a request, so this endpoint only starts it and reports on it, and
 * `opms-run` is what does the work.
 *
 * What all three are built out of — putting a question to the model, working out
 * what of a document can be sent, reading the certificate store — is in
 * `lib/analysis.ts`, because the OPMS worker needs the same things.
 */

// How many certificates one call reads. Each is a round trip to the model, and
// the call has to come back well inside the function's own time limit.
const BATCH = 3;
const MAX_BATCH = 5;

// A dated cell on the spreadsheet with no certificate behind it is worth
// counting, but there are thousands of cells and listing them all would bury
// the handful of real disagreements. Only the count is reported.
const SHEET_ITEM_CAP = 60;

const SYSTEM = `You read scanned crew certificates for a vessel's certificate register and return JSON only.

You are reading one document. It may be a certificate of competency, a medical
certificate, a training course statement of attainment, a licence or a course
completion card, and it is usually a photograph or a scan rather than clean text.

Return exactly this JSON object and nothing else — no prose, no markdown fence:

{
  "readable": true|false,
  "holderName": string|null,        // the person the certificate belongs to, as printed
  "certificateTitle": string|null,  // what the document says it is, as printed
  "issuer": string|null,            // the authority or training provider
  "issuedOn": "YYYY-MM-DD"|null,
  "expiresOn": "YYYY-MM-DD"|null,   // the date it stops being valid
  "neverExpires": true|false,       // true only when the document states it does not expire
  "columns": [                      // every matrix column this document is evidence for, from the list given
    { "code": string, "confidence": "high"|"medium"|"low", "why": string }  // why: at most 15 words
  ],
  "registerPage": true|false,       // the document is a register page, an approval listing or a spreadsheet extract
  "holder": {                       // which of the numbered crew the certificate is for
    "person": number|null, "confidence": "high"|"medium"|"low", "why": string, "others": [number]
  },
  "notes": string|null,             // at most 15 words, only if something matters
  "documentNumber": string|null,    // the card, licence or certificate number as printed; on an MSIC card, the card number
  "holderBirthDate": "YYYY-MM-DD"|null, // the holder's date of birth, only if printed
  "endorsements": [                 // every endorsement printed as part of what this certificate certifies
    { "text": string, "until": "YYYY-MM-DD"|null }
  ],
  "units": [string],                // the training unit codes printed on the document
  "capacities": [string],           // the capacities the document certifies the holder may serve in, as printed
  "isRecognition": true|false,      // the title says this is a certificate of recognition
  "recognises": {                   // what a recognition prints about the foreign certificate behind it
    "authority": string|null, "country": string|null, "number": string|null, "expiresOn": "YYYY-MM-DD"|null
  },
  "assessedOn": "YYYY-MM-DD"|null,  // the date of the examination or assessment, if printed apart from the issue date
  "conditions": string|null,        // any limitation printed on the document, at most 20 words
  "evidenceKind": string|null       // for a document that is not a certificate itself, which of the five it is
}

Rules:
- Dates: Australian documents are day-first. "10/03/2028" is 2028-03-10.
- Only give expiresOn if a date of expiry, valid-until or renewal-due is actually
  printed. Never calculate one from the issue date, and never guess a year.
- Set readable to false only when the document is too poor to read, or is none
  of these: a certificate, a licence, a training statement of attainment, or
  one of the five papers named under evidenceKind below. A certificate or
  course for something not on the list is readable, with columns []. The
  five papers are readable and carry their evidenceKind.
- columns: list every matrix column this document is evidence for. A document
  can be evidence for more than one: a statement of attainment with several
  units, a licence with several classes, a certificate of competency that
  also carries an endorsement or a second capacity, a higher level of the
  same course.
- A higher level of the same course or ticket satisfies the lower: Crew
  Intermediate satisfies Crew Basic. A higher certificate of competency
  satisfies a lower one only where its limits - tonnage, length, near-coastal
  or unlimited, propulsion power - are at least the column's: a Master <24m
  NC does not satisfy a Chief Mate <3000GT. Give such a column "medium",
  never "high". The office's equivalences, given with the list, say which
  certificates stand for which column - apply them.
- confidence: "high" when the document plainly is that item; "medium" when it
  satisfies the item by a level, an equivalence or an endorsement, or the
  filed column is plausible; "low" for a guess. Never leave out a column you
  can see: give it "low" rather than silence.
- registerPage: true for a register page, an approval listing or a
  spreadsheet extract. Such a page is evidence only for the register columns
  named with the list; for anything else it is not a certificate.
- holder: which of the numbered crew given with the list this certificate is
  for, from the name printed on it. Allow initials, the name in another order,
  a middle name, a transliteration or a partial name. "why" in at most 15
  words. person null when it is nobody on the list. "others": the numbers of
  anyone else on the list the printed name could also be - never guess
  between two people; [] when there is nobody else.
- endorsements: the STCW regulation numbers and the named endorsements printed
  as part of what the certificate certifies, each as printed — "II/2 (incl.
  generic ECDIS)", "VI/2 (1) s. A-VI/2 (1-4)", "Proficiency in fast rescue
  boats". Give "until" only where a date of expiry is printed against that
  endorsement; otherwise null. [] where the document prints none.
- units: the national training unit codes printed on the document, as printed —
  "HLTAID011", "HLTAID015", "SITXFSA005", "RIIWHS202E" — and the class codes
  printed on a high risk work licence, each class code alone as its own entry
  ("DG", "CV"), never inside a phrase. [] where there are none.
- capacities: the capacities a certificate of competency says the holder may
  serve in, each as printed — "Master", "GMDSS Radio Operator", "Chief Mate".
  [] where the document prints none.
- recognises: only for a certificate of recognition, and only what it prints
  about the certificate it recognises. null for anything else.
- conditions: a limitation on what the holder may do, as printed — "fit for
  particular duties only", "must wear corrective lenses", "daylight only".
  null where the document prints none.
- evidenceKind: one of "extension" (a letter extending a certificate),
  "lodged-renewal" (a receipt or acknowledgement that a renewal was lodged),
  "crewing-permit" (a temporary crewing permit), "assessor-declaration" (a
  final assessor's declaration) or "issue-letter" (a letter saying a
  certificate has been issued). null where the document is a certificate
  itself. Where such a document prints the date the cover runs out, that date
  is expiresOn.
- Never invent a name, a date, a number or a code. null is the right answer when
  it is not on the page.`;

/** What the question carries besides the document: the office's
 *  Equivalence sheet as the round keeps it (keepEquivalences in
 *  lib/round.ts). The vessel file's covers rows are NOT given: those are
 *  applied by rule after the reading (source/shared/covers.js), whatever
 *  the model makes of the page. */
export type ReadingAsk = { equivalences: Equivalence[]; crew: { name: string; aliases: string[] }[] };

/** The question's context, loaded once for a batch: the Equivalence sheet,
 *  and the crew register - every person's name and the other spellings they
 *  answer to (Crew Details), numbered in the question so the reader picks a
 *  person off it rather than spelling one. */
export async function readingAsk(): Promise<ReadingAsk> {
  const cur = await readDocument().catch(() => null);
  const people = (Array.isArray(cur?.doc.people) ? cur!.doc.people : []) as { name?: unknown; aliases?: unknown }[];
  const crew = people
    .map((p) => ({
      name: String((p && p.name) || "").trim(),
      aliases: (Array.isArray(p && p.aliases) ? (p.aliases as unknown[]) : []).map((a) => String(a || "").trim()).filter(Boolean),
    }))
    .filter((p) => p.name);
  return { equivalences: await equivalences(), crew };
}

/** The reader's pick of a person, turned from the number it was given back
 *  into the register's name: the number means nothing once the list moves.
 *  A number off the list is no pick. `others` are anyone else the reader
 *  said the printed name could be - readerPick (source/shared/names.js)
 *  takes a pick with anyone in it as no pick. The reader saying there is
 *  somebody else is kept however it said it: a number off the list, a name
 *  written out instead of a number, or one number not in a list is kept as
 *  written, so the doubt is never thrown away with the form it came in. */
export function holderFrom(v: unknown, crew: ReadingAsk["crew"]): ReadingHolder | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const said = v as Record<string, unknown>;
  const at = (n: unknown) => {
    const i = typeof n === "number" ? n : typeof n === "string" && /^\d+$/.test(n.trim()) ? Number(n.trim()) : NaN;
    return Number.isInteger(i) && i >= 1 && i <= crew.length ? crew[i - 1].name : null;
  };
  const person = at(said.person);
  const conf = str(said.confidence);
  const confidence: ReadingHolder["confidence"] = conf === "high" || conf === "medium" ? conf : "low";
  const why = whyFrom(said.why);
  const raw = Array.isArray(said.others) ? said.others : said.others == null ? [] : [said.others];
  const others = [...new Set(
    raw
      .filter((x) => x != null && String(x).trim() !== "")
      .map((x) => at(x) || String(typeof x === "object" ? JSON.stringify(x) : x).trim().slice(0, 60))
      .filter((n) => n !== person),
  )].slice(0, 5);
  return { person, confidence, why, others };
}

function instructionFor(row: Row, codes: [string, string][], ask: ReadingAsk) {
  const list = codes.map(([code, title]) => `${code} — ${title}`).join("\n");
  /* The filed column: the code in a name the office wrote. Never one the
     portal wrote itself - that is the model's own earlier guess, and asking
     it to weigh that would be asking it to agree with itself. */
  const filedCode = row.qualCode || row.namedByPortal ? null : filedCodeIn(row.filename, codes);
  const filed = [
    row.person ? `Filed against: ${row.person}` : null,
    row.qualCode ? `Filed against matrix code: ${row.qualCode}` : null,
    filedCode ? `Filed under column: ${filedCode}` : null,
    `Filename: ${row.filename}`,
  ]
    .filter(Boolean)
    .join("\n");
  // "<held> counts as <code>", one a line, only for columns on this list.
  const live = new Set(codes.map(([c]) => c.trim().toUpperCase()));
  const eq = ask.equivalences
    .filter((e) => e && e.held && live.has(String(e.code || "").trim().toUpperCase()))
    .map((e) => `${String(e.held).trim()} counts as ${String(e.code).trim().toUpperCase()}`);
  const register = registerColumns().filter((c) => live.has(c));
  const crew = ask.crew.map((p, i) => `${i + 1}. ${p.name}${p.aliases.length ? ` (also: ${p.aliases.join(", ")})` : ""}`);

  return `Read the attached certificate and return the JSON described.

${filed}

The matrix codes it could answer to:
${list}

The office's equivalences:
${eq.length ? eq.join("\n") : "(none)"}

The columns a register page can be evidence for:
${register.length ? register.join(", ") : "(none)"}

The crew, numbered (for holder):
${crew.length ? crew.join("\n") : "(none)"}

What it was filed against is what the office believes this document is for.
Weigh it: if the document plausibly is that item, list that column with your
confidence; if the document is clearly something else, say what it is, and
list the filed column as "low" with the reason.`;
}

/* How much of a list, and of a line, one document may give.
 *
 * A certificate of competency prints a dozen endorsements and a training
 * statement half a dozen unit codes. A scan the model has misread could come
 * back with hundreds of them, and every one of those would be held against
 * the covers table for the life of the reading. */
const MAX_LISTED = 20;
const MAX_ENDORSEMENT_CHARS = 90;
const MAX_UNIT_CHARS = 24;
const MAX_CAPACITY_CHARS = 60;
/** The words a printed condition is kept to (the question asks for 20), and
 *  the characters, for an answer that came back as one unspaced block: the
 *  words are the whole page and the word count would not catch it, and this
 *  is the one place the batch puts a model's words on the screen. */
const MAX_CONDITION_WORDS = 20;
const MAX_CONDITION_CHARS = 200;

/** The endorsements printed on a certificate, each as printed, with its own
 *  end date where the document prints one against it. A model answering with
 *  plain strings rather than the objects asked for is still read: the words
 *  are the endorsement, and the date is the certificate's own. */
function endorsementsFrom(v: unknown): { text: string; until: string | null }[] {
  if (!Array.isArray(v)) return [];
  const out: { text: string; until: string | null }[] = [];
  for (const item of v) {
    const asObject = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    const text = str(asObject ? asObject.text : item);
    if (!text) continue;
    out.push({ text: text.slice(0, MAX_ENDORSEMENT_CHARS), until: asObject ? date(asObject.until) : null });
    if (out.length >= MAX_LISTED) break;
  }
  return out;
}

/** The unit codes printed on a training statement, as printed. The same code
 *  twice is one code: the rule matches a column's title, and a list with
 *  "HLTAID011" three times fills nothing more than one with it once. */
function unitsFrom(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const unit = str(item);
    if (!unit) continue;
    const short = unit.slice(0, MAX_UNIT_CHARS);
    if (!out.some((u) => u.toUpperCase() === short.toUpperCase())) out.push(short);
    if (out.length >= MAX_LISTED) break;
  }
  return out;
}

/** The capacities a certificate of competency says the holder may serve in,
 *  each as printed. AMSA prints some tickets with two on the one document
 *  ("Master" and "GMDSS Radio Operator"); which column a capacity fills is
 *  the vessel file's covers table (a row reading the capacities). */
function capacitiesFrom(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const said = str(item);
    if (!said) continue;
    const short = said.slice(0, MAX_CAPACITY_CHARS);
    if (!out.some((c) => c.toUpperCase() === short.toUpperCase())) out.push(short);
    if (out.length >= MAX_LISTED) break;
  }
  return out;
}

/** The words the model's reason for a column is kept to: it goes on Needs
 *  attention as it is written, so it has to stay one short phrase. */
const MAX_WHY_WORDS = 15;
const MAX_WHY_CHARS = 140;
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 } as const;

/** The reader's reason, held to fifteen words and a line's length. */
function whyFrom(v: unknown): string | null {
  const said = str(v);
  if (!said) return null;
  const words = said.split(/\s+/);
  return (words.length > MAX_WHY_WORDS ? words.slice(0, MAX_WHY_WORDS).join(" ") : said).slice(0, MAX_WHY_CHARS);
}

/** Every column the model said the document is evidence for: only codes the
 *  matrix has (written as the matrix writes them), a confidence it does not
 *  recognise read as a guess, the reason held to fifteen words, and a code
 *  given twice kept once at the surer of the two. */
export function columnsFrom(v: unknown, codes: [string, string][]): ReadingColumn[] {
  if (!Array.isArray(v)) return [];
  const out: ReadingColumn[] = [];
  for (const item of v) {
    const asObject = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    const said = str(asObject ? asObject.code : item);
    if (!said) continue;
    const hit = codes.find(([c]) => c.trim().toUpperCase() === said.toUpperCase());
    if (!hit) continue;
    const code = hit[0].trim();
    const conf = str(asObject?.confidence);
    const confidence: ReadingColumn["confidence"] = conf === "high" || conf === "medium" ? conf : "low";
    const why = whyFrom(asObject?.why);
    const had = out.find((c) => c.code.toUpperCase() === code.toUpperCase());
    if (had) {
      if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[had.confidence]) { had.confidence = confidence; had.why = why; }
      continue;
    }
    out.push({ code, confidence, why });
    if (out.length >= MAX_LISTED) break;
  }
  return out;
}

/** What a certificate of recognition prints about the foreign certificate
 *  behind it — only what is printed, and nothing at all where the document
 *  is not a recognition. */
function recognisesFrom(v: unknown, isRecognition: boolean) {
  if (!isRecognition || !v || typeof v !== "object" || Array.isArray(v)) return null;
  const said = v as Record<string, unknown>;
  const out = {
    authority: str(said.authority), country: str(said.country),
    number: str(said.number), expiresOn: date(said.expiresOn),
  };
  // A recognition that printed none of the four tells us nothing about the
  // certificate behind it, which is not the same as there being none.
  return out.authority || out.country || out.number || out.expiresOn ? out : null;
}

/** A printed limitation, held to its first `MAX_CONDITION_WORDS` words: it
 *  is shown on the certificate viewer as printed, and a model that answered
 *  with the whole page must not fill the screen with it. */
export function conditionsFrom(v: unknown) {
  const said = str(v);
  if (!said) return null;
  const words = said.split(/\s+/).filter(Boolean);
  const kept = words.length > MAX_CONDITION_WORDS ? words.slice(0, MAX_CONDITION_WORDS).join(" ") : said;
  return kept.slice(0, MAX_CONDITION_CHARS);
}

/** One of the five documents that stand in for a certificate, or null. */
function evidenceKindFrom(v: unknown): EvidenceKind | null {
  const said = (str(v) || "").toLowerCase();
  return (EVIDENCE_KINDS as readonly string[]).includes(said) ? (said as EvidenceKind) : null;
}

async function askModel(row: Row, bytes: ArrayBuffer, codes: [string, string][], ask: ReadingAsk) {
  const shape = mediaFor(row)!;
  const source = { type: "base64", media_type: shape.media, data: base64(bytes) };
  const fileBlock =
    shape.kind === "pdf"
      ? { type: "document", source }
      : { type: "image", source };

  const { json: parsed, truncated } = await askJson({
    system: SYSTEM,
    content: [fileBlock, { type: "text", text: instructionFor(row, codes, ask) }],
    // A certificate reading is a dozen short fields, but max_tokens covers what
    // the model thinks on the way there as well, and a poor scan is thought
    // about for a while. The room is there so a hard-to-read certificate comes
    // back read rather than cut off.
    maxTokens: 8000,
    effort: "low",
  });

  /* Every column the model says the document is evidence for, each with how
     sure it is and why. An answer in the old shape - one qualCode - is
     still read, as that one column. */
  let columns = Array.isArray(parsed.columns)
    ? columnsFrom(parsed.columns, codes)
    : columnsFrom(parsed.qualCode ? [{ code: parsed.qualCode, confidence: parsed.codeConfidence }] : [], codes);
  const registerPage = parsed.registerPage === true;
  let readable = parsed.readable !== false;
  let registerReason: string | null = null;
  /* A register page, an approval listing or a spreadsheet extract is no
     certificate. It counts only for the columns the vessel file names as
     kept in a register (registerEvidenced); for anything else it is
     unreadable, as such a page always was. Even there it is never the
     certificate itself, so the most it says is "medium" - which fills the
     cell and puts it on Needs attention for a look - and a guess about a
     register page is no evidence at all: it is unreadable, whichever way
     the reader worded its doubt. */
  if (registerPage && readable) {
    const allowed = registerColumns();
    columns = columns
      .filter((c) => allowed.includes(c.code.toUpperCase()) && c.confidence !== "low")
      .map((c) => (c.confidence === "high" ? { ...c, confidence: "medium" as const } : c));
    if (!columns.length) {
      readable = false;
      registerReason = "A register page or listing, not a certificate.";
    }
  }
  // The one code everything that still reads it goes by: the first column
  // the model was sure of or held by a level, never a guess.
  const first = columns.find((c) => c.confidence !== "low") || null;

  const reading: Reading = {
    version: READING_VERSION,
    at: new Date().toISOString(),
    model: MODEL,
    readable,
    holderName: str(parsed.holderName),
    certificateTitle: str(parsed.certificateTitle),
    issuer: str(parsed.issuer),
    issuedOn: date(parsed.issuedOn),
    expiresOn: date(parsed.expiresOn),
    neverExpires: parsed.neverExpires === true,
    // Only a code the matrix actually has (columnsFrom). A code the model
    // made up would otherwise land a date in whichever column happened to
    // match.
    qualCode: first ? first.code : null,
    codeConfidence: first ? first.confidence : null,
    columns,
    registerPage,
    holder: holderFrom(parsed.holder, ask.crew),
    // A reading that stopped partway is still worth keeping — the fields it had
    // written are read off the certificate like any other — but whoever looks at
    // it should know the rest of the document went unsaid.
    notes: truncated
      ? [str(parsed.notes), "The reading stopped partway, so parts of this certificate went unread."]
          .filter(Boolean)
          .join(" ")
      : str(parsed.notes),
    // Always written, null where the page has none: a reading carrying the
    // keys is one that was asked for them, so the hour never pays to ask
    // this certificate again (topUpParticulars). Every key below is the
    // same bargain - READING_ASKS is the list.
    documentNumber: str(parsed.documentNumber),
    holderBirthDate: date(parsed.holderBirthDate),
    endorsements: endorsementsFrom(parsed.endorsements),
    units: unitsFrom(parsed.units),
    capacities: capacitiesFrom(parsed.capacities),
    isRecognition: parsed.isRecognition === true,
    recognises: recognisesFrom(parsed.recognises, parsed.isRecognition === true),
    assessedOn: date(parsed.assessedOn),
    conditions: conditionsFrom(parsed.conditions),
    evidenceKind: evidenceKindFrom(parsed.evidenceKind),
  };

  if (!reading.readable && !reading.reason) {
    reading.reason = registerReason || reading.notes || "The model couldn't make out what this document is.";
  }
  return reading;
}

/** A reading that says the certificate could not be read, and why. It
 *  carries every key a reading made now carries, empty, so that asked again
 *  it would say no more. */
function unreadableReading(reason: string): Reading {
  return {
    version: READING_VERSION, at: new Date().toISOString(), model: null, readable: false, reason,
    documentNumber: null, holderBirthDate: null,
    endorsements: [], units: [], capacities: [], isRecognition: false, recognises: null,
    assessedOn: null, conditions: null, evidenceKind: null, columns: [], registerPage: false, holder: null,
  };
}

/** One certificate read now — the same checks and the same question the
 * batch read puts, for a file that has just been filed. A document the
 * model turned away is written down as unreadable; anything about the
 * account - no credit, the rate, a busy model, the key - throws, to be
 * tried again once the account is in order. */
export async function readCertificate(row: Row, codes: [string, string][], ask?: ReadingAsk): Promise<Reading> {
  const unreadable = (reason: string) => unreadableReading(reason);
  const shape = mediaFor(row);
  if (!shape) return unreadable(`${row.filename} isn't a PDF or an image, so it can't be read.`);
  if (row.sizeBytes > MAX_READ_BYTES) {
    return unreadable(`${row.filename} is too large to read. Re-save it under 4 MB and upload it again.`);
  }
  const bytes = await fileStore().get(row.blobKey, { type: "arrayBuffer" });
  if (!bytes) return unreadable("The file is no longer in the store.");
  try {
    return await askModel(row, bytes, codes, ask || (await readingAsk()));
  } catch (e) {
    if (e instanceof ModelRefusal && e.kind === "document") {
      const said = refusalSays(e);
      return unreadable(`The model turned this file away${said ? `: ${said}` : " as one it can't read."}`);
    }
    throw e;
  }
}

/** Why a batch could not go on: the account is out of credit or its key
 *  refused (nothing will read until a person acts), or every certificate
 *  it tried met a model that was busy or over its rate (the next hour
 *  tries again). Null where the batch got through, or failed for reasons
 *  of the documents' own. */
export type ReadStopped = { kind: RefusalKind; line: string } | null;

export function stoppedBy(
  failures: { kind: RefusalKind | null; error: string }[], extracted: number,
): ReadStopped {
  const hard = failures.find((f) => f.kind === "credit") || failures.find((f) => f.kind === "key");
  if (hard) return { kind: hard.kind!, line: hard.error };
  if (extracted === 0 && failures.length && failures.every((f) => f.kind === "rate" || f.kind === "busy")) {
    return { kind: failures[0].kind!, line: failures[0].error };
  }
  return null;
}

/** Read up to `limit` certificates that have no reading yet. */
export async function extract(codes: [string, string][], limit: number) {
  const certs = await liveCertificates();
  const store = readingStore();

  // The portal comes back here once per batch, so what has already been read is
  // answered from one listing rather than a fetch per certificate per call.
  const { blobs } = await store.list({ prefix: `${READING_VERSION}/` });
  const done = new Set(blobs.map((b) => b.key));

  const outstanding = certs.filter((row) => !done.has(readingKey(row)));
  const batch = outstanding.slice(0, limit);
  // The question's context, once for the batch.
  const ask = batch.length ? await readingAsk() : { equivalences: [], crew: [] };

  const failures: { filename: string; person: string | null; error: string; kind: RefusalKind | null }[] = [];

  await Promise.all(
    batch.map(async (row) => {
      try {
        const shape = mediaFor(row);
        if (!shape) {
          await store.setJSON(readingKey(row), unreadableReading(`${row.filename} isn't a PDF or an image, so it can't be read.`));
          return;
        }
        if (row.sizeBytes > MAX_READ_BYTES) {
          await store.setJSON(readingKey(row), unreadableReading(`${row.filename} is too large to read. Re-save it under 4 MB and upload it again.`));
          return;
        }

        const bytes = await fileStore().get(row.blobKey, { type: "arrayBuffer" });
        if (!bytes) {
          await store.setJSON(readingKey(row), unreadableReading("The file is no longer in the store."));
          return;
        }

        await store.setJSON(readingKey(row), await askModel(row, bytes, codes, ask));
      } catch (e) {
        // The model turning the document itself away - a corrupted or
        // password-protected file gets the same refusal every time it is sent,
        // and a certificate that can never be read would otherwise sit at the
        // front of every batch and stop the reading from ever finishing. It is
        // written down as unreadable, with the refusal and what to do about it,
        // and the next batch moves on to the certificates behind it.
        /* Only that, though: a refusal sorted as about the document (its
         * kind, decided once in lib/analysis.ts), and nothing else.
         *
         * "Your credit balance is too low to access the Anthropic API" came
         * back as a 400, the same status the model uses to turn away a
         * corrupted file. Read by its status it was written down as
         * unreadable for good - and then topping the account up fixed
         * nothing, because every one of those certificates was remembered
         * as already read and never tried again. It happened: 791
         * certificates of a crew's paperwork put beyond reach by a billing
         * message. Nothing is written down for anything about the account,
         * so those queue up again the moment there is credit to read them. */
        if (e instanceof ModelRefusal && e.kind === "document") {
          const said = refusalSays(e);
          try {
            await store.setJSON(readingKey(row), unreadableReading(
              `The model turned this file away${said ? `: ${said}` : " as one it can't read."} That usually means ${row.filename} is corrupted or password-protected — open it, re-save it as a fresh PDF or a clear photo, and upload it again.`,
            ));
            return;
          } catch {
            // The store refusing the write is a failure of this call, not of
            // the certificate — reported below and tried again next batch.
          }
        }
        // Nothing is written: a certificate that failed because the model was
        // busy, or the account short, has to be tried again, not remembered
        // as unreadable for good. The failure is said in the one short
        // sentence for its kind.
        failures.push({
          filename: row.filename,
          person: row.person,
          error: e instanceof ModelRefusal ? plainLine(e) : e instanceof Error ? e.message : String(e),
          kind: e instanceof ModelRefusal ? e.kind : null,
        });
      }
    }),
  );

  const read = certs.length - outstanding.length + (batch.length - failures.length);
  const extracted = batch.length - failures.length;

  return Response.json({
    total: certs.length,
    read,
    remaining: Math.max(0, certs.length - read),
    // What this call got through, so the portal can tell a batch that read
    // nothing at all from one that is simply not finished yet.
    attempted: batch.length,
    extracted,
    failures,
    // Why the reading cannot go on, where it cannot: the hour stops on it
    // and the page shows its line.
    stopped: stoppedBy(failures, extracted),
  });
}

// ---------------------------------------------------------------------------
// Filing a certificate under the person whose name is on it
// ---------------------------------------------------------------------------

/**
 * Which crew member a certificate belongs to, from the name printed on it.
 *
 * Only a name that fits one person on the matrix and nobody else counts: the
 * surname and at least one given name both have to appear on the document, so
 * "SMITH, Alan" is never taken for "SMITH, Dan". Anything less certain is
 * left exactly where it was filed and reported as a difference instead — moving
 * a certificate into the wrong person's folder is worse than leaving it be.
 */
export function holderOnMatrix(holderName: string, names: string[]) {
  const on = new Set(words(holderName));
  if (!on.size) return null;

  const fits = names.filter((name) => {
    const [last, rest] = name.split(",");
    const surname = words(last)[0];
    const given = words(rest);
    return !!surname && on.has(surname) && given.some((g) => on.has(g));
  });

  return fits.length === 1 ? fits[0] : null;
}

/**
 * Whose a certificate is, for the label on its row: the printed name where
 * it fits one man on the matrix (holderOnMatrix), then the printed name as
 * the crew register spells it - one of his spellings on Crew Details - and
 * only then the reader's pick off the register (readerPlaces in
 * source/shared/names.js, which never lets the pick take a certificate the
 * printed name fits the man it is filed under). The round asks the same
 * question the same way (whoseCertificate), so a row labelled here is a row
 * the round fills. Null where nothing says, or the answer is nobody on the
 * matrix.
 */
export function holderFor(
  row: { person?: string | null },
  reading: Reading,
  names: string[],
  people: { name?: string; aliases?: string[] }[],
): string | null {
  const printed = reading.holderName || "";
  const byName = printed ? holderOnMatrix(printed, names) : null;
  if (byName) return byName;
  // One of his spellings, or two or more of his words: never a surname or a
  // given name alone, which is the reader's to weigh ("D. EVANS" is not the
  // one Evans on the register just because David is not on it yet).
  const known = printed ? crewRegister(people).spelled(printed) : null;
  if (known) return names.includes(known) ? known : null;
  const picked = readerPlaces(printed, reading.holder, row.person, people);
  return picked && names.includes(picked.person) ? picked.person : null;
}

/**
 * Move certificates into the folder of the person they are actually for.
 *
 * A certificate is filed under whoever the uploader said, worked out from the
 * folder it arrived in or its file name — and a loose scan called
 * "Scan_0043.pdf" gives that nothing to go on. Once the certificate has been
 * read, the name printed on it settles the question, so anything sitting in the
 * wrong folder is moved to the right one, bytes and record together.
 */
export async function refile(names: string[], limit = Infinity) {
  const certs = await liveCertificates();
  const readings = await allReadings();
  const eqTable = await equivalences();

  // The matrix's own titles, for the one filing name a read certificate gets:
  // "PERSON - CODE Title.pdf" - and its columns, so a document already named
  // for one of them keeps that column (codeFor reads the filename).
  const titles: Record<string, string> = {};
  let cols: unknown[] = [];
  // The crew register, for whose a certificate is where the printed name
  // alone does not say (holderFor).
  let people: { name?: string; aliases?: string[] }[] = [];
  try {
    const state = await getEnv().DB.prepare("SELECT data FROM portal_state LIMIT 1").first<{ data: string }>();
    const doc = JSON.parse(state?.data || "{}");
    people = Array.isArray(doc?.people) ? doc.people : [];
    const listed = doc?.quals?.cols || [];
    cols = Array.isArray(listed) ? listed : [];
    for (const c of cols as unknown[][]) {
      titles[String(c[0]).trim().toUpperCase()] = String(c[1] || "").trim();
    }
  } catch (e) {
    console.error("matrix titles not read for renaming:", e);
  }

  const moved: { id: string; filename: string; folder: string; from: string | null; to: string }[] = [];
  let done = 0;
  let remaining = 0;

  // Nothing is deleted here, and nothing anywhere else on the portal removes a
  // certificate on its own. The same document filed twice is listed in the
  // Duplicates section for somebody to decide about - that call is the
  // office's, not the portal's.

  /* Whose certificate each one is, written on its row. The file is not moved.
   *
   * Certificates the sync took on carry their folder's name as their person
   * until a reading says otherwise, so they sit under Other with no rank
   * against them; and a certificate can be in the wrong person's folder
   * altogether. Both are the same answer now - the row is corrected and the
   * file stays where the office filed it.
   *
   * It used to move the file into a folder worked out from the person's
   * name. Where the library had never used that name, the move made the
   * folder rather than renaming anything, so the library grew a second,
   * near-empty folder for people who already had one. A label, not a move:
   * a row update, no file touched, so it does not count against the slice.
   *
   * The labels go first, in a few batches, before any file is touched: a
   * statement per certificate was a database round trip each, and a
   * backlog of them spent the hour's budget of calls before the round
   * could run. Eighty to a batch, the same as the comparison's notes. */
  const named = new Map<string, string>();
  for (const row of certs) {
    const reading = readings.get(readingKey(row)) || null;
    if (!reading || !reading.readable || !reading.holderName) continue;
    const person = holderFor(row, reading, names, people);
    if (!person) continue;
    named.set(row.id, person);
    if ((row.person || "") !== person) {
      moved.push({ id: row.id, filename: row.filename, folder: row.folder || "", from: row.person, to: person });
      row.person = person;
    }
  }
  const labels = moved.map((m) => ({ id: m.id, person: m.to }));
  const d1 = getEnv().DB;
  for (let i = 0; i < labels.length; i += 80) {
    await d1.batch(
      labels.slice(i, i + 80).map((l) =>
        d1.prepare("UPDATE documents SET person = ?2 WHERE id = ?1").bind(l.id, l.person),
      ),
    );
  }

  // Then the files: each takes the one filing name, wrapped as a PDF where
  // it is a photo. Each rename is a copy, a delete and a row update in the
  // library, and they are only worth doing carefully. A big backlog is
  // taken a slice per request (limit + remaining), so no single request
  // runs longer than its caller can wait.
  for (const row of certs) {
    const reading = readings.get(readingKey(row)) || null;
    const person = named.get(row.id);
    if (!reading || !person) continue;

    const code = String(codeFor(row, reading, eqTable, cols) || "").trim().toUpperCase();
    const title = code ? titles[code] : "";
    if (!code || !title || !/^[a-z0-9-]+$/.test(row.folder || "")) continue;
    const personName = names.includes(row.person || "") ? row.person : person;
    if (!personName) continue;
    const ext = ((row.filename.match(/\.[^.]+$/) || [""])[0] || "").toLowerCase();
    const targetExt = ext === ".pdf" || [".jpg", ".jpeg", ".png"].includes(ext) ? ".pdf" : ext;
    // The one filing name (filingName dashes a slash in the title, so
    // "STCW Reg IV/2" is not cut down to "2" by safeName's path stripping).
    const wantBase = filingName(personName, code, title, targetExt);
    if (row.filename === safeName(wantBase) + targetExt) continue;
    if (done >= limit) { remaining++; continue; }
    // Whether the code is the office's own: codeFor took it off the office's
    // name (a hand tag comes first there, and a name the portal wrote is no
    // filing). Then the rename only tidies the office's word into the
    // portal's shape, and the row is not marked as the portal's naming - or
    // the filed column would be thrown away after one refile.
    const filed = row.namedByPortal ? null : filedCodeIn(row.filename, cols);
    const renamedRow = await canonicaliseCertificate(row, wantBase, imageToPdf, !!filed && code === filed);
    if (renamedRow) {
      moved.push({ id: renamedRow.id, filename: renamedRow.filename, folder: row.folder!, from: row.filename, to: personName });
      done++;
    }
  }

  return Response.json({ moved, remaining });
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

const words = (s: string | null | undefined) =>
  (s || "")
    .normalize("NFKD")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

const dmy = (iso: string) => iso.split("-").reverse().join("/");

/** A reading with the date typed against the document on the portal in
 *  place of the one read off the scan, where somebody typed one. For a
 *  document that is no one column - a high risk work licence - the covers
 *  rule reads the expiry off the reading, and the typed date has to beat the
 *  read one there exactly as it does for a certificate's own column. The
 *  page's cells do the same (certificateStanding in lib/analysis.ts). */
export function typedOver(row: { expiresOn?: string | null }, reading: Reading): Reading {
  const typed = isDate(row.expiresOn) ? normDate(row.expiresOn!) : null;
  return typed ? { ...reading, expiresOn: typed } : reading;
}

// isDate() truncates to the first 10 characters before checking the ISO shape,
// so a value that passed it may still carry more than a bare YYYY-MM-DD — a full
// timestamp, say. Anything compared against a date or handed to dmy() once it
// has passed isDate() has to be cut down the same way, or the extra characters
// break the comparison and garble dmy()'s day-month-year.
const normDate = (v: string) => v.trim().slice(0, 10);

/** How a cell reads in a sentence, rather than as a raw value. */
function cellReads(v: string | null | undefined) {
  if (blankish(v)) return (v || "").trim() === "?" ? "a question mark" : "nothing";
  if (isNotHeld(v)) return "not held";
  if (isHeld(v)) return "held";
  return isDate(v) ? dmy(normDate(v || "")) : (v || "").trim();
}

type Item = {
  id: string;
  kind: string;
  person: string;
  code: string;
  title: string;
  group: string;
  sheetValue: string;
  proposed: string;
  detail: string;
  source: "certificate" | "spreadsheet";
  certificate?: { id: string; filename: string; url: string; expires: string | null; title: string | null };
};

type Note = { kind: string; person: string | null; detail: string; certificate?: { id: string; filename: string; url: string } };

// "2 years", "24 months", "every 5 years" — the shapes a validity period is
// written in where the reading couldn't give it as a plain number of months.
function monthsFrom(text: string | null | undefined): number | null {
  const m = /(\d+(?:\.\d+)?)\s*(years?|yrs?|months?|mths?|mos?)\b/i.exec(text || "");
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /^y/i.test(m[2]) ? Math.round(n * 12) : Math.round(n);
}

// An issue date plus a validity period, with the day clamped so 31 January plus
// one month is 28 February rather than the 3rd of March.
function addMonths(iso: string, months: number): string {
  const [y, mo, d] = iso.split("-").map(Number);
  const total = mo - 1 + months;
  const ny = y + Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

type Period = { months: number | null; neverExpires: boolean };

/**
 * The validity periods matrix, as a lookup by matrix code and by item title.
 *
 * The reading is the one the matrix analysis keeps — made when the document was
 * filed, or by the run that is asking now — so the comparison pays nothing to
 * use it. Null where no validity periods matrix is filed, or where the one that
 * is hasn't been read yet: the comparison then runs as it always did, on the
 * dates printed on the certificates alone.
 */
async function validityPeriods() {
  // The validity periods are read off the skills matrix — the office folded
  // the old separate validity spreadsheet into it, so the latest skills
  // matrix is always the source.
  const row = await liveSingleFileRow("skills-matrix");
  if (!row) return null;

  const held = (await matrixStore().get(matrixReadingKey("validity", row.id), {
    type: "json",
  })) as MatrixReading | null;
  if (!held || !held.reading || held.reading.readable === false) return null;

  const listed = Array.isArray(held.reading.periods) ? held.reading.periods : [];
  const byCode = new Map<string, Period>();
  const byTitle = new Map<string, Period>();

  for (const p of listed as Record<string, unknown>[]) {
    if (!p || typeof p !== "object") continue;
    const months =
      typeof p.months === "number" && p.months > 0
        ? Math.round(p.months)
        : monthsFrom(str(p.validFor));
    const entry: Period = { months, neverExpires: p.neverExpires === true };
    if (entry.months == null && !entry.neverExpires) continue;
    const code = str(p.code);
    const item = str(p.item);
    if (code) byCode.set(code.toUpperCase(), entry);
    if (item) byTitle.set(words(item).join(" "), entry);
  }

  if (!byCode.size && !byTitle.size) return null;
  return { filename: row.filename, byCode, byTitle };
}

/**
 * The validity periods matrix as a plain list — what the E-Learning Status
 * page shows against each module. Answered from the cached reading alone, the
 * one made when the document was filed or by the last Update table run, so it
 * costs nothing to ask any time. `read` is false while a matrix is on file but
 * hasn't been read yet, so the page can say so rather than showing blanks.
 */
async function validityPeriodList() {
  // Same source as validityPeriods() above: the skills matrix carries the
  // validity periods, so its latest upload is what this list is read from.
  const row = await liveSingleFileRow("skills-matrix");
  if (!row) return Response.json({ filename: null, read: false, periods: [] });

  const held = (await matrixStore().get(matrixReadingKey("validity", row.id), {
    type: "json",
  })) as MatrixReading | null;
  if (!held || !held.reading || held.reading.readable === false) {
    return Response.json({ filename: row.filename, read: false, periods: [] });
  }

  const listed = Array.isArray(held.reading.periods) ? held.reading.periods : [];
  const periods = (listed as Record<string, unknown>[])
    .filter((p) => p && typeof p === "object")
    .map((p) => ({
      code: str(p.code),
      item: str(p.item),
      validFor: str(p.validFor),
      months:
        typeof p.months === "number" && p.months > 0
          ? Math.round(p.months)
          : monthsFrom(str(p.validFor)),
      neverExpires: p.neverExpires === true,
    }))
    .filter((p) => p.code || p.item);

  return Response.json({ filename: row.filename, read: true, periods });
}

type Sheet = { filename?: string; rows?: { name: string; vals: (string | null)[] }[] } | null;

/** What the comparison hands back: the route wraps it in a Response, the
 *  hourly round reads it as it is. */
export type CompareResult = {
  at: string;
  model: string;
  items: Item[];
  notes: Note[];
  settled: { person: string; code: string; value: string; clear?: boolean }[];
  claimed: string[];
  /** Certificate rows written down this pass - those not already saying
   *  what the reading says. */
  noted: number;
  summary: {
    certificates: number; read: number; unread: number; compared: number; agree: number;
    discrepancies: number; fromCertificates: number; fromSheet: number; sheetTotal: number;
    sheetCapped: number; uncertified: number; sheetFilename: string | null;
    validitySheet: string | null; derived: number;
  };
};

/* The page's comparison reads names through the crew register, the same
   as the round on the hour does: a certificate still filed under the
   office's spelling of a man claims the row the register names, so the
   two never disagree about which cells the certificates stand behind. */
async function compare(matrix: Matrix, sheet: Sheet) {
  const cur = await readDocument();
  return Response.json(await compareMatrix(matrix, sheet, asKnownPerson(cur?.doc.people || [])));
}

/**
 * The comparison itself. `nameOf` is how a certificate's person is read
 * before it is looked for on the matrix: the crew register's, where the
 * round passes one, so a certificate filed under "sAM" claims the row the
 * matrix calls "SAMPLE, Sam". A spelling the register does not know
 * stays itself, the same fallback applySettled uses. The route passes
 * nothing and compares names as they are, as it always has.
 */
export async function compareMatrix(
  matrix: Matrix,
  sheet: Sheet,
  nameOf: (name: string) => string | null | undefined = (n) => n,
  /** The round asks for the certificates as the particulars rule reads
   *  them (source/shared/particulars.js), off the same listing and
   *  readings this pass has already loaded - the route asks for nothing,
   *  so its answer to the page is as it was. */
  opts: { withParticulars?: boolean } = {},
): Promise<CompareResult & { particulars?: ParticularsInput }> {
  const as = (n: string) => { const k = nameOf(n); return k == null || k === "" ? n : k; };
  // The crew register, for the reader's pick of a person (whoseCertificate).
  const people = ((await readDocument().catch(() => null))?.doc.people || []) as { name?: string; aliases?: string[] }[];
  const certs = await liveCertificates();
  const held = await allReadings();

  // The validity periods matrix, where one is filed and has been read. It is
  // what turns a certificate that prints an issue date and no expiry into a
  // date the spreadsheet can carry.
  const validity = await validityPeriods().catch(() => null);

  const readings = certs.map((row) => ({ row, reading: held.get(readingKey(row)) || null }));
  const eqTable = await equivalences();
  const rehomed: { person: string | null; old: string; expiry: string | null }[] = [];

  const cols = matrix.cols || [];
  // Keyed upper case, the same way the rest of the codebase matches matrix
  // codes, so a code that differs from the matrix only in case still matches.
  const colAt = new Map(cols.map((c, i) => [c[0].trim().toUpperCase(), i]));
  const rowAt = new Map(matrix.rows.map((r, i) => [r[0].trim().toUpperCase(), i]));

  const items: Item[] = [];
  const notes: Note[] = [];
  let agree = 0;

  // One certificate per person and code. Two certificates for the same item is
  // a renewal sitting next to the certificate it renews, so the later date is
  // the one held against the spreadsheet and the other is only mentioned.
  const claim = new Map<string, { row: Row; reading: Reading; coveredUntil?: string; heldByCover?: boolean }>();
  /* Every certificate that got past the holder check and onto a column of
     its own, kept for the covering pass below: one certificate fills every
     column its printed endorsements and unit codes cover as well as its own
     (source/shared/covers.js, the table in the vessel file). */
  const standing: { row: Row; reading: Reading; person: string; code: string }[] = [];
  /* The document's own column - the first it is placed in - by row: what
     its row records as what it is, never a second column it also fills. */
  const primaryOf = new Map<string, string>();
  /* The expiry of the foreign certificate itself, where one is on the portal
     for the same column: a recognition can never run longer than the
     certificate it recognises (MO70 s 33(2), s 36(3), s 37(4)). The latest of
     them, because two on file are a renewal beside the one it renewed. */
  const foreignAt = new Map<string, string>();

  for (const { row, reading } of readings) {
    const link = { id: row.id, filename: row.filename, url: `/api/files/${row.id}` };

    if (!reading) continue;
    // A document the reader could not read, or would not call a certificate,
    // fills nothing - unless a person's hand tag is the whole answer (a
    // column that never lapses, or a date typed against the row: tagStands
    // in lib/analysis.ts, which the page's cells ask too).
    if (!reading.readable && !tagStands(row, reading)) {
      notes.push({
        kind: "unreadable",
        person: row.person,
        detail: reading.reason || "This certificate couldn't be read.",
        certificate: link,
      });
      continue;
    }

    // The uploader's own tagging comes first — a person choosing the item off a
    // list beats a model inferring it from a scan - then the column the
    // filename files it under, which is a column of THIS matrix or nothing
    // (source/shared/filed-as.js). The reader's columns come after, every
    // one it was sure of or held satisfied by a level, and never a guess:
    // columnsFor in lib/analysis.ts, which the page's cells go through too.
    const placedAll = columnsFor(row, reading, eqTable, cols);
    const code = placedAll.length ? placedAll[0].code : null;

    // The model's own guess, remembered where the equivalence page overruled
    // it - the cell that guess once filled may still be sitting on the matrix.
    const guess = reading.codeConfidence !== "low" ? (reading.qualCode || "").trim().toUpperCase() : "";
    if (!row.qualCode && guess && code && !placedAll.some((c) => c.code.trim().toUpperCase() === guess) && colAt.has(guess)) {
      const typedOld = isDate(row.expiresOn) ? normDate(row.expiresOn!) : null;
      rehomed.push({ person: row.person, old: guess, expiry: typedOld || reading.expiresOn || null });
    }

    /* A document that is no one column can still fill the columns it
       covers: a high risk work licence printing five classes is rightly
       given no code, and its DG and CV classes fill dogging and the crane
       all the same (the vessel file's rows, source/shared/covers.js). Such
       a document goes through every check below as a certificate would
       and joins only the covering pass; only one that covers nothing
       either is nothing on the matrix. */
    let placed = placedAll.filter((c) => colAt.has(c.code.trim().toUpperCase()));
    const ownColumn = placed.length > 0;
    if (!ownColumn && !coveredCells(typedOver(row, reading), vessel.covers, vessel.qualColumns, null)
      .some((cell) => !!cell.until && colAt.has(cell.code.trim().toUpperCase()))) {
      notes.push({
        kind: "no-code",
        person: row.person,
        detail: reading.certificateTitle
          ? `Read as "${reading.certificateTitle}", which doesn't match an item on the matrix.`
          : "Nothing on the matrix could be matched to this certificate.",
        certificate: link,
      });
      continue;
    }

    // Whose row this certificate speaks for, as the register names him.
    const person = row.person ? as(row.person) : "";
    if (!person || !rowAt.has(person.trim().toUpperCase())) {
      notes.push({
        kind: "not-on-matrix",
        person: row.person,
        detail: `${row.person || "Nobody"} isn't on the crew matrix, so there is nothing to compare this against.`,
        certificate: link,
      });
      continue;
    }

    /* The name on the document against the person it was filed under. A scan
       filed against the wrong crew member is worse than one not filed at
       all. The one rule is in source/shared/names.js, so the page's cells
       (certificateStanding) refuse the same document this does - and it is
       where the reader's pick of a person off the register is weighed, only
       where the printed name and the folder give no answer of their own. */
    const whose = whoseCertificate(reading.holderName, reading.holder, row.person, person, people);
    if (!whose.his) {
      notes.push({
        kind: "name-mismatch",
        person: row.person,
        detail: `Filed under ${row.person}, but the certificate is in the name of ${reading.holderName}.`,
        certificate: link,
      });
      continue;
    }

    /* A paper that stands in for a certificate is not the certificate.
       An AMSA extension letter, a lodged-renewal receipt, a temporary
       crewing permit, a final assessor's declaration and an issue letter
       each carry a man for a while (MO70 s 15(3)-(4), MO505 s 7(3),
       MO504 s 16(2), MO505 ss 22-24, MO505 s 12(2)) - but none of them is
       the certificate, and the day the cover runs out is not the day the
       certificate expires. So the paper never reaches a cell, never joins
       the contest for one and never stands as the foreign certificate
       behind a recognition. What it does carry is worked out separately
       (source/shared/evidence.js) and shown as a cover, in amber, saying
       what carries him.

       Which paper it is, if any, is the one question paperKind answers
       (source/shared/evidence.js): the kind the person picked when they
       filed it, else - where they tagged its column and picked no kind -
       the certificate for that column whatever the model called it, else
       the reading's word. The model sometimes reads an ordinary certificate
       as one of the five papers, and left to the reading that certificate
       stopped filling its cell and had the date cleared as an orphan; the
       person who tagged it chose the item off the list, which beats the
       model's guess. And a paper filed with its kind and its column is a
       paper about that column, never the certificate. The page's cells and
       the evidence rule read the row the same way. */
    const paper = paperKind(row, reading);
    if (paper) {
      notes.push({
        kind: "no-code",
        person: row.person,
        detail: `${row.evidenceKind ? "Filed" : "Read"} as ${paper}, which stands in for a certificate rather than being one, so it fills no cell.`,
        certificate: link,
      });
      continue;
    }

    /* Two columns AMSA may not recognise into at all: MO70 s 7(2)(b) allows
       recognition of the competency, rating, cook-adjacent and GMDSS classes
       only, and neither the certificate of safety training nor the marine
       cook certificate is among them. A recognition claiming either proves
       nothing about that column and fills nothing - and a recognition
       placed only in such columns fills nothing at all. */
    if (ownColumn && isRecognitionReading(reading)) {
      for (const c of placed.filter((p) => !recognitionFills(p.code, vessel.neverRecognised.codes))) {
        notes.push({
          kind: "no-code",
          person: row.person,
          detail: `Read as a certificate of recognition for ${c.code}, which is not a class AMSA recognises, so it fills nothing.`,
          certificate: link,
        });
      }
      placed = placed.filter((p) => recognitionFills(p.code, vessel.neverRecognised.codes));
      if (!placed.length) continue;
    }

    /* Where the filed column and the reading disagree the filed column still
       takes the date, and the disagreement is said - once here for the
       round's report, and on Needs attention by the page's cells
       (certificateStanding), in the one sentence. Said at this point, past
       every check above, so the round and the page say it for exactly the
       documents that fill a cell: a paper, a document under a man not on
       the matrix or printed in another man's name is already noted for
       what it is, and is not a filing to question as well. */
    const disagreed = filedAsFor(row, reading, eqTable, cols);
    if (disagreed) {
      notes.push({
        kind: "filed-as",
        person: row.person,
        detail: filedAsLine(as(row.person || ""), disagreed.code, disagreed.title, disagreed.readsAs),
        certificate: link,
      });
    }
    /* The reader placed it on a man whose names on Crew Details do not yet
       carry the name printed on it: said once, in the one sentence, so the
       name is added where names live and the next certificate needs no
       reader to place it. Past every check, for the same reason as above. */
    if (whose.line) {
      notes.push({
        kind: "read-as",
        person: row.person,
        detail: readAsLine((reading.certificateTitle || "").trim() || row.filename, person, reading.holderName, whose.line),
        certificate: link,
      });
    }

    // An empty code is a document with no column of its own: it covers only.
    if (!placed.length) standing.push({ row, reading, person, code: "" });
    else primaryOf.set(row.id, placed[0].code.trim().toUpperCase());
    for (const c of placed) {
      standing.push({ row, reading, person, code: c.code.trim().toUpperCase() });
      /* A column the reader holds the document satisfies by a level, an
         equivalence or an endorsement: filled, and said in the one line so a
         quick look confirms it (placedLine) - management only, on the page. */
      if (c.by === "read" && c.confidence === "medium") {
        notes.push({
          kind: "placed",
          person: row.person,
          detail: placedLine(person, c.code.trim().toUpperCase(), c.why ?? null),
          certificate: link,
        });
      }
    }
  }

  const keyFor = (person: string, code: string) =>
    `${person.trim().toUpperCase()}::${code.trim().toUpperCase()}`;

  /* The foreign certificates first, before any contest is decided. A
     recognition's date is cut back to the certificate behind it, and a map
     still being filled as the contests were decided would settle the same
     pair of documents differently depending on the order the library
     happened to list the files in. */
  for (const { row, reading, person, code } of standing) {
    if (!code || isRecognitionReading(reading)) continue;
    const own = (isDate(row.expiresOn) ? normDate(row.expiresOn!) : null) || reading.expiresOn || "";
    const key = keyFor(person, code);
    if (own && own > (foreignAt.get(key) || "")) foreignAt.set(key, own);
  }

  /** What one document gives one column: the date typed against it on the
   *  portal where somebody typed one, otherwise the date read off the scan,
   *  and nothing at all for a column that carries no expiry - with the
   *  recognition's cut already applied, so every comparison below is between
   *  two dates that mean the same thing. The page's cells work the date out
   *  the same way (certificateStanding in lib/analysis.ts), so the grid and
   *  the round cannot settle a cell differently. */
  const dateFrom = (r: Row, rd: Reading, code: string, key: string) => {
    const typed = isDate(r.expiresOn) ? normDate(r.expiresOn!) : null;
    const own = neverLapses(code) ? null : typed || rd.expiresOn || null;
    return isRecognitionReading(rd) ? recognisedUntil(rd, own, foreignAt.get(key)).until : own;
  };

  // One certificate per person and code, decided as above. A document with
  // no column of its own has no contest to join here: it covers below.
  const coverOnly: { row: Row; reading: Reading; person: string }[] = [];
  for (const { row, reading, person, code } of standing) {
    // Keyed as the claims are keyed: the register's name, upper case. A
    // document with no column of its own is dated as its own column would
    // be - the date typed against it first (typedOver).
    if (!code) { coverOnly.push({ row, reading: typedOver(row, reading), person: person.trim().toUpperCase() }); continue; }
    const key = keyFor(person, code);
    const sitting = claim.get(key);
    if (!sitting) {
      claim.set(key, { row, reading });
      continue;
    }
    const mine = dateFrom(row, reading, code, key);
    const his = dateFrom(sitting.row, sitting.reading, code, key);
    const mineIsRec = isRecognitionReading(reading);
    const sittingIsRec = isRecognitionReading(sitting.reading);
    /* The medical is the one exception to "the longer runs": it expires the
       moment a further one is issued (MO76 s 16(3)), so of two on file the
       one ISSUED last is the one in force even where the older prints the
       later date. A shorter certificate signed after an injury wins. Two
       issued the same day have nothing in the order to separate them and
       fall back to the longer, as everything else does. */
    const byIssue = certStatesOwnExpiry(code)
      && (reading.issuedOn || "") !== (sitting.reading.issuedOn || "");
    /* A certificate of recognition and the foreign certificate behind it:
       the recognition is the document that counts on this vessel (MO505 s 4,
       s 7(2)) and the cell must open it, so it holds the cell and its date is
       cut back to the foreign one. But nothing in the orders makes a spent
       recognition beat a certificate that is still running - s 7(2) gives
       standing to an AMSA seafarer certificate OR to a recognition, and
       MO70 s 33(2) and s 37(4) only cap a recognition against the
       certificate behind it. So where the other document actually runs the
       longer, the longer runs, and a man who holds a current certificate is
       not shown as expired on an old recognition. */
    const recognitionHolds = () => {
      const rec = mineIsRec ? mine : his;
      const other = mineIsRec ? his : mine;
      return !rec || !other || rec >= other;
    };
    /* Neither printing a later expiry than the other - two induction forms,
       which print none, or two cards to the same day - the one issued last
       is the one in force: a renewal is the newer paper. Decided by order
       of filing before 26 Sep 2026, so a form signed this month lost the
       cell to the one it renewed and the cell stayed expired. The page's
       cells settle it the same way (certificateStanding). */
    const tie = (mine || "") === (his || "");
    const byLater = tie && (reading.issuedOn || "") !== (sitting.reading.issuedOn || "");
    const mineWins = mineIsRec !== sittingIsRec
      ? (mineIsRec ? recognitionHolds() : !recognitionHolds())
      : byIssue || byLater
        ? (reading.issuedOn || "") > (sitting.reading.issuedOn || "")
        : (mine || "") > (his || "");
    const inForce = mineWins ? { row, reading } : sitting;
    const replaced = mineWins ? sitting : { row, reading };
    claim.set(key, inForce);
    notes.push({
      kind: "superseded",
      person: replaced.row.person,
      detail: isRecognitionReading(inForce.reading) !== isRecognitionReading(replaced.reading)
        && isRecognitionReading(inForce.reading)
        ? `Two certificates on file for ${code}. ${inForce.row.filename} is AMSA's certificate of recognition, which is the document that counts here, so ${replaced.row.filename} is the foreign certificate behind it.`
        : byIssue
          ? `Two certificates on file for ${code}. ${inForce.row.filename} was issued last, so ${replaced.row.filename} expired the day it was signed.`
          : byLater
            ? `Two certificates on file for ${code}. Neither runs the longer, and ${inForce.row.filename} was issued last, so ${replaced.row.filename} is treated as the one it replaced.`
            : `Two certificates on file for ${code}. ${inForce.row.filename} runs the longer, so ${replaced.row.filename} is treated as the one it replaced.`,
      certificate: { id: replaced.row.id, filename: replaced.row.filename, url: `/api/files/${replaced.row.id}` },
    });
  }

  /* The covering pass. A new-style AMSA certificate of competency prints its
     endorsements on its face - "II/2 (incl. generic ECDIS)" - and a training
     statement prints the unit codes it covers, so one document answers for
     more than one column. Which endorsement fills which column is the vessel
     file's `covers` table and never the model's guess; a unit code fills the
     column whose title carries it (source/shared/covers.js, with the clauses).
     The covered column joins exactly the contest its own column joins: the
     one that runs the longer is the certificate in force, and the cell links
     to whichever document that is. A covered column with no date to give -
     no end printed against the endorsement and none on the certificate -
     claims nothing, because there would be nothing to put in the cell.

     Only the certificates that hold their own column cover anything: a
     ticket the contest above has just decided was superseded is the one it
     replaced, and the endorsements printed on a spent document cannot date a
     column nothing in force carries. And the documents that are no one
     column - a licence printing five classes - which have nothing to hold
     and cover on their own account. */
  const displaced: { row: Row; reading: Reading; code: string }[] = [];
  const covering = [
    ...[...claim.entries()].map(([ownKey, { row, reading }]) => ({
      row, reading,
      person: ownKey.slice(0, ownKey.indexOf("::")),
      code: ownKey.slice(ownKey.indexOf("::") + 2) as string | null,
    })),
    ...coverOnly.map((c) => ({ ...c, code: null as string | null })),
  ];
  for (const { row, reading, person, code } of covering) {
    for (const cell of coveredCells(reading, vessel.covers, vessel.qualColumns, code)) {
      const at = cell.code.trim().toUpperCase();
      if (!colAt.has(at)) continue;
      // A recognition reaches no further than it may reach itself.
      if (isRecognitionReading(reading) && !recognitionFills(at, vessel.neverRecognised.codes)) continue;
      const key = `${person}::${at}`;
      /* A column that carries no expiry is held or it isn't. A unit code or
         an endorsement printed on a document in force says it is held, and
         no date on any line says more - so the cover holds it, with no date,
         where nothing holds it already. The page's cells hold it the same
         way (lib/analysis.ts). */
      if (neverLapses(at)) {
        if (!claim.has(key)) claim.set(key, { row, reading, heldByCover: true });
        continue;
      }
      if (!cell.until) continue;
      /* The endorsement on a recognition runs for the remainder of the
         foreign certificate's endorsement (MO70 s 37(4)), so the covered
         column takes the same cut - and takes it on BOTH sides of the
         comparison below, or a recognition would win the cell on its own
         printed date and then have that date cut back below the document
         that should have held it. */
      const mine = isRecognitionReading(reading)
        ? recognisedUntil(reading, cell.until, foreignAt.get(key)).until
        : cell.until;
      if (!mine) continue;
      const sitting = claim.get(key);
      if (sitting) {
        const raw = sitting.coveredUntil
          || (isDate(sitting.row.expiresOn) ? normDate(sitting.row.expiresOn!) : null)
          || sitting.reading.expiresOn || null;
        const held = !sitting.coveredUntil && isRecognitionReading(sitting.reading)
          ? recognisedUntil(sitting.reading, raw, foreignAt.get(key)).until
          : raw;
        if ((held || "") >= mine) continue;
        /* A covered date beating a certificate that IS this column: that
           certificate is the one being replaced, and it says so - and its
           own row still records what it is, or nothing afterwards could say
           which cell it had been holding up. */
        if (!sitting.coveredUntil) {
          displaced.push({ row: sitting.row, reading: sitting.reading, code: at });
          notes.push({
            kind: "superseded",
            person: sitting.row.person,
            detail: `${row.filename} covers ${at} to ${dmy(mine)}, which is longer than ${sitting.row.filename} runs, so ${sitting.row.filename} is treated as the one it replaced.`,
            certificate: { id: sitting.row.id, filename: sitting.row.filename, url: `/api/files/${sitting.row.id}` },
          });
        }
      }
      claim.set(key, { row, reading, coveredUntil: mine });
    }
  }

  const covered = new Set<string>();
  let derived = 0;

  // Every cell a certificate settles outright — the expiry printed on it or
  // typed against it, "Y" where it never lapses, or the date worked out from
  // its issue date and the validity periods matrix. The items above only say
  // where the matrix disagrees; this is the whole account, so a spreadsheet
  // can be brought up to what the certificates say even in the cells where
  // the crew matrix already agrees with them.
  const settled: { person: string; code: string; value: string; clear?: boolean }[] = [];

  /* What each certificate turned out to be, written onto its own row.
   *
   * The reading itself lives in a cache keyed by the file's contents, which is
   * right for a cache - it costs nothing to rebuild from the file. But it meant
   * the books never held a certificate's own details: which item it was for and
   * when it ran out lived nowhere but that cache, and 1,663 certificates on the
   * portal had a person against them and nothing else. Delete the file and the
   * cache went with it, and nothing could work out afterwards which cell of the
   * matrix that certificate had been holding up.
   *
   * So the row keeps it now. Gathered as the comparison works through the
   * claims - it has just worked all of this out - and written in one batch at
   * the end rather than a query per certificate. */
  const noted: { id: string; code: string; expires: string | null; issued: string | null;
    issuer: string | null; title: string | null }[] = [];

  for (const [key, { row, reading, coveredUntil, heldByCover }] of claim) {
    const code = key.split("::")[1];
    // The key was built from the register's name for him, so it is what
    // finds his row.
    const at = rowAt.get(key.slice(0, key.indexOf("::")))!;
    const col = colAt.get(code.trim().toUpperCase())!;
    const matrixRow = matrix.rows[at];
    const cell = matrixRow[3][col] || "";
    const [, title, group] = cols[col];
    covered.add(`${at}:${col}`);

    // A date typed against the certificate on the portal — at upload, or edited
    // since — is the person's own answer, and beats the model's reading of the
    // scan the same way their choice of matrix code does.
    const typed = isDate(row.expiresOn) ? normDate(row.expiresOn!) : null;
    /* A covered column takes the date the cover rule worked out - the
       endorsement's own printed end where AMSA printed one, otherwise the
       certificate's. The date typed against the certificate on the portal is
       the person's answer about its OWN column, so it says nothing here. */
    const own = coveredUntil || typed || reading.expiresOn || null;
    /* A certificate of recognition can never outlive the certificate it
       recognises - it is revalidated only after that one is (MO70 s 33(2)),
       endorsed only after it is (s 36(3)), and its endorsement runs for the
       remainder of that one's (s 37(4)). So the cell takes the earlier of
       the two: the date printed on the recognition itself, and the foreign
       certificate's, whether printed on the recognition or read off the
       certificate where it too is on the portal. */
    const expiry = isRecognitionReading(reading)
      ? recognisedUntil(reading, own, foreignAt.get(key)).until
      : own;

    const link = {
      id: row.id,
      filename: row.filename,
      url: `/api/files/${row.id}`,
      expires: expiry,
      title: reading.certificateTitle || null,
    };
    const note = {
      id: row.id,
      code,
      expires: expiry || null,
      issued: reading.issuedOn || null,
      issuer: reading.issuer || null,
      title: reading.certificateTitle || null,
    };
    // Only where the row does not already say exactly this: a quiet hour
    // then writes nothing, rather than every certificate's row every hour.
    const same = (row.readCode ?? null) === note.code && (row.readExpires ?? null) === note.expires
      && (row.readIssued ?? null) === note.issued && (row.readIssuer ?? null) === note.issuer
      && (row.readTitle ?? null) === note.title;
    /* Never for a covered column: the row's own read code is what the
       certificate IS, and writing a column it merely covers over the top
       would lose which certificate this document is. */
    if (!same && !coveredUntil && !heldByCover && primaryOf.get(row.id) === code.trim().toUpperCase()) noted.push(note);

    const base = {
      id: `cert:${row.id}:${code}`,
      person: matrixRow[0],
      code,
      title,
      group,
      sheetValue: cell,
      source: "certificate" as const,
      certificate: link,
    };

    // An item written down as carrying no expiry (NO_EXPIRY_CODES) is settled
    // before any date is looked at: it doesn't lapse for anybody on the crew, so
    // a certificate on file reads as held and nothing more needs asking of the
    // scan or of the validity periods matrix. Where a date was read off the
    // document or typed against it anyway, that date is put up as a note rather
    // than acted on — it can only be a course or issue date, not an expiry the
    // item doesn't have.
    if (neverLapses(code)) {
      // A column that carries no expiry says nothing about a date a covering
      // certificate would have given it: it is held or it isn't - and a
      // document that holds it by a printed unit or endorsement is dated for
      // its own column, not this one.
      if (expiry && !coveredUntil && !heldByCover) {
        notes.push({
          kind: "no-expiry-item",
          person: matrixRow[0],
          detail: `${code} carries no expiry, so the ${dmy(expiry)} date ${typed ? "filed against" : "on"} this certificate is not read as one.`,
          certificate: { id: row.id, filename: row.filename, url: link.url },
        });
      }
      if (isHeld(cell)) {
        settled.push({ person: matrixRow[0], code, value: "Y" });
        agree++;
        continue;
      }
      if (isDate(cell)) {
        notes.push({
          kind: "date-without-expiry",
          person: matrixRow[0],
          detail: `${code} is dated ${dmy(normDate(cell))} on the spreadsheet, but ${code} carries no expiry — it is held or it isn't.`,
          certificate: { id: row.id, filename: row.filename, url: link.url },
        });
        continue;
      }
      derived++;
      settled.push({ person: matrixRow[0], code, value: "Y" });
      items.push({
        ...base,
        kind: "held-not-recorded",
        proposed: "Y",
        // Nothing to expire, so the line carries no expiry against the scan.
        certificate: { ...link, expires: null },
        detail: `${code} carries no expiry, so a certificate on file reads as held. The spreadsheet says ${cellReads(cell)}.`,
      });
      continue;
    }

    if (expiry) {
      // A cell that already agrees stays in `settled`: the round's workbook
      // step writes the office's file from this list, and the workbook may
      // still be missing a date the matrix already has.
      settled.push({ person: matrixRow[0], code, value: expiry });
      if (isDate(cell) && normDate(cell) === expiry) {
        agree++;
        continue;
      }
      items.push({
        ...base,
        kind: isDate(cell) ? "expiry-mismatch" : "missing-on-sheet",
        proposed: expiry,
        detail: isDate(cell)
          ? `The certificate ${typed ? "is filed as expiring" : "expires"} ${dmy(expiry)}. The spreadsheet says ${cellReads(cell)}.`
          : `A certificate is on file, ${typed ? "filed as expiring" : "expiring"} ${dmy(expiry)}, and the spreadsheet has ${cellReads(cell)}.`,
      });
      continue;
    }

    if (reading.neverExpires) {
      if (isHeld(cell)) {
        settled.push({ person: matrixRow[0], code, value: "Y" });
        agree++;
        continue;
      }
      if (isDate(cell)) {
        notes.push({
          kind: "date-without-expiry",
          person: matrixRow[0],
          detail: `${code} is dated ${dmy(normDate(cell))} on the spreadsheet, but the certificate on file carries no expiry.`,
          certificate: { id: row.id, filename: row.filename, url: link.url },
        });
        continue;
      }
      settled.push({ person: matrixRow[0], code, value: "Y" });
      items.push({
        ...base,
        kind: "held-not-recorded",
        proposed: "Y",
        detail: `The certificate on file carries no expiry, so it reads as held. The spreadsheet says ${cellReads(cell)}.`,
      });
      continue;
    }

    // No expiry is printed on the certificate, but the validity periods matrix
    // may still settle the question: an item that runs a fixed period expires
    // that long after it was issued, and an item that never lapses reads as
    // held. Only an issue date actually read off the document is worked from —
    // a period with nothing to add it to decides nothing.
    const period = validity
      ? validity.byCode.get(code.toUpperCase()) || validity.byTitle.get(words(title).join(" "))
      : null;

    if (period && period.neverExpires) {
      if (isHeld(cell)) {
        settled.push({ person: matrixRow[0], code, value: "Y" });
        agree++;
        continue;
      }
      if (isDate(cell)) {
        notes.push({
          kind: "date-without-expiry",
          person: matrixRow[0],
          detail: `${code} is dated ${dmy(normDate(cell))} on the spreadsheet, but the validity periods matrix says it doesn't lapse.`,
          certificate: { id: row.id, filename: row.filename, url: link.url },
        });
        continue;
      }
      derived++;
      settled.push({ person: matrixRow[0], code, value: "Y" });
      items.push({
        ...base,
        kind: "held-not-recorded",
        proposed: "Y",
        detail: `A certificate is on file and the validity periods matrix says ${code} doesn't lapse, so it reads as held. The spreadsheet says ${cellReads(cell)}.`,
      });
      continue;
    }

    // An item that states its own expiry (the AMSA medical) never has one
    // worked out for it — the printed date is the only authority.
    if (period && period.months && reading.issuedOn && !certStatesOwnExpiry(code)) {
      const worked = addMonths(reading.issuedOn, period.months);
      settled.push({ person: matrixRow[0], code, value: worked });
      if (isDate(cell) && normDate(cell) === worked) {
        agree++;
        continue;
      }
      derived++;
      items.push({
        ...base,
        kind: isDate(cell) ? "expiry-mismatch" : "missing-on-sheet",
        proposed: worked,
        certificate: { ...link, expires: worked },
        detail: `No expiry is printed on the certificate. It was issued ${dmy(reading.issuedOn)} and the validity periods matrix gives ${code} ${period.months} months, so it runs to ${dmy(worked)}. The spreadsheet says ${cellReads(cell)}.`,
      });
      continue;
    }

    // A certificate read with no expiry and no statement that it never expires
    // is a reading that came up short, not evidence about the spreadsheet.
    notes.push({
      kind: "no-date-read",
      person: matrixRow[0],
      detail: `No expiry could be read off this certificate, so ${code} was left as the spreadsheet has it (${cellReads(cell)}).`,
      certificate: { id: row.id, filename: row.filename, url: link.url },
    });
  }

  /* The certificates a cover displaced. They hold no cell any more, so the
     loop above never reached them - but their own rows still have to record
     what each one is, or after one of them is deleted nothing could say which
     cell it had been holding up. */
  for (const { row, reading, code } of displaced) {
    const typed = isDate(row.expiresOn) ? normDate(row.expiresOn!) : null;
    const note = {
      id: row.id,
      code,
      expires: (neverLapses(code) ? null : typed || reading.expiresOn) || null,
      issued: reading.issuedOn || null,
      issuer: reading.issuer || null,
      title: reading.certificateTitle || null,
    };
    const same = (row.readCode ?? null) === note.code && (row.readExpires ?? null) === note.expires
      && (row.readIssued ?? null) === note.issued && (row.readIssuer ?? null) === note.issuer
      && (row.readTitle ?? null) === note.title;
    if (!same && !noted.some((n) => n.id === row.id)) noted.push(note);
  }

  // The other spreadsheet: the crew certificates workbook filed on the portal.
  // Where it disagrees with the matrix and no certificate settles the question,
  // that is a disagreement between two spreadsheets and worth putting up.
  let sheetTotal = 0;
  let sheetShown = 0;
  if (sheet && Array.isArray(sheet.rows)) {
    for (const incoming of sheet.rows) {
      const at = rowAt.get((incoming.name || "").trim().toUpperCase());
      if (at === undefined) {
        notes.push({
          kind: "sheet-name",
          person: incoming.name || null,
          detail: `${incoming.name} is in the filed spreadsheet but not on the matrix.`,
        });
        continue;
      }
      const matrixRow = matrix.rows[at];
      (incoming.vals || []).forEach((value, col) => {
        if (value == null || !cols[col]) return;
        const v = String(value).trim();
        const cell = (matrixRow[3][col] || "").trim();
        if (v === cell) return;
        // Blank in the filed sheet says nothing; a person is not required to
        // hold everything, and an empty cell is not a claim that they don't.
        if (v === "") return;
        if (covered.has(`${at}:${col}`)) return;
        // A date in the filed spreadsheet against an item that carries no expiry
        // is not something to copy onto the matrix — the item is held or it
        // isn't. The date is said rather than proposed.
        if (isDate(v) && neverLapses(cols[col][0])) {
          notes.push({
            kind: "date-without-expiry",
            person: matrixRow[0],
            detail: `The filed spreadsheet dates ${cols[col][0]} ${dmy(normDate(v))}, but ${cols[col][0]} carries no expiry, so the matrix is left as it has it (${cellReads(cell)}).`,
          });
          return;
        }
        sheetTotal++;
        if (sheetShown >= SHEET_ITEM_CAP) return;
        sheetShown++;
        items.push({
          id: `sheet:${at}:${col}`,
          kind: "sheet-vs-matrix",
          person: matrixRow[0],
          code: cols[col][0],
          title: cols[col][1],
          group: cols[col][2],
          sheetValue: cell,
          proposed: v,
          detail: `The filed spreadsheet says ${cellReads(v)}. The matrix says ${cellReads(cell)}.`,
          source: "spreadsheet",
        });
      });
    }
  }

  // Dated items with nothing scanned behind them. Counted, not listed: there
  // are thousands of cells and a list of them would bury everything above.
  let uncertified = 0;
  matrix.rows.forEach((r, at) => {
    (r[3] || []).forEach((v, col) => {
      if (isDate(v) && !covered.has(`${at}:${col}`)) uncertified++;
    });
  });

  // Cells this comparison once filled under the model's guess, taken back now
  // the equivalence page homes those certificates somewhere else: only where
  // nothing else claims the column, the person's own tagging doesn't, and the
  // cell still carries exactly the date that certificate put there - a figure
  // the office wrote itself is never touched.
  for (const r of rehomed) {
    if (!r.person || !r.expiry) continue;
    const personKey = as(r.person).trim().toUpperCase();
    if (claim.has(`${personKey}::${r.old}`)) continue;
    const at = rowAt.get(personKey);
    const col = colAt.get(r.old);
    if (at === undefined || col === undefined) continue;
    if (covered.has(`${at}:${col}`)) continue;
    const matrixRow = matrix.rows[at];
    const cell = String((matrixRow[3] && matrixRow[3][col]) || "").trim();
    if (cell !== r.expiry) continue;
    covered.add(`${at}:${col}`);
    settled.push({ person: matrixRow[0], code: r.old, value: "", clear: true });
  }

  const read = readings.filter((r) => r.reading).length;

  /* Written down before the answer goes back.
   *
   * One statement per certificate, batched: D1 has no interactive transaction,
   * and a thousand round trips would take longer than the reading did. A
   * failure here is worth saying and not worth losing the comparison over -
   * the answer on the screen is right either way, and the next run writes the
   * same rows again. */
  if (noted.length) {
    try {
      const at = Math.floor(Date.now() / 1000);
      const db = getEnv().DB;
      const size = 80;
      for (let i = 0; i < noted.length; i += size) {
        await db.batch(
          noted.slice(i, i + size).map((n) =>
            db
              .prepare(
                `UPDATE documents
                    SET read_code = ?2, read_expires = ?3, read_issued = ?4,
                        read_issuer = ?5, read_title = ?6, read_at = ?7
                  WHERE id = ?1`,
              )
              .bind(n.id, n.code, n.expires, n.issued, n.issuer, n.title, at),
          ),
        );
      }
    } catch (e) {
      // The books stay as they were; the comparison still answers.
    }
  }

  return {
    at: new Date().toISOString(),
    model: MODEL,
    items,
    notes,
    settled,
    /* Every cell a certificate on file still stands behind, person and code.
       The portal keeps its own note of which cells it filled from a
       certificate; holding that against this list is how it learns that a
       certificate has been deleted and the date it put there has nothing left
       under it. Said outright rather than inferred from the settled list,
       because a cell the certificates agree with settles nothing and would
       otherwise read as abandoned. */
    claimed: [...claim.keys()],
    noted: noted.length,
    summary: {
      certificates: certs.length,
      read,
      unread: certs.length - read,
      compared: claim.size,
      agree,
      discrepancies: items.length,
      fromCertificates: items.filter((i) => i.source === "certificate").length,
      fromSheet: sheetShown,
      sheetTotal,
      sheetCapped: Math.max(0, sheetTotal - sheetShown),
      uncertified,
      sheetFilename: sheet?.filename || null,
      // The validity periods matrix the expiry dates were worked against, where
      // one was filed and read, and how many items it settled on its own.
      validitySheet: validity ? validity.filename : null,
      derived,
    },
    ...(opts.withParticulars ? { particulars: particularsInput(certs, held, eqTable, cols) } : {}),
  };
}

/** What the particulars rule reads: every certificate on the books with
 *  the column it answers to - worked out the way the comparison works it
 *  out (codeFor) - and the readings by key. */
export type ParticularsInput = {
  rows: { person: string | null; code: string | null; key: string; filedOn: string | null }[];
  readings: Map<string, Reading>;
};

function particularsInput(certs: Row[], held: Map<string, Reading>, eqTable: Awaited<ReturnType<typeof equivalences>>, cols: unknown): ParticularsInput {
  const rows = certs.map((row) => {
    const key = readingKey(row);
    return { person: row.person, code: codeFor(row, held.get(key) || null, eqTable, cols), key, filedOn: row.filedOn ? String(row.filedOn) : null };
  });
  return { rows, readings: held };
}

// ---------------------------------------------------------------------------
// Topping up readings made before the keys they are missing were asked for
// ---------------------------------------------------------------------------

/** How many certificates one man's date of birth may be looked for on. */
const DOB_TRIES = 3;
/** How many certificates are read at once. */
const TOP_UP_AT_ONCE = 4;

/** The near-coastal cards, found by the "NC" in their titles on the vessel
 *  file rather than by a list written here. Their printed conditions matter:
 *  a colour-vision-deficient deck holder's card says daylight only
 *  (MO505 s 13(d)-(e)), and the card must print its conditions (s 12(1)). */
function nearCoastalCards(cols: string[][]): string[] {
  return (Array.isArray(cols) ? cols : [])
    .filter((c) => Array.isArray(c) && /\bNC\b/.test(String(c[1] || "")))
    .map((c) => String(c[0]).trim().toUpperCase());
}

/**
 * What a second look at a certificate adds to the reading already held:
 * only the keys the held reading has not got.
 *
 * Nothing that is already there is touched, so a second look can never move
 * a date, a code or a number the matrix is standing on - and a certificate
 * read again for one key (its endorsements, say) does not have another key's
 * answer overwritten by a scan the model made less of this time.
 *
 * `particulars` is set where this look was asked for the MSIC number or the
 * date of birth. Those two are then written whether or not they were there:
 * the pass asks about a card whose first look could not read the name, whose
 * number therefore went down as null, and the whole point of paying for that
 * look is the number this one can read.
 *
 * `gives` is false where the second look found the document in another man's
 * name: then every key goes in empty. It is not his document, nothing of it
 * is written down, and the empty keys mean it is never paid for again.
 */
function keysAdded(again: Reading, held: Reading, gives: boolean, particulars: boolean): Partial<Reading> {
  const out: Record<string, unknown> = {};
  const put = (key: keyof Reading, value: unknown, none: unknown, always = false) => {
    if (always || !(key in held)) out[key] = gives ? value : none;
  };
  put("documentNumber", again.documentNumber ?? null, null, particulars);
  put("holderBirthDate", again.holderBirthDate ?? null, null, particulars);
  put("endorsements", again.endorsements ?? [], []);
  put("units", again.units ?? [], []);
  put("capacities", again.capacities ?? [], []);
  put("isRecognition", again.isRecognition === true, false);
  put("recognises", again.recognises ?? null, null);
  put("assessedOn", again.assessedOn ?? null, null);
  put("conditions", again.conditions ?? null, null);
  put("evidenceKind", again.evidenceKind ?? null, null);
  return out as Partial<Reading>;
}

/** The names the slash in three column titles once cut a certificate's
 *  filename down to ("2.pdf", "2 (2).pdf", "5).pdf"), before 6147318. */
const ONCE_MISNAMED = /^\d+( \(\d+\))?\.pdf$|^\d\)\.pdf$/;

/**
 * What a second look adds for the columns and the holder, where the reading
 * held was made before the question asked for them: every column the
 * reader gives and whose it is. Nothing the first look read is moved - not
 * its date and not its one code (qualCode, which the MSIC card rule still
 * reads): the columns are what place the document from now on (columnsFor).
 *
 * So a column the first look placed the document in is never lost to the
 * second look quietly: where the second leaves it out or calls it a guess,
 * it is kept as "medium" - still filled, and on Needs attention for a look,
 * since the two looks disagree. A second look that finds the document is a
 * register page is the exception: a register page counts only for the
 * register columns (columnsFor), so what the first look placed it in
 * elsewhere, and the column it is filed for, go. A second look that could
 * not read the scan adds none of it - the first reading stands, placed as
 * it always was - and leaves the mark, so it is not paid for again.
 */
function columnsAdded(again: Reading, held: Reading): Partial<Reading> {
  if ("columns" in held) return {};
  if (again.registerPage === true) {
    return { registerPage: true, columns: again.readable && Array.isArray(again.columns) ? again.columns : [], holder: again.holder ?? null };
  }
  if (!again.readable || !Array.isArray(again.columns)) return { columnsAsked: true };
  let columns = again.columns;
  const first = held.qualCode && (held.codeConfidence === "high" || held.codeConfidence === "medium") ? held.qualCode.trim() : "";
  if (first) {
    const same = (c: { code: string }) => c.code.trim().toUpperCase() === first.toUpperCase();
    const now = columns.find(same);
    if (!now || now.confidence === "low") {
      columns = [...columns.filter((c) => !same(c)), { code: first, confidence: "medium", why: "read so the first time" }];
    }
  }
  return {
    columns,
    registerPage: false,
    holder: again.holder ?? null,
  };
}

/**
 * The readings made before the question asked what it asks now, topped up -
 * a few an hour, never the whole crew read again (that is $15-25 of
 * Matthew's credit, and READING_VERSION is left alone for exactly that
 * reason).
 *
 * For each man on the register whose box is empty or still the
 * certificates' own (openToCertificates), read the way the rule itself
 * reads (particularsFor), so what is paid for is what the rule will use:
 *  - MSIC: the rule takes the number off the newest card printed in his
 *    name, so the newest card in his name whose reading has no
 *    documentNumber key is read again for it. A card the first look could
 *    not put a name to gives the rule nothing while it stands: where it is
 *    his newest card it is looked at once, first, so its name is known
 *    (particularsAsked is the mark) - his, and it is the card he holds
 *    now; another man's, and the named card is read next.
 *  - Date of birth: while the rule gives none - no date, a date it throws
 *    out (an issue date read as the birth date), or two that tie - his
 *    certificates of competency and proficiency (the vessel file's
 *    Qualification columns) newest first, then his medical, until the
 *    rule's answer moves: those whose reading has no holderBirthDate key,
 *    and at most DOB_TRIES re-reads in all, counted by the mark each one
 *    leaves (particularsAsked). A ticket uploaded since carries the key,
 *    null where it prints no date, and is neither re-read nor counted: it
 *    does not stand in for the medical that does print one.
 * A re-read reading carries both keys, so it is never read again: that is
 * all the memory there is, and no other store. Only readable certificates
 * not in another man's name are asked about - one in another man's name
 * could give him nothing.
 *
 * Then the keys that came after those two, on the certificates that can
 * answer for them - one look each, because the one question asks for all of
 * them at once, and only where the key would change what the portal can say:
 *  - endorsements and units: a certificate of competency or proficiency (the
 *    vessel file's tickets), or a training statement's column (a title with
 *    a unit code in it). Those are what can cover another column
 *    (source/shared/covers.js).
 *  - a recognition and the foreign certificate behind it: a document whose
 *    title carries the word recognition.
 *  - the assessment's own date and the printed conditions: the medical
 *    (certStated) and the near-coastal cards, which are the documents the
 *    law has those two on (MO76 s 16(1); MO505 s 12(1), s 13(d)-(e)).
 *  - the alternative evidence: no certificate is read for it on its own - it
 *    rides along with whatever is being read for another key.
 * A certificate a man's particulars already claim this hour is not read
 * twice: one look writes every key it is missing.
 *
 * What a re-read gives is added to the reading already held - the keys it
 * has not got, the mark, and the holder's name where the first look had none
 * and the second found his - and nothing else, so a second look can never
 * move a date or a code on the matrix, nor the certificate to another man
 * (the refile goes by the printed name). A second look that finds another
 * man's name gives nothing: the keys go in empty, so it is not asked again.
 * A second look that could not read the scan leaves the first reading
 * standing, with the keys empty.
 *
 * Stops on the first answer about the model's account, as the reading
 * does, and stores nothing for it. Never more than `cap` reads, and none
 * started once `timeLeft` says no.
 */
export async function topUpParticulars(
  codes: [string, string][],
  opts: { cap: number; timeLeft: () => boolean },
): Promise<{ read: number; stopped: ReadStopped; failed: number }> {
  const out: { read: number; stopped: ReadStopped; failed: number } = { read: 0, stopped: null, failed: 0 };
  const cur = await readDocument();
  const people = (Array.isArray(cur?.doc.people) ? cur!.doc.people : []) as { id?: unknown; name?: string; msic?: unknown; dob?: unknown }[];
  if (!people.length || opts.cap <= 0) return out;
  const fromCert = (cur!.doc.particularsFromCert || {}) as Record<string, { msic?: string; dob?: string }>;
  const register = crewRegister(people);
  // The live matrix's columns: a document is placed here as the round
  // places it, the filename's column included (codeFor).
  const liveCols = (cur!.doc.quals as { cols?: unknown } | null | undefined)?.cols;
  const cols = Array.isArray(liveCols) ? liveCols : [];
  const msic = msicCodeIn(vessel.qualColumns);
  const medical = new Set(Object.keys(vessel.certStated).map((c) => c.trim().toUpperCase()));
  const ticketCodes = new Set(ticketCodesIn(vessel.qualColumns));
  /* Which certificates can answer for the keys that came after the
     particulars. The tickets are the vessel file's own list of the
     certificates of competency and proficiency - the documents AMSA prints
     endorsements on (MO70 s 8, s 34(1)); the training statements are the
     columns whose titles carry a unit code; the cards are the near-coastal
     ones, which print their conditions. */
  const endorsedKinds = new Set(Object.keys(vessel.tickets).map((c) => c.trim().toUpperCase()));
  /* The columns filled off a printed unit code: the titles carrying one,
     and the columns the vessel file reads a licence class into (a high
     risk work licence's DG and CV) - so the seventeen licences on file are
     looked at once for the classes they print. */
  const unitKinds = new Set([
    ...unitColumnsIn(vessel.qualColumns),
    ...vessel.covers.filter((c) => c.from === "units").map((c) => c.code.trim().toUpperCase()),
  ]);
  /* A high risk work licence prints several classes and is rightly named
     for no column at all, so it is known by its title too: twelve of the
     seventeen have no code for the columns above to find them by. */
  const isLicence = (r: Reading) => /high[\s-]*risk\s+work/i.test(String(r.certificateTitle || ""));
  const ncCards = new Set(nearCoastalCards(vessel.qualColumns));

  const certs = await liveCertificates();
  const held = await allReadings();
  const eqTable = await equivalences();
  const store = readingStore();

  // `at` is the certificate's place in the listing, newest upload first.
  type Cert = { row: Row; reading: Reading; code: string; at: number };
  const newestFirst = (a: Cert, b: Cert) =>
    String(b.reading.expiresOn || "").localeCompare(String(a.reading.expiresOn || ""))
    || String(b.reading.issuedOn || "").localeCompare(String(a.reading.issuedOn || ""))
    || String(b.row.filedOn || "").localeCompare(String(a.row.filedOn || ""))
    || a.at - b.at;

  /** Whether a certificate could answer for a key its reading has not got -
   *  the endorsements and units a ticket or a training statement prints, the
   *  recognition keys where the title carries the word, the examination date
   *  and conditions a medical or a near-coastal card prints. Only those, so
   *  nothing is paid for a document that was never going to say it. */
  const wantsMore = (c: Cert) => {
    const r = c.reading;
    const covers = (endorsedKinds.has(c.code) || unitKinds.has(c.code) || isLicence(r)) && !("endorsements" in r);
    /* The capacities came after the endorsements: a ticket read for its
       endorsements before they were asked for is looked at once more. Only
       a ticket - a certificate of competency is what prints a capacity. */
    const capacities = endorsedKinds.has(c.code) && !("capacities" in r);
    const recognition = !("isRecognition" in r) && /\brecognition\b/i.test(String(r.certificateTitle || ""));
    const conditions = (medical.has(c.code) || ncCards.has(c.code)) && !("assessedOn" in r);
    return covers || capacities || recognition || conditions;
  };

  // What the rule finds for him off the readings as they stand: `held` is
  // brought up to date as this pass tops readings up, so the same question
  // asked after each read says whether the read gave the rule its answer.
  const today = todayThere();
  const ruleRows = particularsInput(certs, held, eqTable, cols).rows;
  const found = (me: string, field: "msic" | "dob") => particularsFor(me, ruleRows, held, register, today, msic)[field];
  // Newest first, as the rule ranks cards.
  const cardsInOrder = (list: Cert[]) => {
    const out: Cert[] = [];
    let rest = list;
    while (rest.length) {
      const next = newestCard(rest)!;
      out.push(next);
      rest = rest.filter((c) => c !== next);
    }
    return out;
  };

  /* The jobs: a list of certificates read in turn, with the man they are
     for, so what a second look reads is held against him. A man's
     particulars are a list read until the rule's answer moves (`wants`);
     a certificate read for the keys that came after them is a list of one,
     with nothing to wait for. The particulars are pushed first, so the
     hour's cap is theirs before the back-fill's. */
  const jobs: { me: string | null; certs: Cert[]; wants: "msic" | "dob" | null }[] = [];
  const asked = new Set<string>();
  /** Every certificate that could answer for a key it has not got, with the
   *  man it is filed under, gathered as each man's are worked out. */
  const missing: { me: string; cert: Cert }[] = [];
  for (const p of people) {
    const me = p && p.name ? register.nameOf(p.name) : null;
    if (!me || !particularsKeyOf(p)) continue;
    const mine: Cert[] = [];
    certs.forEach((row, at) => {
      if (!row.person || register.nameOf(row.person) !== me) return;
      const reading = held.get(readingKey(row));
      if (!reading || reading.readable === false) return;
      if (reading.holderName && register.nameOf(reading.holderName) !== me) return;
      mine.push({ row, reading, code: String(codeFor(row, reading, eqTable, cols) || "").trim().toUpperCase(), at });
    });
    const fresh = (list: Cert[]) => list.filter((c) => !asked.has(readingKey(c.row)));
    if (msic && openToCertificates(p, "msic", fromCert)) {
      const cards = mine.filter((c) => c.code === msic && isMsicCard(c.reading, msic));
      // The rule reads only cards printed in his name: of those, the newest
      // without the number key is read again for it.
      const named = newestCard(cards.filter((c) => c.reading.holderName && !("documentNumber" in c.reading)));
      /* Unless a card that already carries a number is newer still: the rule
         reads the newest card in his name, so that card is already its
         answer and a look at the older one could only be paid for and thrown
         away. (The box can be empty and the answer be there all the same -
         the round fills the boxes after this pass, not before it.) */
      const have = newestCard(cards.filter((c) => c.reading.holderName && msicAsWritten(c.reading.documentNumber)));
      const answered = !!have && !!named && newestCard([have, named]) === have;
      // His newest card, where the first look could not name it and no
      // second look has been paid for: looked at once so its name is known.
      const top = newestCard(cards);
      const nameless = top && !top.reading.holderName && !top.reading.particularsAsked ? top : null;
      const list = fresh(cardsInOrder([nameless, answered ? null : named].filter((c): c is Cert => !!c)));
      if (list.length) {
        jobs.push({ me, certs: list, wants: "msic" });
        list.forEach((c) => asked.add(readingKey(c.row)));
      }
    }
    // Looked for only while the rule gives no date - none read, one it
    // throws out, or two that tie - on the ones not yet asked, and only
    // while this pass has asked fewer than DOB_TRIES of them: the mark is
    // the count, so a ticket uploaded since, which carries the key and
    // prints no date, never ends the search.
    const tickets = mine.filter((c) => ticketCodes.has(c.code) && !medical.has(c.code)).sort(newestFirst);
    const medicals = mine.filter((c) => medical.has(c.code)).sort(newestFirst);
    const candidates = [...tickets, ...medicals];
    const tried = candidates.filter((c) => c.reading.particularsAsked).length;
    if (openToCertificates(p, "dob", fromCert) && found(me, "dob") == null && tried < DOB_TRIES) {
      const list = fresh(candidates.filter((c) => !("holderBirthDate" in c.reading))).slice(0, DOB_TRIES - tried);
      if (list.length) {
        jobs.push({ me, certs: list, wants: "dob" });
        list.forEach((c) => asked.add(readingKey(c.row)));
      }
    }
    /* And his certificates whose reading was made before the rest of the
       question was asked. Only the documents that can answer for the key,
       so nothing is paid for a card that was never going to say it. */
    mine.forEach((c) => { if (wantsMore(c)) missing.push({ me, cert: c }); });
  }

  /* And the certificates no folder places. A scan parked under a name the
     register does not know - a loose one under "Other", or a folder wording
     no alias covers - is in nobody's list above, so its reading would stay
     as it was made for good and the covers, recognition and conditions rules
     would go on saying nothing about it. Where the document's own name is a
     man the register DOES know, it gets the same one look, under him, inside
     the same cap. Nothing is moved and no date is touched: this pass only
     adds the keys a reading is missing. */
  for (const [at, row] of certs.entries()) {
    if (row.person && register.nameOf(row.person)) continue;
    const reading = held.get(readingKey(row));
    if (!reading || reading.readable === false) continue;
    const me = reading.holderName ? register.nameOf(reading.holderName) : null;
    if (!me) continue;
    const cert: Cert = { row, reading, code: String(codeFor(row, reading, eqTable, cols) || "").trim().toUpperCase(), at };
    if (wantsMore(cert)) missing.push({ me, cert });
  }
  /* The readings made before the question asked for every column and whose
     a certificate is off the register (columns, holder): every readable one,
     whoever it is filed under - a loose scan is exactly what the pick is for -
     looked at once, after the particulars and before the back-fill below,
     which a look for these fills as well. In order: the files the slash bug
     once cut to "2.pdf" that still have no code (they keep that name until
     a reading names a column), then the readings with no code at all, then
     those whose filed column the reading disagrees with, then the rest. */
  const smart: { cert: Cert; tier: number }[] = [];
  for (const [at, row] of certs.entries()) {
    const reading = held.get(readingKey(row));
    if (!reading || reading.readable === false || "columns" in reading || reading.columnsAsked) continue;
    /* A row tagged by hand is placed by the tag alone, whatever the reader
       says of its columns; only whose it is could still matter, and only
       where the printed name does not fit the man it is filed under. So a
       tagged certificate in its own man's name is not paid for. */
    if (row.qualCode && !nameIsSomebodyElse(reading.holderName, row.person, register.nameOf(row.person || ""))) continue;
    const code = codeFor(row, reading, eqTable, cols);
    const sure = !!reading.qualCode && reading.codeConfidence !== "low";
    const tier = !code && ONCE_MISNAMED.test(row.filename) ? 0
      : !sure ? 1
      : filedAsFor(row, reading, eqTable, cols) ? 2 : 3;
    smart.push({ cert: { row, reading, code: String(code || "").trim().toUpperCase(), at }, tier });
  }
  smart.sort((a, b) => a.tier - b.tier || a.cert.at - b.cert.at);
  for (const { cert } of smart) {
    const key = readingKey(cert.row);
    if (asked.has(key)) continue;
    asked.add(key);
    jobs.push({ me: null, certs: [cert], wants: null });
  }

  // One look per certificate, whatever it is missing: the question asks for
  // every key at once, so a certificate a man's particulars already claim
  // this hour is not read a second time for these.
  for (const { me, cert } of missing) {
    const key = readingKey(cert.row);
    if (asked.has(key)) continue;
    asked.add(key);
    jobs.push({ me, certs: [cert], wants: null });
  }

  let left = opts.cap;
  // The question's context, once for the pass.
  const ask = await readingAsk();
  const readOne = async (c: Cert, me: string | null, particulars: boolean): Promise<Reading | "halt" | "skip"> => {
    if (out.stopped || !opts.timeLeft()) return "halt";
    let again: Reading;
    try {
      again = await readCertificate(c.row, codes, ask);
    } catch (e) {
      // The account, not the scan: nothing stored, and nothing more asked
      // this hour. Anything else costs this one certificate its turn.
      if (e instanceof ModelRefusal && e.kind !== "document" && e.kind !== "other") {
        if (!out.stopped) out.stopped = { kind: e.kind, line: plainLine(e) };
        return "halt";
      }
      out.failed++;
      console.error("a certificate was not read again for the keys it is missing:", c.row.filename, e);
      /* A look for the columns and the holder that fails on the scan's own
         account (an answer that would not parse, a fault the model gave no
         reason for) is tried once more on a later hour, and then marked as
         asked: otherwise the same certificate sits at the front of the queue
         and is paid for every hour for ever. */
      if (me === null) {
        const tried: Reading = { ...c.reading, ...(c.reading.columnsTried ? { columnsAsked: true } : { columnsTried: true }) };
        await store.setJSON(readingKey(c.row), tried).catch((err: unknown) =>
          console.error("a failed look was not marked:", c.row.filename, err));
      }
      return "skip";
    }
    // The second look is held against the man it was asked for: the first
    // look may have named nobody, and a card in his folder can be another
    // man's. Another man's name gives him nothing, and is not kept either -
    // the refile would move the certificate on it, and this pass moves
    // nothing. His own name is kept where the first look had none, so the
    // rule, which takes nothing from a certificate naming nobody, can use it.
    /* A look for the columns and the holder (`me` null) is held against
       nobody: what the document is for and whose it is are the very
       questions, and the refile and the round weigh the answer
       (whoseCertificate). */
    const holder = again.readable ? again.holderName ?? null : null;
    const his = !!holder && (me === null || register.nameOf(holder) === me);
    const gives = again.readable && (!holder || his);
    const topped: Reading = {
      ...c.reading,
      holderName: c.reading.holderName ?? (his ? holder : null),
      ...keysAdded(again, c.reading, gives, particulars),
      ...columnsAdded(again, c.reading),
      ...(me === null ? {} : { particularsAsked: true }),
    };
    try {
      await store.setJSON(readingKey(c.row), topped);
    } catch (e) {
      // Paid for and not kept: this certificate loses its turn and the
      // others go on - one store fault must not end the pass while the
      // rest are still reading.
      out.failed++;
      console.error("a certificate read again was not kept:", c.row.filename, e);
      return "skip";
    }
    out.read++;
    return topped;
  };
  // A man's list is started only with room for all of it, so the cap never
  // cuts his date of birth short after one certificate that printed none.
  const runJob = async (job: (typeof jobs)[number]) => {
    if (left < job.certs.length) return;
    left -= job.certs.length;
    let used = 0;
    const wants = job.wants;
    const me = job.me;
    const before = wants && me ? found(me, wants) : null;
    for (const c of job.certs) {
      const r = await readOne(c, job.me, !!wants);
      if (r === "halt") break;
      used++;
      if (r === "skip") continue;
      held.set(readingKey(c.row), r);
      // The rule's answer moved on this read: the rest of his list is not
      // needed. Only the rule's own answer counts - a date it throws out,
      // or one that only ties with another, leaves the search going. A
      // certificate read for the keys it is missing has nothing to wait for.
      if (wants && me && found(me, wants) !== before) break;
    }
    left += job.certs.length - used;
  };
  let next = 0;
  await Promise.all(Array.from({ length: TOP_UP_AT_ONCE }, async () => {
    while (next < jobs.length && !out.stopped && opts.timeLeft()) await runJob(jobs[next++]);
  }));
  return out;
}

/**
 * The dates the certificates on file actually carry, per person and matrix code,
 * for the date columns on the certification screens.
 *
 * The working out is in `lib/analysis.ts` — cached readings only, no AI and no
 * writes — because the AI Checker is shown the same standing when it is asked
 * about somebody's certificates.
 */
async function certificateDates() {
  return Response.json(await certificateStanding());
}

// ---------------------------------------------------------------------------
// The training matrix and the skills matrix
// ---------------------------------------------------------------------------

/**
 * Reading the matrices the portal holds about the crew as a whole, and holding
 * them against one another.
 *
 * The skills matrix is the rulebook: what the crew are required to hold, how the
 * items have to be spread across the shifts, and whatever else has to be abided
 * by. The validity periods matrix is its companion — how long each item lasts
 * once it has been done, and when it has to be done again. The training matrix is
 * where the crew stand today. None of them says anything much on its own — the
 * point is the set of them together, and that is what the check works out.
 *
 *   matrix-read       — start reading one of the documents, and hand back the
 *                        job to ask after (or the reading itself straight away
 *                        where it was already made and `force` wasn't set)
 *   matrix-read-job    — how that reading is getting on, and its answer once
 *                        it has one
 *   matrix-check       — start holding the training status against the
 *                        requirements, and hand back the job to ask after (or
 *                        the check itself straight away where one is already
 *                        held for these exact documents)
 *   matrix-check-job   — how that check is getting on, and its answer once it
 *                        has one
 *   matrix-reset       — forget every reading and the check
 *
 * The two matrices are required at all times and nothing runs without them. The
 * validity periods matrix is not: with none filed the check is what it always
 * was, and with one filed the periods it gives are what "due" is measured
 * against.
 *
 * Like the OPMS comparison and the shift allocation check, none of the actual
 * reading or comparing happens here. Each is one long question to the model — a
 * whole workbook read sheet by sheet, or three of them held against each other
 * — and a request that waited for one was cut off by the platform at sixty
 * seconds and reached the portal as a bare 504 with nothing in it. So
 * `matrix-read` and `matrix-check` write down what was asked and hand the work
 * to the `matrix-read-run` and `matrix-check-run` background functions, which
 * have fifteen minutes, and the portal asks after the job until it is done. The
 * prompts, the reading and the checking themselves, and the job records are all
 * in `lib/matrix.ts` — a background function needs the same code the endpoint
 * does, and a serverless function file couldn't import another one.
 *
 * A workbook can't be looked at by a vision model, so the portal reads it in the
 * browser with SheetJS and sends the sheets as text. A PDF or a scan is sent as
 * the file itself. Nothing here writes to the portal: what the documents say goes
 * back, and it is the portal that decides what is shown.
 */

// MATRIX_DOCS and matrixDocuments() are imported from `lib/matrix.ts`, which is
// also where the version stamped into every reading and every check, the store
// they are kept in and the keys they are kept under all live — see
// `lib/analysis.ts` for those. Bump MATRIX_VERSION there when a prompt or a
// shape in `lib/matrix.ts` changes, and everything is read again rather than
// answered from a cache built to different rules.

// Both documents are required at all times, so nothing here runs against one of
// them alone — an answer built from half the picture reads as though it were the
// whole one.
function bothRequired(missing: string[]) {
  return Response.json(
    {
      error: `The ${missing.join(" and the ")} ${missing.length === 1 ? "is" : "are"} not on the portal. Both documents are required at all times, and the analysis is against the two of them together.`,
      missing,
    },
    { status: 409 },
  );
}

/** Forget both readings and the check, so the next run reads the documents again. */
async function resetMatrices() {
  const store = matrixStore();
  let cleared = 0;
  const { blobs } = await store.list();
  for (const blob of blobs) {
    await store.delete(blob.key);
    cleared++;
  }
  return Response.json({ cleared });
}

// ---------------------------------------------------------------------------
// The shift allocation guideline against the training matrix
// ---------------------------------------------------------------------------

/**
 * Holding the crew rostered onto a swing against the shift allocation guideline
 * the office sends.
 *
 *   shift-check  — start a run, and hand back the job to ask after
 *   shift-job    — how a run is getting on, and its answer once it has one
 *   shift-state  — whether a sheet is on file, and the answer already held
 *   shift-reset  — forget the held answers
 *
 * Like the OPMS comparison, none of the work happens here. The question — a
 * sheet, a swing's crew and every requirement on it — outlasts a request, and
 * a request that waited for it was cut off by the platform and reached the
 * portal as a bare 504 with nothing in it. So `shift-check` writes down what
 * was asked and hands it to the `shift-run` background function, which has
 * fifteen minutes, and the portal asks after the job until it is done. The
 * comparison itself, and the job record, are in `lib/shift.ts`.
 *
 * The one shortcut: an answer already held for this sheet and this exact crew
 * standing is handed straight back, with no job at all.
 */

/** What the page needs before it offers to run: the sheet on file, and any answer already held. */
async function shiftState() {
  const row = await shiftSheetRow();
  const held = row
    ? ((await shiftStore().get(shiftKeyFor(row.id), { type: "json" })) as Record<string, unknown> | null)
    : null;
  return Response.json({
    sheet: row ? { id: row.id, filename: row.filename, uploaded: row.filedOn } : null,
    analysis: held || null,
  });
}

// ---------------------------------------------------------------------------
// The OPMS export against the portal's own records
// ---------------------------------------------------------------------------

/**
 * Holding three accounts of the same crew against each other: the portal's own
 * skills matrix, the certificates scanned and filed against it, and the latest
 * spreadsheet exported from OPMS.
 *
 * OPMS is somebody else's system. When it disagrees with the portal, one of the
 * two is wrong, and which one it is decides who has to fix it — so the answer is
 * in two columns rather than one list. The certificates are what settles it: a
 * scan is the document itself, so whichever side disagrees with the scan is the
 * side with the mistake. Where no certificate covers the item, the disagreement
 * is put up unattributed rather than pinned on a guess.
 *
 *   opms-check  — start a run, and hand back the job to ask after
 *   opms-job    — how a run is getting on, and its answer once it has one
 *   opms-reset  — forget the held answers
 *
 * None of that work happens here. It is a single question to the model over a
 * whole crew and a whole workbook, and it takes minutes — far longer than the
 * sixty seconds a request is given before the platform cuts it off and the
 * portal is handed a 504 with nothing in it. So `opms-check` writes down what was
 * asked and hands it to the `opms-run` background function, which has fifteen
 * minutes, and the portal asks after the job until it is done. The comparison
 * itself, and the job record, are in `lib/opms.ts`.
 */

// Where the workers answer. A background function is called at the address every
// function has rather than a path of its own, so there is nothing to keep in step
// with a route. The portal is told these rather than having them written down twice.
const OPMS_WORKER_PATH = "/api/run/opms";
const SHIFT_WORKER_PATH = "/api/run/shift";
const MATRIX_READ_WORKER_PATH = "/api/run/matrix-read";
const MATRIX_CHECK_WORKER_PATH = "/api/run/matrix-check";

/**
 * Set the background worker going on a run that has been written down.
 *
 * A background function answers the moment it has the request and carries on
 * without it, so this waits for the handover and nothing else.
 *
 * The portal used to sit behind its host's password protection, and the password was
 * asked for at the edge — before a request reaches any function, and of every
 * request that arrives without an answer to it. This call is the portal's own
 * server calling itself, and a server has no browser and no cookie, so left as
 * it was it was turned away at the door with a 401 and the run it was meant to
 * start never began. What the admin's browser sent up with the request is
 * therefore sent back down with this one: the handover goes in under the answer
 * the admin has already given, rather than under none at all.
 *
 * Whether it was picked up is reported rather than thrown, because there is a
 * second way in when this one is refused and the caller knows about it.
 */
async function startWorker(_req: Request, _path: string, _jobId: string) {
  // On Cloudflare there is no background function to hand the job to, and a
  // worker fetching its own address is refused. Declining the handover here
  // makes every start response carry startPath, and the browser - which has
  // always known this second way in - starts the run itself and holds that
  // request open while it works.
  return false;
}

async function reset() {
  const store = readingStore();
  let cleared = 0;
  const { blobs } = await store.list();
  for (const blob of blobs) {
    await store.delete(blob.key);
    cleared++;
  }
  return Response.json({ cleared });
}

export default async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "The request couldn't be read." }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";

  if (action === "reset") return reset();

  if (action === "matrix-reset") return resetMatrices();

  if (action === "shift-reset") return Response.json({ cleared: await resetShiftAllocation() });

  // The shift allocation guideline against the crew rostered onto one swing.
  // The crew come up with the request — each with their standing on the training
  // matrix, which the page regenerates first — and the sheet is whatever is on
  // file.
  //
  // Nothing is compared in this call. The comparison is one long question to the
  // model and a request that waits for it is cut off by the platform partway —
  // which is exactly the 504 this used to hand back — so what happens here is
  // that the run is written down, the background worker is set going, and the
  // portal is handed the job to ask after with "shift-job". The one shortcut is
  // an answer already held for this sheet and this exact crew standing, which is
  // handed straight back with no job at all.
  if (action === "shift-check") {
    if (!body.crew || typeof body.crew !== "object") {
      return Response.json({ error: "The rostered crew and their matrix standing weren't included." }, { status: 400 });
    }
    const text = typeof body.text === "string" ? body.text : null;
    try {
      // Asked before the run is started rather than left to the worker: a sheet
      // that isn't on the portal is the one failure an admin can fix on the
      // spot, and it should be said now rather than a poll later.
      const { row, held } = await heldShiftAnswer(body.crew);
      if (!row) {
        return Response.json({ error: NO_SHIFT_SHEET, missing: ["shift allocation sheet"] }, { status: 409 });
      }
      if (held && body.force !== true) {
        return Response.json({ cached: true, ...held });
      }

      const job = await startShiftJob({ text, crew: body.crew, force: body.force === true });

      // Where the handover was refused — the password protection turning away a
      // call the server made to itself with no answer to give — the job is still
      // written down and good. It is the starting of it that has to happen from
      // the browser instead, which has an answer, so the portal is told where.
      const handedOver = await startWorker(req, SHIFT_WORKER_PATH, job.id);

      return Response.json(
        {
          pending: true,
          jobId: job.id,
          at: job.at,
          ...(handedOver ? {} : { startPath: SHIFT_WORKER_PATH }),
        },
        { status: 202 },
      );
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  // How a shift run is getting on. The portal asks for this until the answer is
  // there, so it says as little as possible: the state, and the answer once
  // there is one.
  if (action === "shift-job") {
    const jobId = typeof body.jobId === "string" ? body.jobId : "";
    if (!jobId) {
      return Response.json({ error: "Which comparison wasn't said." }, { status: 400 });
    }
    const job = await readShiftJob(jobId);
    if (!job) {
      return Response.json(
        { error: "That comparison is no longer on the server. Run it again." },
        { status: 404 },
      );
    }
    return Response.json(job);
  }

  if (action === "shift-state") {
    try {
      return await shiftState();
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  if (action === "opms-reset") return Response.json({ cleared: await resetOPMS() });

  // The OPMS export against our own matrix and our own certificates. The matrix
  // comes up with the request — it is the portal's live record rather than a file
  // on the server — and the certificate readings are already here.
  //
  // Nothing is compared in this call. The comparison takes minutes and a request
  // is cut off at sixty seconds, so what happens here is that the run is written
  // down, the background worker is set going, and the portal is handed the job to
  // ask after with "opms-job".
  if (action === "opms-check") {
    const cols = Array.isArray(body.cols) ? (body.cols as Matrix["cols"]) : [];
    const rows = Array.isArray(body.rows) ? (body.rows as Matrix["rows"]) : [];
    if (!cols.length || !rows.length) {
      return Response.json({ error: "The crew matrix wasn't included." }, { status: 400 });
    }

    const text = typeof body.text === "string" ? body.text : null;
    try {
      // Asked before the run is started rather than left to the worker: an
      // export that isn't on the portal is the one failure an admin can fix on
      // the spot, and it should be said now rather than a poll later.
      if (!(await opmsSheetRow())) {
        return Response.json({ error: NO_OPMS_SHEET, missing: ["OPMS spreadsheet"] }, { status: 409 });
      }

      const job = await startOpmsJob({ cols, rows, text, force: body.force === true });

      // Where the handover was refused — the password protection turning away a
      // call the server made to itself with no answer to give — the job is still
      // written down and good. It is the starting of it that has to happen from
      // the browser instead, which has an answer, so the portal is told where.
      // Only one of the two ever runs it: the worker takes the run apart as it
      // picks it up, and a second call would find nothing left to run.
      const handedOver = await startWorker(req, OPMS_WORKER_PATH, job.id);

      return Response.json(
        {
          pending: true,
          jobId: job.id,
          at: job.at,
          ...(handedOver ? {} : { startPath: OPMS_WORKER_PATH }),
        },
        { status: 202 },
      );
    } catch (e) {
      // The store and the database are both touched before the run is handed
      // over, and either failing would otherwise reach the portal as a bare 500
      // with nothing an admin could act on.
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  // How a run is getting on. The portal asks for this until the answer is there,
  // so it says as little as possible: the state, and the answer once there is one.
  if (action === "opms-job") {
    const jobId = typeof body.jobId === "string" ? body.jobId : "";
    if (!jobId) {
      return Response.json({ error: "Which comparison wasn't said." }, { status: 400 });
    }
    const job = await readOpmsJob(jobId);
    if (!job) {
      return Response.json(
        { error: "That comparison is no longer on the server. Run it again." },
        { status: 404 },
      );
    }
    return Response.json(job);
  }

  // The matrices the portal holds about the crew as a whole. Read one document,
  // then the next, then hold them against each other — a call apiece rather than
  // one, because a whole workbook through a model is not something one request
  // has time for.
  //
  // Nothing is read in this call. Reading a document is one long question to the
  // model and a request that waits for it is cut off by the platform partway —
  // exactly the 504 this used to hand back on a large workbook — so what happens
  // here is that the run is written down, the background worker is set going,
  // and the portal is handed the job to ask after with "matrix-read-job". The
  // one shortcut is a reading already made for this document, which is handed
  // straight back with no job at all.
  /* The expiry rules, handed over already read.
   *
   * These used to be got at by shipping the whole skills matrix to the model
   * and asking it to find them. The sheet holding them runs to ninety thousand
   * characters and the text was cut off at sixty, so the model never saw most
   * of the table and the portal ran with no rules at all - which is why a
   * certificate printing an issue date and no expiry could never be dated.
   *
   * The page reads them off the columns itself now, exactly, and puts them
   * here. Stored in the same shape and under the same key the model's answer
   * used, so everything that reads periods carries on reading them from one
   * place and nothing else had to change.
   */
  if (action === "validity-rules") {
    const listed = Array.isArray(body.periods) ? body.periods : null;
    if (!listed) {
      return Response.json({ error: "Send the periods that were read." }, { status: 400 });
    }
    const { validity } = await matrixDocuments();
    if (!validity) {
      return Response.json(
        { error: "No skills matrix is on the portal, so there are no rules to keep." },
        { status: 409 },
      );
    }
    const reading = {
      readable: true,
      at: new Date().toISOString(),
      by: "read from the sheet",
      periods: listed,
    };
    const held = { which: "validity", id: validity.id, filename: validity.filename, reading };
    await matrixStore().setJSON(matrixReadingKey("validity", validity.id), held);
    return Response.json({ ...held, kept: listed.length });
  }

  if (action === "matrix-read") {
    const which = typeof body.which === "string" ? body.which : "";
    if (!MATRIX_DOCS[which]) {
      return Response.json(
        { error: `Ask for "training", "skills" or "validity", not "${which}".` },
        { status: 400 },
      );
    }
    const text = typeof body.text === "string" ? body.text : null;
    const force = body.force === true;
    try {
      // Asked before the job starts: a document that isn't on the portal is the
      // one failure an admin can fix on the spot, and it should be said now
      // rather than a poll later.
      const doc = MATRIX_DOCS[which];
      const { training, skills, validity, missing } = await matrixDocuments();
      if (missing.length && which !== "validity") return bothRequired(missing);

      const row = which === "training" ? training! : which === "skills" ? skills! : validity;
      if (!row) {
        return Response.json(
          { error: `No ${doc.label} is on the portal, so there is nothing to read.`, missing: [doc.label] },
          { status: 409 },
        );
      }

      if (!force) {
        const already = (await matrixStore().get(matrixReadingKey(which, row.id), {
          type: "json",
        })) as MatrixReading | null;
        if (already) return Response.json({ ...already, which, cached: true });
      }

      const job = await startMatrixReadJob({ which, text, force });

      // Where the handover was refused — the password protection turning away a
      // call the server made to itself with no answer to give — the job is still
      // written down and good. It is the starting of it that has to happen from
      // the browser instead, which has an answer, so the portal is told where.
      const handedOver = await startWorker(req, MATRIX_READ_WORKER_PATH, job.id);

      return Response.json(
        {
          pending: true,
          jobId: job.id,
          at: job.at,
          which,
          ...(handedOver ? {} : { startPath: MATRIX_READ_WORKER_PATH }),
        },
        { status: 202 },
      );
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  // How a matrix reading is getting on. The portal asks for this until the
  // answer is there, so it says as little as possible: the state, and the
  // answer once there is one.
  if (action === "matrix-read-job") {
    const jobId = typeof body.jobId === "string" ? body.jobId : "";
    if (!jobId) {
      return Response.json({ error: "Which reading wasn't said." }, { status: 400 });
    }
    const job = await readMatrixReadJob(jobId);
    if (!job) {
      return Response.json(
        { error: "That reading is no longer on the server. Run it again." },
        { status: 404 },
      );
    }
    return Response.json(job);
  }

  // Hold the training status against the skills requirements. Nothing is
  // compared in this call, for the same reason nothing is read in matrix-read:
  // the comparison is one long question to the model, so the run is written
  // down, the background worker is set going, and the portal is handed the job
  // to ask after with "matrix-check-job". The shortcuts — an answer already
  // held for these exact documents, and the readings not being there yet — are
  // both answered here with no job at all.
  if (action === "matrix-check") {
    const force = body.force === true;
    try {
      const { training, skills, validity, missing } = await matrixDocuments();
      if (missing.length) return bothRequired(missing);

      const store = matrixStore();
      const key = matrixCheckKey(training!.id, skills!.id, validity ? validity.id : null);

      if (!force) {
        const already = (await store.get(key, { type: "json" })) as Record<string, unknown> | null;
        if (already) return Response.json({ cached: true, ...already });
      }

      const [trainingRead, skillsRead, validityRead] = await Promise.all([
        store.get(matrixReadingKey("training", training!.id), { type: "json" }),
        store.get(matrixReadingKey("skills", skills!.id), { type: "json" }),
        validity ? store.get(matrixReadingKey("validity", validity.id), { type: "json" }) : null,
      ]);
      const unread = [
        trainingRead ? null : "training matrix",
        skillsRead ? null : "skills matrix",
        !validity || validityRead ? null : "validity periods (off the skills matrix)",
      ].filter(Boolean);
      if (unread.length) {
        return Response.json(
          { error: `The ${unread.join(" and the ")} hasn't been read yet.`, unread },
          { status: 409 },
        );
      }

      const job = await startMatrixCheckJob({ force });
      const handedOver = await startWorker(req, MATRIX_CHECK_WORKER_PATH, job.id);

      return Response.json(
        {
          pending: true,
          jobId: job.id,
          at: job.at,
          ...(handedOver ? {} : { startPath: MATRIX_CHECK_WORKER_PATH }),
        },
        { status: 202 },
      );
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  // How a matrix check is getting on. The portal asks for this until the answer
  // is there, so it says as little as possible: the state, and the answer once
  // there is one.
  if (action === "matrix-check-job") {
    const jobId = typeof body.jobId === "string" ? body.jobId : "";
    if (!jobId) {
      return Response.json({ error: "Which check wasn't said." }, { status: 400 });
    }
    const job = await readMatrixCheckJob(jobId);
    if (!job) {
      return Response.json(
        { error: "That check is no longer on the server. Run it again." },
        { status: 404 },
      );
    }
    return Response.json(job);
  }

  // What the portal needs before it offers to run any of the above: whether both
  // documents are on file, and whether the answer is already sitting there.
  if (action === "matrix-state") {
    const { training, skills, validity, missing } = await matrixDocuments();
    const store = matrixStore();
    const held =
      training && skills
        ? await store.get(matrixCheckKey(training.id, skills.id, validity ? validity.id : null), {
            type: "json",
          })
        : null;
    return Response.json({
      missing,
      training: training ? { id: training.id, filename: training.filename } : null,
      skills: skills ? { id: skills.id, filename: skills.filename } : null,
      validity: validity ? { id: validity.id, filename: validity.filename } : null,
      analysis: held || null,
    });
  }

  if (action === "extract") {
    const cols = Array.isArray(body.cols) ? (body.cols as [string, string, string][]) : [];
    if (!cols.length) {
      return Response.json({ error: "The matrix items weren't included." }, { status: 400 });
    }
    const asked = Number(body.limit);
    const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_BATCH) : BATCH;
    try {
      return await extract(cols.map(([code, title]) => [code, title]), limit);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  if (action === "equivalences") {
    // The Equivalence page of the skills matrix, parsed by the page that has
    // the workbook open and kept here for every reading that follows.
    const rows = Array.isArray(body.rows)
      ? (body.rows as unknown[])
          .filter(
            (r): r is { held: string; code: string } =>
              !!r
              && typeof (r as { held?: unknown }).held === "string"
              && typeof (r as { code?: unknown }).code === "string",
          )
          .map((r) => ({ held: r.held.replace(/\s+/g, " ").trim().slice(0, 200), code: r.code.trim().toUpperCase().slice(0, 12) }))
          .filter((r) => !!r.held && /^[A-Z]{2,4}-\d+[A-Z]?$/.test(r.code))
          .slice(0, 400)
      : [];
    // The page may say which skills matrix it read the sheet off. Stamped
    // with that and the crew matrix's columns as they stand, so the hour
    // sees the table as current and does not read the workbook again for
    // the same rows (keepEquivalences in lib/round.ts).
    const skillsId = typeof body.skillsId === "string" && body.skillsId.trim() ? body.skillsId.trim().slice(0, 80) : null;
    const stamp = skillsId ? { skillsId, colsKey: equivalenceColsKey((await readDocument())?.doc.quals?.cols) } : {};
    await matrixStore().setJSON(EQUIV_KEY, { rows, at: new Date().toISOString(), ...stamp });
    return Response.json({ stored: rows.length });
  }

  if (action === "refile") {
    // The names on the matrix are the only people a certificate can be filed
    // under, so without them there is nothing to match against.
    const names = Array.isArray(body.names)
      ? (body.names as unknown[]).filter((n): n is string => typeof n === "string" && !!n.trim())
      : [];
    if (!names.length) {
      return Response.json({ error: "The crew names weren't included." }, { status: 400 });
    }
    const limit = typeof body.limit === "number" && body.limit > 0 ? body.limit : Infinity;
    try {
      return await refile(names, limit);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  // The issue and expiry dates read off the certificates on file, per person
  // and matrix code — what the date columns on the certification screens show.
  // Answered from the cached readings alone, so it is cheap to ask any time.
  if (action === "dates") {
    try {
      return await certificateDates();
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  // How long each item stays valid, as the validity periods matrix gives it —
  // what the Module validity column on the E-Learning Status page shows.
  // Answered from the cached reading alone, so it is cheap to ask any time.
  if (action === "validity-periods") {
    try {
      return await validityPeriodList();
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  if (action === "compare") {
    const cols = Array.isArray(body.cols) ? (body.cols as Matrix["cols"]) : [];
    const rows = Array.isArray(body.rows) ? (body.rows as Matrix["rows"]) : [];
    if (!cols.length || !rows.length) {
      return Response.json({ error: "The crew matrix wasn't included." }, { status: 400 });
    }
    const sheet =
      body.sheet && typeof body.sheet === "object"
        ? (body.sheet as { filename?: string; rows?: { name: string; vals: (string | null)[] }[] })
        : null;
    try {
      return await compare({ cols, rows }, sheet);
    } catch (e) {
      // The comparison touches the database and the reading store, and a failure
      // in either would otherwise reach the portal as a bare 500 with nothing
      // an admin could act on.
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }
  return Response.json({ error: `Unknown action "${action}".` }, { status: 400 });
};

