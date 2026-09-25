/**
 * What the AI Checker can reach, and how it reaches it.
 *
 * The checker used to be blind on purpose. It was a conversation and nothing
 * else: whatever was typed, pasted or attached into it was all it had, and asked
 * about "the matrix" or "Alan's medical" it could only say that it couldn't
 * see them and point at the pages that could. Everything the portal actually
 * holds — the shared record, the file store, a hundred scanned certificates, the
 * analyses already worked out — sat on the other side of a wall from the one part
 * of the portal people ask questions of.
 *
 * This is that wall taken down. The checker is given a short account of what the
 * portal holds with every question, and a set of tools it calls to go and look:
 * the shared record section by section, the file index, what the certificates on
 * file say, any single file opened up and put in front of it, and the analyses
 * the portal has already made. It answers from the portal rather than from what
 * somebody remembered to paste in.
 *
 * Three rules run through all of it:
 *
 * Nothing here runs an analysis. Reading the certificates, the matrices and the
 * OPMS export are long, expensive jobs the portal starts deliberately from its
 * own pages; a question typed into the checker must not quietly set one going.
 * So every answer here is either a database read, a blob read, or an analysis
 * that has already been made and kept — and where one hasn't been made, the
 * checker is told that plainly so it can say so rather than inventing one.
 *
 * Nothing here writes. The checker reads the portal; it does not change it. A
 * question is answered, and the portal is exactly as it was.
 *
 * Everything is bounded. A tool answer is capped, a listing is paged, and the
 * files that can be opened while answering one question are counted and
 * measured — because the whole conversation, everything it has looked at
 * included, is sent up again on every round of it.
 */

import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents, PORTAL_ROW_ID, portalState } from "../db/schema.js";
import { liveSingleFileRow, SINGLE_FILE_CATEGORIES } from "../db/documents.js";
import {
  certificateStanding,
  contentFor,
  liveCertificates,
  matrixCheckKey,
  matrixReadingKey,
  matrixStore,
  READING_VERSION,
  readingKey,
  readingStore,
  todayThere,
  type MatrixReading,
  type Reading,
} from "./analysis.js";
import { heldOpmsAnswer, type OpmsHeld } from "./opms.js";
import { shiftKeyFor, shiftSheetRow, shiftStore, type ShiftHeld } from "./shift.js";
import { vessel } from "../vessel.js";
import { RED_DAYS } from "../../../source/shared/bands.js";

/** The swings' names as the office says them, the two labels with "Swing"
 *  taken off and joined with "and", off the vessel file. */
const swingWords = () => {
  const names = Object.values(vessel.swings.labels).map((l) => l.replace(/^Swing\s+/i, ""));
  return names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names.join("");
};

// What one tool answer may run to. A tool that hands back everything it found
// would spend the room the answer itself needs — and the whole conversation,
// every tool answer in it included, goes up again on every round.
const MAX_TOOL_CHARS = 24000;

// One section of the shared record. The crew matrix and the change history are
// the long ones, and both are lists, so what doesn't fit is asked for by page
// rather than lost.
const MAX_SECTION_CHARS = 22000;
const LIST_PAGE = 40;
const MAX_LIST_PAGE = 200;

// How much of the file index one listing gives back.
const FILES_PAGE = 60;
const MAX_FILES_PAGE = 250;

// How many certificate readings one call reads out of the store. Fifty is a full
// vessel's worth several times over.
const CERTS_PAGE = 60;
const MAX_CERTS_PAGE = 200;

// What may be opened and looked at while answering one question. Both are
// deliberately tight: a PDF is worth thousands of tokens of the conversation and
// is resent on every round after it, so six documents is already a long question.
// Base64 characters, not bytes — about 3.2 MB of file.
const MAX_OPEN_FILES = 6;
const MAX_OPEN_B64 = 4400000;

// ---------------------------------------------------------------------------
// The shared record
// ---------------------------------------------------------------------------

/**
 * What each part of the shared record is, in the words the crew would use.
 *
 * The record is one JSON document and its keys are the names the code uses,
 * which say less than they look like they do — `people` is the establishment
 * rather than who is onboard, `overrides` is one-off changes to the rotation,
 * `quals` is the list of matrix items. Anything not named here is still listed
 * and still readable; this is what is worth explaining.
 */
const SECTIONS: Record<string, string> = {
  notes: "handover notes, filed against a rank and a swing",
  suggestions: "the crew suggestion board",
  appSuggestions: "suggestions about the portal itself",
  correspondence: "correspondence threads with the partnership, and their emails",
  pwCorrespondence: "correspondence threads with PortWays",
  docs: "the document library entries",
  people: "the crew establishment — every position and who holds it",
  overrides: "one-off changes to the swing rotation, by person",
  swingBoard: "who is onboard now and which watch they are on",
  swingBoards: "the same, worked ahead for a coming swing, by swing number",
  swingLists: `the two swing lists as the office sent them, ${swingWords()}`,
  swingDates: "the dates the office has given for a swing, by swing number",
  rosterPattern: "the swing pattern: the first onswing's day out, and days per swing",
  history: "the change log — who changed what, and when",
  comments: "comments left against things on the portal",
  hiddenTabs: "which pages are hidden",
  quals: "the matrix items: every code and what it is",
  matrixArchive: "archived crew qualification spreadsheets",
  certificates: "the certificate register as the portal shows it",
  certSheet: "the crew certificates spreadsheet as it was last read",
  certAnalysis: "the last certificate comparison, and the rulings admins gave it",
  certDates: "issue and expiry dates read off the certificates, keyed PERSON::CODE",
  validityPeriods: "how long each matrix item stays valid",
  matrixAnalysis: "the last training and skills matrix check",
  shiftAnalysis: "the last shift allocation comparison",
  swingReport: "the last swing compliance report",
  matrixUpdated: "the day the matrix was last rebuilt from a spreadsheet",
};

