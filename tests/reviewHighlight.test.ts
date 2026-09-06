import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewHighlight, setReviewTraces } from "../src/reviewHighlight";

describe("ReviewHighlight", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("shows proposed text for pending suggestions while preserving the original document text", () => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit, ReviewHighlight],
      content: "<p>Original sentence.</p>"
    });

    setReviewTraces(editor, [{
      id: "suggestion-1",
      replacementText: "Proposed sentence.",
      status: "pending",
      title: "Tighten sentence",
      from: 1,
      to: 19
    }]);

    expect(editor.getText()).toBe("Original sentence.");
    expect(editor.view.dom.querySelector(".review-trace-pending-source")).toHaveTextContent("Original sentence.");
    expect(editor.view.dom.querySelector(".review-trace-preview-widget")).toHaveTextContent("Proposed sentence.");
  });

  it("keeps pending replacement preview text selectable without letting it mutate the editor", () => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit, ReviewHighlight],
      content: "<p>Original sentence.</p>"
    });

    setReviewTraces(editor, [{
      id: "suggestion-1",
      replacementText: "Proposed sentence.",
      status: "pending",
      title: "Tighten sentence",
      from: 1,
      to: 19
    }]);

    const preview = editor.view.dom.querySelector<HTMLElement>(".review-trace-preview-widget");
    expect(preview).not.toBeNull();
    expect(preview).toHaveAttribute("contenteditable", "true");
    expect(preview).toHaveAttribute("aria-readonly", "true");
    expect(preview).not.toHaveClass("ProseMirror-widget");

    const beforeInput = new Event("beforeinput", { bubbles: true, cancelable: true });
    expect(preview?.dispatchEvent(beforeInput)).toBe(false);
    expect(editor.getText()).toBe("Original sentence.");
  });
});
