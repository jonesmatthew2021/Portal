import { setEnv, type PortalEnv } from "./env.js";
import { gate, logLoginEvent } from "./auth.js";
import { allowed, crewStateBody, denied } from "./authz.js";
import { fileStore } from "./files/store.js";
import { ensureDocumentColumns } from "./db/documents.js";
import users from "./routes/users.js";
import traffic from "./routes/traffic.js";
import sharepoint from "./routes/sharepoint.js";
import rename from "./routes/rename.js";
import renameFile from "./routes/rename-file.js";
import state from "./routes/state.js";
import { history, restore } from "./routes/history.js";
import restoreFile from "./routes/restore-file.js";
import files from "./routes/files.js";
import file from "./routes/file.js";
import analyse, { extract, refile } from "./routes/analyse.js";
import aiChecker from "./routes/ai-checker.js";
import archive from "./routes/archive.js";
import run from "./routes/run.js";
import sync, { runSync, syncProgress, lastSync, lastHourly, recordHourly } from "./routes/sync.js";
import round, { progressAnswer } from "./routes/round.js";
import migrate from "./routes/migrate.js";
import migrateCerts from "./routes/migrate-certs.js";
import readOne from "./routes/read-one.js";
import clearR2 from "./routes/clear-r2.js";
import importSingle from "./routes/import-single.js";
import fauna, { ensureTable as ensureFaunaTable, settleLog as settleFaunaLog } from "./routes/fauna.js";
import { runMatrixRound, roundRunning, leaseHolder, takeLease, dropLease, keepEquivalences, type Lease } from "./lib/round.js";
import { readDocument } from "./lib/shared-state.js";
import { nightlyBackup } from "./lib/backup.js";
import { crewRowsOnly } from "../../source/shared/names.js";

/** What GET /api/sync/last answers: when the folders were last read and
 *  what the hourly round last did - the round's own word for it, error
 *  included - and whether somebody holds the lease right now, and who. The
 *  page asks this every fifteen seconds while it waits for the lease, so
 *  the name it holds the buttons down under is whoever holds it at each
 *  look, not the one it was first told. */
export async function syncLastAnswer(): Promise<Record<string, unknown>> {
  return {
    sync: await lastSync().catch(() => null),
    hourly: await lastHourly().catch(() => null),
    running: await roundRunning().catch(() => false),
    holder: await leaseHolder().catch(() => null),
  };
}

/**
 * The portal's front door on Cloudflare.
 *
 * The routes are the same ones the page has always called — /api/state,
 * /api/files, /api/files/:id, /api/analyse, /api/ai-checker, /api/archive —
 * plus /api/run/:kind, where the browser starts the long jobs the earlier
 * build handed to background functions. Anything that isn't /api is the page
 * itself, served from the assets directory.
 */
