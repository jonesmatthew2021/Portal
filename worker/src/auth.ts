import { getEnv } from "./env.js";
import { vessel } from "./vessel.js";

/**
 * Real sign-in, per person.
 *
 * The shared crew password is retired. Each person is a row in `users` with
 * an email and a role; signing in is typing your email, receiving a six-digit
 * code on it (which is how a phone authenticates — the code lands in the mail
 * app in your pocket), and typing the code back. A session cookie then keeps
 * that device signed in for ninety days, and the server checks it on every
 * request — the roles here are enforced, not the honour system the old
 * name-picker was.
 *
 * Roles: 'it' — everything, including the portal's maintenance machinery;
 * 'management' — everything except that machinery; 'crew' — read and comment.
 * What each may do is decided in authz.ts; this file only answers who they are.
 *
 * Bootstrap: with the users table empty, the address in BOOTSTRAP_IT_EMAIL
 * may sign in and becomes the first IT user. After that, accounts are made on
 * the Access grants page.
 */

export type PortalUser = {
  id: string;
  email: string;
  name: string;
  role: "it" | "management" | "crew";
};

const SESSION_COOKIE = "portal_session";
// A sign-in lasts one week, then the person proves the email is still theirs
// with a fresh code — access on file is re-verified, not granted forever.
const SESSION_DAYS = 7;
const CODE_MINUTES = 10;
const CODE_RESEND_SECONDS = 60;
const CODE_MAX_ATTEMPTS = 5;

const now = () => Math.floor(Date.now() / 1000);

// The door slows down under a hammering: this many events from one address
// inside the window and that address waits. Generous enough for the whole
// crew behind the vessel's one shared connection; far too slow for guessing.
const RATE_MAX = 30;
const RATE_WINDOW = 10 * 60;

// A burst of suspicious traffic raises the alarm: this many bad events
// inside the window emails every IT Help account — at most once an hour.
const SUSPECT_KINDS = ["unknown_email", "disabled_account", "code_wrong", "code_lockout", "denied", "rate_limited"];
const ALERT_BURST = 8;
const ALERT_WINDOW = 15 * 60;
const ALERT_QUIET = 60 * 60;
const sha256 = async (s: string) => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const cleanEmail = (v: unknown) =>
  typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? v.trim().toLowerCase() : null;

/**
 * Every knock on the door goes in the book — who asked for a code, addresses
 * the portal has never heard of trying the sign-in, wrong codes, lockouts,
 * sign-ins, refused actions — with the caller's address and country off the
 * edge. The Access Grants page reads it to spot anyone trying their luck.
 * Never allowed to break the door itself: a logging failure is swallowed.
 */
export async function logLoginEvent(req: Request, kind: string, email: string | null, detail?: string) {
  try {
    const cf = (req as Request & { cf?: { country?: string } }).cf;
    const db = getEnv().DB;
    await db
      .prepare("INSERT INTO login_events (ts, kind, email, ip, country, ua, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(
        now(),
        kind,
        email,
        req.headers.get("CF-Connecting-IP") || "",
        (cf && cf.country) || "",
        (req.headers.get("User-Agent") || "").slice(0, 160),
        detail || null,
      )
      .run();
    // Ninety days is plenty of hindsight; one-in-fifty writes sweeps the rest.
    if (Math.random() < 0.02) {
      await db.prepare("DELETE FROM login_events WHERE ts < ?1").bind(now() - 90 * 86400).run();
    }
    if (SUSPECT_KINDS.includes(kind)) await maybeRaiseAlarm(db);
  } catch (e) {
    console.error("login event not recorded:", e);
  }
}

/** Too many door events from this address lately? Checked before the door answers. */
async function rateLimited(req: Request): Promise<boolean> {
  const ip = req.headers.get("CF-Connecting-IP") || "";
  if (!ip) return false;
  const row = await getEnv()
    .DB.prepare("SELECT COUNT(*) AS n FROM login_events WHERE ts >= ?1 AND ip = ?2")
    .bind(now() - RATE_WINDOW, ip)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= RATE_MAX;
}

