/* Certificate cells — the certificate vocabulary the Crew Matrix, the Roster
 * and the Admin tabs share: the bands and their colours, the tickets, the
 * skills matrix read, the dates and links for a cell, the viewer and the
 * Update matrix button.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state; this
 * holds what the big pages share. See tools/source.mjs.
 */

/* ==================================================================== */
/*  Training matrix                                                      */
/* ==================================================================== */

/* Days from today to a date, by the one count the worker's reminder emails
   use too (daysUntil, source/shared/bands.js). */
function daysTo(iso) {
  return daysUntil(iso, TODAY);
}

/* How long a certificate has left, in three bands. Everything that shows a
   certificate's standing - the matrix, the reports, a person's own page -
   reads the bands from here, so the colours cannot come to mean different
   things on different pages. The two numbers, RED_DAYS and AMBER_DAYS, are
   written down once in source/shared/bands.js, where the worker's weekly
   reminder emails read the same red band. */

// Expired or within RED_DAYS red, to AMBER_DAYS orange, beyond that green.
function bandFor(v) {
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const t = v.toUpperCase();
    if (t === "Y") return { key: "held", fg: T.green, bg: T.bGreenBg, text: "Held" };
    if (t === "N") return { key: "not", fg: T.bRed, bg: T.bRedBg, text: "Not held" };
    // The office marks a module still to be done as "open" (red, in the
    // spreadsheet) rather than "N". Same meaning, same treatment - it counts
    // as not done on the E-Learning Status page instead of unconfirmed, and
    // keeps the office's own word on the tag.
    if (t === "OPEN") return { key: "not", fg: T.bRed, bg: T.bRedBg, text: "Open" };
    return { key: "unknown", fg: T.muted, bg: T.raised, text: "?" };
  }
  const d = daysTo(v);
  if (d <= RED_DAYS) return { key: "red", fg: T.bRed, bg: T.bRedBg, days: d, date: v };
  if (d <= AMBER_DAYS) return { key: "orange", fg: T.bOrange, bg: T.bOrangeBg, days: d, date: v };
  return { key: "green", fg: T.bGreen, bg: T.bGreenBg, days: d, date: v };
}

function Cell({ value, onOpen, missing, cover, flag, two }) {
  const b = bandWithCover(bandFor(value), cover, missing);
  // Two on file: a small 2 before the date, the two names on the title.
  const twoMark = two ? <span title={twoLine(two)} style={{ fontSize: 8, fontWeight: 700, marginRight: 3, verticalAlign: "top" }}>{two.length + 1}</span> : null;
  /* A document filed for this cell that reads as something else, with no
     date in the cell to show: the cell says Check, in orange, and opens
     the document (certFlagFor). Filled, the cell keeps its date and wears
     an orange edge, the sentence on its title. */
  if (!b && flag) return (
    <div title={flagLine(flag)} onClick={onOpen}
      style={{ background: T.bOrangeBg, color: T.bOrange, border: `1px solid ${T.bOrange}`, borderRadius: 2,
        padding: "2px 3px", minWidth: 56, fontFamily: T.mono, fontSize: 9.5, fontWeight: 700,
        lineHeight: 1.25, cursor: onOpen ? "pointer" : undefined }}>
      Check
    </div>
  );
  if (!b && missing) return (
    <div title="Required for this position — nothing on file" style={{
      background: T.bRedBg, color: T.bRed, border: `1px solid ${T.bRed}`, borderRadius: 2,
      padding: "2px 3px", minWidth: 56, fontFamily: T.mono, fontSize: 9.5, fontWeight: 700,
      lineHeight: 1.25 }}>
      Missing
    </div>
  );
  if (!b) return (
    <div title="Not required for this position" style={{
      minWidth: 56, height: 15, borderRadius: 2, border: `1px solid ${T.hatchLine}`,
      backgroundImage: `repeating-linear-gradient(45deg, ${T.hatchLine} 0 1.5px, ${T.hatchBg} 1.5px 5px)`,
    }} />
  );
  const openable = !!onOpen;
  const edge = flag ? { boxShadow: `0 0 0 2px ${T.bOrange}` } : null;
  if (b.date) {
    return (
      <div title={(flag ? flagLine(flag) + " · " : "") + (b.key === "covered"
        ? b.text
        : `${b.date} - ${b.days < 0 ? Math.abs(b.days) + " days ago" : "in " + b.days + " days"}${openable ? " · open the certificate" : ""}`)}
        onClick={openable ? onOpen : undefined}
        style={{ background: b.bg, color: b.fg, borderRadius: 2, padding: "2px 3px", minWidth: 56,
          fontFamily: T.mono, fontSize: 9.5, fontWeight: 600, lineHeight: 1.25,
          cursor: openable ? "pointer" : undefined, ...edge,
          textDecoration: openable ? "underline" : undefined, textUnderlineOffset: 2 }}>
        {twoMark}{b.date.slice(8, 10)}/{b.date.slice(5, 7)}/{b.date.slice(2, 4)}
      </div>
    );
  }
  /* With no date to show - a blank cell an issue letter carries, or an "N" -
     the cell carries one word and the sentence is on the title: a 56-pixel
     matrix cell is no place for "covered by issue-letter". */
  return (
    <div onClick={openable ? onOpen : undefined}
      title={[flag ? flagLine(flag) : "", b.key === "covered" ? b.text : ""].filter(Boolean).join(" · ") || undefined}
      style={{ background: b.bg, color: b.fg, borderRadius: 2, padding: "3px", minWidth: 56,
        fontFamily: T.mono, fontSize: 9.5, lineHeight: 1.25, ...edge,
        cursor: openable ? "pointer" : undefined }}>{twoMark}{b.key === "covered" ? "Covered" : b.text}</div>
  );
}

