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
