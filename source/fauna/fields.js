// @ts-check
/**
 * The Marine Fauna Observation Log, as rules.
 *
 * One file that the phone app, the worker and the tests all run: what the
 * log's 31 columns are, which have dropdowns and what is on them, which a
 * sighting must have, what the phone can work out for itself, and how each
 * column is written to the sheet. The worker imports it; the page loads it
 * as a module.
 *
 * The columns and the dropdown lists are the office's own, read off the
 * "08.2026 - Marine Fauna Observation Log.xlsx" workbook (MinRes). Change
 * them here and only here.
 */

/**
 * @typedef {"time" | "date" | "list" | "number" | "text" | "yesno"} Kind
 * @typedef {{ key: string, col: string, label: string, kind: Kind,
 *   options?: string[], required: "always" | "sighting" | "never",
 *   unit?: string, group: "when" | "vessel" | "conditions" | "position" | "animal" | "response" }} Field
 * @typedef {Record<string, any>} FaunaRecord
 */

/* ------------------------------------------------------------------ lists */

export const FAUNA_TYPES = ["Whale", "Dolphin", "Dugong", "Turtle"];

/** Species the log offers under each fauna type, as the log spells them. */
export const SPECIES = {
  Whale: ["Humpback", "Minke", "Other"],
  Dolphin: ["Snubfin", "Bottlenose", "Other"],
  Dugong: ["Dugong"],
  Turtle: ["Green", "Hawksbill", "Other"],
};

/**
 * The office's own list has "Hawskbill". The app shows the right spelling and
 * writes the office's, so the workbook's dropdown still matches its own cells.
 */
export const SHEET_SPELLING = { Hawksbill: "Hawskbill" };

/**
 * The monitoring zones printed at the top of every month's sheet: the caution
 * zone is the outer one, so an animal inside it is "within the monitoring
 * zone". Distances in metres, the animal's distance from the vessel.
 */
export const ZONES = {
  Whale: { caution: 300, noApproach: 100 },
  Dolphin: { caution: 150, noApproach: 50 },
  Dugong: { caution: 300, noApproach: 100 },
  Turtle: { caution: 100, noApproach: 50 },
};

export const ACTIVITIES = ["Transiting", "Mooring", "Loading", "Discharging"];
export const WEATHER = ["Sunny", "Cloudy", "Overcast", "Rain"];
export const LIGHT = ["Full Light", "Low Light"];
export const CONDITIONS = ["Calm", "Distressed", "Injured", "Deceased"];
export const BEHAVIOURS = ["Travelling", "Foraging", "Resting", "Socialising", "Unknown"];
export const CERTAINTY = ["Certain", "Uncertain"];
export const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

const range = (/** @type {number} */ a, /** @type {number} */ b) =>
  Array.from({ length: b - a + 1 }, (_, i) => String(a + i));

/* ----------------------------------------------------------------- fields */

