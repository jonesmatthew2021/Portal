import type { PortalUser } from "../auth.js";
import { sharepointBrowse } from "../files/store.js";

/**
 * The SharePoint page's window into the company library —
 * GET /api/sharepoint?path=<folder>.
 *
 * One folder per request, exactly as the library holds it: the United
 * Operations Team's real folders and files, not the portal's own filing.
 * Management and IT only — the library holds everyone's certificates.
 */
export default async (req: Request, actor: PortalUser): Promise<Response> => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  if (actor.role === "crew") {
    return Response.json({ error: "The SharePoint library is browsed by Management and IT Help." }, { status: 403 });
  }
  const path = new URL(req.url).searchParams.get("path") || "";
  if (path.includes("..")) return Response.json({ error: "That's not a folder path." }, { status: 400 });
  try {
    return Response.json(
      { path: path.replace(/^\/+|\/+$/g, ""), entries: await sharepointBrowse(path) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
};
