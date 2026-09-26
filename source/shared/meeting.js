/* The safety meeting recorder's rules - the page and the worker both run
 * these (source/shared/, see tools/source.mjs: no import here, and what a
 * rule leans on from another file is handed in by the caller).
 *
 * The sound is cut into pieces of about a minute, each ended at a quiet
 * moment so no word is cut in half (pieceEnd), and each sent to the
 * speech-to-text service as a 16 kHz mono WAV (wavBytes) - the rate the
 * model itself listens at, so nothing is lost, and a minute is under two
 * megabytes. The words come back a piece at a time and are put together
 * with the minute each began at (joinPieces). The minutes the model writes
 * are laid out as plain text (minutesText) for the person to correct on the
 * page, and posted as a Word document (minutesDocument, built with the zip
 * writer in workbook.js, which the caller hands in).
 */

/** The rate the pieces are sent at: whisper's own, mono. */
export const PIECE_RATE = 16000;
/** A piece is about a minute. */
export const PIECE_SECONDS = 60;
/** The cut is made at the quietest tenth of a second in the last ten
 *  seconds of the minute, so a word is not split across two pieces. */
export const PIECE_QUIET_WINDOW = 10;
/** The most the worker takes for one piece (a minute at 16 kHz is 1.9 MB). */
export const PIECE_MAX_BYTES = 3 * 1024 * 1024;
/** The most a meeting's recording may be when it is posted: two hours of
 *  a phone's voice recorder, or four of the page's own. */
export const RECORDING_MAX_BYTES = 60 * 1024 * 1024;

export const TRANSCRIBE_API = "/api/meeting/transcribe";
export const MINUTES_API = "/api/meeting/minutes";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** The three files a meeting posts, told apart on the page by their tag. */
export const MEETING_TAGS = { minutes: "Minutes", transcript: "Transcript", recording: "Recording" };
/** The headings the minutes are laid out under, in this order. */
export const MINUTES_HEADINGS = ["Present", "Apologies", "Items raised", "Actions", "Next meeting", "To check"];

/* ------------------------------------------------------------ the sound --- */

/**
 * Where the piece that starts at `start` ends: a minute on, moved back to
 * the quietest tenth of a second in the last ten seconds, or the end of
 * the samples where less than a minute is left (the caller decides
 * whether that remainder is worth sending).
 * @param {Float32Array} samples
 * @param {number} rate
 * @param {number} start
 * @param {number} [seconds]
 * @param {number} [window]
 */
export function pieceEnd(samples, rate, start, seconds = PIECE_SECONDS, window = PIECE_QUIET_WINDOW) {
  const full = start + Math.round(seconds * rate);
  if (full >= samples.length) return samples.length;
  const frame = Math.max(1, Math.round(rate / 10));
  const from = Math.max(start + frame, full - Math.round(window * rate));
  let best = full;
  let quietest = Infinity;
  for (let at = from; at + frame <= full; at += frame) {
    let energy = 0;
    for (let i = at; i < at + frame; i++) energy += samples[i] * samples[i];
    if (energy < quietest) {
      quietest = energy;
      best = at + (frame >> 1);
    }
  }
  return best;
}

/**
 * The samples brought down to a lower rate by averaging, for a microphone
 * the browser will only run faster than the pieces are sent at. A rate no
 * higher than the one asked for is left as it is.
 * @param {Float32Array} samples
 * @param {number} fromRate
 * @param {number} toRate
 */
export function downsample(samples, fromRate, toRate) {
  if (fromRate <= toRate) return samples;
  const ratio = fromRate / toRate;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += samples[j];
    out[i] = b > a ? sum / (b - a) : 0;
  }
  return out;
}

/**
 * A 16-bit mono WAV of the samples, header and all.
 * @param {Float32Array} samples
 * @param {number} rate
 */
