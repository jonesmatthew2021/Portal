import { PORTAL_ROW_ID } from "../db/schema.js";
import { getEnv } from "../env.js";
import type { PortalUser } from "../auth.js";
import { crewStateView } from "../authz.js";
import { MAX_BYTES, recordHistory, countsOf } from "../lib/shared-state.js";
// The history helpers live with the shared-state code now (lib/shared-state.ts);
// re-exported here so history.ts keeps its imports.
export { HISTORY_KEEP, ensureHistoryTable, recordHistory, countsOf, type HistoryCounts } from "../lib/shared-state.js";

/**
 * The portal's one shared row — ported from the earlier build unchanged in
 * behaviour. The only host difference: SQLite has no now(), so the timestamp
 * is stamped from here.
 *
 * Every save also goes into portal_state_history, so the last 200 saved
 * versions can be looked at and any one of them put back (see history.ts).
 */
const ROW_ID = PORTAL_ROW_ID;

function humanSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const NO_STORE = { "Cache-Control": "no-store" };

// Raw D1 and raw strings throughout this route on purpose: the state is a
// ~600 KB JSON document, every open portal polls this endpoint every few
// seconds, and parsing-and-restringifying it per poll (which the ORM's
// json-mode column does) was enough CPU to trip a per-request budget. The
// stored value is already the JSON to serve, so it is passed through
// byte-for-byte and never parsed here.
async function currentRaw() {
  return await getEnv()
    .DB.prepare("SELECT data, rev FROM portal_state WHERE id = ?1")
    .bind(ROW_ID)
    .first<{ data: string; rev: number }>();
}

/* -------------------------------------------------------------- route ---- */

export default async (req: Request, savedBy: string | null = null, role: PortalUser["role"] | null = null) => {
  // The stored JSON as this grant is handed it: byte for byte, but crew get
  // the crew's copy (authz.ts) - on a GET and on a save answered 409 alike.
  const dataFor = (row: { data: string; rev: number }) =>
    role === "crew" ? crewStateView(row.rev, row.data) : row.data;

  if (req.method === "GET") {
    const row = await currentRaw();
    const body = row ? `{"rev":${row.rev},"data":${dataFor(row)}}` : '{"rev":0,"data":null}';
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
      ? `{"conflict":true,"rev":${row.rev},"data":${dataFor(row)}}`
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
