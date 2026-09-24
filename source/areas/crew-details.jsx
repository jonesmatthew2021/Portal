/* Crew Details — the Admin tab of that name.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state; this
 * holds what is only this tab's. See tools/source.mjs.
 */
/**
 * Crew Details — the crew register.
 *
 * Every person, named once, with every other spelling they are known by. The
 * rest of the portal reads its names from here, so whatever OPMS, the travel
 * roster or a spreadsheet calls somebody, it reaches the right man.
 *
 * The second half of the page is the point of it. Every name the portal has
 * seen anywhere and cannot place is listed, with where it was seen and how
 * many times - and attaching one to a crew member is one press. Do it once and
 * that spelling is understood for good, however many times it comes back.
 */
function CrewDetails() {
  const { people, setPeople, quals: QUALS, setQuals, certificates, rosterPlan, setRosterPlan,
    renameCrew, setCrewRank, swingLists, setSwingLists, writeCrewToWorkbooks,
    notPeople, setNotPeople, certRoot, setCertRoot, log, roundRunning } = usePortal();

  const reg = useMemo(() => crewRegister(people), [people]);
  const [editing, setEditing] = useState(null);   // id of the person being renamed
  const [typed, setTyped] = useState("");
  const [attachTo, setAttachTo] = useState({});   // spelling -> crew member picked
  // Typed against a stray before it is taken on: the name, the rank, the swing.
  const [asName, setAsName] = useState({});
  const [asRank, setAsRank] = useState({});
  const [asSwing, setAsSwing] = useState({});

  /* The register under rank headings, in the order the vessel is manned.
   *
   * The rank comes off the matrix rather than out of the register, because the
   * matrix is where the office writes what a man is employed as and the
   * register only knows which department he is in. Read through the register,
   * so a row the spreadsheet spells differently still finds its man.
   *
   * RANK_GROUPS is the order, the same one the matrix and the swing board sort
   * by. Anybody with no row on the matrix goes last under a heading that says
   * so - that is worth seeing rather than hiding, because it means the portal
   * is asking nothing of him.
   */
  /* The positions to pick from: the vessel's eight, in the order the vessel
     is manned, and then whatever else the matrix or the register calls a man.

     The eight are always there. The list used to be built only from what the
     matrix and the register already held, so a portal with an empty matrix
     and one junior engineer offered a choice between JUNIOR ENGINEER and
     nothing — every other man read "No rank" with no way to give him one. The
     same fix as the two other rank pickers, and the same reason.

     What the matrix says is still offered underneath, because the office
     draws finer than the eight do; only a wording that says the same thing as
     one of the eight is left out, so the list never carries both COOK and
     Cook. */
  const positions = useMemo(() => {
    const said = Array.from(new Set([
      ...(QUALS.rows || []).map((r) => String(r[1] || "").trim()),
      ...(people || []).map((p) => String(p.rank || "").trim()),
    ].filter(Boolean)));
    const letters = (t) => String(t).toUpperCase().replace(/[^A-Z]/g, "");
    const standard = new Set(ROSTER_RANKS.map(letters));
    return [...ROSTER_RANKS, ...said.filter((p) => !standard.has(letters(p))).sort()];
  }, [QUALS, people]);

  const groups = useMemo(() => {
    const jobOf = new Map();
    (QUALS.rows || []).forEach((r) => {
      const who = reg.nameOf(r[0]) || r[0];
      if (!jobOf.has(who)) jobOf.set(who, r[1] || "");
    });

    const held = new Map();
    (people || []).forEach((p) => {
      /* A rank given here beats the matrix's. The matrix is the office's word
         on what a man is employed as and it is right nearly always - but
         somebody with no row on it has no word at all, and this is the page
         for saying so. */
      const job = p.rank || jobOf.get(p.name) || "";
      const at = job ? rankGroupAt(job) : RANK_GROUPS.length;
      const title = job ? (RANK_GROUPS[at] || [])[0] || "Other" : "Not on the matrix";
      if (!held.has(title)) held.set(title, { title, at, crew: [] });
      held.get(title).crew.push({ ...p, job });
    });

    return [...held.values()]
      .sort((a, b) => a.at - b.at || a.title.localeCompare(b.title))
      .map((g) => ({ ...g, crew: g.crew.sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || ""))) }));
  }, [people, QUALS, reg]);

  // Still wanted whole, for the "who is this?" pickers underneath.
  const crew = useMemo(() => groups.flatMap((g) => g.crew), [groups]);

  /* A number against each man, counting straight down the page rather than
     starting again under every rank heading. The last one is the number on the
     register, so the count at the top and the bottom of the list agree — which
     is what somebody checking they have everybody is actually doing. */
  const numberOf = useMemo(() => {
    const at = new Map();
    crew.forEach((p, i) => at.set(p.id, i + 1));
    return at;
  }, [crew]);

  /* Every spelling the portal has seen, and where. A spelling the register
     already answers to is not a problem and is not listed. */
  const strays = useMemo(() => {
    const seen = new Map();
    const aside = new Set((notPeople || []).map(nameLetters));
    const note = (raw, where) => {
      const name = String(raw || "").trim();
      if (!name || reg.knows(name)) return;
      const k = nameLetters(name);
      if (!k || aside.has(k)) return;
      if (!seen.has(k)) seen.set(k, { name, where: new Set(), n: 0 });
      const at = seen.get(k);
      at.n++;
      at.where.add(where);
      // The fullest spelling of the two is the one worth showing.
      if (name.length > at.name.length) at.name = name;
    };
    (QUALS.rows || []).forEach((r) => note(r[0], "the matrix"));
    (certificates || []).forEach((c) => { note(c.person, "certificates"); note(c.folder, "certificates"); });
    (((rosterPlan || {}).rows) || []).forEach((r) => note(r.name, "the roster"));
    return [...seen.values()].sort((a, b) => b.n - a.n);
  }, [QUALS, certificates, rosterPlan, reg, notPeople]);

  /* Where the certificates are.
   *
   * Two settings, and they answer two different questions. The certificate
   * location is the one folder in the library that the crew's folders sit in,
   * and it is set once for everybody. A man's own folder is only written down
   * where the folder underneath it cannot be worked out from his name - the
   * office called it "Kyle", or "AJ", or something that is not a name at all -
   * and saying so here settles it for good.
   *
   * Both are folders the library already has. Neither makes one: the folders
   * are the office's and the portal only ever reads them.
   */
  const [picking, setPicking] = useState(null);   // {kind:"root"} or {kind:"person", p}
  const parentOf = (s) => {
    const cut = String(s || "").lastIndexOf("/");
    return cut > 0 ? s.slice(0, cut) : "";
  };
  const setFolderFor = (p, folder) => {
    setPeople((list) => (list || []).map((x) => (x.id === p.id ? { ...x, certFolder: folder } : x)));
    log("Admin", folder ? p.name + "'s certificates folder set" : p.name + "'s certificates folder cleared",
      folder || "Back to being worked out from his name");
  };

  const nextId = () => "p-" + Date.now() + "-" + Math.floor(Math.random() * 1000);

  /* The register, pushed through the whole portal in one press.
   *
   * The register is where the crew are named; this makes everything else say
   * so. Every matrix row takes the register's spelling of its man and the
   * rank set against him; every man on the register with no matrix row gets
   * one, empty, for his certificates to land in. The roster's rows take the
   * same names and ranks. The swing lists take the names. Then the office's
   * workbooks are rewritten to carry the same crew, through the same write
   * the take-on panel uses — once, not once per man, which is the lesson the
   * 409s taught.
   *
   * Nothing is removed by it, anywhere. A matrix row for a man the register
   * does not know is left exactly as it is and goes on being asked about on
   * this page; taking a man off is its own decision with its own popup.
   */
  const [syncing, setSyncing] = useState(null);   // null | {word} | {done}
  const syncEverything = async () => {
    if (syncing) return;
    setSyncing({ word: "Lining the pages up…" });

    const byName = new Map((people || []).map((p) => [p.name, p]));
    const cols = QUALS.cols || [];
    const claimed = new Set();
    let renamed = 0, ranked = 0;

    const rows = (QUALS.rows || []).map((r) => {
      const who = reg.nameOf(r[0]) || String(r[0] || "").trim();
      const man = byName.get(who);
      if (man) claimed.add(man.id);
      let next = r;
      if (who && who !== r[0]) { next = [who, next[1], next[2], next[3]]; renamed++; }
      if (man && man.rank && String(next[1] || "") !== man.rank) {
        next = [next[0], man.rank, next[2], next[3]]; ranked++;
      }
      return next;
    });
    const added = [];
    (people || []).forEach((p) => {
      if (p.active === false || claimed.has(p.id)) return;
      rows.push([p.name, p.rank || "", "", cols.map(() => "")]);
      added.push(p.name);
    });
    if (renamed || ranked || added.length) setQuals({ ...QUALS, rows });

    let plannedAfter = null;
    let rosterFixed = 0;
    setRosterPlan((plan) => {
      if (!plan) return plan;
      const prows = (plan.rows || []).map((r) => {
        const who = reg.nameOf(r.name);
        const man = who ? byName.get(who) : null;
        const rank = man && man.rank ? rosterRankFor(man.rank) : r.rank;
        const renaming = who && who !== r.name;
        if (!renaming && String(rank || "") === String(r.rank || "")) return r;
        rosterFixed++;
        return { ...r, name: who || r.name, rank };
      });
      if (!rosterFixed) return plan;
      plannedAfter = { ...plan, rows: prows, edited: true, updatedAt: todayISO() };
      return plannedAfter;
    });

    let listsFixed = 0;
    setSwingLists((held) => {
      const next = {};
      Object.entries(held || {}).forEach(([k, list]) => {
        next[k] = { ...list, entries: (((list || {}).entries) || []).map((e) => {
          const who = reg.nameOf(e.name);
          if (who && who !== e.name) { listsFixed++; return { ...e, name: who }; }
          return e;
        }) };
      });
      return next;
    });

    /* The office's workbooks carry the same crew. Only worth the round trip
       when the pages actually moved; a sync that changed nothing writes
       nothing and says so. */
    let workbooks = "the spreadsheets were already in step";
    if (added.length || plannedAfter) {
      setSyncing({ word: "Writing the spreadsheets…" });
      try {
        const r = await writeCrewToWorkbooks({
          want: added.length ? added.length + " crew" : "the crew register",
          plan: plannedAfter, rows, leaving: false,
        });
        workbooks = (r && r.said) || "written";
      } catch (e) {
        workbooks = "the spreadsheets couldn't be written: " + String((e && e.message) || e);
      }
    }

    const doneWords = [
      added.length ? added.length + " added to the matrix" : null,
      renamed ? renamed + " matrix " + (renamed === 1 ? "name" : "names") + " put right" : null,
      ranked ? ranked + " " + (ranked === 1 ? "rank" : "ranks") + " brought over" : null,
      rosterFixed ? rosterFixed + " roster rows lined up" : null,
      listsFixed ? listsFixed + " swing list names lined up" : null,
    ].filter(Boolean);
    log("Admin", "The register was pushed through the portal",
      (doneWords.join(" · ") || "everything already lined up") + " · " + workbooks);
    setSyncing({ done: { added, renamed, ranked, rosterFixed, listsFixed, workbooks, words: doneWords } });
  };

  const attach = (stray, id) => {
    setPeople((list) => (list || []).map((p) => (p.id === id
      ? { ...p, aliases: [...(p.aliases || []), stray.name] } : p)));
    const to = ((people || []).find((p) => p.id === id) || {}).name || "";
    log("Admin", stray.name + " is " + to, "Added to the crew register as another spelling of the same person");
  };

  /* Somebody new, with his department and his swing filled in rather than left
     for somebody to notice later.

     Both are already written down: the matrix says what he is employed as,
     which gives the department, and the roster says which swing he sails on.
     Taken from those rather than asked for, because a register entry with no
     department drops off the bottom of the Roster page without saying why. */
  const takeOn = (stray) => {
    const name = canonicalName(asName[stray.name] == null ? stray.name : asName[stray.name]);
    if (!name) return;
    const row = (QUALS.rows || []).find((r) => nameLetters(r[0]) === nameLetters(stray.name));
    const job = asRank[stray.name] || (row ? row[1] || "" : "");
    const stint = (((rosterPlan || {}).rows) || []).find((r) => {
      const a = new Set(registerWords(r.name)), b = new Set(registerWords(name));
      if (a.size < 2 || b.size < 2) return nameLetters(r.name) === nameLetters(stray.name);
      const small = a.size <= b.size ? a : b, big = a.size <= b.size ? b : a;
      let all = true;
      small.forEach((w) => { if (!big.has(w)) all = false; });
      return all;
    });
    const swing = asSwing[stray.name]
      || (stint ? String(stint.crew || "").trim().toUpperCase().slice(0, 1) : "");
    setPeople((list) => [...(list || []), {
      id: nextId(), name, aliases: [stray.name], active: true,
      rank: job || "",
      dept: job ? deptForRank(job) : "GPH",
      crew: swing === "A" || swing === "B" ? swing : "",
    }]);
    log("Admin", name + " added to the crew register",
      [job || null, swing ? "Swing " + swing : null, "from " + [...stray.where].join(" and ")]
        .filter(Boolean).join(" · "));
  };

  const drop = (id, alias) => setPeople((list) => (list || []).map((p) => (p.id === id
    ? { ...p, aliases: (p.aliases || []).filter((a) => a !== alias) } : p)));

  /* The rank, and the department that follows from it. The department is not
     asked for separately because it has only ever been worked out from the
     rank, and two places to set one thing is two places to set it wrongly.

     Set through the portal's own rank change, so the matrix row and the
     roster's rows are put right in the same press. Picked here and written
     only here, the certificate list would still have had him under his old
     heading and the roster would still have been manning him as one. */
  const setRank = (id, rank) => {
    const p = (people || []).find((x) => x.id === id);
    if (p) setCrewRank(p.name, rank);
  };

  const setSwing = (id, letter) => setPeople((list) => (list || []).map((p) => (p.id === id
    ? { ...p, crew: letter } : p)));

  /* The man's own particulars, which are his and not a document's.
   *
   * His MSIC expiry already comes off the card itself, read as VS-01 — but the
   * number printed on it is nowhere, and it is what gets asked for at the gate
   * and on every port form. Date of birth the same: every crew list Portways
   * and the ports ask for wants it, and it was being typed from memory each
   * time. Held against the person, so it is written once. */
  const setDetail = (id, field, value) => setPeople((list) => (list || []).map((p) => (p.id === id
    ? { ...p, [field]: value } : p)));

  /* Off the register, and nothing else.
   *
   * His certificates stay in SharePoint, his row stays on the matrix and his
   * stints stay on the roster. This is the register forgetting a name, not the
   * portal forgetting a man - taking somebody off the vessel is done on the
   * matrix, where it says so and archives his paperwork. Asked first all the
   * same, because a register the matrix reads its names from is not a list to
   * delete from by accident.
   */
  const [dropping, setDropping] = useState(null);
  const takeOff = (p) => {
    setPeople((list) => (list || []).filter((x) => x.id !== p.id));
    log("Admin", p.name + " taken off the crew register",
      "His certificates, his matrix row and his roster stints are untouched");
    setDropping(null);
  };

  /* Not everything in a library is a person. "HRWL Verification" is a folder
     of paperwork and "SPREADSHEET, Certificates" is a filename the sync read
     as a name. Set aside rather than forced onto somebody. */
  /* Delete, on a spelling that is not anybody. "HRWL Verification" is a
     folder of paperwork and "SPREADSHEET, Certificates" is a filename the sync
     read as a name; neither is a man and neither is worth being asked about
     twice. Nothing is deleted from SharePoint - the spelling is written down as
     not a person so this page stops raising it. */
  const setAside = (stray) => {
    setNotPeople([...(notPeople || []), stray.name]);
    log("Admin", stray.name + " is not a crew member", "Set aside on Crew Details");
  };

  const rankPicker = (value, onPick, width) => (
    <NameSelect width={width} value={value || ""} onPick={onPick}
      options={[{ value: "", label: "No rank" }, ...positions.map((p) => ({ value: p, label: p }))]} />
  );
  const swingPicker = (value, onPick, width) => (
    <NameSelect width={width} value={value || ""} onPick={onPick}
      options={[{ value: "", label: "No swing" },
        ...SWINGS.map((x) => ({ value: x.letter, label: x.name }))]} />
  );

  const rename = (p) => {
    const name = canonicalName(typed);
    if (!name) return;
    /* The old spelling becomes one of his aliases. Whatever was calling him
       that - a spreadsheet, a folder - is still calling him that, and this
       page exists so that stops mattering. */
    setPeople((list) => (list || []).map((x) => (x.id === p.id
      ? { ...x, name, aliases: [...new Set([...(x.aliases || []), p.name])] } : x)));
    if (p.name !== name) renameCrew(p.name, name);
    setEditing(null);
    setTyped("");
  };

  const chip = {
    fontFamily: T.mono, fontSize: 11, padding: "2px 6px", borderRadius: 2,
    border: "1px solid " + T.rule, background: T.raised, color: T.muted,
  };
  const row = { padding: "10px 0", borderTop: "1px solid " + T.rule };

  return (
    <div>
      {/* The primary location: the folder the crew's certificate folders sit in. */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
        padding: "9px 12px", border: "1px solid " + T.rule, borderRadius: 2, marginBottom: 12 }}>
        <Button variant="quiet" onClick={() => setPicking({ kind: "root" })}>Set certificate location</Button>
        {certRoot ? <span style={chip}>{certRoot}</span> : null}
        <span style={{ flex: 1 }} />
        <Button variant="solid" disabled={(!!syncing && !syncing.done) || roundRunning}
          title={!(syncing && !syncing.done) && roundRunning ? ROUND_BUSY : undefined}
          onClick={syncEverything}>
          {syncing && !syncing.done ? syncing.word : "Update from register"}
        </Button>
      </div>

      {/* What the sync did, closed when it has been read. */}
      {syncing && syncing.done && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(22,50,74,0.45)", zIndex: 82,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: T.panel, border: "1px solid " + T.rule, borderTop: "4px solid " + T.accent,
            borderRadius: 3, padding: "20px 24px", width: "min(560px, 94vw)" }}>
            <Eyebrow color={T.accent}>The register, everywhere</Eyebrow>
            <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, margin: "10px 0 4px", lineHeight: 1.7 }}>
              {syncing.done.words.length === 0
                ? "Every page already carried the register's names and ranks — nothing needed changing."
                : syncing.done.words.join(". ") + "."}
            </div>
            {syncing.done.added.length > 0 && (
              <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted, margin: "6px 0", lineHeight: 1.7 }}>
                {syncing.done.added.join(" · ")}
              </div>
            )}
            <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, marginBottom: 14, lineHeight: 1.6 }}>
              Spreadsheets: {syncing.done.workbooks}
            </div>
            <Button variant="solid" onClick={() => setSyncing(null)}>Close</Button>
          </div>
        </div>
      )}

      <div style={{ background: T.panel, border: "1px solid " + T.rule, borderRadius: 2, padding: "16px 18px" }}>
        <Eyebrow color={T.accent}>The crew</Eyebrow>
        <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.muted, margin: "8px 0 4px", lineHeight: 1.6 }}>
          {crew.length} on the register. Everything else on the portal reads its names from here.
        </div>
        {groups.map((g) => (
          <div key={g.title}>
            <div style={{ fontFamily: T.mono, fontSize: 10.5, color: g.title === "Not on the matrix" ? T.bYellow : T.accent,
              textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700,
              marginTop: 16, paddingBottom: 2 }}>
              {g.title} · {g.crew.length}
            </div>
            {g.crew.map((p) => (
          <div key={p.id} style={row}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {editing === p.id ? (
                <>
                  <input value={typed} placeholder="LASTNAME, First"
                    onChange={(e) => setTyped(e.target.value)}
                    style={{ flex: "1 1 220px", fontFamily: T.mono, fontSize: 13, padding: "5px 8px",
                      borderRadius: 2, border: "1px solid " + T.rule, background: T.raised, color: T.text }} />
                  <Button variant="solid" onClick={() => rename(p)}>Save</Button>
                  <Button variant="quiet" onClick={() => { setEditing(null); setTyped(""); }}>Leave it</Button>
                </>
              ) : (
                <>
                  <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted,
                    flex: "0 0 24px", textAlign: "right" }}>{numberOf.get(p.id)}</span>
                  <span style={{ fontFamily: T.display, fontSize: 14, fontWeight: 700, color: T.text,
                    flex: "1 1 150px" }}>{p.name}</span>
                  {/* His MSIC number and his date of birth, beside his name.
                      Typed straight in — they are short, they change almost
                      never, and saving on every keystroke is what the rest of
                      the portal does. */}
                  <input value={p.msic || ""} placeholder="MSIC number" title="MSIC number"
                    onChange={(e) => setDetail(p.id, "msic", e.target.value)}
                    style={{ flex: "0 1 140px", fontFamily: T.mono, fontSize: 12.5, padding: "5px 8px",
                      borderRadius: 2, border: "1px solid " + T.rule, background: T.raised, color: T.text }} />
                  <input className="um-in" type="date" value={p.dob || ""}
                    title="Date of birth"
                    onChange={(e) => setDetail(p.id, "dob", e.target.value)}
                    style={{ flex: "0 1 150px", fontFamily: T.mono, fontSize: 12.5, padding: "4px 8px",
                      borderRadius: 2, border: "1px solid " + T.rule, background: T.raised, color: T.text }} />
                  {rankPicker(p.rank || p.job, (v) => setRank(p.id, v), 195)}
                  {swingPicker(p.crew, (v) => setSwing(p.id, v), 125)}
                  <Button variant="quiet" onClick={() => { setEditing(p.id); setTyped(p.name); }}>
                    Change the name
                  </Button>
                  <Button variant="quiet" onClick={() => setPicking({ kind: "person", p })}>
                    Assign certificates folder
                  </Button>
                  <Button variant="quiet" onClick={() => setDropping(p)}>Delete</Button>
                </>
              )}
            </div>
            {p.certFolder && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted,
                  textTransform: "uppercase", letterSpacing: "0.08em" }}>Certificates</span>
                <span style={chip}>
                  {p.certFolder}
                  <button type="button" onClick={() => setFolderFor(p, "")} title="Not his folder"
                    style={{ marginLeft: 5, border: 0, background: "none", color: T.muted,
                      cursor: "pointer", padding: 0, fontFamily: T.mono, fontSize: 11 }}>×</button>
                </span>
              </div>
            )}
            {(p.aliases || []).length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted,
                  textTransform: "uppercase", letterSpacing: "0.08em" }}>Also</span>
                {(p.aliases || []).map((a) => (
                  <span key={a} style={chip}>
                    {a}
                    <button type="button" onClick={() => drop(p.id, a)} title="Not him"
                      style={{ marginLeft: 5, border: 0, background: "none", color: T.muted,
                        cursor: "pointer", padding: 0, fontFamily: T.mono, fontSize: 11 }}>×</button>
                  </span>
                ))}
              </div>
            )}
          </div>
            ))}
          </div>
        ))}
      </div>

      <div style={{ height: 14 }} />

      <div style={{ background: T.panel, border: "1px solid " + T.rule, borderRadius: 2, padding: "16px 18px" }}>
        <Eyebrow color={strays.length ? T.bYellow : T.accent}>Names the register does not know</Eyebrow>
        {strays.length === 0 ? (
          <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.muted, marginTop: 8 }}>
            Every name on the matrix, the certificates and the roster reaches somebody on the register.
          </div>
        ) : (
          <>
            <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.muted, margin: "8px 0 4px", lineHeight: 1.6 }}>
              {strays.length} spelling{strays.length === 1 ? "" : "s"} the portal has seen and cannot place.
              Say who each one is and it is understood from then on, however it comes back.
            </div>
            {strays.map((x) => (
              <div key={x.name} style={row}>
                {/* Somebody the register already has. */}
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, flex: "0 1 170px" }}>{x.name}</span>
                  <span style={{ fontFamily: T.body, fontSize: 12, color: T.muted, flex: "0 1 180px" }}>
                    {[...x.where].join(" and ")} · {x.n} time{x.n === 1 ? "" : "s"}
                  </span>
                  <NameSelect width={210} value={attachTo[x.name] || ""}
                    onPick={(v) => setAttachTo((a) => ({ ...a, [x.name]: v }))}
                    options={[{ value: "", label: "Who is this?" },
                      ...crew.map((p) => ({ value: p.id, label: p.name }))]} />
                  <Button variant="solid" disabled={!attachTo[x.name]}
                    onClick={() => attach(x, attachTo[x.name])}>
                    That's him
                  </Button>
                  <Button variant="quiet" onClick={() => setAside(x)}>Delete</Button>
                </div>

                {/* Or nobody the register has yet. The name, the rank and the
                    swing are all fillable here rather than being guessed and
                    corrected on the row above afterwards. */}
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
                  marginTop: 7, paddingLeft: 2 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted,
                    textTransform: "uppercase", letterSpacing: "0.08em", flex: "0 0 74px" }}>Or new</span>
                  <input
                    value={asName[x.name] == null ? canonicalName(x.name) : asName[x.name]}
                    placeholder="LASTNAME, First"
                    onChange={(e) => setAsName((a) => ({ ...a, [x.name]: e.target.value }))}
                    style={{ flex: "0 1 190px", fontFamily: T.mono, fontSize: 12.5, padding: "5px 8px",
                      borderRadius: 2, border: "1px solid " + T.rule, background: T.raised, color: T.text }} />
                  {rankPicker(asRank[x.name], (v) => setAsRank((a) => ({ ...a, [x.name]: v })), 195)}
                  {swingPicker(asSwing[x.name], (v) => setAsSwing((a) => ({ ...a, [x.name]: v })), 125)}
                  <Button variant="quiet" onClick={() => takeOn(x)}>Somebody new</Button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* The library itself, to pick a folder out of. The primary location
          opens where it already points; a man's own folder opens inside the
          primary location, which is where the crew's folders are. */}
      {picking && (
        <CertFolderPicker
          title={picking.kind === "root" ? "Set certificate location"
            : "Which folder holds " + picking.p.name + "'s certificates?"}
          start={picking.kind === "root" ? parentOf(certRoot)
            : (picking.p.certFolder ? parentOf(picking.p.certFolder) : certRoot)}
          chosen={picking.kind === "root" ? certRoot : picking.p.certFolder || ""}
          onPick={(folder) => {
            if (picking.kind === "root") {
              setCertRoot(folder);
              log("Admin", "Certificate location set", folder);
            } else {
              setFolderFor(picking.p, folder);
            }
            setPicking(null);
          }}
          onAuto={(names, path) => {
            /* Every folder on the screen, assigned to its man in one press.
             *
             * Each folder's name is read through the register — the part
             * before the office's " - OPMS" tail — under the register's own
             * rules: a spelling it has been taught, or a word exactly one man
             * answers to. "Evgeny - OPMS" reaches EVDOKIMOV, Evgeny; "Chris"
             * and "AJ" reach nobody and are left for by hand, because
             * guessing here files one man's certificates as another's.
             *
             * Nothing said by hand is touched: a man who already has a folder
             * keeps it, and a folder already assigned stays whose it is. Two
             * folders wanting the same man is a question, not an assignment —
             * both are left. */
            const taken = new Set((people || [])
              .map((p) => String(p.certFolder || "").toLowerCase()).filter(Boolean));
            const want = new Map();     // person id -> [folder, ...]
            const left = [];
            names.forEach((name) => {
              const folder = path ? path + "/" + name : name;
              if (taken.has(folder.toLowerCase())) return;
              const who = reg.nameOf(String(name).split(" - ")[0].trim()) || reg.nameOf(name);
              const p = who ? (people || []).find((x) => x.name === who) : null;
              if (!p || p.certFolder) { left.push(name); return; }
              want.set(p.id, [...(want.get(p.id) || []), folder]);
            });
            const sure = new Map([...want].filter(([, f]) => f.length === 1).map(([id, f]) => [id, f[0]]));
            [...want].filter(([, f]) => f.length > 1).forEach(([, f]) => left.push(...f.map((x) => x.split("/").pop())));
            if (sure.size) {
              setPeople((list) => (list || []).map((p) =>
                sure.has(p.id) && !p.certFolder ? { ...p, certFolder: sure.get(p.id) } : p));
            }
            log("Admin", "Certificate folders auto-assigned",
              sure.size + " assigned"
              + (left.length ? " · left for by hand: " + left.sort().join(", ") : ""));
            setPicking(null);
            return { assigned: sure.size, left };
          }}
          onClose={() => setPicking(null)} />
      )}

      {/* Asked before a name goes off the register, because the matrix reads
          its names from it. Nothing else about the man is touched. */}
      {dropping && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(22,50,74,0.45)", zIndex: 78,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: T.panel, border: "1px solid " + T.rule, borderTop: "4px solid " + T.bRed,
            borderRadius: 3, padding: "20px 24px", width: "min(520px, 94vw)" }}>
            <Eyebrow color={T.bRed}>Take {dropping.name} off the register?</Eyebrow>
            <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.muted, margin: "9px 0 15px", lineHeight: 1.6 }}>
              His certificates, his row on the matrix and his stints on the roster all stay exactly as
              they are. What goes is the register's entry, so every spelling that reached him through
              it stops reaching anybody.
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Button variant="solid" onClick={() => takeOff(dropping)}>Take him off</Button>
              <Button variant="quiet" onClick={() => setDropping(null)}>Leave him on</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Picking a folder the library already has.
 *
 * The folders are the office's. This walks them, shows what is there, and
 * hands back the one that was pressed - it never makes a folder, renames one
 * or moves one. Only folders are listed, because a folder is the only thing
 * that can be picked.
 */
