// @ts-check
/**
 * The workbook code the page and the worker both run.
 *
 * A .xlsx is a zip of XML parts. Everything here reads and writes those parts
 * directly, so the office's own workbook can be updated in place with its
 * colours, formulas and other sheets untouched. The page splices this file in
 * at its @shared marker; the worker imports it. Edit it here and only here.
 */

/**
 * @typedef {{ name: string, method: number, flag: number, time: number, date: number,
 *   crc: number, csize: number, usize: number, body: Uint8Array }} ZipEntry
 *   One part of the zip, still compressed, exactly as the file holds it.
 * @typedef {{ ref: string, col: number, s: number | null, t: string, hasFormula: boolean,
 *   v: string | undefined, is: string | undefined, raw: string }} Cell
 * @typedef {{ num: number, open: string, cells: Cell[], gaps: string[], raw: string, dirty: boolean }} Row
 * @typedef {{ head: string, open: string, tail: string, rows: Row[], gaps: string[], added: string[] }} Sheet
 * @typedef {{ kind: "blank" } | { kind: "number", value: number } | { kind: "shared", value: number }
 *   | { kind: "inline", value: string }} CellValue
 * @typedef {[string, string, string, string[]]} MatrixRow
 *   A crew matrix row: name, position, SAM number, then one value per column.
 * @typedef {{ cols: string[][], rows: MatrixRow[] }} Quals
 * @typedef {{ numeric: boolean, sample: string, style: number | null }} ColumnShape
 */

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/* ==================================================================== */
/*  Writing the figures back into the workbook that is already on file  */
/*                                                                      */
/*  The spreadsheet an admin keeps is not a grid of dates. It is a grid */
/*  of dates with the colour bands, the totals down the bottom, the     */
/*  second and third sheets, the print setup and the header the office  */
/*  put on it years ago. Building a fresh workbook out of the matrix    */
/*  hands back the dates and throws all of that away, and what comes    */
/*  back off the portal then no longer looks like the document the      */
/*  vessel works from.                                                  */
/*                                                                      */
/*  So the update is made to the workbook itself rather than to a copy  */
/*  of its figures. A .xlsx is a zip of XML parts: the styles, the      */
/*  conditional formatting that paints the bands, the formulas, every   */
/*  other sheet. Only the handful of value cells that actually moved    */
/*  are rewritten — everything else in the file, down to the bytes, is  */
/*  carried over untouched. A cell keeps the style it was given, so a   */
/*  date written in today is coloured by the same rule that coloured    */
/*  the one it replaced.                                                */
/*                                                                      */
/*  SheetJS can't do this: the free build reads a workbook's values and */
/*  writes a new one, and the styles are gone in between. So the zip is */
/*  opened here, with the browser's own compression, and it stays the   */
/*  fallback for the case where there is nothing on file to update.     */
/* ==================================================================== */

// Nothing here works without the browser's compression streams. They have been
// in every browser for years, but a portal that quietly produced a workbook
// with no colours would be worse than one that says why, so this is checked
// rather than assumed.
export const zipCapable = () =>
  typeof CompressionStream === "function" && typeof DecompressionStream === "function";

/**
 * @param {Uint8Array} bytes
 * @param {CompressionStream | DecompressionStream} stream
 */
export const pipeBytes = async (bytes, stream) =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

/**
 * @param {Uint8Array} bytes
 */
export const inflateRaw = (bytes) => pipeBytes(bytes, new DecompressionStream("deflate-raw"));
/**
 * @param {Uint8Array} bytes
 */
export const deflateRaw = (bytes) => pipeBytes(bytes, new CompressionStream("deflate-raw"));

// The zip checksum. Only the parts that are rewritten need one — every other
// part is copied across still compressed, with the checksum it came with.
/** @type {Int32Array | null} */
export let CRC_TABLE = null;
/**
 * @param {Uint8Array} bytes
 */
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/**
 * The parts of a .xlsx, in the order the file holds them.
 *
 * The central directory at the end of the zip is read rather than the local
 * headers, because it is the one place the sizes are always filled in. Each
 * part is kept exactly as it was found — still compressed — so a part nothing
 * asks about is written back out byte for byte.
 * @param {ArrayBuffer | Uint8Array} buf
 * @returns {ZipEntry[]}
 */
