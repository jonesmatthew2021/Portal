import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import {
  CERT_ROOT, SINGLE_FILE_CATEGORIES, fileStore, safeName,
  tokenForOpmsFolder, personForOpmsFolder, opmsFolderName,
} from "../db/documents.js";
import { certHome, type CertHome } from "../db/cert-home.js";
import { todayThere } from "../lib/analysis.js";
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

type Found = { key: string; size?: number };

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

async function survey(tick: (pct: number, word: string) => Promise<void> = async () => {}) {
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
   * The office's folders were "<First name> - OPMS" - Brenton - OPMS, Evan -
   * OPMS. They are being renamed to the person's own name and nothing else,
   * because the folder already sits inside OPMS Documents and saying it twice
   * told nobody anything.
   *
   * Both are read. A folder is a crew folder if it sits directly under the
   * OPMS root and holds files; the suffix is stripped where it is there and
   * not looked for where it is not, so the library can be half renamed and
   * every certificate in it still finds its way onto the books. */
  const newCertificates: { key: string; folder: string; person: string; size?: number }[] = [];
  const strays: Found[] = [];
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
  const opmsListing = await store.list({ prefix: where.home + "/" });
  /* The files in an assigned folder of its own. Everything directly inside it
     is his — the folder was named as his, so nothing in it has to be read for
     a name. */
  const apart: { key: string; size?: number; man: (typeof where.assigned)[number] }[] = [];
  for (const a of outside) {
    const listing = await store.list({ prefix: a.key + "/" });
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
  const folks = new Map<string, string>();
  for (const f of opmsListing.blobs) {
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
    const m = crewFolderOf(f.key);
    if (!m) continue;
    const { token, person } = whoseFolder(where, `${where.home}/${m}`, m);
    take(f.key, f.size, token, person);
  }
  for (const a of apart) take(a.key, a.size, a.man.token, a.man.person);

  // The office drops the crew qualification expiry spreadsheet loose in OPMS
  // Documents; the newest one there is the training matrix to hold.
  const loose = looseIn(where.home);
  const sheetCandidates = opmsListing.blobs
    .filter((f) => loose(f.key) && /qualification\s*expiry/i.test(f.key));
  sheetCandidates.sort((a, b) => (a.key < b.key ? 1 : -1));
  const trainingSheet = sheetCandidates[0] || null;

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

  const people = [...folks.entries()].map(([folder, name]) => ({ folder, name })).sort((a, b) => a.name.localeCompare(b.name));
  return { newCertificates, singles, strays, missing, moved, trainingSheet, people };
}

/** What the last applied sync did — shown on the SharePoint page. */
export type SyncRecord = {
  at: number;
  by: string;
  registered: number;
  adopted: number;
  strays: number;
  missing: number;
  leftAlone: number;
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
      strays: out.strays.length,
      missing: out.missing.length,
      leftAlone: out.leftAlone.length,
      error: null,
    });
    await sayProgress(100, "Done", { done: true });
    return out;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await record({ at, by, registered: 0, adopted: 0, strays: 0, missing: 0, leftAlone: 0, error });
    await sayProgress(100, "Failed", { done: true, error });
    throw e;
  }
}

export default async (req: Request, by = "Sync now") => {
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
    return Response.json(await runSync(by));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
};

async function apply(
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
  let mirrored = 0;
  if (result.missing.length) {
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
  // newer one has been dropped in — dated filenames make newest a plain
  // comparison — and stands as it the first time.
  let sheetTaken: { key: string } | null = null;
  if (result.trainingSheet) {
    const cand = result.trainingSheet;
    const candName = safeName(cand.key.split("/").pop() || "");
    const [cur] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.category, "training-matrix"), isNull(documents.removedAt)));
    if (!cur || (cur.blobKey !== cand.key && candName > cur.filename)) {
      if (cur) {
        await db
          .update(documents)
          .set({ removedAt: new Date(), removedBy: "SharePoint sync" })
          .where(eq(documents.id, cur.id));
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
    });
    adopted.push({ category, key: f.key });
  }

  return {
    registered,
    adopted: sheetTaken ? [...adopted, { category: "training-matrix", key: sheetTaken.key }] : adopted,
    strays: result.strays,
    missing: result.missing,
    // Files that turned up somewhere else, with the books now pointing at them.
    followed: result.moved.length,
    // And files the library no longer holds, now off the books as well.
    mirrored,
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
