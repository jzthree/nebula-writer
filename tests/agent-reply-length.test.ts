// @vitest-environment node
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliResponse, proposeChanges } from "../server/ai";
import type { AiRequest } from "../src/shared";

const request: AiRequest = { provider: "antigravity", instruction: "Compare the two models in detail", mode: "global", documentHtml: "", documentText: "The study will enroll participants.", selection: null };

/** A long answer whose middle is recognizable: the part a diagnostic trim would drop. */
const LONG_REPLY = ["# Comparison", "BEGINNING OF THE ANSWER", ..."Row of the comparison table. ".repeat(150).match(/.{1,120}/g)!, "MIDDLE OF THE ANSWER", ..."Further detail on each model. ".repeat(150).match(/.{1,120}/g)!, "END OF THE ANSWER"].join("\n");

const ENV_KEYS = ["WRITER_ALLOW_CLI", "WRITER_ANTIGRAVITY_PATH", "WRITER_SENTENCE_VETTING"];
const savedEnv: Record<string, string | undefined> = {};
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(process.cwd(), ".writer-reply-length-"));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
});

describe("an agent's long answer", () => {
  it("reaches the pane whole from an agentic session (Antigravity over ACP)", async () => {
    const fake = join(dir, "agy");
    // Speaks just enough ACP to answer one prompt with the long reply.
    writeFileSync(fake, `#!/usr/bin/env node
const reply = ${JSON.stringify(LONG_REPLY)};
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "conv-long" } });
    else if (m.method && m.method.startsWith("session/set_")) send({ id: m.id, result: {} });
    else if (m.method === "session/prompt") {
      send({ method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } } });
      send({ id: m.id, result: { stopReason: "end_turn" } });
    }
  }
});
`, "utf8");
    chmodSync(fake, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_ANTIGRAVITY_PATH = fake;
    process.env.WRITER_SENTENCE_VETTING = "off";

    const response = await proposeChanges(request);

    expect(LONG_REPLY.length).toBeGreaterThan(8_000);
    expect(response.message).toContain("BEGINNING OF THE ANSWER");
    expect(response.message).toContain("MIDDLE OF THE ANSWER");
    expect(response.message).toContain("END OF THE ANSWER");
    expect(response.message).not.toContain("provider output truncated");
  }, 30_000);

  it("reaches the pane whole from a one-shot reply", () => {
    const response = parseCliResponse("codex", JSON.stringify({ message: LONG_REPLY, suggestions: [] }), { ...request, provider: "codex" });

    expect(response.message).toContain(LONG_REPLY);
    expect(response.message).not.toContain("provider output truncated");
  });
});
