// @ts-check
/**
 * The documents that lawfully stand in for a certificate that has run out.
 *
 * A red cell is not always a man who cannot work. The orders let five papers
 * carry him for a while:
 *
 *  - an AMSA letter extending the certificate, up to six months, where
 *    revalidation was applied for before it expired - and only a certificate
 *    of competency, a rating certificate, a GMDSS radio operator certificate
 *    or a marine cook certificate. Never a certificate of safety training
 *    (MO70 s 15(3) does not list it) and never a certificate of recognition,
 *    whose term can never be extended (s 30 note);
 *  - a near-coastal renewal lodged before the card expired, which keeps him
 *    lawful for 90 days after the expiry (MO505 s 7(3));
 *  - a temporary crewing permit, up to three months (MO504 s 16(2); MO505
 *    s 7(4));
 *  - a final assessor's declaration, 60 days, and only the lower
 *    near-coastal grades (MO505 ss 22-24);
 *  - AMSA's letter saying the certificate has been issued, which IS the
 *    certificate until the card arrives (MO505 s 12(2)) - the one paper the
 *    law gives no end.
 *
 * Which columns each may cover, and each one's ceiling in days, are in the
 * vessel file (`evidenceKinds`) with the clause written beside them, so the
 * law's mapping is data anybody can read and check against the order. Where
 * the document prints its own end date, that date governs; the ceiling only
 * catches a longer one. A cover runs out the way a certificate does - the day
 * printed is the day it stops counting (MO70 s 5(a)(iii)) - so the 90 days
 * MO505 allows are the 90 days after the expiry and not a day more.
 *
 * Nothing here decides a colour. A cover is never green: green would say the
 * certificate is in date, and it is not. What the cell does with this answer
 * is the page's (the amber band and the words on its title).
 *
 * A shared file cannot import another, so the register (crewRegister in
 * names.js) and the name question (nameIsSomebodyElse, the round's and the
 * cells') are handed in by the caller as part of `rules`. The page splices
 * this file in at its @shared marker, so the rule is proved on the code that
 * ships. Edit it here and only here.
 */

/**
 * @typedef {{ id?: unknown, key?: unknown, person?: string | null, code?: string | null,
 *   tagged?: boolean, filedOn?: string | null }} EvidenceRow
 *   One certificate on the books: the row's own id, the key of its reading,
 *   the name it is filed under, the matrix code it answers to, whether that
 *   code is a hand tag (which makes the row a certificate whatever kind of
 *   paper the reading calls it - the round and the page's cells read the tag
 *   the same way), and when it was filed. Newest upload first, as the
 *   library's listing hands them over.
 * @typedef {{ readable?: boolean, holderName?: string | null, issuedOn?: string | null,
 *   expiresOn?: string | null, evidenceKind?: string | null,
 *   isRecognition?: boolean | null }} EvidenceReading
 * @typedef {{ days?: number | null, from?: string, covers?: string[],
 *   notWhenRecognition?: boolean, lodgedBeforeExpiry?: boolean, why?: string }} EvidenceKind
 *   One kind as the vessel file carries it: its ceiling in days (null where
 *   the law gives none), what the ceiling is counted from ("issued" - the
 *   document's own issue date - or "expiry", the certificate's), the columns
 *   it may cover, whether it is barred where the certificate is itself a
 *   recognition, whether it must have been lodged before the certificate
 *   expired to carry anything at all, and the clause it all comes from.
 * @typedef {Record<string, EvidenceKind> | null | undefined} EvidenceKinds
 * @typedef {{ nameOf: (spelling: unknown) => string | null }} Register
 * @typedef {(printed: unknown, filedUnder: unknown, known: unknown) => boolean} NameIsSomebodyElse
 *   Whether the name printed on a document says it is somebody else's - the
 *   one question the round and the page's cells ask (nameIsSomebodyElse in
 *   names.js), handed in so this rule can never answer it differently.
 * @typedef {{ kinds?: EvidenceKinds, register: Register, nameIsSomebodyElse: NameIsSomebodyElse }} EvidenceRules
 * @typedef {{ kind: string, until: string | null, rowId: string }} Cover
 *   The cover that stands: which paper it is, the day it stops counting
 *   (null for an issue letter, which the law gives no end), and the row to
 *   link to.
 */

/** The five kinds the reading may name (evidenceKind in the Reading). A
 *  vessel file naming anything else is a table somebody guessed at, so both
 *  `checkVessel`s refuse it. */
export const EVIDENCE_KINDS = ["extension", "lodged-renewal", "crewing-permit", "assessor-declaration", "issue-letter"];

/** What a ceiling may be counted from: the document's own issue date, or the
 *  expiry printed on the certificate it stands in for (MO505 s 7(3) counts
 *  its 90 days from the expiry). */
export const EVIDENCE_ANCHORS = ["issued", "expiry"];

/** A YYYY-MM-DD day that exists, or "".
 * @param {unknown} v
 */
function evidenceDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || "").slice(0, 10));
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const real = d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1
    && d.getUTCDate() === Number(m[3]);
  return real ? m[0] : "";
}

