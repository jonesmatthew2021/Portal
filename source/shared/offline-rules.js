// @ts-check
/**
 * The offline rules: what the service worker keeps so the last-loaded
 * portal stays readable when the link drops, and how the page tells a
 * kept copy from a live answer.
 *
 * The service worker (source/app/sw.js) has this file folded into it at
 * build, the page has it spliced in at its @shared marker, and
 * tools/client-rules.test.mjs runs it as a module - so the decisions are
 * made in one place and proved without a browser. Nothing here touches a
 * cache or a request: these are the rules, the worker does the work.
 *
 * Network first, always: a kept copy is used only when the network fails
 * or has not answered within NETWORK_WAIT_MS, and every good answer
 * refreshes the copy. So a deploy is picked up the moment the link is up,
 * and a stale page is never preferred to a live one.
 */

/** The header the service worker puts on a copy it kept: when that answer
 *  was fetched, as an ISO time. A live answer never carries it, so the page
 *  can tell the two apart (isCachedAnswer). */
export const FETCHED_AT_HEADER = "X-Portal-Fetched-At";

/** The header the worker (Cloudflare) puts on the portal page itself and
 *  on nothing else. The sign-in form is served at the same address when
 *  nobody is signed in, and a copy of that would be worse than none: only
 *  an answer carrying this header is kept as the page. */
export const PAGE_HEADER = "X-Portal-Page";

/** How long a request waits on the network before the kept copy is used. */
export const NETWORK_WAIT_MS = 4000;

/** The word the page sends the service worker to clear everything it
 *  kept - on sign-out, so a signed-out device holds nothing. */
export const FORGET_MESSAGE = "forget";

/** The four answers the service worker keeps the last good copy of. Nothing
 *  else under /api/ is ever kept. */
export const KEPT_APIS = ["/api/me", "/api/state", "/api/files", "/api/sync/last"];

/** The cache a build keeps its copies in: a new build is a new cache, and
 *  on taking over the worker deletes every cache that is not its own -
 *  which also clears whatever a worker from years ago left behind.
 *  @param {string} version  the build's stamp
 *  @returns {string} */
export function cacheName(version) {
  return "portal-" + version;
}

/**
 * What the service worker does with a request.
 *
 *   "page"   the portal page at "/": network first, the kept copy if not
 *   "api"    one of KEPT_APIS, asked plainly (no query): the same
 *   "vendor" React, React DOM and the fonts under /vendor/: the kept copy
 *            first, since a build's copies never change under it
 *   null     everything else - other pages, file bytes, the CDN scripts,
 *            the fauna app, every write - goes straight to the network
 *            and is never kept
 *
 * @param {string} method
 * @param {string} url  the request's address, absolute or a path
 * @param {string} [origin]  the portal's own origin; an address on
 *   another origin is never kept
 * @returns {"page"|"api"|"vendor"|null}
 */
export function cacheable(method, url, origin) {
  if (String(method).toUpperCase() !== "GET") return null;
  let u;
  try {
    u = new URL(url, origin || "https://portal.invalid");
  } catch (e) {
    return null;
  }
  if (origin && u.origin !== origin) return null;
  if (u.pathname === "/") return "page";
  if (u.pathname.startsWith("/vendor/")) return "vendor";
  if (KEPT_APIS.includes(u.pathname) && u.search === "") return "api";
  return null;
}

/** The address a copy is kept under: the page under "/" whatever the
 *  query, everything else under its path.
 *  @param {string} url
 *  @returns {string} */
export function cacheKey(url) {
  const u = new URL(url, "https://portal.invalid");
  return u.pathname === "/" ? "/" : u.pathname;
}

/**
 * Whether an answer from the network is worth keeping: a good status, and
 * for the page the worker's own mark on it (PAGE_HEADER) - the sign-in
 * form comes back at the same address with the same status and must
 * never be kept as the page.
 *
 * @param {"page"|"api"|"vendor"} kind
 * @param {number} status
 * @param {{ get(name: string): string | null }} headers
 * @returns {boolean}
 */
export function keepable(kind, status, headers) {
  if (status !== 200) return false;
  if (kind === "page") return !!(headers && headers.get(PAGE_HEADER));
  return true;
}

/** The stamp on a kept copy, or null for a live answer.
 *  @param {{ get(name: string): string | null } | null | undefined} headers
 *  @returns {string | null} */
export function isCachedAnswer(headers) {
  const at = headers && typeof headers.get === "function" ? headers.get(FETCHED_AT_HEADER) : null;
  return at ? at : null;
}

/**
 * Whether a live /api/me answer is somebody other than the person whose
 * copies are kept. A different person signing in on the same device must
 * not read the last person's portal offline, so the kept answers go
 * before theirs are kept. Judged by the email, the one thing about a
 * person that never changes spelling; an answer with no email decides
 * nothing.
 *
 * @param {{ email?: unknown } | null | undefined} kept
 * @param {{ email?: unknown } | null | undefined} live
 * @returns {boolean}
 */
export function anotherPerson(kept, live) {
  const a = kept && typeof kept.email === "string" ? kept.email.trim().toLowerCase() : "";
  const b = live && typeof live.email === "string" ? live.email.trim().toLowerCase() : "";
  return !!a && !!b && a !== b;
}
