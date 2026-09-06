# Suggesting mode — design

A Google-Docs-style suggesting experience where humans and the AI produce the
**same kind of tracked change**, visible inline to everyone, accepted or
rejected by anyone. This replaces the current split model (AI proposals in the
session review queue + a private diff-based audit log of human edits) with one
unified concept backed by the collaborative document itself.

## Decisions (locked)

- **Who suggests:** both humans and AI, via a per-user mode toggle. AI always
  suggests (never auto-applies).
- **Default mode in a shared doc:** Editing (direct edits); switch to Suggesting
  per user when review is wanted.
- **Accept/reject authority:** anyone in the document, with attribution.

## The model

A **suggestion** is carried in the ProseMirror/Yjs document as marks, not as a
side overlay:

- **Insertion** — text is present, wearing a `suggestionInsertion` mark
  `{ changeId, author, authorName, role: "human" | "ai", color, createdAt }`.
  Rendered underlined in the author's color. Accept = drop the mark (text
  stays). Reject = delete the text.
- **Deletion** — text is **kept**, wearing a `suggestionDeletion` mark with the
  same attrs. Rendered strikethrough. Accept = remove the text. Reject = drop
  the mark. (A suggested deletion does not disappear until accepted — the
  behavior the current model lacks.)
- A **replacement** = a deletion mark over the old text + an insertion mark of
  the new text sharing one `changeId`, surfaced as one review card.

Marks live in the Yjs doc, so y-prosemirror syncs them to every collaborator
and persists them automatically — refresh and cross-user are solved with no
localStorage shim. Accept/reject are ordinary document transactions everyone
sees, and they are naturally idempotent (accepting an already-resolved change
is a no-op), so no compare-and-swap is needed.

## Modes

Per-user, local (not shared), persisted per browser:

