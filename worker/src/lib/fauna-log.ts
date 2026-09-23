import {
  readZip, writeZip, partOf, partText, setPartText, readSheet, writeSheet, putCell, listSheets, colOf, xmlEsc,
  type ZipEntry,
} from "../../../source/shared/workbook.js";
import { FIELDS, sheetValue, monthName, isBlank } from "../../../source/fauna/fields.js";

/**
 * The office's Marine Fauna Observation Log, written in place.
 *
 * The log is one workbook with a tab per month, all the same shape: the zone
 * table and the header on rows 1-15, entries from row 16 down, and a hidden
 * Sheet1 holding the dropdown lists. This writes a month's entries into the
 * month's tab exactly as a hand would type them, in the cells that are
 * already there with the office's own styles, and touches nothing else in
 * the file. Where the month has no tab yet, the latest month's tab is copied
 * — the way the office starts a month — emptied, and put in after it.
 *
 * Every row the portal writes is remembered by number (fauna_sightings.
 * written_row), so an entry that changes is rewritten in its own row, one
 * that is removed has its row blanked, and a row the office typed by hand is
 * never touched: the portal only ever writes rows it placed itself, or the
 * first empty row under the header.
 */

export const HEADER_ROW = 15;
export const FIRST_ROW = 16;
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type LogWorkbook = {
  entries: ZipEntry[];
  sheets: { name: string; path: string }[];
};

export type LogRow = {
  id: string;
  values: Record<string, unknown>;
  /** The row this entry was written to before, if it was. */
  row: number | null;
};

const guid = () => `{${crypto.randomUUID().toUpperCase()}}`;
const freshUids = (xml: string) => xml.replace(/((?:xr|xr3):uid=")\{[^}]*\}(")/g, (_m, a, b) => a + guid() + b);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function openLog(bytes: ArrayBuffer): Promise<LogWorkbook> {
  const entries = readZip(bytes);
  const wb = partOf(entries, "xl/workbook.xml");
  const rels = partOf(entries, "xl/_rels/workbook.xml.rels");
  if (!wb || !rels) throw new Error("the log is not a workbook");
  const sheets = listSheets(await partText(wb), await partText(rels));
  return { entries, sheets };
}

export async function saveLog(log: LogWorkbook): Promise<ArrayBuffer> {
  return await writeZip(log.entries).arrayBuffer();
}

/** The month tabs the log has, with the month each one is. */
export function monthTabs(log: LogWorkbook) {
  return log.sheets
    .map((s) => ({ ...s, month: MONTHS.indexOf(s.name.trim()) + 1 }))
    .filter((s) => s.month > 0);
}

/**
 * The tab for a month, made from the latest month's tab when the log has
 * none. `made` says whether it was.
 * @param yyyyMm the month, "2026-09"
 */
export async function ensureMonthTab(log: LogWorkbook, yyyyMm: string): Promise<{ name: string; path: string; made: boolean }> {
  const name = monthName(yyyyMm);
  if (!name) throw new Error(`${yyyyMm} is not a month`);
  const have = log.sheets.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
  if (have) return { name: have.name, path: have.path, made: false };

  const tabs = monthTabs(log);
  if (!tabs.length) throw new Error("the log has no month tab to copy from");
  const source = tabs.reduce((a, b) => (b.month > a.month ? b : a));
  await cloneTab(log, source, name);
  const made = log.sheets.find((s) => s.name === name)!;
  return { name: made.name, path: made.path, made: true };
}

/* ------------------------------------------------------- cloning a tab -- */

