/* Crew Matrix — the training matrix: the round's rules, the grid and its
 * reports, the workbook, the reading and the round window, the items held
 * against the office's list, and the swing compliance report.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state (and
 * runMatrixRound, which is the state's); this holds what is only this
 * page's. See tools/source.mjs.
 */

/* The worker's hour holds one lease around its sync, its reading and its
   round, and Update portal and the workbook upload take the same one. A
   page that starts its round in the middle of the hour is refused with a
   409 - so it waits for the lease to be free instead: a look every fifteen
   seconds, up to the fifteen minutes the hour can hold it for. Answers
   whether the lease is free; a portal that cannot say counts as free, and
   the request that follows is what gets refused, plainly.

   `saw` is told what each look found - whether the lease is held, and by
   whom - so the provider can hold whether the hour is running and keep the
   buttons that write the workbook out of its way (see roundRunning), under
   whoever holds it at each look, without a clock of its own. A portal that
   cannot say is told as free too, so the buttons never stay down on its
   account. */
async function waitForRound(onWait, saw) {
  const until = Date.now() + 15 * 60000;
  for (;;) {
    let running = false;
    let holder = null;
    try {
      const r = await fetch("/api/sync/last", { cache: "no-store" });
      if (r.ok) {
        const body = await r.json();
        running = !!body.running;
        holder = body.holder == null ? null : String(body.holder);
      }
    } catch (e) { if (saw) saw(false); return true; }
    if (saw) saw(running, holder);
    if (!running) return true;
    if (Date.now() > until) return false;
    if (onWait) onWait();
    await new Promise((ok) => setTimeout(ok, 15000));
  }
}

// What a button that writes the workbook says, held down, while the hour has it.
const ROUND_BUSY = "The round on the hour is writing the workbook";

/* ---- the round from the page: its decisions as plain rules ---------------
   The round itself runs on the server (POST /api/round, the same code the
   hour runs); the page reads the new certificates and refiles first, then
   starts it and watches, and never applies a date itself. The decisions the
   runner (runMatrixRound in the provider) makes on the way are rules of
   their own here, so each is proved outright in tools/client-rules.test.mjs
   without a browser. */

/* What the runner does with the server's answer to POST /api/round. A 409
   is somebody holding the lease: the hour, which is waited for (and a 409
   that names nobody is read the same way), or a person, who is named and
   not waited for. `by` is the name this round was sent under, so a round
   under the same name is one this person started themselves. */
function roundAnswerPhase(status, body, by) {
  const b = body && typeof body === "object" ? body : {};
  if (status === 200) return "done";
  if (status === 409) {
    const holder = typeof b.by === "string" ? b.by.trim() : "";
    if (!holder || holder === "the round on the hour") return "waiting";
    if (holder === String(by || "").trim()) return "failed:A round you started is still running";
    return `failed:Somebody else is running it: ${holder}. Try again when it has finished.`;
  }
  return "failed:" + (b.error || `The round couldn't be run (${status}).`);
}

/* What a look at GET /api/round/progress is worth to the runner. Only a
   record carrying this round's runId is ours; any other is an older
   round's, or somebody else's, and is left alone. A record of ours that is
   not done while nobody holds the lease, or while the lease is held under
   another name than the record's, is a round that was cut off: the
   platform cancels a request whose browser has gone, and the hour can take
   a lapsed lease within fifteen seconds. Never by the age of the last
   word - the workbook step can outlast any of them. */
function progressAccept(record, runId, running) {
  const r = record && typeof record === "object" ? record : null;
  if (!r || !runId || r.runId !== runId) return "ignore";
  const pct = Math.max(0, Math.min(100, Math.round(Number(r.pct) || 0)));
  const word = String(r.word || "");
  if (r.done) return { pct, word };
  const live = running === undefined ? !!r.running : !!running;
  const holder = r.holder == null ? null : String(r.holder);
  if (!live || (holder !== null && r.by && holder !== String(r.by))) return "cut-off";
  return { pct, word };
}

/* When the pull after the round may go. A pull leaves the document alone
   while this tab holds anything unsaved or has a save in the air, so the
   runner waits for both to clear - up to twenty seconds, after which it
   pulls anyway and says the matrix on screen follows once the save lands. */
const PULL_NOW_CEILING_MS = 20000;
const PULL_LATE_NOTE = "the matrix on screen follows once this tab's own change has saved";
function pullNowStep({ dirty, saving, waitedMs }) {
  if (!dirty && !saving) return "pull";
  return waitedMs >= PULL_NOW_CEILING_MS ? "pull-late" : "wait";
}

/* A pull for a caller who needs what the server holds now - the runner,
   after the round has saved. The tick's own pulls run one at a time, and a
   second ask while one is running is handed the one running; but that one
   may have asked the server before the round's save landed, and would
   bring back nothing new. So a caller is given a fresh pull after any in
   flight, never the one in flight itself. */
function freshPull(inFlight, pull) {
  return inFlight ? inFlight.then(pull, pull) : pull();
}

/* The switch the poll throws when the record says the round was cut off.
   The request is raced against it, never cancelled: a lease that lapsed
   under a workbook write still in flight is not a dead round, and a
   cancelled request would have the platform stop the write with it. The
   runner stops waiting; the request keeps its socket to the end. */
const CUT_OFF = "The round was cut off; press again";
function cutOffSwitch() {
  let throwIt = () => {};
  const tripped = new Promise((_, no) => { throwIt = () => no(new Error(CUT_OFF)); });
  tripped.catch(() => {});
  return { tripped, cutOffNow: throwIt };
}

/* Clearing the run's window leaves a live run alone. The round runs on
   the server once started, and a window taken down mid-run is not a run
   stopped: its progress would go on landing on nothing, the button would
   come back, and a start queued behind it would wait unseen. Only a run
   that has finished, either way, is cleared. */
function runCleared(m) {
  return m && m.phase !== "done" && m.phase !== "failed" ? m : null;
}

/* A start landing mid-run, kept for after it: one queued start, with every
   ask made while it waits folded in. The first ask's keys stand, and the
   certificate upload's origin stands whichever came first, because that
   screen is the one that reads the origin to report its own batch. Every
   caller is answered with the round that runs for them (its waiters), not
   told at once that nothing happened. */
function queueRound(queued, input, waiter) {
  const q = queued || { input: {}, waiters: [] };
  const merged = { ...(input || {}), ...q.input };
  if (input && input.origin === "certificates") merged.origin = "certificates";
  return { input: merged, waiters: waiter ? [...q.waiters, waiter] : q.waiters };
}

/* What a button that writes the workbook says, held down, while somebody
   else has it: the hour by its own sentence, a person by name. */
function roundBusyTitle(holder) {
  const h = String(holder || "").trim();
  return !h || h === "the round on the hour" ? ROUND_BUSY : `${h} is writing the workbook`;
}

/* When a certificate last moved a date on the matrix: the round's own stamp
   (matrixUpdated, written when a date moves). Only where there is no stamp
   yet does the day the workbook was last filed stand in - a workbook
   uploaded by hand moves no date, so it never outranks the stamp. */
function matrixLastMoved(matrixUpdated, trainingMatrix) {
  const stamp = String(matrixUpdated || "").slice(0, 10);
  if (stamp) return stamp;
  return String((trainingMatrix && trainingMatrix.uploaded) || "").slice(0, 10);
}

/* ---- filing the matrix spreadsheet (MatrixSpreadsheet) -------------------
   The report built from the matrix as it stands, filed in place of the one
   on the portal. No certificate is read and no date moves; what comes out
   of it is the line in the log and the stamp the swing report reads. */

/* Whether there is anything to file. latestMatrixFile hands the workbook's
   own bytes back when no cell on it moved, and the server files whatever
   it is sent - a new dated row, the live copy parked - so the page decides
   first: a file with a cell changed, or one built from nothing, is sent;
   the same bytes again are not. */
function fileSpreadsheetSend(report) {
  return report && (report.rebuilt || report.written > 0) ? "send" : "same";
}

/* What to do with a refused upload. The replace takes the server's lease,
   so a 409 is somebody writing the workbook: waited for. Anything else is
   the error it is. */
function fileSpreadsheetStep(err) {
  return err && err.status === 409 ? "wait" : "fail";
}

/* The send, with its one wait: `send` is tried, a 409 is waited out
   (`wait` is given the refusal, which names the holder) and the send goes
   once more. Its refusal the second time, or any other error, is thrown
   as it is, so the server's own sentence is what gets shown. */
async function fileSpreadsheetAttempt(send, wait) {
  try {
    return await send();
  } catch (e) {
    if (fileSpreadsheetStep(e) !== "wait") throw e;
    await wait(e);
    return await send();
  }
}

/* What to say once it is filed: the line in the log, and the patch on
   certAnalysis's `generated` - the file, who filed it and that nothing
   failed. Its `at` is left as it was: that is when the matrix was last
   brought up to the certificates, which the swing report reads "matrix
   fresh" from, and only the round reads a certificate. A workbook built
   from nothing has no count of cells changed worth giving. */
function fileSpreadsheetOutcome(report, record, by) {
  const written = (report && report.written) || 0;
  const filename = (record && record.filename) || "";
  const detail = report && report.rebuilt
    ? `${filename} · built from the matrix`
    : `${filename} · ${written} ${written === 1 ? "cell" : "cells"} changed`;
  const patch = (prev) => ({
    ...(prev || {}),
    generated: {
      ...((prev && prev.generated) || {}),
      at: (prev && prev.generated && prev.generated.at) || null,
      by, filename, fileId: (record && record.id) || null, failed: null,
    },
  });
  return { detail, patch };
}

/* Whether the matrix was current with the certificates on file: the
   round's stamp (certAnalysis.generated.at) falls on or after the day the
   newest certificate was uploaded, by the vessel's calendar. No stamp is
   never fresh; no certificate on file is always fresh. */
function matrixFreshAt(generatedAt, latestCert) {
  return !!generatedAt && (!latestCert || vesselDay(generatedAt) >= latestCert.slice(0, 10));
}

/* The day a moment falls on by the vessel's calendar, as YYYY-MM-DD; "" for
   a moment that is not one. */
function vesselDay(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : new Intl.DateTimeFormat("en-CA", { timeZone: VESSEL_TZ }).format(d);
}

/* The done panel, off the round's outcome: the eyebrow, and the lines
   under it - the counts, the workbook and any one-line problem, nothing
   else. Each line carries a tone for the window (plain, muted, problem,
   link); a link line carries where it goes. */
function doneEyebrow(o) {
  if (!o || o.noItems) return "Nothing on the matrix yet";
  return (o.applied || 0) > 0 || (o.cleared || 0) > 0 ? "Matrix updated" : "Matrix already up to date";
}
function doneWindowLines(o) {
  const out = [];
  if (!o || o.noItems) return out;
  const some = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const s = o.summary || {};
  const certificates = s.certificates || 0;
  out.push({ text: `${s.read || 0} of ${some(certificates, "certificate", "certificates")} on file ${certificates === 1 ? "was" : "were"} read.`, tone: "plain" });
  if ((o.applied || 0) > 0) out.push({ text: `${some(o.applied, "date", "dates")} written`, tone: "plain", changes: true });
  if ((o.cleared || 0) > 0) {
    out.push({ text: `${o.cleared} cleared: the certificate behind ${o.cleared === 1 ? "it" : "them"} is no longer in the library`, tone: "plain" });
  }
  if ((o.refiled || 0) > 0) out.push({ text: `${o.refiled} refiled`, tone: "plain" });
  if ((s.derived || 0) > 0) out.push({ text: `${s.derived} worked out from ${s.validitySheet || "the skills matrix"}`, tone: "plain" });
  if (o.workbook) {
    out.push({ text: `${o.workbook} · ${some(o.written || 0, "cell", "cells")}`, tone: "link",
      href: o.workbookId ? `/api/files/${o.workbookId}` : null, download: o.workbook });
  } else if (o.written === 0) {
    out.push({ text: "The spreadsheet already had every date", tone: "plain" });
  }
  if ((o.leftAsTyped || 0) > 0) out.push({ text: `${some(o.leftAsTyped, "cell", "cells")} left as typed`, tone: "muted" });
  const said = new Set();
  [o.held, o.validityProblem, o.equivalenceProblem, o.workbookProblem, o.roundSkipped, o.roundError, o.prepareProblem].forEach((p) => {
    const text = p == null ? "" : String(p).trim();
    if (!text || said.has(text)) return;
    said.add(text);
    out.push({ text, tone: "problem" });
  });
  if (o.note) out.push({ text: String(o.note), tone: "muted" });
  return out;
}

/**
 * The button that turns whatever is on screen into a PDF. The report is only
 * described when it is clicked, so it always matches the filters in force at
 * that moment, and anything that goes wrong is said next to the button rather
 * than in a browser alert.
 */
function DownloadPDF({ build, label = "Download PDF", variant = "solid" }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const go = async () => {
    setBusy(true);
    setErr("");
    try {
      await saveReportPDF(build());
    } catch (e) {
      setErr(e.message || String(e));
    }
    setBusy(false);
  };

  return (
    <>
      <Button variant={variant} onClick={go} disabled={busy}>
        {busy ? "Making the PDF..." : label}
      </Button>
      {err && (
        <div style={{ flexBasis: "100%", width: "100%", fontFamily: T.body, fontSize: 13,
          color: T.bRed, lineHeight: 1.6 }}>{err}</div>
      )}
    </>
  );
}