- **Editing** — keystrokes apply directly to the text (today's behavior).
  Direct edits are not tracked, matching Google Docs.
- **Suggesting** — keystrokes become suggestion marks: typed text gets an
  insertion mark; deleting accepted text converts the deletion into a deletion
  mark; deleting your own not-yet-accepted insertion really removes it.
- **Clean/marked view** — a visual toggle to preview the document with all
  suggestions applied (insertions plain, deletions hidden) vs. fully marked.

AI always produces suggestions regardless of the human's mode.

## How the existing pieces map

- **AI proposals** are applied to the doc as agent-authored suggestion marks
  (deletion over the matched original + insertion of the replacement, one
  changeId, author = provider/"Agent"), appearing inline for everyone the
  moment they are generated. The sidecar/bridge still *generates* proposals;
  the result is written to the doc as marks instead of into a separate session
  store.
- **The review sidebar** becomes a synced index over the in-doc suggestions:
  jump to, filter by author, accept/reject, and bulk actions ("accept all from
  Agent", "accept all in section"). It reads the marks, it is not a second
  source of truth.
- **Import** brings a DOCX's tracked changes in *as* suggestion marks (source
  revisions become real, actionable suggestions rather than read-only
  highlights).
- **Export** maps suggestion marks → Word tracked changes (reuses the existing
  source-based tracked-change export, reading from marks).
- **MCP / agents** read the suggestion list from the live document marks and
  apply accept/reject as document edits, so an agent participates exactly like a
  human (same operations, visible in the UI).

## What this retires

- The diff-based human audit log (`editorTrackedChanges`, `classifyUserEdit`
  coalescing, the per-browser persistence) — superseded by real suggestion
  marks. Direct edits in Editing mode are intentionally untracked.
- The session-stored AI suggestion queue as a separate data model — folded into
  doc marks (the session keeps title/chat/metadata).

## Architecture notes

- **Schema:** two TipTap mark extensions (`suggestionInsertion`,
  `suggestionDeletion`) carrying the attrs above; inline marks over the existing
  schema.
- **Routing edits to marks (Suggesting mode):** a ProseMirror plugin that, via
  `appendTransaction`/transaction rewriting, (a) adds the insertion mark to
  newly inserted text, and (b) rewrites deletions of accepted text into
  deletion marks (re-inserting the text marked deleted) while letting deletions
  of one's own insertion-marked text pass through as real removals. This is the
  hardest piece; it follows established track-changes patterns (prosemirror
  changeset / Fidus / CKEditor), implemented custom since no turnkey TipTap
  extension fits.
- **Sync:** y-prosemirror already syncs marks + attrs through Yjs; accept/reject
  transactions sync the same way. No new transport.
- **Colors:** author color from the existing collab identity/awareness.

## Known v1 limitations

- Inline text suggestions first (insert / delete / replace within a block).
  Structural changes (adding/removing paragraphs, list/heading changes) in
  Suggesting mode are out of scope for v1 — they either apply directly or are
  approximated; full structural track-changes is a later step.

## Phased build

1. **Human suggesting mode (core):** the two marks, the Editing/Suggesting
   toggle (default Editing), typing/deletion routing, inline rendering by
   author color, inline + sidebar accept/reject (anyone), Yjs sync verified
   cross-user and across refresh. Retire the diff audit log.
   — *Status: typing AND deletion routing are implemented (`SuggestingRouter`);
   deletions re-insert the text with a `suggestionDeletion` mark, deleting your
   own unaccepted insertion really removes it, and undo/redo replay untouched.
   Sidebar accept/reject is implemented: `resolveSuggestionMarks` (suggesting.ts)
   resolves by changeId or by cluster range in one transaction (single undo
   reverses a whole resolution; the router-skip meta keeps resolution deletions
   from re-routing into new suggestions), and the review sidebar renders an
   "Inline suggestions" group over the document's marks with Accept/Reject per
   card. Replacement clusters spanning two changeIds resolve atomically via
   range targeting. The clean/marked view toggle is in (format bar, next to
   Track): clean view previews the document with every suggestion applied —
   insertions plain, deletions hidden — read-only while active, rendering
   only (marks untouched; sidebar resolution still works). In-document controls are in: clicking a
   suggestion mark opens a popover at the pointer with Accept/Reject for the
   whole cluster (Escape or outside click dismisses; the popover follows the
   live cluster list, so a suggestion resolved elsewhere closes it). The diff audit log's HUMAN half is retired: Editing-mode
   edits are intentionally untracked (matching Google Docs), the Track toggle
   and the keystroke-diff recorder (classifyUserEdit et al.) are gone, and
   Suggesting mode is the way to propose reviewable edits. Accepted-AI-edit
   records remain (they feed the review DOCX export's tracked changes).*
2. **AI proposals as marks:** apply AI results as agent-authored suggestion
   marks; the sidebar review queue reads the unified human + AI list from the
   doc.
   — *Status: first slice shipped. `applyReplacementAsSuggestionMarks`
   (suggesting.ts) materializes a proposal as a strike over the matched
   original + an insertion of the replacement under one changeId, and pending
   AI cards carry a "Mark inline" action that converts the session proposal
   into those marks (author = the proposer, role "ai", distinct color). The
   inline group then owns resolution. NEW AI proposals now land inline by
   DEFAULT on local unshared docs: an effect claims each fresh pending
   suggestion (status flip with expectedStatus:"pending" — the server 409s a
   second tab, so two tabs never double-materialize) and the winner writes the
   marks; proposals whose original can't be found stay in the queue for the
   existing missing-target flow, as do all proposals on cloud-shared docs
   (cross-server claiming is not yet settled). Default landing now covers SHARED docs
   too: suggestions are stamped with their staging sidecar's instanceId, and
   only that server's clients participate in the claim (remote Writers receive
   the marks through Yjs), so two servers never double-materialize — verified
   live through the relay. Remaining: retire the queue as a separate store.*
3. **Import/export + agents:** DOCX tracked changes ⇄ suggestion marks; MCP and
   the sidecar read/resolve suggestions from the live doc so agents fully
   participate.
   — *Status: the export half exists — `suggestionsFromSuggestionMarks`
   (editorOps) reads the document's marks at export time and turns each cluster
   into an anchored, author-attributed suggestion, so Suggesting-mode edits land
   in the Word review DOCX as `w:ins`/`w:del` with the suggester's name.
   Import→marks is now in: on a fresh DOCX import, Word revisions materialize
   as attributed suggestion marks (`materializeSourceTrackedChanges` in
   editorOps — inserted runs get wrapped in the accepted view, deleted runs are
   re-inserted struck-through after a context anchor with tail-fallback
   matching; unlocatable revisions stay in the read-only preview pane). The
   preview extractor keeps small revisions (one-word fixes) and anchors from
   the accepted view only. Mark-native agent APIs are still to come.*
