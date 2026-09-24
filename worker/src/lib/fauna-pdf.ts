import { PdfDoc, textWidth, wrapText, type Rgb } from "./pdf.js";
import { readZip, partOf, partText, listSheets, readSheetRows } from "../../../source/shared/workbook.js";
import { FIELDS, monthName, isBlank } from "../../../source/fauna/fields.js";

/**
 * The month's log as a PDF, laid out the way the office's sheet is: the
 * title and vessel, the monitoring-zone table, then the 31 columns with an
 * entry a row — on A3 landscape, the header repeated on every page.
 *
 * The title, the zone table and the column widths are read off the app's
 * template (the office's own workbook), so the PDF follows the sheet.
 */

type FaunaRecord = Record<string, unknown>;

const A3 = { w: 1190.55, h: 841.89 };
const MARGIN = 28;
const HEAD_BLUE: Rgb = [0.18, 0.35, 0.55];
const BAND: Rgb = [0.87, 0.91, 0.96];
const GRID: Rgb = [0.6, 0.66, 0.72];
const INK: Rgb = [0.08, 0.16, 0.23];
const MUTE: Rgb = [0.36, 0.46, 0.53];
const FOOTER = "Printed copies of this document are not controlled. Please ensure that this is the latest available version before use.";

// The sheet is wider than A3 at full size, so it is drawn at about two
// thirds; six-point type is what fits a species name in its column.
const BODY = 6;
const BODY_LINE = 7.2;
const HEAD = 6;
const HEAD_LINE = 7.2;
const PAD = 1.5;

/** What the template's month tab says above the header: the words the PDF repeats. */
async function templateWords(template: ArrayBuffer) {
  const entries = readZip(template);
  const wb = partOf(entries, "xl/workbook.xml");
  const rels = partOf(entries, "xl/_rels/workbook.xml.rels");
  const sheets = wb && rels ? listSheets(await partText(wb), await partText(rels)) : [];
  const tab = sheets.find((s) => s.name !== "Sheet1") || sheets[0];
  const rows = tab ? await readSheetRows(entries, tab.path) : [];
  const cell = (r: number, c: number) => (rows[r - 1] || [])[c - 1] || "";
  // Column widths in Excel's character units, from the sheet's own <cols>.
  const widths: number[] = Array(31).fill(9);
  if (tab) {
    const xml = await partText(partOf(entries, tab.path));
    for (const m of xml.matchAll(/<col\b[^>]*\bmin="(\d+)"[^>]*\bmax="(\d+)"[^>]*\bwidth="([\d.]+)"/g)) {
      for (let c = Number(m[1]); c <= Number(m[2]) && c <= 31; c++) widths[c - 1] = Number(m[3]);
    }
  }
  return {
    title: cell(1, 4) || "MARINE FAUNA OBSERVATION LOG",
    vesselLabel: cell(3, 4) || "Vessel Name:",
    vessel: cell(3, 6) || "",
    zoneTitle: cell(5, 1) || "Monitoring Zones related to Fauna",
    zoneHead: [cell(6, 1) || "Fauna", `${cell(5, 4) || "Caution Zone"} ${cell(6, 4) || "Distance (m)"}`, `${cell(5, 5) || "No Approach Zone"} ${cell(6, 5) || "Distance (m)"}`],
    zones: [7, 8, 9, 10, 11, 12].map((r) => [cell(r, 1), cell(r, 4), cell(r, 5)]).filter((z) => z[0]),
    note: cell(13, 18) || "",
    groups: [
      { from: 15, to: 16, text: cell(14, 15) || "Vessel Position" },
      { from: 22, to: 23, text: cell(14, 22) || "Group Composition" },
    ],
    headers: FIELDS.map((f, i) => cell(15, i + 1) || f.label),
    widths,
  };
}

/** A column's value as the sheet shows it. */
function cellText(key: string, v: unknown): string {
  if (isBlank(v)) return "";
  if (key === "date") { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v)); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v); }
  return String(v);
}

/**
 * The columns' widths on the page: the sheet's own proportions, except that
 * no column is narrower than its widest ordinary value - a date, a position,
 * the longest word on its dropdown - with the difference taken from the
 * columns that have room to spare.
 */
export function columnWidths(sheetWidths: number[], usable: number): number[] {
  const sample = (key: string): string => {
    const f = FIELDS.find((x) => x.key === key)!;
    if (key === "date") return "24/09/2026";
    if (key === "time") return "07:40";
    if (key === "lat" || key === "long") return "114°52.1'E";
    if (f.kind === "list" && f.options) return f.options.reduce((a, b) => (textWidth(b, BODY) > textWidth(a, BODY) ? b : a), "");
    if (key === "species") return "Bottlenose";
    if (key === "windDir") return "Variable";
    if (f.kind === "number") return "3000";
    if (f.kind === "yesno") return "Yes";
    return "";
  };
  const min = FIELDS.map((f) => textWidth(sample(f.key), BODY) + 2 * PAD + 1);
  const scale = usable / sheetWidths.reduce((a, b) => a + b, 0);
  const w = sheetWidths.map((x) => x * scale);
  for (let pass = 0; pass < 3; pass++) {
    let deficit = 0;
    for (let i = 0; i < w.length; i++) if (w[i] < min[i]) { deficit += min[i] - w[i]; w[i] = min[i]; }
    if (deficit < 0.01) break;
    const slack = w.map((x, i) => Math.max(0, x - min[i]));
    const total = slack.reduce((a, b) => a + b, 0);
    if (!total) break;
    for (let i = 0; i < w.length; i++) w[i] -= (deficit * slack[i]) / total;
  }
  return w;
}

