import { sqliteTable, text, integer, blob, index, primaryKey } from "drizzle-orm/sqlite-core";
import { vessel } from "../vessel.js";

/**
 * The one row's id — the vessel file's slug, which is what it always was;
 * see the earlier build for the full story. This schema is that one
 * re-spoken for D1 (SQLite): jsonb becomes JSON-mode text, timestamps become
 * integer epoch dates, and everything else carries over column for column so
 * the ported queries read identically.
 */
export const PORTAL_ROW_ID = vessel.slug;

export const portalState = sqliteTable("portal_state", {
  id: text().primaryKey(),
  data: text({ mode: "json" }).notNull(),
  rev: integer().notNull().default(1),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Every save of the row above, newest 200 kept, so an earlier version can be
 * put back from the Access Grants page. The counts are worked out at save
 * time, when the document is already parsed, so listing the history never
 * reads the documents back. Made lazily by src/routes/state.ts rather than
 * by a migration.
 */
export const portalStateHistory = sqliteTable("portal_state_history", {
  id: integer().primaryKey({ autoIncrement: true }),
  portalId: text("portal_id").notNull(),
  rev: integer().notNull(),
  data: text().notNull(),
  savedAt: integer("saved_at").notNull(),
  savedBy: text("saved_by"),
  crew: integer(),
  matrixRows: integer("matrix_rows"),
  datedCells: integer("dated_cells"),
});

/**
 * One row per file uploaded through the portal — the record of what each file
 * is and where in the portal it belongs. The bytes live in the file store
 * (SharePoint or R2, see src/files/store.ts) under `blobKey`.
 */
export const documents = sqliteTable(
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

    filedOn: text("filed_on"),
    sessionId: text("session_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),

    person: text(),
    folder: text(),
    qualCode: text("qual_code"),
    expiresOn: text("expires_on"),
    checksum: text(),

    /* What the portal read off the document, as against what somebody typed
       against it above. Kept apart on purpose: a person's answer beats a
       reading wherever the two are weighed, and one column holding both would
       lose that. */
    readCode: text("read_code"),
    readExpires: text("read_expires"),
    readIssued: text("read_issued"),
    readIssuer: text("read_issuer"),
    readTitle: text("read_title"),
    readAt: integer("read_at", { mode: "timestamp" }),

    removedAt: integer("removed_at", { mode: "timestamp" }),
    removedBy: text("removed_by"),

    /* Whose file this is in the library. 1 where the sync took it on from
       a folder the office put it in: such a file is never moved by the
       portal, so when it is replaced its row is marked removed with its
       bytes left exactly where they are, and keptInPlace = 1 says so. Both
       nullable and added lazily (ensureDocumentColumns in documents.ts), so
       the live database needed no hand-run migration. */
    adoptedFromFolder: integer("adopted_from_folder"),
    keptInPlace: integer("kept_in_place"),

    /* What paper a certificate row is, where the person filing it said so:
       one of the five that stand in for a certificate (EVIDENCE_KINDS),
       beside qualCode, which is then the column the paper is about. Null is
       a certificate. Added lazily the same way. */
    evidenceKind: text("evidence_kind"),
  },
  (t) => [
    index("documents_category_idx").on(t.category, t.bucket),
    index("documents_folder_idx").on(t.folder, t.checksum),
  ],
);

/**
 * The JSON records the earlier build kept in named blob stores — certificate
 * readings, matrix readings and checks, job records, held answers. D1 rather
 * than KV, because these are read back the instant after they are written
 * (poll loops, three-call sequences) and D1 is strongly consistent where KV is
 * eventual. Values are JSON text; nothing binary lands here — file bytes have
 * their own store.
 */
export const blobs = sqliteTable(
  "blobs",
  {
    store: text().notNull(),
    key: text().notNull(),
    value: text().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.store, t.key] })],
);
