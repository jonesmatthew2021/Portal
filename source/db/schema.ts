import { pgTable, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * The one row's id. Named here rather than typed out wherever the row is read,
 * because it is read from more than one place now: the endpoint the portal saves
 * through, and the AI Checker, which is shown the record when it is asked about
 * anything the portal holds.
 */
export const PORTAL_ROW_ID = "coolibah";

/**
 * Everything the portal holds that isn't a file — the roster, notes,
 * correspondence, comments, suggestions, the crew matrix and the change history
 * — kept as one document so a change to any part of the portal is saved for
 * everyone rather than living in one person's browser until they refresh.
 *
 * `rev` is bumped on every save and is what makes a save safe: a write only
 * lands if it was based on the revision that is currently stored, so two people
 * saving at the same moment can't silently overwrite one another.
 */
export const portalState = pgTable("portal_state", {
  id: text().primaryKey(),
  data: jsonb().notNull(),
  rev: integer().notNull().default(1),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * One row per file uploaded through the portal. The bytes live in Netlify Blobs
 * under `blobKey`; this table is the record of what the file is and where in the
 * portal it belongs, so the listing survives a refresh and is the same for
 * everyone on every device.
 *
 * `category` says which part of the portal the file was filed under:
 *   note           — handover notes, filed against a rank and a swing
 *   document       — a document library entry (bucket names the library)
 *   correspondence — an email attached to a correspondence thread
 *   matrix         — an archived crew qualification spreadsheet
 *   certificate    — a crew certificate, filed in that person's own folder
 *
 * Columns are shared across categories rather than duplicated per category:
 * `title` carries a document title or an email subject, `uploadedBy` carries the
 * person who filed or posted it.
 */
export const documents = pgTable(
  "documents",
  {
    id: text().primaryKey(),
    category: text().notNull(),
    bucket: text(),

    blobKey: text("blob_key").notNull(),
    filename: text().notNull(),
    contentType: text("content_type"),
    sizeBytes: integer("size_bytes").notNull(),

    title: text(),
    uploadedBy: text("uploaded_by"),
    tag: text(),
    source: text(),
    party: text(),
    rank: text(),
    swing: text(),

    // The date the portal displays against the file, as YYYY-MM-DD.
    filedOn: text("filed_on"),
    // Browser session that uploaded it, so crew can remove their own posts.
    sessionId: text("session_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),

    // Crew certificates only. Each certificate belongs to one person, and every
    // person has their own folder in the blob store under `certification/`.
    // `folder` is that folder's name — a slug of the person's name, so the same
    // person's files land together however their name was typed on the day.
    person: text(),
    folder: text(),
    // The matrix code the certificate answers to, e.g. QL-12, where the uploader
    // picked one. Blank when the certificate isn't on the matrix.
    qualCode: text("qual_code"),
    expiresOn: text("expires_on"),
    // SHA-256 of the bytes, so the same certificate uploaded twice is recognised
    // even when it has been renamed on the way in.
    checksum: text(),

    // Removing a file from the portal takes it out of sight rather than
    // destroying it: the bytes stay in the blob store and this row stays here,
    // stamped with when it went and who did it. Anything removed can be put
    // back exactly where it was, and only a deliberate second step from the
    // removed list gets rid of it for good. A live file has this empty.
    removedAt: timestamp("removed_at"),
    removedBy: text("removed_by"),
  },
  (t) => [
    index("documents_category_idx").on(t.category, t.bucket),
    index("documents_folder_idx").on(t.folder, t.checksum),
  ],
);
