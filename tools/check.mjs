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
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { buildPreview } from "./build-preview.mjs";
import { portalJsx, portalSource, areaFiles, partFiles, sharedFiles, readVessel, manifestFor } from "./source.mjs";

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
Infinity MediaRecorder indexedDB
Uint8ClampedArray Float64Array performance queueMicrotask history screen
TypeError RangeError SyntaxError
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
run("Every area, part and shared file is in the portal", () => {
  /* A file dropped into source/areas, source/parts or source/shared that the
     build does not pick up would be work that never reaches the portal and
     never says so. The assembler goes by what is in the folders, so this is
     really checking that each one was found and spliced in under its own
     header. */
  const names = areaFiles();
  const parts = partFiles();
  const shared = sharedFiles();
  if (!names.length && !parts.length && !shared.length) return "no areas, parts or shared files — the shell is the whole portal";
  const jsx = portalJsx();
  const missing = names.filter((n) => !jsx.includes("/* ---- source/areas/" + n + " ---- */"));
  if (missing.length) {
    throw new Error(
      missing.length + " area file(s) are not in the built portal: " + missing.join(", ") +
      "\n      Check the /* @areas */ marker is still in source/index.html.",
    );
  }
  const missingParts = parts.filter((n) => !jsx.includes("/* ---- source/parts/" + n + " ---- */"));
  if (missingParts.length) {
    throw new Error(
      missingParts.length + " part file(s) are not in the built portal: " + missingParts.join(", ") +
      "\n      Check the /* @parts */ marker is still in source/index.html.",
    );
  }
  const missingShared = shared.filter((n) => !jsx.includes("/* ---- source/shared/" + n + " ---- */"));
  if (missingShared.length) {
    throw new Error(
      missingShared.length + " shared file(s) are not in the built portal: " + missingShared.join(", ") +
      "\n      Check the /* @shared */ marker is still in source/index.html.",
    );
  }
  return names.length + " area(s), " + parts.length + " part(s) and " + shared.length + " shared file(s), all spliced in";
});

