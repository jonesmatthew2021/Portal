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

/** Returns the built preview. Writes it to preview.html unless write is false. */
export function buildPreview({ write = true, quiet = false } = {}) {
  const src = readFileSync(join(ROOT, "source", "index.html"), "utf8");

  let out = src.replace(
    "<title>TSV Coolibah - Crew Portal</title>",
    "<title>TSV Coolibah - Crew Portal (TEST PREVIEW)</title>",
  );

  let shim = readFileSync(SHIM, "utf8").replace(/\n$/, "");
  let note;
  if (existsSync(DATA)) {
    const held = JSON.parse(readFileSync(DATA, "utf8"));
    shim = shim
      .replace("__SNAPSHOT__", JSON.stringify(held.snapshot))
      .replace("__FILE_ROWS__", JSON.stringify(held.fileRows));
    note = "crew snapshot rev " + held.snapshot.rev;
  } else {
    // No snapshot on this computer: the preview still builds and still runs,
    // it just opens empty. The snapshot is crew data and is kept out of git.
    shim = shim.replace("__SNAPSHOT__", '{"rev":0,"data":{}}').replace("__FILE_ROWS__", "[]");
    note = "no snapshot on this computer - preview will open empty";
  }

  const at = out.indexOf(ANCHOR);
  if (at < 0) throw new Error("source/index.html has no babel script tag to sit in front of.");
  out = BANNER + out.slice(0, at) + shim + "\n" + out.slice(at);

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
