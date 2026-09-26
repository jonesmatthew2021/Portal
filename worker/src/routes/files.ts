
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { getEnv } from "../env.js";
import { vessel } from "../vessel.js";
import { imageToPdf, imagesToPdf } from "../lib/pdf-wrap.js";
import { certHome } from "../db/cert-home.js";
import { EVIDENCE_KINDS } from "../../../source/shared/evidence.js";
import { filedCodeIn } from "../../../source/shared/filed-as.js";

/** The live matrix's columns, for the code in a filename to be a column of
 *  it (filedCodeIn) and for a column's title. Empty where no document is. */
async function liveColumns(): Promise<string[][]> {
  try {
    const state = await getEnv().DB.prepare("SELECT data FROM portal_state LIMIT 1").first<{ data: string }>();
    const cols = JSON.parse(state?.data || "{}")?.quals?.cols;
    return Array.isArray(cols) ? cols : [];
  } catch {
    return [];
  }
}
import {
  CERT_ROOT,
  SINGLE_FILE_CATEGORIES,
  certFolderFor,
  fileStore,
  relocateToRemovedBlob,
  safeContentType,
  safeName,
  singleFileCategory,
  withSuffix,
} from "../db/documents.js";
import { replaceSingleFile } from "../db/single-file.js";
import { takeLease, dropLease, leaseHolder, writingTheWorkbook } from "../lib/round.js";
import { RECORDING_MAX_BYTES } from "../../../source/shared/meeting.js";

// A function request body is capped at 6 MB once multipart overhead is counted,
// so files are held a little under that. The portal enforces the same number.
const MAX_BYTES = 5 * 1024 * 1024;

const CATEGORIES = [
  "note",
  "document",
  "correspondence",
  "matrix",
  "certificate",
  ...Object.keys(SINGLE_FILE_CATEGORIES),
];

type Row = typeof documents.$inferSelect;

function humanSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Turn a row back into the shape the portal already renders for that section,
// so the front end can drop it straight into its lists.
export function toRecord(row: Row) {
  const common = {
    id: row.id,
    filename: row.filename,
    size: humanSize(row.sizeBytes),
    url: `/api/files/${row.id}`,
    session: row.sessionId,
    stored: true,
  };

  if (row.category === "note") {
    return { ...common, rank: row.rank, swing: row.swing, by: row.uploadedBy, uploaded: row.filedOn };
  }
  if (row.category === "correspondence") {
    return {
      ...common,
      kind: "email",
      party: row.party,
      tag: row.tag,
      title: row.title,
      postedBy: row.uploadedBy,
      date: row.filedOn,
    };
  }
  if (row.category === "matrix") {
    return { ...common, by: row.uploadedBy, uploaded: row.filedOn };
  }
  if (row.category === "certificate") {
    const read = row as Row & {
      readIssued?: string | null; readExpires?: string | null;
      readCode?: string | null; readTitle?: string | null;
    };
    return {
      ...common,
      person: row.person,
      folder: row.folder,
      path: row.blobKey,
      qualCode: row.qualCode,
      title: row.title,
      expires: row.expiresOn,
      checksum: row.checksum,
      readIssued: read.readIssued ?? null,
      readExpires: read.readExpires ?? null,
      /* What the reading made of the certificate: which item it answers and
         the title printed on it. The page names files from these, so it can
         only rename one it has actually read. */
      readCode: read.readCode ?? null,
      readTitle: read.readTitle ?? null,
      /* What paper the person said it was when they filed it, beside the
         column it is about (qualCode); null is a certificate. */
      evidenceKind: row.evidenceKind ?? null,
      /* Whether the portal wrote the file's name itself. The page reads a
         column off a name only where the office wrote it, the way the
         round does (codeFor in lib/analysis.ts). */
      namedByPortal: !!row.namedByPortal,
      by: row.uploadedBy,
      uploaded: row.filedOn,
    };
  }
  if (singleFileCategory(row.category)) {
    return {
      ...common,
      path: row.blobKey,
      title: row.title,
      by: row.uploadedBy,
      uploaded: row.filedOn,
    };
  }
  return { ...common, title: row.title, from: row.source, tag: row.tag, date: row.filedOn };
}

