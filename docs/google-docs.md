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
