/* OPMS Checker — the Admin tab of that name.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state; this
 * holds what is only this tab's. See tools/source.mjs.
 */
function OPMSChecker() {
  /* One spreadsheet, filed in one place.
   *
   * There were two slots for it: this page had its own, and Required Documents
   * had a card of the same name wired to a different one. The same export had
   * been uploaded to both, and on other weeks the crew qualification workbook
   * had gone into the other one instead, so which document the portal held
   * depended on which card somebody had used last.
   *
   * It is filed under Required Documents with everything else now, and read
   * from there. The old slot is still read where a copy is sitting in it, so
   * nothing filed before this goes dark. */
  const portal = usePortal();
  const { setOpmsSheet, quals, opmsAnalysis, setOpmsAnalysis, log, role,
    opmsMarks, setOpmsMarks } = portal;
  const opmsSheet = portal.certSheet || portal.opmsSheet;

  // A finding's identity across weekly runs: side + person + code-or-item,
  // normalised — so a mark made this week still holds when next week's run
  // reports the same disagreement.
  const markKey = (sideKey, f) =>
    `${sideKey}::${String(f.person || "crew").trim().toUpperCase()}::${String(f.code || f.item || "").trim().toUpperCase()}`;
  const markOf = (sideKey, f) => (opmsMarks || {})[markKey(sideKey, f)] || null;
  const setMark = (sideKey, f, status) => {
    const k = markKey(sideKey, f);
    const next = { ...(opmsMarks || {}) };
    if (next[k] && next[k].status === status) delete next[k];
    else next[k] = { status, on: todayISO(), by: role || "admin" };
    setOpmsMarks(next);
  };
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [draftOpen, setDraftOpen] = useState(false);
  // Which finding's Details is open.
  const [detailFor, setDetailFor] = useState(null);

  // The export itself, read off the sheet in the browser, so every certificate
  // can be laid side by side — not only the disagreements the comparison
  // reported. A sheet that can't be read leaves the page to the findings.
  const [opmsRows, setOpmsRows] = useState(null);
  React.useEffect(() => {
    let dead = false;
    setOpmsRows(null);
    if (!opmsSheet || !opmsSheet.url) return;
    (async () => {
      try {
        const XLSX = await loadXLSX();
        const buf = await (await fetch(opmsSheet.url)).arrayBuffer();
        const rows = readOPMSExport(XLSX, buf);
        if (!dead) setOpmsRows(rows);
      } catch (e) {
        if (!dead) setOpmsRows(null);
      }
    })();
    return () => { dead = true; };
  }, [opmsSheet && opmsSheet.url]);

  const [run, setRun] = useState(null);       // null | { phase, read, total } | { phase: "failed", message }
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState([]);
  // The run is watched from a window over the page. It can be put away — the run
  // carries on either way, and the panel under the buttons says where it is.
  const [hidden, setHidden] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);

  const running = !!run && run.phase !== "failed";
  const ready = !!opmsSheet && !!(quals && quals.rows && quals.rows.length);

  // A sheet newer than the answer on file — uploaded from another page, or by
  // somebody else — starts the comparison on its own when this page opens.
  // Once per sheet per visit, and never over a run already going.
  const autoRan = useRef(null);
  React.useEffect(() => {
    if (!ready || busy || !opmsSheet || !opmsSheet.id) return;
    if (!opmsAnalysis || !opmsAnalysis.sheetId) return; // first-ever run stays a choice
    if (opmsAnalysis.sheetId === opmsSheet.id) return;
    if (autoRan.current === opmsSheet.id) return;
    autoRan.current = opmsSheet.id;
    runAnalysis(true);
  }, [ready, busy, opmsSheet && opmsSheet.id]);

  // How far through the run is: the certificates counted as they are read, and
  // the two steps after them held at the point they start from.
  const pct = !run || run.phase === "failed" ? 0
    : run.phase === "reading"
      ? (run.total ? Math.min(OPMS_READ_BAND, Math.round((run.read / run.total) * OPMS_READ_BAND)) : 0)
      : (OPMS_PHASE_PCT[run.phase] || 0);

  React.useEffect(() => {
    if (!running) return;
    const tick = () => setElapsed(Math.round((Date.now() - startedAt.current) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [running]);

  const runAnalysis = async (fresh) => {
    if (!ready) return;
    setErr(""); setBusy(true); setProblems([]); setRun(null); setHidden(false);
    startedAt.current = Date.now();
    try {
      const res = await analyseOPMS({
        quals, opmsSheet, fresh, onPhase: (p) => setRun(p),
      });

      setOpmsAnalysis({
        at: res.at || new Date().toISOString(),
        by: role,
        model: res.model || "",
        sheetId: opmsSheet ? opmsSheet.id : null,
        sheet: res.sheet || null,
        certificates: res.certificates || null,
        check: res.check || null,
        truncated: res.truncated === true,
        problems: res.problems || [],
      });
      setProblems(res.problems || []);

      // Counted off the lists, so the log line and the page can never differ.
      const sizeOf = (v) => (Array.isArray(v) ? v.length : 0);
      log("Admin", "Compared OPMS against our matrix and certificates",
        `${sizeOf(res.check && res.check.ours)} on our end · ${sizeOf(res.check && res.check.opms)} OPMS · ${
          sizeOf(res.check && res.check.unattributed)} unattributed`);
      setRun(null);
    } catch (e) {
      const message = e.message || String(e);
      setErr(message);
      // The window comes back if it had been put away — a run that stopped is the
      // one thing worth interrupting for. Closing it leaves the same message on
      // the panel below.
      setHidden(false);
      setRun({ phase: "failed", message });
    }
    setBusy(false);
  };

  const check = (opmsAnalysis && opmsAnalysis.check) || null;
  const counts = (check && check.counts) || {};
  // The lists come back from a model, so a missing key or the wrong shape is
  // something to render around rather than throw on.
  const listOf = (v) => (Array.isArray(v) ? v : []);
  const notes = listOf(check && check.notes);
  const unattributed = listOf(check && check.unattributed);
  // A model's own tally can disagree with the list it just wrote, so the three
  // attribution figures are counted off the findings on the page. Agreed and
  // compared have nothing on the page to count, so they stay as reported.
  const ours = listOf(check && check.ours);
  const opms = listOf(check && check.opms);
  const disagreements = ours.length + opms.length;
  const certs = (opmsAnalysis && opmsAnalysis.certificates) || null;
  const caveats = problems.length ? problems : listOf(opmsAnalysis && opmsAnalysis.problems);
  const verdict = check ? opmsVerdict(ours.length, opms.length, unattributed.length) : null;

  /* The results as a PDF, so the answer can be sent to whoever has to act on it
     without asking them to log in and run it themselves. It is described when the
     button is clicked, so it is always the check on the screen at that moment.

     The rule that decides fault goes at the top and the verdict under it, because
     a list of somebody else's mistakes is only worth reading alongside the reason
     each one was put on their side of the page. */
  const asPDF = () => {
    const findingItem = (f, side) => ({
      code: f.code || "",
      title: `${f.person || "The crew as a whole"} - ${f.item || "unnamed item"}`,
      status: OPMS_PDF_CONFIDENCE[f.confidence] || "",
      fg: f.confidence === "high" ? side.fg : T.muted,
      bg: f.confidence === "high" ? side.bg : T.raised,
      notes: [
        { text: `OPMS: ${f.opmsSays || "nothing"}`, fg: T.text },
        { text: `Ours: ${f.weSay || "nothing"}`, fg: T.text },
        { text: f.detail, fg: T.muted },
        { text: f.evidence, fg: side.fg },
        { text: f.action ? `To fix: ${f.action}` : "", fg: T.text },
      ],
    });

    const sheet = (opmsAnalysis && opmsAnalysis.sheet) || null;
    const ran = opmsAnalysis && opmsAnalysis.at
      ? new Date(opmsAnalysis.at).toLocaleString("en-AU", {
          day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
        })
      : fmtDate(TODAY);

    return {
      title: "OPMS Checker - who is at fault",
      subtitle: [
        `${VESSEL.name} ${VESSEL.nameAccent}`,
        `run ${ran}`,
        sheet ? sheet.filename : "no OPMS export on file",
        certs ? `${certs.read} of ${certs.total} certificates read` : null,
        `${ours.length} ours · ${opms.length} OPMS · ${unattributed.length} unattributed`,
      ].filter(Boolean).join(" · "),
      intro: `${verdict.who}. ${verdict.line}\n\n${OPMS_RULE}`,
      filename: `opms-check-${TODAY}.pdf`,
      empty: "Nothing to report - our matrix, the certificates on file and the OPMS export agree.",
      groups: [
        ...OPMS_SIDES.map((side) => ({
          heading: side.title,
          meta: `${listOf(check[side.key]).length}`,
          blurb: side.blurb,
          items: listOf(check[side.key]).map((f) => findingItem(f, side)),
        })),
        {
          heading: "Couldn't be put on either side",
          meta: `${unattributed.length}`,
          blurb: "The two systems disagree and no certificate on file covers the item, so which of them is wrong isn't something the documents answer.",
          items: unattributed.map((f) => findingItem(f, { fg: T.muted, bg: T.raised })),
        },
        {
          heading: "What couldn't be compared",
          meta: "",
          items: notes.map((n) => ({ code: "", title: String(n) })),
        },
      ],
    };
  };

  const tile = (label, value, colour) => (
    <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderLeft: `3px solid ${colour}`,
      borderRadius: 2, padding: "10px 13px", flex: "1 1 130px" }}>
      <Eyebrow>{label}</Eyebrow>
      <div style={{ fontFamily: T.display, fontSize: 25, fontWeight: 700, color: colour, marginTop: 5, lineHeight: 1 }}>{value}</div>
    </div>
  );

  // One disagreement as a row under its person's name: the item, then the two
  // accounts side by side — ours in the first column, OPMS's in the second,
  // both in red because they differ — whose mistake it is on the end, the
  // model's sentences behind Details, and the mark that says what has been
  // done about it. `side` is null where no certificate on file could put the
  // disagreement on either side.
  const findingRow = (f, i, side) => {
    const dKey = `${(side && side.key) || "un"}-${i}-${f.person || ""}-${f.code || f.item || ""}`;
    const openThis = detailFor === dKey;
    const val = { fontFamily: T.mono, fontSize: 11.5, color: T.bRed, flex: "1 1 150px",
      minWidth: 0, lineHeight: 1.6, overflowWrap: "anywhere" };
    return (
    <div key={dKey} style={{ padding: "8px 0", borderBottom: `1px solid ${T.rule}` }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: "1 1 200px", minWidth: 0 }}>
          {f.item || "unnamed item"}
          {f.code ? <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.accent }}> {f.code}</span> : null}
        </span>
        <span style={val}>{f.weSay || "nothing"}</span>
        <span style={val}>{f.opmsSays || "nothing"}</span>
        <span style={{ display: "flex", gap: 6, alignItems: "baseline", justifyContent: "flex-end",
          flexWrap: "wrap", minWidth: 150 }}>
          {side
            ? <Chip fg={side.fg} bg={side.bg}>{side.key === "ours" ? "ours to fix" : "OPMS to fix"}</Chip>
            : <Chip fg={T.muted} bg={T.raised}>no certificate</Chip>}
          {side && OPMS_CONFIDENCE[f.confidence] && f.confidence !== "high" && (
            <Chip fg={T.muted} bg={T.raised}>{OPMS_CONFIDENCE[f.confidence]}</Chip>
          )}
          {(f.detail || f.evidence || f.action) && (
            <button className="um-btn" onClick={() => setDetailFor(openThis ? null : dKey)}
              style={{ background: "transparent", color: T.muted, fontSize: 9.5, fontWeight: 700, padding: "2px 0" }}>
              {openThis ? "Close" : "Details"}
            </button>
          )}
        </span>
      </div>
      {openThis && (
        <div style={{ background: T.raised, borderRadius: 2, padding: "8px 11px", marginTop: 6 }}>
          {f.detail && (
            <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, lineHeight: 1.6 }}>{f.detail}</div>
          )}
          {f.evidence && (
            <div style={{ fontFamily: T.body, fontSize: 12.5, color: side ? side.fg : T.muted, lineHeight: 1.6, marginTop: 4 }}>{f.evidence}</div>
          )}
          {f.action && (
            <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, lineHeight: 1.6, marginTop: 4 }}>{f.action}</div>
          )}
        </div>
      )}
      {/* What has been done about it — Sent to OPMS for their mistakes, Fixed
          for ours; the mark keeps its date and holds across weekly runs. A
          finding still coming back after being marked fixed is called out:
          somebody re-imported the old data. */}
      {side && side.key && (() => {
        const mk = markOf(side.key, f);
        const steps = side.key === "opms"
          ? [{ st: "sent", label: "Sent to OPMS" }, { st: "fixed", label: "Settled" }]
          : [{ st: "fixed", label: "Fixed on our side" }];
        return (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 7 }}>
            {steps.map(({ st, label }) => {
              const on = mk && mk.status === st;
              return (
                <button key={st} className="um-btn" onClick={() => setMark(side.key, f, st)}
                  title={on ? `${label} ${fmtDate(mk.on)} — press to clear` : `Mark as ${label.toLowerCase()}`}
                  style={{ background: on ? T.accentSoft : "transparent", color: on ? T.accent : T.muted,
                    border: `1px solid ${on ? T.accent : T.rule}`, borderRadius: 2,
                    padding: "2px 8px", fontSize: 9.5, fontWeight: 700 }}>
                  {label}{on ? ` · ${fmtDate(mk.on)}` : ""}
                </button>
              );
            })}
            {mk && mk.status === "fixed" && (
              <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, background: T.bRedBg,
                color: T.bRed, padding: "2px 7px", borderRadius: 2 }}
                title="Marked fixed, yet this run still reports it — the correction didn't land, or old data was re-imported">
                STILL APPEARING
              </span>
            )}
          </div>
        );
      })()}
    </div>
    );
  };

  return (
    <div>
      <div style={{ background: T.panel, border: `1px solid ${T.rule}`,
        borderLeft: `4px solid ${opmsSheet ? T.green : T.bOrange}`, borderRadius: 2,
        padding: "15px 17px", marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8,
          alignItems: "baseline", flexWrap: "wrap" }}>
          <Eyebrow color={opmsSheet ? T.accent : T.bOrange}>Latest OPMS spreadsheet</Eyebrow>
          <Chip fg={opmsSheet ? T.bGreen : T.bOrange} bg={opmsSheet ? T.bGreenBg : T.raised}>
            {opmsSheet ? "on file" : "not on file"}
          </Chip>
        </div>

        <div style={{ fontFamily: T.body, fontSize: 13.5, color: opmsSheet ? T.text : T.muted,
          marginTop: 10, wordBreak: "break-word" }}>
          {opmsSheet ? opmsSheet.filename : "Not on file"}
        </div>
        {opmsSheet && (
          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 3 }}>
            {opmsSheet.uploaded ? `${fmtDate(opmsSheet.uploaded)} · ` : ""}{opmsSheet.size}
            {opmsSheet.by ? ` · ${opmsSheet.by}` : ""}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
          {opmsSheet && <OpenLink url={opmsSheet.url} />}
          <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted }}>
            Filed under Documents, with the rest of the spreadsheets.
          </span>
        </div>
      </div>

      {/* The check itself. Three accounts of the same crew go in - our skills
          matrix, the certificates we have scanned, and the OPMS export - and what
          comes back is split by whose mistake each disagreement is. */}
      <div style={{ background: T.panel, border: `1px solid ${T.rule}`,
        borderLeft: `4px solid ${T.accent}`, borderRadius: 2, padding: "15px 17px", marginBottom: 16 }}>
        <Eyebrow color={T.accent}>Compare the three against each other</Eyebrow>
        <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.7, marginTop: 9 }}
          title={OPMS_RULE}>
          The OPMS export, our matrix, and the certificates on file, held against one another — the
          certificates settle every disagreement, and the answer says whose mistake each one is.
          A new upload compares itself.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 13 }}>
          <Button onClick={() => runAnalysis(false)} disabled={busy || !ready}>
            {running ? "Working..." : "Analyse spreadsheets and certificates"}
          </Button>
          {opmsAnalysis && ready && (
            <Button variant="quiet" onClick={() => runAnalysis(true)} disabled={busy}
              title="Ask the question again from the documents as they stand now, rather than showing the answer from last time">
              Run it again
            </Button>
          )}
          {running && hidden && (
            <Button variant="quiet" onClick={() => setHidden(false)}>Show progress</Button>
          )}
          {opmsAnalysis && !running && (
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
              Last run {new Date(opmsAnalysis.at).toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
              {opmsAnalysis.by ? ` · ${opmsAnalysis.by}` : ""}
            </span>
          )}
        </div>
        {!opmsSheet && (
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.bOrange, lineHeight: 1.6, marginTop: 10 }}>
            Upload the latest export from OPMS first. There is nothing to compare against until it is on file.
          </div>
        )}
      </div>

      {running && (
        <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderLeft: `4px solid ${T.accent}`,
          borderRadius: 2, padding: "13px 15px", marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
            <Eyebrow color={T.accent}>Analysing</Eyebrow>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{elapsedLabel(elapsed)} elapsed</span>
          </div>
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.7, marginTop: 8 }}>
            {run.phase === "clearing" && "Forgetting the last answer, so the question is asked again from the documents as they stand now."}
            {run.phase === "reading" && (run.total
              ? `Reading the certificates — ${run.read} of ${run.total}. A certificate nobody has read settles nothing, so this comes first.`
              : "Reading the certificates on file. A certificate nobody has read settles nothing, so this comes first.")}
            {run.phase === "sheet" && "Opening the OPMS export."}
            {run.phase === "comparing" && (run.waited > 20
              ? "Holding the OPMS export against our matrix and our certificates. It is one long question over the whole crew and it runs on the server, so it takes a few minutes."
              : "Holding the OPMS export against our matrix and our certificates.")}
          </div>
          {run.phase === "reading" && run.total > 0 && (
            <div className="um-bar" style={{ marginTop: 10 }}>
              <i style={{ width: `${Math.min(100, Math.round((run.read / run.total) * 100))}%` }} />
            </div>
          )}
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.muted, lineHeight: 1.6, marginTop: 7 }}>
            Leave the page open; every certificate reading is kept as it is made.
          </div>
        </div>
      )}

      {/* A run takes minutes and the page underneath it can't be used until it
          finishes, so it is watched from a window rather than a panel that
          scrolls away. The figure and the clock both climb while it works. */}
      {run && !hidden && (
        <AnalysisWindow
          eyebrow="Comparing OPMS against our records"
          pct={pct}
          elapsed={elapsed}
          failed={run.phase === "failed"}
          message={run.message}
          failNote={run.read > 0
            ? `The ${run.read} ${run.read === 1 ? "certificate" : "certificates"} already read ${run.read === 1 ? "was" : "were"} kept, so running it again carries on from there rather than starting over.`
            : "Nothing was read, so nothing has changed. Running it again starts from the beginning."}
          body={<>
            {run.phase === "clearing" && "Forgetting the last answer, so the question is asked again from the documents as they stand now."}
            {run.phase === "reading" && (run.total
              ? `${run.read} of ${run.total} certificates read. A certificate nobody has read settles nothing, so this comes first.`
              : "Looking for certificates to read. A certificate nobody has read settles nothing, so this comes first.")}
            {run.phase === "sheet" && "Every certificate read. Opening the OPMS export."}
            {run.phase === "comparing" && (run.waited > 20
              ? "Holding the OPMS export against our matrix and our certificates. It is one long question over the whole crew and it runs on the server, so it takes a few minutes."
              : "Holding the OPMS export against our matrix and our certificates.")}
          </>}
          note="Leave the page open. Every certificate reading is kept as it is made, so a run that stops partway picks up where it left off rather than starting over."
          onHide={() => setHidden(true)}
          onClose={() => setRun(null)}
        />
      )}

      {(err || (run && run.phase === "failed")) && (
        <div style={{ background: T.bRedBg, border: `1px solid ${T.bRed}`, borderRadius: 2,
          padding: "13px 15px", marginBottom: 16 }}>
          <Eyebrow color={T.bRed}>The analysis stopped</Eyebrow>
          <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.7, marginTop: 8 }}>
            {err || (run && run.message)}
          </div>
        </div>
      )}

      {caveats.length > 0 && (
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.bOrange, lineHeight: 1.7, marginBottom: 14 }}>
          {caveats.map((p, i) => <div key={i}>{p}</div>)}
        </div>
      )}

      {!check ? (
        <Empty>
          {ready
            ? "Nothing has been compared yet. Analyse spreadsheets and certificates reads the certificates on file, then holds the OPMS export against them and against our skills matrix."
            : "The OPMS export has to be on file before anything can be compared — upload it under Documents."}
        </Empty>
      ) : (
        <>
          {/* Who is at fault, first and in its own words, because it is the
              question the page is here to answer. The rule it was decided by is
              underneath it rather than left on the columns further down. */}
          <div style={{ background: T.panel, border: `1px solid ${T.rule}`,
            borderLeft: `4px solid ${verdict.fg}`,
            borderRadius: 2, padding: "15px 17px", marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10,
              alignItems: "baseline", flexWrap: "wrap" }}>
              <Eyebrow color={verdict.fg}>
                {disagreements === 0 ? "Nothing to apportion" : "Who is at fault"}
              </Eyebrow>
              <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <Chip fg={verdict.fg} bg={T.raised}>
                  {disagreements === 0 ? "no disagreements" : `${disagreements} to answer for`}
                </Chip>
                <Chip fg={T.accent} bg={T.raised}>{counts.agree || 0} agreed of {counts.compared || 0} compared</Chip>
                {unattributed.length > 0 && <Chip fg={T.muted} bg={T.raised}>{unattributed.length} unattributed</Chip>}
              </span>
            </div>
            <div style={{ fontFamily: T.display, fontSize: 20, fontWeight: 700, color: verdict.fg,
              marginTop: 9, lineHeight: 1.3 }}>
              {verdict.who}
            </div>
            <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.7, marginTop: 6 }}>
              {verdict.line}
            </div>
            <div style={{ fontFamily: T.body, fontSize: 15, color: T.text, lineHeight: 1.7, marginTop: 9 }}>
              {check.headline}
            </div>
            <details style={{ marginTop: 9, borderTop: `1px solid ${T.rule}`, paddingTop: 7 }}>
              <summary style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, cursor: "pointer" }}>
                How this was decided
                {opmsAnalysis.sheet ? ` · ${opmsAnalysis.sheet.filename}` : ""}
                {certs ? ` · ${certs.read}/${certs.total} certificates read` : ""}
              </summary>
              <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, lineHeight: 1.6, marginTop: 6 }}>
                {OPMS_RULE}
              </div>
            </details>
            {certs && certs.unread > 0 && (
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.bOrange, lineHeight: 1.6, marginTop: 8 }}>
                {certs.unread} {certs.unread === 1 ? "certificate has" : "certificates have"} not been read, so
                nothing they carry settled anything here. Run it again to take them in.
              </div>
            )}
            {/* An answer that filled the room it was given is still an answer —
                everything on the page was compared properly — but it is the top
                of the comparison rather than all of it, and nobody should read
                an empty column underneath as "nothing wrong on that side". */}
            {opmsAnalysis.truncated && (
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.bOrange, lineHeight: 1.6, marginTop: 8 }}>
                This comparison was cut short before it reached the end of the crew. What is below was
                compared in full and is the most serious of what was found, but there may be more that
                wasn't reached. Take out the crew already dealt with, or split the export, and run it again.
              </div>
            )}
            {/* Everything on this page, on paper, for whoever has to act on it. */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 13 }}>
              <DownloadPDF build={asPDF} label="Save the results as a PDF" />
            </div>
          </div>


          {/* The two columns the whole page is for. Side by side where there is
              room, and stacked on a phone, where they read as two lists. */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
            <Button variant={onlyOpen ? "solid" : "quiet"}
              title="Hide findings already marked sent or fixed, so the columns show only what still needs somebody"
              onClick={() => setOnlyOpen(!onlyOpen)}>
              Unresolved only
            </Button>
            {opms.length > 0 && (
              <Button variant="quiet" onClick={() => setDraftOpen(!draftOpen)}>
                {draftOpen ? "Close the email draft" : "Draft the email to OPMS"}
              </Button>
            )}
          </div>

          {/* The email to OPMS, written from the findings on their side: what
              their export has wrong, what the certificate on file shows, one
              block per item. Copy it, attach the PDF above, send. */}
          {draftOpen && (() => {
            const openOnes = opms.filter((f) => { const m = markOf("opms", f); return !m || m.status !== "fixed"; });
            const body = [
              `Hi PK,`,
              ``,
              `Our weekly check of the TR02 export against the certificates on file has found ${openOnes.length} item${openOnes.length === 1 ? "" : "s"} where the export doesn't match the certificate. Details below — scans are on file with us if you need copies.`,
              ``,
              ...openOnes.flatMap((f, n) => [
                `${n + 1}. ${f.person || "Crew-wide"} — ${f.item}${f.code ? ` (${f.code})` : ""}`,
                `   OPMS shows: ${f.opmsSays || "nothing"}`,
                `   Certificate on file: ${f.evidence || f.weSay || "see scan"}`,
                ...(f.action ? [`   Please: ${f.action}`] : []),
                ``,
              ]),
              `Could these be corrected before next week's export? Happy to send the scans through.`,
              ``,
              `Thanks,`,
              `${role || ""}`,
            ].join("\n");
            return (
              <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderLeft: `4px solid ${T.teal}`,
                borderRadius: 2, padding: "13px 15px", marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <Eyebrow color={T.teal}>Email to OPMS · {openOnes.length} item{openOnes.length === 1 ? "" : "s"}</Eyebrow>
                  <span style={{ display: "flex", gap: 8 }}>
                    <Button variant="quiet" onClick={() => {
                      const ta = document.getElementById("opms-email-draft");
                      if (ta) { ta.select(); try { navigator.clipboard.writeText(ta.value); } catch (e) { document.execCommand("copy"); } }
                    }}>Copy</Button>
                    <Button variant="quiet" onClick={() => {
                      const next = { ...(opmsMarks || {}) };
                      openOnes.forEach((f) => { const k = markKey("opms", f);
                        if (!next[k]) next[k] = { status: "sent", on: todayISO(), by: role || "admin" }; });
                      setOpmsMarks(next);
                    }}>Mark all as sent</Button>
                  </span>
                </div>
                <textarea id="opms-email-draft" readOnly value={body} rows={Math.min(18, 6 + openOnes.length * 4)}
                  style={{ width: "100%", marginTop: 10, fontFamily: T.mono, fontSize: 11.5, lineHeight: 1.6,
                    color: T.text, background: T.raised, border: `1px solid ${T.rule}`, borderRadius: 2, padding: 10 }} />
                <div style={{ fontFamily: T.body, fontSize: 12, color: T.muted, marginTop: 6 }}>
                  Copy this into an email to PK, attach the PDF from above, and press Mark all as sent.
                </div>
              </div>
            );
          })()}

          {/* Every certificate side by side, filed under its person. Each crew
              member on the matrix is a fold holding every item either system
              carries: our expiry in the first column, the OPMS export's in the
              second, and the rows — and names — where the two disagree in red.
              The comparison's findings ride on their rows: whose mistake it
              is, the model's sentences behind Details, and the marks. */}
          {(() => {
            const withSide = [
              ...ours.map((f) => ({ f, side: OPMS_SIDES[0] })),
              ...opms.map((f) => ({ f, side: OPMS_SIDES[1] })),
              ...unattributed.map((f) => ({ f, side: null })),
            ];
            const shown = withSide.filter(({ f, side }) => !onlyOpen || !side || !markOf(side.key, f));
            const keyOf = (p) => String(p || "").trim().toUpperCase();
            // The model and the export write names their own way ("Ryan
            // Stewart") and the matrix its way ("STEWART, Ryan"), so the same
            // matching a dropped certificate folder gets decides who each row
            // is about.
            const names = quals && quals.rows ? quals.rows.map((r) => r[0]) : [];
            const canon = (p) => (p ? matchRoster(p, names) || p : "");
            const known = new Set(names.map(keyOf));
            const extras = [];
            shown.forEach(({ f }) => {
              const k = keyOf(canon(f.person));
              if (k && !known.has(k) && !extras.some((e) => keyOf(e) === k)) extras.push(canon(f.person));
            });
            const findsFor = (n) => shown.filter(({ f }) => keyOf(canon(f.person)) === keyOf(n));
            const crewWide = shown.filter(({ f }) => !keyOf(f.person));

            // The export's rows filed under the same names.
            const opmsBy = {};
            (opmsRows || []).forEach((r) => {
              const k = keyOf(canon(r.person));
              (opmsBy[k] = opmsBy[k] || []).push(r);
            });

            /* One person's certificates, both accounts side by side: every
               matrix item either side carries, then whatever the export has
               that the matrix doesn't. What each side says is reduced to a
               date, "held" or "not held" so the two can be compared without
               guessing; a side that says nothing comparable is never called a
               difference, and an item held once and for good keeping a date in
               one system and "held" in the other blames neither. */
            const sideBySide = (n) => {
              const row = (quals.rows || []).find((r) => r[0] === n);
              const vals = row ? row[3] : null;
              const mine = opmsBy[keyOf(n)] || [];
              const used = new Set();
              const items = [];
              (quals.cols || []).forEach((c, i) => {
                const code = c[0];
                const ourRaw = vals && vals[i] != null ? String(vals[i]).trim() : "";
                const o = mine.find((r) => r.code === code && !used.has(r)) || null;
                if (o) used.add(o);
                if (!ourRaw && !o) return;
                const ourKey = !ourRaw ? null
                  : /^y$/i.test(ourRaw) ? "held"
                  : /^n$/i.test(ourRaw) ? "not held"
                  : ourRaw === "?" ? null : ourRaw;
                const opmsKey = !o ? (mine.length ? "not carried" : null)
                  // "Perpetual" and its kin are an expiry column's way of
                  // saying held for good, not a date to disagree over.
                  : o.expiry ? (/^\d{4}-/.test(o.expiry) ? o.expiry : "held")
                  : /in date|about to expire|overridden/i.test(o.status) ? "held"
                  : /missing|outstanding|expired/i.test(o.status) ? "not held" : null;
                const diff = ourKey != null && opmsKey != null && ourKey !== opmsKey
                  && !(ourKey === "held" && /^\d{4}-/.test(opmsKey))
                  && !(opmsKey === "held" && /^\d{4}-/.test(ourKey));
                items.push({ code, title: c[1], ourRaw, o, diff, inExport: mine.length > 0 });
              });
              mine.forEach((r) => {
                if (!used.has(r)) items.push({ code: r.code, title: r.item, ourRaw: "", o: r,
                  diff: false, offMatrix: true, inExport: true });
              });
              return items;
            };

            const ourText = (it) => !it.ourRaw ? "—"
              : /^y$/i.test(it.ourRaw) ? "Held (no expiry)"
              : /^n$/i.test(it.ourRaw) ? "Not held"
              : it.ourRaw === "?" ? "Unknown" : colDate(it.ourRaw);
            const opmsText = (it) => !it.o
              ? (it.inExport ? "not carried" : "—")
              : [it.o.expiry ? (/^\d{4}-/.test(it.o.expiry) ? colDate(it.o.expiry) : it.o.expiry) : "",
                 it.o.status && !/^in date$/i.test(it.o.status) ? it.o.status : ""]
                  .filter(Boolean).join(" · ") || (it.o.status || "—");

            const head = { fontFamily: T.display, fontSize: 9.5, fontWeight: 700,
              letterSpacing: "0.1em", textTransform: "uppercase", color: T.muted };

            // One item's row: the two accounts in red where they differ or the
            // comparison flagged them, with that finding's verdict and marks.
            const dataRow = (n, it, i, finds) => {
              const fr = finds.find(({ f }) => it.code && keyOf(f.code) === keyOf(it.code)) || null;
              const hot = it.diff || !!fr;
              const cell = { fontFamily: T.mono, fontSize: 11, flex: "1 1 130px", minWidth: 0,
                lineHeight: 1.6, overflowWrap: "anywhere",
                color: hot ? T.bRed : (it.offMatrix || !it.ourRaw || !it.o) ? T.muted : T.text };
              const dKey = `data-${n}-${it.code || it.title}-${i}`;
              const openThis = detailFor === dKey;
              const f = fr && fr.f, side = fr && fr.side;
              return (
                <div key={dKey} style={{ padding: "6px 0", borderBottom: `1px solid ${T.rule}` }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span style={{ fontFamily: T.body, fontSize: 12.5, color: hot ? T.bRed : T.text,
                      flex: "1 1 220px", minWidth: 0 }}>
                      {it.title || "unnamed item"}
                      {it.code ? <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent }}> {it.code}</span> : null}
                    </span>
                    <span style={cell}>{ourText(it)}</span>
                    <span style={cell}>{opmsText(it)}</span>
                    <span style={{ display: "flex", gap: 6, alignItems: "baseline", justifyContent: "flex-end",
                      flexWrap: "wrap", minWidth: 130 }}>
                      {fr && (side
                        ? <Chip fg={side.fg} bg={side.bg}>{side.key === "ours" ? "ours to fix" : "OPMS to fix"}</Chip>
                        : <Chip fg={T.muted} bg={T.raised}>no certificate</Chip>)}
                      {f && (f.detail || f.evidence || f.action) && (
                        <button className="um-btn" onClick={() => setDetailFor(openThis ? null : dKey)}
                          style={{ background: "transparent", color: T.muted, fontSize: 9.5, fontWeight: 700, padding: "2px 0" }}>
                          {openThis ? "Close" : "Details"}
                        </button>
                      )}
                    </span>
                  </div>
                  {f && openThis && (
                    <div style={{ background: T.raised, borderRadius: 2, padding: "8px 11px", marginTop: 6 }}>
                      <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
                        OPMS <span style={{ color: T.text }}>{f.opmsSays || "nothing"}</span>
                        {"  ·  "}OURS <span style={{ color: T.text }}>{f.weSay || "nothing"}</span>
                      </div>
                      {f.detail && <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, lineHeight: 1.6, marginTop: 4 }}>{f.detail}</div>}
                      {f.evidence && <div style={{ fontFamily: T.body, fontSize: 12.5, color: side ? side.fg : T.muted, lineHeight: 1.6, marginTop: 4 }}>{f.evidence}</div>}
                      {f.action && <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, lineHeight: 1.6, marginTop: 4 }}>{f.action}</div>}
                    </div>
                  )}
                  {f && side && side.key && (() => {
                    const mk = markOf(side.key, f);
                    const steps = side.key === "opms"
                      ? [{ st: "sent", label: "Sent to OPMS" }, { st: "fixed", label: "Settled" }]
                      : [{ st: "fixed", label: "Fixed on our side" }];
                    return (
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 5 }}>
                        {steps.map(({ st, label }) => {
                          const on = mk && mk.status === st;
                          return (
                            <button key={st} className="um-btn" onClick={() => setMark(side.key, f, st)}
                              title={on ? `${label} ${fmtDate(mk.on)} — press to clear` : `Mark as ${label.toLowerCase()}`}
                              style={{ background: on ? T.accentSoft : "transparent", color: on ? T.accent : T.muted,
                                border: `1px solid ${on ? T.accent : T.rule}`, borderRadius: 2,
                                padding: "2px 8px", fontSize: 9.5, fontWeight: 700 }}>
                              {label}{on ? ` · ${fmtDate(mk.on)}` : ""}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              );
            };

            const groups = [
              ...[...names, ...extras].map((n) => ({ name: n })),
              ...(crewWide.length ? [{ name: "The crew as a whole", cw: true }] : []),
            ];

            return (
              <div style={{ marginBottom: 14 }}>
                {!opmsRows && opmsSheet && (
                  <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, lineHeight: 1.6, marginBottom: 8 }}>
                    Reading the OPMS export off the spreadsheet — if this line stays, the sheet couldn't
                    be read in this browser and the OPMS column shows only what the comparison reported.
                  </div>
                )}
                {groups.map(({ name, cw }) => {
                  const finds = cw ? crewWide : findsFor(name);
                  const items = cw ? [] : sideBySide(name);
                  const matched = new Set();
                  items.forEach((it) => {
                    const fr = finds.find(({ f }) => it.code && keyOf(f.code) === keyOf(it.code));
                    if (fr) matched.add(fr);
                  });
                  const loose = cw ? finds : finds.filter((x) => !matched.has(x));
                  const hotCount = items.filter((it) =>
                    it.diff || finds.some(({ f }) => it.code && keyOf(f.code) === keyOf(it.code))).length + loose.length;
                  const bad = hotCount > 0;
                  return (
                    <details key={name} open style={{ background: T.panel, border: `1px solid ${T.rule}`,
                      borderLeft: `4px solid ${bad ? T.bRed : T.teal}`, borderRadius: 2,
                      marginBottom: 6, padding: "0 15px" }}>
                      <summary style={{ cursor: "pointer", padding: "11px 0", fontFamily: T.body }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: bad ? T.bRed : T.text }}>{name}</span>
                        <span style={{ fontFamily: T.mono, fontSize: 10.5, color: bad ? T.bRed : T.muted, marginLeft: 10 }}>
                          {bad ? `${hotCount} difference${hotCount === 1 ? "" : "s"}`
                            : items.length ? `${items.length} items · agree` : "agrees"}
                        </span>
                      </summary>
                      <div style={{ paddingBottom: 11 }}>
                        {items.length > 0 && (
                          <>
                            <div className="um-datehead" style={{ display: "flex", gap: 10, alignItems: "baseline",
                              padding: "2px 0 5px", borderBottom: `2px solid ${T.rule}` }}>
                              <span style={{ ...head, flex: "1 1 220px" }}>Certificate</span>
                              <span style={{ ...head, flex: "1 1 130px" }}>Our expiry</span>
                              <span style={{ ...head, flex: "1 1 130px" }}>OPMS expiry</span>
                              <span style={{ minWidth: 130 }} />
                            </div>
                            {items.map((it, i) => dataRow(name, it, i, finds))}
                          </>
                        )}
                        {loose.map(({ f, side }, i) => findingRow(f, i, side))}
                        {items.length === 0 && loose.length === 0 && (
                          <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, lineHeight: 1.6 }}>
                            Nothing on either side for this name.
                          </div>
                        )}
                      </div>
                    </details>
                  );
                })}
              </div>
            );
          })()}

          {notes.length > 0 && (
            <details style={{ background: T.raised, border: `1px solid ${T.rule}`, borderRadius: 2,
              padding: "13px 15px" }}>
              <summary style={{ cursor: "pointer" }}><Eyebrow>What couldn't be compared · {notes.length}</Eyebrow></summary>
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.8, marginTop: 7 }}>
                {notes.map((n, i) => <div key={i}>{n}</div>)}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