async function cloneTab(log: LogWorkbook, source: { name: string; path: string }, name: string) {
  const { entries } = log;
  const wbPart = partOf(entries, "xl/workbook.xml")!;
  const relsPart = partOf(entries, "xl/_rels/workbook.xml.rels")!;
  const typesPart = partOf(entries, "[Content_Types].xml")!;
  let wbXml = await partText(wbPart);
  let relsXml = await partText(relsPart);
  let typesXml = await partText(typesPart);

  const nextNumber = (re: RegExp) =>
    Math.max(0, ...entries.map((e) => Number((re.exec(e.name) || [])[1] || 0))) + 1;
  const copyPart = (from: string, to: string) => {
    const src = partOf(entries, from);
    if (!src) return null;
    const dup: ZipEntry = { ...src, name: to, body: src.body };
    entries.push(dup);
    return dup;
  };

  /* The sheet itself: the office's rows emptied, nothing selected, every
     revision mark its own. */
  const sheetN = nextNumber(/^xl\/worksheets\/sheet(\d+)\.xml$/);
  const sheetPath = `xl/worksheets/sheet${sheetN}.xml`;
  const srcSheet = partOf(entries, source.path)!;
  const sheet = readSheet(await partText(srcSheet));
  for (const row of sheet.rows) {
    if (row.num < FIRST_ROW) continue;
    for (const c of row.cells) {
      if (c.v !== undefined || c.is !== undefined || c.hasFormula) putCell(row, c.col, c.ref, c.s, { kind: "blank" });
    }
  }
  let sheetXml = writeSheet(sheet)
    .replace(/\s+tabSelected="1"/, "")
    .replace(/<selection\b[^>]*\/>/, `<selection activeCell="A${FIRST_ROW}" sqref="A${FIRST_ROW}"/>`)
    .replace(/topLeftCell="[^"]*"/, 'topLeftCell="A1"');
  sheetXml = freshUids(sheetXml);
  const newSheet: ZipEntry = { ...srcSheet, name: sheetPath, body: srcSheet.body };
  entries.push(newSheet);
  await setPartText(newSheet, sheetXml);
  typesXml = typesXml.replace(
    "</Types>",
    `<Override PartName="/${sheetPath}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  );

  /* What the tab carries with it: its table, the header logo's drawing and
     its printer settings, each copied under a new number so the two tabs
     share nothing they might write to. */
  const srcRelsPath = source.path.replace(/worksheets\/(sheet\d+\.xml)$/, "worksheets/_rels/$1.rels");
  const srcRels = partOf(entries, srcRelsPath);
  if (srcRels) {
    let sheetRels = await partText(srcRels);
    for (const m of [...sheetRels.matchAll(/Target="([^"]+)"/g)]) {
      const target = m[1];
      const real = "xl/" + target.replace(/^\.\.\//, "");
      let copied: string | null = null;
      if (/\/tables\/table\d+\.xml$/.test(real)) {
        const n = nextNumber(/^xl\/tables\/table(\d+)\.xml$/);
        copied = `xl/tables/table${n}.xml`;
        const part = copyPart(real, copied)!;
        let tableXml = await partText(part);
        // The table's id and name must be its own across the workbook.
        const maxId = await maxTableId(entries, part);
        const tableName = await uniqueTableName(entries, part, `FaunaLog${name}`);
        tableXml = tableXml
          .replace(/(<table\b[^>]*\sid=")\d+(")/, `$1${maxId + 1}$2`)
          .replace(/\sname="[^"]*"/, ` name="${tableName}"`)
          .replace(/\sdisplayName="[^"]*"/, ` displayName="${tableName}"`);
        await setPartText(part, freshUids(tableXml));
        typesXml = typesXml.replace(
          "</Types>",
          `<Override PartName="/${copied}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>`,
        );
      } else if (/\/drawings\/vmlDrawing\d+\.vml$/.test(real)) {
        const n = nextNumber(/^xl\/drawings\/vmlDrawing(\d+)\.vml$/);
        copied = `xl/drawings/vmlDrawing${n}.vml`;
        copyPart(real, copied);
        const drawRels = real.replace(/([^/]+)$/, "_rels/$1.rels");
        if (partOf(entries, drawRels)) copyPart(drawRels, copied.replace(/([^/]+)$/, "_rels/$1.rels"));
      } else if (/\/printerSettings\/printerSettings\d+\.bin$/.test(real)) {
        const n = nextNumber(/^xl\/printerSettings\/printerSettings(\d+)\.bin$/);
        copied = `xl/printerSettings/printerSettings${n}.bin`;
        copyPart(real, copied);
      }
      if (copied) sheetRels = sheetRels.split(`Target="${target}"`).join(`Target="../${copied.slice(3)}"`);
    }
    const newRels: ZipEntry = { ...srcRels, name: sheetPath.replace(/worksheets\/(sheet\d+\.xml)$/, "worksheets/_rels/$1.rels"), body: srcRels.body };
    entries.push(newRels);
    await setPartText(newRels, sheetRels);
  }

  /* The workbook's list of tabs: the new one straight after the one it was
     copied from, with its own sheetId and relationship, and every name that
     belongs to a tab by position moved along with it. */
  const rId = "rId" + (Math.max(0, ...[...relsXml.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]))) + 1);
  relsXml = relsXml.replace(
    "</Relationships>",
    `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheetN}.xml"/></Relationships>`,
  );
  const sheetTags = [...wbXml.matchAll(/<sheet\b[^>]*\/>/g)].map((m) => m[0]);
  const srcIndex = sheetTags.findIndex((t) => t.includes(`name="${xmlEsc(source.name)}"`));
  if (srcIndex < 0) throw new Error(`the tab ${source.name} is not in the workbook's list`);
  const newIndex = srcIndex + 1;
  const sheetId = Math.max(0, ...sheetTags.map((t) => Number((/sheetId="(\d+)"/.exec(t) || [])[1] || 0))) + 1;
  const newTag = `<sheet name="${xmlEsc(name)}" sheetId="${sheetId}" r:id="${rId}"/>`;
  wbXml = wbXml.replace(sheetTags[srcIndex], sheetTags[srcIndex] + newTag);
  wbXml = wbXml.replace(/localSheetId="(\d+)"/g, (whole, n) => (Number(n) >= newIndex ? `localSheetId="${Number(n) + 1}"` : whole));
  wbXml = wbXml.replace(/activeTab="(\d+)"/, (whole, n) => (Number(n) >= newIndex ? `activeTab="${Number(n) + 1}"` : whole));
  // The print area, as the tab it was copied from has it.
  const srcArea = new RegExp(
    `<definedName name="_xlnm\\.Print_Area" localSheetId="${srcIndex}">([^<]*)</definedName>`,
  ).exec(wbXml);
  if (srcArea) {
    const area = srcArea[1].replace(new RegExp(`^'?${escapeRe(xmlEsc(source.name))}'?!`), `${/[^A-Za-z0-9_]/.test(name) ? `'${xmlEsc(name)}'` : xmlEsc(name)}!`);
    wbXml = wbXml.replace(srcArea[0], srcArea[0] + `<definedName name="_xlnm.Print_Area" localSheetId="${newIndex}">${area}</definedName>`);
  }
  await setPartText(wbPart, wbXml);
  await setPartText(relsPart, relsXml);
  await setPartText(typesPart, typesXml);

  /* The file's own list of its tabs, kept honest. */
  const app = partOf(entries, "docProps/app.xml");
  if (app) {
    let appXml = await partText(app);
    const srcTitle = `<vt:lpstr>${xmlEsc(source.name)}</vt:lpstr>`;
    if (appXml.includes(srcTitle)) {
      appXml = appXml.replace(srcTitle, srcTitle + `<vt:lpstr>${xmlEsc(name)}</vt:lpstr>`);
      if (srcArea) appXml = appXml.replace("</vt:vector></TitlesOfParts>", `<vt:lpstr>${xmlEsc(name)}!Print_Area</vt:lpstr></vt:vector></TitlesOfParts>`);
      appXml = appXml
        .replace(/(<TitlesOfParts><vt:vector size=")(\d+)/, (_m, a, n) => a + (Number(n) + 1 + (srcArea ? 1 : 0)))
        .replace(/(<vt:lpstr>Worksheets<\/vt:lpstr><\/vt:variant><vt:variant><vt:i4>)(\d+)/, (_m, a, n) => a + (Number(n) + 1))
        .replace(/(<vt:lpstr>Named Ranges<\/vt:lpstr><\/vt:variant><vt:variant><vt:i4>)(\d+)/, (_m, a, n) => a + (Number(n) + (srcArea ? 1 : 0)));
      await setPartText(app, appXml);
    }
  }

  log.sheets = listSheets(wbXml, relsXml);
}

async function maxTableId(entries: ZipEntry[], except: ZipEntry) {
  let max = 0;
  for (const e of entries) {
    if (e === except || !/^xl\/tables\/table\d+\.xml$/.test(e.name)) continue;
    const id = Number((/<table\b[^>]*\sid="(\d+)"/.exec(await partText(e)) || [])[1] || 0);
    if (id > max) max = id;
  }
  return max;
}

async function uniqueTableName(entries: ZipEntry[], except: ZipEntry, wanted: string) {
  const taken = new Set<string>();
  for (const e of entries) {
    if (e === except || !/^xl\/tables\/table\d+\.xml$/.test(e.name)) continue;
    const m = /displayName="([^"]*)"/.exec(await partText(e));
    if (m) taken.add(m[1].toLowerCase());
  }
  let name = wanted.replace(/[^A-Za-z0-9_]/g, "");
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = wanted + n;
  return name;
}

