import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockWordHost, sampleGrantDocument } from "../src/word/mockOffice";
import { suggestionAnchorFor, type AiSuggestion } from "../src/shared";
import { revertSuggestionOf } from "../src/revertSuggestion";
import {
  applySuggestion,
  applySuggestions,
  chooseMatchIndex,
  commentInlinePicture,
  commentSuggestion,
  readInlinePictureBase64,
  replaceInlinePicture,
  selectInlinePicture,
  wordPieceOps,
  fitReplacementEdges,
  lostWordGaps,
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
    // Word-level application: several small tracked changes, none of them the whole sentence.
    expect(mock.trackedChanges.length).toBeGreaterThan(1);
    expect(mock.trackedChanges.every((change) => change.original !== original)).toBe(true);
    expect(mock.changeTrackingMode).toBe("Off");
    expect(mock.selection.from).toBeGreaterThanOrEqual(mock.text.indexOf(replacement));
  });

  it("follows Word's own tracking setting when asked", async () => {
    const { snapshot } = await boot();
    const result = await applySuggestion(snapshot, { original, replacement }, { matchIndex: 0, trackChanges: "word" });
    expect(result.trackedChange).toBe(false);
    expect(mock.trackedChanges).toEqual([]);
    expect(mock.edits.length).toBeGreaterThan(0);
    expect(mock.text).toContain(replacement);
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

describe("word host: batch apply", () => {
  function uniqueSentence(index: number): string {
    const sentence = mock.paragraphs[index].text.split(/(?<=\.)\s/)[0];
    expect(mock.text.indexOf(sentence)).toBe(mock.text.lastIndexOf(sentence));
    return sentence;
  }

  it("applies several suggestions in one Word.run, last-in-document first, and selects the earliest", async () => {
    const { snapshot } = await boot();
    const items = [3, 5, 7].map((index, order) => {
      const original = uniqueSentence(index);
      return { id: `s${order}`, suggestion: { original, replacement: `Revised sentence ${order}.` }, matchIndex: 0 };
    });
    const runsBefore = mock.runCount;
    const outcomes = await applySuggestions(snapshot, items, { trackChanges: "always" });
    expect(mock.runCount - runsBefore).toBe(1);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(mock.trackedChanges.map((change) => change.replacement)).toEqual(["Revised sentence 2.", "Revised sentence 1.", "Revised sentence 0."]);
    for (const item of items) {
      expect(mock.text).not.toContain(item.suggestion.original);
      expect(mock.text).toContain(item.suggestion.replacement);
    }
    expect(mock.changeTrackingMode).toBe("Off");
    expect(mock.text.slice(mock.selection.from, mock.selection.to)).toBe("Revised sentence 0.");
  });

  it("defers a change that overlaps an earlier one to a later pass and reports it when the text is gone", async () => {
    const { snapshot } = await boot();
    const sentence = uniqueSentence(3);
    const words = sentence.split(" ");
    const first = words.slice(0, 4).join(" ");
    const overlapping = words.slice(2, 6).join(" ");
    const outcomes = await applySuggestions(snapshot, [
      { id: "a", suggestion: { original: first, replacement: "FIRST" }, matchIndex: 0 },
      { id: "b", suggestion: { original: overlapping, replacement: "SECOND" }, matchIndex: 0 }
    ], { trackChanges: "word" });
    expect(outcomes[0]).toMatchObject({ id: "a", ok: true });
    expect(outcomes[1].ok).toBe(false);
    if (!outcomes[1].ok) {
      expect(outcomes[1].error).toContain("could not find");
    }
    expect(mock.text).toContain("FIRST");
    expect(mock.text).not.toContain("SECOND");
  });

  it("reports a stale target without touching the document", async () => {
    const { snapshot } = await boot();
    const original = uniqueSentence(5);
    const index = mock.text.indexOf(original);
    mock.replaceRange(index, index + original.length, "Something else entirely.");
    const [outcome] = await applySuggestions(snapshot, [{ id: "x", suggestion: { original, replacement: "Nope" }, matchIndex: 0 }], { trackChanges: "always" });
    expect(outcome.ok).toBe(false);
    expect(mock.edits.length).toBe(1);
    expect(mock.changeTrackingMode).toBe("Off");
  });
});

describe("word host: inline pictures", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const NEW_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  function bootWithPicture() {
    mock.uninstall();
    mock = new MockWordHost({
      paragraphs: sampleGrantDocument(),
      documentName: "Aims draft.docx",
      pictures: [{ paragraphIndex: 4, base64: PNG, width: 320, height: 200, altText: "Figure 1 schematic" }]
    }).install();
    return boot();
  }

  it("lists pictures in the snapshot with their paragraph context, bytes on demand", async () => {
    const { snapshot } = await bootWithPicture();
    expect(snapshot.pictures).toEqual([{
      index: 0,
      width: 320,
      height: 200,
      altText: "Figure 1 schematic",
      paragraphText: mock.paragraphs[4].text,
      paragraphIndex: 4
    }]);
    const picture = await readInlinePictureBase64(0);
    expect(picture).toEqual({ base64: PNG, width: 320, height: 200 });
    await expect(readInlinePictureBase64(3)).rejects.toThrow("there is no picture 4");
  });

  it("replaces a picture as a tracked change, then selects and comments on it", async () => {
    await bootWithPicture();
    const result = await replaceInlinePicture(0, NEW_PNG, { trackChanges: "always" });
    expect(result.trackedChange).toBe(true);
    expect(mock.pictures[0].base64).toBe(NEW_PNG);
    expect(mock.pictureReplacements).toEqual([{ index: 0, previousBase64: PNG, base64: NEW_PNG, tracked: true }]);
    expect(mock.changeTrackingMode).toBe("Off");

    await selectInlinePicture(0);
    expect(mock.selection).toEqual(mock.paragraphRange(4));
    await commentInlinePicture(0, "Consider a higher-resolution export.");
    expect(mock.comments).toHaveLength(1);
    expect(mock.comments[0].text).toContain("higher-resolution");
  });
});

describe("word host: formatting-safe application", () => {
  const ORIGINAL = "Chromatin accessibility is actually a very important determinant of gene regulation, and it is the case that many studies have looked at it.";
  const REPLACEMENT = "Chromatin accessibility is a key determinant of gene regulation, and many studies have examined it.";

  function pieces(text: string): string[] {
    const out: string[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === " ") {
        out.push(text.slice(start, index + 1));
        start = index + 1;
      }
    }
    if (start < text.length) {
      out.push(text.slice(start));
    }
    return out;
  }

  it("plans one operation per changed run: replace, delete, insert, and end-of-passage spacing", () => {
    expect(wordPieceOps(pieces("The quick brown fox jumps"), "The quick red fox leaps")).toEqual([
      { kind: "replace", from: 2, to: 2, text: "red " },
      { kind: "replace", from: 4, to: 4, text: "leaps" }
    ]);
    expect(wordPieceOps(pieces("The quick brown fox"), "The brown fox")).toEqual([{ kind: "delete", from: 1, to: 1 }]);
    expect(wordPieceOps(pieces("A b c d e"), "A e")).toEqual([{ kind: "delete", from: 1, to: 3 }]);
    expect(wordPieceOps(pieces("The quick fox"), "The quick brown fox")).toEqual([{ kind: "insertEnd", index: 1, text: "brown " }]);
    expect(wordPieceOps(pieces("quick fox"), "The quick fox")).toEqual([{ kind: "insertStart", index: 0, text: "The " }]);
    expect(wordPieceOps(pieces("The quick fox"), "The quick fox again")).toEqual([{ kind: "insertEnd", index: 2, text: " again" }]);
    expect(wordPieceOps(pieces("The quick fox jumps"), "The quick fox")).toEqual([{ kind: "replace", from: 2, to: 3, text: "fox" }]);
    expect(wordPieceOps(pieces("Same text"), "Same text")).toEqual([]);
    expect(wordPieceOps(pieces(ORIGINAL), REPLACEMENT)).toEqual([
      { kind: "delete", from: 3, to: 3 },
      { kind: "replace", from: 5, to: 6, text: "key " },
      { kind: "delete", from: 12, to: 16 },
      { kind: "replace", from: 20, to: 21, text: "examined " }
    ]);
  });

  it("applies a rewrite by touching only the changed runs, so the rest keeps its formatting", async () => {
    const { snapshot } = await boot();
    expect(mock.text).toContain(ORIGINAL);
    const result = await applySuggestion(snapshot, { original: ORIGINAL, replacement: REPLACEMENT }, { matchIndex: 0, trackChanges: "always" });
    expect(result.strategy).toBe("words");
    expect(mock.text).toContain(REPLACEMENT);
    expect(mock.text).not.toContain(ORIGINAL);
    expect(mock.trackedChanges.map((change) => [change.original, change.replacement])).toEqual([
      ["looked at ", "examined "],
      ["it is the case that ", ""],
      ["very important ", "key "],
      ["actually ", ""]
    ]);
    expect(mock.changeTrackingMode).toBe("Off");
  });

  it("keeps a whole-range replace for near-total rewrites", async () => {
    const { snapshot } = await boot();
    const result = await applySuggestion(snapshot, { original: ORIGINAL, replacement: "Open chromatin governs which genes fire." }, { matchIndex: 0, trackChanges: "word" });
    expect(result.strategy).toBe("range");
    expect(mock.edits).toHaveLength(1);
    expect(mock.text).toContain("Open chromatin governs which genes fire.");
  });

  it("refuses to cut into a Word field and says so", async () => {
    mock.uninstall();
    mock = new MockWordHost({ paragraphs: sampleGrantDocument(), documentName: "Aims draft.docx" }).install();
    const start = mock.text.indexOf(ORIGINAL);
    const fieldFrom = start + ORIGINAL.indexOf("determinant");
    mock.fields = [{ from: fieldFrom, to: fieldFrom + "determinant".length }];
    const { snapshot } = await boot();
    const [blocked] = await applySuggestions(snapshot, [{ id: "a", suggestion: { original: ORIGINAL, replacement: ORIGINAL.replace("determinant", "driver") }, matchIndex: 0 }], { trackChanges: "word" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error).toContain("Word field");
    }
    expect(mock.edits).toHaveLength(0);
    const [allowed] = await applySuggestions(snapshot, [{ id: "b", suggestion: { original: ORIGINAL, replacement: ORIGINAL.replace("looked at", "examined") }, matchIndex: 0 }], { trackChanges: "word" });
    expect(allowed.ok).toBe(true);
    expect(mock.text).toContain("many studies have examined it.");
  });
});

