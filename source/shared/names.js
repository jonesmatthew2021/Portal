// @ts-check
/**
 * The names the page and the worker both go by: the crew register, which rows
 * of a matrix are people, and the items that never lapse. The page splices
 * this file in at its @shared marker; the worker imports it. Edit it here and
 * only here.
 */

/**
 * @typedef {{ name?: string, aliases?: string[] }} Person
 *   One person on the register: the name the portal speaks, and every other
 *   spelling they answer to.
 * @typedef {[string, string, string, string[]]} MatrixRow
 *   A crew matrix row: name, position, SAM number, then one value per column.
 * @typedef {{ cols: string[][], rows: MatrixRow[] }} Quals
 */

/**
 * Words that belong to a requirement rather than to a person.
 *
 * A crew qualification spreadsheet keeps a block of requirement furniture under
 * the crew — "Number Required", "Position", "Required Number of Position to
 * Hold Requirement" — and a matrix read out of one brings those rows across in
 * the name column as though they were people.
 */
export const REQUIREMENT_ROW_WORDS =
  /\b(any|crew|holder|holders|minimum|number|position|positions|rank|required|requirement|requirements|shift|shifts|total)\b/i;

/**
 * Whether a row of the matrix is somebody.
 *
 * Nothing is tracked against a requirement row, so it counts as having nothing
 * outstanding and sits among the crew at 100% — which is how "Number Required"
 * comes to read as a deckhand who is fully up to date.
 *
 * Only a row that plainly isn't a name is dropped. A name written the way the
 * matrix writes them — surname, then given name — is kept whatever else is in
 * it, because leaving somebody who is really on the crew off a certification
 * list is the worse mistake of the two.
 * @param {unknown[] | null | undefined} row
 */
export function isCrewRow(row) {
  const name = String((row && row[0]) || "").trim();
  if (!name) return false;
  if (/[A-Za-z],\s*[A-Za-z]/.test(name)) return true;
  return !REQUIREMENT_ROW_WORDS.test(name);
}

/* ==========================================================================
 * The crew register: one place a person is named, and everything reads it.
 *
 * The office writes the same man six ways. The matrix spreadsheet has
 * "sAM", his SharePoint folder is "Sam - OPMS", his certificates are
 * signed "SAMPLE, Sam", the travel roster says "SAM SAMPLE" and the
 * swing list says "Sam Sample". Every one of those is a different string,
 * so nothing joined up and the man read as holding no paperwork at all.
 *
 * Renaming things to agree was tried and it does not hold - the next export
 * from OPMS comes back spelled the old way. So the portal stops trying. The
 * crew register on Crew Details holds each person's name once, together with
 * every other spelling they are known by, and the portal answers to any of
 * them and speaks only the register's.
 *
 * Which means a folder called "Sam - OPMS" can stay called that for ever.
 * ======================================================================== */

/** A name with everything that is not a letter taken out, for comparing.
 * @param {unknown} n
 */
export const nameLetters = (n) => String(n || "").toUpperCase().replace(/[^A-Z]/g, "");

/** The words in a name, initials dropped — they are not worth matching on.
 * @param {unknown} n
 */
export const registerWords = (n) => String(n || "").toUpperCase().split(/[^A-Z]+/).filter((w) => w.length > 1);

/** The words in a name as the two settling paths hold a printed name against
 *  a folder's: accents folded away first, so "José" filed and "Jose" printed
 *  are one word and not two. Digits count - a folder is sometimes numbered.
 * @param {unknown} n
 */
const holderWords = (n) =>
  String(n || "").normalize("NFKD").toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length > 1);

/**
 * Whether the name printed on a document says it is somebody else's.
 *
 * A scan filed against the wrong crew member is worse than one not filed at
 * all: it would put another man's dates in this man's cells. So the name the
 * model read off the document has to share a word with the folder it sits in
 * or with the register's name for that man - a certificate filed under "sAM"
 * and printed "Sam Sample" is the same man.
 *
 * A document with no name read off it says nothing either way and is left
 * alone: plenty of scans are too poor to read a name from.
 *
 * The round (compareMatrix in worker/src/routes/analyse.ts) and the page's
 * cells (certificateStanding in worker/src/lib/analysis.ts) both ask this
 * one question, so the grid and the round can never disagree about whose
 * certificate a document is.
 * @param {unknown} printed the holder's name as it was read off the scan
 * @param {unknown} filedUnder the name on the folder the scan sits in
 * @param {unknown} known the register's name for that man, where it has one
 * @returns {boolean}
 */
