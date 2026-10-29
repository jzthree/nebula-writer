/**
 * An in-memory stand-in for the slice of Apps Script's DocumentApp the Google
 * Docs add-in uses: body → paragraphs/list items/tables → text with per-
 * character formatting, cursor and selection, end-inclusive text offsets.
 * Install with `installFakeDocumentApp(...)` before calling the script code.
 */

interface CharFormat {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  background: string | null;
}

const PLAIN: CharFormat = { bold: false, italic: false, underline: false, background: null };

export const ElementType = {
  BODY_SECTION: "BODY_SECTION",
  DOCUMENT: "DOCUMENT",
  PARAGRAPH: "PARAGRAPH",
  LIST_ITEM: "LIST_ITEM",
  TABLE: "TABLE",
  TABLE_ROW: "TABLE_ROW",
  TABLE_CELL: "TABLE_CELL",
  TEXT: "TEXT",
  INLINE_IMAGE: "INLINE_IMAGE"
} as const;

export const ParagraphHeading = {
  NORMAL: "NORMAL",
  TITLE: "TITLE",
  SUBTITLE: "SUBTITLE",
  HEADING1: "HEADING1",
  HEADING2: "HEADING2",
  HEADING3: "HEADING3",
  HEADING4: "HEADING4",
  HEADING5: "HEADING5",
  HEADING6: "HEADING6"
} as const;

export interface ParagraphSeed {
  text: string;
  heading?: keyof typeof ParagraphHeading;
  list?: boolean;
  bold?: Array<[number, number]>;
  italic?: Array<[number, number]>;
  underline?: Array<[number, number]>;
  background?: Array<[number, number, string]>;
}

export class FakeText {
  chars: Array<{ ch: string; format: CharFormat }> = [];

  constructor(public paragraph: FakeParagraph, text: string) {
    this.chars = [...text].map((ch) => ({ ch, format: { ...PLAIN } }));
  }

  getType(): string {
    return ElementType.TEXT;
  }

  asText(): this {
    return this;
  }

  getParent(): FakeParagraph {
    return this.paragraph;
  }

  getText(): string {
    return this.chars.map((entry) => entry.ch).join("");
  }

  getTextAttributeIndices(): number[] {
    const indices: number[] = [];
    let previous: CharFormat | null = null;
    this.chars.forEach((entry, index) => {
      if (!previous || !sameFormat(previous, entry.format)) {
        indices.push(index);
      }
      previous = entry.format;
    });
    return indices.length ? indices : [0];
  }

  isBold(offset: number): boolean | null {
    return this.chars[offset]?.format.bold ?? null;
  }

  isItalic(offset: number): boolean | null {
    return this.chars[offset]?.format.italic ?? null;
  }

  isUnderline(offset: number): boolean | null {
    return this.chars[offset]?.format.underline ?? null;
  }

  getBackgroundColor(offset: number): string | null {
    return this.chars[offset]?.format.background ?? null;
  }

  deleteText(start: number, endInclusive: number): this {
    if (endInclusive < start) {
      throw new Error(`deleteText: end ${endInclusive} before start ${start}`);
    }
    if (start < 0 || endInclusive >= this.chars.length) {
      throw new Error(`deleteText: range ${start}-${endInclusive} outside text of length ${this.chars.length}`);
    }
    this.chars.splice(start, endInclusive - start + 1);
    return this;
  }

  insertText(offset: number, text: string): this {
    if (offset < 0 || offset > this.chars.length) {
      throw new Error(`insertText: offset ${offset} outside text of length ${this.chars.length}`);
    }
    // Docs gives inserted text the formatting at the insertion point (the character before it).
    const inherit = this.chars[offset - 1]?.format ?? this.chars[offset]?.format ?? PLAIN;
    this.chars.splice(offset, 0, ...[...text].map((ch) => ({ ch, format: { ...inherit } })));
    return this;
  }

  appendText(text: string): this {
    return this.insertText(this.chars.length, text);
  }

