# Google Docs add-in

The same review pane as the Word add-in, in a Google Docs sidebar, talking to
the same local sidecar: prompts, Codex and Claude runs, terminal agents,
placement anchors, inline emphasis, images and message queueing all work
unchanged. What differs is the host: Google exposes no way for an add-in to
create suggested edits, so Writer's edits land directly in the document, and
the pane offers a **Highlight the text Writer changes** option (on by default
for Docs) that colours the new text so you can see what changed. Docs
version history keeps the record; Writer's cards keep the before/after.

## Architecture

```
Google Docs ── Apps Script (gdocs/script/Code.js)
                 │  DocumentApp: read paragraphs/emphasis/images, caret,
                 │  select ranges, apply replace operations
                 │
                 └─ Sidebar.html (served by Google)
                       └─ <iframe src="https://localhost:8443/gdocs/pane.html">
                              the review pane (src/word/App.tsx with the
                              Google Docs host, src/gdocs/docsHost.ts)
                              ── same-origin API + /events ──▶ sidecar
```

- The **pane** is served by the sidecar, so its API calls and the `/events`
  websocket are same-origin — no CORS, no tokens. The sidebar page embeds
  it and relays `google.script.run` calls over `postMessage`
  (`src/gdocs/scriptBridge.ts`), accepting messages only from the pane's
  origin and only for the add-in's own `nebula*` functions.
- The **script** (`src/gdocs/script/main.ts`, bundled by
  `scripts/gdocs-build.mjs` with the shared emphasis helpers) walks
  paragraphs, list items and table cells in order, reports headings, per-run
  bold/italic/underline/highlight, inline images, the caret and selection,
  and applies `DocsReplaceOp`s (`src/gdocs/protocol.ts`): word-level runs,
  paragraph splits for multi-line text, spans across paragraphs, and
  emphasis-only formatting. Each operation verifies the text it is about to
  change; a mismatch fails only that operation. Later operations are applied
  first so earlier offsets stay valid.
- The **host** (`src/gdocs/docsHost.ts`) finds matches in the snapshot
  locally (with the paragraph context placement anchors score), plans the
  operations (`docsPlan.ts`), and polls the caret (every 2 s) and the text
  fingerprint (every 5 s) since Docs has no events.
- Images: Writer reads inline images through the script and swaps them in
  place. Comments are not available (Docs comments created by an add-in do
  not anchor to text), so the Comment button reports that.

## Setup

Once: `npm run word:setup` (creates and trusts the localhost HTTPS
certificate the sidebar loads the pane from) and `npx clasp login`.

```bash
npm run gdocs:setup
```

builds, creates the Apps Script project on your account the first time,
pushes the code, restarts the sidecar and prints the remaining browser
steps: open the project (`npx clasp open-script` in `gdocs/script`),
**Deploy ▸ Test deployments ▸ Install**, then in any Google Doc
**Extensions ▸ Nebula Writer ▸ Open Writer**. Google asks to authorise the
add-in (scope: the current document only), and Chrome asks once to allow
local network access for the sidebar. Institutional Workspace accounts may
have add-ons or test deployments disabled by an admin; a personal Google
account works out of the box.

After code changes on the script side, run the setup again (it pushes);
pane-only changes need only a sidecar restart.

## Tests

- `tests/gdocs-script.test.ts` runs the Apps Script code against an
  in-memory DocumentApp (`tests/gdocs-fake.ts`) with end-inclusive offsets:
  reading, focus, selection, and every apply shape.
- `tests/gdocs-plan.test.ts` covers match finding and operation planning.
- `tests/gdocs-host.test.ts` drives the host through a fake transport.

## Chrome extension (Grammarly-style install)

The same pane as a Chrome side panel next to any Google Doc, installed once
in the browser rather than deployed per Google account. `chrome-extension/`
holds the extension (manifest template, side panel page); `src/chrome/`
holds its code:

- `docsApi.ts` (pure, tested): `documents.get` JSON → the same
  `DocsDocumentPayload` the add-in produces, with a map from paragraph
  offsets to API indices (inline objects occupy index space without text);
  `DocsReplaceOp`s → `documents.batchUpdate` requests (delete, insert,
  `updateTextStyle` for emphasis and the change highlight), later text
  first, every operation verified against the freshly fetched document.
