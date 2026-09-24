import { fileStore } from "../files/store.js";
export { fileStore };
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "./index.js";
import { documents } from "./schema.js";
import { getEnv } from "../env.js";

export type DocumentRow = typeof documents.$inferSelect;

/**
 * The two columns added on 24 Sep 2026 (adopted_from_folder, kept_in_place),
 * put on an existing table the first time the worker needs them, the way
 * the history table is made: one look at the table per isolate, and an
 * ALTER only where a column is missing. The front door awaits this before
 * any /api route runs, because every ORM read of the table names them.
 */
let columnsReady: Promise<unknown> | null = null;
export function ensureDocumentColumns() {
  if (!columnsReady) {
    columnsReady = (async () => {
      const d1 = getEnv().DB;
      const info = await d1.prepare("PRAGMA table_info(documents)").all<{ name: string }>();
      const cols = info.results || [];
      // No rows is no table: a fresh local database that schema.sql has not
      // been run against yet. Nothing to add a column to, and nothing to
      // stop a request over - the route will say what is missing.
      if (!cols.length) return;
      const have = new Set(cols.map((c) => c.name));
      for (const col of ["adopted_from_folder", "kept_in_place"]) {
        if (have.has(col)) continue;
        try {
          await d1.prepare(`ALTER TABLE documents ADD COLUMN ${col} INTEGER`).run();
        } catch (e) {
          // Another isolate got there first in the same instant: the column
          // is there, which is all that was wanted. And a table that is not
          // there is the case above, seen a moment later.
          if (!/duplicate column|no such table/i.test(e instanceof Error ? e.message : String(e))) throw e;
        }
      }
    })().catch((e) => {
      // A failed attempt must not be remembered as done.
      columnsReady = null;
      throw e;
    });
  }
  return columnsReady;
}

/** Forgets that the columns were looked at, so the next call looks again.
 *  For the tests, which stand a fresh database behind each case. */
export function forgetDocumentColumns() {
  columnsReady = null;
}

// Crew certificates are kept apart from everything else in the store, one folder
// per person, so a person's certificates can be found as a set:
//   certification/smith-alan/AMSA Medical 2029.pdf
export const CERT_ROOT = "certification";

// The crew certificates spreadsheet sits alongside those folders. Only ever one
// is kept — the latest — so this folder holds a single file.
export const SHEET_FOLDER = `${CERT_ROOT}/spreadsheet`;

// The two matrices the portal is run against. The training matrix is where the
// crew's training stands today; the skills matrix is what they are required to
// hold — the items, how long each stays valid, and how they have to be spread
// across the shifts. They are kept apart from the certification folders because
// they are documents about the whole crew rather than about one person.
export const TRAINING_FOLDER = "matrices/training";
export const SKILLS_FOLDER = "matrices/skills";

// The skills matrix names what has to be held; the validity periods matrix says
// how long each of those items lasts before it has to be done again. They are two
// halves of the same rulebook and are read together, so the second sits alongside
// the first rather than among the certification folders.
export const VALIDITY_FOLDER = "matrices/validity";

// The spreadsheet OPMS exports. It comes out of a system the portal doesn't
// control, so it is kept in a folder of its own rather than among the documents
// the vessel writes for itself — and, like them, only the latest is held.
export const OPMS_FOLDER = "opms/spreadsheet";

// The shift allocation guideline the office sends — not names, but how many
// holders of certain certificates each shift (day and night) must carry, for
// the swing and the swings after it. The Swings page holds the crew's
// training matrix standing against it, so only the latest is kept, same as the
// other office documents.
export const SHIFT_ALLOCATION_FOLDER = "roster/shift-allocation";
// The office's travel roster — who is on which swing, and the days they sign
// on and off. One is kept, the latest.
export const CREW_ROSTER_FOLDER = "roster/crew-roster";

