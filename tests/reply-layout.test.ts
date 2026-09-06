// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { AiSuggestion } from "../src/shared";
import { parseAssistantReply } from "../src/word/replyLayout";

function suggestion(id: string, ref?: string): AiSuggestion {
  return { id, ref, title: id, original: `original ${id}`, replacement: `replacement ${id}`, rationale: "", confidence: 0.7, target: "global", range: null, status: "pending" };
}

describe("reply layout", () => {
  const suggestions = [suggestion("a", "S1"), suggestion("b", "S2"), suggestion("c", "S3")];

  it("places cards under the agent's headings in the order written", () => {
    const layout = parseAssistantReply("## Significance\nTwo claims were soft.\n[S2]\n[S1]\n\n## Approach\nOne note.\n[S3]", suggestions);
    expect(layout.structured).toBe(true);
    expect(layout.groups.map((group) => group.heading)).toEqual(["Significance", "Approach"]);
    expect(layout.groups[0].blocks).toEqual([{ kind: "text", text: "Two claims were soft." }, { kind: "cards", ids: ["b", "a"] }]);
    expect(layout.groups[1].ids).toEqual(["c"]);
  });

  it("accepts inline refs, bold headings, and alternative token spellings", () => {
    const layout = parseAssistantReply("**Aims**\nTightened the hypothesis {{S1}} and the payoff [[S2]].\n- [S3]", suggestions);
    expect(layout.groups[0].heading).toBe("Aims");
    expect(layout.groups[0].blocks[0]).toEqual({ kind: "text", text: "Tightened the hypothesis and the payoff ." });
    expect(layout.groups[0].ids).toEqual(["a", "b", "c"]);
  });

  it("appends unreferenced suggestions so nothing is hidden", () => {
    const layout = parseAssistantReply("## Significance\n[S1]", suggestions);
    expect(layout.groups.map((group) => group.heading)).toEqual(["Significance", "Other suggestions"]);
    expect(layout.groups[1].ids).toEqual(["b", "c"]);
  });

  it("keeps a plain reply as one group with all cards", () => {
    const layout = parseAssistantReply("Staged three edits near your caret.", suggestions);
    expect(layout.structured).toBe(false);
    expect(layout.groups).toHaveLength(1);
    expect(layout.groups[0].heading).toBeNull();
    expect(layout.groups[0].blocks).toEqual([{ kind: "text", text: "Staged three edits near your caret." }, { kind: "cards", ids: ["a", "b", "c"] }]);
  });

  it("falls back to positional refs when suggestions carry none, and ignores unknown refs", () => {
    const bare = [suggestion("x"), suggestion("y")];
    const layout = parseAssistantReply("[S2] first, then [S1]. [S9] is nothing.", bare);
    expect(layout.groups[0].ids).toEqual(["y", "x"]);
    expect(layout.groups[0].blocks[0]).toEqual({ kind: "text", text: "first, then . is nothing." });
    expect(layout.groups).toHaveLength(1);
  });

  it("never places the same suggestion twice", () => {
    const layout = parseAssistantReply("[S1] and again [S1]\n## More\n[S1]", suggestions);
    expect(layout.groups[0].ids).toEqual(["a"]);
    expect(layout.groups.find((group) => group.heading === "More")?.ids).toEqual([]);
    expect(layout.groups.find((group) => group.heading === "Other suggestions")?.ids).toEqual(["b", "c"]);
  });
});
