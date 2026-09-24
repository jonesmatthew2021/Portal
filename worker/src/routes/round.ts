import type { PortalUser } from "../auth.js";
import { getStore } from "../compat/blobs.js";
import {
  dropLease, keepEquivalences, keepValidityRules, runMatrixRound, takeLease, validityRulesHeld, type Lease,
} from "../lib/round.js";
import { recordHourly } from "./sync.js";

/**
 * The hour's round, started from the page.
 *
 *   POST /api/round            the round itself: the certificates' dates put
 *                              on the crew matrix and written into the
 *                              office's workbook, by the same code the hour
 *                              runs (lib/round.ts), under the same lease.
 *   POST /api/round/prepare    the rules the round reads by - the Equivalence
 *                              sheet and the expiry rules off the skills
 *                              matrix - kept on the server before the page
 *                              does its own reading and refiling.
 *   GET  /api/round/progress   where the round has got to (index.ts).
 *
 * The page does the reading and the refile before it comes here, and
 * Update portal runs POST /api/sync first; this route only prepares,
 * compares, saves and writes. So a browser-held request is enough, with a
 * budget of four minutes against the page's own patience.
 *
 * What a closed tab leaves behind. The request runs on regardless of the
 * tab, to its end or its budget, and nothing it does is half done:
 *   - each saveDocument is one conditional write against the revision it
 *     read, so the matrix is whole or untouched;
 *   - the workbook goes through replaceSingleFile, whose order of work is
 *     fixed so the old copy is never lost;
 *   - a cell that reaches the matrix but not the workbook is written on the
 *     document (workbookPending) and paid by the next round, whoever runs it;
 *   - the lease runs out on its own after LEASE_MS should the drop not land;
 *   - the progress record stays done:false until the round says otherwise,
 *     and a page compares its `at` with its own start rather than trusting
 *     the server to call it dead.
 */
const PROGRESS_KEY = "round-progress";
const BUDGET_MS = 4 * 60 * 1000;

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The round's own running commentary - its own key, never the sync's. */
async function sayRound(pct: number, word: string, extra: Record<string, unknown> = {}) {
  try {
    await getStore("sync").setJSON(PROGRESS_KEY, { pct: Math.round(pct), word, done: false, at: Date.now(), ...extra });
  } catch (e) {
    console.error("round progress not written:", e);
  }
}

export const roundProgress = () => getStore("sync").get(PROGRESS_KEY, { type: "json" });

/** Whose lease stands, for a 409 that says who to wait for. */
async function leaseHolder(): Promise<string | null> {
  const held = await getStore("sync").getWithMetadata("round-lease", { type: "json" }).catch(() => null);
  const lease = held ? (held.data as Lease | null) : null;
  return lease && lease.until > Date.now() ? lease.by : null;
}

/** The rules kept, without the lease: nothing here writes the workbook. */
export async function prepare(): Promise<Response> {
  const eq = await keepEquivalences();
  let validity: string | null = null;
  try {
    validity = await keepValidityRules();
  } catch (e) {
    validity = `The expiry rules could not be read off the skills matrix. ${said(e)}`;
  }
  return Response.json(
    { equivalences: eq.rows, validity: await validityRulesHeld(), problem: eq.problem ?? validity },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export default async function round(req: Request, user: PortalUser | null, path: string): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (path === "/api/round/prepare") {
    try {
      return await prepare();
    } catch (e) {
      return Response.json({ error: said(e) }, { status: 502 });
    }
  }

  // Who is running it: the name the page sends, else the person signed in,
  // else the button's own name. It goes on the lease, the log and the record.
  const sent = await req.json().catch(() => null) as { by?: unknown } | null;
  const who = (sent && typeof sent.by === "string" && sent.by.trim() ? sent.by.trim() : (user?.name || "").trim() || "Update matrix").slice(0, 40);

  const lease = await takeLease(who);
  if (!lease) {
    return Response.json(
      { error: "The hourly round is writing the workbook; try again in a minute.", by: await leaseHolder() },
      { status: 409 },
    );
  }
  const t0 = Date.now();
  const timeLeft = () => Date.now() - t0 < BUDGET_MS;
  const say = (pct: number, word: string, extra: Record<string, unknown> = {}) => sayRound(pct, word, { by: who, ...extra });
  try {
    await say(1, "Starting");
    // Both idempotent: an hour or a prepare that already kept them costs a look.
    await keepEquivalences();
    try { await keepValidityRules(); } catch (e) { console.error("the expiry rules were not kept:", e); }
    const outcome = await runMatrixRound({ by: who, timeLeft, mirroredThisHour: 0, lease, say });
    // The line on the SharePoint page: the counts, not the cells.
    const { changes, summary, ...forRecord } = outcome;
    try {
      await recordHourly({ ...forRecord, at: t0, durationMs: Date.now() - t0, by: who, read: 0, refiled: 0, syncError: null, readError: null });
    } catch (e) {
      console.error("the round's record was not written:", e);
    }
    await say(100, "Done", { done: true });
    return Response.json({ ...outcome, changes, summary }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const error = said(e);
    await say(100, "Failed", { done: true, error });
    return Response.json({ error }, { status: 502 });
  } finally {
    try {
      await dropLease(lease.token);
    } catch (e) {
      console.error("the round's lease was not dropped:", e);
    }
  }
}
