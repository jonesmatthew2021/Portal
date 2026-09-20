import type { PortalUser } from "../auth.js";
import { getEnv } from "../env.js";
import { fileStore } from "../files/store.js";

/**
 * POST /api/rename-file { id, to } — a filed document given a new name.
 *
 * The office names the crew qualification spreadsheet for the day it was last
 * worked on — "20260918 - CREW QUALIFICATION EXPIRY.xlsx" — so a workbook the
 * portal has just written should not still be carrying last week's date on the
 * front of it. Whoever opens the folder reads the name before they read the
 * file, and a stale name is how somebody comes to work off an old copy.
 *
 * The file itself is moved rather than copied: written under the new name in
 * the same folder, then the old one deleted, so SharePoint ends up with one
 * spreadsheet and not two. The record follows it. If the write succeeds and
 * the delete does not, there are two files and the books point at the new one,
 * which is the safe way round to fail.
 *
 * Management and IT only, like every other change to what is on the books.
 */
export default async (req: Request, actor: PortalUser): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (actor.role === "crew") {
    return Response.json({ error: "Documents are renamed by Management and IT Help." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { id?: unknown; to?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  if (!id || !to) return Response.json({ error: "A document and a new name are both needed." }, { status: 400 });
  // A name, not a path: nothing that could climb out of the folder it is in.
  if (/[\\/]/.test(to) || to === "." || to === "..") {
    return Response.json({ error: "That isn't a file name." }, { status: 400 });
  }

  const db = getEnv().DB;
  const row = await db
    .prepare("SELECT id, filename, blob_key FROM documents WHERE id = ?1 AND removed_at IS NULL")
    .bind(id)
    .first<{ id: string; filename: string; blob_key: string }>();
  if (!row) return Response.json({ error: "That document isn't on the books." }, { status: 404 });
  if (row.filename === to) return Response.json({ renamed: false, reason: "already called that" });

  const cut = row.blob_key.lastIndexOf("/");
  const folder = cut < 0 ? "" : row.blob_key.slice(0, cut + 1);
  const nextKey = folder + to;
  if (nextKey === row.blob_key) {
    await db.prepare("UPDATE documents SET filename = ?2 WHERE id = ?1").bind(id, to).run();
    return Response.json({ renamed: true, key: nextKey });
  }

  const store = fileStore();
  const bytes = await store.get(row.blob_key);
  if (!bytes) return Response.json({ error: "The file itself couldn't be found to move." }, { status: 404 });

  await store.set(nextKey, bytes);
  await db.prepare("UPDATE documents SET filename = ?2, blob_key = ?3 WHERE id = ?1").bind(id, to, nextKey).run();
  // The books already point at the new file, so a delete that fails leaves a
  // spare copy behind rather than a record pointing at nothing.
  try {
    await store.delete(row.blob_key);
  } catch (e) {
    return Response.json({ renamed: true, key: nextKey, leftBehind: row.blob_key });
  }
  return Response.json({ renamed: true, key: nextKey, was: row.blob_key });
};
