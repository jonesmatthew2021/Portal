/**
 * The portal's own rules, proved on every run.
 *
 * The names rule (crewRegister), the certificates' answer laid over the
 * matrix (applySettled), the office's spelling of a name (canonicalName) and
 * the three-way merge that stops one tab writing its stale matrix over
 * another's (mergeQuals) are pure functions inside the page. Each has been
 * got wrong once — a spelling that stopped matching, a run that took back
 * what it had filled in, a matrix that flipped between two tabs — and each
 * time it was the crew's dates that paid. So they are run here against the
 * cases that went wrong, on the code that ships, before anything deploys.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const NL = String.fromCharCode(10);

/* The whole portal, compiled by the same Babel the checks use, run once with
 * the browser stubbed out, and the functions under test handed back. Nothing
 * is re-implemented or hand-extracted: the code under test is the code that
 * ships. Same harness as insert-rows.test.mjs. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const { portalJsx, serviceWorkerSource } = await import("file:///" + ROOT.replaceAll(" ", "%20") + "/tools/source.mjs");
/* The matrix rules and the register the worker imports, imported the same
 * way, so what a round takes back is proved on the module and not only
 * through the page. */
const rules = await import(pathToFileURL(join(ROOT, "source", "shared", "matrix-rules.js")).href);
const names = await import(pathToFileURL(join(ROOT, "source", "shared", "names.js")).href);
const require = createRequire(ROOT + "/tools/package.json");
const babel = require("@babel/standalone");
const js = babel.transform(portalJsx(), { presets: ["react"], compact: false }).code;

const stubEl = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => "" : stubEl), apply: () => stubEl });
const hook = (v) => [v, () => {}];
const ReactStub = {
  Component: class {},
  createContext: () => ({ Provider: stubEl, Consumer: stubEl }),
  createElement: () => null, Fragment: {}, useState: hook, useEffect: () => {},
  useMemo: (f) => { try { return f(); } catch (e) { return undefined; } },
  useRef: (v) => ({ current: v }), useContext: () => ({}), useCallback: (f) => f,
};
const documentStub = {
  getElementById: () => ({}), createElement: () => ({ style: {}, getContext: () => ({}) }),
  addEventListener: () => {}, head: { appendChild: () => {} }, body: { appendChild: () => {} },
  documentElement: { style: {} }, querySelectorAll: () => [], querySelector: () => null,
};
const windowStub = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
  addEventListener: () => {}, location: { href: "", protocol: "https:", pathname: "/" },
  history: {}, navigator: { onLine: true }, innerWidth: 1400,
};
const sessionStub = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const fn = new Function(
  "React", "ReactDOM", "XLSX", "window", "document", "navigator", "location",
  "sessionStorage", "localStorage", "addEventListener", "fetch", "setInterval",
  "setTimeout", "clearInterval", "clearTimeout", "requestAnimationFrame", "alert",
  "confirm", "Notification", "Image", "Audio", "ResizeObserver", "FileReader",
  "XMLHttpRequest", "performance", "screen", "history",
  js + NL + ";return { crewRegister, applySettled, settleRound, nameLetters, registerWords, canonicalName, rankGroupAt, RANK_GROUPS, ROSTER_RANKS, mergeQuals, filedUnderSuffix, waitForRound, shouldTabRound, mergeSaved, afterMergedSave, mergeHistory, mergeFilled, mergeSeen, mergePending, saveState, loadState, saveTryAgainIn, settledKeys, missesInARow, roundAnswerPhase, progressAccept, pullNowStep, doneEyebrow, doneWindowLines, PULL_LATE_NOTE, freshPull, cutOffSwitch, CUT_OFF, runCleared, queueRound, roundBusyTitle, ROUND_BUSY, matrixLastMoved, fileSpreadsheetSend, fileSpreadsheetStep, fileSpreadsheetAttempt, fileSpreadsheetOutcome, matrixFreshAt, accountLine, badgeShouldClear, crewUploadNote, OUT_OF_CREDIT, READING_UNAVAILABLE, KEY_PROBLEM, crewRowsOnly, VESSEL, swingCrewWord, swingCrewCalled, cacheable, cacheName, keepable, isCachedAnswer, anotherPerson, FETCHED_AT_HEADER, networkWait, NETWORK_WAIT_MS, API_WAIT_MS, forgetsOn, earlierPortalCache, offlineLine, controlsLocked, offlineAfterPull, signInOverAfterPull, showPicker, forgetsBefore, identityUnproven, keepIdentityAfterControl, keepIdentityOnceControlled, reloadToBeControlled, SIGNED_IN_MESSAGE, bandFor, daysTo, daysUntil, RED_DAYS, AMBER_DAYS, TODAY, REMINDER_DEFAULTS, reminderSetting, expiringWithin, byPerson, recipientsFor, reminderDue, reminderOwed, reminderItemLine, reminderText, summaryText, ReminderSwitch, MatrixPerson, DownloadPDF, particularsFor, fillParticulars, mergeParticulars, msicCodeIn, newestCard, isMsicCard, ticketCodesIn, openToCertificates, reminderLineFor, coveredCells, coveredCodes, unitCodesIn, unitColumnsIn, recognisedUntil, recognitionFills, foreignExpiryOn, isRecognitionReading, certCoverFor, coverLine, bandWithCover, medicalCodesIn, medicalOnFile, medicalTooLong, medicalNote, renewalBlockers, renewalNeedsProblem, coveredBy, evidenceKindsProblem, paperKind, EVIDENCE_KINDS, EVIDENCE_LABELS, marineOrderLines, filedAsLines, notOnMatrixLines, filedCodeIn, filedAsLine, tagWarning, readingLines, placedLine, readAsLine, matrixHeadOffset, headPixels, scrollPair, rosterSwing, rosterPeopleFor, swingAt };",
);
const lib = fn(
  ReactStub, { createRoot: () => ({ render: () => {} }) }, {}, windowStub, documentStub,
  windowStub.navigator, windowStub.location, sessionStub, sessionStub, () => {}, async () => ({ ok: false }),
  () => 0, () => 0, () => {}, () => {}, () => 0, () => {}, () => false,
  function N() {}, function I() {}, function A() {}, class { observe() {} }, function F() {},
  function X() {}, { now: () => 0 }, {}, {},
);

let failed = 0;
const is = (got, want, what) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error("FAIL: " + what + NL + "      wanted " + JSON.stringify(want) + NL + "      got    " + JSON.stringify(got)); }
};

/* ---- the register: one name each, answered to any way round ---- */
{
  const people = [
    { name: "EVANS, Brenton", aliases: ["Brent Evans"] },
    { name: "EVDOKIMOV, Evgeny", aliases: [] },
    { name: "ROSE, Matthew" },
    { name: "JONES, Matthew" },
    { name: "BENNETT, Matthew" },
    { name: "COOK, Sam" },
  ];
  const reg = lib.crewRegister(people);
  is(reg.nameOf("EVANS, Brenton"), "EVANS, Brenton", "the register's own spelling answers");
  is(reg.nameOf("evans, brenton"), "EVANS, Brenton", "case and punctuation do not matter");
  is(reg.nameOf("Brent Evans"), "EVANS, Brenton", "an alias answers to the man it is listed against");
  is(reg.nameOf("BRENTON EVANS"), "EVANS, Brenton", "the same words the other way round answer");
  is(reg.nameOf("Evgeny EVDOKIMOV"), "EVDOKIMOV, Evgeny", "surname in capitals, put second, still answers");
  is(reg.nameOf("SAM"), "COOK, Sam", "one word answers when exactly one man has it");
  is(reg.nameOf("MATTHEW"), null, "one word with three men behind it is a question, not a match");
  is(reg.nameOf("Matthew"), null, "…whatever the case");
  is(reg.nameOf("Nobody Here"), null, "a stranger is not matched to anyone");
  is(reg.knows("BRENTON EVANS"), true, "knows() agrees with nameOf()");
  is(reg.knows("EVANS"), true, "a surname alone answers where only one man has it");
  is(lib.crewRegister([]).nameOf("SAM"), null, "an empty register knows nobody");
  is(lib.crewRegister([{ name: "COOK, Sam" }, { name: "SMITH, Sam" }]).nameOf("SAM"), null, "two Sams: no match");
}

/* ---- the office's way of writing a name ---- */
{
  is(lib.canonicalName("Evgeny EVDOKIMOV"), "EVDOKIMOV, Evgeny", "capitals say which word is the surname");
  is(lib.canonicalName("ASANGE,Kyle"), "ASANGE, Kyle", "a comma with no space is tidied");
  is(lib.canonicalName("brenton evans"), "EVANS, Brenton", "with nothing to go on, the last word is the surname");
  is(lib.canonicalName("  ROSE ,  matthew  "), "ROSE, Matthew", "stray spaces go");
  is(lib.canonicalName("Sam"), "Sam", "one word is left as one word");
  is(lib.canonicalName(""), "", "nothing in, nothing out");
}

/* ---- ranks: every one the pickers offer has a heading ---- */
{
  const homeless = lib.ROSTER_RANKS.filter((r) => lib.rankGroupAt(r) >= lib.RANK_GROUPS.length);
  is(homeless, [], "every roster rank sits under a heading on Crew Details");
  is(lib.registerWords("M. JONES"), ["JONES"], "initials are dropped from the words of a name");
  is(lib.nameLetters("Evans, Brenton"), "EVANSBRENTON", "letters only, upper case");
}

/* ---- the certificates' answer laid over the matrix ---- */
{
  const quals = {
    cols: [["QL-01", "Master"], ["QL-17", "Medical"]],
    rows: [
      ["EVANS, Brenton", "Master", "", ["2031-05-26", "2028-02-02"]],
      ["ROSE, Matthew", "CHIEF OFFICER", "", ["", "2027-01-30"]],
    ],
  };
  const out = lib.applySettled(quals, [
    { person: "rose, matthew", code: "QL-01", value: "2030-09-11" },   // fills an empty cell
    { person: "EVANS, Brenton", code: "QL-17", clear: true },          // takes a date back
    { person: "EVANS, Brenton", code: "QL-01", value: "2031-05-26" },  // agrees with what is there
    { person: "NOBODY, Here", code: "QL-01", value: "2030-01-01" },    // not on the matrix: skipped
    { person: "ROSE, Matthew", code: "ZZ-99", value: "2030-01-01" },   // no such column: skipped
    { person: "ROSE, Matthew", code: "QL-17", clear: true },           // takes a second date back
  ]);
  is(out.next.rows[1][3][0], "2030-09-11", "a settled date lands in the right cell");
  is(out.next.rows[0][3][1], "", "clear:true empties the cell");
  is(out.next.rows[0][3][0], "2031-05-26", "a date that agrees is left as it is");
  is(out.next.rows.length, 2, "nobody is invented");
  is(out.applied.map((a) => a.person + " " + a.code + " " + a.from + ">" + a.to),
    ["ROSE, Matthew QL-01 >2030-09-11", "EVANS, Brenton QL-17 2028-02-02>", "ROSE, Matthew QL-17 2027-01-30>"],
    "applied lists exactly what moved, in order");
  is([...out.only].sort(), ["EVANS, BRENTON|QL-01", "EVANS, BRENTON|QL-17", "ROSE, MATTHEW|QL-01", "ROSE, MATTHEW|QL-17"],
    "only holds every cell the certificates spoke for, cleared ones included");
  is(quals.rows[1][3][0], "", "the matrix handed in is not written on");

  const same = lib.applySettled(out.next, [{ person: "ROSE, Matthew", code: "QL-17", clear: true }]);
  is(same.applied, [], "clearing a cell already cleared moves nothing");
  is(same.next.rows[1][3][1], "", "…but the cell is empty either way");
}

/* ---- three copies of the matrix, brought back to one ---- */
{
  const base = {
    cols: [["QL-01", "Master"], ["QL-17", "Medical"]],
    rows: [
      ["EVANS, Brenton", "Master", "", ["2031-05-26", "2028-02-02"]],
      ["ROSE, Matthew", "CHIEF OFFICER", "", ["2030-09-11", "2027-01-30"]],
    ],
  };
  const copy = (q) => JSON.parse(JSON.stringify(q));

  // This tab changed Evans's medical; the other tab changed Rose's master.
  const mine = copy(base); mine.rows[0][3][1] = "2029-01-01";
  const theirs = copy(base); theirs.rows[1][3][0] = "2032-02-02";
  const out = lib.mergeQuals(base, mine, theirs);
  is(out.rows[0][3][1], "2029-01-01", "my change lands");
  is(out.rows[1][3][0], "2032-02-02", "their change is kept");
  is(out.rows[1], theirs.rows[1], "a row I did not touch is the very object the server sent");
  is(theirs.rows[0][3][1], "2028-02-02", "the server's copy is not written on");

  // The other tab added a man; this tab added a different one.
  const mine2 = copy(base); mine2.rows.push(["COOK, Sam", "COOK", "", ["", "2028-08-08"]]);
  const theirs2 = copy(base); theirs2.rows.push(["JONES, Matthew", "MASTER", "", ["2030-01-01", ""]]);
  const out2 = lib.mergeQuals(base, mine2, theirs2);
  is(out2.rows.map((r) => r[0]), ["EVANS, Brenton", "ROSE, Matthew", "JONES, Matthew", "COOK, Sam"],
    "a row they added is kept and a row I added is appended");
  is(out2.rows[3][3], ["", "2028-08-08"], "my new man's dates come with him");

  // The other tab took a man off; my old copy still has him. He stays off.
  const theirs3 = copy(base); theirs3.rows.splice(1, 1);
  const out3 = lib.mergeQuals(base, copy(base), theirs3);
  is(out3.rows.map((r) => r[0]), ["EVANS, Brenton"], "a man the other tab took off is not put back by a stale copy");

  // The same cell changed on both sides: mine wins, because mine is the
  // change actually being saved.
  const mine4 = copy(base); mine4.rows[0][3][0] = "2033-03-03";
  const theirs4 = copy(base); theirs4.rows[0][3][0] = "2034-04-04";
  is(lib.mergeQuals(base, mine4, theirs4).rows[0][3][0], "2033-03-03", "the same cell changed twice: the save in hand wins");

  // Nothing changed here: the answer is theirs, untouched.
  const out5 = lib.mergeQuals(base, copy(base), theirs);
  is(out5.rows, theirs.rows, "with nothing changed on my side, theirs comes back as it is");

  // No base at all (a tab that never loaded, which the save loop does not
  // let happen — but the function must still answer safely): every filled
  // cell of mine lands, and where mine is empty theirs is left alone.
  const mine6 = copy(mine); mine6.rows[1][3][0] = "";
  const out6 = lib.mergeQuals(null, mine6, theirs);
  is(out6.rows[0][3][1], "2029-01-01", "without a base, my filled cells still land");
  is(out6.rows[1][3][0], "2032-02-02", "…and an empty cell of mine does not blank theirs");
}

/* ---- what a round takes back: only what the portal filled and nothing
        still claims, and never while anything is unread ---- */
{
  const filled = { "A::QL-01": true, "B::QL-02": true };

  const waiting = rules.settleRound({ filledFromCert: filled, claimed: ["A::QL-01"], unread: 3, settled: [] });
  is(waiting.orphans, [], "with scans still unread, nothing is called abandoned");
  is(Object.keys(waiting.noteNow).sort(), ["A::QL-01", "B::QL-02"], "…and the note keeps every cell it had");
  is(waiting.settled, [], "…and nothing is added to the settled list");

  const done = rules.settleRound({ filledFromCert: filled, claimed: ["A::QL-01"], unread: 0, settled: [] });
  is(done.orphans, ["B::QL-02"], "a filled cell no certificate claims is an orphan once everything is read");
  is(done.settled, [{ person: "B", code: "QL-02", value: "", clear: true }], "the orphan is cleared in the same write");
  is(Object.keys(done.noteNow), ["A::QL-01"], "the orphan drops out of the note");

  const given = [{ person: "c", code: "ql-03", value: "2030-01-01" }];
  const added = rules.settleRound({ filledFromCert: filled, claimed: ["A::QL-01", "B::QL-02"], unread: 0, settled: given });
  is(Object.keys(added.noteNow).sort(), ["A::QL-01", "B::QL-02", "C::QL-03"], "a settled date is noted under its key, upper-cased");
  is(added.settled.length, 1, "nothing was orphaned");
  is(given.length, 1, "the settled list handed in is not written on");
}

/* ---- a date comes off only on its second sighting as an orphan, and a
        value settled this round always beats a clearing ---- */
{
  const filled = { "A::QL-01": true, "B::QL-02": true };
  const first = rules.settleRound({ filledFromCert: filled, claimed: ["A::QL-01"], unread: 0, settled: [], seenBefore: {}, now: "2026-09-24T03" });
  is(first.orphans, [], "an orphan seen for the first time is not cleared");
  is(first.settled, [], "…so nothing is added to the settled list");
  is(first.seenNow, { "B::QL-02": "2026-09-24T03" }, "…but it is noted, with the hour it was seen");
  is(Object.keys(first.noteNow).sort(), ["A::QL-01", "B::QL-02"], "…and it stays in the note of filled cells");

  const second = rules.settleRound({ filledFromCert: filled, claimed: ["A::QL-01"], unread: 0, settled: [], seenBefore: first.seenNow, now: "2026-09-24T04" });
  is(second.orphans, ["B::QL-02"], "seen again the next round, it is cleared");
  is(second.settled, [{ person: "B", code: "QL-02", value: "", clear: true }], "…in the same write");
  is(Object.keys(second.noteNow), ["A::QL-01"], "…and drops out of the note");

  const back = rules.settleRound({ filledFromCert: filled, claimed: ["A::QL-01", "B::QL-02"], unread: 0, settled: [], seenBefore: first.seenNow, now: "2026-09-24T04" });
  is(back.orphans, [], "claimed again in between, it is not cleared");
  is(back.seenNow, {}, "…and drops out of the sightings");

  const valued = rules.settleRound({ filledFromCert: filled, claimed: ["A::QL-01"], unread: 0,
    settled: [{ person: "b", code: "ql-02", value: "2030-01-01" }], seenBefore: first.seenNow, now: "2026-09-24T04" });
  is(valued.orphans, [], "a value settled for the cell this round means it is not an orphan at all");
  is(valued.settled, [{ person: "b", code: "ql-02", value: "2030-01-01" }], "…and the value is what goes out");
  is(valued.seenNow, {}, "…and it is not a sighting either");

  const both = rules.settleRound({ filledFromCert: {}, claimed: [], unread: 0,
    settled: [{ person: "C", code: "QL-03", value: "2030-01-01" }, { person: "C", code: "QL-03", clear: true }] });
  is(both.settled.map((x) => !!x.clear), [true, false], "clears go first and values after, so a value always has the last word");
}

/* ---- the rename race: the note under the old spelling, the claim under
        the new, and a value for the cell this round ---- */
{
  const reg = names.crewRegister([{ name: "SITTIYOS, Kachin", aliases: ["bILLY"] }]);
  const race = rules.settleRound({
    filledFromCert: { "BILLY::QL-01": true },
    claimed: ["SITTIYOS, KACHIN::QL-01"],
    unread: 0,
    settled: [{ person: "SITTIYOS, Kachin", code: "QL-01", value: "2031-02-17" }],
    seenBefore: { "BILLY::QL-01": "2026-09-24T03" },
    now: "2026-09-24T04",
    nameOf: reg.nameOf,
  });
  is(race.orphans, [], "the note under the old spelling is the same cell as the claim under the new: no clear");
  is(race.settled, [{ person: "SITTIYOS, Kachin", code: "QL-01", value: "2031-02-17" }], "the value stands");
  is(Object.keys(race.noteNow), ["SITTIYOS, KACHIN::QL-01"], "the note is re-keyed under the register's name");
  is(race.seenNow, {}, "nothing is a sighting");
  const quals = { cols: [["QL-01", "Master"]], rows: [["bILLY", "Cook", "", ["2031-02-17"]]] };
  const laid = rules.applySettled(quals, race.settled, reg.nameOf);
  is(laid.next.rows[0][3][0], "2031-02-17", "the cell keeps the value");
}

/* ---- a held or half-read round is no sighting either way: the note of
        orphans seen carries through unchanged ---- */
{
  const filled = { "A::QL-01": true, "B::QL-02": true, "C::QL-03": true };
  const seen = { "B::QL-02": "2026-09-24T03", "C::QL-03": "2026-09-24T03" };
  const held = rules.settleRound({ filledFromCert: filled, claimed: ["A::QL-01"], unread: 1, settled: [], seenBefore: seen, now: "2026-09-24T04" });
  is(held.orphans, [], "nothing is cleared while anything is unread");
  is(held.seenNow, seen, "…and the sightings are carried through, not forgotten");
  const claimedBack = rules.settleRound({ filledFromCert: filled, claimed: ["A::QL-01", "C::QL-03"], unread: 1, settled: [], seenBefore: seen, now: "2026-09-24T04" });
  is(claimedBack.seenNow, { "B::QL-02": "2026-09-24T03" }, "a cell claimed again in the meantime still drops out of the sightings");
  const reg = names.crewRegister([{ name: "SITTIYOS, Kachin", aliases: ["bILLY"] }]);
  const respelt = rules.settleRound({ filledFromCert: { "BILLY::QL-01": true }, claimed: [], unread: 1, settled: [],
    seenBefore: { "BILLY::QL-01": "2026-09-24T03" }, now: "2026-09-24T04", nameOf: reg.nameOf });
  is(respelt.seenNow, { "SITTIYOS, KACHIN::QL-01": "2026-09-24T03" }, "…carried through under the register's name");
}

/* ---- two rows the register reads as one man: the row spelt as the settled
        name, else the first - the rule the workbook writer uses too ---- */
{
  const reg = names.crewRegister([{ name: "EVANS, Brenton", aliases: ["bRENTON"] }]);
  const quals = {
    cols: [["QL-01", "Master"]],
    rows: [
      ["bRENTON", "Master", "", [""]],
      ["EVANS, Brenton", "Master", "", [""]],
    ],
  };
  const exact = rules.applySettled(quals, [{ person: "EVANS, Brenton", code: "QL-01", value: "2031-05-26" }], reg.nameOf);
  is(exact.next.rows.map((r) => r[3][0]), ["", "2031-05-26"], "the row spelt as the settled name takes the date");
  const first = rules.applySettled(quals, [{ person: "Brenton Evans", code: "QL-01", value: "2031-05-26" }], reg.nameOf);
  is(first.next.rows.map((r) => r[3][0]), ["2031-05-26", ""], "with neither spelt that way, the first of his rows takes it");

  /* The same spelling twice - a man pasted onto the matrix twice - lands on
     the first of the two, which is the line the workbook writer finds too;
     the second is never written on. */
  const twice = {
    cols: [["QL-01", "Master"]],
    rows: [
      ["EVANS, Brenton", "Master", "", [""]],
      ["EVANS, Brenton", "Master", "", [""]],
    ],
  };
  const dup = rules.applySettled(twice, [{ person: "EVANS, Brenton", code: "QL-01", value: "2031-05-26" }], reg.nameOf);
  is(dup.next.rows.map((r) => r[3][0]), ["2031-05-26", ""], "a duplicated spelling takes the first row");
  const dupPage = lib.applySettled(twice, [{ person: "EVANS, Brenton", code: "QL-01", value: "2031-05-26" }]);
  is(dupPage.next.rows.map((r) => r[3][0]), ["2031-05-26", ""], "…in the page's copy as well");
}

/* ---- a settled date finds its row through the register's name ---- */
{
  /* The real register, not a stand-in: its nameOf answers null for anyone it
     does not know, and a stand-in that never did once hid a bug where every
     stranger's row was keyed "NULL" and their dates all fell on one row. */
  const reg = names.crewRegister([{ name: "SITTIYOS, Kachin", aliases: ["bILLY"] }]);
  is(reg.nameOf("SMITH, John"), null, "the register answers null for a stranger");
  const quals = {
    cols: [["QL-01", "Master"], ["QL-17", "Medical"]],
    rows: [
      ["SMITH, John", "Master", "", ["2026-01-01", ""]],     // not on the register
      ["JONES, Ann", "Mate", "", ["2027-01-01", ""]],        // not on the register either
      ["bILLY", "Cook", "", ["", "2026-01-11"]],             // the register's SITTIYOS, Kachin
    ],
  };
  const out = rules.applySettled(quals, [
    { person: "SITTIYOS, Kachin", code: "QL-01", value: "2031-02-17" },
    { person: "SMITH, John", code: "QL-01", value: "2031-01-01" },
  ], reg.nameOf);
  is(out.next.rows[2][3][0], "2031-02-17", "the date lands on the row the spreadsheet calls bILLY");
  is(out.next.rows[2][0], "bILLY", "the row keeps its name as written");
  is(out.next.rows[0][3][0], "2031-01-01", "a man the register does not know keeps his own row");
  is(out.next.rows[1][3][0], "2027-01-01", "…and the other stranger's row is not written on");
  is(out.applied.map((a) => a.person), ["bILLY", "SMITH, John"], "what moved is reported under the row's own name");
  is([...out.only].sort(), ["BILLY|QL-01", "SMITH, JOHN|QL-01"],
    "only is keyed by the row's name, which is the name the workbook writer looks for");
}

/* ---- a workbook filed under the next suffix keeps that name: the page
        never renames it back onto the name the replace stepped round ---- */
{
  const wanted = "20260924 - CREW QUALIFICATION EXPIRY.xlsx";
  is(lib.filedUnderSuffix(wanted, "20260924 - CREW QUALIFICATION EXPIRY (2).xlsx"), true, "the next suffix is the wanted name, taken");
  is(lib.filedUnderSuffix(wanted, "20260924 - CREW QUALIFICATION EXPIRY (12).xlsx"), true, "…whatever the number");
  is(lib.filedUnderSuffix(wanted, wanted), false, "the name itself is not a suffix of itself");
  is(lib.filedUnderSuffix(wanted, "20260923 - CREW QUALIFICATION EXPIRY (2).xlsx"), false, "another day's name is not it");
  is(lib.filedUnderSuffix(wanted, "20260924 - CREW QUALIFICATION EXPIRY (2).xlsm"), false, "nor another kind of file");
  is(lib.filedUnderSuffix(wanted, "20260924 - CREW QUALIFICATION EXPIRY (two).xlsx"), false, "a bracket that is not a number is a different name");
}

/* ---- the page waits for the worker's hour to let go of the workbook
        before its own round, a look at a time, and goes on once it has ---- */
{
  /* The same compiled page, with a portal that says the round is running
     for two looks and then not - under the hour's name, then a person's,
     as the lease passes between them mid-wait - and a clock that does not
     wait. */
  let looks = 0;
  const running = async () => ({ ok: true, json: async () => (++looks < 3 ? { running: true, holder: looks === 1 ? "the round on the hour" : "Kachin" } : { running: false, holder: null }) });
  const page = fn(
    ReactStub, { createRoot: () => ({ render: () => {} }) }, {}, windowStub, documentStub,
    windowStub.navigator, windowStub.location, sessionStub, sessionStub, () => {}, running,
    () => 0, (f) => { f(); return 0; }, () => {}, () => {}, () => 0, () => {}, () => false,
    function N() {}, function I() {}, function A() {}, class { observe() {} }, function F() {},
    function X() {}, { now: () => 0 }, {}, {},
  );
  let waited = 0;
  const seen = [];
  is(await page.waitForRound(() => waited++, (running, holder) => seen.push([running, holder])), true, "the lease came free and the page may go on");
  is(looks, 3, "it looked until the portal said the round had finished");
  is(waited, 2, "…and said it was waiting each time it was not");
  is(seen, [[true, "the round on the hour"], [true, "Kachin"], [false, null]],
    "…and told the provider what every look found, the holder's name at each look and the last look included, so the buttons are held under whoever has it and come back");
  is(await lib.waitForRound(), true, "a portal that cannot say counts as free: the request itself is what gets refused");
  const told = [];
  is(await lib.waitForRound(undefined, (running) => told.push(running)), true, "…and the page may go on");
  is(told, [false], "…and the provider is told it is free, so the buttons never stay down on a portal that cannot say");
}

