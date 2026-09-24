import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { SINGLE_FILE_CATEGORIES, fileStore, safeName, relocateToRemovedBlob } from "../db/documents.js";
import { certHome } from "../db/cert-home.js";
import { todayThere } from "../lib/analysis.js";
import { takeLease, dropLease, leaseHolder, writingTheWorkbook } from "../lib/round.js";
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
 *
 * The file is the office's, and its row says so (adopted_from_folder), the
 * same as one the sync takes from the folder: the portal never moves it
 * afterwards, and the sync knows not to revive its row once the round has
 * replaced it. The one it steps down comes off the books the way a removal
 * does - the office's own file kept where it is, the portal's own copy
 * parked flat - so the next sync does not find two live, and a restore
 * moves nothing into a folder the portal would have to make.
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

  if (!key) {
    // ---- list what the library holds that looks like this document ----
    // A listing changes nothing, so it reads the rows without the lease:
    // wasOnFile is only a hint on the button, and a moment stale is fine.
    const rows = await db.select().from(documents).where(eq(documents.category, category));
    const byKey = new Map(rows.map((r) => [r.blobKey, r]));
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
  // This steps the live workbook down, which the hour may be writing: it
  // takes the one lease every writer of the workbook takes, for its own
  // turn, and stands aside while somebody holds it.
  const lease = await takeLease(by);
  if (!lease) {
    // Names the holder - the hour or a person's round - and promises no
    // time: the same sentence every writer of the workbook answers with,
    // and the holder's name beside it, so the page can hold its buttons
    // down under that name at once.
    const holder = await leaseHolder();
    return Response.json({ error: writingTheWorkbook(holder), by: holder }, { status: 409 });
  }
  try {
    // The rows are read only now, under the lease. Read before it, the
    // picture could be the one the hour's round had just finished
    // replacing: its new live row unseen (so two workbooks stay live) and
    // the one it had already parked stepped down a second time.
    const rows = await db.select().from(documents).where(eq(documents.category, category));
    const byKey = new Map(rows.map((r) => [r.blobKey, r]));

    const meta = (await fileStore().getMetadata(key)) as { size?: number; contentType?: string } | null;
    if (!meta) return Response.json({ error: "That file is no longer in the library." }, { status: 404 });

    // Whatever is current steps down, the way a removal takes a file off: the
    // office's own file stays exactly where it is, kept in place; the portal's
    // own copy is parked flat under removed/, so its name is free and the
    // sync does not find it live. Either way it is there to go back to.
    const live = rows.filter((r) => !r.removedAt && r.blobKey !== key);
    for (const r of live) {
      const theirs = !!r.adoptedFromFolder;
      const blobKey = theirs ? r.blobKey : await relocateToRemovedBlob(r);
      await db.update(documents)
        .set({ removedAt: new Date(), removedBy: by, blobKey, keptInPlace: theirs ? 1 : null })
        .where(eq(documents.id, r.id));
    }

    const had = byKey.get(key);
    let row;
    if (had) {
      // The 22 Sep case: the portal already knew this file and had written it
      // off. Its row comes back as it was - and as the office's file, which
      // is what it is wherever it came from.
      [row] = await db.update(documents)
        .set({ removedAt: null, removedBy: null, keptInPlace: null, adoptedFromFolder: 1 })
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
        // Taken from the folder the office put it in: theirs, never moved.
        adoptedFromFolder: 1,
      }).returning();
    }

    return Response.json({
      record: toRecord(row),
      replaced: live.map((r) => ({ id: r.id, filename: r.filename })),
      restored: !!had,
    });
  } finally {
    // The work is done by now. A drop that fails must not turn it into an
    // error; the lease runs out on its own after LEASE_MS.
    try {
      await dropLease(lease.token);
    } catch (e) {
      console.error("the import's lease was not dropped:", e);
    }
  }
};