describe("word host: placement anchors", () => {
  const paragraphs = [
    { text: "Alpha beta. Moved clause. Gamma." },
    { text: "Delta. Epsilon." },
    { text: "Zeta." }
  ];

  async function bootMoveDocument() {
    mock.uninstall();
    mock = new MockWordHost({ paragraphs, documentName: "Move.docx", viewport: { pageChars: 600, visibleChars: 500 } }).install();
    return boot();
  }

  it("deletes the original copy of a moved clause even after the inserted copy was accepted first", async () => {
    const { snapshot } = await bootMoveDocument();
    const anchor = suggestionAnchorFor(snapshot.bodyText, "Moved clause.")!;
    expect(anchor).toMatchObject({ offset: 12, before: "Alpha beta. " });

    // The insertion half of the move lands first.
    const inserted = await applySuggestions(snapshot, [
      { id: "insert", suggestion: { original: "Epsilon.", replacement: "Epsilon. Moved clause." }, matchIndex: 0 }
    ], { trackChanges: "word" });
    expect(inserted[0].ok).toBe(true);
    expect(mock.text).toBe("Alpha beta. Moved clause. Gamma.\nDelta. Epsilon. Moved clause.\nZeta.");

    // The deletion half now matches twice, and the caret sits by the new copy.
    const later = await readDocumentSnapshot((await waitForWordHost()).capabilities);
    const found = await findSuggestionMatches(later, { original: "Moved clause." });
    expect(found.matches.length).toBe(2);
    expect(found.matches[0].contextBefore).toBe("\nAlpha beta. ");
    expect(found.matches[0].contextAfter).toBe(" Gamma.\nDelta. Epsilon. Moved clause.");
    expect(found.matches[1].contextBefore).toBe("Alpha beta. Moved clause. Gamma.\nDelta. Epsilon. ");
    const nearCaret = found.matches[1].offset! + 1;
    expect(chooseMatchIndex(found.matches, nearCaret)).toBe(1);
    expect(chooseMatchIndex(found.matches, nearCaret, anchor)).toBe(0);

    const deleted = await applySuggestions(later, [
      { id: "delete", suggestion: { original: "Moved clause.", replacement: "", anchor }, matchIndex: null, preferredOffset: nearCaret }
    ], { trackChanges: "word" });
    expect(deleted[0].ok).toBe(true);
    expect(mock.text).toBe("Alpha beta.  Gamma.\nDelta. Epsilon. Moved clause.\nZeta.");
  });

  it("falls back to the nearest occurrence when the surroundings do not settle it", async () => {
    const { snapshot } = await bootMoveDocument();
    mock.replaceRange(mock.text.length, mock.text.length, " Alpha beta. Moved clause. Gamma.");
    const later = await readDocumentSnapshot((await waitForWordHost()).capabilities);
    const found = await findSuggestionMatches(later, { original: "Moved clause." });
    expect(found.matches.length).toBe(2);
    const anchor = { offset: 12, before: "Alpha beta. ", after: " Gamma." };
    expect(chooseMatchIndex(found.matches, found.matches[1].offset, anchor)).toBe(1);
    void snapshot;
  });
});

