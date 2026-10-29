// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyTableSteps, cleanGrid, documentTableLabel, findEditTarget, gridForPrompt, planTableMorph, sameGrid } from "../src/tables";

const BUDGET = [
  ["Item", "Year 1", "Year 2"],
  ["Personnel", "$120,000", "$124,000"],
  ["Equipment", "$30,000", "$0"],
  ["Travel", "$5,000", "$5,000"]
];

function morphs(before: string[][], after: string[][]) {
  const morph = planTableMorph(before, after);
  expect(applyTableSteps(before, morph.steps)).toEqual(after);
  return morph;
}

describe("table morph", () => {
  it("rewrites only the cells that changed when the shape is the same", () => {
    const after = BUDGET.map((row) => [...row]);
    after[2][2] = "$10,000";
    const morph = morphs(BUDGET, after);
    expect(morph.structural).toBe(false);
    expect(morph.steps).toEqual([{ type: "setCell", row: 2, column: 2, text: "$10,000" }]);
  });

  it("inserts a new row where it belongs and leaves the others alone", () => {
    const after = [...BUDGET.slice(0, 3), ["Supplies", "$8,000", "$8,000"], BUDGET[3]];
    const morph = morphs(BUDGET, after);
    expect(morph.steps.filter((step) => step.type !== "setCell")).toEqual([{ type: "insertRow", at: 3 }]);
    expect(morph.steps.filter((step) => step.type === "setCell").every((step) => step.type === "setCell" && step.row === 3)).toBe(true);
  });

  it("deletes a row and adds a column in one change", () => {
    const after = [
      ["Item", "Year 1", "Year 2", "Total"],
      ["Personnel", "$120,000", "$124,000", "$244,000"],
      ["Travel", "$5,000", "$5,000", "$10,000"]
    ];
    const morph = morphs(BUDGET, after);
    expect(morph.steps.filter((step) => step.type !== "setCell")).toEqual([{ type: "deleteRow", row: 2 }, { type: "insertColumn", at: 3 }]);
  });

  it("removes a middle column", () => {
    const after = BUDGET.map((row) => [row[0], row[2]]);
    const morph = morphs(BUDGET, after);
    expect(morph.steps).toEqual([{ type: "deleteColumn", column: 1 }]);
  });

  it("keeps the shape of an irregular table and only sets cells", () => {
    const after = BUDGET.map((row) => [...row]);
    after[0][0] = "Category";
    expect(planTableMorph(BUDGET, after, { irregular: true }).steps).toEqual([{ type: "setCell", row: 0, column: 0, text: "Category" }]);
  });

  it("still reaches the target when every value is rewritten", () => {
    morphs([["a", "b"], ["c", "d"]], [["w", "x", "y"], ["z", "1", "2"], ["3", "4", "5"]]);
  });
});

describe("table helpers", () => {
  it("finds the table an edit was made for even after its index shifted", () => {
    const tables = [{ index: 0, rows: [["New"]] }, { index: 1, rows: BUDGET }];
    expect(findEditTarget(tables, { index: 0, before: BUDGET })).toBe(1);
    expect(findEditTarget(tables, { index: 1, before: [["Changed"]] })).toBeNull();
  });

  it("compares grids ignoring whitespace", () => {
    expect(sameGrid([["a  b"]], [[" a b "]])).toBe(true);
    expect(sameGrid([["a"]], [["a"], ["b"]])).toBe(false);
  });

  it("validates proposed grids and pads short rows", () => {
    expect(cleanGrid([["a", "b"], ["c"]])).toEqual({ rows: [["a", "b"], ["c", ""]] });
    expect(cleanGrid([])).toHaveProperty("error");
    expect(cleanGrid([[{}]])).toHaveProperty("error");
  });

  it("labels and renders tables for prompts", () => {
    expect(documentTableLabel({ index: 1, rows: BUDGET, context: "Table 2. Budget" })).toBe('[Table 2] 4×3 after "Table 2. Budget"');
    expect(gridForPrompt([["a|b", "two\nlines"]])).toBe("| a\\|b | two / lines |");
  });
});