function CrewReport({ only = null, missingItemsFor, onClose }) {
  const { quals: QUALS, certDates } = usePortal();
  const validityFor = useValidityLookup();
  // The whole matrix, spelled out: every crew member and everything held
  // against them - not just what falls due soon. itemsFor puts each person's
  // soonest date first, so what needs attention still leads their list.
  // Asked for one band ("red", "orange", "green") the report keeps only the
  // crew with an item in it, and only those items; asked for the missing it
  // lists the cells the grid marks Missing, by the same rule as the grid.
  const crew = QUALS.rows
    .map((r) => ({
      row: r,
      items: only === "missing"
        ? missingItemsFor(r)
        : itemsFor(r, QUALS).filter((x) => !only || x.band.key === only),
    }))
    .filter((x) => x.items.length > 0);

  const soonOf = (items) => items.filter((x) => x.band.date && daysTo(x.band.date) <= RED_DAYS);
  const total = crew.reduce((n, a) => n + a.items.length, 0);
  const due = crew.reduce((n, a) => n + soonOf(a.items).length, 0);
  const expired = crew.reduce((n, a) => n + a.items.filter((i) => i.band.date && hasExpired(i.band.date, TODAY)).length, 0);

  const said = {
    red: `expired or within ${RED_DAYS} days`,
    orange: `${RED_DAYS} to ${AMBER_DAYS} days`,
    green: `more than ${AMBER_DAYS} days`,
    missing: "missing",
  };
  const heading = only ? `Crew Report - ${said[only]}` : "Crew Report - every item on the matrix";
  const standfirst = `${VESSEL.name} ${VESSEL.nameAccent} · as at ${fmtDate(TODAY)} · ${crew.length} crew · ${total} item${total === 1 ? "" : "s"}`
    + (only ? "" : ` · ${due} due within ${RED_DAYS} days${expired ? ` · ${expired} already expired` : ""}`);

  // Each person's line on the report says the same as their line on the table:
  // how much they hold, how much of it is a problem today, and — because the
  // items underneath are the ones their position asks for — whether the position
  // is the one their ticket is actually for.
  const metaOf = (row, items) => {
    const soon = soonOf(items).length;
    const stand = ticketStandingFor(row, QUALS);
    return `${row[1]} · ${row[2]} · ${items.length} item${items.length === 1 ? "" : "s"}`
      + (soon ? ` · ${soon} due within ${RED_DAYS} days` : "")
      + (stand ? ` · ${stand.label.toLowerCase()}` : "");
  };

  const asPDF = () => ({
    title: heading,
    subtitle: standfirst,
    filename: `crew-report-${only ? slugOf(said[only]) + "-" : ""}${TODAY}.pdf`,
    empty: only ? "Nobody on the matrix has one." : "Nothing is held on the matrix.",
    groups: crew.map(({ row, items }) => ({
      heading: row[0],
      meta: metaOf(row, items),
      items: items.map(pdfLineIn({ person: row[0], dates: certDates, validityFor })),
    })),
  });

  return (
    <div className="um-report">
      <div className="um-noprint" style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <DownloadPDF build={asPDF} />
        <Button variant="quiet" onClick={() => window.print()}>Print</Button>
        <Button variant="quiet" onClick={onClose}>Back to the matrix</Button>
      </div>

      <div style={{ borderBottom: `2px solid ${T.text}`, paddingBottom: 8, marginBottom: 14 }}>
        <div style={{ fontFamily: T.display, fontSize: 22, fontWeight: 700, letterSpacing: "0.04em",
          textTransform: "uppercase", color: T.text }}>{heading}</div>
        <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted, marginTop: 5 }}>
          {standfirst}
        </div>
      </div>

      {crew.length === 0 ? <Empty>{only ? "Nobody on the matrix has one." : "Nothing is held on the matrix."}</Empty> : crew.map(({ row, items }) => (
        <div key={row[0] + row[2]} style={{ marginBottom: 16, breakInside: "avoid" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
            gap: 12, flexWrap: "wrap", background: T.raised, padding: "5px 9px", borderRadius: 2 }}>
            <span style={{ fontFamily: T.body, fontSize: 14, fontWeight: 600, color: T.text }}>{row[0]}</span>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{metaOf(row, items)}</span>
          </div>
          {items.map((x) => <ItemLine key={x.code} x={x} />)}
        </div>
      ))}
    </div>
  );
}

function IndividualReport({ onClose }) {
  const { quals: QUALS, certDates } = usePortal();
  const validityFor = useValidityLookup();
  const [who, setWho] = useState("");
  const row = QUALS.rows.find((r) => r[0] === who);
  const items = row ? itemsFor(row, QUALS) : [];
  const soon = items.filter((x) => (x.band.date && daysTo(x.band.date) <= RED_DAYS) || x.band.key === "not");

  const standfirst = row
    ? `${row[1]} · ${row[2]} · as at ${fmtDate(TODAY)} · ${items.length} items held · ${soon.length ? `${soon.length} due within ${RED_DAYS} days or not held` : `nothing due within ${RED_DAYS} days`}`
    : "";

  const asPDF = () => {
    const line = pdfLineIn({ person: row[0], dates: certDates, validityFor });
    return {
      title: row[0],
      subtitle: standfirst,
      filename: `${slugOf(row[0])}-${TODAY}.pdf`,
      empty: "Nothing is held against this name.",
      groups: [
        ...(soon.length ? [{ heading: "Needs attention", meta: `${soon.length} within ${RED_DAYS} days or not held`, items: soon.map(line) }] : []),
        ...Array.from(new Set(items.map((x) => x.group))).map((g) => ({
          heading: g,
          meta: "",
          items: items.filter((x) => x.group === g).map(line),
        })),
      ],
    };
  };

  return (
    <div className="um-report">
      <div className="um-noprint" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {row && <DownloadPDF build={asPDF} />}
          {row && <Button variant="quiet" onClick={() => window.print()}>Print</Button>}
          <Button variant="quiet" onClick={onClose}>Back to the matrix</Button>
        </div>
        <ChoiceField label="Your name — every name on the matrix">
          <Choices value={who} onPick={setWho} compact
            options={QUALS.rows.map((r) => ({ value: r[0], label: r[0] }))} />
        </ChoiceField>
      </div>

      {!row ? (
        <Empty>Pick a name to see everything held, and what falls due next.</Empty>
      ) : (
        <>
          <div style={{ borderBottom: `2px solid ${T.text}`, paddingBottom: 8, marginBottom: 14 }}>
            <div style={{ fontFamily: T.display, fontSize: 22, fontWeight: 700, letterSpacing: "0.04em",
              textTransform: "uppercase", color: T.text }}>{row[0]}</div>
            <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted, marginTop: 5 }}>
              {standfirst}
            </div>
          </div>

          {soon.length > 0 && (
            <div style={{ marginBottom: 18, breakInside: "avoid" }}>
              <div style={{ marginBottom: 7 }}><Eyebrow color={T.bRed}>Needs attention</Eyebrow></div>
              {soon.map((x) => <ItemLine key={x.code} x={x} />)}
            </div>
          )}

          {Array.from(new Set(items.map((x) => x.group))).map((g) => (
            <div key={g} style={{ marginBottom: 16, breakInside: "avoid" }}>
              <div style={{ marginBottom: 7 }}><Eyebrow>{g}</Eyebrow></div>
              {items.filter((x) => x.group === g).map((x) => <ItemLine key={x.code} x={x} />)}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* Everything held against one person, opened by clicking their name in the
   matrix and shown underneath the table.

   The grid can only give an item a colour and a cramped date. This spells each
   one out: what the code stands for, the date behind the colour, how that date
   reads today, and whether a scan of the certificate has been filed against it.

   It deliberately ignores the category filter above the table. That filter is
   there to get the columns down to a readable width; opening a name is the
   opposite question - what does this person hold, all of it, in one place. */
function MatrixPerson({ row, onClose }) {
  const { certificates, quals: QUALS, certDates } = usePortal();
  const validityFor = useValidityLookup();

  const items = itemsFor(row, QUALS);
  // Whether this person is working in the position their ticket is for. The
  // table marks it with a dot; here there is room to say which ticket it is.
  const stand = ticketStandingFor(row, QUALS);
  // Categories in the order the matrix puts its columns in, so reading down the
  // panel and reading across the table meet the same items in the same order.
  // itemsFor has already sorted within each one, soonest first.
  const groups = Array.from(new Set(QUALS.cols.map((c) => c[2])))
    .filter((g) => items.some((x) => x.group === g));

  // Certificates are filed under the name on the matrix, so a person's scans
  // are whatever sits in their folder. A scan carries the code it was filed
  // against, which is what puts it on the right line.
  const files = certificates.filter((c) => c.person === row[0]);
  const scansFor = (code) => files.filter((f) => f.qualCode === code);

  const dated = (test) => items.filter((x) => x.band.date && test(daysTo(x.band.date)));
  // Nought days left has gone: MO70 s 5(a)(iii).
  const expired = dated((d) => d <= 0);
  const soon = dated((d) => d > 0 && d <= RED_DAYS);
  const later = dated((d) => d > RED_DAYS && d <= AMBER_DAYS);
  const notHeld = items.filter((x) => x.band.key === "not");
  const unconfirmed = items.filter((x) => x.band.key === "unknown");
  // A blank cell means the item was never asked of this position, so it is
  // counted rather than listed - an empty line per item would bury the rest.
  const notRequired = QUALS.cols.length - items.length;

  // What someone opening a name is usually looking for, pulled to the top so it
  // isn't hunted for down a category it happens to sit in. Everything appears
  // again in its own category below, which is the point - this is the shortlist,
  // not a separate set of facts.
  const attention = items.filter(
    (x) => (x.band.date && daysTo(x.band.date) <= AMBER_DAYS) || x.band.key === "not",
  );

  const standfirst = `${row[1]} · ${row[2]} · as at ${fmtDate(TODAY)} · ${items.length} item${items.length === 1 ? "" : "s"} held`
    + ` · ${files.length} scan${files.length === 1 ? "" : "s"} on file`
    + (notRequired ? ` · ${notRequired} not required for this position` : "");

  // One certificate, spelled out: the code, what the code stands for, the date
  // itself, how that date reads today, and a way into the scan filed for it.
  const line = (x, prefix) => {
    const scans = scansFor(x.code);
    return (
      <div key={prefix + x.code} className="um-row" style={{ display: "flex", gap: 10, alignItems: "baseline",
        flexWrap: "wrap", padding: "6px 0", borderBottom: `1px solid ${T.rule}` }}>
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, minWidth: 46 }}>{x.code}</span>
        <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1, minWidth: 190 }}>{x.title}</span>
        <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, minWidth: 74 }}>
          {x.band.date ? x.band.date.split("-").reverse().join("/") : ""}
        </span>
        <BandTag band={x.band} />
        <span style={{ minWidth: 62, textAlign: "right" }}>
          {scans.length === 0 ? (
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>No scan</span>
          ) : scans.map((f) => (
            <span key={f.id} title={f.filename} style={{ marginLeft: 8 }}><OpenLink url={f.url} /></span>
          ))}
        </span>
      </div>
    );
  };

  const asPDF = () => {
    const line = pdfLineIn({ person: row[0], dates: certDates, validityFor });
    return {
      title: row[0],
      subtitle: standfirst,
      filename: `${slugOf(row[0])}-${TODAY}.pdf`,
      empty: "Nothing is held against this name.",
      groups: [
        ...(stand
          ? [{ heading: "Position and ticket", meta: stand.label, blurb: stand.note,
              items: stand.held.map((t) => ({ code: t.code, title: t.short, validity: "", issued: "",
                date: t.band.date ? colDate(t.band.date) : "", status: bandLabel(t.band),
                fg: t.band.fg, bg: t.band.bg })) }]
          : []),
        ...(attention.length
          ? [{ heading: "Needs attention", meta: `${attention.length} expired, due within ${AMBER_DAYS} days or not held`,
              items: attention.map(line) }]
          : []),
        ...groups.map((g) => ({
          heading: g,
          meta: "",
          items: items.filter((x) => x.group === g).map(line),
        })),
      ],
    };
  };

  return (
    <div style={{ background: T.panel, border: `1px solid ${T.rule}`,
      borderLeft: `3px solid ${expired.length + notHeld.length + soon.length ? T.bRed : later.length ? T.bOrange : T.teal}`,
      borderRadius: 2, padding: "14px 15px", marginTop: 18 }}>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
        gap: 12, flexWrap: "wrap", borderBottom: `1px solid ${T.rule}`, paddingBottom: 10, marginBottom: 12 }}>
        <div style={{ minWidth: 220 }}>
          <div style={{ fontFamily: T.display, fontSize: 18, fontWeight: 700, letterSpacing: "0.04em",
            textTransform: "uppercase", color: T.text }}>{row[0]}</div>
          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 5 }}>{standfirst}</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <DownloadPDF build={asPDF} label="Download PDF" variant="quiet" />
          <Button variant="quiet" onClick={onClose}>Close</Button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 14 }}>
        {expired.length > 0 && <Chip fg={T.bRed} bg={T.bRedBg}>{expired.length} expired</Chip>}
        {notHeld.length > 0 && <Chip fg={T.bRed} bg={T.bRedBg}>{notHeld.length} not held</Chip>}
        {soon.length > 0 && <Chip fg={T.bRed} bg={T.bRedBg}>{soon.length} within {RED_DAYS} days</Chip>}
        {later.length > 0 && <Chip fg={T.bOrange} bg={T.bOrangeBg}>{later.length} within {AMBER_DAYS} days</Chip>}
        {unconfirmed.length > 0 && <Chip fg={T.muted} bg={T.raised}>{unconfirmed.length} unconfirmed</Chip>}
        {expired.length + notHeld.length + soon.length + later.length + unconfirmed.length === 0 && items.length > 0 && (
          <Chip fg={T.green} bg={T.bGreenBg}>Everything in date</Chip>
        )}
      </div>

      {/* Ahead of the certificates, because it changes how the rest of the panel
          should be read: the items below are the ones the position asks for, and
          if the position isn't the one the ticket is for then that is the wrong
          set to be reading. Filled where the ticket doesn't reach the position,
          outlined where it goes past it — the same two marks as the table. */}
      {stand && (
        <div style={{ background: stand.strong ? T.violetBg : T.panel, border: `1px solid ${T.violet}`,
          borderLeft: `3px solid ${T.violet}`, borderRadius: 2, padding: "11px 13px", marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
            <Eyebrow color={T.violet}>Position and ticket</Eyebrow>
            <Chip fg={T.violet} bg={stand.strong ? T.panel : T.violetBg}>{stand.label}</Chip>
          </div>
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.65 }}>{stand.note}</div>
          {stand.held.length > 0 && (
            <div style={{ marginTop: 9 }}>
              {stand.held.map((t) => (
                <div key={t.code} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
                  padding: "5px 0", borderTop: `1px solid ${T.rule}` }}>
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, minWidth: 46 }}>{t.code}</span>
                  <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1, minWidth: 170 }}>
                    {t.short}
                    <span style={{ color: T.muted }}>
                      {" · "}{t.stream === "both" ? "deck or engine room" : STREAM_WORD[t.stream]}
                      {t.unconfirmed ? " · not confirmed" : ""}
                    </span>
                  </span>
                  <BandTag band={t.band} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <Empty>Nothing on the matrix against this name.</Empty>
      ) : (
        <>
          {attention.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ marginBottom: 6 }}><Eyebrow color={T.bRed}>Needs attention</Eyebrow></div>
              {attention.map((x) => line(x, "a-"))}
            </div>
          )}

          {groups.map((g) => (
            <div key={g} style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 6 }}><Eyebrow>{g}</Eyebrow></div>
              {items.filter((x) => x.group === g).map((x) => line(x, g + "-"))}
            </div>
          ))}
        </>
      )}

      <div style={{ marginTop: 16, marginBottom: 6 }}>
        <Eyebrow color={T.accent}>Certificates on file · {files.length}</Eyebrow>
      </div>
      {files.length === 0 ? (
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.muted, lineHeight: 1.6 }}>
          Nothing has been uploaded for {row[0]} yet. Scans are filed from the Admin
          tab, under Documents.
        </div>
      ) : files.map((f) => (
        <div key={f.id} className="um-row" style={{ display: "flex", gap: 12, alignItems: "center",
          flexWrap: "wrap", padding: "7px 0", borderTop: `1px solid ${T.rule}` }}>
          <div style={{ flex: "1 1 220px", minWidth: 0 }}>
            <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, wordBreak: "break-word" }}>
              {f.filename}
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 3 }}>
              {[f.qualCode, f.size, f.expires ? `expires ${fmtDate(f.expires)}` : null,
                f.uploaded ? `filed ${fmtDate(f.uploaded)}` : null].filter(Boolean).join(" · ")}
            </div>
          </div>
          <OpenLink url={f.url} />
        </div>
      ))}
    </div>
  );
}

// Matrix column widths, in pixels. Both are pinned because the table would
// otherwise hand its spare width to the crew column - it stretched past 800px
// and pushed the grid so far right that only nine items were on screen. Fixed
// widths keep the qualifications hard up against the names, so as many columns
// as the screen can hold are visible at once.
const MX_NAME_W = 184;
const MX_COL_W = 64;

