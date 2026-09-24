import { eq, and, desc, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import {
  CERT_ROOT, SINGLE_FILE_CATEGORIES, fileStore, safeName, relocateToRemovedBlob,
  tokenForOpmsFolder, personForOpmsFolder, opmsFolderName,
} from "../db/documents.js";
import { isPendingName } from "../db/single-file.js";
import { toReal } from "../files/store.js";
import { certHome, type CertHome } from "../db/cert-home.js";
import { todayThere } from "../lib/analysis.js";
import { takeLease, dropLease, leaseHolder, writingTheWorkbook } from "../lib/round.js";
import { getStore } from "../compat/blobs.js";

/**
 * Taking the folders' own contents onto the portal's books.
 *
 * The portal's storage folders are the ones the team already uses in Teams —
 * Crew Certificate Verifications, Matrix, OPMS Documents and so on (see
 * SHAREPOINT_MAP). People drop files into them by hand, and a file the portal
 * has never been told about is invisible to every screen. This walks those
 * folders, compares what is there with what the portal has on its books, and
 * says what it found:
 *
 *   GET  /api/sync   the survey — what's new, what's adoptable, whose bytes
 *                    have gone missing. Reads everything, changes nothing.
 *   POST /api/sync   the same survey, applied: new certificates are
 *                    registered (filed under the folder they sit in; the
 *                    reading pass later confirms whose they really are and
 *                    refiles any that were dropped in the wrong folder), and
 *                    a single-file document (a matrix, the OPMS sheet) is
 *                    adopted only when the portal has none and the folder
 *                    holds exactly one candidate — never guessed over a live
 *                    one.
 *
 * Files that vanish from a folder (moved or renamed by hand) are reported,
 * never auto-removed: a missing file is a question for a person.
 */

const EXT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  txt: "text/plain",
};

const typeFor = (name: string) =>
  EXT_TYPES[(name.split(".").pop() || "").toLowerCase()] || "application/octet-stream";

// The one form the portal writes a name in, worked out from the token:
// "patwardhan-anand" reads back as "PATWARDHAN, Anand", which is how the crew
// matrix writes it, so the two lists can be held against each other without a
// lookup table standing between them.
const personFrom = (folder: string) => opmsFolderName(folder);

type Found = { key: string; size?: number; modified?: string };

/* ---- which qualification expiry sheet is the newer -------------------------
 *
 * The office dates its exports on the front - "20260922 - CREW QUALIFICATION
 * EXPIRY.xlsx" - and so does the round when it files one. Where both names
 * carry a date, the later date is the newer sheet. An undated candidate
 * never outranks a dated current one: the office's undated export is
 * whatever it was last saved as, and the dated file is the one the round or
 * the office filed on purpose - an undated drop is adopted only where
 * nothing is live. Where neither carries a date, the library's own modified
 * time decides, and where that is not known either nothing outranks
 * anything: an undated export used to beat every dated one simply because
 * "C" sorts after "2", and the sync swapped the current workbook for an
 * older file on the strength of the alphabet. */
const stampOf = (key: string) => (/^(\d{8})\s*-/.exec(key.split("/").pop() || "") || [])[1] || null;

/** Whether `cand` is a newer sheet than `cur`. */
export function outranks(cand: Found, cur: Found): boolean {
  if (cand.key === cur.key) return false;
  const a = stampOf(cand.key);
  const b = stampOf(cur.key);
  if (a && b && a !== b) return a > b;
  if (!a && b) return false;
  if (cand.modified && cur.modified) return cand.modified > cur.modified;
  return false;
}

/** Newest first, by the same rule; a dated name before an undated one, and
 *  the alphabet only as a last resort between two the rule cannot tell apart. */
export function sheetOrder(a: Found, b: Found): number {
  if (outranks(a, b)) return -1;
  if (outranks(b, a)) return 1;
  const da = !!stampOf(a.key), db = !!stampOf(b.key);
  if (da !== db) return da ? -1 : 1;
  return a.key < b.key ? 1 : -1;
}

