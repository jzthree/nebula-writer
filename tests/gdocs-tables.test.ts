import { afterEach, describe, expect, it } from "vitest";
import { nebulaApplyTable, nebulaReadDocument, nebulaSelectTable } from "../src/gdocs/script/main";
import { DOCS_CHANGE_HIGHLIGHT, type DocsTableOp } from "../src/gdocs/protocol";
import { googleDocsHost } from "../src/gdocs/docsHost";
import { setScriptTransport } from "../src/gdocs/scriptBridge";
import type { AiSuggestion } from "../src/shared";
import { buildFakeDocument, installFakeDocumentApp, FakeParagraph, FakeTable, type FakeDocument } from "./gdocs-fake";

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
  setScriptTransport(null);
});

const BUDGET = [["Item", "Year 1"], ["Personnel", "$120,000"], ["Travel", "$5,000"]];

function budgetDocument(): FakeDocument {
  const doc = buildFakeDocument([
    { text: "Table 1. Budget" },
    { table: BUDGET.map((row) => row.map((text) => ({ text }))) },
    { text: "Closing paragraph." }
  ]);
  restore = installFakeDocumentApp(doc);
  return doc;
}

const tableOf = (doc: FakeDocument, index = 0) => doc.body.children.filter((child): child is FakeTable => child instanceof FakeTable)[index];

const op = (overrides: Partial<DocsTableOp>): DocsTableOp => ({
  id: "t1", action: "replace", index: 0, before: BUDGET, rows: null, header: false, afterParagraphIndex: null, expectedParagraphText: null, highlight: false, ...overrides
});

describe("google docs script: tables", () => {
  it("reads top-level tables with their caption and first cell paragraph", () => {
    budgetDocument();
    expect(nebulaReadDocument().tables).toEqual([{ index: 0, rows: BUDGET, paragraphIndex: 1, context: "Table 1. Budget" }]);
  });

  it("adds a row and a column where they belong and highlights the changed cells", () => {
    const doc = budgetDocument();
    const rows = [["Item", "Year 1", "Year 2"], ["Personnel", "$120,000", "$124,000"], ["Supplies", "$8,000", "$8,000"], ["Travel", "$5,000", "$5,000"]];
    expect(nebulaApplyTable(op({ rows, highlight: true }))).toEqual({ id: "t1", ok: true });
    const table = tableOf(doc);
    expect(table.grid()).toEqual(rows);
    const supplies = table.getCell(2, 0).getChild(0) as FakeParagraph;
    expect(supplies.formatAt(0).background).toBe(DOCS_CHANGE_HIGHLIGHT);
    expect((table.getCell(0, 0).getChild(0) as FakeParagraph).formatAt(0).background).toBeNull();
  });

  it("removes rows and columns", () => {
    const doc = budgetDocument();
    expect(nebulaApplyTable(op({ rows: [["Item"], ["Travel"]] })).ok).toBe(true);
    expect(tableOf(doc).grid()).toEqual([["Item"], ["Travel"]]);
  });

  it("refuses a table that changed since the suggestion", () => {
    const doc = budgetDocument();
    tableOf(doc).getCell(1, 1).setText("$1");
    expect(nebulaApplyTable(op({ rows: BUDGET.slice(0, 2) }))).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
    expect(tableOf(doc).grid()[1]).toEqual(["Personnel", "$1"]);
  });

  it("inserts a table after a paragraph with a bold header, and deletes one", () => {
    const doc = budgetDocument();
    const result = nebulaApplyTable(op({ action: "insert", index: null, before: null, rows: [["Aim", "Year"], ["1", "2026"]], header: true, afterParagraphIndex: 7, expectedParagraphText: "Closing paragraph." }));
    expect(result).toEqual({ id: "t1", ok: true });
    const inserted = tableOf(doc, 1);
    expect(doc.body.children.indexOf(inserted)).toBe(3);
    expect(inserted.grid()).toEqual([["Aim", "Year"], ["1", "2026"]]);
    expect((inserted.getCell(0, 0).getChild(0) as FakeParagraph).formatAt(0).bold).toBe(true);
    expect((inserted.getCell(1, 0).getChild(0) as FakeParagraph).formatAt(0).bold).toBe(false);
    expect(nebulaApplyTable(op({ action: "delete" })).ok).toBe(true);
    expect(nebulaReadDocument().tables?.map((table) => table.rows)).toEqual([[["Aim", "Year"], ["1", "2026"]]]);
  });

  it("puts a table anchored in a cell after that table, not inside it", () => {
    const doc = budgetDocument();
    expect(nebulaApplyTable(op({ action: "insert", index: null, before: null, rows: [["x"]], afterParagraphIndex: 3, expectedParagraphText: "Personnel" })).ok).toBe(true);
    expect(doc.body.children.indexOf(tableOf(doc, 1))).toBe(2);
  });

  it("selects a table", () => {
    const doc = budgetDocument();
    nebulaSelectTable(0);
    expect(doc.selection).not.toBeNull();
    expect(() => nebulaSelectTable(3)).toThrow(/no table 4/);
  });
});

