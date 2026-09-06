// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import type { WordHostContext } from "../src/shared";
import { createAgentRun, currentHostContext, deleteAgentRun, recordAgentActivity, setLiveHostContextSource } from "../server/agent-run";
import { paragraphIndex, readAgentRunContext } from "../server/agent-context";

const PARAGRAPHS = [
  { text: "Specific Aims", level: 1 },
  { text: "Chromatin accessibility is a determinant of gene regulation.", level: null },
  { text: "Aim 1. Map accessibility.", level: 2 },
  { text: "We will profile 50,000 cells across six time points.", level: null },
  { text: "Preliminary data demonstrate feasibility.", level: null },
  { text: "Aim 2. Model coupling.", level: 2 },
  { text: "Using the model, we will estimate coupling strength.", level: null },
  { text: "Research Strategy", level: 1 },
  { text: "Significance", level: 2 },
  { text: "Regulatory variation contributes to disease risk.", level: null }
];

const documentText = PARAGRAPHS.map((paragraph) => paragraph.text).join("\n");

function offsets(): Array<{ offset: number; length: number; level: number | null }> {
  let cursor = 0;
  return PARAGRAPHS.map((paragraph) => {
    const entry = { offset: cursor, length: paragraph.text.length, level: paragraph.level };
    cursor += paragraph.text.length + 1;
    return entry;
  });
}

function hostContextAt(paragraph: number, extra: Partial<WordHostContext> = {}): WordHostContext {
  const index = offsets();
  const caret = index[paragraph].offset + 3;
  return {
    source: "word-addin",
    documentName: "Aims.docx",
    capturedAt: new Date().toISOString(),
    documentLength: documentText.length,
    paragraphCount: PARAGRAPHS.length,
    selection: null,
    cursor: { offset: caret, paragraphIndex: paragraph, paragraphText: PARAGRAPHS[paragraph].text, sentence: null },
    section: null,
    viewport: { from: index[2].offset, to: index[4].offset + index[4].length, pages: [1], leadingText: "", trailingText: "" },
    recentFocus: [],
    outline: index
      .map((entry, i) => ({ entry, i }))
      .filter(({ entry }) => entry.level !== null)
      .map(({ entry, i }) => ({ heading: PARAGRAPHS[i].text, level: entry.level, paragraphIndex: i, offset: entry.offset })),
    changeTrackingMode: "Off",
    paragraphs: index,
    ...extra
  };
}

afterEach(() => {
  setLiveHostContextSource(null);
});

