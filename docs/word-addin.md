# Nebula Writer for Word — the task pane add-in

Nebula Writer runs inside Microsoft Word as a task pane. You keep writing in
Word; the pane watches where you are, asks your local AI (Claude Code or Codex)
for anchored suggestions, and lands the ones you accept as native tracked
changes or comments. Nothing leaves your machine except what your CLI provider
sends.

## What the pane knows about your Word window

The pane reads the Word window continuously and attaches that state to every
AI request as `hostContext` (see `WordHostContext` in `src/shared.ts`):

| Signal | Source | Used for |
| --- | --- | --- |
| Selection (text + exact character offsets) | `document.getSelection()` mapped onto the paragraph index | Selection-scoped requests; "this" in an instruction |
| Caret paragraph, sentence, offset | selection start + paragraph texts | "Tighten this paragraph", "what's weak right here" |
| Section heading above the caret | paragraph styles / outline levels | "the section I'm in", location badges on cards |
| Pages on screen (viewport offsets, page numbers) | `activeWindow.activePane.pagesEnclosingViewport` (WordApiDesktop 1.2) | "Review the visible pages"; prioritising what you are looking at |
| Recent focus trail | selection-change events, de-bounced | "the paragraph I was just in" |
| Document outline | heading paragraphs | orientation for document-wide asks |
| Word's Track Changes mode | `document.changeTrackingMode` | how an applied edit is recorded |

Offsets are character offsets into the pane's normalized body text (`\n`
line endings), the same text the sidecar and the agents read — so the agent
can jump straight to the right window with `writer_read_document(offset, limit)`.

The server renders this state into the AI prompt (`server/word-context.ts`),
both for the agentic engine and the one-shot CLI prompt. With the pane open,
the same state is pushed to the sidecar (`POST /api/word/context`), so a
terminal or MCP agent working the same document gets it from
`writer_get_selection` and reads the live Word text from `writer_read_document`.

### Scope picker

| Scope | Sends |
| --- | --- |
| **Auto** | Selection if you have one, otherwise the whole document with your position attached (the prompt tells the AI to prioritise the caret and visible pages unless the instruction is document-wide) |
| **Selection** | Only the selected text |
| **Paragraph** | The paragraph at the caret (short paragraphs widen to their neighbours) |
| **Visible** | The pages currently on screen |
| **Document** | Everything |

### The conversation

The pane works like a chat. Each of your turns shows the instruction **and
exactly what was sent** — click *Sent …* to expand it:

- Text: scope (selection / paragraph / visible pages / whole document), word
  and character counts, offsets, and an excerpt of the start and end.
- Window state: caret paragraph, the heading above it, pages on screen,
  selection size, how many recent stops and headings were attached.
