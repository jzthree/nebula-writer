# Nebula Writer

A local-first, DOCX-compatible writing tool with AI-assisted revision — built for long, structure-heavy documents like NIH R01 grant proposals, where equations, citation-manager fields, and tracked changes must survive every round trip with Microsoft Word.

Nebula Writer treats **Word as the final review surface**: the browser editor is focused on text revision, and AI suggestions are exported back into your original DOCX as native tracked changes and comments, with the untouched OOXML (math, Paperpile/Zotero fields, bookmarks) preserved.

## Highlights

- **Local-first AI.** Suggestions come from the Codex CLI or Claude Code running on your machine. No document text leaves your computer unless your CLI provider sends it.
- **Exact-source suggestions.** Every AI edit anchors to verbatim text from your document. Stale or ambiguous anchors are detected: if the original text moved or appears in several places, the Writer highlights the closest match and asks you to confirm before replacing anything.
- **Reversible review.** Accept and reject are transactional — an accept only counts once the replacement is verified in the document — and both are undoable (`Undo accept` restores the original text; `Restore` returns a rejected suggestion to the queue).
- **Source-preserving review export.** Pending suggestions become Word tracked changes (`w:ins`/`w:del`) or comments patched into your *original* DOCX package, so formulas, citation fields, tables, and images are untouched. Character formatting in patched paragraphs (italics, superscripts, fonts) is preserved run by run.
- **Attributed review.** Every exported tracked change and comment carries the real `w:author` — the collaborator who typed the edit, the person whose request produced the AI suggestion, or the agent that proposed it — so Word shows per-person revisions, not one generic reviewer.
- **Suggesting mode.** In Suggesting mode, typing becomes underlined insertion marks and deletions become strikethrough marks (the text stays until someone accepts), synced live to all collaborators and exported to Word as tracked changes with the suggester's name. Short, ambiguous edit anchors are exported as Word comments instead of guessing a location.
- **Coverage passes for long documents.** Global reviews of documents beyond the context limit run in sequential chunks with live per-pass progress. If a later pass times out, completed passes are kept and the response tells you how much of the document was covered.
- **Shared agent session.** An MCP server exposes the same Writer session to coding agents — an agent can open a DOCX, propose changes, and triage suggestions alongside you, with optimistic-concurrency checks so two clients never silently clobber each other.
- **Crash-safe.** Sessions autosave to `tmp/recovery/` and restore on restart; the browser warns before you close a tab with pending work or discard suggestions by importing a new file.
- **Accessible by default.** Keyboard-navigable menus, WCAG AA muted-text contrast, `prefers-reduced-motion` support, and automatic dark mode.
- **Live collaboration.** Google-Docs-style co-editing over a Yjs CRDT with named remote cursors, plus instant review-queue sync between collaborators (and agents). See "Live collaboration" below.

## Quick start

```bash
npm install
npm run dev:all
```

Open `http://127.0.0.1:5173`. `dev:all` starts the sidecar (port 8787) and the web app together. Local AI is enabled by default, so Codex CLI and Claude Code are available when their CLIs are on `PATH`.

Import a `.docx`, type a revision goal (or pick a grant-writing preset), and review the proposed changes card by card. Export a **Review DOCX** to get your original file back with the pending edits as tracked changes.

## Live collaboration

Nebula Writer supports Google-Docs-style co-editing. The document is a Yjs CRDT synced through the sidecar (`/collab` websocket): collaborators' edits merge in real time, their cursors appear with names and colors, and review-queue actions (new suggestions, accepts/rejects, chat) propagate instantly over a push channel (`/events`).

To invite someone:

```bash
npm run dev:share   # binds the web app and sidecar to your network instead of localhost
```

Then click the **Share** button (people icon) in the toolbar — it lists who is connected, lets you set your cursor name, and shows the link to send (e.g. `http://192.168.1.20:5173/#share=Kx3…`). The collaborator just opens the link; no account or install needed.

**Trust model:** sharing mode is protected by a capability URL. The sidecar generates a fresh 256-bit random token per run (override with `WRITER_SHARE_TOKEN` for a stable one); the share link carries it in the URL fragment, so browsers never transmit it in plain requests and it cannot appear in server logs. Every API call and websocket from a non-local client must present the token (timing-safe comparison) or it is rejected with 401 — guessing is computationally infeasible. Your own localhost browser and same-machine agents are loopback-trusted automatically. Two caveats remain: traffic is plain HTTP (use a VPN such as Tailscale if the network itself is untrusted), and anyone you give the link to can edit until you restart the sidecar (which rotates the token). The default `npm run dev:all` stays strictly local (127.0.0.1).

