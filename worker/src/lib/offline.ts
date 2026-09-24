/**
 * The headers the worker puts on the page's own files, for the service
 * worker that keeps the last-loaded portal readable offline
 * (source/app/sw.js, the rules in source/shared/offline-rules.js).
 *
 * The asset layer serves the files; this decides what rides on them:
 *
 *   /sw.js   no-cache, so the browser asks for it again on every visit and
 *            a deploy's new worker is picked up the moment the link is up
 *            rather than after whatever the browser felt like caching it
 *            for; and Service-Worker-Allowed: /, saying out loud that the
 *            worker may stand in front of the whole site.
 *   /        the page's mark (PAGE_HEADER). The sign-in form is served at
 *            the same address when nobody is signed in, and the worker
 *            keeps only an answer that carries the mark - so a copy of the
 *            sign-in form is never what a phone opens to at sea.
 *
 * Everything else is left as the asset layer serves it. Every /api/ route
 * answers no-store as before: whether an answer is kept is the service
 * worker's decision, never the browser's cache.
 */
import { PAGE_HEADER } from "../../../source/shared/offline-rules.js";

/** The headers to add for a path served from the assets, if any. */
export function assetHeaders(path: string): Record<string, string> {
  if (path === "/sw.js") return { "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" };
  if (path === "/") return { [PAGE_HEADER]: "portal" };
  return {};
}

/** The asset's answer with those headers on it - a new Response, because
 *  the asset layer's own is read-only. */
export function withAssetHeaders(path: string, answer: Response): Response {
  const add = assetHeaders(path);
  if (!Object.keys(add).length) return answer;
  const headers = new Headers(answer.headers);
  for (const [name, value] of Object.entries(add)) headers.set(name, value);
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers });
}
