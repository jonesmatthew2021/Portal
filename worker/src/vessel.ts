/**
 * The vessel file, as the worker reads it.
 *
 * source/vessel.json is everything that is this vessel's and not the
 * portal's: the name, the operator, the brand, the time zone, the domain,
 * the ranks, the swings, the customer's marks, the crew folders. The page
 * gets the same file as VESSEL from the build (tools/source.mjs); this is
 * the one place the worker reads it, so the row id, the backup's mark, the
 * sign-in email's From and the hour's day all agree with the page.
 *
 * The shape is checked once, as the module loads, against the same list
 * the build checks - a key missing or of the wrong kind stops the worker
 * with a message naming the key, and stops the build the same way. Change
 * one list, change the other.
 */
import raw from "../../source/vessel.json";

export type VesselColours = {
  deep: string; panel: string; raised: string; rule: string; text: string;
  muted: string; accent: string; accentSoft: string; teal: string; blue: string;
};

export type Vessel = {
  slug: string;
  operator: string;
  name: string;
  nameAccent: string;
  shortName: string;
  title: string;
  strapline: string;
  brand: { logo: string; icon: string; icon512: string; appleTouch: string; roundelText: string[] };
  theme: {
    themeColor: string;
    bodyBackground: string;
    signIn: { ink: string; button: string };
    light: VesselColours;
    dark: VesselColours;
    fonts: { display: string; body: string; mono: string };
  };
  timezone: string;
  domain: string;
  mailFrom: string;
  emailDomainGuess: string;
  it: { name: string };
  contacts: { opms: string; correspondencePoster: string };
  links: { opms: string };
  portways: { partnership: string; vessel: string };
  previewAccounts: { name: string; password?: string }[];
  parties: string[];
  swings: {
    ids: string[];
    labels: Record<string, string>;
    pattern: { anchor: string; cycle: number };
    legacyNotes: { id: string; label: string }[];
  };
  ranks: { id: string; label: string; dept: string }[];
  depts: string[];
  deptOrder: string[];
  deptRenames: Record<string, string>;
  rankGroups: [string, string][];
  rosterRanks: string[];
  rankToPortways: Record<string, string>;
  shift: {
    vesselCode: string;
    pools: { pool: string; is: string }[];
    establishment: { key: string; label: string; pool: string; shifts: string[] }[];
    groups: { id: string; title: string; hours: string | null }[];
    sheetWords: Record<string, string>;
  };
  customerMarks: { elearning: string; auIssuers: string[]; nameStopWords: string[] };
  elearningCodes: string[];
  noExpiryCodes: string[];
  elearningGroups: string[];
  certStated: Record<string, string>;
  /** Which column a printed endorsement fills, and the clause it comes from
   *  (source/shared/covers.js reads this table; the model only lists what
   *  the certificate prints). `perpetual` is an endorsement that never
   *  expires, whose column takes the certificate's own date. */
  covers: { code: string; when: string; perpetual?: boolean; why?: string }[];
  certPageNotes: string[];
  tickets: Record<string, { grade: number; stream: string; short: string }>;
  docBuckets: string[];
  labels: Record<string, string>;
  qualColumns: string[][];
  crewFolders: Record<string, string>;
};

type Kind = "string" | "number" | "string[]" | "array" | "object" | "colours";

// The same list as VESSEL_SHAPE in tools/source.mjs.
const SHAPE: [string, Kind][] = [
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
  ["certStated", "object"], ["covers", "array"], ["certPageNotes", "string[]"], ["tickets", "object"],
  ["docBuckets", "string[]"], ["labels", "object"], ["qualColumns", "array"], ["crewFolders", "object"],
];
const THEME_COLOURS = ["deep", "panel", "raised", "rule", "text", "muted", "accent", "accentSoft", "teal", "blue"];
/* What each entry of the lists must carry - the same list as ENTRY_SHAPE in
 * tools/source.mjs. A list can be a list and still be wrong inside: a rank
 * group without its pattern would compile to a pattern that matches every
 * position, and a pool without its "is" would do the same on the shift matrix. */
const ENTRY_SHAPE: [string, string[]][] = [
  ["previewAccounts", ["name"]],
  ["swings.legacyNotes", ["id", "label"]],
  ["ranks", ["id", "label", "dept"]],
  ["shift.pools", ["pool", "is"]],
  ["shift.establishment", ["key", "label", "pool"]],
  ["shift.groups", ["id", "title"]],
];
const compiles = (pattern: string) => { try { new RegExp(pattern); return true; } catch { return false; } };

