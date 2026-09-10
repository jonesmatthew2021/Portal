# Putting the portal live on Cloudflare

The whole portal — page, engine, stores — runs as one Cloudflare Worker from
this folder, on the free tier. This is the runbook, in order. Steps 1 and 2
are yours (they need accounts in your name); the rest can be driven from this
machine once they're done.

## 1. Accounts you need (one-time)

- **Cloudflare** — free plan: https://dash.cloudflare.com/sign-up
- **Anthropic API key** — for the AI readings (certificate reading, checkers):
  https://console.anthropic.com → API keys. This is the one running cost, and
  it's per-use, the same bill Netlify's AI gateway was passing through.
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

The archive in this folder's parent is the complete portal as it stood on
Netlify (state rev 342 + 1,421 files). A remote seed mirrors the local one:
the document rows go in through D1, the state through /api/state, the bytes
through the portal's upload path. Ask Claude to run the migration against the
deployed address — scripts/seed-local.mjs is the local half and the model for
it.

## 7. Flip files to SharePoint (when IT delivers)

Set in wrangler.toml [vars]: MS_TENANT_ID, MS_CLIENT_ID, FILE_STORE =
"sharepoint", and make sure SHAREPOINT_LIBRARY names the document library the
certificates live in. Put the secret in (step 4), `npm run deploy`, and the
portal reads and files everything in the Coolibah site from then on. The R2
copy stays as it was — a free spare.

## Day-to-day dev

```bash
npm run dev              # the whole portal at http://localhost:8788
node scripts/seed-local.mjs --bytes matrices,opms   # local data from the archive
```

## What's different from the Netlify build (for whoever reads the code)

- source/netlify/* stays in the repo untouched as the reference; this folder
  is the port. Libraries carried over nearly verbatim.
- Blob stores became one strongly consistent D1 table (src/compat/blobs.ts).
- db.transaction became D1's atomic batch (routes/files.ts).
- Background functions became /api/run/:kind, started by the browser itself —
  the startPath fallback the page has always had — and held open while the
  run works (routes/run.ts).
- File bytes live behind src/files/store.ts: R2 today, SharePoint via
  Microsoft Graph when FILE_STORE says so.
