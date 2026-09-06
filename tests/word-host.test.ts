import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockWordHost, sampleGrantDocument } from "../src/word/mockOffice";
import {
  applySuggestion,
  chooseMatchIndex,
  commentSuggestion,
  detectCapabilities,
  findSuggestionMatches,
  locateSuggestion,
  readDocumentSnapshot,
  readFocus,
  subscribeParagraphChanges,
  subscribeSelectionChanges,
  toWordSearchText,
  waitForWordHost
} from "../src/word/wordHost";

let mock: MockWordHost;

beforeEach(() => {
  mock = new MockWordHost({
    paragraphs: sampleGrantDocument(),
    documentName: "Aims draft.docx",
    viewport: { pageChars: 600, visibleChars: 500 }
  }).install();
});

afterEach(() => {
  mock.uninstall();
});

async function boot() {
  const host = await waitForWordHost();
  expect(host.ready).toBe(true);
  const snapshot = await readDocumentSnapshot(host.capabilities);
  return { capabilities: host.capabilities, snapshot };
}

describe("word host: document snapshot", () => {
  it("reports capabilities from the requirement sets", async () => {
    const host = await waitForWordHost();
    expect(host.capabilities).toMatchObject({ host: true, comments: true, trackChanges: true, viewport: true, paragraphEvents: true, selectionEvents: true });
    mock.uninstall();
    expect(detectCapabilities(false).host).toBe(false);
    const offline = await waitForWordHost();
    expect(offline.ready).toBe(false);
  });

  it("reads the body text and a paragraph index that maps back onto it", async () => {
    const { snapshot } = await boot();
    expect(snapshot.documentName).toBe("Aims draft.docx");
    expect(snapshot.bodyText).toBe(mock.text);
    expect(snapshot.paragraphs.length).toBe(mock.paragraphs.length);
    for (const paragraph of snapshot.paragraphs) {
      expect(snapshot.bodyText.slice(paragraph.offset, paragraph.offset + paragraph.length)).toBe(paragraph.text);
    }
    expect(snapshot.paragraphs[0]).toMatchObject({ headingLevel: 1, text: "Specific Aims" });
    expect(snapshot.changeTrackingMode).toBe("Off");
  });
});

describe("word host: focus (selection, caret, viewport)", () => {
  it("maps the selection onto verbatim document offsets", async () => {
    const { capabilities, snapshot } = await boot();
    const sentence = "Our central hypothesis is that transient accessibility states precede lineage commitment.";
    mock.selectText(sentence);
    const focus = await readFocus(snapshot, capabilities);
    expect(focus.stale).toBe(false);
    expect(focus.selection).not.toBeNull();
    expect(focus.selection?.text).toBe(sentence);
    expect(snapshot.bodyText.slice(focus.selection!.from, focus.selection!.to)).toBe(sentence);
    expect(focus.cursorOffset).toBe(focus.selection!.from);
    expect(focus.cursorParagraphIndex).toBe(2);
  });

  it("tracks a collapsed caret and the pages on screen", async () => {
    const { capabilities, snapshot } = await boot();
    const index = mock.text.indexOf("Using the model");
    mock.setSelection(index + 4, index + 4);
    mock.scrollTo(index);
    const focus = await readFocus(snapshot, capabilities);
    expect(focus.selection).toBeNull();
    expect(focus.cursorOffset).toBe(index + 4);
    expect(focus.cursorParagraphIndex).toBe(6);
    expect(focus.viewport).not.toBeNull();
    expect(focus.viewport!.pages.length).toBeGreaterThan(0);
    expect(focus.viewport!.from).toBeLessThanOrEqual(index);
    expect(focus.viewport!.to).toBeGreaterThan(index);
    expect(focus.viewport!.pages).toEqual(mock.visiblePages().map((page) => page.index));
  });

  it("handles a selection spanning paragraphs", async () => {
    const { capabilities, snapshot } = await boot();
    const start = mock.text.indexOf("Aim 1. Map");
    const end = mock.text.indexOf("[1,2].") + "[1,2].".length;
    mock.setSelection(start, end);
    const focus = await readFocus(snapshot, capabilities);
    expect(focus.selection?.from).toBe(start);
    expect(focus.selection?.to).toBe(end);
    expect(focus.selection?.text).toBe(mock.text.slice(start, end));
    expect(focus.cursorParagraphIndex).toBe(3);
  });

  it("flags a stale snapshot when Word's paragraphs no longer match", async () => {
    const { capabilities, snapshot } = await boot();
    const index = mock.text.indexOf("Innovation");
    mock.replaceRange(index, index + "Innovation".length, "Innovation and impact");
    mock.setSelection(index + 2, index + 2);
    const focus = await readFocus(snapshot, capabilities);
    expect(focus.stale).toBe(true);
    const fresh = await readDocumentSnapshot(capabilities);
    expect((await readFocus(fresh, capabilities)).stale).toBe(false);
  });

  it("degrades gracefully without the desktop viewport API", async () => {
    mock.uninstall();
    mock = new MockWordHost({ paragraphs: sampleGrantDocument(), supports: { "WordApiDesktop 1.2": false } }).install();
    const { capabilities, snapshot } = await boot();
    expect(capabilities.viewport).toBe(false);
    const focus = await readFocus(snapshot, capabilities);
    expect(focus.viewport).toBeNull();
    expect(focus.cursorParagraphIndex).toBe(0);
  });

  it("fires selection and paragraph subscriptions", async () => {
    const { capabilities } = await boot();
    const selectionHandler = vi.fn();
    const unsubscribe = subscribeSelectionChanges(selectionHandler);
    mock.setSelection(3, 3);
    expect(selectionHandler).toHaveBeenCalledTimes(1);
    unsubscribe();
    mock.setSelection(4, 4);
    expect(selectionHandler).toHaveBeenCalledTimes(1);

    const paragraphHandler = vi.fn();
    const stop = await subscribeParagraphChanges(paragraphHandler, capabilities);
    expect(stop).not.toBeNull();
    mock.replaceRange(0, 0, "X");
    expect(paragraphHandler).toHaveBeenCalledTimes(1);
    await stop?.();
    mock.replaceRange(0, 0, "Y");
    expect(paragraphHandler).toHaveBeenCalledTimes(1);
  });
});

