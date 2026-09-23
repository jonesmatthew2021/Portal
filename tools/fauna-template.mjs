/**
 * The workbook the fauna log's month export is written into.
 *
 *   node tools/fauna-template.mjs "<path to the office's Marine Fauna Observation Log.xlsx>" [month tab]
 *
 * The office's log is one tab per month, all the same shape, plus a hidden
 * Sheet1 holding the dropdown lists. This keeps one month tab (the last one,
 * or the one named) and Sheet1, drops every other tab and the parts only they
 * used, empties the kept tab's rows under the header, and writes the result to
 * source/fauna/template.xlsx. The worker renames the tab for the month it is
 * exporting and fills the rows (worker/src/routes/fauna.ts).
 *
 * Run it again whenever MinRes changes the log's layout.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readZip, writeZip, partOf, partText, setPartText, readSheet, writeSheet, putCell, listSheets, xmlEsc,
} from "../source/shared/workbook.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const [, , input, wantedTab] = process.argv;
if (!input) {
  console.error('usage: node tools/fauna-template.mjs "<Marine Fauna Observation Log.xlsx>" [month tab]');
  process.exit(1);
}

const entries = readZip(readFileSync(input));
const wb = partOf(entries, "xl/workbook.xml");
const rels = partOf(entries, "xl/_rels/workbook.xml.rels");
let wbXml = await partText(wb);
let relsXml = await partText(rels);
const sheets = listSheets(wbXml, relsXml);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const months = sheets.filter((s) => MONTHS.includes(s.name));
const keep = wantedTab ? sheets.find((s) => s.name === wantedTab) : months[months.length - 1];
const lists = sheets.find((s) => s.name === "Sheet1");
if (!keep) throw new Error("no month tab to keep - the workbook has " + sheets.map((s) => s.name).join(", "));
if (!lists) throw new Error("the hidden Sheet1 with the dropdown lists is not in the workbook");
console.log(`keeping "${keep.name}" and "${lists.name}", dropping ${sheets.length - 2} other tab(s)`);

/* ---- which parts go with each dropped tab ---- */
const dropped = sheets.filter((s) => s !== keep && s !== lists);
const gone = new Set();
for (const s of dropped) {
  gone.add(s.path);
  const relPath = s.path.replace(/worksheets\/(sheet\d+\.xml)$/, "worksheets/_rels/$1.rels");
  const r = partOf(entries, relPath);
  if (r) {
    gone.add(relPath);
    for (const m of (await partText(r)).matchAll(/Target="([^"]+)"/g)) {
      // ../tables/table3.xml -> xl/tables/table3.xml
      const target = "xl/" + m[1].replace(/^\.\.\//, "");
      gone.add(target);
      const tRels = target.replace(/([^/]+)$/, "_rels/$1.rels");
      if (partOf(entries, tRels)) gone.add(tRels);
    }
  }
}
// A part two tabs shared (an image, say) stays if the kept tab still points at it.
const keptRels = [keep, lists].map((s) => s.path.replace(/worksheets\/(sheet\d+\.xml)$/, "worksheets/_rels/$1.rels"));
for (const rp of keptRels) {
  const r = partOf(entries, rp);
  if (!r) continue;
  for (const m of (await partText(r)).matchAll(/Target="([^"]+)"/g)) gone.delete("xl/" + m[1].replace(/^\.\.\//, ""));
}
for (const name of gone) {
  const at = entries.findIndex((e) => e.name === name);
  if (at >= 0) entries.splice(at, 1);
}