/**
 * The crew folder a filed certificate sits in, or null where it sits somewhere
 * else under the certificate location.
 *
 * One level down from that location, with the file itself below it. The old
 * "<Name> - OPMS" folders and the plain "LASTNAME, First" ones both answer;
 * the spreadsheets the office drops loose in the root do not, because they
 * have no folder of their own.
 *
 * Which location that is, is asked of Crew Details — "opms" where nobody has
 * said otherwise. Read by plain string rather than by pattern, because a
 * folder the office named is free to hold spaces, commas and brackets, and
 * none of those may be let loose in an expression.
 */
export function crewFolderIn(home: string) {
  const at = home.toLowerCase() + "/";
  return (key: string): string | null => {
    if (!key.toLowerCase().startsWith(at)) return null;
    const rest = key.slice(at.length);
    const cut = rest.indexOf("/");
    return cut > 0 && rest.indexOf("/", cut + 1) < 0 ? rest.slice(0, cut) : null;
  };
}

/** A file sitting loose in the certificate location, with no folder of its
 *  own — which is how the office drops the qualification expiry sheet in. */
export const looseIn = (home: string) => {
  const at = home.toLowerCase() + "/";
  return (key: string) => key.toLowerCase().startsWith(at) && !key.slice(at.length).includes("/");
};

/**
 * Whose folder this is.
 *
 * Crew Details first: where somebody has been pointed at this folder by hand,
 * that is the answer and there is nothing to work out. The office named the
 * folder "Kyle" and somebody said which Kyle, once, and it stays said.
 *
 * Only where nobody has said is the name read for a man's name, which is what
 * the portal did on its own before it could be told.
 */
export function whoseFolder(where: CertHome, folderKey: string, folderName: string) {
  const said = where.manIn(folderKey);
  return said
    ? { token: said.token, person: said.person }
    : { token: tokenForOpmsFolder(folderName), person: personForOpmsFolder(folderName) };
}