describe("word host: inline emphasis", () => {
  const paragraphs = [
    { text: "Specific Aims", style: "Heading 1", styleBuiltIn: "Heading1", outlineLevel: 1 },
    { text: "Our central hypothesis is that chromatin state drives fate.", emphasis: [{ start: 4, end: 22, bold: true }, { start: 31, end: 46, italic: true }] },
    { text: "Key point paragraph.", emphasis: [{ start: 0, end: 20, underline: true }] },
    { text: "Plain closing paragraph." }
  ];

  async function bootEmphasis() {
    mock.uninstall();
    mock = new MockWordHost({ paragraphs, documentName: "Emphasis.docx", viewport: { pageChars: 600, visibleChars: 500 } }).install();
    return boot();
  }

  it("reads emphasis: uniform paragraphs from the paragraph font, mixed ones word by word", async () => {
    const { snapshot } = await bootEmphasis();
    const second = snapshot.paragraphs[1].offset;
    const third = snapshot.paragraphs[2].offset;
    expect(snapshot.emphasis).toEqual([
      { start: second + 4, end: second + 22, bold: true },
      { start: second + 31, end: second + 46, italic: true },
      { start: third, end: third + 20, underline: true }
    ]);
  });

  it("applies the emphasis a suggestion asks for after the text lands", async () => {
    const { snapshot } = await bootEmphasis();
    const outcomes = await applySuggestions(snapshot, [{
      id: "e1",
      suggestion: {
        original: "Plain closing paragraph.",
        replacement: "Plain closing paragraph with a key claim.",
        emphasis: { original: [], replacement: [{ start: 31, end: 40, bold: true, highlight: true }] }
      },
      matchIndex: 0
    }], { trackChanges: "word" });
    expect(outcomes[0]).toMatchObject({ id: "e1", ok: true });
    expect(mock.text).toContain("Plain closing paragraph with a key claim.");
    const start = mock.text.indexOf("key claim");
    expect(mock.emphasisOver(start, start + 9)).toEqual({ bold: true, highlight: true });
    expect(mock.emphasisOver(mock.text.indexOf("Plain closing"), start - 1)).toEqual({});
  });

  it("reads and writes text colour, coloured highlight, strikethrough, superscript and subscript", async () => {
    mock.uninstall();
    mock = new MockWordHost({
      paragraphs: [
        { text: "Specific Aims", style: "Heading 1", styleBuiltIn: "Heading1", outlineLevel: 1 },
        { text: "Red warning, cyan note and old text with x2 here.", emphasis: [{ start: 0, end: 3, color: "#C00000" }, { start: 13, end: 22, highlight: true, highlightColor: "#00FFFF" }, { start: 27, end: 35, strike: true }, { start: 42, end: 43, superscript: true }] },
        { text: "Plain closing paragraph." }
      ],
      documentName: "Colours.docx",
      viewport: { pageChars: 600, visibleChars: 500 }
    }).install();
    const { snapshot } = await boot();
    const at = snapshot.paragraphs[1].offset;
    expect(snapshot.emphasis).toEqual([
      { start: at, end: at + 3, color: "#C00000" },
      { start: at + 13, end: at + 22, highlight: true, highlightColor: "#00FFFF" },
      { start: at + 27, end: at + 35, strike: true },
      { start: at + 42, end: at + 43, superscript: true }
    ]);

    const outcomes = await applySuggestions(snapshot, [{
      id: "c1",
      suggestion: {
        original: "Plain closing paragraph.",
        replacement: "Plain closing paragraph with H2O in blue.",
        emphasis: { original: [], replacement: [{ start: 30, end: 31, subscript: true }, { start: 36, end: 40, color: "#0000FF" }] }
      },
      matchIndex: 0
    }], { trackChanges: "word" });
    expect(outcomes[0]).toMatchObject({ id: "c1", ok: true });
    const h2o = mock.text.indexOf("H2O");
    expect(mock.emphasisOver(h2o + 1, h2o + 2)).toEqual({ subscript: true });
    expect(mock.emphasisOver(h2o, h2o + 1)).toEqual({});
    const blue = mock.text.indexOf("blue.");
    expect(mock.emphasisOver(blue, blue + 4)).toEqual({ color: "#0000FF" });
  });

  it("removes emphasis the replacement leaves out, and applies emphasis-only edits without touching the text", async () => {
    const { snapshot } = await bootEmphasis();
    const outcomes = await applySuggestions(snapshot, [{
      id: "e2",
      suggestion: {
        original: "Key point paragraph.",
        replacement: "Key point paragraph.",
        emphasis: { original: [{ start: 0, end: 20, underline: true }], replacement: [{ start: 0, end: 9, bold: true }] }
      },
      matchIndex: 0
    }], { trackChanges: "word" });
    expect(outcomes[0]).toMatchObject({ id: "e2", ok: true, result: { strategy: "emphasis" } });
    const at = mock.text.indexOf("Key point paragraph.");
    expect(at).toBeGreaterThan(0);
    expect(mock.emphasisOver(at, at + 9)).toEqual({ bold: true });
    expect(mock.emphasisOver(at + 10, at + 20)).toEqual({});
  });

  it("lets a plain-text edit inherit the emphasis of the words it replaces", async () => {
    const { snapshot } = await bootEmphasis();
    const outcomes = await applySuggestions(snapshot, [{
      id: "e3",
      suggestion: { original: "Our central hypothesis is that chromatin state drives fate.", replacement: "Our central premise is that chromatin state drives fate." },
      matchIndex: 0
    }], { trackChanges: "word" });
    expect(outcomes[0]).toMatchObject({ id: "e3", ok: true, result: { strategy: "words" } });
    const at = mock.text.indexOf("central premise");
    expect(mock.emphasisOver(at, at + 15)).toEqual({ bold: true });
    const italic = mock.text.indexOf("chromatin state");
    expect(mock.emphasisOver(italic, italic + 15)).toEqual({ italic: true });
  });
});

