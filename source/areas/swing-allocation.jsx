/* Swings — the Admin tab of that name.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state; this
 * holds what is only this tab's. See tools/source.mjs.
 *
 * One page for everything about a swing. It used to be two — Swing
 * Allocation (the cards, the editable board, the archive) and Swing
 * Compliance (the same cards again over a read-only copy of the board, with
 * the legend, the details and the swing report under it). Read top to
 * bottom now: the legend, the cards, the board — editable, and open — then
 * who is clear and who isn't, the shift requirements, the swing report, and
 * the swings gone by.
 */
function SwingsPage({ currentUser, people, setPeople, overrides, swingBoard, setSwingBoard, log }) {
  const { swingArchive } = usePortal();
  const k0 = currentSwingIndex();
  const [at, setAt] = useState(k0);
  const [archived, setArchived] = useState(null);
  // Swings gone by, newest first — the record of each as it stood when it
  // ended, kept five years.
  const past = Object.values(swingArchive || {}).filter((a) => a && a.k < k0).sort((a, b) => b.k - a.k);
  return (
    <>
      <SectionHead title="Swings" />
      <ComplianceLegend />
      <SwingCompliance people={people} overrides={overrides} at={at} setAt={setAt} rosterOpen
        roster={
          <CrewRosters people={people} setPeople={setPeople} board={swingBoard}
            setBoard={setSwingBoard} log={log} currentUser={currentUser}
            viewSwing={at} overrides={overrides}
            onShowNow={() => setAt(k0)} />
        } />
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
      {archived && (
        <SwingDayGrid snapshot={archived} people={people} onClose={() => setArchived(null)} />
      )}
    </>
  );
}
