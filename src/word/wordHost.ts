/**
 * Office.js facade for the Nebula Writer Word task pane.
 *
 * Everything that touches `Office` / `Word` lives here: host detection and
 * capabilities, the document snapshot (body text + paragraph index), the
 * cheap "focus" read (selection, caret, pages on screen), selection and
 * paragraph-change subscriptions, and the three document actions — locate a
 * suggestion, apply it as a tracked change, or leave it as a Word comment.
 *
 * Offsets never come from Word directly; see wordContext.ts for how paragraph
 * texts are mapped onto one normalized body text.
 */

/// <reference types="office-js" />

import { wordDiffSegments } from "../wordDiff";

import { chooseAnchoredCandidate, type SuggestionAnchor } from "../shared";
import type { AiSuggestion, SelectionContext } from "../shared";
import {
  collapseWhitespace,
  excerpt,
  indexParagraphs,
  locateParagraph,
  normalizeWordText,
  type WordDocumentSnapshot,
  type WordFocusState,
  type WordParagraphInfo,
  type WordViewportState, type WordPictureInfo } from "./wordContext";

export interface WordCapabilities {
  /** Running inside Microsoft Word (not a plain browser). */
  host: boolean;
  /** WordApi 1.4: insertComment. */
  comments: boolean;
  /** WordApi 1.4: changeTrackingMode. */
  trackChanges: boolean;
  /** WordApi 1.3: styleBuiltIn on paragraphs. */
  paragraphStyles: boolean;
  /** WordApi 1.6: onParagraphChanged / Added / Deleted. */
  paragraphEvents: boolean;
  /** WordApiDesktop 1.2: activeWindow.activePane.pagesEnclosingViewport. */
  viewport: boolean;
  /** DocumentEvents 1.1: DocumentSelectionChanged. */
  selectionEvents: boolean;
  platform: string | null;
  officeVersion: string | null;
}

export interface WordHostBoot {
  ready: boolean;
  detail: string;
  capabilities: WordCapabilities;
}

export interface SuggestionMatch {
  /** 0-based index among the matches Word found. */
  index: number;
  /** Approximate offset in the snapshot body text, null if the paragraph could not be located. */
  offset: number | null;
  paragraphIndex: number | null;
  preview: string;
  /** Text around the match (previous paragraph + the paragraph up to the match / the rest of the paragraph + the next one), for placement anchors. */
  contextBefore: string;
  contextAfter: string;
}

export interface SuggestionMatchSet {
  matches: SuggestionMatch[];
  /** How the text was found: a single Word search or a head/tail pair for long anchors. */
  strategy: "search" | "head-tail" | "none";
}

export interface ApplyOptions {
  matchIndex: number;
  /** "always": force tracked changes on for this edit; "word": follow Word's current setting. */
  trackChanges: "always" | "word";
}

export interface ApplyResult {
  trackedChange: boolean;
  matches: number;
  matchIndex: number;
  /**
   * "words": only the changed words were deleted/inserted, so the formatting
   * of everything else in the passage (bold, italics, superscripts, links,
   * citation fields) survived. "paragraphs": applied piece by piece inside
   * each paragraph (marks and styles untouched). "range": the whole passage
   * was replaced (near-total rewrites).
   */
  strategy: "range" | "paragraphs" | "words";
}

const WORD_SEARCH_MAX_CHARS = 250;
const ANCHOR_EDGE_CHARS = 120;
const ANCHOR_MIN_CHARS = 24;
const MULTI_PARAGRAPH_ANCHOR_MIN_CHARS = 8;
const MATCH_PREVIEW_CHARS = 90;

/* ------------------------------------------------------------------------- */
/* Host detection                                                            */
/* ------------------------------------------------------------------------- */

function officeGlobal(): typeof Office | null {
  return typeof Office !== "undefined" && Office ? Office : null;
}

function wordGlobal(): typeof Word | null {
  return typeof Word !== "undefined" && Word && typeof Word.run === "function" ? Word : null;
}

function isSetSupported(name: string, version: string): boolean {
  try {
    return Boolean(officeGlobal()?.context?.requirements?.isSetSupported(name, version));
  } catch {
    return false;
  }
}

export function detectCapabilities(host: boolean): WordCapabilities {
  const office = officeGlobal();
  return {
    host,
    comments: host && isSetSupported("WordApi", "1.4"),
    trackChanges: host && isSetSupported("WordApi", "1.4"),
    paragraphStyles: host && isSetSupported("WordApi", "1.3"),
    paragraphEvents: host && isSetSupported("WordApi", "1.6"),
    viewport: host && isSetSupported("WordApiDesktop", "1.2"),
    selectionEvents: host && typeof office?.context?.document?.addHandlerAsync === "function",
    platform: host ? String(office?.context?.platform ?? "") || null : null,
    officeVersion: host ? String(office?.context?.diagnostics?.version ?? "") || null : null
  };
}