  private setFormat(start: number, endInclusive: number, patch: Partial<CharFormat>): this {
    if (endInclusive < start || start < 0 || endInclusive >= this.chars.length) {
      throw new Error(`format: range ${start}-${endInclusive} outside text of length ${this.chars.length}`);
    }
    for (let index = start; index <= endInclusive; index += 1) {
      this.chars[index].format = { ...this.chars[index].format, ...patch };
    }
    return this;
  }

  setBold(start: number, endInclusive: number, value: boolean): this {
    return this.setFormat(start, endInclusive, { bold: value });
  }

  setItalic(start: number, endInclusive: number, value: boolean): this {
    return this.setFormat(start, endInclusive, { italic: value });
  }

  setUnderline(start: number, endInclusive: number, value: boolean): this {
    return this.setFormat(start, endInclusive, { underline: value });
  }

  setBackgroundColor(start: number, endInclusive: number, color: string | null): this {
    return this.setFormat(start, endInclusive, { background: color });
  }
}

function sameFormat(left: CharFormat, right: CharFormat): boolean {
  return left.bold === right.bold && left.italic === right.italic && left.underline === right.underline && left.background === right.background;
}

export class FakeParagraph {
  text: FakeText;
  heading: string;
  nestingLevel = 0;

  constructor(public parent: FakeContainer, seed: ParagraphSeed, public list = Boolean(seed.list)) {
    this.text = new FakeText(this, seed.text);
    this.heading = seed.heading ? ParagraphHeading[seed.heading] : ParagraphHeading.NORMAL;
    for (const [from, to] of seed.bold ?? []) {
      this.text.setBold(from, to - 1, true);
    }
    for (const [from, to] of seed.italic ?? []) {
      this.text.setItalic(from, to - 1, true);
    }
    for (const [from, to] of seed.underline ?? []) {
      this.text.setUnderline(from, to - 1, true);
    }
    for (const [from, to, color] of seed.background ?? []) {
      this.text.setBackgroundColor(from, to - 1, color);
    }
  }

  getType(): string {
    return this.list ? ElementType.LIST_ITEM : ElementType.PARAGRAPH;
  }

  asParagraph(): this {
    return this;
  }

  asListItem(): this {
    return this;
  }

  getText(): string {
    return this.text.getText();
  }

  editAsText(): FakeText {
    return this.text;
  }

  getHeading(): string {
    return this.heading;
  }

  setHeading(value: string): this {
    this.heading = value;
    return this;
  }

  getNumChildren(): number {
    return 1;
  }

  getChild(index: number): FakeText {
    if (index !== 0) {
      throw new Error("child out of range");
    }
    return this.text;
  }

  getChildIndex(child: unknown): number {
    return child === this.text ? 0 : -1;
  }

  getParent(): FakeContainer {
    return this.parent;
  }

  removeFromParent(): void {
    this.parent.remove(this);
  }

  getListId(): string {
    return "list-1";
  }

  setListId(_other: FakeParagraph): this {
    return this;
  }

  getNestingLevel(): number {
    return this.nestingLevel;
  }

  setNestingLevel(level: number): this {
    this.nestingLevel = level;
    return this;
  }

  getAttributes(): Record<string, unknown> {
    return {};
  }

  setAttributes(): this {
    return this;
  }

  /** Test helper: formats of one character. */
  formatAt(offset: number): CharFormat {
    return this.text.chars[offset]?.format ?? { ...PLAIN };
  }
}

export class FakeContainer {
  children: Array<FakeParagraph | FakeTable> = [];

  constructor(public type: string, public parent: FakeContainer | FakeTableRow | null = null) {}

  getType(): string {
    return this.type;
  }

  getParent(): FakeContainer | FakeTableRow | null {
    return this.parent;
  }

  getNumChildren(): number {
    return this.children.length;
  }

  getChild(index: number): FakeParagraph | FakeTable {
    const child = this.children[index];
    if (!child) {
      throw new Error(`child ${index} out of range`);
    }
    return child;
  }

  getChildIndex(child: unknown): number {
    return this.children.indexOf(child as FakeParagraph);
  }

