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
import { equivalentCode, codeFor, filedAsFor, ModelRefusal, plainLine, errorLine, OUT_OF_CREDIT, READING_UNAVAILABLE, KEY_PROBLEM } from "../src/lib/analysis.js";
import { filedCodeIn, filedAsLine } from "../../source/shared/filed-as.js";
import { AI_BUSY, checkerRefusalLine } from "../src/lib/checker.js";
import { crewFolderIn, looseIn, whoseFolder } from "../src/routes/sync.js";
import { asKey } from "../src/db/cert-home.js";
import { canonicalPersonName } from "../src/db/person-name.js";
import { setEnv } from "../src/env.js";
import { vessel, checkVessel, vesselNow } from "../src/vessel.js";
import { crewRowsOnly, crewRegister, nameLetters, registerWords, nameIsSomebodyElse, readAsLine, readerPick, readerPlaces, whoseCertificate } from "../../source/shared/names.js";
import { RED_DAYS, daysUntil, hasExpired } from "../../source/shared/bands.js";
import * as reminders from "../../source/shared/reminders.js";
import { particularsFor, fillParticulars, mergeParticulars, msicCodeIn, newestCard, ticketCodesIn, isMsicCard, openToCertificates } from "../../source/shared/particulars.js";
import { coveredCells, coveredCodes, unitCodesIn, unitColumnsIn, COVER_SOURCES } from "../../source/shared/covers.js";
import { foreignExpiryOn, isRecognitionReading, recognisedUntil, recognitionFills } from "../../source/shared/recognition.js";
import { medicalCodesIn, medicalOnFile, medicalTooLong, medicalNote } from "../../source/shared/medical.js";
import { renewalBlockers, renewalNeedsProblem } from "../../source/shared/renewals.js";
import { coveredBy, evidenceKindsProblem, paperKind, EVIDENCE_KINDS } from "../../source/shared/evidence.js";
import { expiringIn, EXPIRING_MEANS, PORTAL_TOOLS } from "../src/lib/portal.js";
import { dueMeans } from "../src/lib/matrix.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * The column a certificate is filed under is the office's word
 * (source/shared/filed-as.js). A file named "<PERSON> - <CODE> <Title>" was
 * put under that column by whoever filed it, and only a hand tag ranks
 * above it: hand tag > filed column > Equivalence sheet > the model.
 * ------------------------------------------------------------------------ */
const FILED_COLS = [["VS-04", "Helm CONNECT", "Vessel"], ["QL-04", "Master <45m NC", "Qualification"],
  ["QL-13", "ECDIS", "Qualification"], ["QL-01", "Master", "Qualification"], ["MS-07", "Port of Ashburton pilotage exemption", "Marine"]];

test("filed as: the code in a filename is a filing only as a whole token and only for a live column", () => {
  assert.equal(filedCodeIn("SMITH, Alan - VS-04 Helm CONNECT.pdf", FILED_COLS), "VS-04");
  assert.equal(filedCodeIn("smith, alan - vs-04 helm connect.PDF", FILED_COLS), "VS-04", "however it was cased");
  assert.equal(filedCodeIn("PI-02 MinRes - Corporate Safety Induction.pdf", FILED_COLS), null, "a code that is no column of the live matrix is not a filing");
  assert.equal(filedCodeIn("ROGERS, Michael - QL-04Master.pdf", FILED_COLS), null, "not a whole token");
  assert.equal(filedCodeIn("QL-041 something.pdf", FILED_COLS), null, "QL-041 is not QL-04");
  assert.equal(filedCodeIn("Scan_0043.pdf", FILED_COLS), null, "no code at all");
  assert.equal(filedCodeIn("", FILED_COLS), null);
  assert.equal(filedCodeIn("SMITH - VS-04.pdf", null), null, "no columns, no filing");
  assert.equal(filedCodeIn("SMITH - QL-04 QL-13.pdf", FILED_COLS), "QL-04", "the first code named is the filing");
});

test("filed as: hand tag, then the filename's column, then the sheet, then the model", () => {
  const helm = reading({ certificateTitle: "Crew Intermediate", qualCode: null });
  assert.equal(codeFor({ filename: "SMITH, Alan - VS-04 Helm CONNECT.pdf" }, helm, SHEET, FILED_COLS), "VS-04",
    "the model gave nothing: the filed column stands");
  const ecdis = reading({ certificateTitle: "ECDIS generic", qualCode: "QL-13" });
  assert.equal(codeFor({ filename: "ROGERS, Michael - QL-04 Master <45m NC.pdf" }, ecdis, SHEET, FILED_COLS), "QL-04",
    "the model read another item: the filed column still wins");
  assert.equal(codeFor({ qualCode: "QL-01", filename: "X - QL-13 ECDIS.pdf" }, ecdis, SHEET, FILED_COLS), "QL-01", "a hand tag beats the filename");
  assert.equal(codeFor({ filename: "X - PI-02 Induction.pdf" }, ecdis, SHEET, FILED_COLS), "QL-13", "a code that is no column: the model's word as before");
  assert.equal(codeFor({ filename: "X - VS-04 Helm.pdf" }, helm, SHEET), null, "with no columns handed in nothing is read off the name");
  const sheeted = reading({ certificateTitle: "Watchkeeper Deck", qualCode: "QL-13" });
  assert.equal(codeFor({ filename: "ROGERS - QL-04 Master <45m NC.pdf" }, sheeted, SHEET, FILED_COLS), "QL-04", "the filed column beats the sheet too");
  assert.equal(codeFor({ filename: "ROGERS - watchkeeper.pdf" }, sheeted, SHEET, FILED_COLS), "QL-04", "and the sheet still beats the model where nothing was filed");
  /* A name the portal wrote itself (the refile, from the model's guess) is
     not the office's word: read back as a filing it would outrank the sheet
     whose job is to correct that guess, for ever. The row says who named
     the file, and only the office's name is a filing. */
  assert.equal(codeFor({ filename: "ROGERS - QL-13 ECDIS.pdf", namedByPortal: 1 }, sheeted, SHEET, FILED_COLS), "QL-04",
    "the portal's own name is skipped: the sheet moves the certificate");
  assert.equal(codeFor({ filename: "ROGERS - QL-13 ECDIS.pdf", namedByPortal: null }, sheeted, SHEET, FILED_COLS), "QL-13",
    "the same name written by the office is the office's word");
  assert.equal(codeFor({ qualCode: "QL-01", filename: "ROGERS - QL-13 ECDIS.pdf", namedByPortal: 1 }, sheeted, SHEET, FILED_COLS), "QL-01", "a hand tag still comes first");
});

test("filed as: where the filed column and the reading disagree, the disagreement is said - and only then", () => {
  const helm = reading({ certificateTitle: "Crew Intermediate", qualCode: null });
  assert.deepEqual(filedAsFor({ filename: "SMITH, Alan - VS-04 Helm CONNECT.pdf" }, helm, SHEET, FILED_COLS),
    { code: "VS-04", title: "Helm CONNECT", readsAs: "Crew Intermediate" }, "the model read it as nothing on the matrix");
  const ecdis = reading({ certificateTitle: "ECDIS generic", qualCode: "QL-13" });
  assert.deepEqual(filedAsFor({ filename: "ROGERS - QL-04 Master <45m NC.pdf" }, ecdis, SHEET, FILED_COLS),
    { code: "QL-04", title: "Master <45m NC", readsAs: "ECDIS generic" }, "the model read another item");
  const same = reading({ certificateTitle: "Helm CONNECT Crew Basic", qualCode: "VS-04" });
  assert.equal(filedAsFor({ filename: "SMITH - VS-04 Helm CONNECT.pdf" }, same, SHEET, FILED_COLS), null, "the model gave the same column: nothing to say");
  assert.equal(filedAsFor({ qualCode: "QL-01", filename: "X - QL-13 ECDIS.pdf" }, ecdis, SHEET, FILED_COLS), null, "a hand tag is the person's word, not a filing to question");
  assert.equal(filedAsFor({ filename: "X - PI-02 Induction.pdf" }, helm, SHEET, FILED_COLS), null, "no live column in the name: no filing");
  assert.equal(filedAsFor({ filename: "SMITH - VS-04 Helm.pdf" }, reading({ readable: false }), SHEET, FILED_COLS), null, "an unreadable document fills nothing and says nothing");
  const untitled = reading({ certificateTitle: null, qualCode: "QL-13" });
  assert.deepEqual(filedAsFor({ filename: "ROGERS - QL-04 x.pdf" }, untitled, SHEET, FILED_COLS),
    { code: "QL-04", title: "Master <45m NC", readsAs: "ECDIS" }, "no printed title: the column the model named");
  // The model agreed, however unsure: the line is for a document read as something else.
  const unsure = reading({ certificateTitle: "Master <45m NC", qualCode: "QL-04", codeConfidence: "low" });
  assert.equal(filedAsFor({ filename: "ROGERS - QL-04 Master <45m NC.pdf" }, unsure, SHEET, FILED_COLS), null, "the same code at low confidence is agreement");
  assert.equal(codeFor({ filename: "ROGERS - QL-04 Master <45m NC.pdf" }, unsure, SHEET, FILED_COLS), "QL-04", "and the cell is filled all the same");
  const titled = reading({ certificateTitle: "master <45m nc", qualCode: null });
  assert.equal(filedAsFor({ filename: "ROGERS - QL-04 Master <45m NC.pdf" }, titled, SHEET, FILED_COLS), null, "the column's own title printed on the document is agreement too");
  // A name the portal wrote is no filing, so there is no filing to question.
  assert.equal(filedAsFor({ filename: "ROGERS - QL-04 Master <45m NC.pdf", namedByPortal: 1 }, ecdis, SHEET, FILED_COLS), null, "the portal's own name: nothing to say");
  assert.equal(filedAsLine("ROGERS, Michael", "QL-04", "Master <45m NC", "STCW Watchkeeper Deck"),
    "ROGERS, Michael — QL-04: filed as Master <45m NC, reads as STCW Watchkeeper Deck", "the one line, as Needs attention says it");
  assert.equal(filedAsLine("SMITH, Alan", "VS-04", "Helm CONNECT", null),
    "SMITH, Alan — VS-04: filed as Helm CONNECT, reads as nothing on the matrix");
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

test("the assistant's expiring is the red band: RED_DAYS, and it says so", () => {
  assert.deepEqual([-1, 0, RED_DAYS, RED_DAYS + 1, null].map(expiringIn), [false, true, true, false, false]);
  assert.equal(EXPIRING_MEANS, "expiring is anything with 90 days or less to run", "the sentence reads as it always did");
  const certs = PORTAL_TOOLS.find((t) => t.name === "read_certificates") as { input_schema: { properties: { status: { description: string } } } };
  assert.ok(certs.input_schema.properties.status.description.includes(EXPIRING_MEANS), "and the model is told it");
});

test("the AI Checker's due is the red band's days, read from RED_DAYS both ways it is asked", () => {
  for (const withValidity of [true, false]) {
    assert.ok(dueMeans(withValidity).includes(`within ${RED_DAYS} days`), `with the validity matrix: ${withValidity}`);
  }
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "matrix.ts"), "utf8");
  assert.equal(/within 90\b/.test(source), false, "no 90 written into the checker's question by hand");
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
  assert.equal(reminders.reminderItemLine(it(0, "2026-09-24")), "QL-17 AMSA Medical — expired today (24 Sep 2026)");
  assert.equal(reminders.reminderItemLine(it(-3, "2026-09-21")), "QL-17 AMSA Medical — expired 3 days ago (21 Sep 2026)");
  const ship = `${vessel.name} ${vessel.nameAccent}`;
  const own = reminders.reminderText(vessel, "SITTIYOS, Kachin", items.filter((i) => i.person === "SITTIYOS, Kachin"), REMINDER_TODAY, 90);
  assert.equal(own.subject, `Your certificates expiring within 90 days - ${ship}`);
  assert.equal(own.text,
    `Your certificates on the ${ship} crew matrix (SITTIYOS, Kachin) that have expired or expire within 90 days, as at 28 Sep 2026:\n\n` +
    "QL-17 AMSA Medical — expired today (28 Sep 2026)\n" +
    "QL-01 Master — expires 27 Dec 2026 (90 days)\n\n" +
    `https://${vessel.domain}\n`);
  assert.match(own.html, /<li[^>]*>QL-01 Master — expires 27 Dec 2026 \(90 days\)<\/li>/);
  const summary = reminders.summaryText(vessel, reminders.byPerson(items), REMINDER_TODAY, 90);
  assert.equal(summary.subject, `Crew certificates expiring within 90 days - ${ship}`);
  assert.equal(summary.text,
    `Crew certificates on the ${ship} crew matrix that have expired or expire within 90 days, as at 28 Sep 2026 - 3 items, 2 people:\n\n` +
    "EVANS, Brenton\n  QL-17 AMSA Medical — expired 3 days ago (25 Sep 2026)\n\n" +
    "SITTIYOS, Kachin\n  QL-17 AMSA Medical — expired today (28 Sep 2026)\n  QL-01 Master — expires 27 Dec 2026 (90 days)\n\n" +
    `https://${vessel.domain}\n`);
  // A name is written into the html as text, never as markup.
  const odd = reminders.reminderText(vessel, "<b>O'NEIL</b>, Pat", [{ ...it(5, "2026-10-03"), title: "A & B" }], REMINDER_TODAY, 90);
  assert.ok(odd.html.includes("&lt;b&gt;O'NEIL&lt;/b&gt;") && odd.html.includes("A &amp; B") && !odd.html.includes("<b>O'NEIL"));
});

