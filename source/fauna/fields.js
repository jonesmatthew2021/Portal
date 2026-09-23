// @ts-check
/**
 * The Marine Fauna Observation Log, as rules.
 *
 * One file that the phone app, the worker and the tests all run: what the
 * log's 31 columns are, which of them a sighting must have, the question to
 * ask for each one that is still empty, what the phone can work out for
 * itself, and how a spoken sentence is turned into those columns when the
 * AI cannot be reached. The worker imports it; the page loads it as a module.
 *
 * The columns and the dropdown lists are the office's own, read off the
 * "08.2026 - Marine Fauna Observation Log.xlsx" workbook (MinRes). Change
 * them here and only here.
 */

/**
 * @typedef {"time" | "date" | "list" | "number" | "text" | "yesno"} Kind
 * @typedef {{ key: string, col: string, label: string, kind: Kind,
 *   options?: string[], required: "always" | "sighting" | "never",
 *   question: string, group: "when" | "vessel" | "conditions" | "position" | "animal" | "response",
 *   hint?: string }} Field
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
  Whale: { caution: 300, noApproach: 100, withCalf: { caution: 300, noApproach: 300 } },
  Dolphin: { caution: 150, noApproach: 50, withCalf: { caution: 150, noApproach: 150 } },
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
  { key: "time", col: "A", label: "Time", kind: "time", required: "always", group: "when",
    question: "What time was the sighting?" },
  { key: "date", col: "B", label: "Date", kind: "date", required: "always", group: "when",
    question: "What date?" },
  { key: "activity", col: "C", label: "Vessel activity", kind: "list", options: ACTIVITIES, required: "always", group: "vessel",
    question: "What is the vessel doing: transiting, mooring, loading or discharging?" },
  { key: "heading", col: "D", label: "Vessel heading", kind: "number", required: "always", group: "vessel",
    question: "What is the ship's heading?", hint: "degrees" },
  { key: "glare", col: "E", label: "Glare", kind: "list", options: range(0, 3), required: "always", group: "conditions",
    question: "Glare, nought to three?", hint: "0 none, 1 under a quarter of the view, 2 up to half, 3 more than half" },
  { key: "visibility", col: "F", label: "Visibility", kind: "list", options: range(1, 4), required: "always", group: "conditions",
    question: "Visibility, one to four?", hint: "1 sea floor clearly visible, 2 visible but unclear, 3 not visible and clear water, 4 not visible and opaque" },
  { key: "windSpeed", col: "G", label: "Wind speed", kind: "number", required: "always", group: "conditions",
    question: "Wind speed?", hint: "km/h in the log; knots are converted" },
  { key: "windDir", col: "H", label: "Wind direction", kind: "text", required: "always", group: "conditions",
    question: "Wind direction?" },
  { key: "waveHeight", col: "I", label: "Wave height", kind: "number", required: "always", group: "conditions",
    question: "Wave height in metres?", hint: "metres" },
  { key: "cloud", col: "J", label: "Cloud cover", kind: "list", options: range(0, 9), required: "always", group: "conditions",
    question: "Cloud cover in oktas, nought to eight?", hint: "oktas" },
  { key: "light", col: "K", label: "Light", kind: "list", options: LIGHT, required: "always", group: "conditions",
    question: "Full light or low light?" },
  { key: "observer", col: "L", label: "Observer", kind: "text", required: "always", group: "when",
    question: "Who is the observer?" },
  { key: "weather", col: "M", label: "Weather", kind: "list", options: WEATHER, required: "always", group: "conditions",
    question: "Weather: sunny, cloudy, overcast or rain?" },
  { key: "seaState", col: "N", label: "Sea state", kind: "list", options: range(1, 9), required: "always", group: "conditions",
    question: "Sea state, one to nine?", hint: "Beaufort" },
  { key: "lat", col: "O", label: "Latitude", kind: "text", required: "always", group: "position",
    question: "What is the latitude?" },
  { key: "long", col: "P", label: "Longitude", kind: "text", required: "always", group: "position",
    question: "And the longitude?" },
  { key: "inZone", col: "Q", label: "Within monitoring zone", kind: "yesno", required: "sighting", group: "animal",
    question: "Is the animal within the monitoring zone?" },
  { key: "faunaType", col: "R", label: "Fauna type", kind: "list", options: FAUNA_TYPES, required: "sighting", group: "animal",
    question: "What did you see: whale, dolphin, dugong or turtle?" },
  { key: "species", col: "S", label: "Species", kind: "list", required: "sighting", group: "animal",
    question: "Which species?" },
  { key: "certainty", col: "T", label: "Species certainty", kind: "list", options: CERTAINTY, required: "sighting", group: "animal",
    question: "Are you certain of the species?" },
  { key: "total", col: "U", label: "Total number", kind: "number", required: "sighting", group: "animal",
    question: "How many animals in total?" },
  { key: "adults", col: "V", label: "Adults", kind: "number", required: "sighting", group: "animal",
    question: "How many adults?" },
  { key: "calves", col: "W", label: "Calves or juveniles", kind: "number", required: "sighting", group: "animal",
    question: "How many calves or juveniles?" },
  { key: "platformHeight", col: "X", label: "Observer platform height", kind: "number", required: "sighting", group: "vessel",
    question: "How high above the sea is your observation platform, in metres?", hint: "metres" },
  { key: "bearing", col: "Y", label: "Relative bearing", kind: "number", required: "sighting", group: "animal",
    question: "What is the relative bearing to the animal?", hint: "degrees relative to the bow" },
  { key: "distance", col: "Z", label: "Distance from vessel", kind: "number", required: "sighting", group: "animal",
    question: "How far away, in metres?", hint: "metres" },
  { key: "condition", col: "AA", label: "Animal condition", kind: "list", options: CONDITIONS, required: "sighting", group: "animal",
    question: "Animal condition: calm, distressed, injured or deceased?" },
  { key: "behaviour", col: "AB", label: "Behaviour", kind: "list", options: BEHAVIOURS, required: "sighting", group: "animal",
    question: "Behaviour: travelling, foraging, resting, socialising or unknown?" },
  { key: "action", col: "AC", label: "Action taken", kind: "text", required: "sighting", group: "response",
    question: "What action was taken?" },
  { key: "stopWork", col: "AD", label: "Stop work", kind: "yesno", required: "sighting", group: "response",
    question: "Was work stopped?" },
  { key: "comments", col: "AE", label: "Comments", kind: "text", required: "never", group: "response",
    question: "Any comments?" },
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

/**
 * The next thing to ask, spoken plainly: the first empty column in the log's
 * order, one at a time. The watchkeeper talks through the whole entry in one
 * go; the questions only pick up what that left out.
 * @param {FaunaRecord} r
 * @returns {{ keys: string[], text: string } | null}
 */
