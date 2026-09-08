/**
 * Inline emphasis — bold, italic, underline, highlight — as the AI reads and
 * writes it. The document text that reaches a model stays plain (every
 * anchor, offset, and search in Writer is computed on plain text); on top of
 * it ride emphasis spans, and the text is rendered for the model with
 * lightweight markers:
 *
 *   **bold**   *italic*   __underline__   ==highlight==
 *
 * The model quotes originals and writes replacements with the same markers,
 * and `parseEmphasis` turns them back into plain text plus spans that the
 * hosts (Word, the web editor, the DOCX export) apply as real formatting.
 */

import { wordDiffSegments } from "./wordDiff";

export type EmphasisKind = "bold" | "italic" | "underline" | "highlight";

export interface EmphasisFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  highlight?: boolean;
}

/** A run of text with uniform emphasis; offsets are character offsets in the plain text. */
export interface EmphasisSpan extends EmphasisFormat {
  start: number;
  end: number;
}

/** Emphasis on both sides of a suggestion: what the original carries, what the replacement asks for. */
export interface SuggestionEmphasis {
  original: EmphasisSpan[];
  replacement: EmphasisSpan[];
}

export const EMPHASIS_KINDS: EmphasisKind[] = ["bold", "italic", "underline", "highlight"];

export const EMPHASIS_MARKERS: Record<EmphasisKind, string> = {
  bold: "**",
  italic: "*",
  underline: "__",
  highlight: "=="
};

/** One line for prompts and tool descriptions: how emphasis appears and how to write it. */
export const EMPHASIS_NOTATION_NOTE =
  "Inline emphasis in the text is shown with markers: **bold**, *italic*, __underline__, ==highlight==. "
  + "Quote original text with the markers exactly as shown, and use the same markers in replacements to keep, add, or remove emphasis "
  + "(a replacement without markers where the original had them removes the emphasis).";

export function isEmphasisSpan(value: unknown): value is EmphasisSpan {
  if (!value || typeof value !== "object") {
    return false;
  }
  const span = value as Partial<EmphasisSpan>;
  return Number.isInteger(span.start) && Number.isInteger(span.end) && (span.start as number) >= 0 && (span.end as number) >= (span.start as number)
    && EMPHASIS_KINDS.every((kind) => span[kind] === undefined || typeof span[kind] === "boolean");
}

export function isEmphasisSpanList(value: unknown): value is EmphasisSpan[] {
  return Array.isArray(value) && value.every(isEmphasisSpan);
}

export function isSuggestionEmphasis(value: unknown): value is SuggestionEmphasis {
  if (!value || typeof value !== "object") {
    return false;
  }
  const emphasis = value as Partial<SuggestionEmphasis>;
  return isEmphasisSpanList(emphasis.original) && isEmphasisSpanList(emphasis.replacement);
}

export function formatOf(span: EmphasisFormat | null | undefined): EmphasisFormat {
  const format: EmphasisFormat = {};
  for (const kind of EMPHASIS_KINDS) {
    if (span?.[kind]) {
      format[kind] = true;
    }
  }
  return format;
}

export function hasEmphasis(format: EmphasisFormat | null | undefined): boolean {
  return EMPHASIS_KINDS.some((kind) => Boolean(format?.[kind]));
}

export function sameFormat(left: EmphasisFormat | null | undefined, right: EmphasisFormat | null | undefined): boolean {
  return EMPHASIS_KINDS.every((kind) => Boolean(left?.[kind]) === Boolean(right?.[kind]));
}

/** The emphasis at one character offset. */
export function emphasisAt(spans: EmphasisSpan[] | null | undefined, offset: number): EmphasisFormat {
  const format: EmphasisFormat = {};
  for (const span of spans ?? []) {
    if (span.start <= offset && offset < span.end) {
      for (const kind of EMPHASIS_KINDS) {
        if (span[kind]) {
          format[kind] = true;
        }
      }
    }
  }
  return format;
}

/** Spans clipped to [start, end) and rebased so `start` becomes 0. */
export function sliceEmphasis(spans: EmphasisSpan[] | null | undefined, start: number, end: number): EmphasisSpan[] {
  const result: EmphasisSpan[] = [];
  for (const span of spans ?? []) {
    const from = Math.max(span.start, start);
    const to = Math.min(span.end, end);
    if (from < to && hasEmphasis(span)) {
      result.push({ ...formatOf(span), start: from - start, end: to - start });
    }
  }
  return normalizeEmphasis(result);
}

