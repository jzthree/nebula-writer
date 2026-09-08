import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import Underline from "@tiptap/extension-underline";
import { TextSelection } from "@tiptap/pm/state";
import { materializeSourceTrackedChanges, suggestionsFromSuggestionMarks } from "../src/editorOps";
import { applyReplacementAsSuggestionMarks, resolveSuggestionMarks, SuggestingRouter, SuggestionDeletion, SuggestionInsertion } from "../src/suggesting";

function makeEditor(suggestingRef: { value: boolean }) {
  return new Editor({
    extensions: [
      StarterKit,
      SuggestionInsertion,
      SuggestionDeletion,
      SuggestingRouter.configure({
        isSuggesting: () => suggestingRef.value,
        getAuthor: () => ({ author: "id-a", authorName: "Alice", color: "#ff0000", role: "human" })
      })
    ],
    content: "<p>Hello world.</p>"
  });
}

describe("SuggestingRouter", () => {
  it("marks typed text as an insertion suggestion only in Suggesting mode", () => {
    const suggesting = { value: false };
    const editor = makeEditor(suggesting);

    // Editing mode: inserted text is plain.
    editor.chain().focus().insertContentAt(6, "X").run();
    expect(editor.getHTML()).not.toContain("data-suggestion-insertion");

    // Suggesting mode: inserted text wears the insertion mark with attribution.
    suggesting.value = true;
    editor.chain().focus().insertContentAt(6, "Y").run();
    const html = editor.getHTML();
    expect(html).toContain("data-suggestion-insertion");
    expect(html).toContain('data-author="Alice"');
    editor.destroy();
  });

  it("groups contiguous typing under one changeId and starts a new one across a gap", () => {
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);

    editor.chain().focus().insertContentAt(6, "a").run();
    editor.chain().focus().insertContentAt(7, "b").run(); // adjacent → same change
    editor.chain().focus().insertContentAt(1, "Z").run(); // far away → new change

    const changeIds = new Set<string>();
    editor.state.doc.descendants((node) => {
      node.marks.forEach((mark) => {
        if (mark.type.name === "suggestionInsertion") {
          changeIds.add(mark.attrs.changeId as string);
        }
      });
      return true;
    });
    // "a"+"b" share one id; "Z" is a second.
    expect(changeIds.size).toBe(2);
    // And contiguous typing merges into ONE mark run (one DOM span), not a
    // span per keystroke — reusing the adjacent mark instance keeps createdAt
    // identical so ProseMirror can join the text nodes.
    expect(editor.getHTML().match(/data-suggestion-insertion/g)?.length).toBe(2);
    editor.destroy();
  });

  it("keeps deleted text as a strikethrough deletion suggestion instead of removing it", () => {
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);

    // Delete "world" (positions 7-12 inside "<p>Hello world.</p>").
    editor.chain().focus().deleteRange({ from: 7, to: 12 }).run();

    const html = editor.getHTML();
    expect(editor.state.doc.textContent).toBe("Hello world.");
    expect(html).toContain("data-suggestion-deletion");
    expect(html).toContain('data-author="Alice"');
    expect(html).toContain("world");
    editor.destroy();
  });

  it("really removes deletions in Editing mode", () => {
    const suggesting = { value: false };
    const editor = makeEditor(suggesting);

    editor.chain().focus().deleteRange({ from: 7, to: 12 }).run();

    expect(editor.state.doc.textContent).toBe("Hello .");
    expect(editor.getHTML()).not.toContain("data-suggestion-deletion");
    editor.destroy();
  });

  it("really removes the author's own unaccepted insertion when deleted", () => {
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);

    editor.chain().focus().insertContentAt(6, "XYZ").run();
    expect(editor.getHTML()).toContain("data-suggestion-insertion");
    expect(editor.state.doc.textContent).toBe("HelloXYZ world.");

    // Deleting the just-suggested insertion removes it outright — no
    // strikethrough of text that was never in the accepted document.
    editor.chain().focus().deleteRange({ from: 6, to: 9 }).run();
    expect(editor.state.doc.textContent).toBe("Hello world.");
    expect(editor.getHTML()).not.toContain("data-suggestion-deletion");
    editor.destroy();
  });

  it("marks replaced text as deletion plus insertion", () => {
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);

    // Replace "world" with "planet" in one step, as typing over a selection does.
    editor.chain().focus().insertContentAt({ from: 7, to: 12 }, "planet").run();

    const html = editor.getHTML();
    expect(editor.state.doc.textContent).toBe("Hello worldplanet.");
    expect(html).toContain("data-suggestion-deletion");
    expect(html).toContain("data-suggestion-insertion");
    editor.destroy();
  });

  it("converts suggestion marks into anchored, attributed export suggestions", () => {
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);

    // Suggest deleting "world" — the mark keeps the text in the doc.
    editor.chain().focus().deleteRange({ from: 7, to: 12 }).run();

    const suggestions = suggestionsFromSuggestionMarks(editor as never);
    expect(suggestions).toHaveLength(1);
    const [suggestion] = suggestions;
    expect(suggestion.proposedBy).toBe("Alice");
    expect(suggestion.status).toBe("pending");
    // Original carries the deleted text with surrounding context; the
    // replacement is the same context without it.
    expect(suggestion.original).toContain("world");
    expect(suggestion.original).toContain("Hello");
    expect(suggestion.replacement).not.toContain("world");
    expect(suggestion.title).toContain("deletion");
    editor.destroy();
  });

  it("converts a suggested replacement into one deletion-plus-insertion suggestion", () => {
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);

    editor.chain().focus().insertContentAt({ from: 7, to: 12 }, "planet").run();

    const suggestions = suggestionsFromSuggestionMarks(editor as never);
    expect(suggestions).toHaveLength(1);
    const [suggestion] = suggestions;
    expect(suggestion.original).toContain("world");
    expect(suggestion.original).not.toContain("planet");
    expect(suggestion.replacement).toContain("planet");
    expect(suggestion.replacement).not.toContain("world");
    expect(suggestion.title).toContain("replacement");
    editor.destroy();
  });

  it("does not mark programmatically-loaded content as a suggestion, even while suggesting", () => {
    // Loading a document, opening a session, or importing a DOCX replaces the
    // editor content via setContent while Suggesting mode may be on. That
    // content is the accepted baseline, not the author's edit — it must never
    // be marked as a suggested insertion (which would color the whole doc,
    // export it as one giant insertion, and break later deletions since they'd
    // look like "deleting your own unaccepted insertion").
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);
    editor.commands.setContent("<p>Loaded document body.</p>");

    const html = editor.getHTML();
    expect(html).not.toContain("data-suggestion-insertion");
    expect(html).not.toContain("data-suggestion-deletion");
    expect(editor.state.doc.textContent).toBe("Loaded document body.");

    // And a subsequent real deletion still routes into a strikethrough.
    editor.chain().focus().deleteRange({ from: 1, to: 7 }).run(); // "Loaded"
    expect(editor.getHTML()).toContain("data-suggestion-deletion");
    expect(editor.state.doc.textContent).toBe("Loaded document body.");
    editor.destroy();
  });

  it("walks the caret so single-key backspaces strike distinct characters (no caret loop)", () => {
    // The router re-inserts struck text where the caret sits; without the
    // caret-walk rule, repeated Backspace would re-strike the same character
    // forever. Simulate three real Backspace keystrokes at the caret.
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);
    editor.commands.setContent("<p>abcdef</p>"); // positions 1..6 = a..f

    let caret = 7; // after "f"
    for (let i = 0; i < 3; i += 1) {
      editor.chain().command(({ tr, dispatch }) => {
        tr.setSelection(TextSelection.create(tr.doc, caret));
        dispatch?.(tr);
        return true;
      }).run();
      editor.chain().focus().deleteRange({ from: caret - 1, to: caret }).run();
      caret = editor.state.selection.from;
    }

    const struck: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === "suggestionDeletion")) {
        struck.push(node.text ?? "");
      }
      return true;
    });
    // Three backspaces from the end strike three *different* trailing chars.
    expect(struck.join("").split("").sort().join("")).toBe("def");
    expect(editor.state.doc.textContent).toBe("abcdef");
    // Consecutive backspaces coalesce into one struck run (one span, one
    // changeId) rather than a fragment per keystroke.
    expect(struck.length).toBe(1);
    const deletionIds = new Set<string>();
    editor.state.doc.descendants((node) => {
      node.marks.forEach((mark) => {
        if (mark.type.name === "suggestionDeletion") {
          deletionIds.add(mark.attrs.changeId as string);
        }
      });
      return true;
    });
    expect(deletionIds.size).toBe(1);
    editor.destroy();
  });

  it("keeps undo intact after routed deletions", () => {
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);

    editor.chain().focus().deleteRange({ from: 7, to: 12 }).run();
    expect(editor.getHTML()).toContain("data-suggestion-deletion");

    editor.commands.undo();
    expect(editor.state.doc.textContent).toBe("Hello world.");
    expect(editor.getHTML()).not.toContain("data-suggestion-deletion");
    editor.destroy();
  });
});