export default {
  // `ctx` is the platform's execution context; its waitUntil keeps a
  // long request's work going for a while after the browser has gone.
  async fetch(req: Request, env: PortalEnv, ctx?: ExecutionContext): Promise<Response> {
    setEnv(env);
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // Real sign-in stands in front of everything: who this is, then what
      // their level allows, decided here for every request.
      const { barred, user } = await gate(req, path);
      if (barred) return barred;
      // The documents table has two columns the worker adds itself; every
      // ORM read of the table names them, so they are there before any
      // route runs. One look per isolate.
      if (path.startsWith("/api/")) await ensureDocumentColumns();
      if (user && path.startsWith("/api/") && !allowed(user, req.method, path)) {
        // A refused action goes in the sign-in book too — someone reaching
        // past their level is exactly what the traffic view is for.
        await logLoginEvent(req, "denied", user.email, `${req.method} ${path}`);
        return denied();
      }

      if (path === "/api/users") return await users(req, user!);
      if (path === "/api/login-events") return await traffic(req, user!);
      if (path === "/api/sharepoint") return await sharepoint(req, user!);
      if (path === "/api/rename-person") return await rename(req, user!);
      if (path === "/api/rename-file") return await renameFile(req, user!);
      const grantMatch = /^\/api\/users\/([^/]+)$/.exec(path);
      if (grantMatch) return await users(req, user!, decodeURIComponent(grantMatch[1]));

      if (path === "/api/state") {
        // A crew save is rebuilt server-side to carry only their comments —
        // read-only means read-only whatever the page happened to send.
        const save = user && user.role === "crew" && req.method === "PUT" ? await crewStateBody(req) : req;
        // The name goes with the save, so the history says who made it.
        return await state(save, user?.name || null);
      }
      // The last 200 saves, and putting one of them back.
      if (path === "/api/state/history") return await history(req, user!);
      if (path === "/api/state/restore") return await restore(req, user!);
      // A nightly backup put back, from a terminal (routes/restore-file.ts).
      if (path === "/api/state/restore-file") return await restoreFile(req, user!);
      if (path === "/api/files" && req.method === "POST" && user && user.role === "crew") {
        // Crew may file certificates and nothing else through this door.
        const form = await req.clone().formData().catch(() => null);
        if (!form || form.get("category") !== "certificate") {
          await logLoginEvent(req, "denied", user.email, "POST /api/files (not a certificate)");
          return denied();
        }
      }
      if (path === "/api/files") return await files(req);
      if (path === "/api/certificates/read-one") return await readOne(req);

      const fileMatch = /^\/api\/files\/([^/]+)$/.exec(path);
      if (fileMatch) {
        return await file(req, { params: { id: decodeURIComponent(fileMatch[1]) } });
      }

      if (path === "/api/analyse") return await analyse(req);
      if (path === "/api/ai-checker") return await aiChecker(req);
      // The Marine Fauna Observation Log, spoken into a phone (/fauna/).
      if (path.startsWith("/api/fauna/")) return await fauna(req, user!, path);
      if (path === "/api/archive") return await archive(req);
      if (path === "/api/sync/progress") {
        return Response.json((await syncProgress()) ?? { pct: 0, word: "No sync has run yet", done: true }, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      if (path === "/api/sync/last") {
        return Response.json(await syncLastAnswer(), { headers: { "Cache-Control": "no-store" } });
      }
      if (path === "/api/sync") return await sync(req);
      // The round, started from the page: where it has got to, the rules it
      // reads by, and the round itself (routes/round.ts). The round's work
      // is registered with the platform as well as awaited, so a browser
      // that goes mid-round does not take the record and the lease drop
      // with it.
      if (path === "/api/round/progress") {
        return Response.json(await progressAnswer(), { headers: { "Cache-Control": "no-store" } });
      }
      if (path === "/api/round" || path === "/api/round/prepare") {
        return await round(req, user, path, ctx ? (work) => ctx.waitUntil(work) : undefined);
      }
      if (path === "/api/migrate-files") return await migrate(req);
      if (path === "/api/migrate-certs-opms") return await migrateCerts(req, user!);
      if (path === "/api/clear-r2") return await clearR2(req);
      if (path === "/api/import-single") return await importSingle(req, user?.name || "Import from SharePoint");

      const runMatch = /^\/api\/run\/([a-z-]+)$/.exec(path);
      if (runMatch) return await run(req, runMatch[1]);

      // Seeding and migration: bytes written straight into the file store,
      // through the same code path uploads use. Behind the crew-password
      // gate like everything else — which is no more than the ordinary
      // upload endpoint already allows anyone inside the door.
      const devBlob = /^\/api\/dev\/blob\/(.+)$/.exec(path);
      if (devBlob && req.method === "PUT") {
        const key = decodeURIComponent(devBlob[1]);
        await fileStore().set(key, await req.arrayBuffer());
        return Response.json({ stored: key });
      }

      if (path.startsWith("/api/")) {
        return Response.json({ error: `No such endpoint: ${path}` }, { status: 404 });
      }

      return env.ASSETS.fetch(req);
    } catch (e) {
      // Nothing here should throw — the routes answer their own errors — so
      // this is the plumbing itself failing, said plainly.
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  },

  // The hourly tick (wrangler.toml [triggers]): whatever people have dropped
  // into the SharePoint folders from Teams since last time is taken onto the
  // portal's books, then read by the AI and refiled under whoever each
  // certificate names, and then the round (lib/round.ts) puts what the
  // certificates say onto the crew matrix and into the office's workbook —
  // nobody pressing anything. Reads already cached cost nothing, so a quiet
  // hour is a few database looks and done.
  async scheduled(_event: ScheduledEvent, env: PortalEnv) {
    setEnv(env);
    const t0 = Date.now();
    // Whatever happens below is written down: the counts on a good hour,
    // the error on a bad one. A round that fails in silence is how the
    // matrix once sat empty for three hours with nobody told.
    const outcome = { read: 0, refiled: 0, syncError: null as string | null, readError: null as string | null, readStopped: null as string | null, readTried: false };
    const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
    const written = async (round: Record<string, unknown>) => {
      try {
        // The round's own `at` is when it began, an ISO string; the record's
        // is the hour's start, and stays so. The cells it moved and its
        // comparison count are answered to a page that asked for the round,
        // not kept on the hour's line. A workbook the server cannot write
        // goes on roundSkipped too: an open tab reads that line to decide
        // whether to run the round itself (shouldTabRound), and the page
        // shows the reason for a hand to fix.
        const { changes: _changes, summary: _summary, ...forRecord } = round;
        const roundSkipped = (forRecord.roundSkipped ?? forRecord.workbookProblem ?? null) as string | null;
        await recordHourly({ ...outcome, ...forRecord, roundSkipped, at: t0, durationMs: Date.now() - t0 });
      } catch (e) {
        console.error("hourly outcome not written:", e);
      }
    };

    // One lease for the whole hour. The sync can swap the workbook and the
    // round writes it; a page's Update portal or an upload doing either at
    // the same time is two writers of the one file, so they take the same
    // lease for their turn and stand aside while this holds it.
    //
    // A page's turn is short - a sync, an upload, a round of a couple of
    // minutes - so an hour that finds the lease held waits for it rather
    // than losing the whole hour: up to twenty more tries fifteen seconds
    // apart, five minutes in all. The work is given nine minutes from the
    // lease, or until twelve minutes after the tick, whichever comes first
    // (hourDeadline): a scheduled run has fifteen minutes of wall time,
    // and the write in flight, the record and the lease drop always keep
    // three of them whatever the wait cost.
    let lease: Lease | null;
    try {
      await ensureDocumentColumns();
      // The nightly backup, before the lease and outside it: it reads the
      // books and writes one file into the owner's folder, takes no lease
      // and holds nothing up, and nothing it does can stop the sync, the
      // reading or the round. Its own record says what it did (lib/backup.ts).
      try {
        await nightlyBackup(t0);
      } catch (e) {
        console.error("the nightly backup failed outside its own catch:", e);
      }
      lease = await takeLease("the round on the hour");
      for (let tries = 0; !lease && tries < LEASE_RETRIES; tries++) {
        await hourWaits.sleep(LEASE_RETRY_MS);
        lease = await takeLease("the round on the hour");
      }
    } catch (e) {
      await written({ roundError: "the hour could not start: " + said(e) });
      console.error("the hour could not start:", e);
      return;
    }
    if (!lease) {
      await written({ roundSkipped: "another round is still running" });
      return;
    }
    try {
      await written(await theHour(env, lease, hourDeadline(t0, Date.now()), outcome, written));
    } finally {
      try {
        await dropLease(lease.token);
      } catch (e) {
        console.error("the hour's lease was not dropped:", e);
      }
    }
  },
};

const LEASE_RETRIES = 20;
const LEASE_RETRY_MS = 15 * 1000;
/** The wait between tries for the lease. The tests swap it for one that
 *  does not wait. */
export const hourWaits = {
  sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
};

/** When the hour's work must stop starting things: nine minutes from the
 *  lease, but never past twelve from the tick. The scheduled run is cut
 *  at fifteen, and what runs after the last check - the workbook rewrite
 *  and its replace in the library, the record, the lease drop - needs
 *  the three that are left. */
export const hourDeadline = (tick: number, leaseAt: number) =>
  Math.min(leaseAt + 9 * 60 * 1000, tick + 12 * 60 * 1000);

/**
 * The hour's work under its lease: the sync, the reading, the round. What
 * comes back is the round's own word on the hour, for the record.
 * `deadline` is when the work must stop starting things (hourDeadline).
 */
async function theHour(
  env: PortalEnv, lease: Lease, deadline: number,
  outcome: { read: number; refiled: number; syncError: string | null; readError: string | null; readStopped: string | null; readTried: boolean },
  written: (round: Record<string, unknown>) => Promise<void>,
): Promise<Record<string, unknown>> {
  const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
  // The reading loops stop two and a half minutes short of the deadline,
  // so the round always has room to run after them; the round itself is
  // checked against the deadline.
  const timeLeft = () => Date.now() < deadline;
  const loopsLeft = () => Date.now() < deadline - 2.5 * 60 * 1000;
  /* The other budget is calls: one invocation may make about a thousand
     (every fetch to the model or the library, every database statement),
     and an hour that spends them all on reading leaves none for the round
     and none to write the hour's record - the page then shows a stale hour
     with no error, which is the worst way to fail. So the loops are capped
     at roughly six hundred between them, leaving the sync, the round and
     the record their share:
       a batch of four reads is four model calls, four file reads and a
       few database looks - call it fifteen; twenty batches, three hundred;
       one slice of forty renames is a copy, a delete, a folder check and
       a row update each - call it a hundred and seventy, plus the labels
       in a couple of batches. The rest wait for the next hour. */
  const MAX_EXTRACT_BATCHES = 20;
  const MAX_REFILE_CALLS = 1;
  const REFILE_SLICE = 40;

  let mirroredThisHour = 0;
  try {
    const synced = await runSync("hourly schedule");
    mirroredThisHour = synced.mirrored;
  } catch (e) {
    outcome.syncError = said(e);
    console.error("scheduled SharePoint sync failed:", e);
  }

  // The matrix as the register names people - read once, for the refile
  // and for the round alike, so a certificate is filed under the same
  // name the round will look for it by.
  let codes: [string, string][] = [];
  let names: string[] = [];
  // The round's word on the hour, when it did not get to run at all: a
  // matrix that could not be read, or one with nothing on it. Written
  // into the record either way, so the hour never reads as a clean one.
  let round: Record<string, unknown> = {};
  try {
    const cur = await readDocument();
    const quals = cur ? crewRowsOnly(cur.doc.quals as never, cur.doc.people) as { cols?: string[][]; rows?: string[][] } | null : null;
    codes = (quals?.cols || []).map((c) => [c[0], c[1]]);
    names = (quals?.rows || []).map((r) => r[0]).filter(Boolean);
    if (!codes.length || !names.length) round = { roundSkipped: "the crew matrix has no items" };
  } catch (e) {
    round = { roundError: "the crew matrix could not be read: " + said(e) };
    console.error("the crew matrix could not be read for the hour:", e);
  }

  // The hour so far, on the record before the reading spends anything: if
  // the reading runs the budget dry, the page still sees this hour and the
  // word that the round did not get to run, never last hour's line.
  await written(round.roundSkipped || round.roundError ? round : { roundSkipped: "round not yet run" });

  // The skills matrix's Equivalence sheet, before the refile: it says which
  // column a certificate belongs in, and so what the file is renamed to.
  // One look on an hour that already holds it. A sheet that could not be
  // kept goes on the record, where the SharePoint page shows it.
  let equivalenceProblem: string | null = null;
  if (codes.length) {
    const eq = await keepEquivalences();
    equivalenceProblem = eq.problem;
    if (eq.problem) console.error("the Equivalence sheet was not kept:", eq.problem);
  }

  if (env.ANTHROPIC_API_KEY) {
    try {
      if (codes.length) {
        let stalled = 0;
        let batches = 0;
        while (loopsLeft() && batches++ < MAX_EXTRACT_BATCHES) {
          // The hour put certificates to the model: only such an hour,
          // finishing with no reading error, says the account is in order
          // again (the page takes its red line down on it). An hour that
          // stood down for a lease, or had nothing to read, says nothing.
          outcome.readTried = true;
          const out = (await (await extract(codes, 4)).json()) as {
            remaining: number; attempted: number; extracted: number;
            stopped: { kind: string; line: string } | null;
          };
          outcome.read += out.extracted;
          // The first answer about the account ends the reading for the
          // hour: no credit or a refused key is for a person to fix and
          // goes on the record in red; a busy model or the rate is an
          // aside, and the next hour simply tries again. Nothing is kept
          // about it between hours. The refile and the round still run.
          if (out.stopped) {
            if (out.stopped.kind === "credit" || out.stopped.kind === "key") outcome.readError = out.stopped.line;
            else outcome.readStopped = out.stopped.line;
            break;
          }
          if (out.remaining <= 0 || out.attempted === 0) break;
          if (out.extracted === 0 && ++stalled >= 2) break;
        }
        let refiles = 0;
        while (names.length && loopsLeft() && refiles++ < MAX_REFILE_CALLS) {
          const out = (await (await refile(names, REFILE_SLICE)).json()) as {
            moved: unknown[]; remaining: number;
          };
          outcome.refiled += (out.moved || []).length;
          if (!out.remaining) break;
        }
        if (outcome.read || outcome.refiled) {
          console.log("hourly read: " + outcome.read + " certificates read, " + outcome.refiled + " refiled");
        }
      }
    } catch (e) {
      outcome.readError = said(e);
      console.error("scheduled certificate read failed:", e);
    }
  }

  // The round needs stored readings and a matrix with items on it, not the
  // model: an hour with no key still puts what has already been read onto
  // the matrix. It catches everything itself; this try is for the plumbing.
  if (codes.length && names.length) {
    try {
      round = await runMatrixRound({ by: "the round on the hour", timeLeft, mirroredThisHour, lease });
    } catch (e) {
      round = { roundError: said(e) };
      console.error("the round on the hour failed outside its own catch:", e);
    }
  }

  // The fauna log: whatever the phone saved that did not reach the office's
  // workbook at the time (out of range, the file open elsewhere) is written
  // now. Its own file and its own lease; nothing to do with the round's.
  if (timeLeft()) {
    try {
      await ensureFaunaTable();
      const log = await settleFaunaLog(null, "the round on the hour");
      if (log.linked && (log.written || log.blanked || log.error)) {
        round = { ...round, faunaLog: `${log.written} written, ${log.blanked} blanked` + (log.files.length ? ` into ${log.files.join(", ")}` : "") + (log.made.length ? ` (${log.made.join(", ")} made)` : "") + (log.error ? ` — ${log.error}` : "") };
      }
    } catch (e) {
      round = { ...round, faunaLogError: said(e) };
      console.error("the fauna log could not be settled on the hour:", e);
    }
  }
  return { ...round, equivalenceProblem };
}
