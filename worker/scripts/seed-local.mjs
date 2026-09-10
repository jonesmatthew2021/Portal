/* Seeds the local dev worker from the build folder's archive.
 *
 * The archive taken off Netlify holds everything needed to stand the portal
 * up again: portal-state.json (the shared state, rev 342) and
 * documents/index.json (every file row, live and removed) with the files
 * themselves laid out beside it. This script rebuilds the local D1 database
 * from those, and copies a chosen slice of the file bytes into the local R2
 * store so uploads, downloads and readings can be exercised.
 *
 *   node scripts/seed-local.mjs                 rows only (fast)
 *   node scripts/seed-local.mjs --bytes matrices,certification/patwardhan-anand
 *                                               ...rows plus those folders' bytes
 *   node scripts/seed-local.mjs --bytes all     everything (takes a while)
 *
 * Local only — remote seeding at deploy time uses the same shapes against the
 * real database (--remote) and the real file store.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..");
const REPO = join(WORKER, "..");
const SEED = join(WORKER, ".seed");
mkdirSync(SEED, { recursive: true });

// Wrangler invoked as its JS entry under this same node — spawning npx.cmd on
// Windows trips EINVAL, and this dodges the shell entirely.
const WRANGLER_BIN = join(WORKER, "node_modules", "wrangler", "bin", "wrangler.js");
const wrangler = (args) =>
  execFileSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: WORKER,
    stdio: ["ignore", "pipe", "pipe"],
  });

const q = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const epoch = (v) => (v == null ? "NULL" : Math.floor(new Date(v).getTime() / 1000));

/* ---- the document rows ---- */
const index = JSON.parse(readFileSync(join(REPO, "documents", "index.json"), "utf8"));
const rows = index.files || index;

const CHUNK = 200;
let chunks = 0;
for (let i = 0; i < rows.length; i += CHUNK) {
  const batch = rows.slice(i, i + CHUNK).map((r) =>
    `INSERT OR REPLACE INTO documents (id, category, bucket, blob_key, filename, content_type, size_bytes, title, uploaded_by, tag, source, party, rank, swing, filed_on, session_id, created_at, person, folder, qual_code, expires_on, checksum, removed_at, removed_by) VALUES (` +
    [
      q(r.id), q(r.category), q(r.bucket), q(r.blobKey), q(r.filename), q(r.contentType),
      r.sizeBytes ?? 0, q(r.title), q(r.uploadedBy), q(r.tag), q(r.source), q(r.party),
      q(r.rank), q(r.swing), q(r.filedOn), q(r.sessionId), epoch(r.createdAt) ?? 0,
      q(r.person), q(r.folder), q(r.qualCode), q(r.expiresOn), q(r.checksum),
      epoch(r.removedAt), q(r.removedBy),
    ].join(", ") + ");",
  );
  const file = join(SEED, `documents-${chunks}.sql`);
  writeFileSync(file, batch.join("\n"));
  wrangler(["d1", "execute", "portal", "--local", `--file=${file}`]);
  chunks++;
  process.stdout.write(`\rdocument rows: ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
}
console.log();

/* ---- the shared state ----
 * Too big for one SQL statement (SQLite's cap), so it goes in through the
 * portal's own endpoint — which needs the dev worker up: npm run dev first.
 */
const state = JSON.parse(readFileSync(join(REPO, "portal-state.json"), "utf8"));
try {
  const res = await fetch("http://localhost:8788/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rev: 0, data: state.data }),
  });
  if (res.ok) console.log(`portal state seeded (was rev ${state.rev || "?"} on Netlify)`);
  else if (res.status === 409) console.log("portal state already seeded — left as it is");
  else console.log(`portal state not seeded: ${res.status} ${await res.text()}`);
} catch {
  console.log("portal state not seeded — start the dev worker (npm run dev) and run this again");
}

/* ---- file bytes (optional) ---- */
const bytesArg = process.argv.indexOf("--bytes");
if (bytesArg >= 0) {
  const want = (process.argv[bytesArg + 1] || "").split(",").filter(Boolean);
  const all = want.includes("all");
  let put = 0, missing = 0;
  for (const r of rows) {
    if (!all && !want.some((w) => (r.blobKey || "").startsWith(w))) continue;
    // The archive lays files out by their archive path (removed ones already
    // carry removed/ in it).
    const local = join(REPO, "documents", r.path);
    if (!existsSync(local)) { missing++; continue; }
    // Through the worker's own file-store path, so keys land exactly as the
    // portal will ask for them — the r2 CLI percent-encodes keys and doesn't.
    const res = await fetch(
      `http://localhost:8788/api/dev/blob/${r.blobKey.split("/").map(encodeURIComponent).join("/")}`,
      { method: "PUT", body: readFileSync(local) },
    );
    if (!res.ok) throw new Error(`seed of ${r.blobKey} refused: ${res.status}`);
    put++;
    process.stdout.write(`\rfile bytes: ${put} stored`);
  }
  console.log(`\nfile bytes: ${put} stored${missing ? `, ${missing} not found in the archive` : ""}`);
} else {
  console.log("file bytes: skipped (pass --bytes <prefixes> or --bytes all)");
}
