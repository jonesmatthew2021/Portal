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

-- Every save of the row above, newest 200 kept, so any of them can be put
-- back from the Access Grants page. The three counts are what that page
-- lists against each save; worked out at save time so listing the history
-- never has to read the documents back. The worker creates this table
-- itself the first time it is needed (src/routes/state.ts), so the live
-- database needed no hand-run migration. Added 23 Sep 2026.
CREATE TABLE IF NOT EXISTS portal_state_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portal_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  data TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  saved_by TEXT,
  crew INTEGER,
  matrix_rows INTEGER,
  dated_cells INTEGER
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
  -- What the portal read off the document itself, kept apart from qual_code
  -- and expires_on, which are what a person typed against it. A person's
  -- answer beats a reading everywhere the two are weighed, and merging them
  -- would throw that away. Added 21 Sep 2026; existing tables got these via
  -- ALTER TABLE documents ADD COLUMN.
  --
  -- These are what make the books stand on their own. Before them, which item
  -- a certificate was for and when it ran out lived only in a reading cache
  -- keyed by the file's contents - so a certificate deleted from SharePoint
  -- took its own details with it, and nothing could work out afterwards which
  -- cell of the matrix it had filled.
  read_code TEXT,
  read_expires TEXT,
  read_issued TEXT,
  read_issuer TEXT,
  read_title TEXT,
  read_at INTEGER,
  removed_at INTEGER,
  removed_by TEXT,
  -- Whose file this is in the library. adopted_from_folder = 1 where the
  -- sync took it on from a folder the office put it in; such a file is never
  -- moved by the portal, and when it is replaced its row is marked removed
  -- with the bytes left where they are, kept_in_place = 1. Added 24 Sep
  -- 2026; the worker adds them itself to an existing table
  -- (ensureDocumentColumns in src/db/documents.ts).
  adopted_from_folder INTEGER,
  kept_in_place INTEGER,
  -- What paper a certificate row is, where the person filing it said: one of
  -- the five that stand in for a certificate (extension, lodged-renewal,
  -- crewing-permit, assessor-declaration, issue-letter), beside qual_code,
  -- which is then the column the paper is about. NULL is a certificate.
  -- Added 25 Sep 2026; the worker adds it itself to an existing table
  -- (ensureDocumentColumns in src/db/documents.ts).
  evidence_kind TEXT
);

CREATE INDEX IF NOT EXISTS documents_category_idx ON documents (category, bucket);
CREATE INDEX IF NOT EXISTS documents_folder_idx ON documents (folder, checksum);

-- Real per-person access. A user signs in with their email and a one-time
-- code sent to it; a session cookie keeps them in. Three roles, enforced by
-- the server on every request: 'it' (everything, including the maintenance
-- machinery), 'management' (everything but the machinery), 'crew' (read and
-- comment only).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  last_login INTEGER,
  -- Optional mobile (+614...), for sign-in codes by text instead of email.
  -- Added 13 Sep 2026; existing tables got it via ALTER TABLE users ADD COLUMN.
  phone TEXT
);

-- One live code per person at a time; hashed, short-lived, few attempts.
-- The email column holds whichever identifier was typed at the door: an
-- email address or a normalised mobile number.
CREATE TABLE IF NOT EXISTS login_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

-- Every knock on the door, wanted or not: code requests, unknown addresses
-- probing the sign-in, wrong codes, lockouts, sign-ins, and refused actions.
-- What the Access Grants page's traffic view reads to spot anyone trying
-- their luck. Kept ninety days.
CREATE TABLE IF NOT EXISTS login_events (
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  email TEXT,
  ip TEXT,
  country TEXT,
  ua TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS login_events_ts_idx ON login_events (ts);

-- The Marine Fauna Observation Log: one row per sighting (or per nil-sighting
-- watch), spoken into the phone app at /fauna/. data is the whole entry as
-- JSON, keyed the way source/fauna/fields.js names the log's columns; month
-- and at are pulled out for listing and for the month export. Taken off with
-- deleted_at rather than deleted. The worker creates this table itself the
-- first time it is needed (src/routes/fauna.ts). Added 24 Sep 2026.
CREATE TABLE IF NOT EXISTS fauna_sightings (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  at TEXT NOT NULL,
  observer TEXT,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  -- Where the entry sits in the month's workbook in SharePoint
  -- (SHAREPOINT_FAUNA_FOLDER): which month's file, the tab and row it was
  -- written to and when, so a change rewrites the same row, a removal blanks
  -- it, and an entry moved to another month is blanked in the old file.
  -- write_error is why the last attempt failed; the hour tries again. The
  -- worker adds these to an existing table itself.
  written_at INTEGER,
  written_month TEXT,
  written_tab TEXT,
  written_row INTEGER,
  write_error TEXT
);

-- The JSON records the earlier build kept in named blob stores. Strongly
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