describe("word host: cheap background reads", () => {
  it("reuses mixed-paragraph emphasis for unchanged text in cached snapshots", async () => {
    mock.uninstall();
    mock = new MockWordHost({
      paragraphs: [
        { text: "Our central hypothesis is that chromatin state drives fate.", emphasis: [{ start: 4, end: 22, bold: true }] },
        { text: "A plain paragraph." }
      ],
      documentName: "Cache.docx",
      viewport: { pageChars: 600, visibleChars: 500 }
    }).install();
    const { capabilities } = await boot();
    const { MockRange } = await import("../src/word/mockOffice");
    const spy = vi.spyOn(MockRange.prototype, "getTextRanges");
    const full = await readDocumentSnapshot(capabilities, { emphasis: "full" });
    const fullCalls = spy.mock.calls.length;
    expect(fullCalls).toBeGreaterThan(0);
    const cached = await readDocumentSnapshot(capabilities, { emphasis: "cached" });
    expect(spy.mock.calls.length).toBe(fullCalls);
    expect(cached.emphasis).toEqual(full.emphasis);
    spy.mockRestore();
  });

  it("keeps the last viewport when a caret read skips the page-layout query", async () => {
    const { capabilities, snapshot } = await boot();
    const withPages = await readFocus(snapshot, capabilities, null, { viewport: true });
    const caretOnly = await readFocus(snapshot, capabilities, withPages, { viewport: false });
    expect(caretOnly.viewport).toEqual(withPages.viewport);
  });
});

