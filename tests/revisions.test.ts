// @vitest-environment node

import { describe, expect, it } from "vitest";
import { describeFocus, linkRevision, supersedeRevisedSuggestions } from "../server/revisions";
import { buildAgentTaskPrompt, buildCliPrompt } from "../server/ai";
import { createAgentRun, deleteAgentRun } from "../server/agent-run";
import type { AiRequest, AiSuggestion } from "../src/shared";

const focus = { suggestionId: "s-old", ref: "S3", title: "Tighten the opening claim", original: "The results were very unique.", replacement: "The results were unique.", rationale: "Absolute term." };

function suggestion(id: string, extra: Partial<AiSuggestion> = {}): AiSuggestion {
  return { id, title: id, original: "x", replacement: "y", rationale: "r", confidence: 0.8, target: "global", status: "pending", ...extra };
}

describe("refining one suggestion", () => {
  it("links the reply's first text suggestion to the suggestion the message was about", () => {
    const response = { provider: "codex" as const, message: "Revised.", suggestions: [suggestion("img", { kind: "image" }), suggestion("new"), suggestion("other")] };
    const linked = linkRevision({ focus }, response);
    expect(linked.suggestions.map((item) => item.revises ?? null)).toEqual([null, "s-old", null]);
    expect(linkRevision({ focus: null }, response)).toBe(response);
  });

  it("withdraws the earlier suggestion as superseded, never rejected outright, and only while pending", () => {
    const earlier = suggestion("s-old");
    const decided = suggestion("s-done", { status: "accepted" });
    const revision = suggestion("new", { revises: "s-old" });
    const [updated, untouched] = supersedeRevisedSuggestions([earlier, decided], [revision], "Jian");
    expect(updated).toMatchObject({ id: "s-old", status: "rejected", supersededBy: "new", decidedBy: "Jian", decisionNote: "Superseded by a revised suggestion" });
    expect(untouched).toBe(decided);
    expect(supersedeRevisedSuggestions([earlier], [suggestion("plain")], "Jian")).toEqual([earlier]);
  });

  it("puts both engines in revise-this-one mode", () => {
    const request: AiRequest = { provider: "codex", instruction: "keep the citation", mode: "global", documentHtml: "", documentText: "The results were very unique [2].", selection: null, focus };
    const oneShot = buildCliPrompt(request);
    expect(oneShot).toContain('replying about ONE of your earlier suggestions, S3 "Tighten the opening claim"');
    expect(oneShot).toContain("Produce exactly ONE revised suggestion");
    expect(oneShot).not.toContain("writer_stage_suggestions as a single item");
    const run = createAgentRun({ ...request, provider: "claude" });
    try {
      const agentic = buildAgentTaskPrompt({ ...request, provider: "claude" }, run);
      expect(agentic).toContain("Stage the revision with writer_stage_suggestions as a single item.");
    } finally {
      deleteAgentRun(run.id);
    }
    expect(describeFocus(null, "oneshot")).toEqual([]);
  });
});
