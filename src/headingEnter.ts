import { Extension } from "@tiptap/core";

/**
 * Enter at the START of a heading inserts a paragraph ABOVE it, leaving the
 * heading intact (Google Docs behavior). ProseMirror's default splitBlock
 * instead clones an empty heading above, so anything typed there silently
 * inherits the heading format — dogfooding hit this trying to add a new
 * section above an existing one, and it took three repair steps to recover.
 * Enter elsewhere in a heading keeps its default behavior (splitting at the
 * end already produces a paragraph below).
 */
export const HeadingEnter = Extension.create({
  name: "headingEnter",

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { state } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.parentOffset !== 0) {
          return false;
        }
        const parent = $from.parent;
        if (parent.type.name !== "heading" || parent.content.size === 0) {
          return false;
        }
        const paragraph = state.schema.nodes.paragraph;
        if (!paragraph) {
          return false;
        }
        return this.editor.commands.command(({ tr, dispatch }) => {
          if (dispatch) {
            // Insert an empty paragraph before the heading; the selection maps
            // forward automatically, so the caret stays at the heading start.
            tr.insert($from.before(), paragraph.create());
          }
          return true;
        });
      }
    };
  }
});
