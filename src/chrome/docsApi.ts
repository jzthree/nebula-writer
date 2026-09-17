/**
 * Google Docs REST API ↔ the add-in protocol, for the Chrome extension host.
 * `documents.get` JSON becomes the same DocsDocumentPayload the Apps Script
 * add-in produces (plus an index map from paragraph offsets to API indices),
 * and DocsReplaceOps become `documents.batchUpdate` requests. Pure: no
 * fetching, no chrome APIs, so it is fully unit-testable.
 *
 * API indices are UTF-16 code units, end-exclusive — the same units as JS
 * string offsets, so a paragraph offset maps to an index by addition, except
 * where non-text elements (inline images, equations) occupy index space
 * without contributing text.
 */

import { bridgeEmphasisGaps, emphasisFromPieces, splitByEmphasis, type EmphasisFormat, type EmphasisSpan } from "../emphasis";
import { DOCS_CHANGE_HIGHLIGHT, DOCS_EMPHASIS_HIGHLIGHT, type DocsDocumentPayload, type DocsImagePayload, type DocsOpOutcome, type DocsParagraphPayload, type DocsReplaceOp } from "../gdocs/protocol";

/* ------------------------------------------------------------------------- */
/* The slice of the Docs API JSON we read                                    */
/* ------------------------------------------------------------------------- */

export interface ApiColor {
  color?: { rgbColor?: { red?: number; green?: number; blue?: number } };
}

export interface ApiTextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  backgroundColor?: ApiColor;
}

export interface ApiParagraphElement {
  startIndex?: number;
  endIndex?: number;
  textRun?: { content?: string; textStyle?: ApiTextStyle };
  inlineObjectElement?: { inlineObjectId?: string; textStyle?: ApiTextStyle };
  [other: string]: unknown;
}

export interface ApiParagraph {
  elements?: ApiParagraphElement[];
  paragraphStyle?: { namedStyleType?: string };
  bullet?: { listId?: string; nestingLevel?: number };
}

export interface ApiStructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: ApiParagraph;
  table?: { tableRows?: Array<{ tableCells?: Array<{ content?: ApiStructuralElement[] }> }> };
  tableOfContents?: { content?: ApiStructuralElement[] };
  sectionBreak?: unknown;
}

export interface ApiDocument {
  documentId?: string;
  title?: string;
  revisionId?: string;
  body?: { content?: ApiStructuralElement[] };
  inlineObjects?: Record<string, {
    inlineObjectProperties?: {
      embeddedObject?: {
        title?: string;
        description?: string;
        imageProperties?: { contentUri?: string };
        size?: { width?: { magnitude?: number; unit?: string }; height?: { magnitude?: number; unit?: string } };
      };
    };
  }>;
}

/* ------------------------------------------------------------------------- */
/* Parsing                                                                   */
/* ------------------------------------------------------------------------- */

/** One paragraph's mapping from text offsets to API indices: text pieces and index gaps in order. */
interface ParagraphIndex {
  /** API index of the paragraph's first unit. */
  startIndex: number;
  /** API index just past the paragraph's trailing newline. */
  endIndex: number;
  /** Segments in order: text of `length` units at `apiStart`, or a gap of `length` non-text units. */
  segments: Array<{ apiStart: number; textStart: number; length: number; text: boolean }>;
  textLength: number;
}

export interface DocsIndex {
  paragraphs: ParagraphIndex[];
  imageIds: string[];
  revisionId: string;
}

export interface ParsedDocument {
  payload: DocsDocumentPayload;
  index: DocsIndex;
}

const HEADING_LEVELS: Record<string, { level: number | null; style: string }> = {
  TITLE: { level: 1, style: "Title" },
  SUBTITLE: { level: null, style: "Subtitle" },
  HEADING_1: { level: 1, style: "Heading 1" },
  HEADING_2: { level: 2, style: "Heading 2" },
  HEADING_3: { level: 3, style: "Heading 3" },
  HEADING_4: { level: 4, style: "Heading 4" },
  HEADING_5: { level: 5, style: "Heading 5" },
  HEADING_6: { level: 6, style: "Heading 6" }
};

function backgroundHex(style: ApiTextStyle | undefined): string | null {
  const rgb = style?.backgroundColor?.color?.rgbColor;
  if (!rgb) {
    return null;
  }
  const channel = (value: number | undefined) => Math.round((value ?? 0) * 255).toString(16).padStart(2, "0");
  return `#${channel(rgb.red)}${channel(rgb.green)}${channel(rgb.blue)}`;
}

function formatOf(style: ApiTextStyle | undefined): EmphasisFormat {
  const background = backgroundHex(style);
  return {
    ...(style?.bold ? { bold: true } : {}),
    ...(style?.italic ? { italic: true } : {}),
    ...(style?.underline ? { underline: true } : {}),
    ...(background && background.toLowerCase() !== DOCS_CHANGE_HIGHLIGHT ? { highlight: true } : {})
  };
}