/** @type {Field[]} */
export const FIELDS = [
  { key: "time", col: "A", label: "Time", kind: "time", required: "always", group: "when" },
  { key: "date", col: "B", label: "Date", kind: "date", required: "always", group: "when" },
  { key: "activity", col: "C", label: "Vessel activity", kind: "list", options: ACTIVITIES, required: "always", group: "vessel" },
  { key: "heading", col: "D", label: "Vessel heading", kind: "number", unit: "°", required: "always", group: "vessel" },
  { key: "glare", col: "E", label: "Glare", kind: "list", options: range(0, 3), required: "always", group: "conditions" },
  { key: "visibility", col: "F", label: "Visibility", kind: "list", options: range(1, 4), required: "always", group: "conditions" },
  { key: "windSpeed", col: "G", label: "Wind speed", kind: "number", unit: "km/h", required: "always", group: "conditions" },
  { key: "windDir", col: "H", label: "Wind direction", kind: "text", required: "always", group: "conditions" },
  { key: "waveHeight", col: "I", label: "Wave height", kind: "number", unit: "m", required: "always", group: "conditions" },
  { key: "cloud", col: "J", label: "Cloud cover (oktas)", kind: "list", options: range(0, 9), required: "always", group: "conditions" },
  { key: "light", col: "K", label: "Light", kind: "list", options: LIGHT, required: "always", group: "conditions" },
  { key: "observer", col: "L", label: "Observer", kind: "text", required: "always", group: "when" },
  { key: "weather", col: "M", label: "Weather", kind: "list", options: WEATHER, required: "always", group: "conditions" },
  { key: "seaState", col: "N", label: "Sea state", kind: "list", options: range(1, 9), required: "always", group: "conditions" },
  { key: "lat", col: "O", label: "Latitude", kind: "text", required: "always", group: "position" },
  { key: "long", col: "P", label: "Longitude", kind: "text", required: "always", group: "position" },
  { key: "inZone", col: "Q", label: "Within monitoring zone", kind: "yesno", required: "sighting", group: "animal" },
  { key: "faunaType", col: "R", label: "Fauna type", kind: "list", options: FAUNA_TYPES, required: "sighting", group: "animal" },
  { key: "species", col: "S", label: "Species", kind: "list", required: "sighting", group: "animal" },
  { key: "certainty", col: "T", label: "Species certainty", kind: "list", options: CERTAINTY, required: "sighting", group: "animal" },
  { key: "total", col: "U", label: "Total number", kind: "number", required: "sighting", group: "animal" },
  { key: "adults", col: "V", label: "Adults", kind: "number", required: "sighting", group: "animal" },
  { key: "calves", col: "W", label: "Calves or juveniles", kind: "number", required: "sighting", group: "animal" },
  { key: "platformHeight", col: "X", label: "Observer platform height", kind: "number", unit: "m", required: "sighting", group: "vessel" },
  { key: "bearing", col: "Y", label: "Relative bearing", kind: "number", unit: "°", required: "sighting", group: "animal" },
  { key: "distance", col: "Z", label: "Distance from vessel", kind: "number", unit: "m", required: "sighting", group: "animal" },
  { key: "condition", col: "AA", label: "Animal condition", kind: "list", options: CONDITIONS, required: "sighting", group: "animal" },
  { key: "behaviour", col: "AB", label: "Behaviour", kind: "list", options: BEHAVIOURS, required: "sighting", group: "animal" },
  { key: "action", col: "AC", label: "Action taken", kind: "text", required: "sighting", group: "response" },
  { key: "stopWork", col: "AD", label: "Stop work", kind: "yesno", required: "sighting", group: "response" },
  { key: "comments", col: "AE", label: "Comments", kind: "text", required: "never", group: "response" },
];

/** @type {Record<string, Field>} */
export const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

/* ---------------------------------------------------------------- records */

export const NIL_COMMENT = "Nil sightings";

/** @returns {FaunaRecord} */
export function blankRecord() {
  /** @type {FaunaRecord} */
  const r = { kind: "sighting" };
  for (const f of FIELDS) r[f.key] = null;
  return r;
}

/** @param {unknown} v */
export const isBlank = (v) => v === null || v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v));

/**
 * The columns a record still has to be given, in the log's order. A nil
 * sighting (a watch with nothing seen) needs only the first block.
 * @param {FaunaRecord} r
 */
export function missingFields(r) {
  const nil = r.kind === "nil";
  return FIELDS.filter((f) => {
    if (f.required === "never") return false;
    if (f.required === "sighting" && nil) return false;
    return isBlank(r[f.key]);
  }).map((f) => f.key);
}

/* ------------------------------------------------------------ normalising */

const lc = (/** @type {unknown} */ v) => String(v == null ? "" : v).trim().toLowerCase();

/** Pick the option a typed value means, or null.
 * @param {string[]} options
 * @param {unknown} value
 */
export function pickOption(options, value) {
  const v = lc(value);
  if (!v) return null;
  for (const o of options) if (o.toLowerCase() === v) return o;
  for (const o of options) if (v.startsWith(o.toLowerCase()) || o.toLowerCase().startsWith(v)) return o;
  return null;
}

/** @param {unknown} v */
export function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = lc(v).replace(/,/g, "");
  const m = /-?\d+(\.\d+)?/.exec(s);
  return m ? Number(m[0]) : null;
}

/** Knots (or metres a second) to the log's km/h, whole numbers.
 * @param {number | null} value
 * @param {string | null | undefined} unit
 */
export function windKmh(value, unit) {
  if (value == null) return null;
  const u = lc(unit);
  if (u.startsWith("kn") || u.startsWith("kt")) return Math.round(value * 1.852);
  if (u === "m/s" || u.startsWith("metre") || u.startsWith("meter")) return Math.round(value * 3.6);
  return Math.round(value);
}

