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
| `required-documents.jsx` | Required Documents For Upload |
| `certification-checker.jsx` | Certification Checker |
| `elearning-status.jsx` | E-Learning Status |
| `opms-checker.jsx` | OPMS Checker |
| `portways-documentation.jsx` | Portways Documentation |
| `ai-checker.jsx` | AI Checker |
| `sharepoint.jsx` | SharePoint |
| `access-grants.jsx` | Access Grants |

An area file carries no import or export — by the time it runs it is the same
one file it always was, so it can use `T`, `usePortal()` and every shared
component directly.

To add an area: drop a `.jsx` file in `source/areas/`. The build picks it up by
filename order and a check confirms it arrived.

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
- **The last 200 saves are kept** (`portal_state_history`) and any one of them
  can be put back from `Admin → Access Grants`, under Revisions.

## Working in parallel

Several sessions can work different areas at once. Before starting, `git pull`;
when finished, run the checks, commit, deploy and push. Two sessions editing
`source/index.html` will still collide — that part is shared.
