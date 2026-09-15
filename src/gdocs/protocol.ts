/**
 * What the review pane and the Apps Script side of the Google Docs add-in
 * exchange. The script runs in Google's cloud with the user's document; the
 * pane runs in a sidebar iframe served by the local sidecar. Payloads are
 * plain JSON (Apps Script can return nothing else).
 */

import type { EmphasisSpan } from "../emphasis";

export interface DocsParagraphPayload {
  text: string;
  headingLevel: number | null;
  isListItem: boolean;
  /** Google's heading name ("Heading 1", "Title", "Normal"). */
  style: string;
  /** Emphasis relative to this paragraph's text. */
  emphasis: EmphasisSpan[];
}

export interface DocsImagePayload {
  index: number;
  paragraphIndex: number;
  width: number | null;
  height: number | null;
  altText: string | null;
}

export interface DocsDocumentPayload {
  documentName: string;
  documentId: string;
  paragraphs: DocsParagraphPayload[];
  images: DocsImagePayload[];
  /** Changes whenever the document text changes; polled for re-reads. */
  fingerprint: string;
}

export interface DocsSelectionPayload {
  startParagraph: number;
  startOffset: number;
  endParagraph: number;
  /** Exclusive. */
  endOffset: number;
  text: string;
}

export interface DocsFocusPayload {
  paragraphIndex: number | null;
  paragraphText: string | null;
  /** Caret offset within the paragraph. */
  offset: number;
  selection: DocsSelectionPayload | null;
  fingerprint: string;
}

/** A text range by paragraph coordinates; offsets are within the paragraph text, `end` exclusive. */
export interface DocsTextRange {
  paragraphIndex: number;
  start: number;
  endParagraphIndex: number;
  end: number;
}

/**
 * Replace the range with `text` (may contain "\n": new paragraphs). `expected`
 * is the text the range holds now (paragraphs joined with "\n") and is
 * verified before anything changes. `emphasis` (relative to `text`) replaces
 * the emphasis on the new text when present; null leaves what Docs gives the
 * inserted text. `highlight` colours the new text so the author can see what
 * changed. When `text` equals `expected`, only the formatting is applied.
 */
export interface DocsReplaceOp extends DocsTextRange {
  id: string;
  expected: string;
  text: string;
  emphasis: EmphasisSpan[] | null;
  highlight: boolean;
}

export interface DocsOpOutcome {
  id: string;
  ok: boolean;
  error?: string;
}

export interface DocsImageBytesPayload {
  base64: string;
  mime: string;
  width: number | null;
  height: number | null;
}

/** Names of the script functions the sidebar may call (`google.script.run[name]`). */
export const DOCS_SCRIPT_FUNCTIONS = [
  "nebulaReadDocument",
  "nebulaReadFocus",
  "nebulaFocusKey",
  "nebulaFingerprint",
  "nebulaSelect",
  "nebulaApply",
  "nebulaReadImage",
  "nebulaReplaceImage",
  "nebulaSelectImage"
] as const;

export type DocsScriptFunction = (typeof DOCS_SCRIPT_FUNCTIONS)[number];

/** Background colour for text Writer changed (when the highlight option is on). */
export const DOCS_CHANGE_HIGHLIGHT = "#fff2a8";
/** Background colour used for ==highlight== emphasis. */
export const DOCS_EMPHASIS_HIGHLIGHT = "#ffff00";