- `sidepanel.ts`: embeds the sidecar-served pane and answers its `nebula*`
  calls with the Docs REST API, authorised through `chrome.identity`. Each
  panel is bound to its own document tab, including account-specific
  `/document/u/0/d/...` URLs; focusing another window cannot retarget it.
- `content.ts`: best-effort selection text from the Docs page (the API has
  no cursor); `background.ts`: opens the panel from the toolbar button on
  document tabs.

What differs from the add-in: no caret (Writer defaults to the whole
document), and picture replacement is not available (the Docs API needs a public image
URL). Everything else —
emphasis, placement anchors, agents, queueing, change highlighting — is the
same code.

The Chrome extension can read reviewer comment threads after per-document
authorization (see below). The Apps Script add-in does not read comments.
Unavailable comments are explicitly marked as unavailable in AI context;
their absence is not evidence that the document has no comments.

For a passage in the normal canvas editor, highlight the text and copy it
(`Cmd+C` on Mac, `Ctrl+C` elsewhere), then choose **Selection** in Writer.
Docs exposes the selected text when it handles Copy; simply highlighting
does not expose a readable DOM range. The extension observes that copy but
does not read the system clipboard or initiate a copy itself. Moving or
editing in the document clears the captured passage, so select and copy
again after changing it. A passage that occurs more than once in the
document is rejected as ambiguous; include more surrounding text. Matching
tolerates differences in spaces and paragraph breaks introduced by copying
formatted text, while keeping the document's original text and offsets.

With Docs' screen reader and braille support enabled under
**Tools > Accessibility**, Writer can instead read the live native text
selection directly. This is optional; the copy workflow needs no change to
accessibility settings.

Setup: `npm run chrome:setup` generates a stable extension id and builds;
load the folder unpacked in `chrome://extensions`; create an OAuth client of
type "Chrome Extension" for that id in Google Cloud Console (the script
prints the exact steps) and rerun `npm run chrome:setup -- --client-id=…`;
reload the extension. The key and client id stay in gitignored files.

After reloading or updating the unpacked extension, refresh each open Google
Doc and reopen Writer from that document's Chrome toolbar button. Existing
tabs can retain a disconnected content script until refreshed. Writer shows
a reconnect notice if the selection reader is missing, instead of silently
treating a failed connection as an empty selection. It also checks that the
selection reply belongs to the same document as the panel.

### Selection regression checks

The Chrome tests cover panel install/startup/navigation, document identity,
copy capture and invalidation, iframe replacement, and whitespace-preserving
selection matching:

```bash
npm test -- tests/chrome-background.test.ts tests/chrome-document-tab.test.ts tests/chrome-selection.test.ts tests/chrome-selection-bridge.test.ts tests/chrome-selection-match.test.ts
```

For a browser smoke test, reload the extension, refresh the document, and
reopen Writer. Highlight and copy both a plain passage and a multi-paragraph
passage with formatted citations; confirm Selection is enabled and shows the
intended text. Move the caret to clear it, then select and copy a different
passage. Switch between two document tabs and another window to check that
each panel remains attached to its own document. No AI request or document
edit is needed for these checks.

### Reviewer comment threads

The Chrome extension's **Connect comments** command opens Google Picker.
Choose the same Google Doc that is open beside Writer. This authorizes only
selected files using `drive.file`; Writer never requests whole-Drive access.
Google's per-file scope permits read/write access to selected files, but
this comment integration makes only read requests: it does not create,
resolve, reply to, or modify Google comments.

One-time Google Cloud setup, in the same project as the Chrome OAuth client:

1. Enable **Google Drive API** and **Google Picker API**.
2. Add `https://www.googleapis.com/auth/drive.file` to the OAuth consent
   screen's data-access scopes. Keep the existing Docs scope and test users.
3. Create a browser API key restricted to the Picker and Drive APIs, with
   website restrictions for `https://localhost:8443/*` (or the configured TLS
   port) and `https://docs.google.com/*`. Google Picker's iframe needs the
   latter origin. Never use an unrestricted key.
