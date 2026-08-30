/* Packs the portal into plain-text files that can be downloaded from /review/
   and handed to Claude (or any other reviewer) for checking.

   Two things make this necessary rather than "just download index.html". The
   first is that the portal is not only index.html: the file store, the crew
   matrix analysis and the database live in netlify/functions and db/, and a
   review that can't see them is guessing. The second is that index.html is
   492 KB, and roughly 200 KB of that is the logo and the app icons embedded as
   base64 — thousands of characters of noise that crowd out the code anyone
   actually wants read. So the images are swapped for a one-line placeholder on
   the way in.

   Three files come out, because one review of everything at once is not always
   what you want:

     coolibah-portal-source.txt          everything, in one file
     coolibah-portal-no-certificates.txt everything except the certificate side
     coolibah-certificates.txt           only the certificate side

   The split is by declaration rather than by line range, because the
   certificate work is not in one place: uploading and reading certificates
   sits low in index.html, while the expiry matrix those dates feed sits well
   above it. Every piece taken out of the no-certificates file leaves a marker
   behind saying what was removed and where it went, so nothing disappears
   silently.

   Run it after changing any source file:

       node scripts/build-review-bundle.mjs

   No dependencies, nothing installed, no build step — it reads files and writes
   files. */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW = join(ROOT, "review");

const FULL = "coolibah-portal-source.txt";
const NO_CERTS = "coolibah-portal-no-certificates.txt";
const CERTS_ONLY = "coolibah-certificates.txt";

/* Ordered deliberately: the front end first because that is what most reviews
   are about, then the server, then the database. Each entry gets a short note
   so a reader arriving cold knows what they are looking at, and a side saying
   which of the split files it belongs to — "cert" for the certificate side,
   "rest" for everything else, "both" where it is genuinely shared. */
const M_CREATE = "netlify/database/migrations/20260809061335_create_documents/migration.sql";
const M_STATE = "netlify/database/migrations/20260809062843_create_portal_state/migration.sql";
const M_CERTS = "netlify/database/migrations/20260809104035_add_certificate_columns/migration.sql";
const M_REMOVE = "netlify/database/migrations/20260809131510_add_document_removal/migration.sql";

const FILES = [
  ["index.html", "The entire front end — one file, React via Babel in the browser, no build step.", "split"],
  ["netlify/functions/files.mts", "The file store: uploads, listing, soft delete, restore, purge.", "both"],
  ["netlify/functions/file.mts", "Serves one stored file back out by id.", "both"],
  ["netlify/functions/analyse.mts", "Reads certificates and reports the dates it finds against the crew matrix.", "cert"],
  ["netlify/functions/state.mts", "Loads and saves the portal state shared by every device.", "rest"],
  ["db/schema.ts", "Database tables.", "both"],
  ["db/documents.ts", "Queries behind the file store.", "both"],
  ["db/index.ts", "Database connection.", "both"],
  ["drizzle.config.ts", "Migration tooling configuration.", "rest"],
  ["package.json", "Dependencies.", "both"],
  [M_CREATE, "Migration 1 of 4.", "both"],
  [M_STATE, "Migration 2 of 4.", "rest"],
  [M_CERTS, "Migration 3 of 4 — the certificate columns.", "cert"],
  [M_REMOVE, "Migration 4 of 4.", "both"],
  ["review/index.html", "The page these bundles are downloaded from.", "full"],
  ["scripts/build-review-bundle.mjs", "The script that packages them.", "full"],
];

/* The certificate side of the front end, by declaration name. Two groups, and
   they are worth telling apart when reading a review: the first is the expiry
   matrix — the grid of dates, the colour bands, the spreadsheet that populates
   it and the reports read off it. The second is certificates as documents —
   dragging in a folder per person, matching filenames to the roster, and
   reading dates out of the certificates to compare against the matrix. */
