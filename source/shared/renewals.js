// @ts-check
/**
 * What the law wants in hand before a certificate can be renewed.
 *
 * A ticket going red is a job with a date on it. What the office finds out
 * too late is that the renewal cannot be lodged at all, because something
 * else the order asks for went first: a cook's certificate is revalidated on
 * a certificate of safety training and a medical (MO70 s 25), a deck
 * certificate on a medical and a GMDSS radio operator certificate (MO71
 * Sch 4 4.2), an engineer's and a rating's on a medical (MO72 Sch 4 4.2;
 * MO73 Sch 4), and the near-coastal masters and Engineer Class 3 on a
 * current domestic medical (MO505 s 9(3)(b)). So the two dates have to be
 * looked at together, and this is the rule that does it.
 *
 * The pairs themselves are NOT in this file. They live in the vessel file
 * (`renewalNeeds`), each with the clause it comes from written beside it, so
 * the law's mapping is data anybody can read and check against the order -
 * and the next vessel's portal is a new vessel file, not an edit to a rule.
 * A code with no entry is never blocked: MO505 s 9(3)(c) renews Master
 * <24 m NC and MED Grade 2 NC on a declaration of medical fitness, which is
 * not a document the portal holds, so those columns are left out of the
 * table on purpose. The 120 days' sea service MO505 s 9(3)(b) also wants is
 * not something the portal knows either, and is never flagged.
 *
 * Nothing here decides a colour or writes a line on a screen: the Needs
 * attention line is the page's. The page splices this file in at its @shared
 * marker, so the rule is proved on the code that ships. Edit it here and
 * only here.
 *
 * A shared file cannot import another, so the red band (RED_DAYS and
 * daysUntil in bands.js) is handed in by the caller as `rules`.
 */

/**
 * @typedef {{ needs?: string[], why?: string }} RenewalNeed
 *   One certificate's pairs: the codes the order wants in hand, and the
 *   clause that says so. A plain list of codes is read the same way, with
 *   no clause.
 * @typedef {Record<string, RenewalNeed | string[]> | null | undefined} RenewalNeeds
 *   The vessel file's table: { "<code>": { needs, why } }.
 * @typedef {{
 *   needs?: RenewalNeeds,
 *   daysUntil?: (iso: string, today: string) => number,
 *   redDays?: number,
 * }} RenewalRules
 *   The vessel file's table and the two things the red band is measured by
 *   (bands.js), handed in by the caller.
 * @typedef {{ person: string, code: string, needs: string[], expired: string[],
 *   missing: string[], why: string }} RenewalBlocker
 *   One certificate that cannot be renewed: whose, which, what is in the way
 *   (`needs`, and the same codes split into the ones that have run out and
 *   the ones that are not held, so the line can say which), and the clause.
 */

/** A matrix cell as text, trimmed. */
const renewalCell = (/** @type {unknown} */ v) => String(v == null ? "" : v).trim();

