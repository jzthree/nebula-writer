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
import { DOCS_CHANGE_HIGHLIGHT, DOCS_EMPHASIS_HIGHLIGHT, type DocsDocumentPayload, type DocsImagePayload, type DocsOpOutcome, type DocsParagraphPayload, type DocsReplaceOp, type DocsTableOp } from "../gdocs/protocol";
import { columnCount, findEditTarget, planTableMorph, type DocumentTable, type TableStep } from "../tables";

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

export interface ApiTableCell {
  startIndex?: number;
  endIndex?: number;
  content?: ApiStructuralElement[];
  tableCellStyle?: { rowSpan?: number; columnSpan?: number };
}

export interface ApiStructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: ApiParagraph;
  table?: { rows?: number; columns?: number; tableRows?: Array<{ tableCells?: ApiTableCell[] }> };
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

/** Where a cell's content sits: from its first paragraph's start to its last paragraph mark (exclusive end). */
interface CellIndex {
  startIndex: number;
  endIndex: number;
  /** Indices (in payload.paragraphs) of the cell's own paragraphs. */
  paragraphs: number[];
  /** Holds something other than paragraphs (a nested table): its text cannot be rewritten safely. */
  nested: boolean;
}

/** A top-level table's index range and cell map. */
export interface TableIndex {
  startIndex: number;
  endIndex: number;
  cells: CellIndex[][];
}

