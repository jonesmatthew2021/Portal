// @ts-check
/**
 * How long a certificate has left, in three bands - the numbers only. The
 * page colours the matrix by them (bandFor in source/parts/certificate-cells.jsx)
 * and the worker's weekly reminder emails (src/lib/reminders.ts) list what
 * falls in the red band by them, so "expiring soon" means the same number of
 * days on the screen and in the inbox. The page splices this file in at its
 * @shared marker; the worker imports it. Edit them here and only here.
 *
 * Red covers expired as well as expiring: an item that ran out last year and
 * one that runs out next month are both work to be done now.
 */

/** Expired, or expiring within this many days. */
export const RED_DAYS = 90;

/** Expiring within this many days (and beyond RED_DAYS). */
export const AMBER_DAYS = 180;

/**
 * Whole days from `today` to `iso`, both YYYY-MM-DD; negative once it has
 * gone. Both are read as midnight UTC, so a daylight-saving change between
 * the two never moves the answer by a day.
 * @param {string} iso
 * @param {string} today
 */
export function daysUntil(iso, today) {
  return Math.round((new Date(iso).getTime() - new Date(today).getTime()) / 86400000);
}

/**
 * Whether a printed expiry has been reached.
 *
 * A certificate is held only while it is not suspended, not cancelled, and
 * its expiry date "has not been reached" (MO70 s 5(a)(iii)). So the day
 * printed on it is the FIRST day it counts for nothing, not the last day it
 * counts, and a man whose ticket runs out today does not hold it today.
 * `daysUntil` is a plain day count and answers 0 on that day, which read as
 * "still in hand" everywhere it was tested against zero; this is the rule,
 * and every list that decides whether somebody holds something reads it
 * through here.
 * @param {string} iso YYYY-MM-DD, the date printed on the certificate
 * @param {string} today YYYY-MM-DD
 */
export function hasExpired(iso, today) {
  return daysUntil(iso, today) <= 0;
}