export function shiftEmphasis(spans: EmphasisSpan[] | null | undefined, delta: number): EmphasisSpan[] {
  return (spans ?? []).map((span) => ({ ...span, start: span.start + delta, end: span.end + delta }));
}

/** Sorted, non-overlapping spans with adjacent equal formats merged and empty or plain spans dropped. */
export function normalizeEmphasis(spans: EmphasisSpan[] | null | undefined): EmphasisSpan[] {
  const list = (spans ?? []).filter((span) => span.end > span.start && hasEmphasis(span));
  if (!list.length) {
    return [];
  }
  // Resolve overlaps by combining formats per character boundary.
  const boundaries = new Set<number>();
  for (const span of list) {
    boundaries.add(span.start);
    boundaries.add(span.end);
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const result: EmphasisSpan[] = [];
  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const format: EmphasisFormat = {};
    for (const span of list) {
      if (span.start <= start && end <= span.end) {
        for (const kind of EMPHASIS_KINDS) {
          if (span[kind]) {
            format[kind] = true;
          }
        }
      }
    }
    if (!hasEmphasis(format)) {
      continue;
    }
    const last = result[result.length - 1];
    if (last && last.end === start && sameFormat(last, format)) {
      last.end = end;
    } else {
      result.push({ ...format, start, end });
    }
  }
  return result;
}

/**
 * Merge spans of identical format that are separated only by spaces (not line
 * breaks): "**key** **point**" and a bold phrase read the same way.
 */
export function bridgeEmphasisGaps(text: string, spans: EmphasisSpan[] | null | undefined): EmphasisSpan[] {
  const result: EmphasisSpan[] = [];
  for (const span of normalizeEmphasis(spans)) {
    const last = result[result.length - 1];
    if (last && sameFormat(last, span) && /^[^\S\n]*$/.test(text.slice(last.end, span.start))) {
      last.end = span.end;
    } else {
      result.push({ ...span });
    }
  }
  return result;
}

/** The single format covering all of [start, end), or null when the range mixes formats (or is empty). */
export function uniformEmphasis(spans: EmphasisSpan[] | null | undefined, start: number, end: number): EmphasisFormat | null {
  if (end <= start) {
    return null;
  }
  const first = emphasisAt(spans, start);
  for (let offset = start; offset < end; offset += 1) {
    if (!sameFormat(first, emphasisAt(spans, offset))) {
      return null;
    }
  }
  return first;
}

/* ------------------------------------------------------------------------- */
/* Rendering: plain text + spans -> marked text                              */
/* ------------------------------------------------------------------------- */

function openMarkers(format: EmphasisFormat): string {
  return EMPHASIS_KINDS.filter((kind) => format[kind]).map((kind) => EMPHASIS_MARKERS[kind]).join("");
}

function closeMarkers(format: EmphasisFormat): string {
  return EMPHASIS_KINDS.filter((kind) => format[kind]).map((kind) => EMPHASIS_MARKERS[kind]).reverse().join("");
}

interface FormatRun {
  text: string;
  format: EmphasisFormat;
}

/**
 * Split text into runs of uniform format. Whitespace and line breaks are never
 * inside a formatted run at its edges, so markers hug words the way a model
 * expects to read and write them.
 */
function formatRuns(text: string, spans: EmphasisSpan[] | null | undefined, offset: number): FormatRun[] {
  const normalized = normalizeEmphasis(sliceEmphasis(spans, offset, offset + text.length));
  const runs: FormatRun[] = [];
  const push = (piece: string, format: EmphasisFormat) => {
    if (!piece) {
      return;
    }
    const last = runs[runs.length - 1];
    if (last && sameFormat(last.format, format)) {
      last.text += piece;
    } else {
      runs.push({ text: piece, format: formatOf(format) });
    }
  };
  let cursor = 0;
  for (const span of normalized) {
    if (span.start > cursor) {
      push(text.slice(cursor, span.start), {});
    }
    const format = formatOf(span);
    // Formatted pieces per line; edge whitespace goes to the plain side.
    const piece = text.slice(span.start, span.end);
    const lines = piece.split("\n");
    lines.forEach((line, index) => {
      const leading = line.length - line.trimStart().length;
      const trailing = line.length - line.trimEnd().length;
      const core = line.slice(leading, line.length - trailing);
      push(line.slice(0, leading), {});
      push(core, format);
      push(line.slice(line.length - trailing), {});
      if (index < lines.length - 1) {
        push("\n", {});
      }
    });
    cursor = span.end;
  }
  push(text.slice(cursor), {});
  return runs;
}

