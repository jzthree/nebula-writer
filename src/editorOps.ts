import type { Editor } from "@tiptap/react";
import type { AiSuggestion, SelectionContext, SourceTrackedChangePreview } from "./shared";
import { suggestingRouterKey } from "./suggesting";

type SuggestionRange = { from: number; to: number };
type TextRangePosition = { from: number; to: number };

export type SuggestionMatchKind =
  | "exact"      // stored range still holds the original text
  | "in-range"   // found inside the originally selected region
  | "nearby"     // stored range went stale; closest match is near the original anchor
  | "relocated"  // stored range went stale; only match is far from the original anchor
  | "unique"     // no stored anchor; the text appears exactly once
  | "ambiguous"; // no stored anchor; the text appears in several places

export type SuggestionMatch = { from: number; to: number; matchKind: SuggestionMatchKind };

export type ApplySuggestionResult =
  | { ok: true; matchKind: SuggestionMatchKind; range: SuggestionRange }
  | { ok: false; reason: "missing" | "needs-confirmation"; matchKind?: SuggestionMatchKind; range?: SuggestionRange };

// How far (in document positions) a fallback match may drift from the original
// anchor before accepting it requires explicit user confirmation.
const RELOCATED_MATCH_DISTANCE = 2000;
type SearchableSegment = { isText: boolean; text: string; from: number; to: number };
type SearchableNode = {
  attrs?: Record<string, unknown>;
  isAtom?: boolean;
  isInline?: boolean;
  isText?: boolean;
  nodeSize?: number;
  text?: string;
  textContent?: string;
};

interface SuggestionRangeCacheEntry {
  key: string;
  match: SuggestionMatch | null;
}

const suggestionRangeCache = new WeakMap<object, Map<string, SuggestionRangeCacheEntry>>();

export function getSelectionContext(editor: Editor | null): SelectionContext | null {
  if (!editor) {
    return null;
  }
  const { from, to, empty } = editor.state.selection;
  if (empty || from === to) {
    return null;
  }
  const text = editor.state.doc.textBetween(from, to, "\n");
  return text.trim() ? { from, to, text } : null;
}

/** The Nth image node in the document (0-based), in document order. */
function findImageNode(editor: Editor, index: number): { pos: number; nodeSize: number; attrs: Record<string, unknown> } | null {
  let count = 0;
  let found: { pos: number; nodeSize: number; attrs: Record<string, unknown> } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) {
      return false;
    }
    if (node.type.name === "image") {
      if (count === index) {
        found = { pos, nodeSize: node.nodeSize, attrs: { ...node.attrs } };
        return false;
      }
      count += 1;
    }
    return true;
  });
  return found;
}

export function applySuggestion(
  editor: Editor,
  suggestion: AiSuggestion,
  options: { confirmRelocated?: boolean } = {}
): ApplySuggestionResult {
  if (suggestion.kind === "image" && suggestion.image) {
    // A picture swap: point the Nth image node at the replacement file.
    const target = findImageNode(editor, suggestion.image.index);
    if (!target) {
      return { ok: false, reason: "missing" };
    }
    const src = suggestion.image.url;
    editor.chain().focus().command(({ tr }) => {
      tr.setNodeMarkup(target.pos, undefined, { ...target.attrs, src });
      return true;
    }).run();
    return { ok: true, matchKind: "exact", range: { from: target.pos, to: target.pos + target.nodeSize } };
  }
  const match = findSuggestionMatch(editor, suggestion);
  if (!match) {
    return { ok: false, reason: "missing" };
  }
  const range = { from: match.from, to: match.to };
  if ((match.matchKind === "relocated" || match.matchKind === "ambiguous") && !options.confirmRelocated) {
    return { ok: false, reason: "needs-confirmation", matchKind: match.matchKind, range };
  }
  editor.chain().focus().insertContentAt(range, replacementToContent(suggestion.replacement)).run();
  return { ok: true, matchKind: match.matchKind, range };
}