  insertParagraph(index: number, text: string): FakeParagraph {
    const paragraph = new FakeParagraph(this, { text });
    this.children.splice(index, 0, paragraph);
    return paragraph;
  }

  insertListItem(index: number, text: string): FakeParagraph {
    const item = new FakeParagraph(this, { text, list: true });
    this.children.splice(index, 0, item);
    return item;
  }

  appendParagraph(text: string): FakeParagraph {
    return this.insertParagraph(this.children.length, text);
  }

  remove(child: FakeParagraph | FakeTable): void {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
    }
  }

  /** Table cells: paragraphs joined with "\n". */
  getText(): string {
    return this.children.map((child) => (child instanceof FakeParagraph ? child.getText() : "")).join("\n");
  }

  /** Table cells: replace the content with one paragraph per line. */
  setText(text: string): this {
    this.children = text.split("\n").map((line) => new FakeParagraph(this, { text: line }));
    return this;
  }

  getColSpan(): number {
    return 1;
  }

  getRowSpan(): number {
    return 1;
  }

  /** Body: a table filled with `cells`, inserted at `index`. */
  insertTable(index: number, cells: string[][]): FakeTable {
    const table = new FakeTable(this);
    for (const rowCells of cells) {
      const row = new FakeTableRow(table);
      for (const text of rowCells) {
        row.appendTableCell(text);
      }
      table.rows.push(row);
    }
    this.children.splice(index, 0, table);
    return table;
  }
}

export class FakeTableRow {
  cells: FakeContainer[] = [];

  constructor(public table: FakeTable) {}

  getType(): string {
    return ElementType.TABLE_ROW;
  }

  getNumCells(): number {
    return this.cells.length;
  }

  getCell(index: number): FakeContainer {
    return this.cells[index];
  }

  getChildIndex(child: unknown): number {
    return this.cells.indexOf(child as FakeContainer);
  }

  getParent(): FakeTable {
    return this.table;
  }

  appendTableCell(text = ""): FakeContainer {
    return this.insertTableCell(this.cells.length, text);
  }

  insertTableCell(index: number, text = ""): FakeContainer {
    const cell = new FakeContainer(ElementType.TABLE_CELL, this);
    cell.setText(text);
    this.cells.splice(index, 0, cell);
    return cell;
  }

  removeCell(index: number): FakeContainer {
    return this.cells.splice(index, 1)[0];
  }
}

export class FakeTable {
  rows: FakeTableRow[] = [];

  constructor(public parent: FakeContainer) {}

  getType(): string {
    return ElementType.TABLE;
  }

  asTable(): this {
    return this;
  }

  getNumRows(): number {
    return this.rows.length;
  }

  getRow(index: number): FakeTableRow {
    return this.rows[index];
  }

  getChildIndex(child: unknown): number {
    return this.rows.indexOf(child as FakeTableRow);
  }

  getCell(row: number, cell: number): FakeContainer {
    return this.rows[row].cells[cell];
  }

  insertTableRow(index: number): FakeTableRow {
    const row = new FakeTableRow(this);
    this.rows.splice(index, 0, row);
    return row;
  }

  removeRow(index: number): FakeTableRow {
    return this.rows.splice(index, 1)[0];
  }

  /** Test helper: the cell texts. */
  grid(): string[][] {
    return this.rows.map((row) => row.cells.map((cell) => cell.getText()));
  }

  getParent(): FakeContainer {
    return this.parent;
  }

  removeFromParent(): void {
    this.parent.remove(this);
  }
}

class FakeRangeElement {
  constructor(private element: FakeText | FakeParagraph, private start: number | null, private endInclusive: number | null) {}

  getElement(): FakeText | FakeParagraph {
    return this.element;
  }

  isPartial(): boolean {
    return this.start !== null;
  }

  getStartOffset(): number {
    return this.start ?? -1;
  }

  getEndOffsetInclusive(): number {
    return this.endInclusive ?? -1;
  }
}

class FakeRange {
  constructor(public elements: FakeRangeElement[]) {}

