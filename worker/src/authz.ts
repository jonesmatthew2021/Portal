import type { PortalUser } from "./auth.js";
import { getEnv } from "./env.js";
import { PORTAL_ROW_ID } from "./db/schema.js";

/**
 * What each role may do — decided here, on the server, for every request.
 *
 *   it          everything, including the portal's maintenance machinery
 *   management  everything except that machinery — the whole working portal,
 *               none of the plumbing that could break it
 *   crew        read everything the portal shows, and comment on posts;
 *               nothing else writes
 *
 * The crew rule has one subtlety: the portal saves its shared state as one
 * document, so a crew browser sends the whole thing back even when all that
 * changed is a comment. crewStateBody() therefore rebuilds the save from the
 * current state plus ONLY the comments the crew member sent — whatever else
 * their browser included is quietly left as it was, so read-only means
 * read-only however the page behaves.
 */

// The maintenance machinery: bulk moves, store wipes, raw byte writes. IT only.
const IT_ONLY = ["/api/dev/blob/", "/api/migrate-files", "/api/migrate-certs-opms", "/api/clear-r2"];

export function allowed(user: PortalUser, method: string, path: string): boolean {
  if (user.role === "it") return true;

  if (IT_ONLY.some((p) => path === p || path.startsWith(p))) return false;
  if (user.role === "management") return true;

  // Crew: reads pass, and exactly two writes — the shared-state save (which
  // crewStateBody strips to comments) and nothing else.
  if (method === "GET" || method === "HEAD") return true;
  // The fauna log is a watchkeeper's job, whatever their level: any signed-in
  // observer may log a sighting, change one of theirs, or export the month.
  if (path.startsWith("/api/fauna/")) return true;
  if (method === "PUT" && path === "/api/state") return true;
  // Crew may file their own certificates — the upload page's two calls. The
  // files door is held to certificates in index.ts.
  if (method === "POST" && (path === "/api/files" || path === "/api/certificates/read-one")) return true;
  return false;
}

export const denied = () =>
  Response.json(
    { error: "Your access level can't do that. Ask the Master if something needs changing." },
    { status: 403 },
  );

/**
 * A crew member's state save, reduced to what crew may change: comments.
 * Returns a replacement Request whose body is the current state with only
 * the comments taken from the submitted one — same rev, so the optimistic
 * save semantics are untouched.
 */
export async function crewStateBody(req: Request): Promise<Request> {
  let sent: { rev?: unknown; data?: unknown };
  try {
    sent = await req.json();
  } catch {
    return new Request(req.url, { method: req.method, headers: req.headers, body: "{}" });
  }

  const row = await getEnv()
    .DB.prepare("SELECT data FROM portal_state WHERE id = ?1")
    .bind(PORTAL_ROW_ID)
    .first<{ data: string }>();

  let base: Record<string, unknown> = {};
  try {
    base = row ? JSON.parse(row.data) : {};
  } catch {
    base = {};
  }
  const sentData = sent.data && typeof sent.data === "object" ? (sent.data as Record<string, unknown>) : {};
  const merged = { ...base, comments: sentData.comments ?? (base as { comments?: unknown }).comments };

  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: JSON.stringify({ rev: sent.rev, data: merged }),
  });
}