/* ---- a save that never got there is tried again; one the server refused
        is not; a slice changed again while its save was in the air stays
        unsaved ---- */
{
  const answering = (status) => async () => ({ ok: false, status, text: async () => "{}" });
  const pageWith = (fetchStub) => fn(
    ReactStub, { createRoot: () => ({ render: () => {} }) }, {}, windowStub, documentStub,
    windowStub.navigator, windowStub.location, sessionStub, sessionStub, () => {}, fetchStub,
    () => 0, () => 0, () => {}, () => {}, () => 0, () => {}, () => false,
    function N() {}, function I() {}, function A() {}, class { observe() {} }, function F() {},
    function X() {}, { now: () => 0 }, {}, {},
  );
  const page = (status) => pageWith(answering(status));
  const thrown = async (p, data) => { try { await p.saveState(data, 1); return null; } catch (e) { return e; } };
  const tried = (status) => thrown(page(status), {});
  const e500 = await tried(500);
  is(e500 && e500.status, 500, "a save the server fell over on carries the status");
  is(lib.saveTryAgainIn(e500), 15000, "…and is tried again in fifteen seconds");
  const e413 = await tried(413);
  is(e413 && e413.status, 413, "a save the server refused carries the status");
  is(lib.saveTryAgainIn(e413), 0, "…and is not tried again: it would be refused again");
  /* The browser throws a TypeError both for a fetch that never got there
     and for a slip in the tab's own code, so the save loop cannot go by
     the name: saveState marks the one that never left with a status of 0. */
  const offline = pageWith(async () => { throw new TypeError("Failed to fetch"); });
  const e0 = await thrown(offline, {});
  is(e0 && e0.status, 0, "a save that never got there (offline) carries a status of 0");
  is(e0 && e0.message, "Failed to fetch", "…and the browser's own words");
  is(lib.saveTryAgainIn(e0), 15000, "…and is tried again in fifteen seconds");
  /* A load that failed carries whether an answer came and the stamp on it,
     read before the status, so the pull can end offline mode on a live
     failure (the link is up, the server in trouble) and not on a kept one
     (offlineAfterPull). Before this the stamp was read after the status,
     and only a live 200 brought the portal back online. */
  const headers = (o) => ({ get: (k) => (k in o ? o[k] : null) });
  const STAMP = "2026-09-24T06:32:00.000Z";
  const loadFailed = async (p) => { try { await p.loadState(); return null; } catch (e) { return e; } };
  const live503 = await loadFailed(pageWith(async () => ({ ok: false, status: 503, headers: headers({}) })));
  is(live503 && live503.answered, true, "a load the server fell over on says an answer came");
  is(live503 && live503.fetchedAt, null, "…a live one, with no stamp");
  is(live503 && live503.message, "Couldn't load the portal (503)", "…with the status in its words for the badge");
  is(lib.offlineAfterPull(STAMP, live503.answered, live503.fetchedAt), null, "…and a live 503 ends offline mode");
  is(live503 && live503.status, 503, "…and carries the status");
  is(lib.signInOverAfterPull(live503.answered, live503.fetchedAt, live503.status), false, "…which is not the sign-in over");
  const live401 = await loadFailed(pageWith(async () => ({ ok: false, status: 401, headers: headers({}) })));
  is(live401 && live401.status, 401, "a load refused carries the 401");
  is(lib.signInOverAfterPull(live401.answered, live401.fetchedAt, live401.status), true, "…and the poll takes it as the sign-in over");
  const kept500 = await loadFailed(pageWith(async () => ({ ok: false, status: 500, headers: headers({ [lib.FETCHED_AT_HEADER]: STAMP }) })));
  is(kept500 && kept500.fetchedAt, STAMP, "a failed answer that carries the stamp is a kept one");
  is(lib.offlineAfterPull(STAMP, kept500.answered, kept500.fetchedAt), STAMP, "…and does not end offline mode");
  const down = await loadFailed(pageWith(async () => { throw new TypeError("Failed to fetch"); }));
  is(down && down.answered, undefined, "a load that never got there says no answer came");
  is(lib.offlineAfterPull(STAMP, !!down.answered, null), STAMP, "…and leaves the portal as it was");
  /* A connection that drops while the answer is coming down fails the
     body read, not the fetch: the save has landed, the tab does not know
     its new rev, and the browser calls that a TypeError too. It is tried
     again - the copy already landed comes back 409 and is merged. An
     answer the tab cannot read at all (a page where the JSON should be)
     would read the same way every time, and is not. */
  const cutOff = pageWith(async () => ({ ok: true, status: 200, text: async () => { throw new TypeError("network error"); } }));
  const eCut = await thrown(cutOff, {});
  is(eCut && eCut.status, 0, "a save whose answer was cut off on the way down carries a status of 0");
  is(eCut && eCut.message, "network error", "…and the browser's own words");
  is(lib.saveTryAgainIn(eCut), 15000, "…and is tried again in fifteen seconds: the copy already landed comes back 409 and is merged");
  const notJson = pageWith(async () => ({ ok: true, status: 200, text: async () => "<html>" }));
  const eHtml = await thrown(notJson, {});
  is(eHtml && eHtml.status, undefined, "a 200 with a page where the JSON should be carries no status");
  is(lib.saveTryAgainIn(eHtml), 0, "…and is not tried again: it would read the same way every fifteen seconds");
  const landed = pageWith(async () => ({ ok: true, status: 200, text: async () => '{"rev":7}' }));
  is(await landed.saveState({}, 6), { rev: 7 }, "a save that landed hands back the new rev");
  const collided = pageWith(async () => ({ ok: false, status: 409, text: async () => '{"rev":9,"data":{"notes":[]}}' }));
  is(await collided.saveState({}, 6), { rev: 9, data: { notes: [] }, conflict: true }, "one that collided hands back what is stored, marked as a collision");
  const cyclic = {}; cyclic.self = cyclic;
  const eCyclic = await thrown(offline, cyclic);
  is(eCyclic && eCyclic.status, undefined, "a copy the tab could not write out fails before the save leaves, and carries no status");
  is(lib.saveTryAgainIn(eCyclic), 0, "…and is not tried again: it would go wrong the same way every fifteen seconds");
  let realCyclic = null; try { JSON.stringify(cyclic); } catch (e) { realCyclic = e; }
  is(lib.saveTryAgainIn(realCyclic), 0, "…the browser's own error for it included");
  is(lib.saveTryAgainIn(new TypeError("Cannot read properties of undefined")), 0, "…nor is a slip in the tab's own code, which the browser also calls a TypeError");
  is(lib.saveTryAgainIn(new Error("Converting circular structure to JSON")), 0, "something that went wrong in the tab before the save left would go wrong the same way again, so is not");
  is(lib.saveTryAgainIn(new SyntaxError("Unexpected token")), 0, "…nor is an answer the tab could not read");
  is(lib.saveTryAgainIn(null), 0, "…nor is nothing at all to go on");

  const before = new Map([["notes", 1], ["people", 2]]);
  const now = new Map([["notes", 1], ["people", 3]]);
  is(lib.settledKeys(["notes", "people"], before, now), ["notes"], "a slice changed again while its save was in the air is still unsaved; the rest are saved");
  is(lib.settledKeys(["notes", "people"], before, before), ["notes", "people"], "nothing changed in flight: every slice the save carried is saved");
}

/* ---- the change log and the round's notes, three copies to one: what
        the hour wrote is kept, and only what this tab changed lands ---- */
{
  const e = (id, at) => ({ id, at, by: "x", section: "Admin", action: id, detail: "" });
  const base = [e("m1", "2026-09-24T09:00")];
  const mine = [e("m2", "2026-09-24T10:30"), e("m1", "2026-09-24T09:00")];
  const theirs = [e("s1", "2026-09-24T10:00"), e("m1", "2026-09-24T09:00")];
  const out = rules.mergeHistory(base, mine, theirs);
  is(out.map((x) => x.id), ["m2", "s1", "m1"], "the hour's line and the tab's line are both kept, newest first, and a line both hold appears once");
  const restored = rules.mergeHistory(
    [e("bad", "2026-09-24T10:00"), e("m1", "2026-09-24T09:00")],
    [e("m2", "2026-09-24T10:30"), e("bad", "2026-09-24T10:00"), e("m1", "2026-09-24T09:00")],
    [e("put-back", "2026-09-24T10:20"), e("m1", "2026-09-24T09:00")],
  );
  is(restored.map((x) => x.id), ["m2", "put-back", "m1"], "a line the server took off since this tab loaded (a version put back from Revisions) stays off; the tab's new line still lands");
  const tied = rules.mergeHistory([], [e("a", "2026-09-24T10:00"), e("b", "2026-09-24T10:00")], [e("c", "2026-09-24T10:00")]);
  is(tied.map((x) => x.id), ["a", "b", "c"], "lines with the same stamp keep mine's order");
  const many = Array.from({ length: 480 }, (_, i) => e("m" + i, "2026-09-24T10:" + String(59 - (i % 60)).padStart(2, "0")));
  const more = Array.from({ length: 40 }, (_, i) => e("s" + i, "2026-09-24T11:00"));
  const capped = rules.mergeHistory(null, many, more);
  is(capped.length, 500, "the log is capped at five hundred");
  is(capped.slice(0, 40).every((x) => x.id.startsWith("s")), true, "…and the newest survive the cap");
  is(rules.mergeHistory(undefined, null, undefined), [], "nothing on any side is an empty log");

  const keys = (o) => Object.keys(o).sort();
  is(keys(rules.mergeFilled({ A: true, B: true }, { A: true }, { A: true, B: true, C: true })), ["A", "C"],
    "a cell the tab took off its note stays off, and one the hour added stays on");
  is(keys(rules.mergeFilled({ A: true }, { A: true, D: true }, { A: true, C: true })), ["A", "C", "D"],
    "a cell the tab added and one the hour added are both on the note");
  is(keys(rules.mergeSeen({ A: "h1", B: "h1" }, { A: "h1" }, { A: "h1", B: "h1", C: "h2" })), ["A", "C"], "the sightings follow the same rule");
  is(keys(rules.mergeSeen({ A: "h1" }, { A: "h1", D: "h2" }, { A: "h1", C: "h2" })), ["A", "C", "D"], "…both ways");
  is(rules.mergeSeen({ A: "h1" }, { A: "h1" }, { A: "h2" }).A, "h2", "a sighting both hold carries the hour's stamp");
  is(rules.mergePending(["A", "B"], ["A"], ["A", "B", "C"]), ["A", "C"], "what the workbook is owed follows the same rule");
  is(rules.mergePending(["A"], ["A", "D"], ["A", "C"]), ["A", "C", "D"], "…both ways");
  is(rules.mergePending(null, ["A", "A"], undefined), ["A"], "a list is a set: no key twice");
}

/* ---- the provider's save loop uses those merges on a collision, on the
        code that ships ---- */
{
  const e = (id, at) => ({ id, at, by: "x", section: "Admin", action: id, detail: "" });
  const quals = { cols: [["QL-01", "Master"]], rows: [["EVANS, Brenton", "Master", "", ["2031-05-26"]]] };
  const base = { quals, filled: { A: true, B: true }, seen: { X: "h1" }, pending: ["P"], history: [] };
  const mine = {
    notes: ["mine"],
    quals: { cols: quals.cols, rows: [["EVANS, Brenton", "Master", "", ["2032-01-01"]]] },
    history: [e("m1", "2026-09-24T10:30")],
    filledFromCert: { A: true },
    orphanSeen: { X: "h1", Y: "h2" },
    workbookPending: [],
    lastDocUpdate: "2026-09-24T09:00:00.000Z",
  };
  const theirs = {
    notes: ["theirs"], other: "kept",
    quals: { cols: quals.cols, rows: [["EVANS, Brenton", "Master", "", ["2031-05-26"]], ["ROSE, Matthew", "Mate", "", [""]]] },
    history: [e("s1", "2026-09-24T10:00")],
    filledFromCert: { A: true, B: true, C: true },
    orphanSeen: { X: "h1", Z: "h3" },
    workbookPending: ["P", "Q"],
    lastDocUpdate: "2026-09-24T10:00:00.000Z",
  };
  const touched = ["notes", "quals", "history", "filledFromCert", "orphanSeen", "workbookPending", "lastDocUpdate"];
  const out = lib.mergeSaved({ touched, mine, theirs, base });
  is(out.notes, ["mine"], "a plain slice this tab touched goes back over theirs");
  is(out.other, "kept", "a slice this tab never touched is theirs");
  is(out.quals.rows.map((r) => r[0] + ":" + r[3][0]), ["EVANS, Brenton:2032-01-01", "ROSE, Matthew:"], "the matrix is merged cell by cell: my date lands, their new man stays");
  is(out.history.map((x) => x.id), ["m1", "s1"], "the hour's log line is kept beside the tab's");
  is(Object.keys(out.filledFromCert).sort(), ["A", "C"], "the note of filled cells is merged, not laid back whole");
  is(Object.keys(out.orphanSeen).sort(), ["X", "Y", "Z"], "the sightings are merged");
  is(out.workbookPending, ["Q"], "what is owed the workbook is merged: paid by the tab, still owed by the hour");
  is(out.lastDocUpdate, "2026-09-24T10:00:00.000Z", "the document's stamp is the newer of the two");
  const untouched = lib.mergeSaved({ touched: ["notes"], mine, theirs, base });
  is(untouched.history.map((x) => x.id), ["s1"], "a log this tab did not write to is theirs as it is");
  is(untouched.filledFromCert, theirs.filledFromCert, "…and so is the note");
  const alone = lib.mergeSaved({ touched, mine, theirs: null, base });
  is(alone, mine, "a collision with nothing on the other side (the server's document gone) sends mine up whole, every note kept");
  is(lib.mergeSaved({ touched, mine, theirs: undefined, base }).filledFromCert, { A: true }, "…however the nothing is spelt");
  const page = lib.mergeHistory(base.history, mine.history, theirs.history);
  is(page, rules.mergeHistory(base.history, mine.history, theirs.history), "mergeHistory in the page answers as the module does");

  /* The round filled Evans's MSIC number while this tab was changing
     Kachin's rank and typing Kachin's date of birth. The tab's save lands
     on the round's: Kachin's rank and date are the tab's, Evans's number
     and the note of what the certificates put there are the round's -
     the fill survives, it is not left to the next round to put back. */
  const crewBase = [{ id: "p1", name: "EVANS, Brenton", msic: "" }, { id: "p2", name: "SITTIYOS, Kachin", rank: "Cook", dob: "" }];
  const crewMine = { people: [{ id: "p1", name: "EVANS, Brenton", msic: "" }, { id: "p2", name: "SITTIYOS, Kachin", rank: "Deckhand", dob: "1975-05-06" }],
    particularsFromCert: {} };
  const crewTheirs = { people: [{ id: "p1", name: "EVANS, Brenton", msic: "MSIC 0002" }, { id: "p2", name: "SITTIYOS, Kachin", rank: "Cook", dob: "" }],
    particularsFromCert: { p1: { msic: "MSIC 0002" } } };
  const crew = lib.mergeSaved({ touched: ["people"], mine: crewMine, theirs: crewTheirs, base: { people: crewBase, particulars: {} } });
  is(crew.people, [{ id: "p1", name: "EVANS, Brenton", msic: "MSIC 0002" }, { id: "p2", name: "SITTIYOS, Kachin", rank: "Deckhand", dob: "1975-05-06" }],
    "a tab's save of the crew list keeps the round's fill in the boxes it did not touch");
  is(crew.particularsFromCert, { p1: { msic: "MSIC 0002" } }, "…and the round's note of what it put there");
  const crewAfter = lib.afterMergedSave(
    { people: [{ id: "p1", name: "EVANS, Brenton", msic: "" }, { id: "p2", name: "SITTIYOS, Kachin", rank: "Master", dob: "1975-05-06" }] },
    crew, crewMine, ["people"]);
  is(crewAfter.people[0].msic, "MSIC 0002", "…and an edit made while that save was in the air does not take it off again");
  /* The note of what the certificates put in each box, where a tab's save
     carries it (no screen writes it today, but a save that does must not
     wipe the round's): three ways, like the note of filled cells. The
     round noted p2 since; the tab dropped p1 and added p3. */
  const notes = lib.mergeSaved({ touched: ["particularsFromCert"],
    mine: { particularsFromCert: { p3: { dob: "1990-01-01" } } },
    theirs: { particularsFromCert: { p1: { msic: "MSIC 0002" }, p2: { dob: "1975-05-05" } } },
    base: { particulars: { p1: { msic: "MSIC 0002" } } } });
  is(notes.particularsFromCert, { p2: { dob: "1975-05-05" }, p3: { dob: "1990-01-01" } },
    "the round's new note stays, the one the tab took off stays off, the tab's own goes up");

  /* An edit made while the merged copy was still in the air is laid back
     over it the same way, not raw: the local copy was built before the
     merge, so laid back whole it would take the hour's work off again.
     It is laid back against the copy the first save carried, which is
     what the edit was built on - see afterMergedSave. */
  const carriedLog = { history: [e("m2", "2026-09-24T10:30"), e("m1", "2026-09-24T09:00")] };
  const inFlightLog = lib.afterMergedSave(
    { history: [e("m3", "2026-09-24T10:40"), e("m2", "2026-09-24T10:30"), e("m1", "2026-09-24T09:00")] },
    { history: [e("m2", "2026-09-24T10:30"), e("s1", "2026-09-24T10:00"), e("m1", "2026-09-24T09:00")] },
    carriedLog, ["history"],
  );
  is(inFlightLog.history.map((x) => x.id), ["m3", "m2", "s1", "m1"],
    "a line logged while the merged log was in the air lands beside the hour's line, which stays");
  const landed = { ...out, quals: { cols: [["QL-01", "Master"], ["QL-17", "Medical"]],
    rows: [["EVANS, Brenton", "Master", "", ["2032-01-01", "2029-03-03"]], ["ROSE, Matthew", "Mate", "", ["", ""]]] } };
  const typedMeanwhile = { ...mine, quals: { cols: quals.cols, rows: [["EVANS, Brenton", "Master", "", ["2033-06-06"]]] } };
  const laidBack = lib.mergeSaved({ touched: ["quals"], mine: typedMeanwhile, theirs: landed, base });
  is(laidBack.quals.rows.map((r) => r[0] + ":" + r[3].join("|")), ["EVANS, Brenton:2033-06-06|2029-03-03", "ROSE, Matthew:|"],
    "a cell edited while the merged matrix was in the air lands on it; the date the hour filled in and the man it added stay");
  is(laidBack.history.map((x) => x.id), ["m1", "s1"], "…and a slice not edited in the meantime is the merged copy as it landed");

  /* The base those in-flight edits are measured against is the copy the
     first save carried. Measured against what the tab had loaded before
     the collision, an edit that put a cell back to what it was showed no
     change and was dropped: the cell sprang back to the first save's
     value, and a key the tab had crossed off its note came back on. */
  // carried is the copy the first save went up with, the tab's own edits already in it (the date
  // moved on to 2032-01-01, D added to the note); what it had loaded before was EVANS 2031-05-26
  // and a note of A alone, which is what putBack puts each cell back to.
  const carried = { quals: { cols: quals.cols, rows: [["EVANS, Brenton", "Master", "", ["2032-01-01"]]] },
    filledFromCert: { A: true, D: true } };
  const landedNote = { ...landed, filledFromCert: { A: true, C: true, D: true } };
  const putBack = { quals: { cols: quals.cols, rows: [["EVANS, Brenton", "Master", "", ["2031-05-26"]]] },
    filledFromCert: { A: true } };
  const after = lib.afterMergedSave(putBack, landedNote, carried, ["quals", "filledFromCert"]);
  is(after.quals.rows[0][3], ["2031-05-26", "2029-03-03"],
    "a cell put back, while the merged copy was in the air, to what it was before the collision stays put back; the date the hour filled in stays");
  is(Object.keys(after.filledFromCert).sort(), ["A", "C"],
    "a key the tab had added before the first save and crossed off in the meantime stays off; the hour's stays on");
  const loadedBefore = { quals: base.quals, filledFromCert: { A: true } };
  is(lib.afterMergedSave(putBack, landedNote, loadedBefore, ["quals", "filledFromCert"]).quals.rows[0][3][0], "2032-01-01",
    "…measured against the copy loaded before the collision instead, the put-back date shows no change and springs back: the carried copy is the one to hand over");
  is(lib.afterMergedSave(putBack, landedNote, carried, []), landedNote,
    "nothing edited in the meantime: the tab holds the merged copy as it landed");
  is(lib.mergeFilled(base.filled, mine.filledFromCert, theirs.filledFromCert),
    rules.mergeFilled(base.filled, mine.filledFromCert, theirs.filledFromCert), "mergeFilled in the page answers as the module does");
}

/* ---- an open tab runs the round only when the worker's hour has not:
        never with unsaved changes, never offline, never while the hour
        holds the lease, and never over a clean round under seventy
        minutes old ---- */
{
  const now = Date.parse("2026-09-24T10:00:00Z");
  const ago = (min) => new Date(now - min * 60000).toISOString();
  const hourly = (min, more) => ({ at: now - min * 60000, roundError: null, roundSkipped: null, ...more });
  const ask = (o) => lib.shouldTabRound({ lastDocUpdate: ago(90), now, pending: false, online: true, last: null, ...o });
  is(ask({ pending: true }), false, "a tab with unsaved changes never runs the round");
  is(ask({ online: false }), false, "an offline tab never runs the round");
  is(ask({ last: { running: true, hourly: null } }), false, "while the hour holds the lease, the tab stands down");
  is(ask({ last: { running: false, hourly: hourly(30) } }), false, "a clean server round thirty minutes ago: the server did this hour");
  is(ask({ last: { running: false, hourly: hourly(80) } }), true, "a server round eighty minutes ago: the hour did not come, the tab is the fallback");
  is(ask({ last: { running: false, hourly: hourly(30, { roundError: "the library refused" }) } }), true, "a server round thirty minutes ago that failed: the tab runs");
  is(ask({ last: { running: false, hourly: hourly(30, { roundSkipped: "no training matrix on file" }) } }), true, "…or that was skipped");
  is(ask({ last: { running: false, hourly: { ...hourly(30), at: ago(30) } } }), false, "the hour's stamp read as text answers the same");
  is(ask({ lastDocUpdate: ago(90) }), true, "no server record and the tab's own stamp ninety minutes old: due");
  is(ask({ lastDocUpdate: ago(70) }), false, "…seventy minutes old: not yet, the hour gets its turn first");
  is(ask({ lastDocUpdate: ago(71) }), true, "…seventy-one: due, the same window as the server's record so the two do not stack");
  is(ask({ lastDocUpdate: null }), true, "…never updated: due");
  is(ask({ last: { sync: null, hourly: null, running: false } }), true, "a portal that has no hour on record leaves the tab to its own clock");
  is(ask({ last: null, unanswered: 1 }), false, "one ask that got no answer: the tab waits for the next rather than round behind an hour that may have done the work");
  is(ask({ last: null, unanswered: 2 }), true, "two in a row: the portal cannot be asked, the tab's own clock stands in");
  is(ask({ last: { running: false, hourly: hourly(30) }, unanswered: 1 }), false, "an answer in hand is read as ever, whatever went before");

  /* The count itself: only a miss on an ask the tab wanted to round on
     counts, and an answer of any kind clears it. */
  const answered = { running: false, hourly: hourly(30) };
  is(lib.missesInARow(0, true, null), 1, "a wanting ask that got no answer is one miss");
  is(lib.missesInARow(1, true, null), 2, "…and a second in a row is two");
  is(lib.missesInARow(2, true, answered), 0, "an answer clears the count");
  is(lib.missesInARow(1, false, null), 0, "a miss on an ask made only to see a running hour finish does not count, and clears what went before");
  is(lib.missesInARow(undefined, true, null), 1, "a count never started begins at one");
  const afterHours = lib.missesInARow(lib.missesInARow(0, false, null), true, null);
  is(afterHours, 1, "a miss while only watching the hour, then one wanting miss hours later, is one miss, not two");
  is(ask({ last: null, unanswered: afterHours }), false, "…so the tab waits for the next ask rather than round off one bad second");
}

