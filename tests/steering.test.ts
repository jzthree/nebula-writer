import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proposeChanges } from "../server/ai";
import { translateAppServerNotification } from "../server/codex-app-server";
import { markRunInFlight, resetSteering, steerRun } from "../server/steering";
import type { AiRequest } from "../src/shared";

const DOC = "The study will enroll participants. The sample size is adequate.";

function request(overrides: Partial<AiRequest> = {}): AiRequest {
  return { provider: "codex", instruction: "Tighten the text", mode: "global", documentHtml: "", documentText: DOC, selection: null, ...overrides };
}

/** Keep steering until the run accepts it (the turn has to start first). */
async function steerWhenReady(runId: string, text: string, timeoutMs = 8_000): Promise<{ ok: boolean; reason?: string }> {
  const started = Date.now();
  for (;;) {
    const result = await steerRun(runId, text);
    if (result.ok || Date.now() - started > timeoutMs) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let tempDir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["WRITER_ALLOW_CLI", "WRITER_CODEX_PATH", "WRITER_CLAUDE_PATH", "WRITER_CODEX_TRANSPORT", "WRITER_AI_ENGINE"];

beforeEach(() => {
  tempDir = mkdtempSync(join(process.cwd(), ".writer-steer-"));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  process.env.WRITER_ALLOW_CLI = "1";
  resetSteering();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  resetSteering();
});

function writeScript(name: string, lines: string[]): string {
  const path = join(tempDir, name);
  writeFileSync(path, ["#!/usr/bin/env node", ...lines].join("\n"), "utf8");
  chmodSync(path, 0o755);
  return path;
}

/**
 * A miniature `codex app-server`: JSON-RPC over stdio. A turn says it is
 * starting, waits up to 2 s for a steer, and answers with the structured
 * reply naming whatever the steer said.
 */
const FAKE_APP_SERVER = [
  "const args = process.argv.slice(2);",
  "if (args[0] !== 'app-server') {",
  // `codex exec` fallback: answer directly.
  "  process.stdin.resume(); process.stdin.on('end', () => {",
  "    process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'exec-thread' }) + '\\n');",
  "    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ message: 'Answered by exec.', suggestions: [] }) } }) + '\\n');",
  "    process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
  "  });",
  "} else if (process.env.FAKE_NO_APP_SERVER === '1') {",
  "  process.stderr.write(\"error: unrecognized subcommand 'app-server'\\n\"); process.exit(2);",
  "} else {",
  "  let buffer = ''; let steered = null; let finish = null;",
  "  const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
  "  const note = (method, params) => send({ method, params });",
  "  process.stdin.setEncoding('utf8');",
  "  process.stdin.on('data', (chunk) => { buffer += chunk; let n; while ((n = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); if (line.trim()) handle(JSON.parse(line)); } });",
  "  function handle(m) {",
  "    if (m.method === 'initialize') return send({ id: m.id, result: { userAgent: 'fake' } });",
  "    if (m.method === 'thread/start' || m.method === 'thread/resume') return send({ id: m.id, result: { thread: { id: m.params.threadId || 'app-thread' } } });",
  "    if (m.method === 'turn/start') {",
  "      send({ id: m.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });",
  "      note('turn/started', { turn: { id: 'turn-1' } });",
  "      note('item/started', { item: { type: 'mcpToolCall', id: 'i1', server: 'cua_repl', tool: 'js', arguments: { title: 'Look around' } } });",
  "      finish = setTimeout(done, 2000);",
  "      return;",
  "    }",
  "    if (m.method === 'turn/steer') {",
  "      if (m.params.expectedTurnId !== 'turn-1') return send({ id: m.id, error: { code: -32000, message: 'turn mismatch' } });",
  "      steered = m.params.input[0].text; send({ id: m.id, result: { turnId: 'turn-1' } });",
  "      note('item/completed', { item: { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: steered }] } });",
  "      clearTimeout(finish); setTimeout(done, 50);",
  "      return;",
  "    }",
  "  }",
  "  function done() {",
  "    const message = steered ? 'Done. Also: ' + (steered.includes('BANANA') ? 'BANANA' : '?') : 'Done.';",
  "    note('item/completed', { item: { type: 'agentMessage', id: 'a1', text: JSON.stringify({ message, suggestions: [] }) } });",
  "    note('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } });",
  "  }",
  "}"
];

describe("mid-turn steering: Codex app-server", () => {
  it("delivers a message into the running turn and returns the thread for follow-ups", async () => {
    process.env.WRITER_CODEX_TRANSPORT = "app-server";
    process.env.WRITER_CODEX_PATH = writeScript("fake-codex", FAKE_APP_SERVER);
    const release = markRunInFlight("run-codex");
    const pending = proposeChanges(request({ runId: "run-codex" }), { runId: "run-codex" });
    const steer = await steerWhenReady("run-codex", "End with BANANA.");
    const response = await pending;
    release();
    expect(steer.ok).toBe(true);
    expect(response.message).toContain("Done. Also: BANANA");
    expect(response.agentSessionId).toBe("app-thread");
    expect(await steerRun("run-codex", "too late")).toEqual({ ok: false, reason: "not-running" });
  });

  it("falls back to codex exec when the CLI has no app-server", async () => {
    process.env.WRITER_CODEX_TRANSPORT = "app-server";
    process.env.WRITER_CODEX_PATH = writeScript("fake-codex", ["process.env.FAKE_NO_APP_SERVER = '1';", ...FAKE_APP_SERVER]);
    const response = await proposeChanges(request());
    expect(response.message).toContain("Answered by exec.");
  });

  it("translates app-server events into the exec events the stream parser reads", () => {
    expect(translateAppServerNotification("item/completed", { item: { type: "agentMessage", id: "a", text: "hi" } })).toEqual({ type: "item.completed", item: { id: "a", type: "agent_message", text: "hi" } });
    expect(translateAppServerNotification("item/started", { item: { type: "mcpToolCall", id: "t", server: "s", tool: "js", arguments: { title: "x" } } }))
      .toMatchObject({ type: "item.started", item: { type: "mcp_tool_call", tool: "js", arguments: { title: "x" } } });
    expect(translateAppServerNotification("turn/completed", { turn: { status: "failed", error: { message: "boom" } } })).toEqual({ type: "turn.failed", message: "boom", error: { message: "boom" } });
    expect(translateAppServerNotification("error", { error: { message: "retrying" }, willRetry: true })).toBeNull();
    expect(translateAppServerNotification("thread/tokenUsage/updated", {})).toBeNull();
  });
});

describe("mid-turn steering: Claude agentic turn", () => {
  it("writes the steer into the open stream-json stdin and closes it at the result", async () => {
    process.env.WRITER_CLAUDE_PATH = writeScript("fake-claude", [
      "const args = process.argv.slice(2);",
      "if (!args.includes('--input-format')) { process.stderr.write('expected stream-json input'); process.exit(3); }",
      "let buffer = ''; const messages = []; let timer = null;",
      "const reply = () => {",
      "  const steered = messages.slice(1).map((m) => m.message.content[0].text).join(' ');",
      "  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Finished.' + (steered.includes('BANANA') ? ' BANANA' : ''), session_id: 'sess-1' }) + '\\n');",
      "};",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { buffer += chunk; let n; while ((n = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); if (!line.trim()) continue; messages.push(JSON.parse(line));",
      "  if (messages.length === 1) { process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__writer__writer_read_document', input: {} }] } }) + '\\n'); timer = setTimeout(reply, 2000); }",
      "  else { clearTimeout(timer); setTimeout(reply, 50); } } });",
      // Exits only when Writer closes stdin after the result.
      "process.stdin.on('end', () => process.exit(0));"
    ]);
    const pending = proposeChanges(request({ provider: "claude", runId: "run-claude" }), { runId: "run-claude" });
    const steer = await steerWhenReady("run-claude", "Say BANANA at the end.");
    const response = await pending;
    expect(steer.ok).toBe(true);
    expect(response.message).toContain("BANANA");
    expect(response.agentSessionId).toBe("sess-1");
    expect((await steerRun("run-claude", "late")).ok).toBe(false);
  });
});

describe("mid-turn steering: registry", () => {
  it("holds a message for a run that has no session yet and hands back what never got delivered", async () => {
    expect(await steerRun("nobody", "hi")).toEqual({ ok: false, reason: "not-running" });
    const release = markRunInFlight("between");
    expect(await steerRun("between", "hi")).toEqual({ ok: true, held: true });
    expect(release()).toEqual(["hi"]);
    expect(await steerRun("between", "hi")).toEqual({ ok: false, reason: "not-running" });
  });

  it("delivers a held message as soon as the run's session starts", async () => {
    process.env.WRITER_CODEX_TRANSPORT = "app-server";
    process.env.WRITER_CODEX_PATH = writeScript("fake-codex", FAKE_APP_SERVER);
    const release = markRunInFlight("early");
    // Sent before the CLI is even spawned (the request is still queued/starting).
    expect(await steerRun("early", "End with BANANA.")).toEqual({ ok: true, held: true });
    const response = await proposeChanges(request({ runId: "early" }), { runId: "early" });
    expect(response.message).toContain("BANANA");
    expect(release()).toEqual([]);
  });
});
