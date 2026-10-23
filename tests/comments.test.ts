import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentTaskPrompt, buildCliPrompt } from "../server/ai";
import { createAgentRun, deleteAgentRun } from "../server/agent-run";
import { exportDocx, extractDocxComments } from "../server/docx";
import { describeDocumentComments, isDocumentCommentList, isDocumentCommentsStatus, locateCommentAnchor, type AiRequest, type DocumentComment } from "../src/shared";
import { MockWordHost } from "../src/word/mockOffice";
import { readDocumentSnapshot, waitForWordHost } from "../src/word/wordHost";

const DOC = "Specific Aims\nOur central hypothesis is that chromatin state drives fate.\nWe will profile cells.";
const comment = (overrides: Partial<DocumentComment> = {}): DocumentComment => ({
  id: "c1", author: "Reviewer 2", text: "Is this hypothesis testable?", anchorText: "central hypothesis", offset: 18, resolved: false, replies: [], ...overrides
});

describe("comments: what the model sees", () => {
  it("never equates unavailable or partial Google Docs comments with no comments", () => {
    const request: AiRequest = {
      provider: "claude", instruction: "Check comments", mode: "global", documentText: DOC,
      documentComments: [], documentCommentsStatus: { state: "unavailable", detail: "Not connected to Google Drive." }
    };
    const run = createAgentRun(request);
    try {
      expect(buildAgentTaskPrompt(request, run)).toContain("Do not claim there are no comments");
      expect(buildCliPrompt(request)).toContain("UNAVAILABLE");
      expect(run.commentsStatus?.state).toBe("unavailable");
    } finally { deleteAgentRun(run.id); }
    expect(describeDocumentComments([], { status: { state: "complete", detail: "Read successfully" } }).join(" ")).toContain("successfully read");
    expect(describeDocumentComments([comment()], { status: { state: "partial", detail: "A later page failed" } }).join(" ")).toContain("Do not claim all threads were checked");
    expect(isDocumentCommentsStatus({ state: "unavailable", detail: "Not connected" })).toBe(true);
    expect(isDocumentCommentsStatus({ state: "complete", detail: "x".repeat(1_001) })).toBe(false);
    expect(isDocumentCommentsStatus({ state: "unknown", detail: "" })).toBe(false);
  });
  it("lists open threads first with anchors and replies, and is referenced in one-shot and agentic prompts", () => {
    const comments = [
      comment({ id: "c2", text: "Done, thanks.", anchorText: "profile cells", offset: 72, resolved: true }),
      comment({ replies: [{ author: "Jian", text: "Yes — Aim 1 tests it." }] })
    ];
    const lines = describeDocumentComments(comments);
    expect(lines[0]).toContain("1 open, 1 resolved");
    expect(lines[1]).toBe('[C1] Reviewer 2 on "central hypothesis": Is this hypothesis testable?');
    expect(lines[2]).toBe("    ↳ Jian: Yes — Aim 1 tests it.");
    expect(lines[3]).toContain("[C2] (resolved)");
    const request: AiRequest = { provider: "codex", instruction: "Address the comments", mode: "global", documentHtml: "", documentText: DOC, selection: null, documentComments: comments };
    expect(buildCliPrompt(request)).toContain('[C1] Reviewer 2 on "central hypothesis"');
    const run = createAgentRun({ ...request, provider: "claude" });
    try {
      expect(buildAgentTaskPrompt({ ...request, provider: "claude" }, run)).toContain("Is this hypothesis testable?");
      expect(run.comments).toHaveLength(2);
    } finally {
      deleteAgentRun(run.id);
    }
    expect(describeDocumentComments([])).toEqual([]);
  });

  it("validates comment payloads and locates anchors", () => {
    expect(isDocumentCommentList([comment()])).toBe(true);
    expect(isDocumentCommentList([{ id: 1 }])).toBe(false);
    expect(locateCommentAnchor(DOC, "central hypothesis")).toBe(18);
    expect(locateCommentAnchor("a x b x", "x", 5)).toBe(6);
    expect(locateCommentAnchor(DOC, "")).toBeNull();
  });
});

describe("comments: DOCX", () => {
  it("reads comments.xml with anchors, threaded replies and resolved state", async () => {
    const base = await exportDocx({ title: "Comments", html: "<p>Our central hypothesis is that chromatin state drives fate.</p><p>We will profile cells.</p>" });
    const zip = await JSZip.loadAsync(base);
    let documentXml = (await zip.file("word/document.xml")!.async("string"));
    documentXml = documentXml.replace(/(<w:t[^>]*>)Our central hypothesis/, '<w:commentRangeStart w:id="0"/>$1Our central hypothesis').replace(/drives fate\.(<\/w:t><\/w:r>)/, 'drives fate.$1<w:commentRangeEnd w:id="0"/>');
    zip.file("word/document.xml", documentXml);
    zip.file("word/comments.xml", '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">'
      + '<w:comment w:id="0" w:author="Reviewer 2" w:date="2026-10-01T00:00:00Z"><w:p w14:paraId="AAA00001"><w:r><w:t>Is this testable?</w:t></w:r></w:p></w:comment>'
      + '<w:comment w:id="1" w:author="Jian" w:date="2026-10-02T00:00:00Z"><w:p w14:paraId="AAA00002"><w:r><w:t>Yes, Aim 1.</w:t></w:r></w:p></w:comment>'
      + "</w:comments>");
    zip.file("word/commentsExtended.xml", '<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="AAA00001" w15:done="1"/><w15:commentEx w15:paraId="AAA00002" w15:paraIdParent="AAA00001" w15:done="0"/></w15:commentsEx>');
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const comments = await extractDocxComments(buffer, "Our central hypothesis is that chromatin state drives fate.\nWe will profile cells.");
    expect(comments).toEqual([{
      id: "0", author: "Reviewer 2", text: "Is this testable?", anchorText: "Our central hypothesis is that chromatin state drives fate.",
      offset: 0, resolved: true, createdAt: "2026-10-01T00:00:00Z", replies: [{ author: "Jian", text: "Yes, Aim 1.", createdAt: "2026-10-02T00:00:00Z" }]
    }]);
    expect(await extractDocxComments(base)).toEqual([]);
  });
});

describe("comments: Word", () => {
  let mock: MockWordHost | null = null;
  afterEach(() => mock?.uninstall());

  it("reads comments, replies and anchors on full snapshots, and skips them on cheap re-reads", async () => {
    mock = new MockWordHost({
      paragraphs: DOC.split("\n").map((text) => ({ text })),
      comments: [{ anchorText: "central hypothesis", text: "Is this testable?", author: "Reviewer 2", replies: [{ author: "Jian", text: "Yes." }] }, { anchorText: "profile cells", text: "How many?", resolved: true }]
    }).install();
    const host = await waitForWordHost();
    const full = await readDocumentSnapshot(host.capabilities, { emphasis: "full" });
    expect(full.comments).toHaveLength(2);
    expect(full.comments?.[0]).toMatchObject({ author: "Reviewer 2", text: "Is this testable?", anchorText: "central hypothesis", offset: DOC.indexOf("central hypothesis"), resolved: false, replies: [{ author: "Jian", text: "Yes." }] });
    expect(full.comments?.[1]).toMatchObject({ resolved: true, anchorText: "profile cells" });
    const cheap = await readDocumentSnapshot(host.capabilities, { emphasis: "cached" });
    expect(cheap.comments).toBeUndefined();
  });
});
