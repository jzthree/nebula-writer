// @vitest-environment node
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpUpdateMapper, antigravityDataDirArgs, antigravityModeFor, permissionAnswer, permits, toolCallInput } from "../server/acp-runtime";
import { runAgentTurn, type AgentEvent } from "../server/agent-runtime";
import { parseAntigravityModels, parseAntigravitySettingsDefaults } from "../server/model-catalog";
import { isLocalAiProvider, LOCAL_AI_PROVIDERS, providerCliName, providerName } from "../src/providers";

const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "deny", name: "Deny", kind: "reject_once" }];

describe("Antigravity access levels", () => {
  it("lets Writer's own tools through at every level and declines the rest unless reading is allowed", () => {
    const writerTool = { name: "mcp_writer_writer_stage_suggestions", kind: "other" };
    const read = { name: "view_file", kind: "read" };
    const command = { name: "run_command", kind: "execute" };
    for (const level of ["document", "read", "full"] as const) {
      expect(permits(level, writerTool)).toBe(true);
      expect(permits(level, command)).toBe(false);
    }
    expect(permits("document", read)).toBe(false);
    expect(permits("read", read)).toBe(true);
    expect(permissionAnswer("read", read, options)).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(permissionAnswer("full", command, options)).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(permissionAnswer("full", command, [])).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("runs full access as the user's own Antigravity in auto mode, and the rest in Writer's own data dir", () => {
    expect(antigravityDataDirArgs("full", {})).toEqual([]);
    expect(antigravityDataDirArgs("document", {})).toEqual(["--app-data-dir", "nebula-writer"]);
    expect(antigravityDataDirArgs("read", { WRITER_ANTIGRAVITY_DATA_DIR: "default" })).toEqual([]);
    expect(antigravityModeFor("full")).toBe("auto");
    expect(antigravityModeFor("document")).toBe("default");
  });

  it("reads Antigravity's command calls as commands, for the activity log", () => {
    expect(toolCallInput({ rawInput: { CommandLine: "ls -la", toolSummary: "List directory contents" } })).toMatchObject({ command: "ls -la", description: "List directory contents" });
  });
});

describe("ACP updates as Writer events", () => {
  const mapper = () => new AcpUpdateMapper((name) => `summary of ${name}`, (name) => name.replace(/^mcp_writer_/, ""));

  it("keeps the last message as the reply, announces each tool once, and shows thinking once per stretch", () => {
    const m = mapper();
    const events: AgentEvent[] = [
      ...m.consume({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Hmm" } }),
      ...m.consume({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " more" } }),
      ...m.consume({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading first." } }),
      ...m.consume({ sessionUpdate: "tool_call", toolCallId: "t1", name: "mcp_writer_writer_read_document", status: "in_progress", kind: "other" }),
      ...m.consume({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
      ...m.consume({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Staged " } }),
      ...m.consume({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "two edits." } }),
      ...m.consume({ sessionUpdate: "usage_update", used: 10 })
    ];
    expect(events.map((event) => event.kind)).toEqual(["thinking", "text", "tool", "text", "text"]);
    expect(events[2]).toEqual({ kind: "tool", tool: "writer_read_document", summary: "summary of mcp_writer_writer_read_document" });
    expect(m.reply()).toBe("Staged two edits.");
  });
});

describe("Antigravity model list", () => {
  it("reads agy models and maps the settings' display name to an id", () => {
    const models = parseAntigravityModels("Fetching available models...\ngemini-4-carbon-high\tGemini 4 Carbon (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nnot a model line\n");
    expect(models.map((model) => model.id)).toEqual(["gemini-4-carbon-high", "gemini-3.8-flash-low"]);
    expect(parseAntigravitySettingsDefaults(JSON.stringify({ model: "Gemini 4 Carbon (High)" }), models)).toEqual({ model: "gemini-4-carbon-high", reasoning: null });
    expect(parseAntigravitySettingsDefaults("{", models)).toEqual({ model: null, reasoning: null });
  });

  it("names every provider from one table", () => {
    expect(LOCAL_AI_PROVIDERS).toContain("antigravity");
    expect(isLocalAiProvider("antigravity")).toBe(true);
    expect(isLocalAiProvider("gemini")).toBe(false);
    expect(providerName("antigravity")).toBe("Antigravity");
    expect(providerCliName("codex")).toBe("Codex CLI");
    expect(providerName("demo")).toBe("Demo provider");
  });
});

describe("an Antigravity turn over ACP (stand-in agy)", () => {
  let dir: string;
  let log: string;
  const previous = process.env.WRITER_ANTIGRAVITY_PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "writer-acp-"));
    log = join(dir, "log.jsonl");
    const fake = join(dir, "agy");
    // Speaks just enough ACP: records what Writer sends, streams a reply, asks permission once.
    writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const log = ${JSON.stringify(log)};
const record = (entry) => fs.appendFileSync(log, JSON.stringify(entry) + "\\n");
if (process.argv[2] === "models") { console.log("Fetching available models..."); console.log("gemini-4-carbon-high\\tGemini 4 Carbon (High)"); process.exit(0); }
if (process.argv[2] === "--version") { console.log("1.5.9"); process.exit(0); }
record({ argv: process.argv.slice(2) });
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
let promptId = null;
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    record({ method: m.method, params: m.params, result: m.result });
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "conv-1", models: { currentModelId: "gemini-4-carbon-medium", availableModels: [] } } });
    else if (m.method === "session/load") {
      update(m.params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD HISTORY" } });
      if (m.params.sessionId === "gone") send({ id: m.id, error: { code: -32000, message: "conversation not found" } });
      else send({ id: m.id, result: {} });
    }
    else if (m.method === "session/set_model" || m.method === "session/set_mode") send({ id: m.id, result: {} });
    else if (m.method === "session/cancel") send({ id: promptId, result: { stopReason: "cancelled" } });
    else if (m.method === "session/prompt") {
      promptId = m.id;
      const sid = m.params.sessionId;
      if (m.params.prompt[0].text.includes("wait")) return;
      update(sid, { sessionUpdate: "tool_call", toolCallId: "c1", name: "run_command", kind: "execute", status: "pending", rawInput: { CommandLine: "rm -rf build" } });
      send({ id: 900, method: "session/request_permission", params: { sessionId: sid, toolCall: { name: "run_command", kind: "execute", rawInput: { CommandLine: "rm -rf build" } }, options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] } });
    }
    else if (m.id === 900) {
      update("conv-1", { sessionUpdate: "tool_call", toolCallId: "c2", name: "mcp_writer_writer_stage_suggestions", kind: "other", status: "in_progress", rawInput: { suggestions: [{}, {}] } });
      update("conv-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Staged two edits." } });
      send({ id: promptId, result: { stopReason: "end_turn" } });
    }
  }
});
`);
    chmodSync(fake, 0o755);
    process.env.WRITER_ANTIGRAVITY_PATH = fake;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.WRITER_ANTIGRAVITY_PATH; else process.env.WRITER_ANTIGRAVITY_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  const entries = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv?: string[]; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> });

  it("opens a session with Writer's MCP server, picks model and mode, streams the reply and declines what nobody can approve", async () => {
    const events: AgentEvent[] = [];
    const result = await runAgentTurn({
      provider: "antigravity", prompt: "Tighten the aims.", runUrl: "http://127.0.0.1:1/api/agent-run/r1", workspaceDir: dir,
      modelOptions: { model: "gemini-3.8-flash-low", reasoning: null }, toolAccess: "full", onEvent: (event) => events.push(event)
    });
    expect(result).toMatchObject({ ok: true, text: "Staged two edits.", sessionId: "conv-1", provider: "antigravity" });
    const sent = entries();
    expect(sent[0].argv).toEqual(["acp"]);
    const created = sent.find((entry) => entry.method === "session/new")!.params as { mcpServers: Array<{ name: string; env: Array<{ name: string; value: string }> }> };
    expect(created.mcpServers[0].name).toBe("writer");
    expect(created.mcpServers[0].env).toContainEqual({ name: "WRITER_AGENT_RUN_URL", value: "http://127.0.0.1:1/api/agent-run/r1" });
    expect(sent.find((entry) => entry.method === "session/set_model")!.params).toMatchObject({ modelId: "gemini-3.8-flash-low" });
    expect(sent.find((entry) => entry.method === "session/set_mode")!.params).toMatchObject({ modeId: "auto" });
    expect(sent.find((entry) => entry.result && "outcome" in entry.result)!.result).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(events).toContainEqual(expect.objectContaining({ kind: "status", stage: "declined" }));
    expect(events).toContainEqual({ kind: "tool", tool: "writer_stage_suggestions", summary: "staging 2 suggestions" });
  });

  it("resumes a conversation without replaying its history, and says when it is gone", async () => {
    const events: AgentEvent[] = [];
    const resumed = await runAgentTurn({ provider: "antigravity", prompt: "Follow up.", runUrl: "http://127.0.0.1:1/api/agent-run/r2", workspaceDir: dir, sessionId: "conv-1", toolAccess: "document", onEvent: (event) => events.push(event) });
    expect(resumed.ok).toBe(true);
    expect(events.some((event) => event.kind === "text" && event.text === "OLD HISTORY")).toBe(false);
    expect(entries()[0].argv).toEqual(["acp", "--app-data-dir", "nebula-writer"]);
    await expect(runAgentTurn({ provider: "antigravity", prompt: "Again.", runUrl: "http://127.0.0.1:1/api/agent-run/r3", workspaceDir: dir, sessionId: "gone", toolAccess: "full" })).rejects.toThrow(/session not found/);
  });

  it("cancels the turn when stopped", async () => {
    const controller = new AbortController();
    const turn = runAgentTurn({ provider: "antigravity", prompt: "Please wait.", runUrl: "http://127.0.0.1:1/api/agent-run/r4", workspaceDir: dir, toolAccess: "full", signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    await expect(turn).rejects.toThrow(/interrupted/);
    // The stand-in logs the cancel as it reads it: wait for that rather than a fixed time.
    for (let tries = 0; tries < 40 && !entries().some((entry) => entry.method === "session/cancel"); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(entries().some((entry) => entry.method === "session/cancel")).toBe(true);
  });
});
