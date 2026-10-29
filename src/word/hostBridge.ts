/**
 * The document host behind the review pane. The pane was written against
 * Microsoft Word (Office.js); Google Docs is a second host with the same
 * contract. Every host call the pane makes goes through this module, and the
 * entry point of each add-in installs its host before rendering.
 */

import type { AiSuggestion } from "../shared";
import type { WordDocumentSnapshot, WordFocusState } from "./wordContext";
import * as word from "./wordHost";
import type {
  FocusOptions,
  SnapshotOptions,
  ApplyResult,
  BatchApplyItem,
  BatchApplyOptions,
  BatchApplyOutcome,
  SuggestionMatchSet,
  WordCapabilities,
  WordHostBoot
} from "./wordHost";

export type { ApplyResult, BatchApplyItem, BatchApplyOptions, BatchApplyOutcome, SuggestionMatch, SuggestionMatchSet, WordCapabilities, WordHostBoot } from "./wordHost";
export { chooseMatchIndex, toWordSearchText } from "./wordHost";

export interface DocumentHost {
  /** Wait for the host application and report whether the pane runs inside it. */
  waitForHost(timeoutMs?: number): Promise<WordHostBoot>;
  detectCapabilities(host: boolean): WordCapabilities;
  readDocumentSnapshot(capabilities: WordCapabilities, options?: SnapshotOptions): Promise<WordDocumentSnapshot>;
  readFocus(snapshot: WordDocumentSnapshot, capabilities: WordCapabilities, previous?: WordFocusState | null, options?: FocusOptions): Promise<WordFocusState>;
  /** Synchronous: returns the unsubscribe function. */
  subscribeSelectionChanges(handler: () => void): () => void;
  subscribeParagraphChanges(handler: () => void, capabilities: WordCapabilities): Promise<(() => Promise<void>) | null>;
  findSuggestionMatches(snapshot: WordDocumentSnapshot, suggestion: Pick<AiSuggestion, "original">): Promise<SuggestionMatchSet>;
  locateSuggestion(snapshot: WordDocumentSnapshot, suggestion: Pick<AiSuggestion, "original">, matchIndex: number): Promise<{ matches: number; matchIndex: number }>;
  applySuggestions(snapshot: WordDocumentSnapshot, items: BatchApplyItem[], options: BatchApplyOptions): Promise<BatchApplyOutcome[]>;
  commentSuggestion(snapshot: WordDocumentSnapshot, suggestion: Pick<AiSuggestion, "original">, text: string, matchIndex: number): Promise<{ matches: number; matchIndex: number }>;
  readInlinePictureBase64(index: number): Promise<{ base64: string; width: number | null; height: number | null }>;
  replaceInlinePicture(index: number, base64: string, options: { trackChanges: "always" | "word" }): Promise<{ trackedChange: boolean }>;
  selectInlinePicture(index: number): Promise<void>;
  commentInlinePicture(index: number, text: string): Promise<void>;
  /**
   * Apply a table suggestion (kind "table"): insert its grid after the
   * paragraph holding `original` (match `matchIndex`), or morph/delete the
   * table it was made for (found by its `before` grid, see findEditTarget).
   * Fails without changing anything when that table is gone or changed.
   */
  applyTableEdit(snapshot: WordDocumentSnapshot, suggestion: AiSuggestion, options: TableApplyOptions): Promise<{ trackedChange: boolean }>;
  /** Select a table (by its index in the snapshot) so the author sees it. */
  selectTable(snapshot: WordDocumentSnapshot, index: number): Promise<void>;
}

export interface TableApplyOptions {
  trackChanges: "always" | "word";
  highlightChanges: boolean;
  /** insert: which occurrence of `original` to insert after (null: chosen from the anchor). */
  matchIndex: number | null;
}

/** Microsoft Word through Office.js — the original host. */
export const wordDocumentHost: DocumentHost = {
  waitForHost: word.waitForWordHost,
  detectCapabilities: word.detectCapabilities,
  readDocumentSnapshot: word.readDocumentSnapshot,
  readFocus: word.readFocus,
  subscribeSelectionChanges: word.subscribeSelectionChanges,
  subscribeParagraphChanges: word.subscribeParagraphChanges,
  findSuggestionMatches: word.findSuggestionMatches,
  locateSuggestion: word.locateSuggestion,
  applySuggestions: word.applySuggestions,
  commentSuggestion: word.commentSuggestion,
  readInlinePictureBase64: word.readInlinePictureBase64,
  replaceInlinePicture: word.replaceInlinePicture,
  selectInlinePicture: word.selectInlinePicture,
  commentInlinePicture: word.commentInlinePicture,
  applyTableEdit: word.applyTableEdit,
  selectTable: word.selectTable
};

let active: DocumentHost = wordDocumentHost;

/** Install the host for this add-in (before the pane renders). */
export function setDocumentHost(host: DocumentHost): void {
  active = host;
}

export function activeDocumentHost(): DocumentHost {
  return active;
}

// Delegates with the names the pane has always imported.
export const waitForWordHost: DocumentHost["waitForHost"] = (timeoutMs) => active.waitForHost(timeoutMs);
export const detectCapabilities: DocumentHost["detectCapabilities"] = (host) => active.detectCapabilities(host);
export const readDocumentSnapshot: DocumentHost["readDocumentSnapshot"] = (capabilities, options) => active.readDocumentSnapshot(capabilities, options);
export const readFocus: DocumentHost["readFocus"] = (snapshot, capabilities, previous, options) => active.readFocus(snapshot, capabilities, previous, options);
export const subscribeSelectionChanges: DocumentHost["subscribeSelectionChanges"] = (handler) => active.subscribeSelectionChanges(handler);
export const subscribeParagraphChanges: DocumentHost["subscribeParagraphChanges"] = (handler, capabilities) => active.subscribeParagraphChanges(handler, capabilities);
export const findSuggestionMatches: DocumentHost["findSuggestionMatches"] = (snapshot, suggestion) => active.findSuggestionMatches(snapshot, suggestion);
export const locateSuggestion: DocumentHost["locateSuggestion"] = (snapshot, suggestion, matchIndex) => active.locateSuggestion(snapshot, suggestion, matchIndex);
export const applySuggestions: DocumentHost["applySuggestions"] = (snapshot, items, options) => active.applySuggestions(snapshot, items, options);
export const commentSuggestion: DocumentHost["commentSuggestion"] = (snapshot, suggestion, text, matchIndex) => active.commentSuggestion(snapshot, suggestion, text, matchIndex);
export const readInlinePictureBase64: DocumentHost["readInlinePictureBase64"] = (index) => active.readInlinePictureBase64(index);
export const replaceInlinePicture: DocumentHost["replaceInlinePicture"] = (index, base64, options) => active.replaceInlinePicture(index, base64, options);
export const selectInlinePicture: DocumentHost["selectInlinePicture"] = (index) => active.selectInlinePicture(index);
export const commentInlinePicture: DocumentHost["commentInlinePicture"] = (index, text) => active.commentInlinePicture(index, text);
export const applyTableEdit: DocumentHost["applyTableEdit"] = (snapshot, suggestion, options) => active.applyTableEdit(snapshot, suggestion, options);
export const selectTable: DocumentHost["selectTable"] = (snapshot, index) => active.selectTable(snapshot, index);
