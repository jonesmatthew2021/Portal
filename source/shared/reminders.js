// @ts-check
/**
 * The weekly certificate-expiry reminders, as rules: what is expiring, who
 * is told, when it is due, and what the email says. The worker's hour sends
 * them (src/lib/reminders.ts); the page holds the setting and splices this
 * file in at its @shared marker, so the rules are proved on the code that
 * ships. Edit them here and only here.
 *
 * A shared file cannot import another, so the few rules this leans on from
 * names.js and bands.js (crewRowsOnly, crewRegister, daysUntil) are handed
 * in by the caller as `rules` - the worker passes the modules' own, the
 * page's tests pass the page's.
 */

/**
 * @typedef {[string, string, string, string[]]} MatrixRow
 *   A crew matrix row: name, position, SAM number, then one value per column.
 * @typedef {{ cols?: unknown[], rows?: unknown[] }} Quals
 * @typedef {{ name?: string, aliases?: string[] }} Person
 * @typedef {{ person: string, code: string, title: string, date: string, daysLeft: number }} Expiring
 *   One item on somebody's list: whose, which, when, and how many days are
 *   left (negative once it has gone).
 * @typedef {{ person: string, items: Expiring[] }} Group
 * @typedef {{ id?: unknown, email?: unknown, name?: unknown, role?: unknown, disabled?: unknown }} User
 *   A row of the users table, as the worker reads it.
 * @typedef {{ on: boolean, days: number, weekday: number, hour: number }} ReminderSetting
 * @typedef {{ day: string, hour: number, weekday: number }} VesselClock
 *   The day (YYYY-MM-DD), the hour (0-23) and the weekday (0 Sunday to 6
 *   Saturday) where the vessel is.
 * @typedef {{ name: string, nameAccent: string, domain: string }} VesselNaming
 * @typedef {{
 *   crewRowsOnly?: (quals: any, people: any, noExpiryCodes: string[]) => any,
 *   crewRegister?: (people: any) => { nameOf: (spelling: unknown) => string | null },
 *   daysUntil?: (iso: string, today: string) => number,
 * }} Rules
 */

/** The setting as it ships: off, until somebody switches it on. A window of
 *  90 days is the red band (RED_DAYS in bands.js); a test holds the two the
 *  same. Monday, at seven in the morning where the vessel is. */
export const REMINDER_DEFAULTS = { on: false, days: 90, weekday: 1, hour: 7 };

/** The weekdays as the Access Grants switch names them, Sunday first to
 *  match the clock's 0-6. */
export const REMINDER_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The setting as the document holds it, with the defaults where a key is
 * missing or will not do. Only a real `true` switches it on: anything else
 * the document might carry is off, because an email that goes out by
 * mistake cannot be called back.
 * @param {unknown} raw
 * @returns {ReminderSetting}
 */
export function reminderSetting(raw) {
  const r = /** @type {Record<string, unknown>} */ (raw && typeof raw === "object" ? raw : {});
  const whole = (/** @type {unknown} */ v, /** @type {number} */ lo, /** @type {number} */ hi, /** @type {number} */ fallback) => {
    const n = Number(v);
    return v !== null && v !== "" && Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
  };
  return {
    on: r.on === true,
    days: whole(r.days, 1, 365, REMINDER_DEFAULTS.days),
    weekday: whole(r.weekday, 0, 6, REMINDER_DEFAULTS.weekday),
    hour: whole(r.hour, 0, 23, REMINDER_DEFAULTS.hour),
  };
}

const REMINDER_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Everything on the crew matrix that has expired or expires within `days`
 * of `todayISO`, soonest first. Only the crew rows (crewRowsOnly, which also
 * speaks each row by the register's name and turns an item that never
 * lapses into a plain Y); only cells holding a date - Y, N, OPEN and blanks
 * are nobody's reminder; and never an item on the vessel file's list of
 * items that never lapse, whatever a cell under it says.
 * @param {Quals | null | undefined} quals
 * @param {Person[] | null | undefined} people
 * @param {number} days
 * @param {string} todayISO
 * @param {string[]} noExpiryCodes
 * @param {Rules} rules crewRowsOnly and daysUntil
 * @returns {Expiring[]}
 */
