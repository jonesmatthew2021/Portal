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

/* --------------------------------------------- the crew's copy of it ---- */

/** What crew are never handed of the document: the two boxes beside each
 *  man on Crew Details (an admin page) that the round fills from his
 *  certificates, the round's note of what it put in them, and what the round
 *  read off the face of each certificate that only the certificate viewer
 *  shows - the date of a medical examination and any limitation printed on
 *  the document ("fit for particular duties only", MO76 s 7(1)(b)). A man's
 *  medical limitation is his own business: it is shown to management on the
 *  viewer and it is not put on every crew phone with the rest of the
 *  document. Crew read everything the portal shows them, and it shows them
 *  none of these. */
const CREW_NEVER_SEES = {
  person: ["msic", "dob"],
  document: ["particularsFromCert"],
  certDate: ["conditions", "assessedOn"],
} as const;

/* The crew's copy, made once per revision per isolate. The route hands the
   stored JSON through byte for byte because every open portal polls it
   every few seconds and parsing 600 KB per poll was enough to trip the CPU
   budget; the crew's copy has to be parsed to be made, so it is made when
   the revision moves and handed back from here until it does. The text is
   compared as well as the number: a test's portals, and a database put
   back from a backup, can carry the same number over a different document. */
let crewCopy: { rev: number; raw: string; text: string } | null = null;

/** The document as a crew login is handed it: the stored JSON with each
 *  man's MSIC number and date of birth, and the round's note of them,
 *  taken off - and nothing else touched, so the copy a crew phone keeps
 *  offline (the service worker keeps whatever this answers) never holds
 *  them either. A document that will not parse hands crew nothing. */
export function crewStateView(rev: number, dataText: string): string {
  if (crewCopy && crewCopy.rev === rev && crewCopy.raw === dataText) return crewCopy.text;
  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(dataText);
    doc = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    doc = {};
  }
  let touched = false;
  for (const key of CREW_NEVER_SEES.document) {
    if (key in doc) { delete doc[key]; touched = true; }
  }
  if (Array.isArray(doc.people)) {
    doc.people = doc.people.map((p) => {
      if (!p || typeof p !== "object" || Array.isArray(p)) return p;
      const person = { ...(p as Record<string, unknown>) };
      for (const key of CREW_NEVER_SEES.person) {
        if (key in person) { delete person[key]; touched = true; }
      }
      return person;
    });
  }
  /* The dates the round worked out for each person and column, keyed
     PERSON::CODE. The dates themselves are the matrix, which crew read; the
     two things read off the face of the document are not. */
  const dates = doc.certDates as { map?: unknown } | undefined;
  if (dates && typeof dates === "object" && !Array.isArray(dates)
    && dates.map && typeof dates.map === "object" && !Array.isArray(dates.map)) {
    const map = dates.map as Record<string, unknown>;
    const clean: Record<string, unknown> = {};
    let any = false;
    for (const at of Object.keys(map)) {
      const cell = map[at];
      if (!cell || typeof cell !== "object" || Array.isArray(cell)) { clean[at] = cell; continue; }
      const kept = { ...(cell as Record<string, unknown>) };
      for (const key of CREW_NEVER_SEES.certDate) {
        if (key in kept) { delete kept[key]; any = true; }
      }
      clean[at] = kept;
    }
    if (any) { doc.certDates = { ...dates, map: clean }; touched = true; }
  }
  // Nothing to take off: the bytes go out as they are, the way every other
  // grant gets them, rather than restrung.
  const text = touched || !dataText.trim().startsWith("{") ? JSON.stringify(doc) : dataText;
  crewCopy = { rev, raw: dataText, text };
  return text;
}

/**
 * A crew member's state save, reduced to what crew may change: comments.
 * Returns a replacement Request whose body is the current state with only
 * the comments taken from the submitted one — same rev, so the optimistic
 * save semantics are untouched. Everything else - the crew list with each
 * man's two boxes, and the round's note of them (crewStateView takes them
 * off the copy crew are handed) - is the stored document's, so a crew
 * save can neither blank nor change them, whatever the page sent.
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
