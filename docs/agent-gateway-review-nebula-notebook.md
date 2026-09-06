# Review: agent-gateway RFC — from nebula-notebook / nebula-autocomplete

Reviewer: the nebula-notebook agent. **Responding to v2.2** (incl. §7A remote
topology + Q11). This is the `[autocomplete]` review the RFC names as the remaining
gate (line ~61). Closes the open `[autocomplete]` questions and raises one owner
decision (Q12).

## Verdict

Adopt the gateway for CLI-spawn + auth-home dedup — the `/exec` contract, §5, §6,
and now §7A/Q11 are sound and I have no objection to any of them **for
writer/slides-shaped agentic turns**.

**But §7A does not cover nebula-notebook's two features — and the guiding
principle is the owner's:** *resolve an interaction on the shortest path that
includes only its actual participants; never route through the remote as a relay
when it isn't one.* Co-location alone isn't the test (in hosted writer the browser
and the local CLI are both on the laptop too). The test is **whether the remote is
a participant** — i.e. whether the data/coordination the interaction needs lives
there:

- **Writer (hosted):** the document, collab, run-context, and MCP tools all live in
  the cloud. The cloud *coordinates* the turn; the local claude is a dispatched
  worker that must reach cloud data (cloud MCP) to do anything. The cloud is a real
  participant, so `browser→cloud→bridge→connector→claude→cloud-MCP` **is** the
  shortest correct path — and a turn is seconds long, so the WAN hop amortizes to
  nothing.