describe("word host: suggestion actions", () => {
  const original = "Chromatin accessibility is actually a very important determinant of gene regulation, and it is the case that many studies have looked at it.";
  const replacement = "Chromatin accessibility is a key determinant of gene regulation, and many studies have examined it.";

  it("finds matches with approximate offsets and picks the one nearest the author", async () => {
    const { snapshot } = await boot();
    const found = await findSuggestionMatches(snapshot, { original: "Rationale." });
    expect(found.strategy).toBe("search");
    expect(found.matches.length).toBe(1);
    expect(found.matches[0].offset).toBe(mock.text.indexOf("Rationale."));

    const repeated = await findSuggestionMatches(snapshot, { original: "Heading 2" });
    expect(repeated.matches.length).toBe(0);

    const aims = await findSuggestionMatches(snapshot, { original: "Aim" });
    expect(aims.matches.length).toBeGreaterThan(1);
    const secondOffset = aims.matches[1].offset!;
    expect(chooseMatchIndex(aims.matches, secondOffset + 1)).toBe(1);
    expect(chooseMatchIndex(aims.matches, null)).toBe(0);
  });

  it("selects the passage in Word when locating", async () => {
    const { snapshot } = await boot();
    const result = await locateSuggestion(snapshot, { original }, 0);
    expect(result.matches).toBe(1);
    const start = mock.text.indexOf(original);
    expect(mock.selection).toEqual({ from: start, to: start + original.length });
  });

  it("applies a suggestion as a tracked change and restores Word's tracking mode", async () => {
    const { snapshot } = await boot();
    expect(mock.changeTrackingMode).toBe("Off");
    const result = await applySuggestion(snapshot, { original, replacement }, { matchIndex: 0, trackChanges: "always" });
    expect(result.trackedChange).toBe(true);
    expect(mock.text).toContain(replacement);
    expect(mock.text).not.toContain(original);
    expect(mock.trackedChanges).toEqual([{ from: expect.any(Number), to: expect.any(Number), original, replacement }]);
    expect(mock.changeTrackingMode).toBe("Off");
    expect(mock.text.slice(mock.selection.from, mock.selection.to)).toBe(replacement);
  });

  it("follows Word's own tracking setting when asked", async () => {
    const { snapshot } = await boot();
    const result = await applySuggestion(snapshot, { original, replacement }, { matchIndex: 0, trackChanges: "word" });
    expect(result.trackedChange).toBe(false);
    expect(mock.trackedChanges).toEqual([]);
    expect(mock.edits.length).toBe(1);
  });

  it("deletes text for an empty replacement", async () => {
    const { snapshot } = await boot();
    await applySuggestion(snapshot, { original: "It is important to note that the preliminary data", replacement: "" }, { matchIndex: 0, trackChanges: "always" });
    expect(mock.text).not.toContain("It is important to note");
    expect(mock.text).toContain("six time points.  (Fig. 1) demonstrate");
    expect(mock.trackedChanges).toEqual([{ from: expect.any(Number), to: expect.any(Number), original: "It is important to note that the preliminary data", replacement: "" }]);
  });

  it("anchors long originals through a head/tail search", async () => {
    const { snapshot } = await boot();
    const long = mock.paragraphs[9].text;
    expect(long.length).toBeGreaterThan(250);
    const found = await findSuggestionMatches(snapshot, { original: long });
    expect(found.strategy).toBe("head-tail");
    expect(found.matches.length).toBe(1);
    const result = await applySuggestion(snapshot, { original: long, replacement: "Regulatory variation contributes substantially to disease risk, yet the mechanisms remain poorly understood." }, { matchIndex: 0, trackChanges: "always" });
    expect(result.matches).toBe(1);
    expect(mock.text).toContain("Regulatory variation contributes substantially");
  });

  it("refuses to apply when the document has changed under the suggestion", async () => {
    const { snapshot } = await boot();
    await expect(applySuggestion(snapshot, { original: "Text that is not in the document at all", replacement: "x" }, { matchIndex: 0, trackChanges: "always" }))
      .rejects.toThrow(/could not find/i);
    expect(mock.edits.length).toBe(0);
  });

  it("leaves a Word comment anchored on the original text", async () => {
    const { snapshot } = await boot();
    const result = await commentSuggestion(snapshot, { original }, "Nebula Writer — Tighten", 0);
    expect(result.matches).toBe(1);
    expect(mock.comments).toEqual([{ from: expect.any(Number), to: expect.any(Number), anchorText: original, text: "Nebula Writer — Tighten" }]);
    expect(mock.text).toContain(original);
  });

  it("escapes Word's find syntax", () => {
    expect(toWordSearchText("f(x) = x^2\nnext\tcol")).toBe("f(x) = x^^2^pnext^tcol");
  });
});

