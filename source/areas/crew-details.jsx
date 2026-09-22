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
  const { people, setPeople, quals: QUALS, certificates, rosterPlan, renameCrew,
    notPeople, setNotPeople, log } = usePortal();

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
  /* The positions the office uses, off the matrix, for the rank pickers. */
  const positions = useMemo(() => Array.from(new Set((QUALS.rows || [])
    .map((r) => String(r[1] || "").trim()).filter(Boolean))).sort(), [QUALS]);

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

  const nextId = () => "p-" + Date.now() + "-" + Math.floor(Math.random() * 1000);

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
     rank, and two places to set one thing is two places to set it wrongly. */
  const setRank = (id, rank) => setPeople((list) => (list || []).map((p) => (p.id === id
    ? { ...p, rank, dept: rank ? deptForRank(rank) : p.dept } : p)));

  const setSwing = (id, letter) => setPeople((list) => (list || []).map((p) => (p.id === id
    ? { ...p, crew: letter } : p)));

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
                  <span style={{ fontFamily: T.display, fontSize: 14, fontWeight: 700, color: T.text,
                    flex: "1 1 160px" }}>{p.name}</span>
                  {rankPicker(p.rank || p.job, (v) => setRank(p.id, v), 195)}
                  {swingPicker(p.crew, (v) => setSwing(p.id, v), 125)}
                  <Button variant="quiet" onClick={() => { setEditing(p.id); setTyped(p.name); }}>
                    Change the name
                  </Button>
                  <Button variant="quiet" onClick={() => setDropping(p)}>Delete</Button>
                </>
              )}
            </div>
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
              they are. What goes is the register's entry — so every spelling that reached him through
              it stops reaching anybody, and this page will start asking about them again.
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
