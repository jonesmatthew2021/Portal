/**
 * The worker's bindings, reachable from anywhere.
 *
 * The earlier build read its configuration from ambient process.env and module
 * state, and the ported libraries still do — so the fetch handler parks each
 * request's env here first, and everything else asks for it. One request at a
 * time per isolate makes this safe; nothing holds env across an await boundary
 * belonging to another request.
 */

export type PortalEnv = {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  // Cloudflare's own email sending: the sign-in codes, the security alarm,
  // and the fauna log emailed on with the workbook attached.
  EMAIL?: SendEmail;
  // Cloudflare's own speech-to-text (Workers AI), for the safety meeting
  // recorder (routes/meeting.ts). Absent, and the page is told so.
  AI?: Ai;
  BOOTSTRAP_IT_EMAIL?: string;
  FIT_TO_SAIL_URL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  PORTAL_PASSWORD?: string;
  FILE_STORE?: string;
  MS_TENANT_ID?: string;
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  SHAREPOINT_HOSTNAME?: string;
  SHAREPOINT_SITE_PATH?: string;
  SHAREPOINT_LIBRARY?: string;
  SHAREPOINT_ROOT?: string;
  SHAREPOINT_MAP?: string;
  SHAREPOINT_FAUNA_FOLDER?: string;
  // The nightly backup (lib/backup.ts): the folder in the library it goes
  // to, made by the owner and never by the portal (empty: no backup), and
  // the hour, by the vessel's clock, after which the hour writes it.
  BACKUP_FOLDER?: string;
  BACKUP_HOUR?: string;
};

let current: PortalEnv | null = null;

export function setEnv(env: PortalEnv) {
  current = env;
}

export function getEnv(): PortalEnv {
  if (!current) throw new Error("env asked for before the request handler set it");
  return current;
}
