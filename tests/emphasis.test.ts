import { describe, expect, it } from "vitest";
import {
  carryEmphasis,
  emphasisAt,
  emphasisFromPieces,
  hasEmphasisMarkers,
  normalizeEmphasis,
  parseEmphasis,
  renderEmphasis,
  renderEmphasisPerWord,
  sliceEmphasis,
  uniformEmphasis,
  type EmphasisSpan
} from "../src/emphasis";

describe("emphasis: rendering", () => {
  it("wraps spans in markers, hugging words", () => {
    const text = "Our central hypothesis is that chromatin state drives fate.";
    const spans: EmphasisSpan[] = [{ start: 4, end: 22, bold: true }, { start: 31, end: 46, italic: true }];
    expect(renderEmphasis(text, spans)).toBe("Our **central hypothesis** is that *chromatin state* drives fate.");
  });

  it("keeps whitespace and line breaks outside the markers", () => {
    const text = "Key point \nnext line";
    expect(renderEmphasis(text, [{ start: 0, end: text.length, underline: true }])).toBe("__Key point__ \n__next line__");
  });

  it("nests combined formats in a fixed order and renders highlight", () => {
    expect(renderEmphasis("bold italic", [{ start: 0, end: 11, bold: true, italic: true }])).toBe("***bold italic***");
    expect(renderEmphasis("mark", [{ start: 0, end: 4, highlight: true }])).toBe("==mark==");
    expect(renderEmphasis("all", [{ start: 0, end: 3, bold: true, italic: true, underline: true, highlight: true }])).toBe("***__==all==__***");
  });

  it("renders a window of a longer text with an offset", () => {
    const spans: EmphasisSpan[] = [{ start: 10, end: 14, bold: true }];
    expect(renderEmphasis("bold text", spans, 10)).toBe("**bold** text");
  });

  it("renders per-word markers so diff segments stay self-contained", () => {
    expect(renderEmphasisPerWord("key point here", [{ start: 0, end: 9, bold: true }])).toBe("**key** **point** here");
  });

  it("returns the text untouched without spans", () => {
    expect(renderEmphasis("plain", [])).toBe("plain");
    expect(renderEmphasis("plain", null)).toBe("plain");
  });
});

describe("emphasis: parsing", () => {
  it("round-trips rendered text", () => {
    const text = "Our central hypothesis is that chromatin state drives fate.";
    const spans: EmphasisSpan[] = [{ start: 4, end: 22, bold: true }, { start: 31, end: 46, italic: true }];
    expect(parseEmphasis(renderEmphasis(text, spans))).toEqual({ text, spans });
    const combined: EmphasisSpan[] = [{ start: 0, end: 4, bold: true, italic: true }, { start: 5, end: 9, underline: true, highlight: true }];
    expect(parseEmphasis(renderEmphasis("bold mark", combined))).toEqual({ text: "bold mark", spans: combined });
  });

  it("merges per-word markers back into one span", () => {
    expect(parseEmphasis("**key** **point** here")).toEqual({ text: "key point here", spans: [{ start: 0, end: 9, bold: true }] });
  });

  it("leaves stray or unpaired markers as literal text", () => {
    expect(parseEmphasis("2 * 3 = 6")).toEqual({ text: "2 * 3 = 6", spans: [] });
    expect(parseEmphasis("p < 0.05 **unclosed")).toEqual({ text: "p < 0.05 **unclosed", spans: [] });
    expect(parseEmphasis("a == b")).toEqual({ text: "a == b", spans: [] });
    expect(parseEmphasis("__init__ method")).toEqual({ text: "init method", spans: [{ start: 0, end: 4, underline: true }] });
  });

  it("handles interleaved markers by kind", () => {
    expect(parseEmphasis("**bold *both** italic*")).toEqual({
      text: "bold both italic",
      spans: [{ start: 0, end: 5, bold: true }, { start: 5, end: 9, bold: true, italic: true }, { start: 9, end: 16, italic: true }]
    });
  });

  it("reports whether markers are present", () => {
    expect(hasEmphasisMarkers("no markers")).toBe(false);
    expect(hasEmphasisMarkers("a **bold** word")).toBe(true);
  });
});

describe("emphasis: spans", () => {
  it("slices and rebases spans to a window", () => {
    const spans: EmphasisSpan[] = [{ start: 5, end: 15, bold: true }, { start: 20, end: 30, italic: true }];
    expect(sliceEmphasis(spans, 10, 25)).toEqual([{ start: 0, end: 5, bold: true }, { start: 10, end: 15, italic: true }]);
    expect(sliceEmphasis(spans, 16, 19)).toEqual([]);
  });

  it("normalizes overlaps into combined, merged runs", () => {
    expect(normalizeEmphasis([{ start: 0, end: 10, bold: true }, { start: 5, end: 15, italic: true }, { start: 15, end: 20, italic: true }])).toEqual([
      { start: 0, end: 5, bold: true },
      { start: 5, end: 10, bold: true, italic: true },
      { start: 10, end: 20, italic: true }
    ]);
    expect(normalizeEmphasis([{ start: 3, end: 3, bold: true }, { start: 0, end: 4 }])).toEqual([]);
  });

  it("reads the format at an offset and over a range", () => {
    const spans: EmphasisSpan[] = [{ start: 0, end: 4, bold: true }];
    expect(emphasisAt(spans, 2)).toEqual({ bold: true });
    expect(emphasisAt(spans, 4)).toEqual({});
    expect(uniformEmphasis(spans, 0, 4)).toEqual({ bold: true });
    expect(uniformEmphasis(spans, 0, 6)).toBeNull();
  });

  it("builds spans from formatted pieces", () => {
    expect(emphasisFromPieces([
      { text: "Aim 1. ", format: { bold: true } },
      { text: "Map ", format: null },
      { text: "dynamics", format: { italic: true } }
    ], 100)).toEqual([{ start: 100, end: 107, bold: true }, { start: 111, end: 119, italic: true }]);
  });
});

describe("emphasis: carrying through plain-text edits", () => {
  it("keeps emphasis on kept words and lets inserted words inherit from the word before", () => {
    const original = "Aim 1. Map accessibility dynamics.";
    const spans: EmphasisSpan[] = [{ start: 0, end: 6, bold: true }];
    expect(carryEmphasis(original, spans, "Aim 1. Map chromatin accessibility dynamics at scale.")).toEqual([{ start: 0, end: 6, bold: true }]);
    expect(carryEmphasis("Aim 1. Map dynamics.", spans, "Aim 1 revised. Map dynamics.")).toEqual([{ start: 0, end: 14, bold: true }]);
  });

  it("keeps a uniformly emphasised original's emphasis across a full rewrite, and nothing otherwise", () => {
    expect(carryEmphasis("Old heading text", [{ start: 0, end: 16, bold: true }], "Completely different words")).toEqual([{ start: 0, end: 26, bold: true }]);
    expect(carryEmphasis("Old heading text", [{ start: 0, end: 3, bold: true }], "Completely different words")).toEqual([]);
    expect(carryEmphasis("plain", [], "other")).toEqual([]);
  });
});
