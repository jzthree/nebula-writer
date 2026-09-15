import { afterEach, describe, expect, it } from "vitest";
import { nebulaApply, nebulaFingerprint, nebulaFocusKey, nebulaReadDocument, nebulaReadFocus, nebulaSelect } from "../src/gdocs/script/main";
import { DOCS_CHANGE_HIGHLIGHT, DOCS_EMPHASIS_HIGHLIGHT, type DocsReplaceOp } from "../src/gdocs/protocol";
import { buildFakeDocument, installFakeDocumentApp, type FakeDocument } from "./gdocs-fake";

let restore: (() => void) | null = null;

function install(doc: FakeDocument): FakeDocument {
  restore = installFakeDocumentApp(doc);
  return doc;
}

afterEach(() => {
  restore?.();
  restore = null;
});

function sampleDocument(): FakeDocument {
  return buildFakeDocument([
    { text: "Specific Aims", heading: "HEADING1" },
    { text: "Our central hypothesis is that chromatin state drives fate.", bold: [[4, 22]], italic: [[31, 46]] },
    { text: "First aim point.", list: true },
    { table: [[{ text: "Cell one." }, { text: "Cell two." }]] },
    { text: "Closing paragraph." }
  ]);
}

function op(overrides: Partial<DocsReplaceOp> & Pick<DocsReplaceOp, "paragraphIndex" | "start" | "end" | "expected" | "text">): DocsReplaceOp {
  return {
    id: "op",
    endParagraphIndex: overrides.paragraphIndex,
    emphasis: null,
    highlight: false,
    ...overrides
  };
}

describe("google docs script: reading", () => {
  it("reads paragraphs, list items and table cells in order, with headings and emphasis", () => {
    install(sampleDocument());
    const payload = nebulaReadDocument();
    expect(payload.documentName).toBe("Fake doc");
    expect(payload.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "Specific Aims",
      "Our central hypothesis is that chromatin state drives fate.",
      "First aim point.",
      "Cell one.",
      "Cell two.",
      "Closing paragraph."
    ]);
    expect(payload.paragraphs[0]).toMatchObject({ headingLevel: 1, style: "Heading 1", isListItem: false });
    expect(payload.paragraphs[2]).toMatchObject({ headingLevel: null, isListItem: true });
    expect(payload.paragraphs[1].emphasis).toEqual([{ start: 4, end: 22, bold: true }, { start: 31, end: 46, italic: true }]);
    expect(payload.fingerprint).toBe(nebulaFingerprint());
  });

  it("does not report Writer's own change highlight as emphasis", () => {
    install(buildFakeDocument([{ text: "Changed words here.", background: [[0, 7, DOCS_CHANGE_HIGHLIGHT], [8, 13, DOCS_EMPHASIS_HIGHLIGHT]] }]));
    expect(nebulaReadDocument().paragraphs[0].emphasis).toEqual([{ start: 8, end: 13, highlight: true }]);
  });

  it("reports the caret and a partial selection by paragraph coordinates", () => {
    const doc = install(sampleDocument());
    doc.placeCursor(1, 12);
    expect(nebulaReadFocus()).toMatchObject({ paragraphIndex: 1, offset: 12, selection: null, paragraphText: "Our central hypothesis is that chromatin state drives fate." });
    doc.selectText(4, 0, 4);
    const focus = nebulaReadFocus();
    expect(focus.selection).toEqual({ startParagraph: 4, startOffset: 0, endParagraph: 4, endOffset: 4, text: "Cell" });
    expect(focus.paragraphIndex).toBe(4);
    const key = nebulaFocusKey();
    doc.selectText(4, 0, 5);
    expect(nebulaFocusKey()).not.toBe(key);
  });

  it("selects a range by paragraph coordinates", () => {
    const doc = install(sampleDocument());
    nebulaSelect({ paragraphIndex: 1, start: 4, endParagraphIndex: 1, end: 22 });
    const elements = doc.getSelection()?.getRangeElements() ?? [];
    expect(elements).toHaveLength(1);
    expect(elements[0].getStartOffset()).toBe(4);
    expect(elements[0].getEndOffsetInclusive()).toBe(21);
  });
});

