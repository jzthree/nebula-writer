// @vitest-environment node

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parallelDraftsInstruction, proposeChanges } from "../server/ai";

describe("parallel drafts", () => {
  it("lists every draft's edits for the final pass", () => {
    const text = parallelDraftsInstruction("Tighten it", [
      { provider: "codex", message: "One edit.", suggestions: [{ id: "1", title: "Shorten", original: "very unique", replacement: "unique", rationale: "Absolute.", confidence: 0.9, target: "global", status: "pending" }] },
      { provider: "codex", message: "Nothing to change.", suggestions: [] }
    ]);
    expect(text).toContain('The author asked: "Tighten it"');
    expect(text).toContain("2 independent drafts");
    expect(text).toContain('A1. Shorten\n     original: "very unique"\n     replacement: "unique"');
    expect(text).toContain("Draft B. Its message: \"Nothing to change.\"\n  (no edits)");
  });

  it("drafts in parallel without a session, then returns the final pass's choice", async () => {
    const saved = { allow: process.env.WRITER_ALLOW_CLI, codex: process.env.WRITER_CODEX_PATH };
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-parallel-fake-"));
    // A stand-in Codex: a draft answers with its own wording (by call order);
    // the final pass (its prompt lists the drafts) returns a combination.
    const fake = join(tempDir, "fake-codex");
    writeFileSync(fake, [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      "const args = process.argv.slice(2);",
      'const prompt = fs.readFileSync(0, "utf8");',
      `const dir = ${JSON.stringify(tempDir)};`,
      'const final = prompt.includes("independent drafts each answered");',
      'const n = fs.readdirSync(dir).filter((name) => name.startsWith("call-")).length;',
      'fs.writeFileSync(`${dir}/call-${n}-${final ? "final" : "draft"}.txt`, JSON.stringify({ args, prompt }));',
      'const replacement = final ? "The results were unique and new." : n === 0 ? "The results were unique." : "The results were new.";',
      'const payload = { message: final ? "Combined A and B." : "One edit.", suggestions: [{ title: "Tighten", original: "The results were very unique.", replacement, rationale: "Shorter.", confidence: 0.8, imageIndex: null, imageFile: null, imageAction: null, imageCaption: null, tableAction: null, tableIndex: null, tableRows: null, tableHeader: null }] };',
      'const last = args[args.indexOf("--output-last-message") + 1];',
      'if (args.includes("--output-last-message")) fs.writeFileSync(last, JSON.stringify(payload));',
      'const lines = [{ type: "thread.started", thread_id: `thread-${n}` }, { type: "turn.started" }, { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(payload) } }, { type: "turn.completed", usage: {} }];',
      'setTimeout(() => { for (const line of lines) process.stdout.write(JSON.stringify(line) + "\\n"); process.exit(0); }, final ? 0 : 150);'
    ].join("\n"), "utf8");
    chmodSync(fake, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = fake;
    try {
      const response = await proposeChanges({
        provider: "codex", instruction: "Tighten the results sentence.", mode: "global",
        documentHtml: "<p>The results were very unique.</p>", documentText: "The results were very unique.", selection: null,
        parallelDrafts: 2, agentSessionId: "thread-earlier"
      });
      const calls = readdirSync(tempDir).filter((name) => name.startsWith("call-")).sort();
      expect(calls.filter((name) => name.endsWith("draft.txt"))).toHaveLength(2);
      expect(calls.filter((name) => name.endsWith("final.txt"))).toHaveLength(1);
      const drafts = calls.filter((name) => name.endsWith("draft.txt")).map((name) => JSON.parse(readFileSync(join(tempDir, name), "utf8")) as { args: string[] });
      // Drafts start fresh; the final pass continues the conversation's thread.
      expect(drafts.every((draft) => !draft.args.includes("resume"))).toBe(true);
      const final = JSON.parse(readFileSync(join(tempDir, calls.find((name) => name.endsWith("final.txt"))!), "utf8")) as { args: string[]; prompt: string };
      expect(final.args).toContain("thread-earlier");
      expect(final.prompt).toContain('"The results were unique."');
      expect(final.prompt).toContain('"The results were new."');
      expect(response.suggestions).toHaveLength(1);
      expect(response.suggestions[0].replacement).toBe("The results were unique and new.");
      expect(response.message).toContain("2 drafts ran in parallel and proposed 2 edits; a final pass chose or combined them.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      for (const [key, value] of [["WRITER_ALLOW_CLI", saved.allow], ["WRITER_CODEX_PATH", saved.codex]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }, 30_000);
});