/* ---- a man's MSIC number and date of birth, off his own certificates ---- */
const P_PEOPLE = [
  { id: "p1", name: "EVANS, Brenton", aliases: ["bRENTON"] },
  { id: "p2", name: "SITTIYOS, Kachin", aliases: ["bILLY"] },
  { id: "p3", name: "SAMPLE, Sam", aliases: [] },
];
const P_REGISTER = crewRegister(P_PEOPLE);
const P_TODAY = "2026-09-25";
const P_ROWS = [
  { person: "bRENTON", code: "VS-01", key: "m1", filedOn: "2024-01-01" },
  { person: "EVANS, Brenton", code: "VS-01", key: "m2", filedOn: "2026-01-01" },
  { person: "EVANS, Brenton", code: "QL-01", key: "q1", filedOn: "2025-01-01" },
  // Filed in Evans's folder, printed in Kachin's name.
  { person: "EVANS, Brenton", code: "VS-01", key: "w1", filedOn: "2026-06-01" },
  { person: "bILLY", code: "QL-01", key: "k1", filedOn: "2025-01-01" },
  { person: "SITTIYOS, Kachin", code: "QL-17", key: "k2", filedOn: "2025-02-01" },
  { person: "SAMPLE, Sam", code: "QL-12", key: "s1" },
  { person: "SAMPLE, Sam", code: "QL-17", key: "s2" },
  { person: "SAMPLE, Sam", code: "QL-01", key: "s3" },
  { person: "SAMPLE, Sam", code: "QL-02", key: "s4" },
];
const P_READINGS: Record<string, Record<string, unknown>> = {
  m1: { readable: true, qualCode: "VS-01", holderName: "Brenton Evans", documentNumber: "msic 0001", expiresOn: "2027-01-01", holderBirthDate: "1980-03-10" },
  m2: { readable: true, qualCode: "VS-01", holderName: "brenton EVANS", documentNumber: " msic  0002 ", expiresOn: "2030-01-01", holderBirthDate: "1980-03-10" },
  q1: { readable: true, holderName: "Evans Brenton", holderBirthDate: "1980-10-03" },
  w1: { readable: true, qualCode: "VS-01", holderName: "Kachin Sittiyos", documentNumber: "WRONG", expiresOn: "2035-01-01", holderBirthDate: "1970-01-01" },
  k1: { readable: true, holderName: "Kachin Sittiyos", holderBirthDate: "1975-05-05" },
  k2: { readable: true, holderName: "SITTIYOS Kachin", holderBirthDate: "1976-06-06" },
  s1: { readable: true, holderName: "Sam Sample", holderBirthDate: "2030-01-01" },
  s2: { readable: true, holderName: "Sam Sample", holderBirthDate: "2021-06-01" },
  s3: { readable: true, holderName: "Sam Sample", holderBirthDate: "1906-01-01" },
  s4: { readable: true, holderName: "Sam Sample", holderBirthDate: "1985-02-30" },
};
const particularsOf = (name: string, msic: string | null = "VS-01", readings = P_READINGS) =>
  particularsFor(name, P_ROWS, readings, P_REGISTER, P_TODAY, msic);

test("particulars: the newest MSIC card's number, in his name only, and the date his certificates agree on", () => {
  assert.equal(msicCodeIn(vessel.qualColumns), "VS-01", "the MSIC column is found by its title on the vessel file");
  assert.deepEqual(particularsOf("EVANS, Brenton"), { msic: "MSIC 0002", dob: "1980-03-10" },
    "the card that runs out last, tidied; two of three say 10 Mar 1980; the card in Kachin's name gives neither");
  assert.deepEqual(particularsOf("brenton evans"), particularsOf("EVANS, Brenton"), "names in another order or case are the same man through the register");
  assert.deepEqual(particularsOf("SITTIYOS, Kachin"), { msic: null, dob: null },
    "his certificates say two dates once each: no guess; the card in his name filed under Evans is not his to take");
  assert.deepEqual(particularsOf("SAMPLE, Sam"), { msic: null, dob: null },
    "a date in the future, five years ago, 120 years ago or not a day at all says nothing");
  // Each impossible date as the only say Sam's certificates have: on its
  // own it has no tie to hide behind, so only the age check can refuse it.
  const samOnly = (key: string, date: string) => {
    const r: Record<string, Record<string, unknown>> = { ...P_READINGS };
    ["s1", "s2", "s3", "s4"].forEach((k) => { r[k] = { ...P_READINGS[k], readable: false }; });
    r[key] = { readable: true, holderName: "Sam Sample", holderBirthDate: date };
    return particularsOf("SAMPLE, Sam", "VS-01", r).dob;
  };
  assert.equal(samOnly("s1", "1985-01-01"), "1985-01-01", "a real date on its own is his date - so a null below is the date refused");
  assert.equal(samOnly("s1", "2030-01-01"), null, "a date in the future, alone, says nothing");
  assert.equal(samOnly("s2", "2021-06-01"), null, "a five-year-old, alone, says nothing");
  assert.equal(samOnly("s3", "1906-01-01"), null, "a 120-year-old, alone, says nothing");
  assert.equal(samOnly("s4", "1985-02-30"), null, "a day that does not exist, alone, says nothing");
  const outvoted: Record<string, Record<string, unknown>> = { ...P_READINGS,
    s1: { readable: true, holderName: "Sam Sample", holderBirthDate: "2030-01-01" },
    s2: { readable: true, holderName: "Sam Sample", holderBirthDate: "2030-01-01" },
    s3: { readable: true, holderName: "Sam Sample", holderBirthDate: "1985-01-01" },
    s4: { readable: false } };
  assert.equal(particularsOf("SAMPLE, Sam", "VS-01", outvoted).dob, "1985-01-01", "two certificates saying a future date do not outvote the one real date");
  assert.equal(particularsOf("EVANS, Brenton", msicCodeIn([["QL-01", "Master", "Qualification"]])).msic, null, "no MSIC column, no MSIC number");
  const unread = { ...P_READINGS, m2: { ...P_READINGS.m2, readable: false } };
  assert.equal(particularsOf("EVANS, Brenton", "VS-01", unread).msic, "MSIC 0001", "an unreadable reading gives nothing");
});

test("particulars: a certificate that names nobody gives nothing, however it is filed", () => {
  const nameless = { ...P_READINGS,
    m1: { ...P_READINGS.m1, holderName: null }, m2: { ...P_READINGS.m2, holderName: null }, q1: { ...P_READINGS.q1, holderName: "" } };
  assert.deepEqual(particularsOf("EVANS, Brenton", "VS-01", nameless), { msic: null, dob: null },
    "his folder, but no name to say it is his card: neither box takes it");
});

test("particulars: only the card itself gives an MSIC number, not a letter or a receipt filed in its column", () => {
  const rows = [{ person: "EVANS, Brenton", code: "VS-01", key: "a1" }, { person: "EVANS, Brenton", code: "VS-01", key: "a2" }];
  const letter = { readable: true, holderName: "Brenton Evans", qualCode: null, certificateTitle: "AusCheck MSIC application approved", documentNumber: "REF 7777" };
  const card = { readable: true, holderName: "Brenton Evans", qualCode: null, certificateTitle: "Maritime  Security Identification Card", documentNumber: "MSIC 0003", expiresOn: "2020-01-01" };
  assert.equal(particularsFor("EVANS, Brenton", rows, { a1: letter }, P_REGISTER, P_TODAY, "VS-01").msic, null, "the letter's reference is not his card number");
  assert.equal(particularsFor("EVANS, Brenton", rows, { a1: letter, a2: card }, P_REGISTER, P_TODAY, "VS-01").msic, "MSIC 0003",
    "the card, known by its title, gives it");
  assert.equal(isMsicCard({ qualCode: "vs-01" }, "VS-01"), true, "read into the MSIC column by the model");
  assert.equal(isMsicCard({ qualCode: "QL-01", certificateTitle: "Master <500GT" }, "VS-01"), false);
  assert.deepEqual(ticketCodesIn(vessel.qualColumns).slice(0, 2), ["QL-01", "QL-02"], "the tickets are the vessel file's Qualification group");
  assert.equal(ticketCodesIn(vessel.qualColumns).includes("VS-01"), false);
});

test("particulars: of two cards alike in every date the later upload wins, and a renewal whose expiry went unread still beats the old card", () => {
  // The listing hands the newest upload first.
  const card = (key: string, at: number, reading: Record<string, unknown>, filedOn = "2026-01-01") =>
    ({ row: { key, filedOn }, reading, at });
  const same = { expiresOn: "2030-01-01", issuedOn: "2026-01-01" };
  assert.equal(newestCard([card("new", 0, same), card("old", 1, same)])!.row.key, "new", "the clearer scan uploaded last");
  assert.equal(newestCard([card("old", 1, same), card("new", 0, same)])!.row.key, "new", "whatever order they are handed in");
  const expired = card("old", 1, { expiresOn: "2024-01-01", issuedOn: "2020-01-01" }, "2020-02-01");
  assert.equal(newestCard([expired, card("renewed", 0, { issuedOn: "2024-01-01" }, "2024-02-01")])!.row.key, "renewed",
    "issued after the old card: the new card, its expiry unread or not");
  assert.equal(newestCard([expired, card("undated", 0, {}, "2024-02-01")])!.row.key, "undated", "no issue date either: filed after it");
  assert.equal(newestCard([card("current", 1, { expiresOn: "2030-01-01", issuedOn: "2026-01-01" }), card("older", 0, { issuedOn: "2022-01-01" })])!.row.key,
    "current", "an undated card issued before the one that runs out last does not take its place");
  const rows = [{ person: "EVANS, Brenton", code: "VS-01", key: "n1" }, { person: "EVANS, Brenton", code: "VS-01", key: "n2" }];
  const r = { readable: true, holderName: "Brenton Evans", qualCode: "VS-01", expiresOn: "2030-01-01" };
  assert.equal(particularsFor("EVANS, Brenton", rows, { n1: { ...r, documentNumber: "MSIC 0009" }, n2: { ...r, documentNumber: "MSIC 0008" } }, P_REGISTER, P_TODAY, "VS-01").msic,
    "MSIC 0009", "the rule takes the one earlier in the listing: uploaded last");
});

test("particulars: an empty box is filled, a typed one kept, a renewed card replaces the old number, nothing found clears nothing", () => {
  const F = { p1: { msic: "MSIC 0002", dob: "1980-03-10" } };
  const empty = fillParticulars([{ id: "p1", name: "EVANS, Brenton" }], F, {});
  assert.equal(empty.changed, true);
  assert.deepEqual(empty.people, [{ id: "p1", name: "EVANS, Brenton", msic: "MSIC 0002", dob: "1980-03-10" }], "empty boxes filled");
  assert.deepEqual(empty.fromCert, { p1: { msic: "MSIC 0002", dob: "1980-03-10" } }, "and what went in is remembered");

  const again = fillParticulars(empty.people, F, empty.fromCert);
  assert.equal(again.changed, false, "nothing new: nothing changes");
  assert.equal(again.people, empty.people, "the same list back");

  const typed = fillParticulars([{ id: "p1", msic: "TYPED 9", dob: "1980-03-11" }], F, { p1: { msic: "MSIC 0001", dob: "1980-03-10" } });
  assert.equal(typed.changed, false);
  assert.deepEqual(typed.people, [{ id: "p1", msic: "TYPED 9", dob: "1980-03-11" }], "what somebody typed is left as typed");
  assert.deepEqual(typed.fromCert, { p1: { msic: "MSIC 0001", dob: "1980-03-10" } }, "and the certificates' record is kept");

  const renewed = fillParticulars([{ id: "p1", msic: "MSIC 0001" }], { p1: { msic: "MSIC 0002", dob: null } }, { p1: { msic: "MSIC 0001" } });
  assert.deepEqual(renewed.people, [{ id: "p1", msic: "MSIC 0002" }], "the new card's number replaces the old card's");
  assert.deepEqual(renewed.fromCert, { p1: { msic: "MSIC 0002", was: { msic: ["MSIC 0001"] } } }, "and the old card's is remembered as the certificates'");
  // A tab from before the round filled boxes lays its crew list back over
  // the round's: the old card's number is in the box again. It is not typed.
  const laidBack = [{ id: "p1", msic: "MSIC 0001" }];
  assert.equal(openToCertificates(laidBack[0], "msic", renewed.fromCert), true, "an earlier certificate value is still the certificates'");
  assert.deepEqual(fillParticulars(laidBack, { p1: { msic: "MSIC 0002", dob: null } }, renewed.fromCert).people, [{ id: "p1", msic: "MSIC 0002" }],
    "so the new card's number goes back in");
  assert.equal(openToCertificates({ id: "p1", msic: "TYPED 9" }, "msic", renewed.fromCert), false, "anything else is still typed");
  const back = fillParticulars([{ id: "p1", msic: "MSIC 0002" }], { p1: { msic: "MSIC 0001", dob: null } }, renewed.fromCert);
  assert.deepEqual(back.fromCert, { p1: { msic: "MSIC 0001", was: { msic: ["MSIC 0002"] } } }, "a value that comes back is the last one, not an earlier one too");

  const sameAsCert = fillParticulars([{ id: "p1", msic: "msic 0002" }], { p1: { msic: "MSIC 0002", dob: null } }, {});
  assert.deepEqual(sameAsCert.people, [{ id: "p1", msic: "msic 0002" }], "a typed value that is the certificate's stays as typed");
  assert.deepEqual(sameAsCert.fromCert, { p1: { msic: "MSIC 0002" } }, "and is the certificates' from then on");
  const next = fillParticulars(sameAsCert.people, { p1: { msic: "MSIC 0003", dob: null } }, sameAsCert.fromCert);
  assert.deepEqual(next.people, [{ id: "p1", msic: "MSIC 0003" }], "so the next card replaces it: it was never marked typed");

  const none = fillParticulars([{ id: "p1", msic: "MSIC 0001", dob: "1980-03-10" }], null, { p1: { msic: "MSIC 0001", dob: "1980-03-10" } });
  assert.equal(none.changed, false, "nothing found clears nothing");
  const blank = fillParticulars([{ id: "p1", msic: "MSIC 0001" }], { p1: { msic: null, dob: null } }, { p1: { msic: "MSIC 0001" } });
  assert.deepEqual([blank.changed, blank.people[0].msic], [false, "MSIC 0001"], "nor does a man the certificates now say nothing about");
});

test("particulars: a tab's save over the round's keeps the round's fill where the tab did not touch the box", () => {
  const base = [{ id: "p1", name: "EVANS, Brenton", msic: "", rank: "Mate" }, { id: "p2", name: "SITTIYOS, Kachin", dob: "" }];
  const theirs = [{ id: "p1", name: "EVANS, Brenton", msic: "MSIC 0002", rank: "Mate" }, { id: "p2", name: "SITTIYOS, Kachin", dob: "1975-05-05" }];
  const mine = [{ id: "p1", name: "EVANS, Brenton", msic: "", rank: "Master" }, { id: "p2", name: "SITTIYOS, Kachin", dob: "1975-05-06" }];
  assert.deepEqual(mergeParticulars(base, mine, theirs), [
    { id: "p1", name: "EVANS, Brenton", msic: "MSIC 0002", rank: "Master" },
    { id: "p2", name: "SITTIYOS, Kachin", dob: "1975-05-06" },
  ], "Evans's rank is the tab's and his number the round's; the date the tab typed for Kachin is the tab's");
});

/* ------------------------------------------------------------------------ *
 * One certificate fills every column it covers: the endorsements printed on
 * it against the vessel file's table, and the unit codes printed on a
 * training statement against the column titles. The clauses are in
 * source/shared/covers.js.
 * ------------------------------------------------------------------------ */