export function nameIsSomebodyElse(printed, filedUnder, known) {
  const on = holderWords(printed);
  if (!on.length) return false;
  const filed = [...holderWords(filedUnder), ...holderWords(known)];
  return !filed.some((w) => on.includes(w));
}

/**
 * The reader's pick of a person, where it stands.
 *
 * Names on certificates are all over the place - anyone can upload, and a
 * printed "R. JITENDER", a surname alone, a transliteration, a married name
 * or a nickname nobody has typed onto Crew Details yet all used to fill
 * nothing. So the reader is shown the register, numbered, and asked which
 * of these people the certificate is for (`holder` on the reading, the
 * person already turned from a number into the register's name). This is
 * the check that the pick is not absurd, and what the office is asked to do
 * about it:
 *
 *   - no pick, a guess ("low"), or a pick the reader made with somebody
 *     else in mind as well (`others`) - never two people - is no pick;
 *   - the pick must be a person on the register, and the document must
 *     print a name at all;
 *   - "high" stands. Where the printed name shares no word with the man or
 *     any of his spellings, it still stands - the reader may know "Bill"
 *     is Kachin - and the office is asked to add the printed name to his
 *     names ("add"), so the register stays the one place names live and the
 *     next certificate does not need the reader's memory;
 *   - "medium" stands only where the printed name shares a word with him,
 *     and the office is asked to check it ("check"). A "medium" pick of a
 *     man the printed name has nothing in common with is refused: the
 *     reader may not put "Rohin Jitender" on "ROSE, Matthew" on a maybe.
 *
 * "Shares a word" is nameIsSomebodyElse's own question, not a second one.
 * @param {unknown} printed the holder's name as read off the document
 * @param {{ person?: unknown, confidence?: unknown, others?: unknown } | null | undefined} holder the reader's pick
 * @param {Person[] | null | undefined} people the register
 * @returns {{ person: string, line: "add" | "check" | null } | null}
 */
export function readerPick(printed, holder, people) {
  if (!holder || !holder.person) return null;
  if (Array.isArray(holder.others) && holder.others.length) return null;
  const sure = holder.confidence === "high";
  if (!sure && holder.confidence !== "medium") return null;
  if (!String(printed || "").trim()) return null;
  const on = (people || []).find((p) => p && String(p.name || "").trim() === String(holder.person).trim());
  if (!on) return null;
  const person = String(on.name).trim();
  const shares = !nameIsSomebodyElse(printed, person, (on.aliases || []).join(" "));
  if (sure) return { person, line: shares ? null : "add" };
  return shares ? { person, line: "check" } : null;
}

/**
 * Whose certificate a document is, as the round and the page's cells both
 * ask it (compareMatrix in worker/src/routes/analyse.ts, certificateStanding
 * in worker/src/lib/analysis.ts): whether it is the man it is filed under,
 * and what, if anything, the office is asked to do about the name.
 *
 * A printed name the register reads is that man's spelling, and the answer
 * is as it always was: the reader has nothing to add. Otherwise, where the
 * reader's pick stands (readerPick) and IS the man it is filed under (the
 * hourly refile labels the row with the pick before the round runs), it is
 * his, and the pick's line goes with it - "add" or "check" - until his
 * names on Crew Details carry the printed spelling. A pick of anybody else
 * never takes it from the man it is filed under where the printed name fits
 * him: the reader is never let move a certificate that plausibly is the
 * filed man's, whatever it says.
 * @param {unknown} printed the holder's name as read off the document
 * @param {{ person?: unknown, confidence?: unknown, others?: unknown } | null | undefined} holder the reader's pick
 * @param {unknown} filedUnder the name on the row (the folder's, or the refile's label)
 * @param {unknown} known the register's name for that man, as the caller reads it
 * @param {Person[] | null | undefined} people the register
 * @returns {{ his: boolean, line: "add" | "check" | null }}
 */
export function whoseCertificate(printed, holder, filedUnder, known, people) {
  const reg = crewRegister(people);
  const filed = String(filedUnder || "");
  known = String(known || "") || reg.nameOf(filed) || filed;
  const fits = !nameIsSomebodyElse(printed, filed, known);
  const byRegister = String(printed || "").trim() ? reg.nameOf(printed) : null;
  // A printed name the register itself reads: one of his spellings, or
  // somebody else's - the reader is not asked.
  if (byRegister) return { his: byRegister === known || fits, line: null };
  const picked = readerPick(printed, holder, people);
  if (picked && picked.person === known) return { his: true, line: picked.line };
  return { his: fits, line: null };
}