function field(form: FormData, name: string) {
  const v = form.get(name);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

// The vessel and everyone filing for it are on the vessel's own time (the vessel
// file), so the day a file was added is that day rather than whatever UTC had
// reached.
function todayThere() {
  // en-CA gives YYYY-MM-DD, which is the shape the portal stores and displays.
  return new Intl.DateTimeFormat("en-CA", { timeZone: vessel.timezone }).format(new Date());
}

// The date the portal shows against a file. The uploader's own browser sends the
// day it is there, and anything that didn't say is stamped with today rather than
// left blank — a file with no date reads as though it had never been filed.
function filedOnFrom(form: FormData) {
  return field(form, "filedOn") ?? todayThere();
}

// One folder per person, slugged the same way in the browser, here, and in the
// blob store, so a person's certificates land together however their name was
// typed on the day.
const folderFor = certFolderFor;

async function sha256(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A crew certificate. It goes into that person's own folder under
 * `certification/`, and before anything is written the folder is checked for the
 * same certificate already being there — either the identical file under any
 * name, or the same filename. If it is, nothing is stored and the uploader is
 * told, so they decide whether to replace it, keep both, or skip it.
 */
async function uploadCertificate(form: FormData, file: File) {
  const person = field(form, "person");
  if (!person) {
    return Response.json(
      { error: `${file.name} wasn't filed — no crew member was chosen for it.` },
      { status: 400 },
    );
  }
  // What paper it is, where the uploader picked one of the five; anything
  // else is refused rather than filed as a paper nobody can read.
  const evidenceKind = field(form, "evidenceKind");
  if (evidenceKind && !(EVIDENCE_KINDS as readonly string[]).includes(evidenceKind)) {
    return Response.json({ error: `${file.name} wasn't filed — "${evidenceKind}" is not one of the papers the portal knows.` }, { status: 400 });
  }

  const folder = folderFor(person);
  // The filing rule is PDF: a photographed certificate is wrapped as a
  // one-page PDF on the way in — same pixels, its own page size. What can't
  // be wrapped honestly (HEIC, documents) is filed as it came.
  let bytes = await file.arrayBuffer();
  let uploadName = file.name;
  let uploadType = safeContentType(file.type);
  if (!/\.pdf$/i.test(file.name)) {
    const pdf = imageToPdf(bytes, file.type || null);
    if (pdf) {
      bytes = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
      uploadName = file.name.replace(/\.[^.]+$/, "") + ".pdf";
      uploadType = "application/pdf";
    }
  }
  const checksum = await sha256(bytes);
  const filename = safeName(uploadName);

  // Everything already in this person's folder, which answers both "is this file
  // already here" and "what is this new file allowed to be called". Certificates
  // that have been removed are past copies kept for the record — they don't hold
  // their old name against a renewal, and they aren't a duplicate of one.
  const filed = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.category, "certificate"),
        eq(documents.folder, folder),
        isNull(documents.removedAt),
      ),
    )
    .orderBy(desc(documents.createdAt));

  /* The same certificate already here: the identical file, the same name -
     or an older certificate for the same column (Matthew, 26 Sep 2026: "if
     there is an old one in the folder, pop up a window warning the user,
     and give the option to delete the old one"). The column this upload is
     for is the one picked on the page or the code in its name; a row's is
     its tag, what the reader made of it, or the code in its name. A paper
     standing in for a certificate is no clash either way. */
  const cols = await liveColumns();
  const codeOf = (tag: string | null | undefined, read: string | null | undefined, name: string) =>
    String(tag || read || filedCodeIn(name, cols) || "").trim().toUpperCase();
  const wantCode = evidenceKind ? "" : codeOf(field(form, "qualCode"), null, filename);
  const matches = filed.filter(
    (r) => r.checksum === checksum || r.filename.toLowerCase() === filename.toLowerCase()
      || (!!wantCode && !r.evidenceKind && codeOf(r.qualCode, r.readCode, r.filename) === wantCode),
  );

  // "ask" is the default: the uploader hasn't seen the clash yet, so nothing is
  // written until they have.
  const onDuplicate = field(form, "onDuplicate") ?? "ask";

  if (matches.length > 0 && onDuplicate === "ask") {
    return Response.json(
      {
        duplicate: true,
        person,
        folder,
        filename,
        // Same bytes is a certain duplicate; same name only might be a newer
        // renewal saved under the name the old one had; the same column
        // only is an older certificate the new one renews.
        reason: matches.some((r) => r.checksum === checksum) ? "content"
          : matches.some((r) => r.filename.toLowerCase() === filename.toLowerCase()) ? "name" : "column",
        column: wantCode ? { code: wantCode, title: (cols.find((c) => String(c[0]).trim().toUpperCase() === wantCode) || [])[1] || "" } : null,
        existing: matches.map((r) => ({
          id: r.id,
          filename: r.filename,
          size: humanSize(r.sizeBytes),
          uploaded: r.filedOn,
          by: r.uploadedBy,
          url: `/api/files/${r.id}`,
          sameBytes: r.checksum === checksum,
          code: codeOf(r.qualCode, r.readCode, r.filename) || null,
        })),
      },
      { status: 409 },
    );
  }

  if (matches.length > 0 && onDuplicate === "skip") {
    return Response.json({ skipped: true, person, folder, filename }, { status: 200 });
  }

  // Replacing: the ones it clashed with come out of the folder, so it is left
  // holding one copy of the certificate rather than a pile of near-identical
  // files. They are removed rather than destroyed — a superseded certificate is
  // worth keeping, and an uploader who picked the wrong person or the wrong file
  // can put the old one back from the Admin tab.
  //
  // Their bytes are moved aside now — a blob-store move, nothing in the
  // database touched yet — which is what frees the name for a replacement filed
  // under the very same one, and keeps the archived copy holding the bytes
  // being superseded rather than whatever the new upload writes. The row itself
  // isn't marked removed until the transaction below, alongside the insert of
  // the new one, so nothing here can be caught mid-way with the certificate
  // marked gone and nothing yet in its place.
  const uploadedBy = field(form, "uploadedBy");
  const gone = new Set<string>();
  const archivedKeys = new Map<string, string>();
  if (matches.length > 0 && onDuplicate === "replace") {
    for (const r of matches) {
      archivedKeys.set(r.id, await relocateToRemovedBlob(r));
      gone.add(r.id);
    }
  }

  // Keeping both, or replacing a file whose name differed: make sure the name
  // this one is stored under isn't already taken in the folder.
  const taken = new Set(
    filed.filter((r) => !gone.has(r.id)).map((r) => r.filename.toLowerCase()),
  );
  let stored = filename;
  for (let n = 2; taken.has(stored.toLowerCase()); n++) stored = withSuffix(filename, n);

  const id = crypto.randomUUID();
  /* The bytes go into the person's own folder — the team's filing — so an
   * upload here appears in Teams exactly where the office already keeps that
   * person's certificates. Which folder that is, is Crew Details' answer: the
   * one set against him by hand, or the folder his certificates are already
   * in.
   *
   * Where neither is known, nothing is written. The portal used to make a
   * folder from his name at that point, which is how the library came to hold
   * a second, near-empty folder for men who already had one under a name the
   * office uses. Somebody says where it goes instead. */
  const home = (await certHome()).prefixFor(folder);
  if (!home) {
    return Response.json(
      {
        error: `${file.name} wasn't filed — the portal doesn't know which folder ${person}'s `
          + "certificates go in, and it won't make one. Set his folder on Crew Details.",
        needsFolder: person,
      },
      { status: 409 },
    );
  }
  const blobKey = `${home}/${stored}`;

  // Written before anything in the database changes: if this throws, no row
  // has been touched, so a failed upload can't leave the certificate looking
  // replaced when nothing was actually filed.
  await fileStore().set(blobKey, bytes);

  const replaced: { id: string; filename: string }[] = [];
  let row: Row;
  try {
    // D1 has no interactive transactions; its atomic unit is the batch, so
    // the removals and the insert land together or not at all.
    const marks = matches
      .filter((r) => archivedKeys.get(r.id))
      .map((r) =>
        db
          .update(documents)
          .set({ removedAt: new Date(), removedBy: uploadedBy, blobKey: archivedKeys.get(r.id)! })
          .where(eq(documents.id, r.id)),
      );
    matches
      .filter((r) => archivedKeys.get(r.id))
      .forEach((r) => replaced.push({ id: r.id, filename: r.filename }));

    const insert = db
      .insert(documents)
      .values({
        id,
        category: "certificate",
        bucket: folder,
        blobKey,
        filename: stored,
        contentType: uploadType,
        sizeBytes: bytes.byteLength,
        title: field(form, "title"),
        uploadedBy,
        filedOn: filedOnFrom(form),
        sessionId: field(form, "session"),
        person,
        folder,
        qualCode: field(form, "qualCode"),
        expiresOn: field(form, "expiresOn"),
        checksum,
        evidenceKind,
      })
      .returning();

    const results = await db.batch([...marks, insert] as any);
    row = (results[results.length - 1] as Row[])[0];
  } catch (e) {
    // The database still shows the old certificates as live, so the blobs are
    // put back to match before the error goes out. The ordering guarantee: the
    // parked copy under removed/ is written once and never overwritten; a
    // failed save puts the live key back the way it was. Restoring is a copy,
    // not a move — the archive copy stays for the retry, which skips
    // re-archiving over it. Best-effort only: a failure here mustn't mask the
    // error the uploader actually needs to see.
    try {
      const store = fileStore();
      const liveKeys = new Set<string>();
      for (const r of matches) {
        const archivedKey = archivedKeys.get(r.id);
        if (!archivedKey || archivedKey === r.blobKey) continue;
        liveKeys.add(r.blobKey);
        const old = await store.get(archivedKey, { type: "arrayBuffer" });
        if (old) await store.set(r.blobKey, old);
      }
      // The new upload's blob is an orphan unless it landed on a live key that
      // the copy above has already put right.
      if (!liveKeys.has(blobKey)) await store.delete(blobKey);
    } catch (undoErr) {
      console.error(
        `files: couldn't restore ${folder}'s blobs after a failed certificate save:`,
        undoErr,
      );
    }
    throw e;
  }

  return Response.json(
    { category: row.category, bucket: row.bucket, replaced, record: toRecord(row) },
    { status: 201 },
  );
}