export function readZip(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 65535; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("it is not a .xlsx — the file has no zip directory in it");

  const count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  /** @type {ZipEntry[]} */
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(at, true) !== 0x02014b50) throw new Error("the zip directory inside the workbook is damaged");
    const flag = dv.getUint16(at + 8, true);
    const method = dv.getUint16(at + 10, true);
    const csize = dv.getUint32(at + 20, true);
    const usize = dv.getUint32(at + 24, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const commentLen = dv.getUint16(at + 32, true);
    const local = dv.getUint32(at + 42, true);
    // Zip64 and encrypted parts are both rare enough in a spreadsheet that
    // handling them is not worth the room. Saying so sends the run down the
    // rebuild path rather than writing a workbook nothing can open.
    if (flag & 0x01) throw new Error("the workbook is password protected");
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new Error("the workbook is in the zip64 format");
    if (method !== 0 && method !== 8) throw new Error(`part of the workbook is packed in a way this can't read (method ${method})`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    entries.push({
      name: new TextDecoder().decode(b.subarray(at + 46, at + 46 + nameLen)),
      method, flag,
      time: dv.getUint16(at + 12, true),
      date: dv.getUint16(at + 14, true),
      crc: dv.getUint32(at + 16, true),
      csize, usize,
      body: b.subarray(start, start + csize),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The workbook path is the reason this exists, so a .xlsx is what it makes
   unless it is told otherwise. The "download everything" archive in the Admin
   tab is the other caller, and a zip of the whole portal handed over as a
   spreadsheet is one the operating system opens in Excel.
 * @param {ZipEntry[]} entries
 * @param {string} [mime]
 */
export function writeZip(entries, mime = XLSX_MIME) {
  const enc = new TextEncoder();
  /** @type {Uint8Array[]} */
  const parts = [];
  /** @type {Uint8Array[]} */
  const dir = [];
  let offset = 0;

  entries.forEach((e) => {
    const name = enc.encode(e.name);
    // The sizes are written into the local header, so the "sizes follow the
    // data" flag is cleared whether or not the file we read used it.
    const flag = e.flag & ~0x08;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flag, true);
    lv.setUint16(8, e.method, true);
    lv.setUint16(10, e.time, true);
    lv.setUint16(12, e.date, true);
    lv.setUint32(14, e.crc, true);
    lv.setUint32(18, e.csize, true);
    lv.setUint32(22, e.usize, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flag, true);
    cv.setUint16(10, e.method, true);
    cv.setUint16(12, e.time, true);
    cv.setUint16(14, e.date, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.csize, true);
    cv.setUint32(24, e.usize, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);

    parts.push(local, e.body);
    dir.push(cd);
    offset += local.length + e.body.length;
  });

  const dirSize = dir.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...parts, ...dir, end], { type: mime });
}

/**
 * @param {ZipEntry[]} entries
 * @param {string} name
 * @returns {ZipEntry | null}
 */
export const partOf = (entries, name) => entries.find((e) => e.name === name) || null;

/**
 * @param {ZipEntry | null} entry
 */
export async function partText(entry) {
  if (!entry) return "";
  const bytes = entry.method === 0 ? entry.body : await inflateRaw(entry.body);
  return new TextDecoder().decode(bytes);
}

/**
 * @param {ZipEntry} entry
 * @param {string} text
 */
export async function setPartText(entry, text) {
  const bytes = new TextEncoder().encode(text);
  entry.usize = bytes.length;
  entry.crc = crc32(bytes);
  entry.body = await deflateRaw(bytes);
  entry.csize = entry.body.length;
  entry.method = 8;
  entry.flag &= ~0x08;
}

// ---------------------------------------------------------------------------
// The little bit of XML the sheet needs
// ---------------------------------------------------------------------------

/**
 * @param {unknown} s
 */
export const xmlEsc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * @param {unknown} s
 */
export const xmlUnesc = (s) => String(s == null ? "" : s)
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, "&");

/**
 * @param {string} ref
 */
export const colOf = (ref) => {
  let n = 0;
  const letters = String(ref).replace(/\d+$/, "");
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n;
};

/**
 * @param {number} n
 */
export const letterOf = (n) => {
  let s = "";
  let x = n;
  while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = (x - 1 - r) / 26; }
  return s;
};

/**
 * Split a run of XML into the bits a pattern matches and the bits between them.
 *
 * Everything that isn't a row — or, inside a row, isn't a cell — is kept as it
 * was found and put back in the same place, so a workbook written by something
 * other than Excel doesn't lose whatever it puts between them.
 * @param {string} text
 * @param {RegExp} re
 */
export function chunk(text, re) {
  /** @type {string[]} */
  const hits = [];
  /** @type {string[]} */
  const gaps = [];
  let last = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    gaps.push(text.slice(last, m.index));
    hits.push(m[0]);
    last = m.index + m[0].length;
  }
  gaps.push(text.slice(last));
  return { hits, gaps };
}

export const ROW_RE = () => /<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g;
export const CELL_RE = () => /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;

/**
 * @param {string} raw
 * @returns {Cell}
 */
export function readCell(raw) {
  const ref = (raw.match(/\br="([A-Z]+\d+)"/) || [])[1] || "";
  const s = (raw.match(/\bs="(\d+)"/) || [])[1];
  return {
    ref,
    col: colOf(ref),
    s: s === undefined ? null : Number(s),
    t: (raw.match(/\bt="([a-zA-Z]+)"/) || [])[1] || "n",
    hasFormula: /<f[\s/>]/.test(raw),
    v: (raw.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1],
    is: (raw.match(/<is>([\s\S]*?)<\/is>/) || [])[1],
    raw,
  };
}

/** The sheet, split so the value cells can be reached and nothing else moves.
 * @param {string} xml
 * @returns {Sheet}
 */
export function readSheet(xml) {
  const at = xml.indexOf("<sheetData");
  if (at < 0) throw new Error("the sheet has no data in it");
  const gt = xml.indexOf(">", at);
  const openTag = xml.slice(at, gt + 1);
  const empty = openTag.endsWith("/>");
  const close = empty ? gt + 1 : xml.indexOf("</sheetData>", gt);
  const body = empty ? "" : xml.slice(gt + 1, close);

  const rowChunks = chunk(body, ROW_RE());
  const rows = rowChunks.hits.map((raw) => {
    // Every hit begins "<row", so the open tag is always there to find.
    const open = (raw.match(/^<row\b[^>]*?\/?>/) || [""])[0];
    const inner = open.endsWith("/>") ? "" : raw.slice(open.length, raw.length - "</row>".length);
    const cellChunks = chunk(inner, CELL_RE());
    return {
      num: Number((raw.match(/\br="(\d+)"/) || [])[1] || 0),
      open,
      cells: cellChunks.hits.map(readCell),
      gaps: cellChunks.gaps,
      raw,
      dirty: false,
    };
  });

  return {
    head: xml.slice(0, at),
    open: empty ? "<sheetData>" : openTag,
    tail: empty ? xml.slice(gt + 1) : xml.slice(close + "</sheetData>".length),
    rows,
    gaps: rowChunks.gaps,
    added: [],
  };
}

