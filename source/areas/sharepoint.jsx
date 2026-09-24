/* SharePoint — the company library, live. Shown at the foot of the
 * Documents page when it is asked for.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state; this
 * holds what is only this section's. See tools/source.mjs.
 */
function SharePointPage() {
  // Whether the worker's hour holds the workbook: the import is held down while it does.
  const { roundRunning, offlineAt } = usePortal();
  const [path, setPath] = useState("");
  const [listing, setListing] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async (at) => {
    setBusy(true); setErr("");
    try {
      const r = await fetch(`/api/sharepoint?path=${encodeURIComponent(at)}`);
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || `The library couldn't be read (${r.status}).`);
      setListing(out);
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };
  React.useEffect(() => { load(path); }, [path]);

  // Folders → portal, on demand: the same pass the hourly schedule runs.
  const [syncing, setSyncing] = useState(false);
  const [syncOut, setSyncOut] = useState(null);
  const [prog, setProg] = useState(null);
  // Whose folders the last sync found, held until the difference is answered.
  const [peopleSeen, setPeopleSeen] = useState(null);
  const syncNow = async () => {
    setSyncing(true); setSyncOut(null); setPeopleSeen(null); setProg({ pct: 0, word: "Asking the portal to read the folders" });
    // While the sync request is held open, the worker writes its progress down
    // and this poll reads the percentage back for the window.
    const poll = setInterval(async () => {
      try {
        const r = await fetch("/api/sync/progress");
        if (r.ok) { const p = await r.json(); if (p && !p.done) setProg(p); }
      } catch (e) {}
    }, 700);
    try {
      const r = await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ by: "Import new files" }) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || `The import failed (${r.status}).`);
      setSyncOut(out);
      if (out && Array.isArray(out.people)) setPeopleSeen(out.people);
      await load(path);
    } catch (e) { setSyncOut({ error: String(e.message || e) }); }
    clearInterval(poll);
    setSyncing(false);
  };
  const syncLine = () => {
    const ls = listing && listing.lastSync;
    if (!ls) return "Files dropped into these folders from Teams are taken onto the portal's books every hour — none has run yet.";
    const when = new Date(ls.at).toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    if (ls.error) return `Last import ${when} (${ls.by}) failed: ${ls.error}`;
    return `Folders last read ${when} (${ls.by}): ${ls.registered} new certificate${ls.registered === 1 ? "" : "s"} taken on` +
      (ls.adopted ? `, ${ls.adopted} document${ls.adopted === 1 ? "" : "s"} adopted` : "") +
      (ls.missing ? `, ${ls.missing} on the books but gone from the folders` +
        (ls.heldBack ? " — too many to believe in one pass, nothing was taken off the books" : "") : "") + ". Runs every hour.";
  };

  // The worker's own word on its last hourly round — in red when it fell over.
  // The round's part (the dates put on the matrix, the workbook written)
  // rides in the same record, so the one line says the whole hour.
  const hourlyLine = () => {
    const h = listing && listing.lastHourly;
    if (!h) return null;
    const when = new Date(h.at).toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    // The hour's own line, or the name of whoever ran the round from the page.
    const fromPage = !!h.by && h.by !== "the round on the hour";
    const opening = (fromPage ? h.by + " ran the round " : "Hourly round ") + when;
    const bad = [h.syncError, h.readError, h.roundError].filter(Boolean).join("; ");
    if (bad) return { bad: true, text: opening + " failed: " + bad };
    // The record says a workbook problem on roundSkipped too, for the open tab; said once here.
    const aside = [...new Set([h.roundSkipped, h.workbookProblem, h.held, h.validityProblem, h.equivalenceProblem, h.readStopped].filter(Boolean))].join("; ");
    // A round run from the page did its reading and refiling before it came, so those counts are the hour's alone.
    const parts = [
      ...(fromPage ? [] : [h.read + " certificate" + (h.read === 1 ? "" : "s") + " read", h.refiled + " refiled"]),
      ...(h.applied ? [h.applied + " date" + (h.applied === 1 ? "" : "s") + " applied"] : []),
      ...(h.cleared ? [h.cleared + " cleared"] : []),
      ...(h.workbook ? ["workbook written as " + h.workbook] : []),
      ...(h.leftAsTyped ? [h.leftAsTyped + " cell" + (h.leftAsTyped === 1 ? "" : "s") + " left as the office typed them"] : []),
      Math.max(1, Math.round(h.durationMs / 1000)) + "s",
    ];
    return { bad: false, text: opening + ": " + parts.join(", ") + "." + (aside ? " (" + aside + ")" : "") };
  };

  const fmtBytes = (n) => n == null ? "" :
    n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

  // The nightly backup's own line: when it last landed and how big, or
  // why it did not, in red. Nothing at all where no backup folder is named.
  const backupLine = () => {
    const b = listing && listing.lastBackup;
    if (!b) return null;
    const when = new Date(b.at).toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    // The day it last landed, said the way the rest of the line says days.
    const landed = b.day ? new Date(b.day + "T00:00:00").toLocaleDateString("en-AU", { day: "2-digit", month: "short" }) : "";
    if (b.error) return { bad: true, text: "Backup " + when + " failed: " + b.error + (landed ? " (last one landed " + landed + ")" : "") };
    return { bad: false, text: "Last backup " + when + ", " + fmtBytes(b.bytes) };
  };
  const fmtWhen = (s) => !s ? "" :
    new Date(s).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });

  const crumbs = path ? path.split("/") : [];
  const entries = (listing && listing.entries) || [];

  return (
    <div>
      {/* Folders → portal: what the hourly import last did, and a button to run it now. */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontFamily: T.body,
        fontSize: 12.5, color: T.muted, padding: "9px 12px", border: `1px solid ${T.rule}`, borderRadius: 2,
        marginBottom: 12 }}>
        <span style={{ flex: 1, minWidth: 0, lineHeight: 1.6 }}>
          <div>{syncLine()}</div>
          {hourlyLine() && <div style={{ color: hourlyLine().bad ? T.bRed : T.muted }}>{hourlyLine().text}</div>}
          {backupLine() && <div style={{ color: backupLine().bad ? T.bRed : T.muted }}>{backupLine().text}</div>}
        </span>
        <Button variant="quiet" writes disabled={syncing || controlsLocked(offlineAt, roundRunning)}
          title={!syncing && controlsLocked(offlineAt, roundRunning) ? (offlineAt ? offlineLine(offlineAt) : ROUND_BUSY) : undefined}
          onClick={syncNow}>{syncing ? "Importing..." : "Import new files"}</Button>
      </div>
      {/* The sync window: the worker's own percentage while it runs, and a
          plain answer when it is done — what was taken on, or why nothing was. */}
      {(syncing || syncOut) && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(22,50,74,0.45)", zIndex: 60,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderTop: `4px solid ${T.accent}`,
            borderRadius: 3, padding: "22px 26px", width: "min(540px, 92vw)", maxHeight: "80vh", overflowY: "auto" }}>
            <Eyebrow color={T.accent}>{syncing ? "Importing from SharePoint" : "Import finished"}</Eyebrow>
            {syncing ? (
              <>
                <div style={{ fontFamily: T.display, fontSize: 46, fontWeight: 700, color: T.text, margin: "10px 0 2px" }}>
                  {Math.round((prog && prog.pct) || 0)}%
                </div>
                <div style={{ height: 8, background: T.raised, borderRadius: 4, overflow: "hidden", margin: "8px 0 10px" }}>
                  <div style={{ height: "100%", width: `${Math.round((prog && prog.pct) || 0)}%`, background: T.accent,
                    transition: "width .5s" }} />
                </div>
                <div style={{ fontFamily: T.body, fontSize: 13, color: T.muted }}>{(prog && prog.word) || "Working..."}</div>
              </>
            ) : syncOut.error ? (
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.bRed, margin: "12px 0" }}>{syncOut.error}</div>
            ) : (
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.7, margin: "12px 0" }}>
                {syncOut.registered.length === 0 ? (
                  <b>Nothing new to take on.</b>
                ) : (
                  <>
                    <b>{syncOut.registered.length} new certificate{syncOut.registered.length === 1 ? "" : "s"} taken on:</b>
                    <ul style={{ margin: "6px 0", paddingLeft: 20, fontFamily: T.mono, fontSize: 11.5 }}>
                      {syncOut.registered.slice(0, 12).map((r) => <li key={r.id}>{r.key.split("/").slice(1).join(" / ")}</li>)}
                    </ul>
                    {syncOut.registered.length > 12 && <div>...and {syncOut.registered.length - 12} more.</div>}
                  </>
                )}
                {syncOut.adopted.length > 0 && (
                  <div style={{ marginTop: 6 }}>{syncOut.adopted.length} document{syncOut.adopted.length === 1 ? "" : "s"} adopted.</div>
                )}
                {syncOut.missing.length > 0 && (
                  <div style={{ color: T.bRed, marginTop: 8 }}>
                    {syncOut.missing.length} on the books but gone from the folders (moved or renamed by hand) — nothing was deleted.
                  </div>
                )}
              </div>
            )}
            {!syncing && (
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button onClick={() => setSyncOut(null)}>Close</Button>
              </div>
            )}
          </div>
        </div>
      )}

      {peopleSeen && !syncing && !syncOut && (
        <SyncPeople found={peopleSeen} onClose={() => setPeopleSeen(null)} />
      )}

      {/* Where we are */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontFamily: T.mono,
        fontSize: 12, padding: "9px 12px", background: T.panel, border: `1px solid ${T.rule}`,
        borderLeft: `4px solid ${T.accent}`, borderRadius: 2, marginBottom: 12 }}>
        <a style={{ cursor: "pointer", color: T.accent, fontWeight: 700 }} onClick={() => setPath("")}>Library</a>
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            <span style={{ color: T.muted }}>/</span>
            <a style={{ cursor: "pointer", color: i === crumbs.length - 1 ? T.text : T.accent }}
              onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}>{c}</a>
          </React.Fragment>
        ))}
        <span style={{ flex: 1 }} />
        <Button variant="quiet" disabled={busy} onClick={() => load(path)}>Refresh</Button>
      </div>

      {err && <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.bRed, marginBottom: 12 }}>{err}</div>}
      {busy && !listing ? <Empty>Reading the library...</Empty> : null}

      {listing && !busy && entries.length === 0 && !err && <Empty>This folder is empty.</Empty>}

      {entries.map((e) => (
        <div key={e.path} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 12px",
          borderBottom: `1px solid ${T.rule}`, opacity: busy ? 0.5 : 1 }}>
          {e.folder ? (
            <>
              <span style={{ color: T.accent, fontFamily: T.mono, fontSize: 12 }}>&#9656;</span>
              <a style={{ cursor: "pointer", flex: 1, fontFamily: T.body, fontSize: 13.5, fontWeight: 600,
                color: T.text }} onClick={() => setPath(e.path)}>{e.name}</a>
              <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted }}>
                {e.count == null ? "" : `${e.count} item${e.count === 1 ? "" : "s"}`}
              </span>
            </>
          ) : (
            <>
              <span style={{ width: 10 }} />
              <span style={{ flex: 1, fontFamily: T.body, fontSize: 13, color: T.text, minWidth: 0,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
              <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted }}>{fmtBytes(e.size)}</span>
              <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted }}>{fmtWhen(e.modified)}</span>
              {e.downloadUrl && (
                <a href={e.downloadUrl} target="_blank" rel="noreferrer"
                  style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.accent }}>Open</a>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
