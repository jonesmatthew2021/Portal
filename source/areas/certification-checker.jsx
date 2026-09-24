/* The gaps list — what is expired, not held or unconfirmed on the matrix,
 * with the renewal marks against each. It was the Certification Checker,
 * an Admin page of its own; it opens on the Crew Matrix now, under Needs
 * attention, for management. The matrix's own search box drives it when it
 * is shown there, so there is one box, not two.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state; this
 * holds what is only this section's. See tools/source.mjs.
 */
/* The lines the Marine Orders put on Needs attention for one crew row.
   Four things the eight orders decide that nothing on the grid could say
   for itself. Each is a pure rule in source/shared/, run here over the
   matrix as it stands and the certificates the portal has read:

     - a recognition whose foreign certificate nobody holds and which does
       not print its expiry: the date in the cell is a date the portal
       cannot check (MO70 s 33(2), s 37(4));
     - a medical whose printed expiry is longer than MO76 s 16(1) allows
       for the holder's age on the day of the examination;
     - a certificate in the red band that cannot be renewed at all,
       because something the order wants in hand went first (MO70 s 25,
       MO71 Sch 4 4.2, MO72 Sch 4 4.2, MO73 Sch 4, MO505 s 9(3)(b));
     - a certificate that has gone but which one of the five papers the
       orders allow still carries (MO70 s 15(3), MO504 s 16(2),
       MO505 s 7(3), ss 22-24, s 12(2)).

   A blank answer from any of them is nothing on the screen. Pure, so the
   rule tests can hold it to its answers: `row` is the matrix row, `cols`
   the columns, `dates` the round's certDates, `needs` the columns this
   position has to hold, `person` the register's entry for him (the date
   of birth), and `rules` the renewal rules and the medical's codes. */
function marineOrderLines(row, cols, dates, needs, person, todayISO, rules) {
  const out = [];
  const held = {};
  cols.forEach((c, i) => { held[c[0]] = row[3][i]; });
  /* Whether a line about a column is worth putting on the management
     list. A cell that is red, not held or unconfirmed is pressing whatever
     the seat; a column nobody in this seat must hold is nobody's work to
     do. With no skills matrix read there is nothing to ask, so a blank cell
     says nothing either way - the same as the grid, which marks no cell
     Missing without it. */
  const pressing = (code) => {
    const b = bandFor(held[code]);
    return !!b && (b.key === "red" || b.key === "not" || b.key === "unknown");
  };

  cols.forEach((c) => {
    const d = certDateFor(dates, row[0], c[0]);
    /* A recognition whose foreign certificate nobody holds is a date the
       portal cannot check: said where the seat has to hold the column or
       the cell is pressing, and not for a column this seat never needs. */
    if (d && d.recognition && d.foreignUnknown && (needs.has(c[0]) || pressing(c[0]))) {
      out.push({ code: c[0], text: `${row[0]} — ${c[0]}: the certificate the recognition is for is not on the portal` });
    }
    /* A paper, only where there is something for it to carry - the same
       test the cell itself uses (bandWithCover): a pressing cell, or a
       required cell with nothing in it. A man whose certificate is current
       with a spent letter still on file is nobody's work to do. */
    const cover = certCoverFor(dates, row[0], c[0]);
    const carrying = bandFor(held[c[0]]) ? pressing(c[0]) : needs.has(c[0]);
    if (cover && carrying) out.push({ code: c[0], text: `${row[0]} — ${c[0]}: ${coverLine(cover)}` });
  });

  rules.medicalCodes.forEach((code) => {
    const d = certDateFor(dates, row[0], code);
    if (!d) return;
    const said = medicalTooLong(
      { rowId: "", issuedOn: d.issued, assessedOn: d.assessedOn, expiresOn: d.expires, conditions: d.conditions },
      person && person.dob, todayISO,
    );
    if (said) out.push({ code, text: `${row[0]} — medical expires ${fmtDate(d.expires)}, longer than the law allows for their age` });
  });

  renewalBlockers(row[0], held, todayISO, rules.renewal).forEach((b) => {
    const parts = [
      ...b.expired.map((n) => `${n} is expired`),
      ...b.missing.map((n) => `${n} is not held`),
    ];
    out.push({ code: b.code, text: `${row[0]} — ${b.code} cannot be renewed: ${parts.join(", ")}` });
  });

  return out;
}

