import { describe, expect, it } from "vitest";
import { findMatches, planReplace, rangeToParagraphs } from "../src/gdocs/docsPlan";
import { indexParagraphs, type WordDocumentSnapshot } from "../src/word/wordContext";

function snapshot(texts: string[]): WordDocumentSnapshot {
  const bodyText = texts.join("\n");
  return {
    documentName: "Plan.gdoc",
    bodyText,
    paragraphs: indexParagraphs(bodyText, texts.map((text) => ({ text, style: "Normal" }))),
    changeTrackingMode: null,
    capturedAt: new Date().toISOString()
  };
}

describe("google docs planning: matches", () => {
  it("finds every occurrence with paragraph context for the placement anchor", () => {
    const snap = snapshot(["Alpha beta. Moved clause. Gamma.", "Delta. Epsilon. Moved clause.", "Zeta."]);
    const matches = findMatches(snap, "Moved clause.");
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ offset: 12, paragraphIndex: 0, contextBefore: "\nAlpha beta. ", contextAfter: " Gamma.\nDelta. Epsilon. Moved clause." });
    expect(matches[1]).toMatchObject({ paragraphIndex: 1, contextBefore: "Alpha beta. Moved clause. Gamma.\nDelta. Epsilon. ", contextAfter: "\nZeta." });
  });

  it("tolerates whitespace differences and maps offsets to paragraph coordinates", () => {
    const snap = snapshot(["One two.", "Three four."]);
    const matches = findMatches(snap, "two.\nThree");
    expect(matches).toHaveLength(1);
    expect(rangeToParagraphs(snap.paragraphs, matches[0].from, matches[0].to)).toEqual({ paragraphIndex: 0, start: 4, endParagraphIndex: 1, end: 5 });
    expect(findMatches(snap, "two.   Three")).toHaveLength(1);
    expect(findMatches(snap, "missing")).toEqual([]);
  });
});

describe("google docs planning: replace operations", () => {
  const snap = snapshot(["Our central hypothesis is that chromatin state drives fate.", "Second paragraph here."]);

  it("touches only the words that change, with the highlight flag on each run", () => {
    const plan = planReplace(snap, { id: "s1", original: "Our central hypothesis is that chromatin state drives fate.", replacement: "Our central premise is that chromatin state determines fate." }, { from: 0, to: 59 }, { highlight: true });
    expect("error" in plan).toBe(false);
    if (!("error" in plan)) {
      expect(plan.strategy).toBe("words");
      expect(plan.ops).toEqual([
        { id: "s1#0", paragraphIndex: 0, start: 12, endParagraphIndex: 0, end: 22, expected: "hypothesis", text: "premise", emphasis: null, highlight: true },
        { id: "s1#1", paragraphIndex: 0, start: 47, endParagraphIndex: 0, end: 53, expected: "drives", text: "determines", emphasis: null, highlight: true }
      ]);
    }
  });

  it("replaces the whole range for multi-line text, deletions, and explicit emphasis", () => {
    const multi = planReplace(snap, { id: "s2", original: "Second paragraph here.", replacement: "Second.\nThird." }, { from: 60, to: 82 }, { highlight: false });
    expect(multi).toMatchObject({ strategy: "range", ops: [{ paragraphIndex: 1, start: 0, endParagraphIndex: 1, end: 22, expected: "Second paragraph here.", text: "Second.\nThird." }] });
    const deletion = planReplace(snap, { id: "s3", original: "Second paragraph here.", replacement: "" }, { from: 60, to: 82 }, { highlight: false });
    expect(deletion).toMatchObject({ strategy: "range", ops: [{ text: "" }] });
    const emphasised = planReplace(snap, {
      id: "s4",
      original: "Second paragraph here.",
      replacement: "Second paragraph is here.",
      emphasis: { original: [], replacement: [{ start: 0, end: 6, bold: true }] }
    }, { from: 60, to: 82 }, { highlight: true });
    expect(emphasised).toMatchObject({ strategy: "range", ops: [{ text: "Second paragraph is here.", emphasis: [{ start: 0, end: 6, bold: true }], highlight: true }] });
  });

  it("plans an emphasis-only suggestion as formatting over the existing text", () => {
    const plan = planReplace(snap, {
      id: "s5",
      original: "Second paragraph here.",
      replacement: "Second paragraph here.",
      emphasis: { original: [], replacement: [{ start: 0, end: 16, underline: true }] }
    }, { from: 60, to: 82 }, { highlight: true });
    expect(plan).toMatchObject({ strategy: "emphasis", ops: [{ text: "Second paragraph here.", expected: "Second paragraph here.", emphasis: [{ start: 0, end: 16, underline: true }] }] });
  });
});
