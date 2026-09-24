/**
 * The rules the portal leans on hardest, held to the answers they must give.
 *
 * Every case here is one that has actually gone wrong on the live portal at
 * some point, or one whose going wrong would put a wrong date against a
 * crew member's name. If a change makes one of these answer differently, it
 * is either a bug or a decision - and either way somebody should say so out
 * loud rather than find out months later.
 *
 *   npx tsx --test tests/rules.test.ts      (or: node tools/check.mjs)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { equivalentCode, codeFor, ModelRefusal, plainLine, errorLine, OUT_OF_CREDIT, READING_UNAVAILABLE, KEY_PROBLEM } from "../src/lib/analysis.js";
import { AI_BUSY, checkerRefusalLine } from "../src/lib/checker.js";
import { crewFolderIn, looseIn, whoseFolder } from "../src/routes/sync.js";
import { asKey } from "../src/db/cert-home.js";
import { canonicalPersonName } from "../src/db/person-name.js";
import { setEnv } from "../src/env.js";
import { vessel, checkVessel, vesselNow } from "../src/vessel.js";
import { crewRowsOnly, crewRegister, nameLetters, registerWords } from "../../source/shared/names.js";
import { RED_DAYS, daysUntil } from "../../source/shared/bands.js";
import * as reminders from "../../source/shared/reminders.js";

/** The office's equivalence sheet, as the portal stores it. */
const SHEET = [
  { held: "Master <500GT", code: "QL-03" },
  { held: "Master <3000GT", code: "QL-03" },
  { held: "Chief Mate, Master <500GT, Master <3000GT (Near Coastal)", code: "QL-02" },
  { held: "Navigational Watch Rating", code: "QL-12" },
  { held: "Engine Room Watch Rating", code: "QL-12" },
  { held: "Chief Integrated Rating, Able Seafarer - Deck, Able Seafarer - Engine", code: "QL-10" },
  { held: "Watchkeeper Deck", code: "QL-04" },
];

const reading = (over: Record<string, unknown> = {}) => ({
  version: "r1", at: "", model: "", readable: true,
  holderName: "", certificateTitle: "", issuer: "", issuedOn: null,
  expiresOn: null, neverExpires: false, qualCode: null,
  codeConfidence: "high", notes: null, ...over,
}) as never;

test("a ticket naming its capacity on its face is placed by the sheet", () => {
  assert.equal(equivalentCode("Master <500GT", SHEET), "QL-03");
});

test("the sheet's spacing is not the certificate's spacing", () => {
  // The sheet writes "500GT"; the certificate prints "500 GT". Same ticket.
  assert.equal(equivalentCode("Master <500 GT", SHEET), "QL-03");
});

test("the longest name on the sheet wins", () => {
  // Both "Master <500GT" and the compound Chief Mate entry are present in this
  // title; the fuller one is the more senior ticket and must win.
  assert.equal(
    equivalentCode("Chief Mate, Master <500GT, Master <3000GT (Near Coastal)", SHEET),
    "QL-02",
  );
});

test("a ticket the sheet says nothing about is left alone", () => {
  assert.equal(equivalentCode("Provide First Aid HLTAID011", SHEET), null);
});

test("Jack Cook's Master: the capacity is in the small print, not the title", () => {
  // The certificate's face says only "Certificate of Competency"; the capacity
  // sits elsewhere on the page and the reader keeps it in its notes. Read from
  // the title alone this went to the model's QL-01 guess and sat in the wrong
  // column on the live matrix.
  const r = reading({
    certificateTitle: "Certificate of Competency",
    notes: "Capacity listed as Master <500 GT",
    qualCode: "QL-01",
    codeConfidence: "medium",
  });
  assert.equal(codeFor({}, r, SHEET), "QL-03");
});

test("a watch rating is a safety training ticket, not an integrated rating", () => {
  const r = reading({
    certificateTitle: "Certificate of Proficiency - Navigational Watch Rating",
    qualCode: "QL-10",
    codeConfidence: "medium",
  });
  assert.equal(codeFor({}, r, SHEET), "QL-12");
});

test("what a person tagged by hand beats both the sheet and the model", () => {
  const r = reading({ certificateTitle: "Master <500GT", qualCode: "QL-01" });
  assert.equal(codeFor({ qualCode: "QL-09" }, r, SHEET), "QL-09");
});

test("the model's guess stands where the sheet has nothing to say", () => {
  const r = reading({ certificateTitle: "Provide First Aid", qualCode: "QL-18" });
  assert.equal(codeFor({}, r, SHEET), "QL-18");
});

test("a guess the model is unsure of is not used at all", () => {
  const r = reading({
    certificateTitle: "Something unreadable",
    qualCode: "QL-18",
    codeConfidence: "low",
  });
  assert.equal(codeFor({}, r, SHEET), null);
});

test("an empty sheet places nothing", () => {
  assert.equal(equivalentCode("Master <500GT", []), null);
});

/* ------------------------------------------------------------------------ *
 * Where the certificates are — the two things Crew Details sets.
 *
 * The certificate location says which folder in the library the crew's own
 * folders sit in. A man's own folder is set against him by hand, for the
 * folder whose name does not say whose it is. Both had one answer hard-wired
 * into the portal before they could be set, and every case below is one where
 * getting it wrong files a man's certificates against somebody else.
 * ------------------------------------------------------------------------ */

