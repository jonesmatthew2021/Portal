import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { CERT_ROOT, SINGLE_FILE_CATEGORIES, fileStore, safeName, tokenForOpmsFolder } from "../db/documents.js";
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

// "patwardhan-anand" reads back as "Patwardhan Anand" — a guess for the
// listing, and the certificate reading pass settles the real name later.
const personFrom = (folder: string) =>
  folder
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

type Found = { key: string; size?: number };

async function survey(tick: (pct: number, word: string) => Promise<void> = async () => {}) {
  const store = fileStore();
  const rows = await db.select().from(documents);
  const known = new Set(rows.map((r) => r.blobKey));
  const liveByCategory = new Map<string, number>();
  rows.forEach((r) => {
    if (!r.removedAt) liveByCategory.set(r.category, (liveByCategory.get(r.category) || 0) + 1);
  });

  const singleFolders = Object.values(SINGLE_FILE_CATEGORIES).map((c) => c.folder + "/");

  // --- the certificates' one home: the "<Name> - OPMS" folders ------------
  const newCertificates: { key: string; folder: string; person: string; size?: number }[] = [];
  const strays: Found[] = [];
  // The certificate home: where the office keeps each person's certificates
  // up to date, and where the portal's own uploads now land. Many of these
  // files are already on the books from the old certification folders — the
  // same name and size against the same person is the same certificate, and
  // is left alone rather than taken on twice.
  await tick(20, "Walking the OPMS person folders");
  const opmsListing = await store.list({ prefix: "opms/" });
  const rowsByToken = new Map<string, { name: string; size: number }[]>();
  rows.forEach((r) => {
    if (r.removedAt) return;
    const list = rowsByToken.get(r.folder || "") || [];
    list.push({ name: (r.filename || "").toLowerCase(), size: r.sizeBytes ?? -1 });
    rowsByToken.set(r.folder || "", list);
  });
  /* Whose folders the office keeps, whether or not anything in them is new.
     A folder is how SharePoint says a person is on the strength; the portal
     compares this against its own crew list, and asks about the difference
     rather than acting on it. */
  const folks = new Map<string, string>();
  for (const f of opmsListing.blobs) {
    const who = /^opms\/([^/]+ - OPMS)\//i.exec(f.key);
    if (who) folks.set(tokenForOpmsFolder(who[1]), personFrom(tokenForOpmsFolder(who[1])));
  }

  for (const f of opmsListing.blobs) {
    if (known.has(f.key)) continue;
    const m = /^opms\/([^/]+ - OPMS)\//i.exec(f.key);
    if (!m) continue;
    const token = tokenForOpmsFolder(m[1]);
    const name = safeName(f.key.split("/").pop() || "").toLowerCase();
    const twin = (rowsByToken.get(token) || []).some((r) => r.name === name && r.size === (f.size ?? -2));
    if (twin) continue;
    newCertificates.push({ key: f.key, folder: token, person: personFrom(token), size: f.size });
  }

  // The office drops the crew qualification expiry spreadsheet loose in OPMS
  // Documents; the newest one there is the training matrix to hold.
  const sheetCandidates = opmsListing.blobs
    .filter((f) => /^opms\/[^/]+$/.test(f.key) && /qualification\s*expiry/i.test(f.key));
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
  const scannedPrefixes = ["opms/", ...singleFolders];
  const seen = new Set([
    ...opmsListing.blobs.map((f) => f.key),
    ...Object.values(singles).flatMap((s) => s.found.map((f) => f.key)),
  ]);
  // The singles listings above only kept unknown keys; list the known ones too.
  for (const def of Object.values(SINGLE_FILE_CATEGORIES)) {
    (await store.list({ prefix: def.folder + "/" })).blobs.forEach((f) => seen.add(f.key));
  }
  const missing = rows
    .filter((r) => !r.removedAt && scannedPrefixes.some((p) => r.blobKey.startsWith(p)))
    .filter((r) => !seen.has(r.blobKey))
    .map((r) => ({ id: r.id, key: r.blobKey, filename: r.filename, category: r.category }));

  const people = [...folks.entries()].map(([folder, name]) => ({ folder, name })).sort((a, b) => a.name.localeCompare(b.name));
  return { newCertificates, singles, strays, missing, trainingSheet, people };
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
