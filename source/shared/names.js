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
  String(n || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length > 1);

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

/** Every piece of a printed name, initials and all, accents folded away the
 *  same way holderWords folds them. A piece with no letter in it (a number
 *  printed beside the name) is not part of the name.
 * @param {unknown} n
 */
const holderPieces = (n) =>
  String(n || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().split(/[^A-Z0-9]+/).filter((w) => /[A-Z]/.test(w));

/** How many letters two words are apart: one put in, taken out or changed
 *  counts one.
 * @param {string} a
 * @param {string} b
 */
const lettersApart = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
};

/** Whether a printed piece of a name can be one of his words: the same
 *  word, his initial, the short form of it ("ROB" for "ROBERT"), or the
 *  word misspelt by a letter - two in a long one ("KACHN" for "KACHIN",
 *  "SITTYOS" for "SITTIYOS").
 * @param {string} piece
 * @param {string} his
 */
const pieceCanBe = (piece, his) => {
  if (piece === his) return true;
  if (piece.length === 1) return his.startsWith(piece);
  if (piece.length >= 3 && his.length >= 3 && (his.startsWith(piece) || piece.startsWith(his))) return true;
  const shorter = Math.min(piece.length, his.length);
  if (shorter < 4) return false;
  return lettersApart(piece, his) <= (shorter >= 6 ? 2 : 1);
};

/**
 * The reader's pick weighed against the register, with whether the printed
 * name shares a word with the man (readerPlaces needs to know).
 * @param {unknown} printed
 * @param {{ person?: unknown, confidence?: unknown, others?: unknown, why?: unknown } | null | undefined} holder
 * @param {Person[] | null | undefined} people
 * @returns {{ person: string, line: "add" | "check" | null, shares: boolean } | null}
 */
