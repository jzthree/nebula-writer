// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderReplyMarkdown } from "../src/replyMarkdownHtml";
import type { AiSuggestion } from "../src/shared";
import { parseAssistantReply } from "../src/word/replyLayout";

const SAMPLE = [
  "Here is **ProCapNet**'s verified performance:",
  "| Benchmark | ProCapNet | Your model | Source |",
  "|---|---:|---:|---|",
  "| **6-line held-out `chr8/9` PRO-cap** | **`R = 0.698`** | *Puffin 2* | [source.csv](file:///Users/me/Code/fig/source%20v14.csv) |",
  "So your model sits **+0.12 in `R` ahead**. See [the paper](https://example.org/p)."
].join("\n");

describe("reply markdown", () => {
  it("renders bold, italics, code, tables and links", () => {
    const html = renderReplyMarkdown(SAMPLE);
    expect(html).toContain("<strong>ProCapNet</strong>");
    expect(html).toContain('<div class="md-table"><table>');
    expect(html).toContain('<th style="text-align:right">ProCapNet</th>');
    expect(html).toContain("<strong>6-line held-out <code>chr8/9</code> PRO-cap</strong>");
    expect(html).toContain("<em>Puffin 2</em>");
    expect(html).toContain('<a href="https://example.org/p" target="_blank" rel="noopener noreferrer"');
  });

  it("keeps a file link's path to copy instead of a link the pane cannot open", () => {
    const html = renderReplyMarkdown(SAMPLE);
    expect(html).toContain('href="#" data-path="/Users/me/Code/fig/source v14.csv"');
    expect(html).toContain(">source.csv</a>");
    expect(html).not.toContain('href="file:');
  });

  it("shows raw HTML as text, drops unsafe links and links images instead of loading them", () => {
    const html = renderReplyMarkdown('<img src=x onerror="alert(1)"> [click](javascript:alert(1)) ![chart](https://tracker.example/p.png)');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain('href="javascript:');
    // An image is a link to it, not a request the pane makes.
    expect(html).toContain('<a href="https://tracker.example/p.png" target="_blank" rel="noopener noreferrer" title="https://tracker.example/p.png">chart</a>');
  });

  it("keeps single newlines as line breaks and blank lines as paragraphs", () => {
    expect(renderReplyMarkdown("one\ntwo\n\nthree")).toBe("<p>one<br>\ntwo</p>\n<p>three</p>\n");
  });
});

describe("reply layout keeps Markdown structure", () => {
  const cards: AiSuggestion[] = [{ id: "a", ref: "S1", title: "a", original: "o", replacement: "r", rationale: "", confidence: 0.7, target: "global", range: null, status: "pending" }];

  it("keeps blank lines, nested-list indentation and table rows in a text block", () => {
    const text = "Lead.\n\n- one\n  - nested\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[S1]\n\nAfter.";
    const layout = parseAssistantReply(text, cards);
    expect(layout.groups[0].blocks).toEqual([
      { kind: "text", text: "Lead.\n\n- one\n  - nested\n\n| a | b |\n|---|---|\n| 1 | 2 |" },
      { kind: "cards", ids: ["a"] },
      { kind: "text", text: "After." }
    ]);
  });

  it("leaves headings and refs inside a code fence alone", () => {
    const layout = parseAssistantReply("Run:\n```\n## not a heading\n[S1]\n```\nDone.", cards);
    expect(layout.groups[0].heading).toBeNull();
    expect(layout.groups[0].blocks[0]).toEqual({ kind: "text", text: "Run:\n```\n## not a heading\n[S1]\n```\nDone." });
    expect(layout.structured).toBe(false);
  });
});
