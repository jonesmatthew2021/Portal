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
  js + NL + ";return { crewRegister, applySettled, settleRound, nameLetters, registerWords, canonicalName, rankGroupAt, RANK_GROUPS, ROSTER_RANKS, mergeQuals, filedUnderSuffix, waitForRound, shouldTabRound, mergeSaved, mergeHistory, mergeFilled, mergeSeen, mergePending };",
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
     for two looks and then not, and a clock that does not wait. */
  let looks = 0;
  const running = async () => ({ ok: true, json: async () => ({ running: ++looks < 3 }) });
  const page = fn(
    ReactStub, { createRoot: () => ({ render: () => {} }) }, {}, windowStub, documentStub,
    windowStub.navigator, windowStub.location, sessionStub, sessionStub, () => {}, running,
    () => 0, (f) => { f(); return 0; }, () => {}, () => {}, () => 0, () => {}, () => false,
    function N() {}, function I() {}, function A() {}, class { observe() {} }, function F() {},
    function X() {}, { now: () => 0 }, {}, {},
  );
  let waited = 0;
  const seen = [];
  is(await page.waitForRound(() => waited++, (running) => seen.push(running)), true, "the lease came free and the page may go on");
  is(looks, 3, "it looked until the portal said the round had finished");
  is(waited, 2, "…and said it was waiting each time it was not");
  is(seen, [true, true, false], "…and told the provider what every look found, the last look included, so the buttons come back");
  is(await lib.waitForRound(), true, "a portal that cannot say counts as free: the request itself is what gets refused");
}

/* ---- the change log and the round's notes, three copies to one: what
        the hour wrote is kept, and only what this tab changed lands ---- */
{
  const e = (id, at) => ({ id, at, by: "x", section: "Admin", action: id, detail: "" });
  const mine = [e("m2", "2026-09-24T10:30"), e("m1", "2026-09-24T09:00")];
  const theirs = [e("s1", "2026-09-24T10:00"), e("m1", "2026-09-24T09:00")];
  const out = rules.mergeHistory(mine, theirs);
  is(out.map((x) => x.id), ["m2", "s1", "m1"], "the hour's line and the tab's line are both kept, newest first, and a line both hold appears once");
  const tied = rules.mergeHistory([e("a", "2026-09-24T10:00"), e("b", "2026-09-24T10:00")], [e("c", "2026-09-24T10:00")]);
  is(tied.map((x) => x.id), ["a", "b", "c"], "lines with the same stamp keep mine's order");
  const many = Array.from({ length: 480 }, (_, i) => e("m" + i, "2026-09-24T10:" + String(59 - (i % 60)).padStart(2, "0")));
  const more = Array.from({ length: 40 }, (_, i) => e("s" + i, "2026-09-24T11:00"));
  const capped = rules.mergeHistory(many, more);
  is(capped.length, 500, "the log is capped at five hundred");
  is(capped.slice(0, 40).every((x) => x.id.startsWith("s")), true, "…and the newest survive the cap");
  is(rules.mergeHistory(null, undefined), [], "nothing on either side is an empty log");

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
  const base = { quals, filled: { A: true, B: true }, seen: { X: "h1" }, pending: ["P"] };
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
  const page = lib.mergeHistory(mine.history, theirs.history);
  is(page, rules.mergeHistory(mine.history, theirs.history), "mergeHistory in the page answers as the module does");
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
  is(ask({ lastDocUpdate: null }), true, "…never updated: due");
  is(ask({ last: { sync: null, hourly: null, running: false } }), true, "a portal that has no hour on record leaves the tab to its own clock");
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