function TrainingMatrix() {
  const { quals: QUALS, setQuals, log, matrixUpdated, certSheet, certificates, certDates,
    skillsRequirements, setSkillsRequirements, validityMatrix, removeCrew, admin, rosterPlan } = usePortal();
  // Taking a crew member off, asked for here and answered here.
  const [leaving, setLeaving] = useState(null);
  /* Remembered, because whichever order somebody reads the matrix in they read
     it in every time. "As the spreadsheet has it" is the office's own order,
     which is what this always used to show and what somebody comparing the two
     side by side will want. */
  const [sortBy, setSortBy] = useRemembered("matrix-sort", "rank",
    (v) => v === "rank" || v === "name" || v === "sheet");

  // The requirements come off the skills matrix workbook. Read here once when
  // nothing is held yet, so the page doesn't wait on an update run.
  /* Read again whenever the workbook on file is a different one, and remember
     which one the answer came from. Reading only once - on the first look, at
     whatever the file list happened to say at that moment - meant a skills
     matrix replaced afterwards was never read, and the requirements went on
     describing the workbook it replaced with nothing to show they were stale. */
  const askedForReq = useRef("");
  React.useEffect(() => {
    const from = (validityMatrix && validityMatrix.id) || "";
    if (!from || !validityMatrix.url) return;
    if (askedForReq.current === from) return;
    if (skillsRequirements && skillsRequirements.from === from) return;
    askedForReq.current = from;
    (async () => {
      try {
        const read = await readSkillsMatrix(validityMatrix, QUALS.cols);
        if (read) setSkillsRequirements(read);
      } catch (e) {}
    })();
  }, [skillsRequirements, validityMatrix]);

  const needByPosition = useMemo(() => {
    const m = new Map();
    QUALS.rows.forEach((r) => {
      const p = r[1] || "";
      if (!m.has(p)) m.set(p, requiredCodesFor(p, skillsRequirements));
    });
    return m;
  }, [QUALS, skillsRequirements]);

  /* Which other columns answer for a requirement, off the office's own
     equivalence page: "if you do not hold QL-15, QL-14 is accepted". A
     requirement is not missing where the crew member holds something the
     office says stands in for it. */
  const metBy = useMemo(() => {
    const m = new Map();
    ((skillsRequirements && skillsRequirements.covers) || []).forEach((c) => {
      if (!m.has(c.need)) m.set(c.need, []);
      m.get(c.need).push(c.met);
    });
    return m;
  }, [skillsRequirements]);
  const colAt = useMemo(
    () => new Map(QUALS.cols.map((c, i) => [String(c[0]).trim().toUpperCase(), i])),
    [QUALS],
  );
  const standsIn = (row, code) => (metBy.get(code) || []).some((alt) => {
    const at = colAt.get(alt);
    return at !== undefined && String((row[3] || [])[at] || "").trim() !== "";
  });
  // The cell the grid marks Missing: required for the position, nothing on
  // file, and nothing the office accepts in its place. The cell, the Missing
  // button's count and its filter all ask this one question.
  const missingAt = (row, i) => !String((row[3] || [])[i] || "").trim()
    && (needByPosition.get(row[1] || "") || new Set()).has(QUALS.cols[i][0])
    && !standsIn(row, String(QUALS.cols[i][0]).trim().toUpperCase());
  const [report, setReport] = useState(null);
  // The three ways of writing the matrix out, behind one Report button.
  const [reportMenu, setReportMenu] = useState(false);
  // The scan behind a pressed cell, opened in the same viewer the checker uses.
  const [cellScan, setCellScan] = useState(null);
  const [group, setGroup] = useState("All");
  // The grid's frame. The page scrolls it up and down, and FloatingBar (in
  // the shell, shared with the roster) drives it sideways from the bottom of
  // the screen and keeps its column headings in sight.
  const frame = useRef(null);

  const [q, setQ] = useState("");
  const [only, setOnly] = useState("all");

  // Whose certificates are open underneath the table. Held as name and seafarer
  // number together, so two people sharing a surname and initial can't open
  // each other's. Nothing is open until a name is pressed.
  const [picked, setPicked] = useState("");
  const detail = useRef(null);
  const keyOf = (r) => r[0] + "|" + r[2];

  // The table is taller than the screen, so a name pressed near the top would
  // open a panel nobody can see. Bring it into view when it opens, and leave
  // the page alone once it is already there.
  React.useEffect(() => {
    if (picked && detail.current) detail.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [picked]);

  const groups = ["All", ...Array.from(new Set(QUALS.cols.map((c) => c[2])))];
  // Hide the columns that don't apply to anybody on screen. With one person
  // searched, their 54-column row collapses to just the items their position
  // is tracked against — the single biggest readability gain the grid has.
  const [onlyTracked, setOnlyTracked] = useState(false);
  const colIdxAll = QUALS.cols.map((c, i) => i).filter((i) => group === "All" || QUALS.cols[i][2] === group);

  // Where each person's ticket sits against the position they work in. Worked
  // out once for the whole table rather than per row, and keyed the same way the
  // open panel is so a row and its panel can never disagree.
  const standings = useMemo(
    () => new Map(QUALS.rows.map((r) => [r[0] + "|" + r[2], ticketStandingFor(r, QUALS)])
      .filter(([, v]) => v)),
    [QUALS],
  );
  const offTicket = Array.from(standings.values());
  const offTicketStrong = offTicket.filter((x) => x.strong).length;

  /* Either way round.
   *
   * By rank is how the matrix is read when the question is whether the vessel
   * is manned - the masters together, then the mates, the engineers, the GPHs,
   * the cooks. By surname is how it is read when the question is one person's
   * tickets, and hunting a name down a rank-ordered list means knowing their
   * rank first. Names are written LASTNAME, First, so sorting the name sorts
   * the surname. */
  const ordered = useMemo(() => {
    const list = QUALS.rows.slice();
    if (sortBy === "name") return list.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    if (sortBy === "rank") {
      return list.sort((a, b) =>
        rankGroupAt(a[1]) - rankGroupAt(b[1]) || String(a[0]).localeCompare(String(b[0])));
    }
    return list;
  }, [QUALS, sortBy]);

  const rows = ordered.filter((r) => {
    if (q) {
      // Several names at once, comma-separated — a first name is enough.
      const hay = (r[0] + " " + r[1]).toLowerCase();
      const words = hay.split(/[^a-z0-9]+/).filter(Boolean);
      const terms = q.toLowerCase().split(",").map((t) => t.trim()).filter(Boolean);
      if (terms.length && !terms.some((t) => hay.includes(t) || words.some((w) => w.startsWith(t)))) return false;
    }
    if (only === "all") return true;
    // Not a band, so it can't be asked of the cells - it is asked of the person.
    if (only === "ticket") return standings.has(keyOf(r));
    if (only === "missing") return colIdxAll.some((i) => missingAt(r, i));
    return colIdxAll.some((i) => {
      const b = bandFor(r[3][i]);
      return b && (only === "attention"
        ? ["red", "orange", "not"].includes(b.key)
        : b.key === only);
    });
  });

  const colIdx = onlyTracked
    ? colIdxAll.filter((i) => rows.some((r) => String((r[3] || [])[i] || "").trim() !== ""))
    : colIdxAll;

  // The open row, if it is still on the table. Filtering it out closes the
  // panel rather than leaving a name on screen that the table no longer shows.
  const pickedRow = rows.find((r) => keyOf(r) === picked) || null;

  const tally = { red: 0, orange: 0, green: 0, missing: 0 };
  QUALS.rows.forEach((r) => r[3].forEach((v, i) => {
    const b = bandFor(v);
    if (b && tally[b.key] !== undefined) tally[b.key]++;
    if (missingAt(r, i)) tally.missing++;
  }));

  const chip = (label, colour, n, key) => (
    <button className="um-btn"
      onClick={() => {
        const turningOn = only !== key;
        setOnly(turningOn ? key : "all");
        // Filtering happens below the fold, so a press that changes the list
        // also goes to it — otherwise the button reads as doing nothing.
        if (turningOn) {
          setTimeout(() => {
            const el = document.getElementById("matrix-grid");
            if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
          }, 60);
        }
      }}
      style={{ background: only === key ? colour : "transparent", color: only === key ? "#fff" : colour,
        border: `1px solid ${colour}`, borderRadius: 2, padding: "8px 12px", fontSize: 11, fontWeight: 700 }}>
      {n} · {label}
    </button>
  );

  // A missing cell as a report line: the code and title, marked Missing —
  // the same rule as the grid's cell and the Missing button (missingAt).
  const missingItemsFor = (row) => QUALS.cols
    .map((c, i) => (missingAt(row, i)
      ? { code: c[0], title: c[1], group: c[2], band: { key: "not", fg: T.bRed, bg: T.bRedBg, text: "Missing" } }
      : null))
    .filter(Boolean);

  if (report && report.startsWith("crew")) {
    return <CrewReport only={report === "crew" ? null : report.slice(5)}
      missingItemsFor={missingItemsFor} onClose={() => setReport(null)} />;
  }
  if (report === "individual") return <IndividualReport onClose={() => setReport(null)} />;

  return (
    <div>
      <SectionHead title="Crew Matrix" />

      {admin && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 13, alignItems: "center" }}>
          <Field label="Take a crew member off the portal">
            <select className="um-in" value={leaving ? leaving.name : ""}
              onChange={(e) => setLeaving(e.target.value ? { name: e.target.value } : null)}>
              <option value="">Choose…</option>
              {QUALS.rows.map((r) => (
                <option key={r[0]} value={r[0]}>{r[0]}{r[1] ? " — " + r[1] : ""}</option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {admin && leaving && (() => {
        const held = (certificates || []).filter((c) =>
          String(c.person || "").toUpperCase().replace(/[^A-Z]/g, "")
          === leaving.name.toUpperCase().replace(/[^A-Z]/g, "")).length;
        const swings = ((rosterPlan && rosterPlan.rows) || []).filter((r) =>
          String(r.name || "").toUpperCase().replace(/[^A-Z]/g, "")
          === leaving.name.toUpperCase().replace(/[^A-Z]/g, "")).length;
        return (
          <div style={{ position: "fixed", left: "50%", top: 110, transform: "translateX(-50%)", zIndex: 90,
            background: T.panel, border: "1px solid " + T.rule, borderTop: "4px solid " + T.bRed,
            borderRadius: 3, padding: "16px 20px", boxShadow: "0 6px 24px rgba(18,41,61,0.25)",
            width: "min(620px, 94vw)" }}>
            <div style={{ fontFamily: T.display, fontSize: 15, fontWeight: 700, color: T.bRed, marginBottom: 8 }}>
              Take {leaving.name} off the portal?
            </div>
            <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.7, marginBottom: 14 }}>
              They come off the crew matrix{swings ? ", off " + swings + " swing" + (swings === 1 ? "" : "s") + " on the roster" : ""},
              off the crew list the swing board is built from, and their one-off swing changes and renewal notes go with them.
              {held > 0 && <> Their {held} certificate{held === 1 ? "" : "s"} {held === 1 ? "is" : "are"} archived, not destroyed — the Admin tab can fetch {held === 1 ? "it" : "them"} back.</>}
              {swings > 0 && <> Press Save roster on the Roster tab afterwards to write the swings back to the spreadsheet.</>}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button writes variant="solid" onClick={() => { removeCrew(leaving.name); setLeaving(null); }}>
                Yes, take them off
              </Button>
              <Button variant="quiet" onClick={() => setLeaving(null)}>No</Button>
            </div>
          </div>
        );
      })()}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 11 }}>
        <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted,
          textTransform: "uppercase", letterSpacing: "0.08em" }}>Sort by</span>
        <NameSelect value={sortBy} onPick={setSortBy} width={230} options={[
          { value: "rank", label: "Rank" },
          { value: "name", label: "Surname" },
          { value: "sheet", label: "As the spreadsheet has it" },
        ]} />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 13 }}>
        {chip("expired or within " + RED_DAYS + " days", T.bRed, tally.red, "red")}
        {chip(RED_DAYS + "-" + AMBER_DAYS + " days", T.bOrange, tally.orange, "orange")}
        {chip("beyond " + AMBER_DAYS + " days", T.bGreen, tally.green, "green")}
        {chip("missing", T.bRed, tally.missing, "missing")}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <input className="um-in" style={{ flex: 1, minWidth: 200 }} value={q}
          onChange={(e) => setQ(e.target.value)} placeholder="Search crew or position" />
        <Button variant={only === "attention" ? "solid" : "quiet"}
          onClick={() => setOnly(only === "attention" ? "all" : "attention")}>
          Needs attention
        </Button>
        <Button variant={onlyTracked ? "solid" : "quiet"}
          title="Hide the columns that don't apply to anybody shown — search one person and the grid collapses to just their items"
          onClick={() => setOnlyTracked(!onlyTracked)}>
          Only their items
        </Button>
        {/* Only offered when there is somebody to show. On a matrix where every
            position and ticket line up the button would filter to nothing. */}
        {offTicket.length > 0 && (
          <Button variant={only === "ticket" ? "solid" : "quiet"}
            title="Crew filling a job the ticket on the matrix does not cover"
            onClick={() => setOnly(only === "ticket" ? "all" : "ticket")}>
            Position differs from ticket · {offTicket.length}
          </Button>
        )}
      </div>

      <div style={{ marginBottom: 20 }}>
        <Choices value={group} onPick={setGroup} options={groups} compact />
      </div>

      {/* The gaps list — expired, not held, unconfirmed, with the renewal
          marks against each — opens under Needs attention for management.
          It was an Admin page of its own, showing the same trouble the
          filter shows a second way. Crew get the filter alone: the marks
          are the office's notes about people's tickets. */}
      {admin && only === "attention" && (
        <div style={{ marginBottom: 20 }}><CertChecker query={q} /></div>
      )}

      {/* The grid works out what it asks of somebody from their position alone,
          so a person working in a position their ticket isn't for is read against
          the wrong set of requirements — and nothing on the grid used to say so.
          Now their name carries it, in a colour that is nothing to do with a
          date falling due. */}
      {offTicket.length > 0 && (
        <div style={{ background: T.violetBg, border: `1px solid ${T.violet}`, borderLeft: `3px solid ${T.violet}`,
          borderRadius: 2, padding: "11px 13px", marginBottom: 16 }}>
          <div style={{ marginBottom: 5 }}><Eyebrow color={T.violet}>Position and ticket</Eyebrow></div>
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.65 }}>
            {offTicket.length} of {QUALS.rows.length} crew are filling a job the ticket on the matrix does
            not cover. Their names are marked in violet below. What the matrix asks of somebody is worked out
            from their position, so a ticket that does not reach the position is read against the wrong set of
            requirements. Press a name to read which ticket it is. Whether a person may fill a position is the
            office's call on the vessel's manning approval — this only says the two do not line up.
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div id="matrix-grid"><Empty>No crew match that filter.</Empty></div>
      ) : (
        <div className="um-matrix" id="matrix-grid" ref={frame}>
          <table style={{ width: MX_NAME_W + colIdx.length * MX_COL_W, minWidth: "100%", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: MX_NAME_W }} />
              {colIdx.map((i) => <col key={i} style={{ width: MX_COL_W }} />)}
              {/* Takes whatever width is left over when the items don't fill the
                  frame, so no real column is ever stretched. */}
              <col />
            </colgroup>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "5px 8px 5px 7px" }}>
                  <Eyebrow>Crew</Eyebrow>
                </th>
                {colIdx.map((i) => (
                  <th key={i} style={{ padding: "4px 3px", verticalAlign: "bottom" }}>
                    <div style={{ fontFamily: T.mono, fontSize: 8.5, color: T.accent }}>{QUALS.cols[i][0]}</div>
                    {/* Narrower columns leave less room per line, so the label is
                        given four lines instead of two to make up for it. The full
                        title is on hover either way. */}
                    <div title={QUALS.cols[i][1]} style={{ fontFamily: T.display, fontSize: 8.5, fontWeight: 700,
                      letterSpacing: "0.03em", textTransform: "uppercase", color: T.muted, lineHeight: 1.2,
                      maxHeight: 44, overflow: "hidden", overflowWrap: "break-word" }}>
                      {QUALS.cols[i][1].length > 36 ? QUALS.cols[i][1].slice(0, 35) + "\u2026" : QUALS.cols[i][1]}
                    </div>
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isPicked = keyOf(r) === picked;
                const stand = standings.get(keyOf(r)) || null;
                return (
                <tr key={r[0] + r[2]} className="um-row">
                  {/* Name only, and the name is the way into the person: pressing
                      it opens everything held against them under the table, and
                      pressing it again closes it. The position used to sit under
                      the name and doubled the height of every row - it is in the
                      panel now, and searching by position still works.

                      This column is sticky and paints over the grid as it scrolls
                      underneath, so it has to stay opaque - hence T.panel rather
                      than transparent when the row isn't the open one. Its right
                      hand rule is repeated here because an inline shadow replaces
                      the stylesheet's outright. */}
                  <td style={{ padding: "3px 8px 3px 7px", borderBottom: `1px solid ${T.rule}`,
                    background: isPicked ? T.raised : stand ? T.violetBg : T.panel,
                    boxShadow: isPicked
                      ? `inset -1px 0 0 ${T.rule}, inset 3px 0 0 ${T.accent}`
                      : stand
                        ? `inset -1px 0 0 ${T.rule}, inset 3px 0 0 ${T.violet}`
                        : `inset -1px 0 0 ${T.rule}` }}>
                    <button className="um-btn" title={stand ? stand.note : `Certificates held by ${r[0]}`}
                      onClick={() => setPicked(isPicked ? "" : keyOf(r))}
                      style={{ background: "transparent", padding: 0, width: "100%", textAlign: "left",
                        letterSpacing: 0, textTransform: "none", cursor: "pointer", display: "block" }}>
                      <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                        <div style={{ flex: 1, minWidth: 0, fontFamily: T.body, fontSize: 11.5, fontWeight: 600,
                          color: isPicked ? T.accent : T.text,
                          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r[0]}</div>
                        {/* The column is 184px and the names already run out of it,
                            so the mark is a dot rather than a word - which ticket
                            it is, and what it means, is in the panel and on hover.
                            Only a ticket that does not reach the position is marked,
                            so there is one kind of dot and it is always filled. */}
                        {stand && (
                          <span aria-label={stand.label} style={{ flex: "0 0 auto", width: 8, height: 8,
                            borderRadius: "50%", border: `1.5px solid ${T.violet}`, background: T.violet }} />
                        )}
                      </div>
                    </button>
                  </td>
                  {colIdx.map((i) => {
                    const url = String(r[3][i] || "").trim()
                      ? certLinkFor(certDates, certificates, r[0], QUALS.cols[i][0])
                      : null;
                    return (
                    <td key={i} style={{ padding: "2px", borderBottom: `1px solid ${T.rule}`, textAlign: "center",
                      background: isPicked ? T.raised : "transparent" }}>
                      <Cell value={r[3][i]}
                        cover={certCoverFor(certDates, r[0], QUALS.cols[i][0])}
                        missing={missingAt(r, i)}
                        onOpen={url ? () => setCellScan({ url, person: r[0], code: QUALS.cols[i][0], title: QUALS.cols[i][1] }) : undefined} />
                    </td>
                    );
                  })}
                  <td style={{ borderBottom: `1px solid ${T.rule}`, background: isPicked ? T.raised : "transparent" }} />
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Whoever is open, under the table where it was asked for. A name that
          the search or the band filter has taken off screen closes the panel
          with it, so what is open always matches what is on the table. */}
      {pickedRow && (
        <div ref={detail}>
          <MatrixPerson row={pickedRow} onClose={() => setPicked("")} />
        </div>
      )}

      <div style={{ display: "flex", gap: 18, marginTop: 22, flexWrap: "wrap" }}>
        {[["Expired or within " + RED_DAYS + " days", T.bRed],
          [RED_DAYS + " to " + AMBER_DAYS + " days", T.bOrange],
          ["More than " + AMBER_DAYS + " days", T.bGreen]].map(([l, c]) => (
          <span key={l} style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: T.body, fontSize: 13, color: T.muted }}>
            <span style={{ width: 11, height: 11, background: c, borderRadius: 2 }} /> {l}
          </span>
        ))}
        <span style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: T.body, fontSize: 13, color: T.muted }}>
          <span style={{ width: 22, height: 11, borderRadius: 2, border: `1px solid ${T.hatchLine}`,
            backgroundImage: `repeating-linear-gradient(45deg, ${T.hatchLine} 0 1.5px, ${T.hatchBg} 1.5px 5px)` }} />
          Not required for that position
        </span>
        {/* The last two say nothing about a date, which is why they are a colour
            the four bands above them don't use. */}
        <span style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: T.body, fontSize: 13, color: T.muted }}>
          <span style={{ width: 11, height: 11, borderRadius: "50%", background: T.violet,
            border: `1.5px solid ${T.violet}` }} />
          Ticket does not cover the position worked
        </span>
        <span style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: T.body, fontSize: 13, color: T.muted }}>
          <span style={{ width: 11, height: 11, borderRadius: "50%", background: T.panel,
            border: `1.5px solid ${T.violet}` }} />
          Holds a higher ticket than the position
        </span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 18, marginBottom: 30, alignItems: "center" }}>
        {/* Report ▾ alone. Update matrix and the matrix spreadsheet came off
            this page on 26 Sep 2026 at Matthew's word: Update matrix sits on
            Admin → Documents, where the certificates go up, and the office's
            workbook is opened or replaced there (the Training matrix card) and
            written by the hour. The reports write the matrix out as it stands
            — nothing read, no date moved. */}
        <Button onClick={() => setReportMenu(!reportMenu)}>{reportMenu ? "Report ▴" : "Report ▾"}</Button>
        {reportMenu && (
          <>
            <Button variant="quiet" onClick={() => { setReportMenu(false); setReport("individual"); }}>Individual</Button>
            <Button variant="quiet" onClick={() => { setReportMenu(false); setReport("crew"); }}>All crew</Button>
            <Button variant="quiet" onClick={() => { setReportMenu(false); setReport("crew-red"); }}>Expired or within {RED_DAYS} days</Button>
            <Button variant="quiet" onClick={() => { setReportMenu(false); setReport("crew-orange"); }}>{RED_DAYS}-{AMBER_DAYS} days</Button>
            <Button variant="quiet" onClick={() => { setReportMenu(false); setReport("crew-green"); }}>Beyond {AMBER_DAYS} days</Button>
            <Button variant="quiet" onClick={() => { setReportMenu(false); setReport("crew-missing"); }}>Missing</Button>
          </>
        )}
      </div>

      {/* floats above everything, pinned to the bottom of the screen */}
      <FloatingBar frame={frame} />

      {cellScan && (
        <CertViewer url={cellScan.url} person={cellScan.person} code={cellScan.code}
          title={cellScan.title}
          filename={((certificates || []).find((c) => c.url === cellScan.url) || {}).filename}
          onClose={() => setCellScan(null)} />
      )}
    </div>
  );
}