describe("word host: reverting a direct edit", () => {
  const BODY = "Sentence A is here. Sentence B is here. Sentence C is here.";
  const PASSAGES = ["Sentence B is here.", "Sentence B is here. ", " Sentence B is here.", " Sentence B is here. ", "Sentence A is here. Sentence B is here.", "Sentence A is here. Sentence B is here. ", "Sentence C is here.", "Sentence B is here. Sentence C is here."];
  const REWRITE = "Totally unrelated wording replaces everything entirely now.";
  const replacementsFor = (passage: string) => {
    const core = passage.trim();
    const changed = core.replace("is here", "was there");
    return ["", changed, `${changed} `, `${core} Added sentence goes here.`, `${core} Added sentence goes here. `, `Added sentence goes here. ${core}`, REWRITE, `${REWRITE} `, `${core.split(". ")[0]}.`];
  };

  it("puts the text back exactly, whatever whitespace the passage and replacement carried at their ends", async () => {
    let cases = 0;
    for (const original of PASSAGES) {
      for (const replacement of replacementsFor(original)) {
        if (replacement === original) {
          continue;
        }
        mock.uninstall();
        mock = new MockWordHost({ paragraphs: [{ text: BODY }] }).install();
        const offset = BODY.indexOf(original);
        const suggestion = { id: "s", title: "t", original, replacement, rationale: "", confidence: 1, target: "global", status: "accepted", anchor: { offset, before: BODY.slice(0, offset), after: BODY.slice(offset + original.length) } } as AiSuggestion;
        const capabilities = detectCapabilities(true);
        const [forward] = await applySuggestions(await readDocumentSnapshot(capabilities), [{ id: "s", suggestion, matchIndex: 0 }], { trackChanges: "word" });
        expect(forward.ok, JSON.stringify([original, replacement])).toBe(true);
        const inverse = revertSuggestionOf(suggestion) as AiSuggestion;
        const [back] = await applySuggestions(await readDocumentSnapshot(capabilities), [{ id: "s", suggestion: inverse, matchIndex: 0 }], { trackChanges: "word" });
        expect(back.ok, JSON.stringify([original, replacement])).toBe(true);
        // Deleting a paragraph's first or last sentence leaves the space beside it, at the paragraph's edge.
        const atParagraphEdge = replacement === "" && (offset === 0 || offset + original.length === BODY.length);
        expect(atParagraphEdge ? mock.text.trim() : mock.text, JSON.stringify([original, replacement])).toBe(BODY);
        cases += 1;
      }
    }
    expect(cases).toBe(72);
  });

  it("drops whitespace at a replacement's ends only where the document already has some", () => {
    const fit = (original: string, replacement: string, text: string) => fitReplacementEdges({ original, replacement }, text, null).replacement;
    expect(fit("Foo", "Foo bar ", "Foo next")).toBe("Foo bar");
    expect(fit("Old", " New", "A. Old")).toBe("New");
    expect(fit("Foo.", "Foo. ", "Foo.Next")).toBe("Foo. ");
    expect(fit("Old", " New", "A.Old")).toBe(" New");
    expect(fit("Gone", "New ", "Elsewhere")).toBe("New ");
  });
});

