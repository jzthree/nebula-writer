/// <reference types="google-apps-script" />
/**
 * Apps Script side of the Google Docs add-in. Bundled by
 * scripts/gdocs-build.mjs into gdocs/script/Code.js, where each exported
 * function below gets a global stub the sidebar calls through
 * google.script.run. Runs against DocumentApp with the user's own access.
 *
 * Offsets in Apps Script's Text API are END-INCLUSIVE; the protocol uses
 * end-exclusive ranges, converted at the boundary here.
 */

import { bridgeEmphasisGaps, emphasisFromPieces, splitByEmphasis, type EmphasisFormat, type EmphasisSpan } from "../../emphasis";
import {
  DOCS_CHANGE_HIGHLIGHT,
  DOCS_EMPHASIS_HIGHLIGHT,
  type DocsDocumentPayload,
  type DocsFocusPayload,
  type DocsImageBytesPayload,
  type DocsImagePayload,
  type DocsOpOutcome,
  type DocsParagraphPayload,
  type DocsReplaceOp,
  type DocsSelectionPayload,
  type DocsTextRange
} from "../protocol";

type Element = GoogleAppsScript.Document.Element;
type Paragraph = GoogleAppsScript.Document.Paragraph;
type ListItem = GoogleAppsScript.Document.ListItem;
type Text = GoogleAppsScript.Document.Text;
type Block = Paragraph | ListItem;

interface Container {
  getNumChildren(): number;
  getChild(index: number): Element;
}

interface WalkedBlock {
  block: Block;
  /** Child indices from the body down to this block (table → row → cell → block). */
  path: number[];
}

/* ------------------------------------------------------------------------- */
/* Menu                                                                      */
/* ------------------------------------------------------------------------- */

export function onOpen(): void {
  DocumentApp.getUi().createAddonMenu().addItem("Open Writer", "nebulaShowSidebar").addToUi();
}

export function onInstall(): void {
  onOpen();
}

export function nebulaShowSidebar(): void {
  const html = HtmlService.createHtmlOutputFromFile("Sidebar").setTitle("Nebula Writer");
  DocumentApp.getUi().showSidebar(html);
}

/* ------------------------------------------------------------------------- */
/* Reading                                                                   */
/* ------------------------------------------------------------------------- */

function document(): GoogleAppsScript.Document.Document {
  return DocumentApp.getActiveDocument();
}

/** Every paragraph and list item in document order, including those inside table cells. */
function walkBlocks(body: Container): WalkedBlock[] {
  const out: WalkedBlock[] = [];
  const types = DocumentApp.ElementType;
  const visit = (container: Container, prefix: number[]) => {
    const count = container.getNumChildren();
    for (let index = 0; index < count; index += 1) {
      const child = container.getChild(index);
      const type = child.getType();
      if (type === types.PARAGRAPH) {
        out.push({ block: child.asParagraph(), path: [...prefix, index] });
      } else if (type === types.LIST_ITEM) {
        out.push({ block: child.asListItem(), path: [...prefix, index] });
      } else if (type === types.TABLE) {
        const table = child.asTable();
        for (let row = 0; row < table.getNumRows(); row += 1) {
          const tableRow = table.getRow(row);
          for (let cell = 0; cell < tableRow.getNumCells(); cell += 1) {
            visit(tableRow.getCell(cell) as unknown as Container, [...prefix, index, row, cell]);
          }
        }
      }
    }
  };
  visit(body, []);
  return out;
}