export function selectSuggestionTarget(editor: Editor, suggestion: AiSuggestion): { from: number; to: number } | null {
  const centeredExistingTrace = centerSuggestionTarget(editor, suggestion, null);
  const range = findSuggestionRange(editor, suggestion);
  if (!range) {
    return null;
  }
  editor.chain().focus().setTextSelection(range).run();
  if (!centeredExistingTrace) {
    centerEditorRange(editor, range);
  }
  return range;
}

export function centerSuggestionTarget(editor: Editor, suggestion: AiSuggestion, range?: { from: number; to: number } | null): boolean {
  const traceTarget = findVisibleReviewTraceElement(editor, suggestion.id);
  if (traceTarget) {
    centerEditorElement(editor, traceTarget);
    return true;
  }

  const highlightTarget = findVisibleEditorElement(editor, ".review-target-highlight");
  if (highlightTarget) {
    centerEditorElement(editor, highlightTarget);
    return true;
  }

  return range ? centerEditorRange(editor, range) : false;
}

export function findSuggestionRange(editor: Editor, suggestion: AiSuggestion): { from: number; to: number } | null {
  const match = findSuggestionMatch(editor, suggestion);
  return match ? { from: match.from, to: match.to } : null;
}

export function findSuggestionMatch(editor: Editor, suggestion: AiSuggestion): SuggestionMatch | null {
  if (suggestion.kind === "image" && suggestion.image) {
    const target = findImageNode(editor, suggestion.image.index);
    return target ? { from: target.pos, to: target.pos + target.nodeSize, matchKind: "exact" } : null;
  }
  const cache = rangeCacheForEditor(editor);
  const key = suggestionRangeCacheKey(suggestion);
  const cached = cache.get(suggestion.id);
  if (cached?.key === key) {
    return cached.match ? { ...cached.match } : null;
  }

  const match = findSuggestionMatchUncached(editor, suggestion);
  cache.set(suggestion.id, { key, match: match ? { ...match } : null });
  return match;
}

export function primeSuggestionRangeCache(editor: Editor, suggestions: AiSuggestion[]): void {
  suggestions.forEach((suggestion) => {
    findSuggestionRange(editor, suggestion);
  });
}

function findSuggestionMatchUncached(editor: Editor, suggestion: AiSuggestion): SuggestionMatch | null {
  const storedRange = suggestion.range && suggestion.range.from < suggestion.range.to ? suggestion.range : null;
  if (storedRange) {
    const selectedNow = textBetweenIfValid(editor, storedRange.from, storedRange.to);
    if (selectedNow !== null && normalizeText(selectedNow) === normalizeText(suggestion.original)) {
      return { from: storedRange.from, to: storedRange.to, matchKind: "exact" };
    }

    if (selectedNow !== null) {
      const expectedPosition = expectedOriginalPosition(suggestion);
      const rangeWithinSelection = findTextRange(editor, suggestion.original, storedRange, expectedPosition);
      if (rangeWithinSelection) {
        return { ...rangeWithinSelection, matchKind: "in-range" };
      }
    }
  }

  const matches = findAllTextRanges(editor, suggestion.original);
  if (!matches.length) {
    return null;
  }

  if (storedRange) {
    const anchor = expectedOriginalPosition(suggestion) ?? storedRange.from;
    const closest = matches.reduce((best, candidate) => (
      Math.abs(candidate.from - anchor) < Math.abs(best.from - anchor) ? candidate : best
    ), matches[0]);
    const matchKind: SuggestionMatchKind = Math.abs(closest.from - anchor) <= RELOCATED_MATCH_DISTANCE ? "nearby" : "relocated";
    return { ...closest, matchKind };
  }

  return { ...matches[0], matchKind: matches.length === 1 ? "unique" : "ambiguous" };
}

function rangeCacheForEditor(editor: Editor): Map<string, SuggestionRangeCacheEntry> {
  const docKey = editor.state.doc as object;
  const existing = suggestionRangeCache.get(docKey);
  if (existing) {
    return existing;
  }
  const cache = new Map<string, SuggestionRangeCacheEntry>();
  suggestionRangeCache.set(docKey, cache);
  return cache;
}