export interface DocsIndex {
  paragraphs: ParagraphIndex[];
  imageIds: string[];
  /** API index of each inline image (same order as imageIds). */
  imageStarts: number[];
  /** Top-level tables, parallel to payload.tables. */
  tables: TableIndex[];
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

/** How many paragraphs `parseDocument` reads from an element (tables and contents lists included). */
function paragraphCount(element: ApiStructuralElement): number {
  if (element.paragraph) {
    return 1;
  }
  const children = element.table
    ? (element.table.tableRows ?? []).flatMap((row) => (row.tableCells ?? []).flatMap((cell) => cell.content ?? []))
    : element.tableOfContents?.content ?? [];
  return children.reduce((sum, child) => sum + paragraphCount(child), 0);
}

/** Turn a documents.get response into the add-in payload plus the index map the batch builder needs. */
export function parseDocument(doc: ApiDocument): ParsedDocument {
  const paragraphs: DocsParagraphPayload[] = [];
  const indexes: ParagraphIndex[] = [];
  const images: DocsImagePayload[] = [];
  const imageIds: string[] = [];
  const imageStarts: number[] = [];
  const tables: DocumentTable[] = [];
  const tableIndexes: TableIndex[] = [];

  const visit = (elements: ApiStructuralElement[] | undefined, topLevel: boolean) => {
    let previousText: string | null = null;
    for (const element of elements ?? []) {
      if (element.paragraph) {
        const paragraphIndex = paragraphs.length;
        const parsed = parseParagraph(element, paragraphIndex, doc, images, imageIds, imageStarts);
        paragraphs.push(parsed.payload);
        indexes.push(parsed.index);
        previousText = parsed.payload.text;
      } else if (element.table) {
        const firstParagraph = paragraphs.length;
        const rows: string[][] = [];
        const cells: CellIndex[][] = [];
        let irregular = false;
        for (const row of element.table.tableRows ?? []) {
          const rowTexts: string[] = [];
          const rowCells: CellIndex[] = [];
          for (const cell of row.tableCells ?? []) {
            const before = paragraphs.length;
            visit(cell.content, false);
            const own = (cell.content ?? []).filter((item) => item.paragraph);
            const nested = (cell.content ?? []).some((item) => !item.paragraph);
            // The cell's own paragraphs are the ones directly in its content (nested tables add more after them).
            const ownIndexes: number[] = [];
            let cursor = before;
            for (const item of cell.content ?? []) {
              if (item.paragraph) {
                ownIndexes.push(cursor);
                cursor += 1;
              } else {
                cursor += paragraphCount(item);
              }
            }
            rowTexts.push(ownIndexes.map((index) => paragraphs[index].text).join("\n"));
            const first = own[0];
            const last = own[own.length - 1];
            rowCells.push({
              startIndex: first?.startIndex ?? cell.startIndex ?? 0,
              endIndex: last?.endIndex ?? cell.endIndex ?? 0,
              paragraphs: ownIndexes,
              nested
            });
            if ((cell.tableCellStyle?.columnSpan ?? 1) > 1 || (cell.tableCellStyle?.rowSpan ?? 1) > 1 || nested) {
              irregular = true;
            }
          }
          rows.push(rowTexts);
          cells.push(rowCells);
        }
        if (rows.some((row) => row.length !== rows[0]?.length)) {
          irregular = true;
        }
        if (topLevel) {
          tables.push({
            index: tables.length,
            rows,
            paragraphIndex: paragraphs.length > firstParagraph ? firstParagraph : null,
            context: previousText,
            ...(irregular ? { irregular: true } : {})
          });
          tableIndexes.push({ startIndex: element.startIndex ?? 0, endIndex: element.endIndex ?? 0, cells });
        }
        previousText = null;
      } else if (element.tableOfContents) {
        visit(element.tableOfContents.content, false);
      }
    }
  };
  visit(doc.body?.content, true);

  return {
    payload: {
      documentName: doc.title ?? "",
      documentId: doc.documentId ?? "",
      paragraphs,
      images,
      tables,
      fingerprint: doc.revisionId ?? ""
    },
    index: { paragraphs: indexes, imageIds, imageStarts, tables: tableIndexes, revisionId: doc.revisionId ?? "" }
  };
}

function parseParagraph(element: ApiStructuralElement, paragraphIndex: number, doc: ApiDocument, images: DocsImagePayload[], imageIds: string[], imageStarts: number[]): { payload: DocsParagraphPayload; index: ParagraphIndex } {
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
        imageStarts.push(partStart);
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

/* ------------------------------------------------------------------------- */
/* Tables                                                                    */
/* ------------------------------------------------------------------------- */

type ApiRequest = Record<string, unknown>;

function cellLocation(table: TableIndex, rowIndex: number, columnIndex: number): Record<string, unknown> {
  return { tableStartLocation: { index: table.startIndex }, rowIndex, columnIndex };
}

/**
 * Requests for a morph's row/column steps, in order. Each step's indices
 * refer to the table as the requests before it left it; the table's own
 * start index does not move while its rows and columns change.
 */
export function buildTableStructureRequests(table: TableIndex, steps: TableStep[]): ApiRequest[] {
  const requests: ApiRequest[] = [];
  for (const step of steps) {
    switch (step.type) {
      case "deleteRow":
        requests.push({ deleteTableRow: { tableCellLocation: cellLocation(table, step.row, 0) } });
        break;
      case "deleteColumn":
        requests.push({ deleteTableColumn: { tableCellLocation: cellLocation(table, 0, step.column) } });
        break;
      case "insertRow":
        requests.push({ insertTableRow: step.at === 0
          ? { tableCellLocation: cellLocation(table, 0, 0), insertBelow: false }
          : { tableCellLocation: cellLocation(table, step.at - 1, 0), insertBelow: true } });
        break;
      case "insertColumn":
        requests.push({ insertTableColumn: step.at === 0
          ? { tableCellLocation: cellLocation(table, 0, 0), insertRight: false }
          : { tableCellLocation: cellLocation(table, 0, step.at - 1), insertRight: true } });
        break;
      default:
        break;
    }
  }
  return requests;
}

/**
 * Requests that set cell texts in a freshly read table: each cell's text
 * (all but its final paragraph mark) is deleted and the new text inserted,
 * later cells first so earlier indices stay valid. `bold` rows get bold
 * text (a header); `highlight` colours the new text.
 */
export function buildTableCellRequests(
  table: TableIndex,
  cells: Array<{ row: number; column: number; text: string }>,
  options: { highlight: boolean; boldRows?: number[] }
): ApiRequest[] {
  const located = cells.map((cell) => {
    const index = table.cells[cell.row]?.[cell.column];
    if (!index) {
      throw new Error(`The table has no cell at row ${cell.row + 1}, column ${cell.column + 1}.`);
    }
    if (index.nested) {
      throw new Error(`The cell at row ${cell.row + 1}, column ${cell.column + 1} holds a nested table; Writer does not rewrite it.`);
    }
    return { ...cell, index };
  }).sort((a, b) => b.index.startIndex - a.index.startIndex);
  const requests: ApiRequest[] = [];
  for (const cell of located) {
    const start = cell.index.startIndex;
    const end = cell.index.endIndex - 1;
    if (end > start) {
      requests.push({ deleteContentRange: { range: { startIndex: start, endIndex: end } } });
    }
    const text = cell.text.replace(/\r\n?/g, "\n");
    if (!text) {
      continue;
    }
    requests.push({ insertText: { location: { index: start }, text } });
    if (options.boldRows?.includes(cell.row)) {
      requests.push(styleRequest(start, start + text.length, { bold: true }, "bold"));
    }
    if (options.highlight) {
      requests.push(styleRequest(start, start + text.length, { backgroundColor: rgb(DOCS_CHANGE_HIGHLIGHT) }, "backgroundColor"));
    }
  }
  return requests;
}

/** Where a new table goes after a paragraph: before its mark, or after the table it sits in. */
export function tableInsertLocation(parsed: ParsedDocument, afterParagraphIndex: number): number {
  const paragraph = parsed.index.paragraphs[afterParagraphIndex];
  if (!paragraph) {
    throw new Error("The paragraph the table should follow no longer exists — re-read the document.");
  }
  const enclosing = parsed.index.tables.find((table) => paragraph.startIndex >= table.startIndex && paragraph.startIndex < table.endIndex);
  // insertTable puts a newline before the table: at the paragraph's last
  // index that ends the paragraph and the table follows it. A paragraph in
  // a table cell would nest the new table, so it goes after that table.
  return enclosing ? enclosing.endIndex : paragraph.endIndex - 1;
}

export interface TableApplyIo {
  read(): Promise<ParsedDocument>;
  batch(requests: ApiRequest[]): Promise<void>;
}

function errorOutcome(id: string, error: string): DocsOpOutcome {
  return { id, ok: false, error };
}

/**
 * Apply a table op in phases (structure, re-read, then cell text), since
 * every structural change shifts the indices of the text after it. Nothing
 * is sent until the target is verified against the document as read now.
 */
export async function applyTableOp(op: DocsTableOp, io: TableApplyIo): Promise<DocsOpOutcome> {
  const parsed = await io.read();
  const tables = parsed.payload.tables ?? [];
  if (op.action === "insert") {
    const rows = op.rows;
    if (!rows?.length || !columnCount(rows)) {
      return errorOutcome(op.id, "The new table has no cells.");
    }
    const at = op.afterParagraphIndex;
    const paragraph = at !== null ? parsed.payload.paragraphs[at] : undefined;
    if (!paragraph || (op.expectedParagraphText !== null && collapse(paragraph.text) !== collapse(op.expectedParagraphText))) {
      return errorOutcome(op.id, "The paragraph the table should follow has moved or changed since the suggestion was made.");
    }
    const location = tableInsertLocation(parsed, at as number);
    const before = parsed.index.tables.filter((table) => table.startIndex < location).length;
    const width = columnCount(rows);
    await io.batch([{ insertTable: { rows: rows.length, columns: width, location: { index: location } } }]);
    const fresh = await io.read();
    const created = fresh.index.tables[before];
    if (!created || created.cells.length !== rows.length || created.cells[0]?.length !== width) {
      return errorOutcome(op.id, "Google Docs inserted the table, but Writer could not find it to fill in. Check the document.");
    }
    const cells = rows.flatMap((row, r) => Array.from({ length: width }, (_, c) => ({ row: r, column: c, text: row[c] ?? "" }))).filter((cell) => cell.text);
    const requests = [
      ...(op.header && rows.length > 1 ? [{ pinTableHeaderRows: { tableStartLocation: { index: created.startIndex }, pinnedHeaderRowsCount: 1 } }] : []),
      ...buildTableCellRequests(created, cells, { highlight: op.highlight, boldRows: op.header ? [0] : [] })
    ];
    if (requests.length) {
      await io.batch(requests);
    }
    return { id: op.id, ok: true };
  }

  const target = findEditTarget(tables, { index: op.index, before: op.before });
  if (target === null) {
    return errorOutcome(op.id, "The table has changed (or is gone) since the suggestion was made — re-run the request on the current table.");
  }
  const table = parsed.index.tables[target];
  if (op.action === "delete") {
    await io.batch([{ deleteContentRange: { range: { startIndex: table.startIndex, endIndex: table.endIndex } } }]);
    return { id: op.id, ok: true };
  }
  if (!op.rows?.length) {
    return errorOutcome(op.id, "The revised table has no rows.");
  }
  const current = tables[target];
  const morph = planTableMorph(current.rows, op.rows, { irregular: current.irregular });
  if (current.irregular && morph.structural) {
    return errorOutcome(op.id, "This table has merged cells, so Writer can change only its cell text, not its rows or columns.");
  }
  const structure = buildTableStructureRequests(table, morph.steps);
  let live = table;
  if (structure.length) {
    await io.batch(structure);
    const fresh = await io.read();
    const reshaped = fresh.index.tables[target];
    const width = columnCount(op.rows);
    if (!reshaped || reshaped.cells.length !== op.rows.length || reshaped.cells.some((row) => row.length !== width)) {
      return errorOutcome(op.id, "Google Docs changed the table's rows and columns, but not into the expected shape. Check the table before applying again.");
    }
    live = reshaped;
  }
  const cells = morph.steps.flatMap((step) => (step.type === "setCell" ? [{ row: step.row, column: step.column, text: step.text }] : []));
  if (cells.length) {
    await io.batch(buildTableCellRequests(live, cells, { highlight: op.highlight }));
  }
  return { id: op.id, ok: true };
}

/** A paragraph to locate so the author sees a table: its first cell with text. */
export function tableLocateParagraph(parsed: ParsedDocument, tableIndex: number): number | null {
  const table = parsed.index.tables[tableIndex];
  if (!table) {
    return null;
  }
  for (const row of table.cells) {
    for (const cell of row) {
      const found = cell.paragraphs.find((index) => parsed.payload.paragraphs[index]?.text.trim());
      if (found !== undefined) {
        return found;
      }
    }
  }
  return null;
}

/** Request deleting inline image `imageIndex` (its one index unit). */
export function deleteImageRequest(index: DocsIndex, imageIndex: number): Record<string, unknown> | null {
  const start = index.imageStarts[imageIndex];
  return start === undefined ? null : { deleteContentRange: { range: { startIndex: start, endIndex: start + 1 } } };
}