function headingLevelOf(block: Block): { level: number | null; style: string } {
  const headings = DocumentApp.ParagraphHeading;
  const heading = block.getHeading();
  const table: Array<[GoogleAppsScript.Document.ParagraphHeading, number, string]> = [
    [headings.TITLE, 1, "Title"],
    [headings.HEADING1, 1, "Heading 1"],
    [headings.HEADING2, 2, "Heading 2"],
    [headings.HEADING3, 3, "Heading 3"],
    [headings.HEADING4, 4, "Heading 4"],
    [headings.HEADING5, 5, "Heading 5"],
    [headings.HEADING6, 6, "Heading 6"]
  ];
  for (const [value, level, style] of table) {
    if (heading === value) {
      return { level, style };
    }
  }
  return { level: null, style: heading === headings.SUBTITLE ? "Subtitle" : "Normal" };
}

function textEmphasis(text: Text): EmphasisSpan[] {
  const full = text.getText();
  if (!full) {
    return [];
  }
  const starts = text.getTextAttributeIndices();
  const pieces: Array<{ text: string; format: EmphasisFormat | null }> = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1] : full.length;
    if (end <= start) {
      continue;
    }
    const background = text.getBackgroundColor(start);
    pieces.push({
      text: full.slice(start, end),
      format: {
        ...(text.isBold(start) ? { bold: true } : {}),
        ...(text.isItalic(start) ? { italic: true } : {}),
        ...(text.isUnderline(start) ? { underline: true } : {}),
        ...(background && background !== DOCS_CHANGE_HIGHLIGHT ? { highlight: true } : {})
      }
    });
  }
  return bridgeEmphasisGaps(full, emphasisFromPieces(pieces));
}

function paragraphPayload(block: Block): DocsParagraphPayload {
  const heading = headingLevelOf(block);
  return {
    text: block.getText(),
    headingLevel: heading.level,
    isListItem: block.getType() === DocumentApp.ElementType.LIST_ITEM,
    style: heading.style,
    emphasis: textEmphasis(block.editAsText())
  };
}

function inlineImagesOf(blocks: WalkedBlock[]): Array<{ image: GoogleAppsScript.Document.InlineImage; paragraphIndex: number }> {
  const images: Array<{ image: GoogleAppsScript.Document.InlineImage; paragraphIndex: number }> = [];
  blocks.forEach((entry, paragraphIndex) => {
    const count = entry.block.getNumChildren();
    for (let index = 0; index < count; index += 1) {
      const child = entry.block.getChild(index);
      if (child.getType() === DocumentApp.ElementType.INLINE_IMAGE) {
        images.push({ image: child.asInlineImage(), paragraphIndex });
      }
    }
  });
  return images;
}

