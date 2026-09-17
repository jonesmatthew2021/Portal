import { and, eq, isNull, like } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import {
  CERT_ROOT,
  SINGLE_FILE_CATEGORIES,
  fileStore,
  moveBlob,
  opmsCertPrefix,
  safeName,
  tokenForOpmsFolder,
  withSuffix,
} from "../db/documents.js";
import type { PortalUser } from "../auth.js";

/**
 * POST /api/migrate-certs-opms { limit } — the one-time move to the OPMS
 * person folders as the certificates' only home.
 *
 * Each live certificate record still keyed under the old certification
 * folders is settled a batch at a time: where the person's OPMS folder holds
 * the identical file (name and size), the record is repointed at that copy —
 * no bytes touched; where it doesn't, the file itself is moved in. Readings
 * are keyed by the file's fingerprint, so nothing is re-read. Reports what
 * remains so the caller loops until zero.
 */
export default async (req: Request, _actor: PortalUser): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = (await req.json().catch(() => null)) as { limit?: unknown } | null;
  const limit = Math.max(1, Math.min(100, typeof body?.limit === "number" ? body.limit : 25));

  const store = fileStore();
  const opms = await store.list({ prefix: "opms/" });
  const inOpms = new Set(opms.blobs.map((b) => b.key.toLowerCase()));
  const twins = new Map<string, string>();
  for (const b of opms.blobs) {
    const m = /^opms\/([^/]+ - OPMS)\/([^/]+)$/i.exec(b.key);
    if (!m) continue;
    twins.set(
      `${tokenForOpmsFolder(m[1])}|${safeName(m[2]).toLowerCase()}|${b.size ?? -1}`,
      b.key,
    );
  }

  const singleFolders = Object.values(SINGLE_FILE_CATEGORIES).map((c) => c.folder + "/");
  const rows = await db
    .select()
    .from(documents)
    .where(and(isNull(documents.removedAt), eq(documents.category, "certificate"), like(documents.blobKey, `${CERT_ROOT}/%`)));
  const candidates = rows.filter(
    (r) => /^[a-z0-9-]+$/.test(r.folder || "") && !singleFolders.some((s) => r.blobKey.startsWith(s)),
  );
  const batch = candidates.slice(0, limit);

  let repointed = 0;
  let moved = 0;
  for (const r of batch) {
    const hit = twins.get(`${r.folder}|${(r.filename || "").toLowerCase()}|${r.sizeBytes ?? -1}`);
    if (hit) {
      await db.update(documents).set({ blobKey: hit }).where(eq(documents.id, r.id));
      repointed++;
      continue;
    }
    let name = r.filename;
    const prefix = opmsCertPrefix(r.folder || "unnamed");
    for (let n = 2; inOpms.has(`${prefix}/${name}`.toLowerCase()); n++) name = withSuffix(r.filename, n);
    const to = `${prefix}/${name}`;
    await moveBlob(r.blobKey, to);
    inOpms.add(to.toLowerCase());
    await db.update(documents).set({ blobKey: to, filename: name }).where(eq(documents.id, r.id));
    moved++;
  }

  return Response.json({ repointed, moved, remaining: candidates.length - batch.length });
};
