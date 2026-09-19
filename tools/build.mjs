/**
 * Builds everything the portal is made of, in the order it has to happen.
 *
 *   source/index.html  - the portal itself, and the only file anyone edits
 *     -> preview.html            the offline copy, with its crew snapshot
 *          -> portal.html        that copy compiled, for opening straight off disk
 *     -> worker/assets/index.html   the live site, compiled
 */
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const step = (what, file, cwd) => {
  process.stdout.write("  " + what + " ... ");
  execFileSync("node", [file], { cwd: cwd || ROOT, stdio: "pipe" });
  console.log("done");
};

console.log("Building the portal");
step("preview.html   from source/index.html", join(ROOT, "tools", "build-preview.mjs"));
step("portal.html    from preview.html", join(ROOT, "tools", "build-fast-preview.mjs"));
step("live site      from source/index.html", join(ROOT, "worker", "scripts", "build-assets.mjs"), join(ROOT, "worker"));
console.log("Built.");