describe("word host: spaces at the seams of a word-level edit", () => {
  const applyAll = (pieces: string[], replacement: string) => {
    const out = [...pieces];
    const before = pieces.map(() => "");
    const after = pieces.map(() => "");
    for (const op of wordPieceOps(pieces, replacement)) {
      if (op.kind === "insertStart") before[op.index] += op.text;
      else if (op.kind === "insertEnd") after[op.index] += op.text;
      else for (let index = op.from; index <= op.to; index += 1) out[index] = index === op.from && op.kind === "replace" ? op.text : "";
    }
    return out.map((text, index) => `${before[index]}${text}${after[index]}`).join("");
  };

  it("leaves a piece of only whitespace standing between two kept words", () => {
    expect(applyAll(["uses ", "the", " ", "regulatory"], "uses the regulatory")).toBe("uses the regulatory");
    expect(applyAll(["the", " ", "regulatory ", "code"], "the regulatory codes")).toBe("the regulatory codes");
  });

  it("keeps the space a changed word's piece started with", () => {
    expect(applyAll(["foo", " bar ", "baz"], "foo qux baz")).toBe("foo qux baz");
  });

  it("removes a gap along with the word it separated", () => {
    expect(applyAll(["one", " ", "two", " ", "three"], "one three")).toBe("one three");
    expect(applyAll(["one", " ", "two"], "one")).toBe("one");
    expect(applyAll(["one", " ", "two", " ", "three"], "one 2 three")).toBe("one 2 three");
  });

  it("finds adjacent words of the proposal that ended up joined, and nothing the proposal wrote joined", () => {
    expect(lostWordGaps("It learns theregulatory code here.", "learns the regulatory code")).toEqual([["the", "regulatory"]]);
    expect(lostWordGaps("It learns the regulatory code here.", "learns the regulatory code")).toEqual([]);
    expect(lostWordGaps("A co author", "A co author")).toEqual([]);
    expect(lostWordGaps("grammar of DNA:Puffin explained", "grammar of DNA: Puffin explained")).toEqual([["DNA:", "Puffin"]]);
    // Ordinary words that merely contain a proposed pair are left alone.
    expect(lostWordGaps("An independent lab, in dependent cells.", "in dependent cells")).toEqual([]);
    expect(lostWordGaps("A reindependent lab.", "in dependent cells")).toEqual([]);
  });

  it("puts back a space Word dropped when replacing a word, so the text reads as proposed", async () => {
    mock.uninstall();
    mock = new MockWordHost({ paragraphs: [{ text: "The model learns some regulatory code from data." }] }).install();
    mock.losesReplacedTrailingSpace = true;
    const suggestion = { id: "s", title: "t", original: "The model learns some regulatory code from data.", replacement: "The model learns the regulatory code from data.", rationale: "", confidence: 1, target: "global", status: "pending" } as AiSuggestion;
    const [outcome] = await applySuggestions(await readDocumentSnapshot(detectCapabilities(true)), [{ id: "s", suggestion, matchIndex: 0 }], { trackChanges: "always" });
    expect(outcome).toMatchObject({ ok: true, result: { strategy: "words", restoredGaps: 1 } });
    expect(mock.text).toBe("The model learns the regulatory code from data.");
  });
});

