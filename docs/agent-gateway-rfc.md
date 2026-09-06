# RFC: nebula-agent-gateway — a shared local CLI-agent runner

- **Status:** **v3.1** — all reviews in, decisions locked. **Implementation descoped
  (owner, 2026-07-08): v1 ships the GATEWAY plane only ("gateway-lite") for writer +
  slides; the `session`/ATTACH surface is deferred to v2 with nebula.** See §12.
- **Authored from:** nebula-writer (reference implementation source)
- **Date:** 2026-07-06, revised 2026-07-07 (v2, v2.1, v2.2)
- **Implementer:** the nebula-writer agent, after incorporating your comments

### Changelog v2.1 → v2.2 (remote/cloud deployment)

- **New §7A — hosted-tool topology.** Answers "does a remote user need to install the
  whole tool?" No: only the shared gateway + a **thin per-tool connector**. Verified
  claude speaks remote HTTP MCP (tool's MCP tools live in the cloud) and writer already
  dials out to `<cloud>/bridge` (browser never touches local). Browser → cloud →
  outbound bridge → thin connector → gateway → local claude → cloud MCP. New owner
  decision **Q11**: gateway+connector (argv built from a local vetted template — cloud
  can't inject commands) vs gateway-only bridge mode (cloud sends raw argv).

### Changelog v1 → v2 (from slides-mcp review + owner security directive)

- **Security hardened + directive locked (§6):** the gateway is **local-process-only
  and never reachable by a web page** — no CORS, token required in an `Authorization`
  header (which makes any cross-origin browser attempt fail preflight), cross-site
  requests rejected, loopback bind. The v1 "CORS origin allowlist so browsers can call
  it" idea is **removed**. Browser-facing auth stays each tool's own concern. Also
  states plainly that the gateway is *not* a safety boundary for argv.
- **Added `bin` override to `/exec` (§4):** optional absolute binary path — unblocks
  slides' fake-CLI test harness and per-project pinning. Safe *because* of the
  local-process-only stance above.
- **Added spawn-environment / PATH story (§5):** the launchd daemon has a sparse env;
  the gateway now establishes a login-shell PATH for children so MCP grandchildren
  (`tsx`/`node`) resolve. This was flagged as the most likely production failure.
- **Resolved Q5 → per-tool `label`:** homes are namespaced `<home>/<label>/<provider>/`
  to avoid cross-tool codex session-id collisions and keep `--resume` correct.
- **Resolved Q6 → caller env wins:** gateway home fills only when the caller omits
  `CODEX_HOME`/`CLAUDE_CONFIG_DIR`.

### Changelog v2 → v2.1 (from slides-mcp re-review + sign-off)

slides gave sign-off on v2, contingent on nothing. The re-review surfaced one
security gap and three implementation-robustness notes, now landed:

- **§6 — DNS-rebinding / Host validation (the one pre-ship security add):** the
  fetch-metadata checks miss the classic rebinding attack (an `evil.com` page rebound
  to `127.0.0.1` looks same-origin to the browser, so `Sec-Fetch-Site: cross-site`
  never fires). Added: **validate the `Host` header is a loopback name** and reject
  otherwise. Moot under the unix socket — another reason it's the default.
- **§5 — `bin` + shebang + child-`PATH` must be wired in order:** slides' fake CLIs are
  `.mjs` with a `#!/usr/bin/env node` shebang, so exec-ing `bin` directly works only if
  the §5 child `PATH` is assembled *before* the spawn. Implementation ordering note added.
- **§5 — defensive `PATH` capture:** `$SHELL -lic` runs full interactive rc and some
  setups print to stdout during init (nvm/greetings); parse with a sentinel, not
  "whole stdout." Added.
- **§5 / Q9 — per-label symlink under concurrency:** within one `label` the auth
  symlink is (re)created per exec; safe for single-turn tools (slides), but
  autocomplete's burst under one label needs the symlink creation to be
  idempotent/atomic. Flagged toward autocomplete.
- **§9 — slides trajectory path moves** from `~/.slides-mcp/agent-home` to
  `~/.nebula-agent/slides/<provider>/` on migration (intent preserved: still global,
  still labeled). Called out so nobody's surprised the directory moved.

### Changelog v2.2 → v3 (nebula-notebook/autocomplete review + owner decisions)

The nebula-notebook agent (covering autocomplete **and** an agent-terminal feature)
reviewed v2.2. All three reviews are now in. Owner decisions:

- **One sidecar; the gateway becomes a stateful process-lifecycle manager.** Beyond
  `/exec`, it gains a **`session` primitive (§4A)** for long-lived processes: pty
  (reattachable terminal, scrollback) and stdio (warm process pool). This is a
  conscious scope increase — still generic + must-be-local, so it passes §2.
- **The "participant, not co-location" refinement (§2):** keep an interaction local
  unless the remote is genuinely one of its participants. Hosted writer routes through
  the cloud because the cloud owns the doc+MCP; autocomplete/terminal stay local
  because the cluster is a bystander (2× RTT/keystroke otherwise).
- **Q12 resolved → in-gateway ATTACH plane (§6/§7):** a *second, opt-in, browser-facing*
  plane (loopback TCP, per-session capability token + Origin allowlist + Host-loopback)
  that can **only attach to an already-created `session`** — never `/exec`, never spawn.
  Enables co-located browser↔local terminal/completions without routing through the
  cluster. Honestly: attaching to a PTY *is* arbitrary execution, so this is a scoped,
  gated relaxation of §6's "no browser ever," at the same risk profile as an
  authenticated web terminal.
- **`isolation:"ephemeral"` (§5):** fresh home per session, wiped on close — folds
  nebula's no-trace guarantee into the shared layer.
- **Per-plane / per-label concurrency budgets (§7):** so bursty completions don't
  head-of-line-block behind a long agentic run.

**Cross-round context ≠ warm process:** writer/slides get prior-round context from the
CLI's own `--resume <id>` (disk transcript in the §5 per-label home) over plain
`/exec` — no live process needed. The `session` primitive is for *latency* (warm pool)
and *reattach* (pty), not context. Writer/slides keep `/exec` + `--resume`; the warm
session is an optional latency upgrade they may adopt later.

---

## Status (v3): reviews complete, ready to implement

All three consumer reviews are in and every open question is resolved (§10). This
section is retained for provenance; **no further review is being solicited** — the
next step is implementation per the §12 rollout. The contract is `/exec` (§4) +
the `session` primitive (§4A); the two security planes are §6; hosted deployment is
§7A. Owner decisions (Q11–Q13) are recorded in §10.

---

## 1. Motivation

Three projects independently spawn the same local CLIs, and each has re-implemented
the same two things: **process spawning** and **provider auth-home isolation**.

| Project | Local server | AI shape | Auth-isolation code |
|---|---|---|---|
| nebula-writer | sidecar `:8787` | agentic (MCP loop, streamed) + codex one-shot | `server/cli-home.ts` |
| slides-mcp | editor-server `:4318` | agentic (MCP loop, streamed) | `agent-connector.ts` → `prepareProviderHome` |
| nebula-autocomplete | `src/server/` | fast one-shot (`codex exec --json`) | `backends/codex.ts` (`CODEX_HOME` w/ `auth.json`) |

The codex-`auth.json`-symlink / claude-keychain isolation logic now exists **three
times**, hand-rolled in each repo, with subtle drift (writer uses
`~/.nebula-writer/{claude,codex}`, slides uses `~/.slides-mcp/agent-home`,
autocomplete copies `auth.json` into an ad-hoc `CODEX_HOME`). The stream-parsing and
arg-building in writer and slides are near-identical (writer's was ported from
slides).

Beyond duplication, the operational cost is **N persistent local processes and N
launchd agents** to keep alive — when the real irreducible-local surface is small
and identical across all three.

## 2. Design principle

> **Put as little as possible in the gateway.** It handles only what *must* run on
> the user's machine and is identical across every tool. Everything project-specific
> stays in the project repo.

The test for "does this belong in the gateway?": **could it run anywhere but the
user's machine?** If yes, it's out.

By that test, almost everything is out — arg conventions, "agentic vs one-shot,"
models, MCP servers, prompts, stream parsing, session/ephemerality policy, domain
logic. What's left is genuinely local and generic:

1. **Provider discovery** — which CLIs exist on *this* machine (PATH, version).
2. **Process execution & lifecycle** — run a known provider binary with caller-supplied
   argv/stdin/env/cwd. Two shapes, both generic and both irreducibly local:
   *request-scoped* (`/exec`: spawn→stream→exit) and *long-lived* (`session`: a warm
   process pool or a reattachable pty — persistence exists **for** local
   latency/state, so it belongs).
3. **Auth-home isolation** — the one concern that is *about* being local (keychain,
   `~/.codex/auth.json`), and the thing triplicated today.

That's the whole gateway: `GET /providers`, `POST /exec`, the `session` primitive
(§4A), and an auth-home policy applied to every spawn.

### Refinement: participant, not co-location (from the nebula-notebook review)

A second test governs *where an interaction resolves*: **keep it local unless the
remote is genuinely one of its participants** — i.e. unless the data/coordination the
interaction needs lives there. Co-location alone isn't the test (in hosted writer the
browser and the local CLI are both on the laptop too).

- **Hosted writer turn** — the cloud owns the document, collab, run-context, and MCP
  tools; it *coordinates* the turn and the local CLI must reach cloud data to do
  anything. The cloud is a real participant → routing through it (§7A) is the shortest
  correct path, and a seconds-long turn amortizes the WAN hop.
- **Autocomplete / terminal** — the context (cell text, cursor) is *in the browser*;
  the cluster serves kernels/fs but isn't needed to produce a completion or run a local
  shell. The only participants are browser + local CLI → resolve locally. Routing
  through the cluster inserts a bystander and pays 2× the laptop↔cluster RTT
  *per keystroke*, on the one feature with a sub-300 ms budget.

This is why hosted writer uses §7A and co-located autocomplete/terminal use the §6
attach plane — one rule, two answers.

## 3. Architecture

```
   ┌─────────────────────────────────────────────────────────────┐
   │  nebula-agent-gateway  (one persistent daemon, generic)      │
   │                                                              │
   │  GET  /providers   → discovery + health (codex, claude)      │
   │  POST /exec        → spawn provider w/ caller argv, stream    │
   │  auth-home policy  → unified home, codex auth.json symlink,   │
   │                      claude via keychain / .credentials.json  │
   └───────▲───────────────────▲───────────────────▲──────────────┘
           │ /exec             │ /exec             │ /exec
   ┌───────┴──────┐   ┌────────┴───────┐   ┌───────┴──────────┐
   │ writer       │   │ slides-mcp     │   │ nebula-autocomplete│
   │ builds argv, │   │ builds argv,   │   │ builds one-shot    │
   │ runs its MCP │   │ runs its MCP   │   │ argv, reads result │
   │ server, parses│  │ server, parses │   │ (no MCP)           │
   └──────────────┘   └────────────────┘   └────────────────────┘
```

The gateway never knows what "agentic" means. A tool that needs an MCP server puts it
in its own argv (`--mcp-config …`); the gateway-spawned CLI launches that MCP server
itself as a child, and it reaches back to the tool's own context source via env the
tool supplied. The gateway stays ignorant of all of it.

## 4. The `/exec` contract

The heart of the RFC. Everything else is negotiable around this.

### Request

`POST /exec`

```jsonc
{
  "provider": "codex" | "claude",   // known provider: selects home-var + discovery (see /providers)
  "args": ["exec", "--json", "…"],   // full argv AFTER the binary; caller owns it entirely
  "bin": "/abs/path/to/fake-claude.mjs", // optional; overrides provider discovery. absolute path.
                                       // for test harnesses (fake CLI) + per-project binary pinning.
  "label": "slides",                  // optional; namespaces the isolation home (§5). default "default".
  "stdin": "…",                       // optional; string piped to stdin (writer sends the prompt here)
  "env": { "WRITER_AGENT_RUN_URL": "http://127.0.0.1:8787/api/agent-run/…" },
                                       // optional; merged over the child env (caller wins — see §5)
  "cwd": "/abs/path",                 // optional working dir; defaults to a gateway scratch dir
  "timeoutMs": 60000,                 // optional; SIGTERM at deadline, SIGKILL after a grace period
  "isolation": "shared" | "off"       // optional; see §5. default "shared"
}
```

The gateway resolves the binary (`bin` if given, else `provider` discovery), applies
the auth-home env for `provider`/`label`, merges the caller's `env` on top, and spawns
`binary + args` with `stdio: [stdin?, pipe, pipe]`. **It does not inspect or rewrite
`args`** — see §6 for why that is safe only because the gateway is local-process-only.

`bin` is an absolute path, exec'd directly (no shell). It grants no privilege beyond
what the caller — already a same-user local process holding the token — could do by
spawning it itself.

### Response — two modes, negotiated by `Accept`

**Streaming (default, `Accept: application/x-ndjson`)** — for agentic tools that
consume incremental output. Chunked HTTP body, one JSON frame per line:

```
{"t":"stdout","b64":"<base64 of a raw stdout chunk>"}
{"t":"stderr","b64":"<base64 of a raw stderr chunk>"}
{"t":"exit","code":0,"signal":null}
```

Base64 preserves exact bytes so a multibyte character split across chunk boundaries
is never corrupted; the caller concatenates and decodes. stdout and stderr stay on
separate frames so the caller can parse the JSONL protocol on stdout while surfacing
stderr diagnostics.

**Buffered (`Accept: application/json`)** — for one-shot tools (autocomplete) that
just want the result. Single response after the process exits:

```jsonc
{ "stdout": "…", "stderr": "…", "code": 0, "signal": null, "timedOut": false }
```

Same endpoint, same spawn path; only the response shaping differs. Autocomplete gets
zero stream-parsing; writer/slides get incremental frames.

### Cancellation

Closing the request connection cancels the run (SIGTERM → SIGKILL grace). This maps
directly onto every tool's existing `AbortSignal` wiring. (Open question in §10 on
whether an explicit `DELETE /exec/:id` is also wanted.)

