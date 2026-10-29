import { describe, expect, it } from "vitest";
import { applyTableOp, buildTableCellRequests, buildTableStructureRequests, parseDocument, tableInsertLocation, tableLocateParagraph, type ApiDocument, type ApiStructuralElement, type ParsedDocument } from "../src/chrome/docsApi";
import type { DocsTableOp } from "../src/gdocs/protocol";
import { planTableMorph } from "../src/tables";

type Block = string | { table: string[][]; spans?: Array<[number, number]> };

/**
 * A documents.get body laid out like the real thing: a section break, then
 * paragraphs ("text\n") and tables (one index for the table start, one per
 * row, one per cell, then the cell's paragraphs).
 */
function apiDoc(blocks: Block[], revisionId = "rev-1"): ApiDocument {
  let cursor = 1;
  const paragraph = (text: string): ApiStructuralElement => {
    const startIndex = cursor;
    cursor += text.length + 1;
    return { startIndex, endIndex: cursor, paragraph: { elements: [{ startIndex, endIndex: cursor, textRun: { content: `${text}\n` } }] } };
  };
  const content: ApiStructuralElement[] = [{ startIndex: 0, endIndex: 1, sectionBreak: {} }];
  for (const block of blocks) {
    if (typeof block === "string") {
      content.push(paragraph(block));
      continue;
    }
    const startIndex = cursor;
    cursor += 1;
    const tableRows = block.table.map((row, r) => {
      cursor += 1;
      return {
        tableCells: row.map((text, c) => {
          const cellStart = cursor;
          cursor += 1;
          const paragraphs = text.split("\n").map(paragraph);
          const spanned = block.spans?.some(([sr, sc]) => sr === r && sc === c);
          return { startIndex: cellStart, endIndex: cursor, content: paragraphs, ...(spanned ? { tableCellStyle: { columnSpan: 2 } } : {}) };
        })
      };
    });
    content.push({ startIndex, endIndex: cursor, table: { rows: block.table.length, columns: block.table[0].length, tableRows } });
  }
  return { documentId: "doc-1", title: "Budget", revisionId, body: { content } };
}

const BUDGET = [["Item", "Year 1"], ["Personnel", "$120,000"], ["Travel", "$5,000"]];

describe("chrome extension: reading tables", () => {
  it("reads top-level tables as grids with their caption and cell indices", () => {
    const parsed = parseDocument(apiDoc(["Table 1. Budget", { table: BUDGET }, "After."]));
    expect(parsed.payload.paragraphs.map((paragraph) => paragraph.text)).toEqual(["Table 1. Budget", "Item", "Year 1", "Personnel", "$120,000", "Travel", "$5,000", "After."]);
    expect(parsed.payload.tables).toEqual([{ index: 0, rows: BUDGET, paragraphIndex: 1, context: "Table 1. Budget" }]);
    const table = parsed.index.tables[0];
    expect(table.startIndex).toBe(17);
    // Cell (0,0): cell start 19, its paragraph "Item\n" is 20..25.
    expect(table.cells[0][0]).toEqual({ startIndex: 20, endIndex: 25, paragraphs: [1], nested: false });
    expect(tableLocateParagraph(parsed, 0)).toBe(1);
  });

  it("joins a cell's paragraphs and marks merged cells irregular", () => {
    const parsed = parseDocument(apiDoc([{ table: [["a\nb", "c"], ["d", "e"]], spans: [[1, 0]] }]));
    expect(parsed.payload.tables?.[0]).toMatchObject({ rows: [["a\nb", "c"], ["d", "e"]], irregular: true, context: null });
    expect(parsed.index.tables[0].cells[0][0].paragraphs).toEqual([0, 1]);
  });
});

describe("chrome extension: table requests", () => {
  const parsed = parseDocument(apiDoc(["Intro", { table: BUDGET }, "After."]));
  const table = parsed.index.tables[0];

  it("turns morph steps into row and column requests at the table's start", () => {
    const at = { tableStartLocation: { index: table.startIndex } };
    expect(buildTableStructureRequests(table, [
      { type: "deleteColumn", column: 1 },
      { type: "deleteRow", row: 2 },
      { type: "insertRow", at: 0 },
      { type: "insertRow", at: 2 },
      { type: "insertColumn", at: 0 },
      { type: "insertColumn", at: 1 },
      { type: "setCell", row: 0, column: 0, text: "ignored" }
    ])).toEqual([
      { deleteTableColumn: { tableCellLocation: { ...at, rowIndex: 0, columnIndex: 1 } } },
      { deleteTableRow: { tableCellLocation: { ...at, rowIndex: 2, columnIndex: 0 } } },
      { insertTableRow: { tableCellLocation: { ...at, rowIndex: 0, columnIndex: 0 }, insertBelow: false } },
      { insertTableRow: { tableCellLocation: { ...at, rowIndex: 1, columnIndex: 0 }, insertBelow: true } },
      { insertTableColumn: { tableCellLocation: { ...at, rowIndex: 0, columnIndex: 0 }, insertRight: false } },
      { insertTableColumn: { tableCellLocation: { ...at, rowIndex: 0, columnIndex: 0 }, insertRight: true } }
    ]);
  });

  it("rewrites cells last-first, keeping each cell's final paragraph mark", () => {
    const personnel = table.cells[1][1];
    const travel = table.cells[2][0];
    expect(buildTableCellRequests(table, [
      { row: 1, column: 1, text: "$125,000" },
      { row: 2, column: 0, text: "" }
    ], { highlight: true })).toEqual([
      { deleteContentRange: { range: { startIndex: travel.startIndex, endIndex: travel.endIndex - 1 } } },
      { deleteContentRange: { range: { startIndex: personnel.startIndex, endIndex: personnel.endIndex - 1 } } },
      { insertText: { location: { index: personnel.startIndex }, text: "$125,000" } },
      { updateTextStyle: { range: { startIndex: personnel.startIndex, endIndex: personnel.startIndex + 8 }, textStyle: { backgroundColor: expect.anything() }, fields: "backgroundColor" } }
    ]);
  });

  it("places a new table after a paragraph, or after the table a cell paragraph sits in", () => {
    expect(tableInsertLocation(parsed, 0)).toBe(parsed.index.paragraphs[0].endIndex - 1);
    expect(tableInsertLocation(parsed, 2)).toBe(table.endIndex);
  });
});

