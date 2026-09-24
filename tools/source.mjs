/**
 * The portal's source, assembled.
 *
 * source/index.html is the shell: the page, the theme, the shared helpers and
 * the state everything hangs off. The Admin tabs live one to a file under
 * source/areas/, and this splices them into the shell at the @areas marker.
 * The big crew-facing pages - the Crew Matrix, the Roster, the certificate
 * Upload and the certificate cells they share - live one to a file under
 * source/parts/ and go in at the @parts marker, just before the areas, by
 * the same rules. The code the worker runs too lives under source/shared/ and goes in at the
 * @shared marker, where it sat before it was shared. What is this vessel's
 * alone - its name, brand, time zone, ranks and the rest - is source/vessel.json,
 * declared as VESSEL at the @vessel marker and written into the page's head.
 *
 * Why: one 21,000-line file can only be worked on by one job at a time. Two
 * people, or two sessions, editing different tabs both edited that file and
 * collided on every change. A file per tab means two tabs are two files.
 *
 * Everything that builds or checks the portal comes through here, so there is
 * one answer to "what is the portal's source" and the builds and the checks
 * cannot disagree about it.
 *
 * The parts and the areas go in in filename order, which is why the markers
 * sit at the bottom of the script: by then every shared const exists. The
 * components themselves are function declarations, which JavaScript hoists,
 * so nothing cares where in the file they end up.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "source");
const AREAS = join(ROOT, "source", "areas");
const PARTS = join(ROOT, "source", "parts");
const SHARED = join(ROOT, "source", "shared");
const MARKER = "/* @areas */";
const PARTS_MARKER = "/* @parts */";
const SHARED_MARKER = "/* @shared */";
const VESSEL_MARKER = "/* @vessel */";
const VESSEL_FILE = join(SOURCE, "vessel.json");

/* ---------------------------------------------------------------------
 * The vessel file: everything that is this vessel's and not the portal's.
 *
 * source/vessel.json carries the name, the brand, the time zone, the domain,
 * the ranks, the swings, the customer's marks and the crew folders. The page
 * gets it as `const VESSEL` at the @vessel marker, and the head of the page
 * (the title, the theme colour, the icons) is written from it as the page is
 * assembled. The worker reads the same file through worker/src/vessel.ts,
 * which checks the same shape - change one list, change the other. A key
 * missing or of the wrong kind is a build error that names the key, so a
 * vessel file for a new vessel that leaves something out is found at the
 * build and not on somebody's phone.
 * ------------------------------------------------------------------- */
const VESSEL_SHAPE = [
  ["slug", "string"], ["operator", "string"], ["name", "string"], ["nameAccent", "string"],
  ["shortName", "string"], ["title", "string"], ["strapline", "string"],
  ["brand.logo", "string"], ["brand.icon", "string"], ["brand.icon512", "string"], ["brand.appleTouch", "string"],
  ["brand.roundelText", "string[]"],
  ["theme.themeColor", "string"], ["theme.bodyBackground", "string"],
  ["theme.signIn.ink", "string"], ["theme.signIn.button", "string"],
  ["theme.light", "colours"], ["theme.dark", "colours"],
  ["theme.fonts.display", "string"], ["theme.fonts.body", "string"], ["theme.fonts.mono", "string"],
  ["timezone", "string"], ["domain", "string"], ["mailFrom", "string"], ["emailDomainGuess", "string"],
  ["it.name", "string"], ["contacts.opms", "string"], ["contacts.correspondencePoster", "string"],
  ["links.opms", "string"], ["portways.partnership", "string"], ["portways.vessel", "string"],
  ["previewAccounts", "array"], ["parties", "string[]"],
  ["swings.ids", "string[]"], ["swings.labels", "object"], ["swings.pattern.anchor", "string"],
  ["swings.pattern.cycle", "number"], ["swings.legacyNotes", "array"],
  ["ranks", "array"], ["depts", "string[]"], ["deptOrder", "string[]"], ["deptRenames", "object"],
  ["rankGroups", "array"], ["rosterRanks", "string[]"], ["rankToPortways", "object"],
  ["shift.vesselCode", "string"], ["shift.pools", "array"], ["shift.establishment", "array"],
  ["shift.groups", "array"], ["shift.sheetWords", "object"],
  ["customerMarks.elearning", "string"], ["customerMarks.auIssuers", "string[]"],
  ["customerMarks.nameStopWords", "string[]"],
  ["elearningCodes", "string[]"], ["noExpiryCodes", "string[]"], ["elearningGroups", "string[]"],
  ["certStated", "object"], ["certPageNotes", "string[]"], ["tickets", "object"],
  ["docBuckets", "string[]"], ["labels", "object"], ["qualColumns", "array"], ["crewFolders", "object"],
];
// The colours a theme must name: the ones the roundel gives the page.
const THEME_COLOURS = ["deep", "panel", "raised", "rule", "text", "muted", "accent", "accentSoft", "teal", "blue"];
/* What each entry of the lists must carry. A list can be a list and still be
 * wrong inside: a rank group without its pattern would compile to a pattern
 * that matches every position and file the whole crew under the first
 * heading, and a pool without its "is" would do the same on the shift matrix.
 * So each entry is looked at, and each pattern is compiled once here. */
