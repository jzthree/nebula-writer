// @vitest-environment node
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeCodexAppServers, runCodexAppServer, type CodexAppServerRun, TurnDeltaTracker } from "../server/codex-app-server";
import { CodexStreamParser } from "../server/agent-runtime";

/** A `codex app-server` that logs each start and each request; a turn whose prompt says SLOW waits to be interrupted. */
const FAKE = [
  "#!/usr/bin/env node",
  "const { appendFileSync } = await import('node:fs');",
  "const log = (entry) => appendFileSync(process.env.FAKE_LOG, entry + '\\n');",
  "log('spawn');",
  "let buffer = ''; let turns = 0;",
  "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { buffer += chunk; let n; while ((n = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); if (line.trim()) handle(JSON.parse(line)); } });",
  "function handle(m) {",
  "  if (m.method) log(m.method);",
  "  if (m.method === 'initialize') return send({ id: m.id, result: {} });",
  "  if (m.method === 'thread/start' || m.method === 'thread/resume') return send({ id: m.id, result: { thread: { id: m.params.threadId || 'thread-1' } } });",
  "  if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); return send({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: m.params.turnId, status: 'interrupted' } } }); }",
  "  if (m.method === 'turn/start') {",
  "    const turnId = 'turn-' + (++turns); const threadId = m.params.threadId;",
  "    send({ id: m.id, result: { turn: { id: turnId } } });",
  "    send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });",
  "    if (m.params.input[0].text.includes('SLOW')) return;",
  "    send({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', id: 'a', text: 'reply ' + turnId } } });",
  "    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });",
  "  }",
  "}"
].join("\n");

let dir: string;
let fake: string;
const saved = process.env.WRITER_CODEX_KEEPALIVE_MS;

beforeEach(() => {
  dir = mkdtempSync(join(process.cwd(), ".writer-pool-"));
  fake = join(dir, "fake-codex");
  writeFileSync(fake, FAKE, "utf8");
  chmodSync(fake, 0o755);
});

afterEach(() => {
  closeCodexAppServers();
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) {
    delete process.env.WRITER_CODEX_KEEPALIVE_MS;
  } else {
    process.env.WRITER_CODEX_KEEPALIVE_MS = saved;
  }
});

const run = (prompt: string, resumeThreadId: string | null, extra: Partial<CodexAppServerRun> = {}): Promise<{ finalMessage: string | null; threadId: string | null }> =>
  runCodexAppServer({ command: fake, prompt, cwd: dir, env: { ...process.env, FAKE_LOG: join(dir, "log") }, resumeThreadId, sandbox: "read-only", ...extra });
const log = () => readFileSync(join(dir, "log"), "utf8").trim().split("\n");

describe("kept-alive Codex app-server", () => {
  it("runs a conversation's turns in one process without reopening the thread", async () => {
    const first = await run("one", null);
    const second = await run("two", first.threadId);
    const third = await run("three", second.threadId);
    expect([first.finalMessage, second.finalMessage, third.finalMessage]).toEqual(["reply turn-1", "reply turn-2", "reply turn-3"]);
    expect(log().filter((line) => line === "spawn")).toHaveLength(1);
    expect(log()).not.toContain("thread/resume");
    expect(log().filter((line) => line === "turn/start")).toHaveLength(3);
  });

  it("stops a turn by interrupting it, and keeps the process for the next", async () => {
    const first = await run("one", null);
    const controller = new AbortController();
    const slow = run("SLOW", first.threadId, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    await expect(slow).rejects.toThrow("interrupted");
    const after = await run("again", first.threadId);
    expect(after.finalMessage).toBe("reply turn-3");
    expect(log()).toContain("turn/interrupt");
    expect(log().filter((line) => line === "spawn")).toHaveLength(1);
  });

  it("reopens the thread in a new process when the old one is gone", async () => {
    const first = await run("one", null);
    closeCodexAppServers();
    await run("two", first.threadId);
    expect(log().filter((line) => line === "spawn")).toHaveLength(2);
    expect(log()).toContain("thread/resume");
  });

  it("starts one process per turn when keep-alive is off", async () => {
    process.env.WRITER_CODEX_KEEPALIVE_MS = "0";
    const first = await run("one", null);
    await run("two", first.threadId);
    expect(log().filter((line) => line === "spawn")).toHaveLength(2);
  });
});

describe("early signs of a Codex turn", () => {
  it("reports each reasoning headline once, as soon as it is written", () => {
    const tracker = new TurnDeltaTracker();
    const delta = (text: string, summaryIndex = 0) => tracker.consume("item/reasoning/summaryTextDelta", { itemId: "r1", summaryIndex, delta: text });
    expect(delta("**Selecting wea")).toEqual([]);
    expect(delta("ker paragraphs**\n\nThe second")).toEqual([{ type: "reasoning.headline", item_id: "r1", text: "Selecting weaker paragraphs" }]);
    expect(delta(" paragraph repeats")).toEqual([]);
    expect(delta("**Drafting**", 1)).toEqual([{ type: "reasoning.headline", item_id: "r1", text: "Drafting" }]);
  });

  it("names each suggestion as its title completes, and ignores quoted text that looks like one", () => {
    const tracker = new TurnDeltaTracker();
    const delta = (text: string) => tracker.consume("item/agentMessage/delta", { itemId: "m1", delta: text });
    expect(delta('{"message":"x","suggestions":[{"title":"Tighten')).toEqual([]);
    expect(delta(' \\"the\\" claim","original":"a \\"title\\": \\"no\\" b"')).toEqual([{ type: "suggestion.drafted", index: 1, title: 'Tighten "the" claim' }]);
    expect(delta(',"replacement":"c"},{"title":"Second"')).toEqual([{ type: "suggestion.drafted", index: 2, title: "Second" }]);
  });

  it("turns them into progress, without repeating a headline when the item completes", () => {
    const parser = new CodexStreamParser();
    const line = (event: unknown) => parser.consume(JSON.stringify(event));
    expect(line({ type: "reasoning.headline", item_id: "r1", text: "Selecting paragraphs" })).toEqual([{ kind: "status", stage: "thinking", detail: "Selecting paragraphs" }]);
    expect(line({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "**Selecting paragraphs**" } })).toEqual([]);
    expect(line({ type: "item.completed", item: { id: "r2", type: "reasoning", text: "**Other**" } })).toEqual([{ kind: "status", stage: "thinking", detail: "Other" }]);
    expect(line({ type: "suggestion.drafted", index: 2, title: "Second" })).toEqual([{ kind: "status", stage: "writing", detail: "Writing suggestion 2: Second" }]);
  });
});
