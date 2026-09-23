/* Access Grants — the Admin tab of that name.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state; this
 * holds what is only this tab's. See tools/source.mjs.
 */
function AccessGrantsPage() {
  const { swingLists, quals } = usePortal();
  const [grants, setGrants] = useState(null);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [draft, setDraft] = useState({ name: "", email: "", role: "crew" });
  const [traffic, setTraffic] = useState(null);
  const [trafficErr, setTrafficErr] = useState("");
  const myRole = SESSION_USER.role;

  // The company address a muster name almost certainly has: first name, dot,
  // surname, all lowercase — "Cornelius James KEOGH" becomes
  // cornelius.keogh@unitedmarine.au. Editable before granting, for the
  // exceptions.
  const guessEmail = (name) => {
    const parts = String(name || "").trim().toLowerCase().split(/\s+/).map((p) => p.replace(/[^a-z-]/g, ""));
    if (parts.length < 2 || !parts[0] || !parts[parts.length - 1]) return "";
    return `${parts[0]}.${parts[parts.length - 1]}@unitedmarine.au`;
  };

  // All crew without a grant yet — everyone on the crew matrix plus anyone
  // on a swing list, one row each, ready to be granted in one click.
  const ungranted = useMemo(() => {
    const seen = new Set(); const out = [];
    // Matrix names read "SURNAME, First"; swing lists read "First Surname".
    // Both become "First Surname" so one person is one row however spelled,
    // and the guessed email runs the right way round.
    const canonical = (raw) => {
      let name = String(raw || "").trim();
      const m = name.match(/^([^,]+),\s*(.+)$/);
      if (m) name = `${m[2].trim()} ${m[1].trim()}`;
      return name.split(/\s+/).map((w) => (/^[A-Z][A-Z'-]+$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w)).join(" ");
    };
    const keyOf = (name) => {
      const parts = name.toLowerCase().split(/\s+/);
      return parts.length < 2 ? parts[0] : `${parts[0]}|${parts[parts.length - 1]}`;
    };
    const held = new Set((grants || []).flatMap((g) => [keyOf(canonical(g.name)), g.email.toLowerCase()]));
    const add = (rawName, rank) => {
      const name = canonical(rawName);
      if (!name) return;
      const key = keyOf(name);
      if (seen.has(key)) return;
      seen.add(key);
      if (held.has(key) || held.has(guessEmail(name))) return;
      out.push({ name, rank: rank || "" });
    };
    (((quals || {}).rows) || []).forEach((r) => add(r[0], r[1]));
    Object.keys(swingLists || {}).sort().forEach((k) => {
      (((swingLists || {})[k] || {}).entries || []).forEach((e) => add(e.name, e.rank));
    });
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [swingLists, quals, grants]);

  // The same rank order the swing board reads under: bridge, engine room,
  // galley — anyone whose rank matches nothing waits under Other.
  const rankGroups = useMemo(() => {
    const groups = RANK_GROUPS.map(([label]) => ({ label, people: [] }));
    const other = { label: "Other", people: [] };
    ungranted.forEach((p) => {
      const at = RANK_GROUPS.findIndex(([, re]) => re.test(p.rank));
      (at >= 0 ? groups[at] : other).people.push(p);
    });
    return [...groups, other].filter((g) => g.people.length > 0);
  }, [ungranted]);

  // Per-muster-row drafts: email prefilled from the name, level picked here.
  const [rowDrafts, setRowDrafts] = useState({});
  const rowOf = (name) => rowDrafts[name] || { email: guessEmail(name), role: "crew" };
  const setRow = (name, patch) => setRowDrafts((d) => ({ ...d, [name]: { ...rowOf(name), ...patch } }));

  const loadTraffic = async () => {
    try {
      const r = await fetch("/api/login-events");
      if (!r.ok) throw new Error((await r.json()).error || `The traffic couldn't be read (${r.status}).`);
      setTraffic(await r.json());
      setTrafficErr("");
    } catch (e) { setTrafficErr(String(e.message || e)); }
  };
  React.useEffect(() => { loadTraffic(); }, []);

  const load = async () => {
    try {
      const r = await fetch("/api/users");
      if (!r.ok) throw new Error((await r.json()).error || `The list couldn't be read (${r.status}).`);
      setGrants(await r.json());
      setErr("");
    } catch (e) { setErr(String(e.message || e)); }
  };
  React.useEffect(() => { load(); }, []);

  const post = async (body) => {
    const r = await fetch("/api/users", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body) });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || `The grant was refused (${r.status}).`);
    await load();
  };
  const grant = async () => {
    setErr("");
    try {
      await post({ ...draft, name: canonicalName(draft.name) });
      setDraft({ name: "", email: "", role: "crew" });
    } catch (e) { setErr(String(e.message || e)); }
  };
  const grantRow = async (name) => {
    setBusyId(name); setErr("");
    try { await post({ name: canonicalName(name), email: rowOf(name).email, role: rowOf(name).role }); }
    catch (e) { setErr(String(e.message || e)); }
    setBusyId(null);
  };

  const change = async (id, patch) => {
    setBusyId(id); setErr("");
    try {
      const r = await fetch(`/api/users/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || `The change was refused (${r.status}).`);
      await load();
    } catch (e) { setErr(String(e.message || e)); }
    setBusyId(null);
  };

  const remove = async (g) => {
    if (!window.confirm(`Remove ${g.name}'s grant entirely? They are signed out everywhere and can only return if granted again.`)) return;
    setBusyId(g.id); setErr("");
    try {
      const r = await fetch(`/api/users/${g.id}`, { method: "DELETE" });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || `The removal was refused (${r.status}).`);
      await load();
    } catch (e) { setErr(String(e.message || e)); }
    setBusyId(null);
  };

  const roleChip = (role) => {
    const on = { it: { fg: T.violet, bg: T.violetBg }, management: { fg: T.accent, bg: T.accentSoft }, crew: { fg: T.muted, bg: T.raised } }[role] || {};
    const label = (ACCESS_LEVELS.find((l) => l.id === role) || { label: role }).label;
    return <Chip fg={on.fg} bg={on.bg}>{label}</Chip>;
  };

  return (
    <div>
      <div style={{ marginBottom: 10 }}><Eyebrow color={T.accent}>Who can enter, and at what level</Eyebrow></div>
      
      {/* Granting */}
      <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderLeft: `4px solid ${T.accent}`,
        borderRadius: 2, padding: "13px 15px", marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input className="um-in" style={{ flex: "1 1 150px" }} placeholder="Full name" value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input className="um-in" style={{ flex: "1 1 200px" }} placeholder="Email address" value={draft.email}
          onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
        <select className="um-in" style={{ flex: "0 1 150px" }} value={draft.role}
          onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
          {ACCESS_LEVELS.filter((l) => l.id !== "it").map((l) => (
            <option key={l.id} value={l.id}>{l.label}</option>
          ))}
        </select>
        <Button onClick={grant} disabled={!draft.name.trim() || !draft.email.trim()}>Grant access</Button>
      </div>

      {err && <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.bRed, marginBottom: 12 }}>{err}</div>}

      {/* The grants */}
      {!grants ? <Empty>Loading the grants...</Empty> : grants.length === 0 ? (
        <Empty>Nobody has a grant yet — the first sign-in seeds the first IT Help account.</Empty>
      ) : grants.map((g) => {
        const mine = g.email === SESSION_USER.email || g.name === SESSION_USER.name;
        const untouchable = mine || (g.role === "it" && myRole !== "it");
        return (
          <div key={g.id} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
            padding: "9px 12px", borderBottom: `1px solid ${T.rule}`, opacity: g.disabled ? 0.55 : 1 }}>
            <span style={{ flex: "1 1 200px", minWidth: 0 }}>
              <span style={{ fontFamily: T.body, fontSize: 14, fontWeight: 600, color: T.text }}>{g.name}</span>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}> · {g.email}</span>
            </span>
            {roleChip(g.role)}
            {g.disabled && <Chip fg={T.bRed} bg={T.bRedBg}>disabled</Chip>}
            {mine && <Chip fg={T.teal} bg={T.raised}>you</Chip>}
            {!untouchable && (
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <select className="um-in" style={{ fontSize: 11.5, padding: "3px 6px" }} value={g.role}
                  disabled={busyId === g.id}
                  onChange={(e) => change(g.id, { role: e.target.value })}>
                  {ACCESS_LEVELS.filter((l) => l.id !== "it").map((l) => (
                    <option key={l.id} value={l.id}>{l.label}</option>
                  ))}
                </select>
                <Button variant="quiet" disabled={busyId === g.id}
                  onClick={() => change(g.id, { disabled: !g.disabled })}>
                  {g.disabled ? "Re-enable" : "Disable"}
                </Button>
                <Button variant="quiet" disabled={busyId === g.id} onClick={() => remove(g)}>
                  <span style={{ color: T.bRed }}>Delete</span>
                </Button>
              </span>
            )}
          </div>
        );
      })}

      {/* The muster lists, ready to grant — names arrive by themselves, the
          level is all that's picked. */}
      {ungranted.length > 0 && (
        <div style={{ marginTop: 26 }}>
          <div style={{ marginBottom: 8 }}><Eyebrow color={T.teal}>Crew without a grant yet</Eyebrow></div>
          {rankGroups.map((grp) => (
            <div key={grp.label} style={{ marginBottom: 6 }}>
              <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, color: T.accent,
                textTransform: "uppercase", letterSpacing: ".08em", padding: "10px 12px 4px" }}>{grp.label}</div>
              {grp.people.map((p) => (
                <div key={p.name} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
                  padding: "7px 12px", borderBottom: `1px solid ${T.rule}` }}>
                  <span style={{ flex: "1 1 170px", minWidth: 0 }}>
                    <span style={{ fontFamily: T.body, fontSize: 13.5, fontWeight: 600, color: T.text }}>{p.name}</span>
                    {p.rank && <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted }}> · {p.rank}</span>}
                  </span>
                  <input className="um-in" style={{ flex: "1 1 230px", fontSize: 12 }} value={rowOf(p.name).email}
                    onChange={(e) => setRow(p.name, { email: e.target.value })} />
                  <select className="um-in" style={{ fontSize: 11.5, padding: "3px 6px" }} value={rowOf(p.name).role}
                    onChange={(e) => setRow(p.name, { role: e.target.value })}>
                    {ACCESS_LEVELS.filter((l) => l.id !== "it").map((l) => (
                      <option key={l.id} value={l.id}>{l.label}</option>
                    ))}
                  </select>
                  <Button variant="quiet" disabled={busyId === p.name || !rowOf(p.name).email.trim()}
                    onClick={() => grantRow(p.name)}>Grant</Button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* The sign-in book — every knock on the door, wanted or not. */}
      <div style={{ marginTop: 30 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <Eyebrow color={T.violet}>Sign-in traffic</Eyebrow>
          <Button variant="quiet" onClick={loadTraffic}>Refresh</Button>
        </div>
        {trafficErr && <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.bRed, marginBottom: 10 }}>{trafficErr}</div>}
        {!traffic ? (!trafficErr && <Empty>Reading the sign-in book...</Empty>) : (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              {Object.keys(traffic.week || {}).length === 0 ? (
                <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted }}>Nothing in the last seven days.</span>
              ) : Object.entries(traffic.week).sort().map(([kind, n]) => {
                const bad = ["unknown_email", "code_wrong", "code_lockout", "denied", "disabled_account", "rate_limited"].includes(kind);
                return <Chip key={kind} fg={bad ? T.bRed : T.teal} bg={bad ? T.bRedBg : T.raised}>{kind.replace(/_/g, " ")}: {n} this week</Chip>;
              })}
            </div>
            {traffic.events.length === 0 ? <Empty>No traffic recorded yet.</Empty> : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", fontFamily: T.mono, fontSize: 11 }}>
                  <thead><tr>
                    {["When", "What", "Email", "IP", "Country"].map((h) => (
                      <th key={h} style={{ textAlign: "left", padding: "5px 10px", borderBottom: `2px solid ${T.rule}`,
                        fontFamily: T.body, fontSize: 11, color: T.muted, textTransform: "uppercase", letterSpacing: ".06em" }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {traffic.events.map((ev, i) => {
                      const bad = ["unknown_email", "code_wrong", "code_lockout", "denied", "disabled_account", "rate_limited"].includes(ev.kind);
                      return (
                        <tr key={i} style={{ borderBottom: `1px solid ${T.rule}` }}>
                          <td style={{ padding: "5px 10px", whiteSpace: "nowrap", color: T.muted }}>
                            {new Date(ev.ts * 1000).toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                          </td>
                          <td style={{ padding: "5px 10px" }}>
                            <Chip fg={bad ? T.bRed : T.teal} bg={bad ? T.bRedBg : T.raised}>{ev.kind.replace(/_/g, " ")}</Chip>
                            {ev.detail && <span style={{ color: T.muted }}> {ev.detail}</span>}
                          </td>
                          <td style={{ padding: "5px 10px", color: T.text }}>{ev.email || "—"}</td>
                          <td style={{ padding: "5px 10px", color: T.muted }}>{ev.ip || "—"}</td>
                          <td style={{ padding: "5px 10px", color: T.muted }}>{ev.country || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* The last saves the server kept, any of which can be put back. Above
          Start again because it is the opposite of it: nothing here is lost. */}
      <Revisions />

      {/* Start again, at the very bottom of the last page on the tab: the one
          thing on the portal that cannot be undone, as far from anything
          anybody presses in a hurry as it can be put. */}
      <div style={{ background: T.panel, border: `1px solid ${T.rule}`,
        borderLeft: `4px solid ${T.bRed}`, borderRadius: 2, padding: "13px 15px", marginTop: 18 }}>
        <StartAgain />
      </div>
    </div>
  );
}

/**
 * The portal's undo. The server keeps the last 200 saves of the shared
 * document (worker/src/routes/history.ts); this lists them, newest first,
 * with what the portal held at each, and puts one back on a yes.
 *
 * Putting a version back is itself a save on top of everything, so every
 * open tab picks it up on its next look, and the version being replaced
 * stays on the list — a restore can be undone the same way. Certificates
 * and documents live in the file store, not in this document, so they are
 * never touched by it.
 */
function Revisions() {
  const [revs, setRevs] = useState(null);
  const [err, setErr] = useState("");
  const [asking, setAsking] = useState(null);   // the version waiting on a yes
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");

  const when = (ms) => new Date(ms).toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  const load = async () => {
    setErr("");
    try {
      const r = await fetch("/api/state/history");
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || `The saves couldn't be read (${r.status}).`);
      setRevs(out.revisions || []);
    } catch (e) { setErr(String(e.message || e)); }
  };
  React.useEffect(() => { load(); }, []);

  const restore = async (rv) => {
    setBusy(true); setErr(""); setDone("");
    try {
      const r = await fetch("/api/state/restore", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rev: rv.rev }),
      });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || `The version couldn't be put back (${r.status}).`);
      setDone(`Back to how it was at ${when(rv.savedAt)}. Every open tab picks it up within a minute.`);
      setAsking(null);
      await load();
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  const th = { textAlign: "left", padding: "5px 10px", borderBottom: `2px solid ${T.rule}`,
    fontFamily: T.body, fontSize: 11, color: T.muted, textTransform: "uppercase", letterSpacing: ".06em" };
  const td = { padding: "5px 10px", whiteSpace: "nowrap" };

  return (
    <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderLeft: `4px solid ${T.accent}`,
      borderRadius: 2, padding: "13px 15px", marginTop: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <Eyebrow color={T.accent}>Revisions</Eyebrow>
        <Button variant="quiet" onClick={load}>Refresh</Button>
      </div>
      {err && <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.bRed, marginBottom: 10 }}>{err}</div>}
      {done && <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.teal, marginBottom: 10 }}>{done}</div>}
      {!revs ? (!err && <Empty>Reading the saves...</Empty>) : revs.length === 0 ? (
        <Empty>No saves kept yet.</Empty>
      ) : (
        <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontFamily: T.mono, fontSize: 11 }}>
            <thead><tr>
              {["When", "Who", "Crew", "Matrix rows", "Dated cells", ""].map((h, i) => <th key={i} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {revs.map((rv, i) => (
                <tr key={rv.rev} style={{ borderBottom: `1px solid ${T.rule}` }}>
                  <td style={{ ...td, color: T.muted }}>{when(rv.savedAt)}</td>
                  <td style={{ ...td, color: T.text, whiteSpace: "normal" }}>{rv.savedBy || "—"}</td>
                  <td style={{ ...td, color: T.text }}>{rv.crew}</td>
                  <td style={{ ...td, color: T.text }}>{rv.matrixRows}</td>
                  <td style={{ ...td, color: T.text }}>{rv.datedCells}</td>
                  <td style={td}>
                    {i === 0
                      ? <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.muted }}>current</span>
                      : <Button variant="quiet" disabled={busy} onClick={() => setAsking(rv)}>Restore</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {asking && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(22,50,74,0.45)", zIndex: 78,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: T.panel, border: "1px solid " + T.rule, borderTop: "4px solid " + T.accent,
            borderRadius: 3, padding: "20px 24px", width: "min(520px, 94vw)" }}>
            <Eyebrow color={T.accent}>Go back to {when(asking.savedAt)}?</Eyebrow>
            <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.muted, margin: "9px 0 15px", lineHeight: 1.6 }}>
              The portal goes back to how it was then — {asking.crew} crew, {asking.matrixRows} on the matrix,
              {" "}{asking.datedCells} dates. Everything saved since stays on this list and can be put back the
              same way; certificates on file are not touched.
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Button variant="solid" disabled={busy} onClick={() => restore(asking)}>{busy ? "Going back..." : "Yes, go back"}</Button>
              <Button variant="quiet" disabled={busy} onClick={() => setAsking(null)}>No</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
