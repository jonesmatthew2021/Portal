# Working on the portal from another device

Everything lives in two private GitHub repos. Clone them **side by side** in
one folder, because the FIT TO SAIL launcher and the `crewcomp-web` preview
look for the attest repo next door:

```
somewhere/
  portal build/   ← github.com/jonesmatthew2021/Portal   (this repo)
  attest/         ← github.com/cdjones32/attest, branch matthews-work
```

```bash
git clone git@github.com:jonesmatthew2021/Portal.git "portal build"
git clone -b matthews-work git@github.com:cdjones32/attest.git attest
```

The Portal clone is large (it carries every crew certificate under
`documents/`). If the connection drops mid-clone, run it again — git resumes.
SSH to GitHub goes over port 443 on the vessel's connection; see the note at
the end.

## 1. Install once

- **Node.js 22 or newer** — https://nodejs.org (the preview compiler, the
  worker, and Chris's web app all run on it).
- Then, in this folder:

```bash
npm install --prefix tools
npm install --prefix worker
cd worker
npx wrangler login
cd ..
```

`wrangler login` opens a browser: sign in to the Cloudflare account
(jonesmatthew2021@gmail.com). That is what lets this device deploy the live
portal and talk to its database.

- For the FIT TO SAIL preview only: **Java 21** (Microsoft build:
  https://learn.microsoft.com/java/openjdk/download) and **PostgreSQL 16**
  with superuser password `postgres`, plus `npm install` inside
  `attest/admin-web`. Skip this if you only work on the portal.

## 2. The previews

Open this folder in Claude Code and ask for the preview by name, or start it
from `.claude/launch.json`:

| Preview | What it is | Address |
|---|---|---|
| `portal-preview` | The page on its own with a built-in snapshot of the data (rev 342). Fastest way to see a front-end change. Reloads itself when `preview.html` changes. | http://localhost:8787 |
| `portal-worker` | The **whole** portal, backend included, running locally on wrangler — sign-in, uploads, checkers, SharePoint if you give it the secret. | http://localhost:8788 |
| `crewcomp-web` | Chris's FIT TO SAIL web app (needs its backend running — double-click **Start FIT TO SAIL preview.bat**). | http://localhost:5173 |

Nothing in the previews touches the live portal.

### Local settings for `portal-worker`

Copy `worker/.dev.vars.example` to `worker/.dev.vars` and fill in what you
have. That file is never committed. Without it the local worker still runs,
on local file storage and with the AI features saying they aren't configured.

To give the **local** worker SharePoint access, set `FILE_STORE=sharepoint`
and paste the app secret from Atcom's app registration into
`MS_CLIENT_SECRET`. Then it reads and files straight into the United
Operations Team library, exactly as the live portal does. The tenant id,
client id and site path are already in `worker/wrangler.toml`.

Local data for the worker comes from the archive in this folder:

```bash
npm run --prefix worker db:local
npm run --prefix worker seed
```

## 3. The live portal

https://coolibah-portal.com runs on Cloudflare and already has SharePoint
access and the AI key — those are stored as secrets on Cloudflare, not on
any device. Whatever device you deploy from, they stay in place:

```bash
npm run --prefix worker deploy
```

`worker/DEPLOY.md` has the full runbook.

## 4. Keeping the two devices in step

Work is saved by committing and pushing to GitHub, and the other device
picks it up with `git pull`. Ask Claude to commit and push at each milestone,
the way it does here. On the attest repo, stay on branch `matthews-work`.

The portal page is templated into the attest repo
(`vessel-portal/template/portal.html`). When `source/index.html` changes
materially, refresh the template by copying the file across — never edit
the template in place.

## If GitHub won't connect

Some connections (the vessel's, for one) block the normal SSH port. Put
this in `~/.ssh/config` on the new device and SSH goes over 443 instead:

```
Host github.com
  HostName ssh.github.com
  Port 443
  User git
```

If a push still resets partway through, push one commit at a time, oldest
first.