/** Brenton Evans's new-style Master certificate of competency, as the
 *  reading lists what is printed on it. */
const EVANS_COC = [
  "II/2 (incl. generic ECDIS)", "II/5", "VI/1 s. A-VI/1 (2)", "VI/2 (1) s. A-VI/2 (1-4)",
  "VI/3 s. A-VI/3 (1-4)", "VI/4 (1) s. A-VI/4 (1-3)", "VI/4 (2) s. A-VI/4 (4-6)",
  "VI/6 (1) s. A-VI/6 (4)",
].map((text) => ({ text, until: null }));

/** A reading of a certificate that runs to 26 May 2031 - Evans's ticket -
 *  listing whatever the test prints on it. */
const covering = (over: Record<string, unknown>) =>
  ({ readable: true, expiresOn: "2031-05-26", endorsements: [], units: [], ...over }) as never;
const cellsCovered = (over: Record<string, unknown>, ownCode?: string | null) =>
  coveredCells(covering(over), vessel.covers, vessel.qualColumns, ownCode);
const codesCovered = (over: Record<string, unknown>, ownCode?: string | null) =>
  coveredCodes(covering(over), vessel.covers, vessel.qualColumns, ownCode);

test("covers: an ECDIS endorsement fills the ECDIS column with the certificate's own date, and nothing else on Evans's ticket fills anything", () => {
  /* His ticket prints eight endorsements. Only the ECDIS line is a column on
     this matrix: II/5, VI/1, VI/2 (1), VI/3, VI/4 and VI/6 fill nothing, and
     VI/1 in particular never fills QL-12 - the certificate of safety
     training is a class of its own that cannot be endorsed onto another
     document (MO70 s 7(1)(e), s 34(1)). */
  assert.deepEqual(cellsCovered({ endorsements: EVANS_COC }, "QL-01"), [{ code: "QL-13", until: "2031-05-26" }],
    "the ECDIS column, dated as the ticket is dated");
  assert.equal(codesCovered({ endorsements: EVANS_COC }, "QL-01").includes("QL-12"), false,
    "a VI/1 line is a course, not a certificate of safety training");
  assert.deepEqual(codesCovered({ endorsements: [{ text: "II/2", until: null }] }, "QL-01"), [], "II/2 on its own is not ECDIS");
  assert.deepEqual(codesCovered({ endorsements: [{ text: "VI/2 (1) s. A-VI/2 (1-4)", until: null }] }, "QL-01"), [],
    "VI/2 (1) and A-VI/2 (1-4) are survival craft, not fast rescue craft");
  // MO70 s 37(3) item 8: the endorsement is perpetual, so a date printed
  // against it never shortens the column below the certificate's own.
  assert.deepEqual(cellsCovered({ endorsements: [{ text: "II/1 incl. ECDIS", until: "2028-01-01" }] }, "QL-01"),
    [{ code: "QL-13", until: "2031-05-26" }], "ECDIS does not expire of itself: the certificate's date");
});

test("covers: the ECDIS column is the STCW endorsement, never a type-specific Furuno course", () => {
  /* QL-13 is the STCW ECDIS proficiency - "certificate of proficiency as
     ECDIS trained", printed inside the II/1 or II/2 line of a certificate of
     competency (MO70 s 37(3) item 8; MO71 s 9(2)(a)). This vessel's VS-02 is
     type-specific familiarisation on the Furuno FMD, which is not that
     endorsement, so a Furuno certificate listing its course as an
     endorsement must fill nothing on QL-13 - the bare word used to. */
  assert.deepEqual(codesCovered({ endorsements: [{ text: "II/2 (incl. generic ECDIS)", until: null }] }, "QL-01"), ["QL-13"],
    "Brenton's exact line");
  assert.deepEqual(codesCovered({ endorsements: [{ text: "Certificate of proficiency as ECDIS trained", until: null }] }, "QL-01"), ["QL-13"],
    "the endorsement by its name in the order");
  assert.deepEqual(codesCovered({ endorsements: [{ text: "Furuno FMD-3200 Type Specific ECDIS Training", until: null }] }, "QL-01"), [],
    "a type-specific course is not the STCW endorsement");
  assert.deepEqual(codesCovered({ endorsements: [{ text: "ECDIS Type-Specific (FMD series)", until: null }] }, "QL-01"), []);
  assert.deepEqual(codesCovered({ endorsements: [{ text: "ECDIS", until: null }] }, "QL-01"), [],
    "the bare word says nothing about which ECDIS it is");
  /* AMSA prints an officer who has NOT done generic ECDIS training with a
     limitation against his II/1 or II/2 line (the STCW.7/Circ.18 wording,
     which MO71 s 9(2)(a) is the reason for). Listed as printed, that line
     carries both "II/2" and "ECDIS", and it means the opposite of the
     endorsement: it must fill nothing. */
  assert.deepEqual(codesCovered({ endorsements: [{ text: "II/2 - Limitation: not valid for service on ships fitted with ECDIS", until: null }] }, "QL-01"), [],
    "a limitation saying he is not ECDIS trained is the opposite of the endorsement");
  assert.deepEqual(codesCovered({ endorsements: [{ text: "II/1 (without ECDIS)", until: null }] }, "QL-01"), []);
  const row = vessel.covers.find((c) => c.code === "QL-13")!;
  assert.match(String(row.unless), /furuno/i, "the vessel file's row names the type-specific words it excludes");
  assert.match(String(row.unless), /not valid/i, "and the limitation wording");
});

test("covers: the fast rescue craft column takes the endorsement's own printed date where AMSA printed one", () => {
  // MO70 s 37(3) item 2, s 37(5): five years from the proficiency's issue,
  // which is not the day it was written onto the certificate of competency.
  assert.deepEqual(cellsCovered({ endorsements: [{ text: "VI/2 (2) s. A-VI/2 (5-8)", until: "2029-06-18" }] }, "QL-01"),
    [{ code: "QL-16", until: "2029-06-18" }]);
  assert.deepEqual(cellsCovered({ endorsements: [{ text: "VI/2(2)", until: null }] }, "QL-01"),
    [{ code: "QL-16", until: "2031-05-26" }], "no date printed against it: the certificate's own");
  assert.deepEqual(codesCovered({ endorsements: [{ text: "VI/2 para 2", until: null }] }, "QL-01"), ["QL-16"], "however the paragraph is printed");
  assert.deepEqual(codesCovered({ endorsements: [{ text: "Proficiency in fast rescue boats", until: null }] }, "QL-01"), ["QL-16"], "or named in words");
  assert.deepEqual(codesCovered({ endorsements: [{ text: "Fast Rescue Craft", until: null }] }, "QL-01"), ["QL-16"]);
  // Two lines reaching the same column: the shorter term governs, because an
  // endorsement is a line on a document and cannot outlast the earlier date.
  assert.deepEqual(cellsCovered({ endorsements: [
    { text: "VI/2 (2)", until: "2029-06-18" }, { text: "fast rescue boats", until: "2028-01-01" }] }, "QL-01"),
  [{ code: "QL-16", until: "2028-01-01" }]);
  /* And an endorsement printed to run PAST the certificate carrying it gets
     the certificate's date, not its own: an endorsement is a line on a
     document that has to be in force to carry it (MO70 s 36(2)(a)), so the
     column cannot be green years after the only paper behind it has gone. */
  assert.deepEqual(coveredCells(
    { readable: true, expiresOn: "2028-01-01", endorsements: [{ text: "VI/2 (2) s. A-VI/2 (5-8)", until: "2031-09-09" }], units: [] } as never,
    vessel.covers, vessel.qualColumns, "QL-01"),
  [{ code: "QL-16", until: "2028-01-01" }], "the earlier of the two, which is the certificate's own expiry");
});

test("covers: the survival craft endorsement, printed 'other than fast rescue boats', fills nothing", () => {
  /* AMSA prints the survival craft endorsement as "proficiency in survival
     craft and rescue boats other than fast rescue boats" (STCW A-VI/2-1;
     MO70 s 37(3) item 1). The words "fast rescue boats" are on the face of
     a certificate whose whole point is that the man is NOT fast-rescue-boat
     qualified, so the row's own exclusion (`unless`) has to win over its
     pattern, or QL-16 fills off the wrong endorsement. */
  const survival = "Proficiency in survival craft and rescue boats other than fast rescue boats";
  assert.deepEqual(codesCovered({ endorsements: [{ text: survival, until: null }] }, "QL-01"), [],
    "the survival craft endorsement fills no fast rescue craft column");
  assert.deepEqual(codesCovered({ endorsements: [{ text: "Proficiency in fast rescue boats", until: null }] }, "QL-01"), ["QL-16"],
    "the fast rescue boat endorsement still does");
  assert.deepEqual(codesCovered({ endorsements: [
    { text: "Proficiency in fast rescue boats", until: null },
    { text: survival, until: "2029-01-01" },
  ] }, "QL-01"), ["QL-16"], "two lines: the survival craft line fills nothing and the fast rescue line still fills");
  assert.deepEqual(codesCovered({ endorsements: [{ text: "fast rescue boats (other than fast rescue boats)", until: null }] }, "QL-01"), [],
    "one line carrying both phrases: the exclusion wins");
  const row = vessel.covers.find((c) => c.code === "QL-16")!;
  assert.match(String(row.unless), /other than fast rescue/i, "the vessel file's row carries the exclusion");
  // An exclusion that does not compile is refused as the file loads, naming
  // the row - it would otherwise cover nothing and say nothing about it.
  assert.throws(() => checkVessel({ ...vessel, covers: [{ ...row, unless: "(unclosed" }] }, "a vessel file"),
    /"covers\[0\].unless" - it must be a pattern that compiles/);
  assert.throws(() => checkVessel({ ...vessel, covers: [{ ...row, unless: 7 }] }, "a vessel file"),
    /"covers\[0\].unless" - it must be a pattern that compiles/);
  assert.deepEqual(coveredCodes(covering({ endorsements: [{ text: "fast rescue boats", until: null }] }),
    [{ code: "QL-16", when: "fast rescue", unless: "(unclosed" }], vessel.qualColumns, "QL-01"), [],
    "and the rule itself covers nothing on a row whose exclusion will not compile");
});

test("covers: no column this vessel's table covers is one that carries no expiry", () => {
  /* A column that carries no expiry (noExpiryCodes) is held or it isn't, and
     a date read off a line on another document says nothing about that. Both
     settling passes refuse such a column outright - the round's covering pass
     in routes/analyse.ts and the page's in lib/analysis.ts - so they can
     never show a man different things. Nothing on this vessel reaches one
     today; if a covered column is ever put on that list, this fires and what
     the cell should then say is a decision, not a silent change. */
  const noExpiry = new Set(vessel.noExpiryCodes.map((c) => c.trim().toUpperCase()));
  const covered = [
    ...vessel.covers.map((c) => c.code.trim().toUpperCase()),
    ...unitColumnsIn(vessel.qualColumns),
  ];
  assert.deepEqual(covered.filter((c) => noExpiry.has(c)), []);
});

test("covers: GMDSS is never read off a certificate of competency", () => {
  /* The GMDSS radio operator certificate is a certificate class of its own,
     with its own term and its own revalidation (MO70 s 7(1)(ca), s 15(1)(b),
     s 21B, s 25A). No rule makes it an endorsement, so the IV/2 line printed
     on a ticket fills nothing: QL-14 is filled by the GMDSS document itself,
     or by an AMSA certificate of recognition of one. */
  assert.deepEqual(codesCovered({ endorsements: [{ text: "IV/2", until: null }] }, "QL-01"), []);
  assert.deepEqual(codesCovered({ endorsements: [{ text: "GMDSS - STCW Reg IV/2", until: null }] }, "QL-01"), []);
  assert.equal(vessel.covers.some((c) => c.code.toUpperCase() === "QL-14" && (c.from === undefined || c.from === "endorsements")), false,
    "and the vessel file's table has no GMDSS row reading the endorsements to do it with");
});

test("covers: a certificate that itself certifies the GMDSS radio operator capacity is that certificate", () => {
  /* Evgeny Evdokimov's AMSA certificate of competency prints two capacities
     on the one document - Master and GMDSS Radio Operator - and the model,
     rightly, gave it no single code, so his QL-14 stood empty with the paper
     on file. GMDSS is its own certificate class (MO70 s 7(1)(ca)), which is
     why a bare "IV/2" in a regulation list fills nothing; a document that
     itself certifies the holder may serve in the GMDSS radio operator
     CAPACITY is that certificate. The reading lists the printed capacities
     and a row of the vessel file reads them (`from: "capacities"`). */
  assert.deepEqual(cellsCovered({ capacities: ["Master", "GMDSS Radio Operator"] }, "QL-01"), [{ code: "QL-14", until: "2031-05-26" }],
    "the GMDSS column, dated as the certificate is dated");
  assert.deepEqual(codesCovered({ capacities: ["Master"], endorsements: [{ text: "IV/2", until: null }] }, "QL-01"), [],
    "a regulation number is not a capacity");
  assert.deepEqual(codesCovered({ capacities: ["GMDSS Radio Operator"] }, "QL-14"), [], "a document whose own code is QL-14 is not covered again");
  assert.deepEqual(codesCovered({ capacities: ["Chief Mate", "Master"] }, "QL-02"), [], "no other capacity fills anything: the ticket's own column is its code");
  assert.deepEqual(codesCovered({ capacities: "GMDSS Radio Operator" }, "QL-01"), [], "an answer that is not a list is no capacities");
  const row = vessel.covers.find((c) => c.code === "QL-14")!;
  assert.equal(row.from, "capacities", "the vessel file reads the capacity, never an endorsement");
  assert.match(String(row.why), /MO70 s 7\(1\)\(ca\)/);
  assert.equal(checkVessel({ ...vessel, covers: [row] }, "a vessel file").covers[0], row, "checkVessel takes the row");
  assert.deepEqual(COVER_SOURCES, ["endorsements", "units", "capacities"]);
});

