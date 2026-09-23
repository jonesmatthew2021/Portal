/**
 * The fauna log's rules: what a spoken sentence becomes, what the phone can
 * settle on its own, what is still to be asked, and the month written into
 * the office's workbook.
 *
 *   npx tsx --test tests/fauna.test.ts      (or: node tools/check.mjs)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSpoken, settle, mergeParsed, missingFields, nextQuestion, blankRecord, latLongText, observerName, positionText,
  windKmh, compassOf, bearingOf, distanceOf, wordsToNumber, sunUp, sheetValue, modelSchema, monthName,
} from "../../source/fauna/fields.js";
import { exportMonth } from "../src/routes/fauna.js";
import { openLog, ensureMonthTab, writeRows, saveLog, monthTabs } from "../src/lib/fauna-log.js";
import { readZip, partOf, partText, listSheets, readSheetRows } from "../../source/shared/workbook.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, "..", "..", "source", "fauna", "template.xlsx");

/* ---------------------------------------------------------- the words ---- */

test("a whole sighting said in one breath lands in the right columns", () => {
  const said = "Humpback whale, two adults and a calf, about 500 metres on the starboard bow, travelling, calm, we altered course to starboard, no stop work";
  const got = settle(mergeParsed(blankRecord(), parseSpoken(said, blankRecord())));
  assert.equal(got.faunaType, "Whale");
  assert.equal(got.species, "Humpback");
  assert.equal(got.adults, 2);
  assert.equal(got.calves, 1);
  assert.equal(got.total, 3);
  assert.equal(got.distance, 500);
  assert.equal(got.bearing, 45);
  assert.equal(got.behaviour, "Travelling");
  assert.equal(got.condition, "Calm");
  assert.equal(got.action, "Altered course to stbd");
  assert.equal(got.stopWork, "No");
  assert.equal(got.certainty, "Certain");
  assert.equal(got.inZone, "No", "500 m is outside a whale's 300 m caution zone");
});

test("the conditions said the way a bridge says them", () => {
  const said = "Underway heading 270, wind south west 15 knots, half a metre swell, cloud 2, glare 1, vis 4, sea state 2, sunny, full light";
  const got = settle(mergeParsed(blankRecord(), parseSpoken(said, blankRecord())));
  assert.equal(got.activity, "Transiting");
  assert.equal(got.heading, 270);
  assert.equal(got.windDir, "SW");
  assert.equal(got.windSpeed, 28, "15 knots is 28 km/h");
  assert.equal(got.waveHeight, 0.5);
  assert.equal(got.cloud, "2");
  assert.equal(got.glare, "1");
  assert.equal(got.visibility, "4");
  assert.equal(got.seaState, "2");
  assert.equal(got.weather, "Sunny");
  assert.equal(got.light, "Full Light");
});

test("a pod of dolphins bow riding, and a turtle nobody is sure about", () => {
  const a = settle(mergeParsed(blankRecord(), parseSpoken("pod of six bottlenose dolphins bow riding, 20 metres off the port beam", blankRecord())));
  assert.equal(a.faunaType, "Dolphin");
  assert.equal(a.species, "Bottlenose");
  assert.equal(a.total, 6);
  assert.equal(a.adults, 6);
  assert.equal(a.calves, 0);
  assert.equal(a.behaviour, "Socialising");
  assert.equal(a.bearing, 270);
  assert.equal(a.distance, 20);
  assert.equal(a.inZone, "Yes");
  const b = settle(mergeParsed(blankRecord(), parseSpoken("possibly a green turtle, one, dead ahead about 80 metres, resting", blankRecord())));
  assert.equal(b.faunaType, "Turtle");
  assert.equal(b.species, "Green");
  assert.equal(b.certainty, "Uncertain");
  assert.equal(b.total, 1);
  assert.equal(b.bearing, 0);
  assert.equal(b.distance, 80);
  assert.equal(b.behaviour, "Resting");
});

test("nil sightings need only the conditions", () => {
  const got = settle(mergeParsed(blankRecord(), parseSpoken("nil sightings this watch", blankRecord())));
  assert.equal(got.kind, "nil");
  assert.equal(got.comments, "Nil sightings");
  const missing = missingFields(got);
  assert.ok(!missing.includes("faunaType"));
  assert.ok(missing.includes("windSpeed"));
});