function suggestionRangeCacheKey(suggestion: AiSuggestion): string {
  const range = suggestion.range;
  return [
    normalizeText(suggestion.original),
    range?.from ?? "",
    range?.to ?? "",
    range ? normalizeText(range.text) : ""
  ].join("\u0000");
}

export function findTextRange(editor: Editor, query: string, bounds?: { from: number; to: number }, preferredFrom?: number): { from: number; to: number } | null {
  const ranges = findAllTextRanges(editor, query, bounds);
  if (!ranges.length) {
    return null;
  }

  if (preferredFrom === undefined || !Number.isFinite(preferredFrom)) {
    return ranges[0];
  }

  return ranges.reduce((best, candidate) => (
    Math.abs(candidate.from - preferredFrom) < Math.abs(best.from - preferredFrom) ? candidate : best
  ), ranges[0]);
}

export function findAllTextRanges(editor: Editor, query: string, bounds?: { from: number; to: number }): Array<{ from: number; to: number }> {
  const needle = normalizeText(query);
  if (!needle) {
    return [];
  }

  const textNodes: SearchableSegment[] = [];
  editor.state.doc.descendants((node, pos) => {
    const segment = searchableSegmentForNode(node as SearchableNode, pos);
    if (segment) {
      textNodes.push(segment);
    }
  });

  const normalized = normalizeTextWithPositions(textNodes, bounds);
  const ranges: Array<{ from: number; to: number }> = [];
  let index = normalized.text.indexOf(needle);
  while (index >= 0) {
    const firstPosition = normalized.positions[index];
    const lastPosition = normalized.positions[index + needle.length - 1];
    if (firstPosition && lastPosition && lastPosition.to > firstPosition.from) {
      ranges.push({ from: firstPosition.from, to: lastPosition.to });
    }
    index = normalized.text.indexOf(needle, index + Math.max(1, needle.length));
  }

  return ranges;
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// Take whole words from the end of `text` (bounded by the current sentence)
// until the context is distinctive enough to anchor an edit in the source DOCX.
export function trailingAnchorContext(text: string): string {
  let sentenceBoundary = -1;
  for (const match of text.matchAll(/[.!?]/g)) {
    sentenceBoundary = match.index ?? sentenceBoundary;
  }
  let scope = text.slice(sentenceBoundary + 1);
  if (!scope.trim()) {
    // The anchor point sits right after a sentence end ("…text. |") — anchor
    // on the previous sentence rather than empty air, or a pure insertion
    // there gets an all-whitespace original and its card is filtered out.
    scope = text;
  }
  const words = scope.split(/(\s+)/);
  let context = "";
  for (let index = words.length - 1; index >= 0 && context.trim().length < 16; index -= 1) {
    context = words[index] + context;
  }
  return context;
}

// Take whole words from the start of `text` (through the end of the current
// sentence at most) until the context is distinctive enough.
export function leadingAnchorContext(text: string): string {
  const sentenceEnd = /[.!?]/.exec(text);
  let scope = sentenceEnd ? text.slice(0, (sentenceEnd.index ?? 0) + 1) : text;
  if (!scope.trim()) {
    scope = text;
  }
  const words = scope.split(/(\s+)/);
  let context = "";
  for (let index = 0; index < words.length && context.trim().length < 16; index += 1) {
    context += words[index];
  }
  return context;
}

/**
 * Read the document's inline suggestion marks (Suggesting-mode edits by humans
 * or agents) and convert each cluster of marked text into an exportable
 * suggestion: deletion-marked text is proposed for removal, insertion-marked
 * text for insertion, both anchored with surrounding source text and
 * attributed to the mark's author. This is what carries Suggesting-mode edits
 * into the Word review export.
 */
export function suggestionsFromSuggestionMarks(editor: Editor): AiSuggestion[] {
  interface MarkAtom {
    authorName: string | null;
    changeId: string | null;
    from: number;
    to: number;
    text: string;
    kind: "insertion" | "deletion";
  }
  interface ClusterRecord {
    authorName: string | null;
    changeIds: string[];
    regionSource: string;
    regionTarget: string;
    contextBefore: string;
    contextAfter: string;
    from: number;
    to: number;
  }
  const records: ClusterRecord[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) {
      return true;
    }
    // One atom per suggestion MARK, not per text node: two agents proposing
    // against the same sentence stack a deletion mark each on the original,
    // and collapsing them to "first mark wins" mislabels one author's card
    // and makes the other's marks unresolvable.
    const atoms: MarkAtom[] = [];
    const plainRuns: Array<{ from: number; to: number; text: string }> = [];
    node.forEach((child, offset) => {
      if (!child.isText || !child.text) {
        return;
      }
      const from = pos + 1 + offset;
      const marks = child.marks.filter((mark) => mark.type.name === "suggestionDeletion" || mark.type.name === "suggestionInsertion");
      if (!marks.length) {
        plainRuns.push({ from, to: from + child.text.length, text: child.text });
        return;
      }
      for (const mark of marks) {
        atoms.push({
          authorName: (mark.attrs.authorName as string | undefined) || null,
          changeId: (mark.attrs.changeId as string | undefined) || null,
          from,
          to: from + child.text.length,
          text: child.text,
          kind: mark.type.name === "suggestionDeletion" ? "deletion" : "insertion"
        });
      }
    });
    if (!atoms.length) {
      return false;
    }

    // Cluster per author: an author's touching atoms form one proposal even
    // when another author's marks overlap or sit between them.
    const byAuthor = new Map<string, MarkAtom[]>();
    for (const atom of atoms) {
      const key = atom.authorName ?? "";
      const list = byAuthor.get(key) ?? [];
      list.push(atom);
      byAuthor.set(key, list);
    }
    // Source text of the block: everything that is not insertion-marked,
    // regardless of author — that is what the original document contains.
    const insertionSpans = atoms.filter((atom) => atom.kind === "insertion");
    const isInsertedAt = (from: number, to: number) => insertionSpans.some((span) => span.from <= from && span.to >= to);
    // A gap made entirely of insertion-marked text doesn't split a cluster:
    // in a two-agent duel, agent B's inserted replacement sits between agent
    // A's strike and A's own insertion — A's card must still be one proposal.
    const gapIsInsertions = (from: number, to: number): boolean => {
      let cursor = from;
      const spans = [...insertionSpans].sort((a, b) => a.from - b.from);
      for (const span of spans) {
        if (span.to <= cursor) {
          continue;
        }
        if (span.from > cursor) {
          return false;
        }
        cursor = span.to;
        if (cursor >= to) {
          return true;
        }
      }
      return cursor >= to;
    };

    for (const [, authorAtoms] of byAuthor) {
      authorAtoms.sort((a, b) => a.from - b.from);
      let index = 0;
      while (index < authorAtoms.length) {
        let end = index;
        while (
          end + 1 < authorAtoms.length
          && (authorAtoms[end + 1].from <= authorAtoms[end].to
            || gapIsInsertions(authorAtoms[end].to, authorAtoms[end + 1].from))
        ) {
          end += 1;
        }
        const cluster = authorAtoms.slice(index, end + 1);
        const clusterFrom = cluster[0].from;
        const clusterTo = cluster[cluster.length - 1].to;
        const regionSource = cluster.filter((atom) => atom.kind === "deletion").map((atom) => atom.text).join("");
        const regionTarget = cluster.filter((atom) => atom.kind === "insertion").map((atom) => atom.text).join("");
        // Anchor context: source-side text around the cluster (plain runs plus
        // any deletion-marked text outside it — that text exists in the source).
        const sourcePieces = [
          ...plainRuns,
          ...atoms.filter((atom) => atom.kind === "deletion" && !isInsertedAt(atom.from, atom.to))
        ].sort((a, b) => a.from - b.from);
        const seen = new Set<number>();
        let sourceBefore = "";
        let sourceAfter = "";
        for (const piece of sourcePieces) {
          if (seen.has(piece.from)) {
            continue;
          }
          seen.add(piece.from);
          if (piece.to <= clusterFrom) {
            sourceBefore += piece.text;
          } else if (piece.from >= clusterTo) {
            sourceAfter += piece.text;
          }
        }
        records.push({
          authorName: cluster.find((atom) => atom.authorName)?.authorName ?? null,
          changeIds: [...new Set(cluster.map((atom) => atom.changeId).filter((id): id is string => Boolean(id)))],
          regionSource,
          regionTarget,
          contextBefore: trailingAnchorContext(sourceBefore),
          contextAfter: leadingAnchorContext(sourceAfter),
          from: clusterFrom,
          to: clusterTo
        });
        index = end + 1;
      }
    }
    return false;
  });

  // A structural proposal is ONE changeId whose marks span several blocks (a
  // strike in one paragraph, inserted paragraphs after it). Per-block records
  // would surface it as fragments — a strike card with no visible replacement
  // plus insertion clusters whose empty originals get filtered — so merge
  // same-author records that share a changeId into one card.
  const merged: ClusterRecord[] = [];
  for (const record of records.sort((a, b) => a.from - b.from)) {
    const target = merged.find((candidate) => candidate.authorName === record.authorName
      && candidate.changeIds.some((id) => record.changeIds.includes(id)));
    if (!target) {
      merged.push({ ...record, changeIds: [...record.changeIds] });
      continue;
    }
    target.regionSource = [target.regionSource, record.regionSource].filter(Boolean).join("\n");
    target.regionTarget = [target.regionTarget, record.regionTarget].filter(Boolean).join("\n");
    target.contextAfter = record.contextAfter;
    target.from = Math.min(target.from, record.from);
    target.to = Math.max(target.to, record.to);
    for (const id of record.changeIds) {
      if (!target.changeIds.includes(id)) {
        target.changeIds.push(id);
      }
    }
  }

  const suggestions: AiSuggestion[] = [];
  for (const record of merged) {
    const original = `${record.contextBefore}${record.regionSource}${record.contextAfter}`;
    const replacement = `${record.contextBefore}${record.regionTarget}${record.contextAfter}`;
    const changeId = record.changeIds[0] ?? `mark-${record.from}`;
    const kind = record.regionSource && record.regionTarget ? "replacement" : record.regionSource ? "deletion" : "insertion";
    if (original.trim() && normalizeText(original) !== normalizeText(replacement)) {
      suggestions.push({
        id: `${changeId}-mark-export`,
        title: `Suggested ${kind}${record.authorName ? ` by ${record.authorName}` : ""}`,
        original,
        replacement,
        rationale: "Inline suggestion captured from the document's suggestion marks.",
        confidence: 1,
        target: "global",
        range: {
          from: record.from,
          to: record.to,
          text: original
        },
        markChangeIds: record.changeIds,
        status: "pending",
        proposedBy: record.authorName
      });
    }
  }
  return suggestions;
}

