/**
 * Builds preview.html from source/index.html.
 *
 * source/index.html is the portal. preview.html is that same portal with a
 * shim in front of it that answers the API from a snapshot of crew data, so it
 * runs with no server behind it. It used to be kept by hand beside the real
 * one, which meant every change had to be made twice and could drift; it is
 * generated now, so it cannot.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { portalSource, readVessel } from "./source.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHIM = join(ROOT, "tools", "preview", "shim.js");
const DATA = join(ROOT, "tools", "preview", "data.json");
const ANCHOR = '<script type="text/babel" data-type="module">';

const BANNER = `<!--
  BUILT FILE - DO NOT EDIT.
  Made from source/index.html by tools/build-preview.mjs. Anything typed in
  here is lost the next time the portal is built. Edit source/index.html.
-->
`;

/** The shim's slots, filled in one pass.
 *
 *  A function replacer, not a replacement string: a string is read for "$"
 *  marks ($&, $', $1), so a "$" in a certificate note or a pattern would be
 *  mangled on the way in, and "$'" would splice the rest of the shim into the
 *  middle of the JSON. One pass over the original text, so a value already
 *  written in is never scanned again: a crew note that happens to say
 *  "__FILE_ROWS__" stays a note. And "<" is written as <, because the
 *  shim is a <script> block and a note saying "</script>" would end it early
 *  and stop the preview page opening. Slots with no value are left as they
 *  are. */
const SLOTS = /__(VESSEL|SNAPSHOT|FILE_ROWS)__/g;
export const into = (text, values) =>
  text.replace(SLOTS, (mark) => (mark in values ? JSON.stringify(values[mark]).replace(/</g, "\\u003c") : mark));
export const vesselIntoShim = (shim, vessel) => into(shim, { __VESSEL__: vessel });

/** The page with every /vendor/ address pointed at source/vendor/ instead:
 *  the two script tags and the font files. Only the two spellings the page
 *  uses are touched (src="/vendor/ and url('/vendor/), so a word in a note
 *  that happens to say /vendor/ is left alone. */
export const withPreviewVendor = (page) =>
  page.split('src="/vendor/').join('src="source/vendor/').split("url('/vendor/").join("url('source/vendor/");

/** Returns the built preview. Writes it to preview.html unless write is false. */
export function buildPreview({ write = true, quiet = false } = {}) {
  const vessel = readVessel();
  const src = portalSource({ vessel });

  // The title is the vessel file's, so the preview's mark is put on whatever
  // the page's own title is rather than on a name written here.
  let out = src.replace(
    "<title>" + vessel.title + "</title>",
    "<title>" + vessel.title + " (TEST PREVIEW)</title>",
  );

  // The shim runs outside the page's own script, so the vessel file is written
  // into it here rather than kept a second time in the shim.
  const shimText = readFileSync(SHIM, "utf8").replace(/\n$/, "");
  let shim;
  let note;
  if (existsSync(DATA)) {
    const held = JSON.parse(readFileSync(DATA, "utf8"));
    shim = into(shimText, { __VESSEL__: vessel, __SNAPSHOT__: held.snapshot, __FILE_ROWS__: held.fileRows });
    note = "crew snapshot rev " + held.snapshot.rev;
  } else {
    // No snapshot on this computer: the preview still builds and still runs,
    // it just opens empty. The snapshot is crew data and is kept out of git.
    shim = into(shimText, { __VESSEL__: vessel, __SNAPSHOT__: { rev: 0, data: {} }, __FILE_ROWS__: [] });
    note = "no snapshot on this computer - preview will open empty";
  }

  const at = out.indexOf(ANCHOR);
  if (at < 0) throw new Error("source/index.html has no babel script tag to sit in front of.");
  out = BANNER + out.slice(0, at) + shim + "\n" + out.slice(at);

  // React, React DOM and the fonts sit at /vendor/ on the live site. The
  // preview is a file in the build folder - opened by double-click, or
  // served by tools/serve.ps1 - so the same files are asked for by the
  // path that works from both: source/vendor/, beside preview.html.
  out = withPreviewVendor(out);

  if (write) {
    writeFileSync(join(ROOT, "preview.html"), out);
    if (!quiet) {
      console.log(
        "preview.html built from source/index.html — " +
        (out.length / 1048576).toFixed(1) + " MB, " + note,
      );
    }
  }
  return out;
}

// Run directly (not imported)? Then build. pathToFileURL gets the Windows
// spelling right, which "file://" + path does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) buildPreview();