function fingerprintOf(texts: string[]): string {
  let hash = 2166136261;
  let length = 0;
  for (const text of texts) {
    length += text.length + 1;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    hash ^= 10;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${length}:${hash.toString(16)}`;
}

export function nebulaReadDocument(): DocsDocumentPayload {
  const doc = document();
  const blocks = walkBlocks(doc.getBody() as unknown as Container);
  const paragraphs = blocks.map((entry) => paragraphPayload(entry.block));
  const images: DocsImagePayload[] = inlineImagesOf(blocks).map((entry, index) => ({
    index,
    paragraphIndex: entry.paragraphIndex,
    width: numberOrNull(entry.image.getWidth()),
    height: numberOrNull(entry.image.getHeight()),
    altText: entry.image.getAltDescription() || entry.image.getAltTitle() || null
  }));
  return {
    documentName: doc.getName(),
    documentId: doc.getId(),
    paragraphs,
    images,
    fingerprint: fingerprintOf(paragraphs.map((paragraph) => paragraph.text))
  };
}

export function nebulaFingerprint(): string {
  const blocks = walkBlocks(document().getBody() as unknown as Container);
  return fingerprintOf(blocks.map((entry) => entry.block.getText()));
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------------- */
/* Focus: caret and selection                                                */
/* ------------------------------------------------------------------------- */

/** Child-index path of an element from the body, matching `walkBlocks` paths. */
function elementPath(element: Element): number[] {
  const path: number[] = [];
  let current: Element | null = element;
  const types = DocumentApp.ElementType;
  while (current) {
    const parent = current.getParent();
    if (!parent) {
      break;
    }
    const parentType = parent.getType();
    if (parentType === types.BODY_SECTION || parentType === types.DOCUMENT) {
      path.unshift(parent.getChildIndex(current));
      break;
    }
    path.unshift(parent.getChildIndex(current));
    current = parent;
  }
  return path;
}

/** The paragraph or list item containing an element (or the element itself), with the text offset of the element's start within it. */
function enclosingBlock(element: Element): { block: Element; baseOffset: number } | null {
  const types = DocumentApp.ElementType;
  let current: Element | null = element;
  let baseOffset = 0;
  while (current) {
    const type = current.getType();
    if (type === types.PARAGRAPH || type === types.LIST_ITEM) {
      return { block: current, baseOffset };
    }
    const parent = current.getParent();
    if (!parent) {
      return null;
    }
    // Text before this child inside the same parent (paragraphs with inline images hold several children).
    const index = parent.getChildIndex(current);
    for (let sibling = 0; sibling < index; sibling += 1) {
      const child = parent.getChild(sibling);
      if (child.getType() === types.TEXT) {
        baseOffset += child.asText().getText().length;
      }
    }
    current = parent;
  }
  return null;
}

function samePath(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function blockIndexOf(blocks: WalkedBlock[], element: Element): number | null {
  const path = elementPath(element);
  const found = blocks.findIndex((entry) => samePath(entry.path, path));
  return found >= 0 ? found : null;
}

export function nebulaReadFocus(): DocsFocusPayload {
  const doc = document();
  const blocks = walkBlocks(doc.getBody() as unknown as Container);
  const texts = blocks.map((entry) => entry.block.getText());
  const fingerprint = fingerprintOf(texts);
  let paragraphIndex: number | null = null;
  let offset = 0;
  let selection: DocsSelectionPayload | null = null;

  const range = doc.getSelection();
  if (range) {
    const elements = range.getRangeElements();
    if (elements.length) {
      const first = elements[0];
      const last = elements[elements.length - 1];
      const firstBlock = enclosingBlock(first.getElement());
      const lastBlock = enclosingBlock(last.getElement());
      if (firstBlock && lastBlock) {
        const startParagraph = blockIndexOf(blocks, firstBlock.block);
        const endParagraph = blockIndexOf(blocks, lastBlock.block);
        if (startParagraph !== null && endParagraph !== null) {
          const startOffset = firstBlock.baseOffset + (first.isPartial() ? first.getStartOffset() : 0);
          const lastLength = last.getElement().getType() === DocumentApp.ElementType.TEXT
            ? last.getElement().asText().getText().length
            : texts[endParagraph].length;
          const endOffset = lastBlock.baseOffset + (last.isPartial() ? last.getEndOffsetInclusive() + 1 : lastLength);
          const text = startParagraph === endParagraph
            ? texts[startParagraph].slice(startOffset, endOffset)
            : [texts[startParagraph].slice(startOffset), ...texts.slice(startParagraph + 1, endParagraph), texts[endParagraph].slice(0, endOffset)].join("\n");
          selection = { startParagraph, startOffset, endParagraph, endOffset, text };
          paragraphIndex = startParagraph;
          offset = startOffset;
        }
      }
    }
  }
  if (paragraphIndex === null) {
    const cursor = doc.getCursor();
    if (cursor) {
      const enclosing = enclosingBlock(cursor.getElement());
      if (enclosing) {
        paragraphIndex = blockIndexOf(blocks, enclosing.block);
        offset = enclosing.baseOffset + cursor.getOffset();
      }
    }
  }
  return {
    paragraphIndex,
    paragraphText: paragraphIndex === null ? null : texts[paragraphIndex] ?? null,
    offset,
    selection,
    fingerprint
  };
}

/** A cheap key for polling: changes when the caret, the selection, or the text changes. */
export function nebulaFocusKey(): string {
  const focus = nebulaReadFocus();
  const selection = focus.selection;
  return [
    focus.paragraphIndex ?? "-",
    focus.offset,
    selection ? `${selection.startParagraph}:${selection.startOffset}-${selection.endParagraph}:${selection.endOffset}` : "",
    focus.fingerprint
  ].join("|");
}

/* ------------------------------------------------------------------------- */
/* Selecting                                                                 */
/* ------------------------------------------------------------------------- */

export function nebulaSelect(range: DocsTextRange): void {
  const doc = document();
  const blocks = walkBlocks(doc.getBody() as unknown as Container);
  const builder = doc.newRange();
  const first = blocks[range.paragraphIndex]?.block;
  const last = blocks[range.endParagraphIndex]?.block;
  if (!first || !last) {
    throw new Error("The paragraph to select no longer exists.");
  }
  if (range.paragraphIndex === range.endParagraphIndex) {
    addTextRange(builder, first, range.start, range.end);
  } else {
    addTextRange(builder, first, range.start, first.getText().length);
    for (let index = range.paragraphIndex + 1; index < range.endParagraphIndex; index += 1) {
      builder.addElement(blocks[index].block);
    }
    addTextRange(builder, last, 0, range.end);
  }
  doc.setSelection(builder.build());
}

function addTextRange(builder: GoogleAppsScript.Document.RangeBuilder, block: Block, start: number, end: number): void {
  const length = block.getText().length;
  const from = Math.max(0, Math.min(start, length));
  const to = Math.max(from, Math.min(end, length));
  if (to > from) {
    builder.addElement(block.editAsText(), from, to - 1);
  } else {
    builder.addElement(block);
  }
}

/* ------------------------------------------------------------------------- */
/* Applying                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Apply replace operations, last in the document first so earlier paragraph
 * indices and offsets stay valid. Each operation verifies the text it is
 * about to change; a mismatch fails only that operation.
 */
export function nebulaApply(ops: DocsReplaceOp[]): DocsOpOutcome[] {
  const doc = document();
  const blocks = walkBlocks(doc.getBody() as unknown as Container);
  const ordered = [...ops].sort((a, b) => (b.paragraphIndex - a.paragraphIndex) || (b.start - a.start));
  const outcomes: DocsOpOutcome[] = [];
  for (const op of ordered) {
    try {
      applyReplace(blocks, op);
      outcomes.push({ id: op.id, ok: true });
    } catch (error) {
      outcomes.push({ id: op.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

interface InsertedPiece {
  block: Block;
  start: number;
  end: number;
  /** Offset of this piece's first character within op.text. */
  textOffset: number;
}

function rangeText(blocks: WalkedBlock[], op: DocsTextRange): string {
  const first = blocks[op.paragraphIndex]?.block.getText() ?? "";
  if (op.paragraphIndex === op.endParagraphIndex) {
    return first.slice(op.start, op.end);
  }
  const middle = blocks.slice(op.paragraphIndex + 1, op.endParagraphIndex).map((entry) => entry.block.getText());
  const last = blocks[op.endParagraphIndex]?.block.getText() ?? "";
  return [first.slice(op.start), ...middle, last.slice(0, op.end)].join("\n");
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function applyReplace(blocks: WalkedBlock[], op: DocsReplaceOp): void {
  const first = blocks[op.paragraphIndex]?.block;
  const last = blocks[op.endParagraphIndex]?.block;
  if (!first || !last) {
    throw new Error("The paragraph to change no longer exists — re-read the document.");
  }
  const current = rangeText(blocks, op);
  if (collapse(current) !== collapse(op.expected)) {
    throw new Error("The text to change has moved or changed since the suggestion was made.");
  }
  const lines = op.text.split("\n");
  const pieces: InsertedPiece[] = [];

  if (op.text === current) {
    // Formatting only: the text stays, its emphasis/highlight are applied below.
    pieces.push(...rangePieces(blocks, op));
  } else if (op.paragraphIndex === op.endParagraphIndex) {
    const text = first.editAsText();
    if (op.end > op.start) {
      text.deleteText(op.start, op.end - 1);
    }
    if (lines.length === 1) {
      if (lines[0]) {
        text.insertText(op.start, lines[0]);
        pieces.push({ block: first, start: op.start, end: op.start + lines[0].length, textOffset: 0 });
      }
    } else {
      // The rest of the paragraph after the change moves to the end of the last new paragraph.
      const remainder = text.getText().slice(op.start);
      if (remainder) {
        text.deleteText(op.start, text.getText().length - 1);
      }
      if (lines[0]) {
        text.insertText(op.start, lines[0]);
        pieces.push({ block: first, start: op.start, end: op.start + lines[0].length, textOffset: 0 });
      }
      let textOffset = lines[0].length + 1;
      let previous: Block = first;
      for (let index = 1; index < lines.length; index += 1) {
        const line = lines[index];
        const content = index === lines.length - 1 ? line + remainder : line;
        const inserted = insertBlockAfter(previous, content);
        pieces.push({ block: inserted, start: 0, end: line.length, textOffset });
        textOffset += line.length + 1;
        previous = inserted;
      }
    }
  } else {
    // Spans paragraphs: trim the first, drop the middle, trim the last, then lay the new lines out.
    const firstText = first.editAsText();
    const lastText = last.editAsText();
    const firstLength = firstText.getText().length;
    if (firstLength > op.start) {
      firstText.deleteText(op.start, firstLength - 1);
    }
    if (op.end > 0) {
      lastText.deleteText(0, op.end - 1);
    }
    for (let index = op.endParagraphIndex - 1; index > op.paragraphIndex; index -= 1) {
      blocks[index].block.removeFromParent();
    }
    if (lines.length === 1) {
      // One line replaces several paragraphs: merge what remains of the last paragraph into the first.
      const remainder = lastText.getText();
      if (lines[0]) {
        firstText.insertText(op.start, lines[0]);
        pieces.push({ block: first, start: op.start, end: op.start + lines[0].length, textOffset: 0 });
      }
      if (remainder) {
        firstText.appendText(remainder);
      }
      last.removeFromParent();
    } else {
      if (lines[0]) {
        firstText.insertText(op.start, lines[0]);
        pieces.push({ block: first, start: op.start, end: op.start + lines[0].length, textOffset: 0 });
      }
      let textOffset = lines[0].length + 1;
      let previous: Block = first;
      for (let index = 1; index < lines.length - 1; index += 1) {
        const inserted = insertBlockAfter(previous, lines[index]);
        pieces.push({ block: inserted, start: 0, end: lines[index].length, textOffset });
        textOffset += lines[index].length + 1;
        previous = inserted;
      }
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        lastText.insertText(0, lastLine);
        pieces.push({ block: last, start: 0, end: lastLine.length, textOffset });
      }
    }
  }

  for (const piece of pieces) {
    if (piece.end <= piece.start) {
      continue;
    }
    const text = piece.block.editAsText();
    if (op.emphasis) {
      text.setBold(piece.start, piece.end - 1, false);
      text.setItalic(piece.start, piece.end - 1, false);
      text.setUnderline(piece.start, piece.end - 1, false);
      text.setBackgroundColor(piece.start, piece.end - 1, null as unknown as string);
      const local = op.text.slice(piece.textOffset, piece.textOffset + (piece.end - piece.start));
      let cursor = 0;
      for (const run of splitByEmphasis(local, op.emphasis.map((span) => ({ ...span, start: span.start - piece.textOffset, end: span.end - piece.textOffset })))) {
        const from = piece.start + cursor;
        const to = from + run.text.length - 1;
        if (run.format.bold) {
          text.setBold(from, to, true);
        }
        if (run.format.italic) {
          text.setItalic(from, to, true);
        }
        if (run.format.underline) {
          text.setUnderline(from, to, true);
        }
        if (run.format.highlight) {
          text.setBackgroundColor(from, to, DOCS_EMPHASIS_HIGHLIGHT);
        }
        cursor += run.text.length;
      }
    }
    if (op.highlight && op.text !== current) {
      text.setBackgroundColor(piece.start, piece.end - 1, DOCS_CHANGE_HIGHLIGHT);
    }
  }
}

/** The existing text of a range as pieces (for formatting-only operations). */
function rangePieces(blocks: WalkedBlock[], op: DocsReplaceOp): InsertedPiece[] {
  const pieces: InsertedPiece[] = [];
  let textOffset = 0;
  for (let index = op.paragraphIndex; index <= op.endParagraphIndex; index += 1) {
    const block = blocks[index].block;
    const length = block.getText().length;
    const start = index === op.paragraphIndex ? op.start : 0;
    const end = index === op.endParagraphIndex ? op.end : length;
    pieces.push({ block, start, end, textOffset });
    textOffset += end - start + 1;
  }
  return pieces;
}

/** Insert a new paragraph (or list item, matching the neighbour) right after `block`, with the same attributes. */
function insertBlockAfter(block: Block, content: string): Block {
  const parent = block.getParent() as unknown as {
    getChildIndex(child: Element): number;
    insertParagraph(index: number, text: string): Paragraph;
    insertListItem(index: number, text: string): ListItem;
  };
  const at = parent.getChildIndex(block as unknown as Element) + 1;
  let inserted: Block;
  if (block.getType() === DocumentApp.ElementType.LIST_ITEM) {
    inserted = parent.insertListItem(at, content);
    (inserted as ListItem).setListId(block as ListItem);
    (inserted as ListItem).setNestingLevel((block as ListItem).getNestingLevel());
  } else {
    inserted = parent.insertParagraph(at, content);
  }
  try {
    inserted.setHeading(block.getHeading());
  } catch {
    // Some containers reject headings; the text still landed.
  }
  return inserted;
}

/* ------------------------------------------------------------------------- */
/* Images                                                                    */
/* ------------------------------------------------------------------------- */

function imageAt(index: number): { image: GoogleAppsScript.Document.InlineImage; paragraphIndex: number } {
  const blocks = walkBlocks(document().getBody() as unknown as Container);
  const found = inlineImagesOf(blocks)[index];
  if (!found) {
    throw new Error(`The document has no inline image ${index + 1}.`);
  }
  return found;
}

export function nebulaReadImage(index: number): DocsImageBytesPayload {
  const { image } = imageAt(index);
  const blob = image.getBlob();
  return {
    base64: Utilities.base64Encode(blob.getBytes()),
    mime: blob.getContentType() ?? "image/png",
    width: numberOrNull(image.getWidth()),
    height: numberOrNull(image.getHeight())
  };
}

export function nebulaReplaceImage(index: number, base64: string, mime: string): void {
  const { image } = imageAt(index);
  const parent = image.getParent() as unknown as { getChildIndex(child: Element): number; insertInlineImage(index: number, blob: GoogleAppsScript.Base.BlobSource): GoogleAppsScript.Document.InlineImage };
  const at = parent.getChildIndex(image as unknown as Element);
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), mime || "image/png", "replacement");
  const inserted = parent.insertInlineImage(at, blob);
  const width = image.getWidth();
  const height = image.getHeight();
  if (width && height) {
    inserted.setWidth(width);
    inserted.setHeight(height);
  }
  const alt = image.getAltDescription();
  if (alt) {
    inserted.setAltDescription(alt);
  }
  image.removeFromParent();
}

export function nebulaSelectImage(index: number): void {
  const { image } = imageAt(index);
  const doc = document();
  doc.setSelection(doc.newRange().addElement(image).build());
}
