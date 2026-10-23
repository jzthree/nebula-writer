// @vitest-environment node
import { describe, expect, it } from "vitest";
import { locateDocsSelection } from "../src/chrome/selectionMatch";

const paragraphs = (...texts: string[]) => texts.map((text) => ({ text }));

describe("Google Docs copied selection matching", () => {
  it("keeps the exact single-paragraph selection coordinates", () => {
    expect(locateDocsSelection(paragraphs("Opening.", "Our central hypothesis drives this study."), "central hypothesis"))
      .toEqual({ startParagraph: 1, startOffset: 4, endParagraph: 1, endOffset: 22, text: "central hypothesis" });
  });

  it("matches non-breaking and repeated spaces without changing the original text", () => {
    expect(locateDocsSelection(paragraphs("Before.", "Available\u00a0\u00a0material  limits\tresolution.", "After."), "Available material limits resolution."))
      .toEqual({ startParagraph: 1, startOffset: 0, endParagraph: 1, endOffset: 39, text: "Available\u00a0\u00a0material  limits\tresolution." });
  });

  it("matches copied scientific paragraphs with links, superscripts and extra blank lines", () => {
    const first = "Biological material limits resolution.\u00a0";
    const second = "Sequence-based models10–15 improve resolution.";
    const selected = locateDocsSelection(paragraphs("Opening.", first, "", "", second, "After."),
      "Biological  material limits resolution.\n\nSequence-based models10–15 improve resolution.");
    expect(selected).toEqual({
      startParagraph: 1, startOffset: 0, endParagraph: 4, endOffset: second.length,
      text: `${first}\n\n\n${second}`
    });
  });

  it("accepts clipboard CRLF and preserves document paragraph coordinates", () => {
    expect(locateDocsSelection(paragraphs("First passage.", "Next passage."), "passage.\r\nNext"))
      .toEqual({ startParagraph: 0, startOffset: 6, endParagraph: 1, endOffset: 4, text: "passage.\nNext" });
  });

  it("locates a long copied passage inside a manuscript-sized document", () => {
    const document = Array.from({ length: 315 }, (_, i) => `Paragraph ${i}: ${"Background material. ".repeat(15)}`);
    document[112] = `First selected paragraph.\u00a0${"Sequencing depth limits resolution. ".repeat(22)}`;
    document[113] = "";
    document[114] = `Sequence-based models10-15 ${"improve measurement resolution. ".repeat(30)}End of passage.`;
    const exact = document.slice(112, 115).join("\n");
    const copy = exact.replace(/\s+/g, "  ");
    expect(locateDocsSelection(paragraphs(...document), copy)).toEqual({
      startParagraph: 112, startOffset: 0, endParagraph: 114, endOffset: document[114].length, text: exact
    });
  });

  it("handles partial first and last paragraphs and UTF-16 offsets", () => {
    expect(locateDocsSelection(paragraphs("\ud83e\uddec Start here.\u00a0", "", "Then continue. Stop."), "here.   Then continue."))
      .toEqual({ startParagraph: 0, startOffset: 9, endParagraph: 2, endOffset: 14, text: "here.\u00a0\n\nThen continue." });
  });

  it("rejects repeated passages, including one exact and one whitespace variant", () => {
    expect(locateDocsSelection(paragraphs("Same passage.", "Same\u00a0passage."), "Same passage.")).toBeNull();
    expect(locateDocsSelection(paragraphs("Same passage.", "Same passage."), "Same passage.")).toBeNull();
    expect(locateDocsSelection(paragraphs("aaaa"), "aa")).toBeNull();
  });

  it("does not ignore words, punctuation, citations, case or internal zero-width characters", () => {
    const document = paragraphs("Sequence-based models10–15 improve resolution.");
    for (const copy of [
      "Sequence-based models improve resolution.",
      "Sequence-based models10–15 improve resolution!",
      "sequence-based models10–15 improve resolution.",
      "Sequence-based models10–15 improve\u200bresolution."
    ]) {
      expect(locateDocsSelection(document, copy)).toBeNull();
    }
  });

  it.each(["", " ", "\n\t\u00a0"])("rejects empty selection %j", (copy) => {
    expect(locateDocsSelection(paragraphs("Document text."), copy)).toBeNull();
  });
});