/**
 * The categories the portal keeps exactly one file of.
 *
 * Everything else can be filed over and over — fifty certificates, a note per
 * swing — but these are single documents that are replaced rather than added to,
 * so uploading a new one takes the one before it out of the portal. Each has a
 * folder of its own holding that one file.
 *
 * `required` says the portal is not complete without it: the training matrix and
 * the skills matrix have to be on file at all times, so neither can be taken out
 * on its own. Replacing one is still allowed — that is an upload, which files the
 * new one in the same breath as it removes the old.
 */
export const SINGLE_FILE_CATEGORIES: Record<
  string,
  { folder: string; label: string; required: boolean }
> = {
  "certificate-sheet": {
    folder: SHEET_FOLDER,
    label: "crew certificates spreadsheet",
    required: false,
  },
  "training-matrix": {
    folder: TRAINING_FOLDER,
    label: "training matrix",
    required: true,
  },
  "skills-matrix": {
    folder: SKILLS_FOLDER,
    label: "skills matrix",
    required: true,
  },
  // Retired. The validity periods were folded into the skills matrix by the
  // office, and the file filed here was a copy of it that nothing read. The
  // category stays defined so anything already filed under it still resolves
  // and can be opened or taken down by hand; nothing offers it any more.
  "validity-matrix": {
    folder: VALIDITY_FOLDER,
    label: "validity periods matrix",
    required: false,
  },
  "crew-roster": {
    folder: CREW_ROSTER_FOLDER,
    label: "crew roster",
    required: false,
  },
  "opms-sheet": {
    folder: OPMS_FOLDER,
    label: "OPMS spreadsheet",
    required: false,
  },
  "shift-allocation": {
    folder: SHIFT_ALLOCATION_FOLDER,
    label: "shift allocation sheet",
    required: false,
  },
};

export const singleFileCategory = (category: string) =>
  SINGLE_FILE_CATEGORIES[category] || null;

// What the portal will hand back with `Content-Disposition: inline` — the
// browser opens these in the tab itself, so anything that can carry a script
// (HTML, SVG, XML, anything javascript-flavoured) must never land here,
// whatever the uploading browser claimed the file was. Everything else the
// portal is asked to hold — a stray .zip, a mislabelled file — is stored as a
// plain download instead, which nothing renders. This is the one place the
// content type is decided, so every upload path goes through it rather than
// trusting `file.type` on its own.
const INLINE_SAFE_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
]);

export function safeContentType(type: string | null | undefined) {
  const t = (type || "").toLowerCase().trim();
  return INLINE_SAFE_TYPES.has(t) ? t : "application/octet-stream";
}

// Where a removed file's bytes are parked. A certificate's key is built from the
// person's folder and the filename, so leaving a removed one where it was would
// keep that name occupied and push next year's renewal to "AMSA Medical (2).pdf".
// Moving it here frees the name without throwing anything away.
export const REMOVED_ROOT = "removed";

/**
 * The parked copy's address: flat, one file straight under removed/, named
 * with the row's id in front so two removals of the same filename never
 * collide.
 *
 * It used to be removed/<id>/<filename> - a folder per removed file. The
 * portal makes no folders in the library: the folders are the office's, and
 * every removal was quietly adding one. A row removed before this keeps the
 * key written on it (restore and purge read the row, never work it out
 * again), and legacyRemovedKeyFor is the old address for anything that
 * still needs finding there.
 */
export const removedKeyFor = (row: { id: string; filename: string }) =>
  `${REMOVED_ROOT}/${row.id} - ${row.filename}`;
export const legacyRemovedKeyFor = (row: { id: string; filename: string }) =>
  `${REMOVED_ROOT}/${row.id}/${row.filename}`;

