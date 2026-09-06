# Infinite undo/redo and document history

Design for a persistent history system for Nebula Writer, informed by Nebula
Notebook's operation-log undo system, and a recommendation on how much of it
to share with Nebula Slides.

## What the three apps have today

| | Substrate | Live undo | Persistent history |
|---|---|---|---|
| **Notebook** | Plain React state, no CRDT | Dual: CodeMirror per-cell text + operation-level stacks (insert/delete/move/updateContent/changeType) with keyframe batching | Append-only operation log with snapshots, `operationId`/`undoesOperationId` linking, persisted to `.nebula/`; redo not restored across sessions; autosave blocked while redo pending |
| **Writer** | Yjs (TipTap Collaboration + y-undo), local room + cloud DO relay | y-undo UndoManager — per-client, unbounded depth, in-memory, lost on reload | **None.** Room persistence overwrites one merged `Y.encodeStateAsUpdate` per room (`~/.nebula-writer/rooms/<id>.yup`) — every save destroys the path that led there |
| **Slides** | Yjs (node-level LWW maps), files are source of truth, Y.Doc mirrors for sync | Whole-file snapshot stacks in MCP-server memory (`src/history.ts`, cap 20, session-scoped) | Same merged-update persistence as Writer, same gap |

Two observations fall out of this table:

1. **Notebook's design does not transplant.** It is an *operation* log because
   plain state has no other record of change. Writer and Slides are CRDTs —
   the Yjs update stream **already is** an operation log, with causality and
   merge semantics built in. Our persistence currently throws that log away by
   merging. The history system for the Yjs apps is mostly "stop discarding
   what Yjs already gives us."
2. **What survives from Notebook is the concepts, not the code:** keyframes
   (reappearing here as semantic checkpoints), append-only + never rewrite,
   snapshot-at-epoch-start, and its hard-won UX lessons (blocking autosave
   during redo was a constant pain — our design avoids ever needing that).

## Two layers, one substrate

"Infinite undo/redo" conflates two different features. Keep them separate in
the UX, feed them from one substrate:

### Layer 1 — live undo/redo (exists, keep as is)

y-undo, per author, inside a session. Depth is already unbounded; in collab it
correctly undoes *your* changes only (tracked origins), which is the only
sane semantics when someone else typed since. Regression suite:
`tests/suggesting-undo.test.ts`. Nothing to build here except small polish:

- add the history-restore origin (below) to `trackedOrigins`, so a restore is
  itself undoable with Ctrl+Z;
- surface undo depth in the UI if we want ("42 steps this session").

### Layer 2 — persistent history timeline (new)

An append-only per-document **update log** plus a **checkpoint index**. This
gives version browsing, diffs, attribution, and *cross-session* undo — which
is what users actually mean by "infinite undo": "get me back to how it looked
yesterday," not "press Ctrl+Z 4,000 times."

Cross-session undo is **restore-as-forward-edit**: materialize the chosen
version, apply the difference to the live doc as one new transaction. Never
truncate or rewrite the CRDT — a collaborator (or another sidecar) may hold
concurrent changes, and a forward edit merges; a rewrite forks. This is the
Google Docs model, and it is the only model that survives sync.

## Storage design

```
~/.nebula-writer/rooms/
  <docId>.yup                  # merged head state (exists today, still the fast load path)
  <docId>.ylog                 # NEW: append-only update log, current epoch
  <docId>.checkpoints.jsonl    # NEW: checkpoint index
  <docId>.epoch-<n>.yup        # NEW: compacted baseline for old epochs
```

- **`.ylog`** — framed binary appends: `[u32 frameLen][u16 metaLen][meta JSON][update bytes]`.
  Meta: `{ ts, origin?, author? }`. One frame per Yjs update the room applies
  (same hook as today's debounced save — `ydoc.on("update")` — but appending
  the incremental update instead of overwriting the merged state). Text-doc
  updates are tiny; appends are O(1) and crash-safe (a torn tail frame is
  detected by length check and dropped).
- **`.checkpoints.jsonl`** — one line per checkpoint:
  `{ id, ts, label, kind: "auto" | "semantic" | "manual", epoch, logOffset, author? }`.
  A checkpoint is a *pointer into the log*, not a copy of the doc.
- **Materializing a version** = new empty `Y.Doc`, replay epoch baseline +
  log frames up to the checkpoint's offset. CRDT convergence makes this exact.
  This deliberately **avoids `gc: false` / Y.Snapshot**: delete-set retention
  would bloat the live doc in memory and on the wire forever; replay confines
  the cost to the moment someone opens the history panel.
- **Compaction** — when a `.ylog` exceeds a size threshold, fold it into an
  `epoch-<n>.yup` baseline and start a new epoch. Checkpoints inside a
  compacted epoch remain restorable if we cut epochs *at* checkpoint
  boundaries and retain per-checkpoint materialized states for coarse old
  history (configurable retention: e.g. every version < 24h, daily > 24h,
  weekly > 30d — Time-Machine-style thinning).
