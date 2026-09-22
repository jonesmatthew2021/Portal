import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { SINGLE_FILE_CATEGORIES, fileStore, safeName } from "../db/documents.js";
import { certHome } from "../db/cert-home.js";
import { todayThere } from "../lib/analysis.js";
import { looseIn } from "./sync.js";
import { toRecord } from "./files.js";

/**
 * Taking one of the office's workbooks straight from the library.
 *
 * The training matrix, the skills matrix, the roster, the OPMS sheet: the
 * office drops them loose in the certificate location, and the portal used to
 * only ever get them one of two ways — a sync that happened to notice, or
 * somebody downloading the file to their own machine and uploading it back
 * into the portal it was already sitting next to.
 *
 * Both of those went wrong at once on 22 Sep. The sync marked all three
 * workbooks removed while their files were still in the library, and then
 * there was nothing on file and no way to put them back short of re-uploading
 * something that had never left. So: a button that lists what the library
 * holds that looks like this document, and files the one chosen.
 *
 *   POST { category }        -> { found: [{ key, filename, size, wasOnFile }] }
 *   POST { category, key }   -> { record }, the same shape an upload returns
 *
 * Nothing is moved. A workbook filed from here stays exactly where the office
 * put it; the portal points at it. Where the portal already had a row for that
 * file and had marked it removed, the row is simply un-removed — that is the
 * 22 Sep case, and it is the whole file's history kept rather than a second
 * row for the same bytes.
 */

/** What a file has to be called to be offered for each document. */
const LOOKS_LIKE: Record<string, RegExp> = {
  "training-matrix": /qualification\s*expiry|training\s*matrix/i,
  "skills-matrix": /skills?\s*matrix/i,
  "validity-matrix": /validity/i,
  "crew-roster": /roster/i,
  "opms-sheet": /completion\s*overview|opms/i,
  "certificate-sheet": /completion\s*overview|opms|certificate/i,
  "shift-allocation": /shift|allocation/i,
};

const isWorkbook = (key: string) => /\.(xlsx|xlsm|xls|csv)$/i.test(key);

export default async (req: Request, by: string) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = (await req.json().catch(() => null)) as { category?: unknown; key?: unknown } | null;
  const category = typeof body?.category === "string" ? body.category : "";
  const def = SINGLE_FILE_CATEGORIES[category];
  if (!def) return Response.json({ error: "That isn't one of the documents the portal keeps one of." }, { status: 400 });
  const key = typeof body?.key === "string" ? body.key.trim() : "";

  const rows = await db.select().from(documents).where(eq(documents.category, category));
  const byKey = new Map(rows.map((r) => [r.blobKey, r]));

  if (!key) {
    // ---- list what the library holds that looks like this document ----
    const store = fileStore();
    const where = await certHome();
    const loose = looseIn(where.home);
    const looks = LOOKS_LIKE[category] || /./;
    const seen = new Set<string>();
    const found: { key: string; filename: string; size: number; wasOnFile: boolean }[] = [];
    const offer = (k: string, size?: number) => {
      if (seen.has(k) || k.startsWith("removed/") || !isWorkbook(k)) return;
      const filename = k.split("/").pop() || "";
      if (!looks.test(filename)) return;
      seen.add(k);
      const had = byKey.get(k);
      found.push({ key: k, filename, size: size ?? 0, wasOnFile: !!had });
    };
    for (const f of (await store.list({ prefix: def.folder + "/" })).blobs) offer(f.key, f.size);
    for (const f of (await store.list({ prefix: where.home + "/" })).blobs) if (loose(f.key)) offer(f.key, f.size);
    // Newest name first — the office dates them on the front, "20260922 - …".
    found.sort((a, b) => (a.filename < b.filename ? 1 : -1));
    return Response.json({ found, label: def.label });
  }

  // ---- file the one chosen ----
  if (key.includes("..") || key.startsWith("/")) return Response.json({ error: "That isn't a file." }, { status: 400 });
  const meta = (await fileStore().getMetadata(key)) as { size?: number; contentType?: string } | null;
  if (!meta) return Response.json({ error: "That file is no longer in the library." }, { status: 404 });

  // Whatever is current steps down. Kept, marked removed, the way an upload
  // that replaces it does — so the one before is still there to go back to.
  const live = rows.filter((r) => !r.removedAt && r.blobKey !== key);
  for (const r of live) {
    await db.update(documents)
      .set({ removedAt: new Date(), removedBy: by })
      .where(eq(documents.id, r.id));
  }

  const had = byKey.get(key);
  let row;
  if (had) {
    // The 22 Sep case: the portal already knew this file and had written it
    // off. Its row comes back as it was.
    [row] = await db.update(documents)
      .set({ removedAt: null, removedBy: null })
      .where(eq(documents.id, had.id))
      .returning();
  } else {
    const filename = safeName(key.split("/").pop() || "document");
    [row] = await db.insert(documents).values({
      id: crypto.randomUUID(),
      category,
      blobKey: key,
      filename,
      contentType: meta.contentType || "application/octet-stream",
      sizeBytes: meta.size ?? 0,
      uploadedBy: by,
      filedOn: todayThere(),
    }).returning();
  }

  return Response.json({
    record: toRecord(row),
    replaced: live.map((r) => ({ id: r.id, filename: r.filename })),
    restored: !!had,
  });
};
