import { afterEach, describe, expect, it } from "vitest";
import { googleDocsHost } from "../src/gdocs/docsHost";
import type { DocsDocumentPayload, DocsFocusPayload, DocsReplaceOp } from "../src/gdocs/protocol";
import { setScriptTransport } from "../src/gdocs/scriptBridge";

const documentPayload: DocsDocumentPayload = {
  documentName: "Aims.gdoc",
  documentId: "doc-1",
  paragraphs: [
    { text: "Specific Aims", headingLevel: 1, isListItem: false, style: "Heading 1", emphasis: [] },
    { text: "Our central hypothesis is that chromatin state drives fate.", headingLevel: null, isListItem: false, style: "Normal", emphasis: [{ start: 4, end: 22, bold: true }] },
    { text: "Closing paragraph.", headingLevel: null, isListItem: false, style: "Normal", emphasis: [] }
  ],
  images: [{ index: 0, paragraphIndex: 2, width: 100, height: 50, altText: "Figure 1" }],
  fingerprint: "f1"
};

let calls: Array<{ fn: string; args: unknown[] }> = [];
let focusPayload: DocsFocusPayload = { paragraphIndex: 1, paragraphText: documentPayload.paragraphs[1].text, offset: 4, selection: null, fingerprint: "f1" };

function installTransport(): void {
  calls = [];
  setScriptTransport(async (fn, args) => {
    calls.push({ fn, args });
    switch (fn) {
      case "nebulaReadDocument":
        return documentPayload;
      case "nebulaReadFocus":
        return focusPayload;
      case "nebulaApply":
        return (args[0] as DocsReplaceOp[]).map((op) => ({ id: op.id, ok: !op.expected.includes("fail") }));
      case "nebulaSelect":
      case "nebulaSelectImage":
        return null;
      case "nebulaReadImage":
        return { base64: "AAAA", mime: "image/png", width: 100, height: 50 };
      default:
        return null;
    }
  });
}

afterEach(() => {
  setScriptTransport(null);
});

