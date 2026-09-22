/* Swing Allocation — the Admin tab of that name.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state; this
 * holds what is only this tab's. See tools/source.mjs.
 */
function RosterPage({ currentUser, people, setPeople, overrides, swingBoard, setSwingBoard, log }) {
  const { swingArchive } = usePortal();
  const k0 = currentSwingIndex();
  const [at, setAt] = useState(k0);
  const [archived, setArchived] = useState(null);
  const boardRef = useRef(null);
  // Swings gone by, newest first — the record of each as it stood when it
  // ended, kept five years.
  const past = Object.values(swingArchive || {}).filter((a) => a && a.k < k0).sort((a, b) => b.k - a.k);
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <SectionHead title="Swing Allocation" />
        <GenerateAllocations people={people} log={log} />
      </div>
      <SwingCompliance cardsOnly people={people} overrides={overrides} at={at} setAt={setAt}
        onOpenSwing={() => { if (boardRef.current) boardRef.current.scrollIntoView({ behavior: "smooth", block: "start" }); }} />
      {past.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ marginBottom: 8 }}>
            <Eyebrow>Archived swings</Eyebrow>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {past.map((a) => (
              <Button key={a.k} variant="quiet" onClick={() => setArchived(a)}>
                {swingLabel(a)} · Crew {a.crew} · {a.rows.length} onboard
              </Button>
            ))}
          </div>
        </div>
      )}
      <div ref={boardRef}>
        <CrewRosters people={people} setPeople={setPeople} board={swingBoard}
          setBoard={setSwingBoard} log={log} currentUser={currentUser}
          viewSwing={at} overrides={overrides}
          onShowNow={() => setAt(k0)} />
      </div>
      {archived && (
        <SwingDayGrid snapshot={archived} people={people} onClose={() => setArchived(null)} />
      )}
    </>
  );
}