export function replacementToContent(value: string): string {
  if (!value.includes("\n")) {
    return escapeHtml(value);
  }
  const paragraphs = value
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return paragraphs.length
    ? paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")
    : "<p></p>";
}

function searchableSegmentForNode(node: SearchableNode, pos: number): SearchableSegment | null {
  if (node.isText && node.text) {
    return { isText: true, text: node.text, from: pos, to: pos + node.text.length };
  }

  if (!node.isInline || !node.isAtom) {
    return null;
  }

  const text = inlineAtomPreviewText(node);
  if (!text) {
    return null;
  }

  return { isText: false, text, from: pos, to: pos + Math.max(1, node.nodeSize ?? 1) };
}

function inlineAtomPreviewText(node: SearchableNode): string {
  const attrText = typeof node.attrs?.text === "string" ? node.attrs.text : "";
  if (attrText.trim()) {
    return attrText;
  }
  const textContent = typeof node.textContent === "string" ? node.textContent : "";
  return textContent.trim() ? textContent : "";
}

function normalizeTextWithPositions(textNodes: SearchableSegment[], bounds?: { from: number; to: number }): { text: string; positions: TextRangePosition[] } {
  let text = "";
  const positions: TextRangePosition[] = [];
  let previousSegmentTo: number | null = null;

  for (const node of textNodes) {
    if (bounds && (node.to <= bounds.from || node.from >= bounds.to)) {
      continue;
    }
    if (previousSegmentTo !== null && node.from > previousSegmentTo && text && !text.endsWith(" ")) {
      text += " ";
      positions.push({ from: previousSegmentTo, to: node.from });
    }
    previousSegmentTo = node.to;

    for (let index = 0; index < node.text.length; index += 1) {
      const char = node.text[index];
      const sourcePosition = node.from + Math.min(index, Math.max(0, node.to - node.from - 1));
      if (bounds && (node.to <= bounds.from || sourcePosition >= bounds.to)) {
        continue;
      }
      if (/\s/.test(char)) {
        if (text && !text.endsWith(" ")) {
          text += " ";
          positions.push({ from: sourcePosition, to: Math.min(node.to, sourcePosition + 1) });
        }
      } else {
        text += char;
        positions.push({
          from: sourcePosition,
          to: node.isText ? sourcePosition + 1 : node.to
        });
      }
    }
  }

  while (text.startsWith(" ")) {
    text = text.slice(1);
    positions.shift();
  }
  while (text.endsWith(" ")) {
    text = text.slice(0, -1);
    positions.pop();
  }

  return { text, positions };
}

