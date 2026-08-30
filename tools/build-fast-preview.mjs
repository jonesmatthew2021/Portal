/* Pre-compiles preview.html into portal.html, so the page opens fast.

   preview.html carries the portal as readable JSX and asks the browser to
   translate it with Babel on every load — several seconds of waiting before
   anything appears, on every visit, on every phone. This script does that
   translation once, here, and writes the result out as portal.html: the same
   page, byte for byte in behaviour, minus the wait and minus the Babel
   download.

   preview.html stays the file that gets edited — it is the readable one.
   portal.html is a build product: never edit it, just re-run this after any
   change to preview.html:

       node tools/build-fast-preview.mjs

   The local server (tools/serve.ps1) serves portal.html at "/" only while it
   is at least as new as preview.html, so forgetting to re-run this shows the
   slower current page rather than a fast stale one. */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import babel from "@babel/standalone";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "preview.html"), "utf8");

const open = src.indexOf('<script type="text/babel"');
if (open === -1) throw new Error("preview.html has no text/babel script to compile");
const openEnd = src.indexOf(">", open) + 1;
const close = src.indexOf("</script>", openEnd);
const jsx = src.slice(openEnd, close);

const t0 = Date.now();
const { code } = babel.transform(jsx, {
  presets: ["react"],
  compact: false,
  retainLines: true,
});

let out =
  src.slice(0, open) +
  '<script type="module">\n' + code + "\n" +
  src.slice(close);

// The Babel loader has nothing left to do in the compiled page.
out = out.replace(/[ \t]*<script[^>]*babel\.min\.js[^>]*><\/script>\r?\n/, "");

writeFileSync(join(ROOT, "portal.html"), out);
console.log(
  `portal.html written — ${(out.length / 1024 / 1024).toFixed(1)} MB, compiled in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
