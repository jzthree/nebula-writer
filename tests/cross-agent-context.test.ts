// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { buildAgentTaskPrompt, describeConversation, turnsMissedBySession } from "../server/ai";
import type { AiConversationTurn, AiRequest } from "../src/shared";
import type { ChatTurn } from "../src/word/WordPane";
import { buildConversationDigest } from "../src/word/App";

const DOCUMENT = "Aim 1 studies transcription initiation. Panel e compares against AlphaGenome.";

function request(provider: AiRequest["provider"], conversation: AiConversationTurn[], agentSessionId: string | null = "thread-1"): AiRequest {
  return { provider, instruction: "continue", mode: "global", documentHtml: "", documentText: DOCUMENT, selection: null, conversation, agentSessionId } as AiRequest;
}

// Antigravity answered, then the user asked Claude by mistake and stopped it.
const SWITCHED: AiConversationTurn[] = [
  { role: "user", content: "remake the figure as one row" },
  { role: "assistant", content: "Rebuilt the figure.", provider: "antigravity", decisions: [{ ref: "S1", title: "Figure 6", status: "applied", note: null }] },
  { role: "user", content: "drop panels a and d; panel e overstates the gain over AlphaGenome" },
  { role: "assistant", content: "Stopped.", provider: "claude", failed: true }
];

describe("a resumed agent session is told the turns it missed", () => {
  it("names what went to another agent or was stopped, ahead of the decisions since", () => {
    const lines = describeConversation(request("antigravity", SWITCHED), { "S1|Figure 6": "pending|" }).join("\n");
    expect(lines).toContain("Since your last turn the conversation went on without you");
    expect(lines).toContain("User: drop panels a and d; panel e overstates the gain over AlphaGenome");
    expect(lines).toMatch(/Another agent \(.+\) \(stopped or failed before answering\): Stopped\./);
    expect(lines).not.toContain("User: remake the figure as one row");
    expect(lines).toContain('S1 "Figure 6" — applied');
  });

  it("adds nothing when the session's own reply is the latest turn", () => {
    const lines = describeConversation(request("antigravity", SWITCHED.slice(0, 2)), { "S1|Figure 6": "applied|" }).join("\n");
    expect(lines).not.toContain("went on without you");
    expect(lines).toContain("Since your last turn the user has not acted on your suggestions");
  });

  it("tells the other agent everything when it has not answered in the recent conversation", () => {
    const missed = turnsMissedBySession(SWITCHED, "codex");
    expect(missed).toHaveLength(4);
    const prompt = buildAgentTaskPrompt(request("codex", SWITCHED), { maxSuggestions: 6, attachments: [] }, {});
    expect(prompt).toContain("User: remake the figure as one row");
    expect(prompt).toMatch(/Another agent \(.+\): Rebuilt the figure\./);
  });

  it("treats a stopped reply of its own as unseen, and a message sent into its running reply as seen", () => {
    const turns: AiConversationTurn[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "Done first.", provider: "claude" },
      { role: "user", content: "also check the legend", steeredInto: "claude" },
      { role: "user", content: "second" },
      { role: "assistant", content: "Stopped.", provider: "claude", failed: true }
    ];
    expect(turnsMissedBySession(turns, "claude")?.map((turn) => turn.content)).toEqual(["second", "Stopped."]);
  });

  it("keeps the old behavior for a pane that does not say which agent answered", () => {
    const legacy = SWITCHED.map(({ provider: _provider, failed: _failed, ...turn }) => turn);
    expect(turnsMissedBySession(legacy, "antigravity")).toBeNull();
    expect(describeConversation(request("antigravity", legacy), {}).join("\n")).not.toContain("went on without you");
  });

  it("labels other agents' replies in a resumed recap without a ledger", () => {
    const lines = describeConversation(request("antigravity", SWITCHED)).join("\n");
    expect(lines).toContain("You: Rebuilt the figure.");
    expect(lines).toMatch(/Another agent \(.+\) \(stopped or failed before answering\): Stopped\./);
  });
});

describe("the pane's conversation digest", () => {
  it("says which agent answered, which replies were stopped, and where a running-turn message went", () => {
    const at = "2026-11-27T05:00:00.000Z";
    const reply = (id: string, provider: string, status: "done" | "error", extra: Partial<Extract<ChatTurn, { role: "assistant" }>> = {}): ChatTurn => ({ id, role: "assistant", at, text: status === "error" ? "Stopped." : "Done.", status, engine: provider, suggestionIds: [], progress: null, origin: "pane", activity: [], provider, ...extra });
    const turns: ChatTurn[] = [
      { id: "u1", role: "user", at, text: "remake the figure" },
      reply("a1", "antigravity", "done"),
      { id: "u2", role: "user", at, text: "keep panel b", steered: true },
      { id: "u3", role: "user", at, text: "drop panel a" },
      reply("a2", "claude", "error"),
      reply("a3", "codex", "done", { parallel: true })
    ];
    const digest = buildConversationDigest(turns, [], {});
    expect(digest[1]).toMatchObject({ role: "assistant", provider: "antigravity" });
    expect(digest[1].failed).toBeUndefined();
    expect(digest[2]).toMatchObject({ role: "user", content: "keep panel b", steeredInto: "antigravity" });
    expect(digest[3].steeredInto).toBeUndefined();
    expect(digest[4]).toMatchObject({ provider: "claude", failed: true });
    expect(digest[5]).toMatchObject({ provider: "codex", parallel: true });
  });
});
