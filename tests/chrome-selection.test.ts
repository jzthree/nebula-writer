// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocsSelectionReader, type DocsSelectionReader } from "../src/chrome/selection";
import { locateDocsSelection } from "../src/chrome/selectionMatch";

let reader: DocsSelectionReader;
let frame: HTMLIFrameElement;
let editor: HTMLDivElement;

function select(doc: Document, node: Node, start: number, end: number): void {
  const range = doc.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = doc.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function copy(text?: string): void {
  const event = new Event("copy", { bubbles: true });
  if (text !== undefined) {
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  }
  editor.dispatchEvent(event);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div class="kix-appview-editor"></div><iframe class="docs-texteventtarget-iframe"></iframe>';
  frame = document.querySelector("iframe")!;
  editor = frame.contentDocument!.createElement("div");
  editor.setAttribute("contenteditable", "true");
  editor.textContent = "\u200b\u00a0";
  frame.contentDocument!.body.append(editor);
  reader = createDocsSelectionReader(document);
});

afterEach(() => {
  reader.dispose();
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("Google Docs selection reader", () => {
  it("does not mistake placeholders or an unselected frame body for a selection", () => {
    expect(reader.read()).toBe("");
    editor.textContent = "An entire paragraph is not a selection.";
    expect(reader.read()).toBe("");
  });

  it("reads only the native selected range in the accessible editor", () => {
    editor.innerHTML = '<p><span data-ri="0">Our central hypothesis drives this study.</span></p>';
    const text = editor.querySelector("span")!.firstChild!;
    select(frame.contentDocument!, text, 4, 22);
    expect(reader.read()).toBe("central hypothesis");
    frame.contentDocument!.getSelection()!.collapse(text, 22);
    expect(reader.read()).toBe("");
  });

  it("reads a legacy document selection but ignores text in the toolbar", () => {
    const root = document.querySelector(".kix-appview-editor")!;
    root.textContent = "Selected passage";
    select(document, root.firstChild!, 0, 8);
    expect(reader.read()).toBe("Selected");
    const toolbar = document.createElement("div");
    toolbar.textContent = "Menus";
    document.body.append(toolbar);
    select(document, toolbar.firstChild!, 0, 5);
    expect(reader.read()).toBe("");
  });

  it("preserves real paragraph breaks but not soft visual line breaks", () => {
    editor.innerHTML = '<p><span data-ri="0">First line</span><span> <br role="presentation"></span><span data-ri="1">continues.</span></p><p><span data-ri="2">Second paragraph.</span></p>';
    const spans = editor.querySelectorAll("[data-ri]");
    const range = frame.contentDocument!.createRange();
    range.setStart(spans[0].firstChild!, 0);
    range.setEnd(spans[2].firstChild!, 6);
    frame.contentDocument!.getSelection()!.addRange(range);
    expect(reader.read()).toBe("First line continues.\nSecond");
  });

  it("captures a canvas passage after Docs handles Copy, without copying itself", () => {
    const extraCopy = vi.fn();
    editor.addEventListener("copy", extraCopy);
    editor.addEventListener("copy", () => {
      editor.innerHTML = '<b id="docs-internal-guid-test"><span>Exact copied passage</span></b>';
    }, { once: true });
    copy();
    expect(reader.read()).toBe("");
    vi.runAllTimers();
    expect(reader.read()).toBe("Exact copied passage");
    expect(extraCopy).toHaveBeenCalledTimes(1);
  });

  it("preserves copied paragraph breaks and normalizes CRLF", () => {
    copy("First passage.\r\nSecond passage.");
    vi.runAllTimers();
    expect(reader.read()).toBe("First passage.\nSecond passage.");
  });

  it("maps a formatted multi-paragraph copy back to the document's verbatim text", () => {
    editor.addEventListener("copy", () => {
      editor.innerHTML = '<b id="docs-internal-guid-formatted"><p><span>Material limits resolution.&nbsp;</span></p><p></p><p><span>Models</span><sup><a href="https://example.com/citation">10–15</a></sup><span> improve resolution.</span></p></b>';
    }, { once: true });
    copy();
    vi.runAllTimers();
    const original = "Material\u00a0limits resolution.\n\nModels10–15 improve resolution.";
    expect(locateDocsSelection(original.split("\n").map((text) => ({ text })), reader.read()))
      .toEqual({ startParagraph: 0, startOffset: 0, endParagraph: 2, endOffset: 31, text: original });
  });

  it("captures the export when Docs prepares it on keydown before the Copy event", () => {
    editor.dispatchEvent(new Event("keydown", { bubbles: true }));
    editor.innerHTML = '<b id="docs-internal-guid-new"><span>New selection</span></b>';
    copy();
    vi.runAllTimers();
    expect(reader.read()).toBe("New selection");
  });

  it.each(["pointerdown", "mousedown", "keydown", "beforeinput", "input", "paste", "cut"])(
    "clears copied text on %s even when stale exported markup remains", (event) => {
      editor.innerHTML = '<b id="docs-internal-guid-old">Old selection</b>';
      copy("Old selection");
      vi.runAllTimers();
      expect(reader.read()).toBe("Old selection");
      editor.dispatchEvent(new Event(event, { bubbles: true }));
      expect(reader.read()).toBe("");
    }
  );

  it("does not reuse an old export when Copy produces no new selection", () => {
    editor.innerHTML = '<b id="docs-internal-guid-old">Old selection</b>';
    select(frame.contentDocument!, editor.firstChild!.firstChild!, 0, 13);
    copy();
    vi.runAllTimers();
    expect(reader.read()).toBe("");
  });

  it("clears the passage when selection changes on the main canvas", () => {
    copy("Previous passage");
    vi.runAllTimers();
    document.querySelector(".kix-appview-editor")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(reader.read()).toBe("");
  });

  it("does not restore a pending copy after the user moves the caret", () => {
    copy("Previous passage");
    editor.dispatchEvent(new Event("keydown", { bubbles: true }));
    vi.runAllTimers();
    expect(reader.read()).toBe("");
  });

  it("does not copy the entire accessible paragraph when its range is collapsed", () => {
    editor.innerHTML = '<p><span data-ri="0">A whole paragraph</span></p>';
    copy();
    vi.runAllTimers();
    expect(reader.read()).toBe("");
  });

  it("reconnects after Docs replaces the hidden editor iframe", () => {
    copy("Old frame");
    vi.runAllTimers();
    frame.remove();
    frame = document.createElement("iframe");
    frame.className = "docs-texteventtarget-iframe";
    document.body.append(frame);
    expect(reader.read()).toBe("");
    editor = frame.contentDocument!.createElement("div");
    editor.setAttribute("contenteditable", "true");
    frame.contentDocument!.body.append(editor);
    copy("New frame");
    vi.runAllTimers();
    expect(reader.read()).toBe("New frame");
  });

  it("ignores copies outside the Docs editor frame", () => {
    document.body.dispatchEvent(new Event("copy", { bubbles: true }));
    vi.runAllTimers();
    expect(reader.read()).toBe("");
  });

  it("cancels pending work when disposed", () => {
    copy("Pending passage");
    reader.dispose();
    vi.runAllTimers();
    expect(reader.read()).toBe("");
  });
});