/** The expiry date in a cell, or "" where the cell is not a date. */
const renewalDate = (/** @type {unknown} */ v) => {
  const t = renewalCell(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : "";
};

/** One person's cell for a code, whether the caller keeps them in an object
 *  or a Map, and however the code was cased.
 * @param {Map<string, unknown> | Record<string, unknown> | null | undefined} held
 * @param {string} code
 */
function renewalHeld(held, code) {
  if (!held) return "";
  const want = String(code).trim().toUpperCase();
  if (held instanceof Map) {
    for (const [k, v] of held) if (String(k).trim().toUpperCase() === want) return renewalCell(v);
    return "";
  }
  const key = Object.keys(held).find((k) => String(k).trim().toUpperCase() === want);
  return key === undefined ? "" : renewalCell(held[key]);
}

/** The codes one entry of the table asks for, and the clause it comes from.
 * @param {RenewalNeed | string[] | undefined} entry
 */
function renewalEntry(entry) {
  const list = Array.isArray(entry) ? entry : entry && Array.isArray(entry.needs) ? entry.needs : [];
  const why = !Array.isArray(entry) && entry && typeof entry.why === "string" ? entry.why : "";
  return { needs: list.map((c) => String(c).trim().toUpperCase()).filter((c) => !!c), why };
}

/**
 * Whether a vessel file's `renewalNeeds` table will do, in one sentence
 * naming the first entry that will not - or null when it is sound.
 *
 * A code that is not a column would be a blocker nobody could see and a
 * renewal quietly never flagged, so both `checkVessel`s ask this as the file
 * loads rather than letting it through to the screen.
 * @param {unknown} table the vessel file's renewalNeeds
 * @param {unknown} columnCodes the vessel file's qualColumns codes
 * @returns {string | null}
 */
export function renewalNeedsProblem(table, columnCodes) {
  if (table === undefined || table === null) return null;   // a vessel may have no table
  if (typeof table !== "object" || Array.isArray(table)) return "renewalNeeds must be an object of code: { needs, why }.";
  const columns = (Array.isArray(columnCodes) ? columnCodes : []).map((c) => String(c).trim().toUpperCase());
  const rows = /** @type {Record<string, RenewalNeed | string[]>} */ (table);
  for (const code of Object.keys(rows)) {
    const at = 'renewalNeeds["' + code + '"]';
    if (!columns.includes(String(code).trim().toUpperCase())) return at + " is not one of the vessel's columns.";
    const { needs, why } = renewalEntry(rows[code]);
    if (!needs.length) return at + " must name at least one code the law wants in hand before it can be renewed.";
    if (!why) return at + ' must say which clause the pair comes from, in its "why".';
    for (const need of needs) {
      if (!columns.includes(need)) return at + " wants " + need + ", which is not one of the vessel's columns.";
      if (need === String(code).trim().toUpperCase()) return at + " wants itself.";
    }
  }
  return null;
}

/**
 * One man's certificates that have expired or are in the red band and cannot
 * be renewed, because something the order wants in hand has itself expired or
 * is not held.
 *
 * Only a certificate he actually holds with a date on it: one he has never
 * held is a gap and is on the gaps list already, and an item the matrix marks
 * held ("Y") carries no date to renew. The red band is the one the whole
 * portal uses (RED_DAYS in bands.js, expired included), so this list is
 * exactly the renewals the office is working on now.
 *
 * A required item counts as held while its own date has not been reached
 * (MO70 s 5(a)(iii) - the expiry day itself is the day it stops counting) or
 * the matrix marks it held. A blank, an "N", an "OPEN" or a question mark is
 * not held: nobody has said it is.
 * @param {string} person the register's name for him, for the line that says it
 * @param {Map<string, unknown> | Record<string, unknown> | null | undefined} held
 *   his row of the matrix, by column code
 * @param {string} todayISO YYYY-MM-DD
 * @param {RenewalRules} rules
 * @returns {RenewalBlocker[]}
 */
export function renewalBlockers(person, held, todayISO, rules) {
  const table = rules && rules.needs;
  const daysUntil = rules && rules.daysUntil;
  const redDays = rules && typeof rules.redDays === "number" ? rules.redDays : 0;
  if (!table || typeof table !== "object" || typeof daysUntil !== "function") return [];
  const today = String(todayISO || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return [];

  /** Whether what is in a cell is in hand today. */
  const inHand = (/** @type {string} */ code) => {
    const cell = renewalHeld(held, code);
    if (!cell) return false;
    const date = renewalDate(cell);
    if (date) return daysUntil(date, today) > 0;
    return cell.toUpperCase() === "Y";
  };

  /** @type {RenewalBlocker[]} */
  const out = [];
  Object.keys(table).forEach((code) => {
    const mine = renewalDate(renewalHeld(held, code));
    if (!mine) return;                                  // not held, or held with no date
    if (daysUntil(mine, today) > redDays) return;        // not up for renewal yet
    const { needs, why } = renewalEntry(/** @type {Record<string, RenewalNeed | string[]>} */ (table)[code]);
    const wanting = needs.filter((need) => !inHand(need));
    if (!wanting.length) return;
    out.push({
      person: String(person || ""),
      code: String(code).trim().toUpperCase(),
      needs: wanting,
      expired: wanting.filter((need) => !!renewalDate(renewalHeld(held, need))),
      missing: wanting.filter((need) => !renewalDate(renewalHeld(held, need))),
      why,
    });
  });
  return out.sort((a, b) => a.code.localeCompare(b.code));
}
