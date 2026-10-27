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
| **Selection** | The selected text is the *focus*: edits land there unless the instruction cannot be carried out inside it (it names other passages, asks for document-wide work, or the selection holds nothing relevant), in which case the AI edits elsewhere and says so. It always has the rest of the document: Claude reads it with the tools below, Codex receives the whole document — or a window around the selection — in its prompt |
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

If a reply looks truncated or odd, the raw CLI transcript for that run is in
`~/.nebula-writer/cli-transcripts/` (prompt, stdout, stderr; last 30 runs).

### Images

The pane reads the document's inline pictures (size, alt text, and the
paragraph they sit in, usually the caption) and, when you send a request,
uploads each picture's bytes once to the sidecar. The AI can then look at
them: Claude opens the file with its image-capable Read tool, Codex gets the
files as image inputs and can also open them with its image viewer. The
agent tools `writer_list_images` and `writer_read_image` expose the same
list. When the AI produces a new picture — a regenerated figure, a cropped
panel — it proposes it with `writer_stage_image_replacement` (or, in the
one-shot pipeline, a suggestion carrying `imageIndex` and `imageFile`). The
card shows the current and proposed pictures side by side; Apply replaces
the picture in Word (Word tracks it like any other change when Track
Changes is on), Locate selects it, and the comment button anchors a Word
comment on it. In the web app the same card swaps the picture in the editor,
and the source-based DOCX export replaces the media part as a tracked
delete/insert pair. Supported formats: PNG, JPEG, GIF, WebP, up to 15 MB.

**Tools the AI may use** (Settings) decides how much of the CLI's own tooling
a request gets. *Everything your CLI has* (the default) runs Claude Code or
Codex the way you run them yourself: their built-in tools, your own MCP
servers, your permission settings; the document is still only edited through
the review queue. *Document + web and read-only files* adds only web
search/fetch and read-only file access to Writer's tools. *Document only* is
the original lockdown. The web app has the same picker next to the provider.

The box never locks while a request runs, and a message sent meanwhile
works like typing into the CLI while it works:

- **Send** (⌘↩) delivers it *into the running turn*. The AI sees it at its
  next step (after the tool call it is in) and answers both in the same
  reply; the conversation shows it as "Sent into the running turn". Codex
  runs through `codex app-server` (`turn/steer`), Claude through
  `claude -p --input-format stream-json` with stdin kept open for the turn
  (through the agent gateway's open-stdin execs). Each request carries a
  run id; `POST /api/ai/steer {runId, text}` reaches it.
- **Queue** (the list button, ⇧⌘↩) holds it for the turn after — shown above
  the composer with *Send now* and a discard button — and it goes out
  automatically, in the same thread, when the current turn ends. *Send now*
  delivers it into the running turn.
- When the running turn cannot take input (between a turn and its
  follow-up, a CLI without the app-server), the message is queued with a
  notice; *Send now* then stops the turn and sends it.

The web app behaves the same way (Shift/⌘+Enter sends, Option+Enter
queues), and so does the Google Docs sidebar, which runs this pane.
`WRITER_CODEX_TRANSPORT=exec` puts Codex back on `codex exec` (no steering).

Quotes heal themselves where they safely can: a suggestion whose original
differs from the document only in typography, spacing, or a small misquote
inside a long passage is snapped to the document's exact text (the same
correction is carried into the replacement so the misquote never lands), and
the reply says which quotes were repaired. A quote that cannot be placed at
all triggers one automatic re-quote request in the same thread, with the
nearest document text shown to the model.

If a reply describes more changes than it returned ("these ten cuts…" with
one card), Writer asks the CLI once more, in the same thread, for the rest
and merges them in; the reply says so. Keyboard: the pane has no letter
shortcuts. With a suggestion card focused, the arrow keys move between cards
and Enter locates it in Word; everything else is a button.

Follow-ups keep the provider's own conversation: Claude resumes its session
and Codex resumes its recorded thread (`codex exec resume`), so "continue" or
"yes, do it" carries the earlier turns, the document, and the decisions you
made on each suggestion. The thread lives until you start a new conversation
or clear the pane.

Applying edits only the words that change. The pane asks Word for the
passage as word ranges and deletes or inserts just the differing words, so
bold, italics, superscripts, links, and the rest of the passage keep their
formatting (an inserted word takes the formatting of the word it follows);
the tracked change Word shows is the minimal one. A near-total rewrite is
replaced whole. An edit whose words would cut into a Word field — a citation
or cross-reference — is refused with a reason rather than corrupting the
field; leave it as a comment or edit the field in Word.

Applying is batched: a card's Apply, and "Apply all" for a section or a
reply, run as one exchange with Word (every search queued into one sync, one
Track Changes toggle, every replacement queued into one sync, from the end of
the document backwards), followed by a single re-read. A change that
overlaps another in the same batch is retried against the updated text.

**Commenting on one suggestion.** Every pending card has a Comment button
that opens a note box on the card itself, with three canned refinements
(Shorter, Keep my wording, Different angle) and Send (⌘↩). The note is sent
as feedback on that card: the AI is told exactly which suggestion you mean,
revises it as a single new card labelled *Revision of S3*, and the earlier
card is withdrawn (shown as *revised*, with its Show change still
available), never counted as rejected. The small speech-bubble icon next to
it is the other kind of comment: it leaves the suggestion as a Word comment
in the document. The conversation stays one linear transcript; the card
history is the threaded view. The web app has the same Comment box on its
review cards.

Two buttons sit above the transcript once it has turns. **Start a new
conversation** forgets the provider session and the earlier turns (the AI
starts fresh) but keeps pending suggestion cards — they are carried into the
new conversation — and attachments. **Clear** wipes everything and dismisses
pending suggestions. The web app has the same new-conversation button in its
chat header.
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