export function nextQuestion(r) {
  const missing = missingFields(r);
  if (!missing.length) return null;
  const key = missing[0];
  const f = FIELD[key];
  if (key === "species" && r.faunaType) {
    const opts = (SPECIES[/** @type {keyof typeof SPECIES} */ (r.faunaType)] || []);
    return { keys: [key], text: "Which species? " + opts.slice(0, -1).join(", ") + (opts.length > 1 ? " or " : "") + opts[opts.length - 1] + "?" };
  }
  return { keys: [key], text: f.question };
}

/* ------------------------------------------------------------ normalising */

const lc = (/** @type {unknown} */ v) => String(v == null ? "" : v).trim().toLowerCase();

/** Pick the option a spoken or typed value means, or null.
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

/** Knots to the log's km/h, whole numbers.
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
 * language is kept as said where the log's list has no word for it.
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

/** A compass point from words: "south west", "sou'westerly", "from the north", "variable".
 * @param {unknown} v
 */
export function compassOf(v) {
  // "sou'west", "nor'east": the sailor's clipped words, made whole first.
  const s = lc(v)
    .replace(/\bsou(?=['’\s]?(?:west|east|w\b|e\b))/g, "south").replace(/\bnor(?=['’\s]?(?:west|east|w\b|e\b))/g, "north")
    .replace(/['’]/g, "").replace(/-/g, " ")
    // "southwest", "northnortheast": one word to the ear, two or three here.
    .replace(/(north|south|east|west)(?=north|south|east|west)/g, "$1 ");
  if (!s) return null;
  if (/variable|var\b/.test(s)) return "Variable";
  if (/calm|nil wind|no wind/.test(s)) return "Calm";
  const up = s.toUpperCase().replace(/[^A-Z ]/g, "").trim();
  if (COMPASS.includes(up)) return up;
  // Words: "north north east", "sou west", "westerly", "from the north".
  const words = s.replace(/\b(from|the|erly|ly)\b/g, " ").replace(/erly\b/g, "").replace(/\bsou\b/g, "south")
    .replace(/\bnor\b/g, "north").split(/\s+/).filter(Boolean);
  const letters = words.map((w) => (/^north/.test(w) ? "N" : /^south/.test(w) ? "S" : /^east/.test(w) ? "E" : /^west/.test(w) ? "W" : "")).join("");
  if (letters && COMPASS.includes(letters)) return letters;
  // "northwesterly" as one word.
  const one = s.replace(/erly\b|ly\b|ern\b/g, "").replace(/\s+/g, "");
  const packed = one.replace(/north/g, "N").replace(/south/g, "S").replace(/east/g, "E").replace(/west/g, "W");
  if (COMPASS.includes(packed)) return packed;
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
 * A latitude or longitude however it was said or typed — "21 23.4 south",
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
 * inside the caution distance for that fauna (calves widen nothing here — the
 * caution distance is the same, only the no-approach distance grows).
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
  // The head count: whichever two of the three were said settle the third;
  // an animal with no calf mentioned is an adult.
  if (out.total != null && out.adults == null && out.calves == null) { out.adults = out.total; out.calves = 0; }
  else if (out.total != null && out.adults != null && out.calves == null) out.calves = Math.max(0, out.total - out.adults);
  else if (out.total != null && out.calves != null && out.adults == null) out.adults = Math.max(0, out.total - out.calves);
  else if (out.total == null && out.adults != null) out.total = out.adults + (out.calves || 0);
  else if (out.total == null && out.calves != null && out.adults == null && out.calves > 0) { /* a calf alone: still needs the adults */ }
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

/* --------------------------------------------- reading a spoken sentence */

const SMALL = { zero: 0, nought: 0, nil: 0, none: 0, one: 1, a: 1, an: 1, single: 1, two: 2, couple: 2, pair: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000 };

/** Words to figures, so "two hundred and fifty" and "1.5" both count.
 * @param {string} s
 */
export function wordsToNumber(s) {
  const t = lc(s).replace(/-/g, " ");
  const m = /-?\d+(\.\d+)?/.exec(t);
  if (m && !/\b(hundred|thousand)\b/.test(t)) return Number(m[0]);
  let total = 0, cur = 0, seen = false;
  const words = t.split(/\s+/).filter(Boolean);
  // Figures said digit by digit, the way a heading or a bearing is: "three
  // four zero" is 340, not seven.
  const digits = words.map((w) => (/^\d$/.test(w) ? w : w === "oh" ? "0" : SMALL[/** @type {keyof typeof SMALL} */ (w)] != null && SMALL[/** @type {keyof typeof SMALL} */ (w)] <= 9 && w !== "a" && w !== "an" && w !== "couple" && w !== "pair" && w !== "single" ? String(SMALL[/** @type {keyof typeof SMALL} */ (w)]) : null));
  const firstDigit = digits.findIndex((d) => d != null);
  if (firstDigit >= 0) {
    let run = 0;
    while (digits[firstDigit + run] != null) run++;
    const after = words[firstDigit + run];
    if (run >= 2 && (after == null || SMALL[/** @type {keyof typeof SMALL} */ (after)] == null)) return Number(digits.slice(firstDigit, firstDigit + run).join(""));
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "and") continue;
    // "a dozen", "a hundred", "half a metre": the article is not a one of its own.
    if ((w === "a" || w === "an") && (seen || SMALL[/** @type {keyof typeof SMALL} */ (words[i + 1])] != null)) continue;
    if (w === "half") { cur += 0.5; seen = true; continue; }
    const num = /^-?\d+(\.\d+)?$/.test(w) ? Number(w) : SMALL[/** @type {keyof typeof SMALL} */ (w)];
    if (num == null) { if (seen) break; continue; }
    seen = true;
    if (num === 100 || num === 1000) { cur = (cur || 1) * num; if (num === 1000) { total += cur; cur = 0; } }
    else cur += num;
  }
  return seen ? total + cur : null;
}

const NUM = "(?:\\d+(?:\\.\\d+)?|(?:(?:zero|nought|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and|a|half)\\s*)+)";

/** Relative bearings from bridge talk.
 * @param {string} s
 */
export function bearingOf(s) {
  // What the vessel did and how the animal behaved also mention port and
  // starboard; neither is a bearing.
  const t = lc(s)
    .replace(/\b(?:altered|alter|changed|change)\s+(?:our\s+|the\s+)?(?:course|heading)\s+to\s+(?:starboard|stbd|port)\b/g, " ")
    .replace(/\b(?:turned|turn|came|come|swung|swing|went|going|hauled)\s+(?:round\s+|around\s+)?to\s+(?:starboard|stbd|port)\b/g, " ")
    .replace(/\bbow[ -]?(?:rid\w*|wave|waves)\b/g, " ");
  let m;
  if ((m = new RegExp(`(?:relative\\s+)?bearing\\s+(?:of\\s+)?(?:about\\s+|roughly\\s+|around\\s+)?(${NUM})`).exec(t))) {
    const n = wordsToNumber(m[1]); if (n != null) return n;
  }
  if ((m = /\b(green|red)\s+(\d{1,3})\b/.exec(t))) return m[1] === "green" ? Number(m[2]) % 360 : (360 - Number(m[2])) % 360;
  const side = /starboard|stbd/.test(t) ? "s" : /\bport\b/.test(t) ? "p" : "";
  if (/dead ahead|right ahead|straight ahead|\bahead\b|off the bow|on the bow(?!\s)/.test(t) && !side) return 0;
  if (/astern|dead astern|right astern|behind us/.test(t) && !side) return 180;
  if (side) {
    const fine = /\bfine\b/.test(t), broad = /\bbroad\b/.test(t);
    if (/\bbow\b/.test(t)) { const a = fine ? 20 : broad ? 60 : 45; return side === "s" ? a : 360 - a; }
    if (/\bbeam\b|abeam/.test(t)) return side === "s" ? 90 : 270;
    if (/quarter/.test(t)) { const a = fine ? 160 : broad ? 120 : 135; return side === "s" ? a : 360 - a; }
    if (/\bside\b/.test(t)) return side === "s" ? 90 : 270;
  }
  return null;
}

/** Distances in metres from "500 metres", "half a k", "two cables", "a mile".
 * @param {string} s
 */
export function distanceOf(s) {
  const t = lc(s);
  let m;
  if ((m = new RegExp(`(${NUM})\\s*(?:k\\b|km\\b|kilometres?|kilometers?|clicks?)`).exec(t))) {
    const n = wordsToNumber(m[1]); if (n != null) return Math.round(n * 1000);
  }
  if (/\bhalf a (?:k|km|kilometre|kilometer|click)\b/.test(t)) return 500;
  if (/\bquarter of a (?:k|km|kilometre|kilometer)\b/.test(t)) return 250;
  if ((m = new RegExp(`(${NUM})\\s*(?:nautical miles?|miles?|nm\\b)`).exec(t))) {
    const n = wordsToNumber(m[1]); if (n != null) return Math.round(n * 1852);
  }
  if (/\bhalf a (?:nautical )?mile\b/.test(t)) return 926;
  if ((m = new RegExp(`(${NUM})\\s*cables?`).exec(t))) {
    const n = wordsToNumber(m[1]); if (n != null) return Math.round(n * 185.2);
  }
  if ((m = new RegExp(`(${NUM})\\s*(?:m\\b|metres?|meters?)(?!\\s*(?:per|/|a)\\s*(?:sec|s\\b|hour|h\\b))`).exec(t))) {
    // Not the platform height, and not the wave height — said either side of
    // the figure: "half a metre swell", "swell of half a metre".
    const before = t.slice(Math.max(0, m.index - 30), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (!/height|high|wave|swell|seas?\b|platform|bridge/.test(before) && !/^\s*(?:waves?|swell|seas?\b|high|above|platform|eye)/.test(after)) {
      const n = wordsToNumber(m[1]); if (n != null) return Math.round(n);
    }
  }
  if ((m = new RegExp(`(?:distance|range|away|off)\\s*(?:of\\s+|about\\s+|roughly\\s+|around\\s+)?(${NUM})`).exec(t))) {
    const n = wordsToNumber(m[1]); if (n != null) return Math.round(n);
  }
  if ((m = new RegExp(`(${NUM})\\s*(?:metres?|meters?|m)?\\s*(?:away|off|out|distant)`).exec(t))) {
    const n = wordsToNumber(m[1]); if (n != null) return Math.round(n);
  }
  return null;
}

/**
 * The spoken sentence read into the log's columns, for when the AI can't be
 * reached: every column it can find is returned, nothing it can't is.
 * `focus` is the column a question was just asked for, so a bare answer
 * ("four", "yes", "south west") lands there.
 *
 * @param {string} text
 * @param {FaunaRecord} current
 * @param {{ focus?: string[] | null }} [opts]
 * @returns {FaunaRecord}
 */
export function parseSpoken(text, current, opts = {}) {
  /** @type {FaunaRecord} */
  const got = {};
  const t = " " + lc(text).replace(/[,.;!?]+/g, " ").replace(/\s+/g, " ") + " ";
  const focus = opts.focus || [];
  let m;

  /** @param {string} key @param {unknown} v */
  const put = (key, v) => { if (!isBlank(v)) got[key] = v; };

  // A bare answer to the question just asked.
  if (focus.length === 1) {
    const f = FIELD[focus[0]];
    const bare = t.trim();
    if (f.kind === "number") { const n = wordsToNumber(bare); if (n != null && bare.split(" ").length <= 4) put(f.key, n); }
    else if (f.kind === "list" && f.options && f.options.every((o) => /^\d+$/.test(o))) {
      // A scale answered in words: "three", "nought".
      const n = wordsToNumber(bare); if (n != null && f.options.includes(String(n))) put(f.key, String(n));
    }
    else if (f.kind === "list" && f.options) { const o = pickOption(f.options, bare) || f.options.find((o) => t.includes(" " + o.toLowerCase() + " ")); if (o) put(f.key, o); }
    else if (f.kind === "list" && f.key === "species" && current.faunaType) {
      const list = SPECIES[/** @type {keyof typeof SPECIES} */ (current.faunaType)] || [];
      const o = pickOption(list, bare) || list.find((o) => t.includes(" " + o.toLowerCase() + " ")); if (o) put("species", o);
    }
    else if (f.kind === "yesno") { if (/\b(yes|yeah|yep|correct|affirmative|it is|it was|we did)\b/.test(t)) put(f.key, "Yes"); else if (/\b(no|nope|negative|not|nil|wasn't|didn't)\b/.test(t)) put(f.key, "No"); }
    else if (f.key === "windDir") put(f.key, compassOf(bare));
    else if (f.key === "activity") put(f.key, activityOf(bare));
    else if (f.kind === "text") put(f.key, text.trim());
  }

  // Nil sightings.
  if (/\b(nil|no|zero|nothing) (?:sightings?|observations?|fauna|animals?|to report)\b|\bnothing (?:seen|sighted|observed)\b|\bno (?:animals? )?(?:seen|sighted|observed)\b/.test(t)) {
    got.kind = "nil";
  }

  // The animal.
  const fauna = /\b(humpback|minke|whale)/.test(t) ? "Whale"
    : /\b(dolphin|snubfin|snub fin|bottlenose|bottle nose)/.test(t) ? "Dolphin"
    : /\bdugong/.test(t) ? "Dugong"
    : /\b(turtle|hawksbill|hawskbill|green back)/.test(t) ? "Turtle" : null;
  if (fauna) {
    put("faunaType", fauna);
    got.kind = "sighting";
    if (fauna === "Whale") put("species", /humpback|hump back/.test(t) ? "Humpback" : /minke/.test(t) ? "Minke" : /unknown|unidentified|other|not sure what|couldn't tell/.test(t) ? "Other" : null);
    if (fauna === "Dolphin") put("species", /snub ?fin/.test(t) ? "Snubfin" : /bottle ?nose/.test(t) ? "Bottlenose" : /unknown|unidentified|other|not sure what|couldn't tell/.test(t) ? "Other" : null);
    if (fauna === "Turtle") put("species", /hawksbill|hawskbill/.test(t) ? "Hawksbill" : /\bgreen\b/.test(t) ? "Green" : /unknown|unidentified|other|not sure what|couldn't tell/.test(t) ? "Other" : null);
    if (fauna === "Dugong") put("species", "Dugong");
    if (/\b(not sure|unsure|uncertain|possibly|possible|maybe|i think|probably|looked like|might have been|could have been)\b/.test(t)) put("certainty", "Uncertain");
    else if (/\b(certain|definitely|sure|positive|confirmed)\b/.test(t)) put("certainty", "Certain");
  }

  // Head count: "two adults and a calf", "pod of six", "three humpbacks".
  const animalWord = "(?:whales?|humpbacks?|minkes?|dolphins?|snubfins?|bottlenose|dugongs?|turtles?|animals?|individuals?|of them)";
  if ((m = new RegExp(`(${NUM})\\s*adults?`).exec(t))) put("adults", wordsToNumber(m[1]));
  if ((m = new RegExp(`(${NUM})\\s*(?:calves|calf|juveniles?|juvies?|young|pups?)`).exec(t))) put("calves", wordsToNumber(m[1]));
  else if (/\b(?:with|and|plus) (?:a |one |its )?(?:calf|juvenile|young one|pup)\b|\b(?:cow|mother|mum) and calf\b/.test(t)) put("calves", 1);
  if ((m = new RegExp(`(?:pod|group|total|school) of\\s*(?:about |roughly |around |approximately |maybe )?(${NUM})`).exec(t))) put("total", wordsToNumber(m[1]));
  else if ((m = new RegExp(`(${NUM})\\s*(?:x\\s*)?${animalWord}`).exec(t)) && !/adults?|calves|calf|juvenile/.test(m[0])) put("total", wordsToNumber(m[1]));
  else if ((m = new RegExp(`(?:total|count|number)(?: of| was| is|:)?\\s*(${NUM})`).exec(t))) put("total", wordsToNumber(m[1]));
  if (got.total == null && got.adults == null && fauna && /\b(a|an|one|single|lone|solitary) (?:adult )?(?:humpback|minke|whale|dolphin|dugong|turtle|snubfin|bottlenose|hawksbill|green)/.test(t)) put("total", 1);
  if (/\b(cow|mother|mum) and calf\b/.test(t) && got.adults == null) put("adults", 1);
  if (/\bpair of\b|\btwo of them\b/.test(t) && got.total == null) put("total", 2);
  // "A whale with a calf": one adult, unless the animals were plural.
  if (got.calves != null && got.total == null && got.adults == null && fauna
    && !/\b(whales|humpbacks|minkes|dolphins|snubfins|dugongs|turtles|pod|group|school|several|some|many|few|couple|lots)\b/.test(t)) put("adults", 1);

  // Where and how far.
  const bearing = bearingOf(t); if (bearing != null) put("bearing", bearing);
  const dist = distanceOf(t); if (dist != null) put("distance", dist);

  // What it was doing and how it looked.
  if (/\btravel|transit|heading (?:north|south|east|west)|moving (?:north|south|east|west|away|off)|swimming (?:north|south|east|west|away|along|past)|passing|on passage/.test(t)) put("behaviour", "Travelling");
  else if (/\bforag|feeding|feed\b|hunting|chasing|fishing/.test(t)) put("behaviour", "Foraging");
  else if (/\bresting|logging|lying|stationary at the surface|basking|floating/.test(t)) put("behaviour", "Resting");
  else if (/\bsocial|playing|breaching|tail slap|bow riding|bow-riding|riding the bow|mating|interacting/.test(t)) put("behaviour", "Socialising");
  else if (/\bbehaviou?r (?:unknown|unclear|not known|not sure)|unknown behaviou?r/.test(t)) put("behaviour", "Unknown");
  if (/\bdistress|entangled|tangled|struggling|thrashing/.test(t)) put("condition", "Distressed");
  else if (/\binjur|wounded|bleeding|hurt\b/.test(t)) put("condition", "Injured");
  else if (/\bdeceased|dead\b|carcass|floating dead|no longer alive/.test(t)) put("condition", "Deceased");
  else if (/\bcalm\b|healthy|fine\b|looked (?:well|good|ok|okay)|relaxed|unbothered/.test(t)) put("condition", "Calm");

  // What we did about it.
  if (/\baltered (?:course|our course) to (?:starboard|stbd)|came to starboard|turned to starboard|turned (?:right|starboard)/.test(t)) put("action", "Altered course to stbd");
  else if (/\baltered (?:course|our course) to port|came to port|turned to port|turned (?:left|port)/.test(t)) put("action", "Altered course to port");
  else if (/\baltered course|changed course|changed heading|altered heading/.test(t)) put("action", "Altered course");
  else if (/\b(?:reduced|slowed|slowing|reduce) (?:speed|down|to)|slowed down|came off the throttle|reduced revs/.test(t)) put("action", "Reduced speed");
  else if (/\bstopped (?:the )?(?:vessel|ship|engines?|main engine)|all stop|came to a stop|hove to/.test(t)) put("action", "Stopped vessel");
  else if (/\bmonitored|kept watch|watched|observed only|continued to monitor|monitoring/.test(t)) put("action", "Monitored position");
  else if (/\bno action|nothing (?:done|required|needed)|took no action|carried on|continued (?:as|on|with)/.test(t)) put("action", "None");
  if (/\bno stop work|no stop-work|stop work no\b|work (?:continued|not stopped|wasn't stopped|was not stopped)|didn't stop work|did not stop work|no need to stop|without stopping/.test(t)) put("stopWork", "No");
  else if (/\bstop(?:ped)? work|work (?:was )?stopped|ceased (?:work|operations|loading|discharg)|suspended (?:work|operations|loading|discharg)|stopped (?:loading|discharging|operations)/.test(t)) put("stopWork", "Yes");
  if (/\b(?:within|inside|in) the (?:monitoring |caution |no approach )?zone\b/.test(t)) put("inZone", "Yes");
  else if (/\b(?:outside|beyond|out of|clear of) the (?:monitoring |caution |no approach )?zone\b/.test(t)) put("inZone", "No");

  // The vessel.
  if ((m = /\b(transiting|in transit|underway|under way|steaming|on passage|moored|mooring|at the mooring|on the mooring|alongside|berthed|discharging|unloading|loading|at anchor|anchored|berthing|drifting|stationary|hove to)\b/.exec(t))) put("activity", activityOf(m[1]));
  if ((m = new RegExp(`\\b(?:ship'?s |vessel'?s |our )?(?:heading|course|steering|hdg)\\s*(?:of |is |was |at |: )?(${NUM})`).exec(t))) { const n = wordsToNumber(m[1]); if (n != null && n <= 360) put("heading", n % 360); }
  if ((m = new RegExp(`\\b(?:platform|bridge|observation|observer|eye)\\s*(?:height|deck)?\\s*(?:of |is |was |about |at )?(${NUM})\\s*(?:m\\b|metres?|meters?)?`).exec(t))) put("platformHeight", wordsToNumber(m[1]));
  else if ((m = new RegExp(`(${NUM})\\s*(?:m\\b|metres?|meters?)\\s*(?:above (?:the )?(?:sea|water|waterline)|high|platform|eye height)`).exec(t))) put("platformHeight", wordsToNumber(m[1]));

  // The weather.
  if ((m = new RegExp(`\\bwind\\s*(?:speed\\s*)?(?:of |is |was |at |about |: )?(?:(${NUM})\\s*(knots?|kts?|kn|km/?h|kph|kilometres? (?:per|an) hour|m/s)?)`).exec(t)) && m[1]) {
    put("windSpeed", windKmh(wordsToNumber(m[1]), m[2] || ""));
  } else if ((m = new RegExp(`(${NUM})\\s*(knots?|kts?|kn)\\b`).exec(t))) {
    put("windSpeed", windKmh(wordsToNumber(m[1]), "knots"));
  } else if (/\bcalm\b|no wind|nil wind|flat calm/.test(t) && !fauna) { put("windSpeed", 0); }
  if ((m = /\bwind(?:s)?\s*(?:direction\s*)?(?:from (?:the )?|is |was |of |: )?(?:(?:about|roughly|around)\s+)?(north\s?north\s?east|north\s?north\s?west|south\s?south\s?east|south\s?south\s?west|east\s?north\s?east|east\s?south\s?east|west\s?north\s?west|west\s?south\s?west|north\s?east|north\s?west|south\s?east|south\s?west|north|south|east|west|nne|nnw|sse|ssw|ene|ese|wnw|wsw|ne|nw|se|sw|variable|calm|[nsew]\b)(?:erly|ern|ly)?\b/.exec(t))) put("windDir", compassOf(m[1]));
  else if ((m = /\b(north\s?north\s?east|north\s?north\s?west|south\s?south\s?east|south\s?south\s?west|east\s?north\s?east|east\s?south\s?east|west\s?north\s?west|west\s?south\s?west|north\s?east|north\s?west|south\s?east|south\s?west|nor'?\s?east|nor'?\s?west|sou'?\s?east|sou'?\s?west|northerly|southerly|easterly|westerly)(?:erly|ern|ly)?\s*(?:wind|breeze|at|of|\d)/.exec(t))) put("windDir", compassOf(m[1]));
  if ((m = new RegExp(`\\b(?:waves?|swell|seas)\\s*(?:height\\s*)?(?:of |is |was |about |at |: )?(?:(?:about|roughly|around)\\s+)?(${NUM})\\s*(?:m\\b|metres?|meters?)?`).exec(t))) put("waveHeight", wordsToNumber(m[1]));
  else if ((m = new RegExp(`(${NUM})\\s*(?:m\\b|metres?|meters?)\\s*(?:waves?|swell|seas)`).exec(t))) put("waveHeight", wordsToNumber(m[1]));
  else if (/\bhalf (?:a )?metre (?:waves?|swell|seas?)|(?:waves?|swell|seas?) (?:of )?half a metre/.test(t)) put("waveHeight", 0.5);
  else if (/\bflat calm|glassy|no swell|nil swell|flat seas?\b/.test(t)) put("waveHeight", 0);
  if ((m = new RegExp(`\\bcloud(?:s| cover)?\\s*(?:of |is |was |at |: )?(${NUM})\\s*(?:oktas?|eighths?)?`).exec(t))) put("cloud", String(Math.min(9, Math.max(0, wordsToNumber(m[1]) ?? 0))));
  else if ((m = new RegExp(`(${NUM})\\s*(?:oktas?|eighths?)`).exec(t))) put("cloud", String(Math.min(9, Math.max(0, wordsToNumber(m[1]) ?? 0))));
  else if (/\bclear sk(?:y|ies)|no cloud|cloudless/.test(t)) put("cloud", "0");
  else if (/\bfully overcast|total(?:ly)? overcast|complete cloud/.test(t)) put("cloud", "8");
  if ((m = new RegExp(`\\bglare\\s*(?:of |is |was |at |: )?(${NUM})`).exec(t))) put("glare", String(wordsToNumber(m[1])));
  else if (/\bno glare|nil glare|glare nil|glare none/.test(t)) put("glare", "0");
  if ((m = new RegExp(`\\b(?:visibility|vis|viz)\\s*(?:of |is |was |at |: )?(${NUM})`).exec(t))) put("visibility", String(wordsToNumber(m[1])));
  if ((m = new RegExp(`\\bsea state\\s*(?:of |is |was |at |: )?(${NUM})`).exec(t))) put("seaState", String(wordsToNumber(m[1])));
  else if ((m = new RegExp(`\\bbeaufort\\s*(?:force\\s*)?(${NUM})`).exec(t))) put("seaState", String(wordsToNumber(m[1])));
  if (/\bfull light\b|broad daylight|good light|full daylight/.test(t)) put("light", "Full Light");
  else if (/\blow light\b|poor light|dusk|dawn|twilight|night ?time|at night|dark\b|first light|last light/.test(t)) put("light", "Low Light");
  if (/\brain|raining|showers?|drizzle|squall/.test(t)) put("weather", "Rain");
  else if (/\bovercast\b/.test(t)) put("weather", "Overcast");
  else if (/\bcloudy|partly cloudy|some cloud|scattered cloud/.test(t)) put("weather", "Cloudy");
  else if (/\bsunny|fine and clear|clear skies|clear sky|blue sky/.test(t)) put("weather", "Sunny");

  // Anything said about the sighting itself that no column holds.
  if ((m = /\b(?:comment|comments|note|notes|remarks?)(?:\s*:|\s+that|\s+is|\s+are)?\s+(.+)$/.exec(text.trim())) && m[1]) put("comments", m[1].trim());

  // A number on its own answers the last question asked; several questions
  // at once (the conditions) take the figures in the order they were asked.
  if (focus.length > 1) {
    const rest = focus.filter((k) => got[k] == null);
    const nums = [...t.matchAll(/-?\d+(?:\.\d+)?/g)].map((x) => Number(x[0]));
    if (rest.length && nums.length === rest.length && !Object.keys(got).length) rest.forEach((k, i) => put(k, FIELD[k].kind === "list" ? String(nums[i]) : nums[i]));
  }
  return got;
}

/**
 * The parsed columns laid over the record, except where the person typed a
 * value themselves — a hand-set column is never talked over.
 * @param {FaunaRecord} record
 * @param {FaunaRecord} parsed
 * @param {string[]} [locked]
 */
export function mergeParsed(record, parsed, locked = []) {
  const out = { ...record };
  for (const [k, v] of Object.entries(parsed)) {
    // A hand-set column with something in it stands; an emptied one may fill.
    if (locked.includes(k) && !isBlank(record[k])) continue;
    if (isBlank(v) && k !== "kind") continue;
    out[k] = v;
  }
  return out;
}

/* --------------------------------------------------------- for the model */

/** The JSON shape the model is held to: every column, null where unsaid. */
export function modelSchema() {
  /** @type {Record<string, unknown>} */
  const props = {
    kind: { type: "string", enum: ["sighting", "nil"], description: "nil when the speaker reports no sightings for the watch" },
  };
  for (const f of FIELDS) {
    if (f.kind === "number") props[f.key] = { type: ["number", "null"], description: f.label + (f.hint ? " (" + f.hint + ")" : "") };
    else if (f.kind === "list" && f.options) props[f.key] = { type: ["string", "null"], enum: [...f.options, null], description: f.label };
    else if (f.kind === "list") props[f.key] = { type: ["string", "null"], description: f.label + " — one of the species for the fauna type, or Other" };
    else if (f.kind === "yesno") props[f.key] = { type: ["string", "null"], enum: ["Yes", "No", null], description: f.label };
    else props[f.key] = { type: ["string", "null"], description: f.label };
  }
  props.windSpeedUnit = { type: ["string", "null"], enum: ["knots", "km/h", "m/s", null], description: "the unit the wind speed was given in" };
  return {
    type: "object",
    properties: props,
    required: Object.keys(props),
    additionalProperties: false,
  };
}

/** The columns, described for the model in the same words the log uses. */
export function fieldSpecText() {
  const lines = FIELDS.map((f) => {
    let s = `- ${f.key}: ${f.label}`;
    if (f.options) s += ` — one of ${f.options.join(", ")}`;
    if (f.key === "species") s += ` — Whale: ${SPECIES.Whale.join(", ")}; Dolphin: ${SPECIES.Dolphin.join(", ")}; Turtle: ${SPECIES.Turtle.join(", ")}; Dugong: Dugong`;
    if (f.kind === "yesno") s += " — Yes or No";
    if (f.hint) s += ` (${f.hint})`;
    return s;
  });
  return lines.join("\n");
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