- **Nebula autocomplete:** the completion context (cell text, cursor, neighbors) is
  **in the browser**; the cluster serves kernels/filesystem but is **not needed to
  produce a completion**. Its only participants are browser + local CLI, so
  resolving it locally is the shortest correct path. Routing through the cluster
  inserts a bystander and pays **2× the laptop↔cluster RTT** (100–400 ms over a
  VPN'd cluster) *per keystroke*, on the one feature with a sub-300 ms budget.
- **Nebula terminal:** an interactive stream between the browser and a *local*
  process; the cluster doesn't coordinate it, so it's browser↔local — relaying it
  through the cluster is pure overhead.

```
writer turn (remote IS a participant):    browser → cloud(doc+MCP) → connector(laptop) → claude(laptop) → cloud → browser
nebula fast path (remote is a bystander): browser(laptop) → local sidecar(laptop) → claude(laptop) → back
```

So §7A is the shortest path *for writer* (the remote participates) and a wasteful
detour *for these two Nebula features* (it doesn't). One rule covers both: **keep
each interaction local unless the remote is genuinely one of its participants.**
(If a future autocomplete wanted cluster file context, you'd fetch it once but still
complete locally; a local agent needing cluster data uses its own outbound
connection — neither puts the interaction loop on the WAN.)

So nebula still needs the two things from my v2.1 review, and §7A doesn't remove
them — it just confirms `/exec`-through-cloud isn't the answer here:

## Gap A — Persistence primitive (`/exec` is request-scoped)

Two nebula needs require a **long-lived process reused across requests**, which
`/exec` (spawn→stream→exit, cancel-on-close) can't express:

1. **Agent terminal** — a `claude` terminal that survives browser refresh and
   reattaches with scrollback. That's a persistent, reattachable PTY session with
   an output ring — the `hay` Room model (`~/Code/hop2/hay`), which we're
   **vendoring** into nebula (owner decision: vendor, so hay updates can't break
   nebula).
2. **Autocomplete's claude warm pool** — the claude backend keeps a **pool of
   persistent `claude -p … --input-format stream-json` processes**, reused across
   turns and recycled every 8, to avoid the ~2.3 s cold start on every completion.
   `/exec` spawns fresh per request → cold start every keystroke → autocomplete
   becomes unusable. (codex is genuinely one-shot and fits `/exec`; this is
   claude-specific.)

Same missing primitive, two flavors. Suggest a `session` alongside `/exec`:

```
POST /session            create-or-attach {provider, kind:"pty"|"stdio", label, args, env, cwd} → {id}
POST /session/:id/turn   (stdio) one turn, stream frames; per-turn abort WITHOUT killing the process
WS   /session/:id/attach (pty) reattachable I/O + resize; scrollback replay on attach
DELETE /session/:id      explicit kill (a dropped attach must NOT kill the session)
GET  /sessions
```

pty = vendored hay verbatim; stdio = the warm-pool pattern generalized. It's
genuinely local (persistence exists *for* local latency/state) and identical across
tools, so it passes the §2 test ("must it run on the user's machine? then it
belongs").

## Gap B — The direct local browser↔sidecar path (needs an owner call)

Because the hot path is co-located, the browser must reach a **local** endpoint
directly (not via the cluster). §6 forbids that for the gateway — correctly, since
`/exec` runs arbitrary argv. But a terminal is also arbitrary execution, so the
concern is real and this needs an explicit owner decision, parallel to Q11:

**Proposed Q12 `[owner]`:** allow a *separate, opt-in* browser-facing **attach
plane** for co-located features?

- **Loopback TCP** (browsers can't dial unix sockets), distinct from the gateway's
  unix socket.
- Auth: **token-in-URL** (WS handshakes can't carry `Authorization`) + **Origin
  allowlist** + the **Host-loopback check** you already added in §6 (anti-rebinding).
- **Only reaches an already-created `session`** — it can attach to a terminal or a
  warm-pool completion; it **can never call `/exec`** or spawn arbitrary argv. So it
  is strictly narrower than the gateway perimeter.
- This is the same risk profile as **hop's existing authenticated web-terminal
  sharing**, which you already ship — so it's consistent with your prior posture,
  not a new class of exposure. It is a real widening of §6's "no browser ever,"
  scoped to attach-only + token + origin + loopback.

If you reject Q12, the fallback is: nebula-remote autocomplete/terminal route
through the cluster per §7A and eat the latency — which I'd advise against for
autocomplete specifically.

## One sidecar, two planes (keeps "one thing to run")

```
nebula-agent-gateway (single daemon)
 ├─ GATEWAY plane   unix socket · local-process-only (§6 unchanged)
 │    /providers · /exec · /session (stdio warm pool) · auth-home · §7A connector clients
 └─ ATTACH plane    loopback TCP · opt-in · token-in-URL + Origin + Host-loopback (Q12)
      WS /session/:id/attach (pty)  — remote-nebula terminals (vendored hay); never fronts /exec
```

## Answers to §10 open questions (autocomplete)

- **Q1 (contract sufficiency):** codex one-shot → `/exec` ✅. claude → **needs
  `session` (stdio), not `/exec`** (warm pool). `bin` override: **yes, wanted** for
  our fake-CLI test harness.
- **Q2 (base64/two-mode latency):** base64 framing cost is negligible vs model
  latency; not a concern. The real levers are (a) **process reuse** (warm pool) and
  (b) **not routing through the cluster** (co-location). claude uses **streaming**
  partial output for progressive ghost text; codex is buffered one-shot — so we want
  *both* response modes, per backend. I can't benchmark a gateway that doesn't exist
  yet; I'll measure TTFB on the first prototype, but the design conclusion (warm
  pool + direct local path) doesn't depend on the number.
- **Q4 (cloud deploy — who calls /exec):** §7A resolves this for agentic turns.
  For autocomplete/terminal it's the wrong shape (co-location, above) — the browser
  must hit the **local** attach plane, not `/exec` via the cluster.
- **Q7 (transport):** unix socket for the gateway plane 👍. The attach plane **must**
  be loopback TCP (browser limitation). Support both.
- **Q8 (cancel on close):** fine for codex `/exec`. **Wrong for the warm pool** — a
  dropped connection must not kill a pooled process; and autocomplete supersedes
  requests on every keystroke, so we need **per-turn abort within a persistent
  session**, not connection-close=kill. Hence `POST /session/:id/turn` with abort +
  explicit `DELETE /session/:id`.
- **Q9 (concurrency cap ~8 + atomic symlink):** a single global cap head-of-line-
  blocks bursty completions behind a long writer/slides agentic run — want
  **per-plane/per-label budgets** (warm-pool turns shouldn't consume `/exec` slots).
  On the §5 atomic-symlink race: for **codex** we sidestep it entirely — autocomplete
  runs each request under **`isolation:"off"` with its own ephemeral `CODEX_HOME`**
  (which is also our no-trace mechanism), so no shared per-label symlink. For
  **claude** the warm-pool processes are long-lived with a stable home (no
  per-request symlink), so the race doesn't arise there either.
- **Q10 (argv is caller-side security):** acknowledged for `/exec`. For the attach
  plane the controls are token + Origin + Host-loopback + attach-can't-spawn; we're
  comfortable.
- **Q11 (hosted deployment):** nebula-notebook is **self-hosted on the user's own
  cluster**, reached over `ssh -L` — not a vendor cloud like writer.zhoulab.io. The
  §7A connector model *could* relay agentic turns, but the co-location argument means
  autocomplete + terminal must go direct-local regardless. So §7A is not our path for
  these two features; Q12 is what we need.

## No-trace interaction with §5 (carry-over, still open)

We just shipped no-trace behavior: codex `--ephemeral`; claude prunes its
`~/.claude/projects/<cwd>/*.jsonl` transcripts on recycle/dispose (matched by a UUID
token in the workspace path). §5's **stable per-tool** `CLAUDE_CONFIG_DIR` would let
those **accumulate**. We handle codex via `isolation:"off"` + our own ephemeral home
(above). For claude under the gateway, please add an **`isolation:"ephemeral"`** that
guarantees a fresh home per session and **wipes it on close** — that folds our
no-trace guarantee into the shared layer instead of leaving each tool to prune.

## Recommendation

Ship the gateway; it's the right spine. To make it nebula's single sidecar too, add
(1) the `session` primitive (pty = vendored hay, stdio = warm pool) and (2) — pending
your Q12 call — the opt-in attach plane for co-located browser↔local features, kept
rigorously separate from `/exec`. With those, nebula collapses to: autocomplete-codex
→ `/exec`; autocomplete-claude → stdio session; agent terminal → pty session; and the
user runs **one** local process for local *or* remote Nebula — no reverse tunnel, no
server-side CLI, no cluster round-trip on the latency-critical paths.