describe("resolveSuggestionMarks", () => {
  function changeIdsOf(editor: Editor, markName: string): string[] {
    const ids: string[] = [];
    editor.state.doc.descendants((node) => {
      node.marks.forEach((mark) => {
        if (mark.type.name === markName) {
          ids.push(mark.attrs.changeId as string);
        }
      });
      return true;
    });
    return ids;
  }

  it("accepting an insertion keeps the text and drops the mark", () => {
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);
    editor.chain().focus().insertContentAt(6, "XYZ").run();
    const [changeId] = changeIdsOf(editor, "suggestionInsertion");
    expect(resolveSuggestionMarks(editor, { changeId }, "accept")).toBe(true);
    expect(editor.state.doc.textContent).toBe("HelloXYZ world.");
    expect(editor.getHTML()).not.toContain("data-suggestion-insertion");
    editor.destroy();
  });

  it("rejecting an insertion deletes the suggested text", () => {
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);
    editor.chain().focus().insertContentAt(6, "XYZ").run();
    const [changeId] = changeIdsOf(editor, "suggestionInsertion");
    expect(resolveSuggestionMarks(editor, { changeId }, "reject")).toBe(true);
    expect(editor.state.doc.textContent).toBe("Hello world.");
    expect(editor.getHTML()).not.toContain("data-suggestion-insertion");
    editor.destroy();
  });

  it("accepting a deletion removes the struck text", () => {
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);
    editor.chain().focus().deleteRange({ from: 7, to: 12 }).run(); // strike "world"
    const [changeId] = changeIdsOf(editor, "suggestionDeletion");
    expect(resolveSuggestionMarks(editor, { changeId }, "accept")).toBe(true);
    expect(editor.state.doc.textContent).toBe("Hello .");
    expect(editor.getHTML()).not.toContain("data-suggestion-deletion");
    editor.destroy();
  });

  it("rejecting a deletion restores the text to normal", () => {
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);
    editor.chain().focus().deleteRange({ from: 7, to: 12 }).run();
    const [changeId] = changeIdsOf(editor, "suggestionDeletion");
    expect(resolveSuggestionMarks(editor, { changeId }, "reject")).toBe(true);
    expect(editor.state.doc.textContent).toBe("Hello world.");
    expect(editor.getHTML()).not.toContain("data-suggestion-deletion");
    editor.destroy();
  });

  it("resolves a replacement (shared changeId) as one unit", () => {
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);
    // Replace "world" with "planet": deletion mark + insertion mark.
    editor.chain().focus().insertContentAt({ from: 7, to: 12 }, "planet").run();
    const insIds = changeIdsOf(editor, "suggestionInsertion");
    const delIds = changeIdsOf(editor, "suggestionDeletion");
    expect(insIds.length).toBeGreaterThan(0);
    expect(delIds.length).toBeGreaterThan(0);
    // Resolve the whole cluster by RANGE, as the review card does — the two
    // halves may carry different changeIds.
    const suggestions = suggestionsFromSuggestionMarks(editor as never);
    expect(suggestions).toHaveLength(1);
    const range = suggestions[0].range!;
    expect(resolveSuggestionMarks(editor, { from: range.from, to: range.to }, "accept")).toBe(true);
    expect(editor.state.doc.textContent).toBe("Hello planet.");
    expect(editor.getHTML()).not.toContain("data-suggestion");
    editor.destroy();
  });

  it("is idempotent: resolving an unknown changeId is a no-op", () => {
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);
    editor.chain().focus().insertContentAt(6, "XYZ").run();
    const before = editor.getHTML();
    expect(resolveSuggestionMarks(editor, { changeId: "nope-not-real" }, "accept")).toBe(false);
    expect(editor.getHTML()).toBe(before);
    editor.destroy();
  });

  it("resolution deletions are not re-routed into new suggestions while suggesting", () => {
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);
    editor.chain().focus().insertContentAt(6, "XYZ").run();
    const [changeId] = changeIdsOf(editor, "suggestionInsertion");
    // Resolver is ALSO in suggesting mode; rejecting must really delete,
    // not strike the text through as a fresh suggested deletion.
    resolveSuggestionMarks(editor, { changeId }, "reject");
    expect(editor.state.doc.textContent).toBe("Hello world.");
    expect(editor.getHTML()).not.toContain("data-suggestion-deletion");
    editor.destroy();
  });

  it("one undo reverses a whole resolution", () => {
    const suggesting = { value: true };
    const editor = makeEditor(suggesting);
    editor.chain().focus().deleteRange({ from: 7, to: 12 }).run();
    const [changeId] = changeIdsOf(editor, "suggestionDeletion");
    resolveSuggestionMarks(editor, { changeId }, "accept");
    expect(editor.state.doc.textContent).toBe("Hello .");
    editor.commands.undo();
    expect(editor.state.doc.textContent).toBe("Hello world.");
    expect(editor.getHTML()).toContain("data-suggestion-deletion");
    editor.destroy();
  });
});