describe("google docs host", () => {
  it("carries Google comment threads and their read status into the AI snapshot", async () => {
    const comments = [{
      id: "thread-1", author: "Reviewer", text: "Use held-out data.", anchorText: "central hypothesis", offset: 18,
      resolved: true, replies: [{ author: "Author", text: "Agreed." }]
    }];
    setScriptTransport(async () => ({ ...documentPayload, comments, commentsStatus: { state: "complete", detail: "Read successfully" } }));
    const snapshot = await googleDocsHost.readDocumentSnapshot(googleDocsHost.detectCapabilities(true));
    expect(snapshot.comments).toEqual(comments);
    expect(snapshot.commentsStatus).toEqual({ state: "complete", detail: "Read successfully" });
  });
  it("does not mistake missing comment support for a document with no comments", async () => {
    installTransport();
    const snapshot = await googleDocsHost.readDocumentSnapshot(googleDocsHost.detectCapabilities(true));
    expect(snapshot.comments).toEqual([]);
    expect(snapshot.commentsStatus?.state).toBe("unavailable");
  });
  it("boots against the script and builds a snapshot with body offsets, emphasis and pictures", async () => {
    installTransport();
    const boot = await googleDocsHost.waitForHost();
    expect(boot.ready).toBe(true);
    expect(boot.capabilities).toMatchObject({ hostName: "Google Docs", trackChanges: false, comments: false });
    const snapshot = await googleDocsHost.readDocumentSnapshot(boot.capabilities);
    expect(snapshot.bodyText).toBe("Specific Aims\nOur central hypothesis is that chromatin state drives fate.\nClosing paragraph.");
    expect(snapshot.paragraphs[1]).toMatchObject({ offset: 14, headingLevel: null });
    expect(snapshot.paragraphs[0]).toMatchObject({ headingLevel: 1 });
    expect(snapshot.emphasis).toEqual([{ start: 18, end: 36, bold: true }]);
    expect(snapshot.pictures).toEqual([{ index: 0, width: 100, height: 50, altText: "Figure 1", paragraphText: "Closing paragraph.", paragraphIndex: 2 }]);
  });

  it("maps the caret and selection onto the snapshot and flags a stale document", async () => {
    installTransport();
    const snapshot = await googleDocsHost.readDocumentSnapshot(googleDocsHost.detectCapabilities(true));
    const caret = await googleDocsHost.readFocus(snapshot, googleDocsHost.detectCapabilities(true));
    expect(caret).toMatchObject({ cursorOffset: 18, cursorParagraphIndex: 1, selection: null, stale: false, viewport: null });
    focusPayload = { ...focusPayload, selection: { startParagraph: 1, startOffset: 4, endParagraph: 1, endOffset: 22, text: "central hypothesis" } };
    const selected = await googleDocsHost.readFocus(snapshot, googleDocsHost.detectCapabilities(true));
    expect(selected.selection).toEqual({ from: 18, to: 36, text: "central hypothesis" });
    focusPayload = { ...focusPayload, fingerprint: "f2" };
    expect((await googleDocsHost.readFocus(snapshot, googleDocsHost.detectCapabilities(true))).stale).toBe(true);
    focusPayload = { ...focusPayload, fingerprint: "f1", selection: null };
  });

  it("finds matches locally, locates by selecting in the document, and applies through one script call", async () => {
    installTransport();
    const snapshot = await googleDocsHost.readDocumentSnapshot(googleDocsHost.detectCapabilities(true));
    const found = await googleDocsHost.findSuggestionMatches(snapshot, { original: "chromatin state" });
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]).toMatchObject({ offset: 45, paragraphIndex: 1 });
    await googleDocsHost.locateSuggestion(snapshot, { original: "chromatin state" }, 0);
    expect(calls.at(-1)).toEqual({ fn: "nebulaSelect", args: [{ paragraphIndex: 1, start: 31, endParagraphIndex: 1, end: 46, expected: "chromatin state" }] });

    const outcomes = await googleDocsHost.applySuggestions(snapshot, [
      { id: "s1", suggestion: { original: "chromatin state drives fate.", replacement: "chromatin state determines fate." }, matchIndex: 0 },
      { id: "s2", suggestion: { original: "Closing paragraph.", replacement: "" }, matchIndex: null },
      { id: "s3", suggestion: { original: "not in the document", replacement: "x" }, matchIndex: null }
    ], { trackChanges: "word", highlightChanges: true });
    const apply = calls.find((call) => call.fn === "nebulaApply");
    expect(apply?.args[0]).toEqual([
      { id: "s1#0", paragraphIndex: 1, start: 47, endParagraphIndex: 1, end: 53, expected: "drives", text: "determines", emphasis: null, highlight: true },
      { id: "s2", paragraphIndex: 2, start: 0, endParagraphIndex: 2, end: 18, expected: "Closing paragraph.", text: "", emphasis: null, highlight: true }
    ]);
    expect(outcomes[0]).toMatchObject({ id: "s1", ok: true, result: { strategy: "words", trackedChange: false, matches: 1, matchIndex: 0 } });
    expect(outcomes[1]).toMatchObject({ id: "s2", ok: true, result: { strategy: "range" } });
    expect(outcomes[2]).toMatchObject({ id: "s3", ok: false });
  });

  it("refuses overlapping changes in one batch and reports script failures per item", async () => {
    installTransport();
    const snapshot = await googleDocsHost.readDocumentSnapshot(googleDocsHost.detectCapabilities(true));
    const outcomes = await googleDocsHost.applySuggestions(snapshot, [
      { id: "a", suggestion: { original: "central hypothesis", replacement: "premise" }, matchIndex: 0 },
      { id: "b", suggestion: { original: "hypothesis is that", replacement: "premise is that" }, matchIndex: 0 },
      { id: "c", suggestion: { original: "Closing paragraph.", replacement: "fail here" }, matchIndex: 0 }
    ], { trackChanges: "word" });
    expect(outcomes[0].ok).toBe(true);
    expect(outcomes[1]).toMatchObject({ ok: false, error: expect.stringContaining("overlaps") });
    expect(outcomes[2].ok).toBe(true);
  });

  it("reads and replaces pictures through the script and declines comments", async () => {
    installTransport();
    expect(await googleDocsHost.readInlinePictureBase64(0)).toEqual({ base64: "AAAA", width: 100, height: 50 });
    await googleDocsHost.replaceInlinePicture(0, "iVBORw0KGgo=", { trackChanges: "word" });
    expect(calls.at(-1)).toEqual({ fn: "nebulaReplaceImage", args: [0, "iVBORw0KGgo=", "image/png"] });
    const snapshot = await googleDocsHost.readDocumentSnapshot(googleDocsHost.detectCapabilities(true));
    await expect(googleDocsHost.commentSuggestion(snapshot, { original: "x" }, "note", 0)).rejects.toThrow(/cannot take a comment/);
  });
});