async function sharedRecord() {
  const [row] = await db.select().from(portalState).where(eq(portalState.id, PORTAL_ROW_ID));
  return row ?? null;
}

/** How much a section holds, said in a way that fits on the end of a line. */
function sizeOf(value: unknown) {
  if (value === null || value === undefined) return "empty";
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "entry" : "entries"}`;
  if (typeof value === "object") {
    const n = Object.keys(value as object).length;
    return `${n} ${n === 1 ? "key" : "keys"}`;
  }
  if (typeof value === "string") return value.trim() ? `"${value.slice(0, 40)}"` : "empty";
  return String(value);
}

// ---------------------------------------------------------------------------
// Dates, sizes and other small things said the same way everywhere
// ---------------------------------------------------------------------------

const day = (v: unknown) => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string" && v) return v.slice(0, 10);
  return null;
};

const size = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;

/**
 * How many days from today at the vessel to a date, negative once it has gone.
 *
 * Today is the day it is in Western Australia rather than whatever UTC has
 * reached, because an expiry is only ever measured against the day it is where
 * the crew are.
 */
function daysAway(iso: string) {
  const at = Date.parse(`${iso}T00:00:00Z`);
  const now = Date.parse(`${todayThere()}T00:00:00Z`);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return null;
  return Math.round((at - now) / 86400000);
}

/** Whether a certificate this many days from its expiry is expiring: not
 *  gone yet, and inside the matrix's red band - RED_DAYS, the one number
 *  the page's colours and the weekly reminder emails read too, so the
 *  assistant never calls something current that the matrix shows red. */
export const expiringIn = (away: number | null) => away !== null && away >= 0 && away <= RED_DAYS;

/** The status filter's word on expiring, as the model is told it. */
export const EXPIRING_MEANS = `expiring is anything with ${RED_DAYS} days or less to run`;

/** An expiry as a person would say it: the date, and where it stands today. */
function standing(iso: string | null | undefined) {
  if (!iso) return "no expiry recorded";
  const n = daysAway(iso);
  if (n === null) return iso;
  if (n < 0) return `${iso} — EXPIRED ${-n} ${-n === 1 ? "day" : "days"} ago`;
  // The day printed on it is the day it stops counting (MO70 s 5(a)(iii)).
  if (n === 0) return `${iso} — EXPIRED today`;
  if (n <= RED_DAYS) return `${iso} — ${n} ${n === 1 ? "day" : "days"} left`;
  return `${iso} — current`;
}

/** Cut a tool answer to what it is allowed, saying so rather than trailing off. */
function capped(text: string, limit = MAX_TOOL_CHARS) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[Cut off here — this is as much as one answer can carry. Ask again for a narrower slice of it.]`;
}

// ---------------------------------------------------------------------------
// The account of the portal that goes up with every question
// ---------------------------------------------------------------------------

/** Every certificate reading the store holds, by key, without reading any of them. */
async function readingKeys() {
  const { blobs } = await readingStore().list({ prefix: `${READING_VERSION}/` });
  return new Set(blobs.map((b) => b.key));
}

/** Which of the analyses the portal has already made and is still holding. */
async function heldAnalyses() {
  const [training, skills, shiftSheet] = await Promise.all([
    liveSingleFileRow("training-matrix"),
    liveSingleFileRow("skills-matrix"),
    shiftSheetRow(),
  ]);
  // The validity periods are read off the skills matrix itself, so the skills
  // file stands in wherever the old separate validity spreadsheet was looked up.
  const validity = skills;

  const [matrixCheck, shift, opms] = await Promise.all([
    training && skills
      ? (matrixStore().get(matrixCheckKey(training.id, skills.id, validity ? validity.id : null), {
          type: "json",
        }) as Promise<Record<string, unknown> | null>)
      : null,
    shiftSheet
      ? (shiftStore().get(shiftKeyFor(shiftSheet.id), { type: "json" }) as Promise<ShiftHeld | null>)
      : null,
    heldOpmsAnswer(),
  ]);

  return { training, skills, validity, shiftSheet, matrixCheck, shift, opms };
}

/**
 * The state of the portal, written out for the model with every question.
 *
 * This is not the portal — it is the shape of it: what sections the shared record
 * has and how much is in each, how many files are filed under what, how many
 * certificates have been read, and which analyses are sitting there already made.
 * A few hundred words, so that a question about the roster is answered by calling
 * for the roster rather than by saying it can't be seen, and so the model can
 * tell the difference between something the portal doesn't hold and something it
 * simply hasn't looked at yet.
 *
 * It goes up as part of the question rather than as part of the standing
 * instructions, deliberately: it carries today's date and live counts, and the
 * instructions and the tool definitions in front of it are identical on every
 * request, which is what lets the gateway answer the front of each one out of
 * cache.
 */