export async function survey(tick: (pct: number, word: string) => Promise<void> = async () => {}) {
  const store = fileStore();
  const rows = await db.select().from(documents);
  const known = new Set(rows.map((r) => r.blobKey));
  const liveByCategory = new Map<string, number>();
  rows.forEach((r) => {
    if (!r.removedAt) liveByCategory.set(r.category, (liveByCategory.get(r.category) || 0) + 1);
  });

  const singleFolders = Object.values(SINGLE_FILE_CATEGORIES).map((c) => c.folder + "/");

  /* --- the certificates' one home: a folder per person under OPMS ---------
   *
   * The office's folders were "<First name> - OPMS" - Alan - OPMS, Bob -
   * OPMS. They are being renamed to the person's own name and nothing else,
   * because the folder already sits inside OPMS Documents and saying it twice
   * told nobody anything.
   *
   * Both are read. A folder is a crew folder if it sits directly under the
   * OPMS root and holds files; the suffix is stripped where it is there and
   * not looked for where it is not, so the library can be half renamed and
   * every certificate in it still finds its way onto the books. */
  const newCertificates: { key: string; folder: string; person: string; size?: number }[] = [];
  // The certificate home: where the office keeps each person's certificates
  // up to date, and where the portal's own uploads now land. Many of these
  // files are already on the books from the old certification folders — the
  // same name and size against the same person is the same certificate, and
  // is left alone rather than taken on twice.
  /* Where to walk, and whose is whose — both as Crew Details has them. The
     certificate location is walked, and so is any folder somebody has been
     pointed at that sits outside it, because a man assigned a folder the walk
     never reaches would have been assigned nothing at all. */
  const where = await certHome();
  const crewFolderOf = crewFolderIn(where.home);
  const outside = where.assigned.filter((a) => !crewFolderOf(a.key + "/x"));
  await tick(20, `Walking the crew folders in ${where.home}`);
  /* The home itself is looked for before it is walked. A folder the
     library answers 404 to lists as empty, which is right for a man's
     folder that has not been made yet and catastrophically wrong for the
     home: an empty home is every certificate missing at once, and a home
     renamed in the library is exactly how the sync could come to write
     the crew's certificates off in one pass. So a home that is not there
     stops the survey here, with the folder named and nothing marked. The
     R2 driver has no folders and always answers yes. */
  if (!(await store.hasFolder(where.home))) {
    throw new Error(`the folder ${toReal(where.home + "/").replace(/\/+$/, "")} is not in the library`);
  }
  const opmsListing = await store.list({ prefix: where.home + "/" });
  /* The files in an assigned folder of its own. Everything directly inside it
     is his — the folder was named as his, so nothing in it has to be read for
     a name. */
  const apart: { key: string; size?: number; man: (typeof where.assigned)[number] }[] = [];
  for (const a of outside) {
    const under = a.key + "/";
    /* The same for a man's folder outside the home as for the home itself,
       once anything is on the books under it: a folder the library answers
       404 to lists as empty, and empty against his rows is every one of
       his certificates missing - a man's ten or twenty are always under
       the guard, so they would come off the books with their readings.
       A folder with nothing under it yet is allowed not to exist. */
    if (rows.some((r) => !r.removedAt && r.blobKey.startsWith(under)) && !(await store.hasFolder(a.key))) {
      throw new Error(`the folder ${toReal(under).replace(/\/+$/, "")} is not in the library`);
    }
    const listing = await store.list({ prefix: under });
    for (const f of listing.blobs) {
      if (f.key.slice(a.key.length + 1).includes("/")) continue;
      apart.push({ key: f.key, size: f.size, man: a });
    }
  }
  const rowsByToken = new Map<string, { id: string; key: string; name: string; size: number }[]>();
  rows.forEach((r) => {
    if (r.removedAt) return;
    const list = rowsByToken.get(r.folder || "") || [];
    list.push({ id: r.id, key: r.blobKey, name: (r.filename || "").toLowerCase(), size: r.sizeBytes ?? -1 });
    rowsByToken.set(r.folder || "", list);
  });
  /* Whose folders the office keeps, whether or not anything in them is new.
     A folder is how SharePoint says a person is on the strength; the portal
     compares this against its own crew list, and asks about the difference
     rather than acting on it. */
  /* The OPMS sheet's own folder sits one level under the home, exactly
     where a crew folder does, and it is nobody's: a file in it is a single
     document, taken below, not a certificate of somebody called
     SPREADSHEET. Case-folded like crewFolderIn: the walk's keys carry
     the folder name as the office spelt it, and "Spreadsheet" is the same
     folder as "spreadsheet". */
  const lowerSingles = singleFolders.map((p) => p.toLowerCase());
  const inSingleFolder = (key: string) => {
    const k = key.toLowerCase();
    return lowerSingles.some((p) => k.startsWith(p));
  };
  const folks = new Map<string, string>();
  for (const f of opmsListing.blobs) {
    if (inSingleFolder(f.key)) continue;
    const who = crewFolderOf(f.key);
    if (!who) continue;
    const { token, person } = whoseFolder(where, `${where.home}/${who}`, who);
    folks.set(token, person);
  }
  for (const a of apart) folks.set(a.man.token, a.man.person);

  /* A certificate that has moved rather than arrived.
   *
   * The office renaming a folder, or clearing the library and putting
   * everything back, gives the same file a new address. On name and size
   * against the same person it is the same certificate, so it is not taken on
   * twice - but the books have to be re-pointed at where it actually is, or
   * the record goes on naming a file that is no longer there and the scan
   * stops opening. */
  const moved: { id: string; from: string; to: string }[] = [];

  const take = (key: string, size: number | undefined, token: string, person: string) => {
    if (known.has(key)) return;
    const name = safeName(key.split("/").pop() || "").toLowerCase();
    const twin = (rowsByToken.get(token) || [])
      .find((r) => r.name === name && r.size === (size ?? -2));
    if (twin) {
      if (twin.key !== key && !moved.some((x) => x.id === twin.id)) {
        moved.push({ id: twin.id, from: twin.key, to: key });
      }
      return;
    }
    newCertificates.push({ key, folder: token, person, size });
  };

  for (const f of opmsListing.blobs) {
    if (inSingleFolder(f.key)) continue;
    const m = crewFolderOf(f.key);
    if (!m) continue;
    const { token, person } = whoseFolder(where, `${where.home}/${m}`, m);
    take(f.key, f.size, token, person);
  }
  for (const a of apart) take(a.key, a.size, a.man.token, a.man.person);

  // The office drops the crew qualification expiry spreadsheet loose in OPMS
  // Documents; the newest one there is the training matrix to hold.
  // Never a replace's pending copy: a round cut off mid-replace leaves one
  // loose, and it is the newest file in the folder.
  const loose = looseIn(where.home);
  const sheetCandidates = opmsListing.blobs
    .filter((f) => loose(f.key) && /qualification\s*expiry/i.test(f.key) && !isPendingName(f.key));
  sheetCandidates.sort(sheetOrder);
  const trainingSheet = sheetCandidates[0] || null;
  // Every loose sheet the listing showed, with when the library last touched
  // it, so the current one's own modified time is to hand when it is weighed.
  const sheetSeen: Record<string, Found> = {};
  sheetCandidates.forEach((f) => { sheetSeen[f.key] = f; });

  // --- the single-file documents ------------------------------------------
  await tick(55, "Certificates read — checking the single documents");
  const singles: Record<
    string,
    { label: string; live: boolean; found: Found[]; adoptable: boolean }
  > = {};
  let nthSingle = 0;
  const nSingles = Object.keys(SINGLE_FILE_CATEGORIES).length;
  for (const [category, def] of Object.entries(SINGLE_FILE_CATEGORIES)) {
    await tick(55 + Math.round(28 * (++nthSingle) / nSingles), `Checking ${def.label}`);
    const listing = await store.list({ prefix: def.folder + "/" });
    const found = listing.blobs.filter((f) => !known.has(f.key));
    const live = (liveByCategory.get(category) || 0) > 0;
    singles[category] = {
      label: def.label,
      live,
      found,
      // Adopted only where nothing can be trampled: the portal holds none,
      // and there is exactly one candidate to take.
      adoptable: !live && found.length === 1,
    };
  }

  // --- live files whose bytes are gone from the folders --------------------
  await tick(88, "Comparing the folders with the portal's books");
  const scannedPrefixes = [where.home + "/", ...outside.map((a) => a.key + "/"), ...singleFolders];
  const seen = new Set([
    ...opmsListing.blobs.map((f) => f.key),
    ...apart.map((a) => a.key),
    ...Object.values(singles).flatMap((s) => s.found.map((f) => f.key)),
  ]);
  // The singles listings above only kept unknown keys; list the known ones too.
  for (const def of Object.values(SINGLE_FILE_CATEGORIES)) {
    (await store.list({ prefix: def.folder + "/" })).blobs.forEach((f) => seen.add(f.key));
  }
  const followed = new Set(moved.map((m) => m.from));
  const missing = rows
    .filter((r) => !r.removedAt && scannedPrefixes.some((p) => r.blobKey.startsWith(p)))
    .filter((r) => !seen.has(r.blobKey) && !followed.has(r.blobKey))
    .map((r) => ({ id: r.id, key: r.blobKey, filename: r.filename, category: r.category, checksum: r.checksum }));

  /* Rows the books wrote off whose file the library plainly still holds.
   *
   * On 22 Sep one sync run got a bad view of the library and wrote off 791
   * certificates and all three workbooks in a single pass — and because a
   * written-off row's key still counted as "known", the next sync saw the
   * file, said nothing, and the row stayed off the books for ever. A file the
   * listing can see is not missing, whatever the books say, so its row comes
   * back. A row somebody removed through the portal can never match here: its
   * bytes were parked under removed/ when it went, and nothing under
   * removed/ is ever in this listing.
   *
   * Except the office's own file, which is never parked. The round replaces
   * the office's adopted workbook by writing its own beside it and marking
   * the office's row removed, kept in place - the bytes stay exactly where
   * the office put them, and so stay in this listing. That row is off the
   * books on purpose, and reviving it every hour put two workbooks live. */
  const liveKeys = new Set(rows.filter((r) => !r.removedAt).map((r) => r.blobKey));
  const returned = rows
    .filter((r) => r.removedAt && seen.has(r.blobKey) && !r.keptInPlace)
    /* Not where a live row already holds the same address. A file wiped and
       re-uploaded has two rows pointing at one address — the old removed one
       and the new live one — and reviving the old row would put the same file
       on the books twice, which the first run of this did. One address, one
       live row. */
    .filter((r) => !liveKeys.has(r.blobKey))
    .map((r) => ({ id: r.id, key: r.blobKey, filename: r.filename, category: r.category }));

  // How much of the books the scan actually covered, for the guard below.
  const scannedLive = rows.filter(
    (r) => !r.removedAt && scannedPrefixes.some((p) => r.blobKey.startsWith(p)),
  ).length;

  const people = [...folks.entries()].map(([folder, name]) => ({ folder, name })).sort((a, b) => a.name.localeCompare(b.name));
  return { newCertificates, singles, missing, returned, scannedLive, moved, trainingSheet, sheetSeen, people };
}

