/* Upload Crew Certificates — the folder and name helpers, the upload page,
 * who SharePoint says is on the strength, the tab's turn at the round behind
 * Update portal, and the crew's own upload from the phone's camera.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state (and the
 * upload transports, which it calls itself); this holds what is only this
 * page's. See tools/source.mjs.
 */

/* ==================================================================== */
/*  Upload Crew Certificates — one folder per person under certification */
/* ==================================================================== */

// The same slug the server files a certificate under, so the folder a file is
// about to land in can be shown before it is sent.
const certFolder = (person) =>
  (person || "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80) || "unnamed";

/**
 * Which folder a man's certificates go in, as Crew Details says - the
 * browser's half of the answer the server gives when a file is sent.
 *
 * Two places it can come from, in this order: the folder written against him
 * on Crew Details, and the folder his certificates are already in, read off
 * the certificates themselves. The commonest one wins there, because a man
 * whose papers are spread over two folders has one real folder and one
 * accident, and the accident is not where the next one should go.
 *
 * Nothing is ever worked out from his name. A name makes a folder that the
 * library does not have, and the portal does not make folders - the folders
 * are the office's. Where neither answers, this says nothing is known, and
 * the page asks for it to be set on Crew Details rather than inventing one.
 */
function useCertHome() {
  const { people, certificates } = usePortal();
  return useMemo(() => {
    const lastPart = (path) => {
      const cut = String(path || "").lastIndexOf("/");
      return cut > 0 ? path.slice(cut + 1) : String(path || "");
    };

    const said = new Map();
    (people || []).forEach((p) => {
      const k = nameLetters(p.name);
      if (k && p.certFolder) said.set(k, { where: lastPart(p.certFolder), full: p.certFolder, set: true });
    });

    const tally = new Map();
    (certificates || []).forEach((c) => {
      const cut = String(c.path || "").lastIndexOf("/");
      if (cut < 1) return;
      const k = nameLetters(c.person);
      if (!k) return;
      if (!tally.has(k)) tally.set(k, new Map());
      const seen = tally.get(k);
      const at = c.path.slice(0, cut);
      seen.set(at, (seen.get(at) || 0) + 1);
    });

    return (person) => {
      const k = nameLetters(person);
      if (!k) return null;
      if (said.has(k)) return said.get(k);
      const seen = tally.get(k);
      if (!seen || !seen.size) return null;
      const best = [...seen.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { where: lastPart(best), full: best, set: false };
    };
  }, [people, certificates]);
}

// SHA-256 of the bytes, so a certificate already filed under a different name is
// spotted on the page before anything is uploaded. Where the browser won't do it,
// the check the server does on the way in still catches it.
async function fileChecksum(file) {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return null;
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    return null;
  }
}

// Who a file belongs to, guessed from its name, so a folder of fifty scans mostly
// sorts itself. A surname on its own is only taken when one person has it —
// "SMITH, Alan" and "SMITH, Dan" are left for the uploader to choose between.
function guessPerson(filename, names) {
  const hay = " " + filename.toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  const has = (w) => w.length > 2 && hay.includes(" " + w + " ");

  const scored = names.map((n) => {
    const [last, rest] = n.split(",");
    const given = (rest || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    return { name: n, surname: has((last || "").trim().toLowerCase()), given: given.filter(has).length };
  });

  const strong = scored.filter((s) => s.surname && s.given > 0);
  if (strong.length === 1) return strong[0].name;
  const bySurname = scored.filter((s) => s.surname);
  if (bySurname.length === 1) return bySurname[0].name;
  return "";
}

const OTHER = "— someone not on the matrix —";

// Files a folder carries around that are not certificates. Dropping a folder of
// scans off a Windows machine brings these along, and filing them would leave a
// Thumbs.db in someone's certificate folder.
const JUNK = /^(\.|~\$)|^(thumbs\.db|desktop\.ini|\.ds_store|picasa\.ini)$/i;

// The words in a name, punctuation and case set aside, so "ASANGE,Kyle" and
// "SMITH, Alan James" both come back as plain words to compare.
const nameWords = (s) =>
  (s || "").normalize("NFKD").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// Crew folders are named for the person with the system they came out of on the
// end — "Alan - OPMS", "Bob - OPMS". Everything from the first spaced dash
// on is dropped so the folder reads as a name; a hyphenated name keeps its
// hyphen, because that one has no spaces around it.
const folderPerson = (label) =>
  (label || "").split(/\s+[-–—]\s+/)[0].replace(/[_]+/g, " ").trim();

/**
 * Which crew member a folder belongs to.
 *
 * Whoever made the folders typed the name however they think of the person — a
 * given name ("Alan"), a surname ("Smith"), a short form ("Chris", "Bob") —
 * so the roster is tried in order of how certain the match is. Anything that
 * could be two people is left blank rather than guessed: "Matthew" is three
 * people on this roster, and filing a certificate against the wrong one is worse
 * than asking.
 */
function matchRoster(label, names) {
  const want = nameWords(folderPerson(label));
  if (!want.length) return "";

  const rows = names.map((n) => {
    const [last, rest] = n.split(",");
    return { name: n, surname: nameWords(last)[0] || "", given: nameWords(rest) };
  });
  const one = (list) => (list.length === 1 ? list[0].name : "");

  // Surname and given name both there — "Smith Alan" either way round.
  const both = rows.filter((r) => want.includes(r.surname) && r.given.some((g) => want.includes(g)));
  if (both.length) return one(both);

  // A given name on its own, then a surname on its own.
  const byGiven = rows.filter((r) => r.given.some((g) => want.includes(g)));
  if (byGiven.length === 1) return byGiven[0].name;
  const bySurname = rows.filter((r) => want.includes(r.surname));
  if (bySurname.length === 1) return bySurname[0].name;
  // Matched more than one person by name — stop rather than fall to a weaker test.
  if (byGiven.length || bySurname.length) return "";

  // Short forms: "Chris" for Christopher, "Bob" for Robert. Only from three
  // letters up, and only when it fits one person.
  return one(
    rows.filter((r) =>
      want.some((w) => w.length >= 3 && (r.given.some((g) => g.startsWith(w)) || r.surname.startsWith(w))),
    ),
  );
}

/**
 * The folder a file should be filed under, and who that is.
 *
 * Folders can be dropped either way round — the crew folders themselves, or the
 * one folder holding all of them — so every folder in the path is tried from the
 * top down and the first that answers to somebody on the roster wins. When none
 * of them does, the folder the file actually sits in is used as the heading, so
 * the batch still arrives sorted and one choice covers the whole folder.
 */
function groupFor(path, names) {
  const parts = path.split("/").filter(Boolean);
  const dirs = parts.slice(0, -1);
  if (!dirs.length) return { group: "", person: "" };

  for (const dir of dirs) {
    const person = matchRoster(dir, names);
    if (person) return { group: dir, person };
  }
  return { group: dirs[dirs.length - 1], person: "" };
}

/**
 * Every file inside a dropped folder, each with the path it came in under.
 *
 * A folder dropped on the page is not in `dataTransfer.files` — that only ever
 * holds loose files, which is why dropping a folder looked like it did nothing.
 * The folder is reachable through `webkitGetAsEntry`, and is walked here.
 *
 * The entries have to be taken out of the event before anything is awaited: the
 * drop data is emptied as soon as the handler returns, so the list is captured
 * first and read afterwards.
 */
function dropEntries(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
  const loose = [...(dataTransfer.files || [])];

  // No directory support in this browser: fall back to whatever came through as
  // plain files, so dropping files still works even if dropping folders can't.
  if (!entries.length) {
    return Promise.resolve(loose.map((file) => ({ file, path: file.webkitRelativePath || file.name })));
  }
  return (async () => {
    const out = [];
    for (const entry of entries) await walkEntry(entry, "", out, 0);
    return out;
  })();
}

function walkEntry(entry, prefix, out, depth) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => { out.push({ file, path: prefix + file.name }); resolve(); },
        () => resolve(),   // unreadable file — skip it rather than lose the batch
      );
      return;
    }
    if (!entry.isDirectory || depth > 8) return resolve();

    const dir = prefix + entry.name + "/";
    const reader = entry.createReader();
    const found = [];

    // readEntries hands back a hundred at a time at most, so it is called until
    // it comes back empty. Reading it once would quietly lose everything past
    // the hundredth file in a folder.
    const readMore = () => {
      reader.readEntries(
        async (batch) => {
          if (!batch.length) {
            for (const e of found) await walkEntry(e, dir, out, depth + 1);
            return resolve();
          }
          found.push(...batch);
          readMore();
        },
        () => resolve(),
      );
    };
    readMore();
  });
}

// Files picked with the folder button carry their path in `webkitRelativePath`.
const pickedEntries = (list) =>
  [...list].map((file) => ({ file, path: file.webkitRelativePath || file.name }));

