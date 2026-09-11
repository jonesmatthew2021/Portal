import { getEnv } from "./env.js";

/**
 * The password on the front door.
 *
 * On Netlify this was the platform's own password protection, asked at the
 * edge before anything else; here it is ours. One shared password
 * (PORTAL_PASSWORD, a worker secret) gates the whole portal — the page, the
 * files, every /api route — the same bar the crew had before. Entering it
 * once sets a long-lived cookie and the portal never asks again on that
 * device.
 *
 * With no PORTAL_PASSWORD set (local dev) the gate stands open, which is why
 * `wrangler dev` needs no ceremony. This is a door key shared by the crew,
 * not real per-person security — the portal's own sign-in decides who can do
 * what once inside, exactly as before.
 */

const COOKIE = "portal_key";

async function expected(): Promise<string | null> {
  const password = getEnv().PORTAL_PASSWORD;
  if (!password) return null;
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${password}:coolibah-gate`),
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cookieOf(req: Request): string | null {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === COOKIE) return part.slice(eq + 1);
  }
  return null;
}

const LOGIN_PAGE = (wrong: boolean) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TSV Coolibah - Crew Portal</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#eef2f5; font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  form { background:#fff; border:1px solid #d4dbe2; border-top:4px solid #2e6a8e; border-radius:8px;
    padding:34px 30px; width:min(360px, 90vw); text-align:center; }
  h1 { font-size:20px; color:#16324a; margin:0; letter-spacing:.4px; }
  .sub { color:#5b6b7a; font-size:12.5px; margin:6px 0 22px; }
  input { font:inherit; font-size:15px; width:100%; box-sizing:border-box; padding:11px 12px;
    border:1px solid #d4dbe2; border-radius:6px; margin-bottom:12px; text-align:center; }
  button { font:inherit; font-size:14.5px; font-weight:600; width:100%; padding:11px; border:0;
    border-radius:6px; background:#2e6a8e; color:#fff; cursor:pointer; }
  .wrong { color:#b03a2e; font-size:13px; margin:0 0 12px; }
</style></head><body>
<form method="POST" action="/login">
  <h1>TSV COOLIBAH</h1>
  <div class="sub">Crew Portal &middot; United Marine</div>
  ${wrong ? '<p class="wrong">That password isn’t right - try again.</p>' : ""}
  <input type="password" name="password" placeholder="Crew password" autofocus autocomplete="current-password">
  <button type="submit">Enter the portal</button>
</form>
</body></html>`;

/**
 * Stands in front of everything. Returns null when the request may pass, or
 * the Response that answers it instead (the login page, the cookie-setting
 * redirect, or a 401 for an API call from a device that has never entered).
 */
export async function gate(req: Request, path: string): Promise<Response | null> {
  const want = await expected();
  if (!want) return null; // no password configured — local dev

  if (path === "/login") {
    if (req.method !== "POST") return new Response(LOGIN_PAGE(false), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    const form = await req.formData().catch(() => null);
    const given = form ? String(form.get("password") || "") : "";
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${given}:coolibah-gate`));
    const key = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (key !== want) {
      return new Response(LOGIN_PAGE(true), { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/",
        "Set-Cookie": `${COOKIE}=${want}; Path=/; Max-Age=15552000; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  if (cookieOf(req) === want) return null;

  if (path.startsWith("/api/")) {
    return Response.json({ error: "Enter the crew password first — open the portal in the browser." }, { status: 401 });
  }
  return new Response(LOGIN_PAGE(false), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