// One folder per person. The name is slugged so "SMITH, Alan", "Smith,
// Alan" and "smith  alan" all file into the same folder rather than
// leaving one person's certificates scattered across three. The portal uses the
// same rule in the browser, so the folder a file is about to land in can be
// shown before it is sent.
/**
 * The team's own certificate filing: one "<Name> - OPMS" folder per person in
 * the OPMS Documents folder — Alan - OPMS, Bob - OPMS and so on. That is
 * where the crew's certificates actually live and are kept up to date, so the
 * portal treats those folders as the certificate home: the sync reads them,
 * and uploads and refiles write into them. This table marries the portal's
 * person tokens to the folder names the team already uses — first names
 * mostly, surnames where first names collide, and the nicknames the folders
 * were made with. It is the vessel's data, not the portal's, so it is the
 * vessel file's (crewFolders); it is read only after Crew Details, which
 * names a man's folder outright, and before the name worked out from the
 * folder itself (tokenForOpmsFolder). It goes for good once Crew Details
 * names every folder still carrying a nickname - a job done by hand on that
 * page, not here.
 */
import { canonicalPersonName } from "./person-name.js";
import { vessel } from "../vessel.js";

export const OPMS_FOLDER_NAMES: Record<string, string> = vessel.crewFolders;

/**
 * The person's OPMS folder name: LASTNAME, First.
 *
 * The office named these folders for the person rather than for the record -
 * "Kyle", "AJ", "Bob", "Tom" - and the portal kept the crew as the matrix
 * writes them. Holding the two together took a lookup table and a fair
 * amount of guessing, and it still put the same man on the screen twice the
 * day somebody new arrived, once to be added and once to be removed.
 *
 * One form everywhere ends that. The table below stays only to read the
 * folders the office has not renamed yet; nothing new is ever written under
 * a nickname again.
 */
export function opmsFolderName(token: string) {
  const parts = (token || "").split("-").filter(Boolean);
  if (!parts.length) return "UNNAMED";
  const cased = (w: string) => w[0].toUpperCase() + w.slice(1).toLowerCase();
  const surname = parts[0].toUpperCase();
  const first = parts.slice(1).map(cased).join(" ");
  return first ? `${surname}, ${first}` : surname;
}

/** Where this person's certificates are written: their OPMS folder. */
/** Where this person's certificates are written: their own folder under OPMS.
 * No suffix - the folder is already in OPMS Documents, and saying it twice
 * told nobody anything. */
export const opmsCertPrefix = (token: string) => `opms/${opmsFolderName(token)}`;

/**
 * The folder a file is actually in, read off its own address.
 *
 * Not the same thing as opmsCertPrefix, which works a folder name out from the
 * portal's token for a person. Where the library still calls the folder
 * "Chris - OPMS" and the token says "ayers-christopher-james", those two
 * disagree, and writing to the worked-out one does not rename the folder - it
 * makes a second folder beside the first and leaves the file in it.
 *
 * So a rename uses this. The office names its own folders; the portal renames
 * the file inside whichever folder it found it in and nothing else.
 */
export const blobFolder = (blobKey: string) => {
  const cut = String(blobKey || "").lastIndexOf("/");
  return cut > 0 ? blobKey.slice(0, cut) : "opms";
};

const TOKEN_BY_OPMS_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(OPMS_FOLDER_NAMES).map(([t, n]) => [n.toLowerCase(), t]),
);

/** Whether a folder name says who it belongs to on its own - "EVDOKIMOV,
 * Evgeny" does, "Kyle" does not. */
const readsAsAName = (name: string) =>
  name.includes(",") || name.trim().split(/\s+/).filter(Boolean).length > 1;

/**
 * The person token an OPMS folder belongs to.
 *
 * A folder named the standard way says outright whose it is, and is taken at
 * its word. One still carrying a nickname is looked up in the old table, and
 * anything else becomes a token of its own - which is how somebody new turns
 * up to be asked about rather than quietly filed against the wrong person.
 */
export function tokenForOpmsFolder(folderName: string) {
  const name = folderName.replace(/\s*-\s*OPMS\s*$/i, "").trim();
  if (readsAsAName(name)) return certFolderFor(canonicalPersonName(name));
  return TOKEN_BY_OPMS_NAME[name.toLowerCase()] ?? certFolderFor(name);
}

/** Whose folder this is, written the one way the portal writes names. */
export function personForOpmsFolder(folderName: string) {
  const name = folderName.replace(/\s*-\s*OPMS\s*$/i, "").trim();
  if (readsAsAName(name)) return canonicalPersonName(name);
  return opmsFolderName(tokenForOpmsFolder(folderName));
}