test("covers: a unit code printed on a training statement fills every column whose title carries it", () => {
  /* One first-aid statement of attainment, printed with the other units on
     the same certificate: HLTAID011 is its own column and HLTAID015 another,
     both running to the statement's own expiry. */
  const statement = { expiresOn: "2029-03-01", units: ["HLTAID011", "HLTAID015"] };
  assert.deepEqual(cellsCovered(statement, "QL-18"), [{ code: "QL-19", until: "2029-03-01" }],
    "the column it fills itself is not covered again");
  assert.deepEqual(codesCovered(statement, null), ["QL-18", "QL-19"], "filed against nothing, it covers both");
  assert.deepEqual(codesCovered({ units: ["HLTAID009"] }, "QL-18"), [], "a unit no column names fills nothing");
  assert.deepEqual(codesCovered({ units: ["HLTAID01"] }, null), [], "HLTAID01 is not HLTAID011");
  assert.deepEqual(codesCovered({ units: ["RIIWHS202E", "SITXFSA005"] }, null), ["PT-02", "QL-20"]);
  assert.deepEqual(codesCovered({ units: ["first", "aid", "Master"] }, null), [],
    "a word is not a unit code, whatever column title carries it");
  assert.deepEqual(unitColumnsIn(vessel.qualColumns), ["QL-18", "QL-19", "QL-20", "PT-02", "PT-03"],
    "the training columns are read off the titles, not written down anywhere");
  assert.deepEqual(unitCodesIn(["HLTAID011", " hltaid011 ", "x", null]), ["HLTAID011"], "the same code twice is one code");
});

test("covers: a high risk work licence's printed classes fill the dogging and crane columns", () => {
  /* WorkSafe prints several classes on one card - "C6, DG, LF, RB, WP" -
     and the model rightly picks no single column for it, so none of the
     seventeen on file reached HR-01 or HR-02. The classes are printed codes,
     so the reading lists them as units, and two rows in the vessel file read
     them as whole tokens (`from: "units"`): DG fills HR-01 and CV fills
     HR-02, each with the licence's own expiry. The existing rule - a unit
     code printed in a column's title - stays as it is. */
  const licence = (units: unknown) => ({ expiresOn: "2030-04-01", certificateTitle: "Licence to Perform High Risk Work", units });
  assert.deepEqual(cellsCovered(licence(["C6", "DG", "LF", "RB", "WP"]), null), [{ code: "HR-01", until: "2030-04-01" }],
    "DG fills dogging only, dated as the licence is dated");
  assert.deepEqual(codesCovered(licence(["DG", "LF", "RI", "CV"]), null), ["HR-01", "HR-02"], "DG and CV fill both");
  assert.deepEqual(codesCovered(licence(["LF", "WP"]), null), [], "neither class printed: neither column");
  /* An entry counts as a class only when the whole entry, trimmed, IS the
     code. The question asks for each class code alone; a prose entry that
     merely carries the letters - a dangerous goods awareness course listed
     as a unit, "Class DG" - is not a licence class, and used to fill HR-01
     with that document's expiry. */
  assert.deepEqual(codesCovered(licence(["C6, DG, LF, RB, WP"]), null), ["HR-01"],
    "the classes listed on one line, as the readings made before the question asked for each alone list them, are read as tokens");
  assert.deepEqual(codesCovered(licence(["DG; CV"]), null), ["HR-01", "HR-02"], "however the line is punctuated");
  assert.deepEqual(codesCovered(licence(["C6, DG, and forklift"]), null), [], "one word of prose makes the whole line a phrase");
  assert.deepEqual(codesCovered(licence(["Class DG"]), null), [], "a phrase carrying the code is not the code");
  assert.deepEqual(codesCovered(licence(["Dangerous Goods (DG) awareness"]), null), [], "nor is a course title that brackets it");
  assert.deepEqual(codesCovered(licence([" DG "]), null), ["HR-01"], "the code alone, trimmed");
  assert.deepEqual(codesCovered(licence(["dg"]), null), ["HR-01"], "however the model cased it");
  assert.deepEqual(codesCovered(licence(["DG"]), "HR-01"), [], "its own column is not covered again");
  assert.deepEqual(codesCovered(licence(["DGA", "CVB", "1DG", "D G"]), null), [], "whole tokens only: DGA is not DG");
  assert.deepEqual(codesCovered({ expiresOn: "2030-04-01", certificateTitle: "Dogging DG course", units: [],
    endorsements: [{ text: "DG", until: null }] }, null), [],
  "a word in a title or an endorsement is not a class the reading listed as a code");
  const rows = vessel.covers.filter((c) => c.from === "units");
  assert.deepEqual(rows.map((c) => [c.code, c.when]).sort(), [["HR-01", "DG"], ["HR-02", "CV"]], "the vessel file's two rows");
  for (const row of rows) assert.ok(row.why && /licence/i.test(row.why), row.code + " says what it reads");
  assert.throws(() => checkVessel({ ...vessel, covers: [{ code: "HR-01", when: "DG", from: "hearsay" }] }, "a vessel file"),
    /"covers\[0\].from" - it must be one of endorsements, units/, "a source the rule does not read is refused, naming the row");
});

test("covers: a reading that says nothing covers nothing", () => {
  assert.deepEqual(codesCovered({ readable: false, endorsements: EVANS_COC }, "QL-01"), [], "a certificate that could not be read");
  const before = { readable: true, expiresOn: "2031-05-26" };      // read before the question was asked
  assert.deepEqual(coveredCodes(before as never, vessel.covers, vessel.qualColumns, "QL-01"), [], "a reading with no endorsements key at all");
  assert.deepEqual(coveredCodes(null, vessel.covers, vessel.qualColumns, "QL-01"), []);
  assert.deepEqual(codesCovered({ endorsements: EVANS_COC }, "QL-13"), [], "the ECDIS certificate itself covers no second ECDIS column");
  assert.deepEqual(coveredCodes(covering({ endorsements: EVANS_COC }), vessel.covers, [["QL-01", "Master", "Qualification"]], "QL-01"), [],
    "a column this matrix has not got is never filled");
  assert.deepEqual(coveredCodes(covering({ endorsements: EVANS_COC }), [{ code: "QL-13", when: "(unclosed" }], vessel.qualColumns, "QL-01"), [],
    "a pattern that does not compile covers nothing");
  assert.deepEqual(cellsCovered({ expiresOn: null, endorsements: [{ text: "generic ECDIS", until: null }] }, "QL-01"),
    [{ code: "QL-13", until: null }], "no date anywhere: the column is covered and the caller has no date to put in it");
});

test("the vessel file's covers table is checked: a pattern that will not compile, and a code that is not a column", () => {
  const bad = (covers: unknown[]) => () => checkVessel({ ...vessel, covers }, "a vessel file");
  assert.throws(bad([{ code: "QL-13" }]), /a vessel file has no usable "covers\[0\]" - it must be a code and a pattern, both strings/);
  assert.throws(bad([{ code: "QL-13", when: "(unclosed" }]), /"covers\[0\].when" - it must be a pattern that compiles/);
  assert.throws(bad([{ code: "QL-99", when: "ecdis" }]), /"covers\[0\].code" - it must be one of the codes in qualColumns/);
  assert.throws(bad([{ code: "QL-13", when: "ecdis", perpetual: "yes" }]), /"covers\[0\].perpetual" - it must be true or false/);
  assert.throws(bad([{ code: "QL-13", when: "ecdis", why: "" }]), /"covers\[0\].why"/);
  const { covers: _dropped, ...without } = vessel;
  assert.throws(() => checkVessel(without, "a vessel file"), /a vessel file has no usable "covers"/);
  assert.equal(checkVessel(vessel), vessel, "the file as it is passes");
  // A Marine Order for the endorsements; the licence classes are outside the
  // orders (the report's Part 8, item 15) and cite the regulations instead.
  for (const rule of vessel.covers) assert.ok(rule.why && /MO\d\d|Regulations \d{4}/.test(rule.why), rule.code + " carries the clause it comes from");
});

test("the figures the orders turn on are in the vessel file, and checked", () => {
  /* Length, gross tonnage and propulsion power decide things in MO504, MO71
     and MO505, and a table in the vessel file cites them - the temporary
     crewing permit leaves the master's column out because the vessel is 24 m
     or more (MO504 s 16(3)). They were prose in one "why" and recorded
     nowhere, so nothing could be checked against the order. Nothing on the
     portal works a crewing number out from them. */
  const facts = vessel.vesselFacts;
  for (const f of ["lengthMetres", "grossTonnage", "propulsionKW"] as const) {
    assert.equal(typeof facts[f], "number", f + " is a figure, not words");
    assert.ok(facts[f] > 0);
  }
  assert.match(facts.why, /MO504/, "with the clauses that read them");
  assert.match(vessel.evidenceKinds["crewing-permit"].why, /vesselFacts/,
    "and the table that turns on the length says where the length is written down");
  /* The figures Matthew gave (160 m, 10,000 GT, 3,730 kW) cannot be the tug
     measured the MO505 s 5 way - a tug of 3,730 kW is 30-40 m - so they read
     as the tug-and-barge unit, and Matthew has not yet said which. The file
     says whose they are and that the tug's own length and tonnage are not
     confirmed, and nothing on the portal reads a figure whose meaning is
     unconfirmed as if it were settled. The propulsion power is the tug's. */
  assert.equal(facts.confirmedForTug, false, "not yet confirmed for the tug");
  assert.match(facts.asGiven, /tug-and-barge unit/, "labelled as the unit's figures");
  assert.match(facts.asGiven, /not yet confirmed/, "and said to be unconfirmed for the tug");
  const bad = (vesselFacts: unknown) => () => checkVessel({ ...vessel, vesselFacts }, "a vessel file");
  assert.throws(bad({ ...facts, lengthMetres: "160 m" }), /"vesselFacts.lengthMetres" - it must be a number/);
  assert.throws(bad({ ...facts, grossTonnage: 0 }), /"vesselFacts.grossTonnage"/);
  assert.throws(bad({ ...facts, propulsionKW: undefined }), /"vesselFacts.propulsionKW"/);
  assert.throws(bad({ ...facts, why: "" }), /"vesselFacts.why"/);
  assert.throws(bad({ ...facts, asGiven: "" }), /"vesselFacts.asGiven" - it must be whose figures they are/);
  assert.throws(bad({ ...facts, confirmedForTug: "no" }), /"vesselFacts.confirmedForTug" - it must be true or false/);
  assert.throws(bad({ ...facts, confirmedForTug: undefined }), /"vesselFacts.confirmedForTug"/);
  const { vesselFacts: _gone, ...without } = vessel;
  assert.throws(() => checkVessel(without, "a vessel file"), /a vessel file has no usable "vesselFacts"/);
});

test("nothing on the portal reads the vessel's length or gross tonnage while they are unconfirmed for the tug", () => {
  /* The guard on the relabelling above: the two unconfirmed figures are
     read by the two checkVessels (that they are numbers) and by nothing
     else - no rule, no screen, no route. The propulsion power may be read:
     it is the tug's. Every source file the worker and the page are built
     from is looked at, bar the vessel file itself and the one place the
     worker reads it. */
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const at = join(dir, name);
      if (statSync(at).isDirectory()) { if (name !== "node_modules" && name !== "vendor" && name !== "assets") walk(at); }
      else if (/\.(ts|js|jsx|mjs|html)$/.test(name)) files.push(at);
    }
  };
  walk(join(root, "worker", "src"));
  walk(join(root, "source"));
  const readers = files
    .filter((f) => !/vessel\.ts$/.test(f) && !/tools[\\/]source\.mjs$/.test(f))
    .filter((f) => /lengthMetres|grossTonnage/.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(root.length + 1));
  assert.deepEqual(readers, [], "no source file reads lengthMetres or grossTonnage");
  assert.equal(vessel.vesselFacts.confirmedForTug, false, "which is what this guard is for while the figures stand unconfirmed");
});

test("checkVessel asks the renewal, evidence and recognition tables the same questions the rules do", () => {
  /* The two rules that hold a table (renewalNeedsProblem, evidenceKindsProblem)
     are pure and tested on their own; this is the wiring - the worker and the
     build both refuse a file whose tables would leave a blocker nobody can see
     or a cover nobody can find. */
  assert.throws(
    () => checkVessel({ ...vessel, renewalNeeds: { "QL-01": { needs: ["QL-99"], why: "MO71 Sch 4 4.2" } } }, "a vessel file"),
    /a vessel file: renewalNeeds\["QL-01"\] wants QL-99, which is not one of the vessel's columns\./,
  );
  assert.throws(
    () => checkVessel({ ...vessel, renewalNeeds: { "QL-01": { needs: ["QL-17"] } } }, "a vessel file"),
    /must say which clause the pair comes from/,
  );
  assert.throws(
    () => checkVessel({ ...vessel, evidenceKinds: { hearsay: { days: 30, from: "issued", covers: ["QL-01"], why: "nobody's" } } }, "a vessel file"),
    /a vessel file: evidenceKinds\["hearsay"\] is not one of the kinds a reading gives/,
  );
  assert.throws(
    () => checkVessel({ ...vessel, evidenceKinds: { extension: { days: 184, from: "sometime", covers: ["QL-01"], why: "MO70 s 15(3)" } } }, "a vessel file"),
    /must count its days in "from" from one of issued, expiry/,
  );
  assert.throws(
    () => checkVessel({ ...vessel, neverRecognised: { codes: ["QL-99"], why: "MO70 s 7\\(2\\)\\(b\\)" } }, "a vessel file"),
    /"neverRecognised.codes\[0\]" - it must be one of the codes in qualColumns/,
  );
  assert.throws(
    () => checkVessel({ ...vessel, registerEvidenced: { codes: ["CS-99"], why: "the office's register" } }, "a vessel file"),
    /"registerEvidenced.codes\[0\]" - it must be one of the codes in qualColumns/,
  );
  assert.deepEqual(vessel.registerEvidenced.codes, ["CS-03", "CS-04"], "the two cargo-system approvals the office keeps in a register, and nothing else");
  assert.equal(checkVessel(vessel), vessel, "the file as it is passes all three");
  // Every entry carries the clause it comes from: the law's mapping is data
  // somebody can read against the order, not a number in the code.
  for (const [code, need] of Object.entries(vessel.renewalNeeds)) {
    assert.ok(/MO\d\d/.test(need.why), code + " carries the clause it comes from");
  }
  for (const [kind, entry] of Object.entries(vessel.evidenceKinds)) {
    assert.ok(/MO\d\d/.test(entry.why), kind + " carries the clause it comes from");
  }
  assert.ok(/MO70 s 7\(2\)\(b\)/.test(vessel.neverRecognised.why), "and so does the recognition bar");
});

/* ------------------------------------------------------------------------ *
 * The medical (source/shared/medical.js): which one governs, and whether
 * the expiry printed on it is longer than the law allows for the holder's
 * age. Both rules are MO76's - s 16(3) for the first, s 16(1) and its Note
 * for the second - and a wrong answer to either puts a wrong date against a
 * man's name.
 * ------------------------------------------------------------------------ */