- **Migration**: an existing `.yup` becomes the epoch-0 baseline. No format
  break.

### Checkpoint triggers (Writer)

Semantic, not per-keystroke — Notebook's keyframe idea at document scale:

- session open / document import
- DOCX export (the state that left the building is always recoverable)
- suggestion accepted/rejected (batch: one checkpoint per resolution burst)
- agent staging burst landed
- idle boundary (~2 min of quiet after edits) — the autosave heartbeat
- manual "name this version"

### Collab and the cloud

History stays **local-first**: each sidecar logs the updates its room applies.
Logs on two sidecars sharing a doc will differ in order and batching, but
replaying either converges to the same states — that's the CRDT guarantee —
so every replica owns a complete, independently sufficient history. A restore
is a normal edit and syncs through the existing relay. **The Cloudflare DO
needs no changes and holds no history.** (It can keep its own merged state
exactly as today.)

### Attribution

Log frames record origin/author where the server knows it (connection
identity, agent staging, suggestion authors already ride the doc as mark
attrs). The history panel can then answer "who did this" per version diff —
same provenance story as suggestion marks, one layer down.

## Writer UI sketch

- History panel (reuse the autosaves affordance placement): checkpoint list
  with label, time, author chips.
- Selecting a version renders a **read-only preview** (materialized doc in a
  detached editor — the clean-view machinery already renders marks-off
  states) with a diff toggle against current.
- `Restore` applies the forward edit under origin `"history-restore"` (in
  y-undo `trackedOrigins`, so it's Ctrl-Z-able), then checkpoints
  (`kind: "manual"`, label "Restored to <version>").
- Redo pressure never blocks autosave — versions are append-only, so there is
  no Notebook-style "saving clears redo" hazard by construction.

## Shared backend or separate?

**Recommendation: one shared history engine as a library; everything above it
stays per-app. No shared service. Notebook stays on its own system.**

Concretely, three tiers:

1. **Shared — a small package (`@nebula/doc-history`)** with zero UI and zero
   app semantics: log append/replay, checkpoint index, epoch compaction,
   retention policy, restore-as-forward-edit. Writer and Slides have
   near-identical needs at this tier — both are Yjs docs in y-websocket rooms
   persisted by a local sidecar with a cloud relay, and both currently
   persist the same way (merged update file). They even share the same
   CJS-yjs-instance footgun, which the package must respect (accept the
   `Y` runtime as a parameter rather than importing yjs itself — both
   codebases already have comments warning two yjs copies silently break
   sync).

   ```ts
   createDocHistory(Y, dir, docId): {
     append(update, meta?)             // wire to ydoc.on("update")
     checkpoint(label, kind, author?)
     list(): Checkpoint[]
     materialize(checkpointId): Y.Doc  // replay, caller renders preview
     restore(liveDoc, checkpointId, origin)
     compact(policy)
   }
   ```

2. **Per-app — semantics and UI.** What a checkpoint *means* (Writer:
   suggestion resolved, DOCX exported; Slides: file save bridged, agent op
   completed), how a version is *previewed* (prose page vs slide thumbnails),
   what *restore* touches (Writer: one XmlFragment; Slides: per-slide maps —
   Slides can restore a single slide by replaying and diffing only that
   slide's maps, a per-app choice the engine doesn't need to know about).
   Slides' extra wrinkle — files as source of truth — also lives here: its
   file bridge already funnels every change into the Y.Doc (tagged
   `ORIGIN_LOCAL_FILE`), so the log captures file edits for free; restore
   must additionally write files back, which is Slides' business.

3. **Not shared — Notebook.** Different substrate (no CRDT), a working
   system, and no collab requirement. Retrofitting it onto the Yjs engine
   would mean rebuilding its document model; leave it, and let the concepts
   flow one way (keyframes → checkpoints).

**Build order:** implement the engine *inside Writer first*
(`server/doc-history.ts` next to `room-persistence.ts`), prove the API
against real usage — including the dogfood loop — then extract the package
and adopt in Slides. Extracting a proven module is mechanical; designing the
abstraction before the first consumer works is how shared code grows the
wrong joints. The one discipline to hold from day one: the module takes `Y`
and a directory, and knows nothing about sessions, suggestions, or slides.

## Why not alternatives

- **Y.Snapshot / `gc: false`** — permanent delete-set retention bloats every
  live doc and every sync message to pay for a feature used occasionally.
  Replay-from-log pays only when history is opened.
- **Persisting/rehydrating y-undo stacks** — y-undo items hold live struct
  references; serializing them is unsupported and fights the library.
  Cross-session undo via restore is simpler and collab-correct.
- **A shared history *service*** (one daemon for all apps) — operational
  coupling (versioning, restarts, auth) for zero user benefit; the agent
  gateway RFC already deliberately descoped shared daemons to `/exec` only.
- **History in the cloud DO** — breaks local-first ("neither your words nor
  your AI account leaves your machine"), adds storage cost, and is redundant:
  every sidecar's log is already complete.