const CERT_MATRIX = [
  "daysTo", "bandFor", "Cell", "loadXLSX", "isoOf", "parseWorkbook",
  "UpdateSpreadsheet", "itemsFor", "BandTag", "ItemLine",
  "CrewReport", "IndividualReport", "TrainingMatrix", "QUALS", "BANDS",
  "uploadCertificateSheet", "positionsOf", "CertificatesRequired",
];
const CERT_DOCS = [
  "certFolder", "fileChecksum", "guessPerson", "OTHER", "JUNK", "nameWords", "folderPerson",
  "matchRoster", "groupFor", "dropEntries", "walkEntry", "pickedEntries", "UploadCertificates",
  "CertChecker", "XLSX_MIME", "valueReads", "buildMatrixWorkbook", "elapsedLabel", "CertAnalysis",
  "ANALYSE_API", "analyse", "uploadCertificate", "GenerateLatestMatrix",
  // Writing the update into the workbook already on file rather than building a
  // new one — the zip a .xlsx is, and the sheet XML inside it.
  "zipCapable", "pipeBytes", "inflateRaw", "deflateRaw", "crc32", "readZip", "writeZip",
  "partOf", "partText", "setPartText", "xmlEsc", "xmlUnesc", "colOf", "letterOf", "chunk",
  "ROW_RE", "CELL_RE", "readCell", "readSheet", "rowXml", "writeSheet", "sharedStrings",
  "textOfRuns", "cellText", "isoFromSerial", "serialFrom", "textDate", "cellXml", "putCell",
  "extendRanges", "sheetPath", "dropCalcChain", "recalcOnOpen", "updateFiledWorkbook",
  "latestMatrixFile", "workbookNotes", "fileLatestMatrix", "CRC_TABLE",
];
const CERT_DECLS = new Set([...CERT_MATRIX, ...CERT_DOCS]);

/* Any base64 data URI over a few hundred characters is an image or the web app
   manifest, never code. Keep the first slice so it is still obvious what the
   value is, and say how much was cut so nobody mistakes the placeholder for
   the real thing being short. */
const stripDataUris = (text) =>
  text.replace(/data:([a-z.+/-]+);base64,([A-Za-z0-9+/=]{400,})/g, (_m, mime, b64) =>
    `data:${mime};base64,${b64.slice(0, 24)}[... ${b64.length.toLocaleString("en-AU")} characters of embedded ${mime} removed for review ...]`);

const kb = (n) => `${Math.round(n / 1024).toLocaleString("en-AU")} KB`;
const num = (n) => n.toLocaleString("en-AU");
const rule = "=".repeat(74);

const read = (rel) => stripDataUris(readFileSync(join(ROOT, rel), "utf8"));

const banner = (rel, note, lines) => [
  "",
  "/* ==================================================================== */",
  `/*  FILE: ${rel}`,
  `/*  ${note}`,
  `/*  ${num(lines)} lines`,
  "/* ==================================================================== */",
  "",
].join("\n");

const fileSection = (rel, note, body) =>
  `${banner(rel, note, body.split("\n").length)}\n${body.replace(/\s*$/, "")}\n`;

/* ==================================================================== */
/*  Cutting index.html into top-level declarations                       */
/* ==================================================================== */

/* The front end is one long script, so splitting it means finding where each
   declaration begins. Everything top-level in this file starts hard against
   column 0, which makes the boundaries unambiguous without needing a parser.
   A comment block sitting at column 0 is treated as belonging to whatever
   comes after it, not what came before — those comments are the section
   headings and the explanations of the function below, and separating one from
   its function would strand it in the wrong file. */