function expectedOriginalPosition(suggestion: AiSuggestion): number | undefined {
  if (!suggestion.range?.text) {
    return undefined;
  }
  const normalizedRange = normalizeStringWithPositions(suggestion.range.text);
  const index = normalizedRange.text.indexOf(normalizeText(suggestion.original));
  const sourceOffset = index >= 0 ? normalizedRange.positions[index] : undefined;
  return sourceOffset === undefined ? undefined : suggestion.range.from + sourceOffset;
}

function normalizeStringWithPositions(value: string): { text: string; positions: number[] } {
  let text = "";
  const positions: number[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (/\s/.test(char)) {
      if (text && !text.endsWith(" ")) {
        text += " ";
        positions.push(index);
      }
    } else {
      text += char;
      positions.push(index);
    }
  }

  while (text.startsWith(" ")) {
    text = text.slice(1);
    positions.shift();
  }
  while (text.endsWith(" ")) {
    text = text.slice(0, -1);
    positions.pop();
  }

  return { text, positions };
}

function textBetweenIfValid(editor: Editor, from: number, to: number): string | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) {
    return null;
  }

  const docSize = editor.state.doc.content?.size;
  if (typeof docSize === "number" && (from > docSize || to > docSize)) {
    return null;
  }

  try {
    return editor.state.doc.textBetween(from, to, "\n");
  } catch {
    return null;
  }
}