export async function portalOverview() {
  const [record, files, certs, read, held] = await Promise.all([
    sharedRecord(),
    db
      .select({ category: documents.category, removedAt: documents.removedAt })
      .from(documents),
    liveCertificates(),
    readingKeys(),
    heldAnalyses(),
  ]);

  const lines: string[] = [];
  lines.push(
    "THE PORTAL AS IT STANDS. This was put in front of you with the question — nobody typed it. It is what the portal holds right now, so that you can go and read the parts of it the question is about.",
  );
  lines.push(`Today at the vessel is ${todayThere()} (Australian Western Standard Time).`);

  // The shared record, section by section.
  if (record) {
    const data = (record.data || {}) as Record<string, unknown>;
    const keys = Object.keys(data).sort();
    lines.push(
      `\nTHE SHARED RECORD — everything the portal holds that isn't a file. Last saved ${day(record.updatedAt) || "at an unknown date"}, revision ${record.rev}. Read any of these sections with the portal records tool:`,
    );
    for (const key of keys) {
      const what = SECTIONS[key];
      lines.push(`  ${key} — ${sizeOf(data[key])}${what ? `: ${what}` : ""}`);
    }
    const unlisted = Object.keys(SECTIONS).filter((k) => !(k in data));
    if (unlisted.length) {
      lines.push(`  (nothing saved yet under: ${unlisted.join(", ")})`);
    }
  } else {
    lines.push("\nTHE SHARED RECORD is empty — nothing has been saved to the portal yet.");
  }

  // The file store, by category.
  const live = files.filter((f) => !f.removedAt);
  const gone = files.length - live.length;
  const byCategory = new Map<string, number>();
  for (const f of live) byCategory.set(f.category, (byCategory.get(f.category) || 0) + 1);
  lines.push(
    `\nFILES ON THE PORTAL — ${live.length} filed${gone ? `, and ${gone} that ${gone === 1 ? "has" : "have"} been removed but is still readable` : ""}. List them with the file listing tool:`,
  );
  for (const [category, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    const single = SINGLE_FILE_CATEGORIES[category];
    lines.push(`  ${category} — ${n}${single ? ` (the ${single.label})` : ""}`);
  }
  if (!byCategory.size) lines.push("  nothing has been uploaded yet");

  // The certificates, and how much of them has been read.
  if (certs.length) {
    const people = new Set(certs.map((c) => (c.person || "").trim().toUpperCase()).filter(Boolean));
    const readCount = certs.filter((c) => read.has(readingKey(c))).length;
    lines.push(
      `\nCREW CERTIFICATES — ${certs.length} scans on file for ${people.size} ${people.size === 1 ? "person" : "people"}. ${readCount} of them have been read and the reading kept; ${certs.length - readCount} have not been read. Ask for what they say with the certificate tool, and open any of them to look at the scan itself.`,
    );
  } else {
    lines.push("\nCREW CERTIFICATES — none are on file.");
  }

  // The analyses already made.
  const analyses: string[] = [];
  analyses.push(
    held.training && held.skills
      ? held.matrixCheck
        ? `the training and skills matrix check — made ${day((held.matrixCheck as { at?: unknown }).at) || "at an unknown date"}`
        : "the training and skills matrix check — both matrices are on file but no check has been run"
      : `the training and skills matrix check — cannot be run: the ${[held.training ? null : "training matrix", held.skills ? null : "skills matrix"].filter(Boolean).join(" and the ")} ${held.training || held.skills ? "is" : "are"} not on the portal`,
  );
  analyses.push(
    held.opms
      ? `the OPMS comparison — made ${day(held.opms.at) || "at an unknown date"}`
      : "the OPMS comparison — none has been run",
  );
  analyses.push(
    held.shiftSheet
      ? held.shift
        ? `the shift allocation check — made ${day(held.shift.at) || "at an unknown date"}`
        : "the shift allocation check — the sheet is on file but no check has been run"
      : "the shift allocation check — no shift allocation sheet is on the portal",
  );
  analyses.push("the certificate standing — worked out from the certificate readings whenever asked for");
  lines.push(`\nANALYSES THE PORTAL HAS ALREADY MADE. Ask for any of these rather than working it out yourself:`);
  for (const one of analyses) lines.push(`  ${one}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/**
 * What the checker can call, as the model is given them.
 *
 * The descriptions are long on purpose. What a tool is for, when to reach for it
 * and what comes back is the whole of what the model has to go on when it decides
 * whether a question needs the roster or the certificates — a name and a
 * parameter list is not enough, and a tool described in half a line is a tool
 * called in the wrong places.
 */
export const PORTAL_TOOLS: Record<string, unknown>[] = [
  {
    name: "portal_records",
    description:
      "Reads the portal's shared record — everything the portal holds that is not an uploaded file. That is the crew establishment and who holds each position, who is onboard and on which watch, the swing rotation and the dates the office has given for each swing, handover notes, correspondence threads and their emails, the crew suggestion board, comments, the matrix items, the certificate register as the portal shows it, and the change log of who changed what and when. Call this for any question that turns on what the portal records rather than on a document somebody uploaded: who is on this swing, what a note said, what the roster does next month, what changed last week. Call it with no section the first time to see which sections exist and how much each holds, then call it again naming one section to read it. A section that is a list comes back newest first in pages, so pass offset to read further back through it.",
    input_schema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description:
            "Which section to read, named exactly as it was listed. Leave it out to be given the list of sections with a line on what each one holds.",
        },
        offset: {
          type: "integer",
          description:
            "For a section that is a list: how many entries in to start, counting from the newest. For a section that isn't a list and came back saying it was too long, how many characters into its JSON to start. Use it to read further than the first page.",
        },
        limit: {
          type: "integer",
          description: `For a section that is a list: how many entries to return. Defaults to ${LIST_PAGE}, and at most ${MAX_LIST_PAGE}. For a section that isn't a list, how many characters of its JSON to return, at most ${MAX_SECTION_CHARS}.`,
        },
      },
      required: [],
    },
  },
  {
    name: "list_files",
    description:
      "Lists the files uploaded to the portal: every crew certificate, the attachments on handover notes and correspondence, the document library, archived spreadsheets, and the single documents the portal analyses — the training matrix, the skills matrix, the validity periods matrix, the OPMS export, the shift allocation sheet and the crew certificates spreadsheet. Call this to answer whether something has been filed at all, when it was uploaded and by whom, or to find the file a question is about before opening it. Every line starts with the file's id, which is what the file opening tool takes. Files that have been removed from the portal are left out unless you ask for them — they still exist and can still be read, which matters when the question is about something that has gone.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            "Only files filed under this category. The categories are certificate, note, document, correspondence, matrix, and the single-file ones: training-matrix, skills-matrix, validity-matrix, opms-sheet, shift-allocation, certificate-sheet.",
        },
        person: {
          type: "string",
          description:
            "Only certificates belonging to this person. Part of a name is enough and case does not matter.",
        },
        search: {
          type: "string",
          description:
            "Only files whose filename or title contains this. Part of a word is enough and case does not matter.",
        },
        removed: {
          type: "boolean",
          description:
            "True to list the files that have been removed from the portal instead of the ones currently filed.",
        },
        limit: {
          type: "integer",
          description: `How many files to list, newest first. Defaults to ${FILES_PAGE}, and at most ${MAX_FILES_PAGE}.`,
        },
      },
      required: [],
    },
  },
  {
    name: "read_certificates",
    description:
      "Gives you what the crew certificates on file actually say. Every certificate uploaded to the portal is read once by a model and the reading kept, so this answers out of those readings without reading anything again: the holder's name as printed on the document, what the document says it is, who issued it, the issue and expiry dates, and the matrix item it answers to. Call this for any question about who holds what, what has expired or is about to, or whether a certificate for something is on file. Each line carries the file's id, so where the reading is not enough — small print, a condition, a stamp, an endorsement, a name that looks wrong — open the scan itself and look. Certificates that have not been read yet are listed as such rather than left out, because a certificate nobody has read is not the same thing as a certificate nobody holds.",
    input_schema: {
      type: "object",
      properties: {
        person: {
          type: "string",
          description: "Only this person's certificates. Part of a name is enough and case does not matter.",
        },
        code: {
          type: "string",
          description:
            "Only certificates answering to this matrix item code, for example QL-12 or VS-04.",
        },
        status: {
          type: "string",
          enum: ["all", "current", "expiring", "expired", "unread", "unreadable"],
          description:
            `Which certificates to include. current is anything not expired; ${EXPIRING_MEANS}; unread is the ones nobody has read yet; unreadable is the ones a model could not read. Defaults to all.`,
        },
        limit: {
          type: "integer",
          description: `How many certificates to read out, newest first. Defaults to ${CERTS_PAGE}, and at most ${MAX_CERTS_PAGE}.`,
        },
      },
      required: [],
    },
  },
  {
    name: "open_file",
    description:
      "Opens one file that is on the portal and puts the document itself in front of you, so you can read it rather than read about it. A PDF arrives as the document and a photograph or scan as the image, which is what to use when a question turns on what is actually printed on a certificate, what a letter says, or whether a scan shows what somebody says it shows. Take the id from the file listing or from the certificate readings. Spreadsheets cannot be opened this way — a .xlsx is a zip and there is nothing in it to look at — so for the matrices and the OPMS export ask for the analysis the portal has already made instead. Only a handful of files can be opened while answering one question, so choose the ones that settle it.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The file's id, exactly as a listing gave it.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "analysis_answers",
    description:
      "Hands back the analyses the portal has already worked out and is holding. Nothing is run: these are long jobs the portal starts deliberately from its own pages, and this only reads what has been kept. There are four. The certificate standing is the issue and expiry dates in force for each person and matrix item, worked out from the certificate readings by the same rules the portal's own screens use. The matrix check is the training matrix held against the skills matrix and the validity periods — where the crew stand against what they are required to hold. The OPMS comparison is the portal's own records held against the export from OPMS, which is another party's system. The shift allocation check is the rostered crew held against the office's shift allocation guideline. Call this before working any of it out for yourself from the raw records, because these are the answers the crew are looking at on the portal's pages. Each one carries the date it was made: where an answer is old, or was made before something changed, say so rather than presenting it as the position today.",
    input_schema: {
      type: "object",
      properties: {
        which: {
          type: "string",
          enum: ["certificates", "matrices", "opms", "shift"],
          description:
            "Which analysis to read: certificates for the certificate standing, matrices for the training and skills matrix check, opms for the OPMS comparison, shift for the shift allocation check.",
        },
      },
      required: ["which"],
    },
  },
];