test("a bare answer lands in the column that was asked for", () => {
  const r = { ...blankRecord(), faunaType: "Whale", species: "Humpback" };
  assert.equal(parseSpoken("about four hundred", r, { focus: ["distance"] }).distance, 400);
  assert.equal(parseSpoken("Minke", r, { focus: ["species"] }).species, "Minke");
  assert.equal(parseSpoken("yes it was", r, { focus: ["stopWork"] }).stopWork, "Yes");
  assert.equal(parseSpoken("overcast", r, { focus: ["weather"] }).weather, "Overcast");
  assert.equal(parseSpoken("south west", r, { focus: ["windDir"] }).windDir, "SW");
  assert.equal(parseSpoken("three", r, { focus: ["seaState"] }).seaState, "3");
});

test("the next question follows the log's order, one column at a time", () => {
  const empty = settle({ ...blankRecord(), time: "07:40", date: "2026-09-24", observer: "M. Jones", lat: "21°23.4'S", long: "114°52.1'E" });
  const q1 = nextQuestion(empty);
  assert.deepEqual(q1 && q1.keys, ["activity"], "the vessel first");
  assert.equal(parseSpoken("discharging", empty, { focus: q1!.keys }).activity, "Discharging");
  const withVessel = { ...empty, activity: "Transiting", heading: 270 };
  const q2 = nextQuestion(withVessel);
  assert.deepEqual(q2 && q2.keys, ["glare"], "then the first condition, on its own");
  assert.equal(parseSpoken("one", withVessel, { focus: q2!.keys }).glare, "1");
  const nearlyDone = settle({ ...withVessel, glare: "1", visibility: "4", windSpeed: 20, windDir: "SW", waveHeight: 0.5, cloud: "2", light: "Full Light", weather: "Sunny", seaState: "2",
    faunaType: "Whale", species: "Humpback", total: 2, distance: 500, bearing: 45, behaviour: "Travelling", platformHeight: 6 });
  assert.equal(nextQuestion(nearlyDone), null, "everything else the rules settle themselves");
});

test("a hand-typed column is never talked over", () => {
  const r = { ...blankRecord(), distance: 250 };
  const merged = mergeParsed(r, parseSpoken("humpback about 800 metres", r), ["distance"]);
  assert.equal(merged.distance, 250);
  assert.equal(merged.faunaType, "Whale");
});

test("what the vessel did is not read as where the animal was", () => {
  const got = parseSpoken("one humpback 300 metres, we altered course to starboard and reduced speed", blankRecord());
  assert.equal(got.bearing, undefined, "no bearing was said");
  assert.equal(got.action, "Altered course to stbd");
  assert.equal(got.distance, 300);
  assert.equal(parseSpoken("dolphins bow riding on the port side", blankRecord()).bearing, 270);
});

/* ------------------------------------------------------- the helpers ---- */

test("figures, bearings, distances and the compass", () => {
  assert.equal(wordsToNumber("two hundred and fifty"), 250);
  assert.equal(wordsToNumber("1.5"), 1.5);
  assert.equal(wordsToNumber("a dozen"), 12);
  assert.equal(bearingOf("green 40"), 40);
  assert.equal(bearingOf("red 20"), 340);
  assert.equal(bearingOf("fine on the port bow"), 340);
  assert.equal(bearingOf("on the starboard quarter"), 135);
  assert.equal(bearingOf("bearing three four zero"), 340);
  assert.equal(distanceOf("half a k off"), 500);
  assert.equal(distanceOf("two cables"), 370);
  assert.equal(distanceOf("about a mile"), 1852);
  assert.equal(distanceOf("1.5 k away"), 1500);
  assert.equal(distanceOf("full light, one adult, half a metre swell"), null, "a wave height is not a distance");
  assert.equal(distanceOf("swell of one metre, whale 300 metres off"), 300);
  assert.equal(parseSpoken("half a metre swell", { ...blankRecord(), distance: 500 }).distance, undefined);
  assert.equal(compassOf("north north east"), "NNE");
  assert.equal(compassOf("westerly"), "W");
  assert.equal(compassOf("sou'west"), "SW");
  assert.equal(compassOf("variable"), "Variable");
  assert.equal(windKmh(10, "knots"), 19);
  assert.equal(windKmh(28, "km/h"), 28);
});

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
});

