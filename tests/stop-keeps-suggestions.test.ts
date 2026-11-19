// @vitest-environment node
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWriterApp } from "../server/app";
import { proposeChanges } from "../server/ai";
import { conversationStore } from "../server/conversation-store";

const DOC = "Our study enrolls participants. The sample size is adequate.";

/**
 * A stand-in Claude Code: stages one suggestion through the run's MCP URL,
 * writes a `staged` marker next to itself, then behaves as `mode` says:
 * "hang" never answers (a run the author stops), "linger" answers and then
 * stays up the way Claude Code does while background commands it started
 * are still running.
 */
function fakeClaude(dir: string, mode: "hang" | "linger"): string {
  const path = join(dir, `fake-claude-${mode}`);
  writeFileSync(path, [
    "#!/usr/bin/env node",
    'import fs from "node:fs";',
    "const args = process.argv.slice(2);",
    'const config = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));',
    "const runUrl = config.mcpServers.writer.env.WRITER_AGENT_RUN_URL;",
    'const marker = new URL("./staged", import.meta.url);',
    'const staged = { title: "Justify the sample size", original: "The sample size is adequate.", replacement: "The sample size is justified by a power analysis.", rationale: "Reviewers ask." };',
    "process.stdin.resume();",
    "setInterval(() => {}, 1000);",
    'fetch(`${runUrl}/stage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suggestions: [staged] }) })',
    "  .then((response) => response.json())",
    "  .then(() => {",
    '    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-stop" }) + "\\n");',
    '    fs.writeFileSync(marker, "1");',
    mode === "linger"
      ? '    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Staged one edit.", session_id: "sess-stop" }) + "\\n");'
      : "",
    "  });"
  ].join("\n"), "utf8");
  chmodSync(path, 0o755);
  return path;
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let server: Server;
let base = "";
let tempDir = "";
const ENV_KEYS = ["WRITER_SIDECAR_PORT", "WRITER_ALLOW_CLI", "WRITER_CLAUDE_PATH", "WRITER_AI_ENGINE"] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  server = createWriterApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.WRITER_SIDECAR_PORT = String(port);
  process.env.WRITER_ALLOW_CLI = "1";
  process.env.WRITER_AI_ENGINE = "agentic";
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

beforeEach(() => {
  tempDir = mkdtempSync(join(process.cwd(), ".writer-stop-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("stopping a run keeps what it already proposed", () => {
  it("returns the staged suggestion when the author stops the agent", async () => {
    process.env.WRITER_CLAUDE_PATH = fakeClaude(tempDir, "hang");
    const controller = new AbortController();
    const pending = proposeChanges({ provider: "claude", instruction: "Fix the sample size claim", mode: "global", documentHtml: "", documentText: DOC, selection: null }, { signal: controller.signal });
    await waitFor(() => existsSync(join(tempDir, "staged")));
    controller.abort();
    const response = await pending;
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0]).toMatchObject({ original: "The sample size is adequate." });
    expect(response.message).toMatch(/^Stopped\. The 1 suggestion proposed before you stopped is kept\./);
  }, 30_000);

  it("ends the turn soon after the answer even if the CLI stays up", async () => {
    process.env.WRITER_CLAUDE_PATH = fakeClaude(tempDir, "linger");
    const started = Date.now();
    const response = await proposeChanges({ provider: "claude", instruction: "Fix the sample size claim", mode: "global", documentHtml: "", documentText: DOC, selection: null });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(response.suggestions).toHaveLength(1);
    expect(response.message).toContain("Staged one edit.");
    expect(response.agentSessionId).toBe("sess-stop");
  }, 30_000);

  it("finishes a stopped detached pane run as a reply with its suggestion, and saves it", async () => {
    process.env.WRITER_CLAUDE_PATH = fakeClaude(tempDir, "hang");
    const key = "word:stop-test.docx";
    const runId = "run-stop-keeps-1";
    const userTurn = { id: "u-stop", role: "user", at: "2026-11-19T10:00:00.000Z", text: "Fix it" };
    const replyTurn = { id: "a-stop", role: "assistant", at: "2026-11-19T10:00:00.000Z", text: "", status: "running", engine: "Claude Code", suggestionIds: [], progress: null, origin: "pane", activity: [], runId, provider: "claude" };
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const started = await post("/api/word/suggest", {
      provider: "claude", runId, instruction: "Fix it", mode: "global", documentText: DOC, documentName: "stop-test.docx", detach: true,
      selection: null, record: { key, userTurn, replyTurn, proposedBy: "Claude Code" }
    });
    expect(started.status).toBe(202);
    await waitFor(() => existsSync(join(tempDir, "staged")));
    expect((await post(`/api/ai/runs/${runId}/stop`, {})).status).toBe(200);
    const state = await (await fetch(`${base}/api/ai/runs/${runId}?wait=20`)).json() as { status: string; result?: { ai: { message: string; suggestions: Array<{ id: string }> } } };
    expect(state.status).toBe("done");
    expect(state.result!.ai.suggestions).toHaveLength(1);
    expect(state.result!.ai.message).toMatch(/^Stopped\./);
    const reply = conversationStore().read(key, {}).turns.find((entry) => entry.id === "a-stop")!.turn as { status: string; suggestionIds: string[] };
    expect(reply.status).toBe("done");
    expect(reply.suggestionIds).toEqual(state.result!.ai.suggestions.map((suggestion) => suggestion.id));
  }, 30_000);
});