test("a file one folder down from the certificate location is that folder's", () => {
  assert.equal(crewFolderIn("opms")("opms/EVANS, Brenton/AMSA Medical.pdf"), "EVANS, Brenton");
});

test("a file loose in the certificate location belongs to no crew folder", () => {
  assert.equal(crewFolderIn("opms")("opms/Qualification Expiry.xlsx"), null);
  assert.equal(looseIn("opms")("opms/Qualification Expiry.xlsx"), true);
});

test("a file buried deeper than one folder is not taken on", () => {
  assert.equal(crewFolderIn("opms")("opms/EVANS, Brenton/2026/Medical.pdf"), null);
});

test("the certificate location moves, and the crew folders move with it", () => {
  const at = crewFolderIn("Crew Certificates");
  assert.equal(at("Crew Certificates/EVANS, Brenton/Medical.pdf"), "EVANS, Brenton");
  // And nothing at the old address answers any more.
  assert.equal(at("opms/EVANS, Brenton/Medical.pdf"), null);
});

test("a location the office named with spaces, commas and brackets still answers", () => {
  // Read as plain text, never as a pattern: "(" and "." in a folder name would
  // mean something else entirely to an expression, and the wrong folders would
  // match.
  const at = crewFolderIn("Ships/TSV Coolibah (ATB)/Crew, certificates");
  assert.equal(at("Ships/TSV Coolibah (ATB)/Crew, certificates/Kyle/Medical.pdf"), "Kyle");
  assert.equal(at("Ships/TSV CoolibahXATB0/Crew, certificates/Kyle/Medical.pdf"), null);
});

/** Crew Details with one man pointed at one folder, and nobody else.
 *  `inUse` is where other men's certificates already are, which is what
 *  answers for everybody nobody has been asked about. */
const saidFor = (
  key: string,
  token: string,
  person: string,
  inUse: Record<string, string> = {},
) => ({
  home: "opms",
  assigned: [{ key, token, person }],
  manIn: (k: string) => (k.toLowerCase() === key.toLowerCase() ? { key, token, person } : null),
  prefixFor: (t: string) => (t === token ? key : inUse[t] || null),
});

test("a folder named for a man beats the name worked out from the folder", () => {
  // "Kyle" says nothing about who Kyle is. Somebody said, once, on Crew Details.
  const where = saidFor("opms/Kyle", "sittiyos-kachin", "SITTIYOS, Kachin");
  assert.deepEqual(whoseFolder(where as never, "opms/Kyle", "Kyle"), {
    token: "sittiyos-kachin", person: "SITTIYOS, Kachin",
  });
});

test("a folder nobody was asked about is still read for a name", () => {
  const where = saidFor("opms/Kyle", "sittiyos-kachin", "SITTIYOS, Kachin");
  assert.deepEqual(whoseFolder(where as never, "opms/EVANS, Brenton", "EVANS, Brenton"), {
    token: "evans-brenton", person: "EVANS, Brenton",
  });
});

test("his certificates are written into the folder he was given", () => {
  const where = saidFor("opms/Kyle", "sittiyos-kachin", "SITTIYOS, Kachin");
  assert.equal(where.prefixFor("sittiyos-kachin"), "opms/Kyle");
});

test("a man nobody was asked about is filed where the rest of his already are", () => {
  // Most of the crew have never been pointed at a folder by hand and do not
  // need to be: the sync found their folder and their papers have gone into
  // it ever since.
  const where = saidFor("opms/Kyle", "sittiyos-kachin", "SITTIYOS, Kachin",
    { "evans-brenton": "opms/Brenton - OPMS" });
  assert.equal(where.prefixFor("evans-brenton"), "opms/Brenton - OPMS");
});

test("no folder is invented for a man the portal cannot place", () => {
  /* This is the whole of it. The fallback used to be his name under the
     certificate location, so filing a certificate for somebody the library had
     no folder for quietly made one - and the library filled with near-empty
     folders for men who already had a folder under a name the office uses.
     Nothing is written now; the caller is told to go and say where it goes. */
  const where = saidFor("opms/Kyle", "sittiyos-kachin", "SITTIYOS, Kachin");
  assert.equal(where.prefixFor("rose-matthew"), null);
});

/* Crew Details picks folders out of the library, so it saves a real library
   path. The rest of the portal speaks its own keys. Getting this translation
   wrong sends the sync looking in a folder that does not exist, and it finds
   nothing at all — which reads on the screen as the library being empty.
   Set inside each test, not once for the file: the sync's tests run in
   this process too and leave the env as they last set it. */
const libraryMap = () => setEnv({
  SHAREPOINT_ROOT: "United Operations Team/Crew Portal",
  SHAREPOINT_MAP: JSON.stringify({
    "certification/spreadsheet/": "United Operations Team/Crew Portal/Crew Certificates Spreadsheet/",
    "certification/": "United Operations Team/Crew Certificate Verifications/",
    "matrices/": "United Operations Team/Crew Portal/Matrix/",
    "opms/": "United Operations Team/OPMS Documents/",
    "roster/": "United Operations Team/Crew Portal/Crew Roster/",
    "notes/": "United Operations Team/Handover Notes/",
  }),
} as never);

test("the OPMS folder picked in the library is the portal's own opms", () => {
  libraryMap();
  assert.equal(asKey("United Operations Team/OPMS Documents"), "opms");
});

