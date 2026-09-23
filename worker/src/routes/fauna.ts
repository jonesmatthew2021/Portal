import { getEnv } from "../env.js";
import type { PortalUser } from "../auth.js";
import { fileStore, fromReal, sharepointBrowse } from "../files/store.js";
import { getStore } from "../compat/blobs.js";
import { openLog, ensureMonthTab, writeRows, saveLog, type LogRow } from "../lib/fauna-log.js";
import {
  FIELDS, blankRecord, settle, mergeParsed, missingFields, nextQuestion, modelSchema, fieldSpecText,
  monthName, sheetValue, windKmh, parseSpoken, isBlank,
} from "../../../source/fauna/fields.js";
import {
  readZip, writeZip, partOf, partText, setPartText, readSheet, writeSheet, putCell, listSheets,
  colOf, xmlEsc,
} from "../../../source/shared/workbook.js";

/**
 * The Marine Fauna Observation Log, spoken into a phone.
 *
 *   POST /api/fauna/parse            what was said, read into the log's columns
 *   GET  /api/fauna/sightings?month= the month's entries
 *   PUT  /api/fauna/sightings        save one (new or changed)
 *   DELETE /api/fauna/sightings/:id  take one off
 *   GET  /api/fauna/export?month=    the month as the office's own workbook
 *   GET  /api/fauna/log              the log in SharePoint, and what is owed to it
 *   POST /api/fauna/log              write everything owed to it now
 *
 * The columns, the rules about which must be filled and the questions to ask
 * are in source/fauna/fields.js, which the phone runs too. The model reads the
 * sentence; where it can't be reached the phone reads it with the same rules
 * file and says so.
 *
 * Every saved entry is also written into the office's workbook in SharePoint
 * (SHAREPOINT_FAUNA_FOLDER, lib/fauna-log.ts): straight away on the save, and
 * on the hour for anything that could not be written then.
 */

type FaunaRecord = Record<string, unknown>;

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

