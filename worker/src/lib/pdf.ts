/**
 * A small PDF writer: pages of text, lines and boxes in Helvetica, nothing
 * else — enough to print a log as a table. No library, so nothing to keep
 * up and nothing that stops working in the worker.
 *
 * Text is in the PDF's own WinAnsi encoding, which carries the degree sign,
 * the multiplication sign and the usual accents; anything else becomes a
 * question mark rather than a broken file. Widths are Helvetica's own, so
 * text can be measured and wrapped to a column before it is drawn.
 */

// Helvetica and Helvetica-Bold advance widths for the printable ASCII
// range, per 1000 units of font size, from the standard font metrics.
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584,
];
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975,
  722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  333, 278, 333, 584, 556, 333,
  556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500,
  389, 280, 389, 584,
];

// The characters beyond ASCII the log actually uses, with their WinAnsi
// codes and widths.
const EXTRA: Record<string, { code: number; w: number; wb: number }> = {
  "°": { code: 0xb0, w: 400, wb: 400 },
  "×": { code: 0xd7, w: 584, wb: 584 },
  "±": { code: 0xb1, w: 584, wb: 584 },
  "½": { code: 0xbd, w: 834, wb: 834 },
  "’": { code: 0x92, w: 222, wb: 278 },
  "‘": { code: 0x91, w: 222, wb: 278 },
  "“": { code: 0x93, w: 333, wb: 500 },
  "”": { code: 0x94, w: 333, wb: 500 },
  "–": { code: 0x96, w: 556, wb: 556 },
  "—": { code: 0x97, w: 1000, wb: 1000 },
  "é": { code: 0xe9, w: 556, wb: 556 },
  "è": { code: 0xe8, w: 556, wb: 556 },
  "ü": { code: 0xfc, w: 556, wb: 611 },
  "ö": { code: 0xf6, w: 556, wb: 611 },
  "ä": { code: 0xe4, w: 556, wb: 556 },
  "ñ": { code: 0xf1, w: 556, wb: 611 },
};

function charWidth(ch: string, bold: boolean): number {
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 126) return (bold ? BOLD : REGULAR)[code - 32];
  const extra = EXTRA[ch];
  if (extra) return bold ? extra.wb : extra.w;
  return 556;
}

/** The width of a string at a size, in points. */
export function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch, bold);
  return (w * size) / 1000;
}

/**
 * A string broken into lines no wider than the width: at spaces where it
 * can, and inside a word only when the word alone is too wide. The sheet's
 * own line breaks are kept.
 */
export function wrapText(s: string, size: number, maxWidth: number, bold = false): string[] {
  const lines: string[] = [];
  for (const para of String(s ?? "").replace(/\r/g, "").split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const trial = line ? line + " " + word : word;
      if (textWidth(trial, size, bold) <= maxWidth) { line = trial; continue; }
      if (line) lines.push(line);
      // A word wider than the column is cut where it has to be.
      let piece = "";
      for (const ch of word) {
        if (textWidth(piece + ch, size, bold) > maxWidth && piece) { lines.push(piece); piece = ch; }
        else piece += ch;
      }
      line = piece;
    }
    lines.push(line);
  }
  return lines;
}

/** A string as the PDF wants it inside parentheses: escaped, WinAnsi bytes as octal. */
function encode(s: string): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    const code = ch.charCodeAt(0);
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else if (code >= 32 && code <= 126) out += ch;
    else if (EXTRA[ch]) out += "\\" + EXTRA[ch].code.toString(8).padStart(3, "0");
    else out += "?";
  }
  return out;
}

export type Rgb = [number, number, number];
const rgb = (c: Rgb) => c.map((v) => v.toFixed(3)).join(" ");
const n = (v: number) => (Math.round(v * 100) / 100).toString();

export class PdfDoc {
  readonly width: number;
  readonly height: number;
  private pages: string[][] = [];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  get pageCount() { return this.pages.length; }

  addPage() { this.pages.push([]); return this.pages.length - 1; }

  private ops(page: number) {
    if (page < 0 || page >= this.pages.length) throw new Error("no such page");
    return this.pages[page];
  }

  /** Text with its top-left corner at (x, yTop), measured from the top of the page. */
  text(page: number, x: number, yTop: number, s: string, size: number, opts: { bold?: boolean; color?: Rgb } = {}) {
    const font = opts.bold ? "/F2" : "/F1";
    // Helvetica's ascent puts the baseline about 0.72 of the size below the top.
    const y = this.height - yTop - size * 0.78;
    this.ops(page).push(`BT ${rgb(opts.color ?? [0, 0, 0])} rg ${font} ${n(size)} Tf 1 0 0 1 ${n(x)} ${n(y)} Tm (${encode(s)}) Tj ET`);
  }

  /** A box; filled, outlined, or both. */
  rect(page: number, x: number, yTop: number, w: number, h: number, opts: { fill?: Rgb; stroke?: Rgb; lineWidth?: number } = {}) {
    const y = this.height - yTop - h;
    const parts: string[] = [];
    if (opts.fill) parts.push(`${rgb(opts.fill)} rg ${n(x)} ${n(y)} ${n(w)} ${n(h)} re f`);
    if (opts.stroke) parts.push(`${rgb(opts.stroke)} RG ${n(opts.lineWidth ?? 0.5)} w ${n(x)} ${n(y)} ${n(w)} ${n(h)} re S`);
    if (parts.length) this.ops(page).push(parts.join(" "));
  }

  line(page: number, x1: number, y1Top: number, x2: number, y2Top: number, opts: { color?: Rgb; lineWidth?: number } = {}) {
    this.ops(page).push(
      `${rgb(opts.color ?? [0, 0, 0])} RG ${n(opts.lineWidth ?? 0.5)} w ${n(x1)} ${n(this.height - y1Top)} m ${n(x2)} ${n(this.height - y2Top)} l S`,
    );
  }

  /** The finished file. */
  build(): Uint8Array {
    const objects: string[] = [];
    const add = (body: string) => { objects.push(body); return objects.length; };
    add("<< /Type /Catalog /Pages 2 0 R >>");
    add(""); // the pages tree, filled in once the pages exist
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const kids: number[] = [];
    for (const ops of this.pages) {
      const content = ops.join("\n");
      const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      const pageId = add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(this.width)} ${n(this.height)}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
      );
      kids.push(pageId);
    }
    objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

    let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    // Every character is a byte: the text is octal-escaped ASCII and the
    // marker line above is four bytes on purpose.
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}
