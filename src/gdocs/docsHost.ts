/**
 * Google Docs as a document host for the review pane: the same contract the
 * Word host implements, backed by the add-in's Apps Script functions through
 * the script bridge. Docs has no events, so the caret and the text are polled.
 */

import type { AiSuggestion } from "../shared";
import { normalizeEmphasis, shiftEmphasis, type EmphasisSpan } from "../emphasis";
import type { DocumentHost } from "../word/hostBridge";
import { chooseMatchIndex, type BatchApplyItem, type BatchApplyOptions, type BatchApplyOutcome, type SuggestionMatchSet, type WordCapabilities, type WordHostBoot } from "../word/wordHost";
import { indexParagraphs, type WordDocumentSnapshot, type WordFocusState } from "../word/wordContext";
import { findMatches, planReplace, rangesOverlap, rangeToParagraphs, type PlannedEdit } from "./docsPlan";
import type { DocsDocumentPayload, DocsFocusPayload, DocsImageBytesPayload, DocsOpOutcome, DocsReplaceOp } from "./protocol";
import { callScript, waitForScriptHost } from "./scriptBridge";

const SELECTION_POLL_MS = 2_000;
const PARAGRAPH_POLL_MS = 5_000;

export const docsCapabilities: WordCapabilities = {
  host: true,
  hostName: "Google Docs",
  comments: false,
  trackChanges: false,
  paragraphStyles: true,
  paragraphEvents: true,
  viewport: false,
  selectionEvents: true,
  platform: "Google Docs",
  officeVersion: null
};

let lastFingerprint: string | null = null;

async function waitForHost(timeoutMs = 8_000): Promise<WordHostBoot> {
  const ready = await waitForScriptHost(timeoutMs);
  return ready
    ? { ready: true, detail: "Connected to Google Docs.", capabilities: docsCapabilities }
    : { ready: false, detail: "The Google Docs sidebar did not connect — open Writer from the Extensions menu of a Google Doc.", capabilities: { ...docsCapabilities, host: false } };
}

function detectCapabilities(host: boolean): WordCapabilities {
  return { ...docsCapabilities, host };
}

async function readDocumentSnapshot(_capabilities?: WordCapabilities, _options?: unknown): Promise<WordDocumentSnapshot> {
  const payload = await callScript<DocsDocumentPayload>("nebulaReadDocument");
  lastFingerprint = payload.fingerprint;
  const bodyText = payload.paragraphs.map((paragraph) => paragraph.text).join("\n");
  const paragraphs = indexParagraphs(bodyText, payload.paragraphs.map((paragraph) => ({
    text: paragraph.text,
    style: paragraph.style,
    styleBuiltIn: paragraph.headingLevel ? `Heading${paragraph.headingLevel}` : "Normal",
    outlineLevel: paragraph.headingLevel ?? 10,
    isListItem: paragraph.isListItem
  })));
  const emphasis: EmphasisSpan[] = normalizeEmphasis(payload.paragraphs.flatMap((paragraph, index) => shiftEmphasis(paragraph.emphasis ?? [], paragraphs[index]?.offset ?? 0)));
  return {
    documentName: payload.documentName || null,
    bodyText,
    paragraphs,
    pictures: payload.images.map((image) => ({
      index: image.index,
      width: image.width,
      height: image.height,
      altText: image.altText,
      paragraphText: paragraphs[image.paragraphIndex]?.text.trim() ?? "",
      paragraphIndex: image.paragraphIndex
    })),
    emphasis,
    comments: payload.comments ?? [],
    commentsStatus: payload.commentsStatus ?? {
      state: "unavailable",
      detail: "This Google Docs host did not read reviewer comment threads. Use the Chrome extension's Connect comments command."
    },
    changeTrackingMode: null,
    capturedAt: new Date().toISOString()
  };
}

async function readFocus(snapshot: WordDocumentSnapshot, _capabilities: WordCapabilities, previous: WordFocusState | null = null, _options?: unknown): Promise<WordFocusState> {
  const focus = await callScript<DocsFocusPayload>("nebulaReadFocus");
  const paragraph = focus.paragraphIndex !== null ? snapshot.paragraphs[focus.paragraphIndex] ?? null : null;
  const stale = focus.fingerprint !== lastFingerprint || (paragraph !== null && focus.paragraphText !== null && paragraph.text !== focus.paragraphText);
  const cursorOffset = paragraph ? paragraph.offset + Math.min(focus.offset, paragraph.length) : previous?.cursorOffset ?? 0;
  let selection: WordFocusState["selection"] = null;
  if (focus.selection) {
    const range = focus.selection;
    const first = snapshot.paragraphs[range.startParagraph];
    const last = snapshot.paragraphs[range.endParagraph];
    if (first && last) {
      const from = first.offset + range.startOffset;
      const to = last.offset + range.endOffset;
      const text = snapshot.bodyText.slice(from, to);
      if (text.trim()) {
        selection = { from, to, text };
      }
    }
  }
  return {
    selection,
    cursorOffset,
    cursorParagraphIndex: paragraph?.index ?? null,
    viewport: null,
    capturedAt: new Date().toISOString(),
    stale
  };
}

