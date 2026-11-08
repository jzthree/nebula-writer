import { describe, expect, it } from "vitest";
import { runEmphasis, withRunEmphasis } from "../server/docx";

describe("DOCX run formatting", () => {
  it("reads colour, highlight colour, strikethrough and superscript from run properties", () => {
    const rPr = '<w:rPr><w:rFonts w:ascii="Arial"/><w:strike/><w:color w:val="C00000"/><w:sz w:val="22"/><w:highlight w:val="cyan"/><w:vertAlign w:val="superscript"/><w:lang w:val="en-US"/></w:rPr>';
    expect(runEmphasis(rPr)).toEqual({ strike: true, superscript: true, highlight: true, highlightColor: "#00FFFF", color: "#C00000" });
    expect(runEmphasis('<w:rPr><w:color w:val="auto"/><w:shd w:val="clear" w:fill="FFFF00"/></w:rPr>')).toEqual({ highlight: true });
  });

  it("writes formatting in the order Word requires, keeping fonts, size and language", () => {
    const rPr = '<w:rPr><w:rFonts w:ascii="Arial"/><w:b/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr>';
    const written = withRunEmphasis(rPr, { italic: true, color: "#0000FF", highlight: true, highlightColor: "#00FF00", subscript: true });
    expect(written).toBe('<w:rPr><w:rFonts w:ascii="Arial"/><w:i/><w:iCs/><w:color w:val="0000FF"/><w:sz w:val="22"/><w:highlight w:val="green"/><w:vertAlign w:val="subscript"/><w:lang w:val="en-US"/></w:rPr>');
    expect(runEmphasis(written)).toEqual({ italic: true, subscript: true, highlight: true, highlightColor: "#00FF00", color: "#0000FF" });
  });
});
