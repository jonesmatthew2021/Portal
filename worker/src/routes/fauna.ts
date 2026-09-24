import { getEnv } from "../env.js";
import type { PortalUser } from "../auth.js";
import { fileStore, fromReal, sharepointBrowse } from "../files/store.js";
import { getStore } from "../compat/blobs.js";
import {
  openLog, ensureMonthTab, writeRows, saveLog, newMonthWorkbook, monthFileName, isMonthFile, type LogRow, type LogWorkbook,
} from "../lib/fauna-log.js";
import { settle, monthName } from "../../../source/fauna/fields.js";
import { XLSX_MIME } from "../../../source/shared/workbook.js";

/**
 * The Marine Fauna Observation Log, filled in on a phone.
 *
 *   GET  /api/fauna/sightings?month= the month's entries
 *   PUT  /api/fauna/sightings        save one (new or changed)
 *   DELETE /api/fauna/sightings/:id  take one off
 *   GET  /api/fauna/export?month=    the month as the office's own workbook
 *   POST /api/fauna/send             that workbook emailed to whoever is named
 *   GET  /api/fauna/log?month=       the month's workbook in SharePoint, and what is owed
 *   POST /api/fauna/log              write everything owed now
 *
 * The columns, which must be filled and what the phone can settle for itself
 * are in source/fauna/fields.js, which the phone runs too.
 *
 * Every saved entry is also written into the month's workbook in SharePoint
 * (SHAREPOINT_FAUNA_FOLDER, one file a month, lib/fauna-log.ts): straight
 * away on the save, and on the hour for anything that could not be written
 * then. A month with no workbook yet gets one made from the template.
 */

type FaunaRecord = Record<string, unknown>;

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

/* --------------------------------------------------------------- store --- */