### Errors

- Unknown/unavailable `provider` → `400` with `{ error, providerStatus }`.
- Spawn failure (binary vanished) → `502` (streaming: an `{"t":"error"}` frame then
  `exit`).
- The gateway **never** turns a nonzero CLI exit into an HTTP error — a provider that
  ran and exited 1 is a successful `/exec` with `code: 1`. Only gateway-level failures
  are HTTP errors.

## 4A. The `session` primitive (long-lived processes)

`/exec` is request-scoped and cannot express two needs that are irreducibly local:
**a warm process pool** (autocomplete keeps persistent `claude -p --input-format
stream-json` processes to dodge the ~2.3 s cold start — fresh-spawn-per-keystroke is
unusable) and **a reattachable pty** (an agent terminal that survives browser refresh
and replays scrollback). Same missing primitive, two flavors. The gateway provides the
generic lifecycle; the tool supplies the argv and the policy (recycle-after-N, etc.).

```
POST   /session            create-or-attach {provider, kind:"pty"|"stdio", bin?, label, args, env, cwd} → {id}
POST   /session/:id/turn   (stdio) one turn, stream frames; per-turn abort that does NOT kill the process
WS     /session/:id/attach (pty) reattachable I/O + resize; scrollback replay on attach
DELETE /session/:id        explicit kill (a dropped attach/turn must NOT kill the session)
GET    /sessions
```