/* ---- the position somebody works in, against the ticket they hold -------- */
/* Crew don't always work in the position their certificate of competency is
   for. A Master's ticket sails a swing as Chief Officer to cover a rotation, an
   Assistant Engineer holds an Engineer Class 2, a GPH holds a Master <45m. None
   of that is wrong — it is how a two-crew rotation gets filled — but the matrix
   hides it, because every hatched cell on the grid means "not required for this
   position" and the position is the only thing that is worked out from. Read
   against a position that isn't the one the person is ticketed for, somebody's
   requirements are the wrong set, and nothing on the grid says so.

   So the two are held against each other and the difference is put on the
   table in a colour of its own. Nothing is decided here and nothing is marked
   wrong: whether a person may fill a position is the office's call, on the
   vessel's manning approval. This only says the two don't line up, and which
   way. */

/* Every certificate of competency the matrix carries, on one ladder.
   The grade is the size of job the ticket covers — 1 a rating, 6 unlimited
   command or chief engineer — so a ticket and a position can be compared. The
   stream is the department it belongs to: a deck ticket says nothing about
   whether somebody can stand an engine room watch.
   The ladder is the vessel file's. A rating's ticket covers both sides of
   the vessel - Able Seafarer Deck and Able Seafarer Engineer are the one
   certificate - so its stream is "both" and it counts either way. */
const TICKETS = VESSEL.tickets;

/* What each position is normally held against: the department it sits in, the
   lowest ticket that covers the job, and the highest the job is ordinarily
   filled by. Positions are spelled by whoever typed the spreadsheet, so they
   are matched loosely and the first line that matches settles it - which is why
   "Chief Officer - 100m" is asked before the general Chief Officer line, and
   why Chief Engineer is asked before Assistant Engineer's catch-all. */
const POSITION_TICKET = [
  [/^\s*master/i, { stream: "deck", min: 6, upto: 6, expects: "a Master's ticket" }],
  [/chief\s*(officer|mate).*unlimited/i,
    { stream: "deck", min: 5, upto: 5, expects: "Chief Mate or a Master's ticket" }],
  [/chief\s*(officer|mate)/i,
    { stream: "deck", min: 4, upto: 5, expects: "Master <100m NC or Chief Mate" }],
  [/(second|third)\s*(mate|officer)/i,
    { stream: "deck", min: 3, upto: 4, expects: "Master <45m NC or Master <100m NC" }],
  [/chief\s*engineer/i, { stream: "engine", min: 6, upto: 6, expects: "Engineer Class 1" }],
  [/(first|second)\s*engineer/i, { stream: "engine", min: 5, upto: 5, expects: "Engineer Class 2" }],
  [/engineer|engine\s*driver/i,
    { stream: "engine", min: 2, upto: 3, expects: "Marine Engine Driver 2 or Engineer Class 3 NC" }],
  [/\b(gph|general\s*purpose|integrated\s*rating|deck\s*hand|deckhand|able\s*seafarer)\b/i,
    { stream: "deck", min: 1, upto: 2, expects: "an Integrated Rating ticket" }],
  [/\b(cook|chef|caterer|steward)\b/i, { stream: "catering", min: 1, upto: 1, expects: "Marine Cook" }],
];

// How a department reads in a sentence.
const STREAM_WORD = { deck: "deck", engine: "engine room", catering: "catering", both: "rating's" };

/**
 * Where somebody's ticket sits against the position they work in.
 *
 * Nothing comes back when the two line up, or when the position isn't one the
 * portal holds an expectation for - there is nothing to say and nothing to
 * colour. Otherwise it says which way they differ:
 *
 *   strong  - the tickets on the matrix don't reach the position, or the only
 *             ones on it belong to another department. Somebody is filling a job
 *             their certificate doesn't cover, which is the one worth a look.
 *   quiet   - they hold a ticket for a bigger job than the one they are in. Not
 *             a problem in itself, but the matrix reads their requirements off
 *             the position, so the higher ticket's items are never asked of
 *             them - and it is worth knowing who can step up when a swing is
 *             short.
 *
 * A ticket counts as held when its cell holds anything other than "N". Whether
 * it is still in date is the expiry bands' business, not this one - the band
 * comes back with each ticket so the panel can show it either way. A "?" is
 * carried through too, so what isn't confirmed can be said out loud.
 */
function ticketStandingFor(row, QUALS) {
  // A matrix filed with its competency columns coded some other way carries no
  // ticket this can read, and every name on it would come back "no ticket" -
  // a page of violet saying nothing. Where the sheet has no ticket column at
  // all, it isn't a matrix that records tickets and there is nothing to say.
  if (!QUALS.cols.some((c) => TICKETS[c[0]])) return null;

  const hit = POSITION_TICKET.find(([re]) => re.test(row[1] || ""));
  if (!hit) return null;
  const want = hit[1];
  const position = row[1];

  const held = QUALS.cols
    .map((c, i) => ({ code: c[0], title: c[1], value: row[3][i] }))
    .filter((x) => TICKETS[x.code] && x.value && String(x.value).trim().toUpperCase() !== "N")
    .map((x) => ({ ...x, ...TICKETS[x.code], band: bandFor(x.value),
      unconfirmed: String(x.value).trim() === "?" }))
    .sort((a, b) => b.grade - a.grade);

  // Only the tickets that count for the department the position sits in.
  const mine = held.filter((x) => x.stream === want.stream || x.stream === "both");
  const top = mine.length ? mine[0].grade : 0;
  const base = { position, expects: want.expects, held, mine };
  const list = (xs) => xs.map((x) => x.short).join(", ");

  if (held.length === 0) return {
    ...base, way: "none", strong: true, label: "No ticket on the matrix",
    note: `Works as ${position}. No certificate of competency is recorded against this name -`
      + ` the position is normally held against ${want.expects}.`,
  };

  if (mine.length === 0) return {
    ...base, way: "aside", strong: true, label: "Ticket is another department's",
    note: `Works as ${position}, ${STREAM_WORD[want.stream]} side, and holds ${list(held)} -`
      + ` no ${STREAM_WORD[want.stream]} ticket. The position is normally held against ${want.expects}.`,
  };

  if (top < want.min) return {
    ...base, way: "above", strong: true, label: "Working above the ticket held",
    note: `Works as ${position} and holds ${list(mine)}. The position is normally held against`
      + ` ${want.expects}, so this is a bigger job than the ticket covers.`,
  };

  /* A bigger ticket than the job asks for is not a finding and is not marked.
     A Master standing a Chief Officer's watch is ordinary, allowed, and none
     of the matrix's business: it asks that person for the Chief Officer's
     items, which is right, and the rest of what the ticket carries is not
     tracked here because nothing on this vessel needs it to be. Marking it
     put seven names in violet for a state of affairs nobody has to do anything
     about, which is how a colour that ought to mean "look at this" comes to
     mean nothing at all.

     Working ABOVE the ticket held is still marked, and still strongly. That
     one is not allowed, and a page that stayed quiet about it would be worse
     than no page. */
  return null;
}

