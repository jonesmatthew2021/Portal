import type { PortalUser } from "../auth.js";
import { getStore } from "../compat/blobs.js";
import {
  dropLease, keepEquivalences, keepValidityRules, leaseHolder, renewLease, roundRunning, runMatrixRound, takeLease,
  validityRulesHeld, writingTheWorkbook,
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
 *   GET  /api/round/progress   where the round has got to (progressAnswer,
 *                              called from index.ts).
 *
 * The page does the reading and the refile before it comes here, and
 * Update portal runs POST /api/sync first; this route only compares, saves
 * and writes. So the request is held open while it runs, with a budget of
 * two minutes, and the page reads /api/round/progress for the percentage.
 *
 * What a closed tab leaves behind. A request whose browser has gone can be
 * cancelled by the platform: waitUntil keeps it alive for thirty seconds
 * past the disconnect, not to its end. So nothing here may depend on
 * reaching the end:
 *   - each saveDocument is one conditional write against the revision it
 *     read, so the matrix is whole or untouched;
 *   - the workbook goes through replaceSingleFile, whose order of work is
 *     fixed so the old copy is never lost;
 *   - a cell that reaches the matrix but not the workbook is written on the
 *     document (workbookPending) and paid by the next round, whoever runs it;
 *   - the lease is taken for the budget plus two minutes, not the hour's
 *     fifteen, so a round cut off frees it before the hour's five-minute
 *     wait for it runs out - and renewed for the same again on every word
 *     of progress (renewLease), so a workbook write that runs past it
 *     keeps the lease and a lapsed lease only ever means a dead round;
 *   - the progress record carries the page's own runId and stays done:false
 *     until the round says otherwise. A page treats a record that is not
 *     done as dead once the lease is no longer held under the record's
 *     `by` (`running` false, or `holder` another name - the hour can take
 *     a lapsed lease within fifteen seconds and hold it for up to nine
 *     minutes plus its write); the lease lapses at LEASE_FOR_MS. Never by the age of
 *     `at`, because the workbook step between 75 and 100 (the rewrite,
 *     then the replace in the library) can take longer than any word is
 *     fresh for.
 */
const PROGRESS_KEY = "round-progress";
export const BUDGET_MS = 2 * 60 * 1000;
/** How long the lease stands from its take, and from each word of progress
 *  that renews it, should the drop never land. The budget only decides
 *  whether the workbook step may start; the rewrite and the replace in the
 *  library run on past it, so two minutes are kept in hand for the write in
 *  flight - and the hour's last try for the lease is at five, so a dead
 *  round still frees it in time. */
export const LEASE_FOR_MS = BUDGET_MS + 2 * 60 * 1000;

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

/** What GET /api/round/progress answers: the last progress record, or the
 *  word that none has run, whether anybody holds the lease right now, and
 *  who. `holder` is what tells a page its own round's lease from one the
 *  hour took after that round died: `running` alone is true for either.
 *  The record is never called dead here; the page matches its runId. */
export async function progressAnswer(): Promise<Record<string, unknown>> {
  const rec = (await roundProgress().catch(() => null)) as Record<string, unknown> | null;
  return {
    ...(rec ?? { pct: 0, word: "No round has run yet", done: true }),
    running: await roundRunning().catch(() => false),
    holder: await leaseHolder().catch(() => null),
  };
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

/**
 * `keepAlive` is the platform's waitUntil: the work is registered with it
 * as well as awaited, so a browser that goes mid-round does not take the
 * round's record, its lease drop or its last progress word with it.
 */
export default async function round(
  req: Request, user: PortalUser | null, path: string, keepAlive?: (work: Promise<unknown>) => void,
): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (path === "/api/round/prepare") {
    try {
      return await prepare();
    } catch (e) {
      return Response.json({ error: said(e) }, { status: 502 });
    }
  }

  // Who is running it: the name the page sends, else the person signed in,
  // else the page itself. It goes on the lease, the log and the record.
  // The runId is the page's own mark for this round, carried on every
  // progress word so the page matches its round by it, never by the clock.
  const sent = await req.json().catch(() => null) as { by?: unknown; runId?: unknown } | null;
  const who = (sent && typeof sent.by === "string" && sent.by.trim() ? sent.by.trim() : (user?.name || user?.email || "").trim() || "the page").slice(0, 40);
  const runId = sent && typeof sent.runId === "string" && sent.runId.trim() ? sent.runId.trim().slice(0, 64) : crypto.randomUUID();

  const lease = await takeLease(who, undefined, LEASE_FOR_MS);
  if (!lease) {
    // The same sentence every writer of the workbook answers with, naming
    // the holder (writingTheWorkbook in lib/round.ts); `who` above is the
    // caller, `holder` is who they wait for.
    const holder = await leaseHolder();
    return Response.json({ error: writingTheWorkbook(holder), by: holder, runId }, { status: 409 });
  }
  const work = (async () => {
    const t0 = Date.now();
    const timeLeft = () => Date.now() - t0 < BUDGET_MS;
    // Every word of progress also keeps the lease: it was taken short, so
    // a round cut off frees it soon, and a live round that runs long - the
    // workbook step can - holds on to it by saying so. The last word is
    // followed by the drop, so it renews nothing.
    const say = async (pct: number, word: string, extra: Record<string, unknown> = {}) => {
      await sayRound(pct, word, { by: who, runId, ...extra });
      if (extra.done) return;
      try {
        await renewLease(lease.token, LEASE_FOR_MS);
      } catch (e) {
        console.error("the round's lease was not renewed:", e);
      }
    };
    try {
      await say(1, "Starting");
      // Idempotent: an hour or a prepare that already kept it costs a look.
      // The expiry rules are kept inside the round itself.
      const eq = await keepEquivalences();
      const outcome = await runMatrixRound({ by: who, timeLeft, mirroredThisHour: 0, lease, say });
      // The line on the SharePoint page: the counts, not the cells. A
      // workbook the server cannot write is a reason for the open tab to
      // run the round itself, so it goes where the tab reads it.
      const { changes, summary, ...forRecord } = outcome;
      try {
        await recordHourly({
          ...forRecord, roundSkipped: forRecord.roundSkipped ?? forRecord.workbookProblem ?? null, equivalenceProblem: eq.problem,
          at: t0, durationMs: Date.now() - t0, by: who, read: 0, refiled: 0, syncError: null, readError: null,
        });
      } catch (e) {
        console.error("the round's record was not written:", e);
      }
      await say(100, "Done", { done: true });
      return Response.json({ ...outcome, changes, summary, equivalenceProblem: eq.problem, runId }, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      // The plumbing itself failing: on the record too, so the SharePoint
      // page does not keep showing the round before as the last word.
      const error = said(e);
      await recordHourly({ at: t0, durationMs: Date.now() - t0, by: who, read: 0, refiled: 0, syncError: null, readError: null, roundError: error })
        .catch((e2) => console.error("the round's failure was not recorded:", e2));
      await say(100, "Failed", { done: true, error });
      return Response.json({ error, runId }, { status: 502 });
    } finally {
      try {
        await dropLease(lease.token);
      } catch (e) {
        console.error("the round's lease was not dropped:", e);
      }
    }
  })();
  if (keepAlive) keepAlive(work);
  return await work;
}
