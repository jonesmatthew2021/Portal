import type { PortalUser } from "../auth.js";
import { getEnv } from "../env.js";
import { MAX_BYTES, saveDocument, type SharedDocument } from "../lib/shared-state.js";
import { READING_STORES } from "../lib/backup.js";
import { PORTAL_ROW_ID } from "../db/schema.js";
import { vessel } from "../vessel.js";
import { ensureTable as ensureFaunaTable } from "./fauna.js";

/**
 * POST /api/state/restore-file — a nightly backup put back.
 *
 * The body is the backup file itself (lib/backup.ts writes it). By default
 * only the shared document is put back - the crew register, the matrix, the
 * roster, the notes - as a new save on top of everything, so every open
 * tab picks it up and nothing is lost that a later restore could not bring
 * back. The file index, the users, the readings and the fauna log are left
 * alone unless the request names them, and the answer says which it left.
 *
 * There is no button for this; it is run from a terminal by whoever holds
 * the file, signed in as management or IT (the cookie from the browser):
 *
 *   curl -X POST https://<the portal's domain>/api/state/restore-file \
 *     -H "content-type: application/json" -H "cookie: portal_session=<from the browser>" \
 *     --data-binary @"Crew Portal backup 2026-09-24.json"
 *
 * To put the other parts back as well, name them on the address, or as
 * `"what": ["readings", "documents", "users", "fauna"]` in the body:
 *
 *   curl -X POST "https://<the portal's domain>/api/state/restore-file?what=readings,documents" ...
 *
 * Those rows go in through the database's own batch, eighty at a time and
 * every value bound, never as SQL text - D1 refuses a statement over 100 KB,
 * and a backup is megabytes.
 */

const PARTS = ["documents", "users", "readings", "fauna"] as const;
type Part = (typeof PARTS)[number];

// The columns each table has, as schema.sql names them. Only these are
// written, by name from this list and never from the file, so the SQL is
// the portal's own whatever the file says.
const COLUMNS: Record<Exclude<Part, "readings">, string[]> = {
  documents: [
    "id", "category", "bucket", "blob_key", "filename", "content_type", "size_bytes", "title", "uploaded_by",
    "tag", "source", "party", "rank", "swing", "filed_on", "session_id", "created_at", "person", "folder",
    "qual_code", "expires_on", "checksum", "read_code", "read_expires", "read_issued", "read_issuer",
    "read_title", "read_at", "removed_at", "removed_by", "adopted_from_folder", "kept_in_place",
  ],
  users: ["id", "email", "name", "role", "disabled", "created_at", "created_by", "last_login", "phone"],
  fauna: [
    "id", "month", "at", "observer", "data", "created_at", "updated_at", "deleted_at",
    "written_at", "written_month", "written_tab", "written_row", "write_error",
  ],
};
const TABLE: Record<Exclude<Part, "readings">, string> = { documents: "documents", users: "users", fauna: "fauna_sightings" };

const BATCH = 80;

type BackupFile = {
  portal?: unknown;
  backupVersion?: unknown;
  perthDay?: unknown;
  document?: unknown;
  documents?: unknown;
  users?: unknown;
  readings?: unknown;
  fauna?: unknown;
  what?: unknown;
};

const bad = (error: string, status = 400) => Response.json({ error }, { status });

// A value as the database takes it: text, a number or nothing. Anything
// else in a row (there should be nothing else) goes in as its JSON.
const bound = (v: unknown) =>
  v === null || v === undefined ? null : typeof v === "number" || typeof v === "string" ? v : typeof v === "boolean" ? (v ? 1 : 0) : JSON.stringify(v);

