import { randomUUID } from "node:crypto";
import type { AiDocumentImage, AiRequest, AiSuggestion } from "../src/shared";
import { suggestionAnchorFor } from "../src/shared";
import { parseQuotedText, sameEmphasisSpans, stagedEmphasis } from "./emphasis-staging";
import { importImageFile } from "./image-files";
import { repairAnchor } from "./anchor-repair";

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
  /** Image replacement: which document picture (0-based) and the file that replaces it. */
  imageIndex?: unknown;
  imageFile?: unknown;
};

export function isImageCandidate(item: SuggestionCandidate): boolean {
  return item.imageIndex !== undefined && item.imageIndex !== null && item.imageIndex !== "";
}

/** Label a document picture the way prompts and cards refer to it. */
export function documentImageLabel(image: Pick<AiDocumentImage, "index" | "context" | "altText">): string {
  const hint = (image.context ?? image.altText ?? "").replace(/\s+/g, " ").trim();
  return `[Image ${image.index + 1}]${hint ? ` ${hint.length > 80 ? `${hint.slice(0, 77)}…` : hint}` : ""}`;
}

/**
 * An image replacement must name an existing document picture and point at
 * a real PNG/JPEG/GIF/WebP file within the size limit; the file is copied into
 * Writer's image store so it can be previewed and applied later.
 */
export function validateImageReplacementCandidate(item: SuggestionCandidate, images: AiDocumentImage[]): SuggestionValidation {
  const index = typeof item.imageIndex === "number" ? item.imageIndex : Number(item.imageIndex);
  if (!Number.isInteger(index) || index < 0 || index >= images.length) {
    return {
      ok: false,
      reason: images.length
        ? `imageIndex must be between 0 and ${images.length - 1} (the document has ${images.length} image${images.length === 1 ? "" : "s"}; list them with writer_list_images).`
        : "This document has no images to replace."
    };
  }
  const file = typeof item.imageFile === "string" ? item.imageFile.trim() : "";
  if (!file) {
    return { ok: false, reason: "imageFile is missing — the absolute path of the PNG/JPEG/GIF/WebP file that should replace the picture." };
  }
  const stored = importImageFile(file, `image-${index + 1}-replacement`);
  if ("error" in stored) {
    return { ok: false, reason: `imageFile could not be used: ${stored.error}` };
  }
  const target = images[index];
  return {
    ok: true,
    suggestion: {
      kind: "image",
      image: { index, path: stored.path, url: stored.url, mime: stored.mime, originalUrl: target.url, width: target.width ?? null, height: target.height ?? null },
      id: randomUUID(),
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 160) : `Replace image ${index + 1}`,
      original: documentImageLabel(target),
      replacement: "",
      rationale: typeof item.rationale === "string" && item.rationale.trim() ? item.rationale.trim() : "Proposed replacement image.",
      confidence: normalizeConfidence(item.confidence),
      target: "global",
      range: null,
      status: "pending"
    }
  };
}

export type SuggestionValidation =
  | { ok: true; suggestion: AiSuggestion; note?: string }
  | { ok: false; reason: string };

export function validateSuggestionCandidate(
  item: SuggestionCandidate,
  request: Pick<AiRequest, "mode" | "documentText" | "selection" | "documentEmphasis">
): SuggestionValidation {
  const quotedOriginal = parseQuotedText(item.original);
  const quotedReplacement = parseQuotedText(item.replacement);
  const original = quotedOriginal.text;
  const replacement = quotedReplacement.text;
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
  if (!advisory && normalizeWhitespace(original) === normalizeWhitespace(replacement) && sameEmphasisSpans(quotedOriginal.spans, quotedReplacement.spans)) {
    return { ok: false, reason: "replacement only changes whitespace — propose a substantive edit, or set commentOnly: true if this is an advisory note." };
  }

  // The selection is the focus of a selection-scoped request, not a fence:
  // a passage found elsewhere in the document is accepted as a document-wide
  // edit (target "global", no stored range) so an instruction the selection
  // alone cannot satisfy is still carried out.
  const selectionText = request.mode === "selection" ? request.selection?.text ?? "" : "";
  const inSelection = request.mode === "selection" && containsAnchoredText(selectionText, original);
  let anchoredOriginal = original;
  let anchoredReplacement = replacement;
  let note: string | undefined;
  if (!inSelection && !containsAnchoredText(request.documentText, original)) {
    // Self-healing: a near-miss quote is snapped to the document's exact text.
    const repaired = repairAnchor(request.documentText, original, replacement);
    if (!repaired) {
      return {
        ok: false,
        reason: "original is not an exact substring of the document. Use writer_search_document to locate the passage and copy it verbatim (including punctuation and spacing)."
      };
    }
    anchoredOriginal = repaired.original;
    anchoredReplacement = repaired.replacement;
    note = `Anchor repaired: ${repaired.note}; the suggestion now targets the document's exact text.`;
  }

  const commentOnly = item.commentOnly === true || replacementRequiresAuthorConfirmation(anchoredReplacement);
  const anchor = suggestionAnchorFor(request.documentText, anchoredOriginal, inSelection ? request.selection?.from ?? null : null);
  const emphasis = stagedEmphasis({
    documentEmphasis: request.documentEmphasis,
    anchorOffset: anchor?.offset ?? null,
    original: anchoredOriginal,
    quotedReplacement,
    replacement: anchoredReplacement,
    explicit: quotedOriginal.marked || quotedReplacement.marked
  });
  return {
    ok: true,
    ...(note ? { note } : {}),
    suggestion: {
      ...(commentOnly ? { commentOnly: true } : {}),
      ...(emphasis ? { emphasis } : {}),
      id: randomUUID(),
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 160) : "Revise passage",
      original: anchoredOriginal,
      replacement: anchoredReplacement,
      rationale: typeof item.rationale === "string" && item.rationale.trim() ? item.rationale.trim() : "Proposed by the selected local AI provider.",
      confidence: normalizeConfidence(item.confidence),
      target: inSelection ? "selection" : "global",
      range: inSelection ? request.selection ?? null : null,
      anchor,
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