const MED_PEOPLE = [
  { id: "p1", name: "EVANS, Brenton", aliases: ["bRENTON"] },
  { id: "p2", name: "SITTIYOS, Kachin", aliases: [] },
];
const MED_REGISTER = crewRegister(MED_PEOPLE);
const MED_TODAY = "2026-09-25";
const MED_CODES = medicalCodesIn(vessel.certStated);
/** His medicals, newest filed first, as the library hands them over. */
const MED_ROWS = [
  { id: "f2", key: "new", person: "bRENTON", code: "QL-17", filedOn: "2026-06-02" },
  { id: "f1", key: "old", person: "EVANS, Brenton", code: "QL-17", filedOn: "2025-01-02" },
  // His Master ticket - not a medical, whatever it prints.
  { id: "f3", key: "ticket", person: "EVANS, Brenton", code: "QL-01", filedOn: "2026-01-01" },
  // Filed in his folder, printed in Kachin's name.
  { id: "f4", key: "hers", person: "EVANS, Brenton", code: "QL-17", filedOn: "2026-07-01" },
];
const MED_READINGS: Record<string, Record<string, unknown>> = {
  // Issued last, and runs the shorter time - a condition wanted re-checking.
  new: { readable: true, holderName: "Brenton Evans", issuedOn: "2026-06-01", assessedOn: "2026-05-28",
    expiresOn: "2027-06-01", conditions: "Fit for particular duties only" },
  old: { readable: true, holderName: "brenton EVANS", issuedOn: "2025-01-01", assessedOn: "2025-01-01",
    expiresOn: "2029-01-01", conditions: null },
  ticket: { readable: true, holderName: "Brenton Evans", issuedOn: "2026-01-01", expiresOn: "2031-05-26" },
  hers: { readable: true, holderName: "Kachin Sittiyos", issuedOn: "2026-06-30", expiresOn: "2028-06-30" },
};
const medicalsOf = (name: string, rows = MED_ROWS, readings = MED_READINGS) =>
  medicalOnFile(name, rows, readings, MED_REGISTER, MED_CODES);

test("the medical: the one issued last governs, even where an older one prints a later expiry", () => {
  // MO76 s 16(3): a medical expires the moment a further one is issued. The
  // old card's 2029 date died the day the new one was signed, so taking the
  // later expiry would put a man to sea on a certificate that has gone.
  assert.deepEqual(medicalCodesIn(vessel.certStated), ["QL-17"], "the medical's column is the vessel file's certStated");
  const mine = medicalsOf("EVANS, Brenton");
  assert.deepEqual(mine.map((m) => m.rowId), ["f2", "f1"], "newest issued first, whatever they print");
  assert.deepEqual(mine[0], { rowId: "f2", issuedOn: "2026-06-01", assessedOn: "2026-05-28",
    expiresOn: "2027-06-01", conditions: "Fit for particular duties only" });
  assert.deepEqual(medicalsOf("brenton evans").map((m) => m.rowId), ["f2", "f1"], "his name any way round is the same man");
  assert.equal(medicalNote(mine[0]), "Fit for particular duties only", "the condition as printed");
  assert.equal(medicalNote(mine[1]), null, "and nothing where none is printed");
  assert.deepEqual(medicalsOf("SITTIYOS, Kachin"), [], "a medical printed in his name but filed in another man's folder is not his");
  assert.deepEqual(medicalsOf("EVANS, Brenton", MED_ROWS.slice(2)), [], "no medical, nothing - his ticket is not one");
});

test("the medical: a printed expiry longer than the law allows for the holder's age, and never a guess", () => {
  /* MO76 s 16(1) and Note: two years at most, one year where the person was
     18 or younger or 55 or older on the day of the examination. The Note's
     edges are "not more than 18" and "at least 55", so exactly 18 and
     exactly 55 are in the one-year band - the office's guide reads
     "under 18/over 55" and is wrong by a year each way (report Part 7.4). */
  const med = (expiresOn: string | null, assessedOn: string | null = "2026-05-28", issuedOn: string | null = "2026-06-01") =>
    ({ rowId: "f2", issuedOn, assessedOn, expiresOn, conditions: null });
  const grown = "1990-04-01";      // 36 on the assessment day
  assert.equal(medicalTooLong(med("2028-05-28"), grown, MED_TODAY), null, "two years to the day is two years");
  assert.equal(medicalTooLong(med("2028-05-29"), grown, MED_TODAY),
    "the expiry is more than two years after the assessment", "two years and a day is not");
  // The day before his birthday he is 54, and the two-year band is his.
  assert.equal(medicalTooLong(med("2027-11-28"), "1971-05-29", MED_TODAY), null, "he turns 55 the day after the assessment: two years");
  assert.equal(medicalTooLong(med("2027-11-28"), "1971-05-28", MED_TODAY),
    "the expiry is more than a year after the assessment, and the holder was 55 or older that day", "55 on the day: one year");
  assert.equal(medicalTooLong(med("2027-05-28"), "1971-05-28", MED_TODAY), null, "a year to the day is a year");
  assert.equal(medicalTooLong(med("2027-06-28"), "2009-01-01", MED_TODAY),
    "the expiry is more than a year after the assessment, and the holder was 18 or younger that day", "17 at 13 months");
  assert.equal(medicalTooLong(med("2027-06-28"), "2008-05-28", MED_TODAY),
    "the expiry is more than a year after the assessment, and the holder was 18 or younger that day", "18 on the day is the one-year band too");
  assert.equal(medicalTooLong(med("2027-06-28"), "2007-05-28", MED_TODAY), null, "19 on the assessment day: two years");
  assert.equal(medicalTooLong(med("2028-05-29"), null, MED_TODAY), null, "no date of birth, no age, no flag");
  assert.equal(medicalTooLong(med("2028-05-29"), "", MED_TODAY), null, "nor an empty box");
  assert.equal(medicalTooLong(med("2028-05-29"), "not a date", MED_TODAY), null, "nor a box somebody typed words into");
  assert.equal(medicalTooLong(null, grown, MED_TODAY), null, "no medical, nothing");
  // Issued 1 June: two years and a day from the issue, and two years and
  // five days from the examination - so which date it is measured from shows.
  assert.equal(medicalTooLong(med("2028-06-02", null), grown, MED_TODAY),
    "the expiry is more than two years after it was issued", "no assessment date printed: measured from the issue");
  assert.equal(medicalTooLong(med("2028-06-01", null), grown, MED_TODAY), null, "two years from the issue to the day");
  assert.equal(medicalTooLong(med("2028-06-02", null, null), grown, MED_TODAY), null,
    "neither date printed: nothing to measure from");
  assert.equal(medicalTooLong(med(null), grown, MED_TODAY), null, "no printed expiry, nothing to check");
  assert.equal(medicalTooLong(med("2026-09-24"), "2009-01-01", MED_TODAY), null,
    "a medical that has already run out is on the gaps list, not here");
});

/* ------------------------------------------------------------------------ *
 * Renewal blockers (source/shared/renewals.js): a certificate in the red
 * band that cannot be renewed until another one is put right. The pairs are
 * the vessel file's (renewalNeeds), each with the clause it comes from, so
 * the law's mapping is data and not code - and the table that ships is the
 * one these hold against.
 * ------------------------------------------------------------------------ */
/* The vessel file carries the table; the worker's Vessel type gains the key
   when the round is wired to it, so until then it is read as what it is. */
const REN_TABLE = (vessel as unknown as { renewalNeeds: Record<string, { needs: string[]; why: string }> }).renewalNeeds;
const REN_TODAY = "2026-09-25";
const REN_RULES: { needs: typeof REN_TABLE | null; daysUntil: typeof daysUntil; redDays: number } =
  { needs: REN_TABLE, daysUntil, redDays: RED_DAYS };
/** A date `n` days from REN_TODAY - negative for one that has gone. */
const renDay = (n: number) => new Date(Date.parse(REN_TODAY) + n * 86400000).toISOString().slice(0, 10);
const blockersFor = (held: Record<string, string>, rules = REN_RULES) =>
  renewalBlockers("EVANS, Brenton", held, REN_TODAY, rules);

test("renewals: the pairs are the vessel file's, every code a column of it", () => {
  const codes = vessel.qualColumns.map((c) => c[0]);
  assert.equal(renewalNeedsProblem(REN_TABLE, codes), null, "this vessel's table names only its own columns");
  const example = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "fixtures", "example-vessel.json"), "utf8"));
  assert.equal(renewalNeedsProblem(example.renewalNeeds, example.qualColumns.map((c: string[]) => c[0])), null,
    "and so does the made-up vessel's");
  assert.match(String(renewalNeedsProblem({ "QL-11": { needs: ["QL-99"], why: "x" } }, codes)),
    /renewalNeeds\["QL-11"\].*QL-99.*column/, "a need that is not a column is named");
  assert.match(String(renewalNeedsProblem({ "ZZ-01": { needs: ["QL-17"], why: "x" } }, codes)),
    /renewalNeeds\["ZZ-01"\].*column/, "and so is a certificate that is not one");
  assert.match(String(renewalNeedsProblem({ "QL-11": { needs: [], why: "x" } }, codes)), /renewalNeeds\["QL-11"\]/,
    "an entry that needs nothing is a table somebody half wrote");
  // The clause travels with the pair, so a reader can check the rule against
  // the order rather than against this code.
  assert.match(String(REN_TABLE["QL-11"].why), /MO70 s 25/);
  assert.match(String(REN_TABLE["QL-01"].why), /MO71 Sch 4/);
  assert.match(String(REN_TABLE["QL-03"].why), /MO505 s 9\(3\)\(b\)/);
});

test("renewals: a cook whose safety training has lapsed cannot renew his cook certificate", () => {
  // MO70 s 25: the marine cook certificate is revalidated on a certificate of
  // safety training and a medical. His cook ticket is in the red band and the
  // COST went last month, so the renewal is stopped before it is posted.
  const cook = { "QL-11": renDay(40), "QL-12": renDay(-30), "QL-17": renDay(300) };
  assert.deepEqual(blockersFor(cook), [{
    person: "EVANS, Brenton", code: "QL-11", needs: ["QL-12"], expired: ["QL-12"], missing: [],
    why: String(REN_TABLE["QL-11"].why),
  }], "the entry names the certificate of safety training and nothing else");
  assert.deepEqual(blockersFor({ ...cook, "QL-12": renDay(300) }), [], "a current COST and medical: nothing in the way");
  assert.deepEqual(blockersFor({ ...cook, "QL-12": "Y" }), [], "an item the matrix marks held counts as held");
  const bothGone = blockersFor({ "QL-11": renDay(0), "QL-12": renDay(-30), "QL-17": "" });
  assert.deepEqual(bothGone[0].needs, ["QL-12", "QL-17"], "both, where both are in the way");
  assert.deepEqual([bothGone[0].expired, bothGone[0].missing], [["QL-12"], ["QL-17"]],
    "and which is expired and which is not held, so the line can say so");
  assert.deepEqual(blockersFor({ "QL-11": renDay(40), "QL-12": "?", "QL-17": renDay(300) })[0].missing, ["QL-12"],
    "a question mark is nobody saying yes: not held");
});

test("renewals: a deck certificate needs a medical and a GMDSS, and a certificate with time to run is never blocked", () => {
  // MO71 Sch 4 4.2. The GMDSS is a certificate class of its own (MO70
  // s 7(1)(ca)), so an empty QL-14 is a renewal that will not be granted.
  const master = { "QL-01": renDay(-10), "QL-17": renDay(300), "QL-14": "" };
  assert.deepEqual(blockersFor(master)[0].needs, ["QL-14"], "expired, with no GMDSS on file");
  assert.deepEqual(blockersFor({ ...master, "QL-14": renDay(200) }), [], "GMDSS in date: nothing in the way");
  assert.deepEqual(blockersFor({ ...master, "QL-01": renDay(RED_DAYS + 1) }), [],
    "a certificate past the red band is not being renewed yet");
  assert.deepEqual(blockersFor({ ...master, "QL-01": renDay(RED_DAYS) })[0].code, "QL-01", "the edge of the red band is in it");
  assert.deepEqual(blockersFor({ ...master, "QL-01": "" }), [], "a certificate he does not hold is a gap, not a renewal");
  assert.deepEqual(blockersFor({ ...master, "QL-01": "Y" }), [], "nor is one the matrix marks held, which never lapses");
  // MO505 s 9(3)(c): renewing Master <24 m NC or MED Grade 2 NC wants a
  // declaration of medical fitness, not a medical certificate - so neither
  // has an entry in the table and neither is ever blocked for a medical.
  assert.deepEqual(blockersFor({ "QL-08": renDay(-10), "QL-17": "" }), [], "Master <24 m NC: a declaration, and nothing the portal holds");
  assert.deepEqual(blockersFor({ "QL-09": renDay(-10), "QL-17": "" }), [], "MED Grade 2 NC the same");
  assert.deepEqual(blockersFor({ "QL-13": renDay(-10), "QL-17": "" }), [], "a code the table says nothing about is never blocked");
  assert.deepEqual(blockersFor({ "QL-01": renDay(-10) }, { ...REN_RULES, needs: null }), [],
    "no table, no blockers - never a pair written into the code");
});

/* ------------------------------------------------------------------------ *
 * Alternative evidence (source/shared/evidence.js): the five documents that
 * lawfully stand in for a certificate that has run out, each with its own
 * ceiling and the columns it may cover. The kinds are the vessel file's
 * (evidenceKinds), clause and all. Getting one wrong either hides a man
 * with nothing behind him or reds a man who is lawfully covered.
 * ------------------------------------------------------------------------ */
