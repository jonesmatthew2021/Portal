import { setEnv, type PortalEnv } from "./env.js";
import { gate } from "./gate.js";
import { fileStore } from "./files/store.js";
import state from "./routes/state.js";
import files from "./routes/files.js";
import file from "./routes/file.js";
import analyse from "./routes/analyse.js";
import aiChecker from "./routes/ai-checker.js";
import archive from "./routes/archive.js";
import run from "./routes/run.js";
import sync from "./routes/sync.js";
import migrate from "./routes/migrate.js";

/**
 * The portal's front door on Cloudflare.
 *
 * The routes are the same ones the page has always called — /api/state,
 * /api/files, /api/files/:id, /api/analyse, /api/ai-checker, /api/archive —
 * plus /api/run/:kind, where the browser starts the long jobs that Netlify
 * used to hand to background functions. Anything that isn't /api is the page
 * itself, served from the assets directory.
 */
export default {
  async fetch(req: Request, env: PortalEnv): Promise<Response> {
    setEnv(env);
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // The crew password stands in front of everything, the way Netlify's
      // password protection used to. No password configured means local dev.
      const barred = await gate(req, path);
      if (barred) return barred;

      if (path === "/api/state") return await state(req);
      if (path === "/api/files") return await files(req);

      const fileMatch = /^\/api\/files\/([^/]+)$/.exec(path);
      if (fileMatch) {
        return await file(req, { params: { id: decodeURIComponent(fileMatch[1]) } });
      }

      if (path === "/api/analyse") return await analyse(req);
      if (path === "/api/ai-checker") return await aiChecker(req);
      if (path === "/api/archive") return await archive(req);
      if (path === "/api/sync") return await sync(req);
      if (path === "/api/migrate-files") return await migrate(req);

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
};