export function centerEditorRange(editor: Editor, range: { from: number; to: number }): boolean {
  const view = editor.view;
  const dom = view?.dom;
  if (!view || !(dom instanceof HTMLElement) || typeof view.coordsAtPos !== "function") {
    return false;
  }

  try {
    const fromCoords = view.coordsAtPos(range.from);
    const toCoords = view.coordsAtPos(Math.max(range.from, range.to - 1));
    const targetCenter = (fromCoords.top + toCoords.bottom) / 2;
    const scrollTarget = findEditorScrollTarget(dom);
    scrollTargetToCenteredViewport(scrollTarget, targetCenter);
    return true;
  } catch {
    // Some browser/test environments cannot resolve coordinates for a ProseMirror position.
    return false;
  }
}

function centerEditorElement(editor: Editor, element: HTMLElement): void {
  const dom = editor.view?.dom;
  if (!(dom instanceof HTMLElement)) {
    return;
  }
  const rect = element.getBoundingClientRect();
  const scrollTarget = findEditorScrollTarget(dom);
  scrollTargetToCenteredViewport(scrollTarget, (rect.top + rect.bottom) / 2);
}

function findVisibleReviewTraceElement(editor: Editor, id: string): HTMLElement | null {
  const dom = editor.view?.dom;
  if (!(dom instanceof HTMLElement)) {
    return null;
  }
  const matches = Array.from(dom.querySelectorAll<HTMLElement>("[data-review-trace]"))
    .filter((element) => element.dataset.reviewTrace === id && hasVisibleBox(element));
  return matches.find((element) => element.classList.contains("review-trace-active"))
    ?? matches.find((element) => element.classList.contains("review-trace-preview-widget"))
    ?? matches[0]
    ?? null;
}

