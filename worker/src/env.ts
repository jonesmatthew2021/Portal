/**
 * The worker's bindings, reachable from anywhere.
 *
 * The Netlify code read its configuration from ambient process.env and module
 * state, and the ported libraries still do — so the fetch handler parks each
 * request's env here first, and everything else asks for it. One request at a
 * time per isolate makes this safe; nothing holds env across an await boundary
 * belonging to another request.
 */

export type PortalEnv = {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  FILE_STORE?: string;
  MS_TENANT_ID?: string;
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  SHAREPOINT_HOSTNAME?: string;
  SHAREPOINT_SITE_PATH?: string;
  SHAREPOINT_LIBRARY?: string;
  SHAREPOINT_ROOT?: string;
};

let current: PortalEnv | null = null;

export function setEnv(env: PortalEnv) {
  current = env;
}

export function getEnv(): PortalEnv {
  if (!current) throw new Error("env asked for before the request handler set it");
  return current;
}
