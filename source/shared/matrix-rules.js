// @ts-check
/**
 * The matrix rules the page and the worker both run: how an expiry rule is
 * read off the office's skills matrix, how the certificates' answer is laid
 * over the crew matrix, and which filled-in cells a round takes back. The
 * page splices this file in at its @shared marker; the worker imports it.
 * Edit it here and only here.
 */

/**
 * @typedef {[string, string, string, string[]]} MatrixRow
 *   A crew matrix row: name, position, SAM number, then one value per column.
 * @typedef {{ cols: string[][], rows: MatrixRow[] }} Quals
 * @typedef {{ person: string, code: string, value?: string, clear?: boolean }} Settled
 *   One cell the certificates settle: a date to write, or clear:true to take
 *   the date back.
 * @typedef {{ code: string, title: string, category: string, by: string, said: string,
 *   months?: number, never?: boolean, own?: boolean, alsoRuns?: number,
 *   shorterTaken?: boolean, alsoSays?: number[] }} ExpiryRule
 */

/**
 * An expiry rule as the office writes it, turned into something to count with.
 *
 * "5 years" is a period. "No Expiry" means it never lapses - a certificate on
 * file is the whole answer. The medical's rule is a paragraph about the
 * practitioner's judgement rather than a period, and the certificate prints its
 * own date anyway, so it is marked as stating its own and never calculated.
 *
 * "2 years or 4 years" is the MSIC, which runs either way depending on the
 * card. The shorter is taken and the office's words kept beside it: telling a
 * crew member their card lasts four years when it lasts two would put them
 * ashore at a gate, and the other way round only costs a renewal reminder.
 * @param {unknown} said
 */
