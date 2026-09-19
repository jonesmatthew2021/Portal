
import {
  canonicaliseCertificate,
  certFolderFor,
  fileStore,
  liveSingleFileRow,
  refileCertificate,
  safeName,
} from "../db/documents.js";
import { imageToPdf } from "../lib/pdf-wrap.js";
import { getEnv } from "../env.js";
import {
  askJson,
  base64,
  blankish,
  EQUIV_KEY,
  equivalences,
  certificateStanding,
  codeFor,
  contentFor,
  date,
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
  neverLapses,
  READING_VERSION,
  readingKey,
  readingStore,
  refusalSays,
  str,
  type Matrix,
  type MatrixReading,
  type Reading,
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
  "qualCode": string|null,          // the matrix code it answers to, from the list given, or null
  "codeConfidence": "high"|"medium"|"low",
  "notes": string|null              // at most 15 words, only if something matters
}

Rules:
- Dates: Australian documents are day-first. "10/03/2028" is 2028-03-10.
- Only give expiresOn if a date of expiry, valid-until or renewal-due is actually
  printed. Never calculate one from the issue date, and never guess a year.
- Set readable to false when the document is too poor to read, is not a
  certificate, or is a certificate for something not on the list.
- Only give qualCode when the document is plainly that item. Use "high" only when
  the printed title and the item title are the same qualification. If two codes
  could fit, pick neither and return null.
- Never invent a name, a date or a code. null is the right answer when it is not
  on the page.`;

function instructionFor(row: Row, codes: [string, string][]) {
  const list = codes.map(([code, title]) => `${code} — ${title}`).join("\n");
  const filed = [
    row.person ? `Filed against: ${row.person}` : null,
    row.qualCode ? `Filed against matrix code: ${row.qualCode}` : null,
    `Filename: ${row.filename}`,
  ]
    .filter(Boolean)
    .join("\n");

  return `Read the attached certificate and return the JSON described.

${filed}

The matrix codes it could answer to:
${list}

