# TSV Coolibah crew portal

Matthew Jones is Master of the vessel and is building this himself. He is not a
coder. Plain language, no jargon, and show him the change working in the preview
before saying it is done.

## The one rule about editing

Edit **`source/index.html`**, a file under **`source/parts/`** or
**`source/areas/`**, or **`source/vessel.json`** (what is this vessel's, not
the portal's). Nothing else in the frontend is a source file:

- `preview.html`, `portal.html`, `worker/assets/index.html` are **built**. Edit
  them and the next build throws the work away.
- `tools/source.mjs` assembles the portal: the shell plus every part, spliced in
  at the `/* @parts */` marker, plus every area, spliced in at the `/* @areas */`
  marker just after. Both builds and every check come through it.

```
node tools/build.mjs      # rebuild everything
node tools/check.mjs      # the checks — run before deploying
```

`npm run deploy` in `worker/` runs the checks first and refuses to ship if any
fail.

## Where things are

`source/index.html` is the shell: the page, the theme (`T`), the shared
components, and the state everything hangs off (`usePortal()`).

One file per big crew-facing page, spliced in at `/* @parts */` just before
the areas, by the same rules as an area (no import or export, filename order,
a check confirms each arrived):

| File under `source/parts/` | Page |
|---|---|
| `certificate-cells.jsx` | the certificate cells the three pages and the Admin tabs share: the bands, the tickets, the skills matrix read, a cell's dates and links, the viewer, the Update matrix button |
| `crew-matrix.jsx` | Crew Matrix — the round's rules, the grid and its reports, the workbook and the round window, the items held against the office's list, the swing compliance report |
| `roster.jsx` | Roster — the swing board and its editor, the swing compliance and day grid, the crew-roster workbook, the timeline and the roster page, the shift matrix |
| `upload-certificates.jsx` | Upload Crew Certificates — the folder and name helpers, the upload page, who SharePoint says is on the strength, the tab's turn at the round, the crew's camera upload |

`runMatrixRound`, the swing dates (`swingAt`, `swingWithDates`) and the upload
transports stay in the shell: they are the state's, and the areas read them.

One file per Admin tab, so two jobs on two tabs are two files:

| File under `source/areas/` | Tab |
|---|---|
| `crew-details.jsx` | Crew Details — the crew register |
| `swing-allocation.jsx` | Swings (thin — the board is in `source/parts/roster.jsx`, the compliance report in `source/parts/crew-matrix.jsx`) |
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
writer (`workbook.js`), the matrix rules (`matrix-rules.js`), the names
register (`names.js`), the offline rules (`offline-rules.js`), the three
sentences said when the model's account stops a reading
(`reading-lines.js`), the red and amber bands' day counts (`bands.js`), the
weekly expiry reminders' rules (`reminders.js`), a man's MSIC number and
date of birth off his certificates (`particulars.js`), and the five Marine
Orders rules — the columns one certificate covers (`covers.js`), a
certificate of recognition against the certificate behind it
(`recognition.js`), the medical (`medical.js`), what must be in hand before a
renewal (`renewals.js`) and the papers that stand in for a certificate that
has run out (`evidence.js`); the expiry day itself is in `bands.js`
(`hasExpired`). The build splices
them into the page at `/* @shared */` with the `export` taken off each
declaration, and the worker imports them as modules. A shared file cannot
import another: what one leans on from another is handed in by the caller.
Edit that code there and only there.

`source/app/sw.js` is the service worker that keeps the last-loaded portal
readable offline, built to `/sw.js` with the build's stamp written in as its
version and `offline-rules.js` folded in at `/* @offline-rules */`.
`source/vendor/` holds the portal's own copies of React and React DOM (the
18.2.0 builds, from `tools/node_modules`) and the font files (latin and
latin-ext, from the `@fontsource` packages) with their licences, served at
`/vendor/` and copied into the worker's assets at build;
the preview asks for the same files as `source/vendor/` beside `preview.html`.