/** Turn a documents.get response into the add-in payload plus the index map the batch builder needs. */
export function parseDocument(doc: ApiDocument): ParsedDocument {
  const paragraphs: DocsParagraphPayload[] = [];
  const indexes: ParagraphIndex[] = [];
  const images: DocsImagePayload[] = [];
  const imageIds: string[] = [];

  const visit = (elements: ApiStructuralElement[] | undefined) => {
    for (const element of elements ?? []) {
      if (element.paragraph) {
        const paragraphIndex = paragraphs.length;
        const parsed = parseParagraph(element, paragraphIndex, doc, images, imageIds);
        paragraphs.push(parsed.payload);
        indexes.push(parsed.index);
      } else if (element.table) {
        for (const row of element.table.tableRows ?? []) {
          for (const cell of row.tableCells ?? []) {
            visit(cell.content);
          }
        }
      } else if (element.tableOfContents) {
        visit(element.tableOfContents.content);
      }
    }
  };
  visit(doc.body?.content);

  return {
    payload: {
      documentName: doc.title ?? "",
      documentId: doc.documentId ?? "",
      paragraphs,
      images,
      fingerprint: doc.revisionId ?? ""
    },
    index: { paragraphs: indexes, imageIds, revisionId: doc.revisionId ?? "" }
  };
}

function parseParagraph(element: ApiStructuralElement, paragraphIndex: number, doc: ApiDocument, images: DocsImagePayload[], imageIds: string[]): { payload: DocsParagraphPayload; index: ParagraphIndex } {
  const paragraph = element.paragraph as ApiParagraph;
  const startIndex = element.startIndex ?? 0;
  const endIndex = element.endIndex ?? startIndex;
  const segments: ParagraphIndex["segments"] = [];
  const pieces: Array<{ text: string; format: EmphasisFormat | null }> = [];
  let text = "";
  const parts = paragraph.elements ?? [];
  parts.forEach((part, partIndex) => {
    const partStart = part.startIndex ?? startIndex;
    const partEnd = part.endIndex ?? partStart;
    if (part.textRun) {
      let content = part.textRun.content ?? "";
      // The paragraph's last run carries the paragraph mark; it is index space, not text.
      const last = partIndex === parts.length - 1;
      const trailingNewline = last && content.endsWith("\n");
      if (trailingNewline) {
        content = content.slice(0, -1);
      }
      if (content) {
        segments.push({ apiStart: partStart, textStart: text.length, length: content.length, text: true });
        pieces.push({ text: content, format: formatOf(part.textRun.textStyle) });
        text += content;
      }
      if (trailingNewline) {
        segments.push({ apiStart: partStart + content.length, textStart: text.length, length: 1, text: false });
      }
      return;
    }
    if (part.inlineObjectElement?.inlineObjectId) {
      const id = part.inlineObjectElement.inlineObjectId;
      const object = doc.inlineObjects?.[id]?.inlineObjectProperties?.embeddedObject;
      if (object?.imageProperties) {
        images.push({
          index: imageIds.length,
          paragraphIndex,
          width: object.size?.width?.magnitude ?? null,
          height: object.size?.height?.magnitude ?? null,
          altText: object.description || object.title || null
        });
        imageIds.push(id);
      }
    }
    // Any non-text element (image, equation, footnote reference…) occupies index space only.
    segments.push({ apiStart: partStart, textStart: text.length, length: Math.max(1, partEnd - partStart), text: false });
  });

  const style = HEADING_LEVELS[paragraph.paragraphStyle?.namedStyleType ?? ""] ?? { level: null, style: "Normal" };
  return {
    payload: {
      text,
      headingLevel: style.level,
      isListItem: Boolean(paragraph.bullet),
      style: style.style,
      emphasis: bridgeEmphasisGaps(text, emphasisFromPieces(pieces))
    },
    index: { startIndex, endIndex, segments, textLength: text.length }
  };
}

/** API index of a text offset within a paragraph (offset == textLength maps just past the last character). */
export function apiIndexOf(paragraph: ParagraphIndex, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, paragraph.textLength));
  let lastText: ParagraphIndex["segments"][number] | null = null;
  for (const segment of paragraph.segments) {
    if (!segment.text) {
      continue;
    }
    if (clamped >= segment.textStart && clamped < segment.textStart + segment.length) {
      return segment.apiStart + (clamped - segment.textStart);
    }
    lastText = segment;
  }
  // Past the last character: right after the final text segment (before the paragraph mark).
  if (lastText) {
    return lastText.apiStart + lastText.length;
  }
  return paragraph.startIndex;
}

/* ------------------------------------------------------------------------- */
/* Applying: DocsReplaceOp → batchUpdate requests                            */
/* ------------------------------------------------------------------------- */

export interface BatchPlan {
  /** Requests in the order to send them (later text first, so earlier indices stay valid). */
  requests: Array<Record<string, unknown>>;
  /** Outcomes for operations that were rejected up front (text mismatch, missing paragraph). */
  rejected: DocsOpOutcome[];
  /** Ids of the operations the requests cover, in request order. */
  accepted: string[];
}

