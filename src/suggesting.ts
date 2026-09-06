import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import type { Mark as ProseMirrorMark } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { ySyncPluginKey } from "y-prosemirror";

/**
 * Suggesting mode: the two suggestion marks plus a router that, while the
 * local user is in Suggesting mode, turns edits into suggestions instead of
 * plain changes — newly typed text gets an insertion mark, and deletions of
 * accepted text are re-inserted wearing a deletion mark (strikethrough) so a
 * suggested deletion stays visible until someone accepts it. Deleting your own
 * not-yet-accepted insertion really removes it. Marks live in the
 * ProseMirror/Yjs doc, so y-prosemirror syncs them to every collaborator and
 * persists them across refresh for free.
 */

export interface SuggestionAuthor {
  author: string;
  authorName: string;
  color: string;
  role: "human" | "ai";
}

function suggestionAttributes() {
  return {
    changeId: { default: null },
    author: { default: null },
    authorName: { default: null },
    role: { default: "human" },
    color: { default: "#1a73e8" },
    createdAt: { default: null }
  };
}

export const SuggestionInsertion = Mark.create({
  name: "suggestionInsertion",
  inclusive: false,
  excludes: "",
  addAttributes: suggestionAttributes,
  parseHTML() {
    return [{ tag: "span[data-suggestion-insertion]" }];
  },
  renderHTML({ HTMLAttributes, mark }) {
    return ["span", mergeAttributes(HTMLAttributes, {
      "data-suggestion-insertion": "true",
      "data-change-id": (mark.attrs.changeId as string) ?? "",
      "data-author": (mark.attrs.authorName as string) ?? "",
      class: "suggestion-insertion",
      style: `--suggestion-color: ${(mark.attrs.color as string) ?? "#1a73e8"}`,
      title: mark.attrs.authorName ? `Suggested insertion by ${mark.attrs.authorName as string}` : "Suggested insertion"
    }), 0];
  }
});

export const SuggestionDeletion = Mark.create({
  name: "suggestionDeletion",
  inclusive: false,
  excludes: "",
  addAttributes: suggestionAttributes,
  parseHTML() {
    return [{ tag: "span[data-suggestion-deletion]" }];
  },
  renderHTML({ HTMLAttributes, mark }) {
    return ["span", mergeAttributes(HTMLAttributes, {
      "data-suggestion-deletion": "true",
      "data-change-id": (mark.attrs.changeId as string) ?? "",
      "data-author": (mark.attrs.authorName as string) ?? "",
      class: "suggestion-deletion",
      style: `--suggestion-color: ${(mark.attrs.color as string) ?? "#1a73e8"}`,
      title: mark.attrs.authorName ? `Suggested deletion by ${mark.attrs.authorName as string}` : "Suggested deletion"
    }), 0];
  }
});

export interface SuggestingRouterOptions {
  isSuggesting: () => boolean;
  getAuthor: () => SuggestionAuthor;
}

/** Exported so programmatic mark writers (resolution, import materialization)
 * can stamp their transactions to skip the router's re-routing. */
export const suggestingRouterKey = new PluginKey("suggesting-router");

/**
 * Resolve one suggestion (all mark ranges sharing a changeId) per the locked
 * semantics: accepting an insertion keeps the text and drops the mark;
 * rejecting deletes it. Accepting a deletion removes the struck text;
 * rejecting drops the mark (text returns to normal). A replacement is a
 * deletion + insertion sharing one changeId, so both resolve in one call —
 * and one transaction, so a single undo reverses the whole resolution.
 * Idempotent: resolving an unknown/already-resolved changeId is a no-op.
 * Works from any editor (resolution is an ordinary document transaction that
 * syncs through Yjs), regardless of the resolver's own edit mode — the
 * router-skip meta keeps the resolution's deletions from being re-routed
 * into fresh suggestion marks.
 */
/**
 * Materialize a proposal as suggestion marks: strike the matched original
 * with a deletion mark and insert the replacement text after it wearing an
 * insertion mark, both under ONE changeId — the same shape a human replacement
 * produces in Suggesting mode. The result is a pending inline suggestion
 * anyone can accept/reject (and it syncs like any other document content).
 * Returns the changeId, or null if the range is invalid. One transaction, so
 * one undo removes the whole materialized suggestion.
 */
