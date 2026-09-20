/**
 * One way of writing a crew member's name down: LASTNAME, First.
 *
 * The office's OPMS folders were named for the person rather than for the
 * record - "Kyle", "PK", "Con", "Zac" - and the portal kept the crew as the
 * crew matrix writes them, "EVDOKIMOV, Evgeny". Holding the two together took
 * a lookup table, a pairing question and a fair amount of guessing, and it
 * still put the same man on the screen twice the day somebody new arrived.
 *
 * The file's own name is the better authority: it is on every certificate the
 * office files, it survives being moved between folders, and it is the thing a
 * person reads when they go looking. So the person is read from the filename,
 * and every name the portal writes down is put into the one form.
 */

/** A word capitalised the way a name is: Evgeny, O'Brien, Macknamara-Smith. */
const cased = (w: string) =>
  w
    .split(/([-'])/)
    .map((p) => (p === "-" || p === "'" ? p : p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p))
    .join("");

/** Anything that is a rank, a code, or otherwise not part of somebody's name. */
const NOT_A_NAME =
  /^(?:the|and|of|for|crew|alpha|bravo|others|united|marine|minres|mrl|portal|copy|scan|final|new|old|draft)$/i;

/**
 * The name as the portal writes it, out of however it was written down.
 *
 * "EVDOKIMOV, Evgeny" and "Evgeny EVDOKIMOV" and "evdokimov evgeny" all come
 * back the same. Which half is the surname is read from the writing itself:
 * a comma says it outright, and failing that a word in capitals is the surname
 * wherever it sits, because that is how the office writes them. Only where
 * neither says anything is the last word taken as the surname, which is the
 * way a name is written in English more often than not.
 */
export function canonicalPersonName(raw: string): string {
  const s = String(raw ?? "")
    .replace(/[_]+/g, ", ")          // SURNAME_ First — a comma a filesystem ate
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim()
    .replace(/[,\s]+$/, "");
  if (!s) return "";

  let last = "";
  let firsts: string[] = [];

  if (s.includes(",")) {
    const [head, ...rest] = s.split(",");
    last = head.trim();
    firsts = rest.join(" ").split(" ").filter(Boolean);
  } else {
    const parts = s.split(" ").filter(Boolean);
    if (parts.length === 1) return parts[0].toUpperCase();
    // A word in capitals is the surname, wherever it has been put.
    const shouted = parts.findIndex((w) => w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w));
    const at = shouted >= 0 ? shouted : parts.length - 1;
    last = parts[at];
    firsts = parts.filter((_, i) => i !== at);
  }

  const first = firsts.filter((w) => w && !NOT_A_NAME.test(w)).map(cased).join(" ");
  const surname = last.replace(/[^A-Za-z'\- ]/g, "").toUpperCase().trim();
  if (!surname) return "";
  return first ? `${surname}, ${first}` : surname;
}

/**
 * Who a filed document belongs to, read off its own name.
 *
 * The office writes a certificate as "SURNAME, First - QL-01 Master.pdf", so
 * the name is what sits before the first dash. Where there is no dash the whole
 * name is tried, which catches "Travis MICHALZIK.pdf" and "Marlou MATA.png".
 *
 * Null where the filename says nothing about a person - a spreadsheet, a
 * licence verification, anything belonging to the vessel rather than to
 * somebody. Those are worth a human's attention, not a guess.
 */
export function personFromFilename(filename: string): string | null {
  const base = String(filename ?? "")
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .trim();
  if (!base) return null;

  // "SURNAME, First - QL-01 Master" — the office's own way round.
  const dash = base.search(/\s[-–]\s/);
  const head = dash > 0 ? base.slice(0, dash) : base;

  const tidy = head.replace(/\s*\(\d+\)\s*$/, "").trim();
  if (!tidy || /\d/.test(tidy)) return null;

  const words = tidy.replace(/[_,]+/g, " ").split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return null;
  // Every word has to read like part of a name, or this is a document title.
  if (!words.every((w) => /^[A-Za-z][A-Za-z'\-.]*$/.test(w))) return null;
  if (words.some((w) => NOT_A_NAME.test(w))) return null;

  const name = canonicalPersonName(tidy);
  return name && name.includes(",") ? name : null;
}

/** The folder a person's files are filed under, from their name. */
export function folderForPerson(name: string): string {
  return (
    canonicalPersonName(name)
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 80) || "unnamed"
  );
}
