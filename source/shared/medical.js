// @ts-check
/**
 * The medical, as the law dates it.
 *
 * Two rules from Marine Order 76, and nothing else:
 *
 *  - A medical expires the moment a further one is issued (MO76 s 16(3)). So
 *    of two on file the one ISSUED last governs, even where the older one
 *    prints the later expiry: a shorter certificate signed after an injury
 *    wins, and taking the later date would put a man to sea on a
 *    certificate that has gone.
 *
 *  - A medical runs at most two years from the examination, and at most one
 *    year where the person was 18 or younger, or 55 or older, on the day of
 *    it (MO76 s 16(1) and Note). The Note's edges are "not more than 18" and
 *    "at least 55", so exactly 18 and exactly 55 are in the one-year band -
 *    the office's own guide reads "under 18/over 55" and is wrong by a year
 *    each way. The portal takes the printed date either way; this only says
 *    when the printed date is longer than the law allows, which is a
 *    question for AMSA and not something the portal corrects.
 *
 * What these rules will not do is guess. No date of birth, no age, and so no
 * flag: a printed expiry the portal cannot check is left alone.
 *
 * Nothing here decides a colour or writes a line on a screen - the cell's
 * date and the Needs attention line are the page's and the round's. The page
 * splices this file in at its @shared marker, so the rules are proved on the
 * code that ships. Edit them here and only here.
 *
 * A shared file cannot import another, so the register (crewRegister in
 * names.js) and the medical's own column (the vessel file's certStated,
 * through medicalCodesIn) are handed in by the caller.
 */

/**
 * @typedef {{ id?: unknown, key?: unknown, person?: string | null, code?: string | null,
 *   filedOn?: string | null }} MedicalRow
 *   One certificate on the books: the row's own id (the page's), the key of
 *   its reading, the name it is filed under, the matrix code it answers to
 *   and when it was filed. Handed in as the library's listing hands them
 *   over - the newest upload first - so of two alike in every date, the one
 *   earlier in the list is the one uploaded last.
 * @typedef {{ readable?: boolean, holderName?: string | null, issuedOn?: string | null,
 *   assessedOn?: string | null, expiresOn?: string | null, conditions?: string | null }} MedicalReading
 * @typedef {{ nameOf: (spelling: unknown) => string | null }} Register
 * @typedef {{ rowId: string, issuedOn: string | null, assessedOn: string | null,
 *   expiresOn: string | null, conditions: string | null }} Medical
 *   One medical as the portal holds it: which row it is, the dates it
 *   prints, and any limitation printed on it.
 */

/** The age at or below which a medical runs a year, not two (MO76 s 16(1)
 *  Note: "not more than 18", so 18 itself is in the one-year band). */
export const MEDICAL_YOUNG = 18;

/** The age at or above which a medical runs a year, not two (MO76 s 16(1)
 *  Note: "at least 55", so 55 itself is in the one-year band). */
export const MEDICAL_OLD = 55;

/** The longest a medical may run, in years, and the shorter term at the two
 *  edges of age (MO76 s 16(1)). */
export const MEDICAL_YEARS = 2;
export const MEDICAL_YEARS_AT_THE_EDGES = 1;

/** The column the medical is filed under, from the vessel file's certStated -
 *  the items whose expiry is printed on the certificate and only there. The
 *  medical is the one on this vessel; a file listing more would have them
 *  all, which is why this hands back a list and not a code.
 * @param {unknown} certStated the vessel file's certStated: { code: what it says }
 * @returns {string[]}
 */
export function medicalCodesIn(certStated) {
  if (!certStated || typeof certStated !== "object") return [];
  return Object.keys(certStated).map((c) => String(c).trim().toUpperCase()).filter((c) => !!c);
}

/** Whether a YYYY-MM-DD string is a day that exists. A date somebody typed
 *  words into, or a 31st of February, says nothing at all.
 * @param {unknown} v
 */
function medicalDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || "").slice(0, 10));
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const same = d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1
    && d.getUTCDate() === Number(m[3]);
  return same ? m[0] : "";
}

/** A date as text, or "" where there is none to read. */
const medicalText = (/** @type {unknown} */ v) => (typeof v === "string" ? v.slice(0, 10) : "");

/**
 * The medicals on file for one man, newest ISSUED first (MO76 s 16(3), so
 * the first of the list is the one that governs).
 *
 * Only certificates filed under him through the register, in one of the
 * medical's columns, that were read. A reading printed in another man's name
 * is not his, whatever folder it is in; a reading that names nobody is taken
 * as his, because the folder is what already puts its date on his cell and
 * this rule must not disagree with the cell.
 *
 * Two issued the same day are ranked as the round ranks two cards: filed
 * later first, then uploaded later first.
 * @param {string} person the register's name for him
 * @param {MedicalRow[] | null | undefined} rows
 * @param {Map<string, MedicalReading> | Record<string, MedicalReading> | null | undefined} readings by key
 * @param {Register} register
 * @param {string[]} medicalCodes the medical's column(s) - medicalCodesIn
 * @returns {Medical[]}
 */
