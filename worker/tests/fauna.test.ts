/**
 * The fauna log's rules: what the phone settles on its own, what is still to
 * be filled, the position and the light, the month written into the office's
 * workbook, and a month tab made where the log has none.
 *
 *   npx tsx --test tests/fauna.test.ts      (or: node tools/check.mjs)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  settle, missingFields, blankRecord, latLongText, observerName, positionText, windKmh, compassOf, activityOf,
  sunUp, sheetValue, monthName, inZoneByTable,
} from "../../source/fauna/fields.js";
import { exportMonth, monthFileIn, recipients } from "../src/routes/fauna.js";
import { openLog, ensureMonthTab, writeRows, saveLog, monthTabs, newMonthWorkbook, monthFileName, isMonthFile } from "../src/lib/fauna-log.js";
import { readZip, partOf, partText, listSheets, readSheetRows } from "../../source/shared/workbook.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, "..", "..", "source", "fauna", "template.xlsx");

/* ------------------------------------------------------- the settling ---- */

test("what the phone settles for itself once a sighting is typed in", () => {
  const got = settle({ ...blankRecord(), faunaType: "Whale", species: "Humpback", adults: 2, calves: 1, distance: 500, bearing: 45 });
  assert.equal(got.total, 3, "the total from adults and calves");
  assert.equal(got.inZone, "No", "500 m is outside a whale's 300 m caution zone");
  assert.equal(got.certainty, "Certain", "a named species is certain unless said otherwise");
  assert.equal(got.condition, "Calm");
  assert.equal(got.action, "None");
  assert.equal(got.stopWork, "No");
  const near = settle({ ...blankRecord(), faunaType: "Dolphin", species: "Bottlenose", total: 6, distance: 30, bearing: 270 });
  assert.equal(near.adults, 6, "no calves mentioned: all adults");
  assert.equal(near.calves, 0);
  assert.equal(near.inZone, "Yes");
  assert.equal(inZoneByTable({ faunaType: "Turtle", distance: 100 }), "Yes");
  assert.equal(inZoneByTable({ faunaType: "Turtle", distance: 101 }), "No");
  const other = settle({ ...blankRecord(), faunaType: "Turtle", species: "Other", total: 1 });
  assert.equal(other.certainty, "Uncertain");
  const dugong = settle({ ...blankRecord(), faunaType: "Dugong", total: 1 });
  assert.equal(dugong.species, "Dugong");
});

test("a head count that disagrees is made to add up", () => {
  const got = settle({ ...blankRecord(), faunaType: "Whale", species: "Humpback", total: 2, adults: 2, calves: 1 });
  assert.equal(got.total, 3);
  const fromTotal = settle({ ...blankRecord(), faunaType: "Whale", species: "Humpback", total: 4, adults: 3 });
  assert.equal(fromTotal.calves, 1);
});

test("typed values are tidied into the log's own words", () => {
  const got = settle({ ...blankRecord(), activity: "underway", windDir: "south west", heading: "270", windSpeed: "27.8", glare: "1", cloud: 2, stopWork: "y" });
  assert.equal(got.activity, "Transiting");
  assert.equal(got.windDir, "SW");
  assert.equal(got.heading, 270);
  assert.equal(got.windSpeed, 28);
  assert.equal(got.glare, "1");
  assert.equal(got.cloud, "2");
  assert.equal(got.stopWork, "Yes");
  assert.equal(activityOf("at anchor"), "Anchored");
  assert.equal(compassOf("sw"), "SW");
  assert.equal(compassOf("sou'west"), "SW");
  assert.equal(compassOf("north north east"), "NNE");
  assert.equal(compassOf("westerly"), "W");
  assert.equal(compassOf("variable"), "Variable");
  assert.equal(windKmh(10, "knots"), 19);
  assert.equal(windKmh(28, "km/h"), 28);
});

test("nil sightings need only the conditions", () => {
  const got = settle({ ...blankRecord(), kind: "nil", faunaType: "Whale" });
  assert.equal(got.kind, "nil");
  assert.equal(got.comments, "Nil sightings");
  assert.equal(got.faunaType, null, "nothing about an animal on a nil watch");
  const missing = missingFields(got);
  assert.ok(!missing.includes("faunaType"));
  assert.ok(missing.includes("windSpeed"));
});