test("what a column is written to the sheet as", () => {
  assert.deepEqual(sheetValue("time", "07:40"), { kind: "number", value: (7 * 60 + 40) / 1440 });
  assert.deepEqual(sheetValue("date", "2026-08-11"), { kind: "number", value: 46245 });
  assert.deepEqual(sheetValue("species", "Hawksbill"), { kind: "inline", value: "Hawskbill" });
  assert.deepEqual(sheetValue("cloud", "2"), { kind: "number", value: 2 });
  assert.deepEqual(sheetValue("comments", null), { kind: "blank" });
  const schema = modelSchema() as { required: string[]; properties: Record<string, unknown> };
  assert.ok(schema.required.includes("faunaType") && schema.properties.windSpeedUnit);
  assert.equal(monthName("2026-09"), "September");
});

/* ------------------------------------------------------ the workbook ---- */

test("the month goes into the office's own log, tab renamed and rows filled", { skip: !existsSync(TEMPLATE) && "no template built yet (node tools/fauna-template.mjs)" }, async () => {
  const template = readFileSync(TEMPLATE);
  const entries = [
    settle({ ...blankRecord(), time: "07:40", date: "2026-09-24", activity: "Transiting", heading: 270, glare: "1", visibility: "4", windSpeed: 28, windDir: "SW",
      waveHeight: 0.5, cloud: "2", light: "Full Light", observer: "M. Jones", weather: "Sunny", seaState: "2", lat: "21°23.4'S", long: "114°52.1'E",
      faunaType: "Whale", species: "Humpback", total: 3, adults: 2, calves: 1, platformHeight: 6, bearing: 45, distance: 500, behaviour: "Travelling",
      action: "Altered course to stbd", comments: "Cow and calf" }),
    settle({ ...blankRecord(), kind: "nil", time: "06:00", date: "2026-09-23", activity: "Mooring", heading: 120, glare: "0", visibility: "4", windSpeed: 10, windDir: "NE",
      waveHeight: 0, cloud: "7", light: "Low Light", observer: "M. Jones", weather: "Cloudy", seaState: "1", lat: "21°32.0'S", long: "114°59.0'E" }),
  ];
  const blob = await exportMonth(template.buffer.slice(template.byteOffset, template.byteOffset + template.byteLength), "2026-09", entries);
  const out = readZip(await blob.arrayBuffer());
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

  const base = { activity: "Transiting", heading: 270, glare: "1", visibility: "4", windSpeed: 28, windDir: "SW", waveHeight: 0.5, cloud: "2",
    light: "Full Light", observer: "M. Jones", weather: "Sunny", seaState: "2", lat: "21°23.4'S", long: "114°52.1'E", platformHeight: 6 };
  const a = settle({ ...blankRecord(), ...base, time: "07:40", date: "2026-09-24", faunaType: "Whale", species: "Humpback", total: 3, adults: 2, calves: 1, bearing: 45, distance: 500, behaviour: "Travelling" });
  const b = settle({ ...blankRecord(), ...base, time: "09:15", date: "2026-09-24", faunaType: "Dolphin", species: "Bottlenose", total: 6, bearing: 270, distance: 30, behaviour: "Socialising" });
  const first = await writeRows(log, sept.path, [{ id: "a", values: a, row: null }, { id: "b", values: b, row: null }]);
  assert.deepEqual(first.placed, { a: 16, b: 17 });

  // As the next save would do it: b changed, a removed, c new — b keeps its
  // row, a's row is blanked and c takes the first empty row, which is a's.
  const reopened = await openLog(await saveLog(log));
  const tab = await ensureMonthTab(reopened, "2026-09");
  assert.equal(tab.made, false);
  const c = settle({ ...blankRecord(), ...base, time: "16:05", date: "2026-09-25", kind: "nil" });
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