export function expiryRule(said) {
  const text = String(said || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const low = text.toLowerCase();

  if (/^no\s+expiry/.test(low)) return { never: true, said: text };
  // A rule written as prose about somebody's judgement is not a period.
  if (/determined by|practitioner|as required|case by case/.test(low)) {
    return { own: true, said: text };
  }

  const found = [...low.matchAll(/(\d+)\s*(year|month)s?/g)]
    .map((m) => Number(m[1]) * (m[2] === "year" ? 12 : 1))
    .filter((n) => n > 0);
  if (!found.length) return { said: text };

  /* Two figures can mean two different things.
   *
   * "2 years or 4 years" is the MSIC, which runs either way depending on the
   * card: two alternatives, and the shorter is taken, because telling somebody
   * their card lasts four years when it lasts two puts them ashore at a gate
   * while the other way round costs a renewal reminder.
   *
   * "2 years from last completed or if not onboard for a period of greater
   * than 6 months" is not two periods at all. It is a period and a condition
   * about time away from the vessel, and reading the six months as the rule
   * would have told all forty-one crew their vessel induction lapses twice a
   * swing. Where the sentence carries on past the figures, the first one is
   * the rule and the rest is circumstance.
   */
  const bareAlternatives = /^\s*\d+\s*(?:year|month)s?\s+or\s+\d+\s*(?:year|month)s?\s*$/.test(low);
  const months = bareAlternatives ? Math.min(...found) : found[0];
  const other = found.filter((n) => n !== months);
  return {
    months,
    said: text,
    ...(bareAlternatives && other.length ? { alsoRuns: Math.max(...other), shorterTaken: true } : null),
    ...(!bareAlternatives && other.length ? { alsoSays: other } : null),
  };
}

/**
 * The Guidance Information sheet, read as the rule book it is: one row per
 * position per item, carrying the item's code, its name, the category it sits
 * under, when it has to be held by, and how long it lasts.
 *
 * The same item appears once for every position that needs it, with the same
 * rule each time, so the first sighting of a code is kept and the rest are
 * passed over.
 *
 * `rows` is the sheet as a grid of text, one array per row with a blank for
 * an empty cell. The page gets that from SheetJS and the worker from
 * readSheetRows; the finding of the sheet is theirs, the reading is here.
 * @param {string[][]} rows
 */
export function readExpiryRules(rows) {
  // The header row is the one naming the columns this reads.
  const wanted = ["certification id", "expiry"];
  let at = -1;
  rows.slice(0, 30).forEach((r, i) => {
    const heads = r.map((c) => String(c).replace(/\s+/g, " ").trim().toLowerCase());
    if (at < 0 && wanted.every((w) => heads.includes(w))) at = i;
  });
  if (at < 0) return [];

  const head = rows[at].map((c) => String(c).replace(/\s+/g, " ").trim().toLowerCase());
  /**
   * @param {string} want
   */
  const col = (want) => head.indexOf(want);
  const idAt = col("certification id");
  const expAt = col("expiry");
  const nameAt = col("name");
  const catAt = col("category");
  const whenAt = col("timeframe");

  /** @type {ExpiryRule[]} */
  const out = [];
  const seen = new Set();
  rows.slice(at + 1).forEach((r) => {
    const code = String(r[idAt] || "").replace(/\s+/g, " ").trim().toUpperCase();
    if (!/^[A-Z]{2,4}-\d+/.test(code) || seen.has(code)) return;
    const rule = expiryRule(r[expAt]);
    if (!rule) return;
    seen.add(code);
    out.push({
      code,
      title: nameAt >= 0 ? String(r[nameAt] || "").replace(/\s+/g, " ").trim() : "",
      category: catAt >= 0 ? String(r[catAt] || "").replace(/\s+/g, " ").trim() : "",
      by: whenAt >= 0 ? String(r[whenAt] || "").replace(/\s+/g, " ").trim() : "",
      ...rule,
    });
  });
  return out;
}

/**
 * The certificates' answer, laid over the crew matrix. The only place it is
 * done.
 *
 * There were three: the automatic run after an upload, Update matrix (then
 * called Generate latest training matrix), and Update the spreadsheet. Each read the same certificates
 * and then picked its own list out of the answer - two filtered the analysis's
 * items on slightly different conditions, the third used the server's settled
 * list - so the three could write different dates from the same evidence, and
 * only the third had ever heard of taking a date back off. Which one you had
 * pressed last decided what the matrix said.
 *
 * They all hand their work here now. `settled` is the server's own list, the
 * one thing that knows both what a certificate proves and what it no longer
 * proves, and the three buttons keep only their real differences: whether the
 * office's spreadsheet is left alone, built fresh, or written into in place.
 *
 * Back comes the matrix as it should now read, what actually moved (for the
 * screen and the log), and which cells the certificates spoke for at all -
 * which is wider than what moved, because the workbook may be missing a date
 * the matrix already has.
 *
 * `nameOf` is how a name is read before it is compared: the crew register's
 * nameOf, where there is one, so a settled date for "SITTIYOS, Kachin" lands
 * on the row the spreadsheet still calls "bILLY". The row keeps its name as
 * written. Left out, names are compared as they are.
 * @param {Quals} quals
 * @param {Settled[] | null | undefined} settled
 * @param {(name: string) => string} [nameOf]
 */
export function applySettled(quals, settled, nameOf = (n) => n) {
  const rows = (quals.rows || []).map((r) => /** @type {MatrixRow} */ ([r[0], r[1], r[2], (r[3] || []).slice()]));
  const rowAt = new Map(rows.map((r, i) => [String(nameOf(r[0])).trim().toUpperCase(), i]));
  const cols = quals.cols || [];
  const colAt = new Map(cols.map((c, i) => [c[0], i]));

  /** @type {{ person: string, code: string, title: string, from: string, to: string }[]} */
  const applied = [];
  const only = new Set();

  (settled || []).forEach((s) => {
    const r = rowAt.get(String(nameOf(s.person || "")).trim().toUpperCase());
    const c = colAt.get(s.code);
    if (r === undefined || c === undefined) return;

    const before = rows[r][3][c] == null ? "" : String(rows[r][3][c]);
    const key = String(s.person).trim().toUpperCase() + "|" + s.code;
    /** @param {string} to */
    const moved = (to) => applied.push({
      person: rows[r][0], code: s.code, title: (cols[c] || [])[1] || "", from: before, to,
    });

    /* A cell taken back: the certificate behind it has gone from the library,
       or it answers to another column now, so the date it left comes off the
       matrix and out of the workbook alike. */
    if (s.clear) {
      if (before.trim() !== "") {
        rows[r][3][c] = "";
        moved("");
        only.add(key);
      }
      return;
    }

    if (!s.value) return;
    if (before.trim() !== s.value) { rows[r][3][c] = s.value; moved(s.value); }
    else rows[r][3][c] = s.value;
    /* Named whether or not the matrix moved. The matrix agreeing with the
       certificate says nothing about the office's workbook, which may still be
       missing the date entirely. */
    only.add(key);
  });

  return { next: { cols, rows }, applied, only };
}

/**
 * What one round of the certificates settles, orphans included.
 *
 * A certificate deleted from the library takes the date it put on the matrix
 * with it. Only the cells the portal itself filled from a certificate are
 * touched — most of the matrix came in on the office's own spreadsheet and has
 * never had a certificate behind it at all, so treating those as abandoned
 * would empty the sheet. `filledFromCert` is the note kept against each
 * filled cell, keyed PERSON::CODE, and `claimed` is every key a certificate
 * still on the books stands behind. A filled cell nobody claims is an orphan:
 * it is cleared, in the same write as the dates being filled.
 *
 * Never while anything is still unread. A certificate with no reading yet
 * claims no cell, so with a backlog of unread scans every cell they stand
 * behind read as abandoned — the round filled the matrix in, then cleared
 * four hundred dates back out, over and over, while the reading caught up.
 * "Gone from the library" can only be told from "not read yet" once
 * everything on the books has been read, so the clearing waits for that.
 *
 * Back comes a copy of `settled` with one clearing entry per orphan, the
 * orphans themselves, and the note as it should read after this round: the
 * orphans gone, and every cell a certificate actually put a date in added.
 * A certificate whose scan gave no date leaves the office's own date in
 * place, and noting that cell would mean deleting the certificate later
 * wiped a date the portal never put there.
 * @param {{
 *   filledFromCert?: Record<string, boolean> | null,
 *   claimed?: string[] | null,
 *   unread?: number | null,
 *   settled?: { person: string, code: string, value?: string, clear?: boolean }[] | null,
 * }} round
 */
export function settleRound({ filledFromCert, claimed, unread, settled }) {
  const backed = new Set(claimed || []);
  const wasFilled = filledFromCert || {};
  const stillReading = !!unread;
  const orphans = stillReading ? [] : Object.keys(wasFilled).filter((k) => !backed.has(k));

  const out = (settled || []).slice();
  orphans.forEach((k) => {
    const cut = k.indexOf("::");
    if (cut < 0) return;
    out.push({ person: k.slice(0, cut), code: k.slice(cut + 2), value: "", clear: true });
  });

  /** @type {Record<string, boolean>} */
  const noteNow = { ...wasFilled };
  orphans.forEach((k) => { delete noteNow[k]; });
  out.forEach((x) => {
    if (x.clear || !x.value) return;
    noteNow[String(x.person).trim().toUpperCase() + "::" + String(x.code).trim().toUpperCase()] = true;
  });

  return { settled: out, orphans, noteNow };
}