export function applyReplacementAsSuggestionMarks(
  editor: { state: EditorState; view: { dispatch: (tr: Transaction) => void } },
  range: { from: number; to: number },
  replacement: string,
  author: SuggestionAuthor
): string | null {
  const state = editor.state;
  const insertionType = state.schema.marks.suggestionInsertion;
  const deletionType = state.schema.marks.suggestionDeletion;
  if (!insertionType || !deletionType) {
    return null;
  }
  const docSize = state.doc.content.size;
  const from = Math.max(0, Math.min(range.from, docSize));
  const to = Math.max(from, Math.min(range.to, docSize));
  if (to <= from && !replacement) {
    return null;
  }
  const changeId = `sug-${from}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const attrs = {
    changeId,
    author: author.author,
    authorName: author.authorName,
    role: author.role,
    color: author.color,
    createdAt: new Date().toISOString()
  };
  const tr = state.tr;
  tr.setMeta(suggestingRouterKey, true);
  const paragraphType = state.schema.nodes.paragraph;
  const segments = replacement.split(/\s*\n+\s*/).map((part) => part.trim()).filter(Boolean);
  if (segments.length > 1 && paragraphType) {
    // Multi-paragraph replacement (a structural edit, e.g. an approved
    // reorganization): insert whole paragraph nodes after the block that
    // contains the end of the strike, each wearing the insertion mark.
    // Flattening these to spaces (the old v1 behavior) silently merged a
    // reordered document into one giant paragraph on accept.
    const insertPos = state.doc.resolve(to).end() + 1;
    const paragraphs = segments.map((segment) =>
      paragraphType.create(null, state.schema.text(segment, [insertionType.create(attrs)])));
    tr.insert(Math.min(insertPos, state.doc.content.size), paragraphs);
  } else if (segments.length) {
    // Inline replacement: insert after the original first so the strike
    // range stays put.
    tr.insert(to, state.schema.text(segments.join(" "), [insertionType.create(attrs)]));
  }
  if (to > from) {
    tr.addMark(from, to, deletionType.create(attrs));
  }
  editor.view.dispatch(tr);
  return changeId;
}

export function resolveSuggestionMarks(
  editor: { state: EditorState; view: { dispatch: (tr: Transaction) => void } },
  target: { changeId: string } | { changeIds: string[] } | { from: number; to: number },
  decision: "accept" | "reject"
): boolean {
  const state = editor.state;
  const insertionType = state.schema.marks.suggestionInsertion;
  const deletionType = state.schema.marks.suggestionDeletion;
  if (!insertionType || !deletionType) {
    return false;
  }
  // A review card covers a CLUSTER of adjacent marks, which may span multiple
  // changeIds (a replacement = a deletion strike + an insertion typed
  // separately). Cards therefore target the changeId SET of their cluster —
  // never a bare range, which would sweep other authors' overlapping marks
  // (two agents proposing against the same sentence stack deletion marks on
  // the same text). Range targeting remains as a fallback for stale callers.
  const changeIdSet = "changeIds" in target
    ? new Set(target.changeIds)
    : "changeId" in target
      ? new Set([target.changeId])
      : null;
  const rangeFrom = "from" in target ? target.from : 0;
  const rangeTo = "to" in target ? target.to : 0;
  const segments: Array<{ from: number; to: number; kind: "insertion" | "deletion"; mark: ProseMirrorMark }> = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText) {
      return;
    }
    const nodeFrom = pos;
    const nodeTo = pos + node.nodeSize;
    for (const mark of node.marks) {
      const kind = mark.type === insertionType ? "insertion" : mark.type === deletionType ? "deletion" : null;
      if (!kind) {
        continue;
      }
      const matches = changeIdSet ? changeIdSet.has(mark.attrs.changeId as string) : nodeFrom < rangeTo && nodeTo > rangeFrom;
      if (matches) {
        segments.push({ from: nodeFrom, to: nodeTo, kind, mark });
      }
    }
  });
  if (!segments.length) {
    return false;
  }
  const tr = state.tr;
  tr.setMeta(suggestingRouterKey, true);
  // Back-to-front so deletions never shift the positions of segments still
  // to be processed. Deleting the same span twice (text carrying two authors'
  // deletion marks) is prevented by tracking deleted ranges.
  segments.sort((a, b) => b.from - a.from);
  const deleted: Array<{ from: number; to: number }> = [];
  for (const segment of segments) {
    if (deleted.some((range) => range.from <= segment.from && range.to >= segment.to)) {
      continue;
    }
    const keepText = (segment.kind === "insertion") === (decision === "accept");
    if (keepText) {
      // Remove this mark INSTANCE only: text struck by two authors keeps the
      // other author's deletion mark when this one is rejected.
      tr.removeMark(segment.from, segment.to, segment.mark);
    } else {
      tr.delete(segment.from, segment.to);
      deleted.push({ from: segment.from, to: segment.to });
    }
  }
  // A block whose entire content was suggestion text just deleted (accepting
  // a whole-paragraph strike, or rejecting an inserted paragraph) is now an
  // empty shell — remove it rather than leaving blank lines behind.
  if (deleted.length) {
    const emptyBlocks: Array<{ from: number; to: number }> = [];
    tr.doc.descendants((node, pos) => {
      if (!node.isTextblock) {
        return true;
      }
      if (node.content.size === 0 && tr.doc.resolve(pos).depth === 0) {
        const touched = deleted.some((range) => {
          const mapped = tr.mapping.map(range.from);
          return mapped > pos && mapped < pos + node.nodeSize;
        });
        if (touched) {
          emptyBlocks.push({ from: pos, to: pos + node.nodeSize });
        }
      }
      return false;
    });
    emptyBlocks.sort((a, b) => b.from - a.from);
    for (const block of emptyBlocks) {
      if (tr.doc.childCount > 1) {
        tr.delete(block.from, block.to);
      }
    }
  }
  editor.view.dispatch(tr);
  return true;
}

export const SuggestingRouter = Extension.create<SuggestingRouterOptions>({
  name: "suggestingRouter",

  addOptions() {
    return {
      isSuggesting: () => false,
      getAuthor: () => ({ author: "", authorName: "", color: "#1a73e8", role: "human" })
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key: suggestingRouterKey,
        appendTransaction(transactions, oldState, newState) {
          if (!options.isSuggesting()) {
            return null;
          }
          // Skip remote (Yjs) syncs and our own marking pass to avoid loops and
          // double-marking collaborators' text — and skip undo/redo, whose
          // inverse steps must replay verbatim, not be re-routed into new
          // suggestions. Also skip programmatic content replacement
          // (editor.commands.setContent stamps "preventUpdate"): loading a
          // document, opening a session, or importing a DOCX must never mark
          // the whole doc as the current author's suggested insertion. Callers
          // also gate isSuggesting via a suppress flag, but this keeps the
          // router correct even for an unguarded content reset.
          if (transactions.some((transaction) => (
            transaction.getMeta(ySyncPluginKey)
            || transaction.getMeta(suggestingRouterKey)
            || transaction.getMeta("history$")
            || transaction.getMeta("y-undo$")
            || transaction.getMeta("preventUpdate")
          ))) {
            return null;
          }
          if (!transactions.some((transaction) => transaction.docChanged)) {
            return null;
          }

          const author = options.getAuthor();
          const insertionType = newState.schema.marks.suggestionInsertion;
          const deletionType = newState.schema.marks.suggestionDeletion;

          // Collect every inserted range, expressed in final-document coords by
          // mapping forward through the steps that follow each insertion.
          const ranges: Array<{ from: number; to: number }> = [];
          // Collect removed text to re-insert as suggested deletions: position
          // (final-document coords), the removed text pieces with their
          // original marks, and how the cursor should behave afterwards.
          interface RemovedPiece { marks: ProseMirrorMark[]; text: string }
          interface Removal { forward: boolean; hadInsertion: boolean; pieces: RemovedPiece[]; pos: number }
          const removals: Removal[] = [];
          transactions.forEach((transaction, transactionIndex) => {
            transaction.steps.forEach((step, stepIndex) => {
              if (!(step instanceof ReplaceStep)) {
                return;
              }
              if (step.slice.content.size > 0) {
                let from = step.from;
                let to = step.from + step.slice.content.size;
                for (let i = stepIndex + 1; i < transaction.steps.length; i += 1) {
                  const map = transaction.steps[i].getMap();
                  from = map.map(from, -1);
                  to = map.map(to, 1);
                }
                for (let t = transactionIndex + 1; t < transactions.length; t += 1) {
                  transactions[t].steps.forEach((laterStep) => {
                    const map = laterStep.getMap();
                    from = map.map(from, -1);
                    to = map.map(to, 1);
                  });
                }
                if (to > from) {
                  ranges.push({ from, to });
                }
              }

              if (step.from >= step.to) {
                return;
              }
              const docBefore = transaction.docs[stepIndex];
              // v1: only inline deletions inside one block are routed into
              // deletion marks; structural removals (whole paragraphs, list
              // items) pass through as real deletions.
              const removedSlice = docBefore.slice(step.from, step.to);
              if (removedSlice.openStart > 0 || removedSlice.openEnd > 0) {
                return;
              }
              let structural = false;
              removedSlice.content.forEach((node) => {
                if (!node.isInline) {
                  structural = true;
                }
              });
              if (structural) {
                return;
              }

              const pieces: RemovedPiece[] = [];
              docBefore.nodesBetween(step.from, step.to, (node, nodePos) => {
                if (!node.isText || !node.text) {
                  return;
                }
                const pieceFrom = Math.max(step.from, nodePos);
                const pieceTo = Math.min(step.to, nodePos + node.nodeSize);
                if (pieceTo <= pieceFrom) {
                  return;
                }
                const text = node.text.slice(pieceFrom - nodePos, pieceTo - nodePos);
                if (!text) {
                  return;
                }
                // Deleting your own not-yet-accepted insertion really removes it.
                const ownInsertion = node.marks.some((mark) => mark.type === insertionType && mark.attrs.author === author.author);
                if (ownInsertion) {
                  return;
                }
                pieces.push({ marks: [...node.marks], text });
              });
              if (!pieces.length) {
                return;
              }

              let pos = step.from;
              for (let i = stepIndex + 1; i < transaction.steps.length; i += 1) {
                pos = transaction.steps[i].getMap().map(pos, -1);
              }
              for (let t = transactionIndex + 1; t < transactions.length; t += 1) {
                transactions[t].steps.forEach((laterStep) => {
                  pos = laterStep.getMap().map(pos, -1);
                });
              }
              removals.push({
                // Backspace arrives with the caret at the removed range's end;
                // forward-delete (and select-then-edit) starts at its start.
                forward: oldState.selection.from <= step.from,
                hadInsertion: step.slice.content.size > 0,
                pieces,
                pos
              });
            });
          });
          if (!ranges.length && !removals.length) {
            return null;
          }

          const tr = newState.tr;
          ranges.forEach(({ from, to }) => {
            const safeFrom = Math.max(0, Math.min(from, newState.doc.content.size));
            const safeTo = Math.max(safeFrom, Math.min(to, newState.doc.content.size));
            if (safeTo <= safeFrom) {
              return;
            }
            // Group contiguous typing: reuse the adjacent same-author insertion
            // MARK INSTANCE, not just its changeId — a fresh mark per keystroke
            // differs in createdAt, so ProseMirror can't merge the text runs and
            // every character becomes its own DOM span / Yjs formatting range.
            const before = newState.doc.resolve(safeFrom).nodeBefore?.marks ?? [];
            const adjacent = before.find((mark) => mark.type === insertionType && mark.attrs.author === author.author);
            tr.addMark(safeFrom, safeTo, adjacent ?? insertionType.create({
              changeId: `sug-${newState.doc.content.size}-${Math.floor(Math.random() * 1e9).toString(36)}`,
              author: author.author,
              authorName: author.authorName,
              role: author.role,
              color: author.color,
              createdAt: new Date().toISOString()
            }));
          });

          removals.forEach((removal) => {
            const mappedPos = Math.max(0, Math.min(tr.mapping.map(removal.pos, -1), tr.doc.content.size));
            // Reuse a neighboring same-author deletion mark so consecutive
            // Backspaces (struck text grows leftward — check nodeAfter too)
            // merge into one struck run instead of a span-per-character with a
            // fresh changeId each keystroke.
            const $pos = tr.doc.resolve(mappedPos);
            const neighborMarks = [...($pos.nodeBefore?.marks ?? []), ...($pos.nodeAfter?.marks ?? [])];
            const deletionMark = neighborMarks.find((mark) => mark.type === deletionType && mark.attrs.author === author.author)
              ?? deletionType.create({
                changeId: `sug-${mappedPos}-${Math.floor(Math.random() * 1e9).toString(36)}`,
                author: author.author,
                authorName: author.authorName,
                role: author.role,
                color: author.color,
                createdAt: new Date().toISOString()
              });
            const nodes = removal.pieces.map((piece) => {
              const alreadyDeleted = piece.marks.some((mark) => mark.type === deletionType);
              if (alreadyDeleted) {
                return newState.schema.text(piece.text, piece.marks);
              }
              return newState.schema.text(piece.text, [...piece.marks, deletionMark]);
            });
            tr.insert(mappedPos, nodes);
            // Caret rule for pure deletions: forward-delete steps past the
            // struck text (repeated Delete walks onward); backspace stays
            // before it (repeated Backspace walks leftward). Without this the
            // caret can loop forever on the same already-struck character.
            if (!removal.hadInsertion) {
              const insertedSize = removal.pieces.reduce((size, piece) => size + piece.text.length, 0);
              const caret = removal.forward ? mappedPos + insertedSize : mappedPos;
              tr.setSelection(TextSelection.create(tr.doc, Math.max(0, Math.min(caret, tr.doc.content.size))));
            }
          });

          if (!tr.steps.length) {
            return null;
          }
          tr.setMeta(suggestingRouterKey, true);
          return tr;
        }
      })
    ];
  }
});
