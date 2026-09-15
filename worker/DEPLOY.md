# Putting the portal live on Cloudflare

The whole portal — page, engine, stores — runs as one Cloudflare Worker from
this folder, on the free tier. This is the runbook, in order. Steps 1 and 2
are yours (they need accounts in your name); the rest can be driven from this
machine once they're done.

## 1. Accounts you need (one-time)

- **Cloudflare** — free plan: https://dash.cloudflare.com/sign-up
- **Anthropic API key** — for the AI readings (certificate reading, checkers):
  https://console.anthropic.com → API keys. This is the one running cost, and
  it's per-use.
- **SharePoint app registration** — from the IT provider: Application
  (client) ID, Directory (tenant) ID, client secret, with Sites.Selected
  write access granted on the **United Operations Team's site**
  (unitedmarineau.sharepoint.com/sites/UnitedOperationsTeam — verify the
  exact address via Teams > Shared files > "..." > Open in SharePoint). The
  portal files everything under its own "Crew Portal" folder in that
  library, beside the folders the team already uses. Not needed for go-live
  — the portal starts on Cloudflare's own file storage (R2) and flips to
  SharePoint when these arrive.

## 2. Sign wrangler in

```bash
cd worker
npx wrangler login
```

## 3. Create the stores, wire the ids

```bash
npx wrangler d1 create portal          # paste the returned id into wrangler.toml (database_id)
npx wrangler r2 bucket create portal-files
npm run db:remote                      # creates the tables
```

## 4. Secrets

```bash
npx wrangler secret put ANTHROPIC_API_KEY     # paste the Anthropic key when asked
# later, when IT delivers (also set MS_TENANT_ID / MS_CLIENT_ID in wrangler.toml [vars]):
npx wrangler secret put MS_CLIENT_SECRET
```

## 5. Deploy

```bash
npm run deploy
```

This compiles the page from ../source/index.html into assets/ and publishes.
The worker's address (something.workers.dev) is printed at the end — that's
the portal's new home, and what the SharePoint site's Crew Portal link should
point at.

## 6. Move the data in

The archive in this folder's parent is the complete portal as it stood on the
previous host (state rev 342 + 1,421 files). A remote seed mirrors the local one:
the document rows go in through D1, the state through /api/state, the bytes
through the portal's upload path. Ask Claude to run the migration against the
deployed address — scripts/seed-local.mjs is the local half and the model for
it.

## 7. Flip files to SharePoint (when IT delivers)

Set in wrangler.toml [vars]: MS_TENANT_ID, MS_CLIENT_ID, FILE_STORE =
"sharepoint", and check SHAREPOINT_SITE_PATH against the Team's real address
(Teams > Shared files > "..." > Open in SharePoint). Put the secret in
(step 4), `npm run deploy`, and the portal reads and files everything in the
Team's own folders from then on. The R2 copy stays as it was — a free spare.

The portal lives in the folders the team already uses — SHAREPOINT_MAP in
wrangler.toml marries its filing to them: certificates in Crew Certificate
Verifications (one folder per crew member), the matrices in Matrix, the OPMS
sheets in OPMS Documents, the shift sheet in Crew Roster. Anything unmapped
(removed copies, working uploads) sits under the portal's own Crew Portal
folder.

**Taking the folders' contents onto the books:** GET /api/sync surveys those
folders — what's there that the portal doesn't know (files people dropped in
from Teams), and what the portal knows whose bytes have gone (something
moved or renamed by hand). POST /api/sync applies it: new certificates are
registered under the folder they sit in (the AI reading pass later confirms
whose they are and refiles any strays), and a matrix or sheet is adopted
only when the portal holds none and there is exactly one candidate. Run it
after the flip to take on everything already sitting in the folders, and
again after any hand tidy-up.

## Day-to-day dev

```bash
npm run dev              # the whole portal at http://localhost:8788
node scripts/seed-local.mjs --bytes matrices,opms   # local data from the archive
```

Local settings (the file store to use, the SharePoint secret, the AI key)
go in `.dev.vars` — copy `.dev.vars.example` and fill it in. Never committed.
Setting up a fresh device end to end: `../SETUP.md`.

## What's different from the earlier build (for whoever reads the code)

- The earlier serverless build was retired from the repo (git history holds
  it); this folder is the port. Libraries carried over nearly verbatim.
- Blob stores became one strongly consistent D1 table (src/compat/blobs.ts).
- db.transaction became D1's atomic batch (routes/files.ts).
- Background functions became /api/run/:kind, started by the browser itself —
  the startPath fallback the page has always had — and held open while the
  run works (routes/run.ts).
- File bytes live behind src/files/store.ts: R2 today, SharePoint via
  Microsoft Graph when FILE_STORE says so.