const EV_TABLE = (vessel as unknown as {
  evidenceKinds: Record<string, { days: number | null; from: string; covers: string[]; why: string; notWhenRecognition?: boolean }>;
}).evidenceKinds;
const EV_TODAY = "2026-09-25";
const EV_PEOPLE = [{ name: "EVANS, Brenton", aliases: ["bRENTON"] }, { name: "SITTIYOS, Kachin", aliases: [] }];
const EV_RULES = { kinds: EV_TABLE, register: crewRegister(EV_PEOPLE), nameIsSomebodyElse };
const EV_ROWS = [
  { id: "ext", key: "ext", person: "EVANS, Brenton", code: null, filedOn: "2026-08-02" },
  { id: "dec", key: "dec", person: "EVANS, Brenton", code: null, filedOn: "2026-09-01" },
  { id: "lodged", key: "lodged", person: "bRENTON", code: "QL-03", filedOn: "2026-07-01" },
  { id: "coc", key: "coc", person: "EVANS, Brenton", code: "QL-01", filedOn: "2021-02-01" },
  { id: "nc", key: "nc", person: "EVANS, Brenton", code: "QL-03", filedOn: "2020-01-01" },
];
const EV_READINGS: Record<string, Record<string, unknown>> = {
  // AMSA's letter, printing its own end date inside the six months.
  ext: { readable: true, holderName: "Brenton Evans", evidenceKind: "extension", issuedOn: "2026-07-20", expiresOn: "2026-11-25" },
  // A final assessor's declaration, signed three weeks ago.
  dec: { readable: true, holderName: "Brenton Evans", evidenceKind: "assessor-declaration", issuedOn: "2026-09-01", expiresOn: null },
  // The receipt for a near-coastal renewal lodged before the card expired.
  lodged: { readable: true, holderName: "brenton EVANS", evidenceKind: "lodged-renewal", issuedOn: "2026-07-01", expiresOn: null },
  // His certificates themselves: no evidenceKind, and both run out.
  coc: { readable: true, holderName: "Brenton Evans", evidenceKind: null, isRecognition: false, expiresOn: "2026-08-01" },
  nc: { readable: true, holderName: "Brenton Evans", evidenceKind: null, isRecognition: false, expiresOn: "2026-07-07" },
};
const coverOf = (code: string, rows = EV_ROWS, readings = EV_READINGS, today = EV_TODAY) =>
  coveredBy(code, "EVANS, Brenton", rows, readings, today, EV_RULES);

test("evidence: the five kinds are the vessel file's, each with its columns, its ceiling and its clause", () => {
  assert.deepEqual(EVIDENCE_KINDS, ["extension", "lodged-renewal", "crewing-permit", "assessor-declaration", "issue-letter"]);
  const codes = vessel.qualColumns.map((c) => c[0]);
  assert.equal(evidenceKindsProblem(EV_TABLE, codes), null, "this vessel's table names only its own columns");
  const example = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "fixtures", "example-vessel.json"), "utf8"));
  assert.equal(evidenceKindsProblem(example.evidenceKinds, example.qualColumns.map((c: string[]) => c[0])), null,
    "and so does the made-up vessel's");
  assert.match(String(evidenceKindsProblem({ "letter-from-a-mate": { days: 30, from: "issued", covers: ["QL-01"], why: "x" } }, codes)),
    /letter-from-a-mate/, "a kind the reading never gives is named");
  assert.match(String(evidenceKindsProblem({ extension: { days: 30, from: "issued", covers: ["QL-99"], why: "x" } }, codes)),
    /QL-99.*column/, "a column that is not one is named");
  assert.match(String(evidenceKindsProblem({ extension: { days: 30, from: "yesterday", covers: ["QL-01"], why: "x" } }, codes)),
    /"from"/, "and so is a ceiling counted from nowhere");
  // The COST cannot be extended (MO70 s 15(3) does not list it) and neither
  // can a recognition (s 30 note); the near-coastal grades are MO505's and
  // have no extension at all.
  assert.equal(EV_TABLE.extension.covers.includes("QL-12"), false, "no extension of a certificate of safety training");
  assert.equal(EV_TABLE.extension.notWhenRecognition, true, "and none of a certificate of recognition");
  assert.deepEqual(EV_TABLE["assessor-declaration"].covers, ["QL-08", "QL-09"], "a declaration is for the lower near-coastal grades only");
  assert.equal(EV_TABLE["lodged-renewal"].days, 90, "MO505 s 7(3): 90 days after the certificate's expiry");
  assert.equal(EV_TABLE["lodged-renewal"].from, "expiry");
  assert.equal(EV_TABLE["issue-letter"].days, null, "an issue letter is the certificate until the card arrives: no end in law");
  assert.match(EV_TABLE.extension.why, /MO70 s 15\(3\)/);
  assert.match(EV_TABLE["lodged-renewal"].why, /MO505 s 7\(3\)/);
  assert.match(EV_TABLE["assessor-declaration"].why, /MO505 ss 22-24/);
  assert.match(EV_TABLE["crewing-permit"].why, /MO504 s 16/);
  assert.match(EV_TABLE["issue-letter"].why, /MO505 s 12\(2\)/);
});

test("evidence: an extension letter covers the expired Master it was written for, and no COST ever", () => {
  assert.deepEqual(coverOf("QL-01"), { kind: "extension", until: "2026-11-25", rowId: "ext" },
    "the date AMSA printed on the letter, which is inside the six months");
  assert.equal(coverOf("QL-12"), null, "the same letter covers no certificate of safety training (MO70 s 15(3))");
  /* The round could put no code to this letter, so it stands for any column
     its kind allows. Where the round did place it, it stands for that one
     only: a letter about his Master certificate says nothing about his cook
     certificate, though the order lets both be extended. */
  const placed = [{ ...EV_ROWS[0], code: "QL-01" }, ...EV_ROWS.slice(1)];
  assert.deepEqual(coverOf("QL-01", placed), { kind: "extension", until: "2026-11-25", rowId: "ext" });
  assert.equal(coverOf("QL-11", placed), null, "not a column the letter was filed against");
  /* Unplaced it stands for any column the order lets AMSA extend - but only
     where the portal holds the certificate being extended: the six months
     run from that certificate's own printed expiry, and AMSA cannot extend a
     certificate nobody has filed. */
  assert.equal(coverOf("QL-11"), null, "no cook certificate on the portal, so nothing to extend and nothing to count from");
  // A letter printing longer than the six months the order allows.
  const tooLong = { ...EV_READINGS, ext: { ...EV_READINGS.ext, expiresOn: "2027-06-01" } };
  assert.deepEqual(coverOf("QL-01", EV_ROWS, tooLong), { kind: "extension", until: "2027-02-01", rowId: "ext" },
    "six months of extended TERM is as far as it goes: 184 days from the expiry printed on the certificate (MO70 s 15(3)-(4))");
  /* And a letter written months after the certificate lapsed extends the
     term by no more than that either. Anchored to the letter instead, this
     one would have carried him to July - eleven months past an expiry the
     order lets AMSA extend by six. */
  const late = { ...EV_READINGS, ext: { readable: true, holderName: "Brenton Evans", evidenceKind: "extension", issuedOn: "2027-01-01", expiresOn: null } };
  assert.deepEqual(coverOf("QL-01", EV_ROWS, late), { kind: "extension", until: "2027-02-01", rowId: "ext" },
    "184 days from the certificate's expiry, whenever the letter itself was written");
  // MO70 s 30 note: a recognition's term can never be extended.
  const recognised = { ...EV_READINGS, coc: { ...EV_READINGS.coc, isRecognition: true } };
  assert.equal(coverOf("QL-01", EV_ROWS, recognised), null, "an extension of a certificate of recognition is no cover");
  assert.equal(coverOf("QL-01", [EV_ROWS[3]]), null, "his certificate alone is not evidence of anything");
  const before = { ...EV_READINGS, ext: { readable: true, holderName: "Brenton Evans", issuedOn: "2026-07-20", expiresOn: "2026-11-25" } };
  assert.equal(coverOf("QL-01", EV_ROWS, before), null, "a reading made before the key existed says nothing either way");
});

test("evidence: a near-coastal renewal lodged before expiry covers 90 days and not 100", () => {
  // MO505 s 7(3). The 90 days run from the card's own printed expiry, not
  // from the day the receipt was issued, so the certificate on file is what
  // the count is anchored to.
  assert.deepEqual(coverOf("QL-03"), { kind: "lodged-renewal", until: "2026-10-05", rowId: "lodged" },
    "the card expired 80 days ago: still covered");
  const longGone = { ...EV_READINGS, nc: { ...EV_READINGS.nc, expiresOn: "2026-06-17" } };
  assert.equal(coverOf("QL-03", EV_ROWS, longGone), null, "100 days after expiry: no cover left");
  assert.equal(coverOf("QL-03", [EV_ROWS[2]]), null, "and with no card on file there is nothing to count 90 days from");
  // MO505 ss 22-24: a declaration is for the lower grades, so it never
  // reaches a Master <100 m NC.
  assert.equal(coverOf("QL-03", [EV_ROWS[1], EV_ROWS[4]]), null, "a final assessor's declaration is no cover for Master <100 m NC");
  assert.deepEqual(coverOf("QL-08", [EV_ROWS[1]]), { kind: "assessor-declaration", until: "2026-10-31", rowId: "dec" },
    "for Master <24 m NC it is, for 60 days from the day it was signed");
  const stale = { ...EV_READINGS, dec: { ...EV_READINGS.dec, issuedOn: "2026-06-01" } };
  assert.equal(coverOf("QL-08", [EV_ROWS[1]], stale), null, "a declaration whose 60 days have run out is no cover");
  /* MO505 s 7(3) gives the 90 days only where the renewal was lodged BEFORE
     the card expired. The card ran out on 7 July: a receipt dated the day
     before carries him, one dated the day after carries nothing at all. */
  const dayBefore = { ...EV_READINGS, lodged: { ...EV_READINGS.lodged, issuedOn: "2026-07-06" } };
  assert.deepEqual(coverOf("QL-03", EV_ROWS, dayBefore), { kind: "lodged-renewal", until: "2026-10-05", rowId: "lodged" });
  const dayAfter = { ...EV_READINGS, lodged: { ...EV_READINGS.lodged, issuedOn: "2026-07-08" } };
  assert.equal(coverOf("QL-03", EV_ROWS, dayAfter), null, "lodged after the card had gone: the section gives him nothing");
});

test("evidence: a paper is spent once the certificate it was written about is in hand", () => {
  /* MO505 s 12(2): AMSA's issue letter IS the certificate "until the card
     arrives". With days null and no printed end it never ran out, so once a
     letter was on file that column could never show red again - a cell the
     office must chase read as carried, for ever. The card that came of it now
     takes it off the books. */
  const letter = [
    { id: "iss", key: "iss", person: "EVANS, Brenton", code: "QL-04", filedOn: "2024-01-02" },
    { id: "card", key: "card", person: "EVANS, Brenton", code: "QL-04", filedOn: "2024-03-02" },
  ];
  const readings: Record<string, Record<string, unknown>> = {
    iss: { readable: true, holderName: "Brenton Evans", evidenceKind: "issue-letter", issuedOn: "2024-01-01", expiresOn: null },
    card: { readable: true, holderName: "Brenton Evans", evidenceKind: null, isRecognition: false, issuedOn: "2024-02-15", expiresOn: "2029-02-15" },
  };
  assert.equal(coveredBy("QL-04", "EVANS, Brenton", letter, readings, EV_TODAY, EV_RULES), null,
    "the card arrived, so the letter that announced it carries nothing");
  assert.deepEqual(coveredBy("QL-04", "EVANS, Brenton", [letter[0]], readings, EV_TODAY, EV_RULES),
    { kind: "issue-letter", until: null, rowId: "iss" }, "with no card on file it is still the certificate");
  // Neither date read off the scans: nothing is assumed either way.
  const undated = { ...readings, card: { ...readings.card, issuedOn: null } };
  assert.deepEqual(coveredBy("QL-04", "EVANS, Brenton", letter, undated, EV_TODAY, EV_RULES),
    { kind: "issue-letter", until: null, rowId: "iss" }, "a card with no issue date read off it settles nothing");
});

test("evidence: the kind a person picked at upload beats the model's guess, and names the column the paper is about", () => {
  /* A hand tag makes a document the certificate for its column, so a paper
     used to have to be filed untagged and which column it was about rested
     on the model's guess. The upload page's picker now says what paper it
     is beside the column: the rule reads that first (paperKind), and a
     letter the model read as a certificate is still the letter. */
  assert.equal(paperKind({ qualCode: "QL-01", evidenceKind: "extension" }, { evidenceKind: null }), "extension", "the person's word");
  assert.equal(paperKind({ qualCode: "QL-01", evidenceKind: null }, { evidenceKind: "extension" }), "", "a hand tag with no kind is the certificate, whatever the model called it");
  assert.equal(paperKind({ qualCode: null, evidenceKind: null }, { evidenceKind: "extension" }), "extension", "untagged, the model's word stands");
  assert.equal(paperKind({ qualCode: null, evidenceKind: " issue-letter " }, { evidenceKind: "extension" }), "issue-letter", "trimmed, and over the model");
  assert.equal(paperKind({}, null), "", "no reading, no paper");

  // The letter, tagged as an extension about his Master: the model read it
  // as a plain certificate, and it covers QL-01 all the same.
  const rows = [
    { id: "ext", key: "ext", person: "EVANS, Brenton", code: "QL-01", tagged: true, kind: "extension", filedOn: "2026-08-02" },
    EV_ROWS[3],
  ];
  const misread = { ...EV_READINGS, ext: { ...EV_READINGS.ext, evidenceKind: null } };
  assert.deepEqual(coverOf("QL-01", rows, misread), { kind: "extension", until: "2026-11-25", rowId: "ext" }, "the picked kind, over a reading that called it a certificate");
  assert.equal(coverOf("QL-11", rows, misread), null, "and only about the column it was filed against");
  // The same row with no kind picked is the certificate for QL-01: no cover.
  const certificate = [{ ...rows[0], kind: null }, EV_ROWS[3]];
  assert.equal(coverOf("QL-01", certificate), null, "a hand tag alone makes it the certificate, whatever the reading says");
});

test("evidence: a document in another man's name covers nobody, and an issue letter runs until the card comes", () => {
  const hers = [{ id: "hers", key: "hers", person: "EVANS, Brenton", code: "QL-01", filedOn: "2026-09-01" }];
  const readings = { hers: { readable: true, holderName: "Kachin Sittiyos", evidenceKind: "extension", issuedOn: "2026-09-01", expiresOn: "2026-12-01" } };
  assert.equal(coverOf("QL-01", hers, readings), null, "filed in his folder, written for another man");
  assert.equal(coveredBy("QL-01", "SITTIYOS, Kachin", hers, readings, EV_TODAY, EV_RULES), null,
    "and it is not Kachin's either: it is not filed under him");
  // MO505 s 12(2): the letter is the certificate until the card arrives, so
  // the law gives it no end and the portal invents none.
  const letter = [{ id: "iss", key: "iss", person: "EVANS, Brenton", code: "QL-04", filedOn: "2024-01-02" }];
  const issued = { iss: { readable: true, holderName: "Brenton Evans", evidenceKind: "issue-letter", issuedOn: "2024-01-01", expiresOn: null } };
  assert.deepEqual(coveredBy("QL-04", "EVANS, Brenton", letter, issued, EV_TODAY, EV_RULES),
    { kind: "issue-letter", until: null, rowId: "iss" }, "no printed date and no ceiling: covered, with no end to say");
  const dated = { iss: { ...issued.iss, expiresOn: "2024-03-01" } };
  assert.equal(coveredBy("QL-04", "EVANS, Brenton", letter, dated, EV_TODAY, EV_RULES), null,
    "where the letter prints its own end, that date governs - and this one has gone");
  assert.equal(coveredBy("QL-04", "EVANS, Brenton", letter, issued, EV_TODAY, { ...EV_RULES, kinds: null }), null,
    "no table, no cover - never a ceiling written into the code");
});

