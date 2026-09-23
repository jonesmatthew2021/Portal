import { PORTAL_ROW_ID } from "../db/schema.js";
import { getEnv } from "../env.js";

/**
 * The portal's one shared row — ported from the earlier build unchanged in
 * behaviour. The only host difference: SQLite has no now(), so the timestamp
 * is stamped from here.
 *
 * Every save also goes into portal_state_history, so the last 200 saved
 * versions can be looked at and any one of them put back (see history.ts).
 */
const ROW_ID = PORTAL_ROW_ID;
const MAX_BYTES = 5 * 1024 * 1024;
export const HISTORY_KEEP = 200;

function humanSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const NO_STORE = { "Cache-Control": "no-store" };

// Raw D1 and raw strings throughout this route on purpose: the state is a
// ~600 KB JSON document, every open portal polls this endpoint every few
// seconds, and parsing-and-restringifying it per poll (which the ORM's
// json-mode column does) was enough CPU to trip the free plan's limit. The
// stored value is already the JSON to serve, so it is passed through
// byte-for-byte and never parsed here.
async function currentRaw() {
  return await getEnv()
    .DB.prepare("SELECT data, rev FROM portal_state WHERE id = ?1")
    .bind(ROW_ID)
    .first<{ data: string; rev: number }>();
}

/* ------------------------------------------------------------ history ---- */

// The history table is made the first time it is needed rather than by a
// migration, so nothing has to be run against the live database by hand. The
// statement is idempotent and costs next to nothing; it runs once per isolate.
// The three counts are worked out at save time, when the document is already
// parsed, so listing the history never has to read 200 documents back.
let historyReady: Promise<unknown> | null = null;
export function ensureHistoryTable() {
  if (!historyReady) {
    historyReady = getEnv()
      .DB.prepare(
        "CREATE TABLE IF NOT EXISTS portal_state_history (" +
          "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
          "portal_id TEXT NOT NULL, " +
          "rev INTEGER NOT NULL, " +
          "data TEXT NOT NULL, " +
          "saved_at INTEGER NOT NULL, " +
          "saved_by TEXT, " +
          "crew INTEGER, " +
          "matrix_rows INTEGER, " +
          "dated_cells INTEGER)",
      )
      .run()
      .catch((e) => {
        // A failed attempt must not be remembered as done.
        historyReady = null;
        throw e;
      });
  }
  return historyReady;
}

export type HistoryCounts = { crew: number; matrixRows: number; datedCells: number };

// What the revisions list shows about each save: how many crew were on the
// register, how many rows the matrix had, and how many cells held a date.
export function countsOf(data: unknown): HistoryCounts {
  const d = (data && typeof data === "object" ? data : {}) as {
    people?: unknown; quals?: { rows?: unknown };
  };
  const people = Array.isArray(d.people) ? d.people : [];
  const rows = d.quals && Array.isArray(d.quals.rows) ? (d.quals.rows as unknown[]) : [];
  let dated = 0;
  for (const r of rows) {
    const cells = Array.isArray(r) && Array.isArray(r[3]) ? (r[3] as unknown[]) : [];
    for (const c of cells) if (/^\d{4}-\d{2}-\d{2}/.test(String(c ?? ""))) dated++;
  }
  return { crew: people.length, matrixRows: rows.length, datedCells: dated };
}

// A burst of saves from the one person — the page saves a couple of seconds
// after typing stops, so one edit is often three saves — is kept as one
// version, the newest, rather than three. Otherwise an afternoon's typing
// would push the version from before a bad hourly round off the end of the
// list, which is the version the list exists to keep.
const COALESCE_MS = 60 * 1000;

