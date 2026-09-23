import { getEnv } from "../env.js";
import {
  ensureDocumentColumns,
  fileStore,
  moveBlob,
  relocateToRemovedBlob,
  safeName,
  singleFileCategory,
  withSuffix,
  type DocumentRow,
} from "./documents.js";

/**
 * Replacing a document the portal keeps exactly one of - the training
 * matrix, the skills matrix, the OPMS sheet.
 *
 * The upload button and the hourly round both come here. The office's CREW
 * QUALIFICATION EXPIRY workbook is a compliance record, and losing it is
 * the one thing a replace must never do, so the order of the work is fixed
 * and written down:
 *
 *   (a) the NEW bytes are written first - to their final address when no
 *       live row holds it, otherwise to a pending address beside it. If
 *       this fails nothing has changed.
 *   (b) only then is each outgoing row's copy parked (flat under removed/;
 *       the portal makes no folders), and if a pending address was used the
 *       new bytes are moved onto the final one. A file the office itself
 *       put in the folder is not parked: it stays exactly where it is.
 *   (c) then ONE database batch marks the outgoing rows removed and inserts
 *       the new one, so no reader ever sees an hour with no workbook.
 *   (d) if anything after (a) fails, the parked bytes are copied back onto
 *       the live address(es) and the new bytes are deleted. If that
 *       copy-back itself fails the error says where the parked copy is,
 *       rather than swallowing it - the next person needs the address.
 *
 * And nothing is ever written over. The address the new bytes take is
 * looked at first - on the books and in the library itself - and where
 * anything but this replace's own outgoing copy is there, the next suffix
 * is taken instead (see the loop below).
 */
export type ReplaceInput = {
  category: string;
  bytes: ArrayBuffer;
  filename: string;
  contentType: string | null;
  uploadedBy: string | null;
  filedOn: string;
  title?: string | null;
  sessionId?: string | null;
  /** Leave every outgoing row's bytes where they are (its row is still
   *  marked removed, with keptInPlace = 1). A row the sync adopted from
   *  the office's folder is kept in place whether or not this is set. */
  keepOutgoing?: boolean;
};

/** Where a single-file category's upload lands. Everything uploaded from the
 *  portal goes into OPMS Documents, where the office keeps its own copies;
 *  the two spreadsheet homes already inside it keep their sub-folders. */
export function singleFileKeyFor(category: string, filename: string) {
  const { folder } = singleFileCategory(category)!;
  const uploadRoot = folder.startsWith("opms/") || folder.startsWith("certification/") ? folder : "opms";
  return `${uploadRoot}/${filename}`;
}

/** The name the new bytes wait under while the outgoing copy still holds
 *  the final one. Unique to the replace, so two replaces that overlap
 *  never share one, and the sync never takes a leftover for a workbook. */
export const PENDING_MARK = "~pending";
const pendingName = (id: string, filename: string) => `${PENDING_MARK} ${id.slice(0, 8)} - ${filename}`;
export const isPendingName = (key: string) => (key.split("/").pop() || "").startsWith(PENDING_MARK);

/** The live rows of one single-file category, newest first. Plain
 *  statements rather than the ORM, so the round's tests can stand a fake
 *  database behind them. */
export async function liveRowsOf(category: string): Promise<DocumentRow[]> {
  const res = await getEnv()
    .DB.prepare(
      `SELECT id, category, bucket, blob_key AS blobKey, filename,
              content_type AS contentType, size_bytes AS sizeBytes, title,
              uploaded_by AS uploadedBy, tag, source, party, rank, swing,
              filed_on AS filedOn, session_id AS sessionId, person, folder,
              qual_code AS qualCode, expires_on AS expiresOn, checksum,
              created_at AS createdAt, removed_at AS removedAt, removed_by AS removedBy,
              adopted_from_folder AS adoptedFromFolder, kept_in_place AS keptInPlace
       FROM documents WHERE category = ?1 AND removed_at IS NULL
       ORDER BY created_at DESC`,
    )
    .bind(category)
    .all();
  return (res.results || []) as unknown as DocumentRow[];
}