export const MODEL = "claude-opus-5";
const PARSE_TIMEOUT_MS = 25000;
const MAX_TOKENS = 4000;

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
            "written_at INTEGER, written_tab TEXT, written_row INTEGER, write_error TEXT)",
        )
        .run();
      // A table made before the log in SharePoint was thought of gets the
      // columns that say where each entry was written.
      const info = await d1.prepare("PRAGMA table_info(fauna_sightings)").all<{ name: string }>();
      const have = new Set((info.results || []).map((c) => c.name));
      for (const [col, type] of [["written_at", "INTEGER"], ["written_tab", "TEXT"], ["written_row", "INTEGER"], ["write_error", "TEXT"]]) {
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

type Row = {
  id: string; month: string; data: string; deleted_at: number | null;
  written_at: number | null; written_tab: string | null; written_row: number | null; write_error: string | null;
};
const ROW_COLS = "id, month, data, deleted_at, written_at, written_tab, written_row, write_error";

function entryOf(r: Row): FaunaRecord {
  let data: FaunaRecord = {};
  try { data = JSON.parse(r.data); } catch { /* an unreadable row still lists */ }
  return {
    ...data,
    id: r.id,
    inLog: r.written_row != null && !r.deleted_at ? { tab: r.written_tab, row: r.written_row, at: r.written_at } : null,
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

/* --------------------------------------------------------------- model --- */

const SYSTEM = `You fill in a vessel's Marine Fauna Observation Log from what a bridge watchkeeper says out loud. The vessel is the MinRes Coolibah, a transhipment vessel off Onslow, Western Australia.

Read the transcript and return every column you can, as JSON matching the schema. Rules:
- Keep every value already in the current record unless the speaker plainly changes it ("no, make that three", "actually 500 metres").
- Leave a column null when the speaker did not say it and it cannot be worked out from what they said. Never invent conditions, counts or distances.
- Speech recognition mangles words: "hump back" is Humpback, "snub fin" is Snubfin, "bottle nose" is Bottlenose, "hawks bill" is Hawksbill, "dew gong" is Dugong.
- Head count: "two adults and a calf" is total 3, adults 2, calves 1. "A whale" is total 1. "Pod of six" is total 6. A calf, juvenile or pup counts under calves.
- Relative bearing is degrees from the bow: dead ahead 0, starboard bow 45, starboard beam 90, starboard quarter 135, astern 180, port quarter 225, port beam 270, port bow 315. "Green 40" is 40, "red 20" is 340. "Fine on the starboard bow" is about 20, "broad on the port bow" about 300.
- Distances in metres: "half a k" is 500, "one k" is 1000, "two cables" is 370, "a mile" is 1852.
- Wind: give the speed as said and the unit it was said in (mariners say knots); the app converts. Wind direction is a compass point: N, NNE, NE, ENE, E, ESE, SE, SSE, S, SSW, SW, WSW, W, WNW, NW, NNW, or Variable.
- Vessel activity: underway, steaming or on passage is Transiting; moored or alongside is Mooring; discharging or unloading is Discharging; loading is Loading. Anchored, berthing or drifting may be written as said.
- Behaviour: moving somewhere is Travelling; feeding or hunting is Foraging; still at the surface is Resting; breaching, playing, bow-riding or interacting is Socialising.
- Condition defaults to Calm only if the speaker describes the animal as fine; entangled or struggling is Distressed; wounded is Injured; dead is Deceased. Otherwise leave it null.
- Species certainty: hedged words (possibly, not sure, looked like, I think) are Uncertain; a plain statement of species is Certain.
- Action taken: what the vessel did, in a few words, e.g. "Altered course to stbd", "Reduced speed", "Monitored position", "None". Stop work is Yes only if work or operations were stopped.
- "Nothing seen", "nil sightings", "no fauna" means kind is "nil".
- Comments: anything observed that no column holds, in the speaker's own words, briefly. Do not repeat what the columns already say.
- If the transcript is an answer to a question the app just asked (given as "focus"), put a bare answer into that column.

The columns:
${fieldSpecText()}`;

class ModelUnavailable extends Error {}

async function askModel(transcript: string, record: FaunaRecord, focus: string[] | null, lastConditions: FaunaRecord | null) {
  const env = getEnv();
  const key = env.ANTHROPIC_API_KEY;
  const base = (env.ANTHROPIC_BASE_URL || "").replace(/\/+$/, "");
  if (!key || !base) throw new ModelUnavailable("AI is not switched on for this deploy - set the ANTHROPIC_API_KEY secret on the worker.");

  const current: FaunaRecord = {};
  for (const f of FIELDS) if (!isBlank(record[f.key])) current[f.key] = record[f.key];
  const parts = [
    `Current record (already filled in): ${JSON.stringify({ kind: record.kind || "sighting", ...current })}`,
    focus && focus.length ? `The app just asked for: ${focus.join(", ")}. The transcript answers that.` : "",
    lastConditions ? `The previous entry's conditions, to copy only if the speaker says the conditions are the same or unchanged: ${JSON.stringify(lastConditions)}` : "",
    `Transcript: ${JSON.stringify(transcript)}`,
  ].filter(Boolean).join("\n\n");

  const stopwatch = new AbortController();
  const deadline = setTimeout(() => stopwatch.abort(), PARSE_TIMEOUT_MS);
  try {
    const send = () =>
      fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          thinking: { type: "adaptive" },
          output_config: { effort: "low", format: { type: "json_schema", schema: modelSchema() } },
          system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: parts }],
        }),
        signal: stopwatch.signal,
      });
    let res = await send();
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
      res = await send();
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`the model answered ${res.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await res.json()) as {
      stop_reason?: string;
      content?: { type: string; text?: string }[];
    };
    if (body.stop_reason === "refusal") throw new Error("the model declined to read that");
    const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("");
    if (!text.trim()) throw new Error("the model sent nothing back");
    const parsed = JSON.parse(text) as FaunaRecord;
    // Wind as said, in the log's km/h.
    if (parsed.windSpeed != null) {
      parsed.windSpeed = windKmh(Number(parsed.windSpeed), typeof parsed.windSpeedUnit === "string" ? parsed.windSpeedUnit : null);
    }
    delete parsed.windSpeedUnit;
    return parsed;
  } finally {
    clearTimeout(deadline);
  }
}

/* ------------------------------------------------------------- parsing --- */

async function parse(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    transcript?: unknown; record?: unknown; focus?: unknown; locked?: unknown;
    lastConditions?: unknown; latDec?: unknown; lonDec?: unknown; tzHours?: unknown;
  } | null;
  const transcript = body && typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) return json({ error: "Nothing was said." }, 400);
  const record: FaunaRecord = { ...blankRecord(), ...(body && body.record && typeof body.record === "object" ? (body.record as FaunaRecord) : {}) };
  const focus = Array.isArray(body?.focus) ? (body!.focus as unknown[]).filter((k): k is string => typeof k === "string") : null;
  const locked = Array.isArray(body?.locked) ? (body!.locked as unknown[]).filter((k): k is string => typeof k === "string") : [];
  const lastConditions = body && body.lastConditions && typeof body.lastConditions === "object" ? (body.lastConditions as FaunaRecord) : null;
  const ctx = {
    latDec: typeof body?.latDec === "number" ? body!.latDec as number : null,
    lonDec: typeof body?.lonDec === "number" ? body!.lonDec as number : null,
    tzHours: typeof body?.tzHours === "number" ? body!.tzHours as number : 8,
  };

  let parsed: FaunaRecord;
  let by = "model";
  try {
    parsed = await askModel(transcript, record, focus, lastConditions);
  } catch (e) {
    // The rules on the phone are the fallback here too, so the answer is the
    // same one the phone would have reached on its own — and it says why.
    by = e instanceof ModelUnavailable ? "rules (AI not switched on)" : `rules (${e instanceof Error ? e.message : String(e)})`;
    parsed = parseSpoken(transcript, record, { focus });
    if (/\b(same|unchanged|as before|no change)\b/i.test(transcript) && /condition|weather/i.test(transcript) && lastConditions) {
      for (const [k, v] of Object.entries(lastConditions)) if (isBlank(record[k]) && !isBlank(v)) parsed[k] = v;
    }
  }
  const merged = settle(mergeParsed(record, parsed, locked), ctx);
  return json({ record: merged, missing: missingFields(merged), question: nextQuestion(merged), by });
}

/* ------------------------------------------------------------- entries --- */

async function saveOne(req: Request, user: PortalUser) {
  const body = (await req.json().catch(() => null)) as { record?: unknown } | null;
  const raw = body && body.record && typeof body.record === "object" ? (body.record as FaunaRecord) : null;
  if (!raw) return json({ error: "Nothing to save." }, 400);
  const record = settle(raw);
  const id = typeof raw.id === "string" && /^[a-z0-9-]{8,64}$/i.test(raw.id) ? raw.id : crypto.randomUUID();
  const month = monthOf(record);
  if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: "The entry has no date." }, 400);
  const stored: FaunaRecord = { ...record, id, savedBy: user.name, savedAt: new Date().toISOString(), transcript: raw.transcript || null };
  delete stored.inLog;
  delete stored.logError;
  await getEnv()
    .DB.prepare(
      "INSERT INTO fauna_sightings (id, month, at, observer, data, created_at, updated_at, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, NULL) " +
        "ON CONFLICT (id) DO UPDATE SET month = ?2, at = ?3, observer = ?4, data = ?5, updated_at = ?6, deleted_at = NULL",
    )
    .bind(id, month, atOf(record), String(record.observer || ""), JSON.stringify(stored), now())
    .run();
  // Into the office's workbook straight away; what cannot be written now is
  // owed, and the hour pays it.
  const log = await settleLog([id], user.name);
  const row = await getEnv().DB.prepare(`SELECT ${ROW_COLS} FROM fauna_sightings WHERE id = ?1`).bind(id).first<Row>();
  return json({ saved: true, id, record: row ? entryOf(row) : { ...stored }, log });
}

async function removeOne(id: string, user: PortalUser) {
  await getEnv().DB.prepare("UPDATE fauna_sightings SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1").bind(id, now()).run();
  const log = await settleLog([id], user.name);
  return json({ removed: true, id, log });
}

/* -------------------------------------------------------- the log file --- */

const LOG_LEASE_KEY = "fauna-log-lease";
const LOG_LEASE_MS = 3 * 60 * 1000;
const LOG_MAX_BYTES = 8 * 1024 * 1024;

export type LogFile = { key: string; name: string; path: string; modified?: string };
export type LogOutcome =
  | { linked: false; why: string }
  | { linked: true; file: string; written: number; blanked: number; made: string[]; error?: string };

/** The folder the log lives in, as configured, or "" when the link is off. */
const logFolder = () => (getEnv().SHAREPOINT_FAUNA_FOLDER || "").replace(/^\/+|\/+$/g, "");

/**
 * The log in the library: the newest workbook in the folder whose name says
 * fauna. Null where the link is off or nothing is there yet.
 */
export async function findLog(): Promise<LogFile | null> {
  const folder = logFolder();
  if (!folder) return null;
  if ((getEnv().FILE_STORE || "r2") !== "sharepoint") return null;
  const entries = await sharepointBrowse(folder);
  const files = entries.filter((e) => !e.folder && /fauna/i.test(e.name) && /\.xlsx$/i.test(e.name) && !/^~/.test(e.name));
  if (!files.length) return null;
  files.sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
  const best = files[0];
  return { key: fromReal(best.path), name: best.name, path: best.path, modified: best.modified };
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
  "(deleted_at IS NULL AND (written_at IS NULL OR updated_at > written_at)) OR (deleted_at IS NOT NULL AND written_row IS NOT NULL)";

/** How many entries the log is still owed. */
export async function owedCount() {
  const row = await getEnv().DB.prepare(`SELECT COUNT(*) AS n FROM fauna_sightings WHERE ${owedSql}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The entries written into the log in SharePoint: the ones named, or every
 * one still owed when none are. Each live entry lands in its month's tab —
 * its own row where it has one, the first empty row otherwise — and each
 * removed one has its row blanked. One writer at a time; a second waits a
 * little and then leaves it to the hour.
 */