/**
 * The alarm: when suspicious events pile up, every enabled IT Help account
 * gets an email saying what and from where — at most one an hour, so a
 * sustained attack is one clear message, not a flood.
 */
async function maybeRaiseAlarm(db: ReturnType<typeof getEnv>["DB"]) {
  const marks = SUSPECT_KINDS.map((k) => `'${k}'`).join(",");
  const since = now() - ALERT_WINDOW;
  const burst = await db
    .prepare(`SELECT COUNT(*) AS n FROM login_events WHERE ts >= ?1 AND kind IN (${marks})`)
    .bind(since)
    .first<{ n: number }>();
  if ((burst?.n ?? 0) < ALERT_BURST) return;

  const last = await db
    .prepare("SELECT updated_at FROM blobs WHERE store = 'security' AND key = 'last-alert'")
    .first<{ updated_at: number }>();
  if (last && now() - last.updated_at < ALERT_QUIET) return;
  await db
    .prepare(
      "INSERT INTO blobs (store, key, value, updated_at) VALUES ('security', 'last-alert', 'sent', ?1) " +
        "ON CONFLICT (store, key) DO UPDATE SET updated_at = ?1",
    )
    .bind(now())
    .run();

  const kinds = await db
    .prepare(`SELECT kind, COUNT(*) AS n FROM login_events WHERE ts >= ?1 AND kind IN (${marks}) GROUP BY kind ORDER BY n DESC`)
    .bind(since)
    .all<{ kind: string; n: number }>();
  const ips = await db
    .prepare(`SELECT ip, country, COUNT(*) AS n FROM login_events WHERE ts >= ?1 AND kind IN (${marks}) GROUP BY ip, country ORDER BY n DESC LIMIT 5`)
    .bind(since)
    .all<{ ip: string; country: string; n: number }>();
  const watchers = await db
    .prepare("SELECT email FROM users WHERE role = 'it' AND disabled = 0")
    .all<{ email: string }>();

  const what = (kinds.results || []).map((k) => `  ${k.kind.replace(/_/g, " ")}: ${k.n}`).join("\n");
  const where = (ips.results || []).map((i) => `  ${i.ip || "unknown"} (${i.country || "?"}): ${i.n} events`).join("\n");
  const env = getEnv();
  if (!env.EMAIL) return;
  for (const w of watchers.results || []) {
    try {
      await env.EMAIL.send({
        to: w.email,
        from: vessel.mailFrom,
        subject: "Portal security alarm - suspicious sign-in traffic",
        text:
          `The crew portal has seen ${burst!.n} suspicious sign-in events in the last ${ALERT_WINDOW / 60} minutes.\n\n` +
          `What:\n${what}\n\nFrom where:\n${where}\n\n` +
          `The full record is on the Access Grants page, under Sign-in traffic:\n` +
          `https://${vessel.domain}\n\n` +
          `Nothing needs doing if this is expected (a crew round of first sign-ins, say). ` +
          `If it isn't, disable any grant in doubt - that signs its devices out on the spot. ` +
          `At most one of these emails is sent an hour.`,
      });
    } catch (e) {
      console.error("alarm email not sent:", e);
    }
  }
}

function cookieOf(req: Request): string | null {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === SESSION_COOKIE) return part.slice(eq + 1);
  }
  return null;
}

/** Who this request is, or null. Checked on every request by the gate. */
export async function currentUser(req: Request): Promise<PortalUser | null> {
  const sid = cookieOf(req);
  if (!sid || !/^[0-9a-f]{48,64}$/.test(sid)) return null;
  const row = await getEnv()
    .DB.prepare(
      `SELECT u.id, u.email, u.name, u.role FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?1 AND s.revoked = 0 AND s.expires_at > ?2 AND u.disabled = 0`,
    )
    .bind(await sha256(sid), now())
    .first<PortalUser>();
  return row ?? null;
}