/**
 * What the vessel is doing, in the log's words where it has one. Bridge
 * language is kept as typed where the log's list has no word for it.
 * @param {unknown} v
 */
export function activityOf(v) {
  const s = lc(v);
  if (!s) return null;
  if (/transit|underway|under way|steaming|passage|sailing|en route|proceeding/.test(s)) return "Transiting";
  if (/moor|alongside|berthed|made fast|at the buoy|on the buoy/.test(s)) return "Mooring";
  if (/discharg|unload|disch\b/.test(s)) return "Discharging";
  if (/load/.test(s)) return "Loading";
  if (/anchor/.test(s)) return "Anchored";
  if (/berthing|coming alongside/.test(s)) return "Berthing";
  if (/drift/.test(s)) return "Drifting";
  if (/stationary|stopped|hove to/.test(s)) return "Stationary";
  return String(v).trim();
}

/** A compass point from what was typed: "sw", "south west", "sou'westerly", "variable".
 * @param {unknown} v
 */
export function compassOf(v) {
  // "sou'west", "nor'east": the sailor's clipped words, made whole first.
  const s = lc(v)
    .replace(/\bsou(?=['’\s]?(?:west|east|w\b|e\b))/g, "south").replace(/\bnor(?=['’\s]?(?:west|east|w\b|e\b))/g, "north")
    .replace(/['’]/g, "").replace(/-/g, " ")
    // "southwest", "northnortheast": one word to the eye, two or three here.
    .replace(/(north|south|east|west)(?=north|south|east|west)/g, "$1 ");
  if (!s) return null;
  if (/variable|var\b/.test(s)) return "Variable";
  if (/calm|nil wind|no wind/.test(s)) return "Calm";
  const up = s.toUpperCase().replace(/[^A-Z ]/g, "").trim();
  if (COMPASS.includes(up)) return up;
  const words = s.replace(/\b(from|the|erly|ly)\b/g, " ").replace(/erly\b/g, "").split(/\s+/).filter(Boolean);
  const letters = words.map((w) => (/^north/.test(w) ? "N" : /^south/.test(w) ? "S" : /^east/.test(w) ? "E" : /^west/.test(w) ? "W" : "")).join("");
  if (letters && COMPASS.includes(letters)) return letters;
  return String(v).trim();
}

/** The first initial and the surname, the way the log's observers write theirs.
 * @param {string | null | undefined} fullName
 */
export function observerName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0];
  return parts[0][0].toUpperCase() + ". " + parts[parts.length - 1];
}

/**
 * A position the way the log's observers write one: degrees and decimal
 * minutes, hemisphere last — 21°23.4'S 114°52.1'E.
 * @param {number} lat
 * @param {number} lon
 * @returns {[string, string]}
 */
export function latLongText(lat, lon) {
  const dm = (/** @type {number} */ v, /** @type {string} */ pos, /** @type {string} */ neg) => {
    const a = Math.abs(v);
    let d = Math.floor(a);
    let m = (a - d) * 60;
    if (m >= 59.95) { d += 1; m = 0; }
    return `${d}°${m.toFixed(1).padStart(4, "0")}'${v < 0 ? neg : pos}`;
  };
  return [dm(lat, "N", "S"), dm(lon, "E", "W")];
}

/**
 * A latitude or longitude however it was typed — "21 23.4 south",
 * "21 degrees 23.4 minutes S", "21°23.4'S", "-21.39" — written the log's way.
 * Anything that is not a position comes back as it was.
 * @param {"lat" | "long"} which
 * @param {unknown} v
 */