/**
 * A line the portal can show while the checker is working, in the present tense.
 *
 * A question that sets the model reading the record, then the certificates, then
 * opening two scans is a minute or more of nothing arriving. Without this the
 * page looks stuck; with it, whoever asked can see what it is doing.
 */
export function stepFor(name: string, input: Record<string, unknown>) {
  const of = (key: string) => {
    const v = input[key];
    return typeof v === "string" && v.trim() ? v.trim() : "";
  };
  switch (name) {
    case "portal_records":
      return of("section") ? `Reading the portal's ${of("section")}…` : "Looking over the portal's records…";
    case "list_files":
      return of("person")
        ? `Looking through ${of("person")}'s files…`
        : of("search")
          ? `Looking for "${of("search")}" in the files…`
          : "Looking through the files on the portal…";
    case "read_certificates":
      return of("person")
        ? `Reading ${of("person")}'s certificates…`
        : of("code")
          ? `Reading the ${of("code")} certificates on file…`
          : "Reading the certificates on file…";
    case "open_file":
      return "Opening a document to look at it…";
    case "analysis_answers": {
      const which = of("which");
      const named: Record<string, string> = {
        certificates: "the certificate standing",
        matrices: "the matrix check",
        opms: "the OPMS comparison",
        shift: "the shift allocation check",
      };
      return `Reading ${named[which] || "the portal's analysis"}…`;
    }
    default:
      return "Checking the portal…";
  }
}