/** Every row on the books at one address, live or removed. */
async function rowsAt(blobKey: string) {
  const res = await getEnv()
    .DB.prepare("SELECT id, removed_at AS removedAt, kept_in_place AS keptInPlace FROM documents WHERE blob_key = ?1")
    .bind(blobKey)
    .all<{ id: string; removedAt: number | null; keptInPlace: number | null }>();
  return res.results || [];
}

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function replaceSingleFile(
  input: ReplaceInput,
): Promise<{ row: DocumentRow; replaced: { id: string; filename: string }[] }> {
  const single = singleFileCategory(input.category);
  if (!single) throw new Error(`${input.category} is not a document the portal keeps one of`);
  await ensureDocumentColumns();
  const d1 = getEnv().DB;
  const store = fileStore();

  const existing = await liveRowsOf(input.category);
  const stays = (r: DocumentRow) => !!input.keepOutgoing || !!r.adoptedFromFolder;
  const outgoing = new Map(existing.map((r) => [r.id, r]));

  /* The name the new bytes take, and who holds it.
   *
   * Only this replace's own outgoing copy is expected at the address: it is
   * parked at (b), with the new bytes waiting at a pending address until
   * then. Anything else there means the name is taken and the next suffix
   * is tried:
   *   - an outgoing copy that stays where it is (the office's own file);
   *   - a removed row still pointing there. The office's workbook after the
   *     round replaced it is one - its bytes are still at that address and
   *     a restore of its row would serve whatever was written over them;
   *   - a file in the library on no row at all - one the office dropped in
   *     the folder that the sync has not taken on yet.
   * A live row of some other document at the address is refused outright:
   * the books disagree with themselves, and a person looks. */
  let filename = safeName(input.filename);
  let finalKey = singleFileKeyFor(input.category, filename);
  let occupied = false;
  for (let n = 2; ; n++) {
    const here = await rowsAt(finalKey);
    const stranger = here.find((h) => !h.removedAt && !outgoing.has(h.id));
    if (stranger) throw new Error(`${filename} is already on the books as another document; nothing was written`);
    const taken = here.some((h) => !!h.removedAt || stays(outgoing.get(h.id)!));
    occupied = !taken && here.length > 0;
    if (!taken && (occupied || !(await store.getMetadata(finalKey)))) break;
    filename = withSuffix(safeName(input.filename), n);
    finalKey = singleFileKeyFor(input.category, filename);
  }

  const at = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  const pendingKey = occupied ? singleFileKeyFor(input.category, pendingName(id, filename)) : null;

  // (a) the new bytes, before anything on the books is touched.
  await store.set(pendingKey ?? finalKey, input.bytes);

  const archivedKeys = new Map<string, string>();
  let landed = !pendingKey;
  try {
    // (b) the outgoing copies parked - or left where the office put them.
    for (const r of existing) {
      archivedKeys.set(r.id, stays(r) ? r.blobKey : await relocateToRemovedBlob(r));
    }
    if (pendingKey) {
      const moved = await moveBlob(pendingKey, finalKey);
      if (moved !== finalKey) throw new Error("the new bytes went missing before they could be filed");
      landed = true;
    }

    // (c) one batch: the outgoing rows off the books and the new one on.
    const marks = existing.map((r) =>
      d1
        .prepare(
          "UPDATE documents SET removed_at = ?2, removed_by = ?3, blob_key = ?4, kept_in_place = ?5 WHERE id = ?1",
        )
        .bind(r.id, at, input.uploadedBy, archivedKeys.get(r.id)!, stays(r) ? 1 : null),
    );
    const insert = d1
      .prepare(
        "INSERT INTO documents (id, category, blob_key, filename, content_type, size_bytes, title, " +
          "uploaded_by, filed_on, session_id, created_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
      )
      .bind(
        id, input.category, finalKey, filename, input.contentType, input.bytes.byteLength,
        input.title ?? null, input.uploadedBy, input.filedOn, input.sessionId ?? null, at,
      );
    await d1.batch([...marks, insert]);
  } catch (e) {
    // (d) the books still say the old copy is live, so the bytes are put
    // back to match before the error goes out.
    try {
      const liveKeys = new Set<string>();
      for (const r of existing) {
        const parked = archivedKeys.get(r.id);
        if (!parked || parked === r.blobKey) continue;
        liveKeys.add(r.blobKey);
        const old = await store.get(parked, { type: "arrayBuffer" });
        if (!old) throw new Error(`the parked copy at ${parked} could not be read back`);
        await store.set(r.blobKey, old);
      }
      // The new bytes, wherever they got to - unless they landed on a live
      // address the copy-back has just put right.
      if (pendingKey && !landed) await store.delete(pendingKey);
      else if (!liveKeys.has(finalKey)) await store.delete(finalKey);
    } catch (undoErr) {
      const parked = existing
        .map((r) => archivedKeys.get(r.id))
        .filter((k, i): k is string => !!k && k !== existing[i].blobKey);
      throw new Error(
        `${said(e)} And the old ${single.label} could not be put back: ${said(undoErr)}.` +
          (parked.length ? ` Its bytes are parked at ${parked.join(", ")}.` : ""),
      );
    }
    throw e;
  }

  const row = {
    id, category: input.category, bucket: null, blobKey: finalKey, filename,
    contentType: input.contentType, sizeBytes: input.bytes.byteLength, title: input.title ?? null,
    uploadedBy: input.uploadedBy, tag: null, source: null, party: null, rank: null, swing: null,
    filedOn: input.filedOn, sessionId: input.sessionId ?? null, createdAt: new Date(at * 1000),
    person: null, folder: null, qualCode: null, expiresOn: null, checksum: null,
    readCode: null, readExpires: null, readIssued: null, readIssuer: null, readTitle: null, readAt: null,
    removedAt: null, removedBy: null, adoptedFromFolder: null, keptInPlace: null,
  } satisfies DocumentRow;
  return { row, replaced: existing.map((r) => ({ id: r.id, filename: r.filename })) };
}
