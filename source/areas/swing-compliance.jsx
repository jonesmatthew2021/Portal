/* Swing Compliance — the Admin tab of that name.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state; this
 * holds what is only this tab's. See tools/source.mjs.
 */
function SwingCompliancePage({ currentUser, people, setPeople, overrides, swingBoard, setSwingBoard, log }) {
  const [at, setAt] = useState(currentSwingIndex());
  return (
    <>
      <SectionHead title="Swing Compliance" />
      <ComplianceLegend />
      <SwingCompliance compact people={people} overrides={overrides} at={at} setAt={setAt}
        roster={
          <CrewRosters readOnly asAt={todayISO()} people={people} setPeople={setPeople} board={swingBoard}
            setBoard={setSwingBoard} log={log} currentUser={currentUser}
            viewSwing={at} overrides={overrides}
            onShowNow={() => setAt(currentSwingIndex())} />
        } />
    </>
  );
}