export default async (req: Request, actor: PortalUser): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (actor.role === "crew") return bad("A backup is put back by Management and IT Help.", 403);

  let file: BackupFile;
  try {
    file = (await req.json()) as BackupFile;
  } catch {
    return bad("The file couldn't be read as JSON.");
  }
  if (!file || typeof file !== "object") return bad("That isn't a backup file.");
  if (file.portal !== vessel.slug) return bad(`That isn't a ${vessel.shortName} backup: the file's portal mark is wrong.`);
  if (file.backupVersion !== 1) return bad(`This portal doesn't know backup version ${String(file.backupVersion)}.`);
  if (typeof file.document !== "string") return bad("The backup holds no shared document.");
  const perthDay = typeof file.perthDay === "string" ? file.perthDay : "an unknown day";
  if (new TextEncoder().encode(file.document).length > MAX_BYTES) {
    return bad(`The document in this backup is over the ${(MAX_BYTES / (1024 * 1024)).toFixed(1)} MB the database holds.`, 413);
  }
  let doc: SharedDocument;
  try {
    doc = JSON.parse(file.document) as SharedDocument;
    if (!doc || typeof doc !== "object") throw new Error("not an object");
  } catch {
    return bad("The document in this backup isn't readable JSON.");
  }

  // Which of the other parts to put back: named on the address or in the body.
  const asked = new URL(req.url).searchParams.get("what");
  const named = asked ? asked.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(file.what) ? file.what.map(String) : [];
  const what = [...new Set(named)] as string[];
  const unknown = what.filter((w) => !(PARTS as readonly string[]).includes(w));
  if (unknown.length) return bad(`This portal can't put back "${unknown.join('", "')}"; it knows ${PARTS.join(", ")}.`);
  // The readings are the four stores the backup writes and no other: a
  // store the file names for itself - the sync store, with the lease and
  // the hour's records in it, or a job store - is refused before anything
  // is written, the same rule as the columns: names from the portal, never
  // from the file.
  const stores = what.includes("readings") && file.readings && typeof file.readings === "object"
    ? (file.readings as Record<string, Record<string, unknown>>)
    : {};
  const strange = Object.keys(stores).filter((s) => !READING_STORES.includes(s));
  if (strange.length) return bad(`This portal can't put back the store "${strange.join('", "')}"; a backup's readings are ${READING_STORES.join(", ")}.`);

  const db = getEnv().DB;
  // A wiped or brand-new database has no state row yet, and a save is a
  // save over one. An empty row is put there first, only where there is
  // none, so the restore lands on it as the first revision - the very
  // case a backup is kept for.
  await db
    .prepare("INSERT INTO portal_state (id, data, rev, updated_at) VALUES (?1, '{}', 0, ?2) ON CONFLICT (id) DO NOTHING")
    .bind(PORTAL_ROW_ID, Math.floor(Date.now() / 1000))
    .run();

  // The document first, as a save like any other, under a name of its own -
  // a burst of saves by one name is kept as one version, and this must not
  // fold into whatever was saved a minute before it.
  let rev: number;
  try {
    ({ rev } = await saveDocument(() => doc, `${actor.name} restored the backup of ${perthDay}`));
  } catch (e) {
    return bad("The document was not put back: " + (e instanceof Error ? e.message : String(e)), 409);
  }

  const rows: Record<string, number> = {};
  const run = async (stmts: D1PreparedStatement[]) => {
    for (let i = 0; i < stmts.length; i += BATCH) await db.batch(stmts.slice(i, i + BATCH));
  };
  for (const part of what as Part[]) {
    if (part === "readings") {
      const stmts: D1PreparedStatement[] = [];
      for (const [store, entries] of Object.entries(stores)) {
        if (!entries || typeof entries !== "object") continue;
        for (const [key, value] of Object.entries(entries)) {
          // A value the backup could not keep as JSON went in as text with a note; it comes back as that text.
          const kept = value && typeof value === "object" && (value as { note?: unknown }).note === "not JSON as stored"
            && typeof (value as { text?: unknown }).text === "string"
            ? (value as { text: string }).text
            : JSON.stringify(value);
          stmts.push(
            db.prepare("INSERT OR REPLACE INTO blobs (store, key, value, updated_at, etag) VALUES (?1, ?2, ?3, ?4, ?5)")
              .bind(store, key, kept, Date.now(), crypto.randomUUID()),
          );
        }
      }
      await run(stmts);
      rows.readings = stmts.length;
      continue;
    }
    const list = Array.isArray(file[part]) ? (file[part] as unknown[]) : [];
    if (part === "fauna" && list.length) await ensureFaunaTable();
    const cols = COLUMNS[part];
    const stmts: D1PreparedStatement[] = [];
    for (const row of list) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      if (typeof r.id !== "string" || !r.id) continue;
      const present = cols.filter((c) => c in r);
      const marks = present.map((_, i) => `?${i + 1}`).join(", ");
      stmts.push(
        db.prepare(`INSERT OR REPLACE INTO ${TABLE[part]} (${present.join(", ")}) VALUES (${marks})`)
          .bind(...present.map((c) => bound(r[c]))),
      );
    }
    await run(stmts);
    rows[part] = stmts.length;
  }

  return Response.json(
    {
      rev,
      from: perthDay,
      restored: ["document", ...what],
      notRestored: PARTS.filter((p) => !what.includes(p)),
      rows,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
};
