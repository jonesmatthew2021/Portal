import { PORTAL_ROW_ID } from "../db/schema.js";
import { getEnv } from "../env.js";

/**
 * The portal's one shared document, read and changed from the worker itself.
 *
 * The page saves through PUT /api/state with the revision it read, and a
 * save on a stale revision is refused (routes/state.ts). The hourly round
 * has no page: it reads the document, works out its change, and saves it
 * the same way - and where somebody's save landed in between, it reads
 * again and works the change out again from what is there now, up to a
 * handful of tries. The change function must take everything it needs from
 * the document it is handed, never from an earlier read.
 *
 * The history helpers live here too, so the route and the round share one
 * copy of them.
 */
const ROW_ID = PORTAL_ROW_ID;

/* D1 holds a row of at most 2 MB, and the whole document is one row. The
   route refuses a bigger save and so does the round, against the same
   number - the old limit here was 5 MB, which the database would have
   refused anyway, in a less helpful voice. */
export const MAX_BYTES = 2_000_000;

export const HISTORY_KEEP = 200;

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


/* --------------------------------------------------------- the document ---- */

export type SharedDocument = Record<string, unknown> & {
  quals?: { cols?: unknown[]; rows?: unknown[] } | null;
  people?: { name?: string; aliases?: string[] }[] | null;
  filledFromCert?: Record<string, boolean> | null;
  orphanSeen?: Record<string, string> | null;
  history?: unknown[] | null;
  matrixUpdated?: string;
  lastDocUpdate?: string;
};

/** The document as it is now, with the revision it is at; null before the
 *  first save ever. */
export async function readDocument(): Promise<{ doc: SharedDocument; rev: number } | null> {
  const row = await getEnv()
    .DB.prepare("SELECT data, rev FROM portal_state WHERE id = ?1")
    .bind(ROW_ID)
    .first<{ data: string; rev: number }>();
  if (!row) return null;
  return { doc: JSON.parse(row.data) as SharedDocument, rev: row.rev };
}

export type Remember = (rev: number, dataText: string, savedBy: string, counts: HistoryCounts) => Promise<void>;

/**
 * One change to the document, saved against the revision it was worked out
 * from. `change` is handed a copy of the document as just read and gives
 * back the document to save, or null to save nothing at all - no revision
 * bump, no history entry, nothing for an open page to notice.
 *
 * Where the revision has moved on by the time the save lands, the document
 * is read again and `change` is asked again on the fresh copy. After
 * `tries` goes the error is a plain one.
 */
export async function saveDocument(
  change: (doc: SharedDocument) => SharedDocument | null,
  savedBy: string,
  opts: { remember?: Remember; tries?: number } = {},
): Promise<{ rev: number; changed: boolean }> {
  const remember: Remember = opts.remember ?? (async (rev, text, by, counts) => {
    // The save has landed by the time the history is written, so a history
    // hiccup is logged rather than reported as a failed save.
    try {
      await recordHistory(rev, text, by, counts);
    } catch (e) {
      console.error("portal_state_history write failed:", e);
    }
  });
  const tries = opts.tries ?? 5;

  for (let go = 0; go < tries; go++) {
    const cur = await readDocument();
    if (!cur) throw new Error("no shared document yet");
    const next = change(structuredClone(cur.doc));
    if (next === null) return { rev: cur.rev, changed: false };

    const text = JSON.stringify(next);
    const size = new TextEncoder().encode(text).length;
    if (size > MAX_BYTES) {
      throw new Error(`the document would be ${(size / (1024 * 1024)).toFixed(1)} MB, over the ${(MAX_BYTES / (1024 * 1024)).toFixed(1)} MB the database holds`);
    }

    const saved = await getEnv()
      .DB.prepare(
        "UPDATE portal_state SET data = ?2, rev = rev + 1, updated_at = ?3 " +
          "WHERE id = ?1 AND rev = ?4",
      )
      .bind(ROW_ID, text, Math.floor(Date.now() / 1000), cur.rev)
      .run();
    if ((saved.meta?.changes ?? 0) > 0) {
      await remember(cur.rev + 1, text, savedBy, countsOf(next));
      return { rev: cur.rev + 1, changed: true };
    }
    // Somebody saved in between: read again and work the change out again.
  }
  throw new Error(`the shared document kept changing under the save (${tries} tries); nothing was written`);
}
