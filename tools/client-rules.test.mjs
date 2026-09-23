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
import { fileURLToPath } from "node:url";
const NL = String.fromCharCode(10);

/* The whole portal, compiled by the same Babel the checks use, run once with
 * the browser stubbed out, and the functions under test handed back. Nothing
 * is re-implemented or hand-extracted: the code under test is the code that
 * ships. Same harness as insert-rows.test.mjs. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const { portalJsx } = await import("file:///" + ROOT.replaceAll(" ", "%20") + "/tools/source.mjs");
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
  js + NL + ";return { crewRegister, applySettled, nameLetters, registerWords, canonicalName, rankGroupAt, RANK_GROUPS, ROSTER_RANKS, mergeQuals };",
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

if (failed) {
  console.error(failed + " rule(s) gave the wrong answer");
  process.exit(1);
}
console.log("ALL GOOD — every rule still answers as it should");
