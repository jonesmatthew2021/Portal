import { getEnv } from "../env.js";
import { getStore } from "../compat/blobs.js";
import { readDocument } from "./shared-state.js";
import { vessel, vesselNow } from "../vessel.js";
import { crewRowsOnly, crewRegister, nameLetters, registerWords } from "../../../source/shared/names.js";
import { daysUntil } from "../../../source/shared/bands.js";
import {
  reminderSetting, reminderOwed, expiringWithin, byPerson, recipientsFor, reminderText, summaryText,
} from "../../../source/shared/reminders.js";

/**
 * The weekly certificate-expiry emails.
 *
 * On the weekday and from the hour the document's `reminders` setting
 * names (Access Grants; off, Monday, 07:00 and 90 days until somebody
 * changes it), each crew member with a grant is sent their own list of
 * what has expired or expires within the window, and every management and
 * IT grant is sent the whole list, grouped by person. The rules - what is
 * on a list, who is sent it, when it is due, what it says - are in
 * source/shared/reminders.js; this is the only part that reads the books
 * and sends.
 *
 * Called by the hour before it takes its lease, beside the nightly backup:
 * it takes no lease, asks nothing of the library, and nothing it does can
 * stop the sync, the reading or the round.
 *
 * Sending anybody the same email twice is the thing this is built against.
 * The day is claimed in the record - written against the version of the
 * record just read, so of two runs of the same tick only one can - before
 * a single email goes. A run cut off halfway through the sends leaves the
 * claim standing, and the rest of that week's ticks send nothing: an email
 * missed is a line on the SharePoint page, an email sent twice is not
 * something that can be taken back. A failure before anything was sent
 * hands the day back, so the next hour tries again.
 */

/** What the last week's reminders did, kept in the sync store under
 *  "last-reminder": the set day they went for (the day a send was claimed,
 *  or the last one before where nothing went and the next hour is to try
 *  again), when, the window in days, how many crew emails and
 *  summaries were sent, the addresses a send failed for, why nothing was
 *  sent where nothing needed to be, and the error where it could not be.
 *  The SharePoint page shows it. */
export type ReminderRecord = {
  day: string | null;
  at: number;
  window: number;
  own: number;
  summary: number;
  failed: string[];
  skipped: string | null;
  error: string | null;
};

const RECORD = "last-reminder";
export const lastReminder = () => getStore("sync").get(RECORD, { type: "json" }) as Promise<ReminderRecord | null>;

/** Who could be sent anything. Disabled grants are left out here and again
 *  by the rules (recipientsFor), so neither alone lets one through. */
export const REMINDER_USERS_SQL = "SELECT id, email, name, role, disabled FROM users WHERE disabled = 0";

/** What a claim says until the sends are done: if the run is cut off, this
 *  is the line the SharePoint page shows. */
export const UNFINISHED = "the reminders were started and did not finish - nothing more is sent this week";

/** No sending on this deploy (no EMAIL binding in wrangler.toml). */
export const NO_EMAIL = "email sending is not set up on this portal - nothing was sent";

/** How long the sends may go on for, from the job's start. The hour's
 *  deadline for the sync and the round is counted from the tick, and the
 *  reminders come before them: a send that hangs must not eat the round's
 *  time. Past it no new send is started, and whoever was not reached is
 *  named on the record (a test shortens it). */
export const reminderLimits = { sendingForMs: 60_000 };

/** The record's line where the time ran out before the first send: nothing
 *  went, so the next hour tries again. */
export const OUT_OF_TIME = "the reminders ran out of time before the first email - the next hour tries again";

/** The rules from names.js and bands.js the shared reminder rules lean on
 *  (a shared file cannot import another, so they are handed in). */
const RULES = { crewRowsOnly, crewRegister, nameLetters, registerWords, daysUntil };

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * This week's reminders, from the hour: nothing while the switch is off or
 * before they are due; otherwise the day claimed, the emails sent, and the
 * record written. Answers the record written, or null where there was
 * nothing to do. Never throws.
 */
