import { describe, expect, it } from "vitest";
import { buildAgentTaskPrompt, buildCliPrompt } from "../server/ai";
import type { AiRequest } from "../src/shared";

const paragraph = "We see broad potential for this method across genomic profiling. Rare cell populations are examples of this broader opportunity. We believe these advances will interest readers.";
const documentText = `Dear Editors,\n${paragraph}\nThank you for considering it.`;
const sentence = "We believe these advances will interest readers.";
const from = documentText.indexOf(sentence);

function request(extra: Partial<AiRequest> = {}): AiRequest {
  return {
    provider: "codex",
    instruction: "phrase this differently?",
    mode: "selection",
    documentText,
    selection: { from, to: from + sentence.length, text: sentence },
    ...extra
  } as AiRequest;
}

describe("a selection travels with its paragraph", () => {
  it("quotes the whole current paragraph even when a resumed turn only gets a diff", () => {
    const prompt = buildCliPrompt(request({ agentSessionId: "thread-1" }), { documentDelta: ["Document: unchanged since your previous turn in this thread."] });
    expect(prompt).toContain("Document: unchanged since your previous turn");
    expect(prompt).toContain(`<<<paragraph\n${paragraph}\n>>>`);
    expect(prompt).toContain("do not repeat words, phrases or ideas the rest of its paragraph already has");
  });

  it("gives the agent the paragraph too", () => {
    const prompt = buildAgentTaskPrompt(request({ provider: "claude" }), { maxSuggestions: 5, attachments: [] });
    expect(prompt).toContain(`<<<paragraph\n${paragraph}\n>>>`);
  });

  it("skips the quote when the selection is the whole paragraph, keeping the instruction", () => {
    const whole = documentText.indexOf(paragraph);
    const prompt = buildCliPrompt(request({ selection: { from: whole, to: whole + paragraph.length, text: paragraph } }));
    expect(prompt).not.toContain("<<<paragraph");
    expect(prompt).toContain("A rewrite of the selection must read well where it sits");
  });
});
