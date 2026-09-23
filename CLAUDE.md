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
- **The round on the hour is the worker's.** `worker/src/lib/round.ts` puts
  the certificates' dates on the crew matrix and writes the office's CREW
  QUALIFICATION EXPIRY workbook by itself, every hour, with no browser open
  (`scheduled()` in `worker/src/index.ts`; the SharePoint page shows what it
  did). It saves the shared document against the revision it read
  (`lib/shared-state.ts`), replaces the workbook through
  `db/single-file.ts` whose order of work is fixed so the old copy is never
  lost, clears a date only on its second sighting as an orphan, and writes
  only the cells it changed plus blanks — a figure the office typed is left
  as typed. Removed copies are parked flat under `removed/` (no folder is
  ever made), and a file the office itself put in a folder is never moved:
  its row comes off the books with the bytes left where they are.
- **The last 200 saves are kept** (`portal_state_history`) and any one of them
  can be put back from `Admin → Access Grants`, under Revisions.

## Working in parallel

Several sessions can work different areas at once. Before starting, `git pull`;
when finished, run the checks, commit, deploy and push. Two sessions editing
`source/index.html` will still collide — that part is shared.

`portal.html.src.md5` is the one built file that is tracked: it is the stamp
the server checks `portal.html` against, and the build rewrites it. Commit it
with a change; never edit it.