/* ------------------------------------------------------------- pages ---- */

const PAGE = (inner: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${vessel.title}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#eef2f5; font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  form { background:#fff; border:1px solid #d4dbe2; border-top:4px solid ${vessel.theme.signIn.button}; border-radius:8px;
    padding:34px 30px; width:min(380px, 90vw); text-align:center; }
  h1 { font-size:20px; color:${vessel.theme.signIn.ink}; margin:0; letter-spacing:.4px; }
  .sub { color:#5b6b7a; font-size:12.5px; margin:6px 0 22px; }
  input { font:inherit; font-size:15px; width:100%; box-sizing:border-box; padding:11px 12px;
    border:1px solid #d4dbe2; border-radius:6px; margin-bottom:12px; text-align:center; }
  button { font:inherit; font-size:14.5px; font-weight:600; width:100%; padding:11px; border:0;
    border-radius:6px; background:${vessel.theme.signIn.button}; color:#fff; cursor:pointer; }
  .note { color:#5b6b7a; font-size:12.5px; margin:14px 0 0; line-height:1.6; }
  .wrong { color:#b03a2e; font-size:13px; margin:0 0 12px; }
</style></head><body>${inner}</body></html>`;

// Where to land once signed in: the page that was asked for, so the fauna
// log opens as the fauna log and not the portal's front page. Only a path on
// this site is ever followed.
const safeNext = (v: unknown) => {
  const s = typeof v === "string" ? v.trim() : "";
  return /^\/(?!\/)[^\s]*$/.test(s) && !s.startsWith("/login") && !s.startsWith("/api/") ? s : "/";
};

const EMAIL_FORM = (msg?: string, next = "/") =>
  PAGE(`<form method="POST" action="/login">
  <h1>${VESSEL_HEADING}</h1>
  <div class="sub">Crew Portal &middot; ${vessel.operator}</div>
  ${msg ? `<p class="wrong">${msg}</p>` : ""}
  <input type="hidden" name="next" value="${next.replace(/"/g, "&quot;")}">
  <input type="email" name="email" placeholder="Your email address" autofocus autocomplete="email" required>
  <button type="submit">Email me a sign-in code</button>
  <p class="note">A six-digit code goes to your email &mdash; on your phone or anywhere your mail is. Type it on the next screen and this device stays signed in for one week.</p>
</form>`);

const CODE_FORM = (email: string, msg?: string, next = "/") =>
  PAGE(`<form method="POST" action="/login/verify">
  <h1>${VESSEL_HEADING}</h1>
  <div class="sub">A code is on its way to<br><b>${email.replace(/</g, "&lt;")}</b></div>
  ${msg ? `<p class="wrong">${msg}</p>` : ""}
  <input type="hidden" name="email" value="${email.replace(/"/g, "&quot;")}">
  <input type="hidden" name="next" value="${next.replace(/"/g, "&quot;")}">
  <input inputmode="numeric" pattern="[0-9]*" maxlength="6" name="code" placeholder="6-digit code" autofocus autocomplete="one-time-code" required>
  <button type="submit">Enter the portal</button>
  <p class="note">Nothing arrived after a minute? Check junk mail, then <a href="/login">start again</a>.</p>
</form>`);

// The vessel's name as the sign-in page's heading: "TSV COOLIBAH".
const VESSEL_HEADING = `${vessel.name} ${vessel.nameAccent}`.toUpperCase();

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

/* ------------------------------------------------------------- routes --- */

async function sendCode(email: string, code: string) {
  const env = getEnv();
  if (!env.EMAIL) throw new Error("Email sending isn't switched on for this deploy yet.");
  await env.EMAIL.send({
    to: email,
    from: vessel.mailFrom,
    subject: `${code} is your portal sign-in code`,
    text:
      `Your ${vessel.name} ${vessel.nameAccent} crew portal sign-in code is:\n\n    ${code}\n\n` +
      `It works for ${CODE_MINUTES} minutes on the device that asked for it.\n` +
      `If you didn't ask for a code, you can ignore this email.`,
    html:
      `<div style="font-family:sans-serif;max-width:420px"><h2 style="color:${vessel.theme.signIn.ink}">${vessel.name} ${vessel.nameAccent} &middot; Crew Portal</h2>` +
      `<p>Your sign-in code is:</p><p style="font-size:32px;letter-spacing:6px;font-weight:700;color:${vessel.theme.signIn.button}">${code}</p>` +
      `<p style="color:#5b6b7a;font-size:13px">It works for ${CODE_MINUTES} minutes on the device that asked for it. ` +
      `If you didn't ask for a code, ignore this email.</p></div>`,
  });
}