/**
 * The file the portal hands out and files, however it has to be made.
 *
 * The workbook on file is updated in place wherever there is one to update, so
 * what comes out is the same document with new figures in it. Where there
 * isn't — nothing filed yet, a spreadsheet in a format that isn't a workbook,
 * or a workbook this can't safely write into — it falls back to building one
 * from the matrix, and says so, because a plain grid of dates handed to
 * somebody expecting their own spreadsheet is worth a sentence on screen.
 */
async function latestMatrixFile(quals, on, certSheet) {
  const filename = `${on.replace(/-/g, "")} - CREW QUALIFICATION EXPIRY (portal).xlsx`;
  const zippable = certSheet && certSheet.url && /\.xls[xm]$/i.test(certSheet.filename || "");

  let rebuilt = "";
  if (!certSheet || !certSheet.url) {
    rebuilt = "No spreadsheet is filed on the portal yet, so this one was built from the matrix.";
  } else if (!zippable) {
    rebuilt = `${certSheet.filename} isn't an .xlsx, so it couldn't be updated in place and this was built from the matrix.`;
  } else if (!zipCapable()) {
    rebuilt = "This browser can't open the workbook on file, so the spreadsheet was built from the matrix instead. Chrome, Edge, Firefox or Safari will update the workbook itself.";
  } else {
    try {
      const res = await fetch(certSheet.url);
      if (!res.ok) throw new Error(`it couldn't be downloaded (${res.status})`);
      const buf = await res.arrayBuffer();
      const { blob, report } = await updateFiledWorkbook(buf, quals);
      // Nothing moved, so the file already on the portal is the file — handing
      // the original bytes straight back keeps it exactly what it was, which is
      // also what lets the portal notice there is nothing new to file.
      const bytes = blob || new Blob([buf], { type: XLSX_MIME });
      return { file: new File([bytes], filename, { type: XLSX_MIME }), filename, report: { ...report, rebuilt: "" } };
    } catch (e) {
      rebuilt = `${certSheet.filename} couldn't be updated in place, so the spreadsheet was built from the matrix and its formatting, formulas and other sheets aren't carried over. ${e.message || e}`;
    }
  }

  const XLSX = await loadXLSX();
  return {
    file: new File([buildMatrixWorkbook(XLSX, quals, on)], filename, { type: XLSX_MIME }),
    filename,
    report: { rebuilt, sheet: "CREW EXPIRY", written: 0, formulas: 0, addedRows: [], skippedRows: [], skippedCols: [] },
  };
}

/**
 * What the update did to the workbook, in a sentence or two.
 *
 * Whoever presses the button is answerable for the spreadsheet afterwards, so
 * the parts of it the portal couldn't reach are said plainly rather than left
 * to be found in a month.
 */
function workbookNotes(report) {
  if (!report) return [];
  if (report.rebuilt) return [report.rebuilt];

  const notes = [];
  if (report.written) {
    notes.push(`The spreadsheet on file was updated in place — its colours, formulas, column widths and every other sheet in it are exactly as they were, with ${report.written} ${report.written === 1 ? "cell" : "cells"} changed on "${report.sheet}".`);
  } else {
    notes.push(`Nothing on "${report.sheet}" needed changing, so the spreadsheet on file was left exactly as it is.`);
  }
  if (report.formulas) {
    notes.push(`${report.formulas} of those ${report.formulas === 1 ? "cell held a formula, which has been replaced by the date the certificate gives" : "cells held formulas, which have been replaced by the dates the certificates give"}. Every other formula in the workbook is untouched and is worked out again when it is opened.`);
  }
  if (report.addedRows && report.addedRows.length) {
    notes.push(`${report.addedRows.join(", ")} had no row on the spreadsheet, so ${report.addedRows.length === 1 ? "one was" : "rows were"} added under the last crew member, formatted like the row above. Anything that column works out for itself is left blank on ${report.addedRows.length === 1 ? "it" : "them"}.`);
  }
  if (report.skippedRows && report.skippedRows.length) {
    notes.push(`${report.skippedRows.join(", ")} ${report.skippedRows.length === 1 ? "has no row" : "have no rows"} on the spreadsheet, and the sheet holds no crew rows at all to pattern a new one on, so ${report.skippedRows.length === 1 ? "that person's dates were" : "those dates were"} not written into it.`);
  }
  if (report.skippedCols && report.skippedCols.length) {
    notes.push(`The spreadsheet has no column for ${report.skippedCols.join(", ")}, so ${report.skippedCols.length === 1 ? "that item was" : "those items were"} not written into it. Add the ${report.skippedCols.length === 1 ? "column" : "columns"} to the spreadsheet and press this again.`);
  }
  return notes;
}

/**
 * The matrix written back out as a spreadsheet, built from nothing.
 *
 * This is the fallback, not the usual path: where there is a workbook on file
 * the update is made to that workbook, so it keeps its colours, its formulas
 * and its other sheets. This one is for the case where there is nothing on file
 * to update, or what is on file can't be opened — a plain grid is better than
 * no spreadsheet, and the screen says which one was handed out.
 *
 * It is laid out the way the workbook the portal reads is laid out — codes on
 * row 14, titles on row 15, crew from row 16, names in column B — so the file
 * this hands out is a file the portal can read back in. A spreadsheet that
 * comes out of the portal and can't go back into it is a dead end, and an admin
 * would find that out a month later.
 */
function buildMatrixWorkbook(XLSX, quals, at) {
  const width = 4 + quals.cols.length;
  const blank = () => new Array(width).fill(null);

  const aoa = [];
  for (let i = 0; i < 13; i++) aoa.push(blank());

  aoa[0][1] = `${VESSEL.name} ${VESSEL.nameAccent} — CREW QUALIFICATION EXPIRY`;
  aoa[1][1] = `Generated from the crew portal on ${fmtDate(at)}`;
  aoa[2][1] = "Built from the certificates on file and the review of the differences against the previous spreadsheet.";
  aoa[3][1] = "Dates are the expiry date. Y is held with no expiry, N is not held, OPEN is a module still to be done, ? is unconfirmed, blank is not required.";

  // Row 14 (index 13) is the row the portal looks for the item codes on.
  const codes = blank();
  codes[1] = "NAME";
  codes[2] = "POSITION";
  codes[3] = "SAM #";
  quals.cols.forEach((c, i) => { codes[4 + i] = c[0]; });
  aoa.push(codes);

  const titles = blank();
  titles[1] = "Crew member";
  titles[2] = "Position";
  titles[3] = "SAM number";
  quals.cols.forEach((c, i) => { titles[4 + i] = c[1]; });
  aoa.push(titles);

  quals.rows.forEach((r, n) => {
    const row = blank();
    row[0] = n + 1;
    row[1] = r[0];
    row[2] = r[1];
    row[3] = r[2];
    (r[3] || []).forEach((v, i) => { row[4 + i] = v == null || v === "" ? null : v; });
    aoa.push(row);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 5 }, { wch: 28 }, { wch: 24 }, { wch: 11 },
    ...quals.cols.map(() => ({ wch: 12 }))];

  const wb = XLSX.utils.book_new();
  // The name carries "CREW EXPIRY" because that is the sheet the portal reaches
  // for when a workbook holds more than one.
  XLSX.utils.book_append_sheet(wb, ws, "CREW EXPIRY");

  return new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })], { type: XLSX_MIME });
}

/**
 * Read every certificate on file that hasn't been read yet.
 *
 * Reading fifty scans takes far longer than one request is allowed to run, so the
 * server reads a few at a time and remembers each reading. This asks for the next
 * few until nothing is left unread, which is also what makes a lost connection
 * cost the batch it was in rather than the whole run. `onPhase` is called as it
 * goes so a screen can show where it is up to.
 *
 * Both things that need the certificates read start here — the comparison against
 * our own spreadsheets, and the comparison against the OPMS export — and because
 * every reading is kept, the second of the two to run pays for nothing.
 */
