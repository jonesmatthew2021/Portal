# TSV Coolibah crew portal

Matthew Jones is Master of the vessel and is building this himself. He is not a
coder. Plain language, no jargon, and show him the change working in the preview
before saying it is done.

## The one rule about editing

Edit **`source/index.html`** or a file under **`source/areas/`**. Nothing else
in the frontend is a source file:

- `preview.html`, `portal.html`, `worker/assets/index.html` are **built**. Edit
  them and the next build throws the work away.
- `tools/source.mjs` assembles the portal: the shell plus every area, spliced in
  at the `/* @areas */` marker. Both builds and all six checks come through it.

```
node tools/build.mjs      # rebuild everything
node tools/check.mjs      # the six checks — run before deploying
```

`npm run deploy` in `worker/` runs the checks first and refuses to ship if any
fail.

## Where things are

`source/index.html` is the shell: the page, the theme (`T`), the shared
components, and the state everything hangs off (`usePortal()`).

One file per Admin tab, so two jobs on two tabs are two files:

| File under `source/areas/` | Tab |
|---|---|
| `crew-details.jsx` | Crew Details — the crew register |
| `swing-allocation.jsx` | Swings (thin — the board and the compliance check are in the shell) |
| `required-documents.jsx` | Documents — what the portal has to be given, with the library under it |
| `certification-checker.jsx` | the gaps list — not a page; shown on the Crew Matrix under Needs attention |
| `elearning-status.jsx` | E-Learning Status |
| `opms-checker.jsx` | OPMS Checker |
| `portways-documentation.jsx` | Portways Documentation |
| `ai-checker.jsx` | AI Checker |
| `sharepoint.jsx` | the SharePoint library browser, shown at the foot of Documents |
| `access-grants.jsx` | Access Grants |

An area file carries no import or export — by the time it runs it is the same
one file it always was, so it can use `T`, `usePortal()` and every shared
component directly.

To add an area: drop a `.jsx` file in `source/areas/`. The build picks it up by
filename order and a check confirms it arrived.

`source/fauna/` is the **Marine Fauna Observation Log** phone app, served at
`/fauna/` behind the same sign-in and installable from the phone's browser
as its own icon, and shown as the portal's **Fauna Log** tab (`FaunaLog` in
the shell frames the same page). Entries are made only by the Master, the
Chief Officer or the Second Officer — by department on Crew Details
(`Masters`, `DECK OFFICERS`), decided on the server (`logRank`/`mayLog` in
the route) for the phone and the tab alike; IT Help is never held out.
Everyone else signed in reads the month and can send it on. It is plain
HTML and a module, copied into the worker's assets as they are (no JSX, no
build step beyond the copy):

| File under `source/fauna/` | What |
|---|---|
| `index.html` | the app: a form — dropdowns where the log has them, typed boxes otherwise, units on the boxes; date, time, position and observer filled in; save |
| `fields.js` | the log's 31 columns and their dropdown lists, which must be filled, what the phone settles for itself (the head count, the zone, the light), and how each is written to the sheet — the page, the worker and the tests all run this one file |
| `template.xlsx` | the office's own workbook with one month tab, made by `node tools/fauna-template.mjs "<the office's log.xlsx>"`; the month export is written into it |
| `manifest.webmanifest`, `icon.svg` | the home-screen app; `node tools/fauna-icons.mjs` redraws the PNGs |