/* ------------------------------------------------------- writing rows -- */

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Whether a row holds this entry: the same time and date in A and B. */
function rowHolds(row: { cells: { col: number; v?: string; t: string }[] }, values: Record<string, unknown>) {
  const want = (key: string, col: number) => {
    const sv = sheetValue(key, values[key]);
    const cell = row.cells.find((c) => c.col === col);
    if (sv.kind === "blank") return !cell || cell.v === undefined;
    if (!cell || cell.v === undefined || cell.t === "s" || cell.t === "inlineStr") return false;
    return sv.kind === "number" ? near(Number(cell.v), sv.value) : false;
  };
  return want("time", 1) && want("date", 2);
}

const rowEmpty = (row: { cells: { col: number; v?: string; is?: string; hasFormula: boolean }[] }) =>
  row.cells.every((c) => c.col > 31 || (c.v === undefined && c.is === undefined && !c.hasFormula));

/**
 * The entries written into the tab, each into its own row, and the rows of
 * removed entries blanked. What comes back is where each entry now sits.
 */
export async function writeRows(
  log: LogWorkbook,
  path: string,
  rows: LogRow[],
  blank: number[] = [],
): Promise<{ placed: Record<string, number>; lastRow: number }> {
  const part = partOf(log.entries, path);
  if (!part) throw new Error("the month's tab is missing from the workbook");
  const sheet = readSheet(await partText(part));
  const header = sheet.rows.find((r) => r.num === HEADER_ROW);
  if (!header) throw new Error("the tab's header is not on row 15 where the log keeps it");
  const rowAt = (num: number) => sheet.rows.find((r) => r.num === num);
  const pattern = () => rowAt(FIRST_ROW + 1) || rowAt(FIRST_ROW) || sheet.rows[sheet.rows.length - 1];
  const ensureRow = (num: number) => {
    let row = rowAt(num);
    if (!row) {
      const p = pattern();
      row = { num, open: p.open.replace(/\br="\d+"/, `r="${num}"`), cells: [], gaps: [""], raw: "", dirty: true };
      const at = sheet.rows.findIndex((r) => r.num > num);
      if (at < 0) { sheet.rows.push(row); sheet.gaps.push(""); }
      else { sheet.rows.splice(at, 0, row); sheet.gaps.splice(at, 0, ""); }
    }
    return row;
  };
  const styleAt = (num: number, col: number) => {
    const cell = rowAt(num)?.cells.find((c) => c.col === col) || pattern().cells.find((c) => c.col === col);
    return cell ? cell.s : null;
  };
  const write = (num: number, values: Record<string, unknown>) => {
    const row = ensureRow(num);
    for (const f of FIELDS) {
      const col = colOf(f.col + "1");
      putCell(row, col, `${f.col}${num}`, styleAt(num, col), sheetValue(f.key, values[f.key]));
    }
  };
  const wipe = (num: number) => {
    const row = rowAt(num);
    if (!row) return;
    for (const f of FIELDS) {
      const col = colOf(f.col + "1");
      const cell = row.cells.find((c) => c.col === col);
      if (cell && (cell.v !== undefined || cell.is !== undefined)) putCell(row, col, `${f.col}${num}`, cell.s, { kind: "blank" });
    }
  };

  // Rows removed entries held are cleared first, so a new entry may take one.
  const taken = new Set<number>();
  for (const num of blank) if (num >= FIRST_ROW) wipe(num);

  const placed: Record<string, number> = {};
  let lastRow = HEADER_ROW;
  for (const r of sheet.rows) if (r.num > lastRow && !rowEmpty(r)) lastRow = r.num;

  // Entries that already have a row keep it where the row still holds them;
  // one whose row now holds something else is placed afresh.
  const pending: LogRow[] = [];
  for (const entry of rows) {
    const row = entry.row != null ? rowAt(entry.row) : undefined;
    if (entry.row != null && entry.row >= FIRST_ROW && (!row || rowEmpty(row) || rowHolds(row, entry.values))) {
      placed[entry.id] = entry.row;
      taken.add(entry.row);
    } else pending.push(entry);
  }
  for (const entry of pending) {
    // A row that already holds this entry (the books lost its number).
    let num = 0;
    for (const r of sheet.rows) {
      if (r.num >= FIRST_ROW && !taken.has(r.num) && !rowEmpty(r) && rowHolds(r, entry.values)) { num = r.num; break; }
    }
    if (!num) {
      num = FIRST_ROW;
      while (taken.has(num) || (rowAt(num) && !rowEmpty(rowAt(num)!))) num++;
    }
    placed[entry.id] = num;
    taken.add(num);
  }
  for (const entry of rows) write(placed[entry.id], entry.values);
  for (const n of Object.values(placed)) if (n > lastRow) lastRow = n;

  await setPartText(part, writeSheet(sheet));
  await extendTable(log, path, lastRow);
  return { placed, lastRow };
}

/** The tab's table reaches every row that has an entry, so the stripes and
 *  the filter follow the entries down. */
async function extendTable(log: LogWorkbook, sheetPath: string, toRow: number) {
  const relsPath = sheetPath.replace(/worksheets\/(sheet\d+\.xml)$/, "worksheets/_rels/$1.rels");
  const rels = partOf(log.entries, relsPath);
  if (!rels) return;
  const m = /Target="([^"]*tables\/table\d+\.xml)"/.exec(await partText(rels));
  if (!m) return;
  const table = partOf(log.entries, "xl/" + m[1].replace(/^\.\.\//, ""));
  if (!table) return;
  let xml = await partText(table);
  const ref = /\sref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/.exec(xml);
  if (!ref) return;
  if (Number(ref[4]) >= toRow) return;
  xml = xml.replace(/(\sref=")([A-Z]+\d+:[A-Z]+)\d+(")/g, (_w, a, cols, b) => `${a}${cols}${toRow}${b}`);
  await setPartText(table, xml);
}
