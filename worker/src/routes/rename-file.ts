import type { PortalUser } from "../auth.js";
import { getEnv } from "../env.js";
import { fileStore } from "../files/store.js";
import { takeLease, dropLease, leaseHolder, writingTheWorkbook } from "../lib/round.js";

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
 * And nothing is written over. The name asked for can be held by the
 * office's own workbook, kept in place after the round replaced it, by a
 * removed copy, or by a file in the folder on no row at all - the replace
 * that filed this document under a suffix stepped round exactly that, and
 * a rename back onto the name would put the new bytes over the file that
 * holds it. So the address is looked at first, on the books and in the
 * library, and a rename onto anything is refused. The office's own file is
 * never moved at all, and nothing moves while the hour holds the workbook.
 *
 * Management and IT only, like every other change to what is on the books.
 */
export default async (req: Request, actor: PortalUser): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (actor.role === "crew") {
    return Response.json({ error: "Documents are renamed by Management and IT Help." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    { id?: unknown; to?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  if (!id || !to) return Response.json({ error: "A document and a new name are both needed." }, { status: 400 });
  // A name, not a path: nothing that could climb out of the folder it is in.
  if (/[\\/]/.test(to) || to === "." || to === "..") {
    return Response.json({ error: "That isn't a file name." }, { status: 400 });
  }

  const db = getEnv().DB;
  type Found = { id: string; filename: string; blob_key: string; adopted_from_folder: number | null };
  const findRow = () => db
    .prepare("SELECT id, filename, blob_key, adopted_from_folder FROM documents WHERE id = ?1 AND removed_at IS NULL")
    .bind(id)
    .first<Found>();
  // The answers that need no lease are given first, off a plain read, so a
  // rename that was never going to move anything does not make the hour
  // wait its turn.
  const first = await findRow();
  if (!first) return Response.json({ error: "That document isn't on the books." }, { status: 404 });
  if (first.filename === to) return Response.json({ renamed: false, reason: "already called that" });
  if (first.adopted_from_folder) {
    return Response.json(
      { error: `${first.filename} is the office's own file, kept where the office put it; the portal will not move it. Rename it in SharePoint yourself.` },
      { status: 409 },
    );
  }
  // The file moved here may be the workbook the hour is writing: the rename
  // takes the one lease every writer of the workbook takes, for its own
  // turn, and stands aside while somebody holds it.
  const lease = await takeLease(actor.name || actor.email || "a rename");
  if (!lease) {
    // Names the holder - the hour or a person's round - and promises no
    // time: the same sentence every writer of the workbook answers with.
    return Response.json({ error: writingTheWorkbook(await leaseHolder()) }, { status: 409 });
  }
  const changed = () => Response.json({ error: "That document has changed; reload and try again." }, { status: 409 });
  try {
    // The row again, now that the lease is held. Between the first read and
    // the lease the hour's round can finish its replace: the row read is
    // then the one it parked, and its file is no longer at that address.
    // A rename worked out on that picture would move the parked copy, or
    // nothing at all, and write the old name over a row that is off the
    // books - so the row is taken as it is now, and only where it is the
    // same row, still live and still at the same address.
    const row = await findRow();
    if (!row || row.blob_key !== first.blob_key || row.filename !== first.filename || row.adopted_from_folder) return changed();

    /* The folder the file is already in. It is never anything else.
       A rename used to be able to move the file to another folder, and where
       that folder did not exist SharePoint made it - so renaming was quietly
       also a way of filling the library with folders nobody had asked for.
       Folders are the office's to name; this renames what is in them. */
    const cut = row.blob_key.lastIndexOf("/");
    const folder = cut < 0 ? "" : row.blob_key.slice(0, cut + 1);
    const nextKey = folder + to;
    // Both writes land only on a row that is still live: a removal does not
    // take the lease, and a name written onto a parked row would give the
    // parked copy a name its file does not carry.
    if (nextKey === row.blob_key) {
      const { meta } = await db
        .prepare("UPDATE documents SET filename = ?2 WHERE id = ?1 AND removed_at IS NULL")
        .bind(id, to)
        .run();
      if (!meta.changes) return changed();
      return Response.json({ renamed: true, key: nextKey });
    }

    const store = fileStore();
    // Whoever holds the address, live or removed, keeps it: a removed copy
    // is a file somebody may yet restore, and a live one is another document.
    const holder = await db
      .prepare("SELECT id FROM documents WHERE blob_key = ?1 AND id != ?2 LIMIT 1")
      .bind(nextKey, id)
      .first<{ id: string }>();
    if (holder || (await store.getMetadata(nextKey))) {
      return Response.json(
        { error: `${to} is already in that folder; nothing was moved.` },
        { status: 409 },
      );
    }
    const bytes = await store.get(row.blob_key);
    if (!bytes) return Response.json({ error: "The file itself couldn't be found to move." }, { status: 404 });

    await store.set(nextKey, bytes);
    const { meta } = await db
      .prepare("UPDATE documents SET filename = ?2, blob_key = ?3 WHERE id = ?1 AND removed_at IS NULL")
      .bind(id, to, nextKey)
      .run();
    if (!meta.changes) {
      // The row went off the books while the copy was being written. The
      // books never pointed at the copy, so it is taken out again, and the
      // old file - wherever the removal put it - is left as it is.
      try {
        await store.delete(nextKey);
      } catch (e) {
        console.error("the rename's copy was not taken back out:", e);
      }
      return changed();
    }
    // The books already point at the new file, so a delete that fails leaves a
    // spare copy behind rather than a record pointing at nothing.
    try {
      await store.delete(row.blob_key);
    } catch (e) {
      return Response.json({ renamed: true, key: nextKey, leftBehind: row.blob_key });
    }
    return Response.json({ renamed: true, key: nextKey, was: row.blob_key });
  } finally {
    // The move is done by now. A drop that fails must not turn it into an
    // error; the lease runs out on its own after LEASE_MS.
    try {
      await dropLease(lease.token);
    } catch (e) {
      console.error("the rename's lease was not dropped:", e);
    }
  }
};
