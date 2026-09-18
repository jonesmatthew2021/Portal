/**
 * Wrapping a scanned image as a one-page PDF, with nothing but bytes.
 *
 * The crew's certificates arrive as photos as often as PDFs, and the filing
 * rule is PDF. A JPEG goes into the page exactly as it is (PDF speaks JPEG
 * natively as DCTDecode); a PNG's pixel stream is carried over as
 * FlateDecode with the predictor PDF shares with PNG, so neither is
 * re-encoded and nothing is lost. The page is the image's own size.
 *
 * What can't be wrapped honestly is left alone: interlaced or paletted or
 * alpha-carrying PNGs, HEIC, and anything that isn't an image — those keep
 * their own format, and the caller files them as they came.
 */

const enc = (s: string) => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
};

function jpegSize(b: Uint8Array): { w: number; h: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    // Start-of-frame markers carry the dimensions (all SOFn except DHT/DAC/RST).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function pngInfo(b: Uint8Array) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) return null;
  const w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
  const h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
  const bitDepth = b[24];
  const colorType = b[25];
  const interlace = b[28];
  // Only the shapes whose pixel stream PDF can take verbatim: 8-bit
  // greyscale (0) or RGB (2), not interlaced.
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 0 && colorType !== 2)) return null;
  const idat: Uint8Array[] = [];
  let i = 8;
  while (i + 8 <= b.length) {
    const len = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (type === "IDAT") idat.push(b.slice(i + 8, i + 8 + len));
    if (type === "IEND") break;
    i += 12 + len;
  }
  if (!idat.length) return null;
  let total = 0;
  idat.forEach((c) => (total += c.length));
  const data = new Uint8Array(total);
  let at = 0;
  idat.forEach((c) => { data.set(c, at); at += c.length; });
  return { w, h, colorType, data };
}

function buildPdf(image: {
  w: number; h: number; colorSpace: string; filter: string;
  decodeParms?: string; data: Uint8Array;
}) {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [0];
  let length = 0;
  const push = (bytes: Uint8Array) => { parts.push(bytes); length += bytes.length; };
  const obj = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = length;
    push(enc(`${n} 0 obj\n${body}\n`));
    if (stream) {
      push(enc("stream\n"));
      push(stream);
      push(enc("\nendstream\n"));
    }
    push(enc("endobj\n"));
  };

  push(enc("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"));
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${image.w} ${image.h}] ` +
    `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${image.w} /Height ${image.h} ` +
    `/ColorSpace ${image.colorSpace} /BitsPerComponent 8 /Filter ${image.filter} ` +
    `${image.decodeParms || ""} /Length ${image.data.length} >>`, image.data);
  const content = enc(`q ${image.w} 0 0 ${image.h} 0 0 cm /Im0 Do Q`);
  obj(5, `<< /Length ${content.length} >>`, content);

  const xrefAt = length;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let n = 1; n <= 5; n++) xref += String(offsets[n]).padStart(10, "0") + " 00000 n \n";
  push(enc(xref));
  push(enc(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let at = 0;
  parts.forEach((p) => { out.set(p, at); at += p.length; });
  return out;
}

/** The image as a one-page PDF, or null when it isn't one this can carry. */
export function imageToPdf(bytes: ArrayBuffer, contentType: string | null): Uint8Array | null {
  const b = new Uint8Array(bytes);
  const type = (contentType || "").toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg") || (b[0] === 0xff && b[1] === 0xd8)) {
    const size = jpegSize(b);
    if (!size || !size.w || !size.h) return null;
    return buildPdf({ w: size.w, h: size.h, colorSpace: "/DeviceRGB", filter: "/DCTDecode", data: b });
  }
  if (type.includes("png") || (b[0] === 0x89 && b[1] === 0x50)) {
    const png = pngInfo(b);
    if (!png || !png.w || !png.h) return null;
    const colors = png.colorType === 2 ? 3 : 1;
    return buildPdf({
      w: png.w, h: png.h,
      colorSpace: png.colorType === 2 ? "/DeviceRGB" : "/DeviceGray",
      filter: "/FlateDecode",
      decodeParms: `/DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent 8 /Columns ${png.w} >>`,
      data: png.data,
    });
  }
  return null;
}