function subscribeSelectionChanges(handler: () => void): () => void {
  let lastKey: string | null = null;
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    callScript<string>("nebulaFocusKey").then((key) => {
      inFlight = false;
      if (stopped) {
        return;
      }
      if (lastKey !== null && key !== lastKey) {
        handler();
      }
      lastKey = key;
    }).catch(() => {
      inFlight = false;
    });
  }, SELECTION_POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function subscribeParagraphChanges(handler: () => void): Promise<(() => Promise<void>) | null> {
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    callScript<string>("nebulaFingerprint").then((fingerprint) => {
      inFlight = false;
      if (stopped) {
        return;
      }
      if (lastFingerprint !== null && fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        handler();
      }
    }).catch(() => {
      inFlight = false;
    });
  }, PARAGRAPH_POLL_MS);
  return async () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function findSuggestionMatches(snapshot: WordDocumentSnapshot, suggestion: Pick<AiSuggestion, "original">): Promise<SuggestionMatchSet> {
  const matches = findMatches(snapshot, suggestion.original);
  return { matches, strategy: matches.length ? "search" : "none" };
}

async function locateSuggestion(snapshot: WordDocumentSnapshot, suggestion: Pick<AiSuggestion, "original">, matchIndex: number): Promise<{ matches: number; matchIndex: number }> {
  const matches = findMatches(snapshot, suggestion.original);
  if (!matches.length) {
    throw new Error("The document no longer contains this suggestion's original text — the passage may have changed.");
  }
  const index = Math.max(0, Math.min(matchIndex, matches.length - 1));
  const range = rangeToParagraphs(snapshot.paragraphs, matches[index].from, matches[index].to);
  if (!range) throw new Error("This passage could not be mapped to the document. Refresh Writer and try Locate again.");
  await callScript("nebulaSelect", { ...range, expected: snapshot.bodyText.slice(matches[index].from, matches[index].to) });
  return { matches: matches.length, matchIndex: index };
}

async function applySuggestions(snapshot: WordDocumentSnapshot, items: BatchApplyItem[], options: BatchApplyOptions): Promise<BatchApplyOutcome[]> {
  const outcomes = new Map<string, BatchApplyOutcome>();
  const planned: Array<{ item: BatchApplyItem; plan: PlannedEdit; range: { from: number; to: number }; matches: number; matchIndex: number }> = [];
  for (const item of items) {
    const matches = findMatches(snapshot, item.suggestion.original);
    if (!matches.length) {
      outcomes.set(item.id, { id: item.id, ok: false, error: "The document no longer contains this text — the passage may have changed." });
      continue;
    }
    const matchIndex = item.matchIndex !== null && item.matchIndex >= 0 && item.matchIndex < matches.length
      ? item.matchIndex
      : chooseMatchIndex(matches, item.preferredOffset ?? null, item.suggestion.anchor ?? null);
    const match = matches[matchIndex];
    const range = { from: match.from, to: match.to };
    if (planned.some((entry) => rangesOverlap(entry.range, range))) {
      outcomes.set(item.id, { id: item.id, ok: false, error: "This change overlaps another one applied in the same batch — apply it separately." });
      continue;
    }
    const plan = planReplace(snapshot, { id: item.id, ...item.suggestion }, range, { highlight: Boolean(options.highlightChanges) });
    if ("error" in plan) {
      outcomes.set(item.id, { id: item.id, ok: false, error: plan.error });
      continue;
    }
    planned.push({ item, plan, range, matches: matches.length, matchIndex });
  }
  const ops: DocsReplaceOp[] = planned.flatMap((entry) => entry.plan.ops);
  const results = ops.length ? await callScript<DocsOpOutcome[]>("nebulaApply", ops) : [];
  const byOp = new Map(results.map((result) => [result.id, result]));
  for (const entry of planned) {
    const failed = entry.plan.ops.map((op) => byOp.get(op.id)).find((result) => !result || !result.ok);
    if (failed || !results.length) {
      outcomes.set(entry.item.id, { id: entry.item.id, ok: false, error: failed?.error ?? "Google Docs did not report a result for this change." });
      continue;
    }
    outcomes.set(entry.item.id, {
      id: entry.item.id,
      ok: true,
      result: { trackedChange: false, matches: entry.matches, matchIndex: entry.matchIndex, strategy: entry.plan.strategy }
    });
  }
  return items.map((item) => outcomes.get(item.id) ?? { id: item.id, ok: false, error: "Not applied." });
}

async function commentSuggestion(): Promise<{ matches: number; matchIndex: number }> {
  throw new Error("Google Docs cannot take a comment from Writer — apply the change, or copy the note into a Docs comment.");
}

async function readInlinePictureBase64(index: number): Promise<{ base64: string; width: number | null; height: number | null }> {
  const payload = await callScript<DocsImageBytesPayload>("nebulaReadImage", index);
  return { base64: payload.base64, width: payload.width, height: payload.height };
}

async function replaceInlinePicture(index: number, base64: string): Promise<{ trackedChange: boolean }> {
  const mime = /^iVBOR/.test(base64) ? "image/png" : /^\/9j\//.test(base64) ? "image/jpeg" : /^R0lGOD/.test(base64) ? "image/gif" : /^UklGR/.test(base64) ? "image/webp" : "image/png";
  await callScript("nebulaReplaceImage", index, base64, mime);
  return { trackedChange: false };
}

async function selectInlinePicture(index: number): Promise<void> {
  await callScript("nebulaSelectImage", index);
}

async function commentInlinePicture(): Promise<void> {
  throw new Error("Google Docs cannot take a comment from Writer.");
}

export const googleDocsHost: DocumentHost = {
  waitForHost,
  detectCapabilities,
  readDocumentSnapshot,
  readFocus,
  subscribeSelectionChanges,
  subscribeParagraphChanges,
  findSuggestionMatches,
  locateSuggestion,
  applySuggestions,
  commentSuggestion,
  readInlinePictureBase64,
  replaceInlinePicture,
  selectInlinePicture,
  commentInlinePicture
};