function findVisibleEditorElement(editor: Editor, selector: string): HTMLElement | null {
  const dom = editor.view?.dom;
  if (!(dom instanceof HTMLElement)) {
    return null;
  }
  return Array.from(dom.querySelectorAll<HTMLElement>(selector)).find(hasVisibleBox) ?? null;
}

function hasVisibleBox(element: HTMLElement): boolean {
  return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
}

function findEditorScrollTarget(dom: HTMLElement): HTMLElement {
  const editorShell = dom.closest<HTMLElement>(".editor-content-shell");
  if (editorShell && isScrollable(editorShell)) {
    return editorShell;
  }

  let current: HTMLElement | null = dom.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    if (isScrollable(current)) {
      return current;
    }
    current = current.parentElement;
  }

  return (document.scrollingElement instanceof HTMLElement ? document.scrollingElement : document.documentElement);
}

function isScrollable(element: HTMLElement): boolean {
  return element.scrollHeight > element.clientHeight + 1;
}

function scrollTargetToCenteredViewport(scrollTarget: HTMLElement, targetCenter: number) {
  const isDocumentScroller = scrollTarget === document.scrollingElement || scrollTarget === document.documentElement || scrollTarget === document.body;
  const viewportTop = isDocumentScroller ? 0 : scrollTarget.getBoundingClientRect().top;
  const viewportHeight = isDocumentScroller ? window.innerHeight : scrollTarget.clientHeight;
  if (!viewportHeight) {
    return;
  }
  const maxScrollTop = Math.max(0, scrollTarget.scrollHeight - viewportHeight);
  const targetOffset = targetCenter - viewportTop;
  const nextScrollTop = Math.min(
    maxScrollTop,
    Math.max(0, scrollTarget.scrollTop + targetOffset - viewportHeight / 2)
  );

  if (typeof scrollTarget.scrollTo === "function") {
    scrollTarget.scrollTo({ top: nextScrollTop, behavior: "auto" });
    return;
  }
  scrollTarget.scrollTop = nextScrollTop;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}


/**
 * Word context snippets can straddle block boundaries or carry heading text
 * that the imported HTML renders separately — retry with progressively
 * shorter TAILS of the context, which stay within one block and are what
 * actually neighbors the revision.
 */
function findContextAnchor(editor: Editor, context: string): { from: number; to: number } | null {
  const full = context.trim();
  for (const length of [full.length, 32, 16, 8]) {
    const tail = full.slice(-length).trim();
    if (tail.length < 4) {
      break;
    }
    const range = findTextRange(editor, tail);
    if (range) {
      return range;
    }
  }
  return null;
}

/** Distinct-but-stable colors for imported Word revision authors. */
const IMPORT_AUTHOR_PALETTE = ["#c2185b", "#00838f", "#5d4037", "#6a1b9a", "#2e7d32", "#ef6c00"];

function importAuthorColor(author: string): string {
  let hash = 0;
  for (let index = 0; index < author.length; index += 1) {
    hash = (hash * 31 + author.charCodeAt(index)) >>> 0;
  }
  return IMPORT_AUTHOR_PALETTE[hash % IMPORT_AUTHOR_PALETTE.length];
}

