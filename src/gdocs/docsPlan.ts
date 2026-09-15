/**
 * Pure planning for the Google Docs host: finding a suggestion's text in the
 * snapshot and turning a suggestion into replace operations the script
 * applies. Kept free of the script bridge so it is fully unit-testable.
 */

import { sliceEmphasis, type EmphasisSpan } from "../emphasis";
import type { AiSuggestion } from "../shared";
import type { WordDocumentSnapshot, WordParagraphInfo } from "../word/wordContext";
import { excerpt, normalizeWordText, paragraphAtOffset } from "../word/wordContext";
import { wordDiffSegments } from "../wordDiff";
import type { SuggestionMatch } from "../word/wordHost";
import type { DocsReplaceOp, DocsTextRange } from "./protocol";

const MATCH_PREVIEW_CHARS = 90;

/** Where a match sits in the snapshot's body text. */
export interface DocsMatch extends SuggestionMatch {
  from: number;
  to: number;
}

/** Every occurrence of the original in the body text (exact, then whitespace-tolerant), with the context the placement anchor scores. */
export function findMatches(snapshot: WordDocumentSnapshot, original: string): DocsMatch[] {
  const needle = normalizeWordText(original).trim();
  if (!needle) {
    return [];
  }
  const body = snapshot.bodyText;
  let ranges = occurrences(body, needle);
  if (!ranges.length) {
    const collapsed = collapseWithPositions(body);
    ranges = occurrences(collapsed.text, needle.replace(/\s+/g, " ")).map((range) => ({
      from: collapsed.positions[range.from],
      to: collapsed.positions[range.to - 1] + 1
    }));
  }
  return ranges.map((range, index) => {
    const paragraph = paragraphAtOffset(snapshot.paragraphs, range.from);
    const endParagraph = paragraphAtOffset(snapshot.paragraphs, Math.max(range.from, range.to - 1));
    const previous = paragraph && paragraph.index > 0 ? snapshot.paragraphs[paragraph.index - 1].text : "";
    const next = endParagraph && endParagraph.index + 1 < snapshot.paragraphs.length ? snapshot.paragraphs[endParagraph.index + 1].text : "";
    const beforeInParagraph = paragraph ? body.slice(paragraph.offset, range.from) : "";
    const afterInParagraph = endParagraph ? body.slice(range.to, endParagraph.offset + endParagraph.length) : "";
    return {
      index,
      from: range.from,
      to: range.to,
      offset: range.from,
      paragraphIndex: paragraph?.index ?? null,
      preview: excerpt(paragraph?.text ?? body.slice(range.from, range.to), MATCH_PREVIEW_CHARS),
      contextBefore: `${previous}\n${beforeInParagraph}`,
      contextAfter: `${afterInParagraph}\n${next}`
    };
  });
}

function occurrences(haystack: string, needle: string): Array<{ from: number; to: number }> {
  const found: Array<{ from: number; to: number }> = [];
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    found.push({ from: index, to: index + needle.length });
    index = haystack.indexOf(needle, index + Math.max(1, needle.length));
  }
  return found;
}

function collapseWithPositions(value: string): { text: string; positions: number[] } {
  let text = "";
  const positions: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (/\s/.test(char)) {
      if (text && !text.endsWith(" ")) {
        text += " ";
        positions.push(index);
      }
      continue;
    }
    text += char;
    positions.push(index);
  }
  return { text, positions };
}

/** Body offsets → paragraph coordinates (end exclusive). */
export function rangeToParagraphs(paragraphs: WordParagraphInfo[], from: number, to: number): DocsTextRange | null {
  const first = paragraphAtOffset(paragraphs, from);
  const last = paragraphAtOffset(paragraphs, Math.max(from, to - 1));
  if (!first || !last) {
    return null;
  }
  return {
    paragraphIndex: first.index,
    start: from - first.offset,
    endParagraphIndex: last.index,
    end: to - last.offset
  };
}