  getRangeElements(): FakeRangeElement[] {
    return this.elements;
  }
}

class FakeRangeBuilder {
  elements: FakeRangeElement[] = [];

  addElement(element: FakeText | FakeParagraph, start?: number, endInclusive?: number): this {
    this.elements.push(new FakeRangeElement(element, start ?? null, endInclusive ?? null));
    return this;
  }

  build(): FakeRange {
    return new FakeRange(this.elements);
  }
}

class FakePosition {
  constructor(private element: FakeText | FakeParagraph, private offset: number) {}

  getElement(): FakeText | FakeParagraph {
    return this.element;
  }

  getOffset(): number {
    return this.offset;
  }
}

export class FakeDocument {
  body = new FakeContainer(ElementType.BODY_SECTION);
  selection: FakeRange | null = null;
  cursor: FakePosition | null = null;

  constructor(public name = "Fake doc", public id = "doc-1") {}

  getBody(): FakeContainer {
    return this.body;
  }

  getName(): string {
    return this.name;
  }

  getId(): string {
    return this.id;
  }

  getSelection(): FakeRange | null {
    return this.selection;
  }

  getCursor(): FakePosition | null {
    return this.cursor;
  }

  newRange(): FakeRangeBuilder {
    return new FakeRangeBuilder();
  }

  setSelection(range: FakeRange): void {
    this.selection = range;
  }

  newPosition(element: FakeText | FakeParagraph, offset: number): FakePosition {
    return new FakePosition(element, offset);
  }

  setCursor(position: FakePosition): void {
    this.cursor = position;
    this.selection = null;
  }

  /** Test helpers. */
  paragraph(index: number): FakeParagraph {
    return this.body.children[index] as FakeParagraph;
  }

  texts(): string[] {
    const out: string[] = [];
    const visit = (container: FakeContainer) => {
      for (const child of container.children) {
        if (child instanceof FakeParagraph) {
          out.push(child.getText());
        } else {
          for (const row of child.rows) {
            for (const cell of row.cells) {
              visit(cell);
            }
          }
        }
      }
    };
    visit(this.body);
    return out;
  }

  selectText(paragraphIndex: number, start: number, endExclusive: number): void {
    const paragraph = this.paragraph(paragraphIndex);
    this.selection = new FakeRange([new FakeRangeElement(paragraph.text, start, endExclusive - 1)]);
  }

  placeCursor(paragraphIndex: number, offset: number): void {
    this.setCursor(new FakePosition(this.paragraph(paragraphIndex).text, offset));
  }
}

export function buildFakeDocument(seeds: Array<ParagraphSeed | { table: ParagraphSeed[][] }>): FakeDocument {
  const doc = new FakeDocument();
  for (const seed of seeds) {
    if ("table" in seed) {
      const table = new FakeTable(doc.body);
      for (const rowSeed of seed.table) {
        const row = new FakeTableRow(table);
        for (const cellSeed of rowSeed) {
          const cell = new FakeContainer(ElementType.TABLE_CELL, row);
          cell.children.push(new FakeParagraph(cell, cellSeed));
          row.cells.push(cell);
        }
        table.rows.push(row);
      }
      doc.body.children.push(table);
    } else {
      doc.body.children.push(new FakeParagraph(doc.body, seed));
    }
  }
  return doc;
}

export function installFakeDocumentApp(doc: FakeDocument): () => void {
  const globals = globalThis as Record<string, unknown>;
  const previous = { DocumentApp: globals.DocumentApp, HtmlService: globals.HtmlService, Utilities: globals.Utilities };
  globals.DocumentApp = {
    getActiveDocument: () => doc,
    ElementType,
    ParagraphHeading,
    getUi: () => ({ createAddonMenu: () => ({ addItem: () => ({ addToUi: () => undefined }) }), showSidebar: () => undefined })
  };
  return () => {
    globals.DocumentApp = previous.DocumentApp;
    globals.HtmlService = previous.HtmlService;
    globals.Utilities = previous.Utilities;
  };
}