export function positionText(which, v) {
  const raw = String(v == null ? "" : v).trim();
  if (!raw) return raw;
  const s = raw.toLowerCase().replace(/degrees?|deg\b/g, "°").replace(/minutes?|min\b/g, "'").replace(/,/g, " ");
  const hemi = /\b(south|s)\b|s$/.test(s) && which === "lat" ? "S" : /\b(north|n)\b|n$/.test(s) && which === "lat" ? "N"
    : /\b(west|w)\b|w$/.test(s) && which === "long" ? "W" : /\b(east|e)\b|e$/.test(s) && which === "long" ? "E" : "";
  const nums = (s.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return raw;
  let dec;
  if (nums.length >= 2) dec = Math.abs(nums[0]) + nums[1] / 60 + (nums[2] || 0) / 3600;
  else dec = Math.abs(nums[0]);
  const negative = nums[0] < 0 || hemi === "S" || hemi === "W";
  if (!hemi && nums.length === 1 && Math.abs(nums[0]) > (which === "lat" ? 90 : 180)) return raw;
  const signed = negative ? -dec : dec;
  const [la, lo] = latLongText(which === "lat" ? signed : 0, which === "long" ? signed : 0);
  return which === "lat" ? la : lo;
}

/**
 * Whether the sun is up enough for "Full Light": its elevation above six
 * degrees, from the date, the local time and the position. Standard solar
 * position sums, good to a minute or two — plenty for a light-conditions
 * column that only knows two answers.
 * @param {string} date  YYYY-MM-DD, local
 * @param {string} time  HH:MM, local
 * @param {number} lat
 * @param {number} lon
 * @param {number} tzHours  the clock's offset from UTC, e.g. 8 for AWST
 */
export function sunUp(date, time, lat, lon, tzHours) {
  const [y, mo, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  if (![y, mo, d, hh, mm].every(Number.isFinite)) return null;
  const utcHours = hh + mm / 60 - tzHours;
  // Days since J2000.0 (2000-01-01 12:00 UTC).
  const days = (Date.UTC(y, mo - 1, d) - Date.UTC(2000, 0, 1, 12)) / 86400000 + utcHours / 24;
  const rad = Math.PI / 180;
  const g = (357.529 + 0.98560028 * days) % 360;            // mean anomaly
  const q = (280.459 + 0.98564736 * days) % 360;            // mean longitude
  const L = q + 1.915 * Math.sin(g * rad) + 0.02 * Math.sin(2 * g * rad); // apparent longitude
  const e = 23.439 - 0.00000036 * days;                     // obliquity
  const ra = Math.atan2(Math.cos(e * rad) * Math.sin(L * rad), Math.cos(L * rad)) / rad;
  const dec = Math.asin(Math.sin(e * rad) * Math.sin(L * rad));
  const gmst = (18.697374558 + 24.06570982441908 * days) % 24;
  const lst = ((gmst + lon / 15) % 24 + 24) % 24;
  let ha = (lst * 15 - ((ra % 360) + 360) % 360);
  ha = ((ha + 180) % 360 + 360) % 360 - 180;
  const el = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha * rad)) / rad;
  return el > 6;
}

/**
 * Within the monitoring zone, by the zone table at the top of the sheet:
 * inside the caution distance for that fauna.
 * @param {FaunaRecord} r
 */
export function inZoneByTable(r) {
  const z = ZONES[/** @type {keyof typeof ZONES} */ (r.faunaType)];
  const dist = toNumber(r.distance);
  if (!z || dist == null) return null;
  return dist <= z.caution ? "Yes" : "No";
}

/**
 * A record made whole: list values in the log's own words, numbers as
 * numbers, and the columns the phone or the sheet's own rules can settle
 * without asking — adults from the total, the zone from the distance, the
 * light from the sun. Nothing already filled in is changed except to tidy it.
 *
 * @param {FaunaRecord} r
 * @param {{ tzHours?: number, latDec?: number | null, lonDec?: number | null }} [ctx]
 * @returns {FaunaRecord}
 */
