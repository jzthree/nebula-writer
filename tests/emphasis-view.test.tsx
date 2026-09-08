import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { markedSides, renderMarked } from "../src/emphasisView";
import { wordDiffSegments } from "../src/wordDiff";

describe("emphasis in review cards", () => {
  it("renders markers as real emphasis and keeps plain text untouched", () => {
    expect(renderToStaticMarkup(<>{renderMarked("Our **central** *claim* __here__ ==now==")}</>))
      .toBe("<span>Our </span><span><strong>central</strong></span><span> </span><span><em>claim</em></span><span> </span><span><u>here</u></span><span> </span><span><mark>now</mark></span>");
    expect(renderToStaticMarkup(<>{renderMarked("2 * 3")}</>)).toBe("2 * 3");
  });

  it("diffs both sides per word so a changed emphasis shows as a change and every segment renders on its own", () => {
    const sides = markedSides({
      original: "Key point here.",
      replacement: "Key point here.",
      emphasis: { original: [], replacement: [{ start: 0, end: 9, bold: true }] }
    });
    expect(sides).toEqual({ original: "Key point here.", replacement: "**Key** **point** here.", marked: true });
    const segments = wordDiffSegments(sides.original, sides.replacement) ?? [];
    expect(segments.map((segment) => segment.type)).toEqual(["del", "ins", "same", "del", "ins", "same"]);
    expect(renderToStaticMarkup(<>{renderMarked(segments[1].text)}</>)).toBe("<span><strong>Key</strong></span>");
    expect(renderToStaticMarkup(<>{renderMarked(segments[5].text)}</>)).toBe(" here.");
    expect(markedSides({ original: "a", replacement: "b" })).toEqual({ original: "a", replacement: "b", marked: false });
  });
});
