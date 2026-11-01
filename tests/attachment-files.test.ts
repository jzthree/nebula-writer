// @vitest-environment node
import { readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAttachmentPromptLines, buildAgentTaskPrompt } from "../server/ai";
import { createAgentRun, readAgentRunAttachment } from "../server/agent-run";
import { createWriterApp } from "../server/app";
import { writerAttachmentsDirectory } from "../server/maintenance";
import { AI_ATTACHMENT_TEXT_CHAR_LIMIT, type AiAttachment, type AiRequest } from "../src/shared";

const LONG = Array.from({ length: 6_000 }, (_, index) => `Line ${index} of the reviewer packet.`).join("\n");

async function upload(name: string, body: string): Promise<AiAttachment> {
  const server = createWriterApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const form = new FormData();
    form.append("file", new Blob([body], { type: "text/plain" }), name);
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ai/attachments`, { method: "POST", body: form });
    expect(response.status).toBe(200);
    const json = await response.json() as { attachment?: AiAttachment } & AiAttachment;
    return json.attachment ?? json;
  } finally {
    server.close();
  }
}

const request = (attachments: AiAttachment[], toolAccess: AiRequest["toolAccess"] = "full"): AiRequest =>
  ({ provider: "codex", instruction: "Answer the reviewers", mode: "global", documentHtml: "", documentText: "Doc.", selection: null, attachments, toolAccess });

describe("attachments the agent reads from disk", () => {
  it("keeps the whole extracted text next to the file, past the preview cap", async () => {
    const attachment = await upload("packet.txt", LONG);
    try {
      expect(attachment.truncated).toBe(true);
      expect(attachment.text).toHaveLength(AI_ATTACHMENT_TEXT_CHAR_LIMIT);
      expect(attachment.chars).toBe(LONG.length);
      expect(attachment.textPath).toBe(`${attachment.path}.txt`);
      expect(readFileSync(attachment.textPath!, "utf8")).toBe(LONG);

      const lines = buildAttachmentPromptLines(request([attachment])).join("\n");
      expect(lines).toContain(`Full extracted text (${LONG.length.toLocaleString()} characters): ${attachment.textPath}`);
      expect(lines).toContain("read it yourself");
      expect(lines).not.toContain("<<<attachment");

      // Agents reading through Writer's tool get the whole text too.
      const run = createAgentRun({ ...request([attachment]), provider: "claude" });
      const tail = readAgentRunAttachment(run, attachment.name, LONG.length - 40, 100);
      expect(tail?.totalLength).toBe(LONG.length);
      expect(tail?.text).toBe(LONG.slice(-40));
      expect(buildAgentTaskPrompt(request([attachment]), run)).toContain(`its full text at ${attachment.textPath}`);
    } finally {
      rmSync(attachment.path, { force: true });
      rmSync(`${attachment.path}.txt`, { force: true });
    }
  });

  it("still inlines short files, and everything when the AI may not read files", () => {
    const short: AiAttachment = { name: "notes.md", path: join(writerAttachmentsDirectory(), "a-notes.md"), text: "Reviewer 2 wants power.", chars: 23 };
    expect(buildAttachmentPromptLines(request([short])).join("\n")).toContain("<<<attachment\nReviewer 2 wants power.");
    const long: AiAttachment = { name: "packet.pdf", path: join(writerAttachmentsDirectory(), "b-packet.pdf"), text: "x".repeat(AI_ATTACHMENT_TEXT_CHAR_LIMIT), truncated: true, textPath: join(writerAttachmentsDirectory(), "b-packet.pdf.txt"), chars: 90_000 };
    const documentOnly = buildAttachmentPromptLines(request([long], "document")).join("\n");
    expect(documentOnly).toContain("<<<attachment");
    expect(documentOnly).not.toContain(long.textPath);
  });

  it("trusts only full-text files Writer wrote", async () => {
    const { attachmentFullText } = await import("../server/attachment-text");
    expect(attachmentFullText({ name: "x", path: "/etc/x", text: "preview", textPath: "/etc/passwd.txt" })).toBe("preview");
  });
});