describe("applyReplacementAsSuggestionMarks", () => {
  const aiAuthor = { author: "ai-codex", authorName: "Codex", color: "#7b1fa2", role: "ai" as const };

  it("materializes a proposal as strike + insertion under one changeId", () => {
    const suggesting = { value: false };
    const editor = makeEditor(suggesting);
    // "world" at 7-12 → replace with "planet"
    const changeId = applyReplacementAsSuggestionMarks(editor, { from: 7, to: 12 }, "planet", aiAuthor);
    expect(changeId).toBeTruthy();
    expect(editor.state.doc.textContent).toBe("Hello worldplanet.");
    const html = editor.getHTML();
    expect(html).toContain("data-suggestion-deletion");
    expect(html).toContain("data-suggestion-insertion");
    expect(html).toContain('data-author="Codex"');
    const ids = new Set<string>();
    editor.state.doc.descendants((node) => {
      node.marks.forEach((mark) => {
        if (mark.type.name.startsWith("suggestion")) {
          ids.add(mark.attrs.changeId as string);
        }
      });
      return true;
    });
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(changeId);
    editor.destroy();
  });

  it("accepting the materialized suggestion applies the replacement", () => {
    const suggesting = { value: false };
    const editor = makeEditor(suggesting);
    const changeId = applyReplacementAsSuggestionMarks(editor, { from: 7, to: 12 }, "planet", aiAuthor)!;
    expect(resolveSuggestionMarks(editor, { changeId }, "accept")).toBe(true);
    expect(editor.state.doc.textContent).toBe("Hello planet.");
    expect(editor.getHTML()).not.toContain("data-suggestion");
    editor.destroy();
  });

  it("rejecting the materialized suggestion restores the original", () => {
    const suggesting = { value: false };
    const editor = makeEditor(suggesting);
    const changeId = applyReplacementAsSuggestionMarks(editor, { from: 7, to: 12 }, "planet", aiAuthor)!;
    expect(resolveSuggestionMarks(editor, { changeId }, "reject")).toBe(true);
    expect(editor.state.doc.textContent).toBe("Hello world.");
    expect(editor.getHTML()).not.toContain("data-suggestion");
    editor.destroy();
  });

  it("supports pure deletions (empty replacement) and flattens multiline replacements", () => {
    const suggesting = { value: false };
    const editor = makeEditor(suggesting);
    const delId = applyReplacementAsSuggestionMarks(editor, { from: 7, to: 12 }, "", aiAuthor)!;
    expect(editor.state.doc.textContent).toBe("Hello world.");
    expect(editor.getHTML()).toContain("data-suggestion-deletion");
    resolveSuggestionMarks(editor, { changeId: delId }, "accept");
    expect(editor.state.doc.textContent).toBe("Hello .");

    const multiId = applyReplacementAsSuggestionMarks(editor, { from: 1, to: 6 }, "Hi\nthere", aiAuthor)!;
    expect(multiId).toBeTruthy();
    // Paragraph breaks in the replacement land as REAL paragraphs (marked as
    // insertions), not flattened into the current block.
    expect(editor.state.doc.childCount).toBe(3);
    resolveSuggestionMarks(editor, { changeId: multiId }, "accept");
    expect(editor.getHTML()).toBe("<p> .</p><p>Hi</p><p>there</p>");
    editor.destroy();
  });

  it("structural accept/reject cleans up emptied blocks", () => {
    const suggesting = { value: false };
    const editor = makeEditor(suggesting);
    editor.commands.setContent("<p>alpha one.</p><p>beta two.</p><p>gamma three.</p>");
    // Replace the ENTIRE document with a reordered two-paragraph version —
    // the shape an approved reorganization stages.
    const docText = editor.state.doc.textContent;
    const changeId = applyReplacementAsSuggestionMarks(
      editor,
      { from: 1, to: 1 + docText.length + 4 /* across block bounds */ },
      "gamma three.\nalpha one.",
      aiAuthor
    )!;
    expect(changeId).toBeTruthy();
    resolveSuggestionMarks(editor, { changeId }, "accept");
    // Struck paragraphs are gone WITHOUT leaving empty shells.
    expect(editor.getHTML()).toBe("<p>gamma three.</p><p>alpha one.</p>");

    // Rejecting a multi-paragraph insertion removes the inserted blocks too.
    const rejectId = applyReplacementAsSuggestionMarks(editor, { from: 1, to: 1 }, "spam one\nspam two", aiAuthor)!;
    expect(editor.state.doc.childCount).toBe(4);
    resolveSuggestionMarks(editor, { changeId: rejectId }, "reject");
    expect(editor.getHTML()).toBe("<p>gamma three.</p><p>alpha one.</p>");
    editor.destroy();
  });
});