// ---------------------------------------------------------------------------
// Running one
// ---------------------------------------------------------------------------

/**
 * What a tool hands back: what to say, and anything to put in front of the model.
 *
 * `blocks` is how a document reaches the model. A tool result carries text, so
 * the file itself goes into the same turn alongside it rather than inside it —
 * the shape the certificate reading has always used.
 */
export type ToolOutcome = {
  text: string;
  blocks?: Record<string, unknown>[];
  failed?: boolean;
};

/** What one question has already looked at, so that it can be held to a limit. */
export type Reach = { opened: number; b64: number };
export const newReach = (): Reach => ({ opened: 0, b64: 0 });

const num = (v: unknown, fallback: number, max: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
};

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

// ---- the shared record ----------------------------------------------------

async function toolPortalRecords(input: Record<string, unknown>): Promise<ToolOutcome> {
  const row = await sharedRecord();
  if (!row) {
    return { text: "The portal's shared record is empty — nothing has been saved to it yet." };
  }
  const data = (row.data || {}) as Record<string, unknown>;
  const saved = `Last saved ${day(row.updatedAt) || "at an unknown date"}, revision ${row.rev}.`;

  const section = text(input.section);
  if (!section) {
    const lines = Object.keys(data)
      .sort()
      .map((key) => `  ${key} — ${sizeOf(data[key])}${SECTIONS[key] ? `: ${SECTIONS[key]}` : ""}`);
    return {
      text: `The portal's shared record. ${saved}\n\nThe sections in it, and how much each holds:\n${lines.join("\n")}\n\nAsk for one by name to read it.`,
    };
  }

  if (!(section in data)) {
    const near = Object.keys(data).filter((k) => k.toLowerCase().includes(section.toLowerCase()));
    return {
      text: `There is no section called "${section}" in the portal's shared record.${
        near.length ? ` Did you mean ${near.join(", ")}?` : ` The sections are: ${Object.keys(data).sort().join(", ")}.`
      }`,
      failed: true,
    };
  }

  const value = data[section];
  const what = SECTIONS[section] ? ` — ${SECTIONS[section]}` : "";

  if (Array.isArray(value)) {
    // Newest first, which is the order every list on the portal is shown in and
    // the order a question about one of them almost always means.
    const limit = num(input.limit, LIST_PAGE, MAX_LIST_PAGE);
    const offset = Math.max(0, num(input.offset, 0, value.length) || 0);
    const page = [...value].reverse().slice(offset, offset + limit);
    const body = JSON.stringify(page);
    const more = offset + page.length < value.length;
    return {
      text: capped(
        `${section}${what}. ${value.length} ${value.length === 1 ? "entry" : "entries"} in all; ${
          page.length ? `showing ${offset + 1} to ${offset + page.length}, newest first` : "nothing on this page"
        }. ${saved}${more ? ` Pass offset ${offset + page.length} for the next page.` : ""}\n\n${body}`,
        MAX_SECTION_CHARS,
      ),
    };
  }

  // Not a list — an object, most often, like the crew matrix or one of the
  // analyses. Still too long to hand back whole sometimes, so it is paged by
  // character range using the same offset/limit the array path above uses,
  // rather than hard-truncated into JSON that can no longer be parsed.
  const body = JSON.stringify(value);
  if (body.length <= MAX_SECTION_CHARS) {
    return {
      text: `${section}${what}. ${saved}\n\n${body}`,
    };
  }
  // Too long for one answer, and not a list to page by entry, so it is paged by
  // character range instead — same offset/limit as the array path above, just
  // sliced from the JSON string rather than from the array. The chunk itself is
  // sized to MAX_SECTION_CHARS, with room left in MAX_TOOL_CHARS for the header
  // around it, so nothing here needs to fall back to capped() and risk cutting
  // a chunk short of the boundary it just promised.
  const limit = num(input.limit, MAX_SECTION_CHARS, MAX_SECTION_CHARS);
  const offset = Math.max(0, num(input.offset, 0, body.length) || 0);
  const chunk = body.slice(offset, offset + limit);
  const more = offset + chunk.length < body.length;
  return {
    text: `${section}${what} is ${body.length} characters of JSON, too long for one answer; these are characters ${
      offset + 1
    } to ${offset + chunk.length} of it. ${saved}${
      more
        ? ` Call portal_records again with section "${section}" and offset ${offset + chunk.length} to get the next part, and concatenate the parts in order to reconstruct the full JSON before parsing it.`
        : " This is the last part — concatenate it onto what came before, in order, to get the full JSON."
    }\n\n${chunk}`,
  };
}

// ---- the file index ------------------------------------------------------