What it was filed against is what a person typed when they uploaded it, and may
be wrong. Report what the document itself says.`;
}

async function askModel(row: Row, bytes: ArrayBuffer, codes: [string, string][]) {
  const shape = mediaFor(row)!;
  const source = { type: "base64", media_type: shape.media, data: base64(bytes) };
  const fileBlock =
    shape.kind === "pdf"
      ? { type: "document", source }
      : { type: "image", source };

  const { json: parsed, truncated } = await askJson({
    system: SYSTEM,
    content: [fileBlock, { type: "text", text: instructionFor(row, codes) }],
    // A certificate reading is a dozen short fields, but max_tokens covers what
    // the model thinks on the way there as well, and a poor scan is thought
    // about for a while. The room is there so a hard-to-read certificate comes
    // back read rather than cut off.
    maxTokens: 8000,
    effort: "low",
  });

  const code = str(parsed.qualCode);
  const confidence = str(parsed.codeConfidence);

  const reading: Reading = {
    version: READING_VERSION,
    at: new Date().toISOString(),
    model: MODEL,
    readable: parsed.readable !== false,
    holderName: str(parsed.holderName),
    certificateTitle: str(parsed.certificateTitle),
    issuer: str(parsed.issuer),
    issuedOn: date(parsed.issuedOn),
    expiresOn: date(parsed.expiresOn),
    neverExpires: parsed.neverExpires === true,
    // Only a code the matrix actually has. A code the model made up would
    // otherwise land a date in whichever column happened to match. Compared
    // upper case, the same way the rest of the codebase matches matrix codes.
    qualCode: code && codes.some(([c]) => c.toUpperCase() === code.toUpperCase()) ? code : null,
    codeConfidence:
      confidence === "high" || confidence === "medium" || confidence === "low" ? confidence : null,
    // A reading that stopped partway is still worth keeping — the fields it had
    // written are read off the certificate like any other — but whoever looks at
    // it should know the rest of the document went unsaid.
    notes: truncated
      ? [str(parsed.notes), "The reading stopped partway, so parts of this certificate went unread."]
          .filter(Boolean)
          .join(" ")
      : str(parsed.notes),
  };

  if (!reading.readable && !reading.reason) {
    reading.reason = reading.notes || "The model couldn't make out what this document is.";
  }
  return reading;
}

/** Read up to `limit` certificates that have no reading yet. */
/** One certificate read now — the same checks and the same question the
 * batch read puts, for a file that has just been filed. A refusal from the
 * model is written down as unreadable; a busy model throws, to be tried
 * again. */
export async function readCertificate(row: Row, codes: [string, string][]): Promise<Reading> {
  const unreadable = (reason: string) =>
    ({ version: READING_VERSION, at: new Date().toISOString(), model: null, readable: false, reason }) as Reading;
  const shape = mediaFor(row);
  if (!shape) return unreadable(`${row.filename} isn't a PDF or an image, so it can't be read.`);
  if (row.sizeBytes > MAX_READ_BYTES) {
    return unreadable(`${row.filename} is too large to read. Re-save it under 4 MB and upload it again.`);
  }
  const bytes = await fileStore().get(row.blobKey, { type: "arrayBuffer" });
  if (!bytes) return unreadable("The file is no longer in the store.");
  try {
    return await askModel(row, bytes, codes);
  } catch (e) {
    if (e instanceof ModelRefusal && e.status === 400) {
      const said = refusalSays(e);
      return unreadable(`The model turned this file away${said ? `: ${said}` : " as one it can't read."}`);
    }
    throw e;
  }
}

export async function extract(codes: [string, string][], limit: number) {
  const certs = await liveCertificates();
  const store = readingStore();

  // The portal comes back here once per batch, so what has already been read is
  // answered from one listing rather than a fetch per certificate per call.
  const { blobs } = await store.list({ prefix: `${READING_VERSION}/` });
  const done = new Set(blobs.map((b) => b.key));

  const outstanding = certs.filter((row) => !done.has(readingKey(row)));
  const batch = outstanding.slice(0, limit);

  const failures: { filename: string; person: string | null; error: string }[] = [];

  await Promise.all(
    batch.map(async (row) => {
      try {
        const shape = mediaFor(row);
        if (!shape) {
          await store.setJSON(readingKey(row), {
            version: READING_VERSION,
            at: new Date().toISOString(),
            model: null,
            readable: false,
            reason: `${row.filename} isn't a PDF or an image, so it can't be read.`,
          } satisfies Reading);
          return;
        }
        if (row.sizeBytes > MAX_READ_BYTES) {
          await store.setJSON(readingKey(row), {
            version: READING_VERSION,
            at: new Date().toISOString(),
            model: null,
            readable: false,
            reason: `${row.filename} is too large to read. Re-save it under 4 MB and upload it again.`,
          } satisfies Reading);
          return;
        }

        const bytes = await fileStore().get(row.blobKey, { type: "arrayBuffer" });
        if (!bytes) {
          await store.setJSON(readingKey(row), {
            version: READING_VERSION,
            at: new Date().toISOString(),
            model: null,
            readable: false,
            reason: "The file is no longer in the store.",
          } satisfies Reading);
          return;
        }

        await store.setJSON(readingKey(row), await askModel(row, bytes, codes));
      } catch (e) {
        // A 400 is the model turning the document itself away — a corrupted or
        // password-protected file gets the same refusal every time it is sent,
        // and a certificate that can never be read would otherwise sit at the
        // front of every batch and stop the reading from ever finishing. It is
        // written down as unreadable, with the refusal and what to do about it,
        // and the next batch moves on to the certificates behind it.
        if (e instanceof ModelRefusal && e.status === 400) {
          const said = refusalSays(e);
          try {
            await store.setJSON(readingKey(row), {
              version: READING_VERSION,
              at: new Date().toISOString(),
              model: null,
              readable: false,
              reason: `The model turned this file away${said ? `: ${said}` : " as one it can't read."} That usually means ${row.filename} is corrupted or password-protected — open it, re-save it as a fresh PDF or a clear photo, and upload it again.`,
            } satisfies Reading);
            return;
          } catch {
            // The store refusing the write is a failure of this call, not of
            // the certificate — reported below and tried again next batch.
          }
        }
        // Nothing is written: a certificate that failed because the model was
        // busy has to be tried again, not remembered as unreadable for good.
        failures.push({
          filename: row.filename,
          person: row.person,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }),
  );

  const read = certs.length - outstanding.length + (batch.length - failures.length);

  return Response.json({
    total: certs.length,
    read,
    remaining: Math.max(0, certs.length - read),
    // What this call got through, so the portal can tell a batch that read
    // nothing at all from one that is simply not finished yet.
    attempted: batch.length,
    extracted: batch.length - failures.length,
    failures,
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
 * "EVANS, Brenton" is never taken for "EVANS, Dylan". Anything less certain is
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
  // "PERSON - CODE Title.pdf".
  const titles: Record<string, string> = {};
  try {
    const state = await getEnv().DB.prepare("SELECT data FROM portal_state LIMIT 1").first<{ data: string }>();
    for (const c of JSON.parse(state?.data || "{}")?.quals?.cols || []) {
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

  // One at a time: each move is a copy, a delete and a row update in the blob
  // store, and they are only worth doing carefully. A big backlog is taken a
  // slice per request (limit + remaining), so no single request runs longer
  // than its caller can wait.
  for (const row of certs) {
    const reading = readings.get(readingKey(row)) || null;
    if (!reading || !reading.readable || !reading.holderName) continue;

    const person = holderOnMatrix(reading.holderName, names);
    if (!person) continue;

    const folder = certFolderFor(person);
    if (folder !== row.folder) {
      if (done >= limit) { remaining++; continue; }
      const from = row.person;
      const updated = await refileCertificate(row, person, folder);
      moved.push({ id: updated.id, filename: updated.filename, folder, from, to: person });
      done++;
      continue;
    }

    // The right folder, but the folder own wording on the row: certificates
    // the sync took on carry the folder name as their person until a reading
    // says whose they are, and they sit under Other on the certificates list
    // with no rank to their name. The reading says whose they are, so the row
    // takes the matrix name. A label, not a move - one row update, no file
    // touched - so it does not count against the slice.
    if ((row.person || "") !== person) {
      await getEnv().DB.prepare("UPDATE documents SET person = ?2 WHERE id = ?1").bind(row.id, person).run();
      moved.push({ id: row.id, filename: row.filename, folder, from: row.person, to: person });
      row.person = person;
    }

    // Already with the right person: the file takes the one filing name,
    // wrapped as a PDF where it is a photo.
    const code = String(codeFor(row, reading, eqTable) || "").trim().toUpperCase();
    const title = code ? titles[code] : "";
    if (!code || !title || !/^[a-z0-9-]+$/.test(row.folder || "")) continue;
    const personName = names.includes(row.person || "") ? row.person : person;
    if (!personName) continue;
    const ext = ((row.filename.match(/\.[^.]+$/) || [""])[0] || "").toLowerCase();
    const targetExt = ext === ".pdf" || [".jpg", ".jpeg", ".png"].includes(ext) ? ".pdf" : ext;
    if (row.filename === safeName(`${personName} - ${code} ${title}`) + targetExt) continue;
    if (done >= limit) { remaining++; continue; }
    const renamedRow = await canonicaliseCertificate(row, `${personName} - ${code} ${title}`, imageToPdf);
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

async function compare(matrix: Matrix, sheet: { filename?: string; rows?: { name: string; vals: (string | null)[] }[] } | null) {
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
  const claim = new Map<string, { row: Row; reading: Reading }>();

  for (const { row, reading } of readings) {
    const link = { id: row.id, filename: row.filename, url: `/api/files/${row.id}` };

    if (!reading) continue;
    if (!reading.readable) {
      notes.push({
        kind: "unreadable",
        person: row.person,
        detail: reading.reason || "This certificate couldn't be read.",
        certificate: link,
      });
      continue;
    }

    // The uploader's own tagging comes first — a person choosing the item off a
    // list beats a model inferring it from a scan. The model's code is only used
    // where nobody said, and only when it was sure.
    const code = codeFor(row, reading, eqTable);

    // The model's own guess, remembered where the equivalence page overruled
    // it - the cell that guess once filled may still be sitting on the matrix.
    const guess = reading.codeConfidence !== "low" ? (reading.qualCode || "").trim().toUpperCase() : "";
    if (!row.qualCode && guess && code && guess !== code.trim().toUpperCase() && colAt.has(guess)) {
      const typedOld = isDate(row.expiresOn) ? normDate(row.expiresOn!) : null;
      rehomed.push({ person: row.person, old: guess, expiry: typedOld || reading.expiresOn || null });
    }

    if (!code || !colAt.has(code.trim().toUpperCase())) {
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

    if (!row.person || !rowAt.has(row.person.trim().toUpperCase())) {
      notes.push({
        kind: "not-on-matrix",
        person: row.person,
        detail: `${row.person || "Nobody"} isn't on the crew matrix, so there is nothing to compare this against.`,
        certificate: link,
      });
      continue;
    }

    // The name on the document against the person it was filed under. A scan
    // filed against the wrong crew member is worse than one not filed at all.
    if (reading.holderName) {
      const on = words(reading.holderName);
      const filed = words(row.person);
      if (on.length && !filed.some((w) => on.includes(w))) {
        notes.push({
          kind: "name-mismatch",
          person: row.person,
          detail: `Filed under ${row.person}, but the certificate is in the name of ${reading.holderName}.`,
          certificate: link,
        });
        continue;
      }
    }

    const key = `${row.person.trim().toUpperCase()}::${code.trim().toUpperCase()}`;
    const sitting = claim.get(key);
    if (sitting) {
      // The one that runs the longer is the certificate in force; the other is
      // the one it renewed. A date typed against the certificate on the portal
      // beats the model's reading of the scan here too — the same precedence
      // certificateStanding() in lib/analysis.ts uses to answer the same
      // question, so the two agree on which certificate is in force.
      const expiryOf = (r: Row, rd: Reading) => {
        const typed = isDate(r.expiresOn) ? normDate(r.expiresOn!) : null;
        return neverLapses(code) ? null : typed || rd.expiresOn || null;
      };
      const inForce =
        (expiryOf(row, reading) || "") > (expiryOf(sitting.row, sitting.reading) || "") ? { row, reading } : sitting;
      const replaced = inForce === sitting ? { row, reading } : sitting;
      claim.set(key, inForce);
      notes.push({
        kind: "superseded",
        person: replaced.row.person,
        detail: `Two certificates on file for ${code}. ${inForce.row.filename} runs the longer, so ${replaced.row.filename} is treated as the one it replaced.`,
        certificate: { id: replaced.row.id, filename: replaced.row.filename, url: `/api/files/${replaced.row.id}` },
      });
      continue;
    }
    claim.set(key, { row, reading });
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

  for (const [key, { row, reading }] of claim) {
    const code = key.split("::")[1];
    const at = rowAt.get(row.person!.trim().toUpperCase())!;
    const col = colAt.get(code.trim().toUpperCase())!;
    const matrixRow = matrix.rows[at];
    const cell = matrixRow[3][col] || "";
    const [, title, group] = cols[col];
    covered.add(`${at}:${col}`);

    // A date typed against the certificate on the portal — at upload, or edited
    // since — is the person's own answer, and beats the model's reading of the
    // scan the same way their choice of matrix code does.
    const typed = isDate(row.expiresOn) ? normDate(row.expiresOn!) : null;
    const expiry = typed || reading.expiresOn || null;

    const link = {
      id: row.id,
      filename: row.filename,
      url: `/api/files/${row.id}`,
      expires: expiry,
      title: reading.certificateTitle || null,
    };
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
      if (expiry) {
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
    const personKey = r.person.trim().toUpperCase();
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

  return Response.json({
    at: new Date().toISOString(),
    model: MODEL,
    items,
    notes,
    settled,
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
  });
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
    await matrixStore().setJSON(EQUIV_KEY, { rows, at: new Date().toISOString() });
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