async function readCertificates({ quals, fresh, onPhase = () => {} }) {
  // Held out here so a run that stops partway can say how far it got.
  const progress = { read: 0, total: 0, remaining: 1 };

  if (fresh) {
    onPhase({ phase: "clearing", read: 0, total: 0 });
    await analyse({ action: "reset" });
  }

  onPhase({ phase: "reading", read: 0, total: 0 });
  let guard = 0;
  while (progress.remaining > 0) {
    if (guard++ > 500) throw new Error("Stopped after 500 batches - something is wrong on the server.");
    const r = await analyse({ action: "extract", cols: quals.cols, limit: 3 });
    progress.read = r.read; progress.total = r.total; progress.remaining = r.remaining;
    onPhase({ phase: "reading", read: r.read, total: r.total });
    // The batch says when the reading cannot go on - the account out of
    // credit, the key refused, the model busy - in one short sentence,
    // which is what the window and the badge show.
    if (r.stopped) throw new Error(r.stopped.line);
    // A batch that got through none of what it tried is not slow progress, it is
    // a wall - the model is unreachable or over its limit. Stop and say so
    // rather than sit in the loop for ten minutes.
    if (r.remaining > 0 && r.extracted === 0) {
      const why = (r.failures && r.failures[0] && r.failures[0].error) || "";
      throw new Error(`${r.read} of ${r.total} certificates were read, then the reading stopped. ${why}`.trim());
    }
  }

  return progress;
}

/**
 * Three copies of the matrix, brought back to one.
 *
 * When a save lands on top of somebody else's, this tab used to take the
 * server's copy and lay its own whole matrix back over it - so a tab that had
 * changed one cell ten minutes ago wrote its ten-minute-old matrix over every
 * cell anyone had filled in since. Now the tab remembers the matrix it last
 * loaded or saved (base) and writes back only what it actually changed:
 * theirs, with every cell where mine differs from base overwritten by mine.
 *
 * Rows are matched by name the way the register compares them and columns by
 * code, so a moved column or a respelt name on one side doesn't read as a wall
 * of changes. A row mine added that base never had is appended, and nothing
 * of theirs is taken away. A cell mine changed on a row theirs no longer has
 * has nowhere to land - taking a man off the matrix is a deliberate act, and
 * a date typed against him is not a reason to put him back.
 */
function mergeQuals(base, mine, theirs) {
  const shape = (q) => ({
    cols: Array.isArray(q && q.cols) ? q.cols : [],
    rows: Array.isArray(q && q.rows) ? q.rows : [],
  });
  const b = shape(base), m = shape(mine), t = shape(theirs);
  const byName = (q) => new Map(q.rows.map((r) => [nameLetters(r[0]), r]));
  const byCode = (q) => new Map(q.cols.map((c, i) => [String(c[0]), i]));
  const bRows = byName(b), tRows = byName(t);
  const bCols = byCode(b), mCols = byCode(m), tCols = byCode(t);
  const cell = (row, at) =>
    row && at !== undefined && Array.isArray(row[3]) && row[3][at] != null ? String(row[3][at]) : "";
  const field = (row, i) => (row && row[i] != null ? String(row[i]) : "");

  // Theirs is the shape of the answer. A column mine added that neither base
  // nor theirs has is kept on the end, and every row is widened to fit it.
  const cols = t.cols.slice();
  m.cols.forEach((c) => {
    if (!bCols.has(String(c[0])) && !tCols.has(String(c[0]))) cols.push(c);
  });
  const outCols = byCode({ cols });
  const widened = cols.length !== t.cols.length;
  const rows = t.rows.map((r) => {
    if (!widened) return r;
    const cells = (Array.isArray(r[3]) ? r[3] : []).slice();
    while (cells.length < cols.length) cells.push("");
    return [r[0], r[1], r[2], cells];
  });
  const rowAt = new Map(rows.map((r, i) => [nameLetters(r[0]), i]));

  // Copy a row of theirs the first time something is written into it, so a
  // row nothing touched is still the very object the server sent.
  const written = new Set();
  const own = (i) => {
    if (written.has(i)) return rows[i];
    const r = rows[i].slice();
    r[3] = (Array.isArray(r[3]) ? r[3] : []).slice();
    while (r[3].length < cols.length) r[3].push("");
    rows[i] = r;
    written.add(i);
    return r;
  };

  m.rows.forEach((mr) => {
    const key = nameLetters(mr[0]);
    if (!key) return;
    const br = bRows.get(key);
    const at = rowAt.get(key);

    if (at === undefined) {
      // Theirs has no such man. Mine added him: he goes on the end, his cells
      // put under the answer's columns by code. Otherwise theirs took him off
      // and he stays off.
      if (br || !tRows.has(key)) {
        if (br) return;
        rows.push([mr[0], mr[1], mr[2], cols.map((c) => cell(mr, mCols.get(String(c[0]))))]);
      }
      return;
    }

    // The same man on both sides: only what mine changed against base lands.
    if (field(mr, 1) !== field(br, 1)) own(at)[1] = mr[1];
    if (field(mr, 2) !== field(br, 2)) own(at)[2] = mr[2];
    m.cols.forEach((c) => {
      const code = String(c[0]);
      const was = cell(br, bCols.get(code));
      const now = cell(mr, mCols.get(code));
      if (now === was) return;
      const to = outCols.get(code);
      if (to === undefined) return;
      own(at)[3][to] = now;
    });
  });

  return { ...(theirs && typeof theirs === "object" ? theirs : {}), cols, rows };
}

/**
 * A save that landed on top of somebody else's, worked out again.
 *
 * Theirs is the shape of the answer, and only the slices this tab touched
 * go back over it. Some of those slices the round on the hour writes too -
 * the matrix, the change log, the note of cells filled from a certificate,
 * its sightings and what it owes the workbook, and each man's MSIC number
 * and date of birth with its note of what it put there - so laid back whole they
 * would write the tab's stale copy over the hour's work. Each is merged
 * against what this tab last loaded or saved (base) instead: mergeQuals for
 * the matrix, and the merges beside it in source/shared/matrix-rules.js for
 * the rest. The document's stamp is the newer of the two.
 *
 * One pure function, so the rule the provider's save loop follows can be
 * proved outright (tools/client-rules.test.mjs).
 */
function mergeSaved({ touched, mine, theirs, base }) {
  const t = theirs && typeof theirs === "object" ? theirs : null;
  // A collision with nothing on the other side (the server's document has
  // gone) has nothing to merge against: mine goes up whole. Running the
  // merges against an empty document would take every note this tab held.
  if (!t) return { ...mine };
  const b = base || {};
  const merged = { ...t };
  touched.forEach((k) => { merged[k] = mine[k]; });
  if (touched.includes("quals") && t.quals) {
    merged.quals = mergeQuals(b.quals, mine.quals, t.quals);
  }
  if (touched.includes("history")) {
    merged.history = mergeHistory(b.history, mine.history || [], t.history || [], HISTORY_LIMIT);
  }
  if (touched.includes("filledFromCert")) {
    merged.filledFromCert = mergeFilled(b.filled, mine.filledFromCert || {}, t.filledFromCert || {});
  }
  if (touched.includes("orphanSeen")) {
    merged.orphanSeen = mergeSeen(b.seen, mine.orphanSeen || {}, t.orphanSeen || {});
  }
  if (touched.includes("workbookPending")) {
    merged.workbookPending = mergePending(b.pending, mine.workbookPending || [], t.workbookPending || []);
  }
  // The round fills each man's MSIC number and date of birth from his
  // certificates. A tab that changed somebody's rank meanwhile carries the
  // whole crew list, boxes and all: laid back whole it would empty the
  // round's fill, and a box put back to an old card's number would read as
  // typed and hold the new card off. So the two boxes come from theirs
  // wherever this tab did not change them (mergeParticulars).
  if (touched.includes("people") && Array.isArray(t.people) && Array.isArray(b.people)) {
    merged.people = mergeParticulars(b.people, mine.people, t.people);
  }
  if (touched.includes("particularsFromCert")) {
    merged.particularsFromCert = mergeFilled(b.particulars, mine.particularsFromCert || {}, t.particularsFromCert || {});
  }
  // ISO stamps compare as text; whichever side moved the document last is right.
  const ours = String(mine.lastDocUpdate || ""), theirStamp = String(t.lastDocUpdate || "");
  merged.lastDocUpdate = (ours > theirStamp ? ours : theirStamp) || null;
  return merged;
}

/**
 * What the tab holds once a merged save has landed: the merged copy, with
 * any slice edited while it was in the air laid back over it - against the
 * copy the first save carried, not against what the tab had loaded before
 * the collision. The edits were built on the carried copy, so that is the
 * base they differ from; measured against the older copy instead, an edit
 * that put a cell back to what it was showed no change at all and was
 * dropped, the cell springing back on screen to the first save's value and
 * a cell the tab had crossed off its note coming back on. Only what those
 * edits changed lands, a cell put back to what it was included.
 *
 * `now` is the tab's copy as it stands, `merged` the copy that landed,
 * `carried` the copy the first save went up with, `inFlight` the slices
 * edited since. Pure, so the rule can be proved outright
 * (tools/client-rules.test.mjs).
 */
function afterMergedSave(now, merged, carried, inFlight) {
  if (!inFlight.length) return { ...merged };
  return mergeSaved({
    touched: inFlight, mine: now, theirs: merged,
    base: { quals: carried.quals, filled: carried.filledFromCert, seen: carried.orphanSeen,
      pending: carried.workbookPending, history: carried.history,
      people: carried.people, particulars: carried.particularsFromCert },
  });
}

/* Whether the name a document was filed under is the wanted name with a
   " (2)" on it. The replace steps round a name that is taken - by the
   office's own workbook kept in place, a removed copy, or a file in the
   folder on no row - by filing under the next suffix, and that is the
   document's name then. Renaming it back would write the new file over
   whatever holds the name, so the round on the hour accepts the suffix and
   the page does the same. */
function filedUnderSuffix(wanted, actual) {
  const dot = wanted.lastIndexOf(".");
  const base = dot > 0 ? wanted.slice(0, dot) : wanted;
  const ext = dot > 0 ? wanted.slice(dot) : "";
  return actual.startsWith(base + " (") && actual.endsWith(")" + ext)
    && /^\d+$/.test(actual.slice(base.length + 2, actual.length - ext.length - 1));
}

/**
 * The matrix as a spreadsheet: a report built from the matrix as it stands.
 *
 * The same file either way (latestMatrixFile): the workbook on the portal
 * with today's figures written into it, or a grid built from nothing where
 * there is no workbook to update. Matrix spreadsheet downloads it and opens
 * it, for anybody - the file is handed to a new tab as well as to the
 * downloads, so the browser opens it with whatever reads spreadsheets on
 * the machine. File the matrix spreadsheet, admin only, files it on the
 * portal in place of the one there - when there is something new to file
 * (fileSpreadsheetSend): the same bytes again are said, not filed. Neither
 * reads a certificate or moves a date: that is Update matrix's, and the
 * round's, and so the swing report's "matrix fresh" stamp is the round's
 * and the filing leaves it be (fileSpreadsheetOutcome). The replace takes
 * the server's lease, so the filing stands down while a round has it
 * (roundBusyTitle) and waits once for a 409 (fileSpreadsheetAttempt),
 * saying so on the button while it does.
 */
