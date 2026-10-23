// @vitest-environment node
import { describe, expect, it } from "vitest";
import { matchCommentsToSelection } from "../src/commentMatching";
import { describeDocumentComments, type DocumentComment, type SelectionContext } from "../src/shared";
import { buildAgentTaskPrompt, buildCliPrompt } from "../server/ai";

const thread = (id: string, anchorText: string, offset: number | null = null): DocumentComment => ({
  id, anchorText, offset, author: "Reviewer", text: `Review ${id}`, resolved: false, replies: []
});
const highlight = (body: string, text: string, from = body.indexOf(text)): SelectionContext => ({ from, to: from + text.length, text });

describe("selection-aware reviewer comments", () => {
  it("prioritizes overlapping anchors, then same-paragraph and adjacent context", () => {
    const body = "Opening.\nThe selected passage follows the earlier anchor.\nAdjacent note.\n" + "far away ".repeat(100) + "Remote anchor.";
    const comments = [thread("remote", "Remote anchor"), thread("near", "Adjacent note"), thread("paragraph", "earlier anchor"), thread("overlap", "selected passage")];
    const result = matchCommentsToSelection(body, highlight(body, "selected passage"), comments);
    expect(result.state).toBe("matched");
    expect(result.matches.map((item) => [item.commentId, item.relationship, item.certainty])).toEqual([
      ["overlap", "overlap", "located"], ["paragraph", "same-paragraph", "located"], ["near", "nearby", "located"]
    ]);
    expect(result.unrelatedCount).toBe(1);
  });

  it("treats repeated quotes as ambiguous even when one occurrence overlaps the highlight", () => {
    const body = "CpG occurs here.\n" + "Elsewhere.\n".repeat(80) + "CpG occurs again.";
    const result = matchCommentsToSelection(body, highlight(body, "CpG occurs again."), [thread("cpg", "CpG")]);
    expect(result.matches[0]).toMatchObject({ commentId: "cpg", certainty: "ambiguous", relationship: "overlap", candidateCount: 2 });
    expect(result.matches[0].ranges).toEqual([{ from: body.lastIndexOf("CpG"), to: body.lastIndexOf("CpG") + 3 }]);
  });

  it("uses a verified supplied offset to disambiguate repeated quoted text", () => {
    const body = "CpG occurs here.\nCpG occurs again.";
    const result = matchCommentsToSelection(body, highlight(body, "CpG occurs again."), [thread("cpg", "CpG", body.lastIndexOf("CpG"))]);
    expect(result.matches[0]).toMatchObject({ certainty: "located", candidateCount: 1, relationship: "overlap" });
  });

  it("bounds returned evidence without losing late-document repeats or their global ambiguity", () => {
    const body = "CpG ".repeat(10_000) + "CpG end.";
    const result = matchCommentsToSelection(body, highlight(body, "CpG end."), [thread("repeat", "CpG")]);
    expect(result.matches[0]).toMatchObject({ certainty: "ambiguous", relationship: "overlap", candidateCount: 10_001 });
    expect(result.matches[0].ranges.length).toBeLessThanOrEqual(5);
    const far = matchCommentsToSelection(body, highlight(body, "CpG end."), [thread("fixed", "CpG", 0)]);
    expect(far.matches).toEqual([]);
  });

  it("revalidates stale offsets instead of claiming their old location is correct", () => {
    const body = "Old spot.\nNow the unique anchor is here.";
    const result = matchCommentsToSelection(body, highlight(body, "unique anchor"), [thread("moved", "unique anchor", 0)]);
    expect(result.matches[0].ranges[0].from).toBe(body.indexOf("unique anchor"));
    expect(result.matches[0].certainty).toBe("located");
  });

  it("decodes HTML entities and handles typography, invisible characters and whitespace without changing offsets", () => {
    const body = "Intro.\nSURF\u2019s\u00a0cell-type\u200b signals are strong.";
    const quote = "SURF&#39;s cell-type signals";
    const result = matchCommentsToSelection(body, highlight(body, "cell-type\u200b signals"), [thread("encoded", quote)]);
    expect(result.matches[0]).toMatchObject({ relationship: "overlap", certainty: "located", anchorText: "SURF's cell-type signals" });
    expect(body.slice(result.matches[0].ranges[0].from, result.matches[0].ranges[0].to)).toBe("SURF\u2019s\u00a0cell-type\u200b signals");
  });

  it("does not invent locations for image comments, punctuation, or obsolete quoted text", () => {
    const body = "A highlighted passage. Another sentence.";
    const result = matchCommentsToSelection(body, highlight(body, "highlighted passage"), [thread("image", ""), thread("period", "."), thread("old", "Deleted wording")]);
    expect(result.matches).toEqual([]);
    expect(result.unlocated).toEqual([
      { commentId: "image", reason: "missing-anchor" }, { commentId: "period", reason: "weak-anchor" }, { commentId: "old", reason: "anchor-not-found" }
    ]);
    expect(result.state).toBe("no-matches");
  });

  it("accepts an explicit point comment at the start of the selected passage", () => {
    const body = "Point comment here.";
    expect(matchCommentsToSelection(body, highlight(body, body), [thread("point", "", 0)]).matches[0]).toMatchObject({ relationship: "overlap", certainty: "located" });
  });

  it("does not match empty, missing, out-of-range, or stale selections", () => {
    const body = "A highlighted passage.";
    const comments = [thread("c", "highlighted passage")];
    expect(matchCommentsToSelection(body, null, comments).state).toBe("no-selection");
    expect(matchCommentsToSelection(body, { from: 0, to: 0, text: "" }, comments).state).toBe("no-selection");
    for (const selection of [{ from: -1, to: 3, text: "A h" }, { from: 0, to: 1000, text: body }, { from: 0, to: 3, text: "bad" }]) {
      expect(matchCommentsToSelection(body, selection, comments).state).toBe("invalid-selection");
    }
    expect(matchCommentsToSelection(body, highlight(body, "highlighted passage"), [thread("zero-width", "\u200b")]).matches).toEqual([]);
  });

  it("does not use semantic similarity in a comment's content as an attachment", () => {
    const body = "Selected passage.\n" + "Distant paragraphs.\n".repeat(80) + "Other anchor.";
    const comment = { ...thread("not-local", "Other anchor"), text: "Selected passage needs revising." };
    expect(matchCommentsToSelection(body, highlight(body, "Selected passage"), [comment]).matches).toEqual([]);
  });

  it("keeps resolved state visible and prioritizes open comments with equal location evidence", () => {
    const body = "The anchored passage.";
    const comments = [{ ...thread("resolved", "anchored passage"), resolved: true }, thread("open", "anchored passage")];
    const context = matchCommentsToSelection(body, highlight(body, body), comments);
    expect(context.matches.map((match) => match.commentId)).toEqual(["open", "resolved"]);
    expect(describeDocumentComments(comments, { selectionContext: context }).join("\n")).toContain("(resolved)");
  });

  it("puts a late relevant thread before document-wide comments in both agent prompt paths", () => {
    const body = "Opening.\n" + "Unrelated text.\n".repeat(100) + "The target passage.";
    const comments = [...Array.from({ length: 70 }, (_, i) => ({ ...thread(`other-${i}`, "Opening"), text: "Unrelated feedback ".repeat(40) })), thread("target", "target passage")];
    const request = { provider: "claude" as const, mode: "selection" as const, documentText: body, selection: highlight(body, "target passage"), instruction: "Address nearby comments", documentComments: comments };
    for (const prompt of [buildCliPrompt(request), buildAgentTaskPrompt(request, { maxSuggestions: null, attachments: [] })]) {
      expect(prompt).toContain("Comment context for highlighted characters");
      expect(prompt).toContain('id="target"');
      expect(prompt.indexOf("Review target")).toBeLessThan(prompt.indexOf("Unrelated feedback"));
      expect(prompt).toContain("located anchor");
    }
    const global = buildCliPrompt({ ...request, mode: "global" });
    expect(global).not.toContain("Comment context for highlighted characters");
  });

  it("retains the relevant root when a long reply history exceeds the prompt budget", () => {
    const body = "An anchored passage.";
    const comments = [{ ...thread("long", "anchored passage"), replies: Array.from({ length: 100 }, () => ({ author: "Reviewer", text: "Long reply ".repeat(80) })) }];
    const context = matchCommentsToSelection(body, highlight(body, body), comments);
    const prompt = describeDocumentComments(comments, { selectionContext: context }).join("\n");
    expect(prompt).toContain("Review long");
    expect(prompt).toContain("More replies omitted");
    expect(prompt.length).toBeLessThanOrEqual(16_000);
  });
});
