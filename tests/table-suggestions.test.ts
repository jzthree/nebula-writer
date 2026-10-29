// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildDocumentTablePromptLines } from "../server/ai";
import { isTableCandidate, validateTableCandidate } from "../server/suggestion-validation";
import { parseDocumentTables, type DocumentTable } from "../src/tables";

const BUDGET: DocumentTable = {
  index: 0,
  rows: [["Item", "Year 1"], ["Personnel", "$120,000"], ["Travel", "$5,000"]],
  paragraphIndex: 2,
  context: "Table 1. Budget"
};
const TEXT = "Budget justification\nTable 1. Budget\nItem\nYear 1\nPersonnel\n$120,000\nTravel\n$5,000\nTimeline follows.";
const request = { documentText: TEXT, documentTables: [BUDGET], mode: "global" as const, selection: null };

describe("table suggestions", () => {
  it("recognises table candidates only by their action", () => {
    expect(isTableCandidate({ tableAction: "replace" })).toBe(true);
    expect(isTableCandidate({ tableAction: null, original: "x" })).toBe(false);
  });

  it("stages a replace with the table's grid at staging time", () => {
    const verdict = validateTableCandidate({ tableAction: "replace", tableIndex: 0, tableRows: [["Item", "Year 1"], ["Personnel", "$120,000"], ["Supplies", "$2,000"], ["Travel", "$5,000"]], title: "Add supplies", rationale: "Missing line." }, request);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.suggestion.kind).toBe("table");
    expect(verdict.suggestion.original).toBe('[Table 1] 3×2 after "Table 1. Budget"');
    expect(verdict.suggestion.replacement).toBe("");
    expect(verdict.suggestion.table).toEqual({ action: "replace", index: 0, rows: expect.any(Array), before: BUDGET.rows });
  });

  it("anchors an insert to exact document text and never reads as a deletion", () => {
    const verdict = validateTableCandidate({ tableAction: "insert", original: "Timeline follows.", tableRows: [["Aim", "Year"], ["1", "2027"]], tableHeader: true, title: "Timeline", rationale: "Clearer." }, request);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.suggestion.original).toBe("Timeline follows.");
    expect(verdict.suggestion.table).toMatchObject({ action: "insert", index: null, header: true, before: null });
    expect(verdict.suggestion.anchor?.offset).toBe(TEXT.indexOf("Timeline follows."));
  });

  it("rejects what cannot be applied, with a reason the agent can act on", () => {
    expect(validateTableCandidate({ tableAction: "replace", tableIndex: 3, tableRows: [["a"]] }, request)).toMatchObject({ ok: false, reason: expect.stringContaining("between 0 and 0") });
    expect(validateTableCandidate({ tableAction: "replace", tableIndex: 0, tableRows: BUDGET.rows }, request)).toMatchObject({ ok: false, reason: expect.stringContaining("same as the table") });
    expect(validateTableCandidate({ tableAction: "insert", original: "Not in the document", tableRows: [["a"]] }, request)).toMatchObject({ ok: false });
    expect(validateTableCandidate({ tableAction: "insert", original: "Timeline follows.", tableRows: [] }, request)).toMatchObject({ ok: false, reason: expect.stringContaining("tableRows") });
    expect(validateTableCandidate({ tableAction: "replace", tableIndex: 0, tableRows: [["a", "b", "c"]] }, { ...request, documentTables: [{ ...BUDGET, irregular: true }] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("merged cells") });
  });

  it("stages a delete without a grid", () => {
    const verdict = validateTableCandidate({ tableAction: "delete", tableIndex: 0, tableRows: null }, request);
    expect(verdict.ok && verdict.suggestion.table).toEqual({ action: "delete", index: 0, rows: null, before: BUDGET.rows });
  });

  it("shows tables to one-shot prompts as grids, with the contract", () => {
    const lines = buildDocumentTablePromptLines({ documentTables: [BUDGET] }).join("\n");
    expect(lines).toContain("| Personnel | $120,000 |");
    expect(lines).toContain('tableAction "replace"');
    expect(buildDocumentTablePromptLines({}).join("\n")).toContain('tableAction "insert"');
  });

  it("validates tables sent by clients", () => {
    expect(parseDocumentTables([{ index: 0, rows: [["a", "b"], ["c"]], context: "x" }])).toEqual({ value: [{ index: 0, rows: [["a", "b"], ["c", ""]], paragraphIndex: null, context: "x" }] });
    expect(parseDocumentTables([{ index: -1, rows: [] }])).toHaveProperty("error");
    expect(parseDocumentTables(undefined)).toEqual({ value: undefined });
  });
});

describe("agents stage table changes", () => {
  it("validates table candidates through the run's staging", async () => {
    const { createAgentRun, stageAgentRunSuggestions } = await import("../server/agent-run");
    const run = createAgentRun({ provider: "claude", instruction: "Add supplies", mode: "global", documentHtml: "", documentText: TEXT, selection: null, documentTables: [BUDGET] });
    const outcome = stageAgentRunSuggestions(run, [
      { tableAction: "replace", tableIndex: 0, tableRows: [...BUDGET.rows, ["Supplies", "$2,000"]], title: "Add supplies", rationale: "Missing." },
      { tableAction: "replace", tableIndex: 9, tableRows: [["a"]], title: "Bad", rationale: "x" }
    ]);
    expect(outcome.results.map((result) => result.staged)).toEqual([true, false]);
    expect(run.staged[0].kind).toBe("table");
  });

  it("tells agents about the tables and the tool", async () => {
    const { buildAgentTaskPrompt } = await import("../server/ai");
    const prompt = buildAgentTaskPrompt({ provider: "claude", instruction: "x", mode: "global", documentHtml: "", documentText: TEXT, selection: null, documentTables: [BUDGET] }, { maxSuggestions: null, attachments: [] });
    expect(prompt).toContain("writer_stage_table_edit");
    expect(prompt).toContain("[Table 1]");
  });
});