/** `days` days on from a day, as YYYY-MM-DD.
 * @param {string} iso
 * @param {number} days
 */
function evidenceOn(iso, days) {
  return new Date(new Date(iso + "T00:00:00Z").getTime() + days * 86400000).toISOString().slice(0, 10);
}

/** A code as the columns write it. */
const evidenceCode = (/** @type {unknown} */ c) => String(c == null ? "" : c).trim().toUpperCase();

/**
 * Whether a vessel file's `evidenceKinds` table will do, in one sentence
 * naming the first entry that will not - or null when it is sound.
 *
 * A column that is not a column would be a cover nobody could see; a kind
 * the reading never gives would be a paper never found; a ceiling counted
 * from nowhere would be a date nobody could work out. Both `checkVessel`s
 * ask this as the file loads.
 * @param {unknown} table the vessel file's evidenceKinds
 * @param {unknown} columnCodes the vessel file's qualColumns codes
 * @returns {string | null}
 */
export function evidenceKindsProblem(table, columnCodes) {
  if (table === undefined || table === null) return null;   // a vessel may have no table
  if (typeof table !== "object" || Array.isArray(table)) return "evidenceKinds must be an object of kind: { days, from, covers, why }.";
  const columns = (Array.isArray(columnCodes) ? columnCodes : []).map(evidenceCode);
  const rows = /** @type {Record<string, EvidenceKind>} */ (table);
  for (const kind of Object.keys(rows)) {
    const at = 'evidenceKinds["' + kind + '"]';
    if (!EVIDENCE_KINDS.includes(kind)) return at + " is not one of the kinds a reading gives: " + EVIDENCE_KINDS.join(", ") + ".";
    const entry = rows[kind] || {};
    const days = entry.days;
    if (!(days === null || (typeof days === "number" && Number.isInteger(days) && days > 0))) {
      return at + ' must say how many days it may run at most in "days", or null where the law gives it no end.';
    }
    if (!EVIDENCE_ANCHORS.includes(String(entry.from))) {
      return at + ' must count its days in "from" from one of ' + EVIDENCE_ANCHORS.join(", ") + ".";
    }
    if (!Array.isArray(entry.covers) || !entry.covers.length) return at + ' must name the columns it may cover in "covers".';
    for (const code of entry.covers) {
      if (!columns.includes(evidenceCode(code))) return at + " may cover " + code + ", which is not one of the vessel's columns.";
    }
    for (const flag of ["notWhenRecognition", "lodgedBeforeExpiry"]) {
      const said = /** @type {Record<string, unknown>} */ (entry)[flag];
      if (said !== undefined && typeof said !== "boolean") return at + " may say " + flag + " only as true or false.";
    }
    if (typeof entry.why !== "string" || !entry.why.trim()) return at + ' must say which clause it comes from, in its "why".';
  }
  return null;
}

/**
 * The paper that covers one man's column today, or null.
 *
 * Only a document filed under him through the register, that was read, and
 * that is not printed in another man's name. Where the row carries a code it
 * covers that column and no other - a letter about his Master certificate is
 * not evidence about his engine ticket - and where the round could put no
 * code to it, any column its kind allows.
 *
 * A reading made before the portal asked what kind of paper a document is
 * has no `evidenceKind` at all, and says nothing either way: it is topped up
 * on the hour, not guessed at here.
 *
 * Of two covers the one that runs longest is the answer, and an issue letter,
 * which the law gives no end, outlasts them all.
 * @param {string} code the column
 * @param {string} person the register's name for him
 * @param {EvidenceRow[] | null | undefined} rows
 * @param {Map<string, EvidenceReading> | Record<string, EvidenceReading> | null | undefined} readings by key
 * @param {string} todayISO YYYY-MM-DD
 * @param {EvidenceRules} rules the vessel file's evidenceKinds and the register
 * @returns {Cover | null}
 */