/**
 * Phase 3 (docs/suggesting-mode.md): bring a DOCX's tracked changes in AS
 * suggestion marks, so Word revisions arrive as real, actionable suggestions
 * instead of read-only previews. The imported HTML shows the ACCEPTED view, so
 * an "inserted" revision's text is present (wrap it with an insertion mark:
 * accept keeps it, reject removes it — Word's semantics preserved) and a
 * "deleted" revision's text is absent (re-insert it struck through after its
 * context anchor: accept removes, reject restores). Anchoring is heuristic
 * (Word context snippets), so unlocatable revisions are skipped and counted —
 * they remain visible in the source-revision preview pane. Moved text is
 * skipped in v1 (it arrives as its insert/delete halves elsewhere in the
 * list). Returns how many revisions were materialized.
 */
export function materializeSourceTrackedChanges(
  editor: Editor,
  previews: SourceTrackedChangePreview[]
): { materialized: number; remaining: SourceTrackedChangePreview[] } {
  const insertionType = editor.state.schema.marks.suggestionInsertion;
  const deletionType = editor.state.schema.marks.suggestionDeletion;
  if (!insertionType || !deletionType || !previews.length) {
    return { materialized: 0, remaining: previews };
  }
  let materialized = 0;
  const remaining: SourceTrackedChangePreview[] = [];
  // Insertions first: their text exists in the accepted view and must be
  // matched BEFORE deletions re-insert struck copies of similar text (a
  // reorder's insertion would otherwise mark the struck copy). Deletions
  // then go in reverse source order so several anchoring at the same point
  // (e.g. consecutive struck paragraphs at the document start) come out in
  // source order.
  const ordered = [
    ...previews.filter((preview) => preview.kind === "inserted"),
    ...previews.filter((preview) => preview.kind === "deleted").reverse(),
    ...previews.filter((preview) => preview.kind !== "inserted" && preview.kind !== "deleted")
  ];
  for (const preview of ordered) {
    if (preview.kind !== "inserted" && preview.kind !== "deleted") {
      remaining.push(preview);
      continue;
    }
    const text = preview.text.trim();
    if (text.length < 2) {
      remaining.push(preview);
      continue;
    }
    const authorName = preview.author?.trim() || "Word revision";
    const attrs = {
      changeId: `sug-import-${materialized}-${Math.floor(Math.random() * 1e9).toString(36)}`,
      author: `import-${authorName}`,
      authorName,
      role: "human" as const,
      color: importAuthorColor(authorName),
      createdAt: preview.date ?? new Date().toISOString()
    };
    const contextRange = preview.contextBefore ? findContextAnchor(editor, preview.contextBefore) : null;
    if (preview.kind === "inserted") {
      const range = findTextRange(editor, text, undefined, contextRange?.to);
      if (!range) {
        remaining.push(preview);
        continue;
      }
      const tr = editor.state.tr;
      tr.setMeta(suggestingRouterKey, true);
      tr.addMark(range.from, range.to, insertionType.create(attrs));
      editor.view.dispatch(tr);
      materialized += 1;
      continue;
    }
    // Deleted: the text is gone from the accepted view — re-insert it struck
    // through right after its context anchor. No contextBefore at all means
    // nothing in the accepted view precedes the deletion (a struck FIRST
    // paragraph), so the document start is the correct placement. A context
    // that exists but can't be found stays unplaced (preview pane).
    if (!contextRange && preview.contextBefore) {
      remaining.push(preview);
      continue;
    }
    const tr = editor.state.tr;
    tr.setMeta(suggestingRouterKey, true);
    // Re-insert the RAW deleted run (only newlines flattened): Word deleted
    // runs carry their boundary spaces, and trimming them would glue the
    // struck text to its neighbors.
    tr.insert(contextRange?.to ?? 1, editor.state.schema.text(preview.text.replace(/\s*\n+\s*/g, " "), [deletionType.create(attrs)]));
    editor.view.dispatch(tr);
    materialized += 1;
  }
  return { materialized, remaining };
}