/* --------------------------------------------------------------- 4b */
run("The fauna log compiles and is in the live site", () => {
  /* The phone app at /fauna/ is plain HTML and a module, copied into the
     worker's assets as they are. So two things can go wrong quietly: a typo
     that breaks the page on the phone, and an edit under source/fauna that
     never reached worker/assets because the build was not run. */
  const babel = require("@babel/standalone");
  const { parser } = babel.packages;
  const dir = join(ROOT, "source", "fauna");
  const page = readFileSync(join(dir, "index.html"), "utf8");
  const open = page.indexOf('<script type="module">');
  if (open < 0) throw new Error("source/fauna/index.html has no module script");
  const script = page.slice(page.indexOf(">", open) + 1, page.indexOf("</script>", open));
  parser.parse(script, { sourceType: "module" });
  parser.parse(readFileSync(join(dir, "fields.js"), "utf8"), { sourceType: "module" });
  for (const f of ["index.html", "fields.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "template.xlsx"]) {
    const built = join(ROOT, "worker", "assets", "fauna", f);
    if (!existsSync(built)) throw new Error("worker/assets/fauna/" + f + " is missing.\n      Run: node tools/build.mjs");
    if (!readFileSync(join(dir, f)).equals(readFileSync(built))) {
      throw new Error("worker/assets/fauna/" + f + " is not what source/fauna/" + f + " would build.\n      Run: node tools/build.mjs");
    }
  }
  return "no syntax errors, and the live copy matches the source";
});

/* ---------------------------------------------------------------- 5 */
run("Every rank has a heading to sit under", () => {
  /* The rank pickers offer the vessel's eight ranks and Crew Details groups
     the crew under RANK_GROUPS. The two are separate lists, so a rank can be
     offered that no heading matches — which is what happened to JUNIOR
     ENGINEER: eight men picked it and landed under "Other". */
  const jsx = portalJsx();
  const cut = (a, b) => { const i = jsx.indexOf(a); return jsx.slice(i, jsx.indexOf(b, i) + b.length); };
  // Both lists are the vessel file's now, so the page's VESSEL is lifted out
  // with them: what is checked is still what the page runs.
  const { RANK_GROUPS, ROSTER_RANKS, rankGroupAt } = new Function([
    cut("const VESSEL = {", "};\n"),
    cut("const RANK_GROUPS = ", ";\n"),
    cut("const ROSTER_RANKS = ", ";\n"),
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
run("New crew fit into the office's workbook", () => {
  /* The training matrix keeps notes, totals and a legend under the crew, so a
     new crew member means inserting rows and moving everything below down,
     exactly as Excel's own insert does. Getting that wrong corrupts the
     office's compliance workbook quietly, so it is proved on a real .xlsx on
     every run: two men added mid-sheet, the notes and legend moved intact,
     the totals formula still reading its rows, the merged cell and the
     dimension moved with them. */
  try {
    const out = execFileSync("node", [join(ROOT, "tools", "insert-rows.test.mjs")], {
      stdio: "pipe", timeout: 180000, encoding: "utf8",
    });
    if (!out.includes("ALL GOOD")) throw new Error(out.split("\n").filter((l) => /FAIL/.test(l)).join("; ") || "the insert test did not finish");
  } catch (e) {
    const said = String(e.stdout || e.message || e);
    throw new Error(said.split("\n").filter((l) => /FAIL|Error/.test(l)).slice(0, 4).join("\n      ") || said.slice(0, 200));
  }
  return "rows inserted mid-sheet, everything below moved intact";
});

/* ---------------------------------------------------------------- 7 */
run("The portal's own rules answer correctly", () => {
  /* The names rule, the certificates' answer laid over the matrix, the
     office's spelling of a name and the three-way merge on a save collision
     are pure functions inside the page, and each has been got wrong once:
     a spelling that stopped matching, a run that took back what it had just
     filled in, a matrix that flipped between two tabs. They are run against
     the cases that went wrong, on the code that ships. */
  try {
    const out = execFileSync("node", [join(ROOT, "tools", "client-rules.test.mjs")], {
      stdio: "pipe", timeout: 180000, encoding: "utf8",
    });
    if (!out.includes("ALL GOOD")) throw new Error(out.split("\n").filter((l) => /FAIL/.test(l)).join("; ") || "the rules test did not finish");
  } catch (e) {
    const said = String(e.stdout || "") + String(e.stderr || "") || String(e.message || e);
    throw new Error(said.split("\n").filter((l) => /FAIL|wanted|got |Error/.test(l)).slice(0, 8).join("\n      ") || said.slice(0, 200));
  }
  return "names, dates, spellings and the merge all answer as they should";
});

/* ---------------------------------------------------------------- 8 */
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

/* ---------------------------------------------------------------- 9 */
const rulesTest = join(ROOT, "worker", "tests", "rules.test.ts");
if (!existsSync(rulesTest)) {
  skip("The worker's rules answer correctly", "no rule tests written yet");
} else {
  run("The worker's rules answer correctly", () => {
    try {
      // The rules, the shared workbook code as the worker imports it, the
      // hourly round piece by piece, the SharePoint sync, the fauna log,
      // the offline reading's public files and headers, and the safety
      // meeting recorder.
      const out = execFileSync("npx", ["tsx", "--test", "tests/rules.test.ts", "tests/workbook.test.ts", "tests/round.test.ts", "tests/sync.test.ts", "tests/fauna.test.ts", "tests/offline.test.ts", "tests/meeting.test.ts"], {
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

/* --------------------------------------------------------------- 10 */
run("The vessel's name lives only in the vessel file", () => {
  /* The portal is stood up for another vessel by copying the code and writing
     a new source/vessel.json - so nothing but that file may name this one.
     The page is assembled here, in memory, for a made-up vessel
     (tools/fixtures/example-vessel.json) and read for this vessel's names,
     and so is the home-screen manifest written for it; the worker's own
     sources, the build scripts and the preview's shim are read the same way;
     the fauna log's files are another job's and are left out. A hit is a name
     that would follow the code onto the next vessel's portal. The real build
     is not touched. */
  /* Whole words, whatever their case: the slug is written "coolibah" in a
     row id or a storage key and "COOLIBAH" in a heading, and each is the
     vessel's name as much as "Coolibah" is. Whole words so that a name the
     backup file's own format keeps ("perthDay") is not the city. The swings'
     names are looked for as written, case and all: the page's comparisons are
     bound to the ids "ALPHA" and "BRAVO", which any vessel's file must carry,
     but "Alpha" in a heading or a note is this vessel's name for its crew. */
  const WORDS = ["Coolibah", "United Marine", "MinRes", "Perth", "Ashburton", "Onslow",
    "coolibah-portal", "unitedmarine", "Preetham", "Matthew Jones", "ONS-MRN", "portways.opms.com.au"];
  const RES = WORDS.map((w) => new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i"));
  const EXACT = ["Alpha", "Bravo"];
  const EXACT_RES = EXACT.map((w) => new RegExp("\\b" + w + "\\b"));
  const hitsIn = (line) => [...WORDS.filter((w, k) => RES[k].test(line)), ...EXACT.filter((w, k) => EXACT_RES[k].test(line))];
  // The check proves its own eyes first: lines that have slipped past it
  // before, each written as it would be in the code, and ones it must leave.
  const mustSee = ["WHERE id = 'coolibah'", 'PORTAL_ROW_ID = "coolibah"', '"coolibah-tab"', '"TSV COOLIBAH"',
    "https://portways.opms.com.au/", "united marine", "MINRES", "Australia/Perth", "Alpha crew"];
  const mustLeave = ["file.perthDay", "const perthDay = ", '"ALPHA"'];
  for (const l of mustSee) if (!hitsIn(l).length) throw new Error("the check cannot see " + l + " - it would let the vessel's name back into the code");
  for (const l of mustLeave) if (hitsIn(l).length) throw new Error("the check mistakes " + l + " for the vessel's name");
  const hits = [];
  const look = (where, text) => text.split("\n").forEach((line, i) => {
    for (const w of hitsIn(line)) hits.push(where + ":" + (i + 1) + "  \"" + w + "\"  " + line.trim().slice(0, 90));
  });
  const example = readVessel(join(ROOT, "tools", "fixtures", "example-vessel.json"));
  look("the page assembled for " + example.name + " " + example.nameAccent, portalSource({ vessel: example }));
  look("the manifest written for " + example.name + " " + example.nameAccent, manifestFor(example));
  const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? sources(join(dir, d.name))
      : d.name.endsWith(".ts") && !d.name.includes("fauna") ? [join(dir, d.name)] : []);
  // The worker, and everything that assembles or ships the page: the preview's
  // shim is spliced into preview.html and the build scripts write the assets,
  // so a name put back in any of them would ship as surely as one in the page.
  const files = [...sources(join(ROOT, "worker", "src")),
    join(ROOT, "worker", "scripts", "build-assets.mjs"), join(ROOT, "tools", "preview", "shim.js"),
    join(ROOT, "tools", "source.mjs"), join(ROOT, "tools", "build.mjs"), join(ROOT, "tools", "build-preview.mjs")];
  for (const f of files) look(relative(ROOT, f).replace(/\\/g, "/"), readFileSync(f, "utf8"));
  if (hits.length) {
    throw new Error(
      hits.length + " place(s) still name this vessel outside source/vessel.json:\n      " +
      hits.slice(0, 12).join("\n      ") + (hits.length > 12 ? "\n      ..." : ""),
    );
  }
  return "the page and the manifest for a made-up vessel and " + files.length + " worker and build files name nothing of this one";
});

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