// Puts one saved version on the record and lets go of anything older than
// the newest HISTORY_KEEP for this portal.
export async function recordHistory(
  rev: number, dataText: string, savedBy: string | null, counts: HistoryCounts,
) {
  await ensureHistoryTable();
  const db = getEnv().DB;
  const now = Date.now();
  const newest = await db
    .prepare("SELECT id, saved_by, saved_at FROM portal_state_history WHERE portal_id = ?1 ORDER BY id DESC LIMIT 1")
    .bind(ROW_ID)
    .first<{ id: number; saved_by: string | null; saved_at: number }>();
  const sameBurst = !!newest && newest.saved_by === savedBy && now - newest.saved_at < COALESCE_MS;
  const write = sameBurst
    ? db.prepare(
        "UPDATE portal_state_history SET rev = ?2, data = ?3, saved_at = ?4, crew = ?5, matrix_rows = ?6, dated_cells = ?7 WHERE id = ?1",
      ).bind(newest!.id, rev, dataText, now, counts.crew, counts.matrixRows, counts.datedCells)
    : db.prepare(
        "INSERT INTO portal_state_history " +
          "(portal_id, rev, data, saved_at, saved_by, crew, matrix_rows, dated_cells) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      ).bind(ROW_ID, rev, dataText, now, savedBy, counts.crew, counts.matrixRows, counts.datedCells);
  await db.batch([
    write,
    db.prepare(
      "DELETE FROM portal_state_history WHERE portal_id = ?1 AND id NOT IN " +
        "(SELECT id FROM portal_state_history WHERE portal_id = ?1 ORDER BY id DESC LIMIT ?2)",
    ).bind(ROW_ID, HISTORY_KEEP),
  ]);
}

/* -------------------------------------------------------------- route ---- */

export default async (req: Request, savedBy: string | null = null) => {
  if (req.method === "GET") {
    const row = await currentRaw();
    const body = row ? `{"rev":${row.rev},"data":${row.data}}` : '{"rev":0,"data":null}';
    return new Response(body, {
      headers: { ...NO_STORE, "Content-Type": "application/json" },
    });
  }

  if (req.method !== "PUT") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: { rev?: unknown; data?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "The change couldn't be read." }, { status: 400 });
  }

  const base = Number(body.rev);
  if (!Number.isInteger(base) || base < 0) {
    return Response.json({ error: "Missing the revision this change was based on." }, { status: 400 });
  }
  if (body.data === null || typeof body.data !== "object") {
    return Response.json({ error: "The change didn't contain anything to save." }, { status: 400 });
  }

  // One stringify of the incoming data — the string both measures the size
  // and is what gets stored, so it is never re-parsed on the way in or out.
  const dataText = JSON.stringify(body.data);
  const dataSize = new TextEncoder().encode(dataText).length;
  if (dataSize > MAX_BYTES) {
    return Response.json(
      { error: `That change is ${humanSize(dataSize)}. The limit is ${humanSize(MAX_BYTES)}.` },
      { status: 413 },
    );
  }
  const conflict = async () => {
    const row = await currentRaw();
    const payload = row
      ? `{"conflict":true,"rev":${row.rev},"data":${row.data}}`
      : '{"conflict":true,"rev":0,"data":null}';
    return new Response(payload, {
      status: 409,
      headers: { ...NO_STORE, "Content-Type": "application/json" },
    });
  };

  // The save has landed by the time the history is written, so a history
  // hiccup is logged rather than reported as a failed save.
  const remember = async (rev: number) => {
    try {
      await recordHistory(rev, dataText, savedBy, countsOf(body.data));
    } catch (e) {
      console.error("portal_state_history write failed:", e);
    }
  };

  if (base === 0) {
    const seeded = await getEnv()
      .DB.prepare(
        "INSERT INTO portal_state (id, data, rev, updated_at) VALUES (?1, ?2, 1, ?3) " +
          "ON CONFLICT (id) DO NOTHING",
      )
      .bind(ROW_ID, dataText, Math.floor(Date.now() / 1000))
      .run();
    if ((seeded.meta?.changes ?? 0) > 0) {
      await remember(1);
      return Response.json({ rev: 1 });
    }
    return await conflict();
  }

  const saved = await getEnv()
    .DB.prepare(
      "UPDATE portal_state SET data = ?2, rev = rev + 1, updated_at = ?3 " +
        "WHERE id = ?1 AND rev = ?4",
    )
    .bind(ROW_ID, dataText, Math.floor(Date.now() / 1000), base)
    .run();
  if ((saved.meta?.changes ?? 0) > 0) {
    await remember(base + 1);
    return Response.json({ rev: base + 1 });
  }
  return await conflict();
};
