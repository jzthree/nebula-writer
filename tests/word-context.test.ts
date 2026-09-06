// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildHostContext,
  buildOutline,
  headingLevelFor,
  indexParagraphs,
  locateParagraph,
  normalizeWordText,
  paragraphAtOffset,
  resolveScope,
  sentenceAt,
  pruneFocusTrail,
  updateFocusTrail,
  type WordDocumentSnapshot,
  type WordFocusState
} from "../src/word/wordContext";
import { describeWordHostContext, hostContextSelection, parseWordHostContext } from "../server/word-context";
import { WORD_HOST_CONTEXT_LIMITS } from "../src/shared";

const sources = [
  { text: "Specific Aims", styleBuiltIn: "Heading1", style: "Heading 1", outlineLevel: 1 },
  { text: "Chromatin accessibility is a determinant of gene regulation. Many studies have looked at it." },
  { text: "Rationale.", style: "Normal" },
  { text: "Aim 1. Map accessibility.", styleBuiltIn: "Heading2", style: "Heading 2", outlineLevel: 2 },
  { text: "We will profile 50,000 cells across six time points. Preliminary data demonstrate feasibility [1,2]." },
  { text: "Rationale.", style: "Normal" },
  { text: "Approach", style: "My Custom Heading", outlineLevel: 2 },
  { text: "" },
  { text: "Expected outcomes. We expect to identify dynamic enhancers." }
];

function snapshotFromSources(): WordDocumentSnapshot {
  const bodyText = sources.map((source) => source.text).join("\r");
  const normalized = normalizeWordText(bodyText);
  return {
    documentName: "aims.docx",
    bodyText: normalized,
    paragraphs: indexParagraphs(normalized, sources),
    changeTrackingMode: "Off",
    capturedAt: "2026-09-01T10:00:00.000Z"
  };
}

describe("word context: paragraph indexing", () => {
  it("assigns each paragraph its offset in the normalized body text", () => {
    const snapshot = snapshotFromSources();
    expect(snapshot.bodyText).not.toContain("\r");
    for (const paragraph of snapshot.paragraphs) {
      expect(snapshot.bodyText.slice(paragraph.offset, paragraph.offset + paragraph.length)).toBe(paragraph.text);
    }
    expect(snapshot.paragraphs[2].offset).toBeLessThan(snapshot.paragraphs[5].offset);
  });

  it("detects heading levels from built-in styles, style names, and outline levels", () => {
    expect(headingLevelFor({ text: "", styleBuiltIn: "Heading2" })).toBe(2);
    expect(headingLevelFor({ text: "", style: "Heading 3" })).toBe(3);
    expect(headingLevelFor({ text: "", style: "Custom", outlineLevel: 1 })).toBe(1);
    expect(headingLevelFor({ text: "", style: "Normal", styleBuiltIn: "Normal", outlineLevel: 10 })).toBeNull();
    expect(headingLevelFor({ text: "", styleBuiltIn: "Title" })).toBe(1);
    const snapshot = snapshotFromSources();
    expect(snapshot.paragraphs.map((paragraph) => paragraph.headingLevel)).toEqual([1, null, null, 2, null, null, 2, null, null]);
  });

  it("disambiguates repeated paragraphs by their neighbours, then by proximity", () => {
    const snapshot = snapshotFromSources();
    // Neighbours that match nothing (edited since the snapshot) fall back to the plain text candidates.
    expect(locateParagraph(snapshot.paragraphs, { text: "Rationale.", previousText: "Aim 1. Map accessibility.", nextText: "" })).toBe(2);
    expect(locateParagraph(snapshot.paragraphs, { text: "Rationale.", previousText: "We will profile 50,000 cells across six time points. Preliminary data demonstrate feasibility [1,2]." })).toBe(5);
    expect(locateParagraph(snapshot.paragraphs, { text: "Rationale." }, { near: 6 })).toBe(5);
    expect(locateParagraph(snapshot.paragraphs, { text: "Rationale." }, { near: 1 })).toBe(2);
    expect(locateParagraph(snapshot.paragraphs, { text: "Rationale." }, { minIndex: 3 })).toBe(5);
    expect(locateParagraph(snapshot.paragraphs, { text: "Rationale.\r" })).toBe(2);
    expect(locateParagraph(snapshot.paragraphs, { text: "Not in the document" })).toBeNull();
  });

  it("finds the paragraph and sentence at an offset", () => {
    const snapshot = snapshotFromSources();
    const target = snapshot.paragraphs[4];
    expect(paragraphAtOffset(snapshot.paragraphs, target.offset + 5)?.index).toBe(4);
    expect(sentenceAt(target.text, 5)).toBe("We will profile 50,000 cells across six time points.");
    expect(sentenceAt(target.text, target.text.length - 3)).toBe("Preliminary data demonstrate feasibility [1,2].");
  });

  it("builds an outline from heading paragraphs only", () => {
    const outline = buildOutline(snapshotFromSources().paragraphs);
    expect(outline.map((entry) => [entry.heading, entry.level])).toEqual([["Specific Aims", 1], ["Aim 1. Map accessibility.", 2], ["Approach", 2]]);
  });
});

