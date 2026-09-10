import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { CERT_ROOT, SINGLE_FILE_CATEGORIES, fileStore, safeName } from "../db/documents.js";
import { todayThere } from "../lib/analysis.js";

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

async function survey() {
  const store = fileStore();
  const rows = await db.select().from(documents);
  const known = new Set(rows.map((r) => r.blobKey));
  const liveByCategory = new Map<string, number>();
  rows.forEach((r) => {
    if (!r.removedAt) liveByCategory.set(r.category, (liveByCategory.get(r.category) || 0) + 1);
  });

  const singleFolders = Object.values(SINGLE_FILE_CATEGORIES).map((c) => c.folder + "/");

  // --- certificates: every file under certification/<folder>/ ------------
  const certListing = await store.list({ prefix: `${CERT_ROOT}/` });
  const newCertificates: { key: string; folder: string; person: string; size?: number }[] = [];
  const strays: Found[] = [];
  for (const f of certListing.blobs) {
    if (known.has(f.key)) continue;
    if (singleFolders.some((s) => f.key.startsWith(s))) continue;
    const parts = f.key.split("/");
    if (parts.length < 3) {
      // A file sitting loose in the root of the certificates folder belongs
      // to nobody the portal can name — reported, not guessed at.
      strays.push(f);
      continue;
    }
    const folder = parts[1];
    newCertificates.push({ key: f.key, folder, person: personFrom(folder), size: f.size });
  }

  // --- the single-file documents ------------------------------------------
  const singles: Record<
    string,
    { label: string; live: boolean; found: Found[]; adoptable: boolean }
  > = {};
  for (const [category, def] of Object.entries(SINGLE_FILE_CATEGORIES)) {
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
  const scannedPrefixes = [`${CERT_ROOT}/`, ...singleFolders];
  const seen = new Set([
    ...certListing.blobs.map((f) => f.key),
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

  return { newCertificates, singles, strays, missing };
}

export default async (req: Request) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let result;
  try {
    result = await survey();
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }

  if (req.method === "GET") {
    return Response.json(
      { ...result, note: "Survey only — POST /api/sync to take these onto the portal's books." },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const today = todayThere();
  const registered: { id: string; key: string; person: string }[] = [];
  for (const c of result.newCertificates) {
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

  const adopted: { category: string; key: string }[] = [];
  for (const [category, s] of Object.entries(result.singles)) {
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

  return Response.json({
    registered,
    adopted,
    strays: result.strays,
    missing: result.missing,
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
  });
};