const ENTRY_SHAPE = [
  ["previewAccounts", ["name"]],
  ["swings.legacyNotes", ["id", "label"]],
  ["ranks", ["id", "label", "dept"]],
  ["shift.pools", ["pool", "is"]],
  ["shift.establishment", ["key", "label", "pool"]],
  ["shift.groups", ["id", "title"]],
];
const compiles = (pattern) => { try { new RegExp(pattern); return true; } catch (e) { return false; } };

/** Checks the vessel file's shape; throws naming the first key that is wrong. */
export function checkVessel(vessel, from = "source/vessel.json") {
  const at = (path) => path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), vessel);
  const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
  const word = (v) => typeof v === "string" && v.trim() !== "";
  const wrong = (path, want) => new Error(from + " has no usable \"" + path + "\" - it must be " + want + ".");
  for (const [path, kind] of VESSEL_SHAPE) {
    const v = at(path);
    const ok =
      kind === "string" ? word(v) :
      kind === "number" ? typeof v === "number" && Number.isFinite(v) :
      kind === "string[]" ? Array.isArray(v) && v.every((x) => typeof x === "string") :
      kind === "array" ? Array.isArray(v) :
      kind === "object" ? isObject(v) :
      kind === "colours" ? isObject(v) && THEME_COLOURS.every((c) => word(v[c])) :
      false;
    if (!ok) {
      throw wrong(path, kind === "colours" ? "an object naming " + THEME_COLOURS.join(", ") : kind === "string[]" ? "a list of strings" : kind === "array" ? "a list" : kind === "object" ? "an object" : "a " + kind);
    }
  }
  for (const [path, fields] of ENTRY_SHAPE) {
    at(path).forEach((entry, i) => {
      for (const f of fields) if (!isObject(entry) || !word(entry[f])) throw wrong(path + "[" + i + "]." + f, "a string");
    });
  }
  vessel.shift.pools.forEach((p, i) => { if (!compiles(p.is)) throw wrong("shift.pools[" + i + "].is", "a pattern that compiles"); });
  vessel.shift.establishment.forEach((e, i) => {
    if (!Array.isArray(e.shifts) || !e.shifts.every((s) => typeof s === "string")) throw wrong("shift.establishment[" + i + "].shifts", "a list of strings");
  });
  vessel.shift.groups.forEach((g, i) => { if (g.hours !== null && !word(g.hours)) throw wrong("shift.groups[" + i + "].hours", "a string or null"); });
  /* The ids the code keys on. The page hands each shift group its rule by id
   * (day, night, swing), reads the sheet's words by day and night, and names
   * the swings by A and B - so a file that spells any of these its own way
   * would build a page that throws on the Swing Compliance page. Named here,
   * with the key, rather than found there. */
  const GROUP_IDS = ["day", "night", "swing"];
  vessel.shift.groups.forEach((g, i) => { if (!GROUP_IDS.includes(g.id)) throw wrong("shift.groups[" + i + "].id", "one of " + GROUP_IDS.join(", ")); });
  for (const id of GROUP_IDS) {
    if (vessel.shift.groups.filter((g) => g.id === id).length !== 1) throw wrong("shift.groups", "a list with one group for each of " + GROUP_IDS.join(", "));
  }
  for (const id of ["day", "night"]) if (!word(vessel.shift.sheetWords[id])) throw wrong("shift.sheetWords." + id, "a string");
  for (const letter of ["A", "B"]) if (!word(vessel.swings.labels[letter])) throw wrong("swings.labels." + letter, "a string");
  // The page pairs the ids with the labels by order, so a file with one id or
  // three would call a crew by the wrong name. Only the count can be held
  // here: which id is A and which is B is the file's to get right.
  if (vessel.swings.ids.length !== 2) throw wrong("swings.ids", "two ids, the first for swing A and the second for swing B");
  const poolNames = vessel.shift.pools.map((p) => p.pool);
  vessel.shift.establishment.forEach((e, i) => {
    if (!poolNames.includes(e.pool)) throw wrong("shift.establishment[" + i + "].pool", "one of the pools in shift.pools");
    e.shifts.forEach((s, j) => { if (s !== "day" && s !== "night") throw wrong("shift.establishment[" + i + "].shifts[" + j + "]", "day or night"); });
  });
  vessel.rankGroups.forEach((g, i) => {
    if (!Array.isArray(g) || g.length !== 2 || !word(g[0]) || !word(g[1])) throw wrong("rankGroups[" + i + "]", "a heading and a pattern, both strings");
    if (!compiles(g[1])) throw wrong("rankGroups[" + i + "][1]", "a pattern that compiles");
  });
  vessel.qualColumns.forEach((c, i) => {
    if (!Array.isArray(c) || c.length !== 3 || !word(c[0]) || !word(c[1]) || typeof c[2] !== "string") throw wrong("qualColumns[" + i + "]", "a code, a title and a group, all strings");
  });
  return vessel;
}

