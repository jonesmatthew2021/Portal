/**
 * The row-insert, proved on a real workbook.
 *
 * Builds a small but honest .xlsx by hand: a header row of item codes, three
 * crew, and — the point of it — a NOTES line, a totals formula reading a crew
 * column, and a merged cell, all sitting UNDER the crew. Then runs the
 * portal's own updateFiledWorkbook to add two new crew, and reads the result
 * back with the portal's own readers to prove: the new rows are where the
 * crew are, everything below moved down intact, the formula still reads the
 * same column but the wider range, and the merged cell moved with its row.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* The code under test is the code that ships: source/shared/workbook.js is
 * the very file the page splices in and the worker imports. Imported as a
 * module here, by URL because the folder's path has a space in it. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const lib = await import(pathToFileURL(join(ROOT, "source", "shared", "workbook.js")).href);

/* ---- an honest little workbook: two-line header, crew on 3-5, and the
        notes, a totals formula and a merged legend UNDER them ---- */
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
const part = (name, text) => {
  const body = enc.encode(text);
  return { name, method: 0, flag: 0, time: 0, date: 0, crc: 0, csize: body.length, usize: body.length, body };
};
const entries = [
  part("[Content_Types].xml", typesXml),
  part("xl/workbook.xml", workbookXml),
  part("xl/_rels/workbook.xml.rels", relsXml),
  part("xl/sharedStrings.xml", stringsXml),
  part("xl/worksheets/sheet1.xml", sheetXml),
];
const zipped = lib.writeZip(entries);

/* ---- the matrix with two men the sheet has never seen ---- */
const quals = {
  cols: [["QL-01", "Master"], ["QL-17", "Medical"]],
  rows: [
    ["EVANS, Brenton", "Master", "", ["2031-05-26", "2028-02-02"]],
    ["FARMER, Evan", "Master", "", ["2028-04-18", "2026-11-13"]],
    ["COOK, Jack", "Second Mate", "", ["2031-07-13", "2028-01-05"]],
    ["EVDOKIMOV, Evgeny", "CHIEF OFFICER", "", ["2030-06-26", "2028-05-22"]],
    ["ROSE, Matthew", "CHIEF OFFICER", "", ["2030-09-11", "2027-01-30"]],
  ],
};

const buf = await new Blob([zipped]).arrayBuffer();
const out = await lib.updateFiledWorkbook(buf, quals);
if (!out.blob) throw new Error("nothing was written: " + JSON.stringify(out.report));
console.log("report:", JSON.stringify({ added: out.report.addedRows, skipped: out.report.skippedRows, written: out.report.written }));

/* ---- read the result back with the portal's own readers ---- */
const outBuf = await out.blob.arrayBuffer();
const outEntries = lib.readZip(outBuf);
const outXml = await lib.partText(lib.partOf(outEntries, "xl/worksheets/sheet1.xml"));

const say = [];
const rowsBack = [...outXml.matchAll(/<row r="(\d+)">?/g)].map((m) => Number(m[1]));
say.push("row numbers now: " + rowsBack.join(", "));
say.push("new men on rows: " + [...outXml.matchAll(/<row r="(\d+)"[^>]*>(?:(?!<\/row>).)*?(EVDOKIMOV, Evgeny|ROSE, Matthew)/gs)].map((m) => m[1] + "=" + m[2]).join(", "));
say.push("NOTES moved to row: " + ((outXml.match(/<row r="(\d+)"[^>]*>(?:(?!<\/row>).)*?NOTES/s) || [])[1] || "GONE"));
say.push("totals formula now: " + ((outXml.match(/<f>([^<]+)<\/f>/) || [])[1] || "GONE"));
say.push("merged cell now: " + ((outXml.match(/<mergeCell ref="([^"]+)"/) || [])[1] || "GONE"));
say.push("dimension now: " + ((outXml.match(/<dimension ref="([^"]+)"/) || [])[1] || "GONE"));
say.forEach((s2) => console.log("  " + s2));

/* ---- and the hard assertions ---- */
const assert = (ok, what) => { if (!ok) { console.error("FAIL: " + what); process.exitCode = 1; } };
assert(out.report.addedRows.join(",") === "EVDOKIMOV, Evgeny,ROSE, Matthew", "only the two new men were added");
assert(/<row r="6"[^>]*>(?:(?!<\/row>).)*?EVDOKIMOV/s.test(outXml), "Evgeny on row 6, straight after the crew");
assert(/<row r="7"[^>]*>(?:(?!<\/row>).)*?ROSE, Matthew/s.test(outXml), "Rose on row 7");
assert(/<row r="9"[^>]*>(?:(?!<\/row>).)*?NOTES/s.test(outXml), "the NOTES line moved from 7 to 9");
assert(/<row r="11"[^>]*>(?:(?!<\/row>).)*?Legend/s.test(outXml), "the legend moved from 9 to 11");
assert(outXml.includes("<f>COUNT(E3:E5)</f>"), "the totals formula still counts the original crew rows (insert-below-range, as Excel does)");
assert((outXml.match(/<mergeCell ref="([^"]+)"/) || [])[1] === "B10:F10", "the merged note row moved to B10:F10");
assert(/dimension ref="A1:F11"/.test(outXml), "the dimension grew to row 11");
assert(rowsBack.join(",") === [...rowsBack].sort((a, b) => a - b).join(","), "rows are in ascending order");
console.log(process.exitCode ? "SOME CHECKS FAILED" : "ALL GOOD — the insert behaves like Excel's own");

/* ---- the hourly round's way in: only the cells it changed, plus blanks;
        anything the office typed is left as typed and counted ---- */
{
  const three = {
    cols: quals.cols,
    rows: [
      ["EVANS, Brenton", "Master", "", ["2031-05-26", "2028-02-02"]],
      ["FARMER, Evan", "Master", "", ["2028-04-18", ""]],
      ["COOK, Jack", "Second Mate", "", ["", "2028-01-05"]],
    ],
  };
  const roundOut = await lib.updateFiledWorkbook(await new Blob([zipped]).arrayBuffer(), three, null, null, {
    mode: "applied-and-blanks", keys: new Set(["EVANS, BRENTON|QL-17"]),
  });
  assert(!!roundOut.blob, "the round's mode wrote something");
  const roundXml = roundOut.blob ? await lib.partText(lib.partOf(lib.readZip(await roundOut.blob.arrayBuffer()), "xl/worksheets/sheet1.xml")) : "";
  // This fixture carries no cell styles, so a date goes in as text.
  const cellOf = (ref) => (roundXml.match(new RegExp(`<c r="${ref}"[^>]*>(?:<f>[^<]*</f>)?(?:<v>([^<]*)</v>|<is><t[^>]*>([^<]*)</t></is>)`)) || []).slice(1).find(Boolean);
  assert(cellOf("F3") === "2028-02-02", "the one cell the round changed was written");
  assert(cellOf("E3") === "48000", "a date the office typed differently was left as typed");
  assert(roundOut.report.written === 1 && roundOut.report.leftAsTyped === 3, "one written, three left as typed and counted");
  assert(roundOut.report.addedRows.length === 0, "the round adds nobody the workbook has not got");
}
console.log(process.exitCode ? "SOME CHECKS FAILED" : "ALL GOOD — the round's mode leaves the office's figures alone");
