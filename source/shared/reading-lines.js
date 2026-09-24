// @ts-check
/**
 * The three sentences the portal says when the model's account, not the
 * document, is what stopped a reading. The worker decides which one
 * (plainLine in src/lib/analysis.ts) and the page shows them as they are -
 * under Update portal, in the round's window, on the crew phone - so they
 * live here, where both read them. The page splices this file in at its
 * @shared marker; the worker imports it. Edit them here and only here.
 *
 * Each is 60 characters or fewer: the badge under Update portal shows the
 * first 60 of an error, and a sentence cut at 60 would say something else.
 */

/** The account has no credit left; nothing is read until it is topped up. */
export const OUT_OF_CREDIT = "Out of credit — top it up at console.anthropic.com";

/** The model is over its rate or busy; the hour tries again by itself. */
export const READING_UNAVAILABLE = "Reading unavailable — tried again next hour";

/** The key was refused: wrong, expired or revoked. */
export const KEY_PROBLEM = "Reading key refused — check ANTHROPIC_API_KEY";