export function wavBytes(samples, rate) {
  const n = samples.length;
  const out = new Uint8Array(44 + n * 2);
  const v = new DataView(out.buffer);
  const tag = (/** @type {number} */ at, /** @type {string} */ s) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  tag(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); tag(8, "WAVE");
  tag(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/**
 * "[mm:ss]" for a number of seconds into the meeting.
 * @param {number} seconds
 */
export const stampOf = (seconds) => {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `[${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}]`;
};

/**
 * The transcript: each piece's words as a paragraph under the minute it
 * began at, a piece that heard nothing left out.
 * @param {{ at: number, text: string }[]} pieces
 */
export function joinPieces(pieces) {
  return (pieces || [])
    .map((p) => ({ at: p.at, text: String(p.text || "").replace(/\s+/g, " ").trim() }))
    .filter((p) => p.text)
    .map((p) => `${stampOf(p.at)} ${p.text}`)
    .join("\n\n");
}

/* --------------------------------------------------------- the minutes --- */

const MEETING_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "26 Sep 2026" for a yyyy-mm-dd; the text as it came where it is not one.
 * @param {unknown} iso
 */
export const dayWords = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${Number(m[3])} ${MEETING_MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}` : String(iso || "");
};

/**
 * The title a meeting is posted under.
 * @param {unknown} iso
 */
export const meetingTitle = (iso) => `Vessel safety meeting - ${dayWords(iso)}`;

/**
 * The name of one of the meeting's three files.
 * @param {unknown} iso
 * @param {string} kind
 * @param {string} ext
 */
export const meetingFileName = (iso, kind, ext) => `Vessel safety meeting ${String(iso || "").slice(0, 10)} - ${kind}.${ext}`;

/** @param {unknown} s */
const meetingClean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

/**
 * "what - who, by when" for one action, empty where there is no what.
 * @param {unknown} a
 */
export const actionLine = (a) => {
  if (!a || typeof a !== "object") return meetingClean(a);
  const it = /** @type {{ what?: unknown, who?: unknown, when?: unknown }} */ (a);
  const what = meetingClean(it.what);
  if (!what) return "";
  const who = meetingClean(it.who);
  const when = meetingClean(it.when);
  return what + (who ? ` - ${who}` : "") + (when ? `, by ${when}` : "");
};

/**
 * The minutes the model wrote, laid out as the plain text the page shows
 * for correcting: the title, who chaired, then each heading with its
 * lines, the items numbered with what was decided and the actions under
 * each, every action again under Actions, and what the transcript left
 * unclear under To check. The model's answer is taken as it comes: a
 * field missing, null or the wrong shape is left out, never made up.
 * @param {unknown} m
 * @param {{ title?: string, chair?: string }} [about]
 */
export function minutesText(m, about = {}) {
  const got = /** @type {Record<string, unknown>} */ (m && typeof m === "object" ? m : {});
  const lines = [about.title || "Vessel safety meeting"];
  if (meetingClean(about.chair)) lines.push(`Chaired by ${meetingClean(about.chair)}`);
  const list = (/** @type {string} */ heading, /** @type {unknown} */ items, /** @type {string | null} */ none) => {
    const said = (Array.isArray(items) ? items : []).map(meetingClean).filter(Boolean);
    if (!said.length && !none) return;
    lines.push("", heading);
    if (said.length) said.forEach((s) => lines.push(`- ${s}`));
    else lines.push(`- ${none}`);
  };
  list("Present", got.present, "nobody named");
  list("Apologies", got.apologies, null);
  lines.push("", "Items raised");
  const items = Array.isArray(got.items) ? got.items : [];
  if (!items.length) lines.push("- none");
  /** @type {string[]} */
  const actions = [];
  items.forEach((it, i) => {
    const item = /** @type {Record<string, unknown>} */ (it && typeof it === "object" ? it : { heading: meetingClean(it) });
    lines.push(`${i + 1}. ${meetingClean(item.heading) || "Item"}`);
    if (meetingClean(item.discussion)) lines.push(meetingClean(item.discussion));
    if (meetingClean(item.decided)) lines.push(`Decided: ${meetingClean(item.decided)}`);
    (Array.isArray(item.actions) ? item.actions : []).forEach((a) => {
      const line = actionLine(a);
      if (!line) return;
      lines.push(`Action: ${line}`);
      actions.push(line);
    });
    lines.push("");
  });
  lines.push("Actions");
  if (actions.length) actions.forEach((a) => lines.push(`- ${a}`));
  else lines.push("- none");
  if (meetingClean(got.nextMeeting)) lines.push("", "Next meeting", meetingClean(got.nextMeeting));
  list("To check", got.toCheck, null);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/**
 * The lines of the minutes as typed, each sorted: the first line is the
 * title, "Chaired by ..." under it is the subtitle, a line that is one of
 * the headings is a heading, "1. ..." is an item, "- ..." is a bullet,
 * and anything else is a paragraph. Blank lines are left out.
 * @param {string} text
 * @returns {{ kind: "title" | "sub" | "heading" | "item" | "bullet" | "para", text: string }[]}
 */
export function minutesLines(text) {
  /** @type {{ kind: "title" | "sub" | "heading" | "item" | "bullet" | "para", text: string }[]} */
  const out = [];
  const headings = MINUTES_HEADINGS.map((h) => h.toLowerCase());
  String(text || "").split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    if (!out.length) out.push({ kind: "title", text: line });
    else if (out.length === 1 && /^chaired by\b/i.test(line)) out.push({ kind: "sub", text: line });
    else if (headings.includes(line.replace(/:$/, "").toLowerCase())) out.push({ kind: "heading", text: line.replace(/:$/, "") });
    else if (/^\d+[.)]\s+/.test(line)) out.push({ kind: "item", text: line });
    else if (/^[-•*]\s+/.test(line)) out.push({ kind: "bullet", text: line.replace(/^[-•*]\s+/, "") });
    else out.push({ kind: "para", text: line });
  });
  return out;
}

/** @param {unknown} s */
const docxEsc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* One paragraph of the Word document: the runs, then how the paragraph
   sits. Everything is direct formatting - the document carries no styles
   part, so it reads the same in Word, LibreOffice, Google Docs and a
   phone's preview. */
/**
 * @param {string} text
 * @param {{ bold?: boolean, italic?: boolean, size?: number }} [look]
 */
const docxRun = (text, { bold = false, italic = false, size = 22 } = {}) =>
  `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>${bold ? "<w:b/>" : ""}${italic ? "<w:i/>" : ""}<w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${docxEsc(text)}</w:t></w:r>`;
/**
 * @param {string} runs
 * @param {{ before?: number, after?: number, indent?: number, hanging?: number }} [sits]
 */
const docxParagraph = (runs, { before = 0, after = 80, indent = 0, hanging = 0 } = {}) =>
  `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}"/>${indent ? `<w:ind w:left="${indent}" w:hanging="${hanging}"/>` : ""}</w:pPr>${runs}</w:p>`;

/**
 * A line with "Decided:" or "Action:" in front has that word in bold.
 * @param {string} text
 * @param {number} size
 */
const docxLedRuns = (text, size) => {
  const m = /^(Decided|Action|Next meeting):\s*/.exec(text);
  return m ? docxRun(m[0], { bold: true, size }) + docxRun(text.slice(m[0].length), { size }) : docxRun(text, { size });
};

/**
 * The parts of the Word document the minutes are posted as, as XML text:
 * the content types, the package relationships and the document itself.
 * @param {string} text
 * @returns {{ name: string, xml: string }[]}
 */
export function minutesDocxParts(text) {
  const body = minutesLines(text).map((l) => {
    switch (l.kind) {
      case "title": return docxParagraph(docxRun(l.text, { bold: true, size: 36 }), { after: 60 });
      case "sub": return docxParagraph(docxRun(l.text, { italic: true, size: 22 }), { after: 240 });
      case "heading": return docxParagraph(docxRun(l.text, { bold: true, size: 28 }), { before: 240, after: 80 });
      case "item": return docxParagraph(docxRun(l.text, { bold: true, size: 24 }), { before: 160, after: 60 });
      case "bullet": return docxParagraph(docxRun("•  ", { size: 22 }) + docxLedRuns(l.text, 22), { indent: 360, hanging: 360, after: 40 });
      default: return docxParagraph(docxLedRuns(l.text, 22));
    }
  }).join("");
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  return [
    {
      name: "[Content_Types].xml",
      xml: head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + "</Types>",
    },
    {
      name: "_rels/.rels",
      xml: head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        + "</Relationships>",
    },
    {
      name: "word/document.xml",
      xml: head + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        + body
        + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
        + "</w:body></w:document>",
    },
  ];
}

/**
 * The minutes as a Word document (a .docx is a zip of XML parts). The zip
 * writer is workbook.js's, handed in: { crc32, deflateRaw, writeZip }.
 * @param {string} text
 * @param {{ crc32: (b: Uint8Array) => number, deflateRaw: (b: Uint8Array) => Promise<Uint8Array>, writeZip: (entries: any[], mime?: string) => Blob }} zip
 */
export async function minutesDocument(text, zip) {
  const enc = new TextEncoder();
  const entries = [];
  for (const part of minutesDocxParts(text)) {
    const bytes = enc.encode(part.xml);
    const body = await zip.deflateRaw(bytes);
    // 1 Jan 1980, midnight: the zip's own epoch, the same on every build.
    entries.push({ name: part.name, flag: 0, method: 8, time: 0, date: 0x21, crc: zip.crc32(bytes), csize: body.length, usize: bytes.length, body });
  }
  return zip.writeZip(entries, DOCX_MIME);
}

/**
 * The transcript file: the meeting named at the top, then the words.
 * @param {string} transcript
 * @param {{ title?: string, chair?: string }} [about]
 */
export const transcriptText = (transcript, about = {}) =>
  `${about.title || "Vessel safety meeting"}\n${meetingClean(about.chair) ? `Chaired by ${meetingClean(about.chair)}\n` : ""}\n${String(transcript || "").trim()}\n`;

/**
 * The page's document list with a meeting's three files folded into one
 * line: a transcript or a recording whose title is a minutes row's is
 * carried on that row as `also`, and one with no minutes to sit under
 * stays a row of its own.
 * @template {{ id?: string, title?: string, tag?: string }} D
 * @param {D[]} docs
 * @returns {(D & { also?: { label: string, doc: D }[] })[]}
 */
export function meetingRows(docs) {
  const list = Array.isArray(docs) ? docs : [];
  /** @type {Map<string, D & { also: { label: string, doc: D }[] }>} */
  const minutesOf = new Map();
  list.forEach((d) => {
    if (d && d.tag === MEETING_TAGS.minutes && d.title && !minutesOf.has(d.title)) minutesOf.set(d.title, { ...d, also: [] });
  });
  /** @type {(D & { also?: { label: string, doc: D }[] })[]} */
  const out = [];
  list.forEach((d) => {
    const owner = d && d.title && (d.tag === MEETING_TAGS.transcript || d.tag === MEETING_TAGS.recording) ? minutesOf.get(d.title) : null;
    const own = d && d.title && d.tag === MEETING_TAGS.minutes ? minutesOf.get(d.title) : null;
    if (owner) owner.also.push({ label: String(d.tag), doc: d });
    else if (own && own.id === d.id) out.push(own);
    else out.push(d);
  });
  return out;
}