test("a man's folder inside it keeps its place", () => {
  libraryMap();
  assert.equal(asKey("United Operations Team/OPMS Documents/Kyle"), "opms/Kyle");
});

test("a folder the map says nothing about still has a key of its own", () => {
  libraryMap();
  // Not left as it was: a bare real path would be read as a key and re-rooted
  // inside the portal's own folder, where there is nothing — so the sync would
  // walk an empty folder and report that the library held no certificates.
  assert.equal(asKey("United Operations Team/Somewhere Else"), "library/United Operations Team/Somewhere Else");
});

test("a folder inside the portal's own is a plain key, as it always was", () => {
  libraryMap();
  assert.equal(asKey("United Operations Team/Crew Portal/Matrix"), "matrices");
});

test("nothing picked is nothing set, and the portal keeps its own default", () => {
  libraryMap();
  assert.equal(asKey(""), "");
});

/* ------------------------------------------------------------------------ *
 * What a refusal from the model is about, sorted once - the message read
 * before the status. "Your credit balance is too low" came back as a 400,
 * the same status as a corrupted file, and 791 certificates were written
 * down as unreadable over a billing message. Nothing about the account is
 * ever a fact about a scan.
 * ------------------------------------------------------------------------ */
const api = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });

test("a credit-balance refusal is about credit whatever status it wears", () => {
  const low = api("invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");
  const e = new ModelRefusal(400, low);
  assert.equal(e.kind, "credit");
  assert.equal(plainLine(e), OUT_OF_CREDIT);
  assert.equal(new ModelRefusal(402, api("billing_error", "Payment required.")).kind, "credit");
  assert.equal(new ModelRefusal(429, api("rate_limit_error", "You have reached your monthly spend limit.")).kind, "credit", "a spend limit is credit, not the rate");
});

test("the rate, a busy model and a refused key each have their sentence", () => {
  const rate = new ModelRefusal(429, api("rate_limit_error", "This request would exceed the rate limit of 50 requests per minute."));
  assert.equal(rate.kind, "rate");
  assert.equal(plainLine(rate), READING_UNAVAILABLE);
  assert.equal(new ModelRefusal(529, api("overloaded_error", "Overloaded")).kind, "busy");
  assert.equal(new ModelRefusal(500, api("api_error", "An unexpected error has occurred internal to Anthropic's systems.")).kind, "busy");
  assert.equal(plainLine(new ModelRefusal(529, api("overloaded_error", "Overloaded"))), READING_UNAVAILABLE);
  assert.equal(new ModelRefusal(401, api("authentication_error", "invalid x-api-key")).kind, "key");
  assert.equal(new ModelRefusal(403, api("permission_error", "Your API key does not have permission to use the specified resource.")).kind, "key");
  assert.equal(plainLine(new ModelRefusal(401, api("authentication_error", "invalid x-api-key"))), KEY_PROBLEM);
});

test("a document the model turned away is about the document, said plainly", () => {
  const e = new ModelRefusal(400, api("invalid_request_error", "messages.0.content.0.pdf.source.base64.data: The PDF specified was not valid."));
  assert.equal(e.kind, "document");
  assert.equal(plainLine(e), "The PDF specified was not valid.", "the field prefix is taken off");
});

test("a job that fell over says the account's sentence for a refusal and its own words for anything else", () => {
  const low = api("invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");
  assert.equal(errorLine(new ModelRefusal(400, low)), OUT_OF_CREDIT);
  assert.equal(errorLine(new ModelRefusal(529, api("overloaded_error", "Overloaded"))), READING_UNAVAILABLE);
  assert.equal(errorLine(new ModelRefusal(401, api("authentication_error", "invalid x-api-key"))), KEY_PROBLEM);
  assert.equal(errorLine(new Error("the sheet has no Equivalence tab")), "the sheet has no Equivalence tab");
  assert.equal(errorLine("plain words"), "plain words");
});

test("an answer the portal cannot read is other, and other is never stored", () => {
  const e = new ModelRefusal(400, "<html><body>Bad Request</body></html>");
  assert.equal(e.kind, "other");
  assert.equal(plainLine(e), e.message);
  assert.equal(new ModelRefusal(400, api("not_found_error", "model: no such model")).kind, "other");
});

test("a 400 about the portal's own request, or the account, is never about the document", () => {
  // The day the API stops taking a parameter the portal sends, the answer
  // is a 400 invalid_request_error naming that field - and stored as the
  // document's fault it would be written against every certificate in
  // the batch, needing a paid re-read to undo.
  const other = (message: string) => assert.equal(new ModelRefusal(400, api("invalid_request_error", message)).kind, "other", message);
  other("thinking.type: adaptive is not supported");
  other("model: claude-x is not a valid model");
  other("output_config.effort: unknown value");
  other("max_tokens: must be at least 1");
  other("Your organization has been disabled.");
  // While the document's own troubles are, field or no field.
  const doc = (message: string) => assert.equal(new ModelRefusal(400, api("invalid_request_error", message)).kind, "document", message);
  doc("messages.0.content.0.pdf.source.base64.data: The PDF specified was not valid.");
  doc("messages.0.content.0.image.source.base64: image exceeds 5 MB maximum");
  doc("prompt is too long: 250000 tokens > 200000 maximum");
  doc("Could not process image");
});

