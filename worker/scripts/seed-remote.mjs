/* Loads the deployed portal from the build folder's archive — the one-time
 * migration off the previous host.
 *
 *   PORTAL_URL=https://coolibah-portal.<account>.workers.dev \
 *   PORTAL_PASSWORD=<the crew password> \
 *   node scripts/seed-remote.mjs [--bytes all]
 *
 * Three movements, same shapes as the local seed:
 *   rows   — every document record, in chunks, straight into the real D1
 *   state  — the shared portal state, through /api/state (only if empty)
 *   bytes  — the files themselves, through the portal's own store path,
 *            with the crew-password cookie on every request
 *
 * Safe to run again: rows are INSERT OR REPLACE, the state seeding yields to
 * one already there, and bytes overwrite with identical content.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..");
const REPO = join(WORKER, "..");
const SEED = join(WORKER, ".seed");

const BASE = (process.env.PORTAL_URL || "").replace(/\/+$/, "");
const PASSWORD = process.env.PORTAL_PASSWORD || "";
if (!BASE) throw new Error("Set PORTAL_URL to the deployed portal's address.");
if (!PASSWORD) throw new Error("Set PORTAL_PASSWORD so the migration can get past the front door.");

// The same cookie the login page would set — the gate and this must agree.
const cookie = `portal_key=${createHash("sha256").update(`${PASSWORD}:coolibah-gate`).digest("hex")}`;

const WRANGLER_BIN = join(WORKER, "node_modules", "wrangler", "bin", "wrangler.js");
const wrangler = (args) =>
  execFileSync(process.execPath, [WRANGLER_BIN, ...args], { cwd: WORKER, stdio: ["ignore", "pipe", "pipe"] });

const index = JSON.parse(readFileSync(join(REPO, "documents", "index.json"), "utf8"));
const rows = index.files || index;

/* ---- rows: reuse the SQL chunks the local seed writes ---- */
const chunkCount = Math.ceil(rows.length / 200);
let haveChunks = true;
for (let i = 0; i < chunkCount; i++) if (!existsSync(join(SEED, `documents-${i}.sql`))) haveChunks = false;
if (!haveChunks) throw new Error("Run scripts/seed-local.mjs once first — it writes the SQL chunks this reuses.");
for (let i = 0; i < chunkCount; i++) {
  wrangler(["d1", "execute", "portal", "--remote", `--file=${join(SEED, `documents-${i}.sql`)}`]);
  process.stdout.write(`\rdocument rows: chunk ${i + 1}/${chunkCount}`);
}
console.log();

/* ---- state ---- */
const state = JSON.parse(readFileSync(join(REPO, "portal-state.json"), "utf8"));
{
  const res = await fetch(`${BASE}/api/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ rev: 0, data: state.data }),
  });
  if (res.ok) console.log(`portal state loaded (rev ${state.rev || "?"} in the archive)`);
  else if (res.status === 409) console.log("portal state already there — left alone");
  else throw new Error(`state load refused: ${res.status} ${await res.text()}`);
}

/* ---- bytes ---- */
const bytesArg = process.argv.indexOf("--bytes");
if (bytesArg < 0) {
  console.log("bytes: skipped (pass --bytes all, or --bytes <prefixes>)");
} else {
  const want = (process.argv[bytesArg + 1] || "all").split(",").filter(Boolean);
  const all = want.includes("all");
  let put = 0, missing = 0, failed = 0;
  const total = rows.filter((r) => all || want.some((w) => (r.blobKey || "").startsWith(w))).length;
  for (const r of rows) {
    if (!all && !want.some((w) => (r.blobKey || "").startsWith(w))) continue;
    const local = join(REPO, "documents", r.path);
    if (!existsSync(local)) { missing++; continue; }
    const url = `${BASE}/api/dev/blob/${r.blobKey.split("/").map(encodeURIComponent).join("/")}`;
    // A flaky vessel connection shouldn't sink an hour's upload: three goes each.
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const res = await fetch(url, { method: "PUT", headers: { cookie }, body: readFileSync(local) });
        ok = res.ok;
        if (!ok && attempt === 2) console.log(`\n  refused (${res.status}): ${r.blobKey}`);
      } catch {
        await new Promise((s) => setTimeout(s, 2000 * (attempt + 1)));
      }
    }
    if (ok) put++; else failed++;
    process.stdout.write(`\rfile bytes: ${put}/${total} up${failed ? `, ${failed} failed` : ""}${missing ? `, ${missing} not in archive` : ""}   `);
  }
  console.log(`\nfile bytes: ${put} stored, ${failed} failed, ${missing} not found in the archive`);
  if (failed) console.log("run again — already-stored files are skipped over harmlessly (same bytes, same keys)");
}
