/* Builds the worker's assets directory from the portal's source.
 *
 * source/index.html carries the portal as readable JSX and asks the browser to
 * translate it with Babel on every load. The deployed page shouldn't pay that
 * wait, so the JSX is compiled here once — the same translation the local
 * fast-preview build does — and the compiled page becomes assets/index.html.
 * The Portways crew list form rides along unchanged.
 *
 * Run automatically by `npm run dev` and `npm run deploy`.
 */

import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND_FILES, manifestFor, portalSource, readVessel } from "../../tools/source.mjs";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..");
const REPO = join(WORKER, "..");
const ASSETS = join(WORKER, "assets");

// Babel lives in tools/ already (the fast-preview build uses it); borrow it
// rather than installing a second copy.
const require = createRequire(join(REPO, "tools", "package.json"));
const babel = require("@babel/standalone");

mkdirSync(ASSETS, { recursive: true });

const src = portalSource();
const open = src.indexOf('<script type="text/babel"');
if (open === -1) throw new Error("source/index.html has no text/babel script to compile");
const openEnd = src.indexOf(">", open) + 1;
const close = src.indexOf("</script>", openEnd);
const jsx = src.slice(openEnd, close);

const t0 = Date.now();
const { code } = babel.transform(jsx, { presets: ["react"], compact: false, retainLines: true });

let out = src.slice(0, open) + '<script type="module">\n' + code + "\n" + src.slice(close);
out = out.replace(/[ \t]*<script[^>]*babel\.min\.js[^>]*><\/script>\r?\n/, "");

writeFileSync(join(ASSETS, "index.html"), out);
copyFileSync(join(REPO, "source", "crew-list-form.html"), join(ASSETS, "crew-list-form.html"));
// The home-screen app: its manifest written from the vessel file (the name,
// the short name and the colour are the vessel's, never typed into the source
// manifest), and the vessel's own roundel served under the fixed names the
// manifest and the page ask for, so a phone that installs the portal gets
// this vessel's icon. Done here, where the assets are made, so every way of
// making them - the build, npm run assets on its own - gives the same files.
const vessel = readVessel();
writeFileSync(join(ASSETS, "manifest.webmanifest"), manifestFor(vessel));
for (const [key, served] of BRAND_FILES) {
  if (served) copyFileSync(join(REPO, "source", vessel.brand[key]), join(ASSETS, served));
}
// The fauna log — the phone app at /fauna/ — is its own folder, carried over
// as it is: the page, its rules module, its manifest and icons, and the
// workbook template the month export is written into. Plain files, nothing
// to compile.
const FAUNA = join(ASSETS, "fauna");
mkdirSync(FAUNA, { recursive: true });
const faunaFiles = readdirSync(join(REPO, "source", "fauna")).filter((f) => !f.endsWith(".svg"));
for (const f of faunaFiles) copyFileSync(join(REPO, "source", "fauna", f), join(FAUNA, f));

console.log(
  `assets built — index.html ${(out.length / 1024 / 1024).toFixed(1)} MB (compiled in ${((Date.now() - t0) / 1000).toFixed(1)}s), crew-list-form.html, app icons and the fauna log (${faunaFiles.length} files) copied`,
);
