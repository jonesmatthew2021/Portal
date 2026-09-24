// @ts-check
/**
 * One certificate fills every matrix column it covers.
 *
 * Matthew, 25 Sep 2026, looking at a new-style AMSA Master certificate of
 * competency: "Some certificates contain multiple certificates on it ... it
 * also contains ECDIS, can contain other certificates such as fast rescue
 * craft." One document, more than one column - and until now one document
 * gave one column, so a man's ECDIS cell was empty unless somebody filed the
 * same certificate a second time and tagged it by hand.
 *
 * Two ways a certificate covers another column:
 *  - an endorsement printed on it (the reading's `endorsements`). Which
 *    endorsement fills which column is the vessel file's `covers` table -
 *    a fixed table, never the model's guess. The model only lists what is
 *    printed.
 *  - a training unit code printed on it (the reading's `units`). A unit code
 *    that appears in a column's title fills that column: one first-aid
 *    statement of attainment that lists HLTAID011 and HLTAID015 fills both
 *    of those columns. That needs no table - the column titles carry the
 *    codes already.
 *
 * What the law says about the two, and why the dates come out as they do:
 *  - An endorsement is a line on a certificate, not a document of its own
 *    (MO70 s 4 "functions endorsement", s 8). It can only be put on a
 *    certificate that is in force (s 36(2)(a)), and nothing in the orders
 *    says it outlives the certificate it is printed on - so a covered
 *    column runs no longer than the certificate's own printed expiry.
 *  - ECDIS is perpetual (MO70 s 37(3) table item 8), so its column takes the
 *    certificate's own date and nothing else. The office's "5 years" for
 *    ECDIS is wrong by law and lapses men whose ECDIS has not lapsed.
 *  - The fast rescue boat endorsement runs five years from the day the
 *    proficiency was issued (MO70 s 37(3) item 2, s 37(5)), which is not the
 *    day it was written onto the certificate: so where AMSA printed the
 *    endorsement its own end date, that date governs.
 *  - GMDSS is never read off a certificate of competency. It is a
 *    certificate class of its own with its own term and its own revalidation
 *    (MO70 s 7(1)(ca), s 15(1)(b), s 21B, s 25A); no rule makes it an
 *    endorsement, so "IV/2" printed on a ticket fills nothing. QL-14 is
 *    filled by a GMDSS document, or by an AMSA certificate of recognition of
 *    one.
 *  - The Certificate of Safety Training is never filled by an endorsement.
 *    It is a certificate class of its own (MO70 s 7(1)(e), s 22) that cannot
 *    be endorsed onto another document (s 34(1)) and cannot be recognised
 *    from a foreign certificate (s 7(2)(b)). The VI/1, VI/2, VI/3 and VI/4
 *    lines inside a certificate of competency are a course, not a
 *    certificate. Matthew, 25 Sep 2026: "COST is only for small state
 *    certification. International certificates are certificates of
 *    competency."
 *
 * The rules here are pure: they read a reading and the table and say which
 * columns are covered and to what date. Whose certificate it is, which of
 * two certificates for one column wins, and what a figure somebody typed
 * does are the round's (worker/src/lib/round.ts, the settling in
 * source/shared/matrix-rules.js) - a covered column joins that same contest
 * on the same terms as the certificate's own column.
 *
 * A shared file cannot import another, so the columns and the table are
 * handed in by the caller.
 */

/**
 * @typedef {{ readable?: boolean, expiresOn?: string | null, qualCode?: string | null,
 *   endorsements?: { text?: string | null, until?: string | null }[] | unknown,
 *   units?: string[] | unknown }} CoversReading
 * @typedef {{ code: string, when: string, unless?: string, perpetual?: boolean, why?: string }} CoverRule
 *   One row of the vessel file's `covers` table: the column a printed
 *   endorsement fills, the pattern that recognises it (read without regard
 *   to case), an optional pattern that stops the row on a line that names
 *   the endorsement only to exclude it, and whether the endorsement never
 *   expires - in which case the column takes the certificate's own date
 *   whatever the document prints against the endorsement itself.
 * @typedef {{ code: string, until: string | null }} CoveredCell
 */

/** A training unit code as this rule recognises one: letters and digits
 *  together, six characters or more - "HLTAID011", "SITXFSA005",
 *  "RIIWHS202E". A plain word answered as a unit would otherwise claim
 *  every column whose title happens to carry it. */
const UNIT_CODE = /^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{6,}$/;

/** A date as the matrix holds it, or null.
 * @param {unknown} v
 * @returns {string | null}
 */
function day(v) {
  const s = typeof v === "string" ? v.trim().slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** A code as the matrix matches codes: trimmed, capitals.
 * @param {unknown} v
 */
function asCode(v) {
  return String(v == null ? "" : v).trim().toUpperCase();
}

/** Whether `unit` is printed in `title` as a whole word - so "HLTAID01" is
 *  not "HLTAID011" and never fills its column.
 * @param {string} unit
 * @param {string} title
 */
function titleCarries(unit, title) {
  const escaped = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp("\\b" + escaped + "\\b", "i").test(title);
  } catch (e) {
    return false;
  }
}

/** The unit codes printed on a document, as the rule will read them: only
 *  what looks like a unit code, each one once.
 * @param {unknown} units
 * @returns {string[]}
 */
export function unitCodesIn(units) {
  /** @type {string[]} */
  const out = [];
  (Array.isArray(units) ? units : []).forEach((u) => {
    const unit = String(u == null ? "" : u).trim();
    if (!UNIT_CODE.test(unit)) return;
    if (!out.some((seen) => seen.toUpperCase() === unit.toUpperCase())) out.push(unit);
  });
  return out;
}

