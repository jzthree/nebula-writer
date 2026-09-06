import { Extension } from "@tiptap/core";

/**
 * Undo must never leave the document empty.
 *
 * With the Yjs-backed history (Collaboration/y-undo), undoing all the way to a
 * text-empty document triggers a Yjs reconciliation that the undo manager
 * captures as a fresh history item — which destroys the redo stack. The
 * user-visible harm: mash Cmd-Z to clear a draft, then Cmd-Shift-Z, and the
 * draft is gone for good. resetUndoBaseline() keeps freshly-opened content out
 * of history, but a brand-new draft's baseline is still an empty paragraph, and
 * the auto-promotion room swap can reintroduce an empty transition, so this
 * guard is the timing-independent backstop.
 *
 * The guard runs undo; if that emptied a previously non-empty document, it
 * immediately redoes to bounce back to the last content-bearing state — the
 * synchronous redo lands before the reconciliation runs, so redo stays intact.
 */
export const UndoGuard = Extension.create({
  name: "undoGuard",
  // Higher priority than Collaboration so this Mod-z binding wins.
  priority: 1000,

  addKeyboardShortcuts() {
    const guardedUndo = () => {
      const editor = this.editor;
      const hadContent = editor.state.doc.textContent.trim().length > 0;
      const undone = editor.commands.undo();
      if (!undone) {
        return false;
      }
      if (hadContent && editor.state.doc.textContent.trim().length === 0) {
        // That undo emptied the document — bounce back before the empty state
        // clobbers the redo stack.
        editor.commands.redo();
      }
      return true;
    };
    return {
      "Mod-z": guardedUndo,
      "Mod-я": guardedUndo
    };
  }
});