/** Wait for Office.js to initialize and report whether we are inside Word. */
export async function waitForWordHost(timeoutMs = 6_000): Promise<WordHostBoot> {
  const office = officeGlobal();
  if (!office || typeof office.onReady !== "function") {
    return { ready: false, detail: "Office.js did not load — the page is running outside Microsoft Word.", capabilities: detectCapabilities(false) };
  }
  const info = await Promise.race([
    office.onReady(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ]);
  if (!info) {
    return { ready: false, detail: "Office.js did not become ready — reopen the task pane from Word's ribbon.", capabilities: detectCapabilities(false) };
  }
  const inWord = info.host === office.HostType?.Word || office.context?.host === office.HostType?.Word;
  if (!inWord || !wordGlobal()) {
    return { ready: false, detail: "This page is not running inside Microsoft Word.", capabilities: detectCapabilities(false) };
  }
  return { ready: true, detail: "Connected to Microsoft Word.", capabilities: detectCapabilities(true) };
}

export function readDocumentName(): string | null {
  const url = officeGlobal()?.context?.document?.url;
  if (typeof url !== "string" || !url.trim()) {
    return null;
  }
  const withoutQuery = url.split(/[?#]/)[0];
  const name = withoutQuery.split(/[\\/]/).filter(Boolean).pop();
  if (!name) {
    return null;
  }
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function requireWord(): typeof Word {
  const word = wordGlobal();
  if (!word) {
    throw new Error("Microsoft Word is not available. Open this task pane from Word's ribbon.");
  }
  return word;
}

/* ------------------------------------------------------------------------- */
/* Document snapshot                                                         */
/* ------------------------------------------------------------------------- */

/** Full read: body text + every paragraph (text, style, outline level). */
export async function readDocumentSnapshot(capabilities: WordCapabilities): Promise<WordDocumentSnapshot> {
  const word = requireWord();
  return word.run(async (context) => {
    const body = context.document.body;
    const paragraphs = body.paragraphs;
    const inlinePictures = body.inlinePictures;
    body.load("text");
    paragraphs.load(capabilities.paragraphStyles
      ? "items/text,items/style,items/styleBuiltIn,items/outlineLevel,items/isListItem"
      : "items/text,items/style,items/outlineLevel,items/isListItem");
    inlinePictures.load("items/width,items/height,items/altTextDescription,items/altTextTitle");
    if (capabilities.trackChanges) {
      context.document.load("changeTrackingMode");
    }
    await context.sync();
    const bodyText = normalizeWordText(body.text ?? "");
    const sources = paragraphs.items.map((paragraph) => ({
      text: paragraph.text ?? "",
      style: safeString(paragraph, "style"),
      styleBuiltIn: capabilities.paragraphStyles ? safeString(paragraph, "styleBuiltIn") : null,
      outlineLevel: safeNumber(paragraph, "outlineLevel"),
      isListItem: safeBoolean(paragraph, "isListItem")
    }));
    // Picture metadata (never the bytes — those are read on demand when a
    // request is sent). One extra round trip only when there are pictures.
    let pictures: WordPictureInfo[] = [];
    try {
      const items = inlinePictures.items ?? [];
      if (items.length) {
        for (const picture of items) {
          picture.paragraph.load("text");
        }
        await context.sync();
        pictures = items.map((picture, index) => {
          const paragraphText = normalizeWordText(picture.paragraph.text ?? "").trim();
          const paragraphIndex = paragraphText ? sources.findIndex((source) => normalizeWordText(source.text).trim() === paragraphText) : -1;
          return {
            index,
            width: safeNumber(picture, "width"),
            height: safeNumber(picture, "height"),
            altText: safeString(picture, "altTextDescription") || safeString(picture, "altTextTitle") || null,
            paragraphText,
            paragraphIndex: paragraphIndex >= 0 ? paragraphIndex : null
          };
        });
      }
    } catch {
      pictures = [];
    }
    return {
      documentName: readDocumentName(),
      bodyText,
      paragraphs: indexParagraphs(bodyText, sources),
      pictures,
      changeTrackingMode: capabilities.trackChanges ? safeString(context.document, "changeTrackingMode") : null,
      capturedAt: new Date().toISOString()
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Inline pictures                                                           */
/* ------------------------------------------------------------------------- */

async function inlinePictureAt(context: Word.RequestContext, index: number): Promise<Word.InlinePicture> {
  const pictures = context.document.body.inlinePictures;
  pictures.load("items");
  await context.sync();
  const picture = pictures.items[index];
  if (!picture) {
    throw new Error(`Word has ${pictures.items.length} inline picture${pictures.items.length === 1 ? "" : "s"}; there is no picture ${index + 1}.`);
  }
  return picture;
}

/** The bytes of one inline picture, base64-encoded as Word returns them. */
export async function readInlinePictureBase64(index: number): Promise<{ base64: string; width: number | null; height: number | null }> {
  const word = requireWord();
  return word.run(async (context) => {
    const picture = await inlinePictureAt(context, index);
    picture.load("width,height");
    const source = picture.getBase64ImageSrc();
    await context.sync();
    return { base64: source.value ?? "", width: safeNumber(picture, "width"), height: safeNumber(picture, "height") };
  });
}

/** Replace one inline picture with new image bytes, as a tracked change when requested (Word tracks picture replacement like any edit). */
export async function replaceInlinePicture(index: number, base64: string, options: { trackChanges: "always" | "word" }): Promise<{ trackedChange: boolean }> {
  const word = requireWord();
  return word.run(async (context) => {
    const picture = await inlinePictureAt(context, index);
    const document = context.document;
    document.load("changeTrackingMode");
    await context.sync();
    let previousMode: string | null = null;
    let trackedChange: boolean;
    if (options.trackChanges === "always") {
      previousMode = String(document.changeTrackingMode ?? "Off");
      if (previousMode === "Off") {
        document.changeTrackingMode = "TrackAll";
        await context.sync();
      }
      trackedChange = true;
    } else {
      trackedChange = String(document.changeTrackingMode ?? "Off") !== "Off";
    }
    try {
      const inserted = picture.insertInlinePictureFromBase64(base64, "Replace");
      inserted.select();
      await context.sync();
    } finally {
      if (previousMode === "Off") {
        document.changeTrackingMode = "Off";
        await context.sync();
      }
    }
    return { trackedChange };
  });
}

/** Select a picture so Word scrolls to it. */
export async function selectInlinePicture(index: number): Promise<void> {
  const word = requireWord();
  await word.run(async (context) => {
    const picture = await inlinePictureAt(context, index);
    picture.select();
    await context.sync();
  });
}

/** Anchor a Word comment on a picture. */
export async function commentInlinePicture(index: number, text: string): Promise<void> {
  const word = requireWord();
  await word.run(async (context) => {
    const picture = await inlinePictureAt(context, index);
    picture.getRange().insertComment(text);
    picture.select();
    await context.sync();
  });
}

/* ------------------------------------------------------------------------- */
/* Focus: selection, caret, viewport                                         */
/* ------------------------------------------------------------------------- */

/**
 * Cheap read of where the author is. Reads only the paragraphs around the
 * selection and the first/last paragraphs of the visible pages, then maps
 * them onto the snapshot — no full-document reads on every caret move.
 */
export async function readFocus(snapshot: WordDocumentSnapshot, capabilities: WordCapabilities, previous: WordFocusState | null = null): Promise<WordFocusState> {
  const word = requireWord();
  return word.run(async (context) => {
    const selection = context.document.getSelection();
    const firstParagraph = selection.paragraphs.getFirst();
    const lastParagraph = selection.paragraphs.getLast();
    const firstPrevious = firstParagraph.getPreviousOrNullObject();
    const firstNext = firstParagraph.getNextOrNullObject();
    const lastPrevious = lastParagraph.getPreviousOrNullObject();
    const beforeInFirst = firstParagraph.getRange("Start").expandTo(selection.getRange("Start"));
    const beforeInLast = lastParagraph.getRange("Start").expandTo(selection.getRange("End"));
    selection.load("text");
    firstParagraph.load("text");
    lastParagraph.load("text");
    firstPrevious.load("text");
    firstNext.load("text");
    lastPrevious.load("text");
    beforeInFirst.load("text");
    beforeInLast.load("text");

    let pages: Word.PageCollection | null = null;
    let viewportSupported = capabilities.viewport;
    if (viewportSupported) {
      try {
        pages = context.document.activeWindow.activePane.pagesEnclosingViewport;
        pages.load("items/index");
      } catch {
        pages = null;
        viewportSupported = false;
      }
    }
    try {
      await context.sync();
    } catch (error) {
      if (pages && isApiNotFound(error)) {
        // Older desktop builds advertise WordApiDesktop 1.2 without the pane API — retry without it.
        pages = null;
        viewportSupported = false;
        await context.sync();
      } else {
        throw error;
      }
    }

    const near = previous?.cursorParagraphIndex ?? null;
    const firstIndex = locateParagraph(snapshot.paragraphs, {
      text: firstParagraph.text ?? "",
      previousText: firstPrevious.isNullObject ? "" : firstPrevious.text ?? "",
      nextText: firstNext.isNullObject ? "" : firstNext.text ?? ""
    }, { near });
    const lastIndex = lastParagraph.text === firstParagraph.text && lastPrevious.isNullObject === firstPrevious.isNullObject && (lastPrevious.isNullObject || lastPrevious.text === firstPrevious.text)
      ? firstIndex
      : locateParagraph(snapshot.paragraphs, {
        text: lastParagraph.text ?? "",
        previousText: lastPrevious.isNullObject ? "" : lastPrevious.text ?? ""
      }, { near: firstIndex ?? near, minIndex: firstIndex ?? 0 });

    const stale = firstIndex === null;
    const firstInfo = firstIndex !== null ? snapshot.paragraphs[firstIndex] : null;
    const lastInfo = lastIndex !== null ? snapshot.paragraphs[lastIndex] : firstInfo;
    const cursorOffset = firstInfo ? firstInfo.offset + normalizeWordText(beforeInFirst.text ?? "").length : previous?.cursorOffset ?? 0;
    let selectionContext: SelectionContext | null = null;
    const selectedText = normalizeWordText(selection.text ?? "");
    if (firstInfo && lastInfo && selectedText.trim()) {
      const to = lastInfo.offset + normalizeWordText(beforeInLast.text ?? "").length;
      selectionContext = canonicalSelection(snapshot.bodyText, cursorOffset, to, selectedText);
    }

    let viewport: WordViewportState | null = null;
    if (pages && viewportSupported && pages.items.length) {
      viewport = await readViewport(context, snapshot, pages, firstIndex ?? near);
    }

    return {
      selection: selectionContext,
      cursorOffset,
      cursorParagraphIndex: firstIndex,
      viewport,
      capturedAt: new Date().toISOString(),
      stale
    };
  });
}

async function readViewport(context: Word.RequestContext, snapshot: WordDocumentSnapshot, pages: Word.PageCollection, near: number | null): Promise<WordViewportState | null> {
  const indexes = pages.items.map((page) => page.index).filter((index) => Number.isFinite(index));
  const firstPage = pages.items[0];
  const lastPage = pages.items[pages.items.length - 1];
  const first = firstPage.getRange("Whole").paragraphs.getFirst();
  const firstNext = first.getNextOrNullObject();
  const last = lastPage.getRange("Whole").paragraphs.getLast();
  const lastPrevious = last.getPreviousOrNullObject();
  first.load("text");
  firstNext.load("text");
  last.load("text");
  lastPrevious.load("text");
  try {
    await context.sync();
  } catch {
    return null;
  }
  const fromIndex = locateParagraph(snapshot.paragraphs, {
    text: first.text ?? "",
    nextText: firstNext.isNullObject ? "" : firstNext.text ?? ""
  }, { near });
  if (fromIndex === null) {
    return null;
  }
  const toIndex = locateParagraph(snapshot.paragraphs, {
    text: last.text ?? "",
    previousText: lastPrevious.isNullObject ? "" : lastPrevious.text ?? ""
  }, { near: Math.max(fromIndex, near ?? fromIndex), minIndex: fromIndex }) ?? fromIndex;
  const fromParagraph = snapshot.paragraphs[fromIndex];
  const toParagraph = snapshot.paragraphs[Math.max(fromIndex, toIndex)];
  return {
    from: fromParagraph.offset,
    to: toParagraph.offset + toParagraph.length,
    pages: indexes
  };
}

/**
 * The selection the AI receives must be a verbatim slice of the document text
 * (anchors are validated against it). Prefer the offsets derived from the
 * paragraph mapping; if Word's own selection text disagrees (different
 * separators, fields), fall back to searching for the text near the caret.
 */
function canonicalSelection(bodyText: string, from: number, to: number, selectedText: string): SelectionContext | null {
  const end = Math.max(from, to);
  const slice = bodyText.slice(from, end);
  if (slice && collapseWhitespace(slice) === collapseWhitespace(selectedText)) {
    return { from, to: end, text: slice };
  }
  const trimmed = selectedText.trim();
  if (trimmed) {
    const near = nearestOccurrence(bodyText, trimmed, from);
    if (near !== null) {
      return { from: near, to: near + trimmed.length, text: trimmed };
    }
  }
  if (slice.trim()) {
    return { from, to: end, text: slice };
  }
  return null;
}

function nearestOccurrence(haystack: string, needle: string, near: number): number | null {
  let best: number | null = null;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    if (best === null || Math.abs(index - near) < Math.abs(best - near)) {
      best = index;
    }
    if (index > near && best !== null && Math.abs(best - near) <= index - near) {
      break;
    }
    index = haystack.indexOf(needle, index + 1);
  }
  return best;
}

/* ------------------------------------------------------------------------- */
/* Subscriptions                                                             */
/* ------------------------------------------------------------------------- */

/** Fires whenever the selection changes in Word (caret moves count). Returns an unsubscribe. */
export function subscribeSelectionChanges(handler: () => void): () => void {
  const office = officeGlobal();
  const document = office?.context?.document;
  if (!office || !document || typeof document.addHandlerAsync !== "function") {
    return () => undefined;
  }
  const eventType = office.EventType.DocumentSelectionChanged;
  const wrapped = () => handler();
  document.addHandlerAsync(eventType, wrapped, () => undefined);
  return () => {
    try {
      document.removeHandlerAsync(eventType, { handler: wrapped }, () => undefined);
    } catch {
      // Word tears the handler down with the pane anyway.
    }
  };
}

/**
 * Fires when paragraphs change (WordApi 1.6). Resolves to an unsubscribe;
 * resolves to null when the host has no paragraph events, in which case the
 * caller should poll.
 */
export async function subscribeParagraphChanges(handler: () => void, capabilities: WordCapabilities): Promise<(() => Promise<void>) | null> {
  const word = wordGlobal();
  if (!word || !capabilities.paragraphEvents) {
    return null;
  }
  try {
    const results = await word.run(async (context) => {
      const document = context.document;
      const wrapped = async () => handler();
      const handles = [
        document.onParagraphChanged.add(wrapped),
        document.onParagraphAdded.add(wrapped),
        document.onParagraphDeleted.add(wrapped)
      ];
      await context.sync();
      return handles;
    });
    return async () => {
      try {
        await word.run(async (context) => {
          for (const handle of results) {
            handle.remove();
          }
          await context.sync();
        });
      } catch {
        // Pane closing; nothing to clean.
      }
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- */
/* Suggestion actions                                                        */
/* ------------------------------------------------------------------------- */

/** Find where a suggestion's original text lives in Word, with approximate offsets for disambiguation. */
export async function findSuggestionMatches(snapshot: WordDocumentSnapshot, suggestion: Pick<AiSuggestion, "original">): Promise<SuggestionMatchSet> {
  const word = requireWord();
  return word.run(async (context) => {
    const found = await findRanges(context, suggestion.original);
    const matches = await describeMatches(context, snapshot, found.ranges);
    return { matches, strategy: found.strategy };
  });
}

/** Select the suggestion's text in Word so the document scrolls to it. */
export async function locateSuggestion(snapshot: WordDocumentSnapshot, suggestion: Pick<AiSuggestion, "original">, matchIndex: number): Promise<{ matches: number; matchIndex: number }> {
  const word = requireWord();
  return word.run(async (context) => {
    const found = await findRanges(context, suggestion.original);
    if (!found.ranges.length) {
      throw new Error("Word could not find this suggestion's original text — the passage may have changed since the suggestion was made.");
    }
    const index = clampIndex(matchIndex, found.ranges.length);
    found.ranges[index].select("Select");
    await context.sync();
    return { matches: found.ranges.length, matchIndex: index };
  });
}

/** Replace the original text with the suggestion, as a Word tracked change when requested. */
export async function applySuggestion(snapshot: WordDocumentSnapshot, suggestion: Pick<AiSuggestion, "original" | "replacement">, options: ApplyOptions): Promise<ApplyResult> {
  const [outcome] = await applySuggestions(snapshot, [{ id: "single", suggestion, matchIndex: options.matchIndex }], { trackChanges: options.trackChanges });
  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  return outcome.result;
}

export interface BatchApplyItem {
  id: string;
  suggestion: Pick<AiSuggestion, "original" | "replacement" | "anchor">;
  /** Occurrence to act on when the text appears more than once; null = choose by anchor, then `preferredOffset` (one extra round trip only when ambiguous). */
  matchIndex: number | null;
  preferredOffset?: number | null;
}

export type BatchApplyOutcome =
  | { id: string; ok: true; result: ApplyResult }
  | { id: string; ok: false; error: string };

export interface BatchApplyOptions {
  trackChanges: ApplyOptions["trackChanges"];
}

/**
 * Apply several suggestions with a handful of round trips into Word instead
 * of a handful per suggestion: every search is queued and flushed in one
 * sync, every target is verified in one sync, Track Changes is switched once,
 * and every replacement is queued and flushed in one sync (from the end of
 * the document backwards, so earlier ranges are never disturbed). A change
 * that overlaps an earlier one in the same pass waits for the next pass,
 * which searches the updated text; anything still conflicting after three
 * passes is reported, not guessed.
 */
export async function applySuggestions(snapshot: WordDocumentSnapshot, items: BatchApplyItem[], options: BatchApplyOptions): Promise<BatchApplyOutcome[]> {
  const word = requireWord();
  const outcomes = new Map<string, BatchApplyOutcome>();
  let pending = items;
  for (let pass = 0; pass < 3 && pending.length; pass += 1) {
    const remaining = pending;
    pending = await word.run((context) => runApplyPass(context, snapshot, remaining, options, outcomes));
  }
  for (const item of pending) {
    outcomes.set(item.id, { id: item.id, ok: false, error: "This change overlaps another change in the same batch; apply it on its own." });
  }
  return items.map((item) => outcomes.get(item.id) ?? { id: item.id, ok: false, error: "Not applied." });
}

async function runApplyPass(
  context: Word.RequestContext,
  snapshot: WordDocumentSnapshot,
  items: BatchApplyItem[],
  options: BatchApplyOptions,
  outcomes: Map<string, BatchApplyOutcome>
): Promise<BatchApplyItem[]> {
  type Target = { item: BatchApplyItem; range: Word.Range; matches: number; matchIndex: number };
  const found = await findRangesBatch(context, items.map((item) => item.suggestion.original));
  const targets: Target[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const ranges = found[index].ranges;
    if (!ranges.length) {
      outcomes.set(item.id, { id: item.id, ok: false, error: "Word could not find this suggestion's original text — the passage may have changed since the suggestion was made." });
      continue;
    }
    let matchIndex = item.matchIndex;
    if (matchIndex === null) {
      matchIndex = ranges.length > 1 ? chooseMatchIndex(await describeMatches(context, snapshot, ranges), item.preferredOffset ?? null, item.suggestion.anchor ?? null) : 0;
    }
    matchIndex = clampIndex(matchIndex, ranges.length);
    targets.push({ item, range: ranges[matchIndex], matches: ranges.length, matchIndex });
  }
  if (!targets.length) {
    return [];
  }

  const document = context.document;
  for (const target of targets) {
    target.range.load("text");
  }
  document.load("changeTrackingMode");
  const comparisons: Array<{ a: Target; b: Target; result: OfficeExtension.ClientResult<Word.LocationRelation> }> = [];
  for (let a = 0; a < targets.length; a += 1) {
    for (let b = a + 1; b < targets.length; b += 1) {
      comparisons.push({ a: targets[a], b: targets[b], result: targets[a].range.compareLocationWith(targets[b].range) });
    }
  }
  await context.sync();

  const verified = new Set<Target>();
  for (const target of targets) {
    if (collapseWhitespace(normalizeWordText(target.range.text ?? "")) !== collapseWhitespace(target.item.suggestion.original)) {
      outcomes.set(target.item.id, { id: target.item.id, ok: false, error: "The text Word found no longer matches the suggestion's original passage. Re-read the document and ask again." });
    } else {
      verified.add(target);
    }
  }
  const deferred = new Set<Target>();
  const precedingCount = new Map<Target, number>();
  for (const comparison of comparisons) {
    if (!verified.has(comparison.a) || !verified.has(comparison.b)) {
      continue;
    }
    const order = relationOrder(String(comparison.result.value));
    if (order === 0) {
      deferred.add(comparison.b);
    } else if (order < 0) {
      precedingCount.set(comparison.b, (precedingCount.get(comparison.b) ?? 0) + 1);
    } else {
      precedingCount.set(comparison.a, (precedingCount.get(comparison.a) ?? 0) + 1);
    }
  }
  // Last in the document first: replacing later text never moves earlier ranges.
  const ready = [...verified].filter((target) => !deferred.has(target)).sort((x, y) => (precedingCount.get(y) ?? 0) - (precedingCount.get(x) ?? 0));
  if (!ready.length) {
    return [...deferred].map((target) => target.item);
  }

  let previousMode: string | null = null;
  let trackedChange: boolean;
  if (options.trackChanges === "always") {
    previousMode = String(document.changeTrackingMode ?? "Off");
    if (previousMode === "Off") {
      document.changeTrackingMode = "TrackAll";
      await context.sync();
    }
    trackedChange = true;
  } else {
    trackedChange = String(document.changeTrackingMode ?? "Off") !== "Off";
  }
  try {
    const strategies = new Map<Target, ApplyResult["strategy"]>();
    const failures = new Map<Target, string>();
    let earliest: Word.Range | null = null;
    // Word-level plans for every eligible target, loaded in one sync.
    const wordPlans = await planWordLevelEdits(context, ready.filter((target) => wordLevelEligible(target.item.suggestion)).map((target) => ({ key: target, range: target.range, suggestion: target.item.suggestion })));
    for (const target of ready) {
      const { suggestion } = target.item;
      if (await applyPerParagraph(context, target.range, suggestion)) {
        strategies.set(target, "paragraphs");
        earliest = target.range;
        continue;
      }
      if (suggestion.replacement.trim() === "") {
        strategies.set(target, "range");
        target.range.delete();
        earliest = target.range;
        continue;
      }
      const plan = wordPlans.get(target);
      if (plan && "error" in plan) {
        failures.set(target, plan.error);
        continue;
      }
      if (plan) {
        strategies.set(target, "words");
        earliest = applyWordPlan(plan);
        continue;
      }
      strategies.set(target, "range");
      earliest = target.range.insertText(suggestion.replacement, "Replace");
    }
    if (earliest) {
      // One selection for the whole batch: Word scrolls once, to the first change.
      earliest.select("Select");
    }
    await context.sync();
    for (const target of ready) {
      const failure = failures.get(target);
      if (failure) {
        outcomes.set(target.item.id, { id: target.item.id, ok: false, error: failure });
        continue;
      }
      outcomes.set(target.item.id, {
        id: target.item.id,
        ok: true,
        result: { trackedChange, matches: target.matches, matchIndex: target.matchIndex, strategy: strategies.get(target) ?? "range" }
      });
    }
  } finally {
    if (previousMode === "Off") {
      document.changeTrackingMode = "Off";
      await context.sync();
    }
  }
  return [...deferred].map((target) => target.item);
}

/* ------------------------------------------------------------------------- */
/* Word-level application: edit only the words that change                   */
/* ------------------------------------------------------------------------- */

type PieceOp =
  | { kind: "replace"; from: number; to: number; text: string }
  | { kind: "delete"; from: number; to: number }
  | { kind: "insertStart"; index: number; text: string }
  | { kind: "insertEnd"; index: number; text: string };

type WordPlan = { pieces: Word.Range[]; ops: PieceOp[] } | { error: string };

/** Single-paragraph rewrites with something worth keeping: a whole-range replace would flatten the formatting of the untouched words. */
function wordLevelEligible(suggestion: Pick<AiSuggestion, "original" | "replacement">): boolean {
  if (!suggestion.replacement.trim() || normalizeWordText(suggestion.original).includes("\n") || suggestion.replacement.includes("\n")) {
    return false;
  }
  return wordDiffSegments(suggestion.original, suggestion.replacement) !== null;
}

function opPieceIndexes(op: PieceOp): number[] {
  if (op.kind === "insertStart" || op.kind === "insertEnd") {
    return [op.index];
  }
  const indexes: number[] = [];
  for (let index = op.from; index <= op.to; index += 1) {
    indexes.push(index);
  }
  return indexes;
}

/**
 * Word's view of the passage: one range per word (its trailing space kept),
 * each carrying its own formatting. Replacing or deleting only the run of
 * words that changed keeps every other word exactly as it was; new words
 * inherit the formatting of the first word they replace or the word they
 * follow. Fields inside the passage are protected: an edit whose words touch
 * a field result fails with a reason instead of corrupting a citation or
 * cross-reference.
 */
async function planWordLevelEdits<Key>(
  context: Word.RequestContext,
  targets: Array<{ key: Key; range: Word.Range; suggestion: Pick<AiSuggestion, "original" | "replacement"> }>
): Promise<Map<Key, WordPlan>> {
  const plans = new Map<Key, WordPlan>();
  if (!targets.length) {
    return plans;
  }
  const loaded = targets.map((target) => {
    const pieces = target.range.getTextRanges([" ", "\t", "\u00a0"], false);
    pieces.load("items/text");
    let fields: Word.FieldCollection | null = null;
    try {
      fields = target.range.fields;
      fields.load("items");
    } catch {
      fields = null;
    }
    return { target, pieces, fields };
  });
  await context.sync();

  const checks: Array<{ key: Key; results: Array<OfficeExtension.ClientResult<Word.LocationRelation>> }> = [];
  for (const entry of loaded) {
    const pieces = entry.pieces.items ?? [];
    const texts = pieces.map((piece) => piece.text ?? "");
    if (!pieces.length || collapseWhitespace(normalizeWordText(texts.join(""))) !== collapseWhitespace(normalizeWordText(entry.target.suggestion.original))) {
      continue; // Word split it differently than expected: fall back to a range replace.
    }
    const ops = wordPieceOps(texts, entry.target.suggestion.replacement);
    if (!ops.length) {
      continue;
    }
    plans.set(entry.target.key, { pieces, ops });
    let fieldItems: Word.Field[] = [];
    try {
      fieldItems = entry.fields?.items ?? [];
    } catch {
      fieldItems = [];
    }
    if (fieldItems.length) {
      const touched = [...new Set(ops.flatMap(opPieceIndexes))].map((index) => pieces[index]).filter(Boolean);
      const results: Array<OfficeExtension.ClientResult<Word.LocationRelation>> = [];
      for (const field of fieldItems) {
        for (const piece of touched) {
          results.push(piece.compareLocationWith(field.result));
        }
      }
      checks.push({ key: entry.target.key, results });
    }
  }
  if (checks.length) {
    await context.sync();
    for (const check of checks) {
      if (check.results.some((result) => relationOrder(String(result.value)) === 0)) {
        plans.set(check.key, { error: "This change would cut into a Word field (a citation or cross-reference). Leave it as a comment, or edit the field in Word." });
      }
    }
  }
  return plans;
}

/**
 * Edit script over Word's word pieces (texts include their trailing space)
 * that turns them into the replacement with one operation per changed run:
 * a run of changed words becomes one replace (new words inherit the first
 * replaced word's formatting), a run of dropped words one delete, and a pure
 * insertion goes at the end of the previous piece (or the start of the first).
 */
export function wordPieceOps(pieceTexts: string[], replacement: string): PieceOp[] {
  const words = pieceTexts.map((text) => collapseWhitespace(normalizeWordText(text)));
  const targetWords = collapseWhitespace(normalizeWordText(replacement)).split(" ").filter(Boolean);
  const n = words.length;
  const m = targetWords.length;
  if (n + m > 3000) {
    return [];
  }
  const cols = m + 1;
  const lcs = new Array<number>((n + 1) * cols).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] = words[i] === targetWords[j]
        ? lcs[(i + 1) * cols + j + 1] + 1
        : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }
  const trailingSpace = (index: number) => {
    const text = pieceTexts[index] ?? "";
    return text.slice(text.trimEnd().length);
  };
  const ops: PieceOp[] = [];
  let i = 0;
  let j = 0;
  let lastKept = -1;
  while (i < n || j < m) {
    if (i < n && j < m && words[i] === targetWords[j]) {
      lastKept = i;
      i += 1;
      j += 1;
      continue;
    }
    const deleted: number[] = [];
    const inserted: string[] = [];
    while (i < n && (j >= m || words[i] !== targetWords[j]) && (j >= m || lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1])) {
      deleted.push(i);
      i += 1;
    }
    while (j < m && (i >= n || words[i] !== targetWords[j]) && (i >= n || lcs[i * cols + j + 1] > lcs[(i + 1) * cols + j])) {
      inserted.push(targetWords[j]);
      j += 1;
    }
    if (!deleted.length && !inserted.length) {
      break;
    }
    const first = deleted[0];
    const last = deleted[deleted.length - 1];
    if (deleted.length && inserted.length) {
      ops.push({ kind: "replace", from: first, to: last, text: `${inserted.join(" ")}${trailingSpace(last)}` });
      lastKept = last;
    } else if (deleted.length) {
      if (last === n - 1 && first > 0 && lastKept === first - 1 && trailingSpace(first - 1)) {
        // Dropping the passage's tail: the new last word must not keep the space that separated it.
        ops.push({ kind: "replace", from: first - 1, to: last, text: pieceTexts[first - 1].trimEnd() });
      } else {
        ops.push({ kind: "delete", from: first, to: last });
      }
    } else {
      const text = inserted.join(" ");
      if (lastKept >= 0) {
        ops.push({ kind: "insertEnd", index: lastKept, text: trailingSpace(lastKept) ? `${text} ` : ` ${text}` });
      } else {
        ops.push({ kind: "insertStart", index: 0, text: `${text} ` });
      }
    }
  }
  return ops;
}

/** Queue the plan's operations (later pieces first so earlier ones stay put); returns the earliest touched range for selection. */
function applyWordPlan(plan: { pieces: Word.Range[]; ops: PieceOp[] }): Word.Range | null {
  const position = (op: PieceOp) => (op.kind === "insertStart" || op.kind === "insertEnd" ? op.index : op.from);
  const ordered = [...plan.ops].sort((a, b) => position(b) - position(a));
  let earliest: Word.Range | null = null;
  for (const op of ordered) {
    if (op.kind === "insertStart" || op.kind === "insertEnd") {
      const piece = plan.pieces[op.index];
      if (piece) {
        earliest = piece.insertText(op.text, op.kind === "insertStart" ? "Start" : "End");
      }
      continue;
    }
    const first = plan.pieces[op.from];
    const last = plan.pieces[op.to];
    if (!first || !last) {
      continue;
    }
    const range = op.from === op.to ? first : first.expandTo(last);
    if (op.kind === "replace") {
      earliest = range.insertText(op.text, "Replace");
    } else {
      range.delete();
      earliest = range;
    }
  }
  return earliest;
}

/** -1: a precedes b; 1: a follows b; 0: they touch or overlap (or Word could not tell). */
function relationOrder(relation: string): -1 | 0 | 1 {
  switch (relation) {
    case "Before":
    case "AdjacentBefore":
    case "Unrelated":
      return -1;
    case "After":
    case "AdjacentAfter":
      return 1;
    default:
      return 0;
  }
}

/**
 * Search for every original at once: the simple ones (one paragraph, within
 * Word's search-length limit) are queued and flushed in a single sync; the
 * rest, and any case-sensitive misses, take the full per-anchor path.
 */
async function findRangesBatch(context: Word.RequestContext, originals: string[]): Promise<FoundRanges[]> {
  const results: Array<FoundRanges | null> = originals.map(() => null);
  const queued: Array<{ index: number; collection: Word.RangeCollection }> = [];
  originals.forEach((original, index) => {
    const normalizedText = normalizeWordText(original).trim();
    const normalized = collapseWhitespace(normalizedText);
    if (!normalized) {
      results[index] = { ranges: [], strategy: "none" };
      return;
    }
    if (normalizedText.includes("\n") || normalized.length > WORD_SEARCH_MAX_CHARS) {
      return;
    }
    const query = toWordSearchText(normalized);
    if (!query) {
      results[index] = { ranges: [], strategy: "search" };
      return;
    }
    const collection = context.document.body.search(query, { matchCase: true, ignoreSpace: true, ignorePunct: false, matchWholeWord: false, matchWildcards: false });
    collection.load("items");
    queued.push({ index, collection });
  });
  if (queued.length) {
    try {
      await context.sync();
      for (const entry of queued) {
        if (entry.collection.items.length) {
          results[entry.index] = { ranges: entry.collection.items, strategy: "search" };
        }
      }
    } catch (error) {
      if (!isSearchStringError(error)) {
        throw error;
      }
      // One rejected query fails the whole batch; each falls back below.
    }
  }
  for (let index = 0; index < originals.length; index += 1) {
    if (!results[index]) {
      results[index] = await findRanges(context, originals[index]);
    }
  }
  return results as FoundRanges[];
}

/**
 * A suggestion that spans paragraphs (typically: a sentence added at the end
 * of one paragraph, quoted together with the start of the next) is applied
 * paragraph by paragraph, so the paragraph marks — and with them heading
 * styles, list formatting, spacing — are never replaced. Returns false when
 * the paragraph structure differs and the caller should replace the whole
 * range instead.
 */
async function applyPerParagraph(context: Word.RequestContext, target: Word.Range, suggestion: Pick<AiSuggestion, "original" | "replacement">): Promise<boolean> {
  const originalParts = normalizeWordText(suggestion.original).trim().split("\n");
  const replacementParts = normalizeWordText(suggestion.replacement).trim().split("\n");
  if (originalParts.length < 2 || originalParts.length !== replacementParts.length) {
    return false;
  }
  const paragraphs = target.paragraphs;
  paragraphs.load("items/text");
  await context.sync();
  if (paragraphs.items.length !== originalParts.length) {
    return false;
  }
  const edits: Array<{ range: Word.Range; replacement: string }> = [];
  for (let i = 0; i < originalParts.length; i += 1) {
    const before = collapseWhitespace(originalParts[i]);
    const after = collapseWhitespace(replacementParts[i]);
    if (before === after) {
      continue;
    }
    const paragraph = paragraphs.items[i];
    const paragraphText = collapseWhitespace(normalizeWordText(paragraph.text ?? ""));
    if (paragraphText === before) {
      edits.push({ range: paragraph.getRange("Content"), replacement: replacementParts[i] });
      continue;
    }
    if (!before || before.length > WORD_SEARCH_MAX_CHARS) {
      return false;
    }
    const matches = paragraph.search(toWordSearchText(before), { matchCase: true, ignoreSpace: true, ignorePunct: false, matchWholeWord: false, matchWildcards: false });
    matches.load("items");
    await context.sync();
    if (!matches.items.length) {
      return false;
    }
    // The last paragraph's piece is a prefix, the first's a suffix; either way
    // the occurrence nearest the target boundary is the right one.
    const pick = i === 0 ? matches.items[matches.items.length - 1] : matches.items[0];
    edits.push({ range: pick, replacement: replacementParts[i] });
  }
  if (!edits.length) {
    return false;
  }
  let firstInserted: Word.Range | null = null;
  // Apply from the end so earlier edits never shift later ones.
  for (const edit of [...edits].reverse()) {
    if (edit.replacement.trim() === "") {
      edit.range.delete();
    } else {
      firstInserted = edit.range.insertText(edit.replacement, "Replace");
    }
  }
  if (firstInserted) {
    firstInserted.select("Select");
  } else {
    target.select("Start");
  }
  await context.sync();
  return true;
}

/** Anchor a Word comment on the suggestion's original text. */
export async function commentSuggestion(snapshot: WordDocumentSnapshot, suggestion: Pick<AiSuggestion, "original">, text: string, matchIndex: number): Promise<{ matches: number; matchIndex: number }> {
  const word = requireWord();
  return word.run(async (context) => {
    const found = await findRanges(context, suggestion.original);
    if (!found.ranges.length) {
      throw new Error("Word could not find this suggestion's original text to anchor a comment on.");
    }
    const index = clampIndex(matchIndex, found.ranges.length);
    const target = found.ranges[index];
    target.insertComment(text);
    target.select("Select");
    await context.sync();
    return { matches: found.ranges.length, matchIndex: index };
  });
}

/* ------------------------------------------------------------------------- */
/* Range finding                                                             */
/* ------------------------------------------------------------------------- */

interface FoundRanges {
  ranges: Word.Range[];
  strategy: SuggestionMatchSet["strategy"];
}

/**
 * Word's search is capped at ~255 characters, so long anchors are found by
 * searching their head and tail and expanding the head match to the first
 * tail match that follows it. Every candidate is verified against the
 * original before it is used.
 */
async function findRanges(context: Word.RequestContext, original: string): Promise<FoundRanges> {
  const normalizedText = normalizeWordText(original).trim();
  const normalized = collapseWhitespace(normalizedText);
  if (!normalized) {
    return { ranges: [], strategy: "none" };
  }
  // Word's search never crosses a paragraph mark, so an anchor that spans
  // paragraphs (the AI quoted the end of one and the start of the next) is
  // found by its first and last paragraph pieces and expanded between them.
  const parts = normalizedText.split("\n").map(collapseWhitespace).filter(Boolean);
  const multiParagraph = parts.length > 1;
  if (!multiParagraph && normalized.length <= WORD_SEARCH_MAX_CHARS) {
    const ranges = await searchBody(context, normalized);
    return { ranges, strategy: "search" };
  }
  const headSource = multiParagraph ? parts[0] : normalized;
  const tailSource = multiParagraph ? parts[parts.length - 1] : normalized;
  const head = headSource.length <= WORD_SEARCH_MAX_CHARS && multiParagraph ? headSource : trimToWordBoundary(headSource.slice(0, ANCHOR_EDGE_CHARS), "end");
  const tail = tailSource.length <= WORD_SEARCH_MAX_CHARS && multiParagraph ? tailSource : trimToWordBoundary(tailSource.slice(-ANCHOR_EDGE_CHARS), "start");
  const minChars = multiParagraph ? MULTI_PARAGRAPH_ANCHOR_MIN_CHARS : ANCHOR_MIN_CHARS;
  if (head.length < minChars || tail.length < minChars) {
    return { ranges: [], strategy: "none" };
  }
  const heads = await searchBody(context, head);
  const tails = await searchBody(context, tail);
  if (!heads.length || !tails.length) {
    return { ranges: [], strategy: "head-tail" };
  }
  const comparisons: Array<{ head: Word.Range; tail: Word.Range; result: OfficeExtension.ClientResult<Word.LocationRelation> }> = [];
  for (const headRange of heads) {
    for (const tailRange of tails) {
      comparisons.push({ head: headRange, tail: tailRange, result: headRange.compareLocationWith(tailRange) });
    }
  }
  await context.sync();
  const candidates: Word.Range[] = [];
  for (const headRange of heads) {
    const following = comparisons.find((comparison) => comparison.head === headRange && comparison.result.value === "Before");
    if (following) {
      candidates.push(headRange.expandTo(following.tail));
    }
  }
  if (!candidates.length) {
    return { ranges: [], strategy: "head-tail" };
  }
  for (const candidate of candidates) {
    candidate.load("text");
  }
  await context.sync();
  const verified = candidates.filter((candidate) => collapseWhitespace(normalizeWordText(candidate.text ?? "")) === normalized);
  return { ranges: verified, strategy: "head-tail" };
}

async function searchBody(context: Word.RequestContext, text: string): Promise<Word.Range[]> {
  const query = toWordSearchText(text);
  if (!query) {
    return [];
  }
  const attempts: Array<{ matchCase: boolean; ignoreSpace: boolean; ignorePunct: boolean; matchWholeWord: boolean; matchWildcards: boolean }> = [
    { matchCase: true, ignoreSpace: true, ignorePunct: false, matchWholeWord: false, matchWildcards: false },
    { matchCase: false, ignoreSpace: true, ignorePunct: false, matchWholeWord: false, matchWildcards: false }
  ];
  for (const options of attempts) {
    try {
      const results = context.document.body.search(query, options);
      results.load("items");
      await context.sync();
      if (results.items.length) {
        return results.items;
      }
    } catch (error) {
      if (!isSearchStringError(error)) {
        throw error;
      }
      return [];
    }
  }
  return [];
}

/** Word's Find treats `^` as an escape (^p, ^t, ^^); make literal text safe and encode breaks. */
export function toWordSearchText(text: string): string {
  return text
    .replace(/\^/g, "^^")
    .replace(/\n/g, "^p")
    .replace(/\t/g, "^t")
    .trim();
}

async function describeMatches(context: Word.RequestContext, snapshot: WordDocumentSnapshot, ranges: Word.Range[]): Promise<SuggestionMatch[]> {
  if (!ranges.length) {
    return [];
  }
  const probes = ranges.map((range) => {
    const paragraph = range.paragraphs.getFirst();
    const previous = paragraph.getPreviousOrNullObject();
    const next = paragraph.getNextOrNullObject();
    const before = paragraph.getRange("Start").expandTo(range.getRange("Start"));
    const after = range.getRange("End").expandTo(paragraph.getRange("End"));
    paragraph.load("text");
    previous.load("text");
    next.load("text");
    before.load("text");
    after.load("text");
    range.load("text");
    return { paragraph, previous, next, before, after, range };
  });
  await context.sync();
  let lastIndex: number | null = null;
  return probes.map((probe, index) => {
    const paragraphIndex = locateParagraph(snapshot.paragraphs, {
      text: probe.paragraph.text ?? "",
      previousText: probe.previous.isNullObject ? "" : probe.previous.text ?? ""
    }, { near: lastIndex, minIndex: lastIndex ?? 0 });
    if (paragraphIndex !== null) {
      lastIndex = paragraphIndex;
    }
    const paragraph: WordParagraphInfo | null = paragraphIndex !== null ? snapshot.paragraphs[paragraphIndex] : null;
    return {
      index,
      offset: paragraph ? paragraph.offset + normalizeWordText(probe.before.text ?? "").length : null,
      paragraphIndex,
      preview: excerpt(probe.paragraph.text ?? probe.range.text ?? "", MATCH_PREVIEW_CHARS),
      contextBefore: `${probe.previous.isNullObject ? "" : probe.previous.text ?? ""}\n${probe.before.text ?? ""}`,
      contextAfter: `${probe.after.text ?? ""}\n${probe.next.isNullObject ? "" : probe.next.text ?? ""}`
    };
  });
}

/**
 * Pick the occurrence a suggestion means: the one whose surroundings match
 * its placement anchor when that is decisive, else the one closest to where
 * the suggestion (or the author) is.
 */
export function chooseMatchIndex(matches: SuggestionMatch[], preferredOffset: number | null, anchor: SuggestionAnchor | null = null): number {
  const anchored = chooseAnchoredCandidate(anchor, matches.map((match) => ({ before: match.contextBefore, after: match.contextAfter })));
  if (anchored !== null) {
    return matches[anchored].index;
  }
  if (matches.length <= 1 || preferredOffset === null) {
    return 0;
  }
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  matches.forEach((match) => {
    if (match.offset === null) {
      return;
    }
    const distance = Math.abs(match.offset - preferredOffset);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = match.index;
    }
  });
  return best;
}

function trimToWordBoundary(value: string, keep: "start" | "end"): string {
  const trimmed = value.trim();
  if (keep === "end") {
    const lastSpace = trimmed.lastIndexOf(" ");
    return lastSpace >= ANCHOR_MIN_CHARS ? trimmed.slice(0, lastSpace) : trimmed;
  }
  const firstSpace = trimmed.indexOf(" ");
  return firstSpace >= 0 && trimmed.length - firstSpace - 1 >= ANCHOR_MIN_CHARS ? trimmed.slice(firstSpace + 1) : trimmed;
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index) || index < 0) {
    return 0;
  }
  return Math.min(Math.floor(index), Math.max(0, length - 1));
}

function isSearchStringError(error: unknown): boolean {
  const text = errorText(error);
  return /SearchStringInvalidOrTooLong|InvalidOrTooLong|SearchString/i.test(text);
}

function isApiNotFound(error: unknown): boolean {
  return /ApiNotFound|PropertyNotLoaded|InvalidArgument|NotImplemented/i.test(errorText(error));
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error ?? "");
  }
  const maybe = error as { code?: unknown; message?: unknown; name?: unknown };
  return [maybe.code, maybe.name, maybe.message].filter(Boolean).join(" ");
}

function safeString(target: object, key: string): string | null {
  try {
    const value = (target as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function safeNumber(target: object, key: string): number | null {
  try {
    const value = (target as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function safeBoolean(target: object, key: string): boolean | null {
  try {
    const value = (target as Record<string, unknown>)[key];
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}