export function certFolderFor(person: string) {
  return (
    (person || "")
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 80) || "unnamed"
  );
}


// Keep the uploader's filename — it is what they will look for — minus anything
// that would break a blob key or climb out of the folder.
export function safeName(name: string) {
  const base = (name.split(/[\\/]/).pop() || "certificate").trim();
  // Commas and apostrophes stay: "PEJIC, Anton" and "O'BRIEN" are how the
  // filing names read, and SharePoint takes both.
  return base.replace(/[^A-Za-z0-9._ ()&+,'-]/g, "_").slice(0, 120) || "certificate";
}

export function withSuffix(name: string, n: number) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

// Only the categories whose key carries the filename need moving; everything
// else is stored under `uploads/<id>`, which no later upload can collide with.
function keyedByName(row: DocumentRow) {
  return row.category === "certificate" || !!singleFileCategory(row.category);
}

// The store has no move, so this is a copy and a delete. If the bytes have
// already gone the key is still handed back — the row is what the portal lists
// from, and a row pointing at nothing reads as "no longer on the portal" rather
// than breaking the listing for everyone.
export async function moveBlob(from: string, to: string) {
  if (from === to) return to;
  const store = fileStore();
  const bytes = await store.get(from, { type: "arrayBuffer" });
  if (!bytes) return from;
  await store.set(to, bytes);
  await store.delete(from);
  return to;
}

// The name this certificate can go back under. Its own old name is usually free
// again, but a renewal filed in the meantime may have taken it. A rename inside
// the same folder passes the row own current name, which is free to keep -
// without that, a duplicate whose wanted name is held by its twin was pushed
// off its own suffix onto the next one every pass, and back again the pass
// after, moving real bytes in SharePoint each time and never settling.
async function freeCertName(folder: string, filename: string, own?: string | null) {
  const live = await db
    .select({ filename: documents.filename })
    .from(documents)
    .where(
      and(
        eq(documents.category, "certificate"),
        eq(documents.folder, folder),
        isNull(documents.removedAt),
      ),
    );

  const taken = new Set(live.map((r) => r.filename.toLowerCase()));
  if (own) taken.delete(own.toLowerCase());
  let name = filename;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = withSuffix(filename, n);
  return name;
}

/**
 * Move a document's bytes to where a removed copy of it lives, without
 * touching its row. A pure blob-store operation — nothing in the database
 * changes, so it can safely run before a database write rather than as part of
 * one.
 *
 * This is what frees a single-file category's name (or a certificate's) for a
 * replacement filed under the very same one, and it is also the first half of
 * `removeDocument` below. Replacing a document pulls it out on its own, ahead
 * of writing the new blob, so the archived copy holds the bytes being
 * superseded rather than whatever lands on the key next.
 *
 * Idempotent on retry: the archive copy under removed/ is written once and
 * never overwritten. If an earlier attempt already parked the bytes there — a
 * replacement whose database save failed and was then retried — the live key
 * may by now hold the new upload's bytes instead, and copying it again would
 * destroy the only preserved copy of the superseded document. On a first
 * removal the destination doesn't exist yet, so the move proceeds as before.
 */
export async function relocateToRemovedBlob(row: DocumentRow) {
  if (!keyedByName(row)) return row.blobKey;

  const dest = removedKeyFor(row);
  const store = fileStore();
  if (await store.getMetadata(dest)) {
    // The archive copy is already in place; just free the live name, exactly
    // as the move below would have.
    await store.delete(row.blobKey);
    return dest;
  }
  return await moveBlob(row.blobKey, dest);
}

/**
 * Take a file out of the portal without destroying it.
 *
 * The row stays, stamped with when it went and who took it, and the bytes stay
 * in the store — so anything removed by mistake, or a certificate superseded by
 * a renewal, can be put back exactly as it was. `purgeDocument` is the only
 * thing here that actually gets rid of a file, and the portal only offers it
 * from the list of things already removed.
 */
export async function removeDocument(row: DocumentRow, by: string | null) {
  if (row.removedAt) return row;

  // A file the office put in its folder stays exactly where it is; only
  // the portal's account of it changes.
  const theirs = !!row.adoptedFromFolder;
  const blobKey = theirs ? row.blobKey : await relocateToRemovedBlob(row);

  const [updated] = await db
    .update(documents)
    .set({ removedAt: new Date(), removedBy: by, blobKey, keptInPlace: theirs ? 1 : null })
    .where(eq(documents.id, row.id))
    .returning();

  return updated;
}

/** A removed row whose bytes are the office's own file, where the office
 *  put it. Thrown rather than the file being deleted or moved - the portal
 *  never does either to the office's files. */
export class KeptInPlace extends Error {
  constructor(readonly filename: string) {
    super(`${filename} is the office's own file, kept where the office put it; the portal will not delete or move it. Do that in SharePoint yourself.`);
  }
}

/**
 * Whether a current file of a single-file category is on the portal.
 *
 * Only one of these is ever shown — the newest — so restoring an older one while
 * a current one is filed would put a row back that nothing displays. The restore
 * is refused instead, with the reason. It is also what answers "is the training
 * matrix on file", which the portal has to know before it will run anything
 * against it.
 */
export async function liveSingleFileExists(category: string) {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.category, category), isNull(documents.removedAt)))
    .limit(1);
  return rows.length > 0;
}