### Inline emphasis (bold, italic, underline, highlight)

Emphasis is how key claims are signposted in a grant, so the pane reads it
and the AI can write it. The snapshot carries bold/italic/underline/highlight
spans over the body text (paragraphs with a uniform font cost nothing extra;
mixed paragraphs are read word by word in one more round trip). Every request
and the shared session text carry the spans, and the AI sees the document with
markers:

```
**bold**   *italic*   __underline__   ==highlight==
```

The AI quotes originals with the markers as shown and uses them in
replacements to keep, add, or remove emphasis; a replacement without markers
where the original had them removes the emphasis, and an emphasis-only edit
(bold this phrase) is a real suggestion. Cards render the emphasis on both
sides of the diff. Apply sets the requested formatting word by word after the
text lands, writing only what differs (so tracked changes stay clean) and
formatting the spaces between equally emphasised words so an underline or
highlight runs through. A suggestion the AI wrote in plain text still inherits
the formatting of the words it replaces, as before. The web app and the DOCX
export behave the same way (see `docs/agentic-ai.md`).

### What the agent can pull, and the tool-call trail

The briefing pushed with a request stays small (window state, selection,
scope). Everything else the agent pulls through the `writer` MCP tools, and
those reads are **live**: while the pane is open the agent's reads follow your
caret, selection, and visible pages as you move.

| Tool | Reads |
| --- | --- |
| `writer_read_context({ what })` | `paragraph` (at the caret; `before`/`after` add neighbours), `section` (from the heading above the caret to the next heading of that level), `page` (exactly what is on screen), `selection`, `outline` (headings with offsets), `document` (the full text, up to 60k characters, plus the outline) |
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

The conversation is saved per document by the sidecar
(`~/.nebula-writer/conversations.sqlite`, `server/conversation-store.ts`),
keyed by where the document is saved (Word) or its Docs id; the web app saves
its chat the same way, on the sidecar that runs its AI. Reopening the
document restores the latest 40 turns, every card still pending (wherever in
the history it was staged) and the CLI sessions, so the next follow-up
resumes the same Codex thread or Claude session. *New conversation* starts a
new saved conversation (the old turns stay on disk, unrestored); *Clear*
forgets it. An unsaved Word document is saved under its location once it has
one.

Long conversations stay fast at every layer:

- **Storage**: indexed SQLite; saving sends only the turns, suggestions and
  cards that changed; opening reads one page. 10,000 turns: a page read and
  an append take milliseconds.
- **Pane**: only the latest 40 turns are rendered; *Show earlier* reveals
  more, fetching earlier pages, without moving the reader.
- **Prompt**: the digest is the last 16 turns, clipped. A resumed Codex
  thread is not sent the whole document again each turn
  (`server/document-delta.ts`): when the thread still holds the copy it was
  last given, the prompt says the document is unchanged or lists the changed
  paragraphs ("was"/"now"); the full text goes again when much changed or
  Codex compacted the thread (the app-server reports compaction; with `codex
  exec` the full text is always sent). Claude's agentic engine reads the
  document through tools, so its turns never carried it. Both CLIs compact
  their own context when a session grows long.

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

### Comments

The AI sees the document's comments. The pane reads Word's comments (text,
author, the passage each is attached to, replies, resolved state) on every
full read — when you send a request or press Re-sync, never while you type
— and sends them with the request. Prompts list them as reviewers' notes
anchored to text, open threads first; agents also get
`writer_list_comments`, and terminal agents see the last set the pane sent.
In the web app, comments come from the imported DOCX (`comments.xml`, with
replies and resolved state from `commentsExtended.xml`). Google Docs
comments are not read yet (they need Drive API access).

### Writer's Codex threads stay out of the Codex app

With *Everything your CLI has*, Codex runs on `~/.nebula-writer/codex-full`:
every entry of `~/.codex` (config, auth, MCP servers, plugins, computer
use, skills, rules, hooks) is linked in except the history and state
stores, so Codex behaves exactly as you set it up while Writer's threads
are recorded in Writer's home and never appear in the Codex app. The inline
terminal uses the same home. Threads made before this (from 2026-10-05)
can be moved out with `npm run codex:forget-writer-threads`; quit the
Codex app first if it reports a thread is open.

### Staying out of Word's way while you type

Word runs an add-in's reads on its own thread, so reading the document
while the author types is felt as lag. The pane therefore waits for a
pause: nothing is read from Word until 1.5 s after the last edit (paragraph
change events mark edits; caret moves alone do not). Caret reads skip the
pages-on-screen query, which makes Word lay pages out; that query runs only
on an idle 4 s poll. Background re-reads reuse the emphasis already read
for paragraphs whose text is unchanged; a request and Re-sync read
everything afresh. Measured against the mock host: a realistic 3 s typing
burst caused 9 Word round trips before, none now.

The whole-document re-read (every paragraph's text, style and font, and the
pictures) is the heavy one on a long document, so it waits for a break, not
a pause: 5 s with neither an edit nor a caret move. A pause to think
mid-sentence only gets the light caret read. Turning to the pane (clicking
or focusing it) catches up at once. Writing with 2–3 s pauses: one
whole-document read per pause before, one at the break now.

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
  arrows. Every staged suggestion carries a placement anchor (where its
  original sat and the text around it), so the default is the occurrence whose
  surroundings still match the anchor; only when that is undecided does the
  pane fall back to the occurrence nearest the suggestion's offset or your
  caret. This is what keeps a move honest: an agent moves a passage as an
  insertion plus a deletion, and after you accept the insertion the deletion
  still removes the old copy, not the one you just added. The web app and the
  DOCX export resolve repeated originals the same way.
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