/**
 * A document the portal keeps exactly one of — the crew certificates
 * spreadsheet, the training matrix, the skills matrix.
 *
 * Unlike everything else here only the latest is kept, so uploading a new one
 * takes the one before it out of the portal. The uploader is still shown what
 * they are about to replace before anything is written (`onDuplicate` is "ask"
 * until they have), and the file that comes out is kept in the removed list
 * rather than destroyed — which is also how a required matrix is replaced
 * without the portal ever being without one.
 */
async function uploadSingleFile(form: FormData, file: File, category: string) {
  const existing = await db
    .select()
    .from(documents)
    .where(and(eq(documents.category, category), isNull(documents.removedAt)))
    .orderBy(desc(documents.createdAt));

  const decide = field(form, "onDuplicate") ?? "ask";

  if (existing.length > 0 && decide === "ask") {
    return Response.json(
      {
        overwrite: true,
        existing: existing.map((r) => ({
          id: r.id,
          filename: r.filename,
          size: humanSize(r.sizeBytes),
          uploaded: r.filedOn,
          by: r.uploadedBy,
          url: `/api/files/${r.id}`,
        })),
      },
      { status: 409 },
    );
  }

  if (existing.length > 0 && decide === "skip") {
    return Response.json({ skipped: true }, { status: 200 });
  }

  // Never two writers of the one workbook: the upload takes the same lease
  // the round on the hour holds while it writes, and stands aside while
  // that is held.
  const lease = await takeLease(field(form, "uploadedBy") || "an upload");
  if (!lease) {
    // Names the holder - the hour or a person's round - and promises no
    // time: the same sentence every writer of the workbook answers with,
    // and the holder's name beside it (`by`), as POST /api/round answers,
    // so a page waiting on the lease holds its buttons down under the name.
    const holder = await leaseHolder();
    return Response.json({ error: writingTheWorkbook(holder), by: holder }, { status: 409 });
  }

  try {
    // The replace itself - the new bytes first, the old copy parked, one
    // batch on the books, and the old copy put back if anything fails - is
    // in db/single-file.ts, where the hourly round runs the same steps.
    const { row, replaced } = await replaceSingleFile({
      category,
      bytes: await file.arrayBuffer(),
      filename: file.name,
      contentType: safeContentType(file.type),
      uploadedBy: field(form, "uploadedBy"),
      filedOn: filedOnFrom(form),
      title: field(form, "title"),
      sessionId: field(form, "session"),
    });

    return Response.json(
      { category: row.category, replaced, record: toRecord(row) },
      { status: 201 },
    );
  } finally {
    // The replace is done by now: the books and the library have changed.
    // A drop that fails must not turn that into an error the page reads
    // as "couldn't be filed" - the lease runs out on its own after LEASE_MS.
    try {
      await dropLease(lease.token);
    } catch (e) {
      console.error("the upload's lease was not dropped:", e);
    }
  }
}