describe("word host: formatting a multi-paragraph replacement", () => {
  const ORIGINAL = "First lead. First body text here.\nSecond lead. Second body text here.";
  const REPLACEMENT = "New heading.\nSecond lead. Second body text here.\nFirst lead. First body text here.";
  const suggestion = {
    id: "s", title: "t", original: ORIGINAL, replacement: REPLACEMENT, rationale: "", confidence: 1, target: "global", status: "pending",
    emphasis: { original: [{ start: 0, end: 11, bold: true }, { start: 34, end: 46, bold: true }], replacement: [{ start: 0, end: 12, bold: true }, { start: 13, end: 25, italic: true }, { start: 49, end: 60, italic: true }] }
  } as AiSuggestion;

  async function apply(stale: boolean) {
    mock.uninstall();
    mock = new MockWordHost({ paragraphs: [{ text: "Intro paragraph." }, { text: "First lead. First body text here.", emphasis: [{ start: 0, end: 11, bold: true }] }, { text: "Second lead. Second body text here.", emphasis: [{ start: 0, end: 12, bold: true }] }, { text: "Closing paragraph." }] }).install();
    mock.replaceInvalidatesParagraphs = stale;
    const [outcome] = await applySuggestions(await readDocumentSnapshot(detectCapabilities(true)), [{ id: "s", suggestion, matchIndex: 0 }], { trackChanges: "always" });
    return outcome;
  }

  it.each([false, true])("sets each paragraph's emphasis on the new text, not the bold it inherited (stale paragraphs: %s)", async (stale) => {
    const outcome = await apply(stale);
    expect(outcome).toMatchObject({ ok: true, result: { strategy: "range", unformatted: false } });
    const text = mock.text;
    const span = (needle: string) => mock.emphasisOver(text.indexOf(needle), text.indexOf(needle) + needle.length);
    expect(span("New heading.")).toEqual({ bold: true });
    expect(span("Second lead.")).toEqual({ italic: true });
    expect(span("First lead.")).toEqual({ italic: true });
    expect(span("Second body text here.")).toEqual({});
    expect(span("First body text here.")).toEqual({});
  });

  it("still records the tracked changes for a revert when the old paragraphs went stale", async () => {
    const outcome = await apply(true);
    expect(outcome.ok && outcome.result.revisions?.length).toBeGreaterThan(0);
  });
});