describe("word host: anchors that span paragraphs", () => {
  const tail = "Our central hypothesis is that transient accessibility states precede lineage commitment.";
  const heading = "Aim 1. Map accessibility dynamics at single-cell resolution.";
  const original = `${tail}\n${heading}`;

  it("finds a two-paragraph original by its first and last pieces", async () => {
    const { snapshot } = await boot();
    // Word never matches across a paragraph mark, so the direct search fails…
    expect(mock.search("commitment.^pAim 1.")).toEqual([]);
    // …and the facade falls back to head/tail anchoring.
    const found = await findSuggestionMatches(snapshot, { original });
    expect(found.strategy).toBe("head-tail");
    expect(found.matches.length).toBe(1);
    expect(found.matches[0].paragraphIndex).toBe(2);
    const located = await locateSuggestion(snapshot, { original }, 0);
    expect(located.matches).toBe(1);
    expect(mock.text.slice(mock.selection.from, mock.selection.to)).toBe(original);
  });

  it("applies a sentence added before a heading without touching the heading paragraph", async () => {
    const { snapshot } = await boot();
    const replacement = `${tail} I will first use this capability to test whether rules accumulate across layers.\n${heading}`;
    const result = await applySuggestion(snapshot, { original, replacement }, { matchIndex: 0, trackChanges: "always" });
    expect(result.strategy).toBe("paragraphs");
    expect(result.trackedChange).toBe(true);
    expect(mock.paragraphs[2].text).toContain("I will first use this capability");
    expect(mock.paragraphs[3]).toMatchObject({ text: heading, styleBuiltIn: "Heading2" });
    expect(mock.trackedChanges.length).toBe(1);
    expect(mock.trackedChanges[0].original).toBe(tail);
    expect(mock.changeTrackingMode).toBe("Off");
    expect(mock.paragraphs.length).toBe(15);
  });

  it("falls back to a whole-range replacement when the paragraph structure changes", async () => {
    const { snapshot } = await boot();
    const merged = `${tail} ${heading}`; // two paragraphs become one
    const result = await applySuggestion(snapshot, { original, replacement: merged }, { matchIndex: 0, trackChanges: "always" });
    expect(result.strategy).toBe("range");
    expect(mock.text).toContain(merged);
    expect(mock.paragraphs.length).toBe(14);
  });
});

