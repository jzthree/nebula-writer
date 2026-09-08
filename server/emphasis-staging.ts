import { carryEmphasis, normalizeEmphasis, parseEmphasis, sliceEmphasis, type EmphasisSpan, type SuggestionEmphasis } from "../src/emphasis";

/**
 * A string the AI quoted or wrote, with emphasis markers parsed out: trimmed
 * plain text plus spans rebased to it, and whether markers were present.
 */
export function parseQuotedText(value: unknown): { text: string; spans: EmphasisSpan[]; marked: boolean } {
  const parsed = parseEmphasis(String(value ?? ""));
  const leading = parsed.text.length - parsed.text.trimStart().length;
  const text = parsed.text.trim();
  return { text, spans: sliceEmphasis(parsed.spans, leading, leading + text.length), marked: parsed.spans.length > 0 };
}

/**
 * The emphasis record for a staged suggestion. Only when the AI worked with
 * markers (in the quote or the replacement) is emphasis explicit; the
 * original side is what the document actually carries at the anchor, the
 * replacement side is what the AI asked for — carried across an anchor
 * repair when that changed the replacement's text.
 */
export function stagedEmphasis(options: {
  documentEmphasis: EmphasisSpan[] | null | undefined;
  anchorOffset: number | null;
  original: string;
  quotedReplacement: { text: string; spans: EmphasisSpan[] };
  replacement: string;
  explicit: boolean;
}): SuggestionEmphasis | null {
  if (!options.explicit) {
    return null;
  }
  const original = options.anchorOffset === null
    ? []
    : sliceEmphasis(options.documentEmphasis, options.anchorOffset, options.anchorOffset + options.original.length);
  const replacement = options.replacement === options.quotedReplacement.text
    ? options.quotedReplacement.spans
    : carryEmphasis(options.quotedReplacement.text, options.quotedReplacement.spans, options.replacement);
  return { original, replacement };
}

/** Whether two span lists describe the same emphasis (an emphasis-only edit is a real change). */
export function sameEmphasisSpans(left: EmphasisSpan[], right: EmphasisSpan[]): boolean {
  const key = (spans: EmphasisSpan[]) => JSON.stringify(normalizeEmphasis(spans).map((span) => [span.start, span.end, Boolean(span.bold), Boolean(span.italic), Boolean(span.underline), Boolean(span.highlight)]));
  return key(left) === key(right);
}