export async function settleLog(ids: string[] | null, by: string): Promise<LogOutcome> {
  const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const d1 = getEnv().DB;
  const folder = logFolder();
  if (!folder) return { linked: false, why: "no folder is set for the log (SHAREPOINT_FAUNA_FOLDER)" };
  if ((getEnv().FILE_STORE || "r2") !== "sharepoint") return { linked: false, why: "this deploy has no SharePoint" };

  const where = ids && ids.length
    ? `id IN (${ids.map((_, i) => `?${i + 1}`).join(", ")}) AND (${owedSql})`
    : owedSql;
  const owed = (await d1.prepare(`SELECT ${ROW_COLS} FROM fauna_sightings WHERE ${where}`).bind(...(ids || [])).all<Row>()).results || [];

  let file: LogFile | null;
  try {
    file = await findLog();
  } catch (e) {
    const why = `the log's folder could not be read: ${said(e)}`;
    if (owed.length) await noteError(owed.map((r) => r.id), why);
    return { linked: false, why };
  }
  if (!file) {
    const why = `no Marine Fauna Observation Log workbook in ${folder}`;
    if (owed.length) await noteError(owed.map((r) => r.id), why);
    return { linked: false, why };
  }
  if (!owed.length) return { linked: true, file: file.name, written: 0, blanked: 0, made: [] };

  let token: string | null = null;
  for (let attempt = 0; attempt < 4 && !token; attempt++) {
    token = await takeLogLease(by);
    if (!token) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!token) {
    const why = "the log is being written by someone else; it will be tried again on the hour";
    await noteError(owed.map((r) => r.id), why);
    return { linked: true, file: file.name, written: 0, blanked: 0, made: [], error: why };
  }

  try {
    const store = fileStore();
    const bytes = await store.get(file.key, { type: "arrayBuffer" });
    if (!bytes) throw new Error(`${file.name} could not be read from the library`);
    if (bytes.byteLength > LOG_MAX_BYTES) throw new Error(`${file.name} is ${Math.round(bytes.byteLength / 1024 / 1024)} MB, too big to rewrite here`);
    const log = await openLog(bytes);

    // Month by month: the tab, the rows that go in it, the rows to blank.
    const byMonth = new Map<string, Row[]>();
    for (const r of owed) {
      const key = r.deleted_at && r.written_tab ? tabMonth(r.written_tab, r.month) : r.month;
      byMonth.set(key, [...(byMonth.get(key) || []), r]);
    }
    const made: string[] = [];
    const placed = new Map<string, { tab: string; row: number }>();
    const blanked: string[] = [];
    for (const [month, rows] of byMonth) {
      const tab = await ensureMonthTab(log, month);
      if (tab.made) made.push(tab.name);
      const live: LogRow[] = [];
      const blank: number[] = [];
      for (const r of rows) {
        if (r.deleted_at) {
          if (r.written_row != null && r.written_tab === tab.name) { blank.push(r.written_row); blanked.push(r.id); }
          else blanked.push(r.id);
          continue;
        }
        let values: FaunaRecord = {};
        try { values = JSON.parse(r.data); } catch { /* written as blank */ }
        live.push({ id: r.id, values, row: r.written_tab === tab.name ? r.written_row : null });
      }
      const out = await writeRows(log, tab.path, live, blank);
      for (const [id, row] of Object.entries(out.placed)) placed.set(id, { tab: tab.name, row });
    }

    await store.set(file.key, await saveLog(log));

    const at = now();
    const marks = [
      ...[...placed].map(([id, p]) =>
        d1.prepare("UPDATE fauna_sightings SET written_at = ?2, written_tab = ?3, written_row = ?4, write_error = NULL WHERE id = ?1").bind(id, at, p.tab, p.row)),
      ...blanked.map((id) =>
        d1.prepare("UPDATE fauna_sightings SET written_at = ?2, written_tab = NULL, written_row = NULL, write_error = NULL WHERE id = ?1").bind(id, at)),
    ];
    if (marks.length) await d1.batch(marks);
    return { linked: true, file: file.name, written: placed.size, blanked: blanked.length, made };
  } catch (e) {
    const why = said(e);
    await noteError(owed.map((r) => r.id), why);
    console.error("the fauna log could not be written:", e);
    return { linked: true, file: file.name, written: 0, blanked: 0, made: [], error: why };
  } finally {
    await dropLogLease(token).catch(() => {});
  }
}