test("the account's other words for no credit are credit too", () => {
  for (const message of ["You have exceeded your usage limit.", "Insufficient funds on this account.", "Your organization's quota has been reached.", "Payment required."]) {
    assert.equal(new ModelRefusal(400, api("invalid_request_error", message)).kind, "credit", message);
  }
});

test("the AI Checker says what is true on its screen: nothing asks its question again by itself", () => {
  assert.equal(checkerRefusalLine(new ModelRefusal(529, api("overloaded_error", "Overloaded"))), AI_BUSY);
  assert.equal(checkerRefusalLine(new ModelRefusal(429, api("rate_limit_error", "This request would exceed the rate limit of 50 requests per minute."))), AI_BUSY);
  assert.equal(checkerRefusalLine(new ModelRefusal(400, api("invalid_request_error", "Your credit balance is too low to access the Anthropic API."))), OUT_OF_CREDIT);
  assert.equal(checkerRefusalLine(new ModelRefusal(401, api("authentication_error", "invalid x-api-key"))), KEY_PROBLEM);
  assert.equal(checkerRefusalLine(new ModelRefusal(400, api("invalid_request_error", "messages.0.content.1.document: the file is too large"))), "The AI turned the question away (400). the file is too large");
  assert.ok(AI_BUSY.length <= 60);
});

test("every shared sentence fits the badge whole", () => {
  // The badge under Update portal shows the first 60 characters of an error.
  for (const line of [OUT_OF_CREDIT, READING_UNAVAILABLE, KEY_PROBLEM]) assert.ok(line.length <= 60, line);
});

/* ------------------------------------------------------------------------ *
 * The vessel file: the words a filename carries around a name that are the
 * operator's, the customer's or a swing's are read from it, so a name filed
 * as "SMITH, Alan - <operator> <swing>" still comes back as the man alone,
 * whatever vessel the portal is built for. The file's own shape is proved
 * here too, in the same words the build uses.
 * ------------------------------------------------------------------------ */
test("the vessel file's stop words are not part of anybody's name", () => {
  const words = vessel.customerMarks.nameStopWords;
  assert.ok(words.length > 0, "the vessel file names its stop words");
  for (const w of words) {
    assert.equal(canonicalPersonName(`SMITH, Alan ${w}`), "SMITH, Alan", `"${w}" is dropped from a name`);
    assert.equal(canonicalPersonName(`SMITH, Alan ${w.toUpperCase()}`), "SMITH, Alan", `"${w}" is dropped whatever its case`);
  }
  assert.equal(canonicalPersonName("SMITH, Alan James"), "SMITH, Alan James", "a real given name is kept");
});

test("the vessel file has every key the portal reads, and a missing one is named", () => {
  assert.equal(checkVessel(vessel), vessel);
  const { timezone: _dropped, ...without } = vessel;
  assert.throws(() => checkVessel(without, "a vessel file"), /a vessel file has no usable "timezone"/);
  assert.throws(() => checkVessel({ ...vessel, theme: { ...vessel.theme, light: { deep: "#fff" } } }), /"theme.light"/);
  assert.throws(() => checkVessel({ ...vessel, brand: { ...vessel.brand, icon512: "" } }, "a vessel file"), /"brand.icon512"/,
    "the home-screen icons are the vessel's and each is named");
});

test("the vessel file's lists are checked inside, so a rank group or a pool that would match everything is refused", () => {
  /* A rank group without its pattern would compile to a pattern that matches
     every position and file the whole crew under one heading; a pool without
     its "is" would do the same on the shift matrix. Each is named, with its
     place in the list. */
  const rankGroups = vessel.rankGroups.map((g) => [...g]);
  rankGroups[1] = [rankGroups[1][0]] as unknown as [string, string];
  assert.throws(() => checkVessel({ ...vessel, rankGroups }, "a vessel file"), /a vessel file has no usable "rankGroups\[1\]"/);
  const broken = vessel.rankGroups.map((g) => [...g] as [string, string]);
  broken[2] = [broken[2][0], "chief (officer"];
  assert.throws(() => checkVessel({ ...vessel, rankGroups: broken }, "a vessel file"), /"rankGroups\[2\]\[1\]" - it must be a pattern that compiles/);
  const pools = vessel.shift.pools.map((p) => ({ ...p }));
  delete (pools[0] as { is?: string }).is;
  assert.throws(() => checkVessel({ ...vessel, shift: { ...vessel.shift, pools } }, "a vessel file"), /"shift.pools\[0\].is"/);
  const ranks = vessel.ranks.map((r) => ({ ...r }));
  ranks[3] = { ...ranks[3], dept: "" };
  assert.throws(() => checkVessel({ ...vessel, ranks }, "a vessel file"), /"ranks\[3\].dept"/);
  const qualColumns = vessel.qualColumns.map((c) => [...c]);
  qualColumns[0] = ["QL-01"];
  assert.throws(() => checkVessel({ ...vessel, qualColumns }, "a vessel file"), /"qualColumns\[0\]"/);
  assert.equal(checkVessel(vessel), vessel, "the file as it is passes every one of these");
});