describe("chrome extension: applying table ops in phases", () => {
  function io(documents: ParsedDocument[]) {
    const batches: Array<Array<Record<string, unknown>>> = [];
    let reads = 0;
    return {
      batches,
      reads: () => reads,
      io: {
        read: async () => documents[Math.min(reads++, documents.length - 1)],
        batch: async (requests: Array<Record<string, unknown>>) => { batches.push(requests); }
      }
    };
  }
  const op = (overrides: Partial<DocsTableOp>): DocsTableOp => ({
    id: "t1", action: "replace", index: 0, before: BUDGET, rows: null, header: false, afterParagraphIndex: null, expectedParagraphText: null, highlight: false, ...overrides
  });

  it("reshapes first, re-reads, then fills the cells", async () => {
    const after = [BUDGET[0], BUDGET[1], ["Supplies", "$8,000"], BUDGET[2]];
    const before = parseDocument(apiDoc(["Intro", { table: BUDGET }]));
    const reshaped = parseDocument(apiDoc(["Intro", { table: [BUDGET[0], BUDGET[1], ["", ""], BUDGET[2]] }], "rev-2"));
    const run = io([before, reshaped]);
    await expect(applyTableOp(op({ rows: after }), run.io)).resolves.toEqual({ id: "t1", ok: true });
    expect(run.batches[0]).toEqual(buildTableStructureRequests(before.index.tables[0], planTableMorph(BUDGET, after).steps));
    expect(run.batches[1]).toEqual(buildTableCellRequests(reshaped.index.tables[0], [{ row: 2, column: 0, text: "Supplies" }, { row: 2, column: 1, text: "$8,000" }], { highlight: false }));
  });

  it("only rewrites cells when the shape is unchanged (one round trip)", async () => {
    const parsed = parseDocument(apiDoc([{ table: BUDGET }]));
    const run = io([parsed]);
    await applyTableOp(op({ rows: [BUDGET[0], ["Personnel", "$125,000"], BUDGET[2]] }), run.io);
    expect(run.reads()).toBe(1);
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0][0]).toHaveProperty("deleteContentRange");
  });

  it("refuses a table that changed since the suggestion, without sending anything", async () => {
    const run = io([parseDocument(apiDoc([{ table: [["Item", "Year 1"], ["Personnel", "$1"]] }]))]);
    const result = await applyTableOp(op({ rows: BUDGET.slice(0, 2) }), run.io);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
    expect(run.batches).toEqual([]);
  });

  it("refuses to reshape a table with merged cells", async () => {
    const run = io([parseDocument(apiDoc([{ table: BUDGET, spans: [[0, 0]] }]))]);
    const result = await applyTableOp(op({ rows: [...BUDGET, ["Supplies", "$1"]] }), run.io);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("merged") });
    expect(run.batches).toEqual([]);
  });

  it("deletes the whole table range", async () => {
    const parsed = parseDocument(apiDoc(["Intro", { table: BUDGET }, "After."]));
    const run = io([parsed]);
    await applyTableOp(op({ action: "delete" }), run.io);
    const table = parsed.index.tables[0];
    expect(run.batches).toEqual([[{ deleteContentRange: { range: { startIndex: table.startIndex, endIndex: table.endIndex } } }]]);
  });

  it("inserts a table after the anchor paragraph, then fills it with a bold pinned header", async () => {
    const before = parseDocument(apiDoc(["Intro", "After."]));
    const created = parseDocument(apiDoc(["Intro", { table: [["", ""], ["", ""], ["", ""]] }, "", "After."], "rev-2"));
    const run = io([before, created]);
    const result = await applyTableOp(op({ action: "insert", index: null, before: null, rows: BUDGET, header: true, afterParagraphIndex: 0, expectedParagraphText: "Intro" }), run.io);
    expect(result).toEqual({ id: "t1", ok: true });
    expect(run.batches[0]).toEqual([{ insertTable: { rows: 3, columns: 2, location: { index: before.index.paragraphs[0].endIndex - 1 } } }]);
    const table = created.index.tables[0];
    expect(run.batches[1][0]).toEqual({ pinTableHeaderRows: { tableStartLocation: { index: table.startIndex }, pinnedHeaderRowsCount: 1 } });
    const inserts = run.batches[1].filter((request) => "insertText" in request).map((request) => (request.insertText as { text: string }).text);
    expect(inserts).toEqual(["$5,000", "Travel", "$120,000", "Personnel", "Year 1", "Item"]);
    expect(run.batches[1].filter((request) => (request.updateTextStyle as { fields?: string } | undefined)?.fields === "bold")).toHaveLength(2);
  });

  it("does not insert after a paragraph whose text changed", async () => {
    const run = io([parseDocument(apiDoc(["Intro changed"]))]);
    const result = await applyTableOp(op({ action: "insert", index: null, before: null, rows: BUDGET, afterParagraphIndex: 0, expectedParagraphText: "Intro" }), run.io);
    expect(result.ok).toBe(false);
    expect(run.batches).toEqual([]);
  });
});