/* The brand's four image files, and the name each is served under. The page
 * inlines the logo and the icon; the asset build copies all four so a phone
 * that installs the portal fetches this vessel's roundel and not another's. */
export const BRAND_FILES = [["logo", null], ["icon", "icon-192.png"], ["icon512", "icon-512.png"], ["appleTouch", "apple-touch-icon.png"]];

/** The vessel file, read and checked. Another file can be given (the checks
 *  assemble the page for a made-up vessel to prove nothing else names this one). */
export function readVessel(file = VESSEL_FILE) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(file + " could not be read as JSON: " + e.message);
  }
  const vessel = checkVessel(parsed, file);
  // The brand's files are read off disk by the build, so a path that names
  // nothing is said here, with the key, and not as a read error from inside.
  for (const [key] of BRAND_FILES) {
    const rel = vessel.brand[key];
    if (!(existsSync(join(SOURCE, rel)) && statSync(join(SOURCE, rel)).isFile())) {
      throw new Error(file + " has no usable \"brand." + key + "\": " + rel + " is not a file under source/.");
    }
  }
  return vessel;
}

/** The home-screen manifest for a vessel: source/app/manifest.webmanifest
 *  with the vessel's name, short name and colour written in. The source
 *  manifest is the template and is never edited for a vessel. */
export function manifestFor(vessel) {
  const manifest = JSON.parse(readFileSync(join(SOURCE, "app", "manifest.webmanifest"), "utf8"));
  manifest.name = vessel.name + " " + vessel.nameAccent + " Crew Portal";
  manifest.short_name = vessel.shortName;
  manifest.theme_color = vessel.theme.themeColor;
  return JSON.stringify(manifest, null, 2) + "\n";
}

/** A PNG under source/, as a data: address the page can carry inline. */
const inlinePng = (rel) => "data:image/png;base64," + readFileSync(join(SOURCE, rel)).toString("base64");

/* The vessel as the page carries it: the JSON, with the logo and the icon read
 * off disk and inlined so the portal stays a single file. Nothing else is
 * changed on the way in. */
function vesselForPage(vessel) {
  return { ...vessel, brand: { ...vessel.brand, logo: inlinePng(vessel.brand.logo), icon: inlinePng(vessel.brand.icon) } };
}

