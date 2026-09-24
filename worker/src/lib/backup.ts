import { getEnv, type PortalEnv } from "../env.js";
import { getStore } from "../compat/blobs.js";
import { fileStore, toReal } from "../files/store.js";
import { certHome } from "../db/cert-home.js";
import { PORTAL_ROW_ID } from "../db/schema.js";

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

/* ------------------------------------------------------------- the backup -- */

/** What the last backup did, kept in the sync store under "last-backup":
 *  the day it landed on (only ever a day that landed), when it was tried,
 *  and the error where it did not land. The SharePoint page shows it. */
export type BackupRecord = {
  day: string | null;
  at: number;
  name: string | null;
  bytes: number;
  rev: number | null;
  counts: Record<string, number>;
  error: string | null;
};

const RECORD = "last-backup";
export const lastBackup = () => getStore("sync").get(RECORD, { type: "json" }) as Promise<BackupRecord | null>;

/** The named stores that go in the file: the AI's readings and checks. The
 *  sync store (the hour's records, the lease) and the job stores do not. */
const READING_STORES = ["certificate-readings", "matrix-readings", "shift-allocation-readings", "opms-checks"];

/** The real paths of the folders Crew Details points at: the certificate
 *  home and every man's own folder. The backup may not go under any. */
async function foldersFiledInto(): Promise<string[]> {
  const where = await certHome();
  return [where.home, ...where.assigned.map((a) => a.key)].map((k) => trimSlashes(toReal(k + "/")));
}

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The file itself, as text. Put together by hand rather than through
 * JSON.stringify of one big object, so the shared document goes in byte
 * for byte as the database holds it - never parsed and written out again,
 * which is where a stray change could creep in. A reading that is not
 * JSON as stored (it should always be) goes in as a string with a note,
 * so the file still parses.
 */
async function backupBody(now: number, day: string): Promise<{ text: string; rev: number | null; counts: Record<string, number> }> {
  const db = getEnv().DB;
  const state = await db.prepare("SELECT data, rev FROM portal_state WHERE id = ?1").bind(PORTAL_ROW_ID).first<{ data: string; rev: number }>();
  const documents = (await db.prepare("SELECT * FROM documents ORDER BY created_at, id").all()).results || [];
  const users = (await db.prepare("SELECT id, email, name, role, disabled, created_at, created_by, last_login, phone FROM users").all()).results || [];
  const readings: Record<string, { key: string; value: string }[]> = {};
  for (const store of READING_STORES) {
    readings[store] = (await db.prepare("SELECT key, value FROM blobs WHERE store = ?1").bind(store).all<{ key: string; value: string }>()).results || [];
  }
  let fauna: unknown[] = [];
  try {
    fauna = (await db.prepare("SELECT * FROM fauna_sightings").all()).results || [];
  } catch (e) {
    // The table is made the first time the phone logs a sighting; a
    // portal that has never had one has no table and nothing to keep.
    if (!/no such table/i.test(said(e))) throw e;
  }
  const readingCount = Object.values(readings).reduce((n, rows) => n + rows.length, 0);
  const counts = { documents: documents.length, users: users.length, readings: readingCount, fauna: fauna.length };
  const rows = (list: unknown[]) => "[" + list.map((r) => JSON.stringify(r)).join(",") + "]";
  const asStored = (value: string) => {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify({ note: "not JSON as stored", text: value });
    }
  };
  const text =
    '{"portal":"coolibah","backupVersion":1' +
    ',"at":' + JSON.stringify(new Date(now).toISOString()) +
    ',"perthDay":' + JSON.stringify(day) +
    ',"rev":' + (state ? String(state.rev) : "null") +
    ',"counts":' + JSON.stringify(counts) +
    ',"document":' + (state ? state.data : "null") +
    ',"documents":' + rows(documents) +
    ',"users":' + rows(users) +
    ',"readings":{' + READING_STORES.map((store) =>
      JSON.stringify(store) + ":{" + readings[store].map((r) => JSON.stringify(r.key) + ":" + asStored(r.value)).join(",") + "}",
    ).join(",") + "}" +
    ',"fauna":' + rows(fauna) +
    "}";
  return { text, rev: state ? state.rev : null, counts };
}

/**
 * The backup, from the hour: nothing where none is owed or no folder is
 * named; otherwise one file written into BACKUP_FOLDER, the old ones
 * dropped by name, and the record written. About fifteen calls, and no
 * listing. Any failure goes on the record with the day left as it was,
 * so the next hour tries again and the SharePoint page says why.
 */
export async function nightlyBackup(now: number): Promise<BackupRecord | null> {
  const env = getEnv();
  const store = getStore("sync");
  const record = (await store.get(RECORD, { type: "json" }).catch(() => null)) as BackupRecord | null;
  const perth = perthNow(now);
  const hour = Number(env.BACKUP_HOUR);
  if (!backupDue(record, perth, Number.isFinite(hour) ? hour : 2)) return null;
  const folder = trimSlashes(env.BACKUP_FOLDER || "");
  if (!folder) return null;

  const failed = async (error: string): Promise<BackupRecord> => {
    // The day is only ever a day that landed, so it stays as it was.
    const next: BackupRecord = {
      day: record?.day ?? null, name: record?.name ?? null, bytes: record?.bytes ?? 0,
      rev: record?.rev ?? null, counts: record?.counts ?? {}, at: now, error,
    };
    console.error("the nightly backup was not written:", error);
    try {
      await store.setJSON(RECORD, next);
    } catch (e) {
      console.error("the backup's record was not written:", e);
    }
    return next;
  };

  try {
    const allowed = folderAllowed(folder, env, await foldersFiledInto());
    if (!allowed.ok) return await failed(allowed.reason);
    const files = fileStore();
    if (!(await files.hasFolder("library/" + folder))) return await failed(`the folder ${folder} is not in the library; make it in Teams`);

    const { text, rev, counts } = await backupBody(now, perth.day);
    const bytes = new TextEncoder().encode(text);
    const name = backupName(perth.day);
    await files.set(`library/${folder}/${name}`, bytes.buffer as ArrayBuffer, { intoExistingFolder: true });
    for (const old of namesToDrop(perth.day)) {
      // Each on its own: a drop that fails costs one old file, not the backup.
      try {
        await files.delete(`library/${folder}/${old}`);
      } catch (e) {
        console.error(`the old backup ${old} was not dropped:`, e);
      }
    }
    const next: BackupRecord = { day: perth.day, at: now, name, bytes: bytes.length, rev, counts, error: null };
    await store.setJSON(RECORD, next);
    return next;
  } catch (e) {
    return await failed(said(e));
  }
}
