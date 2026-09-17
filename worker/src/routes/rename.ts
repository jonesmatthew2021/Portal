import type { PortalUser } from "../auth.js";
import { getEnv } from "../env.js";

/**
 * POST /api/rename-person { from, to } — a mistake fix.
 *
 * Every document record filed under the old name is relabelled with the new
 * one, in one stroke. The files themselves keep their places and their
 * folders — this changes what the books call the person, nothing else. The
 * page's own half renames the matrix row; Management and IT only.
 */
export default async (req: Request, actor: PortalUser): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (actor.role === "crew") {
    return Response.json({ error: "Names are changed by Management and IT Help." }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as { from?: unknown; to?: unknown } | null;
  const from = typeof body?.from === "string" ? body.from.trim() : "";
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  if (!from || !to || from === to) {
    return Response.json({ error: "Both the old and the new name are needed." }, { status: 400 });
  }
  const res = await getEnv()
    .DB.prepare("UPDATE documents SET person = ?2 WHERE person = ?1")
    .bind(from, to)
    .run();
  return Response.json({ renamed: res.meta?.changes ?? 0 });
};