// Reads the crew qualification workbook in the browser. SheetJS is fetched on
// demand rather than loaded on every visit.
/* The Equivalence page of the skills matrix, taken as a table the server
   keeps: each certificate that is not itself a matrix item, against the most
   senior column the office accepts it for. Read fresh on every update run,
   so a newer sheet takes effect the next press. Column B of the page is the
   item not held; column C is the certificate accepted in its place. */
/* The skills matrix's own sheet, read as a table: each position against the
   items marked M — plain Mandatory. An M with a footnote, "mandatory if
   applicable" and Recommended are left out, so nothing is called missing
   that the office hasn't demanded outright. */
/* The Guidance Information sheet of a skills matrix as a grid of text, for
   readExpiryRules — or no rows at all where the workbook has no such sheet. */
function guidanceRows(XLSX, wb) {
  const name = wb.SheetNames.find((n) => /guidance information/i.test(n));
  if (!name) return [];
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
}

/**
 * The skills matrix read through: what each position must hold, which items
 * the office tracks, how long each one lasts, and what stands in for what.
 *
 * It used to be read from an effect on the crew matrix page, which meant a new
 * skills matrix went unnoticed until somebody happened to open that page. The
 * round reads it on every press now, so the items are held against the office's
 * own list at the moment the button is pushed rather than whenever a screen was
 * last visited.
 */
async function readSkillsMatrix(record, cols) {
  if (!record || !record.url) return null;
  const XLSX = await loadXLSX();
  const resp = await fetch(record.url);
  if (!resp.ok) throw new Error(`The skills matrix couldn't be downloaded (${resp.status}).`);
  const wb = XLSX.read(await resp.arrayBuffer(), { type: "array" });
  const read = skillsRequirementsFrom(XLSX, wb);
  const positions = (read && read.positions) || null;
  const items = (read && read.items) || [];
  const periods = (read && read.periods) || [];
  const covers = coversFrom(XLSX, wb, cols || []);
  if (!positions && !covers.length && !items.length) return null;
  return { at: todayISO(), from: record.id || "", positions: positions || [], items, periods, covers };
}

function skillsRequirementsFrom(XLSX, wb) {
  const name = wb.SheetNames.find((n) => /skills matrix/i.test(n)) || wb.SheetNames.find((n) => /matrix/i.test(n));
  if (!name) return null;
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
  // The row of item codes: the one carrying the most cells that read like one.
  let codesAt = -1, best = 0;
  grid.slice(0, 20).forEach((r, i) => {
    const n = r.filter((c) => /^[A-Za-z]{2,4}-\d+/.test(String(c).trim())).length;
    if (n > best) { best = n; codesAt = i; }
  });
  if (codesAt < 0 || best < 3) return null;
  const codes = grid[codesAt].map((c) => String(c).trim().toUpperCase());

  /* Every item the sheet names, with the title printed under it - the office's
     own list of what this vessel tracks. The portal's matrix columns are held
     against this: an item the office has dropped is one the portal is still
     asking for, and one it has added is one the portal has never heard of. */
  const under = grid[codesAt + 1] || [];
  const items = [];
  codes.forEach((code, i) => {
    if (!/^[A-Z]{2,4}-\d+/.test(code) || items.some((x) => x.code === code)) return;
    items.push({ code, title: String(under[i] || "").replace(/\s+/g, " ").trim() || code });
  });

  /* How long each item lasts once it is done, off the office's own Guidance
   * Information sheet.
   *
   * This is the rule book, and it had never been read. The portal used to ship
   * the whole workbook to the model and ask it to find the periods; the sheet
   * holding them is ninety thousand characters on its own and the text was cut
   * off at sixty, so the model never saw most of the table and the portal ran
   * with no periods at all. A certificate that prints an issue date but no
   * expiry - which is every customer induction, every cargo system module, eight
   * hundred and twenty-four of them - could not be dated, so those columns
   * could only ever be filled from the crew qualification spreadsheet.
   *
   * It is read straight off the columns now: Certification ID against Expiry.
   * No model, nothing to truncate, and the office's own words kept against
   * each one so anybody can see what the portal made of them.
   */
  const periods = readExpiryRules(guidanceRows(XLSX, wb));

  const positions = [];
  for (const r of grid.slice(codesAt + 1)) {
    const position = String(r[0] || "").replace(/\s+/g, " ").trim();
    if (!position) continue;
    const need = [];
    r.forEach((cell, i) => {
      if (String(cell).trim() === "M" && codes[i] && /^[A-Z]{2,4}-\d+/.test(codes[i])) need.push(codes[i]);
    });
    if (need.length) positions.push({ position, need });
  }
  return positions.length || items.length || periods.length ? { positions, items, periods } : null;
}