function MatrixSpreadsheet({ variant = "quiet" }) {
  const { admin, role, quals: QUALS, certSheet, setCertSheet, setCertAnalysis, log,
    roundRunning, roundHolder, setRoundRunning, offlineAt } = usePortal();
  const [busy, setBusy] = useState("");     // "" | "download" | "file" | "wait"
  const [err, setErr] = useState("");
  const [notes, setNotes] = useState([]);   // workbookNotes, or the one line a rebuilt download gets
  const [filed, setFiled] = useState(null); // the record filed, for the link under the row

  const download = async () => {
    setErr(""); setNotes([]); setFiled(null);
    setBusy("download");
    // Opened inside the click itself, so the popup blocker sees a window the
    // user asked for - by the time the workbook is built the click is history.
    const opened = window.open("", "_blank");
    try {
      const { file, filename, report } = await latestMatrixFile(QUALS, todayISO(), certSheet);
      const url = URL.createObjectURL(file);

      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();

      if (opened) opened.location = url;
      setNotes(report && report.rebuilt ? [{ text: report.rebuilt, warn: true }] : []);
      log("Crew Matrix", "Downloaded the latest matrix", filename);
    } catch (e) {
      if (opened) opened.close();
      setErr(`The matrix couldn't be downloaded. ${e.message || String(e)}`);
    }
    setBusy("");
  };

  const file = async () => {
    setErr(""); setNotes([]); setFiled(null);
    setBusy("file");
    try {
      const on = todayISO();
      const { file: built, report } = await latestMatrixFile(QUALS, on, certSheet);
      if (fileSpreadsheetSend(report) === "same") {
        // Nothing on the matrix has moved since the workbook was filed:
        // these are the bytes already there, so nothing is sent.
        setNotes([{ text: "It is the same file as the one already on the portal, so nothing was filed again.", warn: true }]);
      } else {
        const send = () => uploadCertificateSheet(built, { uploadedBy: role, filedOn: on, session: SESSION }, "replace");
        // Somebody is writing the workbook: the buttons go down under
        // their name, this one says it is waiting, and the send goes
        // once more when the lease is free.
        const res = await fileSpreadsheetAttempt(send, async (refusal) => {
          setBusy("wait");
          setRoundRunning(true, refusal.by);
          await waitForRound(undefined, setRoundRunning);
          setBusy("file");
        });
        const said = fileSpreadsheetOutcome(report, res.record, role);
        setCertSheet(res.record);
        setCertAnalysis(said.patch);
        log("Admin", "Filed the matrix spreadsheet", said.detail);
        setNotes(workbookNotes(report).map((text) => ({ text, warn: !!report.rebuilt })));
        setFiled(res.record);
      }
    } catch (e) {
      setErr(`The matrix spreadsheet couldn't be filed. ${e.message || String(e)}`);
    }
    setBusy("");
  };

  const under = err || notes.length || filed;
  return (
    <>
      <Button variant={variant} onClick={download} disabled={!!busy}>
        {busy === "download" ? "Preparing…" : "Matrix spreadsheet"}
      </Button>
      {admin && (
        <Button variant={variant} writes onClick={file} disabled={!!busy || controlsLocked(offlineAt, roundRunning)}
          title={!busy && controlsLocked(offlineAt, roundRunning) ? (offlineAt ? offlineLine(offlineAt) : roundBusyTitle(roundHolder)) : undefined}>
          {busy === "wait" ? "Waiting for the workbook…" : busy === "file" ? "Filing…" : "File the matrix spreadsheet"}
        </Button>
      )}
      {/* The lines under the row take the whole of the next line of it. */}
      {under && (
        <div style={{ flexBasis: "100%" }}>
          {err && (
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.bRed, lineHeight: 1.6 }}>{err}</div>
          )}
          {filed && (
            <a href={filed.url} download={filed.filename}
              style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, textDecoration: "none" }}>
              {filed.filename}
            </a>
          )}
          {/* What happened to the workbook itself - updated in place, or
              rebuilt, and anything on the matrix it had no room for. */}
          {notes.map((note, i) => (
            <div key={i} style={{ fontFamily: T.body, fontSize: 13, lineHeight: 1.6, marginTop: filed || i ? 6 : 0,
              color: note.warn ? T.bOrange : T.muted }}>
              {note.text}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The training matrix, the skills matrix and the validity periods matrix
//
// Two documents the portal is required to hold at all times: the training matrix,
// which is where the crew's training stands now, and the skills matrix, which is
// what they are required to hold — the items, the shift allocations and the rest of
// what has to be abided by. A third sits with the skills matrix where the office
// keeps it separately: the validity periods matrix, which says how long each item
// lasts once it has been done. None of them says much alone, so the analysis is
// always of them together.
// ---------------------------------------------------------------------------

// Only these can be turned into text in the browser. Anything else is sent to the
// server as the file itself.
const WORKBOOK_EXTS = ["xlsx", "xlsm", "xls", "csv"];

// A workbook read as text runs long, and the server caps what it sends the model
// anyway. Cutting it here as well keeps a document that is mostly blank columns
// from filling the request with commas.
const MAX_MATRIX_CHARS = 60000;

/**
 * A filed matrix turned into text, sheet by sheet, in the browser.
 *
 * A model can't be handed a .xlsx — it is a zip — so the portal opens the workbook
 * where it already has a reader and sends what the sheets say. A PDF or a scan
 * needs none of this: `null` comes back and the server reads the file itself.
 * Anything going wrong here is reported rather than thrown, because a matrix the
 * browser can't parse is still a matrix the server may be able to read.
 */
async function matrixSheetText(record) {
  if (!record || !record.url) return { text: null, problem: "" };

  const ext = (record.filename || "").split(".").pop().toLowerCase();
  if (!WORKBOOK_EXTS.includes(ext)) return { text: null, problem: "" };

  try {
    const XLSX = await loadXLSX();
    const res = await fetch(record.url);
    if (!res.ok) throw new Error(`It couldn't be downloaded (${res.status}).`);
    const wb = XLSX.read(await res.arrayBuffer(), { type: "array", cellDates: true });

    let text = "";
    for (const name of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false, dateNF: "yyyy-mm-dd" });
      if (!csv.trim()) continue;
      text += `### SHEET: ${name}\n${csv}\n\n`;
      if (text.length > MAX_MATRIX_CHARS) break;
    }

    if (!text.trim()) throw new Error("Every sheet in it is empty.");
    return { text: text.slice(0, MAX_MATRIX_CHARS), problem: "" };
  } catch (e) {
    // The server is asked to read the file itself, which for a workbook it can't
    // — so this is said on the page rather than swallowed.
    return { text: null, problem: `${record.filename} couldn't be opened as a workbook. ${e.message || e}` };
  }
}

/**
 * Read the matrices and hold them against one another.
 *
 * A call per document plus one for the comparison, because a whole workbook
 * through a model is more than one request has time for: each document is read and
 * the reading kept, then the readings are compared. The server refuses every one
 * of them unless the training matrix and the skills matrix are both on file. The
 * validity periods matrix is read as well wherever one has been filed, and simply
 * skipped where it hasn't.
 */
async function analyseMatrices({ trainingMatrix, skillsMatrix, validityMatrix, fresh = false, onPhase = () => {} }) {
  const problems = [];

  if (fresh) {
    onPhase({ phase: "clearing" });
    await analyse({ action: "matrix-reset" });
  }

  const documents = [
    ["training", trainingMatrix],
    ["skills", skillsMatrix],
    ["validity", validityMatrix],
  ];

  for (const [which, record] of documents) {
    if (!record) continue;
    onPhase({ phase: which });
    const { text, problem } = await matrixSheetText(record);
    if (problem) problems.push(problem);

    const started = await analyse({ action: "matrix-read", which, text, force: fresh });

    // Same 504-avoiding handoff as the OPMS comparison: a large crew's reading
    // can outrun a single request, so the server hands back a job instead and
    // this waits after it rather than the request itself.
    if (started && started.pending && started.jobId && started.startPath) {
      await startAnalysisWorker(started.startPath, started.jobId);
    }
    if (started && started.pending && started.jobId) {
      await waitForAnalysisJob("matrix-read-job", started.jobId, (waited) =>
        onPhase({ phase: which, waited }));
    }
  }

  onPhase({ phase: "checking" });
  const started = await analyse({ action: "matrix-check", force: fresh });

  if (started && started.pending && started.jobId && started.startPath) {
    await startAnalysisWorker(started.startPath, started.jobId);
  }

  const res = started && started.pending && started.jobId
    ? await waitForAnalysisJob("matrix-check-job", started.jobId, (waited) =>
        onPhase({ phase: "checking", waited }))
    : started;

  return { ...res, problems };
}

// ---------------------------------------------------------------------------
// The OPMS export against our own records
// ---------------------------------------------------------------------------

/**
 * Compare the OPMS spreadsheet with our skills matrix and our certificates.
 *
 * OPMS belongs to somebody else, and when it disagrees with the portal one of the
 * two is wrong. Which one decides who has to fix it, so the answer comes back in
 * two columns: what we have wrong, and what OPMS has wrong. The certificates are
 * what tells them apart — a scan is the document itself, so the side that
 * disagrees with the scan is the side with the mistake.
 *
 * The certificates are read first, because a certificate nobody has read settles
 * nothing. That is the long part of the run; every reading is kept, so a second
 * run, or the certification checker afterwards, pays for none of it again.
 */
async function analyseOPMS({ quals, opmsSheet, fresh = false, onPhase = () => {} }) {
  const problems = [];

  if (fresh) {
    onPhase({ phase: "clearing", read: 0, total: 0 });
    await analyse({ action: "opms-reset" });
  }

  // Not `fresh`: clearing the certificate readings as well would mean reading
  // every scan again to answer a question about a spreadsheet. "Run it again"
  // here means ask the question again, not read the certificates again.
  const progress = await readCertificates({ quals, fresh: false, onPhase });

  onPhase({ phase: "sheet", read: progress.read, total: progress.total });
  const { text, problem } = await matrixSheetText(opmsSheet);
  if (problem) problems.push(problem);

  onPhase({ phase: "comparing", read: progress.read, total: progress.total, waited: 0 });
  const started = await analyse({
    action: "opms-check", cols: quals.cols, rows: quals.rows, text, force: fresh,
  });

  // The comparison itself is one long question over the whole crew, and it runs
  // as a job on the server rather than as the answer to this request — a request
  // that waited for it would be cut off partway and arrive back as a 504 with
  // nothing in it. So the server hands back a job, and we ask after it.
  //
  // Normally the server would set the worker going itself. It can't: a worker
  // can't call itself, and every request has to carry a signed-in session,
  // which a call the server makes to itself has none of. This browser does
  // have one — it is how the page in front of you was fetched — so when the
  // server says it couldn't hand the run over, it is handed over from here.
  if (started && started.pending && started.jobId && started.startPath) {
    await startAnalysisWorker(started.startPath, started.jobId);
  }

  const res = started && started.pending && started.jobId
    ? await waitForAnalysisJob("opms-job", started.jobId, (waited) =>
        onPhase({ phase: "comparing", read: progress.read, total: progress.total, waited }))
    : started;

  return { ...res, problems, progress };
}

/**
 * Set a worker going from the browser, where the server couldn't.
 *
 * A background function answers as soon as it has the request, so an answer in
 * the two hundreds means the run was picked up and anything else means it wasn't
 * — and a job nobody is running is one the portal would otherwise sit and ask
 * after until it gave up minutes later.
 */
async function startAnalysisWorker(path, jobId, what = "comparison") {
  // On the old host this returned in a breath — the background function took
  // the job and answered straight away. On Cloudflare the same request IS the
  // run and stays open until the work is done, so waiting for it here would
  // hold the polling up for the whole run. Give it a moment to fail fast (a
  // bad path, the server unreachable), then let it carry on in the background
  // — the polls read the job record while this request is still open.
  const attempt = fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId }),
  });
  attempt.catch(() => {});
  const soon = await Promise.race([
    attempt.then((r) => r, () => "failed"),
    new Promise((res) => setTimeout(() => res("running"), 1500)),
  ]);
  if (soon === "failed") {
    throw new Error(`The ${what} couldn't be started — the server couldn't be reached. Try again in a moment.`);
  }
  if (soon !== "running" && !soon.ok) {
    throw new Error(`The ${what} couldn't be started (${soon.status}). Try again in a moment.`);
  }
}

// How long to keep asking after a comparison running as a job on the server, and
// how often. The workers are given fifteen minutes and a long run can take
// several of them, so the wait is generous. What it isn't is silent: the panel
// is told how long it has been.
const JOB_WAIT_MS = 14 * 60 * 1000;
const JOB_POLL_MS = 2500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask after a comparison until it has an answer. `pollAction` names the kind of
 * job — "opms-job" or "shift-job".
 *
 * A poll that fails is not a run that failed — the job is on the server either
 * way — so a dropped request is tried again and only several in a row are taken
 * as the connection having gone. The answer comes back exactly as it used to
 * when the comparison was the response to the request itself.
 */
async function waitForAnalysisJob(pollAction, jobId, onWait = () => {}) {
  const startedAt = Date.now();
  let misses = 0;

  while (Date.now() - startedAt < JOB_WAIT_MS) {
    await sleep(JOB_POLL_MS);

    let job;
    try {
      job = await analyse({ action: pollAction, jobId });
      misses = 0;
    } catch (e) {
      if (++misses >= 3) throw e;
      continue;
    }

    if (job.state === "done") {
      if (!job.result) throw new Error("The comparison finished without an answer. Run it again.");
      return job.result;
    }
    if (job.state === "error") {
      throw new Error(job.error || "The comparison stopped without saying why.");
    }

    onWait(Math.round((Date.now() - startedAt) / 1000));
  }

  throw new Error(
    "The comparison is taking longer than it should. It may yet finish on the server — run it again in a few minutes and the answer will be there if it did.",
  );
}

/**
 * Step 2 — read the certificates, hold them against the spreadsheets, and let
 * an admin decide what the spreadsheet should say.
 *
 * The portal holds two accounts of the same thing: a folder of scanned
 * certificates per crew member, and the crew qualification spreadsheet the
 * matrix is built from. They drift apart — a renewal is filed and the
 * spreadsheet isn't touched, or a date is typed a year out — and until now the
 * only way to find the drift was to open fifty PDFs alongside the spreadsheet.
 *
 * So the reading is done for them. A certificate that is plainly at odds with the
 * matrix is taken at its word — uploading one already brings the matrix and the
 * spreadsheet up to date on its own — and what is left over is where the
 * certificates say nothing and the two spreadsheets disagree between themselves.
 * Those are put up as rows to be answered yes or no, and only the rows answered
 * yes are written. The AI reads; an admin decides what it couldn't.
 */
// How long a run has been going, for the window that watches it: "1m 12s".
const elapsedLabel = (secs) =>
  secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;

/**
 * The window a run is watched from.
 *
 * Every analysis on the portal takes minutes and none of them can be hurried, so
 * all three are watched the same way: a window over the page saying how far
 * through it is, how long it has been going and what it is doing at this moment.
 * It can be put away — the run carries on either way, and the line under the
 * buttons still says where it is up to.
 *
 * A run that stopped holds the window open with the reason in it rather than
 * closing on its own, since that is the one thing worth interrupting for.
 */
function AnalysisWindow({
  eyebrow, pct, elapsed, body, note,
  failed = false, message = "", failNote = "",
  onHide, onClose,
}) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(18,41,61,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderRadius: 3,
        padding: 20, width: "100%", maxWidth: 420 }}>

        {failed ? (
          <>
            <div style={{ marginBottom: 5 }}><Eyebrow color={T.bRed}>The analysis stopped</Eyebrow></div>
            <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.7, marginBottom: 12 }}>
              {message}
            </div>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.muted, lineHeight: 1.6, marginBottom: 15 }}>
              {failNote}
            </div>
            <Button onClick={onClose}>Close</Button>
          </>
        ) : (
          <>
            <div style={{ marginBottom: 5 }}><Eyebrow color={T.accent}>{eyebrow}</Eyebrow></div>

            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 12 }}>
              <div style={{ fontFamily: T.display, fontSize: 40, fontWeight: 700, color: T.text, lineHeight: 1 }}>
                {pct}%
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
                {elapsedLabel(elapsed)} elapsed
              </div>
            </div>

            <div className="um-bar" style={{ margin: "14px 0 11px" }}>
              <i style={{ width: `${pct}%` }} />
            </div>

            <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.7 }}>
              {body}
            </div>

            <div style={{ fontFamily: T.body, fontSize: 13, color: T.muted, lineHeight: 1.6, marginTop: 10, marginBottom: 15 }}>
              {note}
            </div>

            <Button variant="quiet" onClick={onHide}>Hide this window</Button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The window over whichever page is open while the round from the page runs
 * (runMatrixRound), and its outcome once it has.
 *
 * The round can be started from any Update matrix button, from the
 * certificate upload, or from Update portal, and the admin may have moved on
 * by the time it lands - so it is watched from here, once, rather than from
 * a window per screen. While it runs the figure is the reading, then the
 * refile, then the server's own percentage and word. A round set going by
 * the certificate upload reports on that screen, under the filing summary,
 * so this window goes when one of those lands; every other origin's outcome
 * is said here and closed by hand.
 */
