/**
 * Pure helpers for the Word add-in's window-state awareness.
 *
 * Office.js hands us paragraph objects, a selection range, and (on desktop)
 * the pages on screen — but no character offsets. Everything here turns those
 * pieces into offsets into one normalized document text, which is what the
 * sidecar, the agents, and suggestion anchors all speak. Kept free of
 * Office.js so it is unit-testable and reusable by the mock host.
 */

import {
  WORD_HOST_CONTEXT_LIMITS,
  type SelectionContext,
  type WordHostContext,
  type WordHostContextFocusEntry,
  type WordHostContextOutlineEntry
} from "../shared";

export interface WordParagraphSource {
  text: string;
  style?: string | null;
  styleBuiltIn?: string | null;
  outlineLevel?: number | null;
  isListItem?: boolean | null;
}

export interface WordParagraphInfo {
  /** 0-based position in the document's paragraph list. */
  index: number;
  /** Offset of the paragraph's first character in the normalized body text. */
  offset: number;
  length: number;
  text: string;
  style: string;
  headingLevel: number | null;
  isListItem: boolean;
}

export interface WordPictureInfo {
  /** 0-based position among the body's inline pictures. */
  index: number;
  width: number | null;
  height: number | null;
  altText: string | null;
  /** Text of the paragraph the picture sits in (often its caption). */
  paragraphText: string;
  paragraphIndex: number | null;
}

export interface WordDocumentSnapshot {
  documentName: string | null;
  /** Normalized body text (LF line endings) — the `documentText` sent to the sidecar. */
  bodyText: string;
  paragraphs: WordParagraphInfo[];
  /** Inline pictures (metadata only; bytes are read on demand). */
  pictures?: WordPictureInfo[];
  changeTrackingMode: string | null;
  capturedAt: string;
}

export interface WordViewportState {
  from: number;
  to: number;
  pages: number[];
}

export interface WordFocusState {
  /** Non-collapsed selection, verbatim from the snapshot's body text. */
  selection: SelectionContext | null;
  /** Caret offset (selection start). */
  cursorOffset: number;
  cursorParagraphIndex: number | null;
  viewport: WordViewportState | null;
  capturedAt: string;
  /** True when Word's paragraphs no longer matched the snapshot — re-read the document. */
  stale: boolean;
}

export type FocusTrailEntry = WordHostContextFocusEntry;

export type RequestScope = "auto" | "selection" | "paragraph" | "viewport" | "document";

export interface ResolvedScope {
  scope: Exclude<RequestScope, "auto">;
  mode: "global" | "selection";
  selection: SelectionContext | null;
  label: string;
}

/** Word reports CR (and vertical tab for manual line breaks); the sidecar speaks LF. */
export function normalizeWordText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\v/g, "\n");
}

const HEADING_STYLE_PATTERN = /^(?:heading|überschrift|titre|título|titolo)\s*(\d)\b/i;

export function headingLevelFor(source: WordParagraphSource): number | null {
  const builtIn = source.styleBuiltIn ?? "";
  const builtInMatch = /^Heading(\d)$/.exec(builtIn);
  if (builtInMatch) {
    return Number(builtInMatch[1]);
  }
  if (builtIn === "Title") {
    return 1;
  }
  const styleMatch = HEADING_STYLE_PATTERN.exec(source.style ?? "");
  if (styleMatch) {
    return Number(styleMatch[1]);
  }
  if (/^title$/i.test(source.style ?? "")) {
    return 1;
  }
  // Outline level 1-9 marks heading-like paragraphs even with custom style names; 10 is body text.
  const outline = source.outlineLevel;
  if (typeof outline === "number" && Number.isInteger(outline) && outline >= 1 && outline <= 9 && !builtIn.startsWith("Normal")) {
    return outline;
  }
  return null;
}

/**
 * Assign each paragraph its offset in the body text. Paragraph texts are
 * located sequentially (Word's body text concatenates them in order), which
 * stays correct regardless of the separator Word uses between paragraphs,
 * table cells, or manual breaks.
 */
