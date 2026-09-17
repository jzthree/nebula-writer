import { describe, expect, it } from "vitest";
import { apiIndexOf, buildBatchPlan, imageContentUri, parseDocument, type ApiDocument } from "../src/chrome/docsApi";
import { DOCS_CHANGE_HIGHLIGHT } from "../src/gdocs/protocol";

/** A documents.get response shaped like the real thing: indices are contiguous UTF-16 units, paragraph marks included. */
function fixture(): ApiDocument {
  return {
    documentId: "doc-1",
    title: "Aims",
    revisionId: "rev-1",
    body: {
      content: [
        { startIndex: 0, endIndex: 1, sectionBreak: {} },
        {
          startIndex: 1,
          endIndex: 15,
          paragraph: {
            paragraphStyle: { namedStyleType: "HEADING_1" },
            elements: [{ startIndex: 1, endIndex: 15, textRun: { content: "Specific Aims\n", textStyle: {} } }]
          }
        },
        {
          startIndex: 15,
          endIndex: 75,
          paragraph: {
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            elements: [
              { startIndex: 15, endIndex: 19, textRun: { content: "Our ", textStyle: {} } },
              { startIndex: 19, endIndex: 37, textRun: { content: "central hypothesis", textStyle: { bold: true } } },
              { startIndex: 37, endIndex: 46, textRun: { content: " is that ", textStyle: {} } },
              { startIndex: 46, endIndex: 61, textRun: { content: "chromatin state", textStyle: { italic: true } } },
              { startIndex: 61, endIndex: 75, textRun: { content: " drives fate.\n", textStyle: {} } }
            ]
          }
        },
        {
          startIndex: 75,
          endIndex: 92,
          paragraph: {
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            bullet: { listId: "kix.list", nestingLevel: 0 },
            elements: [
              { startIndex: 75, endIndex: 80, textRun: { content: "See: ", textStyle: {} } },
              { startIndex: 80, endIndex: 81, inlineObjectElement: { inlineObjectId: "kix.img1" } },
              { startIndex: 81, endIndex: 92, textRun: { content: " Figure 1.\n", textStyle: { backgroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 0 } } } } } }
            ]
          }
        },
        {
          startIndex: 92,
          endIndex: 120,
          table: {
            tableRows: [{
              tableCells: [{
                content: [{
                  startIndex: 94,
                  endIndex: 104,
                  paragraph: { elements: [{ startIndex: 94, endIndex: 104, textRun: { content: "Cell one.\n" } }] }
                }]
              }]
            }]
          }
        }
      ]
    },
    inlineObjects: {
      "kix.img1": {
        inlineObjectProperties: {
          embeddedObject: {
            description: "Figure 1",
            imageProperties: { contentUri: "https://lh3.example/img1" },
            size: { width: { magnitude: 200, unit: "PT" }, height: { magnitude: 100, unit: "PT" } }
          }
        }
      }
    }
  };
}

describe("chrome extension: parsing documents.get", () => {
  it("produces the add-in payload with headings, lists, emphasis, images and table cells", () => {
    const { payload, index } = parseDocument(fixture());
    expect(payload).toMatchObject({ documentName: "Aims", documentId: "doc-1", fingerprint: "rev-1" });
    expect(payload.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "Specific Aims",
      "Our central hypothesis is that chromatin state drives fate.",
      "See:  Figure 1.",
      "Cell one."
    ]);
    expect(payload.paragraphs[0]).toMatchObject({ headingLevel: 1, style: "Heading 1" });
    expect(payload.paragraphs[1].emphasis).toEqual([{ start: 4, end: 22, bold: true }, { start: 31, end: 46, italic: true }]);
    expect(payload.paragraphs[2]).toMatchObject({ isListItem: true, emphasis: [{ start: 5, end: 15, highlight: true }] });
    expect(payload.images).toEqual([{ index: 0, paragraphIndex: 2, width: 200, height: 100, altText: "Figure 1" }]);
    expect(imageContentUri(fixture(), index, 0)).toBe("https://lh3.example/img1");
    expect(index.paragraphs[1]).toMatchObject({ startIndex: 15, endIndex: 75, textLength: 59 });
  });

  it("maps paragraph offsets to API indices, skipping index space taken by inline objects", () => {
    const { index } = parseDocument(fixture());
    expect(apiIndexOf(index.paragraphs[1], 0)).toBe(15);
    expect(apiIndexOf(index.paragraphs[1], 12)).toBe(27);
    expect(apiIndexOf(index.paragraphs[1], 59)).toBe(74);
    // "See: " then the image (one unit at 80) then " Figure 1."
    expect(apiIndexOf(index.paragraphs[2], 4)).toBe(79);
    expect(apiIndexOf(index.paragraphs[2], 5)).toBe(81);
    expect(apiIndexOf(index.paragraphs[2], 15)).toBe(91);
  });
});