/**
 * The reader's pick, only where nothing else says whose the document is:
 * not where the register reads the printed name itself, and not where the
 * printed name fits the man the document is filed under. The refile asks
 * this to label a row; whoseCertificate asks it to accept one.
 * @param {unknown} printed
 * @param {{ person?: unknown, confidence?: unknown, others?: unknown } | null | undefined} holder
 * @param {unknown} filedUnder
 * @param {Person[] | null | undefined} people
 * @returns {{ person: string, line: "add" | "check" | null } | null}
 */
export function readerPlaces(printed, holder, filedUnder, people) {
  const reg = crewRegister(people);
  if (String(printed || "").trim() && reg.nameOf(printed)) return null;
  const known = filedUnder ? reg.nameOf(filedUnder) : null;
  if (known && !nameIsSomebodyElse(printed, filedUnder, known)) return null;
  return readerPick(printed, holder, people);
}

/**
 * The one line Needs attention says where the reader placed a certificate
 * on a man whose names on Crew Details do not yet include the name printed
 * on it: "add" where the reader was sure, "check" where it was not.
 * @param {unknown} certificate the certificate's printed title, or its filename
 * @param {unknown} person the register's name for him
 * @param {unknown} printed the name printed on the certificate
 * @param {"add" | "check"} line
 */
export function readAsLine(certificate, person, printed, line) {
  const said = `${String(certificate == null ? "" : certificate)} read as ${String(person == null ? "" : person)}'s — `;
  const name = `"${String(printed == null ? "" : printed).trim()}"`;
  return line === "check"
    ? `${said}check, and add ${name} to their names on Crew Details`
    : `${said}add ${name} to their names on Crew Details`;
}

/**
 * The register, ready to answer to a name written any way round.
 *
 * Two ways of asking. First the spelling itself, letter for letter, which
 * covers the register's own names and every alias listed against them.
 *
 * Then the words, in any order. The travel roster writes "ALAN SMITH" and
 * "MICHAEL CHRISTIE ROGERS" where the matrix writes "SMITH, Alan" and
 * "ROGERS, Michael" — the same man, the same words, put in the other order and
 * sometimes with a middle name along. Left to aliases that would have been
 * forty rows of the office's two habits, answered one at a time, and answered
 * again the next time somebody exported the roster. So the register matches on
 * the words instead: one name's words all inside the other's, at least two of
 * them, and exactly one person it could be. Two candidates is not a match —
 * guessing between two crew members is worse than asking.
 *
 * A single word is matched only where exactly one man on the register answers
 * to it — one Sam on the register and "SAM" is him; two Evanses and "EVANS"
 * is a question, not a match.
 * @param {Person[] | null | undefined} people
 */
export function crewRegister(people) {
  const exact = new Map();
  /** @type {{ name: string, of: string }[]} */
  const spellings = [];
  (people || []).forEach((p) => {
    const name = String((p && p.name) || "").trim();
    if (!name) return;
    exact.set(nameLetters(name), name);
    spellings.push({ name, of: name });
  });
  // Aliases second, so a spelling that is somebody's actual name is never
  // taken over by another person having listed it as one of theirs.
  (people || []).forEach((p) => {
    const name = String((p && p.name) || "").trim();
    if (!name) return;
    ((p && p.aliases) || []).forEach((a) => {
      const k = nameLetters(a);
      if (!k) return;
      if (!exact.has(k)) exact.set(k, name);
      spellings.push({ name: String(a), of: name });
    });
  });

  const bags = spellings
    .map((x) => ({ of: x.of, w: new Set(registerWords(x.name)) }))
    .filter((x) => x.w.size >= 2);

  /**
   * @param {unknown} spelling
   */
  const byWords = (spelling) => {
    const w = new Set(registerWords(spelling));
    if (w.size < 2) return null;
    const could = new Set();
    bags.forEach((b) => {
      const small = w.size <= b.w.size ? w : b.w;
      const big = w.size <= b.w.size ? b.w : w;
      let all = true;
      small.forEach((x) => { if (!big.has(x)) all = false; });
      if (all) could.add(b.of);
    });
    return could.size === 1 ? [...could][0] : null;
  };

  /** One word, where exactly one man answers to it.
   *
   * The rule used to be that a single word was never matched — "Sam" was
   * somebody's first name and three men might answer to it. But the register
   * knows how many men answer to it: on this one there is one Sam and one
   * Evgeny, and a folder called SAM went on reading as a stranger after the
   * man had been put on the register by hand, because nobody had also typed
   * the folder's word in as one of his spellings. The same rule the take-on
   * pairing has always used: one word, one man, that man — two men, no match,
   * and the question is asked instead.
   * @param {unknown} spelling
   */
  const byOneWord = (spelling) => {
    const w = registerWords(spelling);
    if (w.length !== 1) return null;
    const could = new Set();
    spellings.forEach((x) => {
      if (registerWords(x.name).includes(w[0])) could.add(x.of);
    });
    return could.size === 1 ? [...could][0] : null;
  };

  /**
   * @param {unknown} spelling
   * @returns {string | null}
   */
  const nameOf = (spelling) =>
    exact.get(nameLetters(spelling)) || byWords(spelling) || byOneWord(spelling) || null;
  /** @param {unknown} spelling */
  const knows = (spelling) => !!nameOf(spelling);
  return { nameOf, knows };
}