/** The one file currently filed under a single-file category, if there is one. */
export async function liveSingleFileRow(category: string) {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.category, category), isNull(documents.removedAt)))
    .orderBy(desc(documents.createdAt))
    .limit(1);
  return rows[0] || null;
}

/** Nowhere to put a certificate back. Thrown rather than a folder being made
 *  for it - the folders are the office's, and one is set on Crew Details. */
export class NoFolderForRestore extends Error {
  constructor(readonly person: string) {
    super("no folder");
  }
}

/** Put a removed file back where it was, under a name the folder still has free. */
export async function restoreDocument(row: DocumentRow, fallbackHome?: string) {
  if (!row.removedAt) return row;

  let blobKey = row.blobKey;
  let filename = row.filename;
  const single = singleFileCategory(row.category);

  if (row.category === "certificate" && row.folder) {
    /* Back in with the rest of his certificates.
     *
     * Which folder that is, is asked of his other files rather than worked out
     * from his name. The office still calls some of them "Chris - OPMS", and a
     * worked-out "AYERS, Christopher James" would not be that folder - it
     * would be a new one, holding one restored file and nothing else.
     *
     * Where he has nothing else on file and Crew Details has not been asked,
     * nothing goes back. This used to fall through to the worked-out name,
     * which is a folder being made by the portal - and the portal does not
     * make folders. Somebody says where it goes instead.
     */
    const beside = await db
      .select({ blobKey: documents.blobKey })
      .from(documents)
      .where(and(eq(documents.folder, row.folder), isNull(documents.removedAt)))
      .limit(1);
    const home = beside[0] ? blobFolder(beside[0].blobKey) : fallbackHome;
    if (!home) throw new NoFolderForRestore(row.person || row.folder);
    filename = await freeCertName(row.folder, row.filename);
    blobKey = await moveBlob(row.blobKey, `${home}/${filename}`);
  } else if (single && !row.keptInPlace) {
    blobKey = await moveBlob(row.blobKey, `${single.folder}/${filename}`);
  }
  // A row kept in place goes back on the books where its bytes already
  // are: the office's file was never moved, and is not moved now.

  const [updated] = await db
    .update(documents)
    .set({ removedAt: null, removedBy: null, blobKey, filename, keptInPlace: null })
    .where(eq(documents.id, row.id))
    .returning();

  return updated;
}

/** Destroy a file for good. Nothing calls this without a second, deliberate
 *  ask - and never the office's own file, which was only ever kept in place. */
export async function purgeDocument(row: DocumentRow) {
  if (row.keptInPlace) throw new KeptInPlace(row.filename);
  await fileStore().delete(row.blobKey);
  await db.delete(documents).where(eq(documents.id, row.id));
}

