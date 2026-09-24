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
  brand: { logo: string; icon: string; roundelText: string[] };
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
  ["brand.logo", "string"], ["brand.icon", "string"], ["brand.roundelText", "string[]"],
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
const THEME_COLOURS = ["deep", "panel", "raised", "rule", "text", "muted", "accent", "accentSoft", "teal", "blue"];

/** Checks a vessel file's shape; throws naming the first key that is wrong. */
export function checkVessel(value: unknown, from = "source/vessel.json"): Vessel {
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const at = (path: string) =>
    path.split(".").reduce<unknown>((o, k) => (isObject(o) ? o[k] : undefined), value);
  for (const [path, kind] of SHAPE) {
    const v = at(path);
    const ok =
      kind === "string" ? typeof v === "string" && v.trim() !== "" :
      kind === "number" ? typeof v === "number" && Number.isFinite(v) :
      kind === "string[]" ? Array.isArray(v) && v.every((x) => typeof x === "string") :
      kind === "array" ? Array.isArray(v) :
      kind === "object" ? isObject(v) :
      isObject(v) && THEME_COLOURS.every((c) => typeof v[c] === "string" && v[c]);
    if (!ok) {
      const want =
        kind === "colours" ? "an object naming " + THEME_COLOURS.join(", ") :
        kind === "string[]" ? "a list of strings" : kind === "array" ? "a list" : kind === "object" ? "an object" : "a " + kind;
      throw new Error(`${from} has no usable "${path}" - it must be ${want}.`);
    }
  }
  return value as Vessel;
}

/** This vessel. */
export const vessel: Vessel = checkVessel(raw);

/** The vessel's own day and hour at `now`: the vessel decides the day, the
 *  tick is UTC. en-CA gives YYYY-MM-DD, which is the shape the portal stores. */
export function vesselNow(now: number | Date): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: vessel.timezone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  }).formatToParts(new Date(now));
  const part = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return { day: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) % 24 };
}

/** Today, as YYYY-MM-DD, where the vessel is - which is what an expiry is
 *  measured against and the day a file is filed under. */
export const todayThere = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: vessel.timezone }).format(new Date());