/** Checks a vessel file's shape; throws naming the first key that is wrong. */
export function checkVessel(value: unknown, from = "source/vessel.json"): Vessel {
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const word = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  const at = (path: string) =>
    path.split(".").reduce<unknown>((o, k) => (isObject(o) ? o[k] : undefined), value);
  const wrong = (path: string, want: string) => new Error(`${from} has no usable "${path}" - it must be ${want}.`);
  for (const [path, kind] of SHAPE) {
    const v = at(path);
    const ok =
      kind === "string" ? word(v) :
      kind === "number" ? typeof v === "number" && Number.isFinite(v) :
      kind === "string[]" ? Array.isArray(v) && v.every((x) => typeof x === "string") :
      kind === "array" ? Array.isArray(v) :
      kind === "object" ? isObject(v) :
      isObject(v) && THEME_COLOURS.every((c) => word(v[c]));
    if (!ok) {
      throw wrong(path,
        kind === "colours" ? "an object naming " + THEME_COLOURS.join(", ") :
        kind === "string[]" ? "a list of strings" : kind === "array" ? "a list" : kind === "object" ? "an object" : "a " + kind);
    }
  }
  for (const [path, fields] of ENTRY_SHAPE) {
    (at(path) as unknown[]).forEach((entry, i) => {
      for (const f of fields) if (!isObject(entry) || !word(entry[f])) throw wrong(`${path}[${i}].${f}`, "a string");
    });
  }
  const v = value as Vessel;
  v.shift.pools.forEach((p, i) => { if (!compiles(p.is)) throw wrong(`shift.pools[${i}].is`, "a pattern that compiles"); });
  v.shift.establishment.forEach((e, i) => {
    if (!Array.isArray(e.shifts) || !e.shifts.every((s) => typeof s === "string")) throw wrong(`shift.establishment[${i}].shifts`, "a list of strings");
  });
  v.shift.groups.forEach((g, i) => { if (g.hours !== null && !word(g.hours)) throw wrong(`shift.groups[${i}].hours`, "a string or null"); });
  /* The ids the code keys on - the same check as tools/source.mjs. The page
   * hands each shift group its rule by id (day, night, swing), reads the
   * sheet's words by day and night, and names the swings by A and B, so a
   * file that spells any of these its own way is refused here, with the key. */
  const GROUP_IDS = ["day", "night", "swing"];
  v.shift.groups.forEach((g, i) => { if (!GROUP_IDS.includes(g.id)) throw wrong(`shift.groups[${i}].id`, "one of " + GROUP_IDS.join(", ")); });
  for (const id of GROUP_IDS) {
    if (v.shift.groups.filter((g) => g.id === id).length !== 1) throw wrong("shift.groups", "a list with one group for each of " + GROUP_IDS.join(", "));
  }
  for (const id of ["day", "night"]) if (!word(v.shift.sheetWords[id])) throw wrong(`shift.sheetWords.${id}`, "a string");
  for (const letter of ["A", "B"]) if (!word(v.swings.labels[letter])) throw wrong(`swings.labels.${letter}`, "a string");
  // The page pairs the ids with the labels by order, so a file with one id or
  // three would call a crew by the wrong name. Only the count can be held
  // here: which id is A and which is B is the file's to get right.
  if (v.swings.ids.length !== 2) throw wrong("swings.ids", "two ids, the first for swing A and the second for swing B");
  const poolNames = v.shift.pools.map((p) => p.pool);
  v.shift.establishment.forEach((e, i) => {
    if (!poolNames.includes(e.pool)) throw wrong(`shift.establishment[${i}].pool`, "one of the pools in shift.pools");
    e.shifts.forEach((s, j) => { if (s !== "day" && s !== "night") throw wrong(`shift.establishment[${i}].shifts[${j}]`, "day or night"); });
  });
  v.rankGroups.forEach((g, i) => {
    if (!Array.isArray(g) || g.length !== 2 || !word(g[0]) || !word(g[1])) throw wrong(`rankGroups[${i}]`, "a heading and a pattern, both strings");
    if (!compiles(g[1])) throw wrong(`rankGroups[${i}][1]`, "a pattern that compiles");
  });
  v.qualColumns.forEach((c, i) => {
    if (!Array.isArray(c) || c.length !== 3 || !word(c[0]) || !word(c[1]) || typeof c[2] !== "string") throw wrong(`qualColumns[${i}]`, "a code, a title and a group, all strings");
  });
  /* The covers table - the same check as tools/source.mjs. A pattern that
   * does not compile would cover nothing and say nothing about it, and a
   * code that is not a column would fill a cell the matrix has not got. */
  const columnCodes = new Set(v.qualColumns.map((c) => String(c[0]).trim().toUpperCase()));
  v.covers.forEach((c, i) => {
    if (!isObject(c) || !word(c.code) || !word(c.when)) throw wrong(`covers[${i}]`, "a code and a pattern, both strings");
    if (!compiles(c.when)) throw wrong(`covers[${i}].when`, "a pattern that compiles");
    if (!columnCodes.has(String(c.code).trim().toUpperCase())) throw wrong(`covers[${i}].code`, "one of the codes in qualColumns");
    if (c.perpetual !== undefined && typeof c.perpetual !== "boolean") throw wrong(`covers[${i}].perpetual`, "true or false");
    if (c.why !== undefined && !word(c.why)) throw wrong(`covers[${i}].why`, "the clause it comes from, as a string");
  });
  return v;
}

/** This vessel. */
export const vessel: Vessel = checkVessel(raw);

/** The vessel's own day, hour and weekday at `now`: the vessel decides the
 *  day, the tick is UTC. en-CA gives YYYY-MM-DD, which is the shape the
 *  portal stores. The weekday (0 Sunday to 6 Saturday) is worked out from
 *  that day rather than asked of the formatter, so it can never be UTC's
 *  weekday while the day is the vessel's - it is what the weekly reminder
 *  emails are due on. */
export function vesselNow(now: number | Date): { day: string; hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: vessel.timezone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  }).formatToParts(new Date(now));
  const part = (type: string) => parts.find((p) => p.type === type)?.value || "";
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  return { day, hour: Number(part("hour")) % 24, weekday: new Date(day + "T00:00:00Z").getUTCDay() };
}

/** Today, as YYYY-MM-DD, where the vessel is - which is what an expiry is
 *  measured against and the day a file is filed under. */
export const todayThere = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: vessel.timezone }).format(new Date());
