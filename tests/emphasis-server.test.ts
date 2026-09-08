import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { buildCliPrompt } from "../server/ai";
import { createAgentRun, deleteAgentRun, readAgentRunDocument, searchAgentRunDocument } from "../server/agent-run";
import { readAgentRunContext } from "../server/agent-context";
import { exportDocx, exportTrackedChangesFromSourceWithReport, importDocx } from "../server/docx";
import { validateSuggestionCandidate } from "../server/suggestion-validation";
import type { AiRequest } from "../src/shared";

const documentText = "Aim 1. Map dynamics.\nWe will profile cells.";
const documentEmphasis = [{ start: 0, end: 6, bold: true }, { start: 11, end: 19, italic: true }];

function request(overrides: Partial<AiRequest> = {}): AiRequest {
  return { provider: "claude", instruction: "Tighten", mode: "global", documentHtml: "", documentText, selection: null, documentEmphasis, ...overrides };
}

describe("emphasis: what the model reads", () => {
  it("renders the document with markers and explains the notation in one-shot prompts", () => {
    const prompt = buildCliPrompt(request());
    expect(prompt).toContain("**Aim 1.** Map *dynamics*.");
    expect(prompt).toContain("Inline emphasis in the text is shown with markers");
  });

  it("renders a selection with the emphasis it carries in the document", () => {
    const prompt = buildCliPrompt(request({ mode: "selection", selection: { from: 7, to: 20, text: "Map dynamics." } }));
    expect(prompt.endsWith("Text:\nMap *dynamics*.")).toBe(true);
    expect(prompt).toContain("**Aim 1.** Map *dynamics*.");
  });

  it("renders markers in agent reads and searches, and searches past markers in the query", () => {
    const run = createAgentRun(request());
    try {
      expect(readAgentRunDocument(run).text).toBe("**Aim 1.** Map *dynamics*.\nWe will profile cells.");
      expect(readAgentRunDocument(run, 7, 13).text).toBe("Map *dynamics*.");
      const search = searchAgentRunDocument(run, "**Aim 1.** Map");
      expect(search.matches[0]).toMatchObject({ offset: 0 });
      expect(search.matches[0].context).toContain("**Aim 1.**");
      const context = readAgentRunContext(run, { what: "document" });
      expect("error" in context ? null : context.text).toContain("**Aim 1.** Map *dynamics*.");
    } finally {
      deleteAgentRun(run.id);
    }
  });
});

describe("emphasis: what the model writes", () => {
  it("parses markers out of a staged suggestion and records the emphasis on both sides", () => {
    const verdict = validateSuggestionCandidate(
      { title: "Emphasise", original: "**Aim 1.** Map *dynamics*.", replacement: "**Aim 1.** Map ==chromatin== *dynamics*.", rationale: "r" },
      request()
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.suggestion.original).toBe("Aim 1. Map dynamics.");
      expect(verdict.suggestion.replacement).toBe("Aim 1. Map chromatin dynamics.");
      expect(verdict.suggestion.emphasis).toEqual({
        original: [{ start: 0, end: 6, bold: true }, { start: 11, end: 19, italic: true }],
        replacement: [{ start: 0, end: 6, bold: true }, { start: 11, end: 20, highlight: true }, { start: 21, end: 29, italic: true }]
      });
    }
  });

  it("accepts an emphasis-only edit and treats an unmarked quote as leaving emphasis alone", () => {
    const boldOnly = validateSuggestionCandidate({ title: "Bold", original: "Map *dynamics*.", replacement: "**Map dynamics.**", rationale: "r" }, request());
    expect(boldOnly.ok).toBe(true);
    if (boldOnly.ok) {
      expect(boldOnly.suggestion.replacement).toBe("Map dynamics.");
      expect(boldOnly.suggestion.emphasis?.replacement).toEqual([{ start: 0, end: 13, bold: true }]);
    }
    const plain = validateSuggestionCandidate({ title: "Plain", original: "Map dynamics.", replacement: "Map chromatin dynamics.", rationale: "r" }, request());
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.suggestion.emphasis).toBeUndefined();
    }
  });
});

describe("emphasis: DOCX export and import", () => {
  const cleanup: string[] = [];
  afterEach(() => { cleanup.length = 0; });

  async function paragraphsOf(buffer: Buffer): Promise<string[]> {
    const zip = await JSZip.loadAsync(buffer);
    const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
    return xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? [];
  }

  it("emits the emphasis the AI asked for as run properties on the inserted text", async () => {
    const source = await exportDocx({ title: "Emphasis", html: "<p><strong>Aim 1.</strong> Map dynamics.</p>" });
    const result = await exportTrackedChangesFromSourceWithReport(source, [{
      id: "s1", title: "Add", original: "Map dynamics.", replacement: "Map chromatin dynamics.", rationale: "r", confidence: 0.9, target: "global", status: "pending",
      emphasis: { original: [], replacement: [{ start: 4, end: 13, italic: true, underline: true }] }
    }]);
    expect(result.report.matchedSuggestions).toBe(1);
    const paragraph = (await paragraphsOf(result.buffer)).find((xml) => xml.includes("chromatin")) ?? "";
    const inserted = paragraph.match(/<w:ins\b[\s\S]*?<\/w:ins>/)?.[0] ?? "";
    expect(inserted).toMatch(/<w:r><w:rPr>(?:(?!<\/w:rPr>).)*<w:i\/>(?:(?!<\/w:rPr>).)*<w:u w:val="single"\/><\/w:rPr><w:t xml:space="preserve">chromatin<\/w:t><\/w:r>/);
    expect(inserted).toMatch(/<w:t xml:space="preserve">Map <\/w:t>/);
    expect(inserted).not.toMatch(/<w:b\/>[\s\S]*chromatin/);
  });

  it("carries the original's emphasis over when the AI edited in plain text", async () => {
    const source = await exportDocx({ title: "Carry", html: "<p><strong>Aim 1.</strong> Map dynamics.</p>" });
    const result = await exportTrackedChangesFromSourceWithReport(source, [{
      id: "s2", title: "Rename", original: "Aim 1.", replacement: "Aim 1 revised.", rationale: "r", confidence: 0.9, target: "global", status: "pending"
    }]);
    expect(result.report.matchedSuggestions).toBe(1);
    const paragraph = (await paragraphsOf(result.buffer)).find((xml) => xml.includes("revised")) ?? "";
    const inserted = paragraph.match(/<w:ins\b[\s\S]*?<\/w:ins>/)?.[0] ?? "";
    expect(inserted).toMatch(/<w:b\/>[\s\S]*Aim 1 revised\./);
  });

  it("round-trips underline and highlight through the web document", async () => {
    const source = await exportDocx({ title: "Marks", html: "<p>Plain <u>under</u> and <mark>hot</mark> text.</p>" });
    const xml = (await paragraphsOf(source)).join("");
    expect(xml).toContain('<w:u w:val="single"/>');
    expect(xml).toContain('<w:highlight w:val="yellow"/>');
    const imported = await importDocx(source, "marks.docx");
    expect(imported.html).toContain("<u>under</u>");
    expect(imported.html).toContain("<mark>hot</mark>");
  });
});
