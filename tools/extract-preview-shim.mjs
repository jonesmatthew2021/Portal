/**
 * One-time: lifts the test-preview shim out of the hand-maintained preview.html
 * and splits it into the two things it really is - a small piece of code, and a
 * large snapshot of crew data. Run once; build-preview.mjs puts them back
 * together from then on.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "tools", "preview");
mkdirSync(OUT, { recursive: true });

const prev = readFileSync(join(ROOT, "preview.html"), "utf8");

const MARK = "/* ============================ TEST PREVIEW";
const markAt = prev.indexOf(MARK);
if (markAt < 0) throw new Error("No test-preview shim found in preview.html.");
const open = prev.lastIndexOf("<script>", markAt);
const close = prev.indexOf("</script>", markAt);
if (open < 0 || close < 0) throw new Error("The shim's script tags could not be found.");
const block = prev.slice(open, close + "</script>".length);

// The two data lines, pulled out whole so the code that uses them stays small.
const grab = (name) => {
  const re = new RegExp("^(\\s*const " + name + " = )([\\s\\S]*?);\\s*$", "m");
  const m = re.exec(block);
  if (!m) throw new Error("Could not find " + name + " in the shim.");
  return { whole: m[0], indent: m[1], json: m[2] };
};
const snap = grab("SNAPSHOT");
const rows = grab("FILE_ROWS");

writeFileSync(join(OUT, "data.json"), JSON.stringify({
  note: "Crew-data snapshot the offline preview answers from. Not source code, and not in git.",
  snapshot: JSON.parse(snap.json),
  fileRows: JSON.parse(rows.json),
}, null, 0) + "\n");

const code = block
  .replace(snap.whole, snap.indent + "__SNAPSHOT__;")
  .replace(rows.whole, rows.indent + "__FILE_ROWS__;");
writeFileSync(join(OUT, "shim.js"), code + "\n");

console.log("shim.js   " + (code.length / 1024).toFixed(1) + " KB (code)");
console.log("data.json " + (JSON.stringify(snap.json).length / 1024).toFixed(0) + " KB (crew snapshot)");