function CertFolderPicker({ title, start, chosen, onPick, onAuto, onClose }) {
  const [path, setPath] = useState(start || "");
  const [folders, setFolders] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  React.useEffect(() => {
    let live = true;
    setBusy(true); setErr("");
    /* Read as words first and as JSON second. A library that is down answers
       with a page rather than an answer, and "Unexpected token" is not a thing
       to put on a screen. */
    fetch("/api/sharepoint?path=" + encodeURIComponent(path))
      .then((r) => r.text().then((body) => {
        let out = null;
        try { out = JSON.parse(body); } catch (e) {}
        if (!r.ok || !out) {
          throw new Error((out && out.error) || "The library couldn't be read (" + r.status + ").");
        }
        return out;
      }))
      .then((out) => { if (live) setFolders((out.entries || []).filter((e) => e.folder)); })
      .catch((e) => { if (live) { setErr(String(e.message || e)); setFolders([]); } })
      .then(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [path]);

  const crumbs = path ? path.split("/") : [];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(22,50,74,0.45)", zIndex: 80,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: T.panel, border: "1px solid " + T.rule, borderTop: "4px solid " + T.accent,
        borderRadius: 3, padding: "20px 24px", width: "min(620px, 94vw)",
        maxHeight: "82vh", display: "flex", flexDirection: "column" }}>
        <Eyebrow color={T.accent}>{title}</Eyebrow>

        {/* Where we are in the library, and the way back up. */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontFamily: T.mono,
          fontSize: 12, padding: "8px 11px", background: T.raised, border: "1px solid " + T.rule,
          borderLeft: "4px solid " + T.accent, borderRadius: 2, margin: "11px 0 10px" }}>
          <a style={{ cursor: "pointer", color: T.accent, fontWeight: 700 }} onClick={() => setPath("")}>Library</a>
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              <span style={{ color: T.muted }}>/</span>
              <a style={{ cursor: "pointer", color: i === crumbs.length - 1 ? T.text : T.accent }}
                onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}>{c}</a>
            </React.Fragment>
          ))}
        </div>

        {err && (
          <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.bRed, marginBottom: 10 }}>{err}</div>
        )}

        <div style={{ flex: 1, minHeight: 90, overflowY: "auto", marginBottom: 12 }}>
          {busy && folders === null ? <Empty>Reading the library...</Empty>
            : folders && folders.length === 0 && !err ? <Empty>No folders in here.</Empty>
            : (folders || []).map((e) => {
              const here = path ? path + "/" + e.name : e.name;
              const on = here === chosen;
              return (
                <div key={e.path} style={{ display: "flex", gap: 10, alignItems: "center",
                  padding: "8px 2px", borderBottom: "1px solid " + T.rule, opacity: busy ? 0.5 : 1 }}>
                  <span style={{ color: T.accent, fontFamily: T.mono, fontSize: 12 }}>&#9656;</span>
                  <a style={{ cursor: "pointer", flex: 1, minWidth: 0, fontFamily: T.body, fontSize: 13.5,
                    fontWeight: on ? 700 : 600, color: on ? T.accent : T.text }}
                    onClick={() => setPath(here)}>{e.name}</a>
                  <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted }}>
                    {e.count == null ? "" : e.count + " item" + (e.count === 1 ? "" : "s")}
                  </span>
                  <Button variant={on ? "ghost" : "quiet"} onClick={() => onPick(here)}>
                    {on ? "This one" : "Use this one"}
                  </Button>
                </div>
              );
            })}
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <Button variant="solid" disabled={!path} onClick={() => onPick(path)}>
            Use the folder I'm in
          </Button>
          {/* Every folder on this screen assigned to its man in one press,
              where the register can say whose it is. The rest are left. */}
          {onAuto && (
            <Button variant="quiet" disabled={busy || !(folders || []).length}
              onClick={() => onAuto((folders || []).map((e) => e.name), path)}>
              Match folders to crew
            </Button>
          )}
          {chosen ? <Button variant="quiet" onClick={() => onPick("")}>Clear it</Button> : null}
          <span style={{ flex: 1 }} />
          <Button variant="quiet" onClick={onClose}>Leave it</Button>
        </div>
      </div>
    </div>
  );
}
