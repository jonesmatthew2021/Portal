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
