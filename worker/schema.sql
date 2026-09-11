-- The portal's D1 schema. Run with:
--   npx wrangler d1 execute portal --local  --file=./schema.sql   (dev)
--   npx wrangler d1 execute portal --remote --file=./schema.sql   (live)
-- Column names line up with src/db/schema.ts; change them together.

CREATE TABLE IF NOT EXISTS portal_state (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  bucket TEXT,
  blob_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  title TEXT,
  uploaded_by TEXT,
  tag TEXT,
  source TEXT,
  party TEXT,
  rank TEXT,
  swing TEXT,
  filed_on TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  person TEXT,
  folder TEXT,
  qual_code TEXT,
  expires_on TEXT,
  checksum TEXT,
  removed_at INTEGER,
  removed_by TEXT
);

CREATE INDEX IF NOT EXISTS documents_category_idx ON documents (category, bucket);
CREATE INDEX IF NOT EXISTS documents_folder_idx ON documents (folder, checksum);

-- The JSON records the Netlify build kept in named blob stores. Strongly
-- consistent on purpose: poll loops read these back the moment after they are
-- written.
CREATE TABLE IF NOT EXISTS blobs (
  store TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  -- The version mark conditional writes compare against (job claiming).
  etag TEXT,
  PRIMARY KEY (store, key)
);