/* ------------------------------------------------------------------------ *
 * The certificate of recognition (source/shared/recognition.js): the one
 * document that counts on this vessel for a man holding a foreign ticket,
 * and the two rules that keep it honest - it can never outlive the
 * certificate it recognises (MO70 s 33(2), s 36(3), s 37(4)), and it can
 * never fill a column AMSA may not recognise into (s 7(2)(b)).
 * ------------------------------------------------------------------------ */
const RECOGNITION = {
  readable: true, isRecognition: true,
  recognises: { authority: "MCA", country: "United Kingdom", number: "UK-9921", expiresOn: "2029-03-01" },
};

test("recognition: the cell takes the earlier of the recognition and the certificate it recognises", () => {
  // The foreign certificate's printed expiry is the earlier: it governs.
  assert.deepEqual(recognisedUntil(RECOGNITION, "2030-06-30", null),
    { until: "2029-03-01", foreignUnknown: false },
    "a recognition can be revalidated only after the certificate behind it, so it never runs the longer");
  // The recognition's own is the earlier: it governs.
  assert.deepEqual(recognisedUntil(RECOGNITION, "2028-01-01", null),
    { until: "2028-01-01", foreignUnknown: false });
  // The foreign certificate itself is on the portal and runs shorter than
  // what the recognition printed: the document in hand governs.
  assert.deepEqual(recognisedUntil(RECOGNITION, "2030-06-30", "2027-05-05"),
    { until: "2027-05-05", foreignUnknown: false });
  // Nothing known about the foreign certificate at all: the cell still takes
  // the recognition's date - it is all there is - and the office is told.
  assert.deepEqual(recognisedUntil({ readable: true, isRecognition: true, recognises: null }, "2030-06-30", null),
    { until: "2030-06-30", foreignUnknown: true });
  assert.deepEqual(recognisedUntil({ readable: true, isRecognition: true, recognises: { expiresOn: "not a date" } }, null, null),
    { until: null, foreignUnknown: true }, "words somebody typed are not a date");
  assert.equal(foreignExpiryOn(RECOGNITION), "2029-03-01");
  assert.equal(foreignExpiryOn({ readable: true, isRecognition: false }), null);
  assert.equal(isRecognitionReading(RECOGNITION), true);
  assert.equal(isRecognitionReading({ readable: true }), false, "a reading made before the key existed is not a recognition");
});

test("recognition: the safety training and cook columns are never filled by one", () => {
  const barred = vessel.neverRecognised.codes;
  assert.deepEqual(barred.slice().sort(), ["QL-11", "QL-12"],
    "MO70 s 7(2)(b) recognises neither a foreign basic safety training nor a foreign cook certificate");
  assert.equal(recognitionFills("QL-12", barred), false);
  assert.equal(recognitionFills("ql-11", barred), false, "however the code was cased");
  assert.equal(recognitionFills("QL-01", barred), true);
  assert.equal(recognitionFills("QL-14", barred), true, "a recognition of GMDSS is the one on file today and still fills it");
  assert.equal(recognitionFills("QL-12", null), true, "no list, no bar - the vessel file decides, not the code");
});

test("the expiry day itself is the day a certificate stops counting (MO70 s 5(a)(iii))", () => {
  /* A certificate is held only while it is not suspended, not cancelled, and
     its expiry date "has not been reached". So the printed day is the first
     day it counts for nothing - not the last day it counts. daysUntil is a
     plain day count and answers 0 on that day; hasExpired is the rule that
     reads it, and every list that decides whether a man holds something
     reads it through that. */
  assert.equal(daysUntil("2026-09-25", "2026-09-25"), 0, "daysUntil is a day count and says nothing about the rule");
  assert.equal(hasExpired("2026-09-25", "2026-09-25"), true, "the day printed on it, and it has gone");
  assert.equal(hasExpired("2026-09-24", "2026-09-25"), true, "yesterday, and it has gone");
  assert.equal(hasExpired("2026-09-26", "2026-09-25"), false, "tomorrow, and it is still in hand today");
  // And the words the office reads say the same: "expires today" told them a
  // man could sail on a certificate that had already stopped counting.
  assert.equal(
    reminders.reminderItemLine({ person: "SITTIYOS, Kachin", code: "QL-17", title: "AMSA Medical", date: "2026-09-24", daysLeft: 0, from: [] }),
    "QL-17 AMSA Medical — expired today (24 Sep 2026)",
  );
});

test("evidence: whose paper it is, asked the way the round and the cells ask it", () => {
  /* The round (compareMatrix) and the page's cells (certificateStanding)
     hold a printed name against the folder and the register's name with
     nameIsSomebodyElse in source/shared/names.js, which accepts a single
     shared word. This rule held it by strict equality of nameOf, so a
     spelling the register cannot resolve - "Brent Evans", printed on a
     letter, with only "bRENTON" as his alias - was his paper to the round
     and nobody's to this rule. One question, asked through `rules`. */
  const letter = (holderName: string) => ({
    ext: { readable: true, holderName, evidenceKind: "extension", issuedOn: "2026-07-20", expiresOn: "2026-11-25" },
    coc: EV_READINGS.coc,
  });
  const rows = [EV_ROWS[0], EV_ROWS[3]];
  const cover = { kind: "extension", until: "2026-11-25", rowId: "ext" };
  assert.deepEqual(coverOf("QL-01", rows, letter("Brent Evans")), cover, "one shared word with the man: his, as the round says");
  assert.deepEqual(coverOf("QL-01", rows, letter("Brenton")), cover, "a one-word printed name that is his still covers");
  assert.equal(coverOf("QL-01", rows, letter("Kachin")), null, "a one-word printed name that is another man's does not");
  assert.equal(coverOf("QL-01", rows, letter("Kachin Sittiyos")), null, "nor a whole name that is another man's");
  assert.deepEqual(coverOf("QL-01", rows, letter("")), cover, "a paper naming nobody says nothing either way, as the round takes it");
  assert.equal(nameIsSomebodyElse("Brent Evans", "EVANS, Brenton", "EVANS, Brenton"), false, "the shared rule's own answer");
  assert.throws(() => coveredBy("QL-01", "EVANS, Brenton", rows, letter("Brenton"), EV_TODAY, { kinds: EV_TABLE, register: EV_RULES.register } as never),
    /nameIsSomebodyElse/, "a caller that forgets the name rule is stopped here, not found on the grid");
});

test("evidence: a hand-tagged row is the certificate, whatever kind of paper the reading calls it", () => {
  /* The round and the page's cells let a hand tag beat the model's
     evidenceKind (a tagged row fills its cell). This rule has to agree, or
     one document would be both the certificate in the cell and a paper
     covering it. `tagged` on the row is the hand tag. */
  const letter = { id: "ext", key: "ext", person: "EVANS, Brenton", code: "QL-01", tagged: true, filedOn: "2026-08-02" };
  const ticket = { id: "coc", key: "coc", person: "EVANS, Brenton", code: "QL-01", filedOn: "2021-02-01" };
  const readings: Record<string, Record<string, unknown>> = {
    ext: { readable: true, holderName: "Brenton Evans", evidenceKind: "extension", issuedOn: "2026-07-20", expiresOn: "2026-11-25" },
    coc: { readable: true, holderName: "Brenton Evans", evidenceKind: null, isRecognition: false, expiresOn: "2026-08-01" },
  };
  assert.equal(coveredBy("QL-01", "EVANS, Brenton", [letter, ticket], readings, EV_TODAY, EV_RULES), null,
    "tagged, the letter is the certificate for QL-01 and no paper: nothing covers");
  assert.deepEqual(coveredBy("QL-01", "EVANS, Brenton", [{ ...letter, tagged: false }, ticket], readings, EV_TODAY, EV_RULES),
    { kind: "extension", until: "2026-11-25", rowId: "ext" }, "untagged, it is the paper it reads as");
  /* And as the certificate it anchors the count: a lodged renewal's 90 days
     run from the expiry of the certificate on file, which a tagged paper now
     is. */
  const card = { id: "card", key: "card", person: "EVANS, Brenton", code: "QL-03", tagged: true, filedOn: "2026-01-01" };
  const receipt = { id: "lodged", key: "lodged", person: "EVANS, Brenton", code: null, filedOn: "2026-07-01" };
  const nc: Record<string, Record<string, unknown>> = {
    card: { readable: true, holderName: "Brenton Evans", evidenceKind: "issue-letter", issuedOn: "2021-07-07", expiresOn: "2026-07-07" },
    lodged: { readable: true, holderName: "brenton EVANS", evidenceKind: "lodged-renewal", issuedOn: "2026-07-01", expiresOn: null },
  };
  assert.deepEqual(coveredBy("QL-03", "EVANS, Brenton", [card, receipt], nc, EV_TODAY, EV_RULES),
    { kind: "lodged-renewal", until: "2026-10-05", rowId: "lodged" }, "90 days from the tagged document's expiry");
});

test("evidence: a recognition the round could place nowhere still bars an extension", () => {
  /* MO70 s 30 note: a certificate of recognition's term can never be
     extended. That is a fact about the certificate that ran out, so it is
     asked of any of his certificates that could be for this column - a
     recognition the round could put no code to used to leave the letter
     covering the column anyway. */
  const letter = { id: "ext", key: "ext", person: "EVANS, Brenton", code: "QL-01", filedOn: "2026-08-02" };
  const ticket = { id: "coc", key: "coc", person: "EVANS, Brenton", code: "QL-01", filedOn: "2021-02-01" };
  const unplaced = { id: "rec", key: "rec", person: "EVANS, Brenton", code: null, filedOn: "2021-02-01" };
  const readings: Record<string, Record<string, unknown>> = {
    ext: { readable: true, holderName: "Brenton Evans", evidenceKind: "extension", issuedOn: "2026-07-20", expiresOn: "2026-11-25" },
    coc: { readable: true, holderName: "Brenton Evans", evidenceKind: null, isRecognition: false, expiresOn: "2026-08-01" },
    rec: { readable: true, holderName: "Brenton Evans", evidenceKind: null, isRecognition: true, expiresOn: "2026-08-01" },
  };
  assert.deepEqual(coveredBy("QL-01", "EVANS, Brenton", [letter, ticket], readings, EV_TODAY, EV_RULES),
    { kind: "extension", until: "2026-11-25", rowId: "ext" }, "an ordinary certificate is extended as usual");
  assert.equal(coveredBy("QL-01", "EVANS, Brenton", [letter, ticket, unplaced], readings, EV_TODAY, EV_RULES), null,
    "the recognition is his, whether or not the round could name its column");
  const elsewhere = { ...unplaced, code: "QL-09" };
  assert.deepEqual(coveredBy("QL-01", "EVANS, Brenton", [letter, ticket, elsewhere], readings, EV_TODAY, EV_RULES),
    { kind: "extension", until: "2026-11-25", rowId: "ext" }, "a recognition for another column says nothing about this one");
});

test("the reader's pick of a person: a guess, two people or nobody on the register is no pick; medium needs a word in common", () => {
  const people = [{ name: "SITTIYOS, Kachin", aliases: ["bILLY"] }, { name: "JITENDER, Rohin", aliases: [] }];
  const pick = (printed: string, person: string | null, confidence: string, others: string[] = []) =>
    readerPick(printed, { person, confidence, others }, people);
  assert.deepEqual(pick("Bill", "SITTIYOS, Kachin", "high"), { person: "SITTIYOS, Kachin", line: "add" }, "sure, and nothing in common: his, and the name is to be added");
  assert.deepEqual(pick("K SITTIYOS", "SITTIYOS, Kachin", "high"), { person: "SITTIYOS, Kachin", line: "check" }, "sure, his surname and his initial: his, to be checked - an initial is not his name");  assert.deepEqual(pick("K SITTIYOS", "SITTIYOS, Kachin", "medium"), { person: "SITTIYOS, Kachin", line: "check" }, "a maybe with his surname: his, to be checked");
  assert.equal(pick("Rohin Jitender", "SITTIYOS, Kachin", "medium"), null, "a maybe with nothing in common is refused");
  assert.equal(pick("Bill", "SITTIYOS, Kachin", "low"), null, "a guess is no pick");
  assert.equal(pick("Bill", "SITTIYOS, Kachin", "high", ["JITENDER, Rohin"]), null, "never two people");
  assert.equal(pick("Bill", "ROSE, Somebody", "high"), null, "nobody on the register");
  assert.equal(pick("", "SITTIYOS, Kachin", "high"), null, "a document that prints no name is placed by nothing the reader says");
  assert.equal(pick("Bill", null, "high"), null);
  assert.equal(readAsLine("GMDSS", "SITTIYOS, Kachin", " Bill ", "add"), `GMDSS read as SITTIYOS, Kachin's — add "Bill" to their names on Crew Details`);
  assert.equal(readAsLine("GMDSS", "SITTIYOS, Kachin", "Bill", "check"), `GMDSS read as SITTIYOS, Kachin's — check, and add "Bill" to their names on Crew Details`);
  // Whose it is: the register's spelling first, and a pick never takes a
  // document from the man whose name it fits.
  assert.deepEqual(whoseCertificate("bILLY", null, "SITTIYOS, Kachin", "SITTIYOS, Kachin", people), { his: true, line: null }, "an alias is his");
  assert.deepEqual(whoseCertificate("Bill", { person: "SITTIYOS, Kachin", confidence: "high", others: [] }, "SITTIYOS, Kachin", "SITTIYOS, Kachin", people), { his: true, line: "add" });
  assert.deepEqual(whoseCertificate("Kachin Sittiyos", { person: "JITENDER, Rohin", confidence: "high", others: [] }, "SITTIYOS, Kachin", "SITTIYOS, Kachin", people), { his: true, line: null }, "the printed name is his; the pick is not asked");
  assert.deepEqual(whoseCertificate("Bill", { person: "JITENDER, Rohin", confidence: "high", others: [] }, "SITTIYOS, Kachin", "SITTIYOS, Kachin", people), { his: false, line: null }, "a pick of another man, on a name that fits neither: not his");
});

