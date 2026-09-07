# Agentic AI engine — design

Replace the one-shot CLI pipeline (whole document in one prompt → strict JSON
of exact-substring suggestions) with an **agentic runner**: the CLI is spawned
as an agent whose entire capability surface is Writer's own MCP tools. It
reads the document through tools, stages suggestions through a validated
tool, streams progress, and keeps conversation state across chat turns.

The pattern is ported from `slides-mcp/src/agent-connector.ts`, which was
written as the successor to Writer's connector and validated end-to-end
against Claude Code. The one-shot pipeline **retires** at the end of the
sequence — every reason to keep it is resolved below.

## Why

| One-shot pain | Agentic fix |
| --- | --- |
| `original` must be a perfect substring; mismatches fail silently and need fuzzy-match compensation downstream | Validation moves into the staging tool: a bad item is rejected *with a reason* and the agent retries immediately |
| >120k-char documents need sequential coverage passes | The agent reads only the windows it needs (`offset`/`limit` reads + text search) |
| Chat has no memory; every message starts cold | `--resume <sessionId>` per conversation |
| Progress is a coarse "Coverage pass 3 of 8" | Streamed tool events: "reading Specific Aims", "staged 4 suggestions (1 rejected, retrying)" |
| Claude runs with `--tools ""` and cannot read attachments, so we inline ≤40k chars into the prompt | `writer_read_attachment` tool; the inline budget disappears |

## Architecture

### 1. Tool surface (writer-mcp)

The agent's whole world. Additions:

- **`writer_read_document`** — extend the existing full read with `offset` /
  `limit` windowing and total length, so long documents are read in slices.
- **`writer_search_document`** — find occurrences of a string/regex, return
  positions with surrounding context. How agents locate targets without
  reading everything.
- **`writer_stage_suggestions`** — the only write. Batch of
  `{ title, original, replacement, rationale, confidence, commentOnly? }`.
  The sidecar validates each item with the *existing* safety checks
  (`containsAnchoredText`, whitespace-only diff rejection) and answers per-item accept/reject with reasons. Accepted items
  land in the shared review queue tagged with the run id and `proposedBy`.
- **`writer_read_attachment`** — windowed read of a file under
  `tmp/attachments/` (path-validated against that directory; DOCX
  attachments are text-extracted via the existing importer).
- **`writer_propose_changes` retires.** It existed to ask the one-shot
  pipeline for suggestions. External agents (a user's own Claude Code
  session) *are* agents — they read and stage directly with the same tools.

Backing sidecar endpoints: `GET /api/session/document/window`,
`POST /api/session/suggestions/stage`, `GET /api/ai/attachments/read`.
All loopback + share-auth guarded like the rest of the API.

### 2. Agent runner (`server/agent-runtime.ts`)

Port of slides-mcp's connector, adapted:

- **Claude (validated default)** — lockdown recipe:
  `-p <prompt> --output-format stream-json --verbose --mcp-config <tmpfile>
  --strict-mcp-config --tools ToolSearch --allowedTools "mcp__writer ToolSearch"
  [--resume <sessionId>]`.
  `--tools ToolSearch` strips every built-in (no Bash/Write/Read);
  `--strict-mcp-config` + a single-server temp config means the agent can
  reach nothing but Writer's MCP server; `--allowedTools` pre-approves so
  nothing prompts.
- **Codex (experimental, as in slides-mcp)** — `codex exec --json` with the
  MCP server registered via `-c` overrides and the sandbox scoped to a
  scratch dir. Codex has no built-in-tool allowlist; its confinement is the
  sandbox. Gate retirement on validating this path e2e (see Rollout).
- **Stream parsers** for both CLIs' JSONL ported near-verbatim, emitting
  `status | session | text | thinking | tool | result | error` events.
- The MCP config launches `writer-mcp` (tsx entry or built bin) with
  `NEBULA_WRITER_URL` pointing back at this sidecar and the document id in
  env, so tool calls hit the right session.