4. Configure the ignored per-machine setup, using the numeric Cloud project
   number as the Picker app ID:

```bash
npm run chrome:setup -- --picker-api-key=<restricted-key> --picker-app-id=<project-number>
npm run build
```

Restart the sidecar if its server code changed, reload the extension, refresh
the Google Doc, and reopen Writer. Click **Connect comments**, approve the
optional Google API host permission and per-file Google consent, then pick
the document. The status strip reports the number of accessible threads;
**Refresh comments** refreshes them without an AI request. Full document
reads (including every AI request) read comments afresh. Google grants can
be revoked through your Google Account's third-party app access settings.

The local sidecar must serve `gdocs/comment-picker.html` from the updated
build. Google's Picker script runs only in that regular localhost popup,
not in an extension-privileged page. The OAuth token is passed through an
origin/window/nonce-checked message and dedicated message port, never a URL,
log, local storage, or the AI prompt. Only parsed comment data goes to the
sidecar and the selected AI provider.

The reader includes open and resolved threads, authors, dates, replies, and
Google's quoted text when present. It follows pagination, excludes deleted
items, and marks bounded or failed reads as partial/unavailable rather than
claiming no comments exist. Missing or ambiguous quotes have no invented
document offset. The existing `writer_list_comments` tool exposes the
threads and read status to Claude/Codex. Copied documents contain only the
comments actually copied into them; connect the original to read its threads.

Tests: `tests/chrome-drive-comments.test.ts` covers parsing/pagination/limits;
`tests/chrome-comment-picker.test.ts` covers popup origin/nonce/file checks
and cancellation; host, prompt, and API tests cover delivery and access state.

### Selection-aware comment context

When a request uses a highlighted passage, the sidecar locates comment quotes
in the current document and puts matching threads first in the agent prompt.
It decodes escaped entities, tolerates whitespace and typographic quotation
marks, and revalidates saved offsets. Labels distinguish overlapping anchors,
same-paragraph context, and nearby context (up to 400 characters in an adjacent
paragraph). Nearby context is not a claim that a comment is attached to the
selected words. Repeated quotes stay ambiguous unless a verified offset
identifies their occurrence. Missing/image anchors and obsolete text are not
assigned by guessing from the comment's content.

`writer_list_comments({ scope: "selection" })` returns the relevant threads
with `selectionContext` location evidence. `scope: "all"` (the default) keeps
the complete list available. Request-scoped agents retain the highlight sent
with the request; terminal agents follow the current live highlight. No
comment-writing permission or additional extension permission is needed.

Tests: `tests/comment-matching.test.ts` covers matching and prompt priority;
`tests/api.test.ts` covers live and frozen highlights. For a read-only audit
against the current document and actual prompt builder, run:

```sh
npx tsx scripts/check-comment-selection.ts "<document name>"
```

The audit reads the local sidecar only, sends no provider request, and does
not edit the document or save manuscript text as test fixtures.

### Locate in the Chrome extension

Locate uses Google Docs' visible Edit > Find and replace controls to move to
and select the passage; it never fills the replacement field or invokes a
Replace action. It verifies the passage against a fresh Docs snapshot before
searching, checks the native result count, and navigates to the requested
occurrence. Short repeated phrases gain nearby text as search context;
multiline or long suggestions use a bounded single-line excerpt. The verified
located excerpt is available to Writer's selection reader until the next
document interaction, without reading or overwriting the system clipboard.
As with copied selections, identical repeated excerpts cannot be mapped to a
unique focus offset, even though native Find can navigate to their occurrence.

The English Google Docs interface is currently required. Existing Find
preferences are preserved; if regular-expression mode is enabled, Locate asks
you to disable it rather than treating manuscript text as a search pattern.
An already-open Find and replace dialog is left untouched. Changed text,
unexpected native search results, and missing controls produce an error on
the suggestion instead of silently doing nothing. Direct image selection is
not supported by the Chrome host; locate nearby text or a caption instead.

After installing an extension build with Locate support, reload the extension
and refresh the Google Doc so its new content script is injected. Tests in
`tests/chrome-locate.test.ts` cover planning, message routing, Find-only UI
interaction, repeated matches, and invalidation of located selection context.
