// @ts-check
/**
 * The column a certificate is filed under is the office's word.
 *
 * The Master, 25 Sep 2026, on finding certificates on file that the matrix
 * showed as missing: "every file needs to go into the matrix". Five "VS-04
 * Helm CONNECT" files were the Crew Intermediate course, four "QL-04 Master
 * <45m NC" files a Watchkeeper Deck ticket, one pilotage exemption was filed
 * under one port's column and printed for another - the model gave no code,
 * or another one, and the cell the office had filed the paper for stayed
 * empty.
 *
 * A certificate reaches the portal filed under a column in one of two ways:
 * the upload page's chosen column (a hand tag), or a name the office wrote
 * in the portal's own shape - "<PERSON> - <CODE> <Title>.<ext>" - where the
 * code in the filename is a column of the live matrix. The filename's code
 * is the filed column, one rank below a hand tag:
 *
 *     hand tag > filed column (filename) > Equivalence sheet > the model
 *
 * A name the portal wrote itself on the refile is not the office's word: its
 * code is the model's guess written down, and the row says so
 * (`namedByPortal`, set where the portal renames a file under a code that
 * was not already the office's - a rename that only tidies the office's own
 * "<CODE>" into the portal's spelling keeps the office's word and no mark).
 * A marked name is no filing, so the Equivalence sheet can still move the
 * certificate. Names the portal wrote before that mark existed (25 Sep
 * 2026) cannot be told from the office's and are read as the office's.
 *
 * Where the filed column and the model's reading disagree, the filed column
 * still gets the certificate's date and Needs attention says so in one line
 * (filedAsLine), so a wrong filing is visible rather than silently accepted.
 * A document the model found unreadable fills nothing from its filename: a
 * filename is not evidence that a paper exists. That is the callers' rule
 * (codeFor and filedAsFor in worker/src/lib/analysis.ts, which the round and
 * the page's cells both go through); this file is the two pure pieces the
 * page and the worker share. A shared file cannot import another, so the
 * columns are handed in.
 */

/**
 * The column a filename files a document under, or null.
 *
 * The code has to be a whole token of the name - "QL-04" in "ROGERS, Michael
 * - QL-04 Master <45m NC.pdf", never the "QL-04" inside "QL-041" or
 * "QL-04Master" - and a column of the live matrix: "PI-02" on a file when
 * the matrix has no PI-02 column is not a filing, it is a name. Where a
 * name carries two codes the first is the filing. Case is ignored: the
 * office's names are not always the portal's.
 * @param {unknown} filename
 * @param {unknown} columns the live matrix's columns: [code, title, group][]
 * @returns {string | null} the code as the matrix writes it
 */
export function filedCodeIn(filename, columns) {
  const name = String(filename == null ? "" : filename);
  if (!name || !Array.isArray(columns) || !columns.length) return null;
  /** @type {Map<string, string>} */
  const live = new Map();
  columns.forEach((c) => {
    const code = String(Array.isArray(c) ? c[0] : "").trim();
    if (code) live.set(code.toUpperCase(), code.toUpperCase());
  });
  if (!live.size) return null;
  // Tokens are runs of letters, digits and hyphens: a code is "AA-9" shaped,
  // so a hyphen inside a token is part of it and anything else ends it.
  const tokens = name.toUpperCase().split(/[^A-Z0-9-]+/).filter(Boolean);
  for (const t of tokens) {
    const hit = live.get(t);
    if (hit) return hit;
  }
  return null;
}

/**
 * The one line Needs attention says where the filed column and the reading
 * disagree: whose document, which column it was filed under, and what the
 * model read it as. Nothing more.
 * @param {unknown} person as the matrix row names him
 * @param {unknown} code the filed column
 * @param {unknown} title that column's title
 * @param {unknown} readsAs what the reading called the document, or null
 *   where it named nothing the matrix has
 */
export function filedAsLine(person, code, title, readsAs) {
  const read = String(readsAs == null ? "" : readsAs).trim();
  return `${String(person == null ? "" : person)} — ${String(code == null ? "" : code)}: filed as ${String(title == null ? "" : title)}, reads as ${read || "nothing on the matrix"}`;
}
