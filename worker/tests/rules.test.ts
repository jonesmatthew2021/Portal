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
import { equivalentCode, codeFor, ModelRefusal, plainLine, OUT_OF_CREDIT, READING_UNAVAILABLE, KEY_PROBLEM } from "../src/lib/analysis.js";
import { crewFolderIn, looseIn, whoseFolder } from "../src/routes/sync.js";
import { asKey } from "../src/db/cert-home.js";
import { setEnv } from "../src/env.js";

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
   nothing at all — which reads on the screen as the library being empty. */
setEnv({
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
  assert.equal(asKey("United Operations Team/OPMS Documents"), "opms");
});

test("a man's folder inside it keeps its place", () => {
  assert.equal(asKey("United Operations Team/OPMS Documents/Kyle"), "opms/Kyle");
});

test("a folder the map says nothing about still has a key of its own", () => {
  // Not left as it was: a bare real path would be read as a key and re-rooted
  // inside the portal's own folder, where there is nothing — so the sync would
  // walk an empty folder and report that the library held no certificates.
  assert.equal(asKey("United Operations Team/Somewhere Else"), "library/United Operations Team/Somewhere Else");
});

test("a folder inside the portal's own is a plain key, as it always was", () => {
  assert.equal(asKey("United Operations Team/Crew Portal/Matrix"), "matrices");
});

test("nothing picked is nothing set, and the portal keeps its own default", () => {
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

test("an answer the portal cannot read is other, and other is never stored", () => {
  const e = new ModelRefusal(400, "<html><body>Bad Request</body></html>");
  assert.equal(e.kind, "other");
  assert.equal(plainLine(e), e.message);
  assert.equal(new ModelRefusal(400, api("not_found_error", "model: no such model")).kind, "other");
});

test("every shared sentence fits the badge whole", () => {
  // The badge under Update portal shows the first 60 characters of an error.
  for (const line of [OUT_OF_CREDIT, READING_UNAVAILABLE, KEY_PROBLEM]) assert.ok(line.length <= 60, line);
});