export function expiringWithin(quals, people, days, todayISO, noExpiryCodes, rules) {
  if (!rules.crewRowsOnly || !rules.daysUntil) throw new Error("expiringWithin needs crewRowsOnly and daysUntil handed in.");
  const crew = rules.crewRowsOnly(quals, people, noExpiryCodes);
  if (!crew || !Array.isArray(crew.rows)) return [];
  const cols = Array.isArray(crew.cols) ? crew.cols : [];
  const never = new Set(noExpiryCodes.map((c) => String(c).trim().toUpperCase()));
  /** @type {Expiring[]} */
  const out = [];
  const seen = new Set();
  for (const row of crew.rows) {
    if (!Array.isArray(row)) continue;
    const person = String(row[0] || "").trim();
    const cells = Array.isArray(row[3]) ? row[3] : [];
    if (!person) continue;
    cells.forEach((/** @type {unknown} */ v, /** @type {number} */ i) => {
      const col = Array.isArray(cols[i]) ? cols[i] : [];
      const code = String(col[0] || "").trim();
      if (!code || never.has(code.toUpperCase())) return;
      const date = String(v || "").trim();
      if (!REMINDER_ISO.test(date)) return;
      const daysLeft = /** @type {NonNullable<Rules["daysUntil"]>} */ (rules.daysUntil)(date, todayISO);
      if (!Number.isFinite(daysLeft) || daysLeft > days) return;
      // A man on the matrix twice (two spellings the register made one) is
      // one line on his list, not two.
      const key = person + "|" + code + "|" + date;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ person, code, title: String(col[1] || "").trim(), date, daysLeft });
    });
  }
  out.sort((a, b) => a.daysLeft - b.daysLeft || a.person.localeCompare(b.person) || a.code.localeCompare(b.code));
  return out;
}

/**
 * The items one list per person, in the order of the names, each list
 * soonest first.
 * @param {Expiring[]} items
 * @returns {Group[]}
 */
export function byPerson(items) {
  /** @type {Map<string, Expiring[]>} */
  const groups = new Map();
  for (const it of items) {
    const list = groups.get(it.person);
    if (list) list.push(it);
    else groups.set(it.person, [it]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([person, list]) => ({ person, items: [...list].sort((a, b) => a.daysLeft - b.daysLeft || a.code.localeCompare(b.code)) }));
}

const remActive = (/** @type {User} */ u) =>
  !!u && !(u.disabled === true || Number(u.disabled) > 0) && /^[^\s@]+@[^\s@]+$/.test(String(u.email || "").trim());

/**
 * Who is sent what.
 *
 * `own`: each active crew grant whose name the crew register knows as a
 * person with at least one item - that person's own list, to that grant's
 * address. The grant's name ("Kachin Sittiyos", as typed on Access Grants)
 * and the matrix row ("SITTIYOS, Kachin") meet only through the register
 * (crewRegister, on Crew Details), which answers null to a name it cannot
 * put to exactly one person; a null is nobody's list. A grant named in one
 * word is left out too: the register will match a single word where one man
 * answers to it, which is right for a folder name and not good enough for
 * sending somebody's certificates to an inbox.
 *
 * `summary`: every active management and IT grant, the whole list.
 *
 * A disabled grant, or one without a usable address, gets nothing. Each
 * address is written once in each list, whatever its case.
 * @param {User[]} users
 * @param {Person[] | null | undefined} people
 * @param {Expiring[]} items
 * @param {Rules} rules crewRegister
 * @returns {{ own: { user: User, person: string, items: Expiring[] }[], summary: User[] }}
 */
export function recipientsFor(users, people, items, rules) {
  if (!rules.crewRegister) throw new Error("recipientsFor needs crewRegister handed in.");
  const lists = new Map(byPerson(items).map((g) => [g.person, g.items]));
  const reg = rules.crewRegister(people);
  const active = (users || []).filter(remActive);
  /** @type {{ user: User, person: string, items: Expiring[] }[]} */
  const own = [];
  /** @type {User[]} */
  const summary = [];
  const ownTo = new Set();
  const summaryTo = new Set();
  for (const user of active) {
    const to = String(user.email).trim().toLowerCase();
    if (user.role === "crew") {
      const name = String(user.name || "").trim();
      if (name.split(/[^A-Za-z]+/).filter((w) => w.length > 1).length < 2) continue;
      const person = reg.nameOf(name);
      const list = person ? lists.get(person) : undefined;
      if (!person || !list || !list.length || ownTo.has(to)) continue;
      ownTo.add(to);
      own.push({ user, person, items: list });
    } else if (user.role === "management" || user.role === "it") {
      if (summaryTo.has(to)) continue;
      summaryTo.add(to);
      summary.push(user);
    }
  }
  return { own, summary };
}

/**
 * Whether this week's reminders are owed: it is the day, it is past the
 * hour, and the last record is not today's. A record is written for the day
 * before anything is sent, so a second tick that day - or a second worker
 * running the same tick - finds it and sends nothing.
 * @param {{ day?: string | null } | null | undefined} record
 * @param {VesselClock} there
 * @param {number} weekday
 * @param {number} hour
 */
export function reminderDue(record, there, weekday, hour) {
  return there.weekday === weekday && there.hour >= hour && (record?.day ?? null) !== there.day;
}

const REMINDER_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-12" as "12 Oct 2026". Written out by hand so the email reads
 *  the same whatever language the machine sending it speaks.
 * @param {string} iso */
export function reminderDate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return d + " " + REMINDER_MONTHS[m - 1] + " " + y;
}