async function handleRequestCode(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const email = cleanEmail(form?.get("email"));
  const next = safeNext(form?.get("next"));
  if (!email) return html(EMAIL_FORM("Type a whole email address.", next));

  const db = getEnv().DB;
  let user = await db
    .prepare("SELECT id, disabled FROM users WHERE email = ?1")
    .bind(email)
    .first<{ id: string; disabled: number }>();

  // First-ever sign-in: the bootstrap address becomes the first IT user.
  if (!user) {
    const anybody = await db.prepare("SELECT id FROM users LIMIT 1").first();
    const bootstrap = (getEnv().BOOTSTRAP_IT_EMAIL || "").trim().toLowerCase();
    if (!anybody && bootstrap && email === bootstrap) {
      await db
        .prepare(
          "INSERT INTO users (id, email, name, role, disabled, created_at, created_by) VALUES (?1, ?2, ?3, 'it', 0, ?4, 'bootstrap')",
        )
        .bind(crypto.randomUUID(), email, vessel.it.name, now())
        .run();
      user = { id: "seeded", disabled: 0 };
    }
  }

  // Whatever the truth, the answer reads the same — an address is never
  // confirmed or denied to whoever is typing addresses at the door.
  if (!user) {
    await logLoginEvent(req, "unknown_email", email);
  } else if (user.disabled) {
    await logLoginEvent(req, "disabled_account", email);
  }
  if (user && !user.disabled) {
    await logLoginEvent(req, "code_requested", email);
    const recent = await db
      .prepare("SELECT sent_at FROM login_codes WHERE email = ?1")
      .bind(email)
      .first<{ sent_at: number }>();
    if (!recent || now() - recent.sent_at >= CODE_RESEND_SECONDS) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await db
        .prepare(
          "INSERT INTO login_codes (email, code_hash, expires_at, attempts, sent_at) VALUES (?1, ?2, ?3, 0, ?4) " +
            "ON CONFLICT (email) DO UPDATE SET code_hash = ?2, expires_at = ?3, attempts = 0, sent_at = ?4",
        )
        .bind(email, await sha256(`${email}:${code}`), now() + CODE_MINUTES * 60, now())
        .run();
      try {
        await sendCode(email, code);
      } catch (e) {
        console.error("login code could not be emailed:", e);
      }
    }
  }
  return html(CODE_FORM(email, undefined, next));
}

