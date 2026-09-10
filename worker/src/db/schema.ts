import { sqliteTable, text, integer, blob, index, primaryKey } from "drizzle-orm/sqlite-core";

/**
 * The one row's id — same as it always was; see the Netlify original for the
 * full story. This schema is that one re-spoken for D1 (SQLite): jsonb becomes
 * JSON-mode text, timestamps become integer epoch dates, and everything else
 * carries over column for column so the ported queries read identically.
 */
export const PORTAL_ROW_ID = "coolibah";

export const portalState = sqliteTable("portal_state", {
  id: text().primaryKey(),
  data: text({ mode: "json" }).notNull(),
  rev: integer().notNull().default(1),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
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

    removedAt: integer("removed_at", { mode: "timestamp" }),
    removedBy: text("removed_by"),
  },
  (t) => [
    index("documents_category_idx").on(t.category, t.bucket),
    index("documents_folder_idx").on(t.folder, t.checksum),
  ],
);

/**
 * The JSON records the Netlify build kept in named blob stores — certificate
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