function UpdateMatrixRun() {
  const { matrixRun: run, clearMatrixRun } = usePortal();
  const [hidden, setHidden] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);

  const running = !!run && run.phase !== "done" && run.phase !== "failed";

  React.useEffect(() => {
    if (!running) {
      // Ready for the next run: its window starts shown, on a fresh clock.
      startedAt.current = 0;
      setHidden(false);
      return;
    }
    if (!startedAt.current) startedAt.current = Date.now();
    const tick = () => setElapsed(Math.round((Date.now() - startedAt.current) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [running]);

  if (!run) return null;

  if (running) {
    if (hidden) return null;
    const part = (n, of) => (of ? Math.min(100, Math.round((n / of) * 100)) : 0);
    const pct = run.phase === "reading" ? part(run.read, run.total)
      : run.phase === "filing" ? part(run.filed, run.toFile)
      : run.phase === "waiting" ? 0
      : run.pct || 0;
    return (
      <AnalysisWindow
        eyebrow="Updating the matrix"
        pct={pct}
        elapsed={elapsed}
        body={<>
          {run.phase === "reading" && (run.total
            ? `${run.read} of ${run.total} certificates read. Only the ones not read before are read now.`
            : "Looking at what is on file.")}
          {run.phase === "filing" && (run.toFile
            ? `Filing each certificate under the person named on it — ${run.filed} of ${run.toFile}.`
            : "Filing each certificate under the person named on it.")}
          {run.phase === "waiting" && "Waiting for the round on the hour"}
          {run.phase === "starting" && (run.word || "Starting")}
        </>}
        note="Leave the page open. Every certificate reading is kept as it is made, so a run that stops partway picks up where it left off rather than starting over."
        onHide={() => setHidden(true)}
      />
    );
  }

  // The certificate upload's screen reports its own round.
  if (run.origin === "certificates") return null;

  if (run.phase === "failed") {
    return (
      <AnalysisWindow
        failed
        message={run.message}
        failNote="Every certificate already read was kept, so running it again carries on from there rather than starting over."
        onClose={clearMatrixRun}
      />
    );
  }

  const o = run.outcome || {};
  const eyebrow = doneEyebrow(o);
  const colour = eyebrow === "Matrix updated" ? T.accent : T.teal;
  const changes = Array.isArray(o.changes) ? o.changes : [];
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(18,41,61,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderLeft: `4px solid ${colour}`, borderRadius: 3,
        padding: 20, width: "100%", maxWidth: 460, maxHeight: "82vh", overflowY: "auto" }}>
        <div style={{ marginBottom: 7 }}>
          <Eyebrow color={colour}>{eyebrow}</Eyebrow>
        </div>
        {doneWindowLines(o).map((line, i) => (
          <React.Fragment key={i}>
            <div style={{ fontFamily: T.body, fontSize: line.tone === "plain" ? 14 : 13, lineHeight: 1.7,
              color: line.tone === "problem" ? T.bOrange : line.tone === "muted" ? T.muted : T.text }}>
              {line.tone === "link" && line.href
                ? <a href={line.href} download={line.download}
                    style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, textDecoration: "none" }}>{line.text}</a>
                : line.text}
            </div>
            {/* The cells the round moved, from → to; a cleared one goes to blank. */}
            {line.changes && changes.length > 0 && (
              <div style={{ margin: "4px 0 8px", maxHeight: 190, overflowY: "auto" }}>
                {changes.map((a, j) => (
                  <div key={j} style={{ display: "flex", justifyContent: "space-between", gap: 12,
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
            )}
          </React.Fragment>
        ))}
        <div style={{ marginTop: 15 }}>
          <Button onClick={clearMatrixRun}>Close</Button>
        </div>
      </div>
    </div>
  );
}


/**
 * Step 3 — the matrices about the crew as a whole, and the set of them held
 * together.
 *
 * The skills matrix is what the crew are required to hold: the items, how many of
 * each every shift has to have, and whatever else has to be abided by. The
 * validity periods matrix is its other half — how long each item stays valid once
 * it has been done, and when it has to be done again. The training matrix is where
 * they actually stand. Kept apart they are spreadsheets nobody reads to the end;
 * held against each other they answer the only question that matters — is the
 * vessel crewed the way it is required to be crewed today.
 *
 * The training matrix and the skills matrix are required at all times, so the
 * portal will not run this against one of them: with either missing, the screen
 * asks for it and the server refuses the analysis. The validity periods — how
 * long each item stays valid once it has been done — are read off the skills
 * matrix itself, which carries them; there used to be a third card for a
 * separate validity periods spreadsheet, but the office folded it into the
 * skills matrix, so the latest skills matrix is always the source and there is
 * nothing extra to keep up to date.
 */
const MATRIX_CARDS = [
  {
    key: "training",
    category: "training-matrix",
    noun: "training matrix",
    title: "Training matrix",
    blurb: "Where the crew's training stands at the moment - what each person holds and when it runs out.",
    logAction: "Training matrix uploaded",
    required: true,
  },
  {
    key: "skills",
    category: "skills-matrix",
    noun: "skills matrix",
    title: "Skills matrix",
    blurb: "What the crew are required to hold: the items, who each one applies to, the shift allocations, and anything else to abide by.",
    logAction: "Skills matrix uploaded",
    required: true,
  },
  {
    key: "roster",
    category: "crew-roster",
    noun: "crew roster",
    title: "Crew roster",
    blurb: "Who is on which swing, and the days they sign on and off.",
    logAction: "Crew roster uploaded",
    required: false,
  },
];

// The record on file for each card, and where a newly filed one goes. Kept in one
// place so the three screens that show these documents can't disagree about which
// card is which document.
const matrixRecords = (portal) => ({
  training: portal.trainingMatrix,
  skills: portal.skillsMatrix,
  roster: portal.crewRoster,
});

const matrixSetters = (portal) => ({
  training: portal.setTrainingMatrix,
  skills: portal.setSkillsMatrix,
  roster: portal.setCrewRoster,
});

/* What the office tracks, held against what the portal asks for.
 *
 * The skills matrix is the office's list of what this vessel needs. When they
 * take an item off it, the portal goes on asking every crew member for it, and
 * the column sits on the matrix with everybody's dates in it looking like
 * something that still matters - Corporate Safety Induction did exactly that.
 * When they add one, the portal has never heard of it and nobody is asked at
 * all, which is the worse way round.
 *
 * So the two lists are held against each other after every read, and the
 * difference is put to management. Nothing goes on or comes off by itself: an
 * item coming off takes a column and everybody's dates in it with it, and that
 * is not something to do to somebody quietly.
 */
function MatrixItems({ onClose }) {
  const { admin, quals: QUALS, setQuals, skillsRequirements, certificates, log } = usePortal();
  const [dropping, setDropping] = useState("");
  const [done, setDone] = useState([]);

  const sheet = (skillsRequirements && skillsRequirements.items) || [];
  const sheetHas = new Set(sheet.map((x) => x.code));
  const portalHas = new Set(QUALS.cols.map((c) => String(c[0]).trim().toUpperCase()));

  // On the portal, off the office's list.
  const dropped = QUALS.cols
    .filter((c) => !sheetHas.has(String(c[0]).trim().toUpperCase()) && !done.includes(c[0]));
  // On the office's list, never on the portal.
  const fresh = sheet.filter((x) => !portalHas.has(x.code) && !done.includes(x.code));

  // How many crew have something written in a column, so the cost of taking it
  // off is on the screen before the question is answered rather than after.
  const heldIn = (code) => {
    const i = QUALS.cols.findIndex((c) => c[0] === code);
    if (i < 0) return 0;
    return QUALS.rows.filter((r) => String((r[3] || [])[i] || "").trim() !== "").length;
  };
  const scansFor = (code) => (certificates || [])
    .filter((c) => String(c.qualCode || "").trim().toUpperCase() === String(code).trim().toUpperCase());

  const takeOff = (code) => {
    const i = QUALS.cols.findIndex((c) => c[0] === code);
    if (i < 0) return;
    const title = QUALS.cols[i][1];
    const dates = heldIn(code);
    const scans = scansFor(code);
    setQuals((q) => ({
      cols: (q.cols || []).filter((_, n) => n !== i),
      rows: (q.rows || []).map((r) => [r[0], r[1], r[2], (r[3] || []).filter((_, n) => n !== i)]),
    }));
    // The scans stay where they are. A certificate is evidence of something a
    // person did, and the office deciding it no longer tracks the item is not
    // a reason to take their evidence away - it is simply no longer asked for.
    log("Admin", code + " taken off the matrix",
      title + " · " + dates + " date" + (dates === 1 ? "" : "s") + " came off with it"
      + (scans.length ? " · " + scans.length + " scan" + (scans.length === 1 ? "" : "s") + " left on file" : ""));
    setDone((d) => [...d, code]);
    setDropping("");
  };

  /* Which heading a new item sits under.
   *
   * The office's own sheet says, in a Category column beside each item - "1.
   * Qualification", "2. Vessel Specific" - so that is taken first, with the
   * numbering it uses for ordering dropped. Failing that, a column already on
   * the matrix with the same code prefix says where this one belongs.
   *
   * The neighbours alone were not enough: a portal that has just been started
   * again has no neighbours, and every item added would have gone under
   * "Other" - all fifty-three of them, in one heap, on the one occasion the
   * whole matrix is being built. */
  const categories = useMemo(() => {
    const m = new Map();
    (((skillsRequirements || {}).periods) || []).forEach((p) => {
      const said = String(p.category || "").replace(/^\s*\d+[.)]?\s*/, "").trim();
      if (p.code && said) m.set(String(p.code).toUpperCase(), said);
    });
    return m;
  }, [skillsRequirements]);

  const groupFor = (code) => {
    const said = categories.get(String(code).toUpperCase());
    if (said) return said;
    const pre = String(code).split("-")[0].toUpperCase();
    const near = (QUALS.cols || []).find((c) => String(c[0]).split("-")[0].toUpperCase() === pre);
    return near ? near[2] : "Other";
  };

  const takeOn = (item) => {
    setQuals((q) => ({
      cols: [...(q.cols || []), [item.code, item.title, groupFor(item.code)]],
      rows: (q.rows || []).map((r) => [r[0], r[1], r[2], [...(r[3] || []), ""]]),
    }));
    log("Admin", item.code + " added to the matrix", item.title + " · nobody has a date against it yet");
    setDone((d) => [...d, item.code]);
  };

  if (!admin) return null;
  if (!dropped.length && !fresh.length) return null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(22,50,74,0.45)", zIndex: 75,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: T.panel, border: "1px solid " + T.rule, borderTop: "4px solid " + T.accent,
        borderRadius: 3, padding: "20px 24px", width: "min(680px, 94vw)", maxHeight: "82vh", overflowY: "auto" }}>
        <Eyebrow color={T.accent}>The skills matrix and the portal do not track the same items</Eyebrow>
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, margin: "8px 0 14px", lineHeight: 1.6 }}>
          Nothing has been changed. Each one is yours to answer.
        </div>

        {dropped.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontFamily: T.display, fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 4 }}>
              On the portal, no longer on the skills matrix
            </div>
            {dropped.map((c) => {
              const dates = heldIn(c[0]);
              const scans = scansFor(c[0]).length;
              return (
                <div key={c[0]} style={{ padding: "9px 0", borderTop: "1px solid " + T.rule }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, minWidth: 46 }}>{c[0]}</span>
                    <span style={{ fontFamily: T.body, fontSize: 13.5, fontWeight: 600, color: T.text, flex: 1 }}>{c[1]}</span>
                    {dropping !== c[0] && (
                      <Button writes variant="quiet" onClick={() => setDropping(c[0])}>Take off the portal</Button>
                    )}
                  </div>
                  {dropping === c[0] && (
                    <div style={{ marginTop: 8, padding: "10px 12px", background: T.bRedBg,
                      border: "1px solid " + T.bRed, borderRadius: 2 }}>
                      <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.7, marginBottom: 10 }}>
                        Take {c[0]} off the matrix for everybody? The column goes, and{" "}
                        {dates === 0 ? "nobody has a date in it" : dates + " crew " + (dates === 1 ? "has a date" : "have dates") + " in it that go with it"}.
                        {scans > 0 && <> The {scans} {scans === 1 ? "scan" : "scans"} on file {scans === 1 ? "stays" : "stay"} where {scans === 1 ? "it is" : "they are"} — the office no longer asking for an item is not a reason to lose the evidence.</>}
                        {" "}The column stays in the office's own spreadsheet until they take it out there.
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Button writes variant="solid" onClick={() => takeOff(c[0])}>Yes, take it off</Button>
                        <Button variant="quiet" onClick={() => setDropping("")}>No</Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {fresh.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontFamily: T.display, fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 4 }}>
              On the skills matrix, not yet on the portal
            </div>
            {/* A portal that has just been started again is missing every item
                the office tracks, and answering fifty-three buttons one at a
                time is not answering a question - it is doing the same job
                fifty-three times. */}
            {fresh.length > 3 && (
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
                padding: "10px 0", borderTop: "1px solid " + T.rule }}>
                <Button writes variant="solid" onClick={() => fresh.forEach(takeOn)}>
                  Add all {fresh.length} to the portal
                </Button>
                <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted }}>
                  Every item the office tracks, with nobody's dates against them yet.
                </span>
              </div>
            )}
            {fresh.map((x) => (
              <div key={x.code} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
                padding: "9px 0", borderTop: "1px solid " + T.rule }}>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, minWidth: 46 }}>{x.code}</span>
                <span style={{ fontFamily: T.body, fontSize: 13.5, fontWeight: 600, color: T.text, flex: 1 }}>{x.title}</span>
                <Button writes variant="quiet" onClick={() => takeOn(x)}>Add to the portal</Button>
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

/* The circle against each name on a requirement: filled where they are one of
   the number the guideline asks for, hollow where they are held over and above
   it, and red where the requirement isn't met at all. */
function holderCircle(r, n) {
  const need = /^[0-9]+$/.test(String(r.required || "").trim()) ? Number(String(r.required).trim()) : null;
  if (r.verdict === SHIFT_STATUS.short) return { colour: T.bRed, solid: true };
  if (r.verdict === SHIFT_STATUS.unclear) return { colour: T.muted, solid: false };
  return { colour: T.teal, solid: need == null || n < need };
}

/* What the colours on this page mean, said once at the top. The same five
   run through the swing cards, the tiles and the requirement lists. */
function ComplianceLegend() {
  const keys = [
    [T.teal, "Clear", "clear to sail, or the requirement is met"],
    [T.bRed, "Not clear", "something is expired or not held, or the shift is short"],
    [T.bOrange, "Expiring onboard", "runs out during the swing"],
    [T.accent, "On now", "the swing the vessel is on"],
    [T.muted, "Not on the matrix", "nothing on file to read them against"],
  ];
  // The circles against the names under each requirement.
  const circles = [
    [T.teal, true, "Required", "one of the number the guideline asks for"],
    [T.teal, false, "Surplus", "held over and above the number required"],
    [T.bRed, true, "Requirement not met", "the shift is short of holders"],
  ];
  return (
    <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderRadius: 2,
      padding: "11px 15px", marginBottom: 14, display: "flex", gap: 18, flexWrap: "wrap",
      alignItems: "center" }}>
      {keys.map(([colour, word, what]) => (
        <span key={word} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          <span style={{ width: 13, height: 13, borderRadius: 2, background: colour, flex: "none" }} />
          <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, fontWeight: 600 }}>{word}</span>
          <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted }}>{what}</span>
        </span>
      ))}
      <span style={{ width: "100%", height: 1, background: T.rule }} />
      {circles.map(([colour, solid, word, what]) => (
        <span key={word} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          <span style={{ width: 13, height: 13, borderRadius: "50%", flex: "none",
            border: `2px solid ${colour}`, background: solid ? colour : "transparent" }} />
          <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, fontWeight: 600 }}>{word}</span>
          <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted }}>{what}</span>
        </span>
      ))}
    </div>
  );
}


/* How a watch reads on the compliance report. */
const WATCH_WORD = { day: "Days", night: "Nights" };

/**
 * The button at the bottom of the Swing Compliance page: Generate swing
 * compliance.
 *
 * Press it and the swing picked — on the cards above or on the selector next
 * to the button, they are the same pick — is checked whole: the roster it
 * carries, including anything worked ahead on the board above, read against
 * the crew matrix spreadsheets and the certificates on file, person by person.
 * The answer is written down and shared, so it is on the page for whoever
 * opens it next, and it says what it was made from: when, by whom, for which
 * swing, whether the matrix was current with the certificates at the time, and
 * what the shift allocation comparison said where one has been run for this
 * swing. Nothing is guessed at: anyone the matrix can't be matched to is
 * reported as unchecked rather than passed.
 */
