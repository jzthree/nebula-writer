# Deploying Nebula Writer to writer.zhoulab.io

The cloud deployment serves the front-end from Cloudflare's edge and runs one
Durable Object per document (Yjs room + session metadata + events). AI runs
through a **bridge**: your local Writer dials out to the cloud and volunteers
as the team's AI runner, so no inbound ports and no CLI on the edge.

Everything below the "one-time dashboard setup" section is already in the repo
and verified locally with `wrangler dev`.

## One-time dashboard setup (private repo → auto deploys)

Private repos are fully supported — Cloudflare installs a GitHub App and you
grant it access to just this repo.

1. **Cloudflare dashboard → Workers & Pages → Create → Workers → Import a
   repository → Connect GitHub.** GitHub will prompt to install the
   "Cloudflare Workers & Pages" app: choose **Only select repositories** and
   pick `jzthree/nebula-writer`. (Org/private repos both work; you can revisit
   at GitHub → Settings → Applications to adjust.)
2. Select the repo. Configure the build:
   - **Project name**: `nebula-writer`
   - **Build command** (one line, no commas):

     ```
     npm ci && npm run build:cloudflare
     ```

   - **Deploy command**:

     ```
     cd cloudflare && npx wrangler deploy
     ```
   - **Root directory**: `/` (the wrangler config lives in `cloudflare/`,
     reached by the deploy command)
3. Deploy once, then add the domain: **the Worker → Settings → Domains &
   Routes → Add → Custom domain → `writer.zhoulab.io`.** Because zhoulab.io's
   DNS zone is on your Cloudflare account, Cloudflare creates the record and
   certificate automatically.
4. Set secrets under **the Worker → Settings → Variables and Secrets**:
   - `SHARE_TOKEN` — access token collaborators present via `#share=` links.
     Generate one: `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`
     (Skip it and the site is open to anyone who finds the URL — set it.)
   - `BRIDGE_TOKEN` — separate token for the AI bridge (defaults to
     SHARE_TOKEN if unset).

Every push to `main` now builds and deploys automatically.

### CLI alternative (no GitHub integration)

```bash
npx wrangler login                 # one-time browser OAuth
npm run build                      # repo root: builds dist/
cd cloudflare && npm ci
npx wrangler deploy
npx wrangler secret put SHARE_TOKEN
npx wrangler secret put BRIDGE_TOKEN
```

## Daily use

- **Share a document**: open `https://writer.zhoulab.io/#share=<SHARE_TOKEN>`,
  type or paste a draft, click Share → "Start sharing this draft", and send
  the link from the Share menu (it carries both the token and the `#doc=` id).
- **Provide AI to the team** (run on any machine with Codex/Claude CLIs):

  ```bash
  WRITER_CLOUD_URL=wss://writer.zhoulab.io \
  WRITER_CLOUD_TOKEN=<BRIDGE_TOKEN> \
  npm run sidecar
  ```

  While that's running, the cloud UI's providers light up and every
  collaborator can send AI requests; progress ("Codex is drafting suggestions
  for Kathy — pass 2 of 8") streams to all tabs. Stop it and the UI degrades
  gracefully to "AI offline".

## Per-user AI: collaborators use their own Claude Code / Codex

Instead of (or in addition to) the shared bridge, each collaborator can run AI
on **their own machine and their own CLI account**. On the machine where they
have the Codex/Claude CLI installed:

```bash
git clone <this repo> && npm ci
WRITER_ALLOWED_ORIGINS=https://writer.zhoulab.io npm run sidecar
```

Their browser tab at writer.zhoulab.io probes `http://127.0.0.1:8787` every
20 s; when their sidecar is up, the provider pill shows "CLI ready — your
local Writer" and their AI requests run locally on their account. Results
still record into the shared cloud session, so everyone sees the proposals.
Stop the sidecar and that tab falls back to the shared bridge (if connected)
or "AI offline".

Precedence per user: own local sidecar → shared bridge → offline.

Notes:
- `WRITER_ALLOWED_ORIGINS` is required — the sidecar refuses cross-origin
  browser calls unless the cloud origin is explicitly allowed (never use a
  wildcard; an open-CORS loopback server would let any website drive the
  machine's CLIs).
- Chrome/Edge/Firefox allow HTTPS pages to call `http://127.0.0.1` (loopback
  is exempt from mixed-content blocking). Safari blocks it — Safari users
  should switch browser for AI (collaboration itself works everywhere), or
  use the team bridge if one is connected.
- Live progress for personal runs shows in that user's tab; other tabs see the
  proposals when they land (shared-bridge runs broadcast progress to everyone).

## What's different from the local Writer (v1 scope)

- **DOCX import works through your local Writer.** Drag a DOCX into the
  cloud editor (or use Import) and the file is converted by your own
  machine's sidecar — the same one the AI setup starts — then shared as a
  cloud document with full metadata (features, anchors, tracked-change
  previews). Without a local Writer running, the setup guide opens instead.
- **DOCX export and autosave snapshots stay local.** Tracked-changes export
  uses the local sidecar's Word tooling; export from your local Writer.
- Document text, presence/cursors, AI proposals, accept/reject with
  attribution and conflict detection, chat, and live AI progress all work in
  the cloud, backed by Durable Object storage (free tier: 5 GB SQLite, ~100k
  requests/day — plenty for a small team).

## Smoke-tested locally

`wrangler dev` exercised: health/bridge status, session create/read,
record-suggestions dedupe, suggestion-status CAS (409 with decidedBy),
chat-append dedupe, two-client Yjs sync + presence through the DO, live-text
extraction into `documentText`, bridge job round trip with progress + events
broadcasts, SPA asset serving.
