// @ts-check
/**
 * A man's MSIC number and date of birth, off his own certificates.
 *
 * Crew Details has a box for each beside every name. Matthew asked for them
 * to fill themselves from the certificates rather than be typed from memory
 * for every port form. The reading asks each certificate for the number it
 * prints and the holder's date of birth (worker/src/routes/analyse.ts); the
 * round puts what these rules find into the boxes (worker/src/lib/round.ts).
 * The page splices this file in at its @shared marker, so the rules are
 * proved on the code that ships. Edit them here and only here.
 *
 * Three things these rules will not do:
 *  - take either value from a certificate printed in another man's name,
 *    or in no name that could be read, whatever folder it was filed in;
 *  - guess a date of birth where his certificates disagree;
 *  - write over a box somebody typed. A box still holding what the
 *    certificates put there is the certificates' to change (a new card
 *    brings a new number); anything else in it was typed, and stays.
 *
 * A shared file cannot import another, so the register (crewRegister in
 * names.js) is handed in by the caller.
 */

/**
 * @typedef {{ person?: string | null, code?: string | null, key: string, filedOn?: string | null }} ParticularRow
 *   One certificate on the books: the name it is filed under, the matrix
 *   code it answers to (as the round works it out), the key of its reading,
 *   and when it was filed. Handed in as the library's listing hands them
 *   over - the newest upload first - so of two cards alike in every date,
 *   the one earlier in the list is the one uploaded last.
 * @typedef {{ readable?: boolean, holderName?: string | null, issuedOn?: string | null,
 *   expiresOn?: string | null, documentNumber?: string | null, holderBirthDate?: string | null,
 *   qualCode?: string | null, certificateTitle?: string | null }} ParticularReading
 * @typedef {{ nameOf: (spelling: unknown) => string | null }} Register
 * @typedef {{ msic: string | null, dob: string | null }} Particulars
 * @typedef {{ msic?: string | null, dob?: string | null, was?: { msic?: string[], dob?: string[] } }} FromCert
 *   What the certificates last put in a man's two boxes, and what they put
 *   there before that (`was`).
 * @typedef {{ id?: unknown, name?: string, msic?: unknown, dob?: unknown }} ParticularPerson
 * @typedef {{ row: { filedOn?: string | null }, reading: ParticularReading, at: number }} ParticularCard
 */

/** The two boxes, by the field the person record keeps them in. */
export const PARTICULAR_FIELDS = /** @type {const} */ (["msic", "dob"]);

/** The column the MSIC card is filed under, found by its title on the
 *  vessel file's columns - never a code written into the rule. Null where
 *  the vessel carries no such column.
 * @param {unknown} cols the vessel file's qualColumns: [code, title, group][]
 * @returns {string | null}
 */
export function msicCodeIn(cols) {
  const want = "MARITIME SECURITY IDENTIFICATION CARD";
  const found = (Array.isArray(cols) ? cols : []).find((c) =>
    Array.isArray(c) && String(c[1] || "").replace(/\s+/g, " ").trim().toUpperCase() === want);
  return found ? String(found[0]).trim().toUpperCase() : null;
}

/** The columns for certificates of competency and proficiency - the ones
 *  most likely to print the holder's date of birth - found by their group
 *  on the vessel file, not by the letters their codes start with.
 * @param {unknown} cols the vessel file's qualColumns: [code, title, group][]
 * @returns {string[]}
 */
export function ticketCodesIn(cols) {
  return (Array.isArray(cols) ? cols : [])
    .filter((c) => Array.isArray(c) && String(c[2] || "").replace(/\s+/g, " ").trim().toUpperCase() === "QUALIFICATION")
    .map((c) => String(c[0]).trim().toUpperCase());
}

/** Whether the reading itself says the document is an MSIC card - the
 *  model put it in the MSIC column, or its title is the card's. Being
 *  filed in the column is not enough: an AusCheck letter or an application
 *  receipt filed there prints a reference number that is not his card's.
 * @param {ParticularReading | null | undefined} reading
 * @param {string | null} msicCode
 */