function chunkScript(source) {
  const lines = source.split("\n");
  const startsDecl = (l) => /^(?:async\s+function|function|class|const|let|var)\s+[A-Za-z_$]/.test(l);
  const chunks = [];
  let current = null;
  let held = [];

  const flushHeld = () => {
    if (!held.length) return;
    current.body.push(...held);
    held = [];
  };

  for (const line of lines) {
    if (startsDecl(line)) {
      const name = line.match(/^(?:async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/)[1];
      current = { name, body: [...held, line] };
      held = [];
      chunks.push(current);
      continue;
    }
    if (!current) chunks.push((current = { name: "", body: [] }));
    if (/^\/[/*]/.test(line) || (held.length && /^\s*(?:\*|\/\/)/.test(line)) || (held.length && !line.trim())) {
      held.push(line);
      continue;
    }
    flushHeld();
    current.body.push(line);
  }
  flushHeld();

  /* If the chunks don't add back up to the file, the split would quietly drop
     code and a reviewer would never know. Better to fail here. */
  const total = chunks.reduce((n, c) => n + c.body.length, 0);
  if (total !== lines.length) {
    throw new Error(`chunking lost lines: ${total} chunked vs ${lines.length} in the script`);
  }
  return chunks;
}

const frontEnd = read("index.html");
const scriptMatch = frontEnd.match(/(<script type="text\/babel"[^>]*>\n)([\s\S]*?)(<\/script>)/);
if (!scriptMatch) throw new Error("couldn't find the portal's script block in index.html");

const [, scriptOpen, scriptBody, scriptClose] = scriptMatch;
const beforeScript = frontEnd.slice(0, scriptMatch.index) + scriptOpen;
const afterScript = scriptClose + frontEnd.slice(scriptMatch.index + scriptMatch[0].length);
const chunks = chunkScript(scriptBody);

/* A name in CERT_DECLS that matches nothing has been renamed or removed, and
   the split would silently stop covering it. */
const found = new Set(chunks.map((c) => c.name));
const missing = [...CERT_DECLS].filter((n) => !found.has(n));
if (missing.length) throw new Error(`these certificate declarations are no longer in index.html: ${missing.join(", ")}`);

const isCert = (c) => CERT_DECLS.has(c.name);
const certChunks = chunks.filter(isCert);
const restChunks = chunks.filter((c) => !isCert(c));

/* What the certificate half leans on but doesn't define: the theme, the small
   UI pieces, the shared helpers. Worked out by looking for each remaining
   declaration's name in the certificate text rather than by listing them by
   hand, so it keeps up on its own. Anything long is left out and only named —
   the whole app shell is "referenced" by virtue of rendering these screens,
   and pasting it in would defeat the point of a smaller file. */
const certText = certChunks.map((c) => c.body.join("\n")).join("\n");
const SHARED_MAX_LINES = 60;
const referenced = restChunks.filter((c) =>
  c.name && new RegExp(`\\b${c.name.replace(/\$/g, "\\$")}\\b`).test(certText));
const sharedChunks = referenced.filter((c) => c.body.length <= SHARED_MAX_LINES);
const sharedTooLong = referenced.filter((c) => c.body.length > SHARED_MAX_LINES);

/* ==================================================================== */
/*  The three files                                                      */
/* ==================================================================== */

const preamble = (title, blurb) => `${title}
${rule}

${blurb}
`;

const commonNotes = `
Two things about the contents
  The admin account list is near the top of index.html. Picking a name off the
  management team is all it takes, and the shared ADMIN account's password is in
  that same list, so anyone who can open the page can read it. None of it is
  security; the names are there to record who did what. Treat these files as
  internal.

  The logo and the app icons are embedded in index.html as base64 and account
  for roughly ${kb(195155)} of it, so each one is replaced in place by a short note
  saying what was removed. Uploaded files — certificates, spreadsheets,
  documents — are held by Netlify rather than in the source, so a review sees
  the code that handles them but not the files themselves.
`;

const portalBlurb = `  A crew portal for TSV Coolibah: crew rosters and swings, ranks, certificates
  and their expiry dates, a document library, handover notes and correspondence.
  The front end is a single index.html — React compiled in the browser by Babel,
  so there is no build step and no bundler. It talks to four Netlify Functions,
  which read and write a Netlify (Postgres) database through Drizzle.`;

const stateNote = `  - State is shared, not per-device: the portal loads and saves one shared blob
    of state through netlify/functions/state.mts, so a change made on one phone
    shows up on every other one.`;

/* ---- 1. Everything ---- */

const fullParts = FILES.map(([rel, note]) => fileSection(rel, note, read(rel)));
const originalBytes = FILES.reduce((n, [rel]) => n + statSync(join(ROOT, rel)).size, 0);
const strippedBytes = FILES.reduce(
  (n, [rel]) => n + (readFileSync(join(ROOT, rel), "utf8").length - read(rel).length), 0);

const fullOut = `${preamble("TSV COOLIBAH CREW PORTAL — FULL SOURCE, PACKAGED FOR REVIEW",
`Every source file in the portal, one after another, so the whole thing can be
read in one go. File boundaries are the banner comments below.

What this is
${portalBlurb}

Reviewing it in two halves instead
  Two smaller files are also on the download page, if the certificate side is
  best looked at on its own: coolibah-portal-no-certificates.txt and
  coolibah-certificates.txt. Together they cover the same ground as this file.

What has been left out
  Generated bookkeeping only: package-lock.json and Drizzle's migration
  snapshots. The migration SQL itself is included. Nothing is shortened or
  reordered.
${commonNotes}
Worth knowing before reviewing
${stateNote}
  - Some changes need a redeploy and some do not. Anything structural — a tab,
    a screen layout, a form field, the rank list, the 28-day swing pattern —
    is in the source and needs a redeploy. People, rosters, documents and
    permissions are edited in the portal itself.

${rule}
${FILES.length} files · ${kb(originalBytes)} of source · ${kb(strippedBytes)} of embedded images removed
${rule}`)}${fullParts.join("\n")}`;

/* ---- 2. Everything except the certificates ---- */

/* Each certificate declaration leaves a marker where it stood, so the shape of
   the file still reads correctly and nobody reviewing it concludes that, say,
   the expiry bands were never implemented. */
const marker = (c) =>
  `/* [ ${c.name} — ${num(c.body.length)} lines — on the certificate side, in ${CERTS_ONLY} ] */`;

const noCertScript = chunks.map((c) => (isCert(c) ? marker(c) : c.body.join("\n"))).join("\n");
const noCertFrontEnd = `${beforeScript}${noCertScript}${afterScript}`;
/* index.html is handled on its own above, because it is the one file that gets
   split rather than kept or dropped whole. */
const noCertFiles = FILES.filter(([rel, , side]) => rel !== "index.html" && (side === "both" || side === "rest"));
const noCertParts = noCertFiles
  .map(([rel, note]) => fileSection(rel, note, read(rel)));
const certLines = certChunks.reduce((n, c) => n + c.body.length, 0);

const noCertOut = `${preamble("TSV COOLIBAH CREW PORTAL — EVERYTHING EXCEPT THE CERTIFICATES",
`The portal with the certificate side lifted out, so it can be reviewed on its
own. The certificate side is in a separate file, ${CERTS_ONLY},
and the two together cover the whole portal.

What this is
${portalBlurb}

What is in here
  Sign-in and accounts, the crew roster and the 28-day swing pattern, handover
  notes filed by rank, partnership correspondence, the document libraries, crew
  suggestions, the change history, the uploaded file store, the admin and IT
  support screens, and the shell that holds it all together. On the server: the
  file store, serving a stored file back out, and the shared portal state.

What has been lifted out
  ${num(certChunks.length)} declarations, ${num(certLines)} lines, in two groups — the expiry matrix (the grid
  of dates, the colour bands, the spreadsheet that populates it, the reports
  read off it) and certificates as documents (uploading a folder per person,
  matching filenames to the roster, reading dates out of certificates and
  comparing them against the matrix). Also netlify/functions/analyse.mts and
  the migration that added the certificate columns.

  Every one of them leaves a marker in place, like this:

    ${marker({ name: "TrainingMatrix", body: { length: 165 } })}

  so it is clear something was removed rather than never written. Expect
  references to code that isn't here — the shell renders these screens, and the
  markers show where.
${commonNotes}
Worth knowing before reviewing
${stateNote}
  - Uploads go through one shared file store used by every part of the portal,
    certificates included, so that code is here even though certificates aren't.

${rule}
${noCertFiles.length + 1} files · ${num(noCertFrontEnd.split("\n").length)} lines of front end · ${num(certLines)} lines held back
${rule}`)}${fileSection("index.html", `The front end, with the ${num(certChunks.length)} certificate declarations lifted out and marked.`, noCertFrontEnd)}
${noCertParts.join("\n")}`;

/* ---- 3. The certificates on their own ---- */

const certFiles = FILES.filter(([, , side]) => side === "cert");
const certParts = certFiles.map(([rel, note]) => fileSection(rel, note, read(rel)));

/* Certificates are stored through the portal's ordinary file store and land in
   the ordinary documents table, so a review of the certificate side that can't
   see either is missing where the files and their dates actually go. Both are
   in the other file too; they are context here, not certificate code. */
const CERT_CONTEXT_FILES = [
  ["netlify/functions/files.mts", "Shared with the rest of the portal. The upload path every certificate takes, including the duplicate check."],
  ["db/schema.ts", "Shared with the rest of the portal. The tables certificates and their dates are stored in."],
];
const certContextParts = CERT_CONTEXT_FILES.map(([rel, note]) => fileSection(rel, note, read(rel)));

const group = (names) => chunks.filter((c) => names.includes(c.name)).map((c) => c.body.join("\n")).join("\n");

const certOut = `${preamble("TSV COOLIBAH CREW PORTAL — THE CERTIFICATE SIDE",
`Only the parts of the portal that deal with certificates and their expiry
dates, pulled out of a much larger app so they can be reviewed closely. The
rest of the portal is in ${NO_CERTS}.

What this is part of
${portalBlurb}

How certificates work here, in short
  A spreadsheet of crew qualification expiry dates is uploaded and becomes the
  matrix: one row per person, one column per qualification, each cell either an
  expiry date, held/not held, unknown, or blank for not required. Cells are
  coloured by how far off the expiry is. Separately, the actual certificate
  documents are uploaded — often dragged in as a folder per person — matched to
  people on the roster by filename, and read to find the dates inside them.
  Those dates are then compared against the matrix and the differences shown
  for an admin to accept or dismiss, which can write corrected dates back into
  the matrix and generate an updated spreadsheet.

  This is the part where being wrong matters most: a certificate expiry that
  reads a month late is the kind of error that puts someone to sea unqualified.

What is in here
  The front-end declarations, in the order they appear in index.html, in two
  groups — the expiry matrix first, then certificates as documents. Then the
  server function that reads certificates, and the migration that added the
  certificate columns. Shared code the certificate side leans on but does not
  define is included as context — the theme and small UI pieces first, then the
  file store every upload goes through and the tables it writes to.

  ${num(certChunks.length)} declarations, ${num(certLines)} lines, lifted from a ${num(chunks.reduce((n, c) => n + c.body.length, 0))}-line front end.

What is not here
  The app shell that renders these screens, sign-in, the roster, handover notes,
  correspondence, documents, suggestions, history and admin.${sharedTooLong.length ? ` Referenced
  from here but too long to include: ${sharedTooLong.map((c) => c.name).join(", ")}.` : ""}
${commonNotes}
Worth knowing before reviewing
${stateNote}
  - Dates in the matrix are plain YYYY-MM-DD strings, and "today" is a constant
    near the top of index.html rather than the real clock.

${rule}
${num(certChunks.length)} front-end declarations · ${certFiles.length} certificate files · ${sharedChunks.length + CERT_CONTEXT_FILES.length} shared pieces for context
${rule}`)}${banner("Shared context — defined elsewhere in the portal, included so this file makes sense",
  "Not part of the certificate code. Theme, small UI pieces and helpers it calls.",
  sharedChunks.reduce((n, c) => n + c.body.length, 0))}
${sharedChunks.map((c) => c.body.join("\n")).join("\n")}
${banner("index.html — the expiry matrix", "The grid of dates and colour bands, the spreadsheet behind it, and the reports read off it.", CERT_MATRIX.length && group(CERT_MATRIX).split("\n").length)}
${group(CERT_MATRIX)}
${banner("index.html — certificates as documents", "Uploading, matching to the roster, reading dates out, and comparing against the matrix.", group(CERT_DOCS).split("\n").length)}
${group(CERT_DOCS)}
${certParts.join("\n")}
${certContextParts.join("\n")}`;

/* ==================================================================== */
/*  Write them out                                                       */
/* ==================================================================== */

mkdirSync(REVIEW, { recursive: true });

const written = [[FULL, fullOut], [NO_CERTS, noCertOut], [CERTS_ONLY, certOut]].map(([name, text]) => {
  writeFileSync(join(REVIEW, name), text, "utf8");
  return { name, bytes: Buffer.byteLength(text), lines: text.split("\n").length };
});

/* The bundles are snapshots, so they can fall behind the portal if someone
   changes a file and forgets to run this. Recording the size of index.html lets
   the download page compare it against the live one and say so, rather than
   handing over a stale copy that looks current. */
writeFileSync(
  join(REVIEW, "bundle-info.json"),
  `${JSON.stringify({
    packagedOn: new Date().toISOString().slice(0, 10),
    indexBytes: statSync(join(ROOT, "index.html")).size,
    strippedBytes,
    fileCount: FILES.length,
    certDeclarations: certChunks.length,
    certLines,
    bundles: Object.fromEntries(written.map((w) => [w.name, { bytes: w.bytes, lines: w.lines }])),
    /* Kept for the older shape of this file, which the download page read. */
    bundleBytes: written[0].bytes,
    bundleLines: written[0].lines,
  }, null, 2)}\n`,
  "utf8",
);

for (const w of written) console.log(`${w.name} — ${kb(w.bytes)}, ${num(w.lines)} lines`);
console.log(`Certificate side: ${certChunks.length} declarations, ${num(certLines)} lines, ${sharedChunks.length} shared pieces included as context.`);
console.log(`Removed ${kb(strippedBytes)} of embedded images.`);
