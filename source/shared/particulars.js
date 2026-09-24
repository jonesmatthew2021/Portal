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
 *    whatever folder it was filed in;
 *  - guess a date of birth where his certificates disagree;
 *  - write over a box somebody typed. A box still holding exactly what the
 *    certificates last put there is the certificates' to change (a new card
 *    brings a new number); anything else in it was typed, and stays.
 *
 * A shared file cannot import another, so the register (crewRegister in
 * names.js) is handed in by the caller.
 */

/**
 * @typedef {{ person?: string | null, code?: string | null, key: string, filedOn?: string | null }} ParticularRow
 *   One certificate on the books: the name it is filed under, the matrix
 *   code it answers to (as the round works it out), the key of its reading,
 *   and when it was filed.
 * @typedef {{ readable?: boolean, holderName?: string | null, issuedOn?: string | null,
 *   expiresOn?: string | null, documentNumber?: string | null, holderBirthDate?: string | null }} ParticularReading
 * @typedef {{ nameOf: (spelling: unknown) => string | null }} Register
 * @typedef {{ msic: string | null, dob: string | null }} Particulars
 * @typedef {{ id?: unknown, name?: string, msic?: unknown, dob?: unknown }} ParticularPerson
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
 * and whose printed holder - where the reading has one - is him through the
 * register too.
 *  - MSIC: off his MSIC cards whose reading has a number: the one that runs
 *    out last, then the one issued last, then the one filed last.
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
    // Filed under him but printed in another man's name: his folder, not his card.
    if (reading.holderName && register.nameOf(reading.holderName) !== me) return;
    seen.add(row.key);
    mine.push({ row, reading, at });
  });

  /** @type {string | null} */
  let msic = null;
  const want = msicCode ? String(msicCode).trim().toUpperCase() : "";
  if (want) {
    const text = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");
    const cards = mine
      .filter((x) => String(x.row.code || "").trim().toUpperCase() === want && msicAsWritten(x.reading.documentNumber))
      .sort((a, b) =>
        text(b.reading.expiresOn).localeCompare(text(a.reading.expiresOn))
        || text(b.reading.issuedOn).localeCompare(text(a.reading.issuedOn))
        || text(b.row.filedOn).localeCompare(text(a.row.filedOn))
        || b.at - a.at);
    if (cards.length) msic = msicAsWritten(cards[0].reading.documentNumber);
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

/** Whether a man's box is the certificates' to fill: empty, or still
 *  holding exactly what they last put there. Anything else was typed. The
 *  hour asks this before it pays to read a certificate again for it.
 * @param {ParticularPerson} p
 * @param {"msic" | "dob"} field
 * @param {Record<string, Partial<Particulars>> | null | undefined} fromCert
 */
export function openToCertificates(p, field, fromCert) {
  const box = p && typeof p[field] === "string" ? String(p[field]).trim() : "";
  if (!box) return true;
  const key = particularsKeyOf(p);
  const had = key && fromCert && typeof fromCert === "object" ? fromCert[key] : null;
  const last = had && typeof had === "object" && typeof had[field] === "string" ? had[field] : "";
  return !!last && sameParticular(field, box, last);
}

/**
 * The boxes on Crew Details, filled from what the certificates found.
 *
 * A box is filled when it is empty, or when it still holds exactly what the
 * certificates put there last time (`fromCert`) - so a renewed card's
 * number takes the old card's place. Anything else in a box was typed by
 * hand and is left as typed; the record of what the certificates said is
 * kept beside it. A typed value that is what the certificates say is the
 * certificates' from then on. Nothing found never clears a box.
 * @param {ParticularPerson[] | null | undefined} people
 * @param {Record<string, Particulars | null | undefined> | null | undefined} found by particularsKeyOf
 * @param {Record<string, Partial<Particulars>> | null | undefined} fromCert what the certificates last put in each box
 * @returns {{ people: ParticularPerson[], fromCert: Record<string, Partial<Particulars>>, changed: boolean }}
 */
export function fillParticulars(people, found, fromCert) {
  const list = Array.isArray(people) ? people : [];
  const was = fromCert && typeof fromCert === "object" ? fromCert : {};
  /** @type {Record<string, Partial<Particulars>>} */
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
        record[key] = { ...had, [field]: value };
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
