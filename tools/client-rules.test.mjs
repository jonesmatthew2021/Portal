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
const { portalJsx } = await import("file:///" + ROOT.replaceAll(" ", "%20") + "/tools/source.mjs");
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
  js + NL + ";return { crewRegister, applySettled, settleRound, nameLetters, registerWords, canonicalName, rankGroupAt, RANK_GROUPS, ROSTER_RANKS, mergeQuals, filedUnderSuffix, waitForRound, shouldTabRound, mergeSaved, afterMergedSave, mergeHistory, mergeFilled, mergeSeen, mergePending, saveState, saveTryAgainIn, settledKeys, missesInARow, roundAnswerPhase, progressAccept, pullNowStep, doneEyebrow, doneWindowLines, PULL_LATE_NOTE, freshPull, cutOffSwitch, CUT_OFF, runCleared, queueRound, roundBusyTitle, ROUND_BUSY, matrixLastMoved, fileSpreadsheetSend, fileSpreadsheetStep, fileSpreadsheetAttempt, fileSpreadsheetOutcome, matrixFreshAt, badgeShouldClear, crewUploadNote, OUT_OF_CREDIT, READING_UNAVAILABLE, KEY_PROBLEM };",
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

if (failed) {
  console.error(failed + " rule(s) gave the wrong answer");
  process.exit(1);
}
console.log("ALL GOOD — every rule still answers as it should");