/** The columns whose titles carry a training unit code - the training
 *  statements' columns (first aid, resuscitation, food safety, confined
 *  spaces, working at heights on this vessel). Read off the titles, so a
 *  vessel that adds a column with a unit code in its title needs no list
 *  written anywhere.
 * @param {unknown} columns the vessel file's qualColumns: [code, title, group][]
 * @returns {string[]} the codes, as the matrix matches them
 */
export function unitColumnsIn(columns) {
  /** @type {string[]} */
  const out = [];
  (Array.isArray(columns) ? columns : []).forEach((c) => {
    if (!Array.isArray(c)) return;
    const words = String(c[1] || "").split(/[^A-Za-z0-9]+/);
    if (words.some((w) => UNIT_CODE.test(w))) out.push(asCode(c[0]));
  });
  return out;
}

/**
 * The columns one certificate covers besides its own, and the date each
 * takes.
 *
 * `until` is the date the covered column takes: the endorsement's own
 * printed end date where the document prints one and the endorsement is not
 * perpetual, otherwise the certificate's own expiry. Null where neither is
 * printed - the caller then has no date to put in the cell, and a
 * certificate that says it never expires says that about its own column
 * only.
 *
 * Nothing is covered where the certificate could not be read, where the
 * reading was made before the endorsements were asked for (no key at all),
 * or where the table names a column this matrix does not have.
 *
 * @param {CoversReading | null | undefined} reading
 * @param {CoverRule[] | null | undefined} covers the vessel file's table
 * @param {unknown} columns the matrix's columns: [code, title, group][]
 * @param {string | null} [ownCode] the column this certificate fills itself,
 *   as the round works it out (a hand tag beats the equivalence sheet beats
 *   the model); left out, the reading's own code. Never covered again.
 * @returns {CoveredCell[]}
 */
export function coveredCells(reading, covers, columns, ownCode) {
  if (!reading || reading.readable === false) return [];
  const own = asCode(ownCode === undefined || ownCode === null ? reading.qualCode : ownCode);
  const cols = (Array.isArray(columns) ? columns : []).filter((c) => Array.isArray(c));
  const has = new Set(cols.map((c) => asCode(c[0])));
  const certUntil = day(reading.expiresOn);
  /** @type {Map<string, string | null>} */
  const found = new Map();
  /** The shorter of two terms governs: an endorsement is a line on a
   *  document, and two lines that both reach one column cannot make it run
   *  longer than the earlier of them says.
   * @param {string} code
   * @param {string | null} until
   */
  const keep = (code, until) => {
    if (!code || code === own || !has.has(code)) return;
    if (!found.has(code)) { found.set(code, until); return; }
    const held = found.get(code) || null;
    if (until === null || held === null) { found.set(code, null); return; }
    if (until < held) found.set(code, until);
  };

  const printed = Array.isArray(reading.endorsements) ? reading.endorsements : [];
  (Array.isArray(covers) ? covers : []).forEach((rule) => {
    if (!rule || typeof rule !== "object") return;
    const code = asCode(rule.code);
    let when;
    /* The row's exclusion. AMSA prints the survival craft endorsement as
       "proficiency in survival craft and rescue boats other than fast rescue
       boats" (STCW A-VI/2-1; MO70 s 37(3) item 1): the words "fast rescue
       boats" are on the face of a certificate whose point is that the man
       is NOT fast-rescue-boat qualified. A line the exclusion matches fills
       nothing, whatever else it says - the exclusion wins. */
    let notWhen = null;
    try {
      when = new RegExp(String(rule.when), "i");
      if (rule.unless !== undefined) notWhen = new RegExp(String(rule.unless), "i");
    } catch (e) {
      return;        // a pattern that does not compile covers nothing
    }
    printed.forEach((e) => {
      const text = e && typeof e === "object" ? String(e.text == null ? "" : e.text) : String(e == null ? "" : e);
      if (!text || !when.test(text)) return;
      if (notWhen && notWhen.test(text)) return;
      const ownDate = e && typeof e === "object" ? day(e.until) : null;
      /* The earlier of the two dates, never the endorsement's on its own.
         An endorsement exists only as a line on a certificate that is in
         force (MO70 s 36(2)(a)) - so a fast rescue boat endorsement printed
         to 2031 on a ticket that expires in 2028 carries the column to 2028
         and no further, and a ticket that outlives the endorsement carries
         it only to the endorsement's own printed end. Where AMSA printed no
         end against the endorsement the certificate's own date is all there
         is. A perpetual endorsement (ECDIS) always takes the certificate's:
         it does not expire of itself (s 37(3) item 8). */
      const until = rule.perpetual === true
        ? certUntil
        : ownDate && certUntil
          ? (ownDate < certUntil ? ownDate : certUntil)
          : ownDate || certUntil;
      keep(code, until);
    });
  });

  // A unit code printed on the document fills every column whose title
  // carries it, with the document's own expiry: a statement of attainment
  // covers each unit it lists for as long as the statement itself runs.
  unitCodesIn(reading.units).forEach((unit) => {
    cols.forEach((c) => { if (titleCarries(unit, String(c[1] || ""))) keep(asCode(c[0]), certUntil); });
  });

  return [...found.entries()].map(([code, until]) => ({ code, until }));
}

/** The codes one certificate covers besides its own - the cells without
 *  their dates, for a caller that only needs to know which columns are
 *  touched.
 * @param {CoversReading | null | undefined} reading
 * @param {CoverRule[] | null | undefined} covers
 * @param {unknown} columns
 * @param {string | null} [ownCode]
 * @returns {string[]}
 */
export function coveredCodes(reading, covers, columns, ownCode) {
  return coveredCells(reading, covers, columns, ownCode).map((c) => c.code);
}