`source/vessel.json` — everything that is this vessel's (name, brand, timezone,
domain, ranks, swings, customer marks, crew folders); a new vessel is a new
file, never an edit to the page. It also carries the four tables the Marine
Orders rules read, each entry with the clause it comes from written beside it,
so the law's mapping is data anybody can check against the order rather than a
number in the code: `covers` (which printed endorsement fills which column),
`renewalNeeds` (what must be in hand before a renewal), `evidenceKinds` (the
five papers that stand in for a certificate, their ceilings and their columns)
and `neverRecognised` (the columns a recognition can never fill). Both
`checkVessel`s refuse a file whose tables name a column this matrix has not
got. The build declares it on the page as `VESSEL`
at `/* @vessel */` and writes the page's head and the manifest from it; the
worker reads it through `worker/src/vessel.ts`. The eleventh check assembles
the page for a made-up vessel (`tools/fixtures/example-vessel.json`) and fails
on any line that still names this one.

## Things that have already been decided

- **Crew names.** `Admin → Crew Details` is the crew register: each person named
  once, with every other spelling they answer to. The matrix, the certificate
  dates and the certificate list all read names through it
  (`crewRegister` / `asKnownPerson`). Do not add a name comparison that goes
  round it.
- **A man's MSIC number and date of birth come from his certificates.** The
  two boxes beside his name on Crew Details are filled in the round's own
  save (`source/shared/particulars.js`: `particularsFor`, `fillParticulars`;
  `lib/round.ts`), the hour's and Update matrix's alike, and an idle round
  saves nothing: the MSIC number off the MSIC card he holds now
  (`newestCard`; the column found by its title in the vessel file, and only
  a document the reading says is the card itself, `isMsicCard`), the date
  of birth where most of his certificates agree (a tie is no answer) - only
  from certificates filed under him and printed in his name, both through
  the register; one that names nobody gives nothing. A box somebody typed
  is left as typed; one still holding what the certificates put there
  (`particularsFromCert`, by his id, with what they put there before under
  `was`) takes a renewed card's number. A tab saving the crew list keeps
  the round's fill (`mergeParticulars` in `mergeSaved`). The reading asks
  every certificate for `documentNumber` and `holderBirthDate` (both keys
  always written); `READING_VERSION` is unchanged, and the readings made
  before are topped up by a bounded pass on the hour (`topUpParticulars` in
  `routes/analyse.ts`: only for a box still the certificates', read the
  way the rule reads - the newest card in his name without the key, a
  newer card the first look could not name looked at once first, and his
  date of birth while `particularsFor` gives none, a read ending the
  search only when the rule's answer moves - at most
  twenty an hour and three per man for his date of birth (counted by
  `particularsAsked`), `particularsRead` on the hour's record, stopping on
  the account's first no, adding the two keys - null where the second look
  reads another man's name - and nothing else to the reading held but his
  own name where the first look read none; the keys are its only memory; a
  fault of its own goes on `particularsError`, never the reading's red).
  Crew are never handed either: a crew login's `GET /api/state` (and a
  save's 409) is the crew's copy of the document (`crewStateView` in
  `authz.ts` - no `msic`, no `dob`, no `particularsFromCert`), a crew
  save carries only its comments (`crewStateBody`), and so the copy a crew
  phone keeps offline never holds them.
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
  (the write is addressed to the folder by the id `hasFolder` gave,
  `set(..., { intoFolderId })`, so no path is ever resolved for Graph to grow
  a folder to fit) and refusing one the portal files into or one that holds
  the portal's folders (`folderAllowed`). A month of dailies and a year of
  monthlies are kept by name, never by listing. `POST /api/state/restore-file`
  puts one back (`routes/restore-file.ts`, from a terminal: the document as a
  save under a name of its own, on a wiped database too; the file index,
  users, readings and fauna only when named, and the readings only into the
  four stores the backup writes).
- **Certificate-expiry reminders are weekly, and off until switched on.**
  The setting is the document's `reminders` (`{ on, days, weekday, hour }`,
  defaults off, 90, Monday, 07:00 - `REMINDER_DEFAULTS`, read through
  `reminderSetting`, only a plain `true` is on), switched on Access Grants.
  `worker/src/lib/reminders.ts` (`weeklyReminders`) runs from `scheduled()`
  beside the backup, before the lease, taking none and asking nothing of
  the library: the tick at ten past the set hour on the set weekday (the
  vessel's weekday, `vesselNow`) sends each crew grant their own list and
  every management and IT grant a summary by person, from
  `vessel.mailFrom`. A crew grant's name reaches a matrix row only through
  the crew register, and a name it cannot put to exactly one person, or a
  one-word name, is sent nothing. A crew email is held to the register
  strictly at both ends (`remStrictRegister`: one of the person's own
  spellings letter for letter, or exactly their words): the grant's name,
  and the matrix row each item came from (`from` on the item), so a row
  the register only loosely takes for him ("EVANS, R.", "EVANS, Brenton
  James") is in the summary and never in his inbox. The rules are
  `source/shared/reminders.js`. One record, `last-reminder` in the sync
  store, claimed for the set day against the version read before any email
  goes, so nothing is ever sent twice; one line on the SharePoint page.
  Never two weeks' sends less than seven days apart, whatever the weekday
  is moved to (`reminderOwed`); a set day whose every tick was missed is
  sent the next day, as that set day, only where last week's went. The
  sends stop starting a minute in (`reminderLimits`) and name whoever was
  not reached, and a send the email service does not answer within
  `answerWithinMs` (twenty seconds, the wait through `reminderWaits`) is
  given up on and named as unanswered (`unanswered`, not `failed`: the
  service may still deliver it), so they never eat the round's hour.
  Offline the switch, the weekdays and both boxes are held down under the
  badge's line like every other control that writes. The reminders read the
  document every hour before the lease; the lease test allows that one
  read and nothing else of the books. The
  red band's 90 days is one number, `RED_DAYS` in `source/shared/bands.js`,
  with the day count (`daysUntil`) the page and the reminders both use; a
  test holds the reminders' default window to it. The matrix reports' "due
  within ... days" and the assistant's expiring (`expiringIn`,
  `EXPIRING_MEANS` in `worker/src/lib/portal.ts`) read it too.
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
- **The portal reads offline from the last good copy the service worker
  kept** (`source/app/sw.js`, the rules in `source/shared/offline-rules.js`):
  the page, the vendor scripts and fonts, `/api/me`, `/api/state`,
  `/api/files` and `/api/sync/last`, each stamped with when it was fetched.
  Network first, always - a kept copy is used only when the network fails or
  has not started answering (`networkWait`: four seconds for the page and
  for `/api/me`, which the boot waits on and whose kept copy is always the
  person signed in on this device; thirty for the other three answers,
  because a slow link that answers in ten is a link and a kept copy handed
  back then would put a connected portal into offline mode - `/api/state`
  decides that), and the race is on the headers, never on the copy being
  kept - the body streams to the page at the link's own speed. A cache the
  phone will not give (`openCache` null) means the request goes to the
  network plain: the cache failing never fails the page. A live answer of
  any status ends offline mode and a kept one never does
  (`offlineAfterPull`): a 500 on a link that is up is Not saving with the
  reason, not Offline. Every good
  answer replaces the copy, so a deploy is picked up the moment the link is
  up and a stale page is never preferred. Offline the page is read only,
  with one line on the badge ("Offline - showing the portal as at ...",
  `offlineLine`), `put()` refusing every change and every control that
  writes held down under that line (`Button`'s `writes`, `DeleteBtn`,
  `DropSpot`, `controlsLocked`). Sign-out tells the worker to forget
  everything (`forgetOffline`); a sign-in that is over - a 401, or the
  sign-in form served where the page should be - clears the kept copies
  (`forgetsOn`), so a revoked device reads nothing offline, and a live 401
  on the poll sends the tab to the sign-in page the way the boot does
  (`signInOverAfterPull`); a sign-out and a sign-in forget what is kept
  before the request goes and again after the server answers, and a copy
  fetched before either forget is never kept after it (`era` in `sw.js`:
  the worker answers `POST /login/verify` and `/logout` itself,
  `forgetsBefore`, so a slow link can never boot the portal as the last
  person, and until the 303 is back the cookie is still theirs, so
  anything answered in that round trip is forgotten again after it); a
  live `/api/me` for somebody else clears them too; a
  new build carries the kept answers and the page across only from an
  earlier `portal-*` cache and only for the same person
  (`earlierPortalCache`), and the install keeps only the build's own files
  - the vendor scripts and fonts, never who is signed in nor the page (the
  browser finds a deploy on the sign-in POST and on the sign-out, and an
  install fetching then was told the last person, on a cookie not yet
  replaced or revoked, and kept them where nothing forgot them); the first
  worker's kept `/api/me` and kept page are the page's to give
  (`keepIdentityOnceControlled`: a page booted live with no worker in
  front of it when the boot's `/api/me` was sent - sampled before the
  send, never after the answer, since the worker can take control while
  the request is on the wire - asks `/api/me` and `/` again once the
  worker controls it, at once if it already does, and those answers are
  kept the ordinary way; a page a hard reload left uncontrolled under an
  active worker reloads itself once, `reloadToBeControlled`); a kept identity is trusted only
  while the document is kept (`identityUnproven`: the first live
  `/api/state` under a stamped `/api/me` has the page ask `/api/me?live=1`
  once - `proveIdentity` - and reload as whoever the server says, or go to
  the sign-in page on a 401), and a sign-in answered by the worker is told
  to every open portal tab (`SIGNED_IN_MESSAGE`), each of which asks the
  same way, so a tab left open as the last person never polls or saves
  under the new cookie in their name; a cache the phone will not give at install
  or on taking over fails neither (`openCache` null, the activate's work in
  a try, `clients.claim()` regardless);
  and nothing else is ever cached - file bytes, the CDN scripts, the fauna
  app and every write go to the network untouched. The preview's name
  picker never shows on the live site (`showPicker`: only under the shim's
  flag).
- **A listing the library refuses fails the survey and moves nothing.** A 404
  on the certificate home, or on a man's folder outside it once anything
  live is on the books under it (`hasFolder` before the walk in `survey`; a
  folder with nothing under it yet may not exist), or a 429 or 5xx still
  standing after the driver's three retries (`graph` in `files/store.ts`,
  waits through `graphWaits`), throws: 502, the error on `last-run`, no row
  marked missing. On the hour the driver's waits stop at the hour's settling
  time (`graphBudget.until`, set by `scheduled()` from the tick before the
  backup's first call on the library, drawn in to the lease's deadline once
  it is held, and cleared in one `finally` on every way out; the Retry-After
  honoured in full under it and capped at a minute without one): a wait that
  would run past it throws at once, and the hour's record is written before
  the sync so a cut-off invocation still leaves this hour's line. A budget
  more than fifteen minutes past - the platform's cut - is an hour the
  platform cut before its clearing ran, and counts for nothing
  (`STALE_BUDGET_MS`). The driver's failure sentence decodes the path only
  when there is a failure to say, so a path it cannot decode is still sent.
  The single-file folders under the home (`opms/spreadsheet`) are nobody's
  crew folder, whatever case the office spelt them in. The hold-back guard in `apply` (missing > max(25, 10%
  of the live rows the walk covered)) holds every mirror-off and is not a
  failure: `last-run.heldBack` carries the count, `error` stays null, and the
  SharePoint page's last-import line says it on its missing clause. Tests:
  `worker/tests/sync.test.ts`.