test("what is still empty, in the log's order", () => {
  const empty = settle({ ...blankRecord(), time: "07:40", date: "2026-09-24", observer: "M. Jones", lat: "21°23.4'S", long: "114°52.1'E" });
  const missing = missingFields(empty);
  assert.equal(missing[0], "activity", "the vessel first");
  assert.ok(missing.includes("faunaType") && missing.includes("distance"));
  assert.ok(!missing.includes("comments"), "comments are never required");
  const done = settle({ ...empty, activity: "Transiting", heading: 270, glare: "1", visibility: "4", windSpeed: 20, windDir: "SW", waveHeight: 0.5, cloud: "2",
    light: "Full Light", weather: "Sunny", seaState: "2", faunaType: "Whale", species: "Humpback", total: 2, distance: 500, bearing: 45, behaviour: "Travelling", platformHeight: 6 });
  assert.deepEqual(missingFields(done), [], "everything else the rules settle themselves");
});

/* ------------------------------------------------------- the helpers ---- */

test("a position and a name the way the log writes them", () => {
  assert.deepEqual(latLongText(-21.39, 114.868), ["21°23.4'S", "114°52.1'E"]);
  assert.deepEqual(latLongText(-21.999, 114.0), ["21°59.9'S", "114°00.0'E"]);
  assert.equal(positionText("lat", "21 23.4 south"), "21°23.4'S");
  assert.equal(positionText("long", "114 degrees 52.1 minutes east"), "114°52.1'E");
  assert.equal(positionText("lat", "21°23.4'S"), "21°23.4'S");
  assert.equal(positionText("lat", "-21.39"), "21°23.4'S");
  assert.equal(positionText("long", "114.868"), "114°52.1'E");
  assert.equal(positionText("lat", "off Onslow"), "off Onslow");
  const typed = settle({ ...blankRecord(), lat: "21 23.4 south", long: "114 52.1 east" });
  assert.equal(typed.lat, "21°23.4'S");
  assert.equal(typed.long, "114°52.1'E");
  assert.equal(observerName("Matthew Jones"), "M. Jones");
  assert.equal(observerName("Andrii Tymofeyev"), "A. Tymofeyev");
});

test("full light by the sun off Onslow", () => {
  // Mid-morning and mid-afternoon are full light; the small hours are not.
  assert.equal(sunUp("2026-09-24", "10:00", -21.4, 114.9, 8), true);
  assert.equal(sunUp("2026-09-24", "15:30", -21.4, 114.9, 8), true);
  assert.equal(sunUp("2026-09-24", "02:00", -21.4, 114.9, 8), false);
  assert.equal(sunUp("2026-06-21", "18:30", -21.4, 114.9, 8), false, "after sunset in June");
  const got = settle({ ...blankRecord(), date: "2026-09-24", time: "11:00" }, { latDec: -21.4, lonDec: 114.9, tzHours: 8 });
  assert.equal(got.light, "Full Light");
  const chosen = settle({ ...blankRecord(), date: "2026-09-24", time: "11:00", light: "Low Light" }, { latDec: -21.4, lonDec: 114.9, tzHours: 8 });
  assert.equal(chosen.light, "Low Light", "what was picked stands");
});

test("what a column is written to the sheet as", () => {
  assert.deepEqual(sheetValue("time", "07:40"), { kind: "number", value: (7 * 60 + 40) / 1440 });
  assert.deepEqual(sheetValue("date", "2026-08-11"), { kind: "number", value: 46245 });
  assert.deepEqual(sheetValue("species", "Hawksbill"), { kind: "inline", value: "Hawskbill" });
  assert.deepEqual(sheetValue("cloud", "2"), { kind: "number", value: 2 });
  assert.deepEqual(sheetValue("comments", null), { kind: "blank" });
  assert.equal(monthName("2026-09"), "September");
});

/* ------------------------------------------------------ the workbook ---- */

test("a month's workbook is known by its name, however the office wrote the month", () => {
  assert.equal(monthFileName("2026-09"), "09.2026 - Marine Fauna Observation Log.xlsx");
  assert.ok(isMonthFile("09.2026 - Marine Fauna Observation Log.xlsx", "2026-09"));
  assert.ok(isMonthFile("2026-09 Marine Fauna Observation Log.xlsx", "2026-09"));
  assert.ok(isMonthFile("Marine Fauna Observation Log September 2026.xlsx", "2026-09"));
  assert.ok(!isMonthFile("08.2026 - Marine Fauna Observation Log.xlsx", "2026-09"), "another month");
  assert.ok(!isMonthFile("09.2026 - Crew Roster.xlsx", "2026-09"), "not a fauna log");
  assert.ok(!isMonthFile("~$09.2026 - Marine Fauna Observation Log.xlsx", "2026-09"), "Excel's lock file");
  const pick = monthFileIn([
    { name: "09.2026 - Marine Fauna Observation Log.xlsx", path: "United Operations Team/Fauna/09.2026 - Marine Fauna Observation Log.xlsx", modified: "2026-09-20T01:00:00Z" },
    { name: "09.2026 - Marine Fauna Observation Log (2).xlsx", path: "United Operations Team/Fauna/09.2026 - Marine Fauna Observation Log (2).xlsx", modified: "2026-09-24T01:00:00Z" },
    { name: "08.2026 - Marine Fauna Observation Log.xlsx", path: "United Operations Team/Fauna/08.2026 - Marine Fauna Observation Log.xlsx", modified: "2026-09-25T01:00:00Z" },
  ], "2026-09");
  assert.equal(pick && pick.name, "09.2026 - Marine Fauna Observation Log (2).xlsx", "the newest of the month's");
  assert.equal(monthFileIn([], "2026-09"), null);
});