function UploadCertificates() {
  const {
    quals: QUALS, setQuals, certificates, addCertificates, removeCertificate, removeCertificates,
    updateCertificate, setMatrixUpdated, matrixUpdated, log, role, certDates, refreshCertDates, validityPeriods,
    matrixRun: auto, runMatrixRound, clearMatrixRun,
    people, renameCrew, setCrewRank,
  } = usePortal();
  // The same three columns the certification screens carry, against each filed
  // scan: the issue date read off the certificate, the expiry, and how long the
  // item stays valid off the skills matrix.
  const validityFor = useValidityLookup();
  // Which folder each man's certificates go in, as Crew Details says. Nothing
  // is worked out from a name here: a file with no folder to go to is not sent.
  const certHomeOf = useCertHome();
  // A scan filed before codes were recorded still names its code in the file
  // name — "DWYER_ Matthew - QL-18 Provide First Aid" — so where the record
  // carries none, the name is read for a column of the matrix the one way
  // the round reads it (filedCodeIn, source/shared/filed-as.js). Here it is
  // only which column the file sits under on this page, so a name the
  // portal wrote is read too; whose word that code is, is the round's
  // question (codeFor in the worker), not this list's.
  const codeOf = (c) => {
    if (c.qualCode) return c.qualCode;
    return filedCodeIn(c.filename, QUALS.cols) || "";
  };
  const readOf = (c) => {
    if (c.readIssued || c.readExpires) return { issued: c.readIssued || null, expires: c.readExpires || null };
    const code = codeOf(c);
    return code ? certDateFor(certDates, c.person, code) : null;
  };
  // The raw validity period behind the text column — needed to work an expiry
  // out, not just to print. Same order of preference as useValidityLookup.
  const periodOf = useMemo(() => {
    const list = (validityPeriods && validityPeriods.periods) || [];
    const byCode = new Map();
    const byTitle = new Map();
    list.forEach((p) => {
      if (p.code) byCode.set(String(p.code).trim().toUpperCase(), p);
      if (p.item) byTitle.set(normTitle(p.item), p);
    });
    return (code, title) =>
      noExpiryPeriod(code)
        || byCode.get(String(code || "").trim().toUpperCase())
        || byTitle.get(normTitle(title))
        || null;
  }, [validityPeriods]);
  // "2 years", "24 months" — the shapes a validity period is written in. Kept
  // in step by hand with monthsFrom/addMonths in worker/src/routes/analyse.ts,
  // which work the same date out on the server; this page has no bundler.
  const monthsIn = (text) => {
    const m = /(\d+(?:\.\d+)?)\s*(years?|yrs?|months?|mths?|mos?)\b/i.exec(text || "");
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return /^y/i.test(m[2]) ? Math.round(n * 12) : Math.round(n);
  };
  const plusMonths = (iso, months) => {
    const [y, mo, d] = iso.split("-").map(Number);
    const total = mo - 1 + months;
    const ny = y + Math.floor(total / 12);
    const nm = (total % 12) + 1;
    const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
  };
  // The expiry a certificate answers to: the one typed on the row, the one read
  // off the scan — and where neither is held but the issue date and a validity
  // period are, the date they run to together. A validity period means there is
  // an expiry, even when none is printed on the certificate.
  const expiryOf = (c) => {
    const code = codeOf(c);
    const p = periodOf(code, c.title || c.filename);
    // Never-lapsing items carry no expiry, even where one was typed or read.
    if (p && p.neverExpires) return "";
    const d = readOf(c);
    const stored = c.expires || (d && d.expires) || "";
    if (stored) return stored;
    // An item that states its own expiry (the AMSA medical) shows only what is
    // printed or typed — nothing is ever worked out for it.
    if (CERT_STATED[String(code || "").trim().toUpperCase()]) return "";
    const issued = d && d.issued;
    if (!issued) return "";
    if (!p) return "";
    const months = typeof p.months === "number" && p.months > 0 ? Math.round(p.months) : monthsIn(p.validFor);
    return months ? plusMonths(issued, months) : "";
  };
  const neverExpiresRow = (c) => {
    const p = periodOf(codeOf(c), c.title || c.filename);
    return !!(p && p.neverExpires);
  };
  // The person's crew matrix row, matched the forgiving way — "ASANGE,Kyle"
  // and "ASANGE, Kyle" are the same person however the comma landed.
  const matrixRowFor = (person) => {
    const norm = (n) => String(n || "").toUpperCase().replace(/[^A-Z]/g, "");
    const P = norm(person);
    return QUALS.rows.find((r) => norm(r[0]) === P) || null;
  };
  // What the matrix says their position requires that they don't hold — the
  // cells the office marks N (or Open): required for the rank, not held yet.
  const notHeldFor = (person) => {
    const row = matrixRowFor(person);
    if (!row) return { position: null, items: [] };
    const cells = row[3] || [];
    const items = QUALS.cols.filter((_, i) => {
      const v = String(cells[i] || "").trim().toUpperCase();
      return v === "N" || v === "OPEN";
    });
    return { position: row[1], items };
  };

  /* Who there is to file a certificate against: the crew register, off Crew
   * Details, and nothing else if it can be helped.
   *
   * This list used to be the crew matrix's rows. The matrix is the office's
   * spreadsheet and it is not the register - somebody taken on last week has
   * an entry on Crew Details and no row on the matrix yet, and he was simply
   * not on this page to pick. So the register comes first. A matrix row the
   * register has never heard of is added after it rather than dropped,
   * because a name the portal cannot place still has certificates and they
   * have to be filable; Crew Details is where it gets placed.
   */
  const names = useMemo(() => {
    const out = [];
    const seen = new Set();
    const add = (n) => {
      const name = String(n || "").trim();
      const k = nameLetters(name);
      if (!name || !k || seen.has(k)) return;
      seen.add(k);
      out.push(name);
    };
    (people || []).forEach((p) => add(p.name));
    QUALS.rows.forEach((r) => add(r[0]));
    return out.sort((a, b) => a.localeCompare(b));
  }, [people, QUALS]);

  /* What each of them is employed as. The rank set against him on Crew
   * Details is his own word on it and wins; the matrix's is the office's and
   * is what is used where nobody has said otherwise. Read through the
   * register, so a matrix row spelled another way still finds its man. */
  const positions = useMemo(() => {
    const known = asKnownPerson(people);
    const out = {};
    QUALS.rows.forEach((r) => {
      const who = known(r[0]);
      if (!(who in out) && r[1]) out[who] = r[1];
    });
    (people || []).forEach((p) => { if (p.rank) out[p.name] = p.rank; });
    return out;
  }, [people, QUALS]);

  const [person, setPerson] = useState("");   // who files are filed against by default
  const [queue, setQueue] = useState([]);     // staged, before anything is sent
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(null);         // which file is going up now
  const [dup, setDup] = useState(null);       // the duplicate popup
  const [dupAll, setDupAll] = useState(false);
  const [done, setDone] = useState(null);     // what happened, once a run finishes
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [hot, setHot] = useState(false);      // something is being dragged over the drop area
  const [reading, setReading] = useState(false);
  // A filed certificate whose details are being corrected: which one, and what
  // has been typed so far.
  const [edit, setEdit] = useState(null);     // null | { id, qualCode, expires, busy, err }
  // Which crew folders are open. The list starts as names only — a folder opens
  // when its name is pressed, so forty crew read as forty lines, not a wall of
  // every certificate on the vessel. A search opens whatever it matches.
  const [openFolders, setOpenFolders] = useState(() => new Set());
  const fileRef = useRef(null);
  const folderRef = useRef(null);
  const answer = useRef(null);                // resolves the popup
  const forRest = useRef(null);               // choice applied to the rest of the batch
  // A file whose owner the portal cannot work out, waiting to be told whose it is.
  const [whose, setWhose] = useState(null);   // null | { name }
  const whoseAnswer = useRef(null);
  const [whosePick, setWhosePick] = useState("");

  // The round that follows a batch is the shared one (runMatrixRound) — set
  // going here, watched from the window over the page (UpdateMatrixRun), and
  // reported in the panel below once it lands. `auto` is that run's state:
  // { phase: "reading" | "filing" | "starting" | "waiting" | "done" | "failed", ... }

  // What is already filed, by folder, so a clash can be shown as files are picked
  // rather than only once they have been sent.
  const filedIn = (folder) => certificates.filter((c) => (c.folder || certFolder(c.person)) === folder);

  const clashFor = (item) => {
    if (!item.person) return null;
    const already = filedIn(certFolder(item.person));
    const bytes = item.checksum && already.find((c) => c.checksum === item.checksum);
    if (bytes) return { kind: "content", with: bytes };
    const name = already.find((c) => c.filename.toLowerCase() === item.file.name.toLowerCase());
    if (name) return { kind: "name", with: name };
    // An older certificate for the same column - the one picked here, or
    // the code in the file's name - which the server asks about the same way.
    const codeOf = (tag, read, filename) => String(tag || read || filedCodeIn(filename, QUALS.cols) || "").trim().toUpperCase();
    const code = item.evidenceKind ? "" : codeOf(item.qualCode, null, item.file.name);
    const older = code && already.find((c) => !c.evidenceKind && codeOf(c.qualCode, c.readCode, c.filename) === code);
    return older ? { kind: "column", with: older, code, title: (QUALS.cols.find((c) => c[0] === code) || [])[1] || code } : null;
  };

  /**
   * Put files on the list, ready to be filed.
   *
   * Takes what came off a drop or a picker — each file with the path it arrived
   * under — works out whose folder each one is in, and says what it did. A drop
   * that adds nothing used to leave the page unchanged with no explanation,
   * which read as the drop area being broken.
   */
  const stage = async (entries) => {
    setErr(""); setDone(null);

    const junk = [], oversize = [];
    const keep = [];

    for (const e of entries) {
      if (!e || !e.file) continue;
      if (JUNK.test(e.file.name) || e.file.size === 0) { junk.push(e.file.name); continue; }
      if (e.file.size > MAX_UPLOAD_BYTES) { oversize.push(e.file.name); continue; }
      keep.push(e);
    }

    const staged = keep.map((e, i) => {
      const found = groupFor(e.path, names);
      return {
        key: "c" + Date.now() + "-" + i + "-" + Math.random().toString(36).slice(2, 7),
        file: e.file,
        path: e.path,
        group: found.group,
        // A crew member chosen up top wins; then the folder the file came in;
        // then the file's own name, for a loose file dropped on its own.
        person: person || found.person || guessPerson(e.file.name, names),
        custom: false,
        qualCode: "",
        // What paper it is, where it is one of the five that stand in for a
        // certificate rather than the certificate itself; "" is a certificate.
        evidenceKind: "",
        expires: "",
        checksum: null,
        state: null,
        msg: "",
      };
    });

    if (staged.length) setQueue((qq) => [...qq, ...staged]);

    const said = [];
    if (!staged.length) {
      said.push(
        entries.length
          ? "Nothing on that list could be filed."
          : "Nothing came through — if that was a folder, try the Choose folders button.",
      );
    }
    if (oversize.length) {
      said.push(
        `${oversize.length} too big for the ${humanSize(MAX_UPLOAD_BYTES)} limit (${oversize.slice(0, 3).join(", ")}${oversize.length > 3 ? "…" : ""}).`,
      );
    }
    if (junk.length) said.push(`${junk.length} skipped as not a certificate.`);
    setErr(said.join(" "));

    // Hashing is done off to the side so the rows are on the page immediately and
    // pick up their "already filed" mark as each hash lands. A few at a time — a
    // batch of two hundred scans read all at once would be held in memory at once.
    let next = 0;
    const hashOne = async () => {
      while (next < staged.length) {
        const s = staged[next++];
        const sum = await fileChecksum(s.file);
        if (sum) setQueue((qq) => qq.map((x) => (x.key === s.key ? { ...x, checksum: sum } : x)));
      }
    };
    await Promise.all([hashOne(), hashOne(), hashOne(), hashOne()]);
  };

  const patch = (key, fields) =>
    setQueue((qq) => qq.map((x) => (x.key === key ? { ...x, ...fields } : x)));

  const ask = (info) =>
    new Promise((resolve) => {
      answer.current = resolve;
      setDup(info);
    });

  /* Whose is this?
   *
   * The portal reads the owner off the filename and off the folder it came
   * out of. Where neither says, it used to put the file aside and report "no
   * crew member" at the end of the run — so a folder drop of two hundred
   * finished with a list of files that had not been filed and nothing said at
   * the time. The run stops and asks instead, one file at a time, and what is
   * answered is used for that file.
   *
   * Only management ever sees this. A crew member uploading his own
   * certificate is signed in as himself, so there is nothing to ask. */
  const askWhose = (item) =>
    new Promise((resolve) => {
      whoseAnswer.current = resolve;
      setWhosePick("");
      setWhose(item);
    });

  const answerWhose = (person) => {
    setWhose(null);
    const resolve = whoseAnswer.current;
    whoseAnswer.current = null;
    if (resolve) resolve(person || "");
  };

  const respond = (choice) => {
    if (dupAll) forRest.current = choice;
    setDup(null);
    const resolve = answer.current;
    answer.current = null;
    if (resolve) resolve(choice);
  };

  /**
   * Save a corrected code or expiry against a filed certificate.
   *
   * The server row is changed first, then the page follows it — and so does the
   * crew's training: where the person is on the matrix and the item is one of
   * its columns, the new expiry is written straight into that cell and the
   * matrix-updated date is stamped, so a certificate corrected by hand reads on
   * the matrix the moment it is saved rather than after the next analysis.
   */
  const saveEdit = async (c) => {
    if (!edit || edit.busy) return;
    const code = edit.qualCode || null;
    const expires = edit.expires || null;
    // What paper it is, if it is one: a paper's date is the day its cover
    // runs out, never the certificate's expiry, so it is written to no cell.
    const kind = edit.evidenceKind || null;
    setEdit((ed) => (ed ? { ...ed, busy: true, err: "" } : ed));
    try {
      const title = code ? (QUALS.cols.find((x) => x[0] === code) || [])[1] || null : null;
      await editStoredCertificate(c.id, { qualCode: code, expiresOn: expires, title, evidenceKind: kind });
      updateCertificate(c.id, { qualCode: code || "", title: title || "", expires: expires || "", evidenceKind: kind || "" });

      if (code && expires && !kind) {
        // An item recorded as carrying no expiry can only be held or not held,
        // so a date typed against one of those certificates records it as held
        // rather than putting an expiry into a cell that can't have one.
        const value = noExpiryPeriod(code) ? "Y" : expires;
        const r = QUALS.rows.findIndex(
          (row) => String(row[0]).trim().toUpperCase() === String(c.person || "").trim().toUpperCase(),
        );
        const col = QUALS.cols.findIndex((x) => x[0] === code);
        if (r >= 0 && col >= 0 && (QUALS.rows[r][3][col] || "") !== value) {
          const rows = QUALS.rows.map((row) => [row[0], row[1], row[2], (row[3] || []).slice()]);
          rows[r][3][col] = value;
          setQuals({ cols: QUALS.cols, rows });
          setMatrixUpdated(todayISO());
          log("Crew Matrix", `Updated ${c.person}'s ${code} from an edited certificate`,
            `${c.filename} · ${value === "Y" ? "held, no expiry" : `expires ${fmtDate(expires)}`}`);
        }
      }
      setEdit(null);
    } catch (e) {
      setEdit((ed) => (ed ? { ...ed, busy: false, err: e.message || String(e) } : ed));
    }
  };

  /**
   * What happens on its own once certificates have been filed.
   *
   * Filing a certificate used to be the end of it: someone then had to run the
   * reading by hand and answer every difference before the matrix caught up
   * with what had just been uploaded. So the shared round runs instead —
   * every new certificate is read, each one is moved into the folder of the
   * person whose name it carries, and the server's round puts what they
   * settle on the crew matrix and into the office's workbook. The run itself
   * lives with the portal state (runMatrixRound), because every Update
   * matrix button and Update portal set the same run going.
   *
   * Only what a certificate settles is written. The OPMS spreadsheet is never
   * written by the portal at all — it is OPMS's own weekly export, read here
   * only to flag where it disagrees.
   */
  const fileAll = async () => {
    /* Anything queued will do to start. A file with nobody against it is
       asked about while the run waits, rather than being a reason not to run:
       the whole point of asking is that the answer arrives in the middle of a
       folder drop, not before it. */
    if (!queue.length || busy) return;

    setBusy(true); setErr(""); setDone(null); clearMatrixRun();
    forRest.current = null; setDupAll(false);

    const filed = [], replacedIds = [], results = [];

    let pos = 0;
    for (const item of queue) {
      pos++;
      if (!item.person || item.person === OTHER) {
        setAt(`${pos} of ${queue.length} · whose is ${item.file.name}?`);
        const said = await askWhose(item);
        if (!said) {
          results.push({ key: item.key, name: item.file.name, person: item.person, state: "unassigned" });
          continue;
        }
        item.person = said;
        patch(item.key, { person: said });
      }
      // A batch off a folder drop runs to hundreds, so the count matters as much
      // as the name — "12 of 214" says how much of the evening this is going to be.
      setAt(`${pos} of ${queue.length} · ${item.file.name}`);

      const fields = {
        person: item.person,
        qualCode: item.qualCode,
        evidenceKind: item.evidenceKind,
        title: item.qualCode ? (QUALS.cols.find((c) => c[0] === item.qualCode) || [])[1] : "",
        expiresOn: item.expires,
        uploadedBy: role,
        filedOn: todayISO(),
        session: SESSION,
      };

      try {
        let res = await uploadCertificate(item.file, fields, forRest.current || "ask");

        if (res.duplicate) {
          const choice = forRest.current || (await ask({ item, info: res }));
          if (choice === "skip") {
            results.push({ key: item.key, name: item.file.name, person: item.person, state: "skipped" });
            continue;
          }
          res = await uploadCertificate(item.file, fields, choice);
        }

        if (res.skipped) {
          results.push({ key: item.key, name: item.file.name, person: item.person, state: "skipped" });
          continue;
        }

        filed.push(res.record);
        (res.replaced || []).forEach((r) => replacedIds.push(r.id));
        results.push({
          key: item.key,
          id: res.record.id,
          name: res.record.filename,
          person: item.person,
          state: (res.replaced || []).length ? "replaced" : "filed",
          folder: res.record.folder,
        });
      } catch (e) {
        results.push({ key: item.key, name: item.file.name, person: item.person, state: "failed", msg: e.message });
      }
    }

    setAt(null);
    if (filed.length || replacedIds.length) addCertificates(filed, replacedIds);

    const n = (state) => results.filter((r) => r.state === state).length;
    setDone({
      results,
      filed: n("filed"),
      replaced: n("replaced"),
      skipped: n("skipped"),
      failed: n("failed") + n("unassigned"),
    });

    // Anything that didn't land stays on the list so it can be sorted out and sent
    // again; everything that did is cleared away.
    const kept = new Set(results.filter((r) => r.state === "failed" || r.state === "unassigned").map((r) => r.key));
    setQueue((qq) => qq.filter((x) => kept.has(x.key)));

    if (filed.length) {
      const people = [...new Set(results.filter((r) => r.state === "filed" || r.state === "replaced").map((r) => r.person))];
      log(
        "Admin",
        `Filed ${filed.length} crew certificate${filed.length === 1 ? "" : "s"}`,
        people.length === 1 ? people[0] : `${people.length} crew`,
      );
      // Nothing new to read means nothing to bring up to date, so this only runs
      // when something was actually filed. The button stays disabled through it —
      // sending another batch into the middle of the reading would have it read
      // twice and compared against a matrix that is halfway through changing.
      await runMatrixRound({ origin: "certificates" });
    }
    setBusy(false);
  };

  // ---- what is already filed ------------------------------------------------
  // Folders sit in surname order however the name was typed: "SURNAME, First"
  // sorts on what sits before the comma, and a name written the other way round
  // sorts on its last word.
  const surnameOf = (person) => {
    const p = (person || "").trim();
    const comma = p.indexOf(",");
    if (comma > 0) return p.slice(0, comma).trim().toUpperCase();
    const words = p.split(/\s+/);
    return (words[words.length - 1] || p).toUpperCase();
  };
  // The double ups as one list: every byte-identical copy after the first,
  // and every certificate the round set aside because a newer one holds its
  // cell - never a document that still holds a cell (doubleUpsOf).
  const doubleUps = useMemo(() => doubleUpsOf(certificates, certDates), [certificates, certDates]);
  // Byte-identical copies filed under the same person: the first-filed copy
  // stays in the person's folder, every further copy goes to the Double ups
  // list at the bottom - exactly the copies that list carries, so a copy
  // that holds a cell (and so is on no double ups list) stays on the
  // person's list rather than on no list at all (27 Sep 2026).
  const dupExtras = useMemo(() => doubleUps.filter((d) => d.why === "identical copy"), [doubleUps]);
  const dupIds = useMemo(() => new Set(dupExtras.map((c) => c.id)), [dupExtras]);
  const [doubleUpsLine, setDoubleUpsLine] = useState(""); // what a Delete all could not remove
  /* The double ups and the Delete warnings read certDates, which the page
     otherwise refreshes only after its own round - while a Delete, a
     Restore, an upload, an Edit or the hour's round moves who holds what.
     So the dates are asked for again on arriving here, and a moment after
     the certificates or the matrix change (27 Sep 2026: a list older than
     the files it names offered the one document left for a cell as
     "replaced"). Delete all asks once more before it removes anything, and
     removes what THAT answer lists. */
  const certsRef = useRef(certificates);
  certsRef.current = certificates;
  const certKey = useMemo(
    () => certificates.map((c) => [c.id, c.qualCode || "", c.expires || "", c.evidenceKind || ""].join("~")).join("|") + "|" + (matrixUpdated || ""),
    [certificates, matrixUpdated]);
  const firstDates = useRef(true);
  React.useEffect(() => {
    if (firstDates.current) { firstDates.current = false; refreshCertDates(); return; }
    const t = setTimeout(refreshCertDates, 1500);
    return () => clearTimeout(t);
  }, [certKey]);
  const deleteAllDoubleUps = async (step) => {
    const fresh = await refreshCertDates();
    if (!fresh) return { done: [], failed: [], line: "The certificates could not be checked, so nothing was removed." };
    return removeCertificates(doubleUpsOf(certsRef.current, fresh), step);
  };

  const folders = useMemo(() => {
    const byFolder = new Map();
    certificates.forEach((c) => {
      if (dupIds.has(c.id)) return;
      const key = c.folder || certFolder(c.person);
      if (!byFolder.has(key)) byFolder.set(key, { folder: key, person: c.person || key, items: [] });
      byFolder.get(key).items.push(c);
    });
    return [...byFolder.values()].sort(
      (a, b) => surnameOf(a.person).localeCompare(surnameOf(b.person)) || a.person.localeCompare(b.person),
    );
  }, [certificates, dupIds]);

  // Only crew members' folders. Documents synced from the type folders (HRWL
  // Verification and the like) carry the folder's own name rather than a
  // person token — crew folders are lowercase slugs — and a whole-crew
  // document isn't anyone's certificate set, so those stay off this list.
  const shownFolders = folders
    .filter((f) => /^[a-z0-9-]+$/.test(f.folder))
    .map((f) => ({
      ...f,
      items: (q
        ? f.items.filter((c) => (c.filename + " " + f.person).toLowerCase().includes(q.toLowerCase()))
        : f.items
      )
        // Soonest expiry at the top of each person's list, so what needs
        // renewing is the first thing under the name; anything with no expiry
        // to its name sits below the dated ones.
        .slice()
        .sort((a, b) => (expiryOf(a) || "9999-99-99").localeCompare(expiryOf(b) || "9999-99-99")),
    }))
    .filter((f) => f.items.length);

  /* The folders under rank headings rather than one long alphabet: the
     bridge first, the engine room after, the GPH and the galley on the end —
     with anyone whose position the matrix doesn't carry under Other rather
     than dropped. Within each rank the folders keep their surname order. */
  const CERT_RANKS = [
    ["Masters", /master/i],
    ["Deck Officers", /officer|mate/i],
    ["Engineers", /engineer/i],
    ["GPH", /\bgph\b|general purpose/i],
    ["Chefs", /cook|chef/i],
  ];
  const rankOf = (person) => {
    const hit = CERT_RANKS.find(([, re]) => re.test(positions[person] || ""));
    return hit ? hit[0] : "Other";
  };

  /* Changing somebody's rank in place. The rank is the position the crew
     matrix holds against their name, so saving writes it there — and every
     page that reads it (this list's headings, the swing roster's groups, the
     shift checks) follows on its own. The choices are the positions the
     matrix already carries, with room to type one it doesn't. */
  /* Fixing somebody's name in place, and having it land everywhere at once.
   *
   * renameCrew is the portal's own name change and it does the lot: the matrix
   * row, the crew register - keeping the old spelling as one of his, so
   * anything still calling him that reaches him - the roster, the swing lists,
   * the notes filed against him, and his certificates here. The server is told
   * separately because the records it holds carry the name too. No file moves:
   * they are in the office's folders and they stay in them.
   *
   * This used to patch the matrix row on its own and then reload the page two
   * and a half seconds later, which is how Crew Details and the roster came to
   * be left saying the old name. */
  const [nameEdit, setNameEdit] = useState(null); // { person, value, busy }
  const saveName = async (person) => {
    const value = canonicalName(((nameEdit && nameEdit.value) || "").trim());
    if (!value || value === person) { setNameEdit(null); return; }
    setNameEdit((ed) => ({ ...ed, busy: true }));
    renameCrew(person, value);
    try {
      await fetch("/api/rename-person", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: person, to: value }) });
    } catch (e) {}
    setNameEdit(null);
  };
  /* The same for the rank: set once here, written to the matrix row, to his
     entry on Crew Details and to the roster's rows together, so the headings
     on this list, the register and the manning all read it at once. The
     choices are every position the matrix and the register already carry,
     with room to type one neither of them has. */
  const [rankEdit, setRankEdit] = useState(null); // { person, value }
  /* The vessel's eight ranks, and then whatever else the matrix calls its
     people. Same list as the one offered when a crew member is taken on, and
     for the same reason: a matrix holding one GPH used to offer a choice
     between GPH and nothing. See the longer note there. */
  const allPositions = useMemo(() => {
    const said = Array.from(new Set([
      ...QUALS.rows.map((r) => String(r[1] || "").trim()),
      ...Object.values(positions).map((x) => String(x || "").trim()),
    ].filter(Boolean)));
    const letters = (t) => String(t).toUpperCase().replace(/[^A-Z]/g, "");
    const standard = new Set(ROSTER_RANKS.map(letters));
    return [...ROSTER_RANKS, ...said.filter((p) => !standard.has(letters(p))).sort()];
  }, [QUALS, positions]);
  const saveRank = (person) => {
    const value = ((rankEdit && rankEdit.value) || "").trim();
    if (!value) return;
    setCrewRank(person, value);
    setRankEdit(null);
  };

  const ready = queue.filter((x) => x.person && x.person !== OTHER).length;

  /* Who on the list the portal has no folder for. Said before the button is
     pressed rather than after: a folder drop runs to hundreds of files, and
     finding out one failure at a time at the end of it is no use to anybody.
     Nothing is made for them - somebody points at the folder on Crew Details
     and they go in it. */
  const homeless = useMemo(() => {
    const out = new Set();
    queue.forEach((x) => {
      if (!x.person || x.person === OTHER) return;
      if (!certHomeOf(x.person)) out.add(x.person);
    });
    return [...out].sort((a, b) => a.localeCompare(b));
  }, [queue, certHomeOf]);

  // ---- the staging list, gathered back into the folders it came from ---------
  // A folder drop puts hundreds of files on this list. Shown one after another
  // they are unreadable and every one needs its own crew member set; gathered
  // into folders, a folder the roster didn't recognise is one choice, once.
  const groups = useMemo(() => {
    const byGroup = new Map();
    queue.forEach((item) => {
      const key = item.group || "";
      if (!byGroup.has(key)) byGroup.set(key, { group: key, items: [] });
      byGroup.get(key).items.push(item);
    });
    return [...byGroup.values()].sort((a, b) => a.group.localeCompare(b.group));
  }, [queue]);

  // Who a folder is filed against, when every file in it agrees.
  const groupPerson = (g) => {
    const all = new Set(g.items.map((x) => x.person));
    return all.size === 1 ? [...all][0] : "";
  };

  const setGroupPerson = (g, value) => {
    const keys = new Set(g.items.map((x) => x.key));
    setQueue((qq) =>
      qq.map((x) => (keys.has(x.key) ? { ...x, person: value, custom: false } : x)),
    );
  };

  // Reads whatever was dropped — loose files, a folder of them, or the one
  // folder holding every crew folder.
  const onDrop = (e) => {
    e.preventDefault();
    setHot(false);
    setReading(true);
    dropEntries(e.dataTransfer)
      .then((entries) => stage(entries))
      .catch(() => setErr("That folder couldn't be read. Try the Choose folders button instead."))
      .finally(() => setReading(false));
  };

  const dropzone = {
    border: `1px dashed ${hot ? T.accent : T.rule}`, borderRadius: 3,
    background: hot ? T.raised : T.panel,
    padding: "18px 16px", textAlign: "center", marginBottom: 14,
  };

  return (
    <div>
      {/* Who the next files belong to */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
        <div style={{ flex: "1 1 260px" }}>
          <ChoiceField label="Crew member">
            <NameSelect value={person} onPick={setPerson}
              options={[{ value: "", label: "Work it out from the folder or file name" },
                ...names.map((n) => ({ value: n, label: n }))]} />
          </ChoiceField>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input ref={fileRef} type="file" multiple style={{ display: "none" }}
            onChange={(e) => { stage(pickedEntries(e.target.files)); if (fileRef.current) fileRef.current.value = ""; }} />
          {/* webkitdirectory is what turns this into a folder picker. It is set on
              the element itself because React doesn't pass the attribute through. */}
          <input ref={(el) => {
              folderRef.current = el;
              if (el) { el.setAttribute("webkitdirectory", ""); el.setAttribute("directory", ""); }
            }}
            type="file" multiple style={{ display: "none" }}
            onChange={(e) => { stage(pickedEntries(e.target.files)); if (folderRef.current) folderRef.current.value = ""; }} />
          <Button variant="quiet" writes onClick={() => fileRef.current && fileRef.current.click()}>Choose files</Button>
          <Button writes onClick={() => folderRef.current && folderRef.current.click()}>Choose folders</Button>
        </div>
      </div>

      <div style={dropzone}
        onDragOver={(e) => { e.preventDefault(); if (!hot) setHot(true); }}
        // dragleave also fires crossing from the box onto the text inside it, so
        // the highlight only drops when the pointer has left the box for good.
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setHot(false);
        }}
        onDrop={onDrop}>
        <div style={{ fontFamily: T.body, fontSize: 14, color: hot ? T.text : T.muted }}>
          {reading
            ? "Reading the folders…"
            : "Drop crew folders here — one person's, or the whole set."}
        </div>
        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 6 }}>
          folders or single files · {humanSize(MAX_UPLOAD_BYTES)} per file
        </div>
      </div>

      {/* Staged files, gathered into the folders they came from, before anything is sent */}
      {queue.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
            gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
            <Eyebrow color={T.accent}>
              Ready to file · {queue.length} file{queue.length === 1 ? "" : "s"}
              {groups.length > 1 ? ` in ${groups.length} folders` : ""}
            </Eyebrow>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Button variant="quiet" onClick={() => { setQueue([]); setDone(null); setErr(""); }}>Clear</Button>
            </div>
          </div>

          {queue.length > 1 && (
            <div style={{ marginBottom: 10 }}>
              <ChoiceField label="Set every file to…">
                <Choices value="" compact
                  onPick={(v) => { if (v) setQueue((qq) => qq.map((x) => ({ ...x, person: v, custom: false }))); }}
                  options={names.map((n) => ({ value: n, label: n }))} />
              </ChoiceField>
            </div>
          )}

          {groups.map((g) => {
            // Every folder is laid out in full — nothing on the staging list is
            // collapsed, so every file is on screen at once.
            const chosen = groupPerson(g);
            const unset = g.items.filter((x) => !x.person || x.person === OTHER).length;

            return (
              <div key={g.group || "(loose)"} style={{ marginBottom: 10 }}>
                {g.group && (
                  <div style={{ background: T.raised, border: `1px solid ${T.rule}`,
                    borderLeft: `3px solid ${unset ? T.bOrange : T.teal}`, borderRadius: 2,
                    padding: "9px 12px" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ flex: "1 1 200px", minWidth: 0 }}>
                        <span style={{ fontFamily: T.body, fontSize: 14, fontWeight: 600, color: T.text,
                          wordBreak: "break-word" }}>
                          {g.group}
                        </span>
                        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginLeft: 8 }}>
                          {g.items.length} file{g.items.length === 1 ? "" : "s"}
                        </span>
                      </span>

                      <button className="um-btn" title="Take this folder off the list"
                        onClick={() => {
                          const keys = new Set(g.items.map((x) => x.key));
                          setQueue((qq) => qq.filter((x) => !keys.has(x.key)));
                        }}
                        style={{ background: "transparent", color: T.muted, fontSize: 10, fontWeight: 700, padding: "4px 0" }}>
                        Remove
                      </button>
                    </div>

                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginBottom: 5 }}>
                        {unset === g.items.length ? "Who is this folder?" : "Set the whole folder to…"}
                      </div>
                      <Choices value={names.includes(chosen) ? chosen : ""} compact
                        onPick={(v) => setGroupPerson(g, v)}
                        options={names.map((n) => ({ value: n, label: n }))} />
                    </div>
                  </div>
                )}

                {g.items.map((item) => {
                  const clash = clashFor(item);
                  const hasPerson = item.person && item.person !== OTHER;
                  const home = hasPerson ? certHomeOf(item.person) : null;
                  return (
                    <div key={item.key} style={{ background: T.panel, border: `1px solid ${T.rule}`,
                      borderLeft: `3px solid ${clash ? T.bOrange : item.person ? T.teal : T.rule}`,
                      borderRadius: 2, padding: "10px 12px", marginTop: 8,
                      marginLeft: g.group ? 14 : 0 }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                        <FileIcon name={item.file.name} />
                        <div style={{ flex: "1 1 230px", minWidth: 0 }}>
                          <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, wordBreak: "break-word" }}>
                            {item.file.name}
                          </div>
                          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 3 }}>
                            {humanSize(item.file.size)}
                            {!hasPerson ? " · no crew member chosen"
                              : home ? ` · ${item.person} · ${home.where}`
                              : ` · ${item.person} · no folder`}
                          </div>
                          {hasPerson && !home && (
                            <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.bRed, marginTop: 5, lineHeight: 1.5 }}>
                              The portal has no folder for {item.person} and won't make one.
                              Set his folder on Crew Details.
                            </div>
                          )}
                          {clash && (
                            <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.bOrange, marginTop: 5, lineHeight: 1.5 }}>
                              {clash.kind === "content"
                                ? `Already filed for this person as "${clash.with.filename}".`
                                : clash.kind === "column"
                                  ? `An older ${clash.title} is already in this person's folder: "${clash.with.filename}".`
                                  : "A certificate with this name is already in this person's folder."}
                              {" "}You'll be asked what to do with it.
                            </div>
                          )}
                          {item.state === "failed" && (
                            <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.bRed, marginTop: 5 }}>{item.msg}</div>
                          )}
                        </div>
                        <button className="um-btn" title="Take this file off the list"
                          onClick={() => setQueue((qq) => qq.filter((x) => x.key !== item.key))}
                          style={{ background: "transparent", color: T.muted, fontSize: 10, fontWeight: 700, padding: "4px 0" }}>
                          Remove
                        </button>
                      </div>

                      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                        <div>
                          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginBottom: 5 }}>Crew member</div>
                          {item.custom ? (
                            <input className="um-in" placeholder="Name, as it should be filed"
                              value={item.person === OTHER ? "" : item.person}
                              onChange={(e) => patch(item.key, { person: e.target.value })}
                              onBlur={(e) => patch(item.key, { person: canonicalName(e.target.value) })} />
                          ) : (
                            <NameSelect value={names.includes(item.person) ? item.person : ""}
                              onPick={(v) => {
                                patch(item.key, v === OTHER ? { custom: true, person: "" } : { person: v, custom: false });
                              }}
                              options={[{ value: "", label: "Pick a name…" },
                                ...names.map((n) => ({ value: n, label: n })),
                                { value: OTHER, label: OTHER }]} />
                          )}
                        </div>
                        <div>
                          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginBottom: 5 }}>What it is (optional)</div>
                          <Choices value={item.qualCode} compact
                            onPick={(v) => patch(item.key, { qualCode: v })}
                            options={[{ value: "", label: "Not set" },
                              ...QUALS.cols.map((c) => ({ value: c[0], label: `${c[0]} · ${c[1]}` }))]} />
                          {/* Or one of the five papers that stand in for a
                              certificate, about the column chosen above. */}
                          <div style={{ marginTop: 6 }}>
                            <Choices value={item.evidenceKind || ""} compact
                              onPick={(v) => patch(item.key, { evidenceKind: v })}
                              options={paperChoices()} />
                          </div>
                        </div>
                        <div style={{ maxWidth: 220 }}>
                          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginBottom: 5 }}>Expiry date (optional)</div>
                          <input className="um-in" type="date" value={item.expires}
                            title="Expiry date (optional)"
                            onChange={(e) => patch(item.key, { expires: e.target.value })} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
            <Button writes onClick={fileAll} disabled={busy || queue.length === 0}>
              {/* Keyed on this batch's own step: while a file is going up the
                  count shows; once the batch is sent the round is reading it.
                  Not on a run being present - a round from elsewhere can be
                  live while the batch is still going up. */}
              {busy
                ? (at ? `Filing ${at}` : "Reading what was filed...")
                : `File ${queue.length} certificate${queue.length === 1 ? "" : "s"}`}
            </Button>
            {queue.length > ready && (
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.bOrange }}>
                {queue.length - ready} will be asked about as they come up.
              </span>
            )}
          </div>
          {homeless.length > 0 && (
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.bRed, marginTop: 10, lineHeight: 1.6 }}>
              No folder on Crew Details for {homeless.join(", ")}. Nothing of theirs will be filed
              until one is set, and the portal won't make one.
            </div>
          )}
          {/* Files left out of the batch — worth saying, but nothing failed */}
          {err && <div style={{ fontFamily: T.body, fontSize: 13, color: T.bOrange, marginTop: 10 }}>{err}</div>}
        </div>
      )}

      {/* Nothing staged, but the last drop had something to say about why */}
      {queue.length === 0 && err && (
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.bRed, marginBottom: 14 }}>{err}</div>
      )}

      {/* What happened last time the button was pressed */}
      {done && (
        <div style={{ background: T.panel, border: `1px solid ${T.rule}`,
          borderLeft: `4px solid ${done.failed ? T.bOrange : T.green}`, borderRadius: 2,
          padding: "13px 15px", marginBottom: 18 }}>
          <div style={{ marginBottom: 7 }}>
            <Eyebrow color={done.failed ? T.bOrange : T.green}>
              {done.filed + done.replaced} filed
              {done.replaced ? ` · ${done.replaced} replaced` : ""}
              {done.skipped ? ` · ${done.skipped} skipped` : ""}
              {done.failed ? ` · ${done.failed} not filed` : ""}
            </Eyebrow>
          </div>
          {done.results.map((r, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12,
              flexWrap: "wrap", padding: "4px 0", borderBottom: `1px solid ${T.rule}` }}>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, wordBreak: "break-word" }}>
                {r.name} <span style={{ color: T.muted }}>· {r.person || "nobody chosen"}</span>
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 11,
                color: r.state === "failed" || r.state === "unassigned" ? T.bRed
                  : r.state === "skipped" ? T.muted : T.green }}>
                {r.state === "unassigned" ? "no crew member" : r.state}{r.msg ? ` — ${r.msg}` : ""}
              </span>
              {/* The reader's warning, once the round that follows the batch
                  has read the file: the column it was filed under against
                  what the reader made of it (the same line Needs attention
                  carries, filedAs on the dates). */}
              {(() => {
                const f = r.id && certDates && (certDates.filedAs || []).find((x) => x.url === `/api/files/${r.id}`);
                return f ? (
                  <span style={{ flexBasis: "100%", fontFamily: T.body, fontSize: 12.5, color: T.bOrange }}>
                    {tagWarning(f.code, f.title, f.readsAs)}
                  </span>
                ) : null;
              })()}
            </div>
          ))}
        </div>
      )}

      {/* What the round that follows a batch is doing, and what it changed. It
          sits under the filing summary because it happens after it, and because
          it is the part that takes minutes rather than seconds. While it runs it
          is also watched from the shared window over the page. Rounds started
          elsewhere report in that window instead, so only a round that
          followed a filing is repeated here. */}
      {auto && auto.origin === "certificates" && (
        <div style={{ background: T.panel, border: `1px solid ${T.rule}`,
          borderLeft: `4px solid ${auto.phase === "failed" ? T.bOrange : auto.phase === "done" ? T.green : T.accent}`,
          borderRadius: 2, padding: "13px 15px", marginBottom: 18 }}>

          {auto.phase === "failed" ? (
            <>
              <div style={{ marginBottom: 7 }}><Eyebrow color={T.bOrange}>Filed, but the matrix was not updated</Eyebrow></div>
              <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.7 }}>
                Every certificate above is filed and nothing has been lost. The round that follows it
                stopped: {auto.message}
              </div>
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.muted, lineHeight: 1.6, marginTop: 8 }}>
                The certificates already read are kept, so the next upload carries on from here
                rather than starting over.
              </div>
            </>
          ) : auto.phase === "done" ? (() => {
            /* The server's outcome, with the page's own refile alongside. */
            const o = auto.outcome || {};
            const s = o.summary || {};
            const moved = Array.isArray(o.moved) ? o.moved : [];
            const changes = Array.isArray(o.changes) ? o.changes : [];
            const applied = o.applied || 0;
            const eyebrow = o.noItems ? "Nothing on the matrix yet"
              : `${s.read || 0} of ${s.certificates || 0} certificates read`
                + (moved.length ? ` · ${moved.length} refiled` : "")
                + (applied ? ` · ${applied} matrix ${applied === 1 ? "date" : "dates"} updated` : "")
                + (o.cleared ? ` · ${o.cleared} cleared` : "");
            return (
            <>
              <div style={{ marginBottom: 7 }}>
                <Eyebrow color={T.green}>{eyebrow}</Eyebrow>
              </div>

              {/* The counts, the workbook and any one-line problem - the same
                  lines the window over the page says for every other origin,
                  less the read count the eyebrow already carries. */}
              {doneWindowLines(o).slice(1).map((line, i) => (
                <div key={i} style={{ fontFamily: T.body, fontSize: 13, lineHeight: 1.7,
                  color: line.tone === "problem" ? T.bOrange : line.tone === "muted" ? T.muted : T.text }}>
                  {line.tone === "link" && line.href
                    ? <a href={line.href} download={line.download}
                        style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, textDecoration: "none" }}>{line.text}</a>
                    : line.text}
                </div>
              ))}

              {moved.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ marginBottom: 5 }}><Eyebrow>Moved into the right folder</Eyebrow></div>
                  {moved.map((m) => (
                    <div key={m.id} style={{ fontFamily: T.body, fontSize: 13, color: T.text,
                      padding: "3px 0", wordBreak: "break-word" }}>
                      {m.filename} <span style={{ color: T.muted }}>· {m.from || "nobody"} → {m.to}</span>
                    </div>
                  ))}
                </div>
              )}

              {changes.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ marginBottom: 5 }}><Eyebrow>Written into the matrix</Eyebrow></div>
                  <div style={{ maxHeight: 190, overflowY: "auto" }}>
                    {changes.map((a, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12,
                        flexWrap: "wrap", padding: "4px 0", borderBottom: `1px solid ${T.rule}` }}>
                        <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>
                          {a.person} <span style={{ color: T.muted }}>· {a.code} {a.title}</span>
                        </span>
                        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
                          {a.from ? valueReads(a.from) : ""} → <span style={{ color: a.to ? T.green : T.muted }}>{a.to ? valueReads(a.to) : ""}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
            );
          })() : (
            <>
              <div style={{ marginBottom: 7 }}><Eyebrow color={T.accent}>Reading what was just filed</Eyebrow></div>
              <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.7 }}>
                {auto.phase === "reading" && (auto.total
                  ? `Reading the certificates — ${auto.read} of ${auto.total} done.`
                  : "Looking for certificates to read...")}
                {auto.phase === "filing" && (auto.toFile
                  ? `Putting each certificate in the folder of the person named on it — ${auto.filed} of ${auto.toFile}.`
                  : "Putting each certificate in the folder of the person named on it...")}
                {auto.phase === "waiting" && "Waiting for the round on the hour"}
                {auto.phase === "starting" && (auto.word || "Starting")}
              </div>
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.muted, lineHeight: 1.6, marginTop: 8 }}>
                Leave the page open; each certificate is kept as it is read.
              </div>
            </>
          )}
        </div>
      )}

      {/* The folders themselves */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
        gap: 12, flexWrap: "wrap", marginBottom: 9, marginTop: 22 }}>
        <Eyebrow color={T.accent}>Certificates on file · {certificates.length}</Eyebrow>
        <input className="um-in" style={{ width: "auto", minWidth: 190 }} value={q}
          onChange={(e) => setQ(e.target.value)} placeholder="Search crew or file name" />
      </div>

      {shownFolders.length === 0 ? (
        <Empty>
          {certificates.length === 0
            ? "No certificates have been filed yet."
            : "Nothing matches that search."}
        </Empty>
      ) : [...CERT_RANKS.map(([g]) => g), "Other"].map((g) => {
        const inRank = shownFolders.filter((f) => rankOf(f.person) === g);
        if (!inRank.length) return null;
        return (
          <div key={g}>
            <div style={{ margin: "18px 0 8px" }}>
              <Eyebrow>{g} · {inRank.length}</Eyebrow>
            </div>
            {inRank.map((f) => {
        // Searching opens whatever it matched — a hit hidden behind a closed
        // name would read as no hit at all.
        const opened = !!q || openFolders.has(f.folder);
        return (
          <div key={f.folder} style={{ background: T.panel, border: `1px solid ${T.rule}`,
            borderRadius: 2, marginBottom: 8 }}>
            <button className="um-btn" aria-expanded={opened}
              onClick={() => setOpenFolders((prev) => {
                const next = new Set(prev);
                if (next.has(f.folder)) next.delete(f.folder); else next.add(f.folder);
                return next;
              })}
              title={opened ? "Close this person's certificates" : "Show this person's certificates"}
              style={{ width: "100%", textAlign: "left", padding: "11px 13px", background: "transparent",
                border: 0, cursor: "pointer",
                display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              {(() => {
                // A name whose list holds anything in the red band — expired,
                // or inside 30 days — is flagged before the folder is opened,
                // so the closed list still shows where the trouble is.
                const reds = f.items.filter((c) => {
                  const e = expiryOf(c);
                  return e && bandFor(e).key === "red";
                }).length;
                // NH — the matrix requires something for their position that
                // they have never held. Blue on purpose: it is not an expiry.
                const nh = notHeldFor(f.person).items.length;
                return (
                  <span style={{ fontFamily: T.body, fontSize: 14, fontWeight: 600,
                    color: reds ? T.bRed : T.text, textTransform: "none", letterSpacing: 0 }}>
                    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, marginRight: 9 }}>
                      {opened ? "▾" : "▸"}
                    </span>
                    {f.person}
                    <span style={{ color: T.muted, fontWeight: 400 }}>
                      {positions[f.person] ? ` · ${positions[f.person]}` : ""}
                    </span>
                    {nh > 0 && (
                      <span title={`${nh} required item${nh === 1 ? "" : "s"} not held — listed at the bottom of their certificates`}
                        style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.accent,
                          marginLeft: 9, whiteSpace: "nowrap", verticalAlign: "1px" }}>
                        NH
                      </span>
                    )}
                    {reds > 0 && (
                      <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                        background: T.bRedBg, color: T.bRed, padding: "2px 7px", borderRadius: 2,
                        marginLeft: 9, whiteSpace: "nowrap", verticalAlign: "1px" }}>
                        {reds} expired or within 30 days
                      </span>
                    )}
                  </span>
                );
              })()}
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, letterSpacing: 0, textTransform: "none" }}>
                {(() => {
                  /* Where these are actually filed — read off the real path an
                     item in the folder carries. Never worked out from his name:
                     a name makes a folder the library hasn't got, and a folder
                     the library hasn't got is not where anything is. */
                  const real = f.items.find((c) => c.path);
                  const dir = real ? real.path.split("/").slice(0, -1).join("/") + "/" : "no folder";
                  return dir + ' · ' + f.items.length;
                })()}
              </span>
            </button>

            {opened && (
              <div style={{ padding: "0 13px 10px" }}>
                {/* The person's rank, changeable in place — it moves them
                    between the headings above the moment it is saved. */}
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
                  padding: "8px 0 2px" }}>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
                    Rank · <span style={{ color: T.text }}>{positions[f.person] || "not on the matrix"}</span>
                  </span>
                  {/* The folder the next one goes into: the one set against him
                      on Crew Details, or the one his papers are already in. */}
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
                    Folder · <span style={{ color: certHomeOf(f.person) ? T.text : T.bRed }}>
                      {(certHomeOf(f.person) || {}).where || "none set on Crew Details"}
                    </span>
                  </span>
                  {positions[f.person] !== undefined && (
                    <button className="um-btn"
                      onClick={() => setRankEdit(rankEdit && rankEdit.person === f.person
                        ? null
                        : { person: f.person, value: positions[f.person] || "" })}
                      style={{ background: "transparent", color: T.muted, fontSize: 10,
                        fontWeight: 700, padding: "2px 0" }}>
                      {rankEdit && rankEdit.person === f.person ? "Close" : "Change rank"}
                    </button>
                  )}
                  <button className="um-btn"
                    onClick={() => setNameEdit(nameEdit && nameEdit.person === f.person
                      ? null
                      : { person: f.person, value: f.person })}
                    style={{ background: "transparent", color: T.muted, fontSize: 10,
                      fontWeight: 700, padding: "2px 0" }}>
                    {nameEdit && nameEdit.person === f.person ? "Close" : "Fix name"}
                  </button>
                </div>
                {rankEdit && rankEdit.person === f.person && (
                  <div style={{ background: T.deep, border: `1px solid ${T.rule}`, borderRadius: 2,
                    padding: "11px 13px", margin: "6px 0 8px" }}>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                      <div style={{ flex: "1 1 260px" }}>
                        <ChoiceField label="Rank / position">
                          <Choices value={rankEdit.value} compact
                            onPick={(v) => setRankEdit((ed) => ({ ...ed, value: v }))}
                            options={allPositions.map((p) => ({ value: p, label: p }))} />
                        </ChoiceField>
                      </div>
                      <div style={{ flex: "0 1 220px" }}>
                        <Field label="Or type a new one">
                          <input className="um-in" value={rankEdit.value}
                            onChange={(e) => setRankEdit((ed) => ({ ...ed, value: e.target.value }))} />
                        </Field>
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Button writes onClick={() => saveRank(f.person)}
                          disabled={!(rankEdit.value || "").trim()}>Save</Button>
                        <Button variant="quiet" onClick={() => setRankEdit(null)}>Cancel</Button>
                      </div>
                    </div>
                  </div>
                )}
                {nameEdit && nameEdit.person === f.person && (
                  <div style={{ background: T.deep, border: `1px solid ${T.rule}`, borderRadius: 2,
                    padding: "11px 13px", margin: "6px 0 8px" }}>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                      <div style={{ flex: "1 1 280px" }}>
                        <Field label="Name, as it should read">
                          <input className="um-in" value={nameEdit.value}
                            onChange={(e) => setNameEdit((ed) => ({ ...ed, value: e.target.value }))} />
                        </Field>
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Button writes onClick={() => saveName(f.person)}
                          disabled={!!nameEdit.busy || !(nameEdit.value || "").trim() || nameEdit.value.trim() === f.person}>
                          {nameEdit.busy ? "Saving everywhere..." : "Save"}
                        </Button>
                        <Button variant="quiet" onClick={() => setNameEdit(null)}>Cancel</Button>
                      </div>
                    </div>
                  </div>
                )}
                {/* Column headings, once per open folder; the rows below carry
                    each date under its own heading rather than in running text. */}
                <div className="um-datehead" style={{ display: "flex", gap: 12, alignItems: "baseline",
                  padding: "8px 0 4px", borderTop: `1px solid ${T.rule}` }}>
                  <div style={{ flex: "1 1 220px", minWidth: 0 }} />
                  <span style={{ fontFamily: T.display, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em",
                    textTransform: "uppercase", color: T.muted, width: 82, flex: "0 0 82px" }}>Issue date</span>
                  <span style={{ fontFamily: T.display, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em",
                    textTransform: "uppercase", color: T.muted, width: 82, flex: "0 0 82px" }}>Expiry date</span>
                  <span style={{ fontFamily: T.display, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em",
                    textTransform: "uppercase", color: T.muted, width: 110, flex: "0 0 110px" }}>Validity period</span>
                  <span style={{ width: 150, flex: "0 0 150px" }} />
                </div>
                {(() => {
                  const fileRow = (c) => {
                  const d = readOf(c);
                  const expiry = expiryOf(c);
                  const code = codeOf(c);
                  const validity = validityFor({ code, title: c.title || c.filename });
                  return (
                  <React.Fragment key={c.id}>
                    <div className="um-row" style={{ display: "flex", gap: 12, alignItems: "center",
                      flexWrap: "wrap", padding: "8px 0", borderTop: `1px solid ${T.rule}` }}>
                      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                        <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, wordBreak: "break-word" }}>
                          {c.filename}
                        </div>
                        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 3 }}>
                          {[code, c.size, c.uploaded ? `filed ${fmtDate(c.uploaded)}` : null, c.by]
                            .filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: d && d.issued ? T.text : T.muted,
                        width: 82, flex: "0 0 82px" }}>{d && d.issued ? colDate(d.issued) : "—"}</span>
                      <span style={{ width: 82, flex: "0 0 82px" }}>
                        {(() => {
                          // Coloured by bandFor, the same bands as the crew
                          // matrix tiles, so a date reads the same colour here.
                          if (expiry) {
                            const b = bandFor(expiry);
                            return (
                              <span style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 600,
                                background: b.bg, color: b.fg, padding: "3px 6px", borderRadius: 2,
                                whiteSpace: "nowrap" }}>{colDate(expiry)}</span>
                            );
                          }
                          if (neverExpiresRow(c)) {
                            // "No expiry" rather than "Doesn't expire" — the
                            // longer wording overruns this narrow column; the
                            // validity column beside it carries the full phrase.
                            return (
                              <span style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 600,
                                background: T.bGreenBg, color: T.bGreen, padding: "3px 6px", borderRadius: 2,
                                whiteSpace: "nowrap" }}>No expiry</span>
                            );
                          }
                          return <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>—</span>;
                        })()}
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: validity ? T.text : T.muted,
                        width: 110, flex: "0 0 110px", lineHeight: 1.5 }}>{validity || "—"}</span>
                      {/* Grows past its 150px when a Delete's warning opens
                          beside Confirm, and takes the next line if it must,
                          rather than stacking the words in a column. */}
                      <div style={{ minWidth: 150, flex: "0 0 auto", maxWidth: "100%", display: "flex", gap: 10,
                        alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>
                        <OpenLink url={c.url} />
                        {c.stored && (
                          <button className="um-btn"
                            onClick={() => setEdit(edit && edit.id === c.id
                              ? null
                              : { id: c.id, qualCode: c.qualCode || "", evidenceKind: c.evidenceKind || "", expires: c.expires || "", busy: false, err: "" })}
                            style={{ background: "transparent", color: T.muted, fontSize: 10, fontWeight: 700, padding: "4px 0" }}>
                            {edit && edit.id === c.id ? "Close" : "Edit"}
                          </button>
                        )}
                        <DeleteBtn item={c} onDelete={() => removeCertificate(c)} warn={deleteWarn(certDates, c.id)} />
                      </div>
                    </div>

                    {/* Correcting what this certificate is filed as. Saving writes
                        the date straight into the crew matrix as well, and stamps
                        the matrix-updated date — press Update matrix once
                        everything has been put right, and the round writes the
                        training matrix spreadsheet in one go. */}
                    {edit && edit.id === c.id && (
                      <div style={{ background: T.deep, border: `1px solid ${T.rule}`, borderRadius: 2,
                        padding: "11px 13px", margin: "2px 0 8px" }}>
                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                          <div style={{ flex: "1 1 220px" }}>
                            <ChoiceField label="Matrix item">
                              <Choices value={edit.qualCode} compact
                                onPick={(v) => setEdit((ed) => ({ ...ed, qualCode: v }))}
                                options={[{ value: "", label: "Not on the matrix" },
                                  ...QUALS.cols.map(([code, title]) => ({ value: code, label: `${code} — ${title}` }))]} />
                              <div style={{ marginTop: 6 }}>
                                <Choices value={edit.evidenceKind || ""} compact
                                  onPick={(v) => setEdit((ed) => ({ ...ed, evidenceKind: v }))}
                                  options={paperChoices()} />
                              </div>
                            </ChoiceField>
                          </div>
                          <div style={{ flex: "0 1 170px" }}>
                            <Field label="Expires">
                              <input className="um-in" type="date" value={edit.expires}
                                onChange={(e) => setEdit((ed) => ({ ...ed, expires: e.target.value }))} />
                            </Field>
                          </div>
                          <div style={{ display: "flex", gap: 8 }}>
                            <Button writes onClick={() => saveEdit(c)} disabled={edit.busy}>
                              {edit.busy ? "Saving…" : "Save"}
                            </Button>
                            <Button variant="quiet" onClick={() => setEdit(null)} disabled={edit.busy}>Cancel</Button>
                          </div>
                        </div>
                        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, lineHeight: 1.6, marginTop: 8 }}>
                          Saving updates {c.person}'s training on the crew matrix straight away and stamps the
                          date of the change. The training matrix spreadsheet catches up when Update the
                          spreadsheet is pressed below.
                          {noExpiryPeriod(edit.qualCode) && ` ${edit.qualCode} carries no expiry, so it is recorded as held`
                            + " rather than as a date, whatever is typed above."}
                        </div>
                        {edit.err && (
                          <div style={{ fontFamily: T.body, fontSize: 13, color: T.bRed, lineHeight: 1.6, marginTop: 8 }}>
                            {edit.err}
                          </div>
                        )}
                      </div>
                    )}
                  </React.Fragment>
                  );
                  };

                  /* The template for this person's position: every certificate
                     the crew matrix requires of them, in the matrix's own
                     order, each wearing the scans filed against it — and a
                     name with nothing on file still shown, saying so, rather
                     than quietly missing. Files that answer to no required
                     item follow at the bottom under Also on file. A person
                     the matrix doesn't carry keeps the plain file list. */
                  const byCode = new Map();
                  f.items.forEach((c) => {
                    const k = codeOf(c) || "";
                    if (!byCode.has(k)) byCode.set(k, []);
                    byCode.get(k).push(c);
                  });
                  const mrow = QUALS.rows.find(
                    (r) => String(r[0]).trim().toUpperCase() === String(f.person).trim().toUpperCase(),
                  );
                  if (!mrow) return f.items.map(fileRow);
                  const required = QUALS.cols
                    .map((col, i) => ({ code: col[0], title: col[1],
                      val: String((mrow[3] || [])[i] == null ? "" : (mrow[3] || [])[i]).trim() }))
                    .filter((x) => x.val !== "");
                  const reqCodes = new Set(required.map((x) => x.code));
                  const extras = f.items.filter((c) => !reqCodes.has(codeOf(c)));
                  const certName = (x, held) => {
                    const nh = x.val.toUpperCase() === "N";
                    return (
                      <div key={"t-" + x.code} style={{ display: "flex", gap: 10, alignItems: "baseline",
                        flexWrap: "wrap", padding: "9px 0 3px", borderTop: `1px solid ${T.rule}`, marginTop: 2 }}>
                        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, minWidth: 46 }}>{x.code}</span>
                        <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600,
                          color: nh ? T.bRed : T.text, flex: "1 1 220px", minWidth: 0 }}>
                          {x.title}
                        </span>
                        {!held && (
                          <span style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 600,
                            background: nh ? T.bRedBg : T.raised, color: nh ? T.bRed : T.muted,
                            padding: "3px 7px", borderRadius: 2, whiteSpace: "nowrap" }}>
                            {nh ? "Not holding"
                              : x.val === "?" ? "Unknown — check"
                              : /^y$/i.test(x.val) ? "Held · no scan on file"
                              : `No scan on file · matrix holds ${colDate(x.val)}`}
                          </span>
                        )}
                      </div>
                    );
                  };
                  return (
                    <>
                      {required.map((x) => {
                        const have = byCode.get(x.code) || [];
                        return (
                          <React.Fragment key={x.code}>
                            {certName(x, have.length > 0)}
                            {have.map(fileRow)}
                          </React.Fragment>
                        );
                      })}
                      {extras.length > 0 && (
                        <>
                          <div style={{ padding: "14px 0 2px", fontFamily: T.display, fontSize: 9.5,
                            fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: T.muted }}>
                            Also on file · not required for this position
                          </div>
                          {extras.map(fileRow)}
                        </>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        );
            })}
          </div>
        );
      })}

      {/* Always on the page, count and all, so it can be found when it is
          empty (Matthew, 26 Sep 2026: "can't find anything called doubleups"). */}
      <div style={{ marginTop: 22 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
            <Eyebrow color={doubleUps.length ? T.bOrange : T.accent}>Double ups · {doubleUps.length}</Eyebrow>
            {/* The whole list off the books in one go (Matthew, 27 Sep 2026:
                "add delete all button"), one file at a time, each parked
                under removed/ like a single Delete and put back the same way. */}
            <AllButton label="Delete all" busy="Deleting" count={doubleUps.length}
              run={deleteAllDoubleUps}
              onDone={(r) => setDoubleUpsLine(r ? (r.line || (r.failed.length ? oneByOneLine({ past: "Removed" }, r) : "")) : "")} />
          </div>
          {doubleUpsLine && (
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.bOrange, lineHeight: 1.6, marginBottom: 8 }}>{doubleUpsLine}</div>
          )}
          {doubleUps.length === 0 ? <Empty>None.</Empty> : (
          <div style={{ overflowX: "auto", background: T.panel, border: `1px solid ${T.rule}`,
            borderLeft: `4px solid ${T.bOrange}`, borderRadius: 2 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontFamily: T.mono, fontSize: 11 }}>
              <thead><tr>
                {["Crew member", "File", "Code", "Doubles", "Filed", "Size", "", ""].map((h, i) => (
                  <th key={i} style={{ textAlign: "left", padding: "7px 12px", borderBottom: `2px solid ${T.rule}`,
                    fontFamily: T.body, fontSize: 11, color: T.muted, textTransform: "uppercase",
                    letterSpacing: ".06em", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {doubleUps.map((c) => (
                  <tr key={c.id} style={{ borderBottom: `1px solid ${T.rule}` }}>
                    <td style={{ padding: "6px 12px", fontFamily: T.body, fontSize: 13, fontWeight: 600,
                      color: T.text, whiteSpace: "nowrap" }}>{c.person}</td>
                    <td style={{ padding: "6px 12px", color: T.text, wordBreak: "break-word", minWidth: 240 }}>{c.filename}</td>
                    <td style={{ padding: "6px 12px", color: T.muted, whiteSpace: "nowrap" }}>{codeOf(c) || "—"}</td>
                    <td style={{ padding: "6px 12px", color: T.muted, wordBreak: "break-word", minWidth: 200 }}>{c.kept || "—"}<span style={{ color: T.bOrange }}> · {c.why}</span></td>
                    <td style={{ padding: "6px 12px", color: T.muted, whiteSpace: "nowrap" }}>{c.uploaded || "—"}{c.by ? ` · ${c.by}` : ""}</td>
                    <td style={{ padding: "6px 12px", color: T.muted, whiteSpace: "nowrap" }}>{c.size || "—"}</td>
                    <td style={{ padding: "6px 12px" }}><OpenLink url={c.url} /></td>
                    <td style={{ padding: "6px 12px" }}><DeleteBtn item={c} onDelete={() => removeCertificate(c)} warn={deleteWarn(certDates, c.id)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </div>

      {/* What Delete took off the books, right under the lists it is deleted
          from, with Restore on each and Restore all over the lot. It sat on
          Access Grants under the IT Support sign-in until 27 Sep 2026, where
          a management login could not reach it. */}
      <div style={{ marginTop: 22 }}>
        <RemovedFiles stamp={certificates.length} />
      </div>

      {/* Notes — the standing footnotes, editable in place and shared */}
      <NotesPanel />

      {/* Whose certificate is this? Asked while the run waits, so nothing is
          filed against a guess and nothing is quietly left unfiled. */}
      {whose && (
        <div style={{ position: "fixed", inset: 0, zIndex: 92, background: "rgba(18,41,61,0.45)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: T.panel, border: "1px solid " + T.rule, borderTop: "4px solid " + T.accent,
            borderRadius: 3, padding: "20px 24px", width: "min(560px, 94vw)" }}>
            <Eyebrow color={T.accent}>Whose certificate is this?</Eyebrow>
            <div style={{ fontFamily: T.mono, fontSize: 12.5, color: T.text, margin: "10px 0 4px",
              wordBreak: "break-word" }}>{whose.file.name}</div>
            <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, marginBottom: 14, lineHeight: 1.6 }}>
              It is filed into that person's own folder — the portal will not make a new one.
            </div>
            <NameSelect value={whosePick} onPick={setWhosePick}
              options={[{ value: "", label: "Choose the crew member" },
                ...names.map((n) => ({ value: n, label: n }))]} />
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
              <Button writes variant="solid" disabled={!whosePick} onClick={() => answerWhose(whosePick)}>
                File it against {whosePick || "…"}
              </Button>
              <Button writes variant="quiet" onClick={() => answerWhose("")}>Leave this one</Button>
            </div>
          </div>
        </div>
      )}

      {/* The popup the uploader gets when a certificate is already in the folder */}
      {dup && (
        <div style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(18,41,61,0.45)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderRadius: 3,
            padding: 20, width: "100%", maxWidth: 480 }}>
            <div style={{ marginBottom: 6 }}><Eyebrow color={T.bOrange}>Already filed</Eyebrow></div>
            <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.7, marginBottom: 12 }}>
              <b style={{ wordBreak: "break-word" }}>{dup.item.file.name}</b><br />
              {dup.info.reason === "content"
                ? `This exact file is already in ${dup.info.person}'s folder.`
                : dup.info.reason === "column"
                  ? `${dup.info.person} already has ${(dup.info.column && dup.info.column.title) || "a certificate for this column"} on file. Replace it takes the old one off the books.`
                  : `A certificate with this name is already in ${dup.info.person}'s folder.`}
              {" "}Nothing has been uploaded.
            </div>

            <div style={{ background: T.deep, border: `1px solid ${T.rule}`, borderRadius: 2,
              padding: "9px 11px", marginBottom: 14 }}>
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginBottom: 6 }}>
                certification/{dup.info.folder}/
              </div>
              {dup.info.existing.map((e) => (
                <div key={e.id} style={{ display: "flex", justifyContent: "space-between", gap: 10,
                  alignItems: "center", flexWrap: "wrap", padding: "4px 0" }}>
                  <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, wordBreak: "break-word" }}>
                    {e.filename}
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
                      {" "}· {e.size}{e.uploaded ? ` · filed ${fmtDate(e.uploaded)}` : ""}
                      {e.sameBytes ? " · identical" : ""}
                    </span>
                  </span>
                  <OpenLink url={e.url} />
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button writes onClick={() => respond("replace")}>Replace it</Button>
              <Button writes variant="ghost" onClick={() => respond("keep")}>Keep both</Button>
              <Button writes variant="quiet" onClick={() => respond("skip")}>Skip this file</Button>
            </div>

            {queue.length > 1 && (
              <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14,
                fontFamily: T.body, fontSize: 13, color: T.muted }}>
                <input type="checkbox" checked={dupAll} onChange={(e) => setDupAll(e.target.checked)} />
                Do the same with the rest of this batch
              </label>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* Who SharePoint says is on the strength, held against the portal's own crew
 * list after a sync.
 *
 * The office puts a person on and takes a person off by making and deleting a
 * folder. The portal does not take that as an instruction on its own - a
 * folder can go missing for reasons that have nothing to do with a person
 * leaving - so the difference is put to whoever ran the sync, and the answer
 * is theirs. Nothing here happens on its own.
 */
function SyncPeople({ found, onClose }) {
  const { admin, quals: QUALS, rosterPlan, removeCrew, writeCrewToWorkbooks, people,
    folderNames, setFolderNames, setQuals, setRosterPlan, skillsRequirements, log } = usePortal();
  const reg = useMemo(() => crewRegister(people), [people]);
  const [gone, setGone] = useState("");
  // What the portal proposes for each folder it does not know, as it stands
  // on the screen: filled in first, edited where it is wrong, confirmed in one
  // press. Forty people typed in one at a time is how a job gets left undone.
  const [draft, setDraft] = useState({});
  const [done, setDone] = useState([]);
  const [filed, setFiled] = useState([]);

  /* What the matrix calls the jobs, in the office's own words - "Master",
     "Chief Officer - Unlimited", "Assistant Engineer". The roster keeps a
     shorter list of its own, and writing one of those into the matrix puts a
     person under a heading nobody else is under, so the matrix's own wording
     is what is asked for here and the roster rank is worked out from it. */
  /* The ranks to choose from: the vessel's eight, and then whatever else the
   * matrix calls its people.
   *
   * The eight are always there, in the order the vessel is manned. It used to
   * offer the matrix's own words and nothing else, on the reasoning that a new
   * hand should be filed the way the rest of the crew is filed — but the list
   * is only as long as the matrix is, so a matrix holding one GPH offered a
   * choice between GPH and typing it out, which is no choice at all.
   *
   * What the matrix says is still offered, underneath, because the office
   * draws finer than the eight do — "Chief Officer - 100m" and "Chief Officer
   * - Unlimited" are different men on different tickets, and the matrix keys
   * what it asks of them off exactly those words. Only a wording that says
   * the same thing as one of the eight is left out, so the list never carries
   * both COOK and Cook.
   *
   * And a rank can still be typed, because no list the portal builds for
   * itself is going to cover a job nobody has held here yet.
   */
  const allPositions = useMemo(() => {
    const site = SHIFT_MATRIX_VESSEL.toLowerCase();
    const said = Array.from(new Set([
      ...QUALS.rows.map((r) => String(r[1] || "").trim()),
      ...(((skillsRequirements || {}).positions) || [])
        .map((p) => String(p.position || "").replace(/\s+/g, " ").trim())
        .map((p) => (p.toLowerCase().startsWith(site) ? p.slice(SHIFT_MATRIX_VESSEL.length).trim() : p)),
    ].filter(Boolean)));

    const letters = (t) => String(t).toUpperCase().replace(/[^A-Z]/g, "");
    const standard = new Set(ROSTER_RANKS.map(letters));
    return [...ROSTER_RANKS, ...said.filter((p) => !standard.has(letters(p))).sort()];
  }, [QUALS, skillsRequirements]);

  const words = (t) => String(t || "").toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  const inCommon = (a, b) => {
    const held = new Set(words(a));
    return words(b).filter((w) => held.has(w)).length;
  };
  const sameName = (a, b) =>
    String(a || "").toUpperCase().replace(/[^A-Z]/g, "") === String(b || "").toUpperCase().replace(/[^A-Z]/g, "");

  /* Who is on the portal: everybody on the crew register, and anybody the
     matrix still names who has not reached the register yet.

     It used to be the matrix alone. The matrix is what the office sends and
     it can be empty - it was, the morning this was found - and with it empty
     every folder in SharePoint read as a stranger, including forty-three men
     who had just been given a rank and a swing on Crew Details. Crew Details
     is where the crew are named now; this reads it. */
  const onPortal = useMemo(() => {
    const seen = new Set();
    const out = [];
    [...(people || []).map((p) => p.name), ...QUALS.rows.map((r) => r[0])].forEach((n) => {
      const name = reg.nameOf(n) || String(n || "").trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      out.push(name);
    });
    return out;
  }, [people, QUALS, reg]);

  /* Which folder belongs to whom, worked out once.
   *
   * A folder is named however the office names it. Most are a first name -
   * "Kyle", "Travis" - some are a nickname no rule would ever get to from the
   * crew list ("AJ" for Alan James), and some are a surname. So the pairing
   * is taken in three passes, each surer than the one under it:
   *
   *   1. what somebody has already said outright, and been remembered;
   *   2. two names in common, which is a match nobody would argue with;
   *   3. a folder named with one word, where exactly one crew member answers
   *      to it - "Evgeny" can only be EVDOKIMOV, Evgeny.
   *
   * A name already spoken for is out of the running for the rest, and where
   * one word answers for two people - "Evans" - nothing is taken and the
   * question is put instead. The portal guessing wrong here would file a man's
   * certificates against somebody else.
   */
  const pairing = useMemo(() => {
    const out = new Map();
    const taken = new Set();
    const list = found || [];
    const claim = (folder, who) => { out.set(folder, who); taken.add(who); };

    /* 0. what the register already knows. A folder name or the name worked
          out from it that the register answers to - by name or by any spelling
          listed against a man - is that man, and nothing further is guessed. */
    list.forEach((p) => {
      const who = reg.nameOf(p.name) || reg.nameOf(p.folder);
      if (who && !taken.has(who)) claim(p.folder, who);
    });
    list.forEach((p) => {
      if (out.has(p.folder)) return;
      const said = (folderNames || {})[p.folder];
      if (said && onPortal.includes(said) && !taken.has(said)) claim(p.folder, said);
    });
    list.forEach((p) => {
      if (out.has(p.folder)) return;
      const hits = onPortal.filter((n) => !taken.has(n) && inCommon(n, p.name) >= 2);
      if (hits.length === 1) claim(p.folder, hits[0]);
    });
    list.forEach((p) => {
      if (out.has(p.folder)) return;
      const w = words(p.name);
      if (w.length !== 1) return;
      const hits = onPortal.filter((n) => !taken.has(n) && words(n).includes(w[0]));
      if (hits.length === 1) claim(p.folder, hits[0]);
    });
    return out;
  }, [found, onPortal, folderNames, reg]);

  const spokenFor = new Set(pairing.values());

  /* On the portal's books, with no folder in SharePoint any more.
   *
   * A listing that comes back short - Graph throttling a request, a folder
   * renamed, the library reorganised - would otherwise read as most of the
   * crew leaving at once, and the panel would sit there offering to take them
   * all off. A third of the crew unaccounted for is a listing that went wrong,
   * not a crew change, so the removals are held back and the reason is said
   * instead. One or two missing is the thing this is for.
   */
  const unmatched = onPortal.filter((n) => !spokenFor.has(n));
  const tooMany = onPortal.length >= 6 && unmatched.length > onPortal.length / 3;
  const leftBehind = tooMany ? [] : unmatched.filter((n) => !done.includes(n));
  // A folder in SharePoint that answers to nobody on the portal.
  const strangers = (found || []).filter((p) => !pairing.has(p.folder) && !done.includes(p.folder));

  const spine = (rosterPlan && rosterPlan.spine) || [];

  /* The rank the portal can work out for itself.
   *
   * The roster is the one place that already says what somebody is: it carries
   * a rank against every name on it. The roster keeps a short list in capitals
   * and the matrix keeps the office's certificate titles, so the two are matched
   * through the same rule the roster page uses to go the other way.
   *
   * Where the roster has never heard of them, nothing is proposed. A rank
   * guessed off a certificate would be wrong often enough to matter - half the
   * GPHs on this vessel hold a master's ticket of one size or another - and a
   * wrong rank quietly changes what the matrix asks of somebody. */
  const rosterRank = (name) => {
    const rows = (rosterPlan && rosterPlan.rows) || [];
    const hit = rows.find((r) => sameName(r.name, name));
    if (!hit || !hit.rank) return "";
    const want = String(hit.rank).toUpperCase();
    return allPositions.find((p) => rosterRankFor(p) === want) || "";
  };
  const rosterSwing = (name) => {
    const rows = (rosterPlan && rosterPlan.rows) || [];
    const hit = rows.find((r) => sameName(r.name, name));
    if (hit && hit.swing) return hit.swing;
    const today = todayISO();
    const here = spine.find((sp) => sp.on <= today && today < sp.off) || spine[0];
    return here ? swingKeyOf(here) : "";
  };

  const proposed = (p) => {
    const name = canonicalName(p.name);
    return { name, rank: rosterRank(name), swing: rosterSwing(name) };
  };
  const entry = (p) => draft[p.folder] || proposed(p);
  /* Seeded from what was proposed the first time a box is touched. Merging into
     an empty draft instead threw away the name and the swing the moment a rank
     was picked, and the row went quietly dead - the boxes still read right,
     because a React input handed undefined keeps whatever the browser has, and
     nothing happened when the button was pressed. */
  const setEntry = (p, change) =>
    setDraft((d) => ({ ...d, [p.folder]: { ...(d[p.folder] || proposed(p)), ...change } }));

  /* Somebody the office holds and the portal does not: a row on the crew
     matrix, and a place on a swing when the roster is loaded and one is
     chosen. Their certificates come across on the sync itself. */
/* Taking somebody onto the portal.
   *
   * `batch` is the difference between one person and forty-three. The
   * spreadsheets used to be written from in here, once for each person - which
   * is fine for one and a disaster for a list, because forty-three writes of
   * the same workbook set off at once race each other for it and SharePoint
   * turns all but one away: 409 resourceModified, name already exists. The
   * office's file is one file however many people went on.
   *
   * So a batch puts people on the portal and nothing else, and the caller
   * writes the workbooks once when the whole list is through. */
  const takeOn = (p, batch) => {
    const row = entry(p);
    const name = String(row.name || "").trim();
    const position = String(row.rank || "").trim();
    const swing = spine.find((sp) => swingKeyOf(sp) === row.swing) || null;
    if (!name || !position) return null;

    const matrixRow = [name, position, "", (QUALS.cols || []).map(() => "")];
    const rows = [...(QUALS.rows || []), matrixRow];
    setQuals((q) => ({ ...q, rows: [...(q.rows || []), matrixRow] }));

    let plannedAfter = rosterPlan;
    if (swing) {
      setRosterPlan((plan) => {
        if (!plan) return plan;
        plannedAfter = {
          ...plan,
          rows: [...(plan.rows || []), {
            id: "r" + Date.now(), source: "portal", covers: "",
            crew: swing.crew || "", rank: rosterRankFor(position), name,
            on: swing.on, off: swing.off, days: daysBetween(swing.on, swing.off),
            note: "", swing: swingKeyOf(swing),
          }],
          edited: true, updatedAt: todayISO(),
        };
        return plannedAfter;
      });
    }

    // The folder they came out of is theirs from now on, whatever it is called.
    setFolderNames({ ...(folderNames || {}), [p.folder]: name });

    log("Documents", name + " taken onto the portal",
      position + (swing ? " · " + fmtDate(swing.on) + " – " + fmtDate(swing.off) : " · no swing yet"));

    setDone((d) => [...d, p.folder]);
    if (batch) return { name, plan: swing ? plannedAfter : null, rows };

    // The office's spreadsheets follow, and what they managed is said here.
    const folder = p.folder;
    setFiled((f) => [...f, { folder, name, word: "Putting them on the spreadsheets…" }]);
    // The roster workbook is only rewritten where a swing was actually chosen;
    // rewriting it to say exactly what it already said is an upload for nothing.
    writeCrewToWorkbooks({ want: name, plan: swing ? plannedAfter : null, rows, leaving: false })
      .then((r) => setFiled((f) => f.map((x) => x.folder === folder
        ? { ...x, ok: r && r.ok, word: (r && r.said) || "nothing was written" } : x)))
      .catch((e) => setFiled((f) => f.map((x) => x.folder === folder
        ? { ...x, ok: false, word: String((e && e.message) || e) } : x)));
    return null;
  };

  /* The whole list, and then the workbooks once.
   *
   * The rows each call hands back are the matrix as it stood for that person,
   * so the last one through is the matrix with everybody on it - that is what
   * the spreadsheet is written from, and it is written a single time. */
  const takeOnEveryone = () => {
    const ready = strangers.filter((p) => {
      const r = entry(p);
      return String(r.name || "").trim() && String(r.rank || "").trim();
    });
    if (!ready.length) return;

    let last = null;
    ready.forEach((p) => { last = takeOn(p, true) || last; });
    if (!last) return;

    const many = ready.length + " crew";
    setFiled((f) => [...f, { folder: "__all", name: many, word: "Putting them on the spreadsheets…" }]);
    writeCrewToWorkbooks({ want: many, plan: last.plan, rows: last.rows, leaving: false })
      .then((r) => setFiled((f) => f.map((x) => x.folder === "__all"
        ? { ...x, ok: r && r.ok, word: (r && r.said) || "nothing was written" } : x)))
      .catch((e) => setFiled((f) => f.map((x) => x.folder === "__all"
        ? { ...x, ok: false, word: String((e && e.message) || e) } : x)));
  };

  const takeOff = (name) => {
    removeCrew(name);
    setDone((d) => [...d, name]);
    setGone("");
  };

  if (!admin) return null;
  if (!leftBehind.length && !strangers.length && !tooMany && !filed.length) return null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(22,50,74,0.45)", zIndex: 70,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: T.panel, border: "1px solid " + T.rule, borderTop: "4px solid " + T.accent,
        borderRadius: 3, padding: "20px 24px", width: "min(660px, 94vw)", maxHeight: "82vh", overflowY: "auto" }}>
        <Eyebrow color={T.accent}>SharePoint and the portal do not hold the same crew</Eyebrow>
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, margin: "8px 0 14px", lineHeight: 1.6 }}>
          Nothing has been changed. Each one is yours to answer.
        </div>

        {tooMany && (
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.bRed, lineHeight: 1.7,
            padding: "10px 12px", background: T.bRedBg, borderRadius: 2, marginBottom: 16 }}>
            {unmatched.length} of the {onPortal.length} crew on the portal have no folder in SharePoint.
            That reads as the listing coming back short rather than that many people leaving, so nobody
            is offered for removal here. Run the sync again, and if it says the same, the folders are
            worth a look.
          </div>
        )}

        {leftBehind.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontFamily: T.display, fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 4 }}>
              On the portal, no folder in SharePoint
            </div>
            {leftBehind.map((n) => (
              <div key={n} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
                padding: "9px 0", borderTop: "1px solid " + T.rule }}>
                <span style={{ fontFamily: T.body, fontSize: 13.5, fontWeight: 600, color: T.text, flex: 1 }}>{n}</span>
                {gone === n ? (
                  <>
                    <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.bRed }}>
                      Take them off the portal entirely?
                    </span>
                    <Button writes variant="solid" onClick={() => takeOff(n)}>Yes</Button>
                    <Button variant="quiet" onClick={() => setGone("")}>No</Button>
                  </>
                ) : (
                  <Button writes variant="quiet" onClick={() => setGone(n)}>Take off the portal</Button>
                )}
              </div>
            ))}
          </div>
        )}

        {strangers.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontFamily: T.display, fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 4 }}>
              In SharePoint, not on the portal
            </div>
            {/* Every folder the portal does not know, on the screen at once with
                what it proposes already in the boxes. Forty people asked about
                one at a time, each behind a button, is a job nobody finishes. */}
            {strangers.map((p) => {
              const row = entry(p);
              const surnameKnown = String(row.name || "").includes(",");
              return (
                <div key={p.folder} style={{ padding: "10px 0", borderTop: "1px solid " + T.rule }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <div style={{ flex: "1 1 210px" }}>
                      <Field label={"Name · folder " + p.folder}>
                        <input className="um-in" value={row.name}
                          onChange={(e) => setEntry(p, { name: e.target.value })} />
                      </Field>
                    </div>
                    <div style={{ flex: "1 1 190px" }}>
                      <Field label="Rank">
                        <select className="um-in" value={allPositions.includes(row.rank) ? row.rank : (row.rank ? "__typed" : "")}
                          onChange={(e) => setEntry(p, { rank: e.target.value === "__typed" ? " " : e.target.value })}>
                          <option value="">Choose…</option>
                          {allPositions.map((x) => <option key={x} value={x}>{x}</option>)}
                          <option value="__typed">Something else…</option>
                        </select>
                      </Field>
                    </div>
                    {!allPositions.includes(row.rank) && String(row.rank || "") !== "" && (
                      <div style={{ flex: "1 1 170px" }}>
                        <Field label="Type the rank">
                          <input className="um-in" autoFocus value={row.rank.trim()}
                            onChange={(e) => setEntry(p, { rank: e.target.value })} />
                        </Field>
                      </div>
                    )}
                    {/* No swing picker. The swing a man is on is the roster's
                        answer, seeded from it above, and asking again here only
                        offered a way of disagreeing with it. */}
                    <Button writes variant="ghost" disabled={!String(row.name || "").trim() || !String(row.rank || "").trim()}
                      onClick={() => takeOn(p, false)}>
                      Take on
                    </Button>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
                    {/* Pairing a folder with somebody already on the portal is
                        done on Crew Details, against the man himself, where it
                        sits beside his name and can be seen and undone. */}
                    {!surnameKnown && (
                      <span style={{ fontFamily: T.body, fontSize: 12, color: T.bOrange }}>
                        The folder gives one word, so the portal doesn't know the surname — write the full name in.
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            {/* The whole list at once, once the boxes read right. */}
            {strangers.length > 1 && (
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
                marginTop: 12, paddingTop: 10, borderTop: "1px solid " + T.rule }}>
                <Button writes variant="solid"
                  disabled={!strangers.some((p) => String(entry(p).name || "").trim() && String(entry(p).rank || "").trim())}
                  onClick={takeOnEveryone}>
                  Take on everyone above
                </Button>
                <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted }}>
                  {strangers.filter((p) => String(entry(p).rank || "").trim()).length} of {strangers.length} have a rank
                  {strangers.some((p) => !String(entry(p).rank || "").trim()) && " — the rest are left until one is picked"}
                </span>
              </div>
            )}
          </div>
        )}

        {filed.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontFamily: T.display, fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 4 }}>
              Taken on
            </div>
            {filed.map((f) => (
              <div key={f.folder} style={{ padding: "9px 0", borderTop: "1px solid " + T.rule }}>
                <div style={{ fontFamily: T.body, fontSize: 13.5, fontWeight: 600, color: T.text }}>{f.name}</div>
                <div style={{ fontFamily: T.body, fontSize: 12.5, lineHeight: 1.6,
                  color: f.ok === false ? T.bRed : T.muted }}>
                  {f.word}
                  {f.ok === false && <> — their dates go in on the next update.</>}
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

/* Update portal: the whole round, behind one button.
 *
 * Keeping the portal current used to be four jobs in four places - sync the
 * SharePoint folders, answer who has joined or left, read the new certificates
 * into the matrix, write the spreadsheet - and a job missed is a portal that
 * quietly says something that stopped being true a fortnight ago. They are one
 * press now, in the same order, from wherever you happen to be standing.
 *
 * It runs itself every hour when nobody has pressed it, so a portal left alone
 * over a swing does not drift. The hourly run does the reading and the writing;
 * it never adds or removes a crew member on its own, because that is a question
 * for a person and it asks the next one who opens the portal.
 */
/* This tab's own name, made once and kept for as long as the tab is open,
   so the hourly-round lease can tell one tab from another. With storage
   blocked the name lives only in memory, which is enough. */
let TAB_NAME = "";
function thisTab() {
  if (TAB_NAME) return TAB_NAME;
  try {
    TAB_NAME = sessionStorage.getItem(VESSEL.slug + "-tab") || "";
    if (!TAB_NAME) {
      TAB_NAME = "tab-" + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(VESSEL.slug + "-tab", TAB_NAME);
    }
  } catch (e) {
    TAB_NAME = TAB_NAME || "tab-" + Math.random().toString(36).slice(2, 10);
  }
  return TAB_NAME;
}

/* Whether an open admin tab should run the round itself this tick.
 *
 * The worker's hour does the round now; the tab is the fallback for an hour
 * that did not, so it stands down whenever the server has the matter in
 * hand. Never with unsaved changes in the tab (a round saves the document,
 * and it would save them with it), never offline, never while the server's
 * round holds the lease, and never when the server's last round is under
 * seventy minutes old and went through without an error or a skip. Only
 * then does the tab's own clock count, and it counts seventy minutes
 * rather than sixty, so the hour always gets its turn first. The same
 * seventy as the server's record: the hour's stamp on the document is
 * written some minutes after the hour began, so a longer window here
 * would stack on top of that one and leave the vessel unattended for the
 * best part of an hour and a half.
 *
 * `last` is the portal's answer to /api/sync/last, or null where it could
 * not be asked. `unanswered` is how many asks in a row have got no answer:
 * one is a bad second on the line and the tab waits for the next ask
 * rather than run a round behind an hour that may well have done the work;
 * only from the second does the tab's own clock stand in for the record.
 * One pure function so the rule can be proved outright
 * (tools/client-rules.test.mjs). */
const TAB_ROUND_AFTER = 70 * 60000;
function shouldTabRound({ lastDocUpdate, now, pending, online, last, unanswered = 0 }) {
  if (pending) return false;
  if (online === false) return false;
  if (!last && unanswered === 1) return false;
  if (last && last.running) return false;
  const h = last && last.hourly;
  if (h && h.at != null) {
    const at = typeof h.at === "number" ? h.at : Date.parse(h.at);
    const fresh = !isNaN(at) && now - at < 70 * 60000;
    if (fresh && h.roundError == null && h.roundSkipped == null) return false;
  }
  const own = lastDocUpdate ? Date.parse(lastDocUpdate) : 0;
  return !own || isNaN(own) || now - own > TAB_ROUND_AFTER;
}

/* How many asks in a row have got no answer, the tick's count moved on by
   one ask. Only the asks the tab made because it wanted to round count:
   the tab also asks, without wanting to, while the last answer said the
   hour was running, so its buttons come back when it stops. A miss on one
   of those, counted, would sit in the count for hours and make the first
   miss of a wanting ask read as the second - and one bad second on the
   line would send the tab off on a round behind an hour that did the
   work. `last` is the portal's answer, or null where none came. */
function missesInARow(before, wants, last) {
  return last || !wants ? 0 : (before || 0) + 1;
}

/* Whether the red line under Update portal can come down by itself.
   The line says why the last round from this tab stopped - out of credit,
   most often. It used to stay until somebody pressed the button again,
   long after the account was topped up and the hour had read everything.
   It comes down once an hour that began after the line went up has
   finished with no reading error on its record. `errAt` is when the line
   went up (ms); `last` is the portal's answer to /api/sync/last. An hour
   writes its record twice, once before its reading with the round "not
   yet run", so only the finished record counts - and only an hour that
   put certificates to the model (readTried): one that stood down for a
   held lease, could not start, or had nothing to read says nothing about
   the account, and would otherwise take the line down while it is still
   out of credit. Only the account's three lines come down this way: an
   hour that read says nothing about a library that could not be reached,
   a round refused for the lease or a save that never landed, so every
   other line stays until the button is pressed again, as it always did. */
// The three lines about the account are the only ones an hour can answer for:
// they come down by themselves once an hour reads clean. Every other line
// under the button stays until the next press.
function accountLine(err) {
  return [OUT_OF_CREDIT, READING_UNAVAILABLE, KEY_PROBLEM].includes(err);
}

function badgeShouldClear(err, errAt, last) {
  if (!accountLine(err)) return false;
  const h = last && last.hourly;
  if (!h || h.at == null) return false;
  const at = typeof h.at === "number" ? h.at : Date.parse(h.at);
  if (isNaN(at) || !(at > (errAt || 0))) return false;
  if (h.roundSkipped === "round not yet run") return false;
  if (h.readTried !== true) return false;
  return h.readError == null;
}

function UpdateDocumentation() {
  const { admin, lastDocUpdate, setLastDocUpdate, log, pending, roundRunning, setRoundRunning, offlineAt,
    quals: QUALS, setQuals, trainingMatrix,
    rosterPlan, setRosterPlan, crewRoster,
    skillsMatrix, skillsRequirements, setSkillsRequirements,
    certificates, setCertAnalysis, setMatrixAnalysis, runMatrixRound } = usePortal();
  const [step, setStep] = useState("");          // "" when nothing is running
  const [found, setFound] = useState(null);      // whose folders the sync saw
  const [asking, setAsking] = useState(false);   // items the skills matrix has gained or lost
  // Workbooks the library no longer holds, put to whoever is there.
  const [orphaned, setOrphaned] = useState(null);
  const [err, setErr] = useState("");
  // When the red line went up, so the tick can take it down again once a
  // later hour has read without trouble (badgeShouldClear).
  const errAt = useRef(0);
  const going = useRef(false);
  // The document's stamp as this tab holds it now, readable from inside a
  // round that started a while ago: the polls carry on underneath a round,
  // and the hour's own save moves the stamp on while a tab's round runs.
  const docStamp = useRef(lastDocUpdate);
  docStamp.current = lastDocUpdate;
  // How many asks of the portal in a row have got no answer (see shouldTabRound).
  const unanswered = useRef(0);

  const stamp = (iso) => {
    if (!iso) return "never";
    const d = new Date(iso);
    if (isNaN(d)) return "never";
    return d.toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  /* The round itself. `asked` is false for the hourly run, which does the
     reading and the writing and leaves the crew question for a person. */
  const go = async (asked = true) => {
    if (going.current) return;
    going.current = true;
    setErr(""); setFound(null);
    // Where the document stood when this round began.
    const pulled = docStamp.current || "";
    // Why the round stopped, where it did: the round's window says it at
    // the time, and the badge under the button keeps saying it after the
    // window is closed, until an hour reads clean (badgeShouldClear).
    let roundStopped = null;
    try {
      // The worker's hour holds the lease this takes; wait for it rather
      // than be refused, and if refused all the same, wait once more.
      setStep("Waiting for the round on the hour");
      await waitForRound(undefined, setRoundRunning);
      setStep("Reading the SharePoint folders");
      const ask = () => fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ by: asked ? "Update portal" : "the round on the hour" }) });
      let r = await ask();
      if (r.status === 409) {
        // Refused for the lease: the answer names who holds it, so the
        // buttons go down under that name now rather than under the
        // hour's until the next look (as runMatrixRound's 409 branch does).
        const refusal = await r.json().catch(() => ({}));
        setRoundRunning(true, typeof refusal.by === "string" ? refusal.by : "");
        setStep("Waiting for the round on the hour");
        await waitForRound(undefined, setRoundRunning);
        setStep("Reading the SharePoint folders");
        r = await ask();
      }
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || ("the folders couldn't be read (" + r.status + ")"));

      // Who SharePoint holds, put to whoever pressed the button. The rest of
      // the round carries on underneath it rather than waiting on an answer.
      if (asked && Array.isArray(out.people)) setFound(out.people);

      /* The reading and the spreadsheet both need the matrix to have items on
         it: the analysis is asked what each item means, and the workbook is
         found by looking for its row of item codes. With no items there is
         nothing to ask and nothing to look for, and both come back as errors
         about the items not being included - two windows, stacked, saying the
         same thing in a way that reads like a fault. It is not a fault; there
         is simply nothing to do yet. */
      if ((QUALS.cols || []).length) {
        // The one round (runMatrixRound): the page reads and refiles, the
        // server puts the dates on the matrix and into the workbook, under
        // the name this press was made in - so the hour's own fallback and a
        // person's press are told apart on the lease and in the log.
        setStep("Reading the certificates and updating the matrix");
        const run = await runMatrixRound({ origin: "portal", by: asked ? "Update portal" : "the round on the hour" });
        // Only the account's three lines stay up under the button; any
        // other failure was said in the round's window and ends with it.
        if (run && run.phase === "failed" && [OUT_OF_CREDIT, READING_UNAVAILABLE, KEY_PROBLEM].includes(run.message)) roundStopped = run.message;
      } else {
        setStep("");
      }

      /* The skills matrix, read again on every press.
       *
       * The items on the crew matrix are meant to be the office's list and
       * nothing else, so the list is fetched fresh here rather than trusted
       * from whenever a page last happened to read it. A new skills matrix
       * dropped into the library is noticed on the next press of this button,
       * which is the only moment anybody is watching.
       *
       * It failing is not worth losing the round over - the reading that is
       * already held stands, and the comparison below is simply made against
       * that instead. */
      if (skillsMatrix && skillsMatrix.url) {
        try {
          setStep("Reading the skills matrix");
          const read = await readSkillsMatrix(skillsMatrix, (QUALS.cols || []));
          if (read) setSkillsRequirements(read);
        } catch (e) {
          // The list the portal already holds is what the items are held against.
        }
      }

      /* What the library no longer holds, the portal no longer shows.
       *
       * SharePoint is the store. Everything on these screens was read out of a
       * document in it: the crew matrix is the office's crew qualification
       * workbook, the roster is the roster workbook, the requirements are the
       * skills matrix. Deleting the documents and leaving what was read out of
       * them on the screen is the portal keeping its own copy of something the
       * library has been told to forget - which is the whole of what is wrong
       * with a portal that holds its own store.
       *
       * So each one follows its own document. A document is only off the books
       * when the library answered and the file was not in it, and putting the
       * workbook back reads it all in again, so nothing here is lost that an
       * upload does not bring back.
       */
      /* Asked, not done.
       *
       * This used to empty them where the workbook had gone: the crew matrix,
       * the roster, the requirements. It ran on the hour without anybody
       * pressing anything, and on 22 Sep it fired three times and took
       * forty-three crew and fifty-three items off the matrix while nobody was
       * looking. Whatever the reasoning, a round that tidies up is not allowed
       * to throw away the portal's own record on its own say-so.
       *
       * So it puts it to whoever is there. Say no and the matrix stays exactly
       * as it is, which is the right answer whenever the library is having a
       * bad morning rather than actually having lost the file. */
      const gone = [
        !trainingMatrix && (QUALS.rows || []).length ? "the crew matrix" : null,
        !crewRoster && rosterPlan ? "the roster" : null,
        !skillsMatrix && skillsRequirements ? "the requirements" : null,
      ].filter(Boolean);
      if (gone.length) setOrphaned(gone);

      // The skills matrix has been re-read by now, so the portal's own columns
      // can be held against it and anything that has changed put to whoever
      // pressed the button.
      if (asked) setAsking(true);

      /* The log line is not. An hourly round that found nothing to do while
         the hour's own save had already moved the document on (its stamp is
         newer than the one this round began from) was the fallback running
         behind a server that had done the work, and a line saying so an hour,
         every hour, is noise in the crew's change log. A press of the button
         is always answered.

         The server is asked for the stamp outright rather than trusted to
         the polls: a poll leaves the document alone while this tab has
         changes on their way up, and a round has for most of its length, so
         the hour's newer stamp would seldom have landed here in time. */
      const nothing = !(out.registered && out.registered.length) && !out.returned && !out.mirrored
        && !out.heldBack && !out.followed && !gone.length;
      let stampNow = docStamp.current || "";
      if (!asked && nothing) {
        try {
          const head = await loadState();
          const theirs = head && head.data && head.data.lastDocUpdate;
          if (theirs && String(theirs) > stampNow) stampNow = String(theirs);
        } catch (e) { /* the polls' copy is what there is */ }
      }
      const movedOn = !!stampNow && stampNow > pulled;
      const at = new Date().toISOString();
      /* The stamp is always written, whatever the round found - the clock
         that decides when the next one is due reads it, and a round that
         left it alone would be due again at once. */
      setLastDocUpdate(at);
      if (asked || !(nothing && movedOn)) {
        log("Admin", asked ? "Portal updated" : "Portal updated on the hour",
          [(out.registered ? out.registered.length : 0) + " new certificates taken on",
            out.returned ? out.returned + " written off in error, back on the books" : null,
            out.mirrored ? out.mirrored + " gone from the library and off the books" : null,
            out.heldBack ? out.heldBack + " unaccounted for in one pass — too many to believe, nothing was written off" : null,
            out.followed ? out.followed + " followed to a new folder" : null,
            gone.length ? gone.join(" and ") + " — the workbook has gone, asked what to do" : null,
          ].filter(Boolean).join(" · "));
      }
      if (roundStopped) { setErr(roundStopped); errAt.current = Date.now(); }
      setStep("");
    } catch (e) {
      setErr(e.message || String(e));
      errAt.current = Date.now();
      setStep("");
    }
    going.current = false;
  };

  /* Every hour, where nobody has done it by hand. The check is the clock
     rather than a timer left running, so a portal opened after a week away
     does its round at once instead of an hour later.

     One tab does it. With three admin tabs open, three rounds used to run at
     once, each reading the same certificates and writing the same workbook
     and each saving its own copy of the matrix over the others'. Whichever
     tab gets to it first takes a ten-minute lease in the browser's shared
     storage and renews it while its round runs; the others see the lease
     and leave the round to it. Once the round has saved, lastDocUpdate is
     newer than an hour in every tab and nobody is due. A browser with
     storage blocked runs the round regardless — twice is better than never.

     The worker's hour does the round now, so before any of that the tab
     asks the portal what the hour did (shouldTabRound): the tab is the
     fallback for an hour that did not run, not a second hour. A portal
     that cannot be asked twice running leaves the tab to its own clock, as
     before; one ask that got no answer waits for the next. Only asks the
     tab wanted to round on count as misses (missesInARow): the asks made
     only to see a running hour finish do not, and a tick that does not ask
     at all starts the count again. */
  React.useEffect(() => {
    if (!admin) return undefined;
    const LEASE = VESSEL.slug + "-hourly-lease";
    const LEASE_MS = 10 * 60000;
    const me = thisTab();
    const heldElsewhere = () => {
      try {
        const l = JSON.parse(localStorage.getItem(LEASE) || "null");
        return !!(l && l.tab !== me && l.until > Date.now());
      } catch (e) { return false; }
    };
    const take = () => {
      try { localStorage.setItem(LEASE, JSON.stringify({ tab: me, until: Date.now() + LEASE_MS })); } catch (e) { /* storage blocked: run anyway */ }
    };
    const due = (last, unanswered) => shouldTabRound({ lastDocUpdate, now: Date.now(), pending, online: navigator.onLine, last, unanswered });
    const tick = async () => {
      // The tab's own reasons not to, before the portal is asked anything.
      // Offline is one: the round reads and writes, and a kept /api/sync/last
      // would only say the hour has not run.
      const wants = due(null) && !going.current && !heldElsewhere() && !offlineAt;
      // Asked all the same while the last answer said the hour was running,
      // so the buttons held down for it come back when it stops - and while
      // one of the account's lines is up, so it can come down once an hour
      // reads clean. Any other line is not the hour's to take down, so it
      // is no reason to ask.
      if (!wants && !roundRunning && !accountLine(err)) { unanswered.current = 0; return; }
      let last = null;
      try {
        const r = await fetch("/api/sync/last", { cache: "no-store" });
        if (r.ok) last = await r.json();
      } catch (e) { last = null; }
      // A portal that cannot say holds nothing: the buttons come back.
      setRoundRunning(!!(last && last.running), last && last.holder);
      if (badgeShouldClear(err, errAt.current, last)) setErr("");
      unanswered.current = missesInARow(unanswered.current, wants, last);
      if (!wants || !due(last, unanswered.current) || going.current || heldElsewhere()) return;
      take();
      const renew = setInterval(take, 60000);
      try { await go(false); } finally { clearInterval(renew); }
    };
    const t = setInterval(tick, 5 * 60000);
    const first = setTimeout(tick, 45000);
    return () => { clearInterval(t); clearTimeout(first); };
  }, [admin, lastDocUpdate, pending, roundRunning, err, offlineAt]);

  if (!admin) return null;

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
        <Button variant="solid" writes disabled={!!step} onClick={() => go(true)}>
          {step ? "Updating…" : "Update portal"}
        </Button>
        <span style={{ fontFamily: T.mono, fontSize: 9.5, color: err ? T.bRed : T.muted,
          letterSpacing: "0.04em", textTransform: "uppercase" }}>
          {err ? err.slice(0, 60)
            : step
            || (!(QUALS.cols || []).length ? "No items on the matrix yet" : "Last updated " + stamp(lastDocUpdate))}
        </span>
      </div>

      {/* The workbook behind something the portal holds has gone from the
          library. Asked rather than acted on — see the note where it is
          noticed. */}
      {orphaned && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(22,50,74,0.45)", zIndex: 80,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: T.panel, border: "1px solid " + T.rule, borderTop: "4px solid " + T.bRed,
            borderRadius: 3, padding: "20px 24px", width: "min(600px, 94vw)" }}>
            <Eyebrow color={T.bRed}>A workbook has gone from the library</Eyebrow>
            <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, margin: "10px 0 6px", lineHeight: 1.6 }}>
              The library no longer holds the workbook behind {orphaned.join(", ")}.
            </div>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.muted, marginBottom: 15, lineHeight: 1.6 }}>
              Nothing has been emptied. Emptying {orphaned.length === 1 ? "it" : "them"} cannot be undone from
              here — the dates come back only by putting the workbook back and reading it in again. If the
              file was moved or the library was slow to answer, leave it alone.
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Button variant="quiet" onClick={() => setOrphaned(null)}>Leave it as it is</Button>
              <Button writes variant="solid" onClick={() => {
                if (orphaned.includes("the crew matrix")) {
                  setQuals({ cols: [], rows: [] });
                  setCertAnalysis(null);
                  setMatrixAnalysis(null);
                }
                if (orphaned.includes("the roster")) setRosterPlan(null);
                if (orphaned.includes("the requirements")) setSkillsRequirements(null);
                log("Admin", "Emptied what the library no longer holds",
                  orphaned.join(", ") + " — put the workbook back and it is read in again");
                setOrphaned(null);
              }}>Empty {orphaned.join(", ")}</Button>
            </div>
          </div>
        </div>
      )}

      {found && <SyncPeople found={found} onClose={() => setFound(null)} />}
      {asking && <MatrixItems onClose={() => setAsking(false)} />}
    </>
  );
}

