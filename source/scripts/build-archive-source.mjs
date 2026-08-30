/* Packs the portal's own source into one JSON file so the browser can put it
   into the "download everything" archive.

   The Admin tab has a button that builds a zip of the whole portal — every
   source file it is made of, every document anyone has uploaded, and the shared
   state holding the roster, the notes and the change log. The documents and the
   state come from the API, because that is where they live. The source can't:
   a page in a browser has no way to read db/schema.ts off the server. So it is
   written down here, ahead of time, and served as a static file the page can
   fetch like any other.

   index.html is deliberately not in here. It is 915 KB — two thirds of the
   whole repository — and the page can fetch it from "/" instead, which is both
   smaller to store and more honest: what comes back from "/" is the front end
   that is actually deployed, not a copy of it taken whenever this last ran.

   Run it after changing any source file, the same as the review bundles:

       node scripts/build-archive-source.mjs

   No dependencies, nothing installed, no build step — it reads files and writes
   one file. If it is not re-run, the archive still builds; the source in it is
   just as old as `packagedOn` says it is, which is why the page shows that date
   next to the button and writes it into the archive's README. */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "review", "portal-source.json");

/* Directories never worth walking into. node_modules is installed rather than
   written, .git is the history rather than the project, and .netlify is a
   local scratch folder — all three are already ignored by git, and none of them
   is source anybody would want handed back to them. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".netlify"]);

/* Generated files in review/. They are packaged copies of the source that is
   already going into the archive whole, so including them would put the same
   code in twice — once as itself and once quoted inside a text bundle. The
   page these bundles are downloaded from is source, and stays. */
const SKIP_FILES = new Set([
  "review/coolibah-portal-source.txt",
  "review/coolibah-portal-no-certificates.txt",
  "review/coolibah-certificates.txt",
  "review/bundle-info.json",
  "review/portal-source.json",
  // Fetched live from "/" by the page that builds the archive.
  "index.html",
]);

/* A guard rather than a real limit. Everything in this repository is source and
   the largest of it is well under a megabyte, so a file over this is something
   that has been dropped in rather than written — a spreadsheet, a scan, a build
   artifact. It is skipped and named in `skipped`, so it shows up rather than
   quietly swelling every archive from here on. */
const MAX_BYTES = 2 * 1024 * 1024;

// Zip entry names use forward slashes on every platform, and so does the web.
const posix = (p) => p.split(sep).join("/");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
      continue;
    }
    if (entry.isFile()) out.push(posix(relative(ROOT, join(dir, entry.name))));
  }
  return out;
}

const files = [];
const skipped = [];

for (const path of walk(ROOT)) {
  if (SKIP_FILES.has(path)) continue;

  const bytes = statSync(join(ROOT, path)).size;
  if (bytes > MAX_BYTES) {
    skipped.push({ path, bytes, why: "larger than the source size guard" });
    continue;
  }

  /* Everything here is meant to be text. Reading a file that isn't as UTF-8
     silently swaps every byte it can't make sense of for a replacement
     character, and writing that into the archive would hand somebody a
     corrupted copy of their own file without saying so. Decoding strictly
     throws on those bytes instead, which is the answer we want — and it has to
     be the strict decode rather than a search for the replacement character in
     the result, because a source file is perfectly entitled to contain one. */
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(join(ROOT, path)));
  } catch {
    skipped.push({ path, bytes, why: "not a UTF-8 text file" });
    continue;
  }

  files.push({ path, bytes, text });
}

const payload = {
  packagedOn: new Date().toISOString().slice(0, 10),
  // Named here rather than in the browser so the layout of the archive is
  // decided in one place.
  folder: "source",
  note: "index.html is not in this file — the portal fetches it from / when it builds the archive.",
  fileCount: files.length,
  totalBytes: files.reduce((n, f) => n + f.bytes, 0),
  skipped,
  files,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload));

const kb = (n) => `${Math.round(n / 1024).toLocaleString("en-AU")} KB`;
console.log(`review/portal-source.json — ${payload.fileCount} files, ${kb(payload.totalBytes)} of source`);
for (const s of skipped) console.log(`  skipped ${s.path} (${kb(s.bytes)}) — ${s.why}`);