test("a fresh month's workbook from the template carries the month's name through", { skip: !existsSync(TEMPLATE) && "no template built yet (node tools/fauna-template.mjs)" }, async () => {
  const template = readFileSync(TEMPLATE);
  const log = await newMonthWorkbook(template.buffer.slice(template.byteOffset, template.byteOffset + template.byteLength), "2026-10");
  assert.deepEqual(log.sheets.map((s) => s.name), ["October", "Sheet1"]);
  const wbXml = await partText(partOf(log.entries, "xl/workbook.xml"));
  assert.ok(wbXml.includes("October!$A$1:$G$29"), "the print area follows the tab");
  const appXml = await partText(partOf(log.entries, "docProps/app.xml"));
  assert.ok(appXml.includes("<vt:lpstr>October</vt:lpstr>") && !appXml.includes("<vt:lpstr>August</vt:lpstr>"));
  const tab = await ensureMonthTab(log, "2026-10");
  assert.equal(tab.made, false, "the renamed tab is the month's tab");
});

const BASE = { activity: "Transiting", heading: 270, glare: "1", visibility: "4", windSpeed: 28, windDir: "SW", waveHeight: 0.5, cloud: "2",
  light: "Full Light", observer: "M. Jones", weather: "Sunny", seaState: "2", lat: "21°23.4'S", long: "114°52.1'E", platformHeight: 6 };

test("the month goes into the office's own log, tab renamed and rows filled", { skip: !existsSync(TEMPLATE) && "no template built yet (node tools/fauna-template.mjs)" }, async () => {
  const template = readFileSync(TEMPLATE);
  const entries = [
    settle({ ...blankRecord(), ...BASE, time: "07:40", date: "2026-09-24", faunaType: "Whale", species: "Humpback", total: 3, adults: 2, calves: 1,
      bearing: 45, distance: 500, behaviour: "Travelling", action: "Altered course to stbd", comments: "Cow and calf" }),
    settle({ ...blankRecord(), ...BASE, kind: "nil", time: "06:00", date: "2026-09-23", activity: "Mooring", heading: 120, glare: "0", windSpeed: 10, windDir: "NE",
      waveHeight: 0, cloud: "7", light: "Low Light", weather: "Cloudy", seaState: "1", lat: "21°32.0'S", long: "114°59.0'E" }),
  ];
  const bytes = await exportMonth(template.buffer.slice(template.byteOffset, template.byteOffset + template.byteLength), "2026-09", entries);
  const out = readZip(bytes);
  const wbXml = await partText(partOf(out, "xl/workbook.xml"));
  const sheets = listSheets(wbXml, await partText(partOf(out, "xl/_rels/workbook.xml.rels")));
  assert.equal(sheets[0].name, "September");
  assert.ok(wbXml.includes("September!$A$1:$G$29"), "the print area follows the tab");
  const rows = await readSheetRows(out, sheets[0].path);
  assert.equal(rows[14][0], "Time", "the header is still on row 15");
  // Row 16 is the earlier entry (the 23rd), row 17 the later.
  assert.equal(rows[15][30], "Nil sightings");
  assert.equal(rows[15][17], "", "a nil entry has no fauna");
  assert.equal(rows[16][17], "Whale");
  assert.equal(rows[16][18], "Humpback");
  assert.equal(rows[16][20], "3");
  assert.equal(rows[16][25], "500");
  assert.equal(rows[16][28], "Altered course to stbd");
  assert.equal(rows[16][16], "No", "500 m is outside the whale's monitoring zone");
  assert.equal(rows[16][1], "2026-09-24", "the date is a real Excel date");
  const sheetXml = await partText(partOf(out, sheets[0].path));
  assert.ok(/<c r="A17" s="54"><v>0\.3194/.test(sheetXml), "the time keeps the column's time style and is a fraction of the day");
});

/* --------------------------------------------------------- sending ---- */

