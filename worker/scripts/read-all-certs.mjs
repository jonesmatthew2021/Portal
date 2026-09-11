/* Drives the big first read: every certificate on the portal through the AI,
 * a few per request, until none are left unread. Each reading is cached by
 * the file's fingerprint, so this is paid for once — interrupting and
 * rerunning is always safe and never re-reads a certificate.
 *
 *   PORTAL_URL=... PORTAL_PASSWORD=... node scripts/read-all-certs.mjs
 */
import { createHash } from "node:crypto";

const BASE = (process.env.PORTAL_URL || "").replace(/\/+$/, "");
const PASSWORD = process.env.PORTAL_PASSWORD || "";
if (!BASE || !PASSWORD) throw new Error("Set PORTAL_URL and PORTAL_PASSWORD.");
const cookie = `portal_key=${createHash("sha256").update(`${PASSWORD}:coolibah-gate`).digest("hex")}`;
const H = { cookie, "Content-Type": "application/json" };

const state = await (await fetch(`${BASE}/api/state`, { headers: { cookie } })).json();
const cols = state?.data?.quals?.cols;
if (!Array.isArray(cols) || !cols.length) throw new Error("The matrix columns aren't in the portal state.");

let batch = 0;
let stumbles = 0;
while (true) {
  let out = null;
  try {
    const r = await fetch(`${BASE}/api/analyse`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ action: "extract", cols, limit: 5 }),
    });
    out = await r.json();
  } catch (e) {
    console.log(`connection stumble (${e.cause?.code || e.message}) — waiting and carrying on`);
    await new Promise((s) => setTimeout(s, 8000));
    continue;
  }
  if (out.error) {
    if (++stumbles > 5) { console.log(`stopping after repeated errors: ${out.error}`); break; }
    console.log(`server said: ${out.error} — waiting and carrying on`);
    await new Promise((s) => setTimeout(s, 10000));
    continue;
  }
  stumbles = 0;
  batch++;
  if (batch % 5 === 0 || out.remaining === 0) {
    console.log(`read so far: batch ${batch}, remaining ${out.remaining}`);
  }
  if (out.remaining === 0) { console.log("ALL CERTIFICATES READ"); break; }
}