/* The head of the page is HTML, not script, so the title, the theme colour,
 * the icons and the two colours in the boot stylesheet are written in here
 * rather than read from VESSEL at run time. Each placeholder must be found
 * exactly once, or the page has drifted from what the build expects. */
function withVesselHead(shell, page) {
  const fills = {
    "__VESSEL_TITLE__": page.title,
    "__VESSEL_SHORT_NAME__": page.shortName,
    "__VESSEL_THEME_COLOR__": page.theme.themeColor,
    "__VESSEL_BODY_BACKGROUND__": page.theme.bodyBackground,
    "__VESSEL_MUTED__": page.theme.light.muted,
    "__VESSEL_ICON__": page.brand.icon,
  };
  for (const [mark, value] of Object.entries(fills)) {
    const n = shell.split(mark).length - 1;
    const want = mark === "__VESSEL_ICON__" ? 2 : 1;   // the apple icon and the favicon
    if (n !== want) throw new Error("source/index.html should carry " + mark + " " + want + " time(s) in its head, and carries it " + n + ".");
    shell = shell.split(mark).join(value);
  }
  return shell;
}

/** The shell with the vessel written in: the head filled and VESSEL declared at the marker. */
function withVessel(shell, vessel) {
  const page = vesselForPage(vessel);
  const at = shell.indexOf(VESSEL_MARKER);
  if (at < 0) throw new Error("source/index.html has no " + VESSEL_MARKER + " marker, so the page would have no VESSEL at all.");
  const declared = "const VESSEL = " + JSON.stringify(page) + ";";
  return withVesselHead(shell.slice(0, at) + declared + shell.slice(at + VESSEL_MARKER.length), page);
}

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

/** The part files - the big crew-facing pages - in the order they are spliced in. */
export function partFiles() {
  let names = [];
  try {
    names = readdirSync(PARTS).filter((n) => n.endsWith(".jsx")).sort();
  } catch (e) {
    return [];          // no parts yet: everything is still in the shell
  }
  return names;
}

/* The code the page and the worker both run: the workbook writer, the matrix
 * rules and the names register. The worker imports these files as modules;
 * the page has no bundler, so they are spliced into it at the @shared marker
 * with the "export " taken off each declaration, which leaves exactly the
 * code the page always had. */