export async function weeklyReminders(now: number): Promise<ReminderRecord | null> {
  const started = Date.now();
  try {
    const env = getEnv();
    const store = getStore("sync");
    const cur = await readDocument();
    if (!cur) return null;
    const setting = reminderSetting(cur.doc.reminders);
    if (!setting.on) return null;
    const there = vesselNow(now);
    const held = await store.getWithMetadata(RECORD, { type: "json" });
    const record = held ? (held.data as ReminderRecord | null) : null;
    // The set day owed: today, or yesterday where its every tick was missed.
    const owed = reminderOwed(record, there, setting.weekday, setting.hour);
    if (!owed) return null;

    const base: ReminderRecord = {
      day: owed, at: now, window: setting.days, own: 0, summary: 0, failed: [], skipped: null, error: null,
    };
    // The claim: only one run of this tick can write it, and no tick after
    // it this week finds the reminders owed.
    const claim: ReminderRecord = { ...base, error: UNFINISHED };
    const took = held
      ? (await store.setJSON(RECORD, claim, { onlyIfMatch: held.etag })).modified
      : (await store.setJSONIfAbsent(RECORD, claim)).written;
    if (!took) return null;

    // Tried twice: a record left at the claim reads as a run that did not
    // finish, when the emails went.
    const write = async (next: ReminderRecord) => {
      for (let tries = 1; tries <= 2; tries++) {
        try {
          await store.setJSON(RECORD, next);
          break;
        } catch (e) {
          if (tries === 2) console.error("the reminders' record was not written:", e);
        }
      }
      return next;
    };
    // Nothing has gone yet: the day goes back to the one before, so the
    // next hour tries again.
    const notSent = (error: string) => {
      console.error("the weekly reminders were not sent:", error);
      return write({ ...base, day: record?.day ?? null, error });
    };

    // Kept outside the sends so a run that falls over part way still says
    // what went and what did not.
    let sentAny = false;
    const failed: string[] = [];
    let ownSent = 0;
    let summarySent = 0;
    try {
      const email = env.EMAIL;
      if (!email) return await notSent(NO_EMAIL);
      const items = expiringWithin(cur.doc.quals, cur.doc.people, setting.days, there.day, vessel.noExpiryCodes, RULES);
      if (!items.length) return await write({ ...base, skipped: "nothing expiring" });
      const users = (await env.DB.prepare(REMINDER_USERS_SQL).all()).results || [];
      const { own, summary } = recipientsFor(users as never[], cur.doc.people, items, RULES);
      if (!own.length && !summary.length) return await write({ ...base, skipped: "nobody to send to" });

      let outOfTime = false;
      // Each on its own: one address the service refuses costs that one
      // email, not everybody's.
      const send = async (to: string, mail: { subject: string; text: string; html: string }) => {
        if (outOfTime || Date.now() - started > reminderLimits.sendingForMs) {
          outOfTime = true;
          failed.push(to);
          return false;
        }
        try {
          sentAny = true;
          await email.send({ to, from: vessel.mailFrom, subject: mail.subject, text: mail.text, html: mail.html });
          return true;
        } catch (e) {
          console.error("a reminder email was not sent:", e);
          failed.push(to);
          return false;
        }
      };
      for (const o of own) {
        if (await send(String(o.user.email).trim(), reminderText(vessel, o.person, o.items, there.day, setting.days))) ownSent++;
      }
      const all = summaryText(vessel, byPerson(items), there.day, setting.days);
      for (const u of summary) {
        if (await send(String(u.email).trim(), all)) summarySent++;
      }
      // Out of time before a single send: nothing went, so the day is handed
      // back like any other failure before sending.
      if (outOfTime && !sentAny) return await notSent(OUT_OF_TIME);
      // Otherwise whoever was not reached is on the failed list, in red on
      // the SharePoint page; the claim stands, so nobody is sent it twice.
      return await write({ ...base, own: ownSent, summary: summarySent, failed });
    } catch (e) {
      // Once anything has gone the claim stands: the day is kept, so
      // nothing is sent again this week.
      return sentAny
        ? await write({ ...base, own: ownSent, summary: summarySent, failed, error: said(e) })
        : await notSent(said(e));
    }
  } catch (e) {
    console.error("the weekly reminders fell over:", e);
    return null;
  }
}
