// @vitest-environment node

import { describe, expect, it } from "vitest";
import { canonicalText, nearestDocumentExcerpt, repairAnchor } from "../server/anchor-repair";
import { parseCliResponse } from "../server/ai";
import { validateSuggestionCandidate } from "../server/suggestion-validation";
import type { AiRequest } from "../src/shared";

const REFERENCES = "[13] Schultz DC et al. Genes Dev. 2002;16:919–932. [14] Zhou J et al. Nat Genet. 2018;50:1171–1179. PMC6094955. [15] Chen KM et al. Nat Genet. 2022;54:940–949. [16] Avsec Ž et al. Nat Methods. 2021;18:1196–1203. [17] Linder J et al. Nat Genet. 2025;57:949–961.";
const DOCUMENT = `Aims\nSome body text about accessibility.\nReferences\n${REFERENCES}\nEnd.`;

describe("anchor repair", () => {
  it("snaps a long quote with a misquoted entry to the document's text and keeps the misquote out of the replacement", () => {
    const misquoted = REFERENCES.replace("Zhou J et al.", "Zhou J, Troyanskaya OG.");
    const replacement = misquoted.replace(/;\d+:\d+[–-]\d+/g, "").replace(" PMC6094955.", " PMC6094955.");
    const repaired = repairAnchor(DOCUMENT, misquoted, replacement);
    expect(repaired).not.toBeNull();
    expect(repaired?.original).toBe(REFERENCES);
    expect(repaired?.replacement).toContain("Zhou J et al. Nat Genet. 2018.");
    expect(repaired?.replacement).not.toContain("Troyanskaya");
    expect(repaired?.note).toContain("differed from the document in 1 place");
  });

  it("forgives typographic and whitespace differences", () => {
    const text = 'She said "wait" — then left.';
    const doc = `Intro.\n${text}\nOutro.`;
    expect(repairAnchor(doc, "She said \u201Cwait\u201D \u2014 then left.", "She left.")?.original).toBe(text);
    expect(repairAnchor(doc, "She said \"wait\"\n— then  left.", "She left.")?.original).toBe(text);
    expect(canonicalText("\u2018a\u2019 \u2013 b\u00a0c")).toBe("'a' - b c");
  });

  it("refuses when nothing close exists or the quote is too different", () => {
    expect(repairAnchor(DOCUMENT, "This sentence does not appear anywhere in the document at all, not even close.", "x")).toBeNull();
    const heavilyChanged = REFERENCES.replace(/Nat Genet/g, "Nature Genetics").replace(/Genes Dev/g, "Genes and Development").replace(/et al\./g, "and colleagues");
    expect(repairAnchor(DOCUMENT, heavilyChanged, "x")).toBeNull();
    expect(repairAnchor(DOCUMENT, REFERENCES, "x")).toBeNull();
  });

  it("offers the nearest document excerpt for a re-quote request", () => {
    expect(nearestDocumentExcerpt(DOCUMENT, "[13] Schultz DC et al. Genes Dev. 2002;16:919-932. [14] Zhou J, Troyanskaya OG.")).toContain("[13] Schultz DC et al.");
    expect(nearestDocumentExcerpt(DOCUMENT, "Completely unrelated words that never occur.")).toBeNull();
  });

  it("is applied by both validators, with a note", () => {
    const request: AiRequest = { provider: "codex", instruction: "compact", mode: "global", documentHtml: "", documentText: DOCUMENT, selection: null };
    const misquoted = REFERENCES.replace("Zhou J et al.", "Zhou J, Troyanskaya OG.");
    const raw = JSON.stringify({ message: "Compacted.", suggestions: [{ title: "Compact the reference list", original: misquoted, replacement: "[13] Schultz. [14] Zhou J, Troyanskaya OG. [15] Chen.", rationale: "x", confidence: 0.8 }] });
    const response = parseCliResponse("codex", raw, request);
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].original).toBe(REFERENCES);
    expect(response.suggestions[0].replacement).toBe("[13] Schultz. [14] Zhou J et al. [15] Chen.");
    expect(response.message).toContain("1 quote was repaired to match the document exactly");

    const verdict = validateSuggestionCandidate({ title: "Compact", original: misquoted, replacement: "shorter", rationale: "x" }, request);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.suggestion.original).toBe(REFERENCES);
      expect(verdict.note).toContain("Anchor repaired");
    }
  });
});