export function isMsicCard(reading, msicCode) {
  if (!reading || !msicCode) return false;
  const want = String(msicCode).trim().toUpperCase();
  if (String(reading.qualCode || "").trim().toUpperCase() === want) return true;
  const title = String(reading.certificateTitle || "").replace(/\s+/g, " ").trim().toUpperCase();
  return title.includes("MARITIME SECURITY IDENTIFICATION");
}

/** Of a man's MSIC cards, the one he holds now: the one that runs out
 *  last, then the one issued last, then filed last, then uploaded last.
 *  A card whose expiry went unread still takes the place of the one that
 *  runs out last where it was issued after it - or, with either issue
 *  date unread, filed after it - so a renewed card is not beaten by the
 *  old one only because its expiry could not be made out.
 * @template {ParticularCard} C
 * @param {C[]} cards
 * @returns {C | null}
 */
export function newestCard(cards) {
  const text = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");
  /**
   * @param {C} a
   * @param {C} b
   */
  const byIssue = (a, b) =>
    text(b.reading.issuedOn).localeCompare(text(a.reading.issuedOn))
    || text(b.row.filedOn).localeCompare(text(a.row.filedOn))
    || a.at - b.at; // earlier in the listing is the later upload
  const list = Array.isArray(cards) ? cards : [];
  const dated = list.filter((c) => text(c.reading.expiresOn))
    .sort((a, b) => text(b.reading.expiresOn).localeCompare(text(a.reading.expiresOn)) || byIssue(a, b));
  const undated = list.filter((c) => !text(c.reading.expiresOn)).sort(byIssue);
  const best = dated[0] || null;
  const plain = undated[0] || null;
  if (!best || !plain) return best || plain;
  const issued = text(plain.reading.issuedOn) && text(best.reading.issuedOn);
  const later = issued
    ? text(plain.reading.issuedOn) > text(best.reading.issuedOn)
    : text(plain.row.filedOn) > text(best.row.filedOn);
  return later ? plain : best;
}

/** An MSIC number as the box holds it: trimmed, inner spaces one, capitals.
 * @param {unknown} v
 */
export function msicAsWritten(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim().toUpperCase();
}

/** Whether a YYYY-MM-DD string is a day that exists.
 * @param {unknown} v
 */
function realDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** The same day `years` years before `today` (YYYY-MM-DD), as text - so it
 *  compares with a date of birth as text.
 * @param {string} today
 * @param {number} years
 */
function yearsBefore(today, years) {
  return String(Number(today.slice(0, 4)) - years).padStart(4, "0") + today.slice(4, 10);
}

/**
 * What one man's certificates say his MSIC number and date of birth are.
 *
 * Only certificates filed under him (through the register) that were read,
 * and whose printed holder is him through the register too. A reading that
 * names no holder gives nothing: a card misfiled in his folder whose name
 * could not be made out would otherwise put another man's number or birth
 * date in his box, and with no name the refile could never move it.
 *  - MSIC: off his MSIC cards - filed in the column and read as the card
 *    itself (isMsicCard) - whose reading has a number: the one he holds
 *    now (newestCard).
 *  - Date of birth: every one of his certificates that prints a real date
 *    between 15 and 90 years ago has a say; the date most of them give wins,
 *    and a tie between two dates is no answer.
 * @param {string} person the register's name for him
 * @param {ParticularRow[]} rows
 * @param {Map<string, ParticularReading> | Record<string, ParticularReading>} readings by key
 * @param {Register} register
 * @param {string} todayISO YYYY-MM-DD
 * @param {string | null} msicCode the MSIC column's code (msicCodeIn), or null
 * @returns {Particulars}
 */
