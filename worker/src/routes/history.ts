import type { PortalUser } from "../auth.js";
import { PORTAL_ROW_ID } from "../db/schema.js";
import { getEnv } from "../env.js";
import { ensureHistoryTable, recordHistory, countsOf } from "./state.js";

/**
 * The portal's undo.
 *
 *   GET  /api/state/history   the last saves, newest first — when, who, and
 *                             how much was on the portal at the time
 *   POST /api/state/restore   { rev } — puts that saved version back as the
 *                             current state, as a new save on top of
 *                             everything, so every open tab picks it up on
 *                             its next look and nothing since is lost
 *
 * Management and IT only. Crew can read the portal but never its history.
 */

const ROW_ID = PORTAL_ROW_ID;
const LIST_MAX = 50;

type HistoryRow = {
  rev: number;
  saved_at: number;
  saved_by: string | null;
  crew: number | null;
  matrix_rows: number | null;
  dated_cells: number | null;
};

export async function history(req: Request, actor: PortalUser): Promise<Response> {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  if (actor.role === "crew") {
    return Response.json({ error: "The portal's history is read by Management and IT Help." }, { status: 403 });
  }
  await ensureHistoryTable();
  const out = await getEnv()
    .DB.prepare(
      "SELECT rev, saved_at, saved_by, crew, matrix_rows, dated_cells FROM portal_state_history " +
        "WHERE portal_id = ?1 ORDER BY id DESC LIMIT ?2",
    )
    .bind(ROW_ID, LIST_MAX)
    .all<HistoryRow>();
  const revisions = (out.results || []).map((r) => ({
    rev: r.rev,
    savedAt: r.saved_at,
    savedBy: r.saved_by,
    crew: r.crew ?? 0,
    matrixRows: r.matrix_rows ?? 0,
    datedCells: r.dated_cells ?? 0,
  }));
  return Response.json({ revisions }, { headers: { "Cache-Control": "no-store" } });
}

export async function restore(req: Request, actor: PortalUser): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (actor.role === "crew") {
    return Response.json({ error: "Only Management and IT Help can put an earlier version back." }, { status: 403 });
  }

  let body: { rev?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "The request couldn't be read." }, { status: 400 });
  }
  const rev = Number(body.rev);
  if (!Number.isInteger(rev) || rev < 1) {
    return Response.json({ error: "Which saved version to put back wasn't said." }, { status: 400 });
  }

  await ensureHistoryTable();
  const db = getEnv().DB;
  // The newest row for that rev wins should the same number ever appear
  // twice (a restore takes the next number like any save, so it shouldn't).
  const old = await db
    .prepare(
      "SELECT data FROM portal_state_history WHERE portal_id = ?1 AND rev = ?2 ORDER BY id DESC LIMIT 1",
    )
    .bind(ROW_ID, rev)
    .first<{ data: string }>();
  if (!old) {
    return Response.json({ error: `Saved version ${rev} is no longer kept.` }, { status: 404 });
  }

  // The same rev + 1 step every save takes, so the open tabs see a newer
  // number and reload rather than keep what they have. No rev check here:
  // whatever was current, the restored version now stands on top of it.
  const put = await db
    .prepare(
      "UPDATE portal_state SET data = ?2, rev = rev + 1, updated_at = ?3 WHERE id = ?1 RETURNING rev",
    )
    .bind(ROW_ID, old.data, Math.floor(Date.now() / 1000))
    .first<{ rev: number }>();
  if (!put) {
    return Response.json({ error: "The portal has nothing saved yet to put a version back over." }, { status: 409 });
  }

  // The restore is itself a save on the record, and says which version it
  // brought back — so it can be undone the same way as anything else.
  let counts = { crew: 0, matrixRows: 0, datedCells: 0 };
  try { counts = countsOf(JSON.parse(old.data)); } catch { /* counts stay at nought */ }
  try {
    await recordHistory(put.rev, old.data, `${actor.name} restored rev ${rev}`, counts);
  } catch (e) {
    console.error("portal_state_history write failed after restore:", e);
  }
  return Response.json({ rev: put.rev }, { headers: { "Cache-Control": "no-store" } });
}
