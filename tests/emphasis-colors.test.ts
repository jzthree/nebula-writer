import { describe, expect, it } from "vitest";
import { normalizeColor, parseEmphasis, renderEmphasis, sameFormat } from "../src/emphasis";

describe("colours, strikethrough, superscript and subscript", () => {
  it("renders every kind the reader sees, and parses it back exactly", () => {
    const text = "Red word, cyan note, old claim, x2 and H2O here.";
    const spans = [
      { start: 0, end: 3, color: "#C00000" },
      { start: 10, end: 19, highlight: true, highlightColor: "#00FFFF" },
      { start: 21, end: 30, strike: true },
      { start: 33, end: 34, superscript: true },
      { start: 40, end: 41, subscript: true }
    ];
    const marked = renderEmphasis(text, spans);
    expect(marked).toBe("{color=#C00000}Red{/color} word, {bg=#00FFFF}cyan note{/bg}, ~~old claim~~, x{sup}2{/sup} and H{sub}2{/sub}O here.");
    const parsed = parseEmphasis(marked);
    expect(parsed.text).toBe(text);
    expect(parsed.spans).toEqual(spans);
  });

  it("writes a yellow highlight as == and combines colour with other formatting", () => {
    expect(renderEmphasis("key point", [{ start: 0, end: 9, highlight: true, highlightColor: "#FFFF00" }])).toBe("==key point==");
    const marked = renderEmphasis("bold red", [{ start: 0, end: 8, bold: true, color: "#ff0000" }]);
    expect(marked).toBe("{color=#FF0000}**bold red**{/color}");
    expect(parseEmphasis(marked).spans).toEqual([{ start: 0, end: 8, bold: true, color: "#FF0000" }]);
  });

  it("leaves unpaired or malformed tags in the text", () => {
    expect(parseEmphasis("a {color=#C00000}dangling tag").spans).toEqual([]);
    expect(parseEmphasis("a {color=#C00000}dangling tag").text).toBe("a {color=#C00000}dangling tag");
    expect(parseEmphasis("set {color=red}x{/color}").text).toBe("set {color=red}x{/color}");
    expect(parseEmphasis("LaTeX {sup} alone").text).toBe("LaTeX {sup} alone");
  });

  it("compares colours by value", () => {
    expect(sameFormat({ color: "#c00000" }, { color: "#C00000" })).toBe(true);
    expect(sameFormat({ color: "#C00000" }, { color: "#0000FF" })).toBe(false);
    expect(sameFormat({ highlight: true, highlightColor: "#FFFF00" }, { highlight: true })).toBe(true);
    expect(normalizeColor("Turquoise")).toBe("#00FFFF");
    expect(normalizeColor("#abc")).toBe("#AABBCC");
    expect(normalizeColor("Automatic")).toBeNull();
  });
});