/** What the last applied sync did — shown on the SharePoint page. */
export type SyncRecord = {
  at: number;
  by: string;
  registered: number;
  adopted: number;
  missing: number;
  leftAlone: number;
  /** The missing count when it was too many to act on (the guard in
   *  apply), else 0. Not an error: the run registered and adopted as
   *  normal and only held the write-off, so the page says it beside the
   *  missing count and a person goes and looks at the library. */
  heldBack: number;
  error: string | null;
};

const record = (r: SyncRecord) => getStore("sync").setJSON("last-run", r);

/* The sync's own running commentary, written as it works so the page's
   progress window can read percentages off it while the POST is held open. */
async function sayProgress(pct: number, word: string, extra: Record<string, unknown> = {}) {
  try {
    await getStore("sync").setJSON("progress", { pct: Math.round(pct), word, done: false, at: Date.now(), ...extra });
  } catch (e) {
    console.error("sync progress not written:", e);
  }
}
export const syncProgress = () => getStore("sync").get("progress", { type: "json" });

export const lastSync = () => getStore("sync").get("last-run", { type: "json" }) as Promise<SyncRecord | null>;

/**
 * What the hourly round last did on the worker, whole: the folders read,
 * then the certificates read and refiled — and the error if any part fell
 * over. Written every hour whatever happened, so the SharePoint page can
 * say when the round last ran and whether it worked, instead of a failure
 * going into a log nobody reads.
 */