/** Plain text with emphasis markers, as the model reads it. */
export function renderEmphasis(text: string, spans: EmphasisSpan[] | null | undefined, offset = 0): string {
  if (!spans?.length) {
    return text;
  }
  return formatRuns(text, spans, offset)
    .map((run) => (hasEmphasis(run.format) ? `${openMarkers(run.format)}${run.text}${closeMarkers(run.format)}` : run.text))
    .join("");
}

/**
 * Like `renderEmphasis`, but every whitespace-delimited word carries its own
 * markers ("**key** **point**" instead of "**key point**"). Diffs computed on
 * this form never split a marker pair across segments, so each diff segment
 * renders on its own.
 */
export function renderEmphasisPerWord(text: string, spans: EmphasisSpan[] | null | undefined, offset = 0): string {
  if (!spans?.length) {
    return text;
  }
  return formatRuns(text, spans, offset)
    .map((run) => {
      if (!hasEmphasis(run.format)) {
        return run.text;
      }
      return run.text
        .split(/(\s+)/)
        .map((part) => (part && !/^\s+$/.test(part) ? `${openMarkers(run.format)}${part}${closeMarkers(run.format)}` : part))
        .join("");
    })
    .join("");
}

/* ------------------------------------------------------------------------- */
/* Parsing: marked text -> plain text + spans                                */
/* ------------------------------------------------------------------------- */

interface MarkerToken {
  index: number;
  kind: EmphasisKind;
  length: number;
  role: "open" | "close" | "literal";
}

function tokenizeMarkers(marked: string): MarkerToken[] {
  const tokens: MarkerToken[] = [];
  let index = 0;
  while (index < marked.length) {
    const char = marked[index];
    const next = marked[index + 1];
    if (char === "*" && next === "*") {
      tokens.push({ index, kind: "bold", length: 2, role: "literal" });
      index += 2;
      continue;
    }
    if (char === "*") {
      tokens.push({ index, kind: "italic", length: 1, role: "literal" });
      index += 1;
      continue;
    }
    if (char === "_" && next === "_") {
      tokens.push({ index, kind: "underline", length: 2, role: "literal" });
      index += 2;
      continue;
    }
    if (char === "=" && next === "=") {
      tokens.push({ index, kind: "highlight", length: 2, role: "literal" });
      index += 2;
      continue;
    }
    index += 1;
  }
  return tokens;
}

function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

/**
 * Strip emphasis markers and return the plain text with the spans they
 * described. Markers pair per kind in order; a marker that cannot open (no
 * text follows it), cannot close (space before it), or never finds its
 * partner is left in the text as literal characters, so stray asterisks in
 * prose survive untouched.
 */
export function parseEmphasis(marked: string): { text: string; spans: EmphasisSpan[] } {
  const tokens = tokenizeMarkers(marked);
  if (!tokens.length) {
    return { text: marked, spans: [] };
  }
  const open: Partial<Record<EmphasisKind, MarkerToken>> = {};
  for (const token of tokens) {
    const before = marked[token.index - 1];
    const after = marked[token.index + token.length];
    const nextTokenAdjacent = tokens.some((other) => other !== token && other.index === token.index + token.length);
    const previousTokenAdjacent = tokens.some((other) => other !== token && other.index + other.length === token.index);
    const opener = open[token.kind];
    if (opener) {
      // Close when text (or another closing marker) precedes it.
      if (!isSpace(before) || previousTokenAdjacent) {
        token.role = "close";
        opener.role = "open";
        delete open[token.kind];
        continue;
      }
    }
    if (!opener && (!isSpace(after) || nextTokenAdjacent)) {
      open[token.kind] = token;
      continue;
    }
  }
  // Openers that never closed stay literal.
  for (const kind of EMPHASIS_KINDS) {
    const dangling = open[kind];
    if (dangling) {
      dangling.role = "literal";
    }
  }

  let text = "";
  const spans: EmphasisSpan[] = [];
  const state: EmphasisFormat = {};
  const starts: Partial<Record<EmphasisKind, number>> = {};
  let cursor = 0;
  for (const token of tokens) {
    text += marked.slice(cursor, token.index);
    cursor = token.index + token.length;
    if (token.role === "literal") {
      text += marked.slice(token.index, cursor);
      continue;
    }
    if (token.role === "open") {
      state[token.kind] = true;
      starts[token.kind] = text.length;
    } else {
      const start = starts[token.kind] ?? text.length;
      if (text.length > start) {
        spans.push({ start, end: text.length, [token.kind]: true });
      }
      state[token.kind] = false;
      delete starts[token.kind];
    }
  }
  text += marked.slice(cursor);
  return { text, spans: bridgeEmphasisGaps(text, spans) };
}