/* Which of those positions a crew member's own position answers to, and what
   it must hold. The sheet's site prefix and berth letters are set aside, so
   "<site code> Chief Officer (A)" answers to "Chief Officer - Unlimited" —
   and where a rank has two berths, only what every berth demands is asked,
   so nobody is marked missing the other berth's ticket. */
const REQ_SYNONYM = { chef: "cook", chefs: "cook", cooks: "cook" };
function reqTokens(s) {
  const site = SHIFT_MATRIX_VESSEL.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return String(s || "").toLowerCase().normalize("NFKD").split(/[^a-z0-9]+/)
    .map((w) => REQ_SYNONYM[w] || (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .filter((w) => w.length > 1 && !site.includes(w));
}
function requiredCodesFor(position, skillsRequirements) {
  const out = new Set();
  const table = skillsRequirements && Array.isArray(skillsRequirements.positions) ? skillsRequirements.positions : [];
  if (!table.length) return out;
  /* The same seat under either spelling. The office's sheet writes
     "Second Mate" and "Assistant Engineer" under its site code; the
     register writes "SECOND OFFICER" and "JUNIOR ENGINEER"; word for word
     they never met, and a second officer read as needing nothing - his
     empty cells hatched, never Missing (26 Sep 2026). The vessel file's rank groups
     (rankGroupAt) know both spellings of every seat, so the sheet's rows in
     the position's group are its rows; the words decide only where the
     groups place neither. */
  const group = rankGroupAt(position);
  let hits = group < RANK_GROUPS.length ? table.filter((p) => rankGroupAt(p.position) === group) : [];
  if (!hits.length) {
    const crew = new Set(reqTokens(position));
    if (!crew.size) return out;
    hits = table.filter((p) => {
      const words = reqTokens(p.position);
      return words.length && words.every((w) => crew.has(w));
    });
  }
  if (!hits.length) return out;
  let both = null;
  for (const h of hits) {
    const s = new Set(h.need);
    both = both === null ? s : new Set([...both].filter((c) => s.has(c)));
  }
  (both || []).forEach((c) => out.add(c));
  return out;
}

/* The rules on the equivalence page that say one matrix column answers for
   another - "if you do not hold QL-15, QL-14 is accepted". Read in one place,
   because two different parts of the portal need them and one of them used to
   rebuild the requirements without them and quietly wipe them out. */
function coversFrom(XLSX, wb, cols) {
  const sheetName = wb.SheetNames.find((n) => /equivalen/i.test(n));
  if (!sheetName) return [];
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" });
  const colCodes = new Set(cols.map((c) => String(c[0]).trim().toUpperCase()));
  const part = (cell) => {
    const m = String(cell || "").replace(/\s+/g, " ").trim().match(/^([A-Za-z]{2,4}-\d+[A-Za-z]?)\s+(.+)$/);
    return m ? { code: m[1].toUpperCase(), title: m[2].trim() } : null;
  };
  const out = [];
  const pairs = new Set();
  const add = (need, met) => {
    const key = need + "<" + met;
    if (need === met || pairs.has(key)) return;
    pairs.add(key);
    out.push({ need, met });
  };

  /* One column accepted in place of another, said outright: "if you do not
     hold QL-15, QL-14 is accepted". */
  for (const r of grid) {
    const wanted = part(r[1]);
    const held = part(r[2]);
    if (!wanted || !held) continue;
    if (!colCodes.has(wanted.code) || !colCodes.has(held.code)) continue;
    add(wanted.code, held.code);
  }

  /* And the same thing said the long way round. A named ticket is often
     accepted for more than one column - an Engineer Watchkeeper (Motor)
     answers for the engineer's ticket AND for safety training, because the
     one certificate covers both. The portal files that certificate under the
     first column the sheet names, which is the senior one, and the others
     were left looking empty: the crew member was told he was missing a
     certificate the office had already said he did not need.
     Where a ticket is accepted for several columns, holding the one it is
     filed under answers for the rest. */
  const spread = new Map();
  for (const r of grid) {
    const wanted = part(r[1]);
    const held = part(r[2]);
    if (!wanted || !held) continue;
    if (!colCodes.has(wanted.code) || colCodes.has(held.code)) continue;
    if (!spread.has(held.code)) spread.set(held.code, []);
    const list = spread.get(held.code);
    if (!list.includes(wanted.code)) list.push(wanted.code);
  }
  spread.forEach((list) => {
    if (list.length < 2) return;
    const filed = list[0];                 // where the portal puts it
    list.slice(1).forEach((other) => add(other, filed));
  });

  return out;
}

// Every item for one person that isn't blank, soonest first.

function itemsFor(row, QUALS) {
  return QUALS.cols
    .map((c, i) => ({ code: c[0], title: c[1], group: c[2], value: row[3][i], band: bandFor(row[3][i]) }))
    .filter((x) => x.band)
    .sort((a, b) => {
      const ad = a.band.date ? daysTo(a.band.date) : 9e5;
      const bd = b.band.date ? daysTo(b.band.date) : 9e5;
      return ad - bd;
    });
}

// How a band reads as a short status - on screen and on the printed page.
function bandLabel(band) {
  // A covered cell says what carries it, not how long ago the certificate went.
  if (band.key === "covered") return band.text;
  if (!band.date) return band.text;
  const d = daysTo(band.date);
  // Nought days left is a certificate that has gone, not one with a day in
  // it: the printed day is the day it stops counting (MO70 s 5(a)(iii)).
  if (d === 0) return "Expired today";
  return d < 0 ? `Expired ${Math.abs(d)} days ago` : `${d} days`;
}

function BandTag({ band }) {
  return (
    <span style={{ background: band.bg, color: band.fg, fontFamily: T.mono, fontSize: 10.5,
      fontWeight: 600, padding: "3px 7px", borderRadius: 2, whiteSpace: "nowrap" }}>{bandLabel(band)}</span>
  );
}

/* ---- the issue date and expiry date columns ------------------------------ */
/* The certification screens carry two date columns per item. The expiry is
   what the matrix cell itself holds; the issue date only exists on the
   certificates, so it comes from the readings the portal keeps of every scan
   on file — fetched once, shared, and refreshed by Update matrix. */

const colDate = (iso) =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(String(iso)) ? String(iso).slice(0, 10).split("-").reverse().join("/") : "—";

// The dates held for one person and matrix code, out of the shared store.
const certDateFor = (dates, person, code) => {
  const d =
    (dates && dates.map &&
      dates.map[`${String(person || "").trim().toUpperCase()}::${String(code || "").trim().toUpperCase()}`]) || null;
  // An item that never lapses keeps its issue date but hands back no expiry,
  // whatever an old reading wrote down.
  if (d && d.expires != null && noExpiryPeriod(code)) return { ...d, expires: null };
  return d;
};

// The certificate behind one line, as a link. First choice is the scan the
// last Update matrix run settled the dates from; where that run predates the
// link being kept (or hasn't run yet), the scan filed under that person with
// that code picked at upload answers instead.
/* The paper that lawfully carries one person's column while the certificate
   itself is out - an AMSA extension letter, a near-coastal renewal lodged
   before expiry, a temporary crewing permit, a final assessor's declaration,
   an issue letter. The rule and the clauses are source/shared/evidence.js;
   the server runs it over the readings and hands the answers down with the
   dates. */
const certCoverFor = (dates, person, code) =>
  (dates && dates.covers
    && dates.covers[`${String(person || "").trim().toUpperCase()}::${String(code || "").trim().toUpperCase()}`]) || null;

/* The document filed for this cell that the reader made something else of
   (certificateStanding's filedAs, on the dates): the column it was filed
   under and what it reads as, with the file to open. Matthew, 26 Sep 2026:
   a wrong certificate under a column must be seen on the matrix, not only
   on Needs attention. Null where the reader and the filing agree. */
const certFlagFor = (dates, person, code) => {
  const P = String(person || "").trim().toUpperCase(), C = String(code || "").trim().toUpperCase();
  const mine = (f) => String(f.person || "").trim().toUpperCase() === P && String(f.code || "").trim().toUpperCase() === C;
  const filed = ((dates && dates.filedAs) || []).find(mine);
  if (filed) return { kind: "filed-as", ...filed };
  /* Or a document for this cell the reader could not place at all - one
     it could not read, one in another man's name, one with no date read
     off it (certificateStanding's notPlaced): the cell wears that too. */
  const held = ((dates && dates.notPlaced) || []).find(mine);
  return held ? { kind: "not-placed", ...held } : null;
};
const flagLine = (flag) => {
  if (flag.kind === "not-placed") {
    const said = flag.why === "name" ? `in the name of ${flag.printed || "somebody else"}`
      : flag.why === "no-date" ? "no date could be read off it"
      : `could not be read${flag.reason ? ` (${flag.reason})` : ""}`;
    return `On file, not placed: ${flag.filename || "a document"} - ${said}`;
  }
  return `Filed as ${flag.title || flag.code}, reads as ${flag.readsAs || "nothing on the matrix"} - check it`;
};

/* Two certificates on file for one cell (certificateStanding's superseded):
   the one in force holds the cell; the other is the one it replaced. The
   cell says so with a small 2, the two names on its title. */
const certTwoFor = (dates, person, code) => {
  const P = String(person || "").trim().toUpperCase(), C = String(code || "").trim().toUpperCase();
  const mine = ((dates && dates.superseded) || []).filter((f) => String(f.person || "").trim().toUpperCase() === P
    && String(f.code || "").trim().toUpperCase() === C);
  return mine.length ? mine : null;
};
/* The double ups, as one list for Admin → Documents (Matthew, 26 Sep 2026:
   "double ups need to be clearly visible. An actual list is easier"): every
   certificate on file that is a second copy of another - byte for byte
   identical to one filed before it, or set aside by the round because a
   newer one holds the same cell (certificateStanding's superseded). Each
   row is the certificate itself, with the one it doubles named and why.
   Pure, so the rule tests can hold it. */
/* The cells a document holds on the matrix, by the dates the server settled
   (certificateStanding): every cell whose Open opens this file, own or
   covered. What a Delete would empty. */
const heldBy = (dates, fileId) => {
  const id = String(fileId || "");
  if (!id || !dates || !dates.map) return [];
  const codes = new Set();
  Object.entries(dates.map).forEach(([k, cell]) => {
    if (cell && String(cell.url || "").replace(/^\/api\/files\//, "") === id) codes.add(k.slice(k.indexOf("::") + 2));
  });
  return [...codes].sort();
};
/* Said beside a Delete's Confirm, for a certificate that holds cells. */
const emptiesLine = (codes) => (codes && codes.length ? `Empties ${codes.join(", ")} on the matrix` : "");
/* The columns where this file is the foreign certificate behind the
   recognition that holds the cell (certificateStanding's `behind`): the
   cell's date is cut to it, so it is no double up and its Delete says so. */
const behindFor = (dates, fileId) => {
  const id = String(fileId || "");
  if (!id || !dates) return [];
  const codes = new Set();
  (dates.superseded || []).forEach((s) => {
    if (s.behind && String(s.url || "").replace(/^\/api\/files\//, "") === id) codes.add(String(s.code || "").toUpperCase());
  });
  return [...codes].sort();
};
/* The whole warning beside a certificate's Delete: what it empties, and
   where it is the certificate behind a recognition. */
const deleteWarn = (dates, fileId) => {
  const behind = behindFor(dates, fileId);
  return [emptiesLine(heldBy(dates, fileId)), behind.length ? `Behind the recognition for ${behind.join(", ")} on the matrix` : ""]
    .filter(Boolean).join("; ");
};

/* A document that still holds a cell is never a double up, whatever else
   it lost: on 27 Sep 2026 sixteen Master tickets, ECDIS courses and
   licences were listed for the one column a newer document had taken
   while holding others, Delete all took them, and 28 cells went blank. So
   nothing is listed without the dates, an identical copy is listed only
   where it holds nothing, and a replaced one only where the server said
   `holds` is empty - a list made before the server said so is not
   trusted. */
const doubleUpsOf = (certificates, dates) => {
  if (!dates || !dates.map) return [];
  const live = (certificates || []).filter((c) => c && c.id);
  const out = new Map();
  // Byte-identical copies filed under the same person: every copy after the first.
  const byKey = new Map();
  live.forEach((c) => {
    if (!c.checksum || !c.folder) return;
    const k = c.folder + "|" + c.checksum;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  });
  for (const g of byKey.values()) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((a, b) =>
      String(a.uploaded || "").localeCompare(String(b.uploaded || "")) || String(a.id).localeCompare(String(b.id)));
    sorted.slice(1).forEach((c) => {
      if (heldBy(dates, c.id).length) return;
      out.set(c.id, { ...c, kept: sorted[0].filename, why: "identical copy" });
    });
  }
  // Set aside by the round: a newer certificate holds the same cell, and
  // this one holds nothing else.
  const byId = new Map(live.map((c) => [String(c.id), c]));
  (dates.superseded || []).forEach((s) => {
    if (s.behind || !Array.isArray(s.holds) || s.holds.length) return;
    const id = String(s.url || "").replace(/^\/api\/files\//, "");
    const c = id && byId.get(id);
    if (!c || out.has(c.id) || heldBy(dates, c.id).length) return;
    out.set(c.id, { ...c, kept: s.kept || "", why: `replaced for ${s.code}` });
  });
  return [...out.values()].sort((a, b) =>
    String(a.person || "").localeCompare(String(b.person || "")) || String(a.filename || "").localeCompare(String(b.filename || "")));
};

const twoLine = (two) =>
  `${two.length + 1} on file: ${two[0].kept || "the one in force"} holds the cell; ${two.map((t) => t.filename).join(", ")} ${two.length === 1 ? "is the one it replaced" : "are the ones it replaced"}`;

/* The words a covered cell carries, and nothing more: what carries him and
   the day the cover stops counting. An issue letter is the one paper the law
   gives no end (MO505 s 12(2)), so it says none. */
const coverLine = (cover) =>
  cover ? `covered by ${cover.kind}${cover.until ? ` until ${fmtDate(cover.until)}` : ""}` : "";

/* A cover never shows green: green would say the certificate is in date, and
   it is not. A red or missing cell that a paper carries takes the amber band
   and says what carries it; anything already amber or green is left alone.
   A column the position does not have to hold is left hatched whatever paper
   is on file: a cover on a cell nobody must hold is nothing to put on the
   grid. `missing` is the cell the grid marks Missing - required for this
   position with nothing on file - which is exactly the cell an issue letter
   carries (MO505 s 12(2): no card yet). */
const bandWithCover = (band, cover, missing) => {
  if (!cover) return band;
  if (!band && !missing) return band;
  if (band && band.key !== "red" && band.key !== "not" && band.key !== "unknown") return band;
  return { key: "covered", fg: T.bOrange, bg: T.bOrangeBg, date: band && band.date, days: band && band.days,
    text: coverLine(cover), cover };
};

const certLinkFor = (dates, certificates, person, code) => {
  const d = certDateFor(dates, person, code);
  if (d && d.url) return d.url;
  const P = String(person || "").trim().toUpperCase();
  const C = String(code || "").trim().toUpperCase();
  // A paper filed about the column (an extension letter, a lodged renewal)
  // is not the certificate for it, so it never stands in as the link.
  const f = (certificates || []).find(
    (c) => c.url && !c.evidenceKind && String(c.person || "").trim().toUpperCase() === P
      && String(c.qualCode || "").trim().toUpperCase() === C,
  );
  return f ? f.url : null;
};

/* Items whose expiry is printed on the certificate itself and only there. The
   AMSA medical says on its own face whether it runs one year or two, so no
   validity period is ever used to work its expiry out, and the validity column
   says to read the certificate rather than printing the sheet's general guide.
   The list is the vessel file's; the server's comparison (lib/analysis.ts)
   reads the same one. */
const CERT_STATED = VESSEL.certStated;

/* Matrix items that carry no expiry date at all, for every crew member. They
   are sat once and never lapse, which is a fact about the item rather than
   something to be read off a scan, so they read as "Doesn't expire" for the
   whole crew whether or not a validity periods matrix is on file. The list is
   the vessel file's; the matrix gate (crewRowsOnly) and the server's
   comparison are handed the same one. */
const NO_EXPIRY_CODES = VESSEL.noExpiryCodes;

/* Notes shown at the bottom of the crew certificates page, from the vessel
   file. The first is also enforced in the checker: VS-04 is on
   NO_EXPIRY_CODES, so it reads as "Doesn't expire" everywhere rather than as
   a missing date. */
const CERT_PAGE_NOTES = VESSEL.certPageNotes;

/* The Notes panel the certification pages share. Read plainly by default; Edit
   turns each note into a text box, with Add and Delete beside them. Saving
   writes the list to the shared state, so every admin reads the same notes. */
function NotesPanel({ compact = false }) {
  const { certNotes, setCertNotes, admin } = usePortal();
  const [draft, setDraft] = useState(null);   // null = reading; array = editing

  const save = () => {
    const cleaned = draft.map((t) => String(t || "").trim()).filter(Boolean);
    setCertNotes(cleaned);
    setDraft(null);
  };

  return (
    <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderRadius: 2,
      padding: compact ? "11px 15px" : "13px 15px", marginTop: compact ? 0 : 14,
      marginBottom: compact ? 16 : 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <Eyebrow color={T.accent}>Notes</Eyebrow>
        {admin && draft === null && (
          <button className="um-btn" onClick={() => setDraft(certNotes.slice())}
            style={{ background: "transparent", color: T.muted, fontSize: 10, fontWeight: 700, padding: "2px 0" }}>
            Edit
          </button>
        )}
      </div>

      {draft === null ? (
        certNotes.length === 0 ? (
          <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, marginTop: 6 }}>No notes yet.</div>
        ) : (
          <ol style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            {certNotes.map((n, i) => (
              <li key={i} style={{ fontFamily: T.body, fontSize: compact ? 12.5 : 13.5, color: T.muted,
                lineHeight: compact ? 1.6 : 1.7, marginBottom: compact ? 3 : 4 }}>{n}</li>
            ))}
          </ol>
        )
      ) : (
        <div style={{ marginTop: 10 }}>
          {draft.map((n, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8 }}>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, paddingTop: 9, minWidth: 16 }}>{i + 1}.</span>
              <textarea className="um-in" rows={2} value={n}
                onChange={(e) => setDraft(draft.map((x, j) => (j === i ? e.target.value : x)))}
                style={{ flex: 1, fontFamily: T.body, fontSize: 13, lineHeight: 1.5, resize: "vertical" }} />
              <button className="um-btn" title="Delete this note"
                onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                style={{ background: "transparent", color: T.bRed, fontSize: 10, fontWeight: 700, padding: "9px 0" }}>
                Delete
              </button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
            <Button variant="quiet" onClick={() => setDraft([...draft, ""])}>Add a note</Button>
            <Button writes onClick={save}>Save</Button>
            <Button variant="quiet" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

const noExpiryPeriod = (code) =>
  NO_EXPIRY_CODES.includes(String(code || "").trim().toUpperCase())
    ? { code, neverExpires: true }
    : null;

/* How long an item stays valid, off the skills matrix — matched by
   matrix code where the sheet gives one, and by the item's name where it
   doesn't. Items on the no-expiry list above answer first, without a sheet.
   Null where the sheet doesn't list the item, and null throughout where no
   validity periods matrix has been read yet.

   Every certification screen carries this column, and so does every PDF they
   hand over, so the lookup is built once here rather than per screen. */
function useValidityLookup() {
  const { validityPeriods } = usePortal();
  return useMemo(() => {
    const list = (validityPeriods && validityPeriods.periods) || [];
    const byCode = new Map();
    const byTitle = new Map();
    list.forEach((p) => {
      if (p.code) byCode.set(String(p.code).trim().toUpperCase(), p);
      if (p.item) byTitle.set(normTitle(p.item), p);
    });
    return (m) =>
      CERT_STATED[String(m.code || "").trim().toUpperCase()] ||
      periodText(
        noExpiryPeriod(m.code)
          || byCode.get(String(m.code).trim().toUpperCase())
          || byTitle.get(normTitle(m.title)),
      );
  }, [validityPeriods]);
}

// The Certificate column: a way into the scan itself, or word that none is
// filed. Sits at the end of the line, under its own heading. Open shows the
// certificate right here, over the page, rather than sending it for download —
// the scan itself, with a way out to a full tab where it is wanted bigger.
function CertViewer({ url, filename, person, code, title, onClose }) {
  const { certDates } = usePortal();
  /* Any limitation printed on the certificate, as printed - "fit for
     particular duties only" (MO76 s 7(1)(b)), "must wear corrective lenses"
     (s 9(1)), "daylight only" on a colour-vision deck holder's near-coastal
     card (MO505 s 13(d)-(e)). It is shown here beside the scan and nowhere
     else: a line on the grid for every conditioned certificate would bury
     the grid, and the words matter enough not to be summarised. */
  const printed = person && code ? certDateFor(certDates, person, code) : null;
  const conditions = (printed && printed.conditions) || null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(18,41,61,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: T.panel, border: `1px solid ${T.rule}`, borderRadius: 3,
          width: "100%", maxWidth: 960, height: "min(88vh, 860px)", display: "flex",
          flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
          gap: 12, flexWrap: "wrap", padding: "12px 15px", borderBottom: `1px solid ${T.rule}` }}>
          <div style={{ minWidth: 0 }}>
            <Eyebrow color={T.accent}>Certificate on file</Eyebrow>
            <div style={{ fontFamily: T.body, fontSize: 14, fontWeight: 600, color: T.text, marginTop: 3 }}>
              {code ? `${code} · ` : ""}{title || filename || "Certificate"}
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 2, wordBreak: "break-word" }}>
              {[person, filename].filter(Boolean).join(" · ")}
            </div>
            {conditions && (
              <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.bOrange, marginTop: 4, wordBreak: "break-word" }}>
                {conditions}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <a href={url} target="_blank" rel="noopener noreferrer"
              style={{ fontFamily: T.display, fontSize: 11, fontWeight: 700, letterSpacing: "0.12em",
                textTransform: "uppercase", color: T.accent, textDecoration: "none" }}>
              Open in new tab
            </a>
            <Button variant="quiet" onClick={onClose}>Close</Button>
          </div>
        </div>
        {/* An iframe shows both shapes a scan arrives in — a PDF and an image —
            without having to know which this one is. */}
        <iframe src={url} title={filename || "Certificate"}
          style={{ flex: 1, border: 0, width: "100%", background: "#fff" }} />
      </div>
    </div>
  );
}

function CertCell({ url, person, code, title }) {
  const { certificates } = usePortal();
  const [open, setOpen] = useState(false);
  // The filename for the viewer's header, off the filed record the link points
  // at — cosmetic, so a link with no matching record still opens fine.
  const filed = url ? (certificates || []).find((c) => c.url === url) : null;
  return (
    <span style={{ minWidth: 78, textAlign: "right" }}>
      {url ? (
        <>
          <button className="um-btn" onClick={() => setOpen(true)}
            title={`Open the certificate${person ? ` filed for ${person}` : ""}`}
            style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer",
              fontFamily: T.display, fontSize: 11, fontWeight: 700, letterSpacing: "0.12em",
              textTransform: "uppercase", color: T.accent }}>
            Open
          </button>
          {open && (
            <CertViewer url={url} filename={filed && filed.filename} person={person}
              code={code} title={title} onClose={() => setOpen(false)} />
          )}
        </>
      ) : (
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>No scan</span>
      )}
    </span>
  );
}

function DateCols({ issued, expires }) {
  return (
    <>
      <span style={{ fontFamily: T.mono, fontSize: 10.5, color: issued ? T.text : T.muted, minWidth: 78 }}>
        {colDate(issued)}
      </span>
      <span style={{ fontFamily: T.mono, fontSize: 10.5, color: expires ? T.text : T.muted, minWidth: 78 }}>
        {colDate(expires)}
      </span>
    </>
  );
}

// The headings those columns sit under. `trail` reserves the width of whatever
// follows them on each line — the status tag, and on some screens a group
// label — so the headings stand over their columns rather than the right edge.
function DateColsHead({ trail = 150, validity = false }) {
  const head = { fontFamily: T.display, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em",
    textTransform: "uppercase", color: T.muted, minWidth: 78 };
  return (
    <div className="um-datehead" style={{ display: "flex", gap: 10, alignItems: "baseline",
      padding: "6px 0 4px", borderBottom: `2px solid ${T.rule}` }}>
      <span style={{ minWidth: 46 }} />
      <span style={{ flex: 1, minWidth: 180 }} />
      {validity && <span style={{ ...head, minWidth: 92 }}>Module validity</span>}
      <span style={head}>Issue date</span>
      <span style={head}>Expiry date</span>
      <span style={{ ...head, minWidth: 78, textAlign: "right" }}>Certificate</span>
      <span style={{ minWidth: trail }} />
    </div>
  );
}

/* The one button that brings the matrix up to date with the certificates on
   file, wherever it sits: it starts the round from the page (runMatrixRound),
   which reads the new certificates, refiles them and has the server put
   what they settle on the matrix and into the office's workbook. Admin
   only; held down while a round runs here or somebody else holds the
   lease, under their name (roundBusyTitle). */
function UpdateMatrixButton({ variant = "quiet", label = "Update matrix" }) {
  const { admin, matrixRun, runMatrixRound, roundRunning, roundHolder, offlineAt } = usePortal();
  if (!admin) return null;
  const running = !!matrixRun && matrixRun.phase !== "done" && matrixRun.phase !== "failed";
  // Held down offline too (controlsLocked): the round writes the workbook.
  const locked = controlsLocked(offlineAt, roundRunning);
  return (
    <Button variant={variant} writes disabled={running || locked}
      title={!running && locked ? (offlineAt ? offlineLine(offlineAt) : roundBusyTitle(roundHolder)) : undefined}
      onClick={() => { if (!running) runMatrixRound({ origin: "button" }); }}>
      {running ? "Updating…" : label}
    </Button>
  );
}

function ItemLine({ x, person, dates, validity }) {
  const { certificates } = usePortal();
  // With a person given, the line carries the two date columns: the issue date
  // read off that person's certificate, and the expiry the matrix holds (or,
  // where the matrix has none, the one the certificate itself carries) — and a
  // way to open the certificate those dates were read from. `validity` — how
  // long the item stays valid, off the skills matrix — is a column
  // only on the screens that pass it.
  if (person !== undefined) {
    const d = certDateFor(dates, person, x.code);
    return (
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
        padding: "5px 0", borderBottom: `1px solid ${T.rule}` }}>
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, minWidth: 46 }}>{x.code}</span>
        <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1, minWidth: 180 }}>{x.title}</span>
        {validity !== undefined && (
          <span style={{ fontFamily: T.mono, fontSize: 10.5, color: validity ? T.text : T.muted, minWidth: 92 }}>
            {validity || "—"}
          </span>
        )}
        <DateCols issued={d && d.issued} expires={x.band.date || (d && d.expires)} />
        <CertCell url={certLinkFor(dates, certificates, person, x.code)}
          person={person} code={x.code} title={x.title} />
        <span style={{ minWidth: 150, display: "flex", justifyContent: "flex-end" }}>
          <BandTag band={x.band} />
        </span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
      padding: "5px 0", borderBottom: `1px solid ${T.rule}` }}>
      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, minWidth: 46 }}>{x.code}</span>
      <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1, minWidth: 190 }}>{x.title}</span>
      <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, minWidth: 74 }}>
        {x.band.date ? x.band.date.split("-").reverse().join("/") : ""}
      </span>
      <BandTag band={x.band} />
    </div>
  );
}