/**
 * Move a certificate into another person's folder.
 *
 * A certificate is filed under whoever the uploader said it belongs to, and that
 * can be wrong — a loose scan with an unhelpful name, or a folder dropped against
 * the wrong crew member. Once the certificate itself has been read, the name
 * printed on it is the better answer, and this is what acts on it: the bytes move
 * to the folder of the person the certificate is actually for, under a name that
 * folder still has free, and the row follows them.
 */
/**
 * One filing name for a read certificate: "PERSON - CODE Title.pdf". The
 * bytes are wrapped as a PDF where they are a photo the wrapper can carry;
 * anything else keeps its own format behind the same name. A name already
 * right is left alone.
 */
export async function canonicaliseCertificate(
  row: DocumentRow,
  wantBase: string,
  imageToPdf: (bytes: ArrayBuffer, contentType: string | null) => Uint8Array | null,
) {
  const ext = ((row.filename.match(/\.[^.]+$/) || [""])[0] || "").toLowerCase();
  const convertible = [".jpg", ".jpeg", ".png"].includes(ext);
  const targetExt = ext === ".pdf" || convertible ? ".pdf" : ext;
  const want = safeName(wantBase) + targetExt;
  if (row.filename === want && (!convertible || ext === ".pdf")) return null;

  // Where the rename would land, settled before the bytes are fetched: a
  // duplicate whose wanted name is held by its twin lands back on its own
  // name, and that is known without downloading the file to move nowhere.
  if (!convertible) {
    const landing = await freeCertName(row.folder!, want, row.filename);
    if (landing === row.filename
      && `${blobFolder(row.blobKey)}/${landing}` === row.blobKey) return null;
  }

  const store = fileStore();
  let bytes = (await store.get(row.blobKey, { type: "arrayBuffer" })) as ArrayBuffer | null;
  if (!bytes) return null;
  let contentType = row.contentType;
  if (convertible) {
    const pdf = imageToPdf(bytes, row.contentType);
    if (!pdf) {
      // Not a photo the wrapper can carry after all — keep its own format.
      if (row.filename === safeName(wantBase) + ext) return null;
      return await renamed(row, safeName(wantBase) + ext, bytes, row.contentType);
    }
    bytes = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
    contentType = "application/pdf";
  }
  return await renamed(row, want, bytes, contentType);

  async function renamed(r: DocumentRow, name: string, data: ArrayBuffer, type: string | null) {
    const filename = await freeCertName(r.folder!, name, r.filename);
    const to = `${blobFolder(r.blobKey)}/${filename}`;
    if (to === r.blobKey && filename === r.filename) return null;
    // Nothing is written over. The name was chosen from the portal own books,
    // and the folder can still hold a file the books do not know about - or
    // one another run has just written - so the destination is looked at
    // first. Something already there means this rename is left for next time
    // rather than a file being lost under it.
    if (to !== r.blobKey && (await fileStore().getMetadata(to))) return null;
    await fileStore().set(to, data);
    if (to !== r.blobKey) await fileStore().delete(r.blobKey);
    const [updated] = await db
      .update(documents)
      .set({ blobKey: to, filename, contentType: type, sizeBytes: data.byteLength })
      .where(eq(documents.id, r.id))
      .returning();
    return updated;
  }
}

/**
 * A certificate read as somebody else's is written down as theirs. The file
 * does not move.
 *
 * It used to move - into a folder worked out from the new person's name. Where
 * the library had never used that name the move made the folder, so a
 * certificate found in "Sam - OPMS" and read as Sam Sample's ended up
 * alone in a new "SAMPLE, Sam" folder, and the library filled with empty
 * halves of people. The office keeps its own folders; the portal keeps its own
 * books, and the books are what the matrix reads.
 */
export async function refileCertificate(row: DocumentRow, person: string, _folder: string) {
  const [updated] = await db
    .update(documents)
    .set({ person })
    .where(eq(documents.id, row.id))
    .returning();

  return updated;
}