- **stdio** = the warm-pool pattern generalized: a persistent process fed turns over
  stream-json; a **dropped connection or aborted turn must not kill the process**
  (unlike `/exec`), and autocomplete supersedes on every keystroke → per-turn abort
  within the live session.
- **pty** = a persistent terminal with an output ring (the vendored `hay` Room model);
  reattach replays scrollback; a dropped attach leaves the session running.
- Lifecycle is caller-owned via `DELETE`; the gateway reaps orphans (no attach + idle
  past a TTL) as a backstop.
- `bin` (§4) and the child-`PATH`/env rules (§5) apply identically.

**Not for cross-round context.** Conversational continuity across rounds is the CLI's
own `--resume <id>` (disk transcript in the §5 per-label home), which works over plain
`/exec`. `session` is for *latency* and *reattach*, not context — writer/slides keep
`/exec` + `--resume`; a warm stdio session is an optional latency upgrade.

## 5. Auth-home isolation & child environment

### Per-tool home namespacing (resolves Q5)

The gateway owns an agent-home tree (default `~/.nebula-agent`, override
`NEBULA_AGENT_HOME`), **namespaced per tool** via the request's `label`:
`<home>/<label>/<provider>/`. Per exec with `isolation: "shared"` (the default):

- **codex** — sets `CODEX_HOME=<home>/<label>/codex`; symlinks `auth.json` (and
  `config.toml` if present) from the user's real `~/.codex` so login is reused, not
  copied.