describe("word context: focus, scope, and host context", () => {
  function focusAt(snapshot: WordDocumentSnapshot, paragraphIndex: number, selection: WordFocusState["selection"] = null, viewport: WordFocusState["viewport"] = null): WordFocusState {
    const paragraph = snapshot.paragraphs[paragraphIndex];
    return {
      selection,
      cursorOffset: selection?.from ?? paragraph.offset + 3,
      cursorParagraphIndex: paragraphIndex,
      viewport,
      capturedAt: "2026-09-01T10:00:05.000Z",
      stale: false
    };
  }

  it("resolves the request scope from the author's position", () => {
    const snapshot = snapshotFromSources();
    const paragraph = snapshot.paragraphs[4];
    const selection = { from: paragraph.offset, to: paragraph.offset + 20, text: snapshot.bodyText.slice(paragraph.offset, paragraph.offset + 20) };
    const viewport = { from: snapshot.paragraphs[3].offset, to: snapshot.paragraphs[5].offset + snapshot.paragraphs[5].length, pages: [2, 3] };

    expect(resolveScope("auto", snapshot, focusAt(snapshot, 4)).mode).toBe("global");
    expect(resolveScope("auto", snapshot, focusAt(snapshot, 4, selection))).toMatchObject({ scope: "selection", mode: "selection", selection });
    expect(resolveScope("paragraph", snapshot, focusAt(snapshot, 4))).toMatchObject({ mode: "selection", selection: { from: paragraph.offset, text: paragraph.text } });
    const viewportScope = resolveScope("viewport", snapshot, focusAt(snapshot, 4, null, viewport));
    expect(viewportScope.mode).toBe("selection");
    expect(viewportScope.selection?.text).toBe(snapshot.bodyText.slice(viewport.from, viewport.to));
    expect(viewportScope.label).toContain("pages 2–3");
    expect(resolveScope("viewport", snapshot, focusAt(snapshot, 4)).mode).toBe("global");
    expect(resolveScope("document", snapshot, focusAt(snapshot, 4))).toMatchObject({ mode: "global", selection: null });
    // A tiny paragraph widens to its neighbours so the AI has something to anchor on.
    const widened = resolveScope("paragraph", snapshot, focusAt(snapshot, 2));
    expect(widened.mode).toBe("selection");
    expect(widened.selection?.text).toContain("Chromatin accessibility");
    expect(widened.selection?.text).toContain("Aim 1.");
  });

  it("captures caret, section, viewport, and outline in the host context", () => {
    const snapshot = snapshotFromSources();
    const viewport = { from: snapshot.paragraphs[3].offset, to: snapshot.paragraphs[5].offset + snapshot.paragraphs[5].length, pages: [2] };
    const focus = focusAt(snapshot, 4, null, viewport);
    const trail = updateFocusTrail([], focusAt(snapshot, 1), snapshot, Date.parse("2026-09-01T10:00:00.000Z"));
    const context = buildHostContext(snapshot, focus, updateFocusTrail(trail, focus, snapshot, Date.parse("2026-09-01T10:00:10.000Z")));

    expect(context.source).toBe("word-addin");
    expect(context.documentLength).toBe(snapshot.bodyText.length);
    expect(context.cursor).toMatchObject({ paragraphIndex: 4, offset: snapshot.paragraphs[4].offset + 3 });
    expect(context.cursor?.sentence).toBe("We will profile 50,000 cells across six time points.");
    expect(context.section).toMatchObject({ heading: "Aim 1. Map accessibility.", level: 2, paragraphIndex: 3 });
    expect(context.viewport).toMatchObject({ from: viewport.from, to: viewport.to, pages: [2] });
    expect(context.viewport?.leadingText.startsWith("Aim 1.")).toBe(true);
    expect(context.outline.map((entry) => entry.heading)).toEqual(["Specific Aims", "Aim 1. Map accessibility.", "Approach"]);
    expect(context.recentFocus.map((entry) => entry.paragraphIndex)).toEqual([1, 4]);
    expect(context.recentFocus[1].heading).toBe("Aim 1. Map accessibility.");
  });

  it("keeps a bounded, de-duplicated focus trail and drops pass-through stops", () => {
    const snapshot = snapshotFromSources();
    let now = Date.parse("2026-09-01T10:00:00.000Z");
    let trail = updateFocusTrail([], focusAt(snapshot, 1), snapshot, now);
    now += 5_000;
    trail = updateFocusTrail(trail, focusAt(snapshot, 4), snapshot, now);
    now += 200; // arrow-keyed straight through paragraph 4 → replaced, not stacked
    trail = updateFocusTrail(trail, focusAt(snapshot, 8), snapshot, now);
    expect(trail.map((entry) => entry.paragraphIndex)).toEqual([1, 8]);
    now += 5_000;
    trail = updateFocusTrail(trail, focusAt(snapshot, 1), snapshot, now);
    expect(trail.map((entry) => entry.paragraphIndex)).toEqual([8, 1]);
    for (let i = 0; i < 20; i += 1) {
      now += 5_000;
      trail = updateFocusTrail(trail, focusAt(snapshot, i % 2 === 0 ? 4 : 8), snapshot, now);
    }
    expect(trail.length).toBeLessThanOrEqual(WORD_HOST_CONTEXT_LIMITS.recentFocus);
    expect(updateFocusTrail(trail, focusAt(snapshot, 7), snapshot, now + 5_000)).toBe(trail); // empty paragraph ignored
  });
});