export default async (req: Request) => {
  if (req.method === "GET") {
    // Files taken out of the portal are kept, so the listing everyone reads has
    // to leave them out — otherwise removing something would change nothing.
    // `?removed=1` is the other half: the Admin tab's list of what has been
    // removed and can be put back.
    const wantRemoved = new URL(req.url).searchParams.get("removed") === "1";

    // Raw D1 rather than the ORM here on purpose: this is the portal's
    // biggest read — every file row at once — and the ORM's per-row mapping
    // was enough to put the request over its CPU budget.
    // Plain rows with aliased column names cost almost nothing.
    // Each certificate row rides out with its own reading's dates — joined by
    // the fingerprint the reading is keyed under — so a renewal shows what is
    // printed on it, not what an older scan of the same item said.
    const listed = await getEnv().DB.prepare(
      `SELECT d.id, d.category, d.bucket, d.blob_key AS blobKey, d.filename,
              d.content_type AS contentType, d.size_bytes AS sizeBytes, d.title,
              d.uploaded_by AS uploadedBy, d.tag, d.source, d.party, d.rank, d.swing,
              d.filed_on AS filedOn, d.session_id AS sessionId, d.person, d.folder,
              d.qual_code AS qualCode, d.expires_on AS expiresOn, d.checksum,
              d.read_code AS readCode, d.read_title AS readTitle,
              d.evidence_kind AS evidenceKind, d.named_by_portal AS namedByPortal,
              d.removed_at AS removedAt, d.removed_by AS removedBy,
              d.kept_in_place AS keptInPlace,
              json_extract(b.value, '$.issuedOn') AS readIssued,
              json_extract(b.value, '$.expiresOn') AS readExpires,
              json_extract(b.value, '$.readable') AS readReadable
       FROM documents d
       LEFT JOIN blobs b ON b.store = 'certificate-readings'
        AND b.key = 'r1/' || COALESCE(d.checksum, d.id) || '.json'
       WHERE d.removed_at IS ${wantRemoved ? "NOT" : ""} NULL
       ORDER BY ${wantRemoved ? "removed_at" : "created_at"} DESC`,
    ).all<Row & { removedAt: number | null; keptInPlace: number | null; readIssued: string | null; readExpires: string | null; readReadable: number | null }>();

    return Response.json(
      (listed.results || []).map((row) => ({
        category: row.category,
        bucket: row.bucket,
        record: toRecord(row as unknown as Row),
        ...(wantRemoved
          ? {
              removedAt: row.removedAt ? new Date(Number(row.removedAt) * 1000).toISOString() : null,
              removedBy: row.removedBy,
              person: row.person,
              title: row.title,
              // The office's own file, left where the office put it: the
              // portal will neither delete it for good nor move it back.
              keptInPlace: !!row.keptInPlace,
            }
          : null),
      })),
      // Safari on iOS caches a repeated GET and would keep handing a phone the
      // list of files as it stood the first time the portal was opened.
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const form = await req.formData();
  let file = form.get("file");

  // A document photographed on a phone arrives a page at a time under
  // "page"; the pages are bound here into the one PDF everything after sees.
  const pages = form.getAll("page").filter((p): p is File => p instanceof File && p.size > 0);
  if (!(file instanceof File) && pages.length) {
    const pdf = imagesToPdf(
      await Promise.all(pages.map(async (p) => ({ bytes: await p.arrayBuffer(), type: p.type || null }))),
    );
    if (!pdf) {
      return Response.json({ error: "One of the photos couldn't be read. Take it again." }, { status: 400 });
    }
    const base = (field(form, "pagesName") || "certificate").replace(/\.pdf$/i, "");
    file = new File([pdf], `${base}.pdf`, { type: "application/pdf" });
  }

  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: "No file was included in the upload." }, { status: 400 });
  }
  // A safety meeting's recording (source/parts/safety-meeting.jsx, sent
  // with `recording`) is the one document allowed past the limit: an hour
  // of sound is more than five megabytes however it is kept.
  const cap = field(form, "recording") === "1" && (field(form, "category") ?? "document") === "document"
    ? RECORDING_MAX_BYTES
    : MAX_BYTES * (pages.length ? 4 : 1);
  if (file.size > cap) {
    return Response.json(
      { error: `${file.name} is ${humanSize(file.size)}. The limit is ${humanSize(cap)}.` },
      { status: 413 },
    );
  }

  const category = field(form, "category") ?? "document";
  if (!CATEGORIES.includes(category)) {
    return Response.json({ error: `Unknown category "${category}".` }, { status: 400 });
  }

  if (category === "certificate") return uploadCertificate(form, file);
  if (singleFileCategory(category)) return uploadSingleFile(form, file, category);

  const id = crypto.randomUUID();
  const blobKey = `uploads/${id}`;

  await fileStore().set(blobKey, await file.arrayBuffer());

  const [row] = await db
    .insert(documents)
    .values({
      id,
      category,
      bucket: field(form, "bucket"),
      blobKey,
      filename: file.name,
      contentType: safeContentType(file.type),
      sizeBytes: file.size,
      title: field(form, "title"),
      uploadedBy: field(form, "uploadedBy"),
      tag: field(form, "tag"),
      source: field(form, "source"),
      party: field(form, "party"),
      rank: field(form, "rank"),
      swing: field(form, "swing"),
      filedOn: filedOnFrom(form),
      sessionId: field(form, "session"),
    })
    .returning();

  return Response.json(
    { category: row.category, bucket: row.bucket, record: toRecord(row) },
    { status: 201 },
  );
};

