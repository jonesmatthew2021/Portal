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
import { equivalentCode, codeFor } from "../src/lib/analysis.js";

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
