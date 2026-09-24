/* E-Learning Status — the Admin tab of that name.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state; this
 * holds what is only this tab's. See tools/source.mjs.
 */
function ELearningStatus() {
  const { quals: QUALS, certSheet, certDates, validityPeriods, validityMatrix, matrixUpdated } = usePortal();
  // When the matrix was last brought up to the certificates - the round's
  // own stamp, or the spreadsheet's filing date where none has run yet.
  const lastUpdated = matrixUpdated || (certSheet && certSheet.uploaded) || "";
  const [view, setView] = useState("crew");
  const [q, setQ] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  // Which module's line is dropped open on the By module view, by code.
  const [openModule, setOpenModule] = useState(null);

  // Each module's validity period, off the skills matrix — the same
  // lookup the rest of the certification screens and their PDFs read from.
  const validityFor = useValidityLookup();

  const cols = useMemo(
    () => QUALS.cols
      .map((c, i) => ({ code: c[0], title: c[1], group: c[2], i }))
      // The named exceptions too — modules filed under another group but sat
      // at a computer all the same: VS-04 Helm CONNECT, and anything MRN, MRM
      // or MinRes issue.
      .filter((c) => ELEARNING_GROUPS.includes(c.group) || isELearningItem(c.code, c.title)),
    [QUALS],
  );

  const crew = useMemo(
    () =>
      QUALS.rows.map((r) => {
        // Only what this person is actually tracked against - a blank column on
        // the matrix means the module was never asked of them, and counting it
        // as outstanding would put everyone permanently behind.
        const modules = cols
          .map((c) => ({ code: c.code, title: c.title, group: c.group, value: r[3][c.i], band: bandFor(r[3][c.i]) }))
          .filter((x) => x.band)
          .map((x) => ({ ...x, state: moduleState(x) }));
        const count = (s) => modules.filter((x) => x.state === s).length;
        const done = count("done");
        return {
          name: r[0], position: r[1], modules, done,
          overdue: count("overdue"),
          outstanding: count("outstanding"),
          unconfirmed: count("unconfirmed"),
          pct: modules.length ? Math.floor((done / modules.length) * 100) : 100,
        };
      }),
    [QUALS, cols],
  );

  const shownCrew = crew
    .filter((c) => !onlyOpen || c.pct < 100)
    .filter((c) => !q || (c.name + " " + c.position).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.pct - b.pct || a.name.localeCompare(b.name));

  // The same thing read down the columns: which module the crew are behind on,
  // which is what gets chased with the training provider rather than the person.
  const byModule = useMemo(() => {
    const rows = cols.map((c) => {
      // Who each line is about is kept with it, so opening a module can list
      // the crew it is tracked against rather than just count them.
      const held = crew.flatMap((p) => p.modules
        .filter((m) => m.code === c.code)
        .map((m) => ({ ...m, person: p.name, position: p.position })));
      const done = held.filter((m) => m.state === "done").length;
      return {
        ...c, tracked: held.length, done, people: held,
        open: held.length - done,
        // Rounded down all the way through, here and per person: one module
        // outstanding across the whole crew rounds up to 100% and reads as
        // finished, which is exactly the thing this page exists to catch.
        pct: held.length ? Math.floor((done / held.length) * 100) : 100,
      };
    });
    return rows.filter((r) => r.tracked > 0).sort((a, b) => a.pct - b.pct || a.code.localeCompare(b.code));
  }, [cols, crew]);

  const shownModules = byModule
    .filter((m) => !onlyOpen || m.open > 0)
    .filter((m) => !q || (m.code + " " + m.title).toLowerCase().includes(q.toLowerCase()));

  const total = (k) => crew.reduce((n, c) => n + c[k], 0);
  const trackedTotal = crew.reduce((n, c) => n + c.modules.length, 0);
  const doneTotal = total("done");
  const complete = crew.filter((c) => c.modules.length && c.pct === 100).length;

  const bar = (pct, colour) => (
    <div className="um-bar" style={{ width: 96 }}><i style={{ width: `${pct}%`, background: colour }} /></div>
  );

  const colourFor = (pct) => (pct === 100 ? T.teal : pct >= 75 ? T.bYellow : pct >= 50 ? T.bOrange : T.bRed);

  const tile = (label, value, colour) => (
    <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderLeft: `3px solid ${colour}`,
      borderRadius: 2, padding: "10px 13px", flex: "1 1 130px" }}>
      <Eyebrow>{label}</Eyebrow>
      <div style={{ fontFamily: T.display, fontSize: 25, fontWeight: 700, color: colour, marginTop: 5, lineHeight: 1 }}>{value}</div>
    </div>
  );

  const asPDF = () => ({
    title: "E-learning status",
    subtitle: `${VESSEL.name} ${VESSEL.nameAccent} · as at ${fmtDate(TODAY)} · `
      + `${doneTotal} of ${trackedTotal} modules complete · ${complete} of ${crew.length} crew fully up to date`,
    filename: `e-learning-status-${TODAY}.pdf`,
    empty: "No e-learning modules on the matrix.",
    // Every module tracked against each person, as the screen lists them — the
    // ones still outstanding lead, and what is already done follows with the
    // dates it was done on and runs to, which is the part somebody reading this
    // away from the portal has no other way of seeing.
    groups: shownCrew.map((c) => ({
      heading: c.name,
      meta: `${c.position} · ${c.done} of ${c.modules.length} complete`,
      items: [
        ...c.modules.filter((m) => m.state !== "done"),
        ...c.modules.filter((m) => m.state === "done"),
      ].map(pdfLineIn({ person: c.name, dates: certDates, validityFor })),
    })).filter((g) => g.items.length),
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 14,
        flexWrap: "wrap", marginBottom: 7 }}>
        <div style={{ textAlign: "right" }}>
          <Eyebrow>Matrix last updated</Eyebrow>
          <div style={{ fontFamily: T.mono, fontSize: 12, marginTop: 4,
            color: lastUpdated ? T.text : T.muted }}>
            {lastUpdated ? fmtDate(lastUpdated) : "No spreadsheet uploaded yet"}
          </div>
        </div>
        <UpdateMatrixButton />
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        {tile("Modules complete", trackedTotal ? `${Math.floor((doneTotal / trackedTotal) * 100)}%` : "—", T.teal)}
        {tile("Crew fully up to date", `${complete}/${crew.length}`, complete === crew.length ? T.teal : T.bOrange)}
        {tile("Overdue", total("overdue"), T.bRed)}
        {tile("Not done", total("outstanding"), T.bRed)}
        {tile("Unconfirmed", total("unconfirmed"), T.muted)}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
        {[{ id: "crew", label: "By crew" }, { id: "module", label: "By module" }].map((v) => (
          <button key={v.id} className="um-btn" onClick={() => setView(v.id)}
            style={{ background: view === v.id ? T.accent : "transparent", color: view === v.id ? "#fff" : T.muted,
              border: `1px solid ${view === v.id ? T.accent : T.rule}`, borderRadius: 2,
              padding: "7px 11px", fontSize: 11, fontWeight: 700 }}>
            {v.label}
          </button>
        ))}
        <button className="um-btn" onClick={() => setOnlyOpen(!onlyOpen)}
          style={{ background: onlyOpen ? T.bOrange : "transparent", color: onlyOpen ? "#fff" : T.bOrange,
            border: `1px solid ${T.bOrange}`, borderRadius: 2, padding: "7px 11px", fontSize: 11, fontWeight: 700 }}>
          Not complete only
        </button>
        <input className="um-in" style={{ flex: 1, minWidth: 170 }} value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={view === "crew" ? "Search crew or position" : "Search module or code"} />
        <DownloadPDF build={asPDF} variant="quiet" />
      </div>

      {view === "crew" ? (
        shownCrew.length === 0 ? (
          <Empty>{onlyOpen ? "Every crew member is up to date." : "Nothing matches that search."}</Empty>
        ) : shownCrew.map((c) => {
          const colour = colourFor(c.pct);
          return (
            <div key={c.name} style={{ background: T.panel, border: `1px solid ${T.rule}`,
              borderLeft: `3px solid ${colour}`, borderRadius: 2, marginBottom: 8 }}>
              <div style={{ width: "100%", textAlign: "left", padding: "11px 13px",
                  display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span style={{ fontFamily: T.body, fontSize: 14, fontWeight: 600, color: T.text,
                  textTransform: "none", letterSpacing: 0, flex: "1 1 200px" }}>
                  {c.name}
                  <span style={{ color: T.muted, fontWeight: 400 }}> · {c.position}</span>
                </span>
                <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  {c.overdue > 0 && <Chip fg={T.bRed} bg={T.bRedBg}>{c.overdue} overdue</Chip>}
                  {c.outstanding > 0 && <Chip fg={T.bRed} bg={T.bRedBg}>{c.outstanding} not done</Chip>}
                  {c.unconfirmed > 0 && <Chip fg={T.muted} bg={T.raised}>{c.unconfirmed} unconfirmed</Chip>}
                  {bar(c.pct, colour)}
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: colour, letterSpacing: 0, minWidth: 74 }}>
                    {c.done}/{c.modules.length} · {c.pct}%
                  </span>
                </span>
              </div>

                <div style={{ padding: "0 13px 12px" }}>
                  {c.modules.length === 0
                    ? <Empty>No modules tracked against this person.</Empty>
                    : (
                      <>
                        <DateColsHead validity />
                        {c.modules.map((m) => (
                          <ItemLine key={m.code} x={m} person={c.name} dates={certDates}
                            validity={validityFor(m)} />
                        ))}
                      </>
                    )}
                </div>
            </div>
          );
        })
      ) : shownModules.length === 0 ? (
        <Empty>{onlyOpen ? "Every module is complete across the crew." : "Nothing matches that search."}</Empty>
      ) : (
        <div>
          {shownModules.map((m) => {
            const colour = colourFor(m.pct);
            const opened = openModule === m.code;
            const validity = validityFor(m);
            // The crew behind the numbers, worked out only for the line that is
            // open: each person the module is tracked against, the completion
            // date read off their certificate, and the expiry the matrix holds
            // (or, where it holds none, the one the certificate carries). The
            // ones still to do it lead, then oldest completion to newest — the
            // order they fall due again in. Where no completion date was ever
            // read, the expiry stands in so the line still sorts by urgency.
            const people = !opened ? [] : m.people
              .map((p) => {
                const d = certDateFor(certDates, p.person, m.code);
                return {
                  ...p,
                  completed: (d && d.issued) || null,
                  expires: p.band.date || (d && d.expires) || null,
                };
              })
              .sort((a, b) => {
                const ka = a.completed || a.expires || "";
                const kb = b.completed || b.expires || "";
                if (!ka && !kb) return a.person.localeCompare(b.person);
                if (!ka || !kb) return ka ? 1 : -1;
                return ka.localeCompare(kb) || a.person.localeCompare(b.person);
              });
            const head = { fontFamily: T.display, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em",
              textTransform: "uppercase", color: T.muted, minWidth: 78 };
            return (
              <div key={m.code} style={{ borderBottom: `1px solid ${T.rule}` }}>
                <button className="um-btn" aria-expanded={opened}
                  onClick={() => setOpenModule(opened ? null : m.code)}
                  title={opened ? "Close the crew list" : "Show every crew member this module is tracked against"}
                  style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
                    width: "100%", textAlign: "left", padding: "9px 0", background: "transparent",
                    border: 0, textTransform: "none", letterSpacing: 0 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, width: 11 }}>{opened ? "▾" : "▸"}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, minWidth: 46 }}>{m.code}</span>
                  <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1, minWidth: 200 }}>
                    {m.title}
                    <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, marginLeft: 8 }}>{m.group}</span>
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 10.5, color: validity ? T.text : T.muted, minWidth: 92 }}
                    title="How long the module stays valid, off the skills matrix">
                    {validity || "—"}
                  </span>
                  {m.open > 0 && <Chip fg={T.bRed} bg={T.bRedBg}>{m.open} outstanding</Chip>}
                  {bar(m.pct, colour)}
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: colour, minWidth: 74 }}>
                    {m.done}/{m.tracked} · {m.pct}%
                  </span>
                </button>

                {opened && (
                  <div style={{ padding: "0 0 12px 23px" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "baseline",
                      padding: "6px 0 4px", borderBottom: `2px solid ${T.rule}` }}>
                      <span style={{ ...head, flex: 1, minWidth: 180 }}>Crew · {people.length}</span>
                      <span style={{ ...head, minWidth: 92 }}>Module validity</span>
                      <span style={head}>Completed</span>
                      <span style={head}>Expiry date</span>
                      <span style={{ ...head, minWidth: 110, textAlign: "right" }}>Status</span>
                    </div>
                    {people.map((p) => (
                      <div key={p.person} style={{ display: "flex", gap: 10, alignItems: "baseline",
                        flexWrap: "wrap", padding: "5px 0", borderBottom: `1px solid ${T.rule}` }}>
                        <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1, minWidth: 180 }}>
                          {p.person}
                          <span style={{ color: T.muted }}> · {p.position}</span>
                        </span>
                        <span style={{ fontFamily: T.mono, fontSize: 10.5, color: validity ? T.text : T.muted, minWidth: 92 }}>
                          {validity || "—"}
                        </span>
                        <span style={{ fontFamily: T.mono, fontSize: 10.5, color: p.completed ? T.text : T.muted, minWidth: 78 }}>
                          {colDate(p.completed)}
                        </span>
                        <span style={{ fontFamily: T.mono, fontSize: 10.5, color: p.expires ? T.text : T.muted, minWidth: 78 }}>
                          {colDate(p.expires)}
                        </span>
                        <span style={{ minWidth: 110, display: "flex", justifyContent: "flex-end" }}>
                          <BandTag band={p.band} />
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
