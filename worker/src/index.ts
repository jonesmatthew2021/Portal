import { setEnv, type PortalEnv } from "./env.js";
import { gate, logLoginEvent } from "./auth.js";
import { allowed, crewStateBody, denied } from "./authz.js";
import { fileStore } from "./files/store.js";
import users from "./routes/users.js";
import traffic from "./routes/traffic.js";
import sharepoint from "./routes/sharepoint.js";
import rename from "./routes/rename.js";
import renameFile from "./routes/rename-file.js";
import state from "./routes/state.js";
import { history, restore } from "./routes/history.js";
import files from "./routes/files.js";
import file from "./routes/file.js";
import analyse, { extract, refile } from "./routes/analyse.js";
import aiChecker from "./routes/ai-checker.js";
import archive from "./routes/archive.js";
import run from "./routes/run.js";
import sync, { runSync, syncProgress, lastSync, lastHourly, recordHourly } from "./routes/sync.js";
import migrate from "./routes/migrate.js";
import migrateCerts from "./routes/migrate-certs.js";
import readOne from "./routes/read-one.js";
import clearR2 from "./routes/clear-r2.js";
import importSingle from "./routes/import-single.js";

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
  async fetch(req: Request, env: PortalEnv): Promise<Response> {
    setEnv(env);
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // Real sign-in stands in front of everything: who this is, then what
      // their level allows, decided here for every request.
      const { barred, user } = await gate(req, path);
      if (barred) return barred;
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
      if (path === "/api/archive") return await archive(req);
      if (path === "/api/sync/progress") {
        return Response.json((await syncProgress()) ?? { pct: 0, word: "No sync has run yet", done: true }, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      // When the folders were last read and what the hourly round last did —
      // the round's own word for it, error included.
      if (path === "/api/sync/last") {
        return Response.json(
          { sync: await lastSync().catch(() => null), hourly: await lastHourly().catch(() => null) },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      if (path === "/api/sync") return await sync(req);
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
  // certificate names — nobody pressing anything. Reads already cached cost
  // nothing, so a quiet hour is a few database looks and done.
  async scheduled(_event: ScheduledEvent, env: PortalEnv) {
    setEnv(env);
    const t0 = Date.now();
    const timeLeft = () => Date.now() - t0 < 9 * 60 * 1000;
    // Whatever happens below is written down at the end: the counts on a
    // good hour, the error on a bad one. A round that fails in silence is
    // how the matrix once sat empty for three hours with nobody told.
    const outcome = { read: 0, refiled: 0, syncError: null as string | null, readError: null as string | null };
    const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
    try {
      await runSync("hourly schedule");
    } catch (e) {
      outcome.syncError = said(e);
      console.error("scheduled SharePoint sync failed:", e);
    }
    if (env.ANTHROPIC_API_KEY) {
      try {
        const row = await env.DB.prepare("SELECT data FROM portal_state LIMIT 1").first<{ data: string }>();
        const quals = row ? JSON.parse(row.data)?.quals : null;
        const codes: [string, string][] = (quals?.cols || []).map((c: string[]) => [c[0], c[1]]);
        const names: string[] = (quals?.rows || []).map((r: string[]) => r[0]).filter(Boolean);
        if (codes.length) {
          let stalled = 0;
          while (timeLeft()) {
            const out = (await (await extract(codes, 4)).json()) as {
              remaining: number; attempted: number; extracted: number;
            };
            outcome.read += out.extracted;
            if (out.remaining <= 0 || out.attempted === 0) break;
            if (out.extracted === 0 && ++stalled >= 2) break;
          }
          while (names.length && timeLeft()) {
            const out = (await (await refile(names, 50)).json()) as {
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
    try {
      await recordHourly({ at: t0, durationMs: Date.now() - t0, ...outcome });
    } catch (e) {
      console.error("hourly outcome not written:", e);
    }
  },
};