- Engine: provider, model, and reasoning level (with "(default)" when the
  CLI's own default applies).

Each assistant turn carries its reply and the suggestion cards it staged, so
proposals never pile up in a detached queue: handled cards collapse to a
one-line outcome inside the turn, the header counts what is still pending, and
*Clear* wipes the conversation (pending suggestions are recorded as
rejected). Suggestions staged by other agents on the same document (a
terminal `claude`, the web app) arrive as their own turn. With *Mirror this
conversation* on, the turns are appended to the shared session's chat so the
web app shows the same history.

### What the agent can pull, and the tool-call trail

The briefing pushed with a request stays small (window state, selection,
scope). Everything else the agent pulls through the `writer` MCP tools, and
those reads are **live**: while the pane is open the agent's reads follow your
caret, selection, and visible pages as you move.

| Tool | Reads |
| --- | --- |
| `writer_read_context({ what })` | `paragraph` (at the caret; `before`/`after` add neighbours), `section` (from the heading above the caret to the next heading of that level), `page` (exactly what is on screen), `selection`, `outline` (headings with offsets), `document` (size and outline only). Anchor elsewhere with `around` (offset) or `paragraph_index`. |
| `writer_read_document` / `writer_search_document` | Windowed text and exact-text search, as before. |
| `writer_get_selection` | The live window state (caret, section, viewport, trail, outline). |

Each reply in the conversation shows its **tool-call trail**: while the agent
works the last few calls stream under the progress line, and afterwards a
collapsed "N tool calls · reads · staging calls" line lists every read and
staging call with timestamps — so you can see exactly what the agent looked
at before proposing an edit.

### Conversation memory

A follow-up ("make it shorter", "same for Aim 2") is answered in context. The
pane keeps the provider's own conversation id per provider and document and
sends it back, so Claude Code resumes its session; if that session is gone
(CLI updated, store pruned) the sidecar restarts a fresh one instead of
failing. Independently of that, every request carries a compact digest of the
chat so far — your instructions, the agent's replies, and what you did with
each suggestion (applied, dismissed with your note, still pending) — which
both engines read as feedback: dismissed edits are avoided, pending ones are
not re-staged. The *Sent …* record shows "N earlier turns with your decisions"
and whether the session was resumed. *Clear* starts over.

### Sectioned replies and Apply all

Every staged suggestion gets a short ref (`S1`, `S2`, …) from the staging
tool, and both engines are asked to write their reply as sections: a `## `
heading, a sentence of context, then the refs of the suggestions that belong
there (`[S3]` on its own line). The pane renders each card exactly where the
agent placed it, and every section with two or more pending edits gets an
**Apply all** button that applies them one after another as tracked changes,
re-reading Word between edits so later anchors stay valid. Suggestions the
agent forgot to place are listed under *Other suggestions*; a plain unsectioned
reply simply shows its cards beneath the text.

### Reference files

The paperclip in the composer attaches PDFs, DOCX, or text files. The sidecar
extracts their text (`/api/ai/attachments`), and every request in the
conversation carries them until you remove the chip; the *Sent …* details list
which files went along. Attachments are reference material only — suggestions
still anchor to the Word text. (If Word's task pane cannot open a file picker
on your build, drop the file into the web app's chat instead; the limit is 8
files per request.)

### Model and reasoning level

Next to the provider picker are a **model** and a **reasoning** select. Their
options are discovered from the CLIs that are actually installed — nothing is
hard-coded — so they follow `claude update` / Codex upgrades (the pane
re-discovers automatically when the sidecar reports a new CLI version; the
*rediscover* link under Settings forces it):

| Provider | Models from | Reasoning from | Passed as |
| --- | --- | --- | --- |
| Codex | `codex debug models` (the CLI's live catalog: slugs, display names, per-model reasoning levels, defaults); falls back to `models_cache.json` | the catalog's `supported_reasoning_levels` | `-m <model>` · `-c model_reasoning_effort="<level>"` |
| Claude Code | `claude --help` aliases (`fable`, `opus`, `sonnet`…) plus the full ids found inside the installed binary, ranked newest-first | `--effort` levels in `claude --help` (low … max) | `--model <model>` · `--effort <level>` |

"Default" sends nothing and lets the CLI use its own configured model
(`~/.codex/config.toml` / `~/.claude/settings.json`, shown in Settings). *Custom
model id…* accepts anything the CLI accepts, e.g. `claude-fable-5-1[1m]`. The
choice is remembered per provider. The same override rides `modelOptions` on
`/api/ai/suggest` and `/api/word/suggest`, and `GET /api/ai/models` returns the
catalog for any client.

### Applying suggestions

- **Locate** selects the passage in Word (also on card click / ↩).
- **Apply** replaces the text. With *Always as a tracked change* (default) the
  pane switches Word to Track All for the edit and restores the previous mode,
  so the change shows up as a revision from you. Long anchors (over Word's
  ~255-character search limit) are found by head/tail search and verified
  against the original before anything is replaced.
- **Comment** anchors a Word comment with the suggested text and rationale.
- **Dismiss** records a rejection (agents see it as feedback). Restore undoes.
- If the original text occurs more than once, the card shows *match k/n* with
  arrows; the default is the occurrence nearest the suggestion's offset (or
  your caret).
- An original that spans paragraphs (Word's search never crosses a paragraph
  mark) is found by its first and last paragraph pieces, shown with ¶ marks in
  the card, and applied paragraph by paragraph — so a sentence added before a
  heading never replaces the heading's paragraph mark or style.

Decisions sync to the shared Writer session, and suggestions staged by other
clients (a terminal agent, the web app) appear in the pane live via `/events`.

## Setup (macOS)

```bash
npm run word:setup
```

The script:

1. Creates (or reuses) a self-signed certificate for `localhost` in
   `~/.nebula-writer/certs/` and trusts it for SSL in your login keychain —
   Office loads task panes only over HTTPS, and Word's webview honours the
   keychain. macOS asks for your password once.
2. Builds the app (`dist/word/taskpane.html` is a second Vite entry).
3. Writes `word/manifest.xml` into Word's sideload folder
   (`~/Library/Containers/com.microsoft.Word/Data/Documents/wef/`), rewriting
   the port if `WRITER_TLS_PORT` is set. An existing manifest is backed up to
   `~/.nebula-writer/backups/`.
4. Restarts the `io.nebula.writer-sidecar` launchd service so the sidecar
   starts its HTTPS listener (`server/tls.ts`, default port 8443) alongside the
   plain one. The listener is skipped silently when no certificate exists.
5. Runs `npm run word:doctor`.

Then **quit and reopen Word**, open a document, and click **Home › Nebula
Writer** (the manifest adds a ribbon button; *Home › Add-ins › Nebula Writer*
also works).

`npm run word:doctor` checks the certificate and its trust, the HTTPS listener,
the served task pane and icons, the installed manifest (URL, id, ribbon
button), Word's version, and the Office.js CDN, and prints a fix for each
failure.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `WRITER_TLS_PORT` | `8443` | HTTPS port (manifest and sidecar must agree — rerun `word:setup` after changing) |
| `WRITER_TLS_DIR` | `~/.nebula-writer/certs` | Certificate directory |
| `WRITER_TLS_CERT` / `WRITER_TLS_KEY` | `<dir>/localhost.pem`, `<dir>/localhost-key.pem` | Explicit PEM paths |
| `WRITER_TLS=0` | — | Disable the HTTPS listener |

### Windows

Not scripted. Generate a certificate trusted by the machine (for example with
`office-addin-dev-certs`), point `WRITER_TLS_CERT`/`WRITER_TLS_KEY` at it, and
sideload `word/manifest.xml` through a shared-folder catalog (Trust Center ›
Trusted Add-in Catalogs).

## Development

- `word/taskpane.html` → `src/word/main.tsx`. The pane is built together with
  the web app (`npm run build`); the sidecar serves `dist/` with `no-cache` on
  HTML so Word's webview picks up rebuilds.
- `src/word/wordHost.ts` is the only file that touches Office.js.
  `src/word/wordContext.ts` holds the pure offset/paragraph/scope logic.
- **Without Word:** open `https://localhost:8443/word/taskpane.html?mock=1`
  (or the Vite dev server URL with `?mock=1`). `src/word/mockOffice.ts`
  installs an in-memory Word with a sample grant (Office.js is not loaded in
  mock mode); the pane shows a *Mock Word* bar to move the caret, select a
  sentence, scroll, and edit outside the pane.
  The same mock backs the tests (`tests/word-host.test.ts`,
  `tests/word-app.test.tsx`).
- **Inside Word:** enable the webview inspector once with
  `defaults write com.microsoft.Word OfficeWebAddinDeveloperExtras -bool true`,
  relaunch Word, then Safari › Develop › *your Mac* › taskpane.html.
- Office caches manifests aggressively. After changing `word/manifest.xml`, rerun
  `npm run word:setup --no-build`, then quit Word; if the old add-in persists,
  clear `~/Library/Containers/com.microsoft.Word/Data/Library/Caches/` and
  `~/Library/Containers/com.microsoft.Word/Data/Documents/wef/` contents
  (see Microsoft's "Clear the Office cache").

## Requirement sets

| Feature | Requirement set | Fallback |
| --- | --- | --- |
| Comments, Track Changes mode | WordApi 1.4 (manifest minimum) | — |
| Paragraph styles (`styleBuiltIn`) | WordApi 1.3 | style names / outline level |
| Paragraph change events | WordApi 1.6 | poll every 20 s |
| Pages on screen | WordApiDesktop 1.2 (Word for Mac 16.89+) | caret + selection only; *Visible* scope disabled |
| Selection events | DocumentEvents 1.1 | poll every 2.5 s |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Blank pane | certificate not trusted or listener down | `npm run word:doctor` |
| "No Word" pill in a browser | expected — use `?mock=1` to demo | — |
| "No Writer" pill | sidecar not running / no HTTPS | `npm run sidecar` after `word:setup`, check `WRITER_TLS_PORT` |
| Add-in missing from the ribbon | Word was running when the manifest was installed | quit and reopen Word |
| *not found in Word* on a card | text changed since the suggestion | re-read (↻) and ask again |
| Applied edit is not tracked | *Follow Word's Track Changes setting* is selected and tracking is off | switch to *Always as a tracked change* in Settings |
