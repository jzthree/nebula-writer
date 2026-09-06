import { randomUUID } from "node:crypto";
import type { AiRequest, AiSuggestion } from "../src/shared";

/**
 * Suggestion safety checks, shared by the AI pipeline and the agent staging
 * tool. A candidate must anchor to exact source text, must not be a
 * whitespace-only no-op, and must carry protected reference/formula tokens
 * into the replacement. Unlike the pipeline's silent filtering, callers here
 * get a reason string back so an agent can correct and retry.
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

  const scopeText = request.mode === "selection" ? request.selection?.text ?? "" : request.documentText;
  if (!containsAnchoredText(scopeText, original)) {
    return {
      ok: false,
      reason: request.mode === "selection"
        ? "original is not an exact substring of the selected text. Re-read the selection and copy the passage verbatim."
        : "original is not an exact substring of the document. Use writer_search_document to locate the passage and copy it verbatim (including punctuation and spacing)."
    };
  }

  const missingTokens = missingProtectedTokens(original, replacement);
  if (missingTokens.length > 0) {
    return {
      ok: false,
      reason: `replacement drops protected token${missingTokens.length === 1 ? "" : "s"} ${missingTokens.slice(0, 3).map((token) => JSON.stringify(token)).join(", ")} — citations, formulas, URLs, DOIs, and reference labels must be carried over exactly.`
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
      target: request.mode,
      range: request.mode === "selection" ? request.selection ?? null : null,
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

export function missingProtectedTokens(original: string, replacement: string): string[] {
  const protectedTokens = protectedTextTokens(original);
  if (protectedTokens.length === 0) {
    return [];
  }
  return protectedTokens.filter((token) => !replacement.includes(token));
}

export function protectedTextTokens(value: string): string[] {
  const tokenPatterns = [
    /\$\$[\s\S]{1,800}?\$\$|\$[^$\r\n]{1,240}\$/g,
    /\\\([\s\S]{1,400}?\\\)|\\\[[\s\S]{1,800}?\\\]/g,
    /\[[^\]\r\n]*(?:@[\w:.-]+|(?:19|20)\d{2}|doi\b)[^\]\r\n]*\]/gi,
    /\[(?:\d+(?:\s*[-,;]\s*\d+)*)\]/g,
    /\((?=[^)\r\n]*(?:19|20)\d{2})(?=[^)\r\n]*(?:et al\.|[A-Z][A-Za-z'’-]+))[A-Za-z0-9,;.&\s'’-]+(?:19|20)\d{2}[a-z]?\)/g,
    /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi,
    /https?:\/\/[^\s)]+/gi,
    /\\(?:cite|citet|citep|citealp|citeauthor|citeyear|nocite|parencite|textcite|autocite|footcite|supercite|ref|eqref|autoref|cref|Cref|label)\*?(?:\[[^\]\r\n]*\]){0,2}\{[^}\r\n]{1,240}\}/g,
    /\b(?:Eq\.?|Equation|Formula)\s*\(?\d+[a-z]?\)?/gi
  ];
  const tokens = tokenPatterns.flatMap((pattern) => value.match(pattern) ?? []);
  return [...new Set(tokens.map((token) => token.trim()).filter(Boolean))];
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