/**
 * @param {Row} row
 */
export function rowXml(row) {
  if (!row.dirty) return row.raw;
  // `spans` is a hint about which columns the row uses, and a stale one is
  // worse than none, so a row that has been written to loses it.
  const open = row.open.replace(/\s+spans="[^"]*"/, "").replace(/\/>$/, ">");
  let inner = "";
  for (let i = 0; i < row.cells.length; i++) inner += row.gaps[i] + row.cells[i].raw;
  return `${open}${inner + row.gaps[row.cells.length]}</row>`;
}

/**
 * @param {Sheet} sheet
 */
export function writeSheet(sheet) {
  let body = "";
  for (let i = 0; i < sheet.rows.length; i++) body += sheet.gaps[i] + rowXml(sheet.rows[i]);
  body += sheet.added.join("");
  body += sheet.gaps[sheet.rows.length];
  return `${sheet.head}${sheet.open}${body}</sheetData>${sheet.tail}`;
}

/**
 * The shared string table, read only. New text is written into the cell itself
 * as an inline string, so the table — and every count on it — is left alone.
 *
 * @param {string} xml
 * @returns {string[]}
 */
export function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const si = /<si\b[^>]*\/>|<si\b[^>]*>[\s\S]*?<\/si>/g;
  let m;
  while ((m = si.exec(xml))) out.push(textOfRuns(m[0]));
  return out;
}

/**
 * @param {string} xml
 */
export const textOfRuns = (xml) => {
  let text = "";
  const t = /<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = t.exec(xml))) text += xmlUnesc(m[1] || "");
  return text;
};

/** What a cell says, as text — the same reading `parseWorkbook` takes.
 * @param {Cell | null | undefined} cell
 * @param {string[]} strings
 * @param {boolean} date1904
 */
export function cellText(cell, strings, date1904) {
  if (!cell) return "";
  if (cell.t === "s") { const i = Number(cell.v); return strings[i] == null ? "" : strings[i]; }
  if (cell.t === "inlineStr") return textOfRuns(cell.is || "");
  if (cell.t === "str") return xmlUnesc(cell.v || "");
  if (cell.t === "b") return cell.v === "1" ? "Y" : "N";
  if (cell.v == null || cell.v === "") return "";
  const n = Number(cell.v);
  if (!isFinite(n)) return xmlUnesc(cell.v);
  // A number in this range is a date. Everything the matrix carries in an item
  // column is either a date, a letter or blank, so there is nothing else a
  // five-figure number in one could be.
  return n >= 20000 && n <= 90000 ? isoFromSerial(n, date1904) : String(n);
}

/**
 * @param {number} n
 * @param {boolean} date1904
 */
export function isoFromSerial(n, date1904) {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(base + Math.round(n) * 86400000).toISOString().slice(0, 10);
}

/**
 * @param {string} iso
 * @param {boolean} date1904
 */
export function serialFrom(iso, date1904) {
  const [y, m, d] = iso.split("-").map(Number);
  const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
  return date1904 ? days - 1462 : days;
}

/**
 * A date typed into a column that holds its dates as text, written the way the
 * dates already in that column are written.
 *
 * @param {string} iso
 * @param {string} sample
 */
export function textDate(iso, sample) {
  const [y, m, d] = iso.split("-");
  if (/^\d{4}-\d{2}-\d{2}/.test(sample)) return iso;
  const sep = /^\d{1,2}\.\d{1,2}\.\d{2,4}/.test(sample) ? "."
    : /^\d{1,2}-\d{1,2}-\d{2,4}/.test(sample) ? "-" : "/";
  return `${d}${sep}${m}${sep}${y}`;
}

/**
 * @param {string} ref
 * @param {number | null | undefined} style
 * @param {CellValue} val
 */
export function cellXml(ref, style, val) {
  const s = style == null ? "" : ` s="${style}"`;
  if (val.kind === "blank") return `<c r="${ref}"${s}/>`;
  if (val.kind === "number") return `<c r="${ref}"${s}><v>${val.value}</v></c>`;
  if (val.kind === "shared") return `<c r="${ref}"${s} t="s"><v>${val.value}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(val.value)}</t></is></c>`;
}

/**
 * @param {Row} row
 * @param {number} col
 * @param {string} ref
 * @param {number | null | undefined} style
 * @param {CellValue} val
 */
export function putCell(row, col, ref, style, val) {
  const raw = cellXml(ref, style, val);
  const at = row.cells.findIndex((c) => c.col === col);
  if (at >= 0) {
    row.cells[at] = readCell(raw);
  } else {
    // A blank cell isn't in the file at all, so it is put in at the point the
    // column order says it belongs.
    let idx = row.cells.findIndex((c) => c.col > col);
    if (idx < 0) idx = row.cells.length;
    row.cells.splice(idx, 0, readCell(raw));
    row.gaps.splice(idx, 0, "");
  }
  row.dirty = true;
}

/**
 * Ranges that stopped at the last crew member have to reach the ones added
 * under them, or a new row sits outside the rule that paints the colour bands.
 *
 * @param {string} xml
 * @param {number} fromRow
 * @param {number} toRow
 */