function rangeText(payload: DocsDocumentPayload, op: DocsReplaceOp): string | null {
  const first = payload.paragraphs[op.paragraphIndex]?.text;
  const last = payload.paragraphs[op.endParagraphIndex]?.text;
  if (first === undefined || last === undefined) {
    return null;
  }
  if (op.paragraphIndex === op.endParagraphIndex) {
    return first.slice(op.start, op.end);
  }
  const middle = payload.paragraphs.slice(op.paragraphIndex + 1, op.endParagraphIndex).map((paragraph) => paragraph.text);
  return [first.slice(op.start), ...middle, last.slice(0, op.end)].join("\n");
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function rgb(hex: string): { color: { rgbColor: { red: number; green: number; blue: number } } } {
  const value = hex.replace("#", "");
  return {
    color: {
      rgbColor: {
        red: parseInt(value.slice(0, 2), 16) / 255,
        green: parseInt(value.slice(2, 4), 16) / 255,
        blue: parseInt(value.slice(4, 6), 16) / 255
      }
    }
  };
}

function styleRequest(startIndex: number, endIndex: number, style: Record<string, unknown>, fields: string): Record<string, unknown> {
  return { updateTextStyle: { range: { startIndex, endIndex }, textStyle: style, fields } };
}

/**
 * Requests for a set of operations against the document `parsed` describes.
 * Every operation's `expected` text is checked against the parsed text first.
 * Operations are ordered last-in-document first, and within one operation
 * the delete comes before the insert and the formatting after it, so each
 * request's indices are valid when it runs.
 */
export function buildBatchPlan(parsed: ParsedDocument, ops: DocsReplaceOp[]): BatchPlan {
  const requests: Array<Record<string, unknown>> = [];
  const rejected: DocsOpOutcome[] = [];
  const accepted: string[] = [];
  const ordered = [...ops].sort((a, b) => (b.paragraphIndex - a.paragraphIndex) || (b.start - a.start));
  for (const op of ordered) {
    const current = rangeText(parsed.payload, op);
    const first = parsed.index.paragraphs[op.paragraphIndex];
    const last = parsed.index.paragraphs[op.endParagraphIndex];
    if (current === null || !first || !last) {
      rejected.push({ id: op.id, ok: false, error: "The paragraph to change no longer exists — re-read the document." });
      continue;
    }
    if (collapse(current) !== collapse(op.expected)) {
      rejected.push({ id: op.id, ok: false, error: "The text to change has moved or changed since the suggestion was made." });
      continue;
    }
    const startIndex = apiIndexOf(first, op.start);
    const endIndex = apiIndexOf(last, op.end);
    const unchanged = op.text === current;
    if (!unchanged) {
      if (endIndex > startIndex) {
        requests.push({ deleteContentRange: { range: { startIndex, endIndex } } });
      }
      if (op.text) {
        requests.push({ insertText: { location: { index: startIndex }, text: op.text } });
      }
    }
    const insertedEnd = startIndex + op.text.length;
    if (op.text) {
      if (op.emphasis) {
        // Exactly the requested emphasis: clear, then set each run. Newlines are skipped (paragraph marks take no style).
        requests.push(styleRequest(startIndex, insertedEnd, { bold: false, italic: false, underline: false, backgroundColor: {} }, "bold,italic,underline,backgroundColor"));
        let cursor = 0;
        for (const run of splitByEmphasis(op.text, op.emphasis)) {
          const from = startIndex + cursor;
          const to = from + run.text.length;
          cursor += run.text.length;
          const style: Record<string, unknown> = {};
          const fields: string[] = [];
          if (run.format.bold) { style.bold = true; fields.push("bold"); }
          if (run.format.italic) { style.italic = true; fields.push("italic"); }
          if (run.format.underline) { style.underline = true; fields.push("underline"); }
          if (run.format.highlight) { style.backgroundColor = rgb(DOCS_EMPHASIS_HIGHLIGHT); fields.push("backgroundColor"); }
          if (fields.length && run.text.trim()) {
            requests.push(styleRequest(from, to, style, fields.join(",")));
          }
        }
      }
      if (op.highlight && !unchanged) {
        requests.push(styleRequest(startIndex, insertedEnd, { backgroundColor: rgb(DOCS_CHANGE_HIGHLIGHT) }, "backgroundColor"));
      }
    }
    accepted.push(op.id);
  }
  return { requests, rejected, accepted };
}

/** The content URI of the Nth inline image, for reading its bytes. */
export function imageContentUri(doc: ApiDocument, index: DocsIndex, imageIndex: number): string | null {
  const id = index.imageIds[imageIndex];
  return id ? doc.inlineObjects?.[id]?.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri ?? null : null;
}

/** Emphasis spans over a Docs text run list — exported for tests of the style mapping. */
export function emphasisOfRuns(runs: Array<{ content: string; textStyle?: ApiTextStyle }>): EmphasisSpan[] {
  const text = runs.map((run) => run.content).join("");
  return bridgeEmphasisGaps(text, emphasisFromPieces(runs.map((run) => ({ text: run.content, format: formatOf(run.textStyle) }))));
}