/** True when the text carries at least one paired emphasis marker. */
export function hasEmphasisMarkers(marked: string): boolean {
  return parseEmphasis(marked).spans.length > 0;
}

/* ------------------------------------------------------------------------- */
/* Carrying emphasis through an edit the model made in plain text            */
/* ------------------------------------------------------------------------- */

/**
 * Emphasis for a replacement written without markers: words kept from the
 * original keep their emphasis; inserted words take the emphasis of the kept
 * word before them (what Word does when you type inside bold text). A rewrite
 * with nothing in common keeps the original's emphasis only when the whole
 * original was uniformly emphasised.
 */
export function carryEmphasis(original: string, originalSpans: EmphasisSpan[] | null | undefined, replacement: string): EmphasisSpan[] {
  if (!originalSpans?.length || !replacement) {
    return [];
  }
  const segments = wordDiffSegments(original, replacement);
  if (!segments) {
    const uniform = uniformEmphasis(originalSpans, 0, original.length);
    return uniform && hasEmphasis(uniform) ? [{ ...uniform, start: 0, end: replacement.length }] : [];
  }
  const spans: EmphasisSpan[] = [];
  let originalCursor = 0;
  let replacementCursor = 0;
  let inherited: EmphasisFormat = {};
  for (const segment of segments) {
    if (segment.type === "del") {
      originalCursor += segment.text.length;
      continue;
    }
    if (segment.type === "same") {
      // Copy the original's emphasis word by word.
      let local = 0;
      for (const part of segment.text.split(/(\s+)/)) {
        if (!part) {
          continue;
        }
        const format = uniformEmphasis(originalSpans, originalCursor + local, originalCursor + local + part.length)
          ?? emphasisAt(originalSpans, originalCursor + local);
        if (hasEmphasis(format) && !/^\s+$/.test(part)) {
          spans.push({ ...format, start: replacementCursor + local, end: replacementCursor + local + part.length });
        }
        if (!/^\s+$/.test(part)) {
          inherited = format;
        }
        local += part.length;
      }
      originalCursor += segment.text.length;
      replacementCursor += segment.text.length;
      continue;
    }
    if (hasEmphasis(inherited) && segment.text.trim()) {
      const leading = segment.text.length - segment.text.trimStart().length;
      const trailing = segment.text.length - segment.text.trimEnd().length;
      spans.push({ ...inherited, start: replacementCursor + leading, end: replacementCursor + segment.text.length - trailing });
    }
    replacementCursor += segment.text.length;
  }
  return bridgeEmphasisGaps(replacement, spans);
}

/** The text cut into consecutive pieces of uniform emphasis (whitespace included), for hosts that emit formatted runs. */
export function splitByEmphasis(text: string, spans: EmphasisSpan[] | null | undefined): Array<{ text: string; format: EmphasisFormat }> {
  const pieces: Array<{ text: string; format: EmphasisFormat }> = [];
  let cursor = 0;
  for (const span of normalizeEmphasis(sliceEmphasis(spans, 0, text.length))) {
    if (span.start > cursor) {
      pieces.push({ text: text.slice(cursor, span.start), format: {} });
    }
    pieces.push({ text: text.slice(span.start, span.end), format: formatOf(span) });
    cursor = span.end;
  }
  if (cursor < text.length) {
    pieces.push({ text: text.slice(cursor), format: {} });
  }
  return pieces.filter((piece) => piece.text);
}

/**
 * Emphasis spans over a text assembled from formatted pieces (a Word
 * paragraph's word ranges, an editor's text nodes): each piece contributes
 * its format at its position.
 */
export function emphasisFromPieces(pieces: Array<{ text: string; format: EmphasisFormat | null | undefined }>, offset = 0): EmphasisSpan[] {
  const spans: EmphasisSpan[] = [];
  let cursor = offset;
  for (const piece of pieces) {
    if (piece.text && hasEmphasis(piece.format)) {
      spans.push({ ...formatOf(piece.format), start: cursor, end: cursor + piece.text.length });
    }
    cursor += piece.text.length;
  }
  return normalizeEmphasis(spans);
}
