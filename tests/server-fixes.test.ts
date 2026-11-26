// @vitest-environment node

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AI_RESPONSE_SCHEMA, buildAttachmentPromptLines, attachmentHashes, buildCliArgs, proposeChanges, withoutMetaSchema } from "../server/ai";
import type { AiAttachment, AiRequest } from "../src/shared";

describe("Claude one-shot schema", () => {
  it("drops the meta-schema URI Claude Code cannot resolve, and keeps it for Codex", () => {
    const args = buildCliArgs("claude", undefined, null, undefined, null, "document");
    const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
    expect(schema).not.toHaveProperty("$schema");
    expect(schema.properties).toEqual(AI_RESPONSE_SCHEMA.properties);
    expect(withoutMetaSchema({ $schema: "x", type: "object" })).toEqual({ type: "object" });
    expect(AI_RESPONSE_SCHEMA.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });
});

describe("attachments in a resumed thread", () => {
  const notes: AiAttachment = { name: "notes.txt", path: "/tmp/notes.txt", text: "Reviewer notes: tighten Aim 2.", chars: 30 } as AiAttachment;
  const request = { provider: "codex", instruction: "x", mode: "global", documentText: "", attachments: [notes], toolAccess: "document" } as unknown as AiRequest;

  it("sends an attachment's text once, names it on later turns, and sends it again when it changed", () => {
    expect(buildAttachmentPromptLines(request).join("\n")).toContain("Reviewer notes: tighten Aim 2.");
    const held = attachmentHashes(request);
    const later = buildAttachmentPromptLines(request, held).join("\n");
    expect(later).toContain("already in this thread");
    expect(later).not.toContain("Reviewer notes");
    const changed = { ...request, attachments: [{ ...notes, text: "Reviewer notes: tighten Aim 3." }] } as AiRequest;
    expect(buildAttachmentPromptLines(changed, held).join("\n")).toContain("tighten Aim 3.");
    const added = { ...request, attachments: [notes, { ...notes, name: "budget.txt", text: "Budget." }] } as AiRequest;
    const mixed = buildAttachmentPromptLines(added, held).join("\n");
    expect(mixed).toContain("Already in this thread from an earlier turn, unchanged (not repeated here): notes.txt.");
    expect(mixed).toContain("Budget.");
    expect(mixed).not.toContain("Reviewer notes");
  });
});

describe("parallel drafts when the final pass fails", () => {
  it("returns the fullest draft instead of losing the drafts' edits", async () => {
    const saved = { allow: process.env.WRITER_ALLOW_CLI, codex: process.env.WRITER_CODEX_PATH };
    const dir = mkdtempSync(join(process.cwd(), ".writer-final-fails-"));
    const fake = join(dir, "fake-codex");
    writeFileSync(fake, [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      "const args = process.argv.slice(2);",
      'const prompt = fs.readFileSync(0, "utf8");',
      `const dir = ${JSON.stringify(dir)};`,
      'if (prompt.includes("independent drafts each answered")) { process.stderr.write("final pass exploded\\n"); process.exit(1); }',
      'const n = fs.readdirSync(dir).filter((f) => f.startsWith("call-")).length; fs.writeFileSync(`${dir}/call-${n}`, "");',
      'const edits = n === 0 ? 1 : 2;',
      'const s = (i) => ({ title: `Edit ${i}`, original: i === 0 ? "very unique" : "really big", replacement: i === 0 ? "unique" : "big", rationale: "r", confidence: 0.8, imageIndex: null, imageFile: null, imageAction: null, imageCaption: null, tableAction: null, tableIndex: null, tableRows: null, tableHeader: null });',
      'const payload = { message: `Draft with ${edits} edits.`, suggestions: Array.from({ length: edits }, (_, i) => s(i)) };',
      'if (args.includes("--output-last-message")) fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify(payload));',
      'for (const line of [{ type: "thread.started", thread_id: `t-${n}` }, { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(payload) } }, { type: "turn.completed", usage: {} }]) process.stdout.write(JSON.stringify(line) + "\\n");'
    ].join("\n"), "utf8");
    chmodSync(fake, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = fake;
    try {
      const response = await proposeChanges({
        provider: "codex", instruction: "Tighten.", mode: "global", documentHtml: "", selection: null,
        documentText: "It was very unique and really big.", parallelDrafts: 2
      });
      expect(readdirSync(dir).filter((name) => name.startsWith("call-"))).toHaveLength(2);
      expect(response.suggestions.map((suggestion) => suggestion.original)).toEqual(["very unique", "really big"]);
      expect(response.message).toContain("the final pass that combines them failed");
      expect(response.message).toContain("Draft with 2 edits.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      for (const [key, value] of [["WRITER_ALLOW_CLI", saved.allow], ["WRITER_CODEX_PATH", saved.codex]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }, 30_000);
});