test("the To box takes addresses however they are separated, and names what is not one", () => {
  assert.deepEqual(recipients("marine@minres.com.au; Ops@UnitedMarine.au, fauna@example.com"), {
    to: ["marine@minres.com.au", "ops@unitedmarine.au", "fauna@example.com"], bad: [],
  });
  assert.deepEqual(recipients("marine@minres.com.au marine@minres.com.au"), { to: ["marine@minres.com.au"], bad: [] }, "once each");
  assert.deepEqual(recipients("john, marine@minres.com.au"), { to: ["marine@minres.com.au"], bad: ["john"] });
  assert.deepEqual(recipients(""), { to: [], bad: [] });
});

test("a month with no tab gets one copied from the latest month, and rows keep their places", { skip: !existsSync(TEMPLATE) && "no template built yet (node tools/fauna-template.mjs)" }, async () => {
  const template = readFileSync(TEMPLATE);
  const log = await openLog(template.buffer.slice(template.byteOffset, template.byteOffset + template.byteLength));
  assert.deepEqual(monthTabs(log).map((t) => t.name), ["August"]);

  const sept = await ensureMonthTab(log, "2026-09");
  assert.equal(sept.made, true);
  assert.deepEqual(log.sheets.map((s) => s.name), ["August", "September", "Sheet1"], "straight after the tab it was copied from, before the hidden lists");
  const again = await ensureMonthTab(log, "2026-09");
  assert.equal(again.made, false, "the second time it is simply found");

  const wbXml = await partText(partOf(log.entries, "xl/workbook.xml"));
  assert.ok(/<definedName name="_xlnm\.Print_Area" localSheetId="1">September!\$A\$1:\$G\$29<\/definedName>/.test(wbXml), "the print area follows the new tab by position");
  assert.ok(/<definedName name="_xlnm\.Print_Area" localSheetId="0">August!/.test(wbXml), "August keeps its own");
  const types = await partText(partOf(log.entries, "[Content_Types].xml"));
  assert.ok(types.includes(`PartName="/${sept.path}"`), "the new sheet is declared");
  const tables = log.entries.filter((e) => /^xl\/tables\/table\d+\.xml$/.test(e.name));
  assert.equal(tables.length, 2, "the tab brought its own table");
  const names = await Promise.all(tables.map(async (t) => (/displayName="([^"]*)"/.exec(await partText(t)) || [])[1]));
  assert.equal(new Set(names).size, 2, "with a name of its own: " + names.join(", "));
  const septXml = await partText(partOf(log.entries, sept.path));
  assert.ok(!/tabSelected="1"/.test(septXml), "not the selected tab");
  const rows = await readSheetRows(log.entries, sept.path);
  assert.equal(rows[14][0], "Time", "the header came across");

  const a = settle({ ...blankRecord(), ...BASE, time: "07:40", date: "2026-09-24", faunaType: "Whale", species: "Humpback", total: 3, adults: 2, calves: 1, bearing: 45, distance: 500, behaviour: "Travelling" });
  const b = settle({ ...blankRecord(), ...BASE, time: "09:15", date: "2026-09-24", faunaType: "Dolphin", species: "Bottlenose", total: 6, bearing: 270, distance: 30, behaviour: "Socialising" });
  const first = await writeRows(log, sept.path, [{ id: "a", values: a, row: null }, { id: "b", values: b, row: null }]);
  assert.deepEqual(first.placed, { a: 16, b: 17 });

  // As the next save would do it: b changed, a removed, c new — b keeps its
  // row, a's row is blanked and c takes the first empty row, which is a's.
  const reopened = await openLog(await saveLog(log));
  const tab = await ensureMonthTab(reopened, "2026-09");
  assert.equal(tab.made, false);
  const c = settle({ ...blankRecord(), ...BASE, time: "16:05", date: "2026-09-25", kind: "nil" });
  const second = await writeRows(reopened, tab.path, [
    { id: "b", values: { ...b, distance: 45 }, row: first.placed.b },
    { id: "c", values: c, row: null },
  ], [first.placed.a]);
  assert.deepEqual(second.placed, { b: 17, c: 16 });
  const after = await readSheetRows(reopened.entries, tab.path);
  assert.equal(after[16][25], "45", "b rewritten in its own row");
  assert.equal(after[15][30], "Nil sightings", "c in the row a left");
  assert.equal(after[15][17], "", "with a's whale gone");
  // An entry whose remembered row now holds something else is placed afresh.
  const third = await writeRows(reopened, tab.path, [{ id: "d", values: { ...a, time: "18:00" }, row: 17 }]);
  assert.equal(third.placed.d, 18, "row 17 is b's, so d goes to the next empty row");
});
