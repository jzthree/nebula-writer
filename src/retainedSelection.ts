import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Keeps the user's text selection visibly highlighted in the document even
 * after the editor loses focus — e.g. when they select a passage and then
 * click into the AI chat box to type an instruction about it. Browsers hide
 * the native selection highlight on an unfocused element, which made the
 * selection appear to vanish; this paints a persistent highlight so the user
 * keeps visual context of exactly what they are revising.
 */

const retainedSelectionKey = new PluginKey<DecorationSet>("retained-selection");

export const RetainedSelection = Extension.create({
  name: "retainedSelection",

  // Focus/blur don't dispatch transactions on their own, so the decorations
  // prop wouldn't recompute when the editor gains or loses focus. Nudge it with
  // an empty meta transaction so the highlight appears/disappears on cue.
  onBlur() {
    this.editor.view.dispatch(this.editor.state.tr.setMeta(retainedSelectionKey, true));
  },

  onFocus() {
    this.editor.view.dispatch(this.editor.state.tr.setMeta(retainedSelectionKey, true));
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<DecorationSet>({
        key: retainedSelectionKey,
        props: {
          decorations(state) {
            // Only when blurred: a focused editor shows the native selection.
            if (editor?.isFocused) {
              return DecorationSet.empty;
            }
            const { from, to, empty } = state.selection;
            if (empty || from === to) {
              return DecorationSet.empty;
            }
            return DecorationSet.create(state.doc, [
              Decoration.inline(from, to, { class: "retained-selection" })
            ]);
          }
        }
      })
    ];
  }
});