describe("writer_read_context", () => {
  it("reads the paragraph at the caret with neighbours, and the enclosing section", () => {
    const run = createAgentRun({ provider: "demo", instruction: "x", mode: "global", documentText, hostContext: hostContextAt(3) });
    const paragraph = readAgentRunContext(run, { what: "paragraph" });
    expect("error" in paragraph).toBe(false);
    if ("error" in paragraph) {
      return;
    }
    expect(paragraph.text).toBe("We will profile 50,000 cells across six time points.");
    expect(paragraph.paragraphs.map((entry) => entry.index)).toEqual([3]);
    expect(paragraph.heading?.text).toBe("Aim 1. Map accessibility.");
    expect(paragraph.live).toBe(false);

    const widened = readAgentRunContext(run, { what: "paragraph", before: 1, after: 1 });
    if ("error" in widened) {
      throw new Error(widened.error);
    }
    expect(widened.paragraphs.map((entry) => entry.index)).toEqual([2, 3, 4]);
    expect(documentText.slice(widened.from, widened.to)).toBe(widened.text);

    const section = readAgentRunContext(run, { what: "section" });
    if ("error" in section) {
      throw new Error(section.error);
    }
    expect(section.heading?.text).toBe("Aim 1. Map accessibility.");
    expect(section.paragraphs.map((entry) => entry.index)).toEqual([2, 3, 4]);
    expect(section.text.startsWith("Aim 1.")).toBe(true);
    expect(section.text.endsWith("feasibility.")).toBe(true);

    // A level-1 section runs to the next level-1 heading.
    const aims = readAgentRunContext(run, { what: "section", paragraphIndex: 0 });
    if ("error" in aims) {
      throw new Error(aims.error);
    }
    expect(aims.paragraphs.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    deleteAgentRun(run.id);
  });

  it("reads the pages on screen, the outline, and the document summary", () => {
    const run = createAgentRun({ provider: "demo", instruction: "x", mode: "global", documentText, hostContext: hostContextAt(6) });
    const page = readAgentRunContext(run, { what: "page" });
    if ("error" in page) {
      throw new Error(page.error);
    }
    expect(page.pages).toEqual([1]);
    expect(page.paragraphs.map((entry) => entry.index)).toEqual([2, 3, 4]);
    expect(documentText.slice(page.from, page.to)).toBe(page.text);

    const outline = readAgentRunContext(run, { what: "outline" });
    if ("error" in outline) {
      throw new Error(outline.error);
    }
    expect(outline.outline?.map((entry) => entry.text)).toEqual(["Specific Aims", "Aim 1. Map accessibility.", "Aim 2. Model coupling.", "Research Strategy", "Significance"]);
    expect(outline.heading?.text).toBe("Aim 2. Model coupling.");
    expect(outline.text).toContain("## Aim 2. Model coupling.");

    const summary = readAgentRunContext(run, { what: "document" });
    if ("error" in summary) {
      throw new Error(summary.error);
    }
    expect(summary.text).toBe("");
    expect(summary.totalLength).toBe(documentText.length);
    expect(summary.paragraphCount).toBe(PARAGRAPHS.length);
    expect(summary.note).toContain("writer_read_document");
    expect(readAgentRunContext(run, { what: "nope" })).toHaveProperty("error");
    deleteAgentRun(run.id);
  });

  it("follows the author's live position when the add-in pushes a newer state for the same document", () => {
    const run = createAgentRun({ provider: "demo", instruction: "x", mode: "global", documentText, hostContext: hostContextAt(1) });
    setLiveHostContextSource(() => ({ documentName: "Aims.docx", hostContext: hostContextAt(9) }));
    expect(currentHostContext(run).live).toBe(true);
    const paragraph = readAgentRunContext(run, { what: "paragraph" });
    if ("error" in paragraph) {
      throw new Error(paragraph.error);
    }
    expect(paragraph.live).toBe(true);
    expect(paragraph.text).toBe("Regulatory variation contributes to disease risk.");
    expect(paragraph.heading?.text).toBe("Significance");

    // A different document's push is ignored.
    setLiveHostContextSource(() => ({ documentName: "Other.docx", hostContext: hostContextAt(9) }));
    const stale = readAgentRunContext(run, { what: "paragraph" });
    if ("error" in stale) {
      throw new Error(stale.error);
    }
    expect(stale.live).toBe(false);
    expect(stale.text).toBe("Chromatin accessibility is a determinant of gene regulation.");
    deleteAgentRun(run.id);
  });

  it("falls back to line structure and explicit anchors for web-app runs", () => {
    const run = createAgentRun({ provider: "demo", instruction: "x", mode: "global", documentText });
    expect(paragraphIndex(documentText, null).length).toBe(PARAGRAPHS.length);
    const nowhere = readAgentRunContext(run, { what: "paragraph" });
    if ("error" in nowhere) {
      throw new Error(nowhere.error);
    }
    expect(nowhere.text).toBe("");
    expect(nowhere.note).toContain("paragraph_index");
    const explicit = readAgentRunContext(run, { what: "paragraph", around: offsets()[6].offset + 2 });
    if ("error" in explicit) {
      throw new Error(explicit.error);
    }
    expect(explicit.text).toBe("Using the model, we will estimate coupling strength.");
    const selection = readAgentRunContext(run, { what: "selection" });
    if ("error" in selection) {
      throw new Error(selection.error);
    }
    expect(selection.note).toContain("Nothing is selected");
    deleteAgentRun(run.id);
  });

  it("keeps an ordered, de-duplicated activity trail", () => {
    const run = createAgentRun({ provider: "demo", instruction: "x", mode: "global", documentText });
    recordAgentActivity(run, { kind: "status", summary: "Starting" });
    recordAgentActivity(run, { kind: "tool", tool: "mcp__writer__writer_read_context", summary: "Reading the paragraph at the caret" });
    recordAgentActivity(run, { kind: "tool", tool: "mcp__writer__writer_read_context", summary: "Reading the paragraph at the caret" });
    recordAgentActivity(run, { kind: "thinking", summary: "Thinking" });
    recordAgentActivity(run, { kind: "tool", tool: "mcp__writer__writer_stage_suggestions", summary: "Staging 2 suggestions" });
    expect(run.activity.map((entry) => entry.summary)).toEqual(["Starting", "Reading the paragraph at the caret", "Thinking", "Staging 2 suggestions"]);
    expect(run.activity.every((entry) => Date.parse(entry.at) > 0)).toBe(true);
    deleteAgentRun(run.id);
  });
});
