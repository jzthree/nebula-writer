---
name: verify
description: Build, launch, and drive Nebula Writer to verify a change end-to-end (vite + sidecar + Playwright).
---

# Verifying Nebula Writer changes

## Launch

- Web + sidecar together: `npm run dev:all` (vite on 5173 proxying `/api`, `/collab`, `/events` to the sidecar on 8787).
- Separately: `npm run dev` (vite) and `npm run sidecar` (Express sidecar, `server/index.ts` via tsx).
- Simulate "CLI not installed": `WRITER_CODEX_PATH=/nonexistent/codex WRITER_CLAUDE_PATH=/nonexistent/claude npm run sidecar` (an override that isn't executable reports `available: false`).
- Simulate "CLI locked": `npm run sidecar:locked` (`WRITER_ALLOW_CLI=0`).
- Cloud worker: `cd cloudflare && npx wrangler dev` (needs `npm run build` first for dist assets).

## Drive

- No Playwright in the repo; install it in the scratchpad (`npm i playwright`) and reuse the ms-playwright browser cache. If the cached Chromium revision mismatches, `npx playwright install chromium-headless-shell` (~95 MB).
- App URL: `http://127.0.0.1:5173/`. Useful hooks: dialog `role=dialog name="Set up AI for this Writer"`, `getByLabel("AI instruction")` (chat textarea), `getByLabelText("AI provider")` (select), `.warning-pill`, `.local-ai-hint`.
- The app re-probes `/api/health` every 20 s while AI is blocked, and instantly on `window.dispatchEvent(new Event("focus"))` — use that to test live recovery without waiting.
- Guide dismissal is remembered in `sessionStorage["nebula-writer-ai-setup-dismissed"]`; use a fresh browser context per scenario.

## Gotchas

- `lsof -ti :8787` also matches vite's proxied client sockets — killing those PIDs kills vite too. Use `lsof -ti TCP:8787 -sTCP:LISTEN`.
- `server/app.ts` contains a byte that makes grep treat it as binary; use `grep -a`.
- The sidecar re-resolves CLIs on every `/api/health` request — no restart needed after installing a CLI.
- `/api/health` shape differs by origin: sidecar reports real per-provider status; the Cloudflare worker reports `cloud: true` and `available: <bridge connected>` for both providers.
