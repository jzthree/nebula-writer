# Running Nebula Writer on Cloudflare (free tier) — design

Goal: share a live Writer session with a small team over the internet without
running `dev:share` on a LAN/VPN, staying within the Cloudflare free tier.

## Verdict: feasible, with one architectural split

Everything except AI execution maps cleanly onto Cloudflare's free tier. The
CLI providers (Codex CLI / Claude Code) are local processes by design and can
never run on Workers — so the cloud deployment is a **sync + metadata host**,
and AI execution stays on a team member's machine via an outbound bridge.

```
┌──────────────┐   wss (Yjs)    ┌──────────────────────────────┐
│ Teammate A   │ ─────────────▶ │  Cloudflare Worker            │
│ (browser)    │   /api (REST)  │   · static front-end assets   │
└──────────────┘                │   · Durable Object "room"     │
┌──────────────┐                │     - y-websocket protocol    │
│ Teammate B   │ ─────────────▶ │     - session JSON (sugg.,    │
│ (browser)    │                │       chat, revision, auth)   │
└──────────────┘                └──────────────▲───────────────┘
                                               │ outbound wss
                                  ┌────────────┴────────────┐
                                  │ AI runner bridge        │
                                  │ (local sidecar on any   │
                                  │  teammate's machine     │
                                  │  with codex/claude CLI) │
                                  └─────────────────────────┘
```

## How each piece maps to the free tier

| Piece | Cloudflare home | Free-tier fit |
| --- | --- | --- |
| Front-end (vite build) | Workers static assets / Pages | Static asset requests are **free and unlimited**; only Worker invocations count. |
| Yjs document sync | One **Durable Object** per session room (SQLite-backed; available on the free plan) using the WebSocket Hibernation API | WebSocket messages bill at a 20:1 ratio toward the 100k requests/day budget. Heavy all-day co-editing by a small team is a few thousand coalesced Yjs updates/hour → comfortably inside limits. |
| Session metadata (suggestions, chat, revision, decisions) | Same Durable Object, rows in its SQLite storage | Free plan: 5 GB total DO storage, 1 GB per object — session JSON is kilobytes. |
| Share auth | Token hash stored in the DO; same `#share=` capability-URL flow | Bonus: `workers.dev` gives HTTPS for free, removing the plain-HTTP caveat of LAN sharing. |
| DOCX import/export | **Move into the browser.** mammoth/jszip/docx are browser-capable; doing the conversion client-side sidesteps Worker bundle-size and CPU limits entirely. EMF preview (needs a local converter binary) degrades to the placeholder path. | No server cost at all. |
| AI (codex/claude CLI) | **Cannot run on Workers.** | See bridge below. |

## The AI runner bridge

Keep the local-first AI model: any teammate with the CLIs installed runs the
existing sidecar in *bridge mode*:

1. Sidecar starts with `WRITER_CLOUD_URL=wss://<worker>/bridge` + share token.
2. It opens an **outbound** WebSocket to the Durable Object and registers as
   the session's AI runner (no inbound ports, no tunnel needed — works behind
   any NAT).
3. `writer_propose_changes` / browser AI requests enqueue a job in the DO; the
   DO forwards it to the connected runner; the runner executes the CLI locally
   and streams progress + suggestions back; the DO broadcasts to everyone.

If nobody's runner is online, the UI says so ("AI is offline — ask Jian to
start the bridge") instead of failing opaquely. Optionally, a second mode can
call the Anthropic API directly from the Worker for teams that prefer
API-key-based AI over local CLIs — but that departs from the local-first
default and is out of scope for v1.

## What porting requires (rough scope)

1. **DO room class** speaking the y-websocket protocol with hibernation
   (existing open-source implementations of y-websocket-on-DO can be adapted)
   plus the `/events` broadcast and the session REST endpoints (suggestion CAS,
   chat append, share-info) — the Express handlers are mostly pure JS and port
   directly.
2. **Client transport flag**: when served from the cloud origin, the app uses
   browser-side DOCX import/export and skips sidecar-only features (autosave
   listing, tmp artifacts).
3. **Bridge mode** in the sidecar (outbound WS + job loop) and a `wrangler`
   project with bindings.

Estimated as a focused multi-day project; nothing in the current architecture
blocks it — today's split (CRDT doc + revisioned session metadata + capability
auth) was chosen so this port stays mechanical.

## Free-tier budget sanity check (team of ~5)

- Editing all day: Yjs coalesces keystrokes; ≈2–5k WS messages/hour/user peak
  → ≈ 250–600 billed request-equivalents/hour → **well under** 100k/day.
- Suggestion/chat REST traffic: hundreds/day. Negligible.
- Storage: session JSON + Yjs update log ≪ 1 GB.
- The one real ceiling: if the team grows or usage spikes past 100k req/day,
  the Workers paid plan ($5/mo) removes the daily cap.