async function handleVerify(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const email = cleanEmail(form?.get("email"));
  const code = String(form?.get("code") || "").trim();
  const next = safeNext(form?.get("next"));
  if (!email || !/^\d{6}$/.test(code)) {
    return html(email ? CODE_FORM(email, "The code is the six digits from the email.", next) : EMAIL_FORM(undefined, next));
  }

  const db = getEnv().DB;
  const row = await db
    .prepare("SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?1")
    .bind(email)
    .first<{ code_hash: string; expires_at: number; attempts: number }>();

  const fail = async (msg: string) => {
    if (row) {
      await db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?1").bind(email).run();
    }
    return html(CODE_FORM(email, msg, next), 401);
  };

  if (!row || row.expires_at < now()) {
    await logLoginEvent(req, "code_expired", email);
    return fail("That code has lapsed — start again and a fresh one is sent.");
  }
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    await logLoginEvent(req, "code_lockout", email);
    return fail("Too many tries. Start again for a fresh code.");
  }
  if (row.code_hash !== (await sha256(`${email}:${code}`))) {
    await logLoginEvent(req, "code_wrong", email);
    return fail("That's not the code — check the email and try again.");
  }

  const user = await db
    .prepare("SELECT id, email, name, role FROM users WHERE email = ?1 AND disabled = 0")
    .bind(email)
    .first<PortalUser>();
  if (!user) return fail("That account isn't on the portal any more.");

  await db.prepare("DELETE FROM login_codes WHERE email = ?1").bind(email).run();

  // The cookie carries a random token; the table stores its hash — a leaked
  // database row can't be replayed as a session.
  const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db
    .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, revoked) VALUES (?1, ?2, ?3, ?4, 0)")
    .bind(await sha256(token), user.id, now(), now() + SESSION_DAYS * 86400)
    .run();
  await db.prepare("UPDATE users SET last_login = ?2 WHERE id = ?1").bind(user.id, now()).run();
  await logLoginEvent(req, "signed_in", email);

  return new Response(null, {
    status: 303,
    headers: {
      Location: next,
      "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

async function handleLogout(req: Request): Promise<Response> {
  const sid = cookieOf(req);
  if (sid) {
    const who = await currentUser(req);
    await getEnv().DB.prepare("UPDATE sessions SET revoked = 1 WHERE id = ?1").bind(await sha256(sid)).run();
    await logLoginEvent(req, "signed_out", who ? who.email : null);
  }
  return new Response(null, {
    status: 303,
    headers: { Location: "/login", "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` },
  });
}

/**
 * Stands in front of everything, replacing the old shared-password gate.
 * Returns null when the request may pass (and the user, when there is one),
 * or the Response that answers it instead.
 */
const PUBLIC_FILES = new Set([
  "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png",
  // The fauna log's own home-screen icon and manifest.
  "/fauna/manifest.webmanifest", "/fauna/icon-192.png", "/fauna/icon-512.png",
]);

export async function gate(
  req: Request,
  path: string,
): Promise<{ barred: Response | null; user: PortalUser | null }> {
  // A hammered door pauses before it does anything else — the same neutral
  // answer whatever was being tried, and the attempt itself goes in the book.
  if ((path === "/login" || path === "/login/verify") && req.method === "POST") {
    if (await rateLimited(req)) {
      await logLoginEvent(req, "rate_limited", null, path);
      return {
        barred: html(EMAIL_FORM("Too many attempts from this connection. Wait ten minutes and try again."), 429),
        user: null,
      };
    }
  }
  if (path === "/login") {
    if (req.method === "POST") return { barred: await handleRequestCode(req), user: null };
    // /login?next=/fauna/ is how the fauna app sends a signed-out phone here.
    return { barred: html(EMAIL_FORM(undefined, safeNext(new URL(req.url).searchParams.get("next")))), user: null };
  }
  if (path === "/login/verify" && req.method === "POST") return { barred: await handleVerify(req), user: null };
  if (path === "/logout") return { barred: await handleLogout(req), user: null };
  // The home-screen app's icon and manifest are fetched by the phone itself,
  // outside any sign-in — they carry nothing but the roundel.
  if (PUBLIC_FILES.has(path)) return { barred: null, user: null };

  const user = await currentUser(req);
  if (user) {
    if (path === "/api/me") {
      return {
        barred: Response.json(
          { name: user.name, email: user.email, role: user.role, fitToSail: getEnv().FIT_TO_SAIL_URL || null },
          { headers: { "Cache-Control": "no-store" } },
        ),
        user,
      };
    }
    return { barred: null, user };
  }

  if (path.startsWith("/api/")) {
    return { barred: Response.json({ error: "Sign in first — open the portal in the browser." }, { status: 401 }), user: null };
  }
  // A page asked for before signing in is where the sign-in lands afterwards.
  return { barred: html(EMAIL_FORM(undefined, safeNext(path))), user: null };
}
