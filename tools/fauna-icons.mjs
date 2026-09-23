/**
 * The fauna log's home-screen icon, drawn from source/fauna/icon.svg.
 *
 *   node tools/fauna-icons.mjs
 *
 * Writes icon-192.png and icon-512.png beside it. sharp is borrowed from the
 * worker's node_modules, where wrangler already brings it in.
 */
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "worker", "package.json"));
const sharp = require("sharp");
const svg = join(ROOT, "source", "fauna", "icon.svg");

for (const size of [192, 512]) {
  const out = join(ROOT, "source", "fauna", `icon-${size}.png`);
  await sharp(svg).resize(size, size).png().toFile(out);
  console.log("wrote " + out);
}
