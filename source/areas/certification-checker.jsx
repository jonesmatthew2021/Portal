/* Certification Checker — the Admin tab of that name.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state; this
 * holds what is only this tab's. See tools/source.mjs.
 */
function CertChecker() {
  const { quals: QUALS, certSheet, certDates, certificates, renewalMarks } = usePortal();
  const validityFor = useValidityLookup();
  const [q, setQ] = useState("");
  // Hiding what is already in motion leaves the true to-do list: red items
  // nothing has been done about yet.
  const [onlyUntouched, setOnlyUntouched] = useState(false);

  // A gap is anything held but not valid: expired, marked N, or unknown.
  const gapsFor = (row) =>
    QUALS.cols.map((c, i) => ({ code: c[0], title: c[1], group: c[2], value: row[3][i], band: bandFor(row[3][i]) }))
      .filter((x) => x.band && (
        (x.band.date && daysTo(x.band.date) < 0) || x.band.key === "not" || x.band.key === "unknown"));

  const kindOf = (x) => (x.band.date ? "expired" : x.band.key === "not" ? "missing" : "unknown");

  const all = QUALS.rows.map((r) => ({ row: r, gaps: gapsFor(r) })).filter((x) => x.gaps.length);

  const count = (k) => all.reduce((n, x) => n + x.gaps.filter((g) => kindOf(g) === k).length, 0);

  // One entry per tile. The tile is the button, and the section it drops open
  // is this list of gaps narrowed by `keep`.
  const SECTIONS = [
    { key: "missing", label: "Not held", colour: T.bRed, value: count("missing"),
      keep: (g) => kindOf(g) === "missing",
      blurb: "Certificates marked as not held." },
    { key: "expired", label: "Expired", colour: T.bOrange, value: count("expired"),
      keep: (g) => kindOf(g) === "expired",
      blurb: "Certificates that are past their expiry date." },
    { key: "unknown", label: "Unconfirmed", colour: T.muted, value: count("unknown"),
      keep: (g) => kindOf(g) === "unknown",
      blurb: "Certificates left with a question mark. Nobody has said yes or no yet." },
  ];

  const sectionFor = (key) => SECTIONS.find((s) => s.key === key) || SECTIONS[0];

  const listWith = (keep) => all
    .map((x) => ({
      row: x.row,
      gaps: x.gaps.filter((g) => keep(g, x.row)),
    }))
    .filter((x) => x.gaps.length)
    .filter((x) => !q || (x.row[0] + " " + x.row[1]).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.gaps.length - a.gaps.length);

  // The unconfirmed section keeps its lines either way — marks are about
  // renewals, and a question mark isn't a renewal.
  const listFor = (key) => listWith((g, row) => sectionFor(key).keep(g)
    && (!onlyUntouched || kindOf(g) === "unknown" || !renewalMarkFor(renewalMarks, row[0], g.code)));

  // How many red items already have a mark against them — what the
  // nothing-done-yet filter would hide.
  const inMotion = all.reduce((n, x) => n + x.gaps.filter((g) =>
    kindOf(g) !== "unknown" && renewalMarkFor(renewalMarks, x.row[0], g.code)).length, 0);

  // Every section is written out in full below the tiles, so the PDF simply
  // carries the whole list.
  const printed = listWith(() => true);

  // Every item whose certificate was issued by an authority that doesn't read
  // as Australian — valid or not, because the flag is about who issued it,
  // not when it runs out.
  const foreign = QUALS.rows
    .map((row) => ({
      row,
      items: QUALS.cols
        .map((c, i) => ({ code: c[0], title: c[1], group: c[2], value: row[3][i], band: bandFor(row[3][i]) }))
        .map((x) => ({ ...x, foreignIssuer: foreignIssuerOf(certDateFor(certDates, row[0], x.code), x.title) }))
        .filter((x) => x.foreignIssuer),
    }))
    .filter((x) => x.items.length)
    .filter((x) => !q || (x.row[0] + " " + x.row[1]).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.items.length - a.items.length);
  const foreignCount = foreign.reduce((n, x) => n + x.items.length, 0);
  // Whether any issuing authorities have been read into the table at all —
  // when none have, the flag has nothing to go on and says so instead.
  const issuersKnown = !!(certDates && certDates.map && Object.values(certDates.map).some((d) => d && d.issuer));

  const tile = (s) => {
    // A plain figure. The lists it counts are always open underneath, so the
    // tile has nothing to press.
    const edge = `1px solid ${T.rule}`;
    return (
      <div key={s.key}
        style={{ background: T.panel,
          borderTop: edge, borderRight: edge, borderBottom: edge,
          borderLeft: `3px solid ${s.colour}`,
          borderRadius: 2, padding: "10px 13px", flex: "1 1 130px", textAlign: "left" }}>
        <Eyebrow color={T.muted}>{s.label}</Eyebrow>
        <div style={{ fontFamily: T.display, fontSize: 25, fontWeight: 700, color: s.colour, marginTop: 5, lineHeight: 1 }}>{s.value}</div>
      </div>
    );
  };

  // Whatever is on screen, filters and all, written out as a PDF to hand over.
  const asPDF = () => ({
    title: "Certification gaps",
    subtitle: `${VESSEL.name} ${VESSEL.nameAccent} · as at ${fmtDate(TODAY)} · ${printed.length} crew · `
      + `${count("expired")} expired · ${count("missing")} not held · ${count("unknown")} unconfirmed`
      + (inMotion ? ` · ${inMotion} in motion` : "")
      + (q ? ` · matching "${q}"` : ""),
    filename: `certification-gaps-${TODAY}.pdf`,
    empty: "No gaps - everything on the matrix is valid.",
    groups: printed.map(({ row, gaps }) => ({
      heading: row[0],
      meta: `${row[1]} · ${gaps.length} ${gaps.length === 1 ? "item" : "items"}`,
      // Each line carries its renewal mark, so the printed list says not just
      // what is red but what is already being done about it.
      items: gaps.map((g) => {
        const line = pdfLineIn({ person: row[0], dates: certDates, validityFor })(g);
        const mk = kindOf(g) !== "unknown" && renewalMarkFor(renewalMarks, row[0], g.code);
        if (mk) line.notes = [{
          text: `${(renewalStepOf(mk.status) || { label: mk.status }).label} ${fmtDate(mk.on)}${mk.note ? ` — ${mk.note}` : ""}`,
          fg: T.accent,
        }];
        return line;
      }),
    })),
  });

  return (
    <div>
      {/* Sits above the far right of the tiles, over Unconfirmed: the day the
          crew certificates spreadsheet was last uploaded. The button that
          re-checks every certificate moved to Documents,
          renamed Update certificate list. */}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 14,
        flexWrap: "wrap", marginBottom: 7 }}>
        <div style={{ textAlign: "right" }}>
          <Eyebrow>Date last updated</Eyebrow>
          <div style={{ fontFamily: T.mono, fontSize: 12, marginTop: 4,
            color: certSheet && certSheet.uploaded ? T.text : T.muted }}>
            {certSheet && certSheet.uploaded ? fmtDate(certSheet.uploaded) : "No spreadsheet uploaded yet"}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        {SECTIONS.map(tile)}
        {tile({ key: "foreign", label: "Not Australian", colour: T.violet, value: foreignCount })}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <input className="um-in" style={{ flex: 1, minWidth: 170 }} value={q}
          onChange={(e) => setQ(e.target.value)} placeholder="Search crew or position" />
        <Button variant={onlyUntouched ? "solid" : "quiet"}
          title="Hide items already marked Booked, Chased, or Evidence in — what's left is the to-do list"
          onClick={() => setOnlyUntouched(!onlyUntouched)}>
          Nothing done yet{inMotion ? ` · hides ${inMotion}` : ""}
        </Button>
        <DownloadPDF build={asPDF} variant="quiet" />
      </div>

      {/* The notes used to sit here as well. They are kept on Required
          Documents For Upload now, which is the one place they are written —
          the same notes either way, because both read certNotes. */}

      <div id="cert-gap-detail">
        {all.length === 0 ? (
          <Empty>No gaps - everything on the matrix is valid.</Empty>
        ) : SECTIONS.map((s) => {
          const rows = listFor(s.key);
          return (
          <div key={s.key} style={{ marginBottom: 26 }}>
            <div style={{ borderTop: `2px solid ${s.colour}`, paddingTop: 9, marginBottom: 11 }}>
              <div style={{ maxWidth: 640 }}>
                <Eyebrow color={T.text}>{s.label} · {s.value}</Eyebrow>
                <div style={{ fontFamily: T.body, fontSize: 13, color: T.muted, lineHeight: 1.6, marginTop: 3 }}>
                  {s.blurb}
                </div>
              </div>
            </div>

            {rows.length === 0 ? (
              <Empty>{q ? "Nothing in this section matches that search." : "Nothing in this section."}</Empty>
            ) : (
              <>
                <DateColsHead trail={248} validity />
                {rows.map(({ row, gaps }) => (
              <div key={row[0] + row[2]} style={{ marginBottom: 12, breakInside: "avoid" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12,
                  flexWrap: "wrap", background: T.raised, padding: "5px 9px", borderRadius: 2 }}>
                  <span style={{ fontFamily: T.body, fontSize: 14, fontWeight: 600, color: T.text }}>{row[0]}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
                    {row[1]} · {gaps.length} {gaps.length === 1 ? "item" : "items"}
                  </span>
                </div>
                {gaps.map((x) => {
                  const d = certDateFor(certDates, row[0], x.code);
                  const validity = validityFor(x);
                  const from = foreignIssuerOf(d, x.title);
                  return (
                  <div key={x.code} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
                    padding: "4px 0 4px 4px", borderBottom: `1px solid ${T.rule}`,
                    background: from ? T.violetBg : "transparent",
                    borderLeft: from ? `3px solid ${T.violet}` : "3px solid transparent" }}>
                    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, minWidth: 46 }}>{x.code}</span>
                    <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1, minWidth: 180 }}>
                      {x.title}
                      {from && (
                        <span title={`Issued by ${from} — reads as another country's authority, not an Australian one`}
                          style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, background: T.panel,
                            color: T.violet, border: `1px solid ${T.violet}`, borderRadius: 2,
                            padding: "1px 6px", marginLeft: 8, whiteSpace: "nowrap" }}>
                          NOT AU · {from}
                        </span>
                      )}
                    </span>
                    <span style={{ fontFamily: T.mono, fontSize: 10.5, color: validity ? T.text : T.muted, minWidth: 92 }}>
                      {validity || "—"}
                    </span>
                    <DateCols issued={d && d.issued} expires={x.band.date || (d && d.expires)} />
                    <CertCell url={certLinkFor(certDates, certificates, row[0], x.code)}
                      person={row[0]} code={x.code} title={x.title} />
                    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, minWidth: 88 }}>{x.group}</span>
                    <span style={{ minWidth: 110, display: "flex", justifyContent: "flex-end" }}>
                      <BandTag band={x.band} />
                    </span>
                    {kindOf(x) !== "unknown" && <RenewalMark person={row[0]} code={x.code} />}
                  </div>
                  );
                })}
              </div>
                ))}
              </>
            )}
          </div>
          );
        })}

        {/* Every certificate issued by an authority that doesn't read as
            Australian, valid or not — the flag is about who issued it. */}
        {foreignCount > 0 && (
          <div style={{ marginBottom: 26 }}>
            <div style={{ borderTop: `2px solid ${T.violet}`, paddingTop: 9, marginBottom: 11 }}>
              <div style={{ maxWidth: 640 }}>
                <Eyebrow color={T.text}>Not Australian-certified · {foreignCount}</Eyebrow>
              </div>
            </div>
            <DateColsHead trail={248} validity />
            {foreign.map(({ row, items }) => (
              <div key={row[0] + row[2]} style={{ marginBottom: 12, breakInside: "avoid" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12,
                  flexWrap: "wrap", background: T.raised, padding: "5px 9px", borderRadius: 2 }}>
                  <span style={{ fontFamily: T.body, fontSize: 14, fontWeight: 600, color: T.text }}>{row[0]}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
                    {row[1]} · {items.length} {items.length === 1 ? "item" : "items"}
                  </span>
                </div>
                {items.map((x) => {
                  const d = certDateFor(certDates, row[0], x.code);
                  const validity = validityFor(x);
                  return (
                  <div key={x.code} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
                    padding: "4px 0 4px 4px", borderBottom: `1px solid ${T.rule}`,
                    background: T.violetBg, borderLeft: `3px solid ${T.violet}` }}>
                    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, minWidth: 46 }}>{x.code}</span>
                    <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1, minWidth: 180 }}>
                      {x.title}
                      <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, background: T.panel,
                        color: T.violet, border: `1px solid ${T.violet}`, borderRadius: 2,
                        padding: "1px 6px", marginLeft: 8, whiteSpace: "nowrap" }}>
                        {x.foreignIssuer}
                      </span>
                    </span>
                    <span style={{ fontFamily: T.mono, fontSize: 10.5, color: validity ? T.text : T.muted, minWidth: 92 }}>
                      {validity || "—"}
                    </span>
                    <DateCols issued={d && d.issued} expires={(x.band && x.band.date) || (d && d.expires)} />
                    <CertCell url={certLinkFor(certDates, certificates, row[0], x.code)}
                      person={row[0]} code={x.code} title={x.title} />
                    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, minWidth: 88 }}>{x.group}</span>
                    <span style={{ minWidth: 110, display: "flex", justifyContent: "flex-end" }}>
                      {x.band ? <BandTag band={x.band} /> : null}
                    </span>
                  </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