export function coveredBy(code, person, rows, readings, todayISO, rules) {
  const kinds = rules && rules.kinds;
  const register = rules && rules.register;
  const isSomebodyElse = rules && rules.nameIsSomebodyElse;
  /* The name rule is the round's and the cells' (names.js) and every caller
     has it. Without it this rule would answer whose paper a letter is its
     own way, so a caller that forgets it is stopped here rather than found
     on the grid. */
  if (typeof isSomebodyElse !== "function") throw new Error("coveredBy needs the shared name rule (nameIsSomebodyElse in source/shared/names.js) in rules.");
  if (!kinds || typeof kinds !== "object" || !register) return null;
  const want = evidenceCode(code);
  const today = evidenceDay(todayISO);
  if (!want || !today) return null;
  const me = register.nameOf(person) || person;
  /** @param {string} k */
  const readingOf = (k) =>
    (readings instanceof Map ? readings.get(k) : readings ? readings[k] : null) || null;

  // His own papers, each once, in the order the listing gave them.
  const seen = new Set();
  /** @type {{ row: EvidenceRow, reading: EvidenceReading, kind: string }[]} */
  const mine = [];
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const key = row && row.key != null ? String(row.key) : "";
    if (!key || seen.has(key)) return;
    if (!row.person || register.nameOf(row.person) !== me) return;
    const reading = readingOf(key);
    if (!reading || reading.readable === false) return;
    /* Printed in somebody else's name: his folder, not his paper. The same
       question the round and the cells ask - the printed name has to share a
       word with the folder or with the register's name for him, and a
       document naming nobody says nothing either way. Held by strict
       equality of nameOf instead, a spelling the register could not resolve
       ("Brent Evans" against an alias of "bRENTON") was his to the round and
       nobody's here. */
    if (isSomebodyElse(reading.holderName, row.person, me)) return;
    seen.add(key);
    /* What the document is: one of the five papers where the reading says
       so - unless somebody tagged the row, which makes it the certificate
       for that column whatever the reading calls it. A document is the
       certificate or a paper, never both. */
    const kind = row.tagged ? "" : String(reading.evidenceKind || "").trim();
    mine.push({ row, reading, kind });
  });

  /* The certificate itself, for the two questions that turn on it: the day
     MO505's 90 days are counted from, and whether what ran out was a
     recognition, whose term can never be extended. The latest expiry of the
     certificates in this column - never one of the papers standing in for
     them. */
  const own = mine.filter((x) => evidenceCode(x.row.code) === want && !x.kind);
  const ownExpiry = own
    .map((x) => evidenceDay(x.reading.expiresOn))
    .filter((d) => !!d)
    .sort()
    .pop() || "";
  /* And the day the latest of them was issued, for the paper a certificate
     in hand has answered. */
  const ownIssued = own
    .map((x) => evidenceDay(x.reading.issuedOn))
    .filter((d) => !!d)
    .sort()
    .pop() || "";
  /* Whether what ran out was itself a certificate of recognition, whose term
     can never be extended (MO70 s 30 note). Asked of any of his certificates
     that could be for this column, not only the ones the round managed to
     put a code to: a recognition it could place nowhere would otherwise
     leave an extension letter covering the column anyway. */
  const ownIsRecognition = mine.some((x) =>
    x.reading.isRecognition === true && !x.kind
    && (!evidenceCode(x.row.code) || evidenceCode(x.row.code) === want));

  /** @type {Cover[]} */
  const standing = [];
  mine.forEach((x) => {
    const kind = x.kind;
    if (!kind) return;
    const entry = /** @type {Record<string, EvidenceKind>} */ (kinds)[kind];
    if (!entry) return;                                       // not a kind this vessel allows
    if (!(entry.covers || []).map(evidenceCode).includes(want)) return;
    // Filed against another column: evidence about that certificate, not this.
    const filedAs = evidenceCode(x.row.code);
    if (filedAs && filedAs !== want) return;
    if (entry.notWhenRecognition && ownIsRecognition) return;

    const paperIssued = evidenceDay(x.reading.issuedOn);
    /* A paper is spent once the certificate it was written about is in hand.
       AMSA's issue letter IS the certificate only "until the card arrives"
       (MO505 s 12(2)), and an extension or a lodged renewal is answered by
       the certificate that came of it. So a certificate for this column
       issued on or after the paper takes the paper off the books - without
       which an issue letter, the one paper the law gives no end, would carry
       a column for ever and a cell the office must chase would read as
       carried. Where neither date was read off the scans nothing is assumed:
       the paper stands until its own time runs out. */
    if (ownIssued && paperIssued && ownIssued >= paperIssued) return;
    /* A renewal lodged after the certificate had already gone carries
       nothing: MO505 s 7(3) gives its 90 days only where the person applied
       "before it expires". The receipt's own date is the day it was lodged.
       Which kinds this bites is the vessel file's (lodgedBeforeExpiry) - an
       extension letter is AMSA's own letter and may well be written after the
       expiry it extends, so it is not one of them. */
    if (entry.lodgedBeforeExpiry && paperIssued && ownExpiry && paperIssued > ownExpiry) return;

    const printed = evidenceDay(x.reading.expiresOn);
    let ceiling = "";
    if (typeof entry.days === "number") {
      const anchor = entry.from === "expiry" ? ownExpiry : evidenceDay(x.reading.issuedOn);
      if (!anchor) return;                                    // nothing to count the days from
      ceiling = evidenceOn(anchor, entry.days);
    }
    // The printed date governs; the ceiling only catches a longer one.
    const until = printed && ceiling ? (printed < ceiling ? printed : ceiling) : (printed || ceiling || "");
    if (until && until <= today) return;                      // the cover has run out
    standing.push({
      kind,
      until: until || null,
      rowId: x.row.id != null && String(x.row.id) !== "" ? String(x.row.id) : String(x.row.key),
    });
  });

  if (!standing.length) return null;
  // The one that carries him longest; no end at all outlasts any date.
  return standing.sort((a, b) => {
    if (a.until === b.until) return 0;
    if (a.until === null) return -1;
    if (b.until === null) return 1;
    return b.until.localeCompare(a.until);
  })[0];
}