/** A removed entry's tab as a month key, so its blanking is grouped with
 *  that tab's writes; the entry's own month when the tab is not a month. */
function tabMonth(tab: string, fallback: string) {
  const idx = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
    .indexOf(tab.trim().toLowerCase());
  return idx >= 0 ? `${fallback.slice(0, 4)}-${String(idx + 1).padStart(2, "0")}` : fallback;
}

async function noteError(ids: string[], why: string) {
  if (!ids.length) return;
  const d1 = getEnv().DB;
  await d1.batch(ids.map((id) => d1.prepare("UPDATE fauna_sightings SET write_error = ?2 WHERE id = ?1").bind(id, why.slice(0, 400))));
}

/** What the SharePoint page and the app show about the link. */
export async function logStatus() {
  const folder = logFolder();
  const owed = await owedCount();
  if (!folder) return { linked: false, folder: "", file: null, owed, why: "no folder is set for the log" };
  if ((getEnv().FILE_STORE || "r2") !== "sharepoint") return { linked: false, folder, file: null, owed, why: "this deploy has no SharePoint" };
  try {
    const file = await findLog();
    if (!file) return { linked: false, folder, file: null, owed, why: `no Marine Fauna Observation Log workbook in ${folder}` };
    return { linked: true, folder, file: file.name, modified: file.modified || null, owed };
  } catch (e) {
    return { linked: false, folder, file: null, owed, why: e instanceof Error ? e.message : String(e) };
  }
}

