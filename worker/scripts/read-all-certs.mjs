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
let stalled = 0;
let throttled = 0;
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
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
    // A throttled worker stays throttled while it keeps being hit, so each
    // consecutive miss backs further off — half a minute, then one, two,
    // five — and one success resets the clock.
    throttled = Math.min(throttled + 1, 4);
    const wait = [30, 60, 120, 300, 300][throttled] * 1000;
    console.log(`throttled — backing off ${wait / 1000}s`);
    await sleep(wait);
    continue;
  }
  throttled = 0;
  if (out.error) {
    if (++stumbles > 5) { console.log(`stopping after repeated errors: ${out.error}`); break; }
    console.log(`server said: ${out.error} — waiting and carrying on`);
    await new Promise((s) => setTimeout(s, 10000));
    continue;
  }
  stumbles = 0;
  batch++;
  // A batch that read nothing and failed everything is not progress — after a
  // few of those in a row the same certificates are jamming the queue, and
  // looping on them burns requests while reading nothing. Say what failed and
  // stop for a person to look.
  if ((out.extracted ?? 0) === 0 && Array.isArray(out.failures) && out.failures.length) {
    if (++stalled >= 4) {
      console.log(`STALLED on the same batch — first failure: ${out.failures[0].filename}: ${out.failures[0].error}`);
      break;
    }
  } else {
    stalled = 0;
  }
  if (batch % 20 === 0 || out.remaining === 0) {
    console.log(`read so far: batch ${batch}, remaining ${out.remaining}`);
  }
  if (out.remaining === 0) { console.log("ALL CERTIFICATES READ"); break; }
  // A breather between batches keeps sustained load under the free plan's
  // throttle trigger — slower per hour, faster to actually finish.
  await sleep(15000);
}