export async function monthPdf(template: ArrayBuffer, month: string, entries: FaunaRecord[]): Promise<Uint8Array> {
  const words = await templateWords(template);
  const pdf = new PdfDoc(A3.w, A3.h);
  const usable = A3.w - 2 * MARGIN;
  const colW = columnWidths(words.widths, usable);
  const colX = colW.map((_, i) => MARGIN + colW.slice(0, i).reduce((a, b) => a + b, 0));
  const monthTitle = `${monthName(month)} ${month.slice(0, 4)}`;
  const sorted = [...entries].sort((a, b) => `${a.date || ""}T${a.time || ""}`.localeCompare(`${b.date || ""}T${b.time || ""}`));

  // The header row's lines, wrapped once for every page.
  const headLines = words.headers.map((h, i) => wrapText(h, HEAD, colW[i] - 2 * PAD, true));
  const headH = Math.max(...headLines.map((l) => l.length)) * HEAD_LINE + 2 * PAD + 2;
  const groupH = 11;
  const footerTop = A3.h - MARGIN - 10;

  let page = pdf.addPage();
  let y = MARGIN;

  /* ---- the title and the zone table, first page only ---- */
  pdf.text(page, MARGIN, y, words.title, 13, { bold: true, color: INK });
  pdf.text(page, A3.w - MARGIN - textWidth(monthTitle, 11, true), y + 1, monthTitle, 11, { bold: true, color: INK });
  y += 18;
  pdf.text(page, MARGIN, y, `${words.vesselLabel} ${words.vessel}`, 9, { color: INK });
  y += 16;

  const zw = [110, 90, 420];
  const zx = [MARGIN, MARGIN + zw[0], MARGIN + zw[0] + zw[1]];
  const zoneRow = (cells: string[], bold: boolean, fill?: Rgb) => {
    const lines = cells.map((c, i) => wrapText(c, 7, zw[i] - 2 * PAD, bold));
    const h = Math.max(...lines.map((l) => l.length)) * 8.4 + 2 * PAD;
    cells.forEach((_, i) => {
      pdf.rect(page, zx[i], y, zw[i], h, { fill, stroke: GRID, lineWidth: 0.4 });
      lines[i].forEach((line, k) => pdf.text(page, zx[i] + PAD, y + PAD + k * 8.4, line, 7, { bold, color: INK }));
    });
    y += h;
  };
  pdf.text(page, MARGIN, y, words.zoneTitle, 8, { bold: true, color: INK });
  y += 11;
  zoneRow(words.zoneHead, true, BAND);
  for (const z of words.zones) zoneRow(z, false);
  if (words.note) { y += 6; pdf.text(page, MARGIN, y, words.note, 7, { color: MUTE }); y += 10; }
  y += 8;

  /* ---- the table ---- */
  const drawHeader = () => {
    for (const g of words.groups) {
      const x = colX[g.from - 1];
      const w = colX[g.to - 1] + colW[g.to - 1] - x;
      pdf.rect(page, x, y, w, groupH, { fill: BAND, stroke: GRID, lineWidth: 0.4 });
      pdf.text(page, x + (w - textWidth(g.text, 6.5, true)) / 2, y + 2, g.text, 6.5, { bold: true, color: INK });
    }
    y += groupH;
    pdf.rect(page, MARGIN, y, usable, headH, { fill: HEAD_BLUE });
    for (let i = 0; i < FIELDS.length; i++) {
      pdf.rect(page, colX[i], y, colW[i], headH, { stroke: [1, 1, 1], lineWidth: 0.4 });
      headLines[i].forEach((line, k) => pdf.text(page, colX[i] + PAD, y + PAD + 1 + k * HEAD_LINE, line, HEAD, { bold: true, color: [1, 1, 1] }));
    }
    y += headH;
  };
  const newPage = () => {
    page = pdf.addPage();
    y = MARGIN;
    pdf.text(page, MARGIN, y, `${words.title} — ${words.vessel} — ${monthTitle} (continued)`, 9, { bold: true, color: INK });
    y += 16;
    drawHeader();
  };
  drawHeader();

  sorted.forEach((entry, idx) => {
    const lines = FIELDS.map((f, i) => wrapText(cellText(f.key, entry[f.key]), BODY, colW[i] - 2 * PAD));
    const h = Math.max(1, ...lines.map((l) => l.length)) * BODY_LINE + 2 * PAD;
    if (y + h > footerTop - 4) newPage();
    if (idx % 2 === 1) pdf.rect(page, MARGIN, y, usable, h, { fill: BAND });
    for (let i = 0; i < FIELDS.length; i++) {
      pdf.rect(page, colX[i], y, colW[i], h, { stroke: GRID, lineWidth: 0.3 });
      lines[i].forEach((line, k) => pdf.text(page, colX[i] + PAD, y + PAD + k * BODY_LINE, line, BODY, { color: INK }));
    }
    y += h;
  });
  if (!sorted.length) {
    const h = BODY_LINE + 2 * PAD;
    pdf.rect(page, MARGIN, y, usable, h, { stroke: GRID, lineWidth: 0.3 });
    pdf.text(page, MARGIN + PAD, y + PAD, "Nil sightings", BODY, { color: INK });
    y += h;
  }

  /* ---- the footer, on every page, once the count is known ---- */
  const total = pdf.pageCount;
  for (let p = 0; p < total; p++) {
    pdf.text(p, MARGIN, footerTop, FOOTER, 6.5, { color: MUTE });
    const pageWord = `PAGE ${p + 1} OF ${total}`;
    pdf.text(p, A3.w - MARGIN - textWidth(pageWord, 6.5, true), footerTop, pageWord, 6.5, { bold: true, color: MUTE });
  }
  return pdf.build();
}