The worker side is `worker/src/routes/fauna.ts`: the entries live in
`fauna_sightings`, `GET /api/fauna/export?month=` hands back the month as
the office's workbook, and `POST /api/fauna/send` emails that workbook,
attached, from portal@coolibah-portal.com to the addresses typed on the
phone (Cloudflare's email binding, reply-to the sender). The page shows the
month's spreadsheet at the bottom with a Generate spreadsheet button under
it, then Open, Share (where the phone's share sheet takes a spreadsheet),
Send (by email) and Save — sending is the person's choice. Voice and AI
reading were built first and taken out on 24 Sep 2026 at Matthew's word,
and so was a PDF of the sheet (he wants the spreadsheet itself): it is a
form, nothing more.

**The logs in SharePoint.** `SHAREPOINT_FAUNA_FOLDER` (wrangler.toml) names
the library folder — Matthew's choice, 24 Sep 2026: a subfolder called
Fauna under the team's files, one new workbook each month. Every save
writes the entry into the month's workbook straight away (`settleLog` in the
route, the workbook work in `worker/src/lib/fauna-log.ts`): the file whose
name carries the month ("09.2026 - Marine Fauna Observation Log.xlsx"), made
from `template.xlsx` the first time the month has an entry. The hour writes
whatever could not be written then. `fauna_sightings.written_month/
written_tab/written_row` remember where each entry sits, so a change rewrites
its own row, a removal blanks it and an entry moved to another month is
blanked in the file it left. Rows anyone typed by hand are never touched. The
folder is Matthew's to make — the portal makes the files, never the folder.

`source/shared/` holds the code the page and the worker both run: the workbook
writer (`workbook.js`), the matrix rules (`matrix-rules.js`) and the names
register (`names.js`). The build splices them into the page at `/* @shared */`
with the `export` taken off each declaration, and the worker imports them as
modules. Edit that code there and only there.

## Things that have already been decided

- **Crew names.** `Admin → Crew Details` is the crew register: each person named
  once, with every other spelling they answer to. The matrix, the certificate
  dates and the certificate list all read names through it
  (`crewRegister` / `asKnownPerson`). Do not add a name comparison that goes
  round it.
- **SharePoint folders are Matthew's.** The portal renames files where it finds
  them and never creates, renames or moves a folder. Use
  `blobFolder(blobKey)` — the folder a file is actually in — never
  `opmsCertPrefix(token)`, which works a name out and so makes new folders.
- **No explainer text.** The UI carries what Matthew asked for and nothing else.
  Don't add helpful notes to the screen.
- **The nightly backup goes into a folder Matthew made.** `worker/src/lib/backup.ts`:
  the first hour after `BACKUP_HOUR` (Perth) writes one JSON file — the shared
  document byte for byte, the file index, the users, the readings, the fauna
  log; never sessions, sign-in codes or history — into `BACKUP_FOLDER`
  (wrangler.toml; empty means off and nothing shown), never making the folder
  (`set(..., { intoExistingFolder: true })`) and refusing one the portal files
  into (`folderAllowed`). A month of dailies and a year of monthlies are kept by
  name, never by listing. `POST /api/state/restore-file` puts one back
  (`routes/restore-file.ts`, from a terminal: the document as a save under a
  name of its own; the file index, users, readings and fauna only when named).
- **One round.** Every Update matrix button starts the server's round
  (`POST /api/round`, `runMatrixRound` in `source/index.html`); the page
  reads new certificates and refiles first, and never applies dates itself
  — it re-pulls the document. Every such button is called Update matrix
  (`UpdateMatrixButton`, the default label, wherever it sits); the matrix
  spreadsheet is a report built from the matrix as it stands
  (`MatrixSpreadsheet`: Matrix spreadsheet to download it, File the matrix
  spreadsheet to file it), never a reading.
- **The round on the hour is the worker's.** `worker/src/lib/round.ts` puts
  the certificates' dates on the crew matrix and writes the office's CREW
  QUALIFICATION EXPIRY workbook by itself, every hour, with no browser open
  (`scheduled()` in `worker/src/index.ts`; the SharePoint page shows what it
  did). It saves the shared document against the revision it read
  (`lib/shared-state.ts`), replaces the workbook through
  `db/single-file.ts` whose order of work is fixed so the old copy is never
  lost, clears a date only on its second sighting as an orphan, and writes
  only the cells it changed plus blanks — a figure the office typed is left
  as typed. A cell that reaches the matrix but not the workbook is written
  on the document (`workbookPending`) and paid the next hour. Removed copies are parked flat under `removed/` (no folder is
  ever made), and a file the office itself put in a folder is never moved:
  its row comes off the books with the bytes left where they are. One lease
  (`takeLease`/`dropLease` in `round.ts`) covers everyone who writes the
  workbook: the hour holds it around its sync, reading and round, and
  `POST /api/sync`, the workbook upload and the round take the same one for
  their turn or answer 409. Anything new that writes the workbook takes it.
  The round can also be started from the page with `POST /api/round`
  (`routes/round.ts`; progress under `round-progress`, read back by
  `GET /api/round/progress`): the page reads and refiles first, and
  `POST /api/round/prepare` has the server keep the Equivalence sheet and
  the expiry rules before it does. A browser that goes mid-round can have
  the request cancelled, so that round takes the lease for four minutes,
  not fifteen (two of them for a workbook write in flight past the
  budget), and the page matches its progress by the `runId` it sent. A
  page treats a record that is not done as dead once the lease is no
  longer held under the record's `by` (`running` false, or `holder`
  another name - the hour can take a lapsed lease within fifteen seconds
  and hold it for up to nine minutes plus its write); the lease lapses at
  `LEASE_FOR_MS` from its take or its last renewal - the round renews it
  on every word of progress (`renewLease`, the holder's token only), so a
  lapsed lease only ever means a round that died. Never by the age of the
  last word, because the workbook step can outlast any of them. The hour
  never takes a lease that is still being renewed: it tries for five
  minutes and then gives up on the hour (`another round is still
  running`). A page round whose renewal finds the lease taken - it lapsed
  in a silence longer than `LEASE_FOR_MS` and the hour or an upload took
  it - writes the workbook no further (`leaseHeld` into `runMatrixRound`)
  and leaves its cells owed. Every
  writer of the workbook refused for the lease answers 409 with the one
  sentence (`writingTheWorkbook`), naming the holder (`leaseHolder`), and
  `GET /api/sync/last` names the holder too, so a page waiting on the
  lease holds its buttons down under whoever has it at each look.
  The hour's own work stops starting things nine minutes after its lease
  or twelve after the tick, whichever is first (`hourDeadline`). Before it
  takes the lease it writes the nightly backup (`nightlyBackup`), which
  takes none and can stop nothing. Its reading stops on the first answer
  about the model's account: no credit or a refused key goes on the record
  in red (`readError`), a busy model or the rate as an aside
  (`readStopped`), and the refile and the round still run. A refusal from
  the model is sorted once (`ModelRefusal.kind` in `lib/analysis.ts`,
  message before status) and said in one of the three sentences in
  `source/shared/reading-lines.js`; only a document the model turned away
  is ever stored as unreadable — nothing about the account is a fact
  about a scan. The
  Equivalence sheet is never kept as an empty table, and is read again
  when the skills matrix or the crew matrix's columns change.
  An open admin tab runs the round only when the server has not
  (`shouldTabRound`), and a save that lands on the hour's merges the log and
  the round's notes (`mergeSaved`) rather than writing over them - each
  three ways, against what the tab last loaded or saved, so a line or a
  note the server took off since stays off. A save that never got there
  is tried again by itself (`saveTryAgainIn`); a tab is never left holding
  a change that nothing will send.
- **The last 200 saves are kept** (`portal_state_history`) and any one of them
  can be put back from `Admin → Access Grants`, under Revisions.

## Working in parallel

Several sessions can work different areas at once. Before starting, `git pull`;
when finished, run the checks, commit, deploy and push. Two sessions editing
`source/index.html` will still collide — that part is shared.

`portal.html.src.md5` is the one built file that is tracked: it is the stamp
the server checks `portal.html` against, and the build rewrites it. Commit it
with a change; never edit it.