// Postgres's LIKE takes backslash as its escape character by default. Without
// this, a search for a filename that literally contains "%" or "_" would have
// that character read as a wildcard instead of matched literally.
function likeLiteral(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

async function toolListFiles(input: Record<string, unknown>): Promise<ToolOutcome> {
  const category = text(input.category);
  const person = text(input.person);
  const search = text(input.search);
  const removed = input.removed === true;
  const limit = num(input.limit, FILES_PAGE, MAX_FILES_PAGE);

  const where = [removed ? sql`${documents.removedAt} is not null` : isNull(documents.removedAt)];
  if (category) where.push(eq(documents.category, category));
  if (person) where.push(sql`lower(${documents.person}) like ${`%${likeLiteral(person.toLowerCase())}%`}`);
  if (search) {
    const pattern = `%${likeLiteral(search.toLowerCase())}%`;
    where.push(
      or(
        sql`lower(${documents.filename}) like ${pattern}`,
        sql`lower(coalesce(${documents.title}, '')) like ${pattern}`,
      )!,
    );
  }

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(documents)
    .where(and(...where));

  const rows = await db
    .select()
    .from(documents)
    .where(and(...where))
    .orderBy(desc(documents.createdAt))
    .limit(limit);

  if (!rows.length) {
    return {
      text: `No ${removed ? "removed " : ""}files on the portal match that${
        category || person || search ? " (" + [category, person, search].filter(Boolean).join(", ") + ")" : ""
      }.`,
    };
  }

  const lines = rows.map((row) => {
    const bits = [
      row.id,
      row.filename,
      row.category,
      row.person ? `for ${row.person}` : row.bucket ? `in ${row.bucket}` : null,
      row.title && row.title !== row.filename ? `"${row.title}"` : null,
      row.qualCode ? `code ${row.qualCode}` : null,
      row.expiresOn ? `expires ${row.expiresOn}` : null,
      size(row.sizeBytes),
      row.filedOn || day(row.createdAt) ? `filed ${row.filedOn || day(row.createdAt)}` : null,
      row.uploadedBy ? `by ${row.uploadedBy}` : null,
      row.removedAt ? `REMOVED ${day(row.removedAt)}${row.removedBy ? ` by ${row.removedBy}` : ""}` : null,
    ].filter(Boolean);
    return `  ${bits.join(" · ")}`;
  });

  return {
    text: capped(
      `${total} ${removed ? "removed " : ""}${total === 1 ? "file" : "files"} match; showing ${rows.length}, newest first. The first thing on each line is the id — that is what to open a file by.\n\n${lines.join("\n")}${
        total > rows.length ? `\n\n[${total - rows.length} more match. Narrow it down, or raise the limit.]` : ""
      }`,
    ),
  };
}

// ---- what the certificates say -------------------------------------------

async function toolReadCertificates(input: Record<string, unknown>): Promise<ToolOutcome> {
  const person = text(input.person)?.toLowerCase();
  const code = text(input.code)?.toUpperCase();
  const status = text(input.status)?.toLowerCase() || "all";
  const limit = num(input.limit, CERTS_PAGE, MAX_CERTS_PAGE);

  const all = await liveCertificates();
  // Only the person can be filtered here. Which matrix item a certificate answers
  // to may have been typed in by the uploader or may only be in the reading, so
  // that filter waits until the readings are in hand.
  const matched = all.filter(
    (row) => !person || (row.person || "").toLowerCase().includes(person),
  );

  if (!matched.length) {
    return {
      text: `No certificates on file${person ? ` for anyone whose name contains "${person}"` : ""}.`,
    };
  }

  const store = readingStore();
  const read = await Promise.all(
    matched.slice(0, MAX_CERTS_PAGE).map(async (row) => ({
      row,
      reading: (await store.get(readingKey(row), { type: "json" })) as Reading | null,
    })),
  );

  const lines: string[] = [];
  let unread = 0;
  let unreadable = 0;
  let shown = 0;
  let held = 0;

  for (const { row, reading } of read) {
    const onCode = (row.qualCode || (reading?.codeConfidence !== "low" ? reading?.qualCode : null) || "").toUpperCase();
    if (code && onCode !== code) continue;

    const expires = reading?.neverExpires
      ? null
      : (row.expiresOn && row.expiresOn.trim()) || reading?.expiresOn || null;
    const away = expires ? daysAway(expires) : null;

    if (!reading) unread++;
    else if (!reading.readable) unreadable++;

    if (status === "unread" && reading) continue;
    if (status === "unreadable" && (!reading || reading.readable)) continue;
    if (status === "current" && away !== null && away < 0) continue;
    if (status === "expired" && (away === null || away >= 0)) continue;
    if (status === "expiring" && !expiringIn(away)) continue;

    held++;
    if (shown >= limit) continue;
    shown++;

    if (!reading) {
      lines.push(
        `  ${row.id} · ${row.person || "nobody named"} · ${row.filename} · NOT READ YET${
          onCode ? ` · filed against ${onCode}` : ""
        }${row.expiresOn ? ` · expiry typed in as ${row.expiresOn}` : ""}`,
      );
      continue;
    }
    if (!reading.readable) {
      lines.push(
        `  ${row.id} · ${row.person || "nobody named"} · ${row.filename} · COULD NOT BE READ${
          reading.reason ? `: ${reading.reason}` : ""
        }`,
      );
      continue;
    }

    const bits = [
      row.id,
      row.person || "nobody named",
      reading.certificateTitle || row.filename,
      reading.holderName && reading.holderName.toLowerCase() !== (row.person || "").toLowerCase()
        ? `printed name "${reading.holderName}"`
        : null,
      reading.issuer ? `issued by ${reading.issuer}` : null,
      reading.issuedOn ? `issued ${reading.issuedOn}` : null,
      reading.neverExpires ? "states it does not expire" : standing(expires),
      onCode ? `code ${onCode}${row.qualCode ? "" : ` (the model's reading, ${reading.codeConfidence || "unrated"} confidence)`}` : "no matrix code",
      reading.notes || null,
    ].filter(Boolean);
    lines.push(`  ${bits.join(" · ")}`);
  }

  if (!lines.length) {
    return {
      text: `${matched.length} certificates on file match, but none of them are ${status}.${
        unread ? ` ${unread} of them have not been read yet, so nothing is known about what they say.` : ""
      }`,
    };
  }

  const preamble = [
    `${held} ${held === 1 ? "certificate" : "certificates"} on file match${
      status === "all" ? "" : ` and are ${status}`
    }${person ? ` for a name containing "${person}"` : ""}${code ? ` under ${code}` : ""}; showing ${shown}, newest first.`,
    `Today at the vessel is ${todayThere()}. A date typed against a certificate on the portal takes precedence over the model's reading of the scan.`,
    unread ? `${unread} of the certificates matched have not been read yet — nothing is known about what they say.` : "",
    unreadable ? `${unreadable} could not be read.` : "",
    matched.length > read.length
      ? `${matched.length - read.length} further certificates are on file and were not looked at for this answer — narrow it to a person or an item.`
      : "",
    held > shown ? `${held - shown} more match than are shown here — raise the limit or narrow it down.` : "",
    "The first thing on each line is the file id — open it to look at the scan itself.",
  ]
    .filter(Boolean)
    .join(" ");

  return { text: capped(`${preamble}\n\n${lines.join("\n")}`) };
}

// ---- opening one -----------------------------------------------------------

async function toolOpenFile(input: Record<string, unknown>, reach: Reach): Promise<ToolOutcome> {
  const id = text(input.id);
  if (!id) return { text: "No file id was given, so there was nothing to open.", failed: true };

  if (reach.opened >= MAX_OPEN_FILES) {
    return {
      text: `${MAX_OPEN_FILES} documents have already been opened while answering this question, which is as many as one question may open. Answer from what you have, and say what you would still need to look at.`,
      failed: true,
    };
  }

  const [row] = await db.select().from(documents).where(eq(documents.id, id));
  if (!row) {
    return {
      text: `There is no file on the portal with the id ${id}. Ids come from the file listing — check it again.`,
      failed: true,
    };
  }

  let block: Record<string, unknown>;
  try {
    // No sheet text: the browser is what reads a workbook, and there is no
    // browser in the middle of answering a question. contentFor says so by name
    // for a spreadsheet, which is the honest answer here.
    const content = await contentFor(row, null);
    block = content.block as Record<string, unknown>;
  } catch (e) {
    const said = e instanceof Error ? e.message : String(e);
    return {
      text: `${row.filename} couldn't be opened. ${said}${
        /spreadsheet|\.xlsx|\.csv/i.test(said)
          ? " A spreadsheet cannot be looked at directly; if the portal has an analysis of this document, read that instead."
          : ""
      }`,
      failed: true,
    };
  }

  const data = ((block.source as { data?: string })?.data || "").length;
  if (reach.b64 + data > MAX_OPEN_B64) {
    return {
      text: `${row.filename} is ${size((data * 3) / 4)} and there isn't room left for it — this question has already opened ${size((reach.b64 * 3) / 4)} of documents. Answer from what you have, and say what you would still need to look at.`,
      failed: true,
    };
  }
  reach.opened++;
  reach.b64 += data;

  const about = [
    row.category === "certificate" ? `a crew certificate filed against ${row.person || "nobody"}` : row.category,
    row.title && row.title !== row.filename ? `titled "${row.title}"` : null,
    row.filedOn || day(row.createdAt) ? `filed ${row.filedOn || day(row.createdAt)}` : null,
    row.uploadedBy ? `by ${row.uploadedBy}` : null,
    row.qualCode ? `against matrix code ${row.qualCode}` : null,
    row.expiresOn ? `with an expiry typed in as ${row.expiresOn}` : null,
    row.removedAt ? `and removed from the portal on ${day(row.removedAt)}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    text: `${row.filename} is below — ${about}. Read it as the document itself rather than as anything written about it.`,
    blocks: [block],
  };
}

// ---- the analyses already made -------------------------------------------

async function toolAnalysisAnswers(input: Record<string, unknown>): Promise<ToolOutcome> {
  const which = text(input.which)?.toLowerCase();

  if (which === "certificates") {
    const worked = await certificateStanding();
    if (!worked.dates.length) {
      return {
        text: "No certificate standing has been worked out: either no certificates are on file, or none of the ones on file have been read and matched to a matrix item yet.",
      };
    }
    const lines = worked.dates
      .sort((a, b) => a.person.localeCompare(b.person) || a.code.localeCompare(b.code))
      .map(
        (d) =>
          `  ${d.person} · ${d.code} · issued ${d.issued || "not printed"} · ${
            d.expires ? standing(d.expires) : "no expiry"
          } · from file ${d.fileId || "unknown"}`,
      );
    return {
      text: capped(
        `The certificate standing — what is in force for each person and matrix item, worked out just now from the readings the portal holds. ${worked.dates.length} ${
          worked.dates.length === 1 ? "line" : "lines"
        }. Where two certificates claim the same item, the one that runs the longer is the one shown - except a medical, where the one issued last governs whatever it prints (MO76 s 16(3)), and a certificate of recognition, which holds the item and takes the earlier of its own date and the foreign certificate's (MO70 s 33(2), s 37(4)). A line can also come from a column a certificate covers rather than one of its own. Today at the vessel is ${todayThere()}.\n\n${lines.join("\n")}`,
      ),
    };
  }

  if (which === "matrices") {
    const [training, skills] = await Promise.all([
      liveSingleFileRow("training-matrix"),
      liveSingleFileRow("skills-matrix"),
    ]);
    // The validity periods are read off the skills matrix itself.
    const validity = skills;
    if (!training || !skills) {
      const missing = [training ? null : "training matrix", skills ? null : "skills matrix"].filter(Boolean);
      return {
        text: `There is no matrix check to read: the ${missing.join(" and the ")} ${
          missing.length === 1 ? "is" : "are"
        } not on the portal, and both are required. Say so rather than working around it.`,
      };
    }

    const store = matrixStore();
    const [check, readTraining, readSkills, readValidity] = (await Promise.all([
      store.get(matrixCheckKey(training.id, skills.id, validity ? validity.id : null), { type: "json" }),
      store.get(matrixReadingKey("training", training.id), { type: "json" }),
      store.get(matrixReadingKey("skills", skills.id), { type: "json" }),
      validity ? store.get(matrixReadingKey("validity", validity.id), { type: "json" }) : null,
    ])) as [Record<string, unknown> | null, MatrixReading | null, MatrixReading | null, MatrixReading | null];

    const filed = [
      `training matrix: ${training.filename}${readTraining ? `, read ${day(readTraining.at)}` : ", not read yet"}`,
      `skills matrix: ${skills.filename}${readSkills ? `, read ${day(readSkills.at)}` : ", not read yet"}`,
      validity
        ? `validity periods (off the skills matrix): ${validity.filename}${readValidity ? `, read ${day(readValidity.at)}` : ", not read yet"}`
        : "validity periods: no skills matrix on the portal, so how long items last is not known from a document",
    ];

    if (!check) {
      return {
        text: capped(
          `The documents are on the portal but no check has been made from them yet, so there is no answer to read. What is filed:\n  ${filed.join(
            "\n  ",
          )}\n\nThe check is run from the portal's own matrix pages. Say that rather than working one out yourself.${
            readTraining ? `\n\nThe training matrix as it was read:\n${JSON.stringify(readTraining.reading)}` : ""
          }${
            readSkills ? `\n\nThe skills matrix as it was read:\n${JSON.stringify(readSkills.reading)}` : ""
          }`,
        ),
      };
    }

    return {
      text: capped(
        `The training and skills matrix check, made ${day((check as { at?: unknown }).at) || "at an unknown date"}. What it was made from:\n  ${filed.join(
          "\n  ",
        )}\n\nThe answer as the portal holds it:\n${JSON.stringify(check)}`,
      ),
    };
  }

  if (which === "opms") {
    const held = (await heldOpmsAnswer()) as OpmsHeld | null;
    if (!held) {
      const sheet = await liveSingleFileRow("opms-sheet");
      return {
        text: sheet
          ? `The OPMS export (${sheet.filename}) is on the portal but no comparison has been run against it, so there is no answer to read. The comparison is run from the portal's OPMS page.`
          : "No OPMS export is on the portal and no comparison has ever been run, so there is nothing to read.",
      };
    }
    return {
      text: capped(
        `The OPMS comparison, made ${day(held.at) || "at an unknown date"} against ${held.sheet?.filename || "the export on file"}. It held the portal's own matrix and the certificates on file against the export from OPMS, which is another party's system. Of the certificates: ${held.certificates?.read ?? "?"} read, ${held.certificates?.unread ?? "?"} unread, ${held.certificates?.unreadable ?? "?"} unreadable.${
          held.truncated ? " The answer ran out of room part way, so it is the top of the comparison rather than all of it." : ""
        } Anything filed or corrected since was not part of it.\n\n${JSON.stringify(held.check)}`,
      ),
    };
  }

  if (which === "shift") {
    const sheet = await shiftSheetRow();
    if (!sheet) {
      return {
        text: "No skills matrix is on the portal, so there is no shift check to read.",
      };
    }
    const held = (await shiftStore().get(shiftKeyFor(sheet.id), { type: "json" })) as ShiftHeld | null;
    if (!held) {
      return {
        text: `The shift allocation sheet (${sheet.filename}) is on the portal but no check has been run against it. The check is run from the portal's Swings page.`,
      };
    }
    return {
      text: capped(
        `The shift allocation check, made ${day(held.at) || "at an unknown date"} against ${held.sheet?.filename || sheet.filename}. It held the crew rostered onto one swing against the office's shift allocation guideline. It was made against the crew standing as it was at the time: anyone moved on or off a swing since, and any change to the matrix, is not in it.\n\n${JSON.stringify(held.check)}`,
      ),
    };
  }

  return {
    text: 'That is not one of the analyses the portal holds. They are "certificates", "matrices", "opms" and "shift".',
    failed: true,
  };
}

/**
 * Run one tool call and hand back what to tell the model.
 *
 * Nothing is thrown. A tool that fails is a fact about the portal the model
 * should be told and can work around — the file has gone, the section isn't
 * there, the analysis was never run — not a reason to lose a question somebody
 * has been waiting on. The message says what happened in the same plain words
 * the rest of the portal uses, because the model may well end up repeating it.
 */
export async function runPortalTool(
  name: string,
  input: Record<string, unknown>,
  reach: Reach,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "portal_records":
        return await toolPortalRecords(input);
      case "list_files":
        return await toolListFiles(input);
      case "read_certificates":
        return await toolReadCertificates(input);
      case "open_file":
        return await toolOpenFile(input, reach);
      case "analysis_answers":
        return await toolAnalysisAnswers(input);
      default:
        return { text: `There is no such tool as ${name}.`, failed: true };
    }
  } catch (e) {
    console.error(`ai-checker: the ${name} tool failed:`, e);
    return {
      text: `Looking that up on the portal failed: ${
        e instanceof Error ? e.message : String(e)
      }. Answer without it, and say that this part couldn't be checked.`,
      failed: true,
    };
  }
}