function CertChecker({ query }) {
  const { quals: QUALS, certDates, certificates, renewalMarks, people, skillsRequirements } = usePortal();
  const validityFor = useValidityLookup();
  const [own, setOwn] = useState("");
  const q = query != null ? query : own;
  // The same reading of the box the Crew Matrix grid gives it: several
  // names at once, split on commas, each matched on any part of the name
  // or the start of a word — so the grid and this list agree on who is shown.
  const terms = String(q || "").toLowerCase().split(",").map((t) => t.trim()).filter(Boolean);
  const hits = (text) => {
    if (!terms.length) return true;
    const hay = String(text || "").toLowerCase();
    const words = hay.split(/[^a-z0-9]+/).filter(Boolean);
    return terms.some((t) => hay.includes(t) || words.some((w) => w.startsWith(t)));
  };
  // Hiding what is already in motion leaves the true to-do list: red items
  // nothing has been done about yet.
  const [onlyUntouched, setOnlyUntouched] = useState(false);

  // A gap is a cell that has expired, is marked N, or nobody has answered.
  const gapsFor = (row) =>
    QUALS.cols.map((c, i) => ({ code: c[0], title: c[1], group: c[2], value: row[3][i], band: bandFor(row[3][i]) }))
      .filter((x) => x.band && (
        // The day printed on it is the day it stops counting (MO70 s 5(a)(iii)),
        // so a certificate running out today is on this list today.
        (x.band.date && hasExpired(x.band.date, TODAY)) || x.band.key === "not" || x.band.key === "unknown"));

  const kindOf = (x) => (x.band.date ? "expired" : x.band.key === "not" ? "missing" : "unknown");

  /* Worked out once per matrix, not once per keystroke: the search box
     narrows these lists below, and the four rules further down read every
     crew row against every column, which is thousands of lookups nobody
     needs re-done to filter a name. */
  const all = useMemo(
    () => QUALS.rows.map((r) => ({ row: r, gaps: gapsFor(r) })).filter((x) => x.gaps.length),
    [QUALS],
  );

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
    .filter((x) => hits(x.row[0] + " " + x.row[1]))
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

  /* ---- what the Marine Orders say about these cells ---------------------
     One line each, worked out by marineOrderLines above; the register's
     entry for each man carries the date of birth the medical's age check
     reads, and the skills matrix says which columns his seat has to hold. */
  const knownName = asKnownPerson(people);
  const personBy = new Map((people || []).map((p) => [String(p.name || "").trim().toUpperCase(), p]));
  const orderRules = { renewal: { needs: VESSEL.renewalNeeds, daysUntil, redDays: RED_DAYS }, medicalCodes: medicalCodesIn(VESSEL.certStated) };

  const ordersFor = (row) => marineOrderLines(
    row, QUALS.cols, certDates, requiredCodesFor(row[1], skillsRequirements),
    personBy.get(String(knownName(row[0]) || row[0]).trim().toUpperCase()), TODAY, orderRules,
  );

  // Every man's lines, on the inputs the rules read; the search only narrows.
  const ordersAll = useMemo(
    () => QUALS.rows.map((row) => ({ row, lines: ordersFor(row) })).filter((x) => x.lines.length),
    [QUALS, certDates, people, skillsRequirements],
  );
  const orders = ordersAll.filter((x) => hits(x.row[0] + " " + x.row[1]));
  const ordersCount = orders.reduce((n, x) => n + x.lines.length, 0);

  // Every item whose certificate was issued by an authority that doesn't read
  // as Australian — valid or not, because the flag is about who issued it,
  // not when it runs out.
  const foreignAll = useMemo(() => QUALS.rows
    .map((row) => ({
      row,
      items: QUALS.cols
        .map((c, i) => ({ code: c[0], title: c[1], group: c[2], value: row[3][i], band: bandFor(row[3][i]) }))
        .map((x) => ({ ...x, foreignIssuer: foreignIssuerOf(certDateFor(certDates, row[0], x.code), x.title) }))
        .filter((x) => x.foreignIssuer),
    }))
    .filter((x) => x.items.length), [QUALS, certDates]);
  const foreign = foreignAll
    .filter((x) => hits(x.row[0] + " " + x.row[1]))
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
    empty: "No gaps - nothing on the matrix is expired, missing or unconfirmed.",
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
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        {SECTIONS.map(tile)}
        {tile({ key: "foreign", label: "Not Australian", colour: T.violet, value: foreignCount })}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {query == null && (
          <input className="um-in" style={{ flex: 1, minWidth: 170 }} value={own}
            onChange={(e) => setOwn(e.target.value)} placeholder="Search crew or position" />
        )}
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

      {/* What the orders say about these cells, one line each. The wording is
          the law's own: nothing here is explained, only stated. */}
      {ordersCount > 0 && (
        <div id="marine-orders-flags" style={{ marginBottom: 26 }}>
          <div style={{ borderTop: `2px solid ${T.accent}`, paddingTop: 9, marginBottom: 11 }}>
            <Eyebrow color={T.text}>Marine Orders · {ordersCount}</Eyebrow>
          </div>
          {orders.map(({ row, lines }) => (
            <div key={"mo-" + row[0] + row[2]} style={{ marginBottom: 10, breakInside: "avoid" }}>
              {lines.map((l, i) => (
                <div key={l.code + i} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
                  padding: "4px 0 4px 4px", borderBottom: `1px solid ${T.rule}` }}>
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, minWidth: 46 }}>{l.code}</span>
                  <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1, minWidth: 240 }}>{l.text}</span>
                  <CertCell url={certLinkFor(certDates, certificates, row[0], l.code)}
                    person={row[0]} code={l.code} title={l.code} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div id="cert-gap-detail">
        {all.length === 0 ? (
          <Empty>No gaps - nothing on the matrix is expired, missing or unconfirmed.</Empty>
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