- **The Marine Orders are held against the matrix, and the law's mapping is
  data.** Eight orders were read in full from the Federal Register on 25 Sep
  2026 and six rules came out of them, each a pure shared file with its clause
  written beside every line:
  - **One certificate fills every column it covers** (`source/shared/covers.js`). A
    new-style AMSA ticket prints its endorsements on its face and a training
    statement prints its unit codes, so one document answers for more than one
    column. Which endorsement fills which column is the vessel file's `covers`
    table and never the model's guess: ECDIS to QL-13, dated as the
    certificate is dated because the endorsement never expires (MO70 s 37(3)
    item 8 - the office's "5 years" is wrong by law); fast rescue boats to
    QL-16, taking the endorsement's own printed end where AMSA printed one
    (s 37(3) item 2, s 37(5)). A unit code in a column's title fills that
    column with the document's own date. **GMDSS is never read off a
    certificate of competency** - it is a class of its own with its own term
    (s 7(1)(ca), s 21B), so "IV/2" printed on a ticket fills nothing. **QL-12
    is only ever filled by its own certificate**: the certificate of safety
    training cannot be endorsed onto another document (s 34(1)) and cannot be
    recognised from a foreign one (s 7(2)(b)). Matthew, 25 Sep 2026: "COST is
    only for small state certification. International certificates are
    certificates of competency."
  - **A recognition never outlives the certificate it recognises**
    (`source/shared/recognition.js`). A foreign ticket counts here only through
    AMSA's certificate of recognition (MO505 s 4, s 7(2)), so the recognition
    holds the cell and the cell opens it - but it is revalidated only after
    that one is (MO70 s 33(2)), endorsed only after it is (s 36(3)), its
    endorsement runs for the remainder of that one's (s 37(4)) and its term can
    never be extended (s 30 note). The cell takes the **earlier** of the two
    dates, and so does a column it covers. The vessel file's
    `neverRecognised` names the columns it can never fill at all (QL-11,
    QL-12: s 7(2)(b)).
  - **The medical issued last governs** (`source/shared/medical.js`). A medical
    expires the moment a further one is issued (MO76 s 16(3)), so of two on
    file the one issued last is in force even where the older prints the later
    expiry. Needs attention says where a printed expiry is longer than
    MO76 s 16(1) allows for the holder's age on the day of the examination -
    the bands are **18 or younger** and **55 or older**, so exactly 18 and
    exactly 55 are in the one-year band, and with no date of birth on Crew
    Details nothing is flagged. The limitation printed on a certificate shows
    on `CertViewer` and nowhere else.
  - **A red ticket that cannot be renewed says so** (`source/shared/renewals.js`).
    The pairs are the vessel file's `renewalNeeds`, each with its clause: the cook
    certificate on a certificate of safety training and a medical (MO70 s 25),
    a deck certificate on a medical and a GMDSS (MO71 Sch 4 4.2), an
    engineer's and a rating's on a medical (MO72 Sch 4 4.2; MO73 Sch 4,
    MO70 Sch 2 Table 2.4 item 3(b)), the near-coastal masters and Engineer
    Class 3 on a current medical (MO505 s 9(3)(b)). Master <24 m NC and MED
    Grade 2 NC are left out on purpose: s 9(3)(c) renews them on a
    declaration, which is not a document the portal holds, and neither is the
    120 days' sea service.
  - **Five papers lawfully carry a man while a certificate is out**
    (`source/shared/evidence.js`), each with its ceiling and its columns in the
    vessel file's `evidenceKinds`: an AMSA extension letter, up to six months and
    never a certificate of safety training nor a recognition (MO70 s 15(3)-(4),
    s 30 note); a near-coastal renewal lodged before expiry, 90 days past the
    printed expiry (MO505 s 7(3)); a temporary crewing permit, three months
    (MO504 s 16(2)); a final assessor's declaration, 60 days and only the lower
    near-coastal grades (MO505 ss 22-24); an issue letter, which IS the
    certificate until the card arrives and which the law gives no end
    (s 12(2)). Where the paper prints its own end that date governs; the
    ceiling only catches a longer one. The cell goes **amber**, never green:
    green would say the certificate is in date, and it has gone.
    **A paper is never the certificate**: it fills no cell, joins no contest
    for one and never stands as the foreign certificate behind a recognition -
    the certificate still expired on the day printed on it, and that is the day
    the matrix and the office's workbook say. The extension's six months run
    from the certificate's own printed expiry, because s 15(3)-(4) extends "the
    term of a certificate" - so a letter with no certificate on the portal
    behind it covers nothing. A renewal lodged **after** the card expired
    carries nothing (s 7(3): "before it expires"). And a paper is spent once
    the certificate it was written about is in hand: a card issued on or after
    the paper takes it off the books, which is what stops an issue letter, the
    one paper with no end, carrying a column for ever.
  - **A covered column runs no longer than the certificate carrying it.** An
    endorsement exists only as a line on a certificate that has to be in force
    to carry it (MO70 s 36(2)(a)), so QL-16 takes the **earlier** of the
    endorsement's own printed end and the certificate's expiry, and only the
    certificate in force for its own column covers another - a ticket the round
    decided was superseded is the one it replaced. A column that carries no
    expiry is never covered: it is held or it isn't. The round and the page's
    cells (`compareMatrix` in `worker/src/routes/analyse.ts`,
    `certificateStanding` in `worker/src/lib/analysis.ts`) decide every cell the
    same way, on the same dates, keyed on the register's name and refusing a
    document printed in another man's name (`nameIsSomebodyElse` in
    `source/shared/names.js`) - two answers for one cell is a bug, not a
    difference of opinion.
  - **The expiry day itself is the day a certificate stops counting**
    (`hasExpired` in `source/shared/bands.js`, MO70 s 5(a)(iii)). `daysUntil` is a
    plain day count and answers 0 on that day; everything that decides whether
    somebody holds something reads the rule, not the count.

  A green cell means "not expired" and nothing more: suspension and
  cancellation are invisible on a document and only AMSA can confirm them
  (MO70 s 5(a), s 45; MO505 s 17). Never word anything as "valid".

  **The figures the orders turn on are data** (`vesselFacts` in the vessel file,
  checked by both `checkVessel`s): 160 m, 10,000 GT, 3730 kW - Matthew's own
  figures, 25 Sep 2026. MO504 Sch 1 cl 8(2) counts the minimum crew by length
  and its note * makes the master and the engineer two people at 750 kW,
  MO504 s 16(3) holds the master's role at 24 m, MO71 Sch 1 reads a master's
  ticket against gross tonnage and MO505 s 5 an engineer's against propulsion
  power. The portal works no crewing number out from them - MO504's table stops
  at 80 m and MO505 Sch 1 at 100 m and 3000 GT, and which hull the figures
  describe is Matthew's to say; a table in the vessel file cites them so its
  premise can be checked against the order.

  **The office's own spreadsheet is wrong by law in five places** (Part 7 of
  the report): QL-13 ECDIS is not "5 years" but perpetual; a plain Chief Mate
  meets Master <24 m NC only, not QL-03 or QL-04; the list has an engineer
  certificate meeting Master <24 m NC and a Master meeting MED Grade 2 NC,
  which no order allows; the QL-17 age bands read "under 18/over 55" and the
  law's are "18 and under / 55 and over"; and a GPH working under general
  supervision must hold General Purpose Hand NC or an STCW rating certificate,
  which the sheet does not ask. Those are **Matthew's to raise with the
  office** - the portal never corrects the office's sheet quietly. Tests:
  `worker/tests/rules.test.ts`, `worker/tests/round.test.ts`,
  `tools/client-rules.test.mjs`. Preview flags: `?recognition=1`,
  `?medical=long`, `?blocked=1`, `?covered=1`.

## Working in parallel

Several sessions can work different areas at once. Before starting, `git pull`;
when finished, run the checks, commit, deploy and push. Two sessions editing
`source/index.html` will still collide — that part is shared.

`portal.html.src.md5` is the one built file that is tracked: it is the stamp
the server checks `portal.html` against, and the build rewrites it. Commit it
with a change; never edit it.