export function indexParagraphs(bodyText: string, sources: WordParagraphSource[]): WordParagraphInfo[] {
  const result: WordParagraphInfo[] = [];
  let cursor = 0;
  sources.forEach((source, index) => {
    const text = normalizeWordText(source.text ?? "");
    let offset = cursor;
    if (text.length) {
      const found = bodyText.indexOf(text, cursor);
      if (found >= 0) {
        offset = found;
        cursor = found + text.length;
      } else {
        const trimmed = text.trim();
        const foundTrimmed = trimmed ? bodyText.indexOf(trimmed, cursor) : -1;
        if (foundTrimmed >= 0) {
          offset = foundTrimmed;
          cursor = foundTrimmed + trimmed.length;
        }
      }
    }
    result.push({
      index,
      offset,
      length: text.length,
      text,
      style: source.style ?? "",
      headingLevel: headingLevelFor(source),
      isListItem: Boolean(source.isListItem)
    });
  });
  return result;
}

export interface ParagraphProbe {
  text: string;
  previousText?: string | null;
  nextText?: string | null;
}

/**
 * Find the snapshot paragraph an Office.js paragraph corresponds to. Texts
 * repeat (empty lines, "Rationale."), so neighbours disambiguate, then the
 * candidate nearest `near` wins. Returns null when nothing matches — the
 * snapshot is stale and should be re-read.
 */
export function locateParagraph(paragraphs: WordParagraphInfo[], probe: ParagraphProbe, options: { near?: number | null; minIndex?: number } = {}): number | null {
  const target = normalizeWordText(probe.text ?? "");
  const minIndex = options.minIndex ?? 0;
  let candidates = paragraphs.filter((paragraph) => paragraph.index >= minIndex && paragraph.text === target);
  if (!candidates.length) {
    const collapsed = collapseWhitespace(target);
    candidates = paragraphs.filter((paragraph) => paragraph.index >= minIndex && collapseWhitespace(paragraph.text) === collapsed);
  }
  if (!candidates.length) {
    return null;
  }
  if (candidates.length > 1) {
    const withNeighbours = candidates.filter((paragraph) => {
      const previousOk = probe.previousText === undefined || probe.previousText === null
        ? true
        : paragraph.index === 0
          ? probe.previousText === ""
          : paragraphs[paragraph.index - 1].text === normalizeWordText(probe.previousText);
      const nextOk = probe.nextText === undefined || probe.nextText === null
        ? true
        : paragraph.index === paragraphs.length - 1
          ? probe.nextText === ""
          : paragraphs[paragraph.index + 1].text === normalizeWordText(probe.nextText);
      return previousOk && nextOk;
    });
    if (withNeighbours.length) {
      candidates = withNeighbours;
    }
  }
  if (candidates.length === 1 || options.near === undefined || options.near === null) {
    return candidates[0].index;
  }
  const near = options.near;
  return candidates.reduce((best, paragraph) => (
    Math.abs(paragraph.index - near) < Math.abs(best.index - near) ? paragraph : best
  )).index;
}