export function extendRanges(xml, fromRow, toRow) {
  /** @param {string} range */
  const bump = (range) => range.split(/\s+/).filter(Boolean).map((r) =>
    r.replace(/([A-Z]+)(\d+)$/, (whole, c, n) => (Number(n) === fromRow ? `${c}${toRow}` : whole))).join(" ");
  return xml
    .replace(/<(conditionalFormatting|dataValidation)\b[^>]*>/g, (tag) =>
      tag.replace(/sqref="([^"]+)"/, (_w, v) => `sqref="${bump(v)}"`))
    .replace(/<dimension\b[^>]*>/g, (tag) =>
      tag.replace(/ref="([^"]+)"/, (_w, v) => `ref="${bump(v)}"`));
}

/* -------- inserting rows into the middle of a sheet -----------------------
 *
 * The workbook keeps notes, totals and a legend underneath the crew, so a new
 * crew member cannot just go on the end — everything below has to move down,
 * exactly as Excel's own "insert row" moves it. That means three kinds of
 * renumbering, and nothing else:
 *
 *   - a moved row's own number, and the address of every cell in it;
 *   - inside every formula on the sheet, any reference to a row that moved,
 *     so a total that read the notes row still reads the notes row;
 *   - every range the sheet keeps outside its rows - the dimension, merged
 *     cells, conditional formats - where an endpoint that moved moves with
 *     it, and a range that spans the insertion grows to cover it.
 *
 * References to rows that did not move are left exactly as written: the cells
 * they point at have not gone anywhere.
 */

/** Cell references in a formula, moved where they point below the insertion.
 *  Text inside quotes is someone's words, not a reference, and is left alone.
 * @param {string} text
 * @param {number} afterRow
 * @param {number} by
 */
export function shiftFormulaRefs(text, afterRow, by) {
  return text.split('"').map((seg, i) => (i % 2 ? seg
    : seg.replace(/(\$?[A-Z]{1,3}\$?)(\d+)/g, (whole, col, n) =>
        (Number(n) > afterRow ? col + (Number(n) + by) : whole)))).join('"');
}

/** One row's XML, moved down bodily: its own number, its cells' addresses,
 *  and any shared-formula ranges it anchors.
 * @param {string} xml
 * @param {number} by
 */
export function shiftRowXml(xml, by) {
  return xml
    .replace(/(<row\b[^>]*?\br=")(\d+)(")/, (_w, a, n, b) => a + (Number(n) + by) + b)
    .replace(/(\br=")([A-Z]{1,3})(\d+)(")/g, (_w, a, col, n, b) => a + col + (Number(n) + by) + b);
}

/** Formulas anywhere in a row, re-pointed at rows that moved.
 * @param {string} xml
 * @param {number} afterRow
 * @param {number} by
 */
