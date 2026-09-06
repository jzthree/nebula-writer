import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * Optional inline highlighting of a document's source revisions (the tracked
 * changes carried in from the imported DOCX). The editor shows tracked changes
 * accepted, so:
 *  - insertions / moves-in are present in the text → highlighted in place,
 *  - deletions / moves-out are gone from the text → shown as a small marker
 *    anchored after the surviving text that preceded them (contextBefore).
 * Anchors are matched by text (whitespace-flexible); a revision whose anchor
 * can't be located is simply skipped — the side list still lists it.
 */
export interface SourceRevisionMark {
  kind: "inserted" | "deleted" | "movedFrom" | "movedTo";
  text: string;
  contextBefore?: string;
}

interface SourceRevisionState {
  enabled: boolean;
  marks: SourceRevisionMark[];
}

interface SourceRevisionMeta {
  enabled?: boolean;
  marks?: SourceRevisionMark[];
}

const sourceRevisionKey = new PluginKey<SourceRevisionState>("source-revision-highlight");

export const SourceRevisionHighlight = Extension.create({
  name: "sourceRevisionHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<SourceRevisionState>({
        key: sourceRevisionKey,
        state: {
          init: () => ({ enabled: false, marks: [] }),
          apply(transaction, current) {
            const meta = transaction.getMeta(sourceRevisionKey) as SourceRevisionMeta | undefined;
            if (!meta) {
              return current;
            }
            return {
              enabled: meta.enabled ?? current.enabled,
              marks: meta.marks ?? current.marks
            };
          }
        },
        props: {
          decorations(state) {
            const revisionState = sourceRevisionKey.getState(state);
            if (!revisionState?.enabled || !revisionState.marks.length) {
              return DecorationSet.empty;
            }
            const { text, positions } = flattenDoc(state.doc);
            const decorations: Decoration[] = [];
            for (const mark of revisionState.marks) {
              const isInsertion = mark.kind === "inserted" || mark.kind === "movedTo";
              if (isInsertion) {
                const range = findRange(text, positions, mark.text);
                if (range) {
                  decorations.push(Decoration.inline(range.from, range.to, {
                    class: `source-rev source-rev-${mark.kind}`,
                    title: `${mark.kind === "movedTo" ? "Moved here" : "Inserted"} (source revision): ${truncate(mark.text, 160)}`
                  }));
                }
                continue;
              }
              // Deletion / move-out: anchor a marker after the preceding text.
              const anchor = mark.contextBefore?.trim();
              const at = anchor ? findRange(text, positions, anchor) : null;
              const pos = at ? at.to : null;
              if (pos !== null) {
                const deletedText = mark.text;
                const kind = mark.kind;
                decorations.push(Decoration.widget(pos, () => {
                  const marker = document.createElement("span");
                  marker.className = `source-rev-delete-widget source-rev-${kind}-widget`;
                  marker.textContent = kind === "movedFrom" ? "moved" : "del";
                  marker.title = `${kind === "movedFrom" ? "Moved away" : "Deleted"} (source revision): ${truncate(deletedText, 160)}`;
                  return marker;
                }, { side: 1, key: `srev-${kind}-${pos}-${deletedText.slice(0, 12)}` }));
              }
            }
            return DecorationSet.create(state.doc, decorations);
          }
        }
      })
    ];
  }
});

export function setSourceRevisionHighlight(editor: Editor, enabled: boolean, marks: SourceRevisionMark[]): void {
  editor.view.dispatch(editor.state.tr.setMeta(sourceRevisionKey, { enabled, marks }));
}

interface FlatDoc {
  text: string;
  positions: number[];
}

// Concatenate the doc's text with a parallel array mapping each character to
// its ProseMirror position, so a string match maps back to doc coordinates.
function flattenDoc(doc: ProseMirrorNode): FlatDoc {
  let text = "";
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i += 1) {
        text += node.text[i];
        positions.push(pos + i);
      }
    } else if (node.isBlock && text.length > 0 && text[text.length - 1] !== "\n") {
      text += "\n";
      positions.push(pos);
    }
    return true;
  });
  return { text, positions };
}

function findRange(haystack: string, positions: number[], needle: string): { from: number; to: number } | null {
  const trimmed = needle.trim();
  if (trimmed.length < 4) {
    return null;
  }
  const pattern = new RegExp(escapeRegExp(trimmed).replace(/\s+/g, "\\s+"));
  const match = pattern.exec(haystack);
  if (!match || match.index < 0) {
    return null;
  }
  const startChar = match.index;
  const endChar = match.index + match[0].length - 1;
  if (startChar >= positions.length || endChar >= positions.length) {
    return null;
  }
  return { from: positions[startChar], to: positions[endChar] + 1 };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}