describe("chrome extension: batchUpdate plans", () => {
  it("deletes then inserts, later text first, and highlights the new text", () => {
    const parsed = parseDocument(fixture());
    const plan = buildBatchPlan(parsed, [
      { id: "a", paragraphIndex: 1, start: 12, endParagraphIndex: 1, end: 22, expected: "hypothesis", text: "premise", emphasis: null, highlight: true },
      { id: "b", paragraphIndex: 1, start: 47, endParagraphIndex: 1, end: 53, expected: "drives", text: "determines", emphasis: null, highlight: true }
    ]);
    expect(plan.rejected).toEqual([]);
    expect(plan.accepted).toEqual(["b", "a"]);
    expect(plan.requests).toEqual([
      { deleteContentRange: { range: { startIndex: 62, endIndex: 68 } } },
      { insertText: { location: { index: 62 }, text: "determines" } },
      { updateTextStyle: { range: { startIndex: 62, endIndex: 72 }, textStyle: { backgroundColor: expect.anything() }, fields: "backgroundColor" } },
      { deleteContentRange: { range: { startIndex: 27, endIndex: 37 } } },
      { insertText: { location: { index: 27 }, text: "premise" } },
      { updateTextStyle: { range: { startIndex: 27, endIndex: 34 }, textStyle: { backgroundColor: expect.anything() }, fields: "backgroundColor" } }
    ]);
    const highlight = (plan.requests[2] as { updateTextStyle: { textStyle: { backgroundColor: { color: { rgbColor: { red: number } } } } } }).updateTextStyle.textStyle.backgroundColor.color.rgbColor;
    expect(highlight.red).toBeCloseTo(parseInt(DOCS_CHANGE_HIGHLIGHT.slice(1, 3), 16) / 255, 5);
  });

  it("applies exactly the requested emphasis, handles spans across paragraphs and formatting-only edits, and rejects stale text", () => {
    const parsed = parseDocument(fixture());
    const plan = buildBatchPlan(parsed, [
      { id: "emph", paragraphIndex: 3, start: 0, endParagraphIndex: 3, end: 9, expected: "Cell one.", text: "Cell one.", emphasis: [{ start: 0, end: 4, bold: true, underline: true }], highlight: true },
      { id: "span", paragraphIndex: 1, start: 47, endParagraphIndex: 2, end: 4, expected: "drives fate.\nSee:", text: "ends\nNew:", emphasis: null, highlight: false },
      { id: "stale", paragraphIndex: 0, start: 0, endParagraphIndex: 0, end: 8, expected: "Specific Goals", text: "x", emphasis: null, highlight: false }
    ]);
    expect(plan.rejected).toEqual([{ id: "stale", ok: false, error: expect.stringContaining("moved or changed") }]);
    expect(plan.accepted).toEqual(["emph", "span"]);
    // Formatting only: no delete/insert, clear then set the run; the change highlight is not applied to unchanged text.
    expect(plan.requests.slice(0, 2)).toEqual([
      { updateTextStyle: { range: { startIndex: 94, endIndex: 103 }, textStyle: { bold: false, italic: false, underline: false, backgroundColor: {} }, fields: "bold,italic,underline,backgroundColor" } },
      { updateTextStyle: { range: { startIndex: 94, endIndex: 98 }, textStyle: { bold: true, underline: true }, fields: "bold,underline" } }
    ]);
    expect(plan.requests.slice(2)).toEqual([
      { deleteContentRange: { range: { startIndex: 62, endIndex: 79 } } },
      { insertText: { location: { index: 62 }, text: "ends\nNew:" } }
    ]);
  });
});