Because both humans and agents operate on the same shared session, an MCP-connected agent's proposals show up live for every collaborator too.

## AI providers

Two user-facing providers, both shelling out to local CLIs:

| Provider | Backend |
| --- | --- |
| `codex` | local `codex` CLI |
| `claude` | local `claude` (Claude Code) CLI |

Use the activity button next to the provider picker to run a smoke test — it sends a small anchored revision request through the same path as real requests and reports whether the CLI returned a parseable, anchored suggestion.

To prevent the sidecar from shelling out at all (the editor still works for import, review, and export):

```bash
npm run sidecar:locked
# or
WRITER_ALLOW_CLI=0 npm run sidecar
```

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WRITER_CODEX_PATH` | `codex` on `PATH` | Specific Codex CLI executable |
| `WRITER_CLAUDE_PATH` | `claude` on `PATH` | Specific Claude Code executable |
| `WRITER_CLI_TIMEOUT_MS` | unset (no timeout) | Optional cap on one provider request, in milliseconds (minimum 100). By default a request runs until it finishes or you press Stop; the UI shows what the CLI is doing and how long it has been running. |
| `WRITER_ALLOW_CLI` | `1` | Set `0` to lock out local CLI execution |
| `WRITER_CLI_TRANSCRIPTS` | `~/.nebula-writer/cli-transcripts` | Where each one-shot CLI run leaves its prompt and raw output (last 30 kept) so a bad reply can be inspected. `off` disables. |
| `WRITER_SIDECAR_PORT` | `8787` | Sidecar port |
| `WRITER_EMF_CONVERTER` | `emf2svg-conv` | Converter used to preview EMF images in the browser |
| `WRITER_RECOVERY_MAX_AGE_DAYS` | `14` | Delete `tmp/` artifacts older than this |
| `WRITER_RECOVERY_MAX_SNAPSHOTS` | `20` | Keep at most this many autosave snapshots |
| `WRITER_RECOVERY_MAX_TOTAL_MB` | `2048` | Size cap for the `tmp/` artifact tree |

The deterministic `demo` provider still exists behind `/api/ai/suggest` for automated tests, but is not exposed in the product UI.

### Keeping Writer out of your personal CLI history

When Writer asks Codex or Claude Code for a revision it runs the real CLI, which
normally records the session in your personal trajectory history — one
transcript per AI request. Writer keeps its calls out of your personal history
automatically:

- **Transcripts are confined to a Writer-owned home** by default:
  `~/.nebula-writer/claude` (`CLAUDE_CONFIG_DIR`) and `~/.nebula-writer/codex`
  (`CODEX_HOME`), so your real `~/.claude` / `~/.codex` stay clean. Writer
  bridges auth into those homes by symlinking the credential files (Codex's
  `auth.json`; on macOS Claude authenticates through the Keychain, so nothing is
  copied), so there is no separate login step.
- **They are pruned** on the sidecar's maintenance cycle — transcripts older
  than 14 days are removed (`WRITER_CLI_TRAJECTORY_MAX_AGE_DAYS`), and the
  bridged auth symlinks are never touched.
- The CLIs also run in a dedicated workspace directory
  (`~/.nebula-writer/cli-workspace`, override `WRITER_CLI_WORKSPACE`).
- **To opt out** and let a CLI use its own home, set `WRITER_CODEX_HOME=default`
  or `WRITER_CLAUDE_CONFIG_DIR=default` (or point either at a path of your
  choice).

## Word add-in (task pane)

Nebula Writer also runs *inside* Microsoft Word as a task pane, so you can stay
in Word and still get context-aware AI revision: the pane knows which text you
selected, which paragraph and section your caret is in, which pages are on
screen, and where you paused recently — and it tells the AI. Suggestions land
in Word as native tracked changes (or comments). Full guide:
[docs/word-addin.md](docs/word-addin.md).

```bash
npm run word:setup    # trusted localhost certificate, build, manifest into Word, restart sidecar
npm run word:doctor   # check every prerequisite
```

Then in Word: **Home › Nebula Writer**. The pane is a chat: every turn shows
what was sent (scope, size, window state, engine), replies carry their
suggestion cards, and a model / reasoning picker offers whatever the installed
`claude` and `codex` CLIs currently support (discovered via `GET /api/ai/models`). The pane is served by the local sidecar at
`https://localhost:8443/word/taskpane.html` (Office requires HTTPS), and while it
is open, terminal/MCP agents on the same document see your caret and selection
through `writer_get_selection`.

## Cloud deployment (writer.zhoulab.io style)

The `cloudflare/` package deploys the Writer to Cloudflare Workers — static
front-end plus one Durable Object per document for live collaboration. Full
setup (private-repo GitHub integration, custom domain, secrets) is in
[cloudflare/DEPLOY.md](cloudflare/DEPLOY.md).