describe("word context: focus trail follows edits", () => {
  it("drops trail entries whose text was deleted and re-anchors the rest", () => {
    const snapshot = snapshotFromSources();
    const at = (index: number): WordFocusState => ({ selection: null, cursorOffset: snapshot.paragraphs[index].offset, cursorParagraphIndex: index, viewport: null, capturedAt: "", stale: false });
    let trail = updateFocusTrail([], at(1), snapshot, 1_000);
    trail = updateFocusTrail(trail, at(4), snapshot, 10_000);
    trail = updateFocusTrail(trail, at(8), snapshot, 20_000);
    expect(trail.map((entry) => entry.paragraphIndex)).toEqual([1, 4, 8]);

    // The author deletes paragraph 4 ("We will profile…") and adds a paragraph above.
    const edited = [sources[0], { text: "A new opening sentence." }, ...sources.slice(1, 4), ...sources.slice(5)];
    const editedText = edited.map((source) => source.text).join("\n");
    const next: WordDocumentSnapshot = { ...snapshot, bodyText: editedText, paragraphs: indexParagraphs(editedText, edited) };
    const pruned = pruneFocusTrail(trail, next);
    expect(pruned.map((entry) => entry.excerpt.slice(0, 20))).toEqual(["Chromatin accessibil", "Expected outcomes. W"]);
    expect(pruned.map((entry) => entry.paragraphIndex)).toEqual([2, 8]);
    expect(pruned[0].offset).toBe(next.paragraphs[2].offset);
    // The deleted text no longer reaches the AI's briefing.
    const context = buildHostContext(next, at(2), trail);
    expect(context.recentFocus.some((entry) => entry.excerpt.includes("We will profile"))).toBe(false);
  });
});