/* ---- the round from the page: what the server's answer means, which
        progress record is ours and when it says the round was cut off,
        when the pull after it may go, and the done panel's lines ---- */
{
  const busy = "The round on the hour is writing the workbook; try again when it has finished.";
  is(lib.roundAnswerPhase(200, { applied: 1 }, "Matthew"), "done", "a 200 is the outcome");
  is(lib.roundAnswerPhase(409, { error: busy, by: "the round on the hour" }, "Matthew"), "waiting", "the hour holding the lease is waited for");
  is(lib.roundAnswerPhase(409, { error: "Another round is writing the workbook; try again when it has finished.", by: null }, "Matthew"), "waiting", "a 409 that names nobody is waited for too");
  is(lib.roundAnswerPhase(409, { error: "Kachin is writing the workbook; try again when it has finished.", by: "Kachin" }, "Matthew"),
    "failed:Somebody else is running it: Kachin. Try again when it has finished.", "a person holding the lease is named, not waited for");
  is(lib.roundAnswerPhase(409, { error: "Matthew is writing the workbook; try again when it has finished.", by: "Matthew" }, "Matthew"),
    "failed:A round you started is still running", "…and the same name is a round this person started");
  is(lib.roundAnswerPhase(502, { error: "the library refused the write" }, "Matthew"), "failed:the library refused the write", "any other answer fails with the server's words");
  is(lib.roundAnswerPhase(503, {}, "Matthew"), "failed:The round couldn't be run (503).", "…or with the status when it has none");
  is(lib.roundAnswerPhase(500, null, "Matthew"), "failed:The round couldn't be run (500).", "…and a body that could not be read is no body");

  const mine = { pct: 60, word: "Saving the matrix", done: false, by: "Matthew", runId: "run-1", running: true, holder: "Matthew" };
  is(lib.progressAccept(mine, "run-1"), { pct: 60, word: "Saving the matrix" }, "a record carrying this round's runId, under its own lease, is where it has got to");
  is(lib.progressAccept({ ...mine, runId: "run-0" }, "run-1"), "ignore", "another round's record is left alone");
  is(lib.progressAccept({ pct: 0, word: "No round has run yet", done: true, running: false, holder: null }, "run-1"), "ignore", "…and so is the word that none has run");
  is(lib.progressAccept(null, "run-1"), "ignore", "…and no record at all");
  is(lib.progressAccept({ ...mine, running: false, holder: null }, "run-1"), "cut-off", "ours, not done, nobody holding the lease: the round was cut off");
  is(lib.progressAccept({ ...mine, holder: "the round on the hour" }, "run-1"), "cut-off", "ours, not done, the lease held under another name: the hour took it after ours died");
  is(lib.progressAccept({ ...mine, at: 0 }, "run-1"), { pct: 60, word: "Saving the matrix" }, "never by the age of the last word: the workbook step can outlast any of them");
  is(lib.progressAccept({ ...mine, pct: 100, word: "Done", done: true, running: false, holder: null }, "run-1"), { pct: 100, word: "Done" }, "a done record is done whoever holds the lease now");
  is(lib.progressAccept({ ...mine, pct: "75.4" }, "run-1", true), { pct: 75, word: "Saving the matrix" }, "running handed in outranks the record's own, and the figure is a whole number");
  is(lib.progressAccept(mine, "run-1", false), "cut-off", "…so a caller who knows the lease is free calls it cut off");

  is(lib.pullNowStep({ dirty: 0, saving: false, waitedMs: 0 }), "pull", "nothing unsaved and no save in the air: pull now");
  is(lib.pullNowStep({ dirty: 2, saving: false, waitedMs: 1000 }), "wait", "something unsaved: wait");
  is(lib.pullNowStep({ dirty: 0, saving: true, waitedMs: 1000 }), "wait", "a save in the air: wait");
  is(lib.pullNowStep({ dirty: 1, saving: true, waitedMs: 20000 }), "pull-late", "twenty seconds of that: pull anyway, and say the matrix follows");
  is(lib.pullNowStep({ dirty: 0, saving: false, waitedMs: 30000 }), "pull", "clear at last, however long it took: a plain pull");

  /* The pull the runner is handed is a fresh one, after any in flight: a
     tick's pull that asked the server before the round saved brings back
     nothing new, so it is waited out and a new one made. */
  {
    let pulls = 0;
    const pull = () => { pulls++; return Promise.resolve("pulled " + pulls); };
    is(await lib.freshPull(null, pull), "pulled 1", "nothing in flight: one pull, now");
    let letGo;
    const inFlight = new Promise((ok) => { letGo = ok; });
    const asked = lib.freshPull(inFlight, pull);
    is(pulls, 1, "one in flight: no pull yet - the one running was asked before the save");
    letGo();
    is(await asked, "pulled 2", "…and a fresh one follows it");
    is(await lib.freshPull(Promise.reject(new Error("failed")), pull), "pulled 3", "a pull that failed is followed all the same");
  }

  /* The request is raced against the cut-off, never cancelled. */
  {
    const never = new Promise(() => {});
    const sw = lib.cutOffSwitch();
    let said = null;
    const race = Promise.race([never, sw.tripped]).catch((e) => { said = e.message; });
    sw.cutOffNow();
    await race;
    is(said, lib.CUT_OFF, "the switch thrown: the runner stops waiting and says the round was cut off");
    const quiet = lib.cutOffSwitch();
    is(await Promise.race([Promise.resolve({ status: 200 }), quiet.tripped]), { status: 200 }, "not thrown: the request's own answer comes through");
    // Thrown once nobody is racing it: nothing is thrown at the page. Node
    // would end this run on an unhandled rejection, so reaching the end is the proof.
    quiet.cutOffNow();
    await new Promise((ok) => setTimeout(ok, 0));
  }

  /* Closing the window leaves a live run alone. */
  is(lib.runCleared({ phase: "done", origin: "button" }), null, "a run that finished is cleared");
  is(lib.runCleared({ phase: "failed", origin: "button" }), null, "…and one that failed");
  is(lib.runCleared(null), null, "nothing to clear is nothing");
  const live = { phase: "starting", origin: "button", pct: 40 };
  is(lib.runCleared(live), live, "a run in its server phase stays: the round is running whatever the window does");
  is(lib.runCleared({ phase: "reading" }), { phase: "reading" }, "…and one still reading");

  /* A start landing mid-run is queued, and every caller waits for the round that runs for them. */
  {
    const q1 = lib.queueRound(null, { origin: "certificates" }, "upload");
    is(q1, { input: { origin: "certificates" }, waiters: ["upload"] }, "the first ask starts the queue, with its caller waiting");
    const q2 = lib.queueRound(q1, { origin: "portal", by: "Update portal" }, "portal");
    is(q2, { input: { origin: "certificates", by: "Update portal" }, waiters: ["upload", "portal"] },
      "a later ask folds in: the first origin stands, a key only the later ask carried comes along, both wait");
    const q3 = lib.queueRound(lib.queueRound(null, { origin: "button" }, "b"), { origin: "certificates" }, "upload");
    is(q3.input.origin, "certificates", "the upload's origin stands whichever came first: its screen reads it to report the batch");
    is(lib.queueRound(q1, { origin: "button" }).waiters, ["upload"], "an ask with nobody waiting adds no waiter");
    is(lib.queueRound(null, undefined, "x"), { input: {}, waiters: ["x"] }, "an ask with nothing to say still queues");
  }

  /* The button's title while somebody else has the workbook. */
  is(lib.roundBusyTitle(null), lib.ROUND_BUSY, "no name: the hour's own sentence");
  is(lib.roundBusyTitle("the round on the hour"), lib.ROUND_BUSY, "the hour by name: the same");
  is(lib.roundBusyTitle(" Kachin "), "Kachin is writing the workbook", "a person: named");
  is(lib.roundBusyTitle("Update portal"), "Update portal is writing the workbook", "…or the press that holds it");

  /* When a certificate last moved a date: the round's stamp; the workbook's day only where there is no stamp. */
  /* A coming swing is the Roster page's (rosterSwing): the roster swing
     sharing the most days with the pattern's, whose it is, who is on it and
     for which days. Matthew, 26 Sep 2026: the roster is filled in for the
     year, so the swing cards derive from it rather than waiting on a button. */
  {
    const k = lib.swingAt(3);
    const people = [
      { id: "p1", name: "SMITH, Alan", active: true },
      { id: "p2", name: "JONES, Bob", active: true },
      { id: "p3", name: "REYES, Jose", active: true },
      { id: "p4", name: "GONE, Away", active: false },
    ];
    const personFor = (who) => people.find((p) => p.name.toUpperCase().startsWith(String(who).toUpperCase())) || null;
    // The roster's swing sits two days off the pattern's, and the one before it overlaps a little.
    const on = (iso, n) => new Date(new Date(iso + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);
    const spine = [
      { on: on(k.flyOut, -28), off: on(k.flyOut, 2), crew: "BRAVO" },
      { on: on(k.flyOut, 2), off: on(k.flyHome, 2), crew: "ALPHA" },
    ];
    const rows = [
      { name: "SMITH", on: spine[1].on, off: spine[1].off },                       // the whole swing
      { name: "JONES", on: on(spine[1].on, 7), off: spine[1].off },                 // joins a week late
      { name: "REYES", on: spine[0].on, off: spine[0].off },                        // the swing before: not on this one
      { name: "NOBODY", on: spine[1].on, off: spine[1].off },                       // not on the crew list
    ];
    const r = lib.rosterSwing(3, { spine, rows }, people, personFor);
    is(r.dates, { flyOut: spine[1].on, flyHome: spine[1].off, crew: "A" }, "the roster swing sharing the most days, and whose it is");
    is(r.side, { p1: "on", p2: "on", p3: "off" }, "the overlapping stints are on, the rest off, and nobody inactive");
    is(r.window, { p2: { from: on(spine[1].on, 7), to: spine[1].off } }, "a part-swing stint keeps its own days; the whole swing needs none");
    is(r.strangers, ["NOBODY"], "a roster name the crew list cannot place is named, not guessed");
    is(lib.rosterSwing(3, { spine: [], rows }, people, personFor), null, "no roster: the pattern stands");
    is(lib.rosterSwing(9, { spine, rows }, people, personFor), null, "no roster swing near it: the pattern stands");
    const named = lib.rosterPeopleFor([{ id: "x", name: "SMITH, Alan" }], ["SMITH, Alan", "JONES, Bob"]);
    is((named("Alan") || {}).id, "x", "a roster shorthand reaches the crew list's person through the matrix");
    is(named("Zed"), null, "and a name the matrix cannot place is nobody");
  }
  is(lib.matrixLastMoved("2026-08-01", { uploaded: "2026-09-20T03:00:00.000Z" }), "2026-08-01", "a workbook uploaded by hand since moved no date: the round's stamp stands");
  is(lib.matrixLastMoved("2026-09-22", { uploaded: "2026-09-20T03:00:00.000Z" }), "2026-09-22", "the round's stamp later: its day");
  is(lib.matrixLastMoved("2026-09-22", null), "2026-09-22", "no workbook on file: the round's stamp");
  is(lib.matrixLastMoved("", { uploaded: "2026-09-20T03:00:00.000Z" }), "2026-09-20", "no stamp yet: the workbook's day stands in");
  is(lib.matrixLastMoved("", null), "", "neither: nothing, and no nudge");

  /* Filing the matrix spreadsheet: only when there is something new to file. */
  is(lib.fileSpreadsheetSend({ written: 0, rebuilt: "" }), "same", "no cell moved and the workbook's own bytes came back: nothing to file");
  is(lib.fileSpreadsheetSend({ written: 3, rebuilt: "" }), "send", "cells changed: filed");
  is(lib.fileSpreadsheetSend({ written: 0, rebuilt: "No spreadsheet is filed on the portal yet, so this one was built from the matrix." }), "send", "built from nothing: filed, there is nothing on the portal to be the same as");
  is(lib.fileSpreadsheetSend(null), "same", "no report at all is nothing to file");

  /* …and a refusal for the lease is waited for once. */
  is(lib.fileSpreadsheetStep({ status: 409 }), "wait", "409: somebody is writing the workbook, wait for them");
  is(lib.fileSpreadsheetStep({ status: 502 }), "fail", "any other refusal is the error it is");
  is(lib.fileSpreadsheetStep(new Error("no network")), "fail", "…and so is a request that never got there");
  is(lib.fileSpreadsheetStep(null), "fail", "nothing thrown is nothing to wait for");
  {
    const refused = (status, by) => Object.assign(new Error(by ? `${by} is writing the workbook; try again when it has finished.` : `Upload failed (${status}).`), { status, by: by || "" });
    const sends = (...answers) => {
      const calls = [];
      const send = async () => { const a = answers[calls.length]; calls.push(1); if (a instanceof Error) throw a; return a; };
      return { send, calls };
    };
    const waits = () => { const seen = []; return { wait: async (e) => { seen.push(e.by); }, seen }; };

    let s = sends({ record: { id: "cs9" } });
    let w = waits();
    is(await lib.fileSpreadsheetAttempt(s.send, w.wait), { record: { id: "cs9" } }, "sent first time: the record");
    is([s.calls.length, w.seen], [1, []], "…one send, no wait");

    s = sends(refused(409, "the round on the hour"), { record: { id: "cs9" } });
    w = waits();
    is(await lib.fileSpreadsheetAttempt(s.send, w.wait), { record: { id: "cs9" } }, "409 then filed: the record");
    is([s.calls.length, w.seen], [2, ["the round on the hour"]], "…two sends, one wait, told who held the lease");

    s = sends(refused(409, "the round on the hour"), refused(409, "Kachin"));
    w = waits();
    let thrown = null;
    try { await lib.fileSpreadsheetAttempt(s.send, w.wait); } catch (e) { thrown = e; }
    is([s.calls.length, w.seen], [2, ["the round on the hour"]], "409 twice: exactly one wait, then no more");
    is(thrown && thrown.message, "Kachin is writing the workbook; try again when it has finished.", "…and the second refusal is the one surfaced, the server's own sentence");

    s = sends(refused(502));
    w = waits();
    thrown = null;
    try { await lib.fileSpreadsheetAttempt(s.send, w.wait); } catch (e) { thrown = e; }
    is([s.calls.length, w.seen, thrown && thrown.status], [1, [], 502], "any other refusal: no wait, no second send, the error as it is");
  }

  /* What to say once it is filed, and the stamp the swing report reads:
     the round's, which the filing leaves be. */
  {
    const record = { id: "cs9", filename: "20260924 - CREW QUALIFICATION EXPIRY (portal).xlsx", url: "/api/files/cs9" };
    const said = lib.fileSpreadsheetOutcome({ written: 3, rebuilt: "" }, record, "Matthew");
    is(said.detail, "20260924 - CREW QUALIFICATION EXPIRY (portal).xlsx · 3 cells changed", "the log line: the file and the cells changed");
    is(lib.fileSpreadsheetOutcome({ written: 1, rebuilt: "" }, record, "Matthew").detail,
      "20260924 - CREW QUALIFICATION EXPIRY (portal).xlsx · 1 cell changed", "one cell, singular");
    is(lib.fileSpreadsheetOutcome({ written: 0, rebuilt: "No spreadsheet is filed on the portal yet, so this one was built from the matrix." }, record, "Matthew").detail,
      "20260924 - CREW QUALIFICATION EXPIRY (portal).xlsx · built from the matrix", "built from nothing: no count of cells");
    const roundAt = "2026-09-20T00:00:00.000Z";
    const prev = {
      at: roundAt, by: "Kachin", model: "round", items: [], notes: [], summary: { read: 4 }, verdicts: {},
      generated: { at: roundAt, by: "Kachin", filename: "old.xlsx", applied: 2, dismissed: 0, fileId: "tm1", failed: "it broke" },
    };
    is(said.patch(prev), {
      ...prev,
      generated: { at: roundAt, by: "Matthew", filename: record.filename, applied: 2, dismissed: 0, fileId: "cs9", failed: null },
    }, "the file, who filed it and that nothing failed are the filing's; the stamp the swing report reads stays the round's, and so do the reading's own fields and the round's count");
    is(said.patch(null), { generated: { at: null, by: "Matthew", filename: record.filename, fileId: "cs9", failed: null } },
      "no round yet: no stamp, whoever filed");

    /* The swing report's "matrix fresh": the round's stamp against the
       newest certificate's upload day, by the vessel's calendar. */
    const certToday = "2026-09-24T01:00:00.000Z";
    is(lib.matrixFreshAt("2026-09-24T02:00:00.000Z", certToday), true, "a round after the newest certificate: the matrix is current");
    is(lib.matrixFreshAt("2026-09-23T02:00:00.000Z", certToday), false, "a certificate uploaded since the round: it is not");
    is(lib.matrixFreshAt("2026-09-23T17:00:00.000Z", certToday), true, "…by the vessel's day: 17:00 UTC on the 23rd is the 24th in Perth");
    is(lib.matrixFreshAt("", certToday), false, "no round yet: not current");
    is(lib.matrixFreshAt("2026-09-24T02:00:00.000Z", ""), true, "no certificate on file: nothing to be behind");
    // After a round stamps today, the report says current - and a filing
    // of the spreadsheet after that changes nothing either way.
    const afterRound = { generated: { at: "2026-09-24T02:00:00.000Z", by: "Matthew", filename: "20260924 - CREW QUALIFICATION EXPIRY.xlsx", applied: 1, dismissed: 0, fileId: "tm9", failed: null } };
    is(lib.matrixFreshAt(afterRound.generated.at, certToday), true, "after a round: current");
    is(lib.matrixFreshAt(said.patch(afterRound).generated.at, certToday), true, "…and still current after the spreadsheet is filed");
    // A certificate uploaded today and read by no round yet: filing the
    // spreadsheet does not make the matrix current with it.
    const stale = { generated: { at: "2026-09-23T02:00:00.000Z", by: "Matthew", filename: "old.xlsx", applied: 1, dismissed: 0, fileId: "tm8", failed: null } };
    is(lib.matrixFreshAt(said.patch(stale).generated.at, certToday), false, "a filing reads no certificate, so it cannot make the matrix current with one");
  }

  const full = {
    at: "2026-09-24T10:00:00.000Z", applied: 2, cleared: 1, settled: 3, written: 3,
    workbook: "20260924 - CREW QUALIFICATION EXPIRY.xlsx", workbookId: "tm9", leftAsTyped: 3, held: null,
    roundError: null, roundSkipped: null, workbookProblem: null, validityProblem: null, equivalenceProblem: null,
    changes: [
      { person: "EVANS, Brenton", code: "QL-01", title: "Master", from: "", to: "2031-05-26" },
      { person: "ROSE, Matthew", code: "QL-17", title: "Medical", from: "2027-01-30", to: "2029-01-30" },
      { person: "COOK, Sam", code: "QL-17", title: "Medical", from: "2028-02-02", to: "" },
    ],
    summary: { certificates: 12, read: 12, unread: 0, compared: 12, discrepancies: 0, derived: 1, validitySheet: "SKILLS MATRIX.xlsx" },
    refiled: 1, prepareProblem: null, note: null,
  };
  is(lib.doneEyebrow(full), "Matrix updated", "dates moved: the matrix was updated");
  is(lib.doneWindowLines(full).map((l) => l.text), [
    "12 of 12 certificates on file were read.",
    "2 dates written",
    "1 cleared: the certificate behind it is no longer in the library",
    "1 refiled",
    "1 worked out from SKILLS MATRIX.xlsx",
    "20260924 - CREW QUALIFICATION EXPIRY.xlsx · 3 cells",
    "3 cells left as typed",
  ], "the done panel says the counts, the workbook and nothing else");
  const lines = lib.doneWindowLines(full);
  is(lines[1].changes, true, "the dates-written line is where the from → to list hangs");
  is(lines[5].tone, "link", "the workbook line is a link…");
  is(lines[5].href, "/api/files/tm9", "…to the filed workbook");
  is(lines[6].tone, "muted", "cells left as typed are said quietly");
  is(lib.doneWindowLines(full).some((l) => /left differences|no certificate behind/.test(l.text)), false, "no line about differences left: it never counted anything true");

  const idle = { ...full, applied: 0, cleared: 0, settled: 0, written: null, workbook: null, workbookId: null, leftAsTyped: 0,
    changes: [], summary: { ...full.summary, derived: 0 }, refiled: 0 };
  is(lib.doneEyebrow(idle), "Matrix already up to date", "nothing moved: already up to date");
  is(lib.doneWindowLines(idle).map((l) => l.text), ["12 of 12 certificates on file were read."], "with nothing to do, the read count is the whole panel");
  is(lib.doneWindowLines({ ...idle, written: 0 }).map((l) => l.text),
    ["12 of 12 certificates on file were read.", "The spreadsheet already had every date"], "a workbook step that found every date in place says so");
  is(lib.doneWindowLines({ ...idle, summary: { ...idle.summary, certificates: 1, read: 1 } })[0].text, "1 of 1 certificate on file was read.", "one certificate reads as one");

  const trouble = { ...idle, held: "1 certificate is still unread, so nothing was cleared", workbookProblem: "The workbook is too big to rewrite here", roundSkipped: "The workbook is too big to rewrite here",
    equivalenceProblem: "No Equivalence sheet on SKILLS MATRIX.xlsx", prepareProblem: "No Equivalence sheet on SKILLS MATRIX.xlsx", note: lib.PULL_LATE_NOTE };
  is(lib.doneWindowLines(trouble).map((l) => [l.tone, l.text]), [
    ["plain", "12 of 12 certificates on file were read."],
    ["problem", "1 certificate is still unread, so nothing was cleared"],
    ["problem", "No Equivalence sheet on SKILLS MATRIX.xlsx"],
    ["problem", "The workbook is too big to rewrite here"],
    ["muted", "the matrix on screen follows once this tab's own change has saved"],
  ], "each problem once, in orange, and the late-pull note last");
  is(lib.doneEyebrow({ noItems: true }), "Nothing on the matrix yet", "no items on the matrix: nothing to read against");
  is(lib.doneWindowLines({ noItems: true }), [], "…and no lines under it");
  is(lib.doneWindowLines(null), [], "no outcome, no lines");
}

/* ---- the red line under Update portal comes down by itself ---- */
{
  const up = 1_000_000;
  const clean = { hourly: { at: up + 60_000, readError: null, readTried: true, roundSkipped: null } };
  is(lib.badgeShouldClear(lib.OUT_OF_CREDIT, up, clean), true, "a later hour that read with no reading error takes the line down");
  is(lib.badgeShouldClear("", up, clean), false, "no line, nothing to take down");
  is(lib.badgeShouldClear(lib.OUT_OF_CREDIT, up, { hourly: { at: up - 1, readError: null, readTried: true } }), false, "an hour that began before the line went up says nothing about it");
  is(lib.badgeShouldClear(lib.OUT_OF_CREDIT, up, { hourly: { at: up + 60_000, readError: lib.OUT_OF_CREDIT, readTried: true } }), false, "an hour still out of credit leaves it up");
  is(lib.badgeShouldClear(lib.OUT_OF_CREDIT, up, { hourly: { at: up + 60_000, readError: null, readTried: false, roundSkipped: "round not yet run" } }), false, "the hour's early record, written before its reading, does not count");
  is(lib.badgeShouldClear(lib.OUT_OF_CREDIT, up, { hourly: { at: up + 60_000, readError: null, readTried: true, readStopped: "Reading unavailable" } }), true, "a busy model is an aside, not a reason to keep the line up");
  // Hours that never put a certificate to the model say nothing about the account.
  is(lib.badgeShouldClear(lib.OUT_OF_CREDIT, up, { hourly: { at: up + 60_000, readError: null, readTried: false, roundSkipped: "another round is still running" } }), false, "an hour that stood down for somebody's lease leaves it up");
  is(lib.badgeShouldClear(lib.OUT_OF_CREDIT, up, { hourly: { at: up + 60_000, readError: null, readTried: false, roundError: "the hour could not start: D1 is away" } }), false, "an hour that could not start leaves it up");
  is(lib.badgeShouldClear(lib.OUT_OF_CREDIT, up, { hourly: { at: up + 60_000, readError: null, readTried: false, roundSkipped: "the crew matrix has no items" } }), false, "an hour with nothing to read leaves it up");
  is(lib.badgeShouldClear(lib.OUT_OF_CREDIT, up, { hourly: { at: up + 60_000, readError: null } }), false, "a record that does not say whether it read leaves it up");
  is(lib.badgeShouldClear(lib.OUT_OF_CREDIT, up, null), false, "no answer, no change");
  is(lib.accountLine(lib.KEY_PROBLEM), true, "the key's line is the account's");
  is(lib.accountLine(lib.READING_UNAVAILABLE), true, "the busy line is the account's");
  is(lib.accountLine("Failed to fetch"), false, "a line about the network is not the hour's to take down, so the tab does not ask for it");
  is(lib.accountLine(""), false, "no line, nothing to ask about");
  is(lib.badgeShouldClear(lib.OUT_OF_CREDIT, up, { hourly: null }), false, "no hour yet, no change");
  // Only the account's three lines come down by themselves. An hour that
  // read says nothing about a library that could not be reached, a round
  // refused for the lease or a save that never landed: those stay until
  // the button is pressed again.
  is(lib.badgeShouldClear("The import failed (502): SharePoint sign-in failed", up, clean), false, "a library that could not be reached is not the account: the line stays");
  is(lib.badgeShouldClear("Failed to fetch", up, clean), false, "nor is a portal that could not be reached");
  is(lib.badgeShouldClear("Another round is running", up, clean), false, "nor is a round refused for the lease");
  is(lib.badgeShouldClear(lib.READING_UNAVAILABLE, up, clean), true, "a busy model's line comes down once an hour reads clean");
  is(lib.badgeShouldClear(lib.KEY_PROBLEM, up, clean), true, "so does the key's");
}

/* ---- the crew phone after an upload the model could not read ---- */
{
  for (const kind of ["credit", "key", "rate", "busy"]) {
    is(lib.crewUploadNote(kind, lib.OUT_OF_CREDIT), { phase: "Uploaded — will be read on the hour", note: "" }, kind + ": the file is on the books and the hour reads it; nothing for the crew to act on");
  }
  is(lib.crewUploadNote("document", "The PDF specified was not valid."), { phase: "Uploaded — not renamed", note: "The PDF specified was not valid." }, "a document the model turned away is said as it came");
  is(lib.crewUploadNote(undefined, "Reading failed (500)"), { phase: "Uploaded — not renamed", note: "Reading failed (500)" }, "no kind at all: today's note");
  // The three sentences reach the page whole, and fit the badge.
  for (const line of [lib.OUT_OF_CREDIT, lib.READING_UNAVAILABLE, lib.KEY_PROBLEM]) is(line.length <= 60, true, "fits the badge: " + line);
  // The preview's shim cannot read the page's copy (it runs outside the
  // page's script), so it carries the sentence itself; it must be the same.
  const shim = readFileSync(join(ROOT, "tools", "preview", "shim.js"), "utf8");
  is(shim.includes(JSON.stringify(lib.OUT_OF_CREDIT)), true, "the preview shim's out-of-credit line is the shared one");
}

/* ---- the copy spliced into the page answers exactly as the module does ---- */
{
  /* The page has no bundler: the build folds the shared files in by taking
     "export" off each declaration. The tests above run the module; this one
     runs the same fixture through the page's copy and expects the same
     answer, so a fold that mangled a body could not pass unnoticed. */
  const quals = {
    cols: [["QL-01", "Master"], ["QL-17", "Medical"]],
    rows: [
      ["EVANS, Brenton", "Master", "", ["2031-05-26", "2028-02-02"]],
      ["ROSE, Matthew", "CHIEF OFFICER", "", ["", "2027-01-30"]],
    ],
  };
  const settled = [
    { person: "rose, matthew", code: "QL-01", value: "2030-09-11" },
    { person: "EVANS, Brenton", code: "QL-17", clear: true },
  ];
  const page = lib.applySettled(quals, settled);
  const mod = rules.applySettled(quals, settled);
  is({ next: page.next, applied: page.applied, only: [...page.only] },
    { next: mod.next, applied: mod.applied, only: [...mod.only] },
    "applySettled in the page answers as the module does");
  const round = { filledFromCert: { "A::QL-01": true, "B::QL-02": true }, claimed: ["A::QL-01"], unread: 0, settled: [] };
  is(lib.settleRound(round), rules.settleRound(round), "settleRound in the page answers as the module does");
}

/* ---- an item that never lapses reads as held, not as a date ---- */
{
  /* The vessel file names the e-learnings that carry no expiry (noExpiryCodes).
     The matrix loads through crewRowsOnly, which is handed that list; a date
     in one of those columns means the item was done, so it reads as held. A
     caller that dropped the list would let a 2020 date read as long lapsed, so
     the list is required and a forgotten one is said out loud. */
  const quals = { cols: [["VS-04", "Helm CONNECT", "Vessel Specific"], ["QL-01", "Medical", "Qualification"]],
    rows: [["SMITH, Alan", "Master", "1", ["2020-01-01", "2020-01-01"]]] };
  is(lib.VESSEL.noExpiryCodes.includes("VS-04"), true, "VS-04 is on this vessel's list of items that never lapse");
  is(lib.crewRowsOnly(quals, [], lib.VESSEL.noExpiryCodes).rows[0][3], ["Y", "2020-01-01"],
    "the page's gate reads a date in a never-lapsing column as held, and leaves the other column's date alone");
  is(names.crewRowsOnly(quals, [], lib.VESSEL.noExpiryCodes).rows[0][3], ["Y", "2020-01-01"],
    "the module the worker imports answers the same");
  is(names.crewRowsOnly(quals, [], []).rows[0][3], ["2020-01-01", "2020-01-01"],
    "without VS-04 on the list, the date stays a date that ran out in 2020");
  const forgot = (() => { try { names.crewRowsOnly(quals, []); return "nothing"; } catch (e) { return e.message; } })();
  is(forgot, "crewRowsOnly needs the vessel file's list of items that never lapse (noExpiryCodes).",
    "a caller that forgets the list is stopped, in one plain sentence");
}

/* ---- the roster's crew words come off the vessel file's swing labels ---- */
{
  /* A roster row carries the swing's id; what the page shows against it is
     the swing's label with "Swing" taken off, so a vessel whose swings are
     named otherwise shows its own names and this one shows what it always
     did. An id the file does not carry is shown as it is. */
  is(lib.VESSEL.swings.labels, { A: "Swing Alpha", B: "Swing Bravo" }, "this vessel's swings are Alpha and Bravo");
  is(["ALPHA", "BRAVO", "OTHER"].map(lib.swingCrewWord), ["Alpha", "Bravo", "OTHER"], "the crew's name, by the swing's id");
  is(["ALPHA", "BRAVO", "OTHER"].map(lib.swingCrewCalled), ["Alpha crew", "Bravo crew", "OTHER"], "…and the roster's heading for it");
}

/* ---- the preview's shim carries the vessel file as written ---- */
{
  /* A "$" in the file must survive the trip into the shim: replace() with a
     string reads "$'" as "the rest of the text", which would splice the shim
     into the middle of the JSON and break the preview page. */
  const { vesselIntoShim, into } = await import("file:///" + ROOT.replaceAll(" ", "%20") + "/tools/build-preview.mjs");
  const vessel = { note: "costs $' and $& - $1 each", pattern: "^\\$$" };
  const shim = "const VESSEL = __VESSEL__;\nrest of the shim";
  is(vesselIntoShim(shim, vessel), "const VESSEL = " + JSON.stringify(vessel) + ";\nrest of the shim",
    "the vessel file goes into the shim byte for byte, dollar signs and all");
  is(JSON.parse(vesselIntoShim(shim, vessel).slice("const VESSEL = ".length, -";\nrest of the shim".length)), vessel,
    "…and reads back as the same file");
  /* The crew snapshot goes in the same way: it is everyone's notes as typed,
     and the notes change every day, so a "$'" in one of them must not be the
     day the preview page stops opening. */
  const snapshot = { rev: 7, data: { note: "paid $' on the day, $$ later" } };
  const withSnapshot = into("const SNAPSHOT = __SNAPSHOT__;\nconst ROWS = __FILE_ROWS__;", { __SNAPSHOT__: snapshot });
  is(withSnapshot, "const SNAPSHOT = " + JSON.stringify(snapshot) + ";\nconst ROWS = __FILE_ROWS__;",
    "the crew snapshot goes into the shim byte for byte, and a slot with no value is left for its own");
  is(JSON.parse(withSnapshot.slice("const SNAPSHOT = ".length, withSnapshot.indexOf(";\n"))), snapshot,
    "…and reads back as the same snapshot");
  /* One pass over the original text: a note that happens to say the name of
     another slot is a note, not a slot, and the file rows land in their own. */
  const tricky = { rev: 8, data: { note: "the mark __FILE_ROWS__ is just words here" } };
  const rows = [{ id: "r1" }];
  const filled = into("const SNAPSHOT = __SNAPSHOT__;\nconst ROWS = __FILE_ROWS__;", { __SNAPSHOT__: tricky, __FILE_ROWS__: rows });
  is(JSON.parse(filled.slice("const SNAPSHOT = ".length, filled.indexOf(";\n"))), tricky,
    "a slot's name inside a note stays words");
  is(filled.slice(filled.indexOf("const ROWS = ") + "const ROWS = ".length, -1), JSON.stringify(rows),
    "…and the rows still land in their own slot");
  /* The shim is a <script> block: a note saying "</script>" must not end it. */
  const closing = { rev: 9, data: { note: "typed </script> by accident" } };
  const safe = into("const SNAPSHOT = __SNAPSHOT__;", { __SNAPSHOT__: closing });
  is(safe.includes("</script>"), false, "a closing script tag in a note is written so it cannot close the shim");
  is(JSON.parse(safe.slice("const SNAPSHOT = ".length, -1)), closing, "…and still reads back as the same note");
}

/* ---- the vessel file, as the build reads it ---- */
{
  /* The build's loader is the one a new vessel's file meets first. A brand
     file that is not there is said with the key and not as a read error from
     inside the build; a list entry missing what its code needs is refused by
     its place in the list; and the manifest written for a vessel is that
     vessel's, name and all. */
  const { checkVessel, readVessel, manifestFor } = await import("file:///" + ROOT.replaceAll(" ", "%20") + "/tools/source.mjs");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const example = readVessel(join(ROOT, "tools", "fixtures", "example-vessel.json"));
  const said = (f) => { try { f(); return "nothing"; } catch (e) { return e.message; } };

  const dir = mkdtempSync(join(tmpdir(), "vessel-"));
  const noLogo = join(dir, "vessel.json");
  writeFileSync(noLogo, JSON.stringify({ ...example, brand: { ...example.brand, logo: "brand/nothing-here.png" } }));
  is(said(() => readVessel(noLogo)), noLogo + ' has no usable "brand.logo": brand/nothing-here.png is not a file under source/.',
    "a brand file that is not on disk is named by its key");

  const rankGroups = example.rankGroups.map((g) => [...g]);
  rankGroups[1] = [rankGroups[1][0]];
  is(said(() => checkVessel({ ...example, rankGroups }, "a vessel file")),
    'a vessel file has no usable "rankGroups[1]" - it must be a heading and a pattern, both strings.',
    "a rank group without its pattern is refused, not compiled into match-everything");
  const pools = example.shift.pools.map((p) => ({ ...p }));
  delete pools[0].is;
  is(said(() => checkVessel({ ...example, shift: { ...example.shift, pools } }, "a vessel file")),
    'a vessel file has no usable "shift.pools[0].is" - it must be a string.', "a pool without its \"is\" is refused");
  is(said(() => checkVessel({ ...example, brand: { ...example.brand, appleTouch: "" } }, "a vessel file")),
    'a vessel file has no usable "brand.appleTouch" - it must be a string.', "the home-screen icons are the vessel's");

  /* The ids the page keys on are the file's to carry and not to rename: a
     shift group called "dayshift" would reach the page with no rule to take
     its requirements by, and the Swing Compliance page would throw. */
  const groups = example.shift.groups.map((g) => ({ ...g }));
  groups[0].id = "dayshift";
  is(said(() => checkVessel({ ...example, shift: { ...example.shift, groups } }, "a vessel file")),
    'a vessel file has no usable "shift.groups[0].id" - it must be one of day, night, swing.',
    "a shift group under a name the page has no rule for is refused");
  is(said(() => checkVessel({ ...example, shift: { ...example.shift, groups: example.shift.groups.slice(1) } }, "a vessel file")),
    'a vessel file has no usable "shift.groups" - it must be a list with one group for each of day, night, swing.',
    "…and so is a file missing one of the three");
  is(said(() => checkVessel({ ...example, shift: { ...example.shift, sheetWords: { day: "Shift 1" } } }, "a vessel file")),
    'a vessel file has no usable "shift.sheetWords.night" - it must be a string.', "the sheet's words are named for day and night");
  is(said(() => checkVessel({ ...example, swings: { ...example.swings, labels: { A: "Swing Alpha" } } }, "a vessel file")),
    'a vessel file has no usable "swings.labels.B" - it must be a string.', "the swings are labelled A and B");
  is(said(() => checkVessel({ ...example, swings: { ...example.swings, ids: ["ALPHA"] } }, "a vessel file")),
    'a vessel file has no usable "swings.ids" - it must be two ids, the first for swing A and the second for swing B.',
    "the ids are paired with the labels by order, so there are two and no more");
  is(said(() => checkVessel({ ...example, noExpiryCodes: [...example.noExpiryCodes, "ZZ-99"] }, "a vessel file")),
    'a vessel file has no usable "noExpiryCodes[' + example.noExpiryCodes.length + ']" - it must be one of the codes in qualColumns.',
    "an item said never to lapse must be a column of the matrix");
  const establishment = example.shift.establishment.map((e) => ({ ...e }));
  establishment[2] = { ...establishment[2], pool: "purser" };
  is(said(() => checkVessel({ ...example, shift: { ...example.shift, establishment } }, "a vessel file")),
    'a vessel file has no usable "shift.establishment[2].pool" - it must be one of the pools in shift.pools.',
    "a position in a pool the file does not name is refused");
  establishment[2] = { ...example.shift.establishment[2], shifts: ["day", "evening"] };
  is(said(() => checkVessel({ ...example, shift: { ...example.shift, establishment } }, "a vessel file")),
    'a vessel file has no usable "shift.establishment[2].shifts[1]" - it must be day or night.',
    "a position on a shift that is not day or night is refused");
  is(said(() => checkVessel(example, "a vessel file")), "nothing", "the example vessel passes as it is");

  const manifest = JSON.parse(manifestFor(example));
  is([manifest.name, manifest.short_name, manifest.theme_color],
    [example.name + " " + example.nameAccent + " Crew Portal", example.shortName, example.theme.themeColor],
    "the manifest written for a vessel carries that vessel's name, short name and colour");
  is(manifest.icons.map((i) => i.src), ["/icon-192.png", "/icon-512.png"], "…and asks for the icons under the fixed served names");
}

/* ---- the offline rules: what the service worker keeps ---- */
{
  /* The service worker (source/app/sw.js) and the page decide by the same
     file, source/shared/offline-rules.js: run here as the module the
     worker has folded in, and again as the page has it spliced in, so
     neither can drift from the other. What is kept is exactly the page,
     the vendor files and four GET answers; everything else - every write,
     file bytes, the CDN scripts, the fauna app, another origin - goes to
     the network untouched. */
  const offline = await import(pathToFileURL(join(ROOT, "source", "shared", "offline-rules.js")).href);
  const ORIGIN = "https://portal.example";
  for (const [name, rules] of [["the module", offline], ["the page", lib]]) {
    const { cacheable, cacheName, keepable, isCachedAnswer, anotherPerson, FETCHED_AT_HEADER,
      networkWait, NETWORK_WAIT_MS, API_WAIT_MS, forgetsOn, earlierPortalCache, forgetsBefore } = rules;
    is(cacheable("GET", "/", ORIGIN), "page", name + ": the page is kept");
    is(cacheable("GET", ORIGIN + "/?tab=roster", ORIGIN), "page", name + ": …whatever the query on it");
    is(cacheable("GET", "/api/me", ORIGIN), "api", name + ": /api/me is kept");
    is(cacheable("GET", "/api/me?live=1", ORIGIN), null, name + ": …but the page's plain ask of who this is (proveIdentity) is neither kept nor answered from a copy");
    is(cacheable("GET", "/api/state", ORIGIN), "api", name + ": /api/state is kept");
    is(cacheable("GET", "/api/files", ORIGIN), "api", name + ": /api/files is kept");
    is(cacheable("GET", "/api/sync/last", ORIGIN), "api", name + ": /api/sync/last is kept");
    is(cacheable("GET", "/vendor/react.production.min.js", ORIGIN), "vendor", name + ": React is kept, copy first");
    is(cacheable("GET", "/vendor/fonts/ibm-plex-sans-latin-400-normal.woff2", ORIGIN), "vendor", name + ": …and the fonts");
    is(cacheable("POST", "/api/state", ORIGIN), null, name + ": a save goes straight to the network");
    is(cacheable("PUT", "/api/state", ORIGIN), null, name + ": …a PUT too");
    is(cacheable("GET", "/api/files/abc123", ORIGIN), null, name + ": file bytes are never kept");
    is(cacheable("GET", "/api/files?removed=1", ORIGIN), null, name + ": the removed listing is not the listing");
    is(cacheable("POST", "/api/round", ORIGIN), null, name + ": the round is never kept");
    is(cacheable("GET", "/api/round/progress", ORIGIN), null, name + ": nor its progress");
    is(cacheable("GET", "/api/fauna/export?month=2026-09", ORIGIN), null, name + ": nothing of the fauna log");
    is(cacheable("GET", "/fauna/", ORIGIN), null, name + ": the fauna app is not kept");
    is(cacheable("GET", "/login", ORIGIN), null, name + ": the sign-in page is not kept");
    is(cacheable("GET", "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js", ORIGIN), null, name + ": the spreadsheet reader from the CDN is not kept");
    is(cacheable("GET", "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js", ORIGIN), null, name + ": nor the PDF maker");
    is(cacheable("GET", "https://elsewhere.example/api/state", ORIGIN), null, name + ": another origin's /api/state is not this portal's");
    is(cacheable("GET", "not a url at all", ORIGIN), null, name + ": a bare word is a path under the portal that nothing keeps, not an error");
    is(cacheName("abc123"), "portal-abc123", name + ": a build's cache is named for its stamp");
    const headers = (o) => ({ get: (k) => (k in o ? o[k] : null) });
    is(keepable("page", 200, headers({ "X-Portal-Page": "portal" })), true, name + ": the page is kept when it carries the worker's mark");
    is(keepable("page", 200, headers({})), false, name + ": …never without it: that is the sign-in form");
    is(keepable("api", 200, headers({})), true, name + ": a good answer is kept");
    is(keepable("api", 401, headers({})), false, name + ": a refusal is not");
    is(keepable("api", 500, headers({})), false, name + ": nor a failure");
    is(keepable("vendor", 304, headers({})), false, name + ": nor a not-modified");
    is(isCachedAnswer(headers({ [FETCHED_AT_HEADER]: "2026-09-24T06:32:00.000Z" })), "2026-09-24T06:32:00.000Z", name + ": a kept copy says when it was fetched");
    is(isCachedAnswer(headers({})), null, name + ": a live answer carries no stamp");
    is(isCachedAnswer(null), null, name + ": …and no headers at all is no stamp");
    is(anotherPerson({ email: "a@example.com" }, { email: "b@example.com" }), true, name + ": a different email is a different person");
    is(anotherPerson({ email: "A@Example.com " }, { email: "a@example.com" }), false, name + ": the same email, however spelt, is the same person");
    is(anotherPerson(null, { email: "a@example.com" }), false, name + ": nothing kept decides nothing");
    is(anotherPerson({ email: "a@example.com" }, {}), false, name + ": …nor a live answer with no email");
    /* How long the network is given to start answering before the kept
       copy stands in: short for the page (a blank screen at sea), long
       for the four API answers - a slow link that answers in ten seconds
       is a link, and a kept copy handed back then would put a connected
       portal into offline mode, read only. */
    is(networkWait("page", "/"), NETWORK_WAIT_MS, name + ": the page waits NETWORK_WAIT_MS for the network to start answering");
    is(networkWait("api", "/api/state"), API_WAIT_MS, name + ": the document waits API_WAIT_MS");
    is(networkWait("api", "/api/files"), API_WAIT_MS, name + ": …the file listing too");
    is(networkWait("api", "/api/sync/last"), API_WAIT_MS, name + ": …and the hour's word");
    /* /api/me is the exception: the page boots on it and its kept copy is
       always the person signed in on this device (the worker forgets it on
       a 401 and on somebody else signing in), so the long wait buys
       nothing and cost thirty seconds of "Signing you in..." on a link
       that is connected but answers nothing. */
    is(networkWait("api", "/api/me"), NETWORK_WAIT_MS, name + ": /api/me waits only NETWORK_WAIT_MS - the boot waits on it, and its kept copy is always this person");
    is(networkWait("api", ORIGIN + "/api/me"), NETWORK_WAIT_MS, name + ": …by its full address too");
    is(networkWait("api"), API_WAIT_MS, name + ": an API answer with no address named waits the long way");
    is(NETWORK_WAIT_MS, 4000, name + ": …four seconds for the page");
    is(API_WAIT_MS, 30000, name + ": …thirty for the document, so a slow link is never taken for a dead one");
    /* When everything kept must go: the sign-in is over. */
    is(forgetsOn("api", 401, headers({})), true, name + ": a refused API call clears everything kept");
    is(forgetsOn("api", 200, headers({})), false, name + ": a good answer clears nothing");
    is(forgetsOn("api", 500, headers({})), false, name + ": nor a failure - the server being down is not the sign-in ending");
    is(forgetsOn("page", 200, headers({})), true, name + ": the sign-in form served where the page should be clears everything kept");
    is(forgetsOn("page", 200, headers({ "X-Portal-Page": "portal" })), false, name + ": the page itself clears nothing");
    is(forgetsOn("page", 502, headers({})), false, name + ": nor a page that could not be served");
    is(forgetsOn("vendor", 401, headers({})), false, name + ": a vendor file never decides this");
    /* What is forgotten before a request is even sent: the sign-out, and
       the request a sign-in completes through. The code posted to
       /login/verify is the one that sets the new cookie and sends the
       browser to the page; nothing on that path used to touch the kept
       copies, and the next person's page booted as the last person off
       the kept /api/me when the link was merely slow. */
    is(forgetsBefore("GET", "/logout", ORIGIN), "signOut", name + ": the sign-out address forgets everything before it is sent");
    is(forgetsBefore("GET", ORIGIN + "/logout", ORIGIN), "signOut", name + ": …in full too");
    is(forgetsBefore("POST", "/login/verify", ORIGIN), "signIn", name + ": the code posted to /login/verify is a sign-in completing");
    is(forgetsBefore("post", ORIGIN + "/login/verify", ORIGIN), "signIn", name + ": …whatever the case of the method");
    is(forgetsBefore("GET", "/login/verify", ORIGIN), null, name + ": a GET of that address completes nothing");
    is(forgetsBefore("POST", "/login", ORIGIN), null, name + ": asking for the code completes nothing either");
    is(forgetsBefore("GET", "/login", ORIGIN), null, name + ": nor does opening the sign-in form");
    is(forgetsBefore("GET", "/", ORIGIN), null, name + ": the page forgets nothing");
    is(forgetsBefore("POST", "/api/state", ORIGIN), null, name + ": nor a save");
    is(forgetsBefore("POST", "https://elsewhere.example/login/verify", ORIGIN), null, name + ": another origin's sign-in is none of this worker's");
    is(forgetsBefore("POST", "http://[bad", ORIGIN), null, name + ": an address that cannot be read forgets nothing");
    /* Whose kept answers come across on a new build. */
    is(earlierPortalCache("portal-aaa", "portal-bbb"), true, name + ": an earlier build's cache is carried across");
    is(earlierPortalCache("portal-bbb", "portal-bbb"), false, name + ": …not this build's own");
    is(earlierPortalCache("workbox-precache-v2", "portal-bbb"), false, name + ": …and never the cache of the worker from years ago");
    is(earlierPortalCache("", "portal-bbb"), false, name + ": …nor a nameless one");
  }
  is(offline.FETCHED_AT_HEADER, lib.FETCHED_AT_HEADER, "the stamp's header is the same word in the worker and the page");
  is(offline.KEPT_APIS, ["/api/me", "/api/state", "/api/files", "/api/sync/last"], "the four answers kept, and no more");
  /* The preview's shim writes the stamp on its answers under ?offline=1,
     outside the page's own script, so the header is spelt there a second
     time: held to the one word here. */
  const shim = readFileSync(join(ROOT, "tools", "preview", "shim.js"), "utf8");
  is(shim.includes('const OFFLINE_STAMP_HEADER = "' + offline.FETCHED_AT_HEADER + '";'), true,
    "the preview's shim stamps its answers under the same header the service worker uses");
  is(/const OFFLINE_STAMP = new Date\(/.test(shim), true,
    "the preview's stamp is set once when the page opens, so the badge's line stands still between polls");
}

/* ---- the service worker at work: a pretend network, a pretend clock ---- */
{
  /* source/app/sw.js as the build ships it (tools/source.mjs folds the
     rules in), run here against a network and a clock the test controls.
     What it proves is the thing that bit: with the link UP and slow, the
     page gets the live answer, never the kept copy. The race is on the
     fetch settling - the headers - not on the copy being kept, which reads
     the whole body first: raced on that, a 400 KB document on a slow sea
     link lost to the timer every poll, the page was handed its previous
     copy, stamped, and a connected portal went "Offline" and read only. */
  const ORIGIN = "https://portal.example";
  const offline = await import(pathToFileURL(join(ROOT, "source", "shared", "offline-rules.js")).href);
  const tick = () => new Promise((r) => setImmediate(r));
  const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
  /* One build's worker over one set of caches. Two worlds handed the same
     `shared` store are an old build and a new one on the same device: the
     old worker still answering while the new one installs. */
  const world = (version = "testbuild", shared = null) => {
    let now = 0;
    const timers = [];
    const setTimeoutFake = (fn, ms) => { timers.push({ at: now + (ms || 0), fn, done: false }); return timers.length; };
    const advance = async (ms) => {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => !t.done && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at; due.done = true; due.fn();
        await settle();
      }
      now = end;
      await settle();
    };
    const keyOf = (k) => (typeof k === "string" ? k : new URL(k.url).pathname);
    const stores = shared || new Map();
    const cacheOf = (name) => {
      if (!stores.has(name)) {
        const store = new Map();
        stores.set(name, {
          store,
          match: async (k) => (store.has(keyOf(k)) ? store.get(keyOf(k)).clone() : undefined),
          put: async (k, r) => { store.set(keyOf(k), r); },
          delete: async (k) => store.delete(keyOf(k)),
        });
      }
      return stores.get(name);
    };
    const caches = { open: async (n) => cacheOf(n), keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n) };
    const listeners = {};
    let claimed = false;
    // The portal tabs open on this device, each keeping what the worker
    // tells it (postMessage), and the question the worker asked for them.
    const tabs = [];
    const openTab = () => { const tab = { told: [], postMessage: (m) => tab.told.push(m) }; tabs.push(tab); return tab; };
    let askedFor = null, tabsRefuse = false;
    const self = { location: { origin: ORIGIN }, addEventListener: (t, f) => { listeners[t] = f; },
      skipWaiting: async () => {}, clients: { claim: async () => { claimed = true; },
        matchAll: async (q) => { askedFor = q; if (tabsRefuse) throw new DOMException("no clients", "InvalidStateError"); return [...tabs]; } } };
    let fetchFake = async () => { throw new TypeError("no network in this test"); };
    const sw = serviceWorkerSource(version, ["/vendor/react.production.min.js"]);
    const run = new Function("self", "caches", "fetch", "setTimeout", sw + NL + ";return { networkFirst, cacheFirst, keep, stamped, NAME };");
    const w = run(self, caches, (...a) => fetchFake(...a), setTimeoutFake);
    return { ...w, caches, cacheOf, listeners, advance, setFetch: (f) => { fetchFake = f; }, now: () => now, stores, claimed: () => claimed,
      openTab, askedFor: () => askedFor, refuseTabs: () => { tabsRefuse = true; } };
  };
  const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...headers } });
  const event = (path) => ({ request: new Request(ORIGIN + path), waitUntil(p) { this.done = (this.done || Promise.resolve()).then(() => p); } });
  const stampOf = (r) => r.headers.get(offline.FETCHED_AT_HEADER);

  {
    // The headers at once, the body six seconds later (the way a 400 KB
    // document comes down a slow sea link), a kept copy waiting.
    const w = world();
    const cache = w.cacheOf(w.NAME);
    cache.store.set("/api/state", await w.stamped(json({ rev: 8 })));
    w.setFetch(() => Promise.resolve(new Response(new ReadableStream({
      start(c) { w.bodyStart = () => { c.enqueue(new TextEncoder().encode('{"rev":9}')); c.close(); }; },
    }), { status: 200, headers: { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": "999" } })));
    const ev = event("/api/state");
    let answered = null;
    w.networkFirst(ev, "api").then((a) => { answered = a; });
    await settle();
    is(!!answered, true, "the page gets the live answer the moment its headers are in - the clock has not moved");
    is(stampOf(answered), null, "…and it is the live one, not the kept copy");
    is(w.now(), 0, "…at 0 s");
    // Six seconds on, the body lands: the page reads it, and the copy is kept.
    await w.advance(6000);
    w.bodyStart();
    await settle();
    is(await answered.text(), '{"rev":9}', "the body streams through to the page when it comes");
    await ev.done;
    const kept = cache.store.get("/api/state");
    is(await kept.clone().text(), '{"rev":9}', "the copy is refreshed with the live body once it has all come");
    is(!!stampOf(kept), true, "…stamped");
    is(kept.headers.get("Content-Encoding"), null, "…without the edge's Content-Encoding: the kept body is already decoded");
    is(kept.headers.get("Content-Length"), null, "…nor its Content-Length");
  }
  {
    // A slow link: nothing for five seconds, then the answer. Ten times
    // the page's wait, and still the live answer.
    const w = world();
    const cache = w.cacheOf(w.NAME);
    cache.store.set("/api/state", await w.stamped(json({ rev: 8 })));
    let give;
    w.setFetch(() => new Promise((r) => { give = r; }));
    let answered = null;
    w.networkFirst(event("/api/state"), "api").then((a) => { answered = a; });
    await settle();   // the worker sets its timer once the cache is open
    await w.advance(4500);
    is(answered, null, "four and a half seconds of silence on an API call is not yet the kept copy");
    give(json({ rev: 9 }));
    await w.advance(500);
    is(answered && stampOf(answered), null, "the answer that came at five seconds is the live one");
    is(answered && (await answered.json()).rev, 9, "…rev 9, not the kept rev 8");
  }
  {
    // A link that says nothing at all: the kept copy after API_WAIT_MS.
    const w = world();
    const cache = w.cacheOf(w.NAME);
    cache.store.set("/api/state", await w.stamped(json({ rev: 8 })));
    w.setFetch(() => new Promise(() => {}));
    let answered = null;
    w.networkFirst(event("/api/state"), "api").then((a) => { answered = a; });
    await settle();   // the worker sets its timer once the cache is open
    await w.advance(offline.API_WAIT_MS - 1);
    is(answered, null, "…not before API_WAIT_MS");
    await w.advance(1);
    is(answered && !!stampOf(answered), true, "a link that has said nothing for API_WAIT_MS is down: the kept copy, stamped");
    is(answered && (await answered.json()).rev, 8, "…the kept rev 8");
  }
  {
    // The link off outright: the kept copy at once.
    const w = world();
    const cache = w.cacheOf(w.NAME);
    cache.store.set("/api/state", await w.stamped(json({ rev: 8 })));
    w.setFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    let answered = null;
    w.networkFirst(event("/api/state"), "api").then((a) => { answered = a; });
    await settle();   // the worker sets its timer once the cache is open
    await settle();
    is(answered && !!stampOf(answered), true, "a fetch that fails gets the kept copy without waiting");
    is(w.now(), 0, "…at once");
  }
  {
    // The page itself waits only NETWORK_WAIT_MS: a blank screen at sea
    // is worse than a page four seconds old, and the live one refreshes
    // the copy for the next opening when it comes.
    const w = world();
    const cache = w.cacheOf(w.NAME);
    cache.store.set("/", await w.stamped(new Response("<html>old", { status: 200, headers: { "X-Portal-Page": "portal" } })));
    let give;
    w.setFetch(() => new Promise((r) => { give = r; }));
    const ev = event("/");
    let answered = null;
    w.networkFirst(ev, "page").then((a) => { answered = a; });
    await settle();
    await w.advance(offline.NETWORK_WAIT_MS);
    is(answered && !!stampOf(answered), true, "the page not started after NETWORK_WAIT_MS is the kept page");
    give(new Response("<html>new", { status: 200, headers: { "X-Portal-Page": "portal" } }));
    await w.advance(1000);
    await ev.done;
    is(await cache.store.get("/").clone().text(), "<html>new", "…and the live page, when it comes, is kept for the next opening");
  }
  {
    // The sign-in over: a 401 on a kept API clears the crew's answers and
    // the page, and leaves the build's own files.
    const w = world();
    const cache = w.cacheOf(w.NAME);
    for (const k of offline.KEPT_APIS) cache.store.set(k, await w.stamped(json({ k })));
    cache.store.set("/", await w.stamped(new Response("<html>", { status: 200, headers: { "X-Portal-Page": "portal" } })));
    cache.store.set("/vendor/react.production.min.js", new Response("react"));
    w.setFetch(() => Promise.resolve(new Response("{}", { status: 401 })));
    const ev = event("/api/me");
    const answered = await w.networkFirst(ev, "api");
    is(answered.status, 401, "the refusal reaches the page as it is");
    await ev.done;
    is([...cache.store.keys()], ["/vendor/react.production.min.js"], "…and everything kept of the crew's is gone: the four answers and the page, the vendor file left");
  }
  {
    // The sign-in form served where the page should be says the same.
    const w = world();
    const cache = w.cacheOf(w.NAME);
    cache.store.set("/api/state", await w.stamped(json({ rev: 8 })));
    cache.store.set("/", await w.stamped(new Response("<html>", { status: 200, headers: { "X-Portal-Page": "portal" } })));
    w.setFetch(() => Promise.resolve(new Response("<form>sign in", { status: 200 })));
    const ev = event("/");
    await w.networkFirst(ev, "page");
    await ev.done;
    is([...cache.store.keys()], [], "the sign-in form at the page's address clears the kept page and document");
  }
  {
    // A new build taking over: only an earlier portal cache's stamped
    // answers come across, and never another person's.
    const w = world();
    const mine = w.cacheOf(w.NAME);
    const old = w.cacheOf("portal-earlier");
    old.store.set("/api/me", await w.stamped(json({ email: "a@example.com" })));
    old.store.set("/api/state", await w.stamped(json({ rev: 8 })));
    old.store.set("/api/files", json([]));           // no stamp: not one of the worker's copies
    const stray = w.cacheOf("workbox-years-ago");
    stray.store.set("/api/state", await w.stamped(json({ rev: 1 })));
    const activate = { waitUntil(p) { this.done = p; } };
    w.listeners.activate(activate);
    await activate.done;
    is([...mine.store.keys()].sort(), ["/api/me", "/api/state"], "with nothing kept yet, the earlier build's stamped answers come across - the unstamped one does not");
    is(await w.caches.keys(), [w.NAME], "…and every other cache is gone, the stray one unread");
  }
  {
    const w = world();
    const mine = w.cacheOf(w.NAME);
    mine.store.set("/api/me", await w.stamped(json({ email: "b@example.com" })));
    const old = w.cacheOf("portal-earlier");
    old.store.set("/api/me", await w.stamped(json({ email: "a@example.com" })));
    old.store.set("/api/state", await w.stamped(json({ rev: 8 })));
    const activate = { waitUntil(p) { this.done = p; } };
    w.listeners.activate(activate);
    await activate.done;
    is([...mine.store.keys()], ["/api/me"], "an earlier cache kept for somebody else brings nothing across");
    is((await (await mine.match("/api/me")).json()).email, "b@example.com", "…and this build's own /api/me stands");
  }
  {
    // The phone's storage gone (full, or corrupted): caches.open rejects.
    // The cache failing must never fail the request - the page still gets
    // the live answer, plain, with the link up.
    const w = world();
    w.caches.open = async () => { throw new DOMException("storage is full", "QuotaExceededError"); };
    w.setFetch(() => Promise.resolve(json({ rev: 9 })));
    const ev = event("/api/state");
    const answered = await w.networkFirst(ev, "api");
    is(answered && (await answered.json()).rev, 9, "with the cache refusing to open, a poll still gets the live answer");
    is(stampOf(answered), null, "…the live one, unstamped");
    const page = await w.networkFirst(event("/"), "page");
    is(page && page.status, 200, "…and so does the page");
    const vendor = await w.cacheFirst(event("/vendor/react.production.min.js"));
    is(vendor && vendor.status, 200, "…and a vendor file, straight from the network");
    is(w.now(), 0, "…none of them waited on the cache");
  }
  {
    // The cache opens but cannot be read from: with the link off, the
    // request fails the way it always did, not on the cache's error.
    const w = world();
    const cache = w.cacheOf(w.NAME);
    cache.match = async () => { throw new DOMException("cannot read", "UnknownError"); };
    w.setFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    let failed = null;
    await w.networkFirst(event("/api/state"), "api").catch((e) => { failed = e; });
    is(failed instanceof TypeError, true, "a kept copy that cannot be read hands the page the network's own failure");
    w.setFetch(() => Promise.resolve(new Response("react", { status: 200 })));
    const vendor = await w.cacheFirst(event("/vendor/react.production.min.js"));
    is(await vendor.text(), "react", "…and a vendor file comes from the network");
  }
  {
    // A link that is connected but answers nothing (a satellite dish at
    // sea): the boot waits on /api/me, whose kept copy is always this
    // person, so it is answered from the copy after NETWORK_WAIT_MS -
    // while /api/state, which decides offline mode, still waits the full
    // API_WAIT_MS for the live answer.
    const w = world();
    const cache = w.cacheOf(w.NAME);
    cache.store.set("/api/me", await w.stamped(json({ email: "a@example.com" })));
    cache.store.set("/api/state", await w.stamped(json({ rev: 8 })));
    w.setFetch(() => new Promise(() => {}));
    let me = null, state = null;
    w.networkFirst(event("/api/me"), "api").then((a) => { me = a; });
    w.networkFirst(event("/api/state"), "api").then((a) => { state = a; });
    await settle();   // the worker sets its timers once the cache is open
    await w.advance(offline.NETWORK_WAIT_MS - 1);
    is(me, null, "/api/me is not the kept copy before NETWORK_WAIT_MS");
    await w.advance(1);
    is(me && !!stampOf(me), true, "…and is the kept copy at NETWORK_WAIT_MS: the boot goes on");
    is(state, null, "…while /api/state is still waiting for the live answer");
    await w.advance(offline.API_WAIT_MS - offline.NETWORK_WAIT_MS - 1);
    is(state, null, "…not before API_WAIT_MS");
    await w.advance(1);
    is(state && !!stampOf(state), true, "…and the kept document at API_WAIT_MS");
  }
  {
    /* The fetch listener itself: which requests it answers and which it
       leaves to the browser. A FetchEvent-like object: respondWith
       records the promise the worker answers with, waitUntil the work it
       runs alongside. A navigation cannot be built as a Request here
       (Node refuses the mode), so those are plain request-like objects. */
    const fetchEvent = (request) => ({
      request, answer: null, done: Promise.resolve(),
      respondWith(p) { this.answer = p; },
      waitUntil(p) { this.done = this.done.then(() => p); },
    });
    const w = world();
    const cache = w.cacheOf(w.NAME);
    cache.store.set("/vendor/react.production.min.js", new Response("react"));
    let calls = [];
    w.setFetch((r) => { calls.push((r.method || "GET") + " " + new URL(r.url).pathname); return Promise.resolve(json({ rev: 9 })); });
    // A poll of the document: answered by the worker, network first.
    const poll = fetchEvent(new Request(ORIGIN + "/api/state"));
    w.listeners.fetch(poll);
    is(!!poll.answer, true, "a GET of /api/state is answered by the worker");
    is((await (await poll.answer).json()).rev, 9, "…with the live document, network first");
    await poll.done;
    is(!!cache.store.get("/api/state"), true, "…and the answer is kept");
    // A vendor file: the kept copy, the network never asked.
    calls = [];
    const vendor = fetchEvent(new Request(ORIGIN + "/vendor/react.production.min.js"));
    w.listeners.fetch(vendor);
    is(!!vendor.answer, true, "a GET of a vendor file is answered by the worker");
    is(await (await vendor.answer).text(), "react", "…from the kept copy first");
    is(calls, [], "…without asking the network");
    // A save: the worker leaves it to the browser.
    const save = fetchEvent(new Request(ORIGIN + "/api/state", { method: "POST", body: "{}" }));
    w.listeners.fetch(save);
    is(save.answer, null, "a POST of /api/state is left to the browser: the worker neither answers nor keeps it");
    is(calls, [], "…and does not send it itself");
    // The sign-out: everything kept goes before the request is sent.
    cache.store.set("/api/me", await w.stamped(json({ email: "a@example.com" })));
    let keptWhenSent = null;
    w.setFetch(async (r) => { keptWhenSent = await w.caches.keys(); return new Response(null, { status: 303, headers: { Location: "/login" } }); });
    const out = fetchEvent({ url: ORIGIN + "/logout", method: "GET", mode: "navigate" });
    w.listeners.fetch(out);
    is(!!out.answer, true, "a navigation to /logout is answered by the worker");
    is((await out.answer).status, 303, "…with the server's own answer, the 303 the browser follows");
    is(keptWhenSent, [], "…sent only once the whole cache is gone");
    is(await w.caches.keys(), [], "…and it stays gone");
  }
  {
    /* The must-fix: a sign-in submitted on this device clears the last
       person's copies before the new person's page can boot. Person A's
       stamped /api/me and document are kept; B posts the code; the
       worker answers only once the crew's answers are gone, so the 303
       and the page after it find nothing of A's - and a slow /api/me for
       B is then NOT answered from a kept copy at NETWORK_WAIT_MS, where
       before it was A's, and the portal booted as A, live and editable. */
    const fetchEvent = (request) => ({
      request, answer: null, done: Promise.resolve(),
      respondWith(p) { this.answer = p; },
      waitUntil(p) { this.done = this.done.then(() => p); },
    });
    const w = world();
    const cache = w.cacheOf(w.NAME);
    cache.store.set("/api/me", await w.stamped(json({ email: "a@example.com" })));
    cache.store.set("/api/state", await w.stamped(json({ rev: 8 })));
    cache.store.set("/", await w.stamped(new Response("<html>", { status: 200, headers: { "X-Portal-Page": "portal" } })));
    cache.store.set("/vendor/react.production.min.js", new Response("react"));
    let keptWhenSent = null, sent = null;
    w.setFetch(async (r) => {
      sent = (r.method || "GET") + " " + new URL(r.url).pathname;
      keptWhenSent = [...cache.store.keys()];
      return new Response(null, { status: 303, headers: { Location: "/" } });
    });
    const signIn = fetchEvent({ url: ORIGIN + "/login/verify", method: "POST", mode: "navigate" });
    w.listeners.fetch(signIn);
    is(!!signIn.answer, true, "the code posted to /login/verify is answered by the worker");
    const answered = await signIn.answer;
    is(answered.status, 303, "…with the server's own answer, the 303 to the page");
    is(sent, "POST /login/verify", "…the request itself sent on as it was");
    is(keptWhenSent, ["/vendor/react.production.min.js"], "…and sent only once the crew's answers and the page were gone, the vendor file left");
    is([...cache.store.keys()], ["/vendor/react.production.min.js"], "afterwards only the vendor entry remains");
    // B's page boots and asks /api/me on a link that says nothing.
    w.setFetch(() => new Promise(() => {}));
    const me = fetchEvent(new Request(ORIGIN + "/api/me"));
    w.listeners.fetch(me);
    let booted = null;
    me.answer.then((a) => { booted = a; });
    await settle();   // the worker sets its timer once the cache is open
    await w.advance(offline.NETWORK_WAIT_MS + 1);
    is(booted, null, "the new person's slow /api/me is not answered from a kept copy at NETWORK_WAIT_MS: there is none");
    await w.advance(offline.API_WAIT_MS);
    is(booted, null, "…nor later: the page waits on the network, and never boots as the last person");
  }
  {
    /* The must-fix, second door: a deploy re-opened the one above. A
       navigation the worker handles has the browser check /sw.js, so when
       a build went out since this device last opened the page, B's
       sign-in POST itself starts the new worker installing while the old
       one is forgetting A's copies and sending the code on. The new
       build's install used to fetch /api/me itself - with the cookie the
       device held at that instant, A's, the 303 with B's cookie not yet
       back - and keep A in the NEW cache, which nothing ever forgot: the
       old worker's forget hit the old cache, and on taking over the new
       worker found A already kept and carried nothing. B's page then
       booted, and on a link slower than NETWORK_WAIT_MS was answered A's
       kept /api/me and opened as A, live and editable. Now an install
       never asks who is signed in: the person's copy comes across from
       the earlier build's cache on taking over, or stays gone if a
       sign-in forgot it. */
    const fetchEvent = (request) => ({
      request, answer: null, done: Promise.resolve(),
      respondWith(p) { this.answer = p; },
      waitUntil(p) { this.done = this.done.then(() => p); },
    });
    const shared = new Map();
    const oldBuild = world("oldbuild", shared);
    const oldCache = oldBuild.cacheOf(oldBuild.NAME);
    oldCache.store.set("/api/me", await oldBuild.stamped(json({ email: "a@example.com" })));
    oldCache.store.set("/api/state", await oldBuild.stamped(json({ rev: 8 })));
    oldCache.store.set("/", await oldBuild.stamped(new Response("<html>", { status: 200, headers: { "X-Portal-Page": "portal" } })));
    // B posts the code through the old worker. The server takes its time.
    let signInAnswer;
    oldBuild.setFetch(() => new Promise((r) => { signInAnswer = r; }));
    const signIn = fetchEvent({ url: ORIGIN + "/login/verify", method: "POST", mode: "navigate" });
    oldBuild.listeners.fetch(signIn);
    await settle();
    is([...oldCache.store.keys()], [], "the old worker has forgotten A's copies and sent B's code on");
    // Meanwhile the new build installs. The device's cookie is still A's:
    // anything that asks /api/me now is told A.
    const newBuild = world("newbuild", shared);
    const asked = [];
    newBuild.setFetch(async (r) => {
      const path = new URL(typeof r === "string" ? r : r.url, ORIGIN).pathname;
      asked.push(path);
      if (path === "/api/me") return json({ email: "a@example.com" });
      if (path === "/") return new Response("<html>new", { status: 200, headers: { "X-Portal-Page": "portal" } });
      return new Response("react", { status: 200 });
    });
    const install = { waitUntil(p) { this.done = p; } };
    newBuild.listeners.install(install);
    await install.done;
    is(asked.includes("/api/me"), false, "a build installing over an earlier build's cache, mid sign-in, never asks who is signed in");
    is(asked.includes("/"), false, "…nor fetches the page, which is somebody's");
    is(asked.includes("/vendor/react.production.min.js"), true, "…only the vendor files");
    // The 303 with B's cookie comes back, and the new worker takes over.
    signInAnswer(new Response(null, { status: 303, headers: { Location: "/" } }));
    is((await signIn.answer).status, 303, "B's sign-in completes");
    const activate = { waitUntil(p) { this.done = p; } };
    newBuild.listeners.activate(activate);
    await activate.done;
    const newCache = newBuild.cacheOf(newBuild.NAME);
    is(newCache.store.has("/api/me"), false, "on taking over, nothing of A's is kept in the new build's cache");
    is(await newBuild.caches.keys(), [newBuild.NAME], "…and the old build's cache is gone");
    // B's page boots and asks /api/me on a link that says nothing.
    newBuild.setFetch(() => new Promise(() => {}));
    const me = fetchEvent(new Request(ORIGIN + "/api/me"));
    newBuild.listeners.fetch(me);
    let booted = null;
    me.answer.then((a) => { booted = a; });
    await settle();
    await newBuild.advance(offline.NETWORK_WAIT_MS + 1);
    is(booted, null, "B's slow /api/me after the deploy is not answered from a kept copy at NETWORK_WAIT_MS: the portal never opens as A");
    await newBuild.advance(offline.API_WAIT_MS);
    is(booted, null, "…nor later");
  }
  {
    /* The must-fix, third door: a deploy found on the SIGN-OUT. A clicks
       Sign out: the page tells the old worker to forget, and the browser
       navigates to /logout - which the old worker answers itself, taking
       its whole cache first and only then sending the sign-out on. That
       navigation is also the browser's check of /sw.js, so a build gone
       out since installs while the server's 303 - the one that clears
       A's cookie - is still on its way. The new build's install used to
       look for an earlier cache to decide whether to ask who is signed
       in, and found none: the old worker had just deleted it. So it
       asked /api/me with the cookie the device still held - A's, not yet
       revoked - and kept A, and A's page, in the new cache, which nothing
       forgot. A signed-out device then held A's name, email and role, and
       offline opened the page as A. Now an install never asks who is
       signed in: the page keeps /api/me itself, once the first worker
       takes control, from a boot the server has already answered. */
    const fetchEvent = (request) => ({
      request, answer: null, done: Promise.resolve(),
      respondWith(p) { this.answer = p; },
      waitUntil(p) { this.done = this.done.then(() => p); },
    });
    const shared = new Map();
    const oldBuild = world("oldbuild", shared);
    const oldCache = oldBuild.cacheOf(oldBuild.NAME);
    oldCache.store.set("/api/me", await oldBuild.stamped(json({ email: "a@example.com" })));
    oldCache.store.set("/api/state", await oldBuild.stamped(json({ rev: 8 })));
    oldCache.store.set("/", await oldBuild.stamped(new Response("<html>", { status: 200, headers: { "X-Portal-Page": "portal" } })));
    // A signs out through the old worker. The server takes its time.
    let signOutAnswer;
    oldBuild.setFetch(() => new Promise((r) => { signOutAnswer = r; }));
    const signOut = fetchEvent({ url: ORIGIN + "/logout", method: "GET", mode: "navigate" });
    oldBuild.listeners.fetch(signOut);
    await settle();
    is(await oldBuild.caches.keys(), [], "the old worker has taken its whole cache and sent the sign-out on");
    // Meanwhile the new build installs. The cookie is still A's - the 303
    // revoking it has not come back - so anything asking /api/me is told A.
    const newBuild = world("newbuild", shared);
    const asked = [];
    newBuild.setFetch(async (r) => {
      const path = new URL(typeof r === "string" ? r : r.url, ORIGIN).pathname;
      asked.push(path);
      if (path === "/api/me") return json({ email: "a@example.com", name: "A", role: "management" });
      if (path === "/") return new Response("<html>new", { status: 200, headers: { "X-Portal-Page": "portal" } });
      return new Response("react", { status: 200 });
    });
    const install = { waitUntil(p) { this.done = p; } };
    newBuild.listeners.install(install);
    await install.done;
    const newCache = newBuild.cacheOf(newBuild.NAME);
    is(asked.includes("/api/me"), false, "a build installing during a sign-out, with no earlier cache to find, still never asks who is signed in");
    is(newCache.store.has("/api/me"), false, "…so the signed-out person is not kept in the new cache");
    // The 303 clearing A's cookie comes back, and the new worker takes over.
    signOutAnswer(new Response(null, { status: 303, headers: { Location: "/login" } }));
    is((await signOut.answer).status, 303, "A's sign-out completes");
    const activate = { waitUntil(p) { this.done = p; } };
    newBuild.listeners.activate(activate);
    await activate.done;
    is(newCache.store.has("/api/me"), false, "on taking over, the new cache still holds nobody");
    is(newCache.store.has("/api/state"), false, "…and no document");
    is(newCache.store.has("/"), false, "…and no page either: the install fetched only the build's own files, so nothing fetched on A's cookie is in the new cache");
    // Offline now, somebody opens the portal on the signed-out device.
    newBuild.setFetch(() => new Promise(() => {}));
    const me = fetchEvent(new Request(ORIGIN + "/api/me"));
    newBuild.listeners.fetch(me);
    let booted = null;
    me.answer.then((a) => { booted = a; });
    await settle();
    await newBuild.advance(offline.NETWORK_WAIT_MS + 1);
    is(booted, null, "a signed-out device asked /api/me offline is not answered from a copy: it holds nobody");
    await newBuild.advance(offline.API_WAIT_MS);
    is(booted, null, "…nor later");
  }
  {
    /* The sign-out race, in one build. A signs out: the worker deletes
       its cache and sends /logout on, and until the server's 303 comes
       back the cookie is still A's and the session not yet revoked. Any
       request the worker answered in that round trip - another tab's
       navigation to the page, a boot's /api/me, a poll of the document -
       came back 200 as A, opened the cache again (which re-created the
       one just deleted) and was kept there, and nothing forgot those
       copies afterwards: with the link down the portal booted as A on a
       device A had signed out of. Now the sign-out forgets a second time
       once the server has answered, and a copy fetched before a forget
       is never kept after it (era). */
    const fetchEvent = (request) => ({
      request, answer: null, done: Promise.resolve(),
      respondWith(p) { this.answer = p; },
      waitUntil(p) { this.done = this.done.then(() => p); },
    });
    const navigation = (path) => fetchEvent({ url: ORIGIN + path, method: "GET", mode: "navigate" });
    const w = world();
    const cache = w.cacheOf(w.NAME);
    cache.store.set("/api/me", await w.stamped(json({ email: "a@example.com" })));
    cache.store.set("/api/state", await w.stamped(json({ rev: 8 })));
    cache.store.set("/", await w.stamped(new Response("<html>", { status: 200, headers: { "X-Portal-Page": "portal" } })));
    let signOutAnswer;
    w.setFetch(async (r) => {
      const path = new URL(typeof r === "string" ? r : r.url, ORIGIN).pathname;
      if (path === "/logout") return new Promise((res) => { signOutAnswer = res; });
      if (path === "/") return new Response("<html>", { status: 200, headers: { "X-Portal-Page": "portal" } });
      if (path === "/api/me") return json({ email: "a@example.com", name: "A", role: "management" });
      return json({ rev: 9 });
    });
    const out = navigation("/logout");
    w.listeners.fetch(out);
    await settle();
    is(await w.caches.keys(), [], "the sign-out has taken the whole cache and sent /logout on");
    // While the server takes its time, the worker is asked for the page,
    // for who this is, and for the document - all still under A's cookie.
    const during = [navigation("/"), fetchEvent(new Request(ORIGIN + "/api/me")), fetchEvent(new Request(ORIGIN + "/api/state"))];
    for (const ev of during) w.listeners.fetch(ev);
    for (const ev of during) {
      is((await ev.answer).status, 200, "a request for " + new URL(ev.request.url).pathname + " during the sign-out's round trip is answered 200, as A");
      await ev.done;
    }
    signOutAnswer(new Response(null, { status: 303, headers: { Location: "/login" } }));
    is((await out.answer).status, 303, "A's sign-out completes");
    const keptAfter = (await w.caches.keys()).includes(w.NAME) ? [...w.cacheOf(w.NAME).store.keys()] : [];
    is(keptAfter.includes("/"), false, "after the 303 the cache holds no page");
    is(keptAfter.includes("/api/me"), false, "…no /api/me");
    is(keptAfter.includes("/api/state"), false, "…and no document: what was answered as A during the round trip is forgotten again after it");
    // The link down now: nothing is answered from a copy.
    w.setFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    for (const path of ["/", "/api/me", "/api/state"]) {
      const ev = path === "/" ? navigation("/") : fetchEvent(new Request(ORIGIN + path));
      w.listeners.fetch(ev);
      const answer = await ev.answer.catch(() => null);
      is(answer, null, "an offline GET of " + path + " on the signed-out device is not answered from a copy");
    }
  }
  {
    /* A poll of the document already out when the sign-out lands: its
       answer comes back as A after the cache has gone, and is not kept -
       no cache comes back for it. */
    const fetchEvent = (request) => ({
      request, answer: null, done: Promise.resolve(),
      respondWith(p) { this.answer = p; },
      waitUntil(p) { this.done = this.done.then(() => p); },
    });
    const w = world();
    const cache = w.cacheOf(w.NAME);
    cache.store.set("/api/state", await w.stamped(json({ rev: 8 })));
    let pollAnswer;
    w.setFetch(async (r) => {
      const path = new URL(typeof r === "string" ? r : r.url, ORIGIN).pathname;
      if (path === "/api/state") return new Promise((res) => { pollAnswer = res; });
      return new Response(null, { status: 303, headers: { Location: "/login" } });
    });
    const poll = fetchEvent(new Request(ORIGIN + "/api/state"));
    w.listeners.fetch(poll);
    await settle();
    const out = fetchEvent({ url: ORIGIN + "/logout", method: "GET", mode: "navigate" });
    w.listeners.fetch(out);
    is((await out.answer).status, 303, "the sign-out completes while a poll of the document is still out");
    pollAnswer(json({ rev: 9 }));
    is((await poll.answer).status, 200, "the poll's answer lands after the sign-out, as A");
    await poll.done;
    is(await w.caches.keys(), [], "…and is not kept: no cache comes back for it");
    w.setFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const offlinePoll = fetchEvent(new Request(ORIGIN + "/api/state"));
    w.listeners.fetch(offlinePoll);
    is(await offlinePoll.answer.catch(() => null), null, "…so an offline GET of the document is not answered from a copy");
  }
  {
    /* The sign-in twin. Tab 1 is open as A and polls the document; B
       posts the code in tab 2. The worker forgets A's copies and sends
       the code on - and A's poll, sent before that forget, is answered
       during the round trip, as A, under A's cookie. Kept, it was A's
       document beside B's /api/me. A copy fetched before a forget is
       never kept after it; B's boot /api/me, fetched after the 303, is. */
    const fetchEvent = (request) => ({
      request, answer: null, done: Promise.resolve(),
      respondWith(p) { this.answer = p; },
      waitUntil(p) { this.done = this.done.then(() => p); },
    });
    const w = world();
    const cache = w.cacheOf(w.NAME);
    cache.store.set("/api/me", await w.stamped(json({ email: "a@example.com" })));
    cache.store.set("/api/state", await w.stamped(json({ rev: 8 })));
    cache.store.set("/vendor/react.production.min.js", new Response("react"));
    const pollAnswers = [];
    let signInAnswer, cookie = "a";
    w.setFetch(async (r) => {
      const path = new URL(typeof r === "string" ? r : r.url, ORIGIN).pathname;
      if (path === "/api/state") return new Promise((res) => { pollAnswers.push(res); });
      if (path === "/login/verify") return new Promise((res) => { signInAnswer = res; });
      if (path === "/api/me") return json({ email: cookie + "@example.com" });
      return new Response("react", { status: 200 });
    });
    // Two polls of A's are out: one answered during B's round trip, one after it.
    const poll = fetchEvent(new Request(ORIGIN + "/api/state"));
    const latePoll = fetchEvent(new Request(ORIGIN + "/api/state"));
    w.listeners.fetch(poll);
    w.listeners.fetch(latePoll);
    await settle();
    const signIn = fetchEvent({ url: ORIGIN + "/login/verify", method: "POST", mode: "navigate" });
    w.listeners.fetch(signIn);
    await settle();
    is([...cache.store.keys()], ["/vendor/react.production.min.js"], "B's sign-in has forgotten A's copies and sent the code on");
    pollAnswers[0](json({ rev: 9 }));
    is((await poll.answer).status, 200, "A's poll is answered during B's sign-in round trip");
    await poll.done;
    is(cache.store.has("/api/state"), false, "…and A's document is not kept: it was fetched before the forget");
    cookie = "b";
    signInAnswer(new Response(null, { status: 303, headers: { Location: "/" } }));
    is((await signIn.answer).status, 303, "B's sign-in completes");
    pollAnswers[1](json({ rev: 9 }));
    is((await latePoll.answer).status, 200, "A's other poll is answered after the 303, still as A - it went out on A's cookie");
    await latePoll.done;
    is(cache.store.has("/api/state"), false, "…and is not kept either");
    // B's page boots and asks /api/me: fetched after the forget, it is B's and is kept.
    const me = fetchEvent(new Request(ORIGIN + "/api/me"));
    w.listeners.fetch(me);
    is((await (await me.answer).json()).email, "b@example.com", "B's boot /api/me is the live answer");
    await me.done;
    is((await (await cache.match("/api/me")).json()).email, "b@example.com", "…and is kept: B's, fetched after the forget");
    is([...cache.store.keys()].sort(), ["/api/me", "/vendor/react.production.min.js"], "…beside nothing of A's");
  }
  {
    /* The sign-in that did not pass through this worker: A's copies are
       kept, and a live /api/me comes back as B with no /login/verify
       before it (the cookie changed elsewhere). The keep clears A's
       copies itself - and must still keep the very answer that told it,
       or B reads nothing offline until their next online opening. */
    const fetchEvent = (request) => ({
      request, answer: null, done: Promise.resolve(),
      respondWith(p) { this.answer = p; },
      waitUntil(p) { this.done = this.done.then(() => p); },
    });
    const w = world();
    const cache = w.cacheOf(w.NAME);
    cache.store.set("/api/me", await w.stamped(json({ email: "a@example.com" })));
    cache.store.set("/api/state", await w.stamped(json({ rev: 8 })));
    cache.store.set("/", new Response("<html>", { status: 200, headers: { "X-Portal-Page": "portal" } }));
    w.setFetch(async () => json({ email: "b@example.com" }));
    const me = fetchEvent(new Request(ORIGIN + "/api/me"));
    w.listeners.fetch(me);
    is((await (await me.answer).json()).email, "b@example.com", "a live /api/me as B, with no sign-in through this worker, is the live answer");
    await me.done;
    is([...cache.store.keys()], ["/api/me"], "…A's copies are cleared and B's /api/me is the one thing kept");
    is((await (await cache.match("/api/me")).json()).email, "b@example.com", "…and it reads as B");
  }
  {
    /* The same, with the page's own forget (a sign-out's word) landing
       while that answer's body is still being read: the forget wins, and
       nothing is kept - not B's /api/me either. */
    const fetchEvent = (request) => ({
      request, answer: null, done: Promise.resolve(),
      respondWith(p) { this.answer = p; },
      waitUntil(p) { this.done = this.done.then(() => p); },
    });
    const w = world();
    const cache = w.cacheOf(w.NAME);
    cache.store.set("/api/me", await w.stamped(json({ email: "a@example.com" })));
    cache.store.set("/api/state", await w.stamped(json({ rev: 8 })));
    cache.store.set("/", new Response("<html>", { status: 200, headers: { "X-Portal-Page": "portal" } }));
    let bodyStart;
    w.setFetch(() => Promise.resolve(new Response(new ReadableStream({
      start(c) { bodyStart = () => { c.enqueue(new TextEncoder().encode('{"email":"b@example.com"}')); c.close(); }; },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const me = fetchEvent(new Request(ORIGIN + "/api/me"));
    w.listeners.fetch(me);
    is((await me.answer).status, 200, "the live /api/me is answered on its headers, body still to come");
    await settle();
    const told = { data: { type: offline.FORGET_MESSAGE }, waitUntil(p) { this.done = p; } };
    w.listeners.message(told);
    await told.done;
    is(await w.caches.keys(), [], "the page's forget lands while the body is being read: everything kept goes");
    bodyStart();
    await me.done;
    is(await w.caches.keys(), [], "…and the answer that lived through it is not kept: B's /api/me is dropped too");
    /* Looked at on the handle keep() was writing to, not only on the
       store's list: a forget dooms the old cache, so its keys are gone
       either way, and only the handle can say whether B's answer was
       put after the forget or dropped before anything ran. */
    const onHandle = cache.store.has("/api/me") ? (await cache.store.get("/api/me").clone().json()).email : null;
    is(onHandle, "a@example.com", "…B's answer never reached the cache: the forget's deletes are the last word");
  }
  {
    // A first-ever install, no earlier cache: only the build's own files
    // - React, React DOM and the fonts - are fetched for the head start.
    // Neither who is signed in nor the page: the install cannot know
    // whether the cookie it holds is mid sign-out, and the page is served
    // only to somebody signed in. The page, booted live as the cookie's
    // person, asks /api/me and the page again once this worker takes
    // control (keepIdentityOnceControlled), and those are the first of
    // each kept.
    const w = world();
    const asked = [];
    w.setFetch(async (r) => {
      const path = new URL(typeof r === "string" ? r : r.url, ORIGIN).pathname;
      asked.push(path);
      if (path === "/api/me") return json({ email: "a@example.com" });
      if (path === "/") return new Response("<html>", { status: 200, headers: { "X-Portal-Page": "portal" } });
      return new Response("react", { status: 200 });
    });
    const install = { waitUntil(p) { this.done = p; } };
    w.listeners.install(install);
    await install.done;
    is(asked.includes("/api/me"), false, "a first install, with no earlier cache, still never asks who is signed in");
    is(asked.includes("/"), false, "…nor fetches the page: it is somebody's, served only behind their sign-in");
    is(asked.includes("/vendor/react.production.min.js"), true, "…only the vendor files");
    is([...w.cacheOf(w.NAME).store.keys()], ["/vendor/react.production.min.js"], "…and keeps exactly those");
    // The page, controlled now, asks for the page and /api/me again: they
    // go through the worker and are kept the ordinary way.
    const fetchEvent = (request) => ({ request, answer: null, done: Promise.resolve(), respondWith(p) { this.answer = p; }, waitUntil(p) { this.done = this.done.then(() => p); } });
    const page = fetchEvent({ url: ORIGIN + "/", method: "GET" });
    w.listeners.fetch(page);
    is((await page.answer).status, 200, "the page's own ask of /, through the worker, is the live page");
    await page.done;
    is(await (await w.cacheOf(w.NAME).match("/")).text(), "<html>", "…and is the first page kept");
    const me = fetchEvent(new Request(ORIGIN + "/api/me"));
    w.listeners.fetch(me);
    is((await (await me.answer).json()).email, "a@example.com", "the page's own ask of /api/me, through the worker, is the live answer");
    await me.done;
    is((await (await w.cacheOf(w.NAME).match("/api/me")).json()).email, "a@example.com", "…and is the first /api/me kept");
  }
  {
    /* The should-fix: a sign-in answered by the worker is told to every
       open portal tab, uncontrolled ones included. Tab 1 is open as A;
       B signs in on tab 2 of the same browser, which replaces the cookie
       for both. Tab 1 used to poll and save under B's cookie in A's name
       for as long as it stayed open - a live boot was never re-proven.
       Told, it asks the server who this is (proveIdentity) and reloads
       as B. Told after the server's answer, so the cookie is B's already
       when tab 1 asks. */
    const fetchEvent = (request) => ({ request, answer: null, respondWith(p) { this.answer = p; }, waitUntil() {} });
    const w = world();
    const tab1 = w.openTab();
    const tab2 = w.openTab();
    let toldWhenSent = null;
    w.setFetch(async () => { toldWhenSent = tab1.told.length; return new Response(null, { status: 303, headers: { Location: "/" } }); });
    const signIn = fetchEvent({ url: ORIGIN + "/login/verify", method: "POST", mode: "navigate" });
    w.listeners.fetch(signIn);
    is((await signIn.answer).status, 303, "the sign-in is answered with the server's 303");
    is(tab1.told, [{ type: offline.SIGNED_IN_MESSAGE }], "…and the tab open as the last person is told a sign-in happened");
    is(tab2.told, [{ type: offline.SIGNED_IN_MESSAGE }], "…every open tab is");
    is(toldWhenSent, 0, "…told only once the server has answered, so the cookie is the new person's when the tab asks");
    is(w.askedFor(), { type: "window", includeUncontrolled: true }, "…the portal's windows, whether or not this worker controls them yet");
    // A sign-out tells nobody: the page that signed out sent the word
    // itself, and any other tab's next poll is a live 401.
    const out = fetchEvent({ url: ORIGIN + "/logout", method: "GET", mode: "navigate" });
    w.listeners.fetch(out);
    is((await out.answer).status, 303, "a sign-out is answered as before");
    is(tab1.told.length, 1, "…and tells the tabs nothing more");
    // The tabs cannot be listed: the sign-in still completes.
    const broken = world();
    broken.refuseTabs();
    broken.setFetch(async () => new Response(null, { status: 303, headers: { Location: "/" } }));
    const again = fetchEvent({ url: ORIGIN + "/login/verify", method: "POST", mode: "navigate" });
    broken.listeners.fetch(again);
    is((await again.answer).status, 303, "with nobody to tell, the sign-in still comes back with its 303");
  }
  {
    // A deploy with the same person signed in throughout: the earlier
    // cache's copies come across on taking over, so the phone is never
    // left with nothing to read, and the boot's /api/me is that person.
    const shared = new Map();
    const oldBuild = world("oldbuild", shared);
    const oldCache = oldBuild.cacheOf(oldBuild.NAME);
    oldCache.store.set("/api/me", await oldBuild.stamped(json({ email: "b@example.com" })));
    oldCache.store.set("/api/state", await oldBuild.stamped(json({ rev: 8 })));
    oldCache.store.set("/", await oldBuild.stamped(new Response("<html>old", { status: 200, headers: { "X-Portal-Page": "portal" } })));
    const newBuild = world("newbuild", shared);
    let askedWho = false;
    newBuild.setFetch(async (r) => {
      const path = new URL(typeof r === "string" ? r : r.url, ORIGIN).pathname;
      if (path === "/api/me") askedWho = true;
      return new Response("x", { status: 200, headers: { "X-Portal-Page": "portal" } });
    });
    const install = { waitUntil(p) { this.done = p; } };
    newBuild.listeners.install(install);
    await install.done;
    const activate = { waitUntil(p) { this.done = p; } };
    newBuild.listeners.activate(activate);
    await activate.done;
    const mine = newBuild.cacheOf(newBuild.NAME);
    is(askedWho, false, "a deploy with the same person signed in asks nobody who that is");
    is((await (await mine.match("/api/me")).json()).email, "b@example.com", "…their /api/me comes across from the earlier build's cache");
    is((await (await mine.match("/api/state")).json()).rev, 8, "…with their document");
    is(await (await mine.match("/")).text(), "<html>old", "…and the page they last opened, since the install fetched none: the next opening with the link up replaces it");
  }
  {
    // The phone's storage gone at install: caches.open and caches.keys
    // both refuse. The worker still installs and takes over - the page
    // just reads from the network, plain - where before the install's
    // waitUntil rejected, the worker went redundant, and the browser
    // registered it again, and failed again, on every page load.
    const w = world();
    let claimed = false;
    w.caches.open = async () => { throw new DOMException("cannot open", "UnknownError"); };
    w.caches.keys = async () => { throw new DOMException("cannot open", "UnknownError"); };
    w.setFetch(() => Promise.resolve(new Response("x", { status: 200 })));
    const install = { waitUntil(p) { this.done = p; } };
    w.listeners.install(install);
    let installed = "not yet";
    await install.done.then(() => { installed = "installed"; }, (e) => { installed = "failed: " + e; });
    is(installed, "installed", "with the cache refusing to open, the worker still installs");
    const activate = { waitUntil(p) { this.done = p; } };
    w.listeners.activate(activate);
    let activated = "not yet";
    await activate.done.then(() => { activated = "activated"; }, (e) => { activated = "failed: " + e; });
    is(activated, "activated", "…and takes over");
    is(w.claimed(), true, "…claiming the open page, so it is not left uncontrolled until its next navigation");
  }
  {
    // The cache failing never fails the sign-in: with the phone's storage
    // gone, the code still goes to the server and the 303 comes back.
    const fetchEvent = (request) => ({ request, answer: null, respondWith(p) { this.answer = p; }, waitUntil() {} });
    const w = world();
    w.caches.open = async () => { throw new DOMException("storage is full", "QuotaExceededError"); };
    w.caches.delete = async () => { throw new DOMException("storage is full", "QuotaExceededError"); };
    w.setFetch(async () => new Response(null, { status: 303, headers: { Location: "/" } }));
    const signIn = fetchEvent({ url: ORIGIN + "/login/verify", method: "POST", mode: "navigate" });
    w.listeners.fetch(signIn);
    is((await signIn.answer).status, 303, "with the cache refusing, a sign-in still reaches the server and its 303 comes back");
    const out = fetchEvent({ url: ORIGIN + "/logout", method: "GET", mode: "navigate" });
    w.listeners.fetch(out);
    is((await out.answer).status, 303, "…and so does a sign-out");
  }
}

/* ---- the page offline: the badge's line, the lock, the picker ---- */
{
  /* Three rules the page keeps at the top: what the badge says while the
     portal is offline, when nothing may be written, and when the preview's
     name picker may stand in for the sign-in. The last one is the bug
     that started this: a link that was down used to fall through to the
     honour-system picker on the live site. */
  const { offlineLine, controlsLocked, offlineAfterPull, signInOverAfterPull, showPicker, identityUnproven, keepIdentityAfterControl, keepIdentityOnceControlled, reloadToBeControlled, SIGNED_IN_MESSAGE, VESSEL } = lib;
  /* What a poll of /api/state decides. A live answer of any status ends
     offline mode: a 500 is a server in trouble on a link that is up, and
     the badge says Not saving with the reason, as it always did. Before
     this a link that came back to a worker mid-deploy kept "Offline" on
     the badge and every edit refused until the first 200. */
  const STAMP = "2026-09-24T06:32:00.000Z";
  is(offlineAfterPull(null, true, null), null, "a live answer, online, stays online");
  is(offlineAfterPull(null, true, STAMP), STAMP, "a kept copy puts the portal offline as at its stamp");
  is(offlineAfterPull(STAMP, true, null), null, "a live answer ends offline mode, 200 or not: the rule is not shown the status");
  is(offlineAfterPull(STAMP, true, STAMP), STAMP, "a kept copy, good or failed, does not: nothing live has been heard");
  is(offlineAfterPull(STAMP, false, null), STAMP, "no answer at all (the link down, nothing kept) changes nothing");
  is(offlineAfterPull(null, false, null), null, "…online or offline");
  /* A live 401 on the poll is the sign-in over - expired while the tab
     was open, or taken away - and the tab goes to the sign-in page the
     way the boot does. Before this it sat on "Couldn't load the portal
     (401)" until somebody pressed Try again. */
  is(signInOverAfterPull(true, null, 401), true, "a live 401 on the poll is the sign-in over: the tab goes to the sign-in page");
  is(signInOverAfterPull(true, STAMP, 401), false, "a kept 401 is not: it is a copy of one already acted on");
  is(signInOverAfterPull(true, null, 503), false, "a live 503 is a server in trouble, not a sign-in over");
  is(signInOverAfterPull(false, null, undefined), false, "no answer at all decides nothing");
  is(signInOverAfterPull(undefined, undefined, 401), false, "…even with a 401 left on the error from somewhere else");
  /* A kept identity is trusted only while the document is kept. The page
     booted on the worker's copy of /api/me (the link said nothing for four
     seconds); the moment a live document lands the server is asked plainly
     who this is - a copy the worker should not have had, the last person's
     kept by a build installing mid sign-in, can never run the portal as
     them for long. */
  is(identityUnproven(STAMP, null), true, "a kept /api/me under a live document: the server is asked who this is");
  is(identityUnproven(STAMP, STAMP), false, "a kept /api/me under a kept document is offline, and nobody to ask");
  is(identityUnproven(null, null), false, "a live /api/me needs no proving");
  is(identityUnproven(null, STAMP), false, "…offline or not");
  /* The first worker's kept /api/me is the page's to give. An install
     never asks who is signed in (it runs on whatever cookie the device
     holds at that instant - a sign-out's, before the 303 revoking it has
     come back), so a page that booted live with no worker in front of it
     asks /api/me again once the worker takes control, and that answer is
     kept. A page controlled from the start had its boot's /api/me kept as
     it came through; a kept boot has nothing live to give. */
  is(keepIdentityAfterControl(null, false), true, "a live boot with no worker in front of it re-asks /api/me once the worker takes control");
  is(keepIdentityAfterControl(STAMP, false), false, "a kept boot has nothing live to give");
  is(keepIdentityAfterControl(null, true), false, "a page controlled from the start needs nothing: its boot's /api/me was kept as it came through");
  is(keepIdentityAfterControl(STAMP, true), false, "…nor a kept boot under a worker");
  /* The hook itself, against a pretend navigator.serviceWorker. Whether
     the boot's /api/me went through the worker is decided by whether a
     worker controlled the page when that request was SENT, not when it
     was answered: judged after the answer, a worker that took control
     while /api/me was on the wire looked like one that had answered it,
     no listener was armed, controllerchange had already fired, and the
     page never asked again that session - a phone opened once at the
     wharf and reopened at sea had no /api/me kept and got "Couldn't
     reach the portal". So control is sampled before the send, the
     listener goes on synchronously, and a worker already in control is
     re-asked at once. The re-ask fetches the page too: the install keeps
     only the build's own files, so the page's copy is the page's to give
     as well. */
  const pretendWorker = () => {
    const listening = new Set();
    let becameReady;
    const sw = {
      controller: null,
      ready: new Promise((r) => { becameReady = r; }),
      addEventListener: (type, fn) => { if (type === "controllerchange") listening.add(fn); },
      removeEventListener: (type, fn) => { listening.delete(fn); },
    };
    const asks = [];
    // What the page fetches, and whether a worker stood in front of it then.
    const fetchFn = (url) => { asks.push({ path: url, throughWorker: !!sw.controller }); return Promise.resolve(new Response("{}")); };
    const takeControl = () => { sw.controller = { scriptURL: "/sw.js" }; [...listening].forEach((fn) => fn({ type: "controllerchange" })); };
    const waits = [];
    const reloads = [];
    let tried = false;
    const reclaim = { tried: () => tried, mark: () => { tried = true; }, reload: () => reloads.push(1), wait: (fn) => waits.push(fn) };
    return { sw, asks, fetchFn, takeControl, activate: () => becameReady({ active: { state: "activated" } }), listening, waits, reloads, reclaim, tried: () => tried };
  };
  const throughWorker = (asks) => asks.filter((a) => a.throughWorker).map((a) => a.path).sort();
  {
    // Control taken after the boot's answer: the ordinary first install.
    const p = pretendWorker();
    is(keepIdentityOnceControlled(p.sw, p.fetchFn, false, null, p.reclaim), true, "a live boot with no worker in front of it arms the re-ask");
    is(p.listening.size, 1, "…the listener goes on at once, not after ready");
    is(p.asks, [], "…and nothing is asked until the worker controls the page");
    p.takeControl();
    is(throughWorker(p.asks), ["/", "/api/me"], "control taken after the answer: /api/me and the page are asked again, through the worker");
    is(p.listening.size, 0, "…once");
  }
  {
    // Control taken while the boot's /api/me was on the wire: the answer
    // bypassed the worker, the controller is set by the time the page
    // looks, and controllerchange has already fired.
    const p = pretendWorker();
    p.takeControl();
    is(keepIdentityOnceControlled(p.sw, p.fetchFn, false, null, p.reclaim), true, "control taken while the boot request was out: the page still gives the worker its /api/me");
    is(throughWorker(p.asks), ["/", "/api/me"], "…asked again now, through the worker");
    is(p.listening.size, 0, "…and nothing left listening");
  }
  {
    // Control taken just after the hook is armed, before anything else
    // has run: the listener is already on.
    const p = pretendWorker();
    keepIdentityOnceControlled(p.sw, p.fetchFn, false, null, p.reclaim);
    p.takeControl();
    is(throughWorker(p.asks), ["/", "/api/me"], "control taken just after the hook is armed: asked again, through the worker");
    is(p.asks.length, 2, "…exactly once each");
  }
  {
    // Nothing to give: a page controlled from the start, a kept boot, no worker at all.
    const p = pretendWorker();
    p.takeControl();
    is(keepIdentityOnceControlled(p.sw, p.fetchFn, true, null, p.reclaim), false, "a page controlled from the start asks nothing again: its boot went through the worker");
    is(keepIdentityOnceControlled(p.sw, p.fetchFn, false, STAMP, p.reclaim), false, "a kept boot has nothing live to give");
    is(p.asks, [], "…and neither fetched anything");
    is(keepIdentityOnceControlled(null, p.fetchFn, false, null, p.reclaim), false, "no worker at all: nothing to do");
  }
  /* A hard reload (shift-reload, or a reload from the browser's own
     offline error page) leaves the page uncontrolled while the worker is
     already active: controllerchange never fires, every fetch of that
     page session bypasses the worker, nothing kept is refreshed for as
     long as the tab stays open, and a sign-out from it cannot post its
     forget. Such a page reloads itself once to come under the worker. */
  is(reloadToBeControlled(false, true, false), true, "uncontrolled with the worker already active: reload once to be controlled");
  is(reloadToBeControlled(true, true, false), false, "controlled: nothing to do");
  is(reloadToBeControlled(false, false, false), false, "no active worker yet: it will take control by itself");
  is(reloadToBeControlled(false, true, true), false, "already tried once: never a second time, whatever the reason it did not take");
  {
    // The hook after a hard reload: ready resolves with an active worker,
    // no controllerchange comes, and the page reloads once.
    const p = pretendWorker();
    keepIdentityOnceControlled(p.sw, p.fetchFn, false, null, p.reclaim);
    p.activate();
    await new Promise((r) => setImmediate(r));
    is(p.waits.length, 1, "with the worker active and the page not controlled, the page gives the claim a moment");
    p.waits[0]();
    is(p.reloads, [1], "…and, still not controlled, reloads once");
    is(p.tried(), true, "…marking that it has");
    is(p.asks, [], "…without asking anything: the reloaded page will boot through the worker");
  }
  {
    // The moment passes and the worker has taken control in it: no reload.
    const p = pretendWorker();
    keepIdentityOnceControlled(p.sw, p.fetchFn, false, null, p.reclaim);
    p.activate();
    await new Promise((r) => setImmediate(r));
    p.takeControl();
    p.waits[0]();
    is(p.reloads, [], "a first install whose worker takes control in the moment given is not reloaded");
    is(throughWorker(p.asks), ["/", "/api/me"], "…it was re-asked instead");
  }
  {
    // Already tried once: never again.
    const p = pretendWorker();
    p.reclaim.mark();
    keepIdentityOnceControlled(p.sw, p.fetchFn, false, null, p.reclaim);
    p.activate();
    await new Promise((r) => setImmediate(r));
    if (p.waits[0]) p.waits[0]();
    is(p.reloads, [], "a page that has already reloaded once for this is never reloaded again");
  }
  is(SIGNED_IN_MESSAGE, "signedIn", "the worker's word to every tab that a sign-in happened on this device");
  is(VESSEL.timezone, "Australia/Perth", "the line is read in the vessel's own time (the test's cases are in it)");
  // 06:32 UTC is 14:32 in the vessel's time.
  is(offlineLine("2026-09-24T06:32:00.000Z", Date.parse("2026-09-24T09:00:00.000Z")),
    "Offline — showing the portal as at 24 Sep, 14:32", "the badge says when the copy on screen was fetched, without the year when that was today");
  is(offlineLine("2026-09-24T06:32:00.000Z", Date.parse("2026-09-25T09:00:00.000Z")),
    "Offline — showing the portal as at 24 Sep 2026, 14:32", "…and with the year when it was not");
  // 16:30 UTC on the 23rd is already the 24th in the vessel's time.
  is(offlineLine("2026-09-23T16:30:00.000Z", Date.parse("2026-09-24T09:00:00.000Z")),
    "Offline — showing the portal as at 24 Sep, 00:30", "the day is the vessel's day, not UTC's");
  is(offlineLine("2026-01-05T01:07:00.000Z", Date.parse("2026-01-05T02:00:00.000Z")),
    "Offline — showing the portal as at 5 Jan, 09:07", "a single-figure day is written plainly");
  is(offlineLine("not a time", Date.now()), "Offline — showing the portal as last loaded", "a stamp that cannot be read still says offline");
  is(offlineLine(null, Date.now()), "Offline — showing the portal as last loaded", "…and so does no stamp at all");

  is(controlsLocked(null, false), false, "online with no round running, everything may be written");
  is(controlsLocked("2026-09-24T06:32:00.000Z", false), true, "offline, nothing may be written");
  is(controlsLocked(null, true), true, "the round running holds the workbook's buttons as before");
  is(controlsLocked("2026-09-24T06:32:00.000Z", true), true, "…and both together lock too");

  is(showPicker(true, "Couldn't reach the portal"), true, "under the preview's shim a failed /api/me shows the picker");
  is(showPicker(undefined, "Couldn't reach the portal"), false, "on the live site it never does: a link that is down is not a sign-in");
  is(showPicker(false, "Couldn't reach the portal"), false, "…nor with the flag set to anything but true");
  is(showPicker(true, null), false, "and under the shim a /api/me that answered needs no picker");
}

/* ---- the bands: one number for red, the same on the page and in the emails ---- */
{
  const { bandFor, daysTo, daysUntil, RED_DAYS, AMBER_DAYS, TODAY } = lib;
  const bands = await import(pathToFileURL(join(ROOT, "source", "shared", "bands.js")).href);
  is([RED_DAYS, AMBER_DAYS], [90, 180], "red is expired or within 90 days, amber within 180");
  is([bands.RED_DAYS, bands.AMBER_DAYS], [RED_DAYS, AMBER_DAYS], "the page and the worker read the same two numbers");
  is([/within 90\b/.test(portalJsx()), (portalJsx().match(/within \$\{RED_DAYS\} days/g) || []).length], [false, 6],
    "the reports' headings say the red band's days from RED_DAYS, never a 90 written in by hand");
  is(daysUntil("2026-10-12", "2026-09-24"), 18, "18 days from 24 Sep to 12 Oct");
  is(daysUntil("2026-09-21", "2026-09-24"), -3, "three days gone is -3");
  is(daysUntil("2026-04-06", "2026-04-04"), 2, "a daylight-saving weekend elsewhere moves nothing");
  const on = (n) => new Date(new Date(TODAY).getTime() + n * 86400000).toISOString().slice(0, 10);
  is(daysTo(on(18)), 18, "the page's daysTo counts from today by the shared count");
  is(bandFor(on(-3)).key, "red", "expired is red");
  is(bandFor(on(0)).key, "red", "expiring today is red");
  is(bandFor(on(90)).key, "red", "90 days is still red");
  is(bandFor(on(91)).key, "orange", "91 days is amber");
  is(bandFor(on(180)).key, "orange", "180 days is still amber");
  is(bandFor(on(181)).key, "green", "181 days is green");
  is(bandFor(on(91)).days, 91, "the band carries its days");
  is([bandFor("Y").key, bandFor("n").key, bandFor("OPEN").key, bandFor("x").key, bandFor("")],
    ["held", "not", "not", "unknown", null], "the words keep their bands");
}

/* ---- the weekly reminders: what is on a list, who is sent it, when ---- */
{
  const { REMINDER_DEFAULTS, reminderSetting, expiringWithin, byPerson, recipientsFor, reminderDue, reminderOwed, reminderItemLine,
    reminderText, summaryText, crewRowsOnly, crewRegister, nameLetters, registerWords, daysUntil, RED_DAYS, VESSEL } = lib;
  // The page's own copies of the rules the reminders lean on, handed in the
  // way the worker hands in the modules'.
  const rules = { crewRowsOnly, crewRegister, nameLetters, registerWords, daysUntil };
  const today = "2026-09-28";
  const on = (n) => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
  const quals = {
    cols: [["QL-01", "Master", "Qualification"], ["QL-17", "AMSA Medical", "Medical"], ["VS-04", "Induction", "E-Learning"]],
    rows: [
      ["SITTIYOS, Kachin", "Cook", "", [on(90), on(0), on(5)]],
      ["EVANS, Brenton", "Master", "", [on(91), on(-3), ""]],
      ["SAMPLE, Sam", "Deckhand", "", ["Y", "OPEN", ""]],
      ["Number Required", "", "", [on(1), "", ""]],
    ],
  };
  const people = [{ name: "SITTIYOS, Kachin", aliases: ["bILLY"] }, { name: "EVANS, Brenton" }, { name: "SAMPLE, Sam" }];

  is(REMINDER_DEFAULTS, { on: false, days: RED_DAYS, weekday: 1, hour: 7 }, "the reminders ship off: 90 days (the red band), Monday, 07:00");
  is(reminderSetting({}), REMINDER_DEFAULTS, "a document with no setting reads the defaults");
  is(reminderSetting({ on: "yes", days: 400 }).on, false, "only a real true switches them on");

  const items = expiringWithin(quals, people, 90, today, VESSEL.noExpiryCodes, rules);
  is(items.map((i) => [i.person, i.code, i.daysLeft]),
    [["EVANS, Brenton", "QL-17", -3], ["SITTIYOS, Kachin", "QL-17", 0], ["SITTIYOS, Kachin", "QL-01", 90]],
    "0 and 90 days on the list, 91 off, expired on; VS-04, Y, OPEN and blanks never; the requirement row is nobody");
  is(byPerson(items).map((g) => g.person), ["EVANS, Brenton", "SITTIYOS, Kachin"], "one list per person, by name");

  const users = [
    { email: "kachin@example.com", name: "Kachin Sittiyos", role: "crew", disabled: 0 },
    { email: "sam@example.com", name: "Sam Sample", role: "crew", disabled: 0 },
    { email: "brenton@example.com", name: "Brenton Evans", role: "crew", disabled: 1 },
    { email: "boss@example.com", name: "Matthew Jones", role: "management", disabled: 0 },
    { email: "help@example.com", name: "IT Help", role: "it", disabled: 0 },
  ];
  const sent = recipientsFor(users, people, items, rules);
  is(sent.own.map((o) => [o.user.email, o.person, o.items.length]), [["kachin@example.com", "SITTIYOS, Kachin", 2]],
    "\"Kachin Sittiyos\" is sent the row \"SITTIYOS, Kachin\"; Sam has nothing due; Brenton is disabled");
  is(sent.summary.map((u) => u.email), ["boss@example.com", "help@example.com"], "management and IT get the summary");

  // Another man's row the register only loosely takes for Brenton (the
  // initial dropped, one word, a word more) stays out of Brenton's email
  // and in the summary.
  const brentonOnly = [{ name: "EVANS, Brenton" }];
  const brenton = [{ email: "brenton@example.com", name: "Brenton Evans", role: "crew", disabled: 0 },
    { email: "boss@example.com", name: "Matthew Jones", role: "management", disabled: 0 }];
  for (const other of ["EVANS, R.", "EVANS", "EVANS, Brenton James"]) {
    const q = { cols: [["QL-01", "Master"], ["QL-17", "AMSA Medical"]],
      rows: [["EVANS, Brenton", "Master", "", ["", on(14)]], [other, "Cook", "", [on(3), ""]]] };
    const its = expiringWithin(q, brentonOnly, 90, today, VESSEL.noExpiryCodes, rules);
    const out = recipientsFor(brenton, brentonOnly, its, rules);
    is(out.own.map((o) => [o.user.email, o.items.map((i) => i.code)]), [["brenton@example.com", ["QL-17"]]],
      JSON.stringify(other) + "'s item is not sent to Brenton");
    is(summaryText(VESSEL, byPerson(its), today, 90).text.includes("QL-01"), true, JSON.stringify(other) + "'s item is in the summary");
  }
  const oneItem = expiringWithin({ cols: [["QL-17", "AMSA Medical"]], rows: [["EVANS, Brenton", "Master", "", [on(14)]]] },
    brentonOnly, 90, today, VESSEL.noExpiryCodes, rules);
  is(recipientsFor([{ email: "james@example.com", name: "Brenton James Evans", role: "crew", disabled: 0 }], brentonOnly, oneItem, rules).own, [],
    "the grant 'Brenton James Evans' is not EVANS, Brenton");

  const monday7 = { day: "2026-09-28", hour: 7, weekday: 1 };
  is(reminderDue(null, monday7, 1, 7), true, "due at 07:10 Monday");
  is(reminderDue(null, { ...monday7, hour: 6 }, 1, 7), false, "not at 06:10");
  is(reminderDue(null, { day: "2026-09-29", hour: 7, weekday: 2 }, 1, 7), false, "not on Tuesday");
  is(reminderDue({ day: "2026-09-28" }, monday7, 1, 7), false, "not twice on one Monday");
  is(reminderDue({ day: "2026-09-28" }, { day: "2026-10-01", hour: 7, weekday: 4 }, 4, 7), false,
    "sent Monday, then set to Thursday: nothing that Thursday");
  is(reminderOwed({ day: "2026-09-21" }, { day: "2026-09-29", hour: 0, weekday: 2 }, 1, 23), "2026-09-28",
    "Monday's one tick missed: Tuesday sends Monday's");
  is(reminderOwed(null, { day: "2026-09-29", hour: 9, weekday: 2 }, 1, 7), null, "switched on the day after: nothing until Monday");

  is(reminderItemLine(items[0]), "QL-17 AMSA Medical — expired 3 days ago (25 Sep 2026)", "an expired line");
  is(reminderItemLine(items[2]), "QL-01 Master — expires 27 Dec 2026 (90 days)", "an expiring line");
  is(reminderText(VESSEL, "SITTIYOS, Kachin", byPerson(items)[1].items, today, 90).subject,
    "Your certificates expiring within 90 days - " + VESSEL.name + " " + VESSEL.nameAccent, "the crew member's subject");
  is(summaryText(VESSEL, byPerson(items), today, 90).text.split("\n").slice(-2), ["https://" + VESSEL.domain, ""],
    "the summary ends on the portal's address");
}

/* ---- offline, every reminder control on Access Grants is held down under
        the badge's line; online, none is ---- */
{
  /* The page compiled again with a React that builds the elements instead
     of dropping them, and a portal that is offline or not. The switch is
     drawn and every component in it opened up, so each button and box is
     seen as the browser would get it: held down by itself or by the
     fieldset round it, with its own title or the nearest one above it. */
  const drawn = (portal) => {
    const el = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
    const R = { ...ReactStub, createElement: el, useContext: () => portal, useEffect: () => {} };
    const page = fn(
      R, { createRoot: () => ({ render: () => {} }) }, {}, windowStub, documentStub,
      windowStub.navigator, windowStub.location, sessionStub, sessionStub, () => {}, async () => ({ ok: false }),
      () => 0, () => 0, () => {}, () => {}, () => 0, () => {}, () => false,
      function N() {}, function I() {}, function A() {}, class { observe() {} }, function F() {},
      function X() {}, { now: () => 0 }, {}, {},
    );
    const open = (n) => {
      if (!n || typeof n !== "object") return n;
      if (typeof n.type === "function") return open(n.type({ ...n.props, children: n.children.length <= 1 ? n.children[0] : n.children }));
      return { ...n, children: n.children.map(open) };
    };
    const controls = [];
    const walk = (n, held, title) => {
      if (!n || typeof n !== "object") return;
      const heldHere = held || (n.type === "fieldset" && !!n.props.disabled);
      const titleHere = n.props.title !== undefined ? n.props.title : title;
      if (n.type === "button" || n.type === "input") controls.push({ held: heldHere || !!n.props.disabled, title: titleHere });
      n.children.forEach((c) => walk(c, heldHere, titleHere));
    };
    walk(open(el(page.ReminderSwitch, null)), false, undefined);
    return controls;
  };
  const setting = { on: true, days: 90, weekday: 1, hour: 7 };
  const STAMP = "2026-09-25T01:00:00.000Z";
  const offline = drawn({ reminders: setting, setReminders: () => {}, offlineAt: STAMP });
  is(offline.length, 11, "the reminder row has On, Off, the seven weekdays and the two boxes");
  is(offline.filter((c) => !c.held).length, 0, "offline, every one of them is held down");
  is([...new Set(offline.map((c) => c.title))], [lib.offlineLine(STAMP)], "…under the badge's line");
  const online = drawn({ reminders: setting, setReminders: () => {}, offlineAt: null });
  is(online.length, 11, "online, the same eleven");
  is(online.filter((c) => c.held).length, 0, "…and none is held down");
  is(online.filter((c) => c.title !== undefined).length, 0, "…nor carries the offline line");
}

/* ---- the SharePoint page's reminder line: red for a send that failed or
        went unanswered, and saying which ---- */
{
  const { reminderLineFor } = lib;
  const on = { on: true };
  const week = { at: "2026-09-28T00:00:00.000Z", own: 2, summary: 1, failed: [], unanswered: [] };
  is(reminderLineFor({ on: false }, week), { bad: false, text: "Reminders are off" }, "off says so, not red");
  is(reminderLineFor(on, null), null, "on, and never sent: no line");
  is(reminderLineFor(on, week).bad, false, "every send answered: not red");
  const silent = reminderLineFor(on, { ...week, unanswered: ["a@b"] });
  is(silent.bad, true, "a send the service never answered is red");
  is(silent.text.includes("no answer for: a@b") && !silent.text.includes("failed"), true, "…named as unanswered, not as failed");
  const failedSend = reminderLineFor(on, { ...week, failed: ["c@d"] });
  is([failedSend.bad, failedSend.text.includes("failed: c@d")], [true, true], "a failed send is red and named");
}

/* ---- a man's MSIC number and date of birth, off his own certificates ---- */
{
  /* The page's own copy of the rules (spliced in at @shared), and the
     module the worker imports, answer the same. */
  const shared = await import(pathToFileURL(join(ROOT, "source", "shared", "particulars.js")).href);
  const { particularsFor, fillParticulars, mergeParticulars, msicCodeIn, VESSEL, crewRegister } = lib;
  const people = [
    { id: "p1", name: "EVANS, Brenton", aliases: ["bRENTON"] },
    { id: "p2", name: "SITTIYOS, Kachin", aliases: ["bILLY"] },
    { id: "p3", name: "SAMPLE, Sam", aliases: [] },
  ];
  const register = crewRegister(people);
  const today = "2026-09-25";
  const rows = [
    { person: "bRENTON", code: "VS-01", key: "m1", filedOn: "2024-01-01" },
    { person: "EVANS, Brenton", code: "VS-01", key: "m2", filedOn: "2026-01-01" },
    { person: "EVANS, Brenton", code: "QL-01", key: "q1" },
    { person: "EVANS, Brenton", code: "VS-01", key: "w1", filedOn: "2026-06-01" },
    { person: "bILLY", code: "QL-01", key: "k1" },
    { person: "SITTIYOS, Kachin", code: "QL-17", key: "k2" },
    { person: "SAMPLE, Sam", code: "QL-12", key: "s1" },
    { person: "SAMPLE, Sam", code: "QL-17", key: "s2" },
    { person: "SAMPLE, Sam", code: "QL-01", key: "s3" },
  ];
  const readings = {
    m1: { readable: true, qualCode: "VS-01", holderName: "Brenton Evans", documentNumber: "msic 0001", expiresOn: "2027-01-01", holderBirthDate: "1980-03-10" },
    m2: { readable: true, qualCode: "VS-01", holderName: "brenton EVANS", documentNumber: " msic  0002 ", expiresOn: "2030-01-01", holderBirthDate: "1980-03-10" },
    q1: { readable: true, holderName: "Evans Brenton", holderBirthDate: "1980-10-03" },
    w1: { readable: true, qualCode: "VS-01", holderName: "Kachin Sittiyos", documentNumber: "WRONG", expiresOn: "2035-01-01", holderBirthDate: "1970-01-01" },
    k1: { readable: true, holderName: "Kachin Sittiyos", holderBirthDate: "1975-05-05" },
    k2: { readable: true, holderName: "SITTIYOS Kachin", holderBirthDate: "1976-06-06" },
    s1: { readable: true, holderName: "Sam Sample", holderBirthDate: "2030-01-01" },
    s2: { readable: true, holderName: "Sam Sample", holderBirthDate: "2021-06-01" },
    s3: { readable: true, holderName: "Sam Sample", holderBirthDate: "1906-01-01" },
  };
  const of = (name, code = "VS-01") => particularsFor(name, rows, readings, register, today, code);
  is(msicCodeIn(VESSEL.qualColumns), "VS-01", "the MSIC column is found by its title on the vessel file");
  is(of("EVANS, Brenton"), { msic: "MSIC 0002", dob: "1980-03-10" },
    "Evans: the card that runs out last, tidied; the date two of three give; nothing from the card in Kachin's name");
  is(shared.particularsFor("EVANS, Brenton", rows, readings, names.crewRegister(people), today, "VS-01"), of("EVANS, Brenton"),
    "the worker's module answers the same");
  is(of("brenton evans"), of("EVANS, Brenton"), "another order or case is the same man through the register");
  is(of("SITTIYOS, Kachin"), { msic: null, dob: null }, "Kachin: two dates once each is no answer");
  is(of("SAMPLE, Sam"), { msic: null, dob: null }, "a future date, a five-year-old and a 120-year-old say nothing");
  // Each impossible date as Sam's only say: no tie to hide behind, so only
  // the age check can refuse it.
  const samOnly = (date) => particularsFor("SAMPLE, Sam", [{ person: "SAMPLE, Sam", code: "QL-12", key: "x" }],
    { x: { readable: true, holderName: "Sam Sample", holderBirthDate: date } }, register, today, "VS-01").dob;
  is(samOnly("1985-01-01"), "1985-01-01", "a real date on its own is his - so a null below is the date refused");
  is([samOnly("2030-01-01"), samOnly("2021-06-01"), samOnly("1906-01-01"), samOnly("1985-02-30")], [null, null, null, null],
    "a future date, a five-year-old, a 120-year-old and a day that does not exist each say nothing, even alone");
  const three = [{ person: "SAMPLE, Sam", code: "QL-12", key: "y1" }, { person: "SAMPLE, Sam", code: "QL-17", key: "y2" }, { person: "SAMPLE, Sam", code: "QL-01", key: "y3" }];
  is(particularsFor("SAMPLE, Sam", three, { y1: { readable: true, holderName: "Sam Sample", holderBirthDate: "2030-01-01" },
    y2: { readable: true, holderName: "Sam Sample", holderBirthDate: "2030-01-01" }, y3: { readable: true, holderName: "Sam Sample", holderBirthDate: "1985-01-01" } },
  register, today, "VS-01").dob, "1985-01-01", "two future dates do not outvote the one real date");
  is(particularsFor("EVANS, Brenton", rows, { ...readings, m1: { ...readings.m1, holderName: null }, m2: { ...readings.m2, holderName: null }, q1: { ...readings.q1, holderName: "" } },
    register, today, "VS-01"), { msic: null, dob: null }, "a certificate naming nobody gives nothing, whoever's folder it is in");
  const letter = { readable: true, holderName: "Brenton Evans", qualCode: null, certificateTitle: "AusCheck MSIC application approved", documentNumber: "REF 7777" };
  is(particularsFor("EVANS, Brenton", [{ person: "EVANS, Brenton", code: "VS-01", key: "l" }], { l: letter }, register, today, "VS-01").msic, null,
    "a letter filed in the MSIC column does not give its reference as his card number");
  is(lib.isMsicCard({ certificateTitle: "Maritime Security Identification Card" }, "VS-01"), true, "the card known by its title");
  is(lib.ticketCodesIn(VESSEL.qualColumns).includes("QL-17") && !lib.ticketCodesIn(VESSEL.qualColumns).includes("VS-01"), true, "the tickets are the Qualification group");
  const alike = { expiresOn: "2030-01-01", issuedOn: "2026-01-01" };
  is(lib.newestCard([{ row: { key: "old" }, reading: alike, at: 1 }, { row: { key: "new" }, reading: alike, at: 0 }]).row.key, "new",
    "alike in every date: the upload first in the listing, the newest");
  is(lib.newestCard([{ row: { key: "old" }, reading: { expiresOn: "2024-01-01", issuedOn: "2020-01-01" }, at: 1 },
    { row: { key: "renewed" }, reading: { issuedOn: "2024-01-01" }, at: 0 }]).row.key, "renewed", "a renewal whose expiry went unread still beats the old card");
  is(of("EVANS, Brenton", msicCodeIn([["QL-01", "Master", "Qualification"]])).msic, null, "no MSIC column, no number");

  const F = { p1: { msic: "MSIC 0002", dob: "1980-03-10" } };
  const filled = fillParticulars([{ id: "p1" }], F, {});
  is([filled.changed, filled.people, filled.fromCert], [true, [{ id: "p1", msic: "MSIC 0002", dob: "1980-03-10" }], F], "empty boxes filled, and remembered");
  is(fillParticulars(filled.people, F, filled.fromCert).changed, false, "the same again changes nothing");
  const typed = fillParticulars([{ id: "p1", msic: "TYPED 9" }], F, { p1: { msic: "MSIC 0001" } });
  is([typed.people[0].msic, typed.fromCert.p1.msic], ["TYPED 9", "MSIC 0001"], "a typed number is left as typed, the record kept");
  const renewed = fillParticulars([{ id: "p1", msic: "MSIC 0001" }], F, { p1: { msic: "MSIC 0001" } });
  is(renewed.people[0].msic, "MSIC 0002", "a renewed card's number replaces the old card's");
  is(renewed.fromCert.p1.was, { msic: ["MSIC 0001"] }, "and the old card's is remembered as the certificates'");
  is(lib.openToCertificates({ id: "p1", msic: "MSIC 0001" }, "msic", renewed.fromCert), true,
    "laid back into the box by a tab from before the fill, the old number is still the certificates' - not typed");
  is(fillParticulars([{ id: "p1", msic: "MSIC 0001" }], F, renewed.fromCert).people[0].msic, "MSIC 0002", "so the new card's goes back in");
  is(lib.openToCertificates({ id: "p1", msic: "TYPED 9" }, "msic", renewed.fromCert), false, "anything else is typed");
  const same = fillParticulars([{ id: "p1", msic: "msic 0002" }], F, {});
  is([same.people[0].msic, same.fromCert.p1.msic], ["msic 0002", "MSIC 0002"], "typed as the certificate says: kept as typed, not marked typed");
  is(fillParticulars([{ id: "p1", msic: "MSIC 0001" }], null, { p1: { msic: "MSIC 0001" } }).changed, false, "nothing found clears nothing");
  is(mergeParticulars([{ id: "p1", msic: "", rank: "Mate" }], [{ id: "p1", msic: "", rank: "Master" }], [{ id: "p1", msic: "MSIC 0002", rank: "Mate" }]),
    [{ id: "p1", msic: "MSIC 0002", rank: "Master" }], "a tab's save keeps the round's fill in a box the tab did not touch");
}

/* ---- a person's Needs attention heading says the days it lists by ---- */
{
  /* MatrixPerson drawn for a man holding one item RED_DAYS + 30 days out -
     past red, inside amber - and its PDF built: the heading's count is the
     number of lines under it, and its days are the amber band's, which is
     what the list is filtered by. */
  const { RED_DAYS, AMBER_DAYS, TODAY, VESSEL } = lib;
  const on = (n) => new Date(new Date(TODAY).getTime() + n * 86400000).toISOString().slice(0, 10);
  const cols = VESSEL.qualColumns;
  const row = ["EVANS, Brenton", "Master", "Master", cols.map((c, i) => (i === 0 ? on(RED_DAYS + 30) : ""))];
  const portal = { certificates: [], quals: { cols, rows: [row] }, certDates: {}, validityPeriods: null };
  const el = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  const R = { ...ReactStub, createElement: el, useContext: () => portal, useEffect: () => {} };
  const page = fn(
    R, { createRoot: () => ({ render: () => {} }) }, {}, windowStub, documentStub,
    windowStub.navigator, windowStub.location, sessionStub, sessionStub, () => {}, async () => ({ ok: false }),
    () => 0, () => 0, () => {}, () => {}, () => 0, () => {}, () => false,
    function N() {}, function I() {}, function A() {}, class { observe() {} }, function F() {},
    function X() {}, { now: () => 0 }, {}, {},
  );
  let build = null;
  const find = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === page.DownloadPDF) build = n.props.build;
    (n.children || []).forEach(find);
  };
  find(page.MatrixPerson({ row, onClose: () => {} }));
  const group = build && build().groups.find((g) => g.heading === "Needs attention");
  is(group && group.items.length, 1, "the item 120 days out is listed under Needs attention");
  is(group && Number(group.meta.split(" ")[0]), group && group.items.length, "…and the heading counts what is listed");
  is(group && group.meta.includes("within " + AMBER_DAYS + " days"), true, "…by the days it was listed by");
}

/* ---- one certificate fills every column it covers ---- */
{
  /* The page's own copy of the rule (spliced in at @shared) and the module
     the worker imports answer the same, off the same table in the vessel
     file. The clauses are in source/shared/covers.js. */
  const shared = await import(pathToFileURL(join(ROOT, "source", "shared", "covers.js")).href);
  const { coveredCells, coveredCodes, unitCodesIn, unitColumnsIn, VESSEL } = lib;
  const table = VESSEL.covers;
  const cols = VESSEL.qualColumns;
  // Brenton Evans's new-style Master certificate of competency, as the
  // reading lists what is printed on it.
  const coc = ["II/2 (incl. generic ECDIS)", "II/5", "VI/1 s. A-VI/1 (2)", "VI/2 (1) s. A-VI/2 (1-4)",
    "VI/3 s. A-VI/3 (1-4)", "VI/4 (1) s. A-VI/4 (1-3)", "VI/4 (2) s. A-VI/4 (4-6)", "VI/6 (1) s. A-VI/6 (4)"]
    .map((text) => ({ text, until: null }));
  const read = (over) => ({ readable: true, expiresOn: "2031-05-26", endorsements: [], units: [], ...over });
  const codes = (over, own) => coveredCodes(read(over), table, cols, own);

  is(coveredCells(read({ endorsements: coc }), table, cols, "QL-01"), [{ code: "QL-13", until: "2031-05-26" }],
    "his ticket covers the ECDIS column, dated as the ticket is dated");
  is(shared.coveredCells(read({ endorsements: coc }), table, cols, "QL-01"), coveredCells(read({ endorsements: coc }), table, cols, "QL-01"),
    "the worker's module answers the same");
  is(codes({ endorsements: coc }, "QL-01").includes("QL-12"), false, "a VI/1 line never fills the certificate of safety training");
  is(codes({ endorsements: [{ text: "II/2", until: null }] }, "QL-01"), [], "II/2 alone is not ECDIS");
  is(codes({ endorsements: [{ text: "Furuno FMD-3200 Type Specific ECDIS Training", until: null }] }, "QL-01"), [],
    "a type-specific Furuno course is not the STCW ECDIS endorsement (the row's unless)");
  is(codes({ endorsements: [{ text: "II/2 - Limitation: not valid for service on ships fitted with ECDIS", until: null }] }, "QL-01"), [],
    "a limitation saying he is not ECDIS trained fills nothing, though the line carries II/2 and ECDIS");
  is(codes({ endorsements: [{ text: "VI/2 (1) s. A-VI/2 (1-4)", until: null }] }, "QL-01"), [], "survival craft is not fast rescue craft");
  is(codes({ endorsements: [{ text: "VI/2 (2) s. A-VI/2 (5-8)", until: null }] }, "QL-01"), ["QL-16"], "VI/2 (2) is fast rescue craft");
  is(coveredCells(read({ endorsements: [{ text: "VI/2 (2)", until: "2029-06-18" }] }), table, cols, "QL-01"), [{ code: "QL-16", until: "2029-06-18" }],
    "and takes the date AMSA printed against the endorsement");
  is(coveredCells(read({ expiresOn: "2028-01-01", endorsements: [{ text: "VI/2 (2)", until: "2031-09-09" }] }), table, cols, "QL-01"),
    [{ code: "QL-16", until: "2028-01-01" }],
    "an endorsement printed to outlive the certificate carrying it takes the certificate's date");
  is(codes({ endorsements: [{ text: "Proficiency in survival craft and rescue boats other than fast rescue boats", until: null }] }, "QL-01"), [],
    "the survival craft endorsement names fast rescue boats to exclude them, and fills nothing (the row's unless)");
  is(codes({ endorsements: [{ text: "Proficiency in fast rescue boats", until: null }] }, "QL-01"), ["QL-16"], "the fast rescue boat endorsement still fills QL-16");
  is(codes({ endorsements: [{ text: "IV/2", until: null }] }, "QL-01"), [], "GMDSS is never read off a certificate of competency");
  is(codes({ capacities: ["Master", "GMDSS Radio Operator"] }, "QL-01"), ["QL-14"],
    "unless the certificate itself certifies the GMDSS radio operator capacity: then it is that certificate");
  is(shared.coveredCodes(read({ capacities: ["Master", "GMDSS Radio Operator"] }), table, cols, "QL-01"), ["QL-14"], "the worker's module reads the capacity the same");
  is(codes({ units: ["HLTAID011", "HLTAID015"] }, "QL-18"), ["QL-19"], "a unit code printed on a statement fills the column whose title carries it");
  is(codes({ units: ["HLTAID01"] }, null), [], "HLTAID01 is not HLTAID011");
  is(codes({ expiresOn: "2030-04-01", units: ["C6", "DG", "LF", "RB", "WP"] }, null), ["HR-01"],
    "a high risk work licence's DG class fills the dogging column and nothing else");
  is(codes({ expiresOn: "2030-04-01", units: ["DG", "LF", "RI", "CV"] }, null), ["HR-01", "HR-02"], "DG and CV fill both");
  is(shared.coveredCodes(read({ units: ["DG", "LF", "RI", "CV"] }), table, cols, null), ["HR-01", "HR-02"], "the worker's module reads the classes the same");
  // A class is an entry that IS the code, alone: a prose entry carrying the
  // letters is not a licence class and fills nothing.
  is(codes({ expiresOn: "2030-04-01", units: ["Class DG"] }, null), [], "'Class DG' is a phrase, not the class");
  is(codes({ expiresOn: "2030-04-01", units: ["Dangerous Goods (DG) awareness"] }, null), [], "a course title bracketing the code is not the class");
  is(codes({ expiresOn: "2030-04-01", units: ["C6, DG, LF, RB, WP"] }, null), ["HR-01"], "five classes on one line, as the older readings list them, are five classes");
  is(codes({ expiresOn: "2030-04-01", units: ["C6, DG, and forklift"] }, null), [], "one word of prose makes the whole line a phrase");
  is(codes({ readable: false, endorsements: coc }, "QL-01"), [], "an unreadable certificate covers nothing");
  is(coveredCodes({ readable: true, expiresOn: "2031-05-26" }, table, cols, "QL-01"), [], "nor does a reading made before the question was asked");
  is(unitColumnsIn(cols), ["QL-18", "QL-19", "QL-20", "PT-02", "PT-03"], "the training columns are read off the column titles");
  is(unitCodesIn(["HLTAID011", " hltaid011 "]), ["HLTAID011"], "the same unit code twice is one code");
}

/* ---- the medical: which one governs, and an expiry longer than the law
        allows for the holder's age (MO76 s 16(3), s 16(1)) ---- */
{
  /* The page's own copy of the rules (spliced in at @shared), and the
     module the worker imports, answer the same. */
  const shared = await import(pathToFileURL(join(ROOT, "source", "shared", "medical.js")).href);
  const { medicalCodesIn, medicalOnFile, medicalTooLong, medicalNote, VESSEL, crewRegister } = lib;
  const people = [{ id: "p1", name: "EVANS, Brenton", aliases: ["bRENTON"] }, { id: "p2", name: "SITTIYOS, Kachin", aliases: [] }];
  const register = crewRegister(people);
  const codes = medicalCodesIn(VESSEL.certStated);
  is(codes, ["QL-17"], "the medical's column is the vessel file's certStated");
  const rows = [
    { id: "f2", key: "new", person: "bRENTON", code: "QL-17", filedOn: "2026-06-02" },
    { id: "f1", key: "old", person: "EVANS, Brenton", code: "QL-17", filedOn: "2025-01-02" },
    { id: "f4", key: "hers", person: "EVANS, Brenton", code: "QL-17", filedOn: "2026-07-01" },
  ];
  const readings = {
    new: { readable: true, holderName: "Brenton Evans", issuedOn: "2026-06-01", assessedOn: "2026-05-28", expiresOn: "2027-06-01", conditions: " Daylight only " },
    old: { readable: true, holderName: "brenton EVANS", issuedOn: "2025-01-01", assessedOn: "2025-01-01", expiresOn: "2029-01-01", conditions: null },
    hers: { readable: true, holderName: "Kachin Sittiyos", issuedOn: "2026-06-30", expiresOn: "2028-06-30" },
  };
  const mine = medicalOnFile("EVANS, Brenton", rows, readings, register, codes);
  is(mine.map((m) => m.rowId), ["f2", "f1"], "the medical issued last governs, though the older one prints 2029");
  is(medicalNote(mine[0]), "Daylight only", "the condition as printed, tidied of its spaces");
  is(shared.medicalOnFile("EVANS, Brenton", rows, readings, register, codes), mine, "the worker's module answers the same");
  is(medicalTooLong(mine[0], "1990-04-01", "2026-09-25"), null, "a year out from a 36-year-old's assessment is well inside two years");
  const twoAndADay = { ...mine[0], expiresOn: "2028-05-29" };
  is(medicalTooLong(twoAndADay, "1990-04-01", "2026-09-25"), "the expiry is more than two years after the assessment", "two years and a day is flagged");
  is(medicalTooLong(twoAndADay, null, "2026-09-25"), null, "with no date of birth on Crew Details, nothing is flagged");
  is(shared.medicalTooLong(twoAndADay, "1971-05-28", "2026-09-25"),
    "the expiry is more than a year after the assessment, and the holder was 55 or older that day", "55 on the assessment day: one year, module and page alike");
  is(medicalTooLong(twoAndADay, "1971-05-28", "2026-09-25"), shared.medicalTooLong(twoAndADay, "1971-05-28", "2026-09-25"), "the page says it too");
}

/* ---- renewal blockers: a red ticket that cannot be renewed until
        something else is put right (MO70 s 25, MO71 Sch 4 4.2) ---- */
{
  const shared = await import(pathToFileURL(join(ROOT, "source", "shared", "renewals.js")).href);
  const { renewalBlockers, renewalNeedsProblem, daysUntil, RED_DAYS, VESSEL } = lib;
  const codes = VESSEL.qualColumns.map((c) => c[0]);
  // A table the page never got would pass the check below by being absent,
  // so it is counted first.
  is(Object.keys(VESSEL.renewalNeeds || {}).sort(), ["QL-01", "QL-02", "QL-03", "QL-04", "QL-05", "QL-06", "QL-07", "QL-10", "QL-11"],
    "the page carries the vessel file's pairs, and not the two the law renews on a declaration (QL-08, QL-09)");
  is(renewalNeedsProblem(VESSEL.renewalNeeds, codes), null, "the vessel file's pairs all name its own columns");
  is(renewalNeedsProblem(VESSEL.renewalNeeds, codes), shared.renewalNeedsProblem(VESSEL.renewalNeeds, codes), "page and module agree");
  const today = "2026-09-25";
  const on = (n) => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
  const rules = { needs: VESSEL.renewalNeeds, daysUntil, redDays: RED_DAYS };
  const cook = { "QL-11": on(40), "QL-12": on(-30), "QL-17": on(300) };
  const blocked = renewalBlockers("SITTIYOS, Kachin", cook, today, rules);
  is(blocked.map((b) => [b.person, b.code, b.needs]), [["SITTIYOS, Kachin", "QL-11", ["QL-12"]]],
    "his cook certificate cannot be renewed until the certificate of safety training is");
  is(blocked[0].why.includes("MO70 s 25"), true, "and the clause travels with it");
  is(shared.renewalBlockers("SITTIYOS, Kachin", cook, today, rules), blocked, "the worker's module answers the same");
  is(renewalBlockers("SITTIYOS, Kachin", { ...cook, "QL-12": on(300) }, today, rules), [], "a current COST: nothing in the way");
  is(renewalBlockers("EVANS, Brenton", { "QL-01": on(-10), "QL-17": on(300), "QL-14": "" }, today, rules)[0].missing, ["QL-14"],
    "an expired deck certificate with no GMDSS on file");
  is(renewalBlockers("EVANS, Brenton", { "QL-01": on(RED_DAYS + 1), "QL-14": "" }, today, rules), [],
    "a certificate past the red band is not being renewed yet");
}

/* ---- alternative evidence: the papers that lawfully carry a man while a
        certificate is out (MO70 s 15(3), MO505 s 7(3), ss 22-24, s 12(2)) ---- */
{
  const shared = await import(pathToFileURL(join(ROOT, "source", "shared", "evidence.js")).href);
  const { coveredBy, evidenceKindsProblem, EVIDENCE_KINDS, VESSEL, crewRegister } = lib;
  const codes = VESSEL.qualColumns.map((c) => c[0]);
  is(EVIDENCE_KINDS, ["extension", "lodged-renewal", "crewing-permit", "assessor-declaration", "issue-letter"], "the five kinds");
  // Absent, the table would pass the check below by having nothing in it.
  is(Object.keys(VESSEL.evidenceKinds || {}), EVIDENCE_KINDS, "the page carries all five of the vessel file's kinds");
  is(evidenceKindsProblem(VESSEL.evidenceKinds, codes), null, "the vessel file's kinds all name its own columns");
  is(shared.evidenceKindsProblem(VESSEL.evidenceKinds, codes), null, "the module says so too");
  const today = "2026-09-25";
  const rules = { kinds: VESSEL.evidenceKinds, nameIsSomebodyElse: names.nameIsSomebodyElse,
    register: crewRegister([{ name: "EVANS, Brenton", aliases: [] }, { name: "SITTIYOS, Kachin", aliases: [] }]) };
  const rows = [
    { id: "ext", key: "ext", person: "EVANS, Brenton", code: null, filedOn: "2026-08-02" },
    { id: "coc", key: "coc", person: "EVANS, Brenton", code: "QL-01", filedOn: "2021-02-01" },
  ];
  const readings = {
    ext: { readable: true, holderName: "Brenton Evans", evidenceKind: "extension", issuedOn: "2026-07-20", expiresOn: "2026-11-25" },
    coc: { readable: true, holderName: "Brenton Evans", evidenceKind: null, isRecognition: false, expiresOn: "2026-08-01" },
  };
  const cover = coveredBy("QL-01", "EVANS, Brenton", rows, readings, today, rules);
  is(cover, { kind: "extension", until: "2026-11-25", rowId: "ext" }, "AMSA's letter carries his expired Master to 25 Nov");
  is(shared.coveredBy("QL-01", "EVANS, Brenton", rows, readings, today, rules), cover, "the worker's module answers the same");
  is(coveredBy("QL-12", "EVANS, Brenton", rows, readings, today, rules), null, "no extension of a certificate of safety training, ever");
  const recognised = { ...readings, coc: { ...readings.coc, isRecognition: true } };
  is(coveredBy("QL-01", "EVANS, Brenton", rows, recognised, today, rules), null, "and none of a certificate of recognition");
  const spent = { ...readings, ext: { ...readings.ext, expiresOn: "2026-09-01" } };
  is(coveredBy("QL-01", "EVANS, Brenton", rows, spent, today, rules), null, "a cover that has run out is no cover");
  // Whose paper it is, asked the way the round asks it (nameIsSomebodyElse).
  const oneWord = { ...readings, ext: { ...readings.ext, holderName: "Brenton" } };
  is(coveredBy("QL-01", "EVANS, Brenton", rows, oneWord, today, rules), cover, "a one-word printed name that is his still covers");
  const hers = { ...readings, ext: { ...readings.ext, holderName: "Kachin" } };
  is(coveredBy("QL-01", "EVANS, Brenton", rows, hers, today, rules), null, "one that is another man's does not");
  /* What paper a document is: the kind the person picked at upload first,
     then a hand tag with no kind (the certificate for that column, whatever
     the model called it), then the model's word. The page and the worker
     answer it the one way. */
  const { paperKind } = lib;
  is(paperKind({ qualCode: "QL-01", evidenceKind: "extension" }, { evidenceKind: null }), "extension", "the person's kind beats the model");
  is(paperKind({ qualCode: "QL-01", evidenceKind: null }, { evidenceKind: "extension" }), "", "a hand tag alone is the certificate");
  is(paperKind({ qualCode: null, evidenceKind: null }, { evidenceKind: "extension" }), "extension", "untagged, the model's word");
  is(shared.paperKind({ qualCode: "QL-01", evidenceKind: "extension" }, { evidenceKind: null }), "extension", "the worker's module answers the same");
  const picked = [{ id: "ext", key: "ext", person: "EVANS, Brenton", code: "QL-01", tagged: true, kind: "extension", filedOn: "2026-08-02" }, rows[1]];
  const misread = { ...readings, ext: { ...readings.ext, evidenceKind: null } };
  is(coveredBy("QL-01", "EVANS, Brenton", picked, misread, today, rules), cover, "a letter tagged as an extension about his Master covers it, though the model read it as a certificate");
  is(coveredBy("QL-01", "EVANS, Brenton", [{ ...picked[0], kind: null }, rows[1]], readings, today, rules), null, "the same tag with no kind is the certificate: no cover");
}

/* ---- the certificate of recognition: never longer than the certificate it
        recognises, and never the safety training or cook column
        (MO70 s 33(2), s 36(3), s 37(4), s 7(2)(b)) ---- */
{
  /* The page draws these cells, so its own copy of the rule (spliced in at
     @shared) must answer what the worker's module answers. */
  const shared = await import(pathToFileURL(join(ROOT, "source", "shared", "recognition.js")).href);
  const { recognisedUntil, recognitionFills, foreignExpiryOn, isRecognitionReading, VESSEL } = lib;
  const rec = { readable: true, isRecognition: true, recognises: { expiresOn: "2029-03-01" } };
  is(recognisedUntil(rec, "2030-06-30", null), { until: "2029-03-01", foreignUnknown: false },
    "the recognition never runs longer than the certificate behind it");
  is(shared.recognisedUntil(rec, "2030-06-30", null), recognisedUntil(rec, "2030-06-30", null),
    "the worker's module answers the same");
  is(recognisedUntil(rec, "2028-01-01", null), { until: "2028-01-01", foreignUnknown: false },
    "and where it is the earlier of the two, its own date governs");
  is(recognisedUntil({ readable: true, isRecognition: true }, "2030-06-30", null),
    { until: "2030-06-30", foreignUnknown: true },
    "nothing known about the foreign certificate: the cell takes what there is, and the office is told");
  is(foreignExpiryOn(rec), "2029-03-01");
  is(isRecognitionReading({ readable: true }), false);
  is(VESSEL.neverRecognised.codes.slice().sort(), ["QL-11", "QL-12"]);
  is(recognitionFills("QL-12", VESSEL.neverRecognised.codes), false, "no recognition ever fills the certificate of safety training");
  is(recognitionFills("QL-14", VESSEL.neverRecognised.codes), true);
}

/* ---- the cell a paper carries: amber, never green, and it says what
        carries it (MO70 s 15(3), MO505 s 7(3), s 12(2), ss 22-24) ---- */
{
  const { certCoverFor, coverLine, bandWithCover, bandFor } = lib;
  const dates = { map: {}, covers: { "EVANS, BRENTON::QL-01": { kind: "extension", until: "2026-11-08", url: "/api/files/x" } } };
  const cover = certCoverFor(dates, "evans, brenton", "ql-01");
  is(!!cover, true, "the cover is found however the name and the code were cased");
  is(certCoverFor(dates, "EVANS, Brenton", "QL-02"), null, "and only for the column the paper covers");
  is(coverLine(cover), "covered by extension until 08 NOV 2026", "the words on the cell are what carries it and until when");
  is(coverLine({ kind: "issue-letter", until: null }), "covered by issue-letter",
    "an issue letter is the one paper the law gives no end, so it says none");
  const red = bandFor("2026-01-01");
  is(red.key, "red", "his ticket has gone");
  const carried = bandWithCover(red, cover);
  is(carried.key, "covered", "a paper carries him, so the cell is not red");
  const amberDay = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
  is(bandFor(amberDay).key, "orange", "120 days out is the amber band");
  is(carried.fg, bandFor(amberDay).fg, "it takes the amber band - never green, because the certificate itself has gone");
  const green = bandFor(new Date(Date.now() + 900 * 86400000).toISOString().slice(0, 10));
  is(green.key, "green");
  is(bandWithCover(green, cover), green, "a certificate still in date is left exactly as it was");
  is(bandWithCover(red, null), red, "and no paper, no change");
  /* A column this position does not have to hold stays hatched whatever is on
     file: a cover on a cell nobody must hold is nothing to put on the grid.
     A required cell with nothing in it - the issue-letter case, MO505 s
     12(2), where the card has not arrived - does take the cover. */
  is(bandWithCover(null, cover, false), null, "not required for this position: left hatched");
  is(bandWithCover(null, cover, true).key, "covered", "required with nothing on file: the paper carries it");
  is(bandWithCover(null, cover, true).date, null, "and with no date to show, the sentence stays on the title");
}

/* ---- the lines the Marine Orders put on Needs attention for one man, and
        when each is worth putting there ---- */
{
  const { marineOrderLines, VESSEL, daysUntil, RED_DAYS } = lib;
  const today = "2026-09-25";
  const on = (n) => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
  const cols = [["QL-02", "Chief Mate", "Qualification"], ["QL-17", "AMSA Medical", "Qualification"]];
  const rules = { renewal: { needs: VESSEL.renewalNeeds, daysUntil, redDays: RED_DAYS }, medicalCodes: ["QL-17"] };
  const recognised = { map: { "EVANS, BRENTON::QL-02": { expires: on(900), issued: on(-200), recognition: true, foreignUnknown: true } } };
  const row = (cell) => ["EVANS, Brenton", "Master", "", [cell, ""]];
  // Only the recognition and cover lines: a red Chief Mate with no medical
  // held is a renewal blocker too, which is right and not what is asked here.
  const lines = (cell, needs, dates = recognised) =>
    marineOrderLines(row(cell), cols, dates, new Set(needs), null, today, rules).map((l) => l.text)
      .filter((t) => /recognition|covered by/.test(t));
  /* The recognition line - "the certificate the recognition is for is not on
     the portal" - is gated as the cover lines are: on the cell's band, or on
     the seat requiring the column. A recognition on a column nobody in this
     seat must hold is nothing to put on the management list. */
  is(lines(on(900), []), [], "a green recognition on a column the seat does not require: no line");
  is(lines(on(900), ["QL-02"]), ["EVANS, Brenton — QL-02: the certificate the recognition is for is not on the portal"],
    "the seat requires it: the line");
  is(lines(on(-10), []), ["EVANS, Brenton — QL-02: the certificate the recognition is for is not on the portal"],
    "the cell is red: the line, required or not");
  is(lines("", []), [], "a blank cell on a column not required: nothing");
  is(lines("", ["QL-02"]), ["EVANS, Brenton — QL-02: the certificate the recognition is for is not on the portal"],
    "a blank cell on a column the seat requires: the line");
  const known = { map: { "EVANS, BRENTON::QL-02": { expires: on(900), recognition: true, foreignUnknown: false } } };
  is(lines(on(900), ["QL-02"], known), [], "the foreign certificate is known: nothing to say");
  // The cover lines were already gated this way, and still are.
  const covered = { map: {}, covers: { "EVANS, BRENTON::QL-02": { kind: "extension", until: on(45) } } };
  is(lines(on(-10), [], covered), ["EVANS, Brenton — QL-02: " + lib.coverLine({ kind: "extension", until: on(45) })],
    "a red cell a paper carries: the cover line");
  is(lines(on(900), [], covered), [], "a green cell with a spent letter on file: nothing");

  /* The filed column against the reading: where the office filed a paper
     under a column and the model read it as something else, Needs attention
     says so in one line - always, whatever the seat needs, because a wrong
     filing is a wrong filing. The list is the server's (certificateStanding),
     keyed under the register's name in capitals as the dates are. Its own
     list, not one of the orders' lines: the Marine Orders count is the
     orders' alone. */
  const filed = { map: {}, filedAs: [
    { person: "EVANS, BRENTON", code: "QL-03", title: "Master <100m NC", readsAs: "Crew Intermediate course", url: null },
    { person: "SITTIYOS, KACHIN", code: "QL-03", title: "Master <100m NC", readsAs: null, url: null },
  ] };
  const filedLines = (cell) => lib.filedAsLines(row(cell), filed).map((l) => l.text);
  is(filedLines(on(900)), ["EVANS, Brenton — QL-03: filed as Master <100m NC, reads as Crew Intermediate course"], "his line, whatever the cell holds");
  is(filedLines(""), ["EVANS, Brenton — QL-03: filed as Master <100m NC, reads as Crew Intermediate course"], "the same line on a blank cell: it is about the filing, not the band");
  is(lib.filedAsLines(row(on(900)), filed)[0].code, "QL-03", "the line carries its column, so it can open the file");
  is(filedLines(on(900)).some((t) => /SITTIYOS/.test(t)), false, "another man's filing is not on his row");
  is(lib.filedAsLines(row(on(900)), { map: {} }), [], "nothing filed, nothing said");
  is(lib.filedAsLines(row(on(900)), null), [], "no dates yet, nothing said");
  is(marineOrderLines(row(on(900)), cols, filed, new Set(), null, today, rules).filter((l) => /filed as/.test(l.text)), [],
    "and the orders' own lines never carry it");
  const shared = await import(pathToFileURL(join(ROOT, "source", "shared", "filed-as.js")).href);
  is(lib.filedAsLine("SITTIYOS, Kachin", "QL-02", "Chief Mate", null), "SITTIYOS, Kachin — QL-02: filed as Chief Mate, reads as nothing on the matrix", "the page's copy of the line");
  is(shared.filedAsLine("SITTIYOS, Kachin", "QL-02", "Chief Mate", null), lib.filedAsLine("SITTIYOS, Kachin", "QL-02", "Chief Mate", null), "the worker's module says it the same");
  // The upload page's warning on a file the reader thinks was put in the wrong column.
  is(lib.tagWarning("QL-06", "Engineer Class 2", "Master <45m NC"), "Filed as QL-06 · Engineer Class 2, but it reads as Master <45m NC - check it.", "the page's warning");
  is(shared.tagWarning("QL-06", "Engineer Class 2", "Master <45m NC"), lib.tagWarning("QL-06", "Engineer Class 2", "Master <45m NC"), "the worker's module says it the same");
  is(lib.tagWarning("QL-06", "", null), "Filed as QL-06, but it reads as nothing on the matrix - check it.", "no title, nothing read: still a sentence");
  // The code in a filename is a filing only as a whole token and only for a live column.
  is(lib.filedCodeIn("SMITH, Alan - VS-04 Helm CONNECT.pdf", [["VS-04", "Helm CONNECT", "Vessel"]]), "VS-04");
  is(lib.filedCodeIn("PI-02 MinRes - Corporate Safety Induction.pdf", [["VS-04", "Helm CONNECT", "Vessel"]]), null, "not a column of the live matrix");
  is(lib.filedCodeIn("ROGERS - QL-04Master.pdf", [["QL-04", "Master <45m NC", "Qualification"]]), null, "not a whole token");
  is(shared.filedCodeIn("SMITH, Alan - VS-04 Helm CONNECT.pdf", [["VS-04", "Helm CONNECT", "Vessel"]]), "VS-04", "the worker's module reads the name the same");

  /* On file, not on the matrix: the documents the server found no column
     for anywhere (certificateStanding's notOnMatrix), one line each,
     "<person> — <title or filename>", sorted by person and then title. */
  const { notOnMatrixLines } = lib;
  const listed = { map: {}, notOnMatrix: [
    { person: "SITTIYOS, Kachin", title: "MHE quiz.pdf", url: "/api/files/q" },
    { person: "EVANS, Brenton", title: "MinRes Psychosocial Hazards", url: "/api/files/p" },
    { person: "EVANS, Brenton", title: "MRN Marine Contractor H&S", url: "/api/files/h" },
  ] };
  is(notOnMatrixLines(listed).map((l) => l.text), [
    "EVANS, Brenton — MinRes Psychosocial Hazards",
    "EVANS, Brenton — MRN Marine Contractor H&S",
    "SITTIYOS, Kachin — MHE quiz.pdf",
  ], "one line per document, by person and then title");
  is(notOnMatrixLines(listed)[0].url, "/api/files/p", "each line opens its file");
  is(notOnMatrixLines({ map: {} }), [], "nothing listed, nothing said");
  is(notOnMatrixLines(null), [], "no dates yet, nothing said");

  /* The reader's own work on Needs attention: a column it filled on a
     "medium", with its reason, and a certificate it placed on a man whose
     names on Crew Details do not carry the printed name - these exact
     sentences, and no others, each on its own man's row. */
  const reader = { map: {},
    placed: [
      { person: "EVANS, BRENTON", code: "VS-04", why: "Crew Intermediate satisfies Crew Basic", url: "/api/files/h" },
      { person: "SITTIYOS, KACHIN", code: "CS-04", why: "listed on the approvals register", url: null },
    ],
    readAs: [
      { person: "EVANS, BRENTON", certificate: "GMDSS", printed: "Bill", line: "add", url: "/api/files/g" },
      { person: "EVANS, BRENTON", certificate: "Provide First Aid", printed: "B. Evens", line: "check", url: null },
    ] };
  is(lib.readingLines(row(on(900)), reader).map((l) => l.text), [
    "EVANS, Brenton — VS-04: placed by the reading (Crew Intermediate satisfies Crew Basic)",
    `GMDSS read as EVANS, Brenton's — add "Bill" to their names on Crew Details`,
    `Provide First Aid read as EVANS, Brenton's — check, and add "B. Evens" to their names on Crew Details`,
  ], "the three sentences, his only");
  is(lib.readingLines(row(on(900)), reader)[0].url, "/api/files/h", "each opens its file");
  is(lib.readingLines(row(on(900)), { map: {} }), [], "nothing placed, nothing said");
  is(lib.readingLines(row(on(900)), null), [], "no dates yet, nothing said");
  is(lib.placedLine("EVANS, Brenton", "VS-04", null), "EVANS, Brenton — VS-04: placed by the reading", "no reason given: no brackets");
  const sharedFiled = await import(pathToFileURL(join(ROOT, "source", "shared", "filed-as.js")).href);
  const sharedNames = await import(pathToFileURL(join(ROOT, "source", "shared", "names.js")).href);
  is(sharedFiled.placedLine("A", "B", "c"), lib.placedLine("A", "B", "c"), "the worker's module says the placed line the same");
  is(sharedNames.readAsLine("A", "B", "c", "check"), lib.readAsLine("A", "B", "c", "check"), "and the read-as line");
  // Management only: the lines live in the gaps list, which the Crew
  // Matrix opens under Needs attention for management and nobody else.
  const area = readFileSync(join(ROOT, "source", "areas", "certification-checker.jsx"), "utf8");
  const matrixPage = readFileSync(join(ROOT, "source", "parts", "crew-matrix.jsx"), "utf8");
  is(/readingLines\(/.test(area) && /id="placed-by-reading"/.test(area), true, "the lines are the gaps list's");
  is(/\{admin && only === "attention" && \(\s*<div[^>]*><CertChecker /.test(matrixPage), true, "and the gaps list is shown to management only");
  is((matrixPage.match(/<CertChecker/g) || []).length, 1, "nowhere else");
}

/* ---- the matrix's column headings stay on screen as the page scrolls ----
   The page scrolls the grid now, not a fixed-height window, so the heading
   row is moved down by hand: nothing while the grid's top is still on
   screen below the line, the distance scrolled past it after, and never
   past the end of the table. */
{
  const { matrixHeadOffset } = lib;
  is(matrixHeadOffset(300, 1500, 60, 0), 0, "the grid's top is still below the line: the headings sit where they are");
  is(matrixHeadOffset(0, 1500, 60, 0), 0, "exactly at the line: nothing to move");
  is(matrixHeadOffset(-200, 1500, 60, 0), 200, "200px scrolled past the top of the screen: moved down 200");
  is(matrixHeadOffset(-120, 1500, 60, 80), 200, "200px above a bar held at the top: moved down 200, under the bar");
  is(matrixHeadOffset(-5000, 1500, 60, 0), 1440, "scrolled past the end: they stop on the last row, frame less headings");
  is(matrixHeadOffset(-1440, 1500, 60, 0), 1440, "the last row exactly");
  is(matrixHeadOffset(), 0, "nothing measured, nothing moved");
  is(matrixHeadOffset(-200, undefined, 60, 0), 0, "no frame height: nothing moved");
  is(matrixHeadOffset(-200, 1500, 60, NaN), 0, "a line that is not a number: nothing moved");
  is(matrixHeadOffset(-200, -1500, 60, 0), 0, "a negative frame height: nothing moved");
  is(matrixHeadOffset(-200, 1500, -60, 0), 0, "a negative heading height: nothing moved");
  is(matrixHeadOffset(-200, 1500, 60, -10), 0, "a negative line: nothing moved");
  is(matrixHeadOffset(-200, 40, 60, 0), 0, "headings taller than the frame: nothing moved");
  // The roster's three date rows (22 + 12 + 12, and the rule under them) move
  // as one block by the same rule.
  is(matrixHeadOffset(-300, 1200, 47, 0), 300, "the roster's date rows: moved down as far as the table has gone");
  is(matrixHeadOffset(-3000, 1200, 47, 0), 1153, "and they stop on its last crew row");

  // Landed on the screen's own pixels: the browser draws a top where it
  // rounds it to, so the headings are drawn exactly on the line. A top on a
  // half pixel is where rounding the move alone put them a pixel low.
  const { headPixels } = lib;
  // Where the headings' top is drawn, in screen pixels from the line, with the
  // browser's tie at a half pixel taken the unlucky way (downwards): 0 is on
  // the line, -1 a pixel above (the rows beneath covered), 1 a pixel below (a
  // hairline of them showing).
  const drawnAt = (top, down, dpr) => {
    const at = (top + down) * dpr;
    return Math.abs(at - Math.round(at)) === 0.5 ? Math.ceil(at) : Math.round(at);
  };
  const safe = (v) => v === 0 || v === -1;
  let low = [];
  [1, 1.25, 1.5, 2, 3].forEach((dpr) => {
    for (let n = 0; n <= 100; n++) {
      const top = -299 - n / 100;
      if (!safe(drawnAt(top, headPixels(-top, dpr), dpr))) low.push(dpr + "x at " + top);
    }
  });
  is(low, [], "at 100%, 125%, 150%, 200% and 300%, wherever the top falls, the headings are drawn on the line or a pixel above");
  is(drawnAt(-299.6000061, headPixels(299.6000061, 1.25), 1.25) <= 0, true,
    "the top the roster measured at 125% (a hair past a half pixel) is not drawn below the line");
  is(drawnAt(-150.25, Math.round(150.25 * 2) / 2, 2), 1, "where rounding the move to the nearest drew a top on a half pixel a pixel low");
  is(headPixels(1153, 2), 1153, "a move of whole pixels is left as it is");
  is(headPixels(0, 2), 0, "no move is no move");
  is(headPixels(200, 0), 0, "no pixel ratio to go on: nothing moved");
}

/* ---- the grid and its floating bar keep in step, however fast a swipe ----
   Played the way the browser plays it: setting a scroller's position moves it
   at once (held to its range, and no event if it did not move), and its scroll
   event comes at the next drawn frame - once, however often it moved in
   between, and after the events already waiting. The old way, a flag held only
   while the one side was being set, is run through the same frames to show
   they catch it: its echo came a frame late and pulled the grid back. */
{
  const { scrollPair } = lib;
  const oldLock = (a, b) => {
    let lock = false;
    return {
      fromA: () => { if (lock) return; lock = true; b.scrollLeft = a.scrollLeft; lock = false; },
      fromB: () => { if (lock) return; lock = true; a.scrollLeft = b.scrollLeft; lock = false; },
    };
  };
  const world = (pairOf, max = 3000) => {
    let due = [];
    const scroller = () => {
      let at = 0;
      const el = { on: null };
      Object.defineProperty(el, "scrollLeft", {
        get: () => at,
        set: (v) => {
          const n = Math.max(0, Math.min(max, v));
          if (n === at) return;
          at = n;
          if (!due.includes(el)) due.push(el);
        },
      });
      return el;
    };
    const grid = scroller(), bar = scroller();
    const pair = pairOf(grid, bar);
    grid.on = pair.fromA;
    bar.on = pair.fromB;
    // One drawn frame: the events waiting are delivered in the order they
    // were raised; any raised while delivering wait for the next frame.
    const frame = () => { const now = due; due = []; now.forEach((el) => el.on()); };
    const settle = () => { for (let n = 0; n < 10; n++) frame(); };
    return { grid, bar, frame, settle };
  };
  // A swipe on the grid itself: so far each frame, then let go.
  const swipe = (pairOf, steps) => {
    const w = world(pairOf);
    steps.forEach((s) => { w.grid.scrollLeft += s; w.frame(); });
    w.settle();
    return [w.grid.scrollLeft, w.bar.scrollLeft];
  };
  const ten = (n) => Array.from({ length: 10 }, () => n);
  is(swipe(scrollPair, ten(50)), [500, 500], "a 500px trackpad swipe moves the grid 500px, and the bar with it");
  is(swipe(scrollPair, ten(120)), [1200, 1200], "a fast shift+wheel of 1200px moves it 1200px");
  is(swipe(scrollPair, [3, 7, 1, 40, 2, 90, 5]), [148, 148], "uneven steps add up exactly");
  is(swipe(scrollPair, ten(400)), [3000, 3000], "a swipe past the end stops at the end, both together");
  is(swipe(oldLock, ten(50))[0] < 500, true, "the old flag, played the same way, loses ground - so these frames would catch it");

  // Dragging the bar's thumb: the grid follows every step, never skipping
  // back, and ends where the thumb is let go.
  const drag = (pairOf) => {
    const w = world(pairOf);
    const seen = [];
    for (let n = 1; n <= 20; n++) { w.bar.scrollLeft = n * 37; w.frame(); seen.push(w.grid.scrollLeft); }
    w.settle();
    return { seen, end: [w.grid.scrollLeft, w.bar.scrollLeft] };
  };
  const dragged = drag(scrollPair);
  is(dragged.end, [740, 740], "dragging the bar to 740 takes the grid to 740");
  is(dragged.seen.every((v, n) => n === 0 || v >= dragged.seen[n - 1]), true, "the grid never jumps back on the way");
  is(dragged.seen.slice(-1)[0], 740, "and is there on the frame the thumb gets there");

  // The two in turn: a swipe on the grid, then the bar dragged back, then
  // the grid again - each hands over cleanly to the other.
  const w = world(scrollPair);
  ten(30).forEach((s) => { w.grid.scrollLeft += s; w.frame(); });
  w.frame();
  [250, 200, 150, 100].forEach((v) => { w.bar.scrollLeft = v; w.frame(); });
  w.frame();
  ten(20).forEach((s) => { w.grid.scrollLeft += s; w.frame(); });
  w.settle();
  is([w.grid.scrollLeft, w.bar.scrollLeft], [300, 300], "grid, then bar, then grid: they end together where the last move left them");
}

/* ---- both grids' stylesheets move their headings the one way ----
   The heading rows are moved down by --mx-head on the crew matrix and the
   roster alike, print puts them back where they belong, and the floating bar
   is lifted clear of the test preview's ribbon by a variable only the preview
   sets. */
{
  const page = readFileSync(join(ROOT, "source", "index.html"), "utf8");
  const shim = readFileSync(join(ROOT, "tools", "preview", "shim.js"), "utf8");
  // The rule's whole block, to the brace that closes it on a line of its own
  // (a colour written in as ${T.panel} carries a brace of its own).
  const rule = (selector) => {
    const at = page.indexOf(selector + " {");
    return at < 0 ? "" : page.slice(at, page.indexOf("\n}", at));
  };
  is(/translateY\(var\(--mx-head/.test(rule(".um-matrix thead th")), true, "the crew matrix's headings move by --mx-head");
  is(/translateY\(var\(--mx-head/.test(rule(".um-timeline thead th")), true, "the roster's headings move by --mx-head");
  const print = page.slice(page.indexOf("@media print {"), page.indexOf("@media print {") + 600);
  is(/\.um-matrix thead th, \.um-timeline thead th \{ transform: none !important; \}/.test(print), true,
    "print puts both grids' headings back at the top of their tables");
  is(/\.um-floatbar[^{]*\{[^}]*var\(--um-floatbar-lift, 0px\)/.test(page), true, "the bar's lift is 0 unless something sets it");
  is(shim.includes("--um-floatbar-lift"), true, "the test preview sets the lift to clear its ribbon");
}

if (failed) {
  console.error(failed + " rule(s) gave the wrong answer");
  process.exit(1);
}
console.log("ALL GOOD — every rule still answers as it should");
