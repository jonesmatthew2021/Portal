/**
 * The portal's safety net.
 *
 *   node tools/check.mjs
 *
 * Runs every check in a few seconds and says, in plain words, whether anything
 * that used to work has stopped. `npm run deploy` runs it first and refuses to
 * ship if any of it fails.
 *
 * It catches what it covers, not everything. What it covers is the ground that
 * has actually given way before: something calling a piece of the portal that
 * no longer exists, the page failing to compile, preview.html drifting from the
 * portal it is meant to mirror, and the worker's types going astray.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { buildPreview } from "./build-preview.mjs";
import { portalJsx, areaFiles } from "./source.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "tools", "package.json"));

/* Names the portal may use without declaring: the browser's own, and the two
 * libraries the page loads. Anything NOT on this list that the portal refers to
 * does not exist at all - which is the whole point of the first check. Add to
 * this list only when the browser really does provide the name. */
const PROVIDED = new Set(`
Array Blob Boolean CompressionStream DataView Date DecompressionStream Error File
FileReader Float32Array FormData Int32Array Intl JSON Map Math Notification Number
Object Promise React ReactDOM RegExp ResizeObserver Response Set String TextDecoder
TextEncoder URL URLSearchParams Uint8Array XMLHttpRequest cancelAnimationFrame
clearInterval clearTimeout createImageBitmap crypto document encodeURIComponent
fetch isFinite isNaN location navigator parseFloat parseInt requestAnimationFrame
sessionStorage setInterval setTimeout undefined window XLSX localStorage console
Image Audio alert confirm atob btoa structuredClone AbortController Headers Request
Symbol BigInt Proxy Reflect WeakMap WeakSet ArrayBuffer Uint16Array Int8Array
Uint8ClampedArray Float64Array performance queueMicrotask history screen
`.trim().split(/\s+/));

const results = [];
const run = (title, fn) => {
  try {
    const note = fn();
    results.push({ ok: true, title, note: note || "" });
  } catch (e) {
    results.push({ ok: false, title, note: e.message });
  }
};
const skip = (title, why) => results.push({ skipped: true, title, note: why });

/* The portal's own script, lifted out of the assembled page — the shell plus
   every area under source/areas. Taken from one place so the checks and the
   builds cannot disagree about what the portal's source is. */

/* ---------------------------------------------------------------- 1 */
run("The portal compiles", () => {
  const babel = require("@babel/standalone");
  babel.transform(portalJsx(), { presets: ["react"], compact: false, retainLines: true });
  return "no syntax errors";
});

/* ---------------------------------------------------------------- 2 */
run("Everything the portal calls exists", () => {
  const babel = require("@babel/standalone");
  const { parser, traverse } = babel.packages;
  const ast = parser.parse(portalJsx(), { sourceType: "script", plugins: ["jsx"] });
  let loose = [];
  traverse.default(ast, {
    Program(path) {
      loose = Object.keys(path.scope.globals).filter((n) => !PROVIDED.has(n)).sort();
    },
  });
  if (loose.length) {
    throw new Error(
      "the portal refers to " + loose.length + " thing(s) that are not defined anywhere: " +
      loose.join(", ") +
      "\n      Either they were removed while something still used them, or a name is misspelt.",
    );
  }
  return "every name it uses is defined";
});

/* ---------------------------------------------------------------- 3 */
run("preview.html is in step with the portal", () => {
  const built = buildPreview({ write: false });
  const onDisk = existsSync(join(ROOT, "preview.html"))
    ? readFileSync(join(ROOT, "preview.html"), "utf8") : "";
  if (built !== onDisk) {
    throw new Error(
      "preview.html is not what source/index.html would build.\n" +
      "      Run: node tools/build-preview.mjs\n" +
      "      (preview.html is a built file - edit source/index.html instead.)",
    );
  }
  return "built from the same source";
});

