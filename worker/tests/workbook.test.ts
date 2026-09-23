/**
 * The shared workbook and matrix code, run from the worker's side of the fence.
 *
 * source/shared/ is one file the page splices in and the worker imports, and
 * the hourly round is moving into the worker. So the same row-insert that
 * tools/insert-rows.test.mjs proves through the page is proved here through
 * the import, along with the pieces only the worker will use: the dated
 * filename, the sheet-as-rows reader and the expiry rules read off it.
 *
 *   npx tsx --test tests/workbook.test.ts      (or: node tools/check.mjs)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readZip, writeZip, updateFiledWorkbook, partText, partOf, listSheets, readSheetRows,
  datedWorkbookName,
} from "../../source/shared/workbook.js";
import { readExpiryRules, expiryRule } from "../../source/shared/matrix-rules.js";

/* ---- the same honest little workbook insert-rows.test.mjs builds: two-line
        header, crew on 3-5, and the notes, a totals formula and a merged
        legend UNDER them ---- */
const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:F9"/><sheetData>
<row r="1"><c r="B1" t="inlineStr"><is><t>CREW</t></is></c><c r="C1" t="inlineStr"><is><t>POSITION</t></is></c><c r="D1" t="inlineStr"><is><t>SAMS</t></is></c><c r="E1" t="inlineStr"><is><t>QL-01</t></is></c><c r="F1" t="inlineStr"><is><t>QL-17</t></is></c></row>
<row r="2"><c r="B2" t="inlineStr"><is><t>Name</t></is></c></row>
<row r="3"><c r="B3" t="inlineStr"><is><t>EVANS, Brenton</t></is></c><c r="C3" t="inlineStr"><is><t>Master</t></is></c><c r="D3"/><c r="E3" t="n"><v>48000</v></c><c r="F3" t="n"><v>47500</v></c></row>
<row r="4"><c r="B4" t="inlineStr"><is><t>FARMER, Evan</t></is></c><c r="C4" t="inlineStr"><is><t>Master</t></is></c><c r="D4"/><c r="E4" t="n"><v>48100</v></c><c r="F4" t="n"><v>47600</v></c></row>
<row r="5"><c r="B5" t="inlineStr"><is><t>COOK, Jack</t></is></c><c r="C5" t="inlineStr"><is><t>Second Mate</t></is></c><c r="D5"/><c r="E5" t="n"><v>48200</v></c><c r="F5" t="n"><v>47700</v></c></row>
<row r="7"><c r="B7" t="inlineStr"><is><t>NOTES</t></is></c><c r="E7"><f>COUNT(E3:E5)</f><v>3</v></c></row>
<row r="8"><c r="B8" t="inlineStr"><is><t>1. VS-04 never lapses.</t></is></c></row>
<row r="9"><c r="B9" t="inlineStr"><is><t>Legend: red = expired</t></is></c></row>
</sheetData><mergeCells count="1"><mergeCell ref="B8:F8"/></mergeCells></worksheet>`;

const workbookXml = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="CREW EXPIRY" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const relsXml = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
const stringsXml = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"></sst>`;
const typesXml = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`;

const enc = new TextEncoder();
const part = (name: string, text: string) => {
  const body = enc.encode(text);
  return { name, method: 0, flag: 0, time: 0, date: 0, crc: 0, csize: body.length, usize: body.length, body };
};
const workbook = (sheet: string, wb: string) => [
  part("[Content_Types].xml", typesXml),
  part("xl/workbook.xml", wb),
  part("xl/_rels/workbook.xml.rels", relsXml),
  part("xl/sharedStrings.xml", stringsXml),
  part("xl/worksheets/sheet1.xml", sheet),
];

/* ---- the matrix with two men the sheet has never seen ---- */
const quals = {
  cols: [["QL-01", "Master"], ["QL-17", "Medical"]],
  rows: [
    ["EVANS, Brenton", "Master", "", ["2031-05-26", "2028-02-02"]],
    ["FARMER, Evan", "Master", "", ["2028-04-18", "2026-11-13"]],
    ["COOK, Jack", "Second Mate", "", ["2031-07-13", "2028-01-05"]],
    ["EVDOKIMOV, Evgeny", "CHIEF OFFICER", "", ["2030-06-26", "2028-05-22"]],
    ["ROSE, Matthew", "CHIEF OFFICER", "", ["2030-09-11", "2027-01-30"]],
  ] as [string, string, string, string[]][],
};

test("new crew fit into the office's workbook, through the worker's import", async () => {
  const buf = await writeZip(workbook(sheetXml, workbookXml)).arrayBuffer();
  const out = await updateFiledWorkbook(buf, quals);
  if (!out.blob) throw new Error("nothing was written: " + JSON.stringify(out.report));

  const outEntries = readZip(await out.blob.arrayBuffer());
  const outXml = await partText(partOf(outEntries, "xl/worksheets/sheet1.xml"));
  const rowsBack = [...outXml.matchAll(/<row r="(\d+)">?/g)].map((m) => Number(m[1]));

  assert.equal(out.report.addedRows.join(","), "EVDOKIMOV, Evgeny,ROSE, Matthew", "only the two new men were added");
  assert.ok(/<row r="6"[^>]*>(?:(?!<\/row>).)*?EVDOKIMOV/s.test(outXml), "Evgeny on row 6, straight after the crew");
  assert.ok(/<row r="7"[^>]*>(?:(?!<\/row>).)*?ROSE, Matthew/s.test(outXml), "Rose on row 7");
  assert.ok(/<row r="9"[^>]*>(?:(?!<\/row>).)*?NOTES/s.test(outXml), "the NOTES line moved from 7 to 9");
  assert.ok(/<row r="11"[^>]*>(?:(?!<\/row>).)*?Legend/s.test(outXml), "the legend moved from 9 to 11");
  assert.ok(outXml.includes("<f>COUNT(E3:E5)</f>"), "the totals formula still counts the original crew rows (insert-below-range, as Excel does)");
  assert.equal((outXml.match(/<mergeCell ref="([^"]+)"/) || [])[1], "B10:F10", "the merged note row moved to B10:F10");
  assert.ok(/dimension ref="A1:F11"/.test(outXml), "the dimension grew to row 11");
  assert.equal(rowsBack.join(","), [...rowsBack].sort((a, b) => a - b).join(","), "rows are in ascending order");
});

test("the filed workbook carries the day it was written on the front", () => {
  assert.equal(datedWorkbookName("20260918 - X.xlsx", "2026-09-23"), "20260923 - X.xlsx");
  assert.equal(datedWorkbookName("X.xlsx", "2026-09-23"), "20260923 - X.xlsx");
  // A caller that forgets the day is refused, not obliged with "undefined - X.xlsx".
  assert.throws(() => datedWorkbookName("X.xlsx", undefined as unknown as string), /YYYY-MM-DD/);
  assert.throws(() => datedWorkbookName("X.xlsx", "23/09/2026"), /YYYY-MM-DD/);
});

/* ---- the office's rule book, as a sheet ---- */
const cell = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const line = (n: number, words: string[]) =>
  `<row r="${n}">${words.map((w, i) => (w === "" ? "" : cell(String.fromCharCode(65 + i) + n, w))).join("")}</row>`;
const guidanceXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
${line(1, ["Certification ID", "Name", "Category", "Timeframe", "Expiry"])}
${line(2, ["QL-01", "Master", "", "", "5 years"])}
${line(3, ["VS-04", "Helm", "", "", "No expiry"])}
${line(4, ["QL-17", "Medical", "", "", "determined by practitioner"])}
</sheetData></worksheet>`;
const guidanceWorkbookXml = workbookXml.replace('name="CREW EXPIRY"', 'name="Guidance Information"');

