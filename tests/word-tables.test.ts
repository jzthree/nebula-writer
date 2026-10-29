import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockWordHost } from "../src/word/mockOffice";
import { applyTableEdit, readDocumentSnapshot, selectTable, waitForWordHost } from "../src/word/wordHost";
import type { AiSuggestion } from "../src/shared";
import type { AiTableEdit } from "../src/tables";

const BUDGET = [
  ["Item", "Year 1", "Year 2"],
  ["Personnel", "$120,000", "$124,000"],
  ["Equipment", "$30,000", "$0"]
];

let mock: MockWordHost;

beforeEach(() => {
  mock = new MockWordHost({
    paragraphs: [
      { text: "Budget Justification", styleBuiltIn: "Heading1", style: "Heading 1", outlineLevel: 1 },
      { text: "Table 1. Requested budget by year." },
      { text: "Personnel costs cover the PI and one postdoc." },
      { text: "Timeline follows." }
    ],
    tables: [{ afterParagraph: 1, rows: BUDGET }]
  }).install();
});

afterEach(() => {
  mock.uninstall();
});

async function snapshot() {
  const host = await waitForWordHost();
  return readDocumentSnapshot(host.capabilities);
}

function tableSuggestion(table: AiTableEdit, original = "[Table 1]"): AiSuggestion {
  return { id: "t1", kind: "table", table, title: "Table", original, replacement: "", rationale: "", confidence: 0.8, target: "global", status: "pending" };
}

describe("word host: tables", () => {
  it("reads top-level tables as grids with their caption and first-cell paragraph", async () => {
    const snap = await snapshot();
    expect(snap.tables).toEqual([{ index: 0, rows: BUDGET, paragraphIndex: 2, context: "Table 1. Requested budget by year." }]);
    expect(snap.paragraphs[2].text).toBe("Item");
  });

  it("inserts a new table after the paragraph holding the anchor text", async () => {
    const snap = await snapshot();
    const rows = [["Phase", "Months"], ["Pilot", "1-6"]];
    const result = await applyTableEdit(snap, tableSuggestion({ action: "insert", index: null, rows, before: null, header: true }, "Timeline follows."), { trackChanges: "word", highlightChanges: false, matchIndex: null });
    expect(result.trackedChange).toBe(false);
    const ids = mock.tableIds();
    expect(ids).toHaveLength(2);
    expect(mock.tableGrid(ids[1])).toEqual(rows);
    expect(mock.tableMeta.get(ids[1])).toMatchObject({ header: 1, style: "GridTable1Light" });
    expect((await snapshot()).tables?.[1].context).toBe("Timeline follows.");
  });

  it("morphs a table: adds a row and a column, sets only the changed cells, tracked", async () => {
    const snap = await snapshot();
    const after = [
      ["Item", "Year 1", "Year 2", "Total"],
      ["Personnel", "$120,000", "$124,000", "$244,000"],
      ["Supplies", "$8,000", "$8,000", "$16,000"],
      ["Equipment", "$30,000", "$0", "$30,000"]
    ];
    const result = await applyTableEdit(snap, tableSuggestion({ action: "replace", index: 0, rows: after, before: BUDGET }), { trackChanges: "always", highlightChanges: false, matchIndex: null });
    expect(result.trackedChange).toBe(true);
    expect(mock.changeTrackingMode).toBe("Off");
    expect(mock.tableGrid(mock.tableIds()[0])).toEqual(after);
    const actions = mock.tableEdits.map((edit) => edit.action);
    expect(actions.filter((action) => action === "insertRows")).toHaveLength(1);
    expect(actions.filter((action) => action === "insertColumns")).toHaveLength(1);
    // New row (3 cells) + new column (4 cells, one shared with the new row) = 7 cell writes; unchanged cells untouched.
    expect(actions.filter((action) => action === "setCell")).toHaveLength(7);
    expect(mock.tableEdits.every((edit) => edit.tracked)).toBe(true);
  });

  it("deletes a table", async () => {
    const snap = await snapshot();
    await applyTableEdit(snap, tableSuggestion({ action: "delete", index: 0, rows: null, before: BUDGET }), { trackChanges: "word", highlightChanges: false, matchIndex: null });
    expect(mock.tableIds()).toEqual([]);
    expect(mock.text).toBe("Budget Justification\nTable 1. Requested budget by year.\nPersonnel costs cover the PI and one postdoc.\nTimeline follows.");
  });

  it("refuses to touch a table that changed since the suggestion was made", async () => {
    const snap = await snapshot();
    const id = mock.tableIds()[0];
    const grid = mock.tableGrid(id);
    grid[1][1] = "$999";
    mock.writeTable(id, grid, "setCell");
    const before = mock.tableGrid(id);
    await expect(applyTableEdit(snap, tableSuggestion({ action: "replace", index: 0, rows: BUDGET.map((row) => [...row, "x"]), before: BUDGET }), { trackChanges: "word", highlightChanges: false, matchIndex: null }))
      .rejects.toThrow(/changed or is gone/);
    expect(mock.tableGrid(id)).toEqual(before);
  });

  it("finds its table even after another table was inserted before it", async () => {
    let snap = await snapshot();
    await applyTableEdit(snap, tableSuggestion({ action: "insert", index: null, rows: [["A"]], before: null }, "Budget Justification"), { trackChanges: "word", highlightChanges: false, matchIndex: null });
    const edited = BUDGET.map((row) => [...row]);
    edited[2][2] = "$10,000";
    await applyTableEdit(snap, tableSuggestion({ action: "replace", index: 0, rows: edited, before: BUDGET }), { trackChanges: "word", highlightChanges: false, matchIndex: null });
    expect(mock.tableGrid(mock.tableIds()[1])).toEqual(edited);
    snap = await snapshot();
    await selectTable(snap, 1);
    expect(mock.text.slice(mock.selection.from, mock.selection.to)).toContain("$10,000");
  });
});