AI in the cloud comes from real machines, two ways:

- **Bring your own AI (each collaborator).** On a machine with the Codex or
  Claude CLI:

  ```bash
  git clone <this repo> && cd nebula-writer && npm ci
  WRITER_ALLOWED_ORIGINS=https://<your-cloud-host> npm run sidecar
  ```

  Your open cloud tab detects it within ~20s and runs AI requests on your own
  account. (The cloud UI also shows this command whenever AI is offline.)

- **Team bridge (one shared runner).** The owner runs
  `WRITER_CLOUD_URL=wss://<your-cloud-host> WRITER_CLOUD_TOKEN=<BRIDGE_TOKEN> npm run sidecar`
  and everyone without their own runner shares it.

## The DOCX revision workflow

1. **Import** a DOCX. The importer reports up front what the browser view can and cannot keep (table formatting, EMF/TIFF images, equations, footnotes, comment markers), so there are no surprises at export time. Existing tracked changes are shown as accepted, with the original revision markup preserved for export.
2. **Revise** with AI. Selection-scoped or document-global instructions; per-request suggestion caps; saved prompts and built-in grant-writing routines (gap triage, rigor, milestones, cross-aim integration, and more).
3. **Review** in the queue. Suggestions are filterable (pending / priority / conflicts / missing targets / latest run / Word comments / fact checks), searchable, and keyboard-navigable. Confidence is bucketed High / Med / Low — it is the provider's self-estimate, not a guarantee. An auto-advance toggle controls whether accepting jumps to the next suggestion or stays on the edited text for verification.
4. **Export**:
   - **Review DOCX** — patches pending suggestions into the original DOCX as tracked changes and comments (preferred for technical/academic documents).
   - **Cumulative review** — one carrier DOCX for everything pending in the shared session.
   - **Rebuilt DOCX** — regenerates a plain document from the editor (loses Word-only structure; the UI says so).
   - **Session JSON** — a small snapshot of the review queue for restore/handoff.

Suggestions whose targets would disturb protected content (equations, citation fields, tracked structure) are exported as Word comments instead of tracked changes, with the reason reported.

## MCP / agent interface

The bundled [`writer-mcp`](writer-mcp/) package is a standalone MCP server exposing Writer tools that talk to the local sidecar (start the sidecar first):

- `writer_status`, `writer_open_docx`, `writer_get_document`
- `writer_propose_changes`, `writer_list_suggestions`, `writer_set_suggestion_status`
- `writer_export_review_docx`

Register it with your MCP client, e.g. `claude mcp add nebula-writer -- npx tsx <repo>/writer-mcp/src/index.ts` — see [writer-mcp/README.md](writer-mcp/README.md) for details.

Agents and the web UI share one sidecar session. Session mutations accept optional `expectedSessionId` / `expectedRevision` fields; when supplied, a stale write is rejected with HTTP 409 instead of clobbering another client's state. The session summary includes the current `revision`.

While an AI request is running, `GET /api/ai/progress` reports the provider, current stage (e.g. `Coverage pass 3 of 8`), and elapsed time; the web UI polls this to show live progress.

## Architecture

```
┌────────────────────┐   HTTP    ┌──────────────────────────┐   stdio   ┌─────────────┐
│  Web app (Vite +   │ ────────▶ │  Sidecar (Express)        │ ────────▶ │ codex /     │
│  React + TipTap)   │ ◀──────── │  · DOCX import/export     │ ◀──────── │ claude CLI  │
└────────────────────┘           │  · session + autosave     │           └─────────────┘
        ▲                        │  · AI orchestration       │
        │ MCP tools              │  · tracked-change patcher │
┌────────────────────┐           └──────────────────────────┘
│  Coding agents     │ ────────────────────▲
└────────────────────┘
```

- `src/` — browser app: TipTap editor, review queue, routines, session sync.
- `server/` — sidecar: DOCX conversion (`docx.ts`), AI provider orchestration (`ai.ts`), session/state API (`app.ts`), realtime websockets (`realtime.ts`), artifact rotation (`maintenance.ts`).
- `writer-mcp/` — standalone MCP server for coding agents (own package with its own tests).
- `tests/` — Vitest suites covering the editor operations, review flows, DOCX round-trips, the HTTP API, and tmp pruning.

Recovery snapshots are written to `tmp/recovery/` and pruned automatically (see the `WRITER_RECOVERY_*` variables above).

## Development

```bash
npm run dev:all    # sidecar + web app
npm test           # vitest (233 tests)
npm run build      # typecheck + production build
npm run qa         # scripted QA loop
```

## License

Private — all rights reserved.