test("an item the vessel file says never lapses reads as held, whatever date is in its column", () => {
  /* The hour and the page both load the matrix through crewRowsOnly with the
     file's noExpiryCodes; a caller that dropped the list would let an
     e-learning sat in 2020 read as long lapsed, so the list is required. */
  const quals = { cols: [["VS-04", "Helm CONNECT", "Vessel Specific"], ["QL-01", "Medical", "Qualification"]],
    rows: [["SMITH, Alan", "Master", "1", ["2020-01-01", "2020-01-01"]]] };
  assert.ok(vessel.noExpiryCodes.includes("VS-04"), "VS-04 is on this vessel's list");
  assert.deepEqual(crewRowsOnly(quals as never, [], vessel.noExpiryCodes)!.rows[0][3], ["Y", "2020-01-01"]);
  assert.deepEqual(crewRowsOnly(quals as never, [], [])!.rows[0][3], ["2020-01-01", "2020-01-01"], "without the list the date stays a date");
  assert.throws(() => (crewRowsOnly as unknown as (q: unknown, p: unknown) => unknown)(quals, []),
    /crewRowsOnly needs the vessel file's list of items that never lapse \(noExpiryCodes\)\./);
});

test("the ids the page keys on are the file's to carry and not to rename", () => {
  /* A shift group called "dayshift" would reach the page with no rule to
     take its requirements by, and the Swing Compliance page would throw; a
     position in a pool the file does not name would never be filled. */
  const groups = vessel.shift.groups.map((g) => ({ ...g }));
  groups[0].id = "dayshift";
  assert.throws(() => checkVessel({ ...vessel, shift: { ...vessel.shift, groups } }, "a vessel file"),
    /a vessel file has no usable "shift.groups\[0\].id" - it must be one of day, night, swing\./);
  assert.throws(() => checkVessel({ ...vessel, shift: { ...vessel.shift, groups: vessel.shift.groups.slice(1) } }, "a vessel file"),
    /"shift.groups" - it must be a list with one group for each of day, night, swing\./);
  assert.throws(() => checkVessel({ ...vessel, shift: { ...vessel.shift, sheetWords: { day: "Shift 1" } } }, "a vessel file"),
    /"shift.sheetWords.night" - it must be a string\./);
  assert.throws(() => checkVessel({ ...vessel, swings: { ...vessel.swings, labels: { A: "Swing Alpha" } } }, "a vessel file"),
    /"swings.labels.B" - it must be a string\./);
  assert.throws(() => checkVessel({ ...vessel, swings: { ...vessel.swings, ids: ["ALPHA"] } }, "a vessel file"),
    /"swings.ids" - it must be two ids, the first for swing A and the second for swing B\./);
  const establishment = vessel.shift.establishment.map((e) => ({ ...e }));
  establishment[2] = { ...establishment[2], pool: "purser" };
  assert.throws(() => checkVessel({ ...vessel, shift: { ...vessel.shift, establishment } }, "a vessel file"),
    /"shift.establishment\[2\].pool" - it must be one of the pools in shift.pools\./);
  establishment[2] = { ...vessel.shift.establishment[2], shifts: ["day", "evening"] };
  assert.throws(() => checkVessel({ ...vessel, shift: { ...vessel.shift, establishment } }, "a vessel file"),
    /"shift.establishment\[2\].shifts\[1\]" - it must be day or night\./);
  assert.equal(checkVessel(vessel), vessel, "the file as it is carries every id the page keys on");
});

/* ------------------------------------------------------------------------ *
 * The weekly certificate-expiry reminders, as rules (source/shared/
 * reminders.js): what is on a list, who is sent which, and when it is due.
 * Sending somebody else's certificates to an inbox, or the same email
 * twice, is what these hold against.
 * ------------------------------------------------------------------------ */
const REMINDER_RULES = { crewRowsOnly, crewRegister, nameLetters, registerWords, daysUntil };
const REMINDER_TODAY = "2026-09-28";
/** A date `n` days from REMINDER_TODAY. */
const inDays = (n: number) => new Date(Date.parse(REMINDER_TODAY) + n * 86400000).toISOString().slice(0, 10);
const REMINDER_QUALS = {
  cols: [["QL-01", "Master", "Qualification"], ["QL-17", "AMSA Medical", "Medical"], ["VS-04", "Induction e-learning", "E-Learning"], ["QL-20", "Sea Survival", "Safety"]],
  rows: [
    ["SITTIYOS, Kachin", "Cook", "", [inDays(90), inDays(0), inDays(5), "OPEN"]],
    ["EVANS, Brenton", "Master", "", [inDays(91), inDays(-3), "", "Y"]],
    ["SAMPLE, Sam", "Deckhand", "", ["N", "", "", inDays(400)]],
    ["Number Required", "", "", [inDays(1), inDays(1), "", ""]],
  ],
};
const REMINDER_PEOPLE = [{ name: "SITTIYOS, Kachin", aliases: ["bILLY"] }, { name: "EVANS, Brenton", aliases: [] }, { name: "SAMPLE, Sam", aliases: [] }];
const expiring = (quals: unknown, people = REMINDER_PEOPLE, days = 90) =>
  reminders.expiringWithin(quals as never, people, days, REMINDER_TODAY, vessel.noExpiryCodes, REMINDER_RULES);

test("the red band and the reminder window are the same 90 days", () => {
  assert.equal(RED_DAYS, 90);
  assert.equal(reminders.REMINDER_DEFAULTS.days, RED_DAYS);
  assert.deepEqual(reminders.REMINDER_DEFAULTS, { on: false, days: 90, weekday: 1, hour: 7 }, "off, 90 days, Monday, 07:00");
});

test("the setting reads the document with the defaults where a key will not do, and only a real true is on", () => {
  assert.deepEqual(reminders.reminderSetting(undefined), reminders.REMINDER_DEFAULTS);
  assert.deepEqual(reminders.reminderSetting({ on: true, days: 30, weekday: 3, hour: 6 }), { on: true, days: 30, weekday: 3, hour: 6 });
  assert.deepEqual(reminders.reminderSetting({ on: "true", days: "60", weekday: 9, hour: -1 }), { on: false, days: 60, weekday: 1, hour: 7 });
  assert.deepEqual(reminders.reminderSetting({ on: 1, days: 0, weekday: 1.5, hour: "" }), { on: false, days: 90, weekday: 1, hour: 7 });
});

test("what is expiring: crew rows only, dates only, never the items that never lapse, soonest first", () => {
  assert.deepEqual(expiring(REMINDER_QUALS), [
    { person: "EVANS, Brenton", code: "QL-17", title: "AMSA Medical", date: inDays(-3), daysLeft: -3, from: ["EVANS, Brenton"] },
    { person: "SITTIYOS, Kachin", code: "QL-17", title: "AMSA Medical", date: inDays(0), daysLeft: 0, from: ["SITTIYOS, Kachin"] },
    { person: "SITTIYOS, Kachin", code: "QL-01", title: "Master", date: inDays(90), daysLeft: 90, from: ["SITTIYOS, Kachin"] },
  ], "0 and 90 days in, 91 out, expired in; VS-04, OPEN, Y, N and blanks skipped; the requirement row is nobody");
  assert.equal(vessel.noExpiryCodes.includes("VS-04"), true, "VS-04 never lapses (the vessel file)");
  assert.equal(expiring(REMINDER_QUALS, REMINDER_PEOPLE, 91).length, 4, "a 91-day window takes the 91st day");
  assert.deepEqual(expiring(null), [], "no matrix, nothing");
  assert.throws(() => reminders.expiringWithin(REMINDER_QUALS as never, REMINDER_PEOPLE, 90, REMINDER_TODAY, vessel.noExpiryCodes, {}), /needs crewRowsOnly, crewRegister and daysUntil/);
  // A row the office spelt its own way is listed under the register's name.
  const spelt = { ...REMINDER_QUALS, rows: [["bILLY", "Cook", "", [inDays(10), "", "", ""]]] };
  assert.deepEqual(expiring(spelt).map((i) => [i.person, i.from]), [["SITTIYOS, Kachin", ["bILLY"]]], "and keeps the row's own spelling");
  // The same man twice, the same item and date: one line, both spellings.
  const twice = { ...REMINDER_QUALS, rows: [["bILLY", "Cook", "", [inDays(10), "", "", ""]], ["SITTIYOS, Kachin", "Cook", "", [inDays(10), "", "", ""]]] };
  assert.deepEqual(expiring(twice).map((i) => [i.person, i.from]), [["SITTIYOS, Kachin", ["bILLY", "SITTIYOS, Kachin"]]]);
});

test("each crew grant is sent their own list, through the register; management and IT the summary; nobody else anything", () => {
  const items = expiring(REMINDER_QUALS);
  const users = [
    { id: "u1", email: "kachin@example.com", name: "Kachin Sittiyos", role: "crew", disabled: 0 },
    { id: "u2", email: "brenton@example.com", name: "Brenton Evans", role: "crew", disabled: 1 },
    { id: "u3", email: "sam@example.com", name: "Sam Sample", role: "crew", disabled: 0 },
    { id: "u4", email: "boss@example.com", name: "Matthew Jones", role: "management", disabled: 0 },
    { id: "u5", email: "help@example.com", name: "IT Help", role: "it", disabled: 0 },
    { id: "u6", email: "old@example.com", name: "Old Boss", role: "management", disabled: 1 },
    { id: "u7", email: "stranger@example.com", name: "Alan Stranger", role: "crew", disabled: 0 },
    { id: "u8", email: "kachin", name: "Kachin Sittiyos", role: "crew", disabled: 0 },
    { id: "u9", email: "BOSS@example.com", name: "Matthew Jones", role: "management", disabled: 0 },
    { id: "u10", email: "billy@example.com", name: "Kachin", role: "crew", disabled: 0 },
  ];
  const out = reminders.recipientsFor(users, REMINDER_PEOPLE, items, REMINDER_RULES);
  assert.deepEqual(out.own.map((o) => [o.user.email, o.person, o.items.map((i) => i.code)]), [
    ["kachin@example.com", "SITTIYOS, Kachin", ["QL-17", "QL-01"]],
  ], "\"Kachin Sittiyos\" is the row \"SITTIYOS, Kachin\"; Brenton is disabled; Sam has nothing due; a stranger and a one-word name are nobody's; a broken address is none");
  assert.deepEqual(out.summary.map((u) => u.email), ["boss@example.com", "help@example.com"], "management and IT, each address once, the disabled one left out");
  // Two men the grant's name could be: nobody's list.
  const twins = [...REMINDER_PEOPLE, { name: "SITTIYOS, Kachin James", aliases: [] }];
  assert.deepEqual(reminders.recipientsFor(users, twins, items, REMINDER_RULES).own, [], "a name the register cannot put to one person sends nothing");
  assert.throws(() => reminders.recipientsFor(users, REMINDER_PEOPLE, items, {}), /needs crewRegister, nameLetters and registerWords/);
});

test("another man's row the register only loosely takes for somebody stays out of that man's own email, and in the summary", () => {
  // Brenton is on Crew Details; the other rows are men who are not yet.
  const people = [{ name: "EVANS, Brenton", aliases: [] }];
  const brenton = [{ id: "b", email: "brenton@example.com", name: "Brenton Evans", role: "crew", disabled: 0 },
    { id: "m", email: "boss@example.com", name: "Matthew Jones", role: "management", disabled: 0 }];
  for (const other of ["EVANS, R.", "EVANS", "EVANS, Brenton James"]) {
    const quals = { cols: [["QL-01", "Master", ""], ["QL-17", "AMSA Medical", ""]], rows: [
      ["EVANS, Brenton", "Master", "", ["", inDays(14)]],
      [other, "Cook", "", [inDays(3), ""]],
    ] };
    const items = expiring(quals, people);
    assert.deepEqual(items.map((i) => [i.person, i.code, i.from]), [
      ["EVANS, Brenton", "QL-01", [other]],
      ["EVANS, Brenton", "QL-17", ["EVANS, Brenton"]],
    ], JSON.stringify(other) + ": the register takes the row for Brenton, as the matrix page does");
    const out = reminders.recipientsFor(brenton, people, items, REMINDER_RULES);
    assert.deepEqual(out.own.map((o) => [o.user.email, o.items.map((i) => i.code)]), [["brenton@example.com", ["QL-17"]]],
      JSON.stringify(other) + "'s QL-01 is not sent to Brenton");
    assert.deepEqual(out.summary.map((u) => u.email), ["boss@example.com"], "the summary still goes, with every item on it");
  }
  // Only the other man's item due: Brenton is sent nothing at all.
  const onlyOther = expiring({ cols: [["QL-01", "Master", ""]], rows: [["EVANS, R.", "Cook", "", [inDays(3)]]] }, people);
  assert.deepEqual(reminders.recipientsFor(brenton, people, onlyOther, REMINDER_RULES).own, []);
  // A grant with a word more than the register's name is somebody else too.
  const items = expiring({ cols: [["QL-17", "AMSA Medical", ""]], rows: [["EVANS, Brenton", "Master", "", [inDays(14)]]] }, people);
  const james = [{ id: "j", email: "james@example.com", name: "Brenton James Evans", role: "crew", disabled: 0 }];
  assert.deepEqual(reminders.recipientsFor(james, people, items, REMINDER_RULES).own, [], "'Brenton James Evans' is not EVANS, Brenton");
  // Listed on the register as one of his spellings, it is him.
  const listed = [{ name: "EVANS, Brenton", aliases: ["Brenton James Evans"] }];
  assert.deepEqual(reminders.recipientsFor(james, listed, items, REMINDER_RULES).own.map((o) => o.user.email), ["james@example.com"]);
  // A spelling two people on the register both list is nobody's.
  const shared = [{ name: "EVANS, Brenton", aliases: ["B EVANS"] }, { name: "EVANS, Bob", aliases: ["B EVANS"] }];
  const bRow = expiring({ cols: [["QL-17", "AMSA Medical", ""]], rows: [["B EVANS", "Master", "", [inDays(14)]]] }, shared);
  assert.deepEqual(reminders.recipientsFor(brenton, shared, bRow, REMINDER_RULES).own, []);
});

test("the reminders are due on the day, from the hour, once", () => {
  // Monday 28 Sep 2026 where the vessel is.
  const at = (utc: string) => vesselNow(Date.parse(utc));
  assert.deepEqual(at("2026-09-27T23:10:00Z"), { day: "2026-09-28", hour: 7, weekday: 1 }, "07:10 Monday in Perth is 23:10 Sunday UTC");
  assert.deepEqual(at("2026-09-27T15:59:00Z"), { day: "2026-09-27", hour: 23, weekday: 0 }, "a minute to midnight is still Sunday in Perth");
  assert.deepEqual(at("2026-09-27T16:00:00Z"), { day: "2026-09-28", hour: 0, weekday: 1 }, "midnight is Monday in Perth while it is Sunday in UTC");
  const due = (utc: string, record: { day?: string | null } | null = null) => reminders.reminderDue(record, at(utc), 1, 7);
  assert.equal(due("2026-09-27T23:10:00Z"), true, "07:10 Monday: due");
  assert.equal(due("2026-09-27T22:10:00Z"), false, "06:10 Monday: not yet");
  assert.equal(due("2026-09-28T02:10:00Z"), true, "10:10 Monday, the morning's ticks missed: still due");
  assert.equal(due("2026-09-28T23:10:00Z"), false, "07:10 Tuesday: not due");
  assert.equal(due("2026-09-27T23:10:00Z", { day: "2026-09-28" }), false, "sent already this Monday: not twice");
  assert.equal(due("2026-09-28T00:10:00Z", { day: "2026-09-28" }), false, "…nor at 08:10");
  assert.equal(due("2026-10-04T23:10:00Z", { day: "2026-09-28" }), true, "the next Monday: due again");

  // A week between two sends, whatever the weekday is moved to.
  const on = (day: string, weekday: number, hour = 7) => ({ day, hour, weekday });
  assert.equal(reminders.reminderDue({ day: "2026-09-28" }, on("2026-10-01", 4), 4, 7), false,
    "sent Monday, the weekday moved to Thursday: nothing that Thursday");
  assert.equal(reminders.reminderDue({ day: "2026-09-28" }, on("2026-10-08", 4), 4, 7), true, "the Thursday after: due");
  assert.equal(reminders.reminderDue({ day: "2026-09-28" }, on("2026-10-04", 0), 0, 7), false, "moved to Sunday: not six days on");
  assert.equal(reminders.reminderDue({ day: "not a day" }, on("2026-09-28", 1), 1, 7), true, "a record with no day in it is no send");

  // Every tick of the set day missed: the next day, all day, the set day is owed.
  const owed = reminders.reminderOwed;
  assert.equal(owed({ day: "2026-09-21" }, on("2026-09-29", 2, 0), 1, 23), "2026-09-28", "Monday's 23:10 missed: Tuesday 00:10 sends it, as Monday's");
  assert.equal(owed({ day: "2026-09-21" }, on("2026-09-29", 2, 15), 1, 7), "2026-09-28", "...at any hour of the Tuesday");
  assert.equal(owed({ day: "2026-09-28" }, on("2026-09-29", 2, 0), 1, 7), null, "Monday's went: Tuesday sends nothing");
  assert.equal(owed({ day: "2026-09-14" }, on("2026-09-29", 2, 0), 1, 7), null, "last week's did not go either: nothing older is caught up");
  assert.equal(owed(null, on("2026-09-29", 2, 9), 1, 7), null, "switched on the day after: nothing until Monday");
  assert.equal(owed({ day: "2026-09-21" }, on("2026-09-30", 3, 9), 1, 7), null, "not two days after");
  assert.equal(owed({ day: "2026-09-19" }, on("2026-09-27", 0, 0), 6, 7), "2026-09-26", "Saturday's is caught up on the Sunday");
  // The claimed day is the set day, so the next week keeps its day.
  assert.equal(owed({ day: "2026-09-28" }, on("2026-10-05", 1), 1, 7), "2026-10-05", "the Monday after a Tuesday catch-up: due as ever");
  // A week handed back after a failure before sending is still owed.
  assert.equal(owed({ day: "2026-09-21" }, on("2026-09-28", 1, 9), 1, 7), "2026-09-28");
});

test("the emails say the list in plain words, and nothing else but the portal's address", () => {
  const items = expiring(REMINDER_QUALS);
  const it = (daysLeft: number, date: string) => ({ person: "SITTIYOS, Kachin", code: "QL-17", title: "AMSA Medical", date, daysLeft, from: ["SITTIYOS, Kachin"] });
  assert.equal(reminders.reminderItemLine(it(18, "2026-10-12")), "QL-17 AMSA Medical — expires 12 Oct 2026 (18 days)");
  assert.equal(reminders.reminderItemLine(it(1, "2026-09-25")), "QL-17 AMSA Medical — expires 25 Sep 2026 (1 day)");
  assert.equal(reminders.reminderItemLine(it(0, "2026-09-24")), "QL-17 AMSA Medical — expires today (24 Sep 2026)");
  assert.equal(reminders.reminderItemLine(it(-3, "2026-09-21")), "QL-17 AMSA Medical — expired 3 days ago (21 Sep 2026)");
  const ship = `${vessel.name} ${vessel.nameAccent}`;
  const own = reminders.reminderText(vessel, "SITTIYOS, Kachin", items.filter((i) => i.person === "SITTIYOS, Kachin"), REMINDER_TODAY, 90);
  assert.equal(own.subject, `Your certificates expiring within 90 days - ${ship}`);
  assert.equal(own.text,
    `Your certificates on the ${ship} crew matrix (SITTIYOS, Kachin) that have expired or expire within 90 days, as at 28 Sep 2026:\n\n` +
    "QL-17 AMSA Medical — expires today (28 Sep 2026)\n" +
    "QL-01 Master — expires 27 Dec 2026 (90 days)\n\n" +
    `https://${vessel.domain}\n`);
  assert.match(own.html, /<li[^>]*>QL-01 Master — expires 27 Dec 2026 \(90 days\)<\/li>/);
  const summary = reminders.summaryText(vessel, reminders.byPerson(items), REMINDER_TODAY, 90);
  assert.equal(summary.subject, `Crew certificates expiring within 90 days - ${ship}`);
  assert.equal(summary.text,
    `Crew certificates on the ${ship} crew matrix that have expired or expire within 90 days, as at 28 Sep 2026 - 3 items, 2 people:\n\n` +
    "EVANS, Brenton\n  QL-17 AMSA Medical — expired 3 days ago (25 Sep 2026)\n\n" +
    "SITTIYOS, Kachin\n  QL-17 AMSA Medical — expires today (28 Sep 2026)\n  QL-01 Master — expires 27 Dec 2026 (90 days)\n\n" +
    `https://${vessel.domain}\n`);
  // A name is written into the html as text, never as markup.
  const odd = reminders.reminderText(vessel, "<b>O'NEIL</b>, Pat", [{ ...it(5, "2026-10-03"), title: "A & B" }], REMINDER_TODAY, 90);
  assert.ok(odd.html.includes("&lt;b&gt;O'NEIL&lt;/b&gt;") && odd.html.includes("A &amp; B") && !odd.html.includes("<b>O'NEIL"));
});