/* ---------------------------------------------------------------- 4 */
run("Every area is in the portal", () => {
  /* A file dropped into source/areas that the build does not pick up would be
     work that never reaches the portal and never says so. The assembler goes
     by what is in the folder, so this is really checking that each one was
     found and that each one carries the component the switch asks for. */
  const names = areaFiles();
  if (!names.length) return "no areas — the shell is the whole portal";
  const jsx = portalJsx();
  const missing = names.filter((n) => !jsx.includes("/* ---- source/areas/" + n + " ---- */"));
  if (missing.length) {
    throw new Error(
      missing.length + " area file(s) are not in the built portal: " + missing.join(", ") +
      "\n      Check the /* @areas */ marker is still in source/index.html.",
    );
  }
  return names.length + " area(s), all spliced in";
});

/* ---------------------------------------------------------------- 5 */
run("Every rank has a heading to sit under", () => {
  /* The rank pickers offer the vessel's eight ranks and Crew Details groups
     the crew under RANK_GROUPS. The two are separate lists, so a rank can be
     offered that no heading matches — which is what happened to JUNIOR
     ENGINEER: eight men picked it and landed under "Other". */
  const jsx = portalJsx();
  const cut = (a, b) => { const i = jsx.indexOf(a); return jsx.slice(i, jsx.indexOf(b, i) + b.length); };
  const { RANK_GROUPS, ROSTER_RANKS, rankGroupAt } = new Function([
    cut("const RANK_GROUPS = [", "\n];"),
    cut("const ROSTER_RANKS = [", "];"),
    cut("const rankGroupAt =", "\n};"),
    "return { RANK_GROUPS, ROSTER_RANKS, rankGroupAt };",
  ].join("\n"))();

  const homeless = ROSTER_RANKS.filter((r) => rankGroupAt(r) >= RANK_GROUPS.length);
  if (homeless.length) {
    throw new Error(
      homeless.length + " rank(s) fall through to \"Other\": " + homeless.join(", ") +
      "\n      Add them to RANK_GROUPS, or the crew who hold them have no heading.",
    );
  }
  return ROSTER_RANKS.length + " rank(s), each under a heading";
});

/* ---------------------------------------------------------------- 6 */
run("The worker's types are clean", () => {
  try {
    execFileSync("npx", ["tsc", "--noEmit"], {
      cwd: join(ROOT, "worker"), stdio: "pipe", shell: true, timeout: 180000,
    });
  } catch (e) {
    const out = String(e.stdout || "") + String(e.stderr || "");
    const lines = out.split("\n").filter((l) => /error TS/.test(l));
    throw new Error(
      lines.length + " type error(s) in the worker:\n      " + lines.slice(0, 6).join("\n      "),
    );
  }
  return "no type errors";
});

/* ---------------------------------------------------------------- 7 */
const rulesTest = join(ROOT, "worker", "tests", "rules.test.ts");
if (!existsSync(rulesTest)) {
  skip("The worker's rules answer correctly", "no rule tests written yet");
} else {
  run("The worker's rules answer correctly", () => {
    try {
      const out = execFileSync("npx", ["tsx", "--test", "tests/rules.test.ts"], {
        cwd: join(ROOT, "worker"), stdio: "pipe", shell: true, timeout: 180000, encoding: "utf8",
      });
      const m = /(?:#|ℹ)\s*pass (\d+)/.exec(out);
      return (m ? m[1] : "all") + " rule(s) still answer correctly";
    } catch (e) {
      const out = String(e.stdout || "") + String(e.stderr || "");
      const bad = out.split("\n").filter((l) => /not ok|Error:|expected/.test(l)).slice(0, 6);
      throw new Error("a rule the portal depends on has changed its answer:\n      " + bad.join("\n      "));
    }
  });
}

/* ---------------------------------------------------------------------- */
console.log("");
for (const r of results) {
  const mark = r.skipped ? "--" : r.ok ? "OK" : "!!";
  console.log(" " + mark + "  " + r.title + (r.note ? "  (" + r.note.split("\n")[0] + ")" : ""));
  if (!r.ok && !r.skipped) {
    for (const line of r.note.split("\n").slice(1)) console.log(line);
  }
}
const failed = results.filter((r) => !r.ok && !r.skipped);
console.log("");
if (failed.length) {
  console.log(failed.length + " check(s) failed — nothing has been deployed.");
  process.exit(1);
}
console.log("All checks passed.");
