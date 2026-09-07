import { randomUUID } from "node:crypto";
import type { AiRequest, AiSuggestion } from "../src/shared";

/**
 * Suggestion safety checks, shared by the AI pipeline and the agent staging
 * tool. A candidate must anchor to exact source text and must not be a
 * whitespace-only no-op; what the edit does to the text is the reviewer's
 * call (the card shows the diff), not a filter's. Callers get a reason string
 * back so an agent can correct and retry.
 */

export type SuggestionCandidate = Partial<AiSuggestion> & {
  original?: unknown;
  replacement?: unknown;
  title?: unknown;
  rationale?: unknown;
  confidence?: unknown;
  commentOnly?: unknown;
};

export type SuggestionValidation =
  | { ok: true; suggestion: AiSuggestion }
  | { ok: false; reason: string };

export function validateSuggestionCandidate(
  item: SuggestionCandidate,
  request: Pick<AiRequest, "mode" | "documentText" | "selection">
): SuggestionValidation {
  const original = String(item.original ?? "").trim();
  const replacement = String(item.replacement ?? "").trim();
  const advisory = item.commentOnly === true;
  if (!original) {
    return { ok: false, reason: "original is empty — copy the exact source text you want to change." };
  }
  if (!replacement) {
    if (advisory) {
      return { ok: false, reason: "replacement is empty — for advisory notes, repeat the original text as the replacement." };
    }
    // An explicit empty string proposes DELETING the original — a supported
    // suggestion kind (the accept path and Word review exports handle pure
    // deletions). A missing field is still an error: that's a malformed
    // candidate, not a deletion.
    if (typeof item.replacement !== "string") {
      return { ok: false, reason: "replacement is missing — provide the revised text, or an empty string to propose deleting the original." };
    }
  }
  // Advisory notes (commentOnly) may keep the text unchanged — the rationale
  // carries the message. Text edits must actually change something.
  if (!advisory && normalizeWhitespace(original) === normalizeWhitespace(replacement)) {
    return { ok: false, reason: "replacement only changes whitespace — propose a substantive edit, or set commentOnly: true if this is an advisory note." };
  }

  // The selection is the focus of a selection-scoped request, not a fence:
  // a passage found elsewhere in the document is accepted as a document-wide
  // edit (target "global", no stored range) so an instruction the selection
  // alone cannot satisfy is still carried out.
  const selectionText = request.mode === "selection" ? request.selection?.text ?? "" : "";
  const inSelection = request.mode === "selection" && containsAnchoredText(selectionText, original);
  if (!inSelection && !containsAnchoredText(request.documentText, original)) {
    return {
      ok: false,
      reason: "original is not an exact substring of the document. Use writer_search_document to locate the passage and copy it verbatim (including punctuation and spacing)."
    };
  }

  const commentOnly = item.commentOnly === true || replacementRequiresAuthorConfirmation(replacement);
  return {
    ok: true,
    suggestion: {
      ...(commentOnly ? { commentOnly: true } : {}),
      id: randomUUID(),
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 160) : "Revise passage",
      original,
      replacement,
      rationale: typeof item.rationale === "string" && item.rationale.trim() ? item.rationale.trim() : "Proposed by the selected local AI provider.",
      confidence: normalizeConfidence(item.confidence),
      target: inSelection ? "selection" : "global",
      range: inSelection ? request.selection ?? null : null,
      status: "pending"
    }
  };
}

export function replacementRequiresAuthorConfirmation(replacement: string): boolean {
  return /\[(?:PI|author|collaborator|user)\s*:\s*(?:add|confirm|fill|insert|replace|resolve|verify)\b/i.test(replacement)
    || /\b(?:PI|author|collaborator|user)\s*:\s*(?:add|confirm|fill|insert|replace|resolve|verify)\b/i.test(replacement);
}

export function containsAnchoredText(scopeText: string, original: string): boolean {
  return scopeText.includes(original) || normalizeWhitespace(scopeText).includes(normalizeWhitespace(original));
}


export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeConfidence(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    return 0.65;
  }
  return Math.max(0, Math.min(1, number));
}