export function sharedFiles() {
  let names = [];
  try {
    names = readdirSync(SHARED).filter((n) => /\.m?js$/.test(n)).sort();
  } catch (e) {
    return [];          // nothing shared yet
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

/** source/index.html with the vessel written in and every area spliced in.
 *  `vessel` is the checked vessel file; left out, source/vessel.json is read. */
export function portalSource({ vessel = readVessel() } = {}) {
  const shell = withShared(withVessel(asLf(readFileSync(join(ROOT, "source", "index.html"), "utf8")), vessel));
  // The parts go in first, then the areas: both markers sit under every const
  // the shell declares, and a part's own consts are above the areas that read them.
  return withFolder(withFolder(shell, PARTS, "parts", PARTS_MARKER, partFiles()), AREAS, "areas", MARKER, areaFiles());
}

/* The shell with one folder's files spliced in where its marker sits. The
 * parts and the areas are folded by this one function so the two cannot
 * drift apart: a file per page, a header per file, filename order. */
function withFolder(shell, dir, rel, marker, names) {
  const at = shell.indexOf(marker);

  if (at < 0) {
    if (names.length) {
      throw new Error(
        "source/index.html has no " + marker + " marker, so the " + names.length +
        " file(s) in source/" + rel + " would not be in the portal at all.",
      );
    }
    return shell;        // nothing to splice, nothing to mark
  }

  const files = names.map((n) => {
    const text = readFileSync(join(dir, n), "utf8").replace(/\r\n/g, "\n");
    // A header per file, so a stack trace or a search says which file to open.
    return "/* ---- source/" + rel + "/" + n + " ---- */\n" + text.replace(/\n+$/, "") + "\n";
  }).join("\n");

  return shell.slice(0, at) + files + shell.slice(at + marker.length);
}

/** The shell with every shared file spliced in where the marker sits. */
function withShared(shell) {
  const names = sharedFiles();
  const at = shell.indexOf(SHARED_MARKER);
  if (at < 0) {
    if (names.length) {
      throw new Error(
        "source/index.html has no " + SHARED_MARKER + " marker, so the " + names.length +
        " file(s) in source/shared would not be in the portal at all.",
      );
    }
    return shell;
  }

  const shared = names.map(foldedShared).join("\n");

  return shell.slice(0, at) + shared + shell.slice(at + SHARED_MARKER.length);
}

/** One shared file as plain page code: the "export" taken off each
 *  declaration, under a header naming the file. */
function foldedShared(n) {
  const body = readFileSync(join(SHARED, n), "utf8").replace(/\r\n/g, "\n");
  // Only a plain "export" in front of a declaration can be folded back into
  // page code. Anything else would need a bundler, so it is refused here
  // rather than compiled into a page that breaks on load. The comments are
  // taken out before looking, so a comment that mentions an import does not
  // stop the build; the file itself is folded with its comments intact.
  const noComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const code = noComments(body);
  if (/^\s*import\b/m.test(code) || /\bexport\s+default\b/.test(code) || /\bexport\s*\{/.test(code)) {
    throw new Error(
      "source/shared/" + n + " uses an import, an export default or an export { } — " +
      "shared files may only put \"export\" in front of a function, const or let.",
    );
  }
  const folded = body.replace(/^export\s+(?=(async\s+)?function\b|const\b|let\b)/gm, "");
  // Whatever the fold did not take (an export class, an export var) would
  // reach the page as is and only be found by the compile, with Babel's
  // message rather than this one.
  if (/^\s*export\b/m.test(noComments(folded))) {
    throw new Error(
      "source/shared/" + n + " has an export the page cannot fold: only export function, " +
      "export async function, export const and export let are allowed.",
    );
  }
  // A header per file, so a stack trace or a search says which file to open.
  return "/* ---- source/shared/" + n + " ---- */\n" + folded.replace(/\n+$/, "") + "\n";
}

/* The service worker (source/app/sw.js), as the live site serves it at
 * /sw.js: the build's stamp written in as its VERSION - so every deploy is
 * a new worker with a new cache - and source/shared/offline-rules.js folded
 * in at its marker, exactly as the page has it, so the worker and the page
 * decide by the same rules. The stamp must be a plain word: it becomes a
 * string in the worker and the name of its cache. */
const SW_FILE = join(SOURCE, "app", "sw.js");
const SW_VERSION_MARK = '"__BUILD_VERSION__"';
const SW_RULES_MARK = "/* @offline-rules */";
const SW_VENDOR_MARK = "__VENDOR_FILES__";
/** `vendor` is the list of served paths under /vendor/ the worker keeps at
 *  install - React, React DOM and the fonts, as the asset build found them. */
export function serviceWorkerSource(version, vendor = []) {
  if (!/^[A-Za-z0-9._-]{4,64}$/.test(String(version))) {
    throw new Error("the service worker's version must be a plain word (letters, digits, . _ -), not " + JSON.stringify(version));
  }
  if (!Array.isArray(vendor) || vendor.some((p) => typeof p !== "string" || !p.startsWith("/vendor/"))) {
    throw new Error("the service worker's vendor list must be served paths under /vendor/.");
  }
  const sw = asLf(readFileSync(SW_FILE, "utf8"));
  for (const mark of [SW_VERSION_MARK, SW_RULES_MARK, SW_VENDOR_MARK]) {
    if (sw.split(mark).length !== 2) throw new Error("source/app/sw.js should carry " + mark + " exactly once.");
  }
  return sw.replace(SW_VERSION_MARK, JSON.stringify(String(version)))
    .replace(SW_VENDOR_MARK, JSON.stringify(vendor))
    .replace(SW_RULES_MARK, foldedShared("offline-rules.js"));
}

/** Just the JSX, lifted out of the assembled page. */
export function portalJsx(options) {
  const src = portalSource(options);
  const open = src.indexOf('<script type="text/babel"');
  if (open < 0) throw new Error("source/index.html has no portal script in it.");
  const start = src.indexOf(">", open) + 1;
  return src.slice(start, src.indexOf("</script>", start));
}
