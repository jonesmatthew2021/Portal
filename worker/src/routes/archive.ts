/**
 * What is in the portal, listed so the browser can download all of it.
 *
 * The Admin tab has a button that packages the whole portal into one zip — the
 * source it is built from, every file anyone has uploaded, and the shared state
 * holding the roster, the notes and the change log. The zip is built in the
 * browser rather than here, and that is deliberate: a streamed function
 * response is capped at 20 MB by the platform, and the documents on their own
 * can be well past that. A page assembling the archive itself has no such
 * ceiling, can show progress while it works, and pulls each file through
 * `/api/files/:id` — the same endpoint the portal already serves them from.
 *
 * So this endpoint hands over the list rather than the bytes: every document
 * row, live and removed, and the path each one should take inside the archive.
 * Working the layout out here rather than in the browser keeps it in one place,
 * next to the rules about how files are filed in the first place.
 */


import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { PORTAL_ROW_ID, documents, portalState } from "../db/schema.js";
import { safeName, singleFileCategory } from "../db/documents.js";

type Row = typeof documents.$inferSelect;

/**
 * One path segment, made safe to write to a disk anywhere.
 *
 * Buckets, parties, ranks and swings are typed into the portal by whoever filed
 * the thing, so they arrive as free text — with slashes, colons and trailing
 * dots in them if that is what was typed. Any of those turns a tidy folder into
 * a path that climbs out of the archive, or one Windows refuses to create.
 */
function segment(value: string | null, fallback: string) {
  const clean = (value || "")
    // Decomposing and then dropping the combining marks turns "Café" into
    // "Cafe" rather than "Cafe-", which is what leaving the marks to be swapped
    // out as unwanted characters would give.
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 ._&()+-]+/g, "-")
    .slice(0, 80);

  // Trimmed after the length cap as well as before it, because a name cut at
  // eighty characters can be left ending in a space or a dot - and a folder
  // whose name ends in either is one Windows will not create.
  return clean.replace(/^[-.\s]+|[-.\s]+$/g, "") || fallback;
}

/**
 * Where a document belongs in the archive, before collisions are settled.
 *
 * Certificates and the single-file documents are already filed under a path in
 * the blob store — `certification/evans-brenton/AMSA Medical 2029.pdf` — and
 * that path is the best description of them there is, so it is kept as-is.
 * Everything else is stored under `uploads/<id>`, which says nothing to anyone
 * opening the archive, so those are laid out by what the portal files them as.
 */
function pathFor(row: Row) {
  const filename = safeName(row.filename);

  if (row.category === "certificate") {
    return `certification/${segment(row.folder, "unnamed")}/${filename}`;
  }

  const single = singleFileCategory(row.category);
  if (single) return `${single.folder}/${filename}`;

  if (row.category === "note") {
    return `notes/${segment(row.swing, "no-swing")}/${segment(row.rank, "no-rank")}/${filename}`;
  }
  if (row.category === "correspondence") {
    return `correspondence/${segment(row.party, "no-party")}/${filename}`;
  }
  if (row.category === "document") {
    return `library/${segment(row.bucket, "no-library")}/${filename}`;
  }
  if (row.category === "matrix") {
    return `crew-matrix-archive/${filename}`;
  }

  return `other/${segment(row.category, "uncategorised")}/${filename}`;
}

// Two files can legitimately want the same path — the same filename posted to
// two threads under a party name that slugs the same way, or a note filed twice
// for one rank and swing. Numbering the later one keeps both, the same way the
// file store does when a certificate is filed under a name already taken.
function unique(path: string, taken: Set<string>) {
  if (!taken.has(path.toLowerCase())) {
    taken.add(path.toLowerCase());
    return path;
  }
  const dot = path.lastIndexOf(".");
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

export default async (req: Request) => {
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  /* Ordered oldest first, and by id where two share a timestamp, so the archive
     comes out in the same order every time it is taken. Two archives of an
     unchanged portal being byte-for-byte comparable is worth more here than any
     particular order. */
  const rows = await db.select().from(documents).orderBy(asc(documents.createdAt), asc(documents.id));

  const taken = new Set<string>();
  const files = rows.map((row) => {
    // Removed files are kept rather than destroyed, so they belong in a
    // complete copy of the portal — but under their own heading, so nobody
    // opening the archive mistakes a superseded certificate for a current one.
    const base = pathFor(row);
    const path = unique(row.removedAt ? `removed/${base}` : base, taken);

    return {
      id: row.id,
      path,
      url: `/api/files/${row.id}`,
      category: row.category,
      bucket: row.bucket,
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      title: row.title,
      uploadedBy: row.uploadedBy,
      filedOn: row.filedOn,
      createdAt: row.createdAt,
      person: row.person,
      folder: row.folder,
      qualCode: row.qualCode,
      expiresOn: row.expiresOn,
      checksum: row.checksum,
      blobKey: row.blobKey,
      removedAt: row.removedAt,
      removedBy: row.removedBy,
    };
  });

  // Which revision of the shared state this archive is of. The page saves the
  // state alongside the files, and a rev written next to it is what tells
  // somebody comparing two archives whether anything was typed in between.
  const [state] = await db
    .select({ rev: portalState.rev })
    .from(portalState)
    .where(eq(portalState.id, PORTAL_ROW_ID));

  return Response.json(
    {
      files,
      count: files.length,
      liveCount: files.filter((f) => !f.removedAt).length,
      totalBytes: files.reduce((n, f) => n + f.sizeBytes, 0),
      stateRev: state?.rev ?? 0,
    },
    // Every archive should be of the portal as it stands now, not as it stood
    // the first time somebody opened the Admin tab on that phone.
    { headers: { "Cache-Control": "no-store" } },
  );
};