/** Whatever a name was written as, as the register writes it.
 * @param {Person[] | null | undefined} people
 * @returns {(person: string) => string}
 */
export function asKnownPerson(people) {
  const reg = crewRegister(people);
  return (person) => reg.nameOf(person) || person;
}

/**
 * The matrix with only the crew on it.
 *
 * The same object comes back when every row is somebody's, so a matrix that was
 * never carrying furniture doesn't count as having changed.
 * @param {Quals | null | undefined} quals
 * @param {Person[] | null | undefined} people
 * @param {string[]} noExpiryCodes the items that never lapse (the vessel file's)
 */
export function crewRowsOnly(quals, people, noExpiryCodes) {
  // The list is the vessel file's and every caller has it. Without it an
  // e-learning would quietly read as a date that can run out, so a caller
  // that forgets the list is stopped here rather than found on the matrix.
  if (!Array.isArray(noExpiryCodes)) throw new Error("crewRowsOnly needs the vessel file's list of items that never lapse (noExpiryCodes).");
  if (!quals || !Array.isArray(quals.rows)) return quals;
  let rows = quals.rows.filter(isCrewRow);
  let changed = rows.length !== quals.rows.length;

  /* The register's name, whatever the spreadsheet called him.
   *
   * Done here because this is the one gate the matrix loads through, so the
   * grid, the tallies, the gap pages and every report say the same name
   * without being asked to. The spreadsheet is left exactly as the office
   * sent it - this is what the portal reads it as. */
  if ((people || []).length) {
    const known = asKnownPerson(people);
    rows = rows.map((r) => {
      const name = known(r[0]);
      if (name === r[0]) return r;
      changed = true;
      const nr = /** @type {MatrixRow} */ (r.slice());
      nr[0] = name;
      return nr;
    });
  }

  // Items that never lapse (noExpiryCodes, the vessel file's - an e-learning
  // sat once) carry no expiry date: any date ever typed or read into one of
  // their columns means the item was completed, so it reads as held rather
  // than as a date that can run out. Done here, at the one gate the matrix
  // loads through, so the grid, the tallies, the gap pages and every report
  // agree without asking.
  const cols = Array.isArray(quals.cols) ? quals.cols : [];
  const never = noExpiryCodes.map((code) => String(code).trim().toUpperCase());
  const noExp = cols.map((c) => never.includes(String((c && c[0]) || "").trim().toUpperCase()));
  if (noExp.some(Boolean)) {
    rows = rows.map((r) => {
      const cells = r[3];
      if (!Array.isArray(cells)) return r;
      let rowChanged = false;
      const next = cells.map((v, i) => {
        if (noExp[i] && /^\d{4}-\d{2}-\d{2}/.test(String(v || ""))) { rowChanged = true; return "Y"; }
        return v;
      });
      if (!rowChanged) return r;
      changed = true;
      const nr = /** @type {MatrixRow} */ (r.slice());
      nr[3] = next;
      return nr;
    });
  }

  return changed ? { ...quals, rows } : quals;
}

/* The matrix items that carry no expiry date at all are the vessel file's
   (noExpiryCodes): the page and the server's comparison (worker/src/lib/
   analysis.ts) both read that one list, and hand it to crewRowsOnly above. */