- **claude** — sets `CLAUDE_CONFIG_DIR=<home>/<label>/claude`; on macOS auth is the
  keychain (shared, nothing linked); on Linux, symlinks `.credentials.json` if present.

Namespacing (rather than one shared home) is deliberate, per slides' review: codex
session-ids in a shared `sessions/` dir can collide across tools, and `--resume` /
`exec resume` stay correct only against a stable per-tool home. It also preserves each
tool's identifiable trajectory location.

**Concurrency within one label (slides note → autocomplete):** the auth symlink is
(re)created per exec. For single-turn tools (slides' `activeRun` lock) this is safe.
Symlink creation is nonetheless made **idempotent/atomic** (create-if-absent, tolerate
`EEXIST`, or `symlink`-to-temp then `rename`) so it's safe under bursts. In practice
autocomplete sidesteps it: codex bursts run under `isolation:"off"` with a per-request
ephemeral `CODEX_HOME` (also its no-trace mechanism), and the claude warm pool holds a
stable long-lived home — neither re-symlinks per request.

**Isolation modes:**
- `"shared"` (default) — the per-label home above, auth bridged in.
- `"off"` — no home injection; the CLI uses its own default (or a caller-supplied
  `CODEX_HOME`). Autocomplete's per-request ephemeral home path.
- `"ephemeral"` (**new, for nebula no-trace**) — a **fresh** home per `session`/exec,
  auth bridged in, **wiped on close**. Guarantees no transcript accumulation without
  each tool hand-pruning `~/.claude/projects/<cwd>/*.jsonl`. Folds nebula's no-trace
  guarantee into the shared layer.

### Env precedence (resolves Q6)

**Caller env wins.** The child env is `{ …childBaseEnv, CODEX_HOME/CLAUDE_CONFIG_DIR
from isolation, …caller.env }` — the isolation home vars are applied first and the
caller's `env` is merged last, so a caller that passes its own `CODEX_HOME` (e.g.
autocomplete's per-request ephemeral throwaway home) overrides the gateway's. The
gateway home fills in only when the caller omits it.

The gateway imposes no session/ephemerality policy — autocomplete's `--ephemeral`,
`history.persistence="none"`, `features.plugins=false` live in autocomplete's argv and
are carried through untouched.

### Child environment / PATH (the launchd trap — flagged by slides as top risk)

A gateway started by launchd inherits a **sparse** environment with no user `PATH`.
The CLIs it spawns often launch a grandchild MCP server via `tsx`/`npx`, and `tsx`
shells out to `node` — all of which fail to resolve under launchd's minimal env
("works in dev, dies under launchd"). Two-part fix:

1. **The gateway establishes a login-shell `PATH` for children.** At startup it
   captures the user's interactive `PATH` once and uses it as the child base env, so
   `node`/`tsx`/`npx` and the provider binaries resolve regardless of how the daemon
   itself was launched. `HOME`, `USER`, `SHELL`, `LANG` are also propagated.
   - **Parse defensively (slides note):** `$SHELL -lic '…$PATH'` runs the full
     interactive rc, and some setups print to stdout during init (nvm, greetings). Emit
     a sentinel and read the marked line — e.g. `$SHELL -lic 'printf "NEBULA_PATH=%s\n"
     "$PATH"'` and grep `^NEBULA_PATH=` — rather than trusting whole stdout, or the
     cached `PATH` can be corrupted.
2. **Callers may still forward specifics.** Because caller env wins (above), a tool
   can pass an exact `PATH`/toolchain env for its MCP server if it needs to pin one.

**Implementation ordering (slides note):** `bin` (§4) is exec'd directly with no shell,
so a shebang like `#!/usr/bin/env node` (slides' `.mjs` fakes) resolves `node` *from
the child `PATH`*. The child env must therefore be fully assembled **before** the spawn
— a naive path that spawns `bin` before the §5 base env is built breaks slides' test
harness specifically. Wire the two together.

`GET /providers` reports the resolved child `PATH` so a tool can diagnose a missing
toolchain without guessing.

## 6. Security model — **hard requirement: no backdoor to any website**

The gateway spawns the user's authenticated CLIs with argv it does not inspect. So a
caller can run `codex -s danger-full-access`, strip a tool's `--strict-mcp-config`
lockdown, or (via `bin`) run an arbitrary binary — all as the user. **The gateway is
therefore not a safety boundary for argv; the token + loopback bind are the whole
perimeter, and the blast radius is cross-tool.** This is a deliberate, named trade:
sandboxing is caller-side, exactly like the tools already have it.

Given that, the non-negotiable requirement (owner directive) is: **a web page must
never be able to drive execution it shouldn't.** The daemon exposes **two planes** with
different perimeters:

- **GATEWAY plane** — `/providers`, `/exec`, `/session` create/turn/delete, auth-home.
  Can spawn arbitrary argv → **local-process-only, no browser, ever** (this subsection).
- **ATTACH plane** — a narrow, opt-in, browser-facing plane that can *only attach to an
  already-created `session`*, never spawn (see "ATTACH plane" below, resolves Q12).

### GATEWAY plane — local-process-only

- **Loopback bind only** (`127.0.0.1`) — never `0.0.0.0`.
- **Token in an `Authorization` header** — token at `~/.nebula-agent/token` (mode
  `600`, readable only by the user). This is not just a secret; the header choice is
  load-bearing: `Authorization` is **not** a CORS-safelisted header, so any
  cross-origin page trying to send it triggers a preflight, which the gateway denies
  (it returns no CORS headers) — the real request never fires. A page cannot read the
  600 token file either.
- **No CORS, ever.** The gateway emits no `Access-Control-Allow-*` headers, so no
  cross-origin browser response is readable and no preflighted request is allowed. The
  v1 idea of a browser origin allowlist is **dropped**.
- **Reject browser-originated requests outright.** Any request bearing a cross-site
  `Origin` or `Sec-Fetch-Site: cross-site` / `Sec-Fetch-Mode: cors` is refused, as
  belt-and-suspenders against "simple request" CSRF (a `text/plain` POST that skips
  preflight still cannot spawn anything, because it also lacks the token — and it's
  rejected on the fetch-metadata check regardless).
- **Validate the `Host` header (anti-DNS-rebinding).** The fetch-metadata checks above
  miss the classic localhost attack: with DNS rebinding, an `evil.com` page rebound to
  `127.0.0.1` is *same-origin* to the browser, so `Sec-Fetch-Site: cross-site` never
  fires and the `Origin` looks same-origin. Defense: **require `Host` to be a loopback
  name** (`127.0.0.1[:port]` / `localhost[:port]`) and reject anything else. The
  `600`-mode token is still the ultimate backstop (a page can't read it), but this
  closes the one browser-reachable path the fetch-metadata checks don't. **Moot under
  the unix-socket transport** (§7) — a further argument for making the socket the
  default.

Trusted local processes (each tool's own backend) set the `Authorization` header
directly — they are not subject to CORS — and are unaffected.

For **hosted** tools, browser-facing auth stays each tool's responsibility on its own
endpoint: the browser talks to *that tool's* cloud, which reaches the local machine via
the §7A outbound bridge → connector → GATEWAY plane. The browser never touches the
GATEWAY plane.

### ATTACH plane (resolves Q12 → in-gateway, opt-in)

Co-located features (nebula's agent terminal and warm-pool completions, §2 "participant
not co-location") need the **browser to reach a local session directly** — routing
through the cluster would cost 2× RTT per keystroke. The owner's choice (2026-07-07,
one-sidecar): a **second, opt-in, browser-facing plane on the same daemon**, scoped so
tightly it is not the backdoor §6 forbids:

- **Attach-only.** It can `WS /session/:id/attach` and drive turns on **already-created**
  sessions — it **cannot** call `/exec`, cannot create sessions, cannot pass argv. New
  sessions are created only via the GATEWAY plane (a trusted local process).
- **Loopback TCP** (browsers can't dial the gateway's unix socket), separate listener.
- **Per-session capability token, not the standing gateway token.** The session's
  creator (GATEWAY plane) mints a short-lived, single-session token; the browser gets
  *that*. A leaked attach URL exposes one session briefly, never the daemon. (WS
  handshakes can't carry `Authorization`, so the token rides the URL — hence
  short-lived + per-session rather than the standing 600-file token.)
- **Origin allowlist + Host-loopback** on the WS handshake (server-enforced; a real
  browser sends its true `Origin`, so a malicious page is rejected; Host-loopback blocks
  DNS rebinding).

**Named honestly:** attaching to a *pty* terminal **is** arbitrary execution — you can
type any command. So this plane's guarantee is not "can't execute"; it's "can only reach
sessions a trusted local process already created, gated by a per-session token + origin
+ loopback." That is the **same risk profile as an authenticated web terminal** (e.g.
hop's), consciously accepted here for the co-located terminal/completion features, and
kept rigorously separate from `/exec`.

## 7. Lifecycle & deployment

- **Two listeners, one daemon:**
  - **GATEWAY plane** — a **unix domain socket** (`~/.nebula-agent/sock`, mode `600`)
    as the primary transport: unreachable over any network interface, file-perms gated.
    A loopback-TCP port (default `8791`) stays as an opt-in for callers that can't speak
    to a socket.
  - **ATTACH plane** (opt-in, only if a tool needs co-located browser attach) — a
    **loopback TCP** listener (browsers can't dial unix sockets), separate port, with
    the §6 attach-plane controls.
- **Per-plane / per-label concurrency budgets** (resolves Q9). A single global cap would
  head-of-line-block bursty completions behind a long agentic run. Instead: a
  machine-protecting global ceiling, plus separate budgets so warm-pool turns don't
  consume `/exec` slots and one tool's burst doesn't starve another.
- **One launchd LaunchAgent** keeps the daemon alive (RunAtLoad, KeepAlive, restart on
  crash) — one agent for everything.
- `GET /providers` also returns a gateway `version` so tools can detect an
  incompatible/old gateway and tell the user to update it.

## 7A. Remote / cloud deployment (hosted tools, e.g. writer.zhoulab.io)

The motivating case: a user of a **hosted** tool should install **only the shared
gateway + a thin per-tool connector**, never the tool's full app — no local DOCX,
collab, or UI; those live in the cloud. Two facts (verified 2026-07-07) make this work:

- **claude speaks remote MCP:** `claude mcp add --transport http <name> <url> --header
  "Authorization: Bearer …"`. The locally-run CLI can attach to a **cloud-hosted** MCP
  server, so the tool's MCP tools live in the cloud, not on the user's machine.
- **The local side dials out:** writer's sidecar already opens an outbound WebSocket to
  `<cloud>/bridge` (no inbound ports; the browser never reaches the local machine).

### Topology

```
 Browser (writer.zhoulab.io) ── talks only to its own origin ──► Cloud (Cloudflare DO)
                                                                  • document + collab
                                                                  • run-context
                                                                  • MCP server over HTTP
                                                                        ▲ (2) claude attaches to
        Local machine                                                   │     cloud MCP (Bearer)
   ┌───────────────────────────────────────────┐                       │
   │ thin connector ── outbound bridge ─────────┼─► Cloud  (1) "run a turn: mcpUrl,token,prompt"
   │   builds argv from a VETTED template       │                       │
   │        │ /exec  (localhost + token)        │                       │
   │        ▼                                    │                       │
   │   shared gateway ── spawns ──► claude ──────┴───────────────────────┘
   └───────────────────────────────────────────┘   (local auth; output streams back
                                                     connector → bridge → cloud → browser)
```

1. The cloud sends a **constrained** run-request down the authenticated bridge
   (mcp-url + per-run token + prompt) — **not raw argv**.
2. The local connector builds the claude argv from a **vetted template** (the agentic
   lockdown flags + `--mcp-config` pointing at the cloud MCP url with the Bearer token)
   and calls the local gateway's `/exec`.
3. The gateway spawns claude locally (local auth); claude attaches to the cloud MCP
   server, does the work, and output streams back up the bridge to the browser.

The browser only ever talks to its own cloud origin — consistent with §6, it never
reaches the gateway.

### Why a thin connector, not gateway-alone

The §6 invariant — *no remote supplies raw argv to a local CLI* — must hold for the
**cloud** too, not just websites. A compromised cloud sending raw argv to a bridge-mode
gateway would be local RCE. So the connector builds argv from a **local vetted
template**; the cloud can only trigger the tool's own agentic recipe, never arbitrary
commands. The connector is tiny — bridge + argv template + gateway client, kilobytes,
not the app.

### What the user installs for a hosted tool

The **shared gateway** (once, amortized across every hosted tool) **+ a thin per-tool
connector**. Far less than the full app, and no per-tool heavyweight sidecar.

### Owner decision (Q11) — **RESOLVED: (A) gateway + thin connector** (owner, 2026-07-07)

- **(A) gateway + thin connector ✅ CHOSEN** — argv is built locally from a vetted
  template; the cloud cannot inject commands; the §6 security posture holds end-to-end.
  A hosted user installs the shared gateway + a thin per-tool connector.
- ~~(B) gateway-only with a bridge mode~~ — rejected: would let the cloud send raw argv
  to a local CLI, trusting the cloud as-much-as-your-own-shell. Not acceptable.

**Implication for implementation:** the connector is a real (if tiny) deliverable per
hosted tool — bridge client + a **vetted argv template** (no pass-through of
cloud-supplied argv; the cloud provides only mcp-url + per-run token + prompt, which
the template interpolates into fixed, lockdown-flagged argv) + gateway `/exec` client.
The gateway itself stays pure `/exec` + `/providers`; it never learns about bridges.

## 8. Optional shared client library

To avoid re-duplicating the writer/slides arg-builders and stream-parsers, they can
move into a small **optional** client lib (`@nebula/agent-client`) that repos import:
`buildClaudeAgenticArgs()`, `ClaudeStreamParser`, an `exec()` helper that speaks the
§4 protocol. **This is a convenience library, explicitly not part of the daemon.**
Autocomplete, being pure one-shot, may not need it at all.

## 9. Per-project migration

What each repo keeps vs. deletes. **Nothing about how you invoke the CLI changes** —
you build the same argv; you just hand it to `/exec` instead of `spawn()`.

### nebula-notebook (autocomplete + agent terminal)
- **Deletes:** the `spawn` in `backends/codex.ts` / `claude.ts`, the `CODEX_HOME`
  auth-copy setup, and its own warm-pool / pty lifecycle plumbing.
- **Keeps:** the exact argv (codex `exec --json --ephemeral …`; claude `-p
  --input-format stream-json`), extract-agent-message parsing, model/effort/timeout,
  the recycle-after-N policy, the browser-side ghost-text/terminal UI.
- **Becomes:**
  - autocomplete-**codex** → `POST /exec` buffered, `isolation:"off"` + ephemeral
    `CODEX_HOME` (no-trace).
  - autocomplete-**claude** → `POST /session {kind:"stdio"}` + `…/turn` (warm pool;
    dodges the 2.3 s cold start), `isolation:"ephemeral"`.
  - agent **terminal** → `POST /session {kind:"pty"}` (vendored `hay`) + browser
    `WS …/attach` over the **ATTACH plane**.
- **Net:** nebula runs **one** local process (the shared daemon) for local *or* remote
  — no reverse tunnel, no server-side CLI, no cluster round-trip on the latency paths.
- **Self-hosted, not vendor-cloud:** reached over `ssh -L` to the user's own cluster,
  so §7A's connector isn't its path for the co-located features; the ATTACH plane is.

### nebula-writer
- **Deletes:** the `spawn`/kill/stream plumbing in `agent-runtime.ts`; the
  home-isolation half of `cli-home.ts`; codex one-shot's spawn in `ai.ts`.
- **Keeps:** arg builders, `agent-mcp.ts` (its MCP server), `agent-run.ts`
  (run-context endpoints), suggestion validation, stream→event mapping, DOCX, collab.
- **Becomes:** `agenticCliProvider` builds argv + starts a run context, then calls
  `/exec` (streaming) with `env.WRITER_AGENT_RUN_URL` pointing at its run endpoint.

### slides-mcp
- **Deletes:** the `spawn`/kill/stream plumbing and `prepareProviderHome` in
  `agent-connector.ts`.
- **Keeps:** `buildClaudeArgs`/`buildCodexArgs` (incl. its `--strict-mcp-config`
  lockdown), its filesystem MCP server + deck wiring, stream parsers, deck ops/render.
- **Becomes:** `runAgentTurn` calls `/exec` (streaming) with `bin`-overridable binary,
  `label: "slides"`, and its child `PATH`/deck env.
- **Reality check (from slides' review):** slides has **no daemon** today —
  `editor-server` is user-started and self-contained — so the gateway does **not**
  remove a persistent process for slides; it adds a runtime dependency. The win is
  dedup of the auth-home logic + shared parsers, which is *nice-to-have, not
  load-bearing*. Therefore **slides migrates last**, only after writer proves the path
  end-to-end, and a standalone slides remains a supported fallback.
- **Directory moves on migration:** slides' trajectory store relocates from
  `~/.slides-mcp/agent-home` to `~/.nebula-agent/slides/<provider>/`. Intent preserved
  (still global, still identifiable via the label), but call it out at migration time
  so the move isn't a surprise.

## 10. Open questions & review status

All three reviews are in (`slides ✔`, `nebula ✔`). Every question is resolved.

**Contract sufficiency**
1. `[all]` Can the contract express every invocation? — **✔** yes: `/exec` + `bin`
   override for slides/writer/codex; **`session` (§4A)** for nebula's warm pool + pty,
   which `/exec` could *not* express (the one thing the contract had to grow).
2. `[all]` Two-mode response / base64 cost? — **✔** negligible vs model latency for all;
   nebula's real levers are process reuse (warm pool) + not routing through the cluster,
   both now in the design. claude streams partial output; codex is buffered — both modes
   kept, per backend.

**MCP / run-context**
3. `[slides][writer]` Grandchild-MCP model holds? — **slides ✔** (filesystem MCP,
   cleaner than writer). `[writer]` HTTP run-context — validated during writer's migration.
4. `[all]` Cloud/remote deploy → who drives execution? — **✔** hosted writer: §7A
   (browser→cloud→bridge→connector→gateway). nebula: self-hosted over `ssh -L`; co-located
   autocomplete/terminal use the **ATTACH plane** (§6), not the cluster (§2 participant
   rule). slides: local-only.

**Isolation & sessions**
5. `[all]` Home model? — **RESOLVED: per-tool `label`** namespacing (§5).
6. `[all]` Env precedence? — **RESOLVED: caller env wins** (§5). Plus new
   `isolation:"ephemeral"` for nebula no-trace.

**Ops**
7. `[all]` Transport? — **RESOLVED:** GATEWAY plane = unix socket (+ opt-in TCP);
   ATTACH plane = loopback TCP (browser needs it). §7.
8. `[all]` Cancel semantics? — **RESOLVED:** connection-close cancels `/exec` (slides ✔);
   `session` has **per-turn abort that does not kill the process** + explicit `DELETE`
   (nebula's warm pool must survive dropped turns). §4A.
9. `[all]` Concurrency? — **RESOLVED: per-plane / per-label budgets** (nebula: bursts
   mustn't head-of-line-block behind an agentic run), global machine ceiling on top. §7.
   Atomic auth-symlink made safe; nebula sidesteps it anyway (`isolation:"off"`/ephemeral).

**Security**
10. `[all]` Argv is caller-side (gateway not an argv safety boundary)? — **✔ acknowledged**
    by slides and nebula. For the ATTACH plane, controls are per-session token + Origin +
    Host-loopback + attach-can't-spawn (§6).

**Owner decisions — all resolved (2026-07-07)**
11. Hosted-deployment model → **(A) gateway + thin connector** (§7A).
12. Co-located browser attach → **in-gateway ATTACH plane** (§6), one sidecar. The owner
    chose one process and accepted the stateful process-lifecycle manager; the ATTACH
    plane is scoped attach-only with per-session tokens.
13. `session` primitive scope (stateful lifecycle in the shared daemon) → **accepted** (§4A).

## 11. Non-goals

- Not a model router or an API proxy — it runs local *CLIs*, nothing else.
- No prompt construction, no domain logic, no MCP tool definitions, no parsing of
  meaning — all caller-side.
- Not a replacement for a tool's own backend where that backend has real local
  responsibilities (writer's DOCX/collab). It replaces only the CLI-spawn+auth layer.

## 12. Rollout

Phased so the `/exec` core ships and proves out before the bigger stateful surface.
**Owner descope (2026-07-08): v1 is "gateway-lite" — the GATEWAY plane only, for
writer + slides. No `session` primitive, no ATTACH plane, no terminal.** The §4A/§6
attach design stays in this doc as the agreed v2 shape for nebula, but nothing
stateful ships in v1.

### v1 — gateway-lite (writer + slides)

1. **Scaffold the GATEWAY plane** — `/providers` + `/exec` + auth-home (§5, `shared`/
   `off` modes) + the §6 perimeter + §5 child-PATH, extracted from writer's
   `cli-runtime` + spawn/home code (freshest, best-tested). Unix socket primary,
   opt-in loopback TCP. Simple global concurrency cap (per-plane budgets are a v2
   concern). Package: `~/Code/nebula-agent-gateway`.
2. **Migrate writer** onto `/exec` **with in-process fallback**: if the gateway socket
   is absent, writer spawns locally exactly as today. Writer stays self-contained;
   the gateway being down can never take writer's AI offline. Verify end-to-end
   (agentic claude + codex one-shot), including the HTTP run-context grandchild path
   (Q3). This is the proof.
3. **One launchd/socket service** for the daemon.
4. **Migrate slides** the same way (same fallback posture; standalone slides remains
   supported). Directory move called out (§9).

Each migration keeps the tool's tests green against the new `/exec` path — using the
`bin` override to point at each tool's existing fake-CLI harness — before the old
spawn code is deleted.

### v2 — stateful surface (nebula)

5. **Add the `session` primitive** (§4A: stdio warm pool + pty) and **the ATTACH
   plane** (§6), plus `isolation:"ephemeral"` and per-plane/per-label budgets.
   Migrate **nebula** — codex→`/exec`, claude→stdio session, terminal→pty+attach.
   Vendored `hay` for the pty.
6. **§7A thin connector** if/when a hosted tool wants to shed its full local backend —
   not needed for hosted writer today, whose existing sidecar+bridge remains the
   trusted local process that calls the gateway.
