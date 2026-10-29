// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import { afterEach, describe, expect, it } from "vitest";
import { applySuggestion, findSuggestionMatch, readEditorTables, revertTableSuggestion } from "../src/editorOps";
import type { AiSuggestion } from "../src/shared";

const BUDGET_HTML = "<p>Intro paragraph.</p><p>Table 1. Budget</p><table><tbody><tr><th><p>Item</p></th><th><p>Cost</p></th></tr><tr><td><p>Travel</p></td><td><p>$5,000</p></td></tr></tbody></table><p>After the table.</p>";

let editor: Editor | null = null;

function makeEditor(html: string): Editor {
  editor = new Editor({ extensions: [StarterKit, Table, TableRow, TableHeader, TableCell], content: html });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function tableSuggestion(overrides: Partial<AiSuggestion>): AiSuggestion {
  return {
    id: "t1",
    kind: "table",
    title: "Table",
    original: "[Table 1]",
    replacement: "",
    rationale: "",
    confidence: 0.8,
    target: "global",
    status: "pending",
    ...overrides
  } as AiSuggestion;
}

describe("web editor tables", () => {
  it("reads top-level tables as grids with their preceding paragraph", () => {
    const tables = readEditorTables(makeEditor(BUDGET_HTML));
    expect(tables).toEqual([{ index: 0, rows: [["Item", "Cost"], ["Travel", "$5,000"]], paragraphIndex: null, context: "Table 1. Budget" }]);
  });

  it("marks tables with merged cells as irregular", () => {
    const tables = readEditorTables(makeEditor('<table><tbody><tr><td colspan="2"><p>Wide</p></td></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>'));
    expect(tables[0].irregular).toBe(true);
  });

  it("inserts a table after the paragraph holding the anchor, never deleting the anchor", () => {
    const ed = makeEditor("<p>Our costs are below.</p><p>Closing.</p>");
    const result = applySuggestion(ed, tableSuggestion({
      original: "costs are below",
      table: { action: "insert", index: null, rows: [["Item", "Cost"], ["Travel", "$5,000"]], before: null, header: true }
    }));
    expect(result.ok).toBe(true);
    expect(ed.getHTML()).toContain("Our costs are below.");
    expect(readEditorTables(ed)[0].rows).toEqual([["Item", "Cost"], ["Travel", "$5,000"]]);
    const json = ed.getJSON();
    expect(json.content?.map((node) => node.type)).toEqual(["paragraph", "table", "paragraph"]);
    expect(json.content?.[1].content?.[0].content?.[0].type).toBe("tableHeader");
  });

  it("replaces the table it was made for, keeping its header row", () => {
    const ed = makeEditor(BUDGET_HTML);
    const suggestion = tableSuggestion({
      table: { action: "replace", index: 0, before: [["Item", "Cost"], ["Travel", "$5,000"]], rows: [["Item", "Cost"], ["Travel", "$6,000"], ["Supplies", "$1,000"]] }
    });
    expect(findSuggestionMatch(ed, suggestion)?.matchKind).toBe("exact");
    expect(applySuggestion(ed, suggestion).ok).toBe(true);
    expect(readEditorTables(ed)[0].rows).toEqual([["Item", "Cost"], ["Travel", "$6,000"], ["Supplies", "$1,000"]]);
    expect(ed.getJSON().content?.[2].content?.[0].content?.[0].type).toBe("tableHeader");
  });

  it("refuses a table that changed since the suggestion was made", () => {
    const ed = makeEditor(BUDGET_HTML);
    const result = applySuggestion(ed, tableSuggestion({
      table: { action: "replace", index: 0, before: [["Item", "Cost"], ["Travel", "$9"]], rows: [["x"]] }
    }));
    expect(result).toEqual({ ok: false, reason: "missing" });
    expect(readEditorTables(ed)[0].rows[1][1]).toBe("$5,000");
  });

  it("deletes a table", () => {
    const ed = makeEditor(BUDGET_HTML);
    expect(applySuggestion(ed, tableSuggestion({ table: { action: "delete", index: 0, before: [["Item", "Cost"], ["Travel", "$5,000"]], rows: null } })).ok).toBe(true);
    expect(readEditorTables(ed)).toEqual([]);
    expect(ed.getText()).toContain("After the table.");
  });

  it("undoes an accepted insert, replace and delete", () => {
    const ed = makeEditor(BUDGET_HTML);
    const before = [["Item", "Cost"], ["Travel", "$5,000"]];
    const replace = tableSuggestion({ table: { action: "replace", index: 0, before, rows: [["Item", "Cost"], ["Travel", "$6,000"]] } });
    expect(applySuggestion(ed, replace).ok).toBe(true);
    expect(revertTableSuggestion(ed, replace, null)).toBe(true);
    expect(readEditorTables(ed)[0].rows).toEqual(before);

    const insert = tableSuggestion({ original: "Intro paragraph.", table: { action: "insert", index: null, rows: [["New"]], before: null } });
    expect(applySuggestion(ed, insert).ok).toBe(true);
    expect(readEditorTables(ed)).toHaveLength(2);
    expect(revertTableSuggestion(ed, insert, null)).toBe(true);
    expect(readEditorTables(ed).map((table) => table.rows)).toEqual([before]);

    const remove = tableSuggestion({ table: { action: "delete", index: 0, before, rows: null } });
    const result = applySuggestion(ed, remove);
    expect(result.ok).toBe(true);
    expect(revertTableSuggestion(ed, remove, result.ok ? result.range.from : null)).toBe(true);
    expect(readEditorTables(ed)[0].rows).toEqual(before);
    expect(ed.getJSON().content?.map((node) => node.type)).toEqual(["paragraph", "paragraph", "table", "paragraph"]);
  });
});
