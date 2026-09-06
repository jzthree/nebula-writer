# Terminal-driven Writer — implementation plan

**Decision (owner, 2026-07-09):** Replace Writer's hand-rolled AI chat + agentic
engine with a **local terminal running real `claude`/`codex`** that drives the
document through Writer's MCP server. The app is local-first; the cloud syncs
collaborators only. This activates the deferred v2 of the agent-gateway RFC
(the `session` PTY primitive + ATTACH plane).

## Locked decisions
- **Edit model:** the CLI **stages tracked suggestions** into the existing
  review queue (accept/reject) — reuse today's suggestion + collab machinery.
- **Chat panel:** **replaced** by the terminal; retire `runAgentTurn` + the
  chat agentic path.
- **Scope:** **full cloud + collab** — the ATTACH plane (loopback TCP + per-
  session capability token + Origin/Host checks) from the start, so a
  writer.zhoulab.io user gets a personal terminal reaching their own local CLI.

## Why this fixes the pain
The custom chat path's stalls / resume-slowness / error-surfacing are all
symptoms of re-implementing what the CLI already does well. A real terminal
hands conversation, streaming, resume, and error reporting back to the CLI
itself. We keep only what's genuinely ours: the MCP tools that read the live
document and stage suggestions.

## SECURITY PIVOT (owner, 2026-07-09): hop, not a home-rolled ATTACH plane

The owner's requirement: browser→local-terminal access must sit behind a
**well-established** security method, not our own token/Origin/Host checks —
"we can never expect all our code to be bulletproof." The answer is **hop**
(~/Code/hop2): hay (PTY core, auth/tunneling are explicit non-goals) + hop's
security layer — **Cloudflare Tunnel (outbound cloudflared, NO inbound local
port a malicious website could reach), password + TOTP 2FA (one-time setup,
persistent cookie), httpOnly/secure/sameSite cookies, end-to-end TLS.** The
home-rolled ATTACH plane from the gateway RFC v2 is **dropped**; the gateway
keeps only /exec (v1, shipped). Bonus: no localhost access from the page at
all — no Chrome Local-Network-Access prompt, no CORS/PNA.

We use hop's runtime, not its full product UI: Writer's sidecar (trusted local
process) creates one terminal session via hop's local API (bearer token from
~/.hop2/.tunnel-state); the user reaches it through hop's authenticated web
terminal. Modifying the hop repo for reusability is allowed (owner).

## Architecture (as proven)
```
 Browser ── writer.zhoulab.io (doc + collab via cloud DO — sync only)
    └── hop web terminal (https://hop.zhoulab.io, Cloudflare tunnel + 2FA)
             │ outbound cloudflared — no inbound port
             ▼
        hop daemon ── hay PTY: scripts/writer-agent-terminal.sh claude
             │  interactive claude REPL, --mcp-config → Writer MCP
             ▼
        Writer MCP (agent-mcp.ts, WRITER_AGENT_RUN_URL=…/api/agent-run/live)
             ▼
        sidecar "live" agent run → active session review queue → collab sync
```

## Proven end-to-end (2026-07-09, backend-first as required)
1. **One-shot proof:** real `claude -p` + live MCP config → read active doc →
   staged "Tighten Broader Impacts sentence" into the live review queue (21s).
2. **Interactive proof:** hop API created a terminal running
   `scripts/writer-agent-terminal.sh claude`; claude's REPL came up with the
   writer tools; a request typed into the terminal (hop write API) staged
   "Specify the further experiments" into the live queue in 20s.

## LOCAL-FIRST PIVOT (owner, 2026-07-10)

Writer becomes a **local app**; writer.zhoulab.io is a **sync service** between
users. This dissolves (not works around) the cross-origin problems:

- The sidecar serves the built web bundle → `http://localhost:8787` IS a full
  local Writer, **same origin as AI and the terminal**. No CORS, no
  Private-Network-Access, no Chrome local-network prompt. ✅ done + verified:
  a plain browser at localhost:8787 runs AI same-origin with zero prompts.
- `/api/health` reports `local:true` → the same bundle is context-aware
  (`localMode`): full local mode vs cloud sync/fallback. ✅ done.
- **Security boundary is now clean:** cloud DO = content sync only (Yjs, no
  code execution); local = everything that runs code (AI, terminal).
- **hop/tunnel is now OPTIONAL** — needed only to reach your OWN local Writer
  from another device. Local use = plain localhost, no tunnel/2FA.

### Inline terminal (remaining) — two paths
The terminal must be same-origin with the app.
- **(A) Sidecar owns the PTY** [recommended, cleanest local-first]: vendor
  hay's pty/rooms into the sidecar; serve the terminal at
  `localhost:8787/agent-terminal` (same-origin), embed xterm inline. hop
  needed only for remote. Local use needs no hop at all.
- **(B) Sidecar reverse-proxies hop's terminal** at `/agent-terminal` (inject
  the hop token server-side, proxy HTTP+WS). Reuses the proven hop terminal;
  fiddly proxy/URL-rewrite; keeps hop as a hard dep even locally.

## Build slices (original, still valid)
1. ✅ **Live-doc agent run** (`/api/agent-run/live/*`): reads follow the active
   session's current text; staging lands in the live review queue with
   revision bump + broadcast + persist. `scripts/writer-agent-terminal.sh`
   launches claude/codex with the live MCP config.
2. ✅ **CLI-first backend proof** — one-shot and interactive-in-hop-terminal
   (see above).
3. **Writer UI integration:** "Open agent terminal" in Writer — sidecar
   ensures the hop session exists (hop API), UI links/embeds hop's web
   terminal for it (hop tunnel URL, behind 2FA). Onboarding covers the
   one-time hop setup (cloudflared + TOTP QR) — the explicit "user is aware
   before they hook it up" moment.
4. **Retire** the chat panel + `runAgentTurn` agentic engine once the terminal
   covers them.
5. Fix PDF attachment text extraction (returns raw bytes today) — terminal
   CLI can read files directly, so lower priority.

## Per-user setup (domain-less collaborators)
A collaborator does NOT need a domain. hop uses a **Cloudflare quick tunnel**
automatically when no domain is configured (`useNamedTunnel` false →
`cloudflared tunnel --url` → random `https://<id>.trycloudflare.com`). Writer
reads whatever URL hop reports from `~/.hop2/.tunnel-state`, so the Terminal
button works with a quick tunnel unchanged. One dependency: `cloudflared`.
`scripts/setup-agent-terminal.sh` is the one-shot installer: ensure cloudflared
→ start hop (quick tunnel) → show the one-time 2FA QR → verify sidecar↔hop.
Tradeoffs: quick-tunnel URL rotates on restart (Writer re-reads each click, so
it self-heals; an already-open tab on an old URL breaks) and trycloudflare has
no SLA — a named tunnel/domain is the optional upgrade for a stable URL.

## Open items
- Embedding hop's web terminal in Writer (iframe vs new-tab link) — iframe
  needs hop cookie/frame headers to allow it; new-tab works today. Possible
  hop-repo tweak (owner approved modifying hop).
- Per-doc session naming (`writer-<docid>`) + reattach semantics.
- hop distribution for collaborators (npm publish / installer) so the setup
  script doesn't assume a local hop checkout.