/* -------------------------------------------------------------- export --- */

/**
 * The office's own log with the month's entries written in. The template is
 * the MinRes workbook with one month tab and the hidden lists tab, made by
 * tools/fauna-template.mjs; the tab is renamed for the month asked for and
 * the rows go in under the header exactly as a hand would type them.
 */
export async function exportMonth(template: ArrayBuffer, month: string, entries: FaunaRecord[]) {
  const entriesZip = readZip(template);
  const wbPart = partOf(entriesZip, "xl/workbook.xml");
  const relsPart = partOf(entriesZip, "xl/_rels/workbook.xml.rels");
  if (!wbPart || !relsPart) throw new Error("the template has no workbook in it");
  let wbXml = await partText(wbPart);
  const sheets = listSheets(wbXml, await partText(relsPart));
  const tab = sheets.find((s) => s.name !== "Sheet1") || sheets[0];
  if (!tab) throw new Error("the template has no month tab");
  const name = monthName(month) || month;
  // The tab and its print area take the month's name.
  wbXml = wbXml.replace(/<sheet\b[^>]*>/g, (t) => (t.includes(`name="${xmlEsc(tab.name)}"`) ? t.replace(/name="[^"]*"/, `name="${xmlEsc(name)}"`) : t));
  wbXml = wbXml.replace(new RegExp(`>${xmlEsc(tab.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}!`, "g"), `>${xmlEsc(name)}!`)
    .replace(new RegExp(`>'${xmlEsc(tab.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'!`, "g"), `>'${xmlEsc(name)}'!`);
  await setPartText(wbPart, wbXml);
  const app = partOf(entriesZip, "docProps/app.xml");
  if (app) await setPartText(app, (await partText(app)).split(`<vt:lpstr>${xmlEsc(tab.name)}</vt:lpstr>`).join(`<vt:lpstr>${xmlEsc(name)}</vt:lpstr>`)
    .split(`<vt:lpstr>${xmlEsc(tab.name)}!`).join(`<vt:lpstr>${xmlEsc(name)}!`));

  const sheetPart = partOf(entriesZip, tab.path);
  if (!sheetPart) throw new Error("the template's month tab is missing");
  const sheet = readSheet(await partText(sheetPart));
  const header = sheet.rows.find((r) => r.num === 15);
  if (!header) throw new Error("the template's header row is not where the log keeps it");
  const firstRow = 16;
  // Entries in time order, each into the next row under the header. The
  // rows already exist in the template with the office's cell styles, so a
  // value goes into the cell that is there and keeps its look.
  const sorted = [...entries].sort((a, b) => atOf(a).localeCompare(atOf(b)));
  const styleOf = (rowNum: number, col: number) => {
    const row = sheet.rows.find((r) => r.num === rowNum) || sheet.rows.find((r) => r.num === firstRow + 1);
    const cell = row?.cells.find((c) => c.col === col);
    return cell ? cell.s : null;
  };
  sorted.forEach((entry, i) => {
    const num = firstRow + i;
    let row = sheet.rows.find((r) => r.num === num);
    if (!row) {
      const pattern = sheet.rows.find((r) => r.num === firstRow + 1) || sheet.rows[sheet.rows.length - 1];
      row = { num, open: pattern.open.replace(/\br="\d+"/, `r="${num}"`), cells: [], gaps: [""], raw: "", dirty: true };
      sheet.rows.push(row);
      sheet.gaps.push("");
    }
    for (const f of FIELDS) {
      const col = colOf(f.col + "1");
      const val = sheetValue(f.key, entry[f.key]);
      putCell(row, col, `${f.col}${num}`, styleOf(num, col) ?? styleOf(firstRow + 1, col), val);
    }
  });
  await setPartText(sheetPart, writeSheet(sheet));
  return writeZip(entriesZip);
}

async function templateBytes(req: Request) {
  const url = new URL("/fauna/template.xlsx", req.url);
  const res = await getEnv().ASSETS.fetch(new Request(url.toString()));
  if (!res.ok) throw new Error("the log template is not on the server (fauna/template.xlsx)");
  return await res.arrayBuffer();
}

/* --------------------------------------------------------------- route --- */

export default async (req: Request, user: PortalUser, path: string): Promise<Response> => {
  await ensureTable();
  const url = new URL(req.url);

  if (path === "/api/fauna/parse" && req.method === "POST") return await parse(req);

  if (path === "/api/fauna/sightings") {
    if (req.method === "GET") {
      const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: "The month is YYYY-MM." }, 400);
      return json({ month, entries: await listMonth(month) });
    }
    if (req.method === "PUT" || req.method === "POST") return await saveOne(req, user);
  }
  const one = /^\/api\/fauna\/sightings\/([a-z0-9-]+)$/i.exec(path);
  if (one && req.method === "DELETE") return await removeOne(one[1], user);

  if (path === "/api/fauna/log") {
    if (req.method === "GET") return json(await logStatus());
    if (req.method === "POST") return json({ ...(await settleLog(null, user.name)), owed: await owedCount() });
  }

  if (path === "/api/fauna/export" && req.method === "GET") {
    const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: "The month is YYYY-MM." }, 400);
    try {
      const blob = await exportMonth(await templateBytes(req), month, await listMonth(month));
      const filename = `${month} - Marine Fauna Observation Log - Coolibah.xlsx`;
      return new Response(blob, {
        headers: {
          ...NO_STORE,
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    } catch (e) {
      return json({ error: `The log could not be written: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
  }

  return json({ error: `No such endpoint: ${path}` }, 404);
};