export function paragraphAtOffset(paragraphs: WordParagraphInfo[], offset: number): WordParagraphInfo | null {
  if (!paragraphs.length) {
    return null;
  }
  let low = 0;
  let high = paragraphs.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (paragraphs[mid].offset <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return paragraphs[low];
}

const SENTENCE_BOUNDARY = /[.!?…]+["'”’)\]]*\s+/g;

/** The sentence of `text` that contains `offsetInText`. */
export function sentenceAt(text: string, offsetInText: number): string {
  const bounded = Math.max(0, Math.min(text.length, offsetInText));
  let start = 0;
  SENTENCE_BOUNDARY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_BOUNDARY.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (bounded < end) {
      return text.slice(start, end).trim();
    }
    start = end;
  }
  return text.slice(start).trim();
}

export function nearestHeading(paragraphs: WordParagraphInfo[], paragraphIndex: number): WordParagraphInfo | null {
  for (let index = Math.min(paragraphIndex, paragraphs.length - 1); index >= 0; index -= 1) {
    const paragraph = paragraphs[index];
    if (paragraph.headingLevel !== null && paragraph.text.trim()) {
      return paragraph;
    }
  }
  return null;
}

export function buildOutline(paragraphs: WordParagraphInfo[], limit = WORD_HOST_CONTEXT_LIMITS.outline): WordHostContextOutlineEntry[] {
  const outline: WordHostContextOutlineEntry[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.headingLevel === null || !paragraph.text.trim()) {
      continue;
    }
    outline.push({
      heading: excerpt(paragraph.text, WORD_HOST_CONTEXT_LIMITS.excerpt),
      level: paragraph.headingLevel,
      paragraphIndex: paragraph.index,
      offset: paragraph.offset
    });
    if (outline.length >= limit) {
      break;
    }
  }
  return outline;
}