function GenerateSwingCompliance({ results, here, setAt }) {
  const { certificates, certAnalysis, shiftAnalysis, swingBoard, swingBoards,
    swingReport, setSwingReport, log, role, certDates } = usePortal();
  const validityFor = useValidityLookup();

  const s = here.swing;

  // The watch each person is on, off the board the swing is read from — the
  // live board for the swing that is on, the swing's own board for a coming one.
  const watchBoard = s.k > currentSwingIndex() ? (swingBoards || {})[s.k] || null : swingBoard;
  const watchOf = (p) => (p && watchBoard && watchBoard.shift && watchBoard.shift[p.id]) || "";

  // Whether the matrix was current with the certificates on file when asked —
  // the same reading the shift allocation check makes, but said on the report
  // rather than blocking it: an answer with its caveat written on beats none.
  // The stamp is the round's; filing the matrix spreadsheet leaves it be.
  const latestCert = (certificates || []).reduce((m, c) => (c.uploaded && c.uploaded > m ? c.uploaded : m), "");
  const generatedAt = (certAnalysis && certAnalysis.generated && certAnalysis.generated.at) || "";
  const matrixFresh = matrixFreshAt(generatedAt, latestCert);

  const generate = () => {
    const item = (x) => ({
      code: x.code, title: x.title, date: x.band.date || null,
      status: x.band.key === "not" ? "Not held"
        : x.band.date && x.band.date < s.start ? `Runs out ${fmtDate(x.band.date)} — before the swing starts`
        : x.band.date ? `Runs out ${fmtDate(x.band.date)} — while they are onboard`
        : bandLabel(x.band),
    });
    const person = (c) => ({
      name: c.name, position: c.position || "", watch: watchOf(c.person),
      blockers: c.blockers.map(item), during: c.during.map(item),
    });
    // The shift allocation answer rides along when it was made for this very
    // swing; an answer about another swing is left off rather than passed on.
    const sa = shiftAnalysis && shiftAnalysis.swing === swingLabel(s)
      && shiftAnalysis.check && Array.isArray(shiftAnalysis.check.requirements)
      ? shiftAnalysis : null;
    const reqs = sa ? sa.check.requirements : [];
    const tally = (list) => ({
      short: list.filter((q) => q.status === "short").length,
      unclear: list.filter((q) => q.status !== "short" && q.status !== "met").length,
      met: list.filter((q) => q.status === "met").length,
    });
    const report = {
      at: new Date().toISOString(),
      by: role,
      swing: { k: s.k, label: swingLabel(s), crew: s.crew,
        flyOut: s.flyOut, flyHome: s.flyHome, start: s.start, end: s.end },
      counts: {
        rostered: here.checked.length + here.unchecked.length,
        clear: here.clear.length, blocked: here.blocked.length,
        watch: here.watch.length, unchecked: here.unchecked.length,
      },
      matrix: {
        generatedAt: generatedAt || null,
        newestCertificate: latestCert ? latestCert.slice(0, 10) : null,
        fresh: matrixFresh,
      },
      blocked: here.blocked.map(person),
      watch: here.watch.map(person),
      clear: here.clear.map((c) => ({ name: c.name, position: c.position || "", watch: watchOf(c.person) })),
      unchecked: here.unchecked.map((p) => ({ name: p.name, dept: p.dept || "" })),
      shift: sa ? {
        at: sa.at,
        headline: sa.check.headline || "",
        ...tally(reqs),
        // The same verdicts broken up by shift. A requirement with one number
        // each shift must meet alike counts toward both shifts; one the sheet
        // didn't split by shift falls to the whole-swing tally.
        byShift: {
          day: tally(reqs.filter((q) => q.shift === "day" || q.shift === "both")),
          night: tally(reqs.filter((q) => q.shift === "night" || q.shift === "both")),
          swing: tally(reqs.filter((q) => q.shift !== "day" && q.shift !== "night" && q.shift !== "both")),
        },
      } : null,
    };
    setSwingReport(report);
    log("Swings", "Swing compliance generated",
      `${report.swing.label} · Crew ${report.swing.crew} · `
      + `${report.counts.blocked ? `${report.counts.blocked} not clear` : "all clear"}`
      + `${report.counts.unchecked ? ` · ${report.counts.unchecked} unchecked` : ""}`);
  };

  const r = swingReport;
  const ok = !!r && !r.counts.blocked;
  // The report stays put while the cards above switch swings, so which swing it
  // was made for is written on it — and when that isn't the swing picked now,
  // it is said out loud rather than the old answer quietly passing as this one's.
  const stale = !!r && r.swing.k !== s.k;
  const when = (iso) => new Date(iso).toLocaleString("en-AU",
    { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  // One shift's slice of the shift allocation answer, said in a few words.
  const saPart = (t) => `${t.short ? `${t.short} short` : "none short"}${t.unclear ? `, ${t.unclear} unclear` : ""}, ${t.met} met`;

  // The headings the three date columns sit under on each card — the issue
  // date read off the certificate, the expiry the check was made against, and
  // how long the item stays valid off the skills matrix.
  const colHead = { fontFamily: T.display, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em",
    textTransform: "uppercase", color: T.muted, minWidth: 78 };

  const personCard = (c, colour, items) => (
    <div key={c.name} style={{ background: T.panel, border: `1px solid ${T.rule}`,
      borderLeft: `3px solid ${colour}`, borderRadius: 2, padding: "11px 13px", marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap",
        alignItems: "baseline" }}>
        <span style={{ fontFamily: T.body, fontSize: 14, fontWeight: 600, color: T.text }}>
          {c.name}
          {c.position && <span style={{ color: T.muted, fontWeight: 400 }}> · {c.position}</span>}
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
          {WATCH_WORD[c.watch] || "No watch set"}
        </span>
      </div>
      <div style={{ marginTop: 6 }}>
        <div className="um-datehead" style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
          padding: "6px 0 4px", borderBottom: `2px solid ${T.rule}` }}>
          <span style={{ minWidth: 46 }} />
          <span style={{ flex: "1 1 160px" }} />
          <span style={{ flex: "1 1 190px" }} />
          <span style={colHead}>Issue date</span>
          <span style={colHead}>Expiry date</span>
          <span style={{ ...colHead, minWidth: 92 }}>Validity</span>
        </div>
        {items.map((x, i) => {
          const d = certDateFor(certDates, c.name, x.code);
          const validity = validityFor(x);
          return (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
              padding: "7px 0", borderTop: i ? `1px solid ${T.rule}` : "none" }}>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, minWidth: 46 }}>{x.code}</span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: "1 1 160px",
                minWidth: 0 }}>{x.title}</span>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: colour, flex: "1 1 190px",
                minWidth: 0 }}>{x.status}</span>
              <DateCols issued={d && d.issued} expires={x.date || (d && d.expires)} />
              <span style={{ fontFamily: T.mono, fontSize: 10.5, color: validity ? T.text : T.muted,
                minWidth: 92 }}>{validity || "—"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );

  const asPDF = () => {
    const line = (who, fg, bg) => (x) => {
      const d = certDateFor(certDates, who, x.code);
      const col = (v) => { const s = v ? colDate(v) : ""; return s === "—" ? "" : s; };
      return { code: x.code, title: x.title, validity: validityFor(x) || "",
        issued: col(d && d.issued), date: col(x.date || (d && d.expires)),
        status: x.status, fg, bg };
    };
    return {
      title: `Swing compliance report · ${r.swing.label}`,
      subtitle: `${VESSEL.name} ${VESSEL.nameAccent} · Crew ${r.swing.crew} · `
        + `fly out ${fmtDate(r.swing.flyOut)}, home ${fmtDate(r.swing.flyHome)} · `
        + `generated ${when(r.at)}${r.by ? ` by ${r.by}` : ""} · `
        + `${r.counts.rostered} rostered · ${r.counts.blocked} not clear · `
        + `${r.counts.watch} expiring onboard · ${r.counts.unchecked} unchecked`,
      filename: `swing-compliance-report-${r.swing.flyOut}.pdf`,
      empty: "Everyone rostered onto this swing is clear.",
      groups: [
        ...r.blocked.map((c) => ({
          heading: c.name,
          meta: `${c.position || "—"} · ${WATCH_WORD[c.watch] || "no watch set"} · not clear`,
          items: [...c.blockers.map(line(c.name, T.bRed, T.bRedBg)), ...c.during.map(line(c.name, T.bOrange, T.bOrangeBg))],
        })),
        ...r.watch.map((c) => ({
          heading: c.name,
          meta: `${c.position || "—"} · ${WATCH_WORD[c.watch] || "no watch set"} · expiring onboard`,
          items: c.during.map(line(c.name, T.bOrange, T.bOrangeBg)),
        })),
        r.clear.length ? {
          heading: "Clear to fly",
          meta: `${r.clear.length}`,
          items: r.clear.map((c) => ({ code: "", title: `${c.name}${c.position ? ` · ${c.position}` : ""}`,
            status: "Clear", fg: T.teal, bg: T.raised })),
        } : null,
        r.unchecked.length ? {
          heading: "Not on the matrix — unchecked",
          meta: `${r.unchecked.length}`,
          items: r.unchecked.map((p) => ({ code: "", title: `${p.name}${p.dept ? ` · ${p.dept}` : ""}`,
            status: "Unchecked", fg: T.muted, bg: T.raised })),
        } : null,
      ].filter(Boolean),
    };
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
        <div style={{ flex: "1 1 320px" }}>
          <ChoiceField label="Swing to check">
            <Choices value={s.k} onPick={(v) => setAt(Number(v))} compact
              options={results.map((x) => ({ value: x.swing.k,
                label: `Crew ${x.swing.crew} · ${swingLabel(x.swing)}${x.swing.k <= currentSwingIndex() ? " · on now" : ""}` }))} />
          </ChoiceField>
        </div>
        <Button onClick={generate}>Swing report</Button>
        {r && (
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, paddingBottom: 9 }}>
            Last generated {when(r.at)}{r.by ? ` · ${r.by}` : ""} · {r.swing.label}
          </span>
        )}
      </div>

      {!r ? (
        <Empty>
          Nothing generated yet. Pick a swing and press the button — the roster is checked against
          the matrix spreadsheets and the certificates on file, and the answer is kept here for
          everyone.
        </Empty>
      ) : (
        <>
          {stale && (
            <div style={{ background: T.panel, border: `1px solid ${T.rule}`,
              borderLeft: `4px solid ${T.bOrange}`, borderRadius: 2, padding: "12px 15px",
              marginBottom: 10 }}>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.6 }}>
                This report was generated for{" "}
                <strong style={{ fontWeight: 700 }}>Crew {r.swing.crew} · {r.swing.label}</strong>.
                The swing picked now is{" "}
                <strong style={{ fontWeight: 700 }}>Crew {s.crew} · {swingLabel(s)}</strong> — press
                the button and the report is made for it instead.
              </span>
            </div>
          )}

          <div style={{ background: T.panel, border: `1px solid ${T.rule}`,
            borderLeft: `4px solid ${ok ? T.teal : T.bRed}`, borderRadius: 2,
            padding: "13px 15px", marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
              gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.6,
                flex: "1 1 220px" }}>
                {ok
                  ? r.counts.unchecked
                    ? `Everyone the matrix could check is clear to fly. ${r.counts.unchecked} of the ${r.counts.rostered} rostered couldn't be matched to it, so they are unchecked rather than passed.`
                    : "The swing is compliant — everyone rostered onto it is clear to fly."
                  : `The swing is not compliant as it stands — ${r.counts.blocked} of the ${r.counts.rostered} rostered ${r.counts.blocked === 1 ? "is" : "are"} not clear to fly.`}
              </span>
              <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                {r.counts.blocked > 0 && <Chip fg={T.bRed} bg={T.bRedBg}>{r.counts.blocked} not clear</Chip>}
                {r.counts.watch > 0 && <Chip fg={T.bOrange} bg={T.bOrangeBg}>{r.counts.watch} expiring onboard</Chip>}
                <Chip fg={T.teal} bg={T.raised}>{r.counts.clear} clear</Chip>
                {r.counts.unchecked > 0 && <Chip fg={T.muted} bg={T.raised}>{r.counts.unchecked} unchecked</Chip>}
              </span>
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 6 }}>
              Crew {r.swing.crew} · fly out {fmtDate(r.swing.flyOut)}, home {fmtDate(r.swing.flyHome)} ·{" "}
              {r.counts.rostered} rostered · generated {when(r.at)}{r.by ? ` by ${r.by}` : ""}
            </div>
            <div style={{ fontFamily: T.body, fontSize: 12.5, lineHeight: 1.6, marginTop: 7,
              color: r.matrix.fresh ? T.muted : T.bOrange }}>
              {r.matrix.fresh
                ? `The matrix was up to date with the certificates on file when this was generated${r.matrix.generatedAt ? ` (matrix generated ${fmtDate(vesselDay(r.matrix.generatedAt))})` : ""}.`
                : r.matrix.generatedAt
                  ? "A certificate newer than the last matrix generation is on file — generate the latest training matrix on the Crew Matrix page and press the button again for the surest answer."
                  : "The training matrix has not been generated from the certificates on file yet — this report reads the matrix spreadsheets as they stand."}
            </div>
            <div style={{ fontFamily: T.body, fontSize: 12.5, lineHeight: 1.6, marginTop: 5,
              color: r.shift && r.shift.short ? T.bRed : T.muted }}>
              {r.shift
                ? r.shift.byShift
                  ? `Shift allocation guideline for this swing — Day Shift (1200 – 2400): ${saPart(r.shift.byShift.day)}. Night Shift (2400 – 1200): ${saPart(r.shift.byShift.night)}.${(r.shift.byShift.swing.short + r.shift.byShift.swing.unclear + r.shift.byShift.swing.met) > 0 ? ` Whole swing: ${saPart(r.shift.byShift.swing)}.` : ""} Compared ${when(r.shift.at)}.`
                  : `Shift allocation guideline for this swing: ${r.shift.short ? `${r.shift.short} requirement${r.shift.short === 1 ? "" : "s"} short` : "no requirement short"}${r.shift.unclear ? `, ${r.shift.unclear} unclear` : ""}, ${r.shift.met} met — compared ${when(r.shift.at)}.`
                : "The shift allocation guideline hasn't been compared for this swing — run the comparison above and generate again to fold its answer in."}
            </div>
          </div>

          {r.blocked.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ marginBottom: 8 }}>
                <Eyebrow color={T.bRed}>Not clear to fly · {r.blocked.length}</Eyebrow>
              </div>
              {r.blocked.map((c) => personCard(c, T.bRed, [...c.blockers, ...c.during]))}
            </div>
          )}

          {r.watch.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ marginBottom: 8 }}>
                <Eyebrow color={T.bOrange}>Clear to fly, expiring onboard · {r.watch.length}</Eyebrow>
              </div>
              {r.watch.map((c) => personCard(c, T.bOrange, c.during))}
            </div>
          )}

          {r.clear.length > 0 && (
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.muted, lineHeight: 1.7,
              marginBottom: 10 }}>
              <strong style={{ fontWeight: 600, color: T.teal }}>Clear to fly ({r.clear.length}):</strong>{" "}
              {r.clear.map((c) => c.name).join(", ")}.
            </div>
          )}

          {r.unchecked.length > 0 && (
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.muted, lineHeight: 1.7,
              marginBottom: 10 }}>
              <strong style={{ fontWeight: 600 }}>Not on the matrix ({r.unchecked.length}):</strong>{" "}
              {r.unchecked.map((p) => p.name).join(", ")} — no row on the crew matrix could be
              matched to them, so they are reported rather than guessed at.
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, flexWrap: "wrap" }}>
            <DownloadPDF build={asPDF} variant="quiet" label="Download the report" />
          </div>
        </>
      )}
    </div>
  );
}
