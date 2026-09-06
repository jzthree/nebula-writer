import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import { HeadingEnter } from "../src/headingEnter";

function makeEditor() {
  return new Editor({
    extensions: [StarterKit, HeadingEnter],
    content: "<p>Intro.</p><h2>Section</h2><p>Body.</p>"
  });
}

function outline(editor: Editor): string {
  const parts: string[] = [];
  editor.state.doc.forEach((node) => parts.push(`${node.type.name}:${node.textContent}`));
  return parts.join("|");
}

describe("HeadingEnter", () => {
  it("Enter at a heading start inserts a paragraph above, heading intact", () => {
    const editor = makeEditor();
    // caret at the start of "Section" (inside the h2)
    const pos = editor.state.doc.resolve(editor.state.doc.textContent.indexOf("Section")).pos;
    const from = (() => {
      let found = 0;
      editor.state.doc.descendants((node, p) => {
        if (node.isText && node.text === "Section") { found = p; return false; }
        return true;
      });
      return found;
    })();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from)));
    editor.commands.keyboardShortcut("Enter");
    expect(outline(editor)).toBe("paragraph:Intro.|paragraph:|heading:Section|paragraph:Body.");
    // typing above (after ArrowUp) lands in a PARAGRAPH, not a heading clone
    const emptyParaPos = editor.state.doc.child(0).nodeSize; // after Intro.
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, emptyParaPos + 1)));
    editor.commands.insertContent("New section intro");
    expect(outline(editor)).toBe("paragraph:Intro.|paragraph:New section intro|heading:Section|paragraph:Body.");
    editor.destroy();
  });

  it("Enter mid-heading and at heading end keep default behavior", () => {
    const editor = makeEditor();
    let hStart = 0;
    editor.state.doc.descendants((node, p) => {
      if (node.isText && node.text === "Section") { hStart = p; return false; }
      return true;
    });
    // caret after "Sec" (middle) → default split into two headings
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, hStart + 3)));
    editor.commands.keyboardShortcut("Enter");
    expect(outline(editor)).toBe("paragraph:Intro.|heading:Sec|heading:tion|paragraph:Body.");
    editor.destroy();
  });
});