export function remapRowFormulas(xml, afterRow, by) {
  return xml
    .replace(/(<f\b[^>]*>)([^<]*)(<\/f>)/g, (_w, a, t, b) => a + shiftFormulaRefs(t, afterRow, by) + b)
    .replace(/(<f\b[^>]*\bref=")([^"]+)(")/g, (_w, a, v, b) => a + shiftFormulaRefs(v, afterRow, by) + b);
}

/** Every ref= and sqref= range outside the rows — dimension, merged cells,
 *  conditional formats, filters — with moved endpoints moved.
 * @param {string} xml
 * @param {number} afterRow
 * @param {number} by
 */
export function shiftRanges(xml, afterRow, by) {
  return xml.replace(/((?:ref|sqref)=")([^"]+)(")/g, (_w, a, v, b) =>
    a + shiftFormulaRefs(v, afterRow, by) + b);
}

/**
 * Which sheet in the workbook the matrix is on, and where its XML lives.
 *
 * The same sheet the portal reads back in is the one written to — the one
 * named for the crew expiry, or the first if the workbook only has one.
 * @param {string} workbookXml
 * @param {string} relsXml
 */
export function sheetPath(workbookXml, relsXml) {
  const sheets = listSheets(workbookXml, relsXml);
  if (!sheets.length) throw new Error("no sheets could be found in the workbook");

  return sheets.find((s) => s.name.toUpperCase().includes("CREW EXPIRY")) || sheets[0];
}

/**
 * Every sheet in the workbook, in the workbook's own order: its name as Excel
 * shows it and the zip path its XML sits at.
 * @param {string} workbookXml
 * @param {string} relsXml
 * @returns {{ name: string, path: string }[]}
 */
export function listSheets(workbookXml, relsXml) {
  /** @type {Record<string, string>} */
  const rels = {};
  const rel = /<Relationship\b[^>]*>/g;
  let m;
  while ((m = rel.exec(relsXml))) {
    const id = (m[0].match(/Id="([^"]+)"/) || [])[1];
    const target = (m[0].match(/Target="([^"]+)"/) || [])[1];
    if (id && target) rels[id] = target.replace(/^\//, "").replace(/^xl\//, "");
  }

  const sheets = [];
  const sh = /<sheet\b[^>]*>/g;
  while ((m = sh.exec(workbookXml))) {
    const name = xmlUnesc((m[0].match(/name="([^"]*)"/) || [])[1] || "");
    const id = (m[0].match(/r:id="([^"]+)"/) || [])[1];
    if (id && rels[id]) sheets.push({ name, path: `xl/${rels[id]}` });
  }
  return sheets;
}

/**
 * One sheet read as text, row by row: what each cell says, with a blank for a
 * cell that is empty or not in the file.
 *
 * Rows are placed by their Excel row number, so rows[i] is row i+1 of the
 * sheet and a row Excel left out of the file is an empty array — the same
 * shape SheetJS gives with { header: 1 }, which is what the rule readers
 * expect. Cells are placed by column the same way.
 * @param {ReturnType<typeof readZip>} entries
 * @param {string} path
 * @returns {Promise<string[][]>}
 */
export async function readSheetRows(entries, path) {
  const wbPart = partOf(entries, "xl/workbook.xml");
  const date1904 = /date1904="(1|true)"/.test(await partText(wbPart));
  const strings = sharedStrings(await partText(partOf(entries, "xl/sharedStrings.xml")));
  const sheet = readSheet(await partText(partOf(entries, path)));

  /** @type {string[][]} */
  const rows = [];
  sheet.rows.forEach((row) => {
    if (row.num < 1) return;
    /** @type {string[]} */
    const cells = [];
    row.cells.forEach((c) => {
      if (c.col >= 1) cells[c.col - 1] = cellText(c, strings, date1904);
    });
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = "";
    rows[row.num - 1] = cells;
  });
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

/**
 * Excel keeps a list of which formulas to work out in which order. Replacing a
 * formula with a figure leaves that list pointing at a cell that no longer has
 * one, which Excel reports as a damaged file — so it is dropped and Excel
 * builds it again on open.
 *
 * @param {ZipEntry[]} entries
 */
export async function dropCalcChain(entries) {
  const at = entries.findIndex((e) => e.name === "xl/calcChain.xml");
  if (at < 0) return;
  entries.splice(at, 1);

  const types = partOf(entries, "[Content_Types].xml");
  if (types) {
    await setPartText(types, (await partText(types))
      .replace(/<Override[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, ""));
  }
  const rels = partOf(entries, "xl/_rels/workbook.xml.rels");
  if (rels) {
    await setPartText(rels, (await partText(rels))
      .replace(/<Relationship[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/g, ""));
  }
}

/**
 * Every formula left in the workbook is worked out again when it is opened.
 * Cached answers that depended on a cell this changed would otherwise show the
 * figure they had before the update until somebody typed into the sheet.
 *
 * @param {string} xml
 */
export function recalcOnOpen(xml) {
  if (/<calcPr\b/.test(xml)) {
    return xml.replace(/<calcPr\b[^>]*?\/?>/, (tag) => (/fullCalcOnLoad=/.test(tag)
      ? tag.replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"')
      : tag.replace(/\/?>$/, ' fullCalcOnLoad="1"/>')));
  }
  // Where the workbook has no calculation settings at all, they go in at the
  // first place the format allows after the list of sheets.
  const after = ["<oleSize", "<customWorkbookViews", "<pivotCaches", "<smartTagPr",
    "<smartTagTypes", "<webPublishing", "<fileRecoveryPr", "<webPublishObjects",
    "<extLst", "</workbook>"];
  for (const tag of after) {
    const at = xml.indexOf(tag);
    if (at >= 0) return `${xml.slice(0, at)}<calcPr fullCalcOnLoad="1"/>${xml.slice(at)}`;
  }
  return xml;
}

/**
 * The workbook on file, brought up to date in place.
 *
 * Only cells whose figure has actually moved are written. A cell that already
 * says what the matrix says is not touched at all, which is why running this
 * twice in a row produces the same file the second time and the portal reports
 * that there was nothing to file.
 *
 * What it returns alongside the file is what it could not do: crew or items the
 * workbook has no room for. Those are put on screen rather than swallowed —
 * a spreadsheet quietly missing a person is the failure worth being loud about.
 *
 * `only`, where it is given, is a Set of NAME|CODE keys and narrows the write
 * to exactly those cells: every other person and item is left out entirely,
 * even where the workbook and the matrix disagree. It is how the certificate
 * run writes in what the certificates settle without dragging the rest of the
 * matrix over whatever else the workbook says.
 *
 * `opts.mode` of "applied-and-blanks" is the hourly round's way in, with
 * `opts.keys` the NAME|CODE cells the round itself just changed. Those are
 * written whatever the workbook says - the certificate's answer is the
 * answer - and so is any cell in scope that is BLANK in the workbook and
 * has a value on the matrix. A cell the office typed differently is left
 * exactly as typed and counted in `report.leftAsTyped`: the round runs with
 * nobody watching, and a figure somebody wrote by hand is not a thing to
 * write over on the hour. Rows in scope are the ones the workbook already
 * has, plus anyone carrying a changed cell; nobody else is added to the
 * office's file by the round.
 *
 * `opts.nameOf` reads a name the workbook writes through the crew register,
 * so a row the office calls "sAM" is the matrix's "SAMPLE, Sam" and
 * not a second man to be added underneath. The page's callers pass nothing
 * and names are compared as written, as they always were.
 * @param {ArrayBuffer} buf
 * @param {Quals} quals
 * @param {Set<string> | null} [only]
 * @param {Set<string> | null} [blank]
 * @param {{ mode?: "applied-and-blanks", keys?: Set<string> | null,
 *   nameOf?: ((name: string) => string | null | undefined) | null }} [opts]
 */
export async function updateFiledWorkbook(buf, quals, only = null, blank = null, opts = {}) {
  const entries = readZip(buf);
  const appliedMode = opts.mode === "applied-and-blanks";
  const changedKeys = appliedMode ? (opts.keys || new Set()) : null;
  /** A name as the register writes it, where the caller has one.
   * @param {unknown} n */
  const as = (n) => {
    const k = opts.nameOf ? opts.nameOf(String(n == null ? "" : n)) : null;
    return k == null || k === "" ? String(n == null ? "" : n) : k;
  };

  const wbPart = partOf(entries, "xl/workbook.xml");
  const relsPart = partOf(entries, "xl/_rels/workbook.xml.rels");
  if (!wbPart || !relsPart) throw new Error("it is not laid out like a .xlsx inside");

  let workbookXml = await partText(wbPart);
  const date1904 = /date1904="(1|true)"/.test(workbookXml);
  const target = sheetPath(workbookXml, await partText(relsPart));

  const sheetPart = partOf(entries, target.path);
  if (!sheetPart) throw new Error(`the sheet "${target.name}" is missing from the workbook`);

  const strings = sharedStrings(await partText(partOf(entries, "xl/sharedStrings.xml")));
  const sharedAt = new Map();
  strings.forEach((s, i) => { if (!sharedAt.has(s)) sharedAt.set(s, i); });

  const sheetXml = await partText(sheetPart);
  const sheet = readSheet(sheetXml);
  /**
   * @param {Row} row
   * @param {number} col
   */
  const cellAt = (row, col) => row.cells.find((c) => c.col === col) || null;
  /**
   * @param {Cell | null | undefined} cell
   */
  const says = (cell) => cellText(cell, strings, date1904);

  // The row the item codes are on. It is looked for rather than assumed to be
  // row 14, so a workbook with a line added to the header still lines up.
  const codes = quals.cols.map((c) => c[0]);
  /** @type {{ row: Row, found: Map<string, number> } | null} */
  let header = null;
  for (const row of sheet.rows) {
    /** @type {Map<string, number>} */
    const found = new Map();
    row.cells.forEach((c) => {
      const text = says(c).trim();
      if (codes.includes(text) && !found.has(text)) found.set(text, c.col);
    });
    if (found.size >= 2 && (!header || found.size > header.found.size)) header = { row, found };
  }
  if (!header) throw new Error("the item codes couldn't be found on it — it isn't laid out like the crew qualification workbook");

  const colForCode = header.found;
  const codesRow = header.row;
  /**
   * @param {unknown} name
   * @param {string} code
   */
  const keyOf = (name, code) => `${as(String(name).trim()).trim().toUpperCase()}|${code}`;
  const onlyCodes = only ? new Set([...only].map((k) => k.slice(k.indexOf("|") + 1))) : null;
  const missingCols = codes.filter((code) => !colForCode.has(code) && (!onlyCodes || onlyCodes.has(code)));

  // Crew are read from under the codes: a name in column B is a crew member,
  // and the row it is on is the row that person's dates go in. The row directly
  // under the codes is the one carrying the item titles, and "Crew member" in
  // column B is a heading rather than somebody on the roster.
  const NAME_COL = 2, POS_COL = 3, SAM_COL = 4;
  const crewRows = sheet.rows.filter((r) => r.num > codesRow.num + 1 && says(cellAt(r, NAME_COL)).trim() !== "");
  /** @type {Map<string, Row>} */
  const rowForName = new Map();
  /** @type {Map<string, Row>} */
  const rowSpelt = new Map();
  crewRows.forEach((r) => {
    const own = says(cellAt(r, NAME_COL)).trim().toUpperCase();
    if (!rowSpelt.has(own)) rowSpelt.set(own, r);
    const key = as(own).trim().toUpperCase();
    if (!rowForName.has(key)) rowForName.set(key, r);
  });
  /** The workbook row for a matrix name: the row spelt exactly that way
   * where there is one, otherwise the first the register reads as him -
   * the same rule applySettled uses, so both land on the same line.
   * @param {unknown} name */
  const rowOf = (name) => {
    const want = String(name == null ? "" : name).trim().toUpperCase();
    return rowSpelt.get(want) || rowForName.get(as(want).trim().toUpperCase());
  };

  // Only the people and items the write actually concerns. With no `only`
  // everything on the matrix is in scope, which is what the matrix-driven
  // update has always done. The round's mode takes the rows the workbook
  // already has and anyone carrying a cell it changed.
  const inScope = only
    ? quals.rows.filter((p) => quals.cols.some((c) => only.has(keyOf(p[0], c[0]))))
    : changedKeys
    ? quals.rows.filter((p) => !!rowOf(p[0]) || quals.cols.some((c) => changedKeys.has(keyOf(p[0], c[0]))))
    : quals.rows;

  // What each item column holds today — figures or text, and in which style —
  // so a date written into a cell that has never had one in it is written the
  // way the dates already in that column are written, and carries the format
  // that makes a date look like a date rather than a five-figure number.
  const shapeOf = new Map();
  colForCode.forEach((col, code) => {
    let numbers = 0, words = 0, sample = "";
    /** @type {number | null} */
    let style = null;
    const styles = new Map();
    crewRows.forEach((r) => {
      const c = cellAt(r, col);
      if (!c) return;
      if (c.s != null) styles.set(c.s, (styles.get(c.s) || 0) + 1);
      const text = says(c);
      if (text === "") return;
      if (c.t === "n") numbers++; else words++;
      if (!sample && /\d/.test(text)) sample = text;
    });
    styles.forEach((n, s) => { if (style === null || n > (styles.get(style) || 0)) style = s; });
    shapeOf.set(code, { numeric: numbers >= words, sample, style });
  });

  // A column nobody has ever put anything in has no style of its own to copy,
  // so it borrows one from a column that has. Where there is nothing to borrow
  // — an empty sheet — a date goes in as text, because a date serial with no
  // date format on it reads as 46000 and would have to be found and fixed.
  /** @type {number | null} */
  let borrowed = null;
  let borrowedSample = "";
  shapeOf.forEach((shape) => {
    if (borrowed === null && shape.style != null && shape.numeric) borrowed = shape.style;
    if (!borrowedSample && shape.sample) borrowedSample = shape.sample;
  });
  shapeOf.forEach((shape) => {
    if (shape.style == null) shape.style = borrowed;
    if (!shape.sample) shape.sample = borrowedSample;
  });

  /** @type {{ sheet: string, written: number, formulas: number, leftAsTyped: number, addedRows: string[], skippedRows: string[], clearedRows: string[], skippedCols: string[] }} */
  const report = {
    sheet: target.name, written: 0, formulas: 0, leftAsTyped: 0,
    addedRows: [], skippedRows: [], clearedRows: [], skippedCols: missingCols,
  };

  /**
   * The value a cell should end up holding, in the shape that column uses. A
   * date only goes in as a figure where there is a style to render it with;
   * otherwise it is written out in words the way the column already writes them.
   *
   * @param {string} want
   * @param {ColumnShape} shape
   * @param {Cell | null} existing
   * @param {number | null | undefined} style
   * @returns {CellValue}
   */
  const valueFor = (want, shape, existing, style) => {
    if (want === "") return { kind: "blank" };
    if (/^\d{4}-\d{2}-\d{2}$/.test(want)) {
      const numeric = existing ? existing.t === "n" : shape.numeric;
      if (numeric && style != null) return { kind: "number", value: serialFrom(want, date1904) };
      return textValue(textDate(want, shape.sample));
    }
    return textValue(want);
  };
  /**
   * @param {string} text
   * @returns {CellValue}
   */
  const textValue = (text) => (sharedAt.has(text)
    ? { kind: "shared", value: sharedAt.get(text) }
    : { kind: "inline", value: text });

  inScope.forEach((person) => {
    const row = rowOf(person[0]);
    if (!row) { report.skippedRows.push(person[0]); return; }

    quals.cols.forEach((col, i) => {
      const at = colForCode.get(col[0]);
      if (at === undefined) return;
      if (only && !only.has(keyOf(person[0], col[0]))) return;

      const want = person[3] && person[3][i] != null ? String(person[3][i]).trim() : "";
      const existing = cellAt(row, at);
      const has = says(existing).trim();
      if (has === want) return;
      /* The round's mode: a cell it changed is written; a blank cell takes
         the matrix's value; anything the office typed is left as typed. */
      if (changedKeys && !changedKeys.has(keyOf(person[0], col[0])) && has !== "") {
        if (want !== "") report.leftAsTyped++;
        return;
      }

      const shape = shapeOf.get(col[0]) || { numeric: true, sample: "", style: null };
      const style = existing && existing.s != null ? existing.s : shape.style;
      if (existing && existing.hasFormula) report.formulas++;
      putCell(row, at, `${letterOf(at)}${row.num}`, style, valueFor(want, shape, existing, style));
      report.written++;
    });
  });

  /* Anyone taken off the portal: their row is emptied - the name, the rank,
     the SAM number and every date on it - rather than lifted out of the sheet.
     The same reason rows are only ever added on the end holds here: taking a
     row out moves every row under it out from under the formulas, the print
     ranges and the conditional formatting that point at them. The line is left
     blank where they were, for whoever next opens the workbook to close up. */
  if (blank && blank.size) {
    const everyCol = new Set([NAME_COL, POS_COL, SAM_COL]);
    colForCode.forEach((at) => everyCol.add(at));
    const order = [...everyCol].sort((a, b) => a - b);
    blank.forEach((who) => {
      const row = rowOf(who);
      if (!row) return;
      let emptied = 0;
      order.forEach((at) => {
        const existing = cellAt(row, at);
        if (!existing || says(existing).trim() === "") return;
        if (existing.hasFormula) report.formulas++;
        putCell(row, at, `${letterOf(at)}${row.num}`, existing.s, { kind: "blank" });
        emptied++;
      });
      if (emptied) { report.written += emptied; report.clearedRows.push(who); }
    });
  }

  // Anyone on the matrix the workbook has never had a row for. A row can only
  // go on the end — putting one in the middle would move every row under it out
  // from under the formulas and the print ranges that point at them — so it is
  // only done where the crew are the last thing on the sheet. A totals line, a
  // note, anything at all under them and the rows are left to be added by hand.
  /* Where the crew end on the sheet. It is read off everybody the matrix
     knows, not off the people this particular write concerns - a write that
     concerns one newcomer and nobody else would otherwise find no crew rows at
     all and leave them off the workbook. */
  const placed = quals.rows
    .map((p) => rowOf(p[0]))
    .filter((r) => r !== undefined);
  if (report.skippedRows.length && placed.length) {
    const lastCrew = placed.reduce((a, b) => (b.num > a.num ? b : a));
    const below = sheet.rows.filter((r) => r.num > lastCrew.num && r.cells.some((c) => says(c) !== ""));
    {
      const template = lastCrew;
      let num = lastCrew.num;
      const adding = report.skippedRows.slice();
      report.skippedRows = [];

      /** @type {string[]} */
      const newRowXml = [];
      adding.forEach((name) => {
        const person = quals.rows.find((p) => p[0] === name);
        // Every name here came off quals.rows, so this never fires - and if it
        // ever did, a man quietly left off the workbook is worse than no write.
        if (!person) throw new Error("row to add is not on the matrix: " + name);
        num += 1;

        // The row above is the pattern for the new one, but a column it happens
        // to have left blank isn't in the file at all — so the columns that have
        // to be written are put in alongside it and the lot is laid out in
        // column order, which is the order a sheet has to keep its cells in.
        const styleAt = new Map();
        template.cells.forEach((c) => styleAt.set(c.col, c.s));
        [NAME_COL, POS_COL, SAM_COL].forEach((col) => {
          if (!styleAt.has(col)) styleAt.set(col, null);
        });
        const codeAt = new Map();
        colForCode.forEach((col, code) => {
          codeAt.set(col, code);
          if (!styleAt.has(col)) styleAt.set(col, (shapeOf.get(code) || {}).style ?? null);
        });

        const cells = [...styleAt.keys()].sort((a, b) => a - b).map((col) => {
          const style = styleAt.get(col);
          const ref = `${letterOf(col)}${num}`;
          if (col === NAME_COL) return cellXml(ref, style, textValue(String(person[0] || "")));
          if (col === POS_COL) return cellXml(ref, style, textValue(String(person[1] || "")));
          if (col === SAM_COL) return cellXml(ref, style, textValue(String(person[2] || "")));

          const code = codeAt.get(col);
          if (code) {
            const idx = quals.cols.findIndex((x) => x[0] === code);
            const want = only && !only.has(keyOf(person[0], code))
              ? ""
              : person[3] && person[3][idx] != null ? String(person[3][idx]).trim() : "";
            const shape = shapeOf.get(code) || { numeric: true, sample: "", style };
            return cellXml(ref, style, valueFor(want, shape, null, style));
          }
          // A counter, a total, anything else the sheet keeps its own way: the
          // look is copied, the contents are not invented.
          return cellXml(ref, style, { kind: "blank" });
        }).join("");

        newRowXml.push(`<row r="${num}">${cells}</row>`);
        report.addedRows.push(person[0]);
        report.written++;
      });

      if (!below.length) {
        /* Nothing under the crew: the new rows go on the end, as ever. */
        newRowXml.forEach((xml) => sheet.added.push(xml));
        sheet.head = extendRanges(sheet.head, lastCrew.num, num);
        sheet.tail = extendRanges(sheet.tail, lastCrew.num, num);
      } else {
        /* Notes, totals or a legend sit under the crew, so this is Excel's
           own "insert rows": everything below moves down by as many rows as
           are going in, and every reference to a moved row moves with it.
           This used to stop here and ask for the rows to be added by hand,
           which is not a thing a crewing system gets to ask. */
        const by = adding.length;
        const insertAt = lastCrew.num;

        sheet.rows = sheet.rows.map((r) => {
          let xml = rowXml(r);
          xml = remapRowFormulas(xml, insertAt, by);
          if (r.num > insertAt) xml = shiftRowXml(xml, by);
          return { num: r.num > insertAt ? r.num + by : r.num, open: r.open,
            cells: [], gaps: [""], raw: xml, dirty: false };
        });

        const at = sheet.rows.findIndex((r) => r.num > insertAt + by);
        const fresh = newRowXml.map((xml, i) => ({
          num: insertAt + 1 + i, open: "", cells: [], gaps: [""], raw: xml, dirty: false,
        }));
        if (at < 0) {
          sheet.rows.push(...fresh);
          fresh.forEach(() => sheet.gaps.splice(sheet.gaps.length - 1, 0, ""));
        } else {
          sheet.rows.splice(at, 0, ...fresh);
          fresh.forEach(() => sheet.gaps.splice(at, 0, ""));
        }

        sheet.head = shiftRanges(sheet.head, insertAt, by);
        sheet.tail = shiftRanges(sheet.tail, insertAt, by);
      }
    }
  }

  if (!report.written) return { blob: null, report };

  await setPartText(sheetPart, writeSheet(sheet));
  // Replaced formulas and inserted rows both leave Excel's calculation order
  // pointing at cells that have moved or gone; dropped, it is rebuilt on open.
  if (report.formulas || report.addedRows.length) await dropCalcChain(entries);
  await setPartText(wbPart, recalcOnOpen(workbookXml));

  return { blob: writeZip(entries), report };
}

/** The office names the crew qualification spreadsheet for the day it was last
   worked on. A workbook the portal has just written carries today's date on
   the front of it, so whoever opens the folder can see at a glance how old the
   copy in their hands is. Anything already dated has its date replaced rather
   than another one stuck on the front. `on` is the day as YYYY-MM-DD; the
   caller says which day, because only the page knows the vessel's clock. A
   caller that forgets is refused rather than obliged: stamping whatever came
   in would rename the office's spreadsheet to nonsense on SharePoint.
 * @param {string} filename
 * @param {string} on
 */
export function datedWorkbookName(filename, on) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(on || ""))) throw new Error("datedWorkbookName needs the day as YYYY-MM-DD");
  const stamp = String(on).replace(/-/g, "");
  const name = String(filename || "CREW QUALIFICATION EXPIRY.xlsx");
  return /^\d{8}\s*-\s*/.test(name) ? name.replace(/^\d{8}\s*-\s*/, stamp + " - ") : stamp + " - " + name;
}