const remPlural = (/** @type {number} */ n, /** @type {string} */ word) => n + " " + word + (n === 1 ? "" : "s");

/** One item as a line: "QL-17 AMSA Medical — expires 12 Oct 2026 (18 days)",
 *  "… — expires today (12 Oct 2026)", "… — expired 3 days ago (21 Sep 2026)".
 * @param {Expiring} it */
export function reminderItemLine(it) {
  const what = it.title ? it.code + " " + it.title : it.code;
  const when = reminderDate(it.date);
  if (it.daysLeft === 0) return what + " — expires today (" + when + ")";
  if (it.daysLeft < 0) return what + " — expired " + remPlural(-it.daysLeft, "day") + " ago (" + when + ")";
  return what + " — expires " + when + " (" + remPlural(it.daysLeft, "day") + ")";
}

const remEsc = (/** @type {unknown} */ s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** @param {VesselNaming} vessel */
const remShip = (vessel) => vessel.name + " " + vessel.nameAccent;
/** @param {VesselNaming} vessel */
const remPortal = (vessel) => "https://" + vessel.domain;

/**
 * @param {string} head
 * @param {string[]} body
 * @param {VesselNaming} vessel
 */
const remHtml = (head, body, vessel) =>
  '<div style="font-family:sans-serif;max-width:560px">' +
  '<p>' + remEsc(head) + '</p>' + body.join("") +
  '<p><a href="' + remEsc(remPortal(vessel)) + '">' + remEsc(remPortal(vessel)) + '</a></p></div>';

/** @param {Expiring[]} items */
const remHtmlList = (items) =>
  '<ul style="padding-left:18px;margin:0 0 14px">' +
  items.map((it) => '<li style="margin:3px 0' + (it.daysLeft < 0 ? ';color:#b3261e' : '') + '">' + remEsc(reminderItemLine(it)) + '</li>').join("") +
  '</ul>';

/**
 * One crew member's own email: one line saying what the list is, the list,
 * and the portal's address. Nothing else.
 * @param {VesselNaming} vessel
 * @param {string} person the register's name for them
 * @param {Expiring[]} items
 * @param {string} todayISO
 * @param {number} days the window
 */
export function reminderText(vessel, person, items, todayISO, days) {
  const head = "Your certificates on the " + remShip(vessel) + " crew matrix (" + person + ") that have expired or expire within " +
    remPlural(days, "day") + ", as at " + reminderDate(todayISO) + ":";
  return {
    subject: "Your certificates expiring within " + remPlural(days, "day") + " - " + remShip(vessel),
    text: head + "\n\n" + items.map(reminderItemLine).join("\n") + "\n\n" + remPortal(vessel) + "\n",
    html: remHtml(head, [remHtmlList(items)], vessel),
  };
}

/**
 * The summary for management and IT: the same line, then every person's
 * list under their name, then the portal's address.
 * @param {VesselNaming} vessel
 * @param {Group[]} groups
 * @param {string} todayISO
 * @param {number} days the window
 */
export function summaryText(vessel, groups, todayISO, days) {
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  const head = "Crew certificates on the " + remShip(vessel) + " crew matrix that have expired or expire within " +
    remPlural(days, "day") + ", as at " + reminderDate(todayISO) + " - " + remPlural(count, "item") + ", " +
    groups.length + (groups.length === 1 ? " person" : " people") + ":";
  return {
    subject: "Crew certificates expiring within " + remPlural(days, "day") + " - " + remShip(vessel),
    text: head + "\n\n" + groups.map((g) => g.person + "\n" + g.items.map((it) => "  " + reminderItemLine(it)).join("\n")).join("\n\n") +
      "\n\n" + remPortal(vessel) + "\n",
    html: remHtml(head, groups.map((g) => '<p style="margin:0 0 4px"><b>' + remEsc(g.person) + '</b></p>' + remHtmlList(g.items)), vessel),
  };
}