export function settle(r, ctx = {}) {
  /** @type {FaunaRecord} */
  const out = { ...blankRecord(), ...r };
  for (const f of FIELDS) {
    const v = out[f.key];
    if (isBlank(v)) { out[f.key] = null; continue; }
    if (f.kind === "list" && f.options) out[f.key] = pickOption(f.options, v) ?? (f.key === "activity" ? activityOf(v) : String(v).trim());
    else if (f.kind === "number") out[f.key] = toNumber(v);
    else if (f.kind === "yesno") out[f.key] = /^(y|yes|true|1)/.test(lc(v)) ? "Yes" : /^(n|no|false|0)/.test(lc(v)) ? "No" : null;
    else if (f.kind === "text") out[f.key] = String(v).trim();
  }
  if (out.activity) out.activity = activityOf(out.activity);
  if (out.windDir) out.windDir = compassOf(out.windDir);
  if (out.lat) out.lat = positionText("lat", out.lat);
  if (out.long) out.long = positionText("long", out.long);
  if (out.faunaType) {
    const list = SPECIES[/** @type {keyof typeof SPECIES} */ (out.faunaType)] || [];
    if (out.species) out.species = pickOption(list, out.species) ?? (list.includes("Other") ? "Other" : out.species);
    else if (out.faunaType === "Dugong") out.species = "Dugong";
  }
  if (out.heading != null) out.heading = ((Math.round(out.heading) % 360) + 360) % 360;
  if (out.bearing != null) out.bearing = ((Math.round(out.bearing) % 360) + 360) % 360;
  if (out.windSpeed != null) out.windSpeed = Math.round(out.windSpeed);
  if (out.distance != null) out.distance = Math.round(out.distance);
  for (const k of ["total", "adults", "calves"]) if (out[k] != null) out[k] = Math.max(0, Math.round(out[k]));

  const nil = out.kind === "nil";
  if (nil) {
    for (const f of FIELDS) if (f.required === "sighting") out[f.key] = null;
    if (!out.comments) out.comments = NIL_COMMENT;
    return out;
  }
  // The head count: whichever two of the three were given settle the third;
  // an animal with no calf mentioned is an adult.
  if (out.total != null && out.adults == null && out.calves == null) { out.adults = out.total; out.calves = 0; }
  else if (out.total != null && out.adults != null && out.calves == null) out.calves = Math.max(0, out.total - out.adults);
  else if (out.total != null && out.calves != null && out.adults == null) out.adults = Math.max(0, out.total - out.calves);
  else if (out.total == null && out.adults != null) out.total = out.adults + (out.calves || 0);
  if (out.total != null && out.adults != null && out.calves != null && out.adults + out.calves !== out.total) {
    out.total = out.adults + out.calves;
  }
  if (out.faunaType && out.inZone == null) out.inZone = inZoneByTable(out);
  if (out.faunaType && out.certainty == null && out.species && out.species !== "Other") out.certainty = "Certain";
  if (out.faunaType && out.species === "Other" && out.certainty == null) out.certainty = "Uncertain";
  if (out.faunaType && out.condition == null) out.condition = "Calm";
  if (out.faunaType && out.action == null) out.action = "None";
  if (out.faunaType && out.stopWork == null) out.stopWork = "No";
  if (out.light == null && out.date && out.time && ctx.latDec != null && ctx.lonDec != null) {
    const up = sunUp(out.date, out.time, ctx.latDec, ctx.lonDec, ctx.tzHours ?? 8);
    if (up != null) out.light = up ? "Full Light" : "Low Light";
  }
  return out;
}

/* --------------------------------------------------------- for the sheet */

/** Month tab names as the log has them. @param {string} yyyyMm */
export function monthName(yyyyMm) {
  const m = Number(String(yyyyMm).slice(5, 7));
  return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1] || "";
}

/**
 * The value a column is written to the sheet as: numbers as numbers, the time
 * and date as Excel's own serials so the column's format shows them, and the
 * office's spelling where it differs from ours.
 * @param {string} key
 * @param {unknown} value
 * @returns {{ kind: "blank" } | { kind: "number", value: number } | { kind: "inline", value: string }}
 */
export function sheetValue(key, value) {
  if (isBlank(value)) return { kind: "blank" };
  const f = FIELD[key];
  if (f.kind === "time") {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(value));
    if (!m) return { kind: "inline", value: String(value) };
    return { kind: "number", value: (Number(m[1]) * 60 + Number(m[2])) / 1440 };
  }
  if (f.kind === "date") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
    if (!m) return { kind: "inline", value: String(value) };
    const days = Math.round((Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - Date.UTC(1899, 11, 30)) / 86400000);
    return { kind: "number", value: days };
  }
  if (f.kind === "number") { const n = toNumber(value); return n == null ? { kind: "inline", value: String(value) } : { kind: "number", value: n }; }
  if (f.kind === "list" && f.options && /^\d+$/.test(String(value))) return { kind: "number", value: Number(value) };
  const s = String(value);
  return { kind: "inline", value: SHEET_SPELLING[/** @type {keyof typeof SHEET_SPELLING} */ (s)] || s };
}