let ready: Promise<unknown> | null = null;
export function ensureTable() {
  if (!ready) {
    ready = (async () => {
      const d1 = getEnv().DB;
      await d1
        .prepare(
          "CREATE TABLE IF NOT EXISTS fauna_sightings (" +
            "id TEXT PRIMARY KEY, month TEXT NOT NULL, at TEXT NOT NULL, observer TEXT, " +
            "data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, " +
            "written_at INTEGER, written_month TEXT, written_tab TEXT, written_row INTEGER, write_error TEXT)",
        )
        .run();
      // A table made before the log in SharePoint was thought of gets the
      // columns that say where each entry was written.
      const info = await d1.prepare("PRAGMA table_info(fauna_sightings)").all<{ name: string }>();
      const have = new Set((info.results || []).map((c) => c.name));
      for (const [col, type] of [["written_at", "INTEGER"], ["written_month", "TEXT"], ["written_tab", "TEXT"], ["written_row", "INTEGER"], ["write_error", "TEXT"]]) {
        if (have.has(col)) continue;
        try {
          await d1.prepare(`ALTER TABLE fauna_sightings ADD COLUMN ${col} ${type}`).run();
        } catch (e) {
          if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) throw e;
        }
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const now = () => Math.floor(Date.now() / 1000);
const monthOf = (r: FaunaRecord) => String(r.date || "").slice(0, 7);
const atOf = (r: FaunaRecord) => `${r.date || ""}T${r.time || "00:00"}`;
const isMonth = (s: string) => /^\d{4}-\d{2}$/.test(s);

type Row = {
  id: string; month: string; data: string; deleted_at: number | null;
  written_at: number | null; written_month: string | null; written_tab: string | null; written_row: number | null; write_error: string | null;
};
const ROW_COLS = "id, month, data, deleted_at, written_at, written_month, written_tab, written_row, write_error";

function entryOf(r: Row): FaunaRecord {
  let data: FaunaRecord = {};
  try { data = JSON.parse(r.data); } catch { /* an unreadable row still lists */ }
  return {
    ...data,
    id: r.id,
    inLog: r.written_row != null && !r.deleted_at && r.written_month === r.month
      ? { month: r.written_month, tab: r.written_tab, row: r.written_row, at: r.written_at } : null,
    logError: r.write_error || null,
  };
}

async function listMonth(month: string) {
  const rows = await getEnv()
    .DB.prepare(`SELECT ${ROW_COLS} FROM fauna_sightings WHERE month = ?1 AND deleted_at IS NULL ORDER BY at ASC`)
    .bind(month)
    .all<Row>();
  return (rows.results || []).map(entryOf);
}

/* ------------------------------------------------------------- entries --- */

async function saveOne(req: Request, user: PortalUser) {
  const body = (await req.json().catch(() => null)) as { record?: unknown } | null;
  const raw = body && body.record && typeof body.record === "object" ? (body.record as FaunaRecord) : null;
  if (!raw) return json({ error: "Nothing to save." }, 400);
  const record = settle(raw);
  const id = typeof raw.id === "string" && /^[a-z0-9-]{8,64}$/i.test(raw.id) ? raw.id : crypto.randomUUID();
  const month = monthOf(record);
  if (!isMonth(month)) return json({ error: "The entry has no date." }, 400);
  const stored: FaunaRecord = { ...record, id, savedBy: user.name, savedAt: new Date().toISOString() };
  for (const k of ["inLog", "logError", "pending"]) delete stored[k];
  await getEnv()
    .DB.prepare(
      "INSERT INTO fauna_sightings (id, month, at, observer, data, created_at, updated_at, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, NULL) " +
        "ON CONFLICT (id) DO UPDATE SET month = ?2, at = ?3, observer = ?4, data = ?5, updated_at = ?6, deleted_at = NULL",
    )
    .bind(id, month, atOf(record), String(record.observer || ""), JSON.stringify(stored), now())
    .run();
  // Into the month's workbook straight away; what cannot be written now is
  // owed, and the hour pays it.
  const log = await settleLog([id], user.name, new URL(req.url).origin);
  const row = await getEnv().DB.prepare(`SELECT ${ROW_COLS} FROM fauna_sightings WHERE id = ?1`).bind(id).first<Row>();
  return json({ saved: true, id, record: row ? entryOf(row) : { ...stored }, log });
}

async function removeOne(req: Request, id: string, user: PortalUser) {
  await getEnv().DB.prepare("UPDATE fauna_sightings SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1").bind(id, now()).run();
  const log = await settleLog([id], user.name, new URL(req.url).origin);
  return json({ removed: true, id, log });
}

/* ------------------------------------------------------ the month's file --- */

const LOG_LEASE_KEY = "fauna-log-lease";
const LOG_LEASE_MS = 3 * 60 * 1000;
const LOG_MAX_BYTES = 8 * 1024 * 1024;
// The template is served with the page; the assets binding goes by the
// path alone, so the origin only has to be a well-formed one.
const TEMPLATE_PATH = "/fauna/template.xlsx";
const ANY_ORIGIN = "https://coolibah-portal.com";

export type LogFile = { name: string; path: string; modified?: string };
export type LogOutcome =
  | { linked: false; why: string }
  | { linked: true; written: number; blanked: number; files: string[]; made: string[]; error?: string };

/** The folder the logs live in, as configured, or "" when the link is off. */
const logFolder = () => (getEnv().SHAREPOINT_FAUNA_FOLDER || "").replace(/^\/+|\/+$/g, "");
const linkOff = () => {
  if (!logFolder()) return "no folder is set for the log (SHAREPOINT_FAUNA_FOLDER)";
  if ((getEnv().FILE_STORE || "r2") !== "sharepoint") return "this deploy has no SharePoint";
  return null;
};

/** What the folder holds, or a plain word for why it could not be read. */
async function folderFiles(): Promise<{ name: string; path: string; modified?: string }[]> {
  const entries = await sharepointBrowse(logFolder()).catch((e) => {
    const said = e instanceof Error ? e.message : String(e);
    throw new Error(/isn't in the library|404/.test(said) ? `there is no ${logFolder()} folder in the library yet` : said);
  });
  return entries.filter((e) => !e.folder).map((e) => ({ name: e.name, path: e.path, modified: e.modified }));
}

/** The month's workbook in the folder, newest first where there is more than one, or null. */
export function monthFileIn(files: { name: string; path: string; modified?: string }[], month: string): LogFile | null {
  const mine = files.filter((f) => isMonthFile(f.name, month));
  if (!mine.length) return null;
  mine.sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
  return { name: mine[0].name, path: mine[0].path, modified: mine[0].modified };
}

async function templateBytes(origin: string) {
  const res = await getEnv().ASSETS.fetch(new Request(origin + TEMPLATE_PATH));
  if (!res.ok) throw new Error("the log template is not on the server (fauna/template.xlsx)");
  return await res.arrayBuffer();
}

/** The log held for one writer at a time, with the lease the round uses
 *  for the qualification workbook as the model. */
async function takeLogLease(by: string) {
  const leases = getStore("sync");
  const token = crypto.randomUUID();
  const lease = { until: Date.now() + LOG_LEASE_MS, by, token };
  const held = await leases.getWithMetadata(LOG_LEASE_KEY, { type: "json" });
  const running = held ? (held.data as { until: number } | null) : null;
  if (running && running.until > Date.now()) return null;
  if (!held) return (await leases.setJSONIfAbsent(LOG_LEASE_KEY, lease)).written ? token : null;
  return (await leases.setJSON(LOG_LEASE_KEY, lease, { onlyIfMatch: held.etag })).modified ? token : null;
}
async function dropLogLease(token: string) {
  const leases = getStore("sync");
  const held = await leases.getWithMetadata(LOG_LEASE_KEY, { type: "json" });
  const lease = held ? (held.data as { token: string } | null) : null;
  if (!held || !lease || lease.token !== token) return;
  await leases.setJSON(LOG_LEASE_KEY, { ...lease, until: 0 }, { onlyIfMatch: held.etag });
}

const owedSql =
  "(deleted_at IS NULL AND (written_at IS NULL OR updated_at > written_at OR written_month IS NOT month)) " +
  "OR (deleted_at IS NOT NULL AND written_row IS NOT NULL)";

/** How many entries the logs are still owed. */
export async function owedCount() {
  const row = await getEnv().DB.prepare(`SELECT COUNT(*) AS n FROM fauna_sightings WHERE ${owedSql}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The entries written into their months' workbooks in SharePoint: the ones
 * named, or every one still owed when none are. Each live entry lands in
 * its month's file — made from the template where the month has none —
 * in its own row where it has one, the first empty row otherwise. A removed
 * entry has its row blanked, and one moved to another month is blanked in
 * the file it left. One writer at a time; a second waits a little and then
 * leaves it to the hour.
 */
export async function settleLog(ids: string[] | null, by: string, origin = ANY_ORIGIN): Promise<LogOutcome> {
  const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const d1 = getEnv().DB;
  const off = linkOff();
  if (off) return { linked: false, why: off };

  const where = ids && ids.length
    ? `id IN (${ids.map((_, i) => `?${i + 1}`).join(", ")}) AND (${owedSql})`
    : owedSql;
  const owed = (await d1.prepare(`SELECT ${ROW_COLS} FROM fauna_sightings WHERE ${where}`).bind(...(ids || [])).all<Row>()).results || [];
  if (!owed.length) return { linked: true, written: 0, blanked: 0, files: [], made: [] };

  let token: string | null = null;
  for (let attempt = 0; attempt < 4 && !token; attempt++) {
    token = await takeLogLease(by);
    if (!token) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!token) {
    const why = "the log is being written by someone else; it will be tried again on the hour";
    await noteError(owed.map((r) => r.id), why);
    return { linked: true, written: 0, blanked: 0, files: [], made: [], error: why };
  }

  try {
    const files = await folderFiles();
    const store = fileStore();

    /* Month by month: the rows to write into that month's file, and the
       rows to blank there - removed entries, and entries that have moved
       to another month. */
    const writes = new Map<string, Row[]>();
    const blanks = new Map<string, Row[]>();
    const add = (map: Map<string, Row[]>, month: string, r: Row) => map.set(month, [...(map.get(month) || []), r]);
    for (const r of owed) {
      const hadRow = r.written_row != null && r.written_month && isMonth(r.written_month);
      if (r.deleted_at) { if (hadRow) add(blanks, r.written_month!, r); continue; }
      if (hadRow && r.written_month !== r.month) add(blanks, r.written_month!, r);
      add(writes, r.month, r);
    }
    const months = [...new Set([...writes.keys(), ...blanks.keys()])].sort();

    const touched: string[] = [];
    const made: string[] = [];
    const placed = new Map<string, { month: string; tab: string; row: number }>();
    const cleared = new Set<string>();
    for (const month of months) {
      const toWrite = writes.get(month) || [];
      const toBlank = blanks.get(month) || [];
      let file = monthFileIn(files, month);
      let log: LogWorkbook;
      if (file) {
        const bytes = await store.get(fromReal(file.path), { type: "arrayBuffer" });
        if (!bytes) throw new Error(`${file.name} could not be read from the library`);
        if (bytes.byteLength > LOG_MAX_BYTES) throw new Error(`${file.name} is ${Math.round(bytes.byteLength / 1024 / 1024)} MB, too big to rewrite here`);
        log = await openLog(bytes);
      } else {
        // Only blanks owed to a file that is not there: nothing to blank.
        if (!toWrite.length) { toBlank.forEach((r) => cleared.add(r.id)); continue; }
        log = await newMonthWorkbook(await templateBytes(origin), month);
        const name = monthFileName(month);
        file = { name, path: `${logFolder()}/${name}` };
        made.push(name);
      }
      const tab = await ensureMonthTab(log, month);
      const live: LogRow[] = toWrite.map((r) => {
        let values: FaunaRecord = {};
        try { values = JSON.parse(r.data); } catch { /* written as blank */ }
        return { id: r.id, values, row: r.written_month === month && r.written_tab === tab.name ? r.written_row : null };
      });
      const blankRows = toBlank.filter((r) => r.written_tab === tab.name).map((r) => r.written_row!);
      const out = await writeRows(log, tab.path, live, blankRows);
      await store.set(fromReal(file.path), await saveLog(log));
      touched.push(file.name);
      for (const [id, row] of Object.entries(out.placed)) placed.set(id, { month, tab: tab.name, row });
      toBlank.forEach((r) => cleared.add(r.id));
    }

    const at = now();
    const marks = [
      ...[...placed].map(([id, p]) =>
        d1.prepare("UPDATE fauna_sightings SET written_at = ?2, written_month = ?3, written_tab = ?4, written_row = ?5, write_error = NULL WHERE id = ?1")
          .bind(id, at, p.month, p.tab, p.row)),
      ...[...cleared].filter((id) => !placed.has(id)).map((id) =>
        d1.prepare("UPDATE fauna_sightings SET written_at = ?2, written_month = NULL, written_tab = NULL, written_row = NULL, write_error = NULL WHERE id = ?1").bind(id, at)),
    ];
    if (marks.length) await d1.batch(marks);
    return { linked: true, written: placed.size, blanked: [...cleared].filter((id) => !placed.has(id)).length, files: touched, made };
  } catch (e) {
    const why = said(e);
    await noteError(owed.map((r) => r.id), why);
    console.error("the fauna log could not be written:", e);
    return { linked: true, written: 0, blanked: 0, files: [], made: [], error: why };
  } finally {
    await dropLogLease(token).catch(() => {});
  }
}

async function noteError(ids: string[], why: string) {
  if (!ids.length) return;
  const d1 = getEnv().DB;
  await d1.batch(ids.map((id) => d1.prepare("UPDATE fauna_sightings SET write_error = ?2 WHERE id = ?1").bind(id, why.slice(0, 400))));
}

/** What the app shows about the link, for one month. */
export async function logStatus(month: string) {
  const folder = logFolder();
  const owed = await owedCount();
  const off = linkOff();
  if (off) return { linked: false, folder, month, file: null, owed, why: off };
  try {
    const file = monthFileIn(await folderFiles(), month);
    return { linked: true, folder, month, file: file ? file.name : null, modified: file?.modified || null, owed };
  } catch (e) {
    return { linked: false, folder, month, file: null, owed, why: e instanceof Error ? e.message : String(e) };
  }
}

/* -------------------------------------------------------------- export --- */

/**
 * The month as the office's own workbook, for the download button: the
 * template with the tab named for the month and the entries written under
 * the header in time order.
 */
export async function exportMonth(template: ArrayBuffer, month: string, entries: FaunaRecord[]) {
  const log = await newMonthWorkbook(template, month);
  const tab = await ensureMonthTab(log, month);
  const sorted = [...entries].sort((a, b) => atOf(a).localeCompare(atOf(b)));
  await writeRows(log, tab.path, sorted.map((e, i) => ({ id: String(e.id || i), values: e, row: null })));
  return await saveLog(log);
}

/* --------------------------------------------------------------- route --- */

export default async (req: Request, user: PortalUser, path: string): Promise<Response> => {
  await ensureTable();
  const url = new URL(req.url);
  const thisMonth = new Date().toISOString().slice(0, 7);

  if (path === "/api/fauna/sightings") {
    if (req.method === "GET") {
      const month = url.searchParams.get("month") || thisMonth;
      if (!isMonth(month)) return json({ error: "The month is YYYY-MM." }, 400);
      return json({ month, entries: await listMonth(month) });
    }
    if (req.method === "PUT" || req.method === "POST") return await saveOne(req, user);
  }
  const one = /^\/api\/fauna\/sightings\/([a-z0-9-]+)$/i.exec(path);
  if (one && req.method === "DELETE") return await removeOne(req, one[1], user);

  if (path === "/api/fauna/log") {
    const month = url.searchParams.get("month") || thisMonth;
    if (!isMonth(month)) return json({ error: "The month is YYYY-MM." }, 400);
    if (req.method === "GET") return json(await logStatus(month));
    if (req.method === "POST") return json({ ...(await settleLog(null, user.name, url.origin)), owed: await owedCount() });
  }

  if (path === "/api/fauna/export" && req.method === "GET") {
    const month = url.searchParams.get("month") || thisMonth;
    if (!isMonth(month)) return json({ error: "The month is YYYY-MM." }, 400);
    try {
      const bytes = await exportMonth(await templateBytes(url.origin), month, await listMonth(month));
      return new Response(bytes, {
        headers: {
          ...NO_STORE,
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${monthFileName(month)}"`,
        },
      });
    } catch (e) {
      return json({ error: `The log could not be written: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
  }

  // The month's workbook emailed on, from the portal's own address, to
  // whoever the person names - their decision, made on the phone.
  if (path === "/api/fauna/send" && req.method === "POST") return await sendMonth(req, user);

  return json({ error: `No such endpoint: ${path}` }, 404);
};

/* ---------------------------------------------------------------- send --- */

/** The addresses typed into the To box: separated by commas, semicolons or
 *  spaces; anything that is not an address is left out and named. */
export function recipients(raw: unknown): { to: string[]; bad: string[] } {
  const parts = String(raw ?? "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const to: string[] = [];
  const bad: string[] = [];
  for (const p of parts) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p)) { if (!to.includes(p.toLowerCase())) to.push(p.toLowerCase()); }
    else bad.push(p);
  }
  return { to, bad };
}

async function sendMonth(req: Request, user: PortalUser) {
  const env = getEnv();
  const body = (await req.json().catch(() => null)) as { month?: unknown; to?: unknown; note?: unknown } | null;
  const month = typeof body?.month === "string" ? body.month : "";
  if (!isMonth(month)) return json({ error: "The month is YYYY-MM." }, 400);
  const { to, bad } = recipients(body?.to);
  if (bad.length) return json({ error: `Not an email address: ${bad.join(", ")}` }, 400);
  if (!to.length) return json({ error: "Who is it going to? Type an email address." }, 400);
  if (to.length > 10) return json({ error: "Ten addresses at most." }, 400);
  if (!env.EMAIL) return json({ error: "Email sending isn't switched on for this deploy." }, 503);

  const url = new URL(req.url);
  const entries = await listMonth(month);
  let bytes: ArrayBuffer;
  try {
    bytes = await exportMonth(await templateBytes(url.origin), month, entries);
  } catch (e) {
    return json({ error: `The spreadsheet could not be made: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
  const filename = monthFileName(month);
  const title = `${monthName(month)} ${month.slice(0, 4)}`;
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 1000) : "";
  const count = entries.length;
  try {
    await env.EMAIL.send({
      to,
      from: { name: "TSV Coolibah Crew Portal", email: "portal@coolibah-portal.com" },
      replyTo: user.email,
      subject: `Marine Fauna Observation Log - ${title} - MinRes Coolibah`,
      text:
        `Attached is the Marine Fauna Observation Log for ${title} from the MinRes Coolibah` +
        ` (${count} ${count === 1 ? "entry" : "entries"}), sent by ${user.name} from the vessel's crew portal.` +
        (note ? `\n\n${note}` : "") +
        `\n\nReplies go to ${user.email}.`,
      attachments: [{ disposition: "attachment", filename, type: XLSX_MIME, content: bytes }],
    });
  } catch (e) {
    return json({ error: `The email was not sent: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
  console.log(`fauna log ${filename} emailed to ${to.join(", ")} by ${user.email}`);
  return json({ sent: true, to, filename });
}