- Existing single-flight AI queue, output cap, and SIGTERM→SIGKILL interrupt
  handling all preserved. There is no timeout by default: a turn runs until it
  finishes or the user stops it (`WRITER_CLI_TIMEOUT_MS` remains an opt-in
  cap), and the one-shot pipeline now streams the same JSONL events as the
  agentic engine (`codex exec --json`, resumed per conversation with
  `codex exec resume <thread>`; `claude --output-format stream-json
  --include-partial-messages`) so both the web busy pill and the Word pane
  show live stages — reading, thinking (with Codex's reasoning headline),
  writing with a running character count — plus elapsed time.


### 3. Request contract — what makes retirement safe

`POST /api/ai/suggest` keeps returning
`AiResponse { message, suggestions, stagedInSession }`:

- `suggestions` = the items the agent staged during this run (collected by
  run id). Routines, Word-live, the personal runner, and the bridge all
  consume this shape today and keep working unchanged.
- `message` = the agent's closing 1–2 sentence summary.
- New: `agentSessionId` in request/response. The web app keeps one per
  document+provider (cleared on document switch), so follow-up chat messages
  resume the same CLI conversation.

Prompt template (ported from `buildAgentPrompt`): role, the tool workflow
("inspect before editing; stage in small batches; the staging tool tells you
if an anchor missed — fix and retry"), selection scope when present,
attachment names+paths, suggestion-quality guidance (change only what was asked, etc.), and "finish with 1–2 plain sentences."

### 4. Progress and multi-tab UX

Agent events map onto the existing progress plumbing (`setAiProgress` →
`/api/ai/progress` polling → bridge broadcasts), with a new free-text
`detail` ("tool: writer_stage_suggestions — 4 staged"). All tabs see live
stage text exactly like coverage passes today. Streaming the assistant's
text deltas over the `/events` websocket for a live-typing bubble is a
follow-up, not part of this port.

## Retirement checklist — reasons to keep one-shot, each resolved

| Concern | Resolution |
| --- | --- |
| Bridge mode depends on it | Bridge forwards the request to the runner's sidecar, which runs the agentic engine there. Nothing bridge-specific about one-shot. ✓ |
| Routines / R01 sequences consume `AiResponse.suggestions` | Contract preserved (staged-during-run collection). ✓ |
| `/api/word/suggest` (Word add-in) | Same contract; same engine. ✓ |
| Provider smoke test | Repointed at a minimal agentic turn on a tiny built-in doc — exercises the *real* tool path, which is strictly better smoke coverage. ✓ |
| Demo provider (tests, no-CLI demo) | Pure JS, not part of the CLI pipeline. Kept. ✓ |
| Attachment text inlining | Replaced by `writer_read_attachment`. Upload endpoint + chips stay; `AiAttachment.text` stops traveling once agentic is default. ✓ |
| Codex agentic is experimental | **Gate hit (2026-07-06).** Codex 0.142.3's non-interactive `exec` raises an approval elicitation for MCP tool calls and auto-cancels it ("user cancelled MCP tool call"). Bisected exhaustively — args, env, cwd, stdio, shell-wrapping, `approval_policy="never"`, project `trust_level`, per-server `trusted` — nothing disables it (binary strings show a persisted, app-config-level MCP tool approval). So the one-shot pipeline **stays as Codex's engine**; Claude defaults to agentic. `WRITER_AI_ENGINE=agentic` forces Codex agentic for re-testing when a new codex ships; `WRITER_AI_ENGINE=oneshot` forces the old engine everywhere. Full retirement resumes when Codex agentic passes e2e. |
| Latency/cost for small asks | An agentic turn on a small doc is one read + one stage — a few extra seconds. Accepted; multi-turn memory and reliability buy more than that. |

What gets deleted: `buildCliPrompt`, `AI_RESPONSE_SCHEMA` / `--json-schema`
handling, `parseCliResponse`, coverage-pass machinery
(`buildDocumentCoverageChunks`, `runCoveragePasses`), the unsupported-flag
compat retries, and their tests — replaced by runner tests (arg builders,
stream parsers, staging validation, prompt builder).

## Rollout

1. **Tools** — writer-mcp additions + sidecar endpoints, unit-tested
   (staging validation matrix: anchor miss, whitespace-only, happy path).
2. **Runner** — `agent-runtime.ts` + switch `/api/ai/suggest`, `/api/word/suggest`,
   bridge, smoke to it. `WRITER_AI_ENGINE=oneshot` env escape hatch, one
   release only.
3. **Validate & delete** — e2e both providers (small doc, long doc, selection
   scope, attachment, multi-turn resume, staging-rejection retry, interrupt).
   Then delete the one-shot code, its tests, and the escape hatch.

## Test plan

- Unit: arg builders (lockdown flags exact), both stream parsers against
  captured JSONL fixtures, staging validation matrix, window/search reads,
  attachment path confinement (reject `../` and absolute paths outside
  `tmp/attachments`).
- App tests: chat send → staged suggestions render in review queue;
  `agentSessionId` threading; progress detail strings.
- E2E (verify skill): real Claude run staging a suggestion end-to-end in the
  browser; rejection-retry observed in the event stream; Codex run gating
  phase 3.

## Structural reads and live window state (2026-09-01)

`writer_read_context` reads by structure (paragraph / section / page / selection / outline / document) against the run snapshot, anchored on the Word add-in's caret. The add-in pushes its window state and a paragraph index continuously (`POST /api/word/context`); `server/agent-run.ts` keeps a live source so `writer_get_selection` and `writer_read_context` follow the author mid-run when the document name matches. Every agent event is recorded in `AgentRunContext.activity` and returned as `AiResponse.activity`, which the Word pane renders as the reply's tool-call trail.
