import { getStore } from "../compat/blobs.js";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { fileStore } from "../files/store.js";
import { getEnv } from "../env.js";

/**
 * Moving the file bytes home to SharePoint.
 *
 * When the portal went live on Cloudflare its files were loaded into R2; the
 * company's requirement is that they live in SharePoint. This copies them
 * over, a few per call so each request stays comfortably inside the worker's
 * limits, and the caller loops until nothing is left:
 *
 *   POST /api/migrate-files {"limit": 10}
 *     → { copied, skipped, remaining, done }
 *
 * Every row's bytes are read from R2 under its own key and written through
 * the SharePoint driver, which lands them in the team's real folders (the
 * same mapping every upload uses). What has been copied is remembered, so
 * the loop resumes cleanly after any interruption and a finished migration
 * answers instantly. Rows whose bytes aren't in R2 are marked and reported
 * rather than retried forever.
 *
 * Copy only — R2 is left untouched here. Emptying it is a separate,
 * deliberate step once SharePoint is verified serving.
 */
export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if ((getEnv().FILE_STORE || "r2") !== "sharepoint") {
    return Response.json({ error: "FILE_STORE isn't sharepoint — there is nowhere to migrate to." }, { status: 409 });
  }

  let limit = 10;
  try {
    const body = (await req.json()) as { limit?: unknown };
    if (typeof body.limit === "number" && body.limit >= 1) limit = Math.min(20, Math.floor(body.limit));
  } catch {
    // Defaults are fine.
  }

  const progress = getStore({ name: "file-migration" });
  const rows = await db.select().from(documents);
  const done = new Set((await progress.list()).blobs.map((b) => b.key));
  const pending = rows.filter((row) => !done.has(row.id));

  const sharepoint = fileStore();
  const r2 = getEnv().FILES;
  let copied = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of pending.slice(0, limit)) {
    try {
      const obj = await r2.get(row.blobKey);
      if (!obj) {
        await progress.setJSON(row.id, { at: new Date().toISOString(), note: "no bytes in R2" });
        skipped++;
        continue;
      }
      await sharepoint.set(row.blobKey, await obj.arrayBuffer());
      await progress.setJSON(row.id, { at: new Date().toISOString() });
      copied++;
    } catch (e) {
      errors.push(`${row.blobKey}: ${e instanceof Error ? e.message : String(e)}`);
      if (errors.length >= 3) break; // three strikes — stop and let the caller see why
    }
  }

  const remaining = pending.length - copied - skipped;
  return Response.json({
    copied,
    skipped,
    remaining,
    done: remaining <= 0,
    ...(errors.length ? { errors } : {}),
  });
};