/* ---- workbook.xml: the two tabs, the kept tab first ---- */
const sheetTags = [...wbXml.matchAll(/<sheet\b[^>]*\/>/g)].map((m) => m[0]);
const tagOf = (s) => sheetTags.find((t) => t.includes(`name="${xmlEsc(s.name)}"`));
const keptIndex = sheets.indexOf(keep);
wbXml = wbXml.replace(/<sheets>[\s\S]*?<\/sheets>/, `<sheets>${tagOf(keep)}${tagOf(lists)}</sheets>`);
// Print areas belong to a tab by position; the kept tab is now tab 0 and the
// others' print areas go.
wbXml = wbXml.replace(/<definedName\b[^>]*localSheetId="(\d+)"[^>]*>[\s\S]*?<\/definedName>/g, (whole, id) =>
  Number(id) === keptIndex ? whole.replace(/localSheetId="\d+"/, 'localSheetId="0"') : "");
wbXml = wbXml.replace(/activeTab="\d+"/, 'activeTab="0"');
await setPartText(wb, wbXml);

relsXml = relsXml.replace(/<Relationship\b[^>]*\/>/g, (tag) => {
  const target = (tag.match(/Target="([^"]+)"/) || [])[1] || "";
  return gone.has("xl/" + target.replace(/^\//, "").replace(/^xl\//, "")) ? "" : tag;
});
await setPartText(rels, relsXml);

/* ---- [Content_Types].xml: no overrides for parts that are gone ---- */
const types = partOf(entries, "[Content_Types].xml");
await setPartText(types, (await partText(types)).replace(/<Override\b[^>]*\/>/g, (tag) => {
  const part = ((tag.match(/PartName="([^"]+)"/) || [])[1] || "").replace(/^\//, "");
  return gone.has(part) ? "" : tag;
}));

/* ---- docProps/app.xml: the tab list Excel shows in the file's properties ---- */
const app = partOf(entries, "docProps/app.xml");
if (app) {
  let appXml = await partText(app);
  const names = [...appXml.matchAll(/<vt:lpstr>([^<]*)<\/vt:lpstr>/g)].map((m) => m[1]);
  const tabNames = names.filter((n) => sheets.some((s) => xmlEsc(s.name) === n));
  const ranges = names.filter((n) => !tabNames.includes(n) && !/!Print_Area$/.test(n) || n === `${xmlEsc(keep.name)}!Print_Area`);
  const keptTabs = [xmlEsc(keep.name), xmlEsc(lists.name)];
  const vector = [...keptTabs, ...ranges].map((n) => `<vt:lpstr>${n}</vt:lpstr>`).join("");
  appXml = appXml
    .replace(/<TitlesOfParts>[\s\S]*?<\/TitlesOfParts>/, `<TitlesOfParts><vt:vector size="${keptTabs.length + ranges.length}" baseType="lpstr">${vector}</vt:vector></TitlesOfParts>`)
    .replace(/(<vt:lpstr>Worksheets<\/vt:lpstr><\/vt:variant><vt:variant><vt:i4>)\d+/, `$1${keptTabs.length}`)
    .replace(/(<vt:lpstr>Named Ranges<\/vt:lpstr><\/vt:variant><vt:variant><vt:i4>)\d+/, `$1${ranges.length}`);
  await setPartText(app, appXml);
}

/* ---- the kept tab: every row under the header emptied, styles kept ---- */
const sheetPart = partOf(entries, keep.path);
const sheet = readSheet(await partText(sheetPart));
let cleared = 0;
for (const row of sheet.rows) {
  if (row.num < 16) continue;
  for (const c of row.cells) {
    if (c.v !== undefined || c.is !== undefined || c.hasFormula) { putCell(row, c.col, c.ref, c.s, { kind: "blank" }); cleared++; }
  }
}
await setPartText(sheetPart, writeSheet(sheet).replace(/<selection\b[^>]*\/>/, '<selection activeCell="A16" sqref="A16"/>').replace(/topLeftCell="[^"]*"/, 'topLeftCell="A1"'));
console.log(`cleared ${cleared} cell(s) under the header`);

const out = join(ROOT, "source", "fauna", "template.xlsx");
const blob = writeZip(entries);
writeFileSync(out, new Uint8Array(await blob.arrayBuffer()));
console.log(`wrote ${out} (${Math.round(blob.size / 1024)} KB, ${entries.length} parts)`);
