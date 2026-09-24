/**
 * Builds everything the portal is made of, in the order it has to happen.
 *
 *   source/index.html  - the portal itself, and the only file anyone edits
 *     -> preview.html            the offline copy, with its crew snapshot
 *          -> portal.html        that copy compiled, for opening straight off disk
 *     -> worker/assets/index.html   the live site, compiled
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readVessel } from "./source.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const step = (what, file, cwd) => {
  process.stdout.write("  " + what + " ... ");
  execFileSync("node", [file], { cwd: cwd || ROOT, stdio: "pipe" });
  console.log("done");
};

/* The home-screen manifest names the vessel, and the vessel's name lives in
 * source/vessel.json. The asset build copies source/app/manifest.webmanifest
 * over as it is; this writes the vessel's name, short name and colour into
 * that copy, so the source manifest is never edited by hand for a vessel. */
const manifestStep = () => {
  process.stdout.write("  manifest       from source/vessel.json ... ");
  const vessel = readVessel();
  const manifest = JSON.parse(readFileSync(join(ROOT, "source", "app", "manifest.webmanifest"), "utf8"));
  manifest.name = vessel.name + " " + vessel.nameAccent + " Crew Portal";
  manifest.short_name = vessel.shortName;
  manifest.theme_color = vessel.theme.themeColor;
  writeFileSync(join(ROOT, "worker", "assets", "manifest.webmanifest"), JSON.stringify(manifest, null, 2) + "\n");
  console.log("done");
};

console.log("Building the portal");
step("preview.html   from source/index.html", join(ROOT, "tools", "build-preview.mjs"));
step("portal.html    from preview.html", join(ROOT, "tools", "build-fast-preview.mjs"));
step("live site      from source/index.html", join(ROOT, "worker", "scripts", "build-assets.mjs"), join(ROOT, "worker"));
manifestStep();
console.log("Built.");