export interface PlannedEdit {
  ops: DocsReplaceOp[];
  strategy: "range" | "words" | "emphasis";
}

/**
 * Replace operations for one suggestion at one match. A single-paragraph,
 * single-line change is applied word by word (only the words that change are
 * touched, so the formatting of the rest survives); anything else replaces
 * the whole range. Emphasis the AI asked for rides on each operation,
 * relative to that operation's text.
 */
export function planReplace(
  snapshot: WordDocumentSnapshot,
  suggestion: Pick<AiSuggestion, "id" | "original" | "replacement" | "emphasis">,
  match: { from: number; to: number },
  options: { highlight: boolean }
): PlannedEdit | { error: string } {
  const body = snapshot.bodyText;
  const current = body.slice(match.from, match.to);
  const replacement = normalizeWordText(suggestion.replacement).trim();
  const emphasis = suggestion.emphasis?.replacement ?? null;
  const range = rangeToParagraphs(snapshot.paragraphs, match.from, match.to);
  if (!range) {
    return { error: "The passage could not be mapped to a paragraph." };
  }
  const whole = (): DocsReplaceOp => ({
    id: suggestion.id,
    ...range,
    expected: current,
    text: replacement,
    emphasis,
    highlight: options.highlight
  });

  if (collapseText(current) === collapseText(replacement)) {
    // Emphasis only: the script applies formatting over the existing text.
    return { ops: [{ ...whole(), text: current }], strategy: "emphasis" };
  }
  if (!replacement || current.includes("\n") || replacement.includes("\n")) {
    return { ops: [whole()], strategy: "range" };
  }
  const segments = wordDiffSegments(current, replacement);
  if (!segments) {
    return { ops: [whole()], strategy: "range" };
  }
  // Runs of changed words become one operation each; kept words are untouched.
  const ops: DocsReplaceOp[] = [];
  let originalCursor = 0;
  let replacementCursor = 0;
  let pendingDelete = "";
  let pendingInsert = "";
  let pendingStart = 0;
  let pendingInsertOffset = 0;
  let sequence = 0;
  const flush = () => {
    if (!pendingDelete && !pendingInsert) {
      return;
    }
    const start = match.from + pendingStart;
    const end = start + pendingDelete.length;
    const local = rangeToParagraphs(snapshot.paragraphs, start, Math.max(start, end));
    if (local) {
      ops.push({
        id: `${suggestion.id}#${sequence}`,
        paragraphIndex: local.paragraphIndex,
        start: local.start,
        endParagraphIndex: local.paragraphIndex,
        end: local.start + pendingDelete.length,
        expected: pendingDelete,
        text: pendingInsert,
        emphasis: emphasis ? sliceEmphasis(emphasis, pendingInsertOffset, pendingInsertOffset + pendingInsert.length) : null,
        highlight: options.highlight
      });
      sequence += 1;
    }
    pendingDelete = "";
    pendingInsert = "";
  };
  for (const segment of segments) {
    if (segment.type === "same") {
      flush();
      originalCursor += segment.text.length;
      replacementCursor += segment.text.length;
      continue;
    }
    if (!pendingDelete && !pendingInsert) {
      pendingStart = originalCursor;
      pendingInsertOffset = replacementCursor;
    }
    if (segment.type === "del") {
      pendingDelete += segment.text;
      originalCursor += segment.text.length;
    } else {
      pendingInsert += segment.text;
      replacementCursor += segment.text.length;
    }
  }
  flush();
  if (!ops.length) {
    return { ops: [whole()], strategy: "range" };
  }
  // Explicit emphasis over kept words must land too: when the AI asked for
  // emphasis, format the whole result rather than only the changed runs.
  if (emphasis && emphasis.length) {
    return { ops: [whole()], strategy: "range" };
  }
  return { ops, strategy: "words" };
}

function collapseText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Two planned ranges touch or overlap (in body offsets). */
export function rangesOverlap(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from < b.to && b.from < a.to;
}