function pickWeighed(printed, holder, people) {
  if (!holder || !holder.person) return null;
  if (Array.isArray(holder.others) && holder.others.length) return null;
  const sure = holder.confidence === "high";
  if (!sure && holder.confidence !== "medium") return null;
  if (!String(printed || "").trim()) return null;
  const on = (people || []).find((p) => p && String(p.name || "").trim() === String(holder.person).trim());
  if (!on) return null;
  const person = String(on.name).trim();

  // His words, off every spelling the register has for him, and everybody
  // else's.
  const his = new Set([on.name, ...(on.aliases || [])].flatMap(holderWords));
  const theirs = new Set();
  (people || []).forEach((p) => {
    if (!p || p === on) return;
    [p.name, ...(p.aliases || [])].flatMap(holderWords).forEach((w) => theirs.add(w));
  });

  /* Never two people. The reader is asked to list anyone else it could be
     (`others`), but its reasons can name one without listing him ("could
     be Kachin or Rohin"): a pick whose reasons name somebody else on the
     register is no pick. */
  if (holderWords(holder.why).some((w) => theirs.has(w) && !his.has(w))) return null;

  // Shares a word: nameIsSomebodyElse's own question, asked the other way
  // round. A printed name with no word in it to compare - initials only, a
  // script the letters A-Z do not cover - shares nothing: it says nothing
  // either way, and "nothing" is not a word in common.
  const words = holderWords(printed);
  const shares = words.length > 0 && !nameIsSomebodyElse(printed, person, (on.aliases || []).join(" "));

  /* A word printed on it that is another man's on Crew Details and none of
     his ("R. JITENDER", "Rohin" or "EVANS" picked as SITTIYOS, Kachin):
     the printed name points at somebody else. With no word of his beside
     it, the pick is no pick, however sure - and the office is never asked
     to put another man's name on his entry. With one ("Rohin EVANS" picked
     as EVANS, Brenton) it is a doubt like the two below. A piece that is
     only nearly another man's - misspelt, shortened, his initial ("R.
     JITINDER", "Brent", "R. J.") - and can be none of the pick's words
     points at him just the same. */
  const hisList = [...his];
  const theirsOnly = [...theirs].filter((t) => !his.has(t));
  const elsewhere = holderPieces(printed).some((w) => !his.has(w) && (theirs.has(w)
    || (!hisList.some((h) => pieceCanBe(w, h)) && theirsOnly.some((t) => pieceCanBe(w, t)))));
  if (elsewhere && !shares) return null;

  /* Where the word in common does not settle it. Either every word the
     printed name shares with him is somebody else's on the register too
     (two EVANSes, "G. EVANS"), or the printed name carries another piece -
     a given name, an initial - that can be none of his words not already
     matched ("Gareth EVANS" or "D. EVANS" picked as EVANS, Brenton, with
     Gareth or David nowhere on the register). A misspelt given name, a
     short form or his initial can be his, but is not his letter for letter
     ("Joan SMITH" is a letter from "SMITH, John"): a sure pick on one is
     placed and checked, never placed quietly. */
  const hit = words.filter((w) => his.has(w));
  const everyoneElses = hit.length > 0 && hit.every((w) => theirs.has(w));
  const unmatched = [...his].filter((w) => !hit.includes(w));
  const rest = holderPieces(printed).filter((w) => !hit.includes(w));
  // The pieces that can be one of his other words, and are not that word.
  const near = unmatched.length ? rest.filter((w) => unmatched.some((u) => pieceCanBe(w, u))) : [];
  const contradicts = shares && unmatched.length > 0 && rest.length > 0 && !near.length;
  const loose = shares && near.length > 0;
  // Only part of his name and nothing else ("JITENDER" alone): his word,
  // but less to go on than "R. JITENDER", so checked the same.
  const partial = shares && rest.length === 0 && unmatched.length > 0;
  const doubt = everyoneElses || contradicts || elsewhere;

  if (sure) return { person, shares, line: !shares ? "add" : doubt || loose || partial ? "check" : null };
  return shares && !doubt ? { person, shares, line: "check" } : null;
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
 *     else in mind as well (`others`, or another register man named in its
 *     reasons) - never two people - is no pick;
 *   - the pick must be a person on the register, and the document must
 *     print a name at all;
 *   - "high" stands. Where the printed name shares no word with the man or
 *     any of his spellings, it still stands - the reader may know "Bill"
 *     is Kachin - and the office is asked to add the printed name to his
 *     names ("add"), so the register stays the one place names live and the
 *     next certificate does not need the reader's memory. But never where
 *     that printed name carries a word of another man's on the register
 *     ("R. JITENDER" picked as Kachin): that is no pick. Where the word in
 *     common does not settle it - two EVANSes, a word of another man's
 *     beside it, or a given name or initial that is none of his - or where
 *     the rest of the name is his only by an initial, a short form or a
 *     letter or two ("Joan SMITH" for John), it stands and the office is
 *     asked to check it;
 *   - "medium" stands only where the printed name shares a word with him and
 *     nothing on it says it could be somebody else, and the office is asked
 *     to check it ("check"). Anything less is refused: the reader may not
 *     put "Rohin Jitender" on "ROSE, Matthew", nor "Gareth EVANS" on
 *     "EVANS, Brenton", on a maybe.
 *
 * "Shares a word" is nameIsSomebodyElse's own question, not a second one.
 * @param {unknown} printed the holder's name as read off the document
 * @param {{ person?: unknown, confidence?: unknown, others?: unknown, why?: unknown } | null | undefined} holder the reader's pick
 * @param {Person[] | null | undefined} people the register
 * @returns {{ person: string, line: "add" | "check" | null } | null}
 */
export function readerPick(printed, holder, people) {
  const weighed = pickWeighed(printed, holder, people);
  return weighed ? { person: weighed.person, line: weighed.line } : null;
}

/**
 * Whose certificate a document is, as the round and the page's cells both
 * ask it (compareMatrix in worker/src/routes/analyse.ts, certificateStanding
 * in worker/src/lib/analysis.ts): whether it is the man it is filed under,
 * and what, if anything, the office is asked to do about the name.
 *
 * A printed name the register spells - one of his spellings letter for
 * letter, or two or more of his words (crewRegister's `spelled`) - is that
 * man's, and the reader has nothing to add. A surname or a given name alone
 * is not a spelling: it goes to the reader, and the reader's doubts go on
 * Needs attention. Otherwise, where the
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
  const byRegister = String(printed || "").trim() ? reg.spelled(printed) : null;
  // A printed name the register itself reads: one of his spellings, or
  // somebody else's - the reader is not asked, and a word in common with
  // the man it is filed under does not make another man's name his
  // ("Gareth EVANS" in Brenton's folder, with Gareth on Crew Details).
  if (byRegister) return { his: byRegister === known, line: null };
  const picked = readerPick(printed, holder, people);
  if (picked && picked.person === known) return { his: true, line: picked.line };
  return { his: fits, line: null };
}

/**
 * The reader's pick, only where nothing else says whose the document is:
 * not where the register spells the printed name itself, and not where the
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
  if (String(printed || "").trim() && reg.spelled(printed)) return null;
  const known = filedUnder ? reg.nameOf(filedUnder) : null;
  if (known && !nameIsSomebodyElse(printed, filedUnder, known)) return null;
  const picked = pickWeighed(printed, holder, people);
  if (!picked) return null;
  /* The office's folder is overruled only by the printed name, never by the
     reader's memory alone: a certificate in a register man's folder goes to
     another man only where the printed name shares a word with him. */
  if (known && picked.person !== known && !picked.shares) return null;
  return { person: picked.person, line: picked.line };
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
  // taken over by another person having listed it as one of theirs. A
  // spelling two people both list as theirs ("Bill" on two men) is neither's:
  // the register will not choose, the same as for a word two names share.
  /** @type {Map<string, string>} */
  const byAlias = new Map();
  (people || []).forEach((p) => {
    const name = String((p && p.name) || "").trim();
    if (!name) return;
    ((p && p.aliases) || []).forEach((a) => {
      const k = nameLetters(a);
      if (!k) return;
      if (!exact.has(k) && !byAlias.has(k)) { exact.set(k, name); byAlias.set(k, name); }
      else if (byAlias.has(k) && byAlias.get(k) !== name) exact.delete(k);
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
  /**
   * A name as the register spells it: letter for letter, or two or more of
   * one man's words - never one word alone. A folder called "SAM" is the one
   * Sam (nameOf), but a certificate printed "D. EVANS" is not therefore the
   * one Evans on the register: David may simply not be on it yet. Whose a
   * printed name is (whoseCertificate, readerPlaces, the refile's holderFor)
   * asks this.
   * @param {unknown} spelling
   * @returns {string | null}
   */
  const spelled = (spelling) => exact.get(nameLetters(spelling)) || byWords(spelling) || null;
  return { nameOf, knows, spelled };
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
