// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildAgentTaskPrompt, buildCliPrompt, buildSelectionContextLines } from "../server/ai";
import { createAgentRun, deleteAgentRun } from "../server/agent-run";
import { readAgentRunContext } from "../server/agent-context";
import { AI_CONTEXT_CHAR_LIMIT, type AiRequest } from "../src/shared";

const PARAGRAPH = "Chromatin accessibility is a determinant of gene regulation. ";
const SELECTION = "We will profile 50,000 cells across six time points.";

function requestWithSelection(documentText: string): AiRequest {
  const from = documentText.indexOf(SELECTION);
  return {
    provider: "codex",
    instruction: "Is this consistent with the timeline in Aim 2?",
    mode: "selection",
    documentHtml: `<p>${documentText}</p>`,
    documentText,
    selection: { from, to: from + SELECTION.length, text: SELECTION }
  };
}

describe("reading beyond the selected scope", () => {
  it("gives one-shot providers the whole document as read-only context when it fits", () => {
    const documentText = `${PARAGRAPH.repeat(20)}${SELECTION} ${PARAGRAPH.repeat(20)}`;
    const request = requestWithSelection(documentText);
    const lines = buildSelectionContextLines(request);
    expect(lines[0]).toContain("the entire document");
    expect(lines).toContain(documentText);

    const prompt = buildCliPrompt(request);
    expect(prompt).toContain("<<<document");
    expect(prompt).toContain("original must still quote the Text block only");
    expect(prompt.indexOf("<<<document")).toBeLessThan(prompt.indexOf("Text:\n"));
    expect(prompt.endsWith(`Text:\n${SELECTION}`)).toBe(true);
  });

  it("falls back to a window around the selection for documents over the budget", () => {
    const filler = PARAGRAPH.repeat(Math.ceil(AI_CONTEXT_CHAR_LIMIT / PARAGRAPH.length));
    const documentText = `${filler}${SELECTION} ${filler}`;
    const request = requestWithSelection(documentText);
    const lines = buildSelectionContextLines(request);
    expect(lines[0]).toMatch(/window around the selection: characters [\d,]+-[\d,]+ of [\d,]+/);
    const body = lines[2];
    expect(body).toContain(SELECTION);
    expect(body.length).toBeLessThanOrEqual(60_000 + SELECTION.length);
    expect(body.length).toBeGreaterThan(50_000);
  });

  it("adds no context block when there is nothing beyond the selection, in global mode, or during coverage passes", () => {
    expect(buildSelectionContextLines(requestWithSelection(SELECTION))).toEqual([]);
    const request = requestWithSelection(`${PARAGRAPH}${SELECTION}`);
    expect(buildSelectionContextLines({ ...request, mode: "global" })).toEqual([]);
    expect(buildSelectionContextLines(request, { coveragePass: { index: 1, total: 2, start: 0, end: 10, totalLength: 20, text: "x" } })).toEqual([]);
  });

  it("tells the agentic engine it may read past the selection, up to the whole document", () => {
    const request: AiRequest = { ...requestWithSelection(`${PARAGRAPH}${SELECTION}`), provider: "claude" };
    const run = createAgentRun(request);
    try {
      const prompt = buildAgentTaskPrompt(request, run);
      expect(prompt).toContain("propose edits ONLY within it");
      expect(prompt).toContain("Reading is NOT limited to the selection");
      expect(prompt).toContain("up to all of it");
      expect(prompt).toContain('writer_read_context({ what: "document" })');
      expect(prompt).toContain("Never guess at content you could have read");
      expect(prompt).toContain("question about the document rather than a request for edits");
    } finally {
      deleteAgentRun(run.id);
    }
  });

  it("returns the whole text for what: document and says how to continue past the read limit", () => {
    const documentText = `${PARAGRAPH.repeat(1_200)}${SELECTION}`;
    expect(documentText.length).toBeGreaterThan(60_000);
    const run = createAgentRun({ ...requestWithSelection(documentText), provider: "claude", mode: "global", selection: null });
    try {
      const context = readAgentRunContext(run, { what: "document" });
      if ("error" in context) {
        throw new Error(context.error);
      }
      expect(context.text.length).toBe(60_000);
      expect(context.text).toBe(documentText.slice(0, 60_000));
      expect(context.to).toBe(60_000);
      expect(context.totalLength).toBe(documentText.length);
      expect(context.note).toContain("first 60,000");
      expect(context.note).toContain("writer_read_document(offset=60000, limit=60000)");
      expect(context.paragraphs.every((paragraph) => paragraph.offset < 60_000)).toBe(true);
    } finally {
      deleteAgentRun(run.id);
    }
  });
});
