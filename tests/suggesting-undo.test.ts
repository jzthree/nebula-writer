import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import { TextSelection } from "@tiptap/pm/state";
import * as Y from "yjs";
import { yUndoPluginKey } from "y-prosemirror";
import { applyReplacementAsSuggestionMarks, resolveSuggestionMarks, SuggestingRouter, SuggestionDeletion, SuggestionInsertion } from "../src/suggesting";

/**
 * Undo/redo through the suggestion-mark machinery on the COLLAB stack
 * (Collaboration = ySync + y-undo), which is what the live app runs — the
 * StarterKit history behaves differently and hid these bugs. Dogfooding
 * round 20 found: redo of an undone suggesting edit no-ops, undo of an
 * accept doesn't restore the pending marks, and the sequence can walk a
 * draft to empty.
 */

function makeCollabEditor(suggestingRef: { value: boolean }) {
  const ydoc = new Y.Doc();
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ history: false }),
      Collaboration.configure({ document: ydoc }),
      SuggestionInsertion,
      SuggestionDeletion,
      SuggestingRouter.configure({
        isSuggesting: () => suggestingRef.value,
        getAuthor: () => ({ author: "id-a", authorName: "Alice", color: "#ff0000", role: "human" })
      })
    ],
    content: ""
  });
  editor.commands.setContent("<p>The stately manor stood on the hill.</p>");
  settleUndoStep(editor);
  return editor;
}

function settleUndoStep(editor: Editor) {
  // Real interactions are spaced beyond y-undo's 500ms captureTimeout; tests
  // are not — split capture groups explicitly so each step is one undo item.
  yUndoPluginKey.getState(editor.state)?.undoManager?.stopCapturing();
}

function replaceWord(editor: Editor, word: string, replacement: string) {
  const text = editor.state.doc.textContent;
  const at = text.indexOf(word) + 1;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at, at + word.length))
  );
  editor.view.dispatch(editor.state.tr.insertText(replacement));
}

function markCount(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.isText) {
      count += node.marks.filter((mark) => mark.type.name === "suggestionInsertion" || mark.type.name === "suggestionDeletion").length;
    }
  });
  return count;
}

describe("undo/redo with suggestion marks (y-undo stack)", () => {
  it("undo then redo of a suggesting-mode edit round-trips", () => {
    const suggesting = { value: true };
    const editor = makeCollabEditor(suggesting);
    replaceWord(editor, "stately", "grand");
    settleUndoStep(editor);
    expect(markCount(editor)).toBeGreaterThan(0);
    expect(editor.state.doc.textContent).toContain("grand");

    editor.commands.undo();
    expect(editor.state.doc.textContent).toBe("The stately manor stood on the hill.");
    expect(markCount(editor)).toBe(0);

    editor.commands.redo();
    expect(editor.state.doc.textContent).toContain("grand");
    expect(markCount(editor)).toBeGreaterThan(0);
    editor.destroy();
  });

  it("undo of an ACCEPT restores the pending suggestion", () => {
    const suggesting = { value: false };
    const editor = makeCollabEditor(suggesting);
    const text = editor.state.doc.textContent;
    const at = text.indexOf("stately") + 1;
    const changeId = applyReplacementAsSuggestionMarks(editor, { from: at, to: at + 7 }, "grand", {
      author: "ai-Codex", authorName: "Codex", color: "#7b1fa2", role: "ai"
    })!;
    settleUndoStep(editor);
    expect(markCount(editor)).toBeGreaterThan(0);

    resolveSuggestionMarks(editor, { changeId }, "accept");
    settleUndoStep(editor);
    expect(editor.state.doc.textContent).toBe("The grand manor stood on the hill.");
    expect(markCount(editor)).toBe(0);

    editor.commands.undo();
    // pending suggestion is back: strike on "stately" + insertion "grand"
    expect(editor.state.doc.textContent).toBe("The statelygrand manor stood on the hill.");
    expect(markCount(editor)).toBe(2);

    editor.commands.redo();
    expect(editor.state.doc.textContent).toBe("The grand manor stood on the hill.");
    expect(markCount(editor)).toBe(0);
    editor.destroy();
  });

  it("undo storm around a resolution never empties the document", () => {
    const suggesting = { value: true };
    const editor = makeCollabEditor(suggesting);
    replaceWord(editor, "stately", "grand");
    settleUndoStep(editor);
    resolveSuggestionMarks(editor, { from: 1, to: editor.state.doc.content.size }, "accept");
    settleUndoStep(editor);
    for (let i = 0; i < 6; i++) {
      editor.commands.undo();
    }
    for (let i = 0; i < 6; i++) {
      editor.commands.redo();
    }
    expect(editor.state.doc.textContent.length).toBeGreaterThan(0);
    editor.destroy();
  });
});

describe("undo storm never destroys the document (y-undo redo survival)", () => {
  it("over-mashing undo to empty, then redo, restores the full draft", () => {
    const suggesting = { value: false };
    const editor = makeCollabEditor(suggesting);
    editor.commands.setContent("<h1>Title</h1><p>Alpha one.</p><p>Beta two.</p><p>Gamma three.</p>");
    // Make the loaded content the baseline, the way resetUndoBaseline does live.
    yUndoPluginKey.getState(editor.state)?.undoManager?.clear();

    // Type several separately-captured edits.
    for (const word of [" delta", " epsilon", " zeta"]) {
      const end = editor.state.doc.content.size - 1;
      editor.view.dispatch(editor.state.tr.insertText(word, end));
      settleUndoStep(editor);
    }
    const full = editor.state.doc.textContent;
    expect(full).toContain("delta");

    // Over-mash undo far past the stack depth.
    for (let i = 0; i < 12; i++) {
      editor.commands.undo();
    }
    // Baseline (the seeded content) survives; never emptied past it.
    expect(editor.state.doc.textContent).toContain("Alpha one.");
    expect(editor.state.doc.textContent).toContain("Title");

    // Redo brings the typed edits back.
    for (let i = 0; i < 12; i++) {
      editor.commands.redo();
    }
    expect(editor.state.doc.textContent).toContain("delta");
    expect(editor.state.doc.textContent).toContain("epsilon");
    expect(editor.state.doc.textContent).toContain("zeta");
    editor.destroy();
  });
});
