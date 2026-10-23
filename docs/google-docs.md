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

Locate is carried out by the content script (`locate.ts`). Docs paints text
on a canvas; when its accessible text layer is present (SVG rects labelled
with each run's text — Docs turns it on for some extensions, such as
Grammarly), Locate finds the passage there, scrolls it into view and
highlights it briefly, telling repeated passages apart by their order in the
document. Without that layer it scrolls to the passage's estimated position.

Neither Google Docs integration currently reads reviewer comment threads.
Their absence from AI context does not mean the document has no comments.
This selection fix does not add Drive permissions or comment access.

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