export function particularsFor(person, rows, readings, register, todayISO, msicCode) {
  const me = register.nameOf(person) || person;
  /** @param {string} k */
  const readingOf = (k) => (readings instanceof Map ? readings.get(k) : readings && readings[k]) || null;
  // Each certificate once: the same scan filed twice is one say, not two.
  const seen = new Set();
  /** @type {{ row: ParticularRow, reading: ParticularReading, at: number }[]} */
  const mine = [];
  (Array.isArray(rows) ? rows : []).forEach((row, at) => {
    if (!row || !row.key || seen.has(row.key)) return;
    if (!row.person || register.nameOf(row.person) !== me) return;
    const reading = readingOf(row.key);
    if (!reading || reading.readable === false) return;
    // Filed under him but printed in another man's name - or in no name
    // that could be read: his folder, not necessarily his card.
    if (!reading.holderName || register.nameOf(reading.holderName) !== me) return;
    seen.add(row.key);
    mine.push({ row, reading, at });
  });

  /** @type {string | null} */
  let msic = null;
  const want = msicCode ? String(msicCode).trim().toUpperCase() : "";
  if (want) {
    const card = newestCard(mine.filter((x) =>
      String(x.row.code || "").trim().toUpperCase() === want
      && isMsicCard(x.reading, want)
      && msicAsWritten(x.reading.documentNumber)));
    if (card) msic = msicAsWritten(card.reading.documentNumber);
  }

  /** @type {string | null} */
  let dob = null;
  const today = String(todayISO || "").slice(0, 10);
  if (realDay(today)) {
    const oldest = yearsBefore(today, 90);
    const youngest = yearsBefore(today, 15);
    /** @type {Map<string, number>} */
    const says = new Map();
    mine.forEach((x) => {
      const d = typeof x.reading.holderBirthDate === "string" ? x.reading.holderBirthDate.slice(0, 10) : "";
      if (!realDay(d) || d < oldest || d > youngest) return;
      says.set(d, (says.get(d) || 0) + 1);
    });
    const ranked = [...says.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) dob = ranked[0][0];
  }
  return { msic, dob };
}

/** The key a man's particulars are remembered under: his id on Crew
 *  Details, which a change of name does not move.
 * @param {ParticularPerson} p
 */
export function particularsKeyOf(p) {
  if (!p || typeof p !== "object") return "";
  if (p.id != null && String(p.id) !== "") return String(p.id);
  return String(p.name || "").trim();
}

/** Two values of one box as the same: an MSIC number however it was
 *  spaced or cased, a date as written.
 * @param {"msic" | "dob"} field
 * @param {unknown} a
 * @param {unknown} b
 */
function sameParticular(field, a, b) {
  return field === "msic"
    ? msicAsWritten(a) === msicAsWritten(b)
    : String(a == null ? "" : a).trim() === String(b == null ? "" : b).trim();
}

/** How many of the values the certificates put in a box before are
 *  remembered beside the last one. */
const EARLIER_KEPT = 5;

/** Whether a man's box is the certificates' to fill: empty, or still
 *  holding what they last put there - or what they put there before that.
 *  An old card's number can come back into the box without anybody typing
 *  it: a tab still running a page from before the round filled boxes lays
 *  its whole crew list back over the round's on a collision. Taken for
 *  typed, it would hold the new card off for good. Anything else was
 *  typed. The hour asks this before it pays to read a certificate again.
 * @param {ParticularPerson} p
 * @param {"msic" | "dob"} field
 * @param {Record<string, FromCert> | null | undefined} fromCert
 */
export function openToCertificates(p, field, fromCert) {
  const box = p && typeof p[field] === "string" ? String(p[field]).trim() : "";
  if (!box) return true;
  const key = particularsKeyOf(p);
  const had = key && fromCert && typeof fromCert === "object" ? fromCert[key] : null;
  if (!had || typeof had !== "object") return false;
  const last = typeof had[field] === "string" ? had[field] : "";
  if (last && sameParticular(field, box, last)) return true;
  const earlier = had.was && typeof had.was === "object" && Array.isArray(had.was[field]) ? had.was[field] : [];
  return earlier.some((v) => typeof v === "string" && !!v && sameParticular(field, box, v));
}