export type HourlyRecord = {
  at: number;
  durationMs: number;
  /** Who ran it: absent for the hour itself, the person's name when the
   *  round was started from the page (routes/round.ts). */
  by?: string;
  read: number;
  refiled: number;
  syncError: string | null;
  /** Why the reading cannot go on until a person acts: the account is out
   *  of credit, or its key was refused. Shown in red. */
  readError: string | null;
  /** Why the reading stopped early this hour on its own account - the
   *  model busy or over its rate - and will try again next hour. An aside,
   *  not an error. */
  readStopped?: string | null;
  /** Whether the hour put certificates to the model at all. An hour that
   *  did, and ends with no readError, is the account in order; one that
   *  stood down for a held lease or had nothing to read says nothing
   *  about the account, and the page's red line stays up on it. */
  readTried?: boolean;
  // The round's own outcome (lib/round.ts), spread in when it ran.
  applied?: number;
  cleared?: number;
  settled?: number;
  written?: number | null;
  workbook?: string | null;
  workbookId?: string | null;
  leftAsTyped?: number;
  held?: string | null;
  roundError?: string | null;
  /** Why the tab should run the round itself: the round did not run, or
   *  its workbook step cannot be done on the server (workbookProblem is
   *  copied here, since an open tab reads only this and roundError). */
  roundSkipped?: string | null;
  workbookProblem?: string | null;
  validityProblem?: string | null;
  /** Why the Equivalence sheet could not be kept off the skills matrix. */
  equivalenceProblem?: string | null;
};
export const recordHourly = (r: HourlyRecord) => getStore("sync").setJSON("last-hourly", r);
export const lastHourly = () => getStore("sync").get("last-hourly", { type: "json" }) as Promise<HourlyRecord | null>;