export function excerpt(text: string, limit: number): string {
  const normalized = collapseWhitespace(text);
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const TRAIL_MIN_DWELL_MS = 1_200;
const TRAIL_PROBE_CHARS = 48;

/**
 * Drop trail entries whose text no longer exists (the author deleted or
 * rewrote it) and re-anchor the rest to the current snapshot. Without this a
 * stale excerpt of deleted text would ride along in the AI's briefing and
 * could be "restored" by a well-meaning edit.
 */
export function pruneFocusTrail(trail: FocusTrailEntry[], snapshot: WordDocumentSnapshot): FocusTrailEntry[] {
  const kept: FocusTrailEntry[] = [];
  for (const entry of trail) {
    const probe = entry.excerpt.replace(/…$/, "").slice(0, TRAIL_PROBE_CHARS).trim();
    if (!probe) {
      continue;
    }
    const near = snapshot.bodyText.indexOf(probe, Math.max(0, entry.offset - 2_000));
    const offset = near >= 0 && near <= entry.offset + 4_000 ? near : snapshot.bodyText.indexOf(probe);
    if (offset < 0) {
      continue;
    }
    const paragraph = paragraphAtOffset(snapshot.paragraphs, offset);
    if (!paragraph) {
      continue;
    }
    const heading = nearestHeading(snapshot.paragraphs, paragraph.index);
    kept.push({
      ...entry,
      offset: paragraph.offset,
      paragraphIndex: paragraph.index,
      excerpt: excerpt(paragraph.text, WORD_HOST_CONTEXT_LIMITS.excerpt),
      heading: heading && heading.index !== paragraph.index ? excerpt(heading.text, WORD_HOST_CONTEXT_LIMITS.excerpt) : null
    });
  }
  return kept;
}

/**
 * Keep a short trail of where the author paused. A paragraph counts once the
 * caret rested in it for a moment (so scrolling through with arrow keys does
 * not flood the trail); revisiting a paragraph moves it to the end.
 */
export function updateFocusTrail(trail: FocusTrailEntry[], focus: WordFocusState | null, snapshot: WordDocumentSnapshot | null, now = Date.now()): FocusTrailEntry[] {
  if (!focus || !snapshot || focus.cursorParagraphIndex === null) {
    return trail;
  }
  const paragraph = snapshot.paragraphs[focus.cursorParagraphIndex];
  if (!paragraph || !paragraph.text.trim()) {
    return trail;
  }
  const pruned = pruneFocusTrail(trail, snapshot);
  const last = pruned[pruned.length - 1];
  if (last && last.paragraphIndex === paragraph.index) {
    return pruned.length === trail.length ? trail : pruned;
  }
  let base = pruned;
  if (last && now - Date.parse(last.at) < TRAIL_MIN_DWELL_MS) {
    // The previous stop was a pass-through; replace it instead of stacking.
    base = trail.slice(0, -1);
  }
  const heading = nearestHeading(snapshot.paragraphs, paragraph.index);
  const entry: FocusTrailEntry = {
    offset: paragraph.offset,
    paragraphIndex: paragraph.index,
    excerpt: excerpt(paragraph.text, WORD_HOST_CONTEXT_LIMITS.excerpt),
    heading: heading && heading.index !== paragraph.index ? excerpt(heading.text, WORD_HOST_CONTEXT_LIMITS.excerpt) : null,
    at: new Date(now).toISOString()
  };
  return [...base.filter((item) => item.paragraphIndex !== paragraph.index), entry].slice(-WORD_HOST_CONTEXT_LIMITS.recentFocus);
}

export function buildHostContext(snapshot: WordDocumentSnapshot, focus: WordFocusState | null, trail: FocusTrailEntry[]): WordHostContext {
  const cursorParagraph = focus && focus.cursorParagraphIndex !== null ? snapshot.paragraphs[focus.cursorParagraphIndex] ?? null : null;
  const heading = cursorParagraph ? nearestHeading(snapshot.paragraphs, cursorParagraph.index) : null;
  const cursorOffset = focus?.cursorOffset ?? 0;
  const viewport = focus?.viewport ?? null;
  return {
    source: "word-addin",
    documentName: snapshot.documentName,
    capturedAt: focus?.capturedAt ?? snapshot.capturedAt,
    documentLength: snapshot.bodyText.length,
    paragraphCount: snapshot.paragraphs.length,
    selection: focus?.selection ?? null,
    cursor: focus
      ? {
        offset: cursorOffset,
        paragraphIndex: cursorParagraph?.index ?? null,
        paragraphText: cursorParagraph ? excerpt(cursorParagraph.text, WORD_HOST_CONTEXT_LIMITS.paragraphText) : null,
        sentence: cursorParagraph ? excerpt(sentenceAt(cursorParagraph.text, cursorOffset - cursorParagraph.offset), WORD_HOST_CONTEXT_LIMITS.sentence) : null
      }
      : null,
    section: heading
      ? { heading: excerpt(heading.text, WORD_HOST_CONTEXT_LIMITS.excerpt), level: heading.headingLevel, paragraphIndex: heading.index, offset: heading.offset }
      : null,
    viewport: viewport
      ? {
        from: viewport.from,
        to: viewport.to,
        pages: viewport.pages,
        leadingText: excerpt(snapshot.bodyText.slice(viewport.from, viewport.from + 400), WORD_HOST_CONTEXT_LIMITS.excerpt),
        trailingText: excerpt(snapshot.bodyText.slice(Math.max(viewport.from, viewport.to - 400), viewport.to), WORD_HOST_CONTEXT_LIMITS.excerpt)
      }
      : null,
    recentFocus: pruneFocusTrail(trail, snapshot).slice(-WORD_HOST_CONTEXT_LIMITS.recentFocus),
    outline: buildOutline(snapshot.paragraphs),
    changeTrackingMode: snapshot.changeTrackingMode,
    paragraphs: snapshot.paragraphs.slice(0, PARAGRAPH_PUSH_LIMIT).map((paragraph) => ({
      offset: paragraph.offset,
      length: paragraph.length,
      level: paragraph.headingLevel,
      style: paragraph.style ? paragraph.style.slice(0, 40) : null
    }))
  };
}

const PARAGRAPH_PUSH_LIMIT = 6_000;

const PARAGRAPH_SCOPE_MIN_CHARS = 40;

/** Turn the pane's scope picker into the request's mode/selection. */
export function resolveScope(scope: RequestScope, snapshot: WordDocumentSnapshot, focus: WordFocusState | null): ResolvedScope {
  const selection = focus?.selection ?? null;
  if (scope === "auto") {
    return selection ? resolveScope("selection", snapshot, focus) : resolveScope("document", snapshot, focus);
  }
  if (scope === "selection") {
    if (!selection) {
      return { scope: "document", mode: "global", selection: null, label: "Whole document (nothing selected)" };
    }
    return { scope, mode: "selection", selection, label: `Selection · ${wordCount(selection.text)} words` };
  }
  if (scope === "paragraph") {
    const paragraph = focus && focus.cursorParagraphIndex !== null ? snapshot.paragraphs[focus.cursorParagraphIndex] : null;
    if (!paragraph || paragraph.text.trim().length < PARAGRAPH_SCOPE_MIN_CHARS) {
      // Too little to anchor on; widen to the surrounding paragraphs.
      const window = paragraph ? paragraphWindow(snapshot, paragraph.index) : null;
      if (!window) {
        return { scope: "document", mode: "global", selection: null, label: "Whole document (no paragraph at the caret)" };
      }
      return { scope, mode: "selection", selection: window, label: `Around the caret · ${wordCount(window.text)} words` };
    }
    return {
      scope,
      mode: "selection",
      selection: { from: paragraph.offset, to: paragraph.offset + paragraph.length, text: paragraph.text },
      label: `This paragraph · ${wordCount(paragraph.text)} words`
    };
  }
  if (scope === "viewport") {
    const viewport = focus?.viewport;
    if (!viewport || viewport.to <= viewport.from) {
      return { scope: "document", mode: "global", selection: null, label: "Whole document (viewport unavailable)" };
    }
    const text = snapshot.bodyText.slice(viewport.from, viewport.to);
    return {
      scope,
      mode: "selection",
      selection: { from: viewport.from, to: viewport.to, text },
      label: `Visible page${viewport.pages.length === 1 ? "" : "s"} ${describePages(viewport.pages)} · ${wordCount(text)} words`
    };
  }
  return { scope: "document", mode: "global", selection: null, label: `Whole document · ${wordCount(snapshot.bodyText)} words` };
}

function paragraphWindow(snapshot: WordDocumentSnapshot, index: number): SelectionContext | null {
  const from = Math.max(0, index - 1);
  const to = Math.min(snapshot.paragraphs.length - 1, index + 1);
  const first = snapshot.paragraphs[from];
  const last = snapshot.paragraphs[to];
  if (!first || !last) {
    return null;
  }
  const start = first.offset;
  const end = last.offset + last.length;
  const text = snapshot.bodyText.slice(start, end);
  return text.trim() ? { from: start, to: end, text } : null;
}

export function describePages(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (!sorted.length) {
    return "";
  }
  if (sorted.length === 1) {
    return String(sorted[0]);
  }
  const contiguous = sorted.every((page, index) => index === 0 || page === sorted[index - 1] + 1);
  return contiguous ? `${sorted[0]}–${sorted[sorted.length - 1]}` : sorted.join(", ");
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Human summary of where the caret is, for the pane's context strip. */
export function describeFocus(snapshot: WordDocumentSnapshot | null, focus: WordFocusState | null): { heading: string | null; position: string; selection: string | null; viewport: string | null } {
  if (!snapshot || !focus) {
    return { heading: null, position: "Waiting for Word…", selection: null, viewport: null };
  }
  const paragraph = focus.cursorParagraphIndex !== null ? snapshot.paragraphs[focus.cursorParagraphIndex] ?? null : null;
  const heading = paragraph ? nearestHeading(snapshot.paragraphs, paragraph.index) : null;
  return {
    heading: heading ? excerpt(heading.text, 80) : null,
    position: paragraph
      ? `Paragraph ${paragraph.index + 1} of ${snapshot.paragraphs.length}`
      : `Offset ${focus.cursorOffset.toLocaleString()} of ${snapshot.bodyText.length.toLocaleString()}`,
    selection: focus.selection ? `${wordCount(focus.selection.text)} words selected` : null,
    viewport: focus.viewport && focus.viewport.pages.length ? `Viewing page${focus.viewport.pages.length === 1 ? "" : "s"} ${describePages(focus.viewport.pages)}` : null
  };
}