describe("google docs host: table suggestions", () => {
  const tableSuggestion = (table: AiSuggestion["table"], original: string): AiSuggestion => ({
    id: "s1", kind: "table", table, title: "Table", original, replacement: "", rationale: "", confidence: 0.7, target: "global", status: "pending"
  });

  async function snapshotWith(calls: Array<{ fn: string; args: unknown[] }>, outcome: { ok: boolean; error?: string } = { ok: true }) {
    setScriptTransport(async (fn, args) => {
      calls.push({ fn, args });
      if (fn === "nebulaReadDocument") {
        return {
          documentName: "Budget", documentId: "doc-1", images: [], fingerprint: "f1",
          paragraphs: ["Table 1. Budget", "Item", "Year 1", "Closing paragraph."].map((text) => ({ text, headingLevel: null, isListItem: false, style: "Normal", emphasis: [] })),
          tables: [{ index: 0, rows: [["Item", "Year 1"]], paragraphIndex: 1, context: "Table 1. Budget" }]
        };
      }
      if (fn === "nebulaApplyTable") {
        return { id: (args[0] as DocsTableOp).id, ...outcome };
      }
      return null;
    });
    return googleDocsHost.readDocumentSnapshot(googleDocsHost.detectCapabilities(true));
  }

  it("carries tables into the snapshot and inserts after the anchored paragraph", async () => {
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    const snapshot = await snapshotWith(calls);
    expect(snapshot.tables).toEqual([{ index: 0, rows: [["Item", "Year 1"]], paragraphIndex: 1, context: "Table 1. Budget" }]);
    const result = await googleDocsHost.applyTableEdit(snapshot, tableSuggestion({ action: "insert", index: null, rows: [["a"]], before: null, header: true }, "Closing"), { trackChanges: "word", highlightChanges: true, matchIndex: null });
    expect(result).toEqual({ trackedChange: false });
    expect(calls.at(-1)).toEqual({ fn: "nebulaApplyTable", args: [{
      id: "s1", action: "insert", index: null, before: null, rows: [["a"]], header: true,
      afterParagraphIndex: 3, expectedParagraphText: "Closing paragraph.", highlight: true
    }] });
  });

  it("sends replace ops with the staged grid and reports failures", async () => {
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    const snapshot = await snapshotWith(calls, { ok: false, error: "The table has changed" });
    const suggestion = tableSuggestion({ action: "replace", index: 0, rows: [["Item", "Year 2"]], before: [["Item", "Year 1"]] }, "[Table 1]");
    await expect(googleDocsHost.applyTableEdit(snapshot, suggestion, { trackChanges: "word", highlightChanges: false, matchIndex: null })).rejects.toThrow("The table has changed");
    expect(calls.at(-1)?.args[0]).toMatchObject({ action: "replace", index: 0, before: [["Item", "Year 1"]], rows: [["Item", "Year 2"]], afterParagraphIndex: null });
    await googleDocsHost.selectTable(snapshot, 0);
    expect(calls.at(-1)).toEqual({ fn: "nebulaSelectTable", args: [0] });
  });
});