/**
 * The survey applied, by whoever asked — the hourly schedule or the Sync now
 * button — and the outcome written down either way, a failure included, so
 * the SharePoint page can always say when the folders were last read.
 */
export async function runSync(by: string) {
  const at = Date.now();
  try {
    await sayProgress(2, "Asking SharePoint for the folders");
    const out = await apply(await survey(sayProgress), sayProgress);
    await record({
      at,
      by,
      registered: out.registered.length,
      adopted: out.adopted.length,
      missing: out.missing.length,
      leftAlone: out.leftAlone.length,
      heldBack: out.heldBack,
      error: null,
    });
    await sayProgress(100, "Done", { done: true });
    return out;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await record({ at, by, registered: 0, adopted: 0, missing: 0, leftAlone: 0, heldBack: 0, error });
    await sayProgress(100, "Failed", { done: true, error });
    throw e;
  }
}

export default async (req: Request, by = "Import new files") => {
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    if (req.method === "GET") {
      const result = await survey();
      return Response.json(
        { ...result, note: "Survey only — POST /api/sync to take these onto the portal's books." },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // The page says which button asked — Import new files, Update portal or
    // the round on the hour — so the SharePoint page's "last read" line
    // names a button that exists.
    let who = by;
    const sent = await req.json().catch(() => null) as { by?: unknown } | null;
    if (sent && typeof sent.by === "string" && sent.by.trim()) who = sent.by.trim().slice(0, 40);
    // The sync can swap the workbook, so it takes the one lease the hour
    // and the upload take, for its own turn - never two writers at once.
    const lease = await takeLease(who);
    if (!lease) {
      // Names the holder - the hour or a person's round - and promises no
      // time: the same sentence every writer of the workbook answers with,
      // and the holder's name beside it (`by`), as POST /api/round answers.
      const holder = await leaseHolder();
      return Response.json({ error: writingTheWorkbook(holder), by: holder }, { status: 409 });
    }
    try {
      return Response.json(await runSync(who));
    } finally {
      // The sync is done by now and its record written. A drop that fails
      // must not turn that into a 502 - the lease runs out on its own after
      // LEASE_MS.
      try {
        await dropLease(lease.token);
      } catch (e) {
        console.error("the sync's lease was not dropped:", e);
      }
    }
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
};

export async function apply(
  result: Awaited<ReturnType<typeof survey>>,
  tick: (pct: number, word: string) => Promise<void> = async () => {},
) {
  const today = todayThere();

  /* Files that turned up under a new address first, before anything is taken
     on: the office renaming a folder, or clearing the library and putting it
     all back, moves every file it holds. The record follows the file. Done
     before the registering so a certificate cannot be filed twice - once at
     its new address and once still pointing at the old one. */
  for (const m of result.moved) {
    await db.update(documents).set({ blobKey: m.to }).where(eq(documents.id, m.id));
  }

  /* A file deleted in SharePoint comes off the portal's books.
   *
   * SharePoint holds the documents; the portal holds an account of them. The
   * two saying different things is the whole problem - a certificate deleted
   * from the library went on being listed here, openable from a link that led
   * nowhere, and a crew member who had been taken off still had their papers
   * on the screen. Whoever deleted the file meant it to be gone.
   *
   * The row is marked removed rather than destroyed, which is what the Admin
   * tab restores from, so a deletion made by mistake in the library is undone
   * on the portal in one press. The bytes are not touched: there are none
   * left to touch.
   *
   * The listing having failed is not the same as the files having gone. A
   * Graph error throws out of the survey long before this, so reaching here
   * at all means the library answered and the file was genuinely not in it. */
  /* First, anything written off in error comes back. The file is in the
     listing, so the row is simply un-removed — same bytes, same history, same
     reading where one survives. */
  let returned = 0;
  for (const r of result.returned) {
    await db
      .update(documents)
      .set({ removedAt: null, removedBy: null })
      .where(eq(documents.id, r.id));
    returned++;
  }

  /* One address, one live row.
   *
   * The first run of the resurrection revived rows for files that had been
   * wiped and re-uploaded — the old row and the new both live, pointing at
   * the same file, so the same certificate counted twice. Whichever row
   * carries a reading is the one kept (it is the row the portal knows most
   * about); ties go to the newer. The other goes back to removed, which is
   * where it was. */
  let deduped = 0;
  const live = await db.select().from(documents).where(isNull(documents.removedAt));
  {
    const byKey = new Map<string, typeof live>();
    for (const r of live) {
      byKey.set(r.blobKey, [...(byKey.get(r.blobKey) || []), r]);
    }
    const at = new Date();
    for (const [, twins] of byKey) {
      if (twins.length < 2) continue;
      const readOf = (r: (typeof live)[number]) =>
        ((r as { readAt?: number | null }).readAt ? 2 : 0) + (r.createdAt ? 1 : 0);
      const keep = [...twins].sort((a, b) =>
        readOf(b) - readOf(a) || Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))[0];
      for (const r of twins) {
        if (r.id === keep.id) continue;
        await db
          .update(documents)
          .set({ removedAt: at, removedBy: "the same file is already on the books" })
          .where(eq(documents.id, r.id));
        deduped++;
      }
    }
  }

  /* And the mirroring is held back when the shortfall is not believable.
   *
   * The same guard the crew list has had all along: one or two files gone is
   * a file gone, but hundreds unaccounted for in one pass is a listing that
   * went wrong — a renamed root, a translation slip, Graph having a bad
   * morning — and acting on it is how 791 certificates went off the books in
   * one run on 22 Sep. Nothing is mirrored off in that case; the count is
   * reported and a human looks. */
  const holdBack = result.missing.length > Math.max(25, Math.round(0.1 * (result.scannedLive || 0)));

  let mirrored = 0;
  if (result.missing.length && !holdBack) {
    const at = new Date();
    const readings = getStore({ name: "certificate-readings", consistency: "strong" });
    for (const m of result.missing) {
      await db
        .update(documents)
        .set({ removedAt: at, removedBy: "SharePoint sync" })
        .where(eq(documents.id, m.id));
      /* And what the portal read off the file goes with it. The reading holds
         the expiry, the issuer and the name printed on the certificate - it is
         not the document, but it is out of the document, and a deletion that
         left it sitting here would be the portal quietly keeping its own copy
         of what the library had been told to forget. */
      try {
        await readings.delete("r1/" + (m.checksum || m.id) + ".json");
      } catch (e) {
        // A reading that was never made, or already gone. Nothing to undo.
      }
      mirrored++;
    }
  }

  const registered: { id: string; key: string; person: string }[] = [];
  let taken = 0;
  for (const c of result.newCertificates) {
    await tick(90 + Math.round(9 * (++taken) / result.newCertificates.length), `Taking on ${c.key.split("/").pop()}`);
    const id = crypto.randomUUID();
    await db.insert(documents).values({
      id,
      category: "certificate",
      bucket: c.folder,
      blobKey: c.key,
      filename: safeName(c.key.split("/").pop() || "certificate"),
      contentType: typeFor(c.key),
      sizeBytes: c.size ?? 0,
      uploadedBy: "SharePoint sync",
      filedOn: today,
      person: c.person,
      folder: c.folder,
    });
    registered.push({ id, key: c.key, person: c.person });
  }

  // The newest qualification-expiry sheet replaces the training matrix when a
  // newer one has been dropped in (outranks, above: the date on the front,
  // then the library's modified time) and stands as it the first time. A
  // file taken from the folder is the office's: it is marked so, and never
  // moved by the portal afterwards.
  let sheetTaken: { key: string } | null = null;
  // A file already live on the books, under any category, is nobody's
  // candidate: it is the workbook, or it is somebody else's document.
  const liveKeys = new Set(live.map((r) => r.blobKey));
  if (result.trainingSheet && !liveKeys.has(result.trainingSheet.key)) {
    const cand = result.trainingSheet;
    const candName = safeName(cand.key.split("/").pop() || "");
    /* Every live row, newest first. There should be one; the candidate is
       weighed against the newest, and if it wins every one of them steps
       down - a swap that stepped down only the newest left an older twin
       live beside the new one. */
    const current = await db
      .select()
      .from(documents)
      .where(and(eq(documents.category, "training-matrix"), isNull(documents.removedAt)))
      .orderBy(desc(documents.createdAt));
    const cur = current[0];
    /* The current one as the listing saw it - or, where the listing did not
       (a workbook still filed under the old matrices/training address), as
       old as the day it was filed, so a newer drop can still take over. */
    const curSeen: Found = cur
      ? (result.sheetSeen[cur.blobKey] || { key: cur.blobKey, modified: cur.createdAt ? new Date(cur.createdAt).toISOString() : undefined })
      : { key: "" };
    if (!cur || outranks(cand, curSeen)) {
      for (const old of current) {
        /* The portal's own dated copy is parked flat, the way a replace parks
           it; a file the office put in the folder stays exactly where it is. */
        const theirs = !!old.adoptedFromFolder;
        const blobKey = theirs ? old.blobKey : await relocateToRemovedBlob(old);
        await db
          .update(documents)
          .set({ removedAt: new Date(), removedBy: "SharePoint sync", blobKey, keptInPlace: theirs ? 1 : null })
          .where(eq(documents.id, old.id));
      }
      await db.insert(documents).values({
        id: crypto.randomUUID(),
        category: "training-matrix",
        blobKey: cand.key,
        filename: candName,
        contentType: typeFor(candName),
        sizeBytes: cand.size ?? 0,
        uploadedBy: "SharePoint sync",
        filedOn: todayThere(),
        adoptedFromFolder: 1,
      });
      sheetTaken = { key: cand.key };
    }
  }

  const adopted: { category: string; key: string }[] = [];
  for (const [category, s] of Object.entries(result.singles)) {
    if (category === "training-matrix" && sheetTaken) continue;
    if (!s.adoptable) continue;
    const f = s.found[0];
    await db.insert(documents).values({
      id: crypto.randomUUID(),
      category,
      blobKey: f.key,
      filename: safeName(f.key.split("/").pop() || "document"),
      contentType: typeFor(f.key),
      sizeBytes: f.size ?? 0,
      uploadedBy: "SharePoint sync",
      filedOn: today,
      // Taken from the folder the office put it in: theirs, never moved.
      adoptedFromFolder: 1,
    });
    adopted.push({ category, key: f.key });
  }

  return {
    registered,
    adopted: sheetTaken ? [...adopted, { category: "training-matrix", key: sheetTaken.key }] : adopted,
    missing: result.missing,
    // Files that turned up somewhere else, with the books now pointing at them.
    followed: result.moved.length,
    // And files the library no longer holds, now off the books as well.
    mirrored,
    // Files written off in error whose bytes the library plainly still holds,
    // back on the books as the rows they always were.
    returned,
    // Missing files NOT written off, because the shortfall was too big to be
    // anything but a listing gone wrong. A human reads this number.
    heldBack: holdBack ? result.missing.length : 0,
    // Whose folders SharePoint keeps. The portal compares this with its own
    // crew list and asks; nobody is added or taken off out here.
    people: result.people,
    leftAlone: Object.entries(result.singles)
      .filter(([, s]) => s.found.length && !s.adoptable)
      .map(([category, s]) => ({
        category,
        label: s.label,
        found: s.found.map((f) => f.key),
        why: s.live
          ? "a current one is already on the portal — replace it through the portal if this newer file should take over"
          : "more than one candidate — upload the right one through the portal",
      })),
  };
}