describe("server: Word host context parsing and prompt rendering", () => {
  const snapshot = snapshotFromSources();
  const paragraph = snapshot.paragraphs[4];
  const rawContext = buildHostContext(snapshot, {
    selection: { from: paragraph.offset, to: paragraph.offset + 26, text: snapshot.bodyText.slice(paragraph.offset, paragraph.offset + 26) },
    cursorOffset: paragraph.offset,
    cursorParagraphIndex: 4,
    viewport: { from: snapshot.paragraphs[3].offset, to: snapshot.paragraphs[5].offset + snapshot.paragraphs[5].length, pages: [2, 3] },
    capturedAt: new Date().toISOString(),
    stale: false
  }, []);

  it("accepts a well-formed context and rejects malformed ones", () => {
    const parsed = parseWordHostContext(JSON.parse(JSON.stringify(rawContext)));
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) {
      return;
    }
    expect(parsed.hostContext?.cursor?.paragraphIndex).toBe(4);
    expect(parsed.hostContext?.section?.heading).toBe("Aim 1. Map accessibility.");
    expect(parsed.hostContext?.viewport?.pages).toEqual([2, 3]);
    expect(hostContextSelection(parsed.hostContext)?.text).toBe(snapshot.bodyText.slice(paragraph.offset, paragraph.offset + 26));

    expect(parseWordHostContext(null)).toEqual({ hostContext: null });
    expect(parseWordHostContext("nope")).toHaveProperty("error");
    expect(parseWordHostContext({ documentLength: -1 })).toHaveProperty("error");
    expect(parseWordHostContext({ documentLength: 10, selection: { from: "a" } })).toHaveProperty("error");
    const lenient = parseWordHostContext({ documentLength: 10, cursor: { offset: "x" }, viewport: 5, recentFocus: "no", outline: [{ heading: "H" }] });
    expect(lenient).toMatchObject({ hostContext: { cursor: null, viewport: null, recentFocus: [], outline: [] } });
  });

  it("bounds excerpt sizes and list lengths", () => {
    const parsed = parseWordHostContext({
      documentLength: 10,
      cursor: { offset: 1, paragraphIndex: 0, paragraphText: "x".repeat(5_000), sentence: "y".repeat(5_000) },
      recentFocus: Array.from({ length: 40 }, (_, index) => ({ offset: index, paragraphIndex: index, excerpt: `p${index}`, at: "" })),
      outline: Array.from({ length: 400 }, (_, index) => ({ heading: `h${index}`, level: 1, paragraphIndex: index, offset: index }))
    });
    expect("error" in parsed).toBe(false);
    if ("error" in parsed || !parsed.hostContext) {
      return;
    }
    expect(parsed.hostContext.cursor?.paragraphText?.length).toBe(WORD_HOST_CONTEXT_LIMITS.paragraphText);
    expect(parsed.hostContext.recentFocus.length).toBe(WORD_HOST_CONTEXT_LIMITS.recentFocus);
    expect(parsed.hostContext.recentFocus[0].excerpt).toBe("p32");
    expect(parsed.hostContext.outline.length).toBe(WORD_HOST_CONTEXT_LIMITS.outline);
  });

  it("renders the window state as prompt lines with read hints for agents", () => {
    const lines = describeWordHostContext(rawContext, { mode: "global", tooling: "mcp" });
    const text = lines.join("\n");
    expect(text).toContain("Word window state");
    expect(text).toContain("paragraph 5 of 9");
    expect(text).toContain('under the heading "Aim 1. Map accessibility."');
    expect(text).toContain("Selected text");
    expect(text).toContain("We will profile 50,000");
    expect(text).toContain("On screen right now: pages 2-3");
    expect(text).toContain("Document outline:");
    expect(text).toMatch(/writer_read_document\(offset=\d+, limit=\d+\)/);
    expect(text).toContain("prioritize the passage at the caret");

    const selectionMode = describeWordHostContext(rawContext, { mode: "selection", tooling: "inline" }).join("\n");
    expect(selectionMode).toContain("The selection spans offsets");
    expect(selectionMode).not.toContain("<<<selected");
    expect(selectionMode).not.toContain("writer_read_document");
    expect(selectionMode).toContain("orientation only");

    expect(describeWordHostContext(null, { mode: "global", tooling: "mcp" })).toEqual([]);
  });
});