describe("google docs script: applying", () => {
  it("replaces a run of words inside a paragraph and highlights the new text when asked", () => {
    const doc = install(sampleDocument());
    const outcomes = nebulaApply([op({ paragraphIndex: 1, start: 12, end: 22, expected: "hypothesis", text: "premise", highlight: true })]);
    expect(outcomes).toEqual([{ id: "op", ok: true }]);
    expect(doc.texts()[1]).toBe("Our central premise is that chromatin state drives fate.");
    const paragraph = doc.paragraph(1);
    // Inserted text inherits the bold of the words it replaced and carries the change highlight.
    expect(paragraph.formatAt(12)).toMatchObject({ bold: true, background: DOCS_CHANGE_HIGHLIGHT });
    expect(paragraph.formatAt(4)).toMatchObject({ bold: true, background: null });
    expect(paragraph.formatAt(28)).toMatchObject({ italic: true, background: null });
  });

  it("sets exactly the emphasis the suggestion asks for on the new text", () => {
    const doc = install(sampleDocument());
    // "Closing paragraph." is the fifth block in document order (after the table cells).
    const outcomes = nebulaApply([op({
      paragraphIndex: 5,
      start: 0,
      end: 18,
      expected: "Closing paragraph.",
      text: "Closing key paragraph.",
      emphasis: [{ start: 8, end: 11, bold: true, highlight: true }]
    })]);
    expect(outcomes).toEqual([{ id: "op", ok: true }]);
    expect(doc.texts().indexOf("Closing key paragraph.")).toBe(5);
    const paragraph = doc.body.children.filter((child) => "getText" in child).find((child) => child.getText() === "Closing key paragraph.");
    expect(paragraph?.formatAt(8)).toMatchObject({ bold: true, background: DOCS_EMPHASIS_HIGHLIGHT });
    expect(paragraph?.formatAt(0)).toMatchObject({ bold: false, background: null });
  });

  it("splits a paragraph for a multi-line replacement, keeping the rest of the paragraph after the last line", () => {
    const doc = install(buildFakeDocument([{ text: "Alpha beta gamma." }, { text: "Delta." }]));
    const outcomes = nebulaApply([op({ paragraphIndex: 0, start: 6, end: 10, expected: "beta", text: "one\ntwo", highlight: true })]);
    expect(outcomes[0].ok).toBe(true);
    expect(doc.texts()).toEqual(["Alpha one", "two gamma.", "Delta."]);
    expect(doc.paragraph(1).formatAt(0)).toMatchObject({ background: DOCS_CHANGE_HIGHLIGHT });
    expect(doc.paragraph(1).formatAt(4)).toMatchObject({ background: null });
  });

  it("replaces a span across paragraphs, dropping the middle ones and merging the remainder", () => {
    const doc = install(buildFakeDocument([{ text: "Start of first. Tail one." }, { text: "Middle paragraph." }, { text: "Head two. End of last." }]));
    const outcomes = nebulaApply([op({
      paragraphIndex: 0,
      start: 16,
      endParagraphIndex: 2,
      end: 9,
      expected: "Tail one.\nMiddle paragraph.\nHead two.",
      text: "Merged sentence."
    })]);
    expect(outcomes[0].ok).toBe(true);
    expect(doc.texts()).toEqual(["Start of first. Merged sentence. End of last."]);
  });

  it("lays multi-line text across the paragraphs it replaces", () => {
    const doc = install(buildFakeDocument([{ text: "A tail." }, { text: "B whole." }, { text: "C head. C rest." }]));
    const outcomes = nebulaApply([op({ paragraphIndex: 0, start: 2, endParagraphIndex: 2, end: 7, expected: "tail.\nB whole.\nC head.", text: "x1\nx2\nx3" })]);
    expect(outcomes[0].ok).toBe(true);
    expect(doc.texts()).toEqual(["A x1", "x2", "x3 C rest."]);
  });

  it("refuses an operation whose text no longer matches, and applies formatting-only operations in place", () => {
    const doc = install(sampleDocument());
    const outcomes = nebulaApply([
      op({ id: "stale", paragraphIndex: 4, start: 0, end: 7, expected: "Opening", text: "Other" }),
      op({ id: "format", paragraphIndex: 2, start: 0, end: 5, expected: "First", text: "First", emphasis: [{ start: 0, end: 5, underline: true }] })
    ]);
    expect(outcomes.find((outcome) => outcome.id === "stale")).toMatchObject({ ok: false, error: expect.stringContaining("moved or changed") });
    expect(outcomes.find((outcome) => outcome.id === "format")).toEqual({ id: "format", ok: true });
    expect(doc.texts()[2]).toBe("First aim point.");
    expect(doc.paragraph(2).formatAt(0)).toMatchObject({ underline: true, background: null });
    expect(doc.paragraph(2).formatAt(6)).toMatchObject({ underline: false });
  });

  it("applies later operations first so earlier offsets stay valid", () => {
    const doc = install(buildFakeDocument([{ text: "one two three four" }]));
    const outcomes = nebulaApply([
      op({ id: "a", paragraphIndex: 0, start: 0, end: 3, expected: "one", text: "ONE-LONGER" }),
      op({ id: "b", paragraphIndex: 0, start: 8, end: 13, expected: "three", text: "3" })
    ]);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(doc.texts()[0]).toBe("ONE-LONGER two 3 four");
  });
});