test("the reader's pick: a printed name with no word to compare shares nothing with anybody", () => {
  /* Initials only, or a script the letters A-Z do not cover, says nothing
     either way - and "nothing" is not a word in common. Sure, the pick
     stands and the office is asked to add the name; a maybe is refused. */
  const people = [{ name: "EVANS, Brenton", aliases: [] }, { name: "EVANS, Gareth", aliases: [] }, { name: "SITTIYOS, Kachin", aliases: [] }];
  const pick = (printed: string, person: string, confidence: string) => readerPick(printed, { person, confidence, others: [] }, people);
  assert.deepEqual(pick("李伟", "SITTIYOS, Kachin", "high"), { person: "SITTIYOS, Kachin", line: "add" }, "sure: his, and the name to be added");
  assert.equal(pick("李伟", "SITTIYOS, Kachin", "medium"), null, "a maybe on a name with nothing to compare is refused");
  assert.equal(pick("K. S.", "EVANS, Brenton", "medium"), null, "initials alone are no word in common");
  assert.deepEqual(readerPlaces("李伟", { person: "SITTIYOS, Kachin", confidence: "high", others: [] }, "Loose", people),
    { person: "SITTIYOS, Kachin", line: "add" }, "the refile places the sure pick, with the line");
  assert.deepEqual(whoseCertificate("李伟", { person: "SITTIYOS, Kachin", confidence: "high", others: [] }, "SITTIYOS, Kachin", "SITTIYOS, Kachin", people),
    { his: true, line: "add" }, "and the round says the line: the register does not carry the printed spelling");
});

test("the reader's pick: never two people, and a word in common that does not settle it is checked", () => {
  const two = [{ name: "EVANS, Brenton", aliases: [] }, { name: "EVANS, Gareth", aliases: [] }, { name: "SITTIYOS, Kachin", aliases: [] }, { name: "JITENDER, Rohin", aliases: [] }];
  const one = two.filter((p) => p.name !== "EVANS, Gareth");
  const pick = (printed: string, person: string, confidence: string, people = two, why = "") =>
    readerPick(printed, { person, confidence, why, others: [] }, people);
  // Two EVANSes: the register itself will not choose between them.
  assert.equal(crewRegister(two).nameOf("G. EVANS"), null);
  assert.equal(pick("G. EVANS", "EVANS, Brenton", "medium"), null, "a maybe is refused");
  assert.deepEqual(pick("G. EVANS", "EVANS, Brenton", "high"), { person: "EVANS, Brenton", line: "check" }, "sure is placed, and checked");
  assert.deepEqual(pick("EVANS", "EVANS, Gareth", "high"), { person: "EVANS, Gareth", line: "check" }, "a bare surname two men share is checked");
  // Gareth off the register: the printed given name is none of Brenton's.
  assert.equal(pick("Gareth EVANS", "EVANS, Brenton", "medium", one), null, "a given name that is none of his refuses a maybe");
  assert.deepEqual(pick("Gareth EVANS", "EVANS, Brenton", "high", one), { person: "EVANS, Brenton", line: "check" }, "and a sure pick is checked");
  assert.deepEqual(pick("D. EVANS", "EVANS, Brenton", "high", one), { person: "EVANS, Brenton", line: "check" }, "an initial that is none of his is checked");
  assert.equal(pick("D. EVANS", "EVANS, Brenton", "medium", one), null);
  // His initial, a short form or a misspelt given name can be his: a sure
  // pick on one is placed and checked, never placed quietly.
  assert.deepEqual(pick("B. EVANS", "EVANS, Brenton", "high", one), { person: "EVANS, Brenton", line: "check" });
  assert.deepEqual(pick("R. JITENDER", "JITENDER, Rohin", "high"), { person: "JITENDER, Rohin", line: "check" });
  assert.deepEqual(pick("Kachn SITTIYOS", "SITTIYOS, Kachin", "medium"), { person: "SITTIYOS, Kachin", line: "check" });
  assert.deepEqual(pick("Brenton James EVANS", "EVANS, Brenton", "high", one), { person: "EVANS, Brenton", line: null }, "a middle name beside his own is his");
  // The reader's reasons name somebody else on the register: no pick.
  assert.equal(pick("K SITTIYOS", "SITTIYOS, Kachin", "high", two, "could be Kachin or Rohin"), null);
  assert.deepEqual(pick("K SITTIYOS", "SITTIYOS, Kachin", "high", two, "Kachin, surname and initial"), { person: "SITTIYOS, Kachin", line: "check" }, "reasons naming only him leave his pick standing");

  // The round, on a row the refile labelled with a sure pick: his, with the line.
  assert.deepEqual(whoseCertificate("G. EVANS", { person: "EVANS, Brenton", confidence: "high", others: [] }, "EVANS, Brenton", "EVANS, Brenton", two),
    { his: true, line: "check" });
  assert.equal(readerPlaces("G. EVANS", { person: "EVANS, Brenton", confidence: "medium", others: [] }, "Loose", two), null);
});

test("a surname alone is not a spelling the register places on its own", () => {
  const people = [{ name: "EVANS, Brenton", aliases: ["bRENTON"] }, { name: "SITTIYOS, Kachin", aliases: ["Billy"] }];
  const reg = crewRegister(people);
  assert.equal(reg.nameOf("D. EVANS"), "EVANS, Brenton", "a folder word: the one Evans");
  assert.equal(reg.spelled("D. EVANS"), null, "a printed name: not a spelling of his");
  assert.equal(reg.spelled("Billy"), "SITTIYOS, Kachin", "an alias letter for letter is");
  assert.equal(reg.spelled("Kachin SITTIYOS"), "SITTIYOS, Kachin", "two of his words in any order are");
  // The refile with nobody picked leaves it where it is.
  assert.equal(readerPlaces("D. EVANS", { person: null, confidence: "low", others: [] }, "Loose", people), null);
  // Placed on him by a sure pick, the round still says it is to be checked:
  // the one Evans on the register is not a reading of "D. EVANS".
  assert.deepEqual(whoseCertificate("D. EVANS", { person: "EVANS, Brenton", confidence: "high", others: [] }, "EVANS, Brenton", "EVANS, Brenton", people),
    { his: true, line: "check" });
  // The office's folder is overruled by the printed name, never by the reader's memory alone.
  assert.equal(readerPlaces("Bill", { person: "EVANS, Brenton", confidence: "high", others: [] }, "SITTIYOS, Kachin", people), null,
    "a certificate in Kachin's folder printed a name that fits nobody stays his folder's question");
  assert.deepEqual(readerPlaces("Brent EVANS", { person: "EVANS, Brenton", confidence: "high", others: [] }, "SITTIYOS, Kachin", people),
    { person: "EVANS, Brenton", line: "check" }, "a printed name that shares a word with the pick moves it - checked, Brent being his only by a short form");
});

test("the reader's pick: a printed word that is another man's on Crew Details and none of his is never placed on him", () => {
  const people = [{ name: "EVANS, Brenton", aliases: ["bRENTON"] }, { name: "SITTIYOS, Kachin", aliases: [] }, { name: "JITENDER, Rohin", aliases: [] }];
  const kachin = { person: "SITTIYOS, Kachin", confidence: "high", others: [] };
  assert.equal(readerPick("R. JITENDER", kachin, people), null, "Rohin's surname and initial: no pick of Kachin, however sure");
  assert.equal(readerPick("JITENDER", kachin, people), null, "Rohin's surname alone");
  assert.equal(readerPick("Rohin", kachin, people), null, "Rohin's given name alone");
  assert.equal(readerPick("EVANS", kachin, people), null, "Evans's surname");
  // Nor on the refile's label, loose or in Kachin's own folder, nor in the round.
  assert.equal(readerPlaces("R. JITENDER", kachin, "Loose", people), null);
  assert.equal(readerPlaces("Rohin", kachin, "Loose", people), null);
  assert.equal(readerPlaces("R. JITENDER", kachin, "SITTIYOS, Kachin", people), null);
  assert.equal(readerPlaces("EVANS", kachin, "SITTIYOS, Kachin", people), null);
  assert.deepEqual(whoseCertificate("R. JITENDER", kachin, "SITTIYOS, Kachin", "SITTIYOS, Kachin", people), { his: false, line: null },
    "filed in his folder, it is still not his - and nobody is asked to add Rohin's name to his");
  assert.deepEqual(whoseCertificate("EVANS", kachin, "SITTIYOS, Kachin", "SITTIYOS, Kachin", people), { his: false, line: null });

  // A word of his beside another man's: a doubt, so sure is checked and a maybe refused.
  const brenton = (confidence: string) => readerPick("Rohin EVANS", { person: "EVANS, Brenton", confidence, others: [] }, people);
  assert.deepEqual(brenton("high"), { person: "EVANS, Brenton", line: "check" });
  assert.equal(brenton("medium"), null);

  // What the reader may still do.
  assert.deepEqual(readerPick("Bill S", kachin, people), { person: "SITTIYOS, Kachin", line: "add" }, "a name that is nobody's on the register: his, and to be added");
  assert.deepEqual(readerPlaces("Bill S", kachin, "Loose", people), { person: "SITTIYOS, Kachin", line: "add" });
  assert.deepEqual(readerPick("R. JITENDER", { person: "JITENDER, Rohin", confidence: "high", others: [] }, people), { person: "JITENDER, Rohin", line: "check" },
    "Rohin's own initial and surname are placed on Rohin");
  assert.deepEqual(readerPick("李伟", kachin, people), { person: "SITTIYOS, Kachin", line: "add" });
  assert.equal(readerPick("李伟", { ...kachin, confidence: "medium" }, people), null);
  assert.equal(readerPick("K. S.", { person: "EVANS, Brenton", confidence: "medium", others: [] }, people), null);
});

test("whose it is: a printed name Crew Details spells as another man is not the folder man's for a word in common", () => {
  /* Two EVANSes on Crew Details, "Gareth EVANS" printed, filed in Brenton's
     folder: the register says it is Gareth's, so it is not Brenton's, even
     though EVANS is his word too - whatever the reader picked. */
  const two = [{ name: "EVANS, Brenton", aliases: ["bRENTON"] }, { name: "EVANS, Gareth", aliases: [] }, { name: "SITTIYOS, Kachin", aliases: [] }];
  assert.deepEqual(whoseCertificate("Gareth EVANS", null, "EVANS, Brenton", "EVANS, Brenton", two), { his: false, line: null });
  assert.deepEqual(whoseCertificate("Gareth EVANS", { person: "EVANS, Brenton", confidence: "high", others: [] }, "bRENTON", "EVANS, Brenton", two), { his: false, line: null });
  // His own spellings are still his.
  assert.deepEqual(whoseCertificate("Brenton Evans", null, "bRENTON", "EVANS, Brenton", two), { his: true, line: null });
  assert.deepEqual(whoseCertificate("bRENTON", null, "EVANS, Brenton", "EVANS, Brenton", two), { his: true, line: null });
});

test("the reader's pick: a given name his only by a letter or two, an initial or a short form is checked, never placed quietly", () => {
  const people = [{ name: "SMITH, John", aliases: [] }, { name: "EVANS, Brenton", aliases: [] }, { name: "SITTIYOS, Kachin", aliases: [] }];
  const john = (printed: string, confidence = "high") => readerPick(printed, { person: "SMITH, John", confidence, others: [] }, people);
  assert.deepEqual(john("Joan SMITH"), { person: "SMITH, John", line: "check" }, "a letter from his given name");
  assert.deepEqual(john("Johnny SMITH"), { person: "SMITH, John", line: "check" }, "a longer form of it");
  assert.deepEqual(john("J. SMITH"), { person: "SMITH, John", line: "check" }, "his initial");
  assert.deepEqual(john("SMITH"), { person: "SMITH, John", line: "check" }, "his surname alone: less to go on than his initial, checked the same");
  assert.deepEqual(john("John"), { person: "SMITH, John", line: "check" }, "his given name alone");
  assert.deepEqual(readerPlaces("SMITH", { person: "SMITH, John", confidence: "high", others: [] }, "Loose", people), { person: "SMITH, John", line: "check" });
  assert.deepEqual(john("Joan SMITH", "medium"), { person: "SMITH, John", line: "check" }, "a maybe is checked as before");
  assert.deepEqual(readerPlaces("Joan SMITH", { person: "SMITH, John", confidence: "high", others: [] }, "Loose", people), { person: "SMITH, John", line: "check" },
    "the refile labels it with the line");
  assert.deepEqual(whoseCertificate("Joan SMITH", { person: "SMITH, John", confidence: "high", others: [] }, "SMITH, John", "SMITH, John", people),
    { his: true, line: "check" }, "and the round says it");
  // His name as Crew Details spells it decides by itself, with nothing to check.
  assert.deepEqual(whoseCertificate("John SMITH", { person: "SMITH, John", confidence: "high", others: [] }, "SMITH, John", "SMITH, John", people), { his: true, line: null });
  assert.deepEqual(john("John SMITH"), { person: "SMITH, John", line: null }, "every word his, letter for letter");
});

test("evidence: a certificate the reader placed on him bars an extension, as the round and the cells count it his", () => {
  /* A recognition printed "Bill" that the reader is sure is Evans: the round
     and the cells fill his cell from it (whoseCertificate), so the cover
     rule counts it his too, and his recognition's term is never extended. */
  const letter = { id: "ext", key: "ext", person: "EVANS, Brenton", code: "QL-01", filedOn: "2026-08-02" };
  const ticket = { id: "coc", key: "coc", person: "EVANS, Brenton", code: "QL-01", filedOn: "2021-02-01" };
  const rec = { id: "rec", key: "rec", person: "EVANS, Brenton", code: null, filedOn: "2021-02-01" };
  const readings: Record<string, Record<string, unknown>> = {
    ext: { readable: true, holderName: "Brenton Evans", evidenceKind: "extension", issuedOn: "2026-07-20", expiresOn: "2026-11-25" },
    coc: { readable: true, holderName: "Brenton Evans", evidenceKind: null, isRecognition: false, expiresOn: "2026-08-01" },
    rec: { readable: true, holderName: "Bill", evidenceKind: null, isRecognition: true, expiresOn: "2026-08-01",
      holder: { person: "EVANS, Brenton", confidence: "high", why: "Bill is Brenton", others: [] } },
  };
  assert.deepEqual(coveredBy("QL-01", "EVANS, Brenton", [letter, ticket, rec], readings, EV_TODAY, EV_RULES),
    { kind: "extension", until: "2026-11-25", rowId: "ext" }, "asked by the printed name alone, the recognition is somebody else's");
  const rules = { ...EV_RULES, whoseCertificate, people: EV_PEOPLE };
  assert.equal(coveredBy("QL-01", "EVANS, Brenton", [letter, ticket, rec], readings, EV_TODAY, rules), null,
    "weighed as the round weighs it, it is his recognition, and nothing extends it");
});
