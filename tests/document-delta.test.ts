// @vitest-environment node
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proposeChanges } from "../server/ai";
import { conversationStore, resetConversationStore } from "../server/conversation-store";
import { describeDocumentDelta, diffParagraphs } from "../server/document-delta";
import type { AiRequest } from "../src/shared";

const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} explains one part of the aims in plain words.`);
const DOC = paragraphs.join("\n");

describe("document delta", () => {
  it("says an unchanged document is unchanged", () => {
    expect(describeDocumentDelta(DOC, DOC)?.join("\n")).toMatch(/unchanged since your previous turn/);
  });

  it("lists only the paragraphs that changed, by their position now", () => {
    const edited = [...paragraphs];
    edited[4] = "Paragraph 5 now says something sharper.";
    edited.splice(10, 0, "A new paragraph after the tenth.");
    edited.splice(20, 1);
    const hunks = diffParagraphs(DOC, edited.join("\n"));
    expect(hunks.map((hunk) => [hunk.newStart, hunk.removed.length, hunk.added.length])).toEqual([[4, 1, 1], [10, 0, 1], [20, 1, 0]]);
    const lines = describeDocumentDelta(DOC, edited.join("\n"))!;
    expect(lines.join("\n")).toContain("now: Paragraph 5 now says something sharper.");
    expect(lines.join("\n")).toContain("was: Paragraph 5 explains one part of the aims in plain words.");
    expect(lines.join("\n")).toContain("@@ paragraph 11 after the paragraph ending");
    expect(lines.join("\n")).not.toContain("Paragraph 15 explains");
  });

  it("falls back to the full text when much of the document changed", () => {
    const rewritten = paragraphs.map((paragraph, index) => (index % 2 ? paragraph.toUpperCase() : paragraph)).join("\n");
    expect(describeDocumentDelta(DOC, rewritten)).toBeNull();
  });
});

/**
 * A miniature `codex app-server` that records every prompt it is given and
 * answers with an empty structured reply; FAKE_COMPACT=1 makes the turn report
 * a context compaction.
 */
const FAKE_APP_SERVER = [
  "#!/usr/bin/env node",
  "const { appendFileSync } = await import('node:fs');",
  "let buffer = '';",
  "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { buffer += chunk; let n; while ((n = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); if (line.trim()) handle(JSON.parse(line)); } });",
  "function handle(m) {",
  "  if (m.method === 'initialize') return send({ id: m.id, result: { userAgent: 'fake' } });",
  "  if (m.method === 'thread/start' || m.method === 'thread/resume') return send({ id: m.id, result: { thread: { id: m.params.threadId || 'thread-a' } } });",
  "  if (m.method === 'turn/start') {",
  "    appendFileSync(process.env.FAKE_PROMPTS, JSON.stringify(m.params.input.map((part) => part.text || '').join('')) + '\\n');",
  "    send({ id: m.id, result: { turn: { id: 't', status: 'inProgress' } } });",
  "    send({ method: 'turn/started', params: { turn: { id: 't' } } });",
  "    if (process.env.FAKE_COMPACT === '1') send({ method: 'item/completed', params: { item: { type: 'contextCompaction', id: 'c' } } });",
  "    send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a', text: JSON.stringify({ message: 'Done.', suggestions: [] }) } } });",
  "    send({ method: 'turn/completed', params: { turn: { id: 't', status: 'completed', error: null } } });",
  "  }",
  "}"
].join("\n");

describe("resumed Codex turns send only what changed", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["WRITER_ALLOW_CLI", "WRITER_CODEX_PATH", "WRITER_CODEX_TRANSPORT", "WRITER_AI_ENGINE", "FAKE_PROMPTS", "FAKE_COMPACT"];

  beforeEach(() => {
    dir = mkdtempSync(join(process.cwd(), ".writer-delta-"));
    for (const key of KEYS) {
      saved[key] = process.env[key];
    }
    const fake = join(dir, "fake-codex");
    writeFileSync(fake, FAKE_APP_SERVER, "utf8");
    chmodSync(fake, 0o755);
    Object.assign(process.env, { WRITER_ALLOW_CLI: "1", WRITER_CODEX_PATH: fake, WRITER_CODEX_TRANSPORT: "app-server", WRITER_AI_ENGINE: "oneshot", FAKE_PROMPTS: join(dir, "prompts.jsonl") });
    delete process.env.FAKE_COMPACT;
    resetConversationStore();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    resetConversationStore();
  });

  const prompts = (): string[] => readFileSync(join(dir, "prompts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string);
  const request = (documentText: string, agentSessionId: string | null): AiRequest => ({ provider: "codex", instruction: "Tighten it", mode: "global", documentHtml: "", documentText, selection: null, agentSessionId });

  it("sends the document once, then the changes, then nothing when unchanged", async () => {
    const first = await proposeChanges(request(DOC, null));
    expect(first.message).toBe("Done.");
    expect(first.agentSessionId).toBe("thread-a");
    const edited = DOC.replace("Paragraph 7 explains one part", "Paragraph 7 states one part");
    await proposeChanges(request(edited, "thread-a"));
    await proposeChanges(request(edited, "thread-a"));
    const [full, delta, unchanged] = prompts();
    expect(full).toContain("Paragraph 29 explains one part of the aims");
    expect(delta).toContain("now: Paragraph 7 states one part of the aims in plain words.");
    expect(delta).not.toContain("Paragraph 29 explains one part of the aims");
    expect(delta).not.toContain("blocks below are the CURRENT document");
    expect(unchanged).toMatch(/Document: unchanged since your previous turn/);
    expect(unchanged.length).toBeLessThan(full.length - DOC.length / 2);
  });

  it("sends the full document again after Codex compacts the thread", async () => {
    await proposeChanges(request(DOC, null));
    process.env.FAKE_COMPACT = "1";
    await proposeChanges(request(DOC, "thread-a"));
    delete process.env.FAKE_COMPACT;
    await proposeChanges(request(DOC, "thread-a"));
    const [, compactedTurn, afterCompaction] = prompts();
    expect(compactedTurn).toMatch(/unchanged since your previous turn/);
    expect(afterCompaction).toContain("Paragraph 29 explains one part of the aims");
    expect(conversationStore().threadDocument("thread-a")).toBe(DOC);
  });

  it("does the same for the document context of a caret or selection request", async () => {
    const at = DOC.indexOf("Paragraph 12");
    const selection = { from: at, to: at + paragraphs[11].length, text: paragraphs[11] };
    const ask = (agentSessionId: string | null): AiRequest => ({ ...request(DOC, agentSessionId), mode: "selection", selection });
    await proposeChanges(ask(null));
    await proposeChanges(ask("thread-a"));
    const [full, unchanged] = prompts();
    expect(full).toContain("Paragraph 29 explains one part of the aims");
    expect(unchanged).toMatch(/Document context \(the entire document[^\n]*\nDocument: unchanged since your previous turn/);
    expect(unchanged).toContain(paragraphs[11]);
    expect(unchanged).not.toContain("Paragraph 29 explains one part of the aims");
  });
});
