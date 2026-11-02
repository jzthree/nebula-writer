// @vitest-environment node
import { describe, expect, it } from "vitest";
import { revertSuggestionOf } from "../src/revertSuggestion";
import type { AiSuggestion } from "../src/shared";

const base: AiSuggestion = { id: "s1", title: "t", original: "very important", replacement: "key", rationale: "", confidence: 0.8, target: "global", status: "accepted" };

describe("revertSuggestionOf", () => {
  it("swaps a replacement back, keeping the anchor and swapping emphasis", () => {
    const anchor = { offset: 10, before: "It is a ", after: " factor." };
    const emphasis = { original: [], replacement: [{ start: 0, end: 3, kinds: ["bold" as const] }] };
    const inverse = revertSuggestionOf({ ...base, anchor, emphasis: emphasis as never });
    expect(inverse).toMatchObject({ original: "key", replacement: "very important", anchor, range: null });
    expect(inverse?.emphasis).toEqual({ original: emphasis.replacement, replacement: [] });
  });

  it("puts a deletion back between the text that surrounded it, within its paragraph", () => {
    const anchor = { offset: 20, before: "Heading\nA sentence. ", after: " Next one.\nOther" };
    const inverse = revertSuggestionOf({ ...base, original: "Aside here.", replacement: "", anchor });
    expect(inverse).toMatchObject({ original: "A sentence.  Next one.", replacement: "A sentence. Aside here. Next one." });
    // Whitespace at the deleted passage's ends stayed in the document, so it is part of what to find.
    expect(revertSuggestionOf({ ...base, original: " Aside here. ", replacement: "", anchor: { offset: 19, before: "A sentence.", after: "Next one." } })).toMatchObject({ original: "A sentence.  Next one.", replacement: "A sentence. Aside here. Next one." });
    expect(inverse?.anchor).toEqual({ offset: 8, before: "Heading\n", after: "\nOther" });
  });

  it("undoes table inserts and replacements", () => {
    const rows = [["a", "b"]];
    const before = [["a", "c"]];
    expect(revertSuggestionOf({ ...base, kind: "table", table: { action: "insert", index: null, rows, before: null } })?.table).toEqual({ action: "delete", index: null, rows: null, before: rows });
    expect(revertSuggestionOf({ ...base, kind: "table", table: { action: "replace", index: 2, rows, before } })?.table).toEqual({ action: "replace", index: 2, rows: before, before: rows });
  });

  it("offers nothing it cannot undo", () => {
    expect(revertSuggestionOf({ ...base, commentOnly: true })).toBeNull();
    expect(revertSuggestionOf({ ...base, kind: "table", table: { action: "delete", index: 0, rows: null, before: [["a"]] } })).toBeNull();
    expect(revertSuggestionOf({ ...base, kind: "image" })).toBeNull();
    expect(revertSuggestionOf({ ...base, replacement: "", anchor: { offset: 0, before: "\n", after: "\n" } })).toBeNull();
  });
});