/**
 * The boxes on Crew Details, filled from what the certificates found.
 *
 * A box is filled when it is empty, or when it still holds exactly what the
 * certificates put there last time (`fromCert`) - so a renewed card's
 * number takes the old card's place. Anything else in a box was typed by
 * hand and is left as typed; the record of what the certificates said is
 * kept beside it, with what they said before (`was`, see
 * openToCertificates). A typed value that is what the certificates say is
 * the certificates' from then on. Nothing found never clears a box.
 * @param {ParticularPerson[] | null | undefined} people
 * @param {Record<string, Particulars | null | undefined> | null | undefined} found by particularsKeyOf
 * @param {Record<string, FromCert> | null | undefined} fromCert what the certificates last put in each box
 * @returns {{ people: ParticularPerson[], fromCert: Record<string, FromCert>, changed: boolean }}
 */
export function fillParticulars(people, found, fromCert) {
  const list = Array.isArray(people) ? people : [];
  const was = fromCert && typeof fromCert === "object" ? fromCert : {};
  /** @type {Record<string, FromCert>} */
  const record = { ...was };
  let changed = false;
  const next = list.map((p) => {
    const key = particularsKeyOf(p);
    const f = key && found ? found[key] : null;
    if (!f) return p;
    let out = p;
    PARTICULAR_FIELDS.forEach((field) => {
      const value = f[field];
      if (!value) return;
      const box = typeof p[field] === "string" ? String(p[field]).trim() : "";
      const had = record[key] && typeof record[key] === "object" ? record[key] : {};
      const last = typeof had[field] === "string" ? String(had[field]) : "";
      if (!sameParticular(field, box, value) && !openToCertificates(p, field, record)) return; // typed by hand
      // Empty, or the certificates' own: the certificates' value goes in -
      // unless it is already there as typed, which is left as typed.
      if (!box || !sameParticular(field, box, value)) {
        out = { ...out, [field]: value };
        changed = true;
      }
      if (last !== value) {
        // The value it replaces is remembered, so it is never taken for
        // typed if it comes back into the box.
        const before = had.was && typeof had.was === "object" && Array.isArray(had.was[field]) ? had.was[field] : [];
        const earlier = last ? [last, ...before.filter((v) => v !== last && v !== value)].slice(0, EARLIER_KEPT) : before;
        const kept = earlier.length ? { ...(had.was || {}), [field]: earlier } : had.was;
        record[key] = { ...had, [field]: value, ...(kept ? { was: kept } : {}) };
        changed = true;
      }
    });
    return out;
  });
  return changed ? { people: next, fromCert: record, changed } : { people: list, fromCert: was, changed };
}

/**
 * A tab's save that landed on the server's: the tab's list of people, with
 * each man's two boxes taken from the server's copy wherever the tab did
 * not change them since it last loaded or saved (`base`) - so the round's
 * fill is not written over by a tab that was changing somebody's rank.
 * A box the tab did change is the tab's. A man the server's copy does not
 * have is left as the tab has him.
 * @param {ParticularPerson[] | null | undefined} base
 * @param {ParticularPerson[] | null | undefined} mine
 * @param {ParticularPerson[] | null | undefined} theirs
 */
export function mergeParticulars(base, mine, theirs) {
  /** @param {ParticularPerson[] | null | undefined} l */
  const byKey = (l) => {
    /** @type {Map<string, ParticularPerson>} */
    const m = new Map();
    (Array.isArray(l) ? l : []).forEach((p) => { const k = particularsKeyOf(p); if (k) m.set(k, p); });
    return m;
  };
  const b = byKey(base);
  const t = byKey(theirs);
  const text = (/** @type {unknown} */ v) => (v == null ? "" : String(v));
  return (Array.isArray(mine) ? mine : []).map((p) => {
    const k = particularsKeyOf(p);
    const tp = k ? t.get(k) : null;
    const bp = k ? b.get(k) : null;
    if (!tp || !bp) return p;
    let out = p;
    PARTICULAR_FIELDS.forEach((field) => {
      if (text(p[field]) !== text(bp[field])) return; // the tab's own change
      if (text(tp[field]) === text(p[field])) return;
      out = { ...out, [field]: tp[field] };
    });
    return out;
  });
}
