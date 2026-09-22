/**
 * The portal's source, assembled.
 *
 * source/index.html is the shell: the page, the theme, the shared helpers and
 * the state everything hangs off. The Admin tabs live one to a file under
 * source/areas/, and this splices them into the shell at the @areas marker.
 *
 * Why: one 21,000-line file can only be worked on by one job at a time. Two
 * people, or two sessions, editing different tabs both edited that file and
 * collided on every change. A file per tab means two tabs are two files.
 *
 * Everything that builds or checks the portal comes through here, so there is
 * one answer to "what is the portal's source" and the builds and the checks
 * cannot disagree about it.
 *
 * The areas go in in filename order, which is why the marker sits at the
 * bottom of the script: by then every shared const exists. The components
 * themselves are function declarations, which JavaScript hoists, so nothing
 * cares where in the file they end up.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AREAS = join(ROOT, "source", "areas");
const MARKER = "/* @areas */";

/** The area files, in the order they are spliced in. */
export function areaFiles() {
  let names = [];
  try {
    names = readdirSync(AREAS).filter((n) => n.endsWith(".jsx")).sort();
  } catch (e) {
    return [];          // no areas yet: the shell is the whole portal
  }
  return names;
}

/* Line endings are settled here and nowhere else.
 *
 * Git hands the source back with CRLF on this machine and with LF on others,
 * and the build used to carry whichever it was straight into preview.html - so
 * the same source built to two different files and the "preview is in step"
 * check failed for no reason anybody could see. Everything is read as LF. */
const asLf = (t) => t.split(String.fromCharCode(13) + "\n").join("\n");

/** source/index.html with every area spliced in. */
export function portalSource() {
  const shell = asLf(readFileSync(join(ROOT, "source", "index.html"), "utf8"));
  const names = areaFiles();
  const at = shell.indexOf(MARKER);

  if (at < 0) {
    if (names.length) {
      throw new Error(
        "source/index.html has no " + MARKER + " marker, so the " + names.length +
        " file(s) in source/areas would not be in the portal at all.",
      );
    }
    return shell;        // nothing to splice, nothing to mark
  }

  const areas = names.map((n) => {
    const body = readFileSync(join(AREAS, n), "utf8").replace(/\r\n/g, "\n");
    // A header per area, so a stack trace or a search says which file to open.
    return "/* ---- source/areas/" + n + " ---- */\n" + body.replace(/\n+$/, "") + "\n";
  }).join("\n");

  return shell.slice(0, at) + areas + shell.slice(at + MARKER.length);
}

/** Just the JSX, lifted out of the assembled page. */
export function portalJsx() {
  const src = portalSource();
  const open = src.indexOf('<script type="text/babel"');
  if (open < 0) throw new Error("source/index.html has no portal script in it.");
  const start = src.indexOf(">", open) + 1;
  return src.slice(start, src.indexOf("</script>", start));
}
