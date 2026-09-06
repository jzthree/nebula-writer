import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { suggestionsFromSuggestionMarks } from "../src/editorOps";
import { applyReplacementAsSuggestionMarks, resolveSuggestionMarks, SuggestingRouter, SuggestionDeletion, SuggestionInsertion } from "../src/suggesting";

function makeEditor(content: string) {
  return new Editor({
    extensions: [StarterKit, SuggestionInsertion, SuggestionDeletion,
      SuggestingRouter.configure({ isSuggesting: () => false, getAuthor: () => ({ author: "x", authorName: "X", color: "#000", role: "human" }) })],
    content
  });
}
const alice = { author: "a", authorName: "Alice", color: "#f00", role: "human" as const };
const bob = { author: "b", authorName: "Bob", color: "#00f", role: "human" as const };

describe("torture", () => {
  it("ADJACENT different-author suggestions: cards + range resolution behavior", () => {
    const editor = makeEditor("<p>alpha beta gamma delta.</p>");
    // Alice replaces "beta" (7-11), Bob replaces "gamma" — after Alice's insert, positions shift; find fresh
    const a = applyReplacementAsSuggestionMarks(editor, { from: 7, to: 11 }, "BETA", alice);
    const text = editor.state.doc.textContent; // "alpha betaBETA gamma delta."
    const gammaAt = text.indexOf("gamma") + 1;
    const b = applyReplacementAsSuggestionMarks(editor, { from: gammaAt, to: gammaAt + 5 }, "GAMMA", bob);
    const cards = suggestionsFromSuggestionMarks(editor as never);
    console.log("cards:", cards.map((c) => ({ title: c.title, range: c.range })));
    // separated by a space → expect TWO cards
    expect(cards.length).toBe(2);
    // resolving Alice's by range must NOT touch Bob's
    const aCard = cards.find((c) => c.title.includes("Alice"))!;
    resolveSuggestionMarks(editor, { from: aCard.range!.from, to: aCard.range!.to }, "accept");
    const after = suggestionsFromSuggestionMarks(editor as never);
    expect(after.length).toBe(1);
    expect(after[0].title).toContain("Bob");
    expect(editor.state.doc.textContent).toContain("BETA");
    expect(editor.state.doc.textContent).toContain("gammaGAMMA");
    editor.destroy();
  });

  it("TOUCHING different-author suggestions (no gap): what clusters?", () => {
    const editor = makeEditor("<p>alphabeta.</p>");
    applyReplacementAsSuggestionMarks(editor, { from: 1, to: 6 }, "ALPHA", alice);  // alpha[ALPHA]
    // Bob suggests replacing "beta" which now sits immediately after Alice's insertion
    const text = editor.state.doc.textContent;
    const betaAt = text.indexOf("beta") + 1;
    applyReplacementAsSuggestionMarks(editor, { from: betaAt, to: betaAt + 4 }, "BETA", bob);
    const cards = suggestionsFromSuggestionMarks(editor as never);
    // Touching clusters from DIFFERENT authors stay separate proposals.
    expect(cards.length).toBe(2);
    expect(cards.map((c) => c.title).join()).toContain("Alice");
    expect(cards.map((c) => c.title).join()).toContain("Bob");
    // Resolving Alice's by range leaves Bob's pending.
    const aCard = cards.find((c) => c.title.includes("Alice"))!;
    resolveSuggestionMarks(editor, { from: aCard.range!.from, to: aCard.range!.to }, "accept");
    const rest = suggestionsFromSuggestionMarks(editor as never);
    expect(rest.length).toBe(1);
    expect(rest[0].title).toContain("Bob");
    editor.destroy();
  });

  it("rejecting an insertion nested inside another author's strike keeps the strike intact", () => {
    const editor = makeEditor("<p>Hello world.</p>");
    // Alice strikes "Hello world" (1-12)
    const delId = applyReplacementAsSuggestionMarks(editor, { from: 1, to: 12 }, "", alice)!;
    // Bob inserts a marked suggestion INSIDE the struck region (at 6)
    const insId = applyReplacementAsSuggestionMarks(editor, { from: 6, to: 6 }, "XX", bob)!;
    expect(editor.state.doc.textContent).toBe("HelloXX world.");
    // Reject Bob's insertion by changeId — Alice's strike must survive
    resolveSuggestionMarks(editor, { changeId: insId }, "reject");
    expect(editor.state.doc.textContent).toBe("Hello world.");
    const remaining = suggestionsFromSuggestionMarks(editor as never);
    expect(remaining.length).toBe(1);
    expect(remaining[0].title).toContain("Alice");
    // Accept Alice's deletion — struck text goes
    resolveSuggestionMarks(editor, { changeId: delId }, "accept");
    expect(editor.state.doc.textContent).toBe(".");
    editor.destroy();
  });
});