describe("materializeSourceTrackedChanges", () => {
  it("wraps inserted-revision text with an insertion mark", () => {
    const suggesting = { value: false };
    const editor = makeEditor(suggesting);
    editor.commands.setContent("<p>Hello brave new world.</p>");
    const { materialized } = materializeSourceTrackedChanges(editor as never, [
      { kind: "inserted", text: "brave new", author: "Reviewer A", contextBefore: "Hello" }
    ]);
    expect(materialized).toBe(1);
    const html = editor.getHTML();
    expect(html).toContain("data-suggestion-insertion");
    expect(html).toContain('data-author="Reviewer A"');
    expect(editor.state.doc.textContent).toBe("Hello brave new world.");
    editor.destroy();
  });

  it("re-inserts deleted-revision text struck through after its anchor", () => {
    const suggesting = { value: false };
    const editor = makeEditor(suggesting);
    editor.commands.setContent("<p>Hello world.</p>");
    const { materialized } = materializeSourceTrackedChanges(editor as never, [
      { kind: "deleted", text: " cruel", author: "Reviewer B", contextBefore: "Hello" }
    ]);
    expect(materialized).toBe(1);
    expect(editor.state.doc.textContent).toBe("Hello cruel world.");
    expect(editor.getHTML()).toContain("data-suggestion-deletion");
    editor.destroy();
  });

  it("skips unlocatable revisions and moved text", () => {
    const suggesting = { value: false };
    const editor = makeEditor(suggesting);
    editor.commands.setContent("<p>Hello world.</p>");
    const { materialized, remaining } = materializeSourceTrackedChanges(editor as never, [
      { kind: "inserted", text: "totally absent text", author: "X" },
      // context EXISTS but is not in this document — placement is ambiguous
      { kind: "deleted", text: "gone", author: "X", contextBefore: "no such anchor" },
      { kind: "movedTo", text: "world", author: "X" }
    ]);
    expect(materialized).toBe(0);
    expect(remaining).toHaveLength(3);
    expect(editor.state.doc.textContent).toBe("Hello world.");
    editor.destroy();
  });

  it("materializes an anchor-less deletion at the document start", () => {
    const suggesting = { value: false };
    const editor = makeEditor(suggesting);
    editor.commands.setContent("<p>Hello world.</p>");
    // No contextBefore at all = nothing in the accepted view precedes the
    // deletion (a struck first paragraph) — the document start is correct.
    const { materialized } = materializeSourceTrackedChanges(editor as never, [
      { kind: "deleted", text: "Struck opening paragraph. ", author: "X" }
    ]);
    expect(materialized).toBe(1);
    expect(editor.state.doc.textContent).toBe("Struck opening paragraph. Hello world.");
    expect(editor.getHTML()).toContain("data-suggestion-deletion");
    editor.destroy();
  });

  it("materialized revisions resolve like any inline suggestion", () => {
    const suggesting = { value: false };
    const editor = makeEditor(suggesting);
    editor.commands.setContent("<p>Hello world.</p>");
    materializeSourceTrackedChanges(editor as never, [
      { kind: "deleted", text: " cruel", author: "Reviewer B", contextBefore: "Hello" }
    ]);
    const suggestions = suggestionsFromSuggestionMarks(editor as never);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].proposedBy).toBe("Reviewer B");
    const range = suggestions[0].range!;
    resolveSuggestionMarks(editor, { from: range.from, to: range.to }, "accept");
    expect(editor.state.doc.textContent).toBe("Hello world.");
    expect(editor.getHTML()).not.toContain("data-suggestion");
    editor.destroy();
  });
});

describe("suggestion marks: inline emphasis", () => {
  it("inserts the replacement with the emphasis marks its spans ask for", () => {
    const editor = new Editor({
      extensions: [StarterKit, Underline, Highlight, SuggestionInsertion, SuggestionDeletion],
      content: "<p>Hello world.</p>"
    });
    try {
      const changeId = applyReplacementAsSuggestionMarks(editor, { from: 1, to: 6 }, "Greetings", { author: "ai", authorName: "AI", color: "#7b1fa2", role: "ai" }, [{ start: 0, end: 9, bold: true, underline: true }]);
      expect(changeId).toBeTruthy();
      const html = editor.getHTML();
      expect(html).toMatch(/<strong><u><(?:ins|span)[^>]*>Greetings<\/(?:ins|span)><\/u><\/strong>|<(?:ins|span)[^>]*><strong><u>Greetings<\/u><\/strong>/);
      expect(editor.getText()).toContain("HelloGreetings world.");
    } finally {
      editor.destroy();
    }
  });
});
