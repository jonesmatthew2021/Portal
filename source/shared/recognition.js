// @ts-check
/**
 * An AMSA certificate of recognition, and the foreign certificate behind it.
 *
 * A foreign STCW card on its own gives a man no standing on this vessel. It
 * counts only through AMSA's certificate of recognition (MO505 s 4, s 7(2);
 * MO70 ss 26-30), and the recognition is the document that counts. But the
 * recognition can never outlive the certificate it recognises:
 *
 *  - it can be revalidated only after the foreign certificate has been
 *    (MO70 s 33(2)), and endorsed only after the foreign certificate has
 *    been (s 36(3));
 *  - an endorsement on it runs for the remainder of the foreign
 *    certificate's endorsement unless AMSA sets another term (s 37(4));
 *  - its own term can never be extended (s 30 note; the note to s 15(6)).
 *
 * So where both dates are known the cell takes the EARLIER of them. Reading
 * the later one would put a man to sea on a recognition of a certificate
 * that has gone.
 *
 * And two columns a recognition can never fill at all: AMSA may recognise
 * only the classes MO70 s 7(2)(b) lists, which do not include the
 * certificate of safety training or the marine cook certificate. A
 * recognition claiming either fills nothing. Which columns those are is the
 * vessel file's (`neverRecognised`), with the clause beside it, so the
 * law's mapping is data and not a code written into a rule.
 *
 * Nothing here decides a colour or writes a line on a screen. The page
 * splices this file in at its @shared marker, so the rule is proved on the
 * code that ships. Edit it here and only here.
 *
 * A shared file cannot import another, so the vessel file's list of barred
 * columns is handed in by the caller.
 */

/**
 * @typedef {{ readable?: boolean, isRecognition?: boolean | null,
 *   recognises?: { authority?: string | null, country?: string | null,
 *     number?: string | null, expiresOn?: string | null } | null }} RecognitionReading
 */

/** A YYYY-MM-DD day, or "". */
function recognitionDay(/** @type {unknown} */ v) {
  const s = typeof v === "string" ? v.trim().slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

/** A code as the columns write it. */
const recognitionCode = (/** @type {unknown} */ c) => String(c == null ? "" : c).trim().toUpperCase();

/** Whether a document is an AMSA certificate of recognition.
 * @param {RecognitionReading | null | undefined} reading
 */
export function isRecognitionReading(reading) {
  return !!reading && reading.isRecognition === true;
}

/**
 * Whether a recognition may fill a column at all.
 *
 * False for the columns MO70 s 7(2)(b) keeps out of the recognition scheme -
 * this vessel's certificate of safety training and marine cook columns. A
 * foreign basic safety or cook certificate is not a class AMSA recognises,
 * so a document claiming to recognise one proves nothing about that column.
 * @param {string} code
 * @param {unknown} neverRecognised the vessel file's neverRecognised.codes
 */
export function recognitionFills(code, neverRecognised) {
  const barred = (Array.isArray(neverRecognised) ? neverRecognised : []).map(recognitionCode);
  return !barred.includes(recognitionCode(code));
}

/**
 * The expiry a recognition prints for the foreign certificate behind it, as
 * printed, or null.
 * @param {RecognitionReading | null | undefined} reading
 */
export function foreignExpiryOn(reading) {
  const said = reading && reading.recognises ? reading.recognises.expiresOn : null;
  return recognitionDay(said) || null;
}

/**
 * The date a cell takes where a recognition fills it.
 *
 * `until` is the date it would take on its own - the recognition's printed
 * expiry, or the date the covers rule worked out for a column it covers.
 * `onFile` is the expiry of the foreign certificate where one is on the
 * portal for that column. The earlier of what is known governs (MO70
 * s 33(2), s 36(3), s 37(4)).
 *
 * `foreignUnknown` is true where neither the recognition prints the foreign
 * certificate's expiry nor the certificate itself is on the portal: the cell
 * still takes the recognition's own date, because that is all there is, and
 * the office is told the certificate behind it is not held.
 * @param {RecognitionReading | null | undefined} reading
 * @param {string | null | undefined} until
 * @param {string | null | undefined} onFile
 * @returns {{ until: string | null, foreignUnknown: boolean }}
 */
export function recognisedUntil(reading, until, onFile) {
  const mine = recognitionDay(until);
  const printed = foreignExpiryOn(reading) || "";
  const held = recognitionDay(onFile);
  const foreign = printed && held ? (printed < held ? printed : held) : printed || held;
  if (!foreign) return { until: mine || null, foreignUnknown: true };
  if (!mine) return { until: foreign, foreignUnknown: false };
  return { until: foreign < mine ? foreign : mine, foreignUnknown: false };
}
