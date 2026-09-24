import type { PortalEnv } from "../env.js";

/**
 * The nightly backup: one JSON file a day in a folder of the owner's, in
 * the library, holding everything the portal would need to be put back -
 * the shared document byte for byte, the file index, the users, the AI
 * readings and the fauna log. Written by the hour after BACKUP_HOUR in
 * Perth, before the hour takes its lease, so it never holds the round up
 * and the round never holds it up.
 *
 * Nothing here makes a folder. BACKUP_FOLDER is a folder the owner made in
 * Teams; a write that would need one is refused by the driver, and the
 * refusal goes on the record for the SharePoint page to show. Empty, and
 * the backup is off and nothing is shown.
 *
 * This file is the rules - the day, when a backup is due, what it is
 * called, what old ones go, which folders are refused - and then the
 * backup itself (nightlyBackup), which is the only thing here that talks
 * to the database or the library.
 */

export type Perth = { day: string; hour: number };

/** The day (YYYY-MM-DD) and the hour (0-23) it is in Perth at `now`. Perth
 *  decides the day: the vessel is on Perth time and the tick is UTC. */
export function perthNow(now: number | Date): Perth {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Perth", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  }).formatToParts(new Date(now));
  const part = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return { day: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) % 24 };
}

/** Whether a backup is owed now: it is past the hour, and the last one
 *  that landed was not today's. A record with an error and no day is one
 *  that never landed, so it is owed again every hour until it does. */
export function backupDue(record: { day?: string | null } | null | undefined, perth: Perth, afterHour: number): boolean {
  return perth.hour >= afterHour && (record?.day ?? null) !== perth.day;
}

export const backupName = (day: string) => `Crew Portal backup ${day}.json`;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const dayAt = (utcMs: number) => new Date(utcMs).toISOString().slice(0, 10);
const utcOf = (day: string) => {
  const m = ISO_DAY.exec(day);
  if (!m) throw new Error(`not a day: ${day}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};

/**
 * The names to take out of the folder after today's has landed: a month's
 * dailies and a year's monthlies are kept, and nothing is listed to find
 * out what is there. The dailies dated 31 to 37 days back go (seven, so a
 * week's outage heals itself: a night the backup did not run leaves a
 * file that the next week of nights still reaches), except one that is the
 * first of its month, which stays as that month's; and the first of the
 * month 13 months back goes. A name that was never there is a delete of
 * nothing, which the drivers answer quietly.
 */
export function namesToDrop(day: string): string[] {
  const at = utcOf(day);
  const out: string[] = [];
  for (let back = 31; back <= 37; back++) {
    const d = dayAt(at - back * 86_400_000);
    if (!d.endsWith("-01")) out.push(backupName(d));
  }
  const m = ISO_DAY.exec(day)!;
  const monthly = dayAt(Date.UTC(Number(m[1]), Number(m[2]) - 1 - 13, 1));
  out.push(backupName(monthly));
  return out;
}

const trimSlashes = (s: string) => String(s || "").replace(/^\/+|\/+$/g, "");

/**
 * Whether the backup may go in this folder. A folder the portal files
 * into is refused - a SHAREPOINT_MAP target, the fauna folder, the
 * portal's own folder, and whatever the caller adds (the certificate home
 * and the crew folders Crew Details assigned): the sync reads those
 * folders and would take a backup on as a document, and the round writes
 * into them. Under or equal is refused; a folder beside them is fine.
 * `folder` and `alsoFiledInto` are real library paths.
 */
export function folderAllowed(
  folder: string,
  env: Pick<PortalEnv, "SHAREPOINT_MAP" | "SHAREPOINT_FAUNA_FOLDER" | "SHAREPOINT_ROOT">,
  alsoFiledInto: string[] = [],
): { ok: true } | { ok: false; reason: string } {
  const want = trimSlashes(folder);
  if (!want) return { ok: false, reason: "no backup folder is named (BACKUP_FOLDER)" };
  let map: Record<string, string> = {};
  try {
    map = env.SHAREPOINT_MAP ? (JSON.parse(env.SHAREPOINT_MAP) as Record<string, string>) : {};
  } catch {
    map = {};
  }
  const filedInto = [
    ...Object.values(map),
    env.SHAREPOINT_FAUNA_FOLDER || "",
    env.SHAREPOINT_ROOT ?? "Crew Portal",
    ...alsoFiledInto,
  ].map(trimSlashes).filter(Boolean);
  const lower = (want + "/").toLowerCase();
  const inside = filedInto.find((f) => lower.startsWith(f.toLowerCase() + "/"));
  if (inside) {
    return { ok: false, reason: `the folder ${want} is one the portal files into (${inside}); pick another` };
  }
  return { ok: true };
}