/* The choices for what paper a document is: the certificate itself, or one
   of the five that stand in for one (source/shared/evidence.js), named and
   nothing more. */
function paperChoices() {
  return [{ value: "", label: "Certificate" },
    ...EVIDENCE_KINDS.map((k) => ({ value: k, label: EVIDENCE_LABELS[k] || k }))];
}

/* What the phone's panel says when the reading after an upload failed.
   The file is on the books either way. A failure about the model's
   account - no credit, the rate, a busy model, the key - is nothing the
   crew member can act on and nothing wrong with the photo: the hour reads
   it once the account is in order, and that is all the panel says. Any
   other failure is said as it came. `kind` is read-one's word for it. */
function crewUploadNote(kind, message) {
  if (kind === "credit" || kind === "key" || kind === "rate" || kind === "busy") {
    return { phase: "Uploaded — will be read on the hour", note: "" };
  }
  return { phase: "Uploaded — not renamed", note: message || "" };
}

/* Upload Crew Certificates — the crew's own door. A name and a drop, and the
   file is filed into the company SharePoint under them, read, converted to
   PDF and named the way OPMS wants it; the window then hands the finished
   file back to save and upload to OPMS. */
function CrewCertificateUpload() {
  const { quals: QUALS, people } = usePortal();
  const names = useMemo(() => QUALS.rows.map((r) => r[0]), [QUALS]);
  /* Whose certificate this is, taken from who is signed in.
   *
   * A crew member reached this page with his own email, so there is nothing to
   * ask him: it is his certificate. It used to be a box he typed his name into,
   * seeded from his login and editable, so a certificate could be filed against
   * a man who was not the one uploading it - by a slip, or by somebody helping
   * a mate out - and nothing downstream could tell.
   *
   * The name is read through the crew register, so however the login spells him
   * he reaches the one name the portal knows him by. */
  const [typed, setTyped] = useState(SESSION_USER.name || "");
  const filedAs = useMemo(() => {
    const reg = crewRegister(people);
    const mine = reg.nameOf(SESSION_USER.name) || reg.nameOf(typed);
    if (mine) return mine;
    const c = canonicalName(typed);
    return c ? (matchRoster(c, names) || c) : "";
  }, [typed, names, people]);
  const [jobs, setJobs] = useState([]);
  const [open, setOpen] = useState(false);
  const [hot, setHot] = useState(false);
  const [nameErr, setNameErr] = useState("");
  const fileRef = useRef(null);
  const camRef = useRef(null);
  const [shots, setShots] = useState([]);
  const [retake, setRetake] = useState("");
  const patchJob = (key, p) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...p } : j)));

  /* A photo straight off the phone: turned the right way up, brought down to
     a size that uploads quickly, re-saved as a JPEG, and measured for
     sharpness so a blurred shot is caught before it goes anywhere. */
  const takeIn = async (file) => {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const small = document.createElement("canvas");
    const sw = 400, sh = Math.max(1, Math.round(canvas.height * (400 / canvas.width)));
    small.width = sw; small.height = sh;
    small.getContext("2d").drawImage(canvas, 0, 0, sw, sh);
    const px = small.getContext("2d").getImageData(0, 0, sw, sh).data;
    const g = new Float32Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) {
      const i = y * sw + x;
      const v = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - sw] - g[i + sw];
      sum += v; sum2 += v * v; n++;
    }
    const sharpness = n ? sum2 / n - (sum / n) * (sum / n) : 0;
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.86));
    return { key: Date.now() + "-" + Math.random().toString(36).slice(2, 7), blob, preview: URL.createObjectURL(blob),
      blurry: sharpness < 30 };
  };

  const addShots = async (files) => {
    const list = [...files].filter((f) => f && f.size > 0);
    if (!list.length) return;
    setRetake("");
    const taken = [];
    for (const f of list) {
      try { taken.push(await takeIn(f)); } catch (e) { setRetake("That photo couldn't be opened. Take it again."); }
    }
    setShots((s) => [...s, ...taken]);
  };
  const dropShot = (key) => setShots((s) => s.filter((x) => x.key !== key));
  const clearShots = () => { shots.forEach((s) => URL.revokeObjectURL(s.preview)); setShots([]); };

  const uploadOne = (file, key) => new Promise((resolve) => {
    const fd = new FormData();
    if (Array.isArray(file)) {
      file.forEach((s, i) => fd.append("page", s.blob, `page-${i + 1}.jpg`));
      fd.append("pagesName", `${filedAs} - certificate photo`);
    } else {
      fd.append("file", file);
    }
    fd.append("category", "certificate");
    fd.append("person", filedAs);
    fd.append("uploadedBy", SESSION_USER.name || filedAs);
    fd.append("onDuplicate", "skip");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) patchJob(key, { pct: Math.round((e.loaded / e.total) * 45), phase: "Uploading to SharePoint" });
    };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText || "{}"); } catch (e) {}
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => resolve({ status: 0, body: {} });
    xhr.send(fd);
  });

  const run = async (files, fromCamera) => {
    if (!filedAs) { setNameErr("Type your name first."); return; }
    setNameErr("");
    const list = fromCamera ? [files] : [...files].filter((f) => f && f.size > 0);
    if (!list.length) return;
    const start = list.map((f, i) => ({ key: Date.now() + "-" + i,
      name: fromCamera ? `Photo · ${f.length} page${f.length === 1 ? "" : "s"}` : f.name, pct: 0, phase: "Waiting", done: false }));
    setJobs(start); setOpen(true);
    for (let i = 0; i < list.length; i++) {
      const key = start[i].key;
      const up = await uploadOne(list[i], key);
      if (up.status === 200 && up.body.skipped) {
        patchJob(key, { pct: 100, phase: "Already on file", done: true });
        continue;
      }
      if (up.status < 200 || up.status >= 300 || !up.body.record) {
        patchJob(key, { pct: 100, phase: "Failed", done: true, note: up.body.error || `Upload failed (${up.status || "no connection"})` });
        continue;
      }
      const rec = up.body.record;
      if (fromCamera) clearShots();
      patchJob(key, { pct: 50, phase: "Converting and reading the certificate" });
      let creep = 50;
      const timer = setInterval(() => { creep = Math.min(90, creep + 1); patchJob(key, { pct: creep }); }, 700);
      try {
        const r = await fetch("/api/certificates/read-one", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: rec.id, discardUnreadable: !!fromCamera }) });
        const out = await r.json();
        if (!r.ok) {
          clearInterval(timer);
          patchJob(key, { pct: 100, done: true, filename: rec.filename, url: rec.url,
            ...crewUploadNote(out.kind, out.error || `Reading failed (${r.status})`) });
          continue;
        }
        clearInterval(timer);
        if (out.discarded) {
          patchJob(key, { pct: 100, phase: "Not clear — take the photo again", done: true, failed: true, note: out.reason || "" });
          setRetake("The photo wasn't clear enough to read. Take it again.");
          continue;
        }
        patchJob(key, { pct: 100, phase: "Done", done: true, filename: out.filename, url: out.url, code: out.code,
          // The reader's warning where it thinks the file was put in the wrong
          // column (tagWarning) comes before anything else the row could say.
          warn: !!out.warning,
          note: out.warning || (out.readable ? (out.code ? "" : "Certificate type not identified — name kept as uploaded.") : (out.reason || "Couldn't be read.")) });
      } catch (e) {
        clearInterval(timer);
        patchJob(key, { pct: 100, phase: "Uploaded — not renamed", done: true, filename: rec.filename, url: rec.url, note: String(e.message || e) });
      }
    }
  };

  const save = async (j) => {
    const r = await fetch(j.url);
    if (!r.ok) throw new Error("The file couldn't be fetched (" + r.status + ").");
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = j.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  const allDone = jobs.length > 0 && jobs.every((j) => j.done);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <SectionHead title="Upload Crew Certificates" />
        <a className="um-btn" href={VESSEL.links.opms} target="_blank" rel="noreferrer"
          style={{ background: T.accent, color: "#fff", border: `1px solid ${T.accent}`, fontSize: 11, fontWeight: 700,
            padding: "8px 13px", borderRadius: 2, textDecoration: "none", letterSpacing: "0.06em" }}>
          OPEN OPMS
        </a>
      </div>

      {/* Who it is filed against. A crew member signed in with his own email
          is not asked — it is his certificate. Management, and anyone the
          register does not recognise, still says who. */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
        {crewRegister(people).nameOf(SESSION_USER.name) ? (
          <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.text }}>
            Filed against <b>{filedAs}</b>
          </div>
        ) : (
          <>
            <div style={{ flex: "1 1 260px" }}>
              <Field label="Your name">
                <input className="um-in" value={typed} placeholder="First name and surname"
                  onChange={(e) => setTyped(e.target.value)} />
              </Field>
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 11.5, color: filedAs ? T.text : T.muted, paddingBottom: 9 }}>
              {filedAs ? `Filed as ${filedAs}` : ""}
            </div>
          </>
        )}
      </div>
      {nameErr && <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.bRed, marginBottom: 10 }}>{nameErr}</div>}

      <input ref={fileRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/*" style={{ display: "none" }}
        onChange={(e) => { run(e.target.files); if (fileRef.current) fileRef.current.value = ""; }} />
      <input ref={camRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
        onChange={(e) => { addShots(e.target.files); if (camRef.current) camRef.current.value = ""; }} />

      <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderRadius: 3, padding: "14px 16px", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <Button writes onClick={() => camRef.current && camRef.current.click()}>
            {shots.length ? "Take the next page" : "Take a photo"}
          </Button>
          {shots.length > 0 && !shots.some((s) => s.blurry) && (
            <Button variant="ghost" writes onClick={() => run(shots, true)}>
              Upload {shots.length} page{shots.length === 1 ? "" : "s"} as one certificate
            </Button>
          )}
          {shots.length > 0 && <Button variant="quiet" onClick={clearShots}>Discard photos</Button>}
        </div>
        {retake && <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.bRed, marginTop: 10 }}>{retake}</div>}
        {shots.length > 0 && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
            {shots.map((s, i) => (
              <div key={s.key} style={{ width: 96 }}>
                <div className="um-shot" style={{ outline: s.blurry ? `3px solid ${T.bRed}` : "none" }}>
                  <img src={s.preview} alt="" />
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 10.5, color: s.blurry ? T.bRed : T.muted, marginTop: 4, textAlign: "center" }}>
                  {s.blurry ? "Not clear — retake" : `Page ${i + 1}`}
                </div>
                <div style={{ textAlign: "center", marginTop: 2 }}>
                  <a style={{ fontFamily: T.body, fontSize: 11.5, color: T.accent, cursor: "pointer" }} onClick={() => dropShot(s.key)}>Remove</a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="um-drop"
        onDragOver={(e) => { e.preventDefault(); setHot(true); }}
        onDragLeave={() => setHot(false)}
        onDrop={(e) => { e.preventDefault(); setHot(false); run(e.dataTransfer.files); }}
        onClick={() => fileRef.current && fileRef.current.click()}
        style={{ border: `2px dashed ${hot ? T.accent : T.rule}`, borderRadius: 3, background: hot ? T.raised : T.panel,
          padding: "34px 16px", textAlign: "center", cursor: "pointer", marginBottom: 18 }}>
        <div className="um-cue" style={{ fontFamily: T.display, fontSize: 14, fontWeight: 700, color: T.text, letterSpacing: "0.04em" }}>
          Drop certificates here
        </div>
        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 6 }}>or press to choose files · PDF or photo · 5 MB each</div>
      </div>

      {open && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(22,50,74,0.45)", zIndex: 60,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderTop: `4px solid ${T.accent}`,
            borderRadius: 3, padding: "22px 26px", width: "min(600px, 94vw)", maxHeight: "84vh", overflowY: "auto" }}>
            <Eyebrow color={T.accent}>{allDone ? "Finished" : "Uploading"}</Eyebrow>
            {jobs.map((j) => (
              <div key={j.key} style={{ padding: "12px 0", borderBottom: `1px solid ${T.rule}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <span style={{ fontFamily: T.body, fontSize: 13.5, fontWeight: 600, color: T.text, minWidth: 0,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.filename || j.name}</span>
                  <span style={{ fontFamily: T.display, fontSize: 22, fontWeight: 700, color: T.text }}>{j.pct}%</span>
                </div>
                <div style={{ height: 7, background: T.raised, borderRadius: 4, overflow: "hidden", margin: "8px 0 6px" }}>
                  <div style={{ height: "100%", width: `${j.pct}%`, background: j.failed || (j.note && j.phase === "Failed") ? T.bRed : T.accent,
                    transition: "width .4s" }} />
                </div>
                <div style={{ fontFamily: T.body, fontSize: 12.5, color: j.warn ? T.bOrange : T.muted }}>{j.phase}{j.note ? ` · ${j.note}` : ""}</div>
                {j.done && j.url && (
                  <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
                    <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>Save this document for upload to OPMS</span>
                    <Button onClick={() => save(j)}>Save to this device</Button>
                  </div>
                )}
              </div>
            ))}
            {allDone && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 14 }}>
                <span style={{ fontFamily: T.body, fontSize: 14, fontWeight: 700, color: T.teal }}>Upload successfully completed</span>
                <Button variant="quiet" onClick={() => { setOpen(false); setJobs([]); }}>Close</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