test("the expiry rules read off the Guidance Information sheet", async () => {
  const entries = readZip(await writeZip(workbook(guidanceXml, guidanceWorkbookXml)).arrayBuffer());
  const sheets = listSheets(await partText(partOf(entries, "xl/workbook.xml")), await partText(partOf(entries, "xl/_rels/workbook.xml.rels")));
  const guidance = sheets.find((s) => /guidance information/i.test(s.name));
  if (!guidance) throw new Error("the sheet is not found by name");

  const rows = await readSheetRows(entries, guidance.path);
  assert.deepEqual(rows[0], ["Certification ID", "Name", "Category", "Timeframe", "Expiry"], "the header row reads as row 1");
  assert.equal(rows[1][0], "QL-01");
  assert.equal(rows[1][2], "", "an empty cell reads as a blank");

  const read = readExpiryRules(rows);
  const rule = (code: string) => read.find((r) => r.code === code);
  assert.equal(rule("QL-01")?.months, 60, "5 years is sixty months");
  assert.equal(rule("VS-04")?.never, true, "No expiry never lapses");
  assert.equal(rule("QL-17")?.own, true, "the practitioner's judgement is the certificate's own date");
});

test("two alternatives: the shorter is the rule", () => {
  assert.equal(expiryRule("2 years or 4 years")?.months, 24);
});