describe("same-range duel (two agents replace the same sentence)", () => {
  it("rejecting one author's card then accepting the other's loses no text", () => {
    const codex = { author: "ai-Codex", authorName: "Codex", color: "#7b1fa2", role: "ai" as const };
    const claude = { author: "ai-Claude Code", authorName: "Claude Code", color: "#7b1fa2", role: "ai" as const };
    const editor = makeEditor("<p>Line editing is table stakes. The interesting capabilities are structural.</p>");
    const orig = "Line editing is table stakes.";
    const at = editor.state.doc.textContent.indexOf(orig) + 1;
    applyReplacementAsSuggestionMarks(editor, { from: at, to: at + orig.length }, "Agents must do more than line-edit.", codex);
    // second agent targets the SAME original (still present, struck)
    const at2 = editor.state.doc.textContent.indexOf(orig) + 1;
    applyReplacementAsSuggestionMarks(editor, { from: at2, to: at2 + orig.length }, "Line editing is just the ante - the price of sitting down at the table.", claude);

    const cards = suggestionsFromSuggestionMarks(editor as never);
    console.log(JSON.stringify(cards.map((c) => ({ title: c.title, range: c.range, original: c.original.slice(0, 50), replacement: c.replacement.slice(0, 50) })), null, 2));
    // each agent gets exactly one REPLACEMENT card despite the shared strike
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.title).sort()).toEqual([
      "Suggested replacement by Claude Code",
      "Suggested replacement by Codex"
    ]);
    const codexCard = cards.find((c) => c.title.includes("Codex"));
    expect(codexCard).toBeTruthy();
    resolveSuggestionMarks(editor, { changeIds: codexCard!.markChangeIds! }, "reject");

    const cardsAfter = suggestionsFromSuggestionMarks(editor as never);
    const claudeCard = cardsAfter.find((c) => c.title.includes("Claude Code"));
    expect(claudeCard).toBeTruthy();
    resolveSuggestionMarks(editor, { changeIds: claudeCard!.markChangeIds! }, "accept");

    const text = editor.state.doc.textContent;
    expect(text).toContain("Line editing is just the ante - the price of sitting down at the table.");
    expect(text).not.toContain("table stakes. ");
    expect(text).not.toContain("more than line-edit");
    editor.destroy();
  });
});

describe("structural proposal card", () => {
  it("merges one changeId spanning several blocks into a single replacement card", () => {
    const codex = { author: "ai-Codex", authorName: "Codex", color: "#7b1fa2", role: "ai" as const };
    const editor = makeEditor("<p>Original opening paragraph.</p>");
    const changeId = applyReplacementAsSuggestionMarks(
      editor,
      { from: 1, to: 1 + "Original opening paragraph.".length },
      "Alpha replacement.\nBeta replacement.",
      codex
    )!;
    const cards = suggestionsFromSuggestionMarks(editor as never);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("Suggested replacement by Codex");
    expect(cards[0].original).toBe("Original opening paragraph.");
    expect(cards[0].replacement).toBe("Alpha replacement.\nBeta replacement.");
    expect(cards[0].markChangeIds).toEqual([changeId]);

    resolveSuggestionMarks(editor, { changeIds: cards[0].markChangeIds! }, "accept");
    expect(editor.getHTML()).toBe("<p>Alpha replacement.</p><p>Beta replacement.</p>");
    expect(suggestionsFromSuggestionMarks(editor as never)).toHaveLength(0);
    editor.destroy();
  });
});

describe("trailing pure insertion", () => {
  it("an insertion right after a sentence end still gets a card", () => {
    const codex = { author: "ai-Codex", authorName: "Codex", color: "#7b1fa2", role: "ai" as const };
    const editor = makeEditor("<p>Plain lead-in text.</p>");
    const end = 1 + editor.state.doc.textContent.length;
    applyReplacementAsSuggestionMarks(editor, { from: end, to: end }, " A suggested tail sentence.", codex);
    const cards = suggestionsFromSuggestionMarks(editor as never);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("Suggested insertion by Codex");
    expect(cards[0].original.trim().length).toBeGreaterThan(0);
    expect(cards[0].replacement).toContain("A suggested tail sentence.");
    editor.destroy();
  });
});