export function medicalOnFile(person, rows, readings, register, medicalCodes) {
  const me = register.nameOf(person) || person;
  const want = (Array.isArray(medicalCodes) ? medicalCodes : []).map((c) => String(c).trim().toUpperCase());
  if (!want.length) return [];
  /** @param {string} k */
  const readingOf = (k) =>
    (readings instanceof Map ? readings.get(k) : readings ? readings[k] : null) || null;

  // Each certificate once: the same scan filed twice is one medical, not two.
  const seen = new Set();
  /** @type {{ m: Medical, issued: string, filed: string, at: number }[]} */
  const mine = [];
  (Array.isArray(rows) ? rows : []).forEach((row, at) => {
    const key = row && row.key != null ? String(row.key) : "";
    if (!key || seen.has(key)) return;
    if (!row.person || register.nameOf(row.person) !== me) return;
    if (!want.includes(String(row.code || "").trim().toUpperCase())) return;
    const reading = readingOf(key);
    if (!reading || reading.readable === false) return;
    // Printed in somebody else's name: his folder, not his medical.
    if (reading.holderName && register.nameOf(reading.holderName) !== me) return;
    seen.add(key);
    const conditions = String(reading.conditions == null ? "" : reading.conditions).trim();
    mine.push({
      m: {
        rowId: row.id != null && String(row.id) !== "" ? String(row.id) : key,
        issuedOn: medicalDay(reading.issuedOn) || null,
        assessedOn: medicalDay(reading.assessedOn) || null,
        expiresOn: medicalDay(reading.expiresOn) || null,
        conditions: conditions || null,
      },
      issued: medicalText(reading.issuedOn),
      filed: medicalText(row.filedOn),
      at,
    });
  });

  return mine
    .sort((a, b) => b.issued.localeCompare(a.issued) || b.filed.localeCompare(a.filed) || a.at - b.at)
    .map((x) => x.m);
}

/** The same day `years` years on, with a 29 February rolling forward to the
 *  1st - so the longer reading of the term is taken and a lawful expiry is
 *  never flagged over a leap day.
 * @param {string} iso YYYY-MM-DD
 * @param {number} years
 */
function medicalYearsOn(iso, years) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

/** Somebody's age in whole years on a day, both dates YYYY-MM-DD.
 * @param {string} dob
 * @param {string} on
 */
function medicalAgeOn(dob, on) {
  const years = Number(on.slice(0, 4)) - Number(dob.slice(0, 4));
  // Before the birthday comes round in that year he is a year younger.
  return on.slice(5) < dob.slice(5) ? years - 1 : years;
}

/**
 * Whether the expiry printed on a medical is longer than MO76 s 16(1)
 * allows for the holder's age on the day of the examination - and if it is,
 * the problem in one plain sentence.
 *
 * Measured from the assessment where the document prints one, and from the
 * issue where it does not: the order dates the term from the examination,
 * and the issue is the closest the portal has to it. Null wherever there is
 * nothing to hold the printed date against - no expiry, no date to measure
 * from, or no date of birth - because the alternative is guessing at a man's
 * age. Null too where the medical has already run out: that is on the gaps
 * list already and nobody can shorten a date that has gone.
 * @param {Medical | null | undefined} medical
 * @param {unknown} dob the holder's date of birth, YYYY-MM-DD (Crew Details)
 * @param {string} todayISO YYYY-MM-DD
 * @returns {string | null}
 */
export function medicalTooLong(medical, dob, todayISO) {
  if (!medical) return null;
  const expires = medicalDay(medical.expiresOn);
  const assessed = medicalDay(medical.assessedOn);
  const from = assessed || medicalDay(medical.issuedOn);
  const born = medicalDay(dob);
  const today = medicalDay(todayISO);
  if (!expires || !from || !born) return null;
  if (today && expires <= today) return null;

  const age = medicalAgeOn(born, from);
  const atTheEdges = age <= MEDICAL_YOUNG || age >= MEDICAL_OLD;
  const years = atTheEdges ? MEDICAL_YEARS_AT_THE_EDGES : MEDICAL_YEARS;
  if (expires <= medicalYearsOn(from, years)) return null;

  const how = years === 1 ? "a year" : "two years";
  const measured = assessed ? "the assessment" : "it was issued";
  const why = !atTheEdges ? ""
    : age >= MEDICAL_OLD ? ", and the holder was " + MEDICAL_OLD + " or older that day"
      : ", and the holder was " + MEDICAL_YOUNG + " or younger that day";
  return "the expiry is more than " + how + " after " + measured + why;
}

/** The limitation printed on a medical, as printed, or null where it prints
 *  none ("fit for particular duties only", "must wear corrective lenses").
 *  A certificate must show fitness for the duties actually performed (MO76
 *  s 7(1)(b)), and where it records an aid to vision or hearing the holder
 *  must use it and carry a spare (s 9(1)) - so the words matter and are
 *  never summarised.
 * @param {Medical | null | undefined} medical
 * @returns {string | null}
 */
export function medicalNote(medical) {
  const said = String((medical && medical.conditions) || "").trim();
  return said || null;
}
