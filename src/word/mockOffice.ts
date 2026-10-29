/**
 * In-memory stand-in for the Office.js surface the task pane uses.
 *
 * Lets the pane run in a plain browser (`taskpane.html?mock=1`) and in vitest
 * without Microsoft Word: paragraphs, a selection, a scrollable "viewport"
 * of fixed-size pages, search, tracked-change replacements, and comments.
 * It implements exactly the members wordHost.ts touches — it is a test
 * double, not a Word emulator — but keeps Word's shapes (load/sync, ranges,
 * *OrNullObject) so the real facade code runs unchanged against it.
 */

import { emphasisAt, hasEmphasis, normalizeEmphasis, shiftEmphasis, uniformEmphasis, type EmphasisFormat, type EmphasisKind, type EmphasisSpan } from "../emphasis";

export interface MockParagraphSeed {
  text: string;
  /** Inline emphasis, offsets relative to the paragraph text. */
  emphasis?: EmphasisSpan[];
  style?: string;
  styleBuiltIn?: string;
  outlineLevel?: number;
  isListItem?: boolean;
  alignment?: string;
}

export interface MockWordOptions {
  paragraphs: MockParagraphSeed[];
  documentName?: string;
  selection?: { from: number; to: number };
  /** Characters per simulated page and how many characters the window shows. */
  viewport?: { pageChars: number; visibleChars: number; scrollOffset?: number };
  changeTrackingMode?: "Off" | "TrackAll" | "TrackMineOnly";
  supports?: Partial<Record<"WordApi 1.3" | "WordApi 1.4" | "WordApi 1.6" | "WordApiDesktop 1.2", boolean>>;
  platform?: string;
  /** Inline pictures: which paragraph each sits in and its (base64) bytes. */
  pictures?: MockPictureSeed[];
  /** Word fields (citations, cross-references) as absolute text spans. */
  fields?: Array<{ from: number; to: number }>;
  /** Tables: each is inserted after seed paragraph `afterParagraph` (one paragraph per cell line, row by row). */
  tables?: MockTableSeed[];
  /** Existing comments, anchored to the first occurrence of `anchorText`. */
  comments?: Array<{ anchorText: string; text: string; author?: string; resolved?: boolean; replies?: Array<{ author: string; text: string }> }>;
}

export interface MockTableSeed {
  afterParagraph: number;
  rows: string[][];
  /** Merged cells (Word reports isUniform false). */
  irregular?: boolean;
}

/** Where a paragraph sits when it is part of a table cell. */
export interface MockCellTag {
  table: number;
  row: number;
  column: number;
}

export interface MockTableEdit {
  table: number;
  action: "insert" | "deleteRows" | "deleteColumns" | "insertRows" | "insertColumns" | "setCell" | "delete";
  tracked: boolean;
}

export interface MockPictureSeed {
  paragraphIndex: number;
  base64: string;
  width: number;
  height: number;
  altText?: string;
}

/** A picture added or removed through the API (not a seed), in order. */
export interface MockPictureEdit {
  action: "insert" | "delete";
  paragraphIndex: number;
  base64: string;
  tracked: boolean;
}

export interface MockPictureReplacement {
  index: number;
  previousBase64: string;
  base64: string;
  tracked: boolean;
}

export interface MockTrackedChange {
  from: number;
  to: number;
  original: string;
  replacement: string;
}

export interface MockComment {
  from: number;
  to: number;
  anchorText: string;
  text: string;
  author?: string;
  resolved?: boolean;
  replies?: Array<{ author: string; text: string }>;
}

const PARAGRAPH_SEPARATOR = "\n";

type Handler = () => void;

interface ParagraphState extends MockParagraphSeed {
  text: string;
  cell?: MockCellTag;
}

export class MockWordHost {
  paragraphs: ParagraphState[];
  selection: { from: number; to: number };
  changeTrackingMode: "Off" | "TrackAll" | "TrackMineOnly";
  documentName: string;
  viewport: { pageChars: number; visibleChars: number; scrollOffset: number };
  supports: Record<string, boolean>;
  platform: string;
  trackedChanges: MockTrackedChange[] = [];
  comments: MockComment[] = [];
  pictures: MockPictureSeed[] = [];
  pictureReplacements: MockPictureReplacement[] = [];
  pictureEdits: MockPictureEdit[] = [];
  /** Natural size (points) the mock gives a picture inserted from base64. */
  insertedPictureSize = { width: 936, height: 624 };
  fields: Array<{ from: number; to: number }> = [];
  /** Inline emphasis (bold/italic/underline/highlight) as absolute spans over `text`. */
  emphasis: EmphasisSpan[] = [];
  /** Every insertText/delete, tracked or not. */
  edits: MockTrackedChange[] = [];
  /** Table structure and cell edits, in order. */
  tableEdits: MockTableEdit[] = [];
  tableMeta = new Map<number, { irregular: boolean; header: number; style: string | null }>();
  private nextTableId = 1;
  selectionHandlers = new Set<Handler>();
  paragraphHandlers = new Set<Handler>();
  runCount = 0;
  /** Whole-body text loads: one per document snapshot. */
  bodyReads = 0;
  private previousOffice: unknown;
  private previousWord: unknown;

  constructor(options: MockWordOptions) {
    this.paragraphs = options.paragraphs.map((paragraph) => ({ ...paragraph, text: paragraph.text }));
    this.selection = options.selection ?? { from: 0, to: 0 };
    this.changeTrackingMode = options.changeTrackingMode ?? "Off";
    this.documentName = options.documentName ?? "Mock document.docx";
    this.viewport = { scrollOffset: 0, ...(options.viewport ?? { pageChars: 1_500, visibleChars: 1_200 }) };
    this.supports = {
      "WordApi 1.1": true,
      "WordApi 1.3": true,
      "WordApi 1.4": true,
      "WordApi 1.6": true,
      "WordApiDesktop 1.2": true,
      ...(options.supports ?? {})
    };
    this.platform = options.platform ?? "Mac";
    this.pictures = (options.pictures ?? []).map((picture) => ({ ...picture }));
    this.fields = (options.fields ?? []).map((field) => ({ ...field }));
    const offsets = this.paragraphOffsets();
    this.emphasis = normalizeEmphasis(options.paragraphs.flatMap((paragraph, index) => shiftEmphasis(paragraph.emphasis ?? [], offsets[index] ?? 0)));
    // Tables last (later seeds first), so seed paragraph indices stay valid while inserting.
    for (const table of [...(options.tables ?? [])].sort((a, b) => b.afterParagraph - a.afterParagraph)) {
      const id = this.insertTable(table.afterParagraph, table.rows, false);
      this.tableMeta.set(id, { irregular: Boolean(table.irregular), header: 0, style: null });
    }
    this.edits = [];
    this.tableEdits = [];
    this.trackedChanges = [];
    for (const seed of options.comments ?? []) {
      const from = this.text.indexOf(seed.anchorText);
      if (from >= 0) {
        this.comments.push({ from, to: from + seed.anchorText.length, anchorText: seed.anchorText, text: seed.text, author: seed.author, resolved: seed.resolved, replies: seed.replies });
      }
    }
  }

  /* ------------------------------ tables ------------------------------ */

  /** Table ids in document order. */
  tableIds(): number[] {
    const ids: number[] = [];
    for (const paragraph of this.paragraphs) {
      if (paragraph.cell && !ids.includes(paragraph.cell.table)) {
        ids.push(paragraph.cell.table);
      }
    }
    return ids;
  }

  tableBlock(id: number): { first: number; last: number } {
    const first = this.paragraphs.findIndex((paragraph) => paragraph.cell?.table === id);
    if (first < 0) {
      throw new Error(`Mock Word: table ${id} no longer exists`);
    }
    let last = first;
    while (this.paragraphs[last + 1]?.cell?.table === id) {
      last += 1;
    }
    return { first, last };
  }

  tableGrid(id: number): string[][] {
    const { first, last } = this.tableBlock(id);
    const grid: string[][] = [];
    for (let index = first; index <= last; index += 1) {
      const { text, cell } = this.paragraphs[index];
      const tag = cell as MockCellTag;
      grid[tag.row] ??= [];
      grid[tag.row][tag.column] = grid[tag.row][tag.column] === undefined ? text : `${grid[tag.row][tag.column]}\n${text}`;
    }
    return grid.map((row) => Array.from(row, (cell) => cell ?? ""));
  }

  /** Character range of a table, a row or a cell (the paragraphs it covers). */
  tableRange(id: number, row?: number, column?: number): { from: number; to: number } {
    const indices = this.paragraphs.flatMap((paragraph, index) =>
      paragraph.cell?.table === id && (row === undefined || paragraph.cell.row === row) && (column === undefined || paragraph.cell.column === column) ? [index] : []);
    if (!indices.length) {
      throw new Error(`Mock Word: no such table cell ${id}/${row}/${column}`);
    }
    return { from: this.paragraphRange(indices[0]).from, to: this.paragraphRange(indices[indices.length - 1]).to };
  }

  private tableParagraphs(id: number, grid: string[][]): ParagraphState[] {
    return grid.flatMap((row, r) => row.flatMap((cell, c) => cell.split("\n").map((text) => ({ text, cell: { table: id, row: r, column: c } }))));
  }

  /** Insert a table after paragraph `after`; returns its id. */
  insertTable(after: number, rows: string[][], record = true): number {
    const id = this.nextTableId;
    this.nextTableId += 1;
    this.tableMeta.set(id, { irregular: false, header: 0, style: null });
    this.spliceParagraphs(after + 1, 0, this.tableParagraphs(id, rows));
    if (record) {
      this.tableEdits.push({ table: id, action: "insert", tracked: this.changeTrackingMode !== "Off" });
    }
    return id;
  }

  /** Rewrite a table's grid (null removes the table). */
  writeTable(id: number, grid: string[][] | null, action: MockTableEdit["action"]): void {
    const { first, last } = this.tableBlock(id);
    this.spliceParagraphs(first, last - first + 1, grid ? this.tableParagraphs(id, grid) : []);
    this.tableEdits.push({ table: id, action, tracked: this.changeTrackingMode !== "Off" });
  }

  /** Replace whole paragraphs, keeping emphasis outside them in place. */
  spliceParagraphs(start: number, deleteCount: number, inserted: ParagraphState[]): void {
    const offsets = this.paragraphOffsets();
    const from = offsets[start] ?? this.text.length + PARAGRAPH_SEPARATOR.length;
    const to = start + deleteCount < offsets.length ? offsets[start + deleteCount] : this.text.length + PARAGRAPH_SEPARATOR.length;
    const original = this.text.slice(from, to);
    this.paragraphs.splice(start, deleteCount, ...inserted);
    // Pictures follow their paragraphs; those in removed paragraphs go with them.
    this.pictures = this.pictures.flatMap((picture) => {
      if (picture.paragraphIndex < start) return [picture];
      if (picture.paragraphIndex < start + deleteCount) return [];
      return [{ ...picture, paragraphIndex: picture.paragraphIndex + inserted.length - deleteCount }];
    });
    const added = inserted.reduce((sum, paragraph) => sum + paragraph.text.length + PARAGRAPH_SEPARATOR.length, 0);
    const delta = added - (to - from);
    this.emphasis = normalizeEmphasis(this.emphasis.flatMap((span) => {
      if (span.end <= from) return [span];
      if (span.start >= to) return [{ ...span, start: span.start + delta, end: span.end + delta }];
      return span.start < from ? [{ ...span, end: from }] : [];
    }));
    const edit = { from, to, original, replacement: inserted.map((paragraph) => paragraph.text + PARAGRAPH_SEPARATOR).join("") };
    this.edits.push(edit);
    if (this.changeTrackingMode !== "Off") {
      this.trackedChanges.push(edit);
    }
    this.fireParagraphChanged();
  }

  /* ------------------------------ emphasis ------------------------------ */

  /** The emphasis of [from, to): the format when uniform, null for a mixed range (what Word reports). */
  emphasisOver(from: number, to: number): EmphasisFormat | null {
    return to <= from ? {} : uniformEmphasis(this.emphasis, from, to);
  }

  /** One kind of emphasis over [from, to): true/false when uniform, null when mixed. */
  emphasisKindOver(from: number, to: number, kind: EmphasisKind): boolean | null {
    if (to <= from) {
      return false;
    }
    const first = Boolean(emphasisAt(this.emphasis, from)[kind]);
    for (let offset = from + 1; offset < to; offset += 1) {
      if (Boolean(emphasisAt(this.emphasis, offset)[kind]) !== first) {
        return null;
      }
    }
    return first;
  }

  /** Turn one kind of emphasis on or off over [from, to), like setting Word's font.bold on a range. */
  setEmphasis(from: number, to: number, kind: EmphasisKind, on: boolean): void {
    if (to <= from) {
      return;
    }
    const spans: EmphasisSpan[] = [];
    for (const span of this.emphasis) {
      if (span.end <= from || span.start >= to) {
        spans.push(span);
        continue;
      }
      if (span.start < from) {
        spans.push({ ...span, end: from });
      }
      if (span.end > to) {
        spans.push({ ...span, start: to });
      }
      const inner = { ...span, start: Math.max(span.start, from), end: Math.min(span.end, to) };
      if (on) {
        inner[kind] = true;
      } else {
        delete inner[kind];
      }
      spans.push(inner);
    }
    if (on) {
      spans.push({ start: from, end: to, [kind]: true });
    }
    this.emphasis = normalizeEmphasis(spans);
    this.edits.push({ from, to, original: this.text.slice(from, to), replacement: this.text.slice(from, to) });
  }

  /** Swap a picture's bytes, recording it (as tracked when tracking is on). */
  replacePicture(index: number, base64: string): void {
    const picture = this.pictures[index];
    if (!picture) {
      throw new Error(`Mock Word: no inline picture ${index}`);
    }
    this.pictureReplacements.push({ index, previousBase64: picture.base64, base64, tracked: this.changeTrackingMode !== "Off" });
    picture.base64 = base64;
  }

  /** Add a picture at the start of paragraph `paragraphIndex`; returns its index in document order. */
  insertPicture(paragraphIndex: number, base64: string): number {
    const seed: MockPictureSeed = { paragraphIndex, base64, ...this.insertedPictureSize };
    this.pictures.push(seed);
    this.pictures.sort((a, b) => a.paragraphIndex - b.paragraphIndex);
    this.pictureEdits.push({ action: "insert", paragraphIndex, base64, tracked: this.changeTrackingMode !== "Off" });
    return this.pictures.indexOf(seed);
  }

  /** Remove picture `index` (its paragraph stays). */
  deletePicture(index: number): void {
    const [picture] = this.pictures.splice(index, 1);
    if (!picture) {
      throw new Error(`Mock Word: no inline picture ${index}`);
    }
    this.pictureEdits.push({ action: "delete", paragraphIndex: picture.paragraphIndex, base64: picture.base64, tracked: this.changeTrackingMode !== "Off" });
  }

  /* ----------------------------- document model ----------------------------- */

  get text(): string {
    return this.paragraphs.map((paragraph) => paragraph.text).join(PARAGRAPH_SEPARATOR);
  }

  paragraphOffsets(): number[] {
    const offsets: number[] = [];
    let cursor = 0;
    for (const paragraph of this.paragraphs) {
      offsets.push(cursor);
      cursor += paragraph.text.length + PARAGRAPH_SEPARATOR.length;
    }
    return offsets;
  }

  paragraphIndexAt(offset: number): number {
    const offsets = this.paragraphOffsets();
    let index = 0;
    for (let i = 0; i < offsets.length; i += 1) {
      if (offsets[i] <= offset) {
        index = i;
      } else {
        break;
      }
    }
    return index;
  }

  paragraphRange(index: number): { from: number; to: number } {
    const offsets = this.paragraphOffsets();
    const from = offsets[index] ?? 0;
    return { from, to: from + (this.paragraphs[index]?.text.length ?? 0) };
  }

  setSelection(from: number, to: number = from): void {
    const length = this.text.length;
    const start = Math.max(0, Math.min(length, Math.min(from, to)));
    const end = Math.max(0, Math.min(length, Math.max(from, to)));
    this.selection = { from: start, to: end };
    this.fireSelectionChanged();
  }

  /** Select the first occurrence of `needle` (after `after`) — handy in tests. */
  selectText(needle: string, after = 0): void {
    const index = this.text.indexOf(needle, after);
    if (index < 0) {
      throw new Error(`Mock Word: text not found: ${needle}`);
    }
    this.setSelection(index, index + needle.length);
  }

  scrollTo(offset: number): void {
    this.viewport.scrollOffset = Math.max(0, Math.min(this.text.length, offset));
  }

  fireSelectionChanged(): void {
    for (const handler of [...this.selectionHandlers]) {
      handler();
    }
  }

  fireParagraphChanged(): void {
    for (const handler of [...this.paragraphHandlers]) {
      handler();
    }
  }

  /** Replace [from, to) with `replacement`, recording a tracked change when tracking is on. */
  replaceRange(from: number, to: number, replacement: string): { from: number; to: number } {
    const text = this.text;
    const original = text.slice(from, to);
    const nextText = text.slice(0, from) + replacement + text.slice(to);
    const firstParagraph = this.paragraphIndexAt(from);
    const lastParagraph = this.paragraphIndexAt(Math.max(from, to - 1));
    const before = this.paragraphs.slice(0, firstParagraph);
    const after = this.paragraphs.slice(lastParagraph + 1);
    const style = this.paragraphs[firstParagraph] ?? { text: "" };
    const beforeLength = before.reduce((sum, paragraph) => sum + paragraph.text.length + PARAGRAPH_SEPARATOR.length, 0);
    const afterLength = after.reduce((sum, paragraph) => sum + paragraph.text.length + PARAGRAPH_SEPARATOR.length, 0);
    const middle = nextText.slice(beforeLength, nextText.length - afterLength);
    const middleParagraphs = middle.split(PARAGRAPH_SEPARATOR).map((paragraphText) => ({ ...style, text: paragraphText }));
    this.paragraphs = [...before, ...middleParagraphs, ...after];
    // Emphasis follows the text: spans after the edit shift, spans across it
    // are clipped, and the new text takes the format of the first replaced
    // character (or of the character before a pure insertion), as Word does.
    const inherited = to > from ? emphasisAt(this.emphasis, from) : from > 0 ? emphasisAt(this.emphasis, from - 1) : {};
    const delta = replacement.length - (to - from);
    const shifted: EmphasisSpan[] = [];
    for (const span of this.emphasis) {
      if (span.end <= from) {
        shifted.push(span);
      } else if (span.start >= to) {
        shifted.push({ ...span, start: span.start + delta, end: span.end + delta });
      } else {
        if (span.start < from) {
          shifted.push({ ...span, end: from });
        }
        if (span.end > to) {
          shifted.push({ ...span, start: to + delta, end: span.end + delta });
        }
      }
    }
    if (replacement.length && hasEmphasis(inherited)) {
      shifted.push({ ...inherited, start: from, end: from + replacement.length });
    }
    this.emphasis = normalizeEmphasis(shifted);
    const edit = { from, to, original, replacement };
    this.edits.push(edit);
    if (this.changeTrackingMode !== "Off") {
      this.trackedChanges.push(edit);
    }
    this.fireParagraphChanged();
    return { from, to: from + replacement.length };
  }

  /* ----------------------------- search ----------------------------- */

  search(query: string, options: { matchCase?: boolean; ignoreSpace?: boolean } = {}, within: { from: number; to: number } | null = null): Array<{ from: number; to: number }> {
    // Like Word: a search string never matches across a paragraph mark, and a
    // literal "^p" finds nothing (Office.js search has no paragraph-mark code).
    if (/\^p/.test(query)) {
      return [];
    }
    const decoded = query.replace(/\^\^/g, "\u0000").replace(/\^t/g, "\t").replace(/\u0000/g, "^");
    const tokens = decoded.split(/\s+/).filter(Boolean).map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!tokens.length) {
      return [];
    }
    const pattern = new RegExp(tokens.join(options.ignoreSpace === false ? " " : "[^\\S\\n]+"), options.matchCase ? "g" : "gi");
    const results: Array<{ from: number; to: number }> = [];
    const text = within ? this.text.slice(0, within.to) : this.text;
    if (within) {
      pattern.lastIndex = within.from;
    }
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (!within || match.index >= within.from) {
        results.push({ from: match.index, to: match.index + match[0].length });
      }
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
      }
    }
    return results;
  }

  /* ----------------------------- viewport ----------------------------- */

  pages(): Array<{ index: number; from: number; to: number }> {
    const length = Math.max(1, this.text.length);
    const pages: Array<{ index: number; from: number; to: number }> = [];
    for (let from = 0, index = 1; from < length; from += this.viewport.pageChars, index += 1) {
      pages.push({ index, from, to: Math.min(length, from + this.viewport.pageChars) });
    }
    return pages;
  }

  visiblePages(): Array<{ index: number; from: number; to: number }> {
    const from = this.viewport.scrollOffset;
    const to = from + this.viewport.visibleChars;
    return this.pages().filter((page) => page.to > from && page.from < to);
  }

  /* ----------------------------- install ----------------------------- */

  install(): this {
    const host = this;
    this.previousOffice = (globalThis as Record<string, unknown>).Office;
    this.previousWord = (globalThis as Record<string, unknown>).Word;
    const office = {
      HostType: { Word: "Word" },
      EventType: { DocumentSelectionChanged: "documentSelectionChanged" },
      onReady: () => Promise.resolve({ host: "Word", platform: host.platform }),
      context: {
        host: "Word",
        platform: host.platform,
        diagnostics: { version: "mock 16.0" },
        document: {
          url: `file:///Users/mock/Documents/${encodeURIComponent(host.documentName)}`,
          addHandlerAsync: (_type: string, handler: Handler, callback?: (result: { status: string }) => void) => {
            host.selectionHandlers.add(handler);
            callback?.({ status: "succeeded" });
          },
          removeHandlerAsync: (_type: string, options: { handler?: Handler } | undefined, callback?: (result: { status: string }) => void) => {
            if (options?.handler) {
              host.selectionHandlers.delete(options.handler);
            } else {
              host.selectionHandlers.clear();
            }
            callback?.({ status: "succeeded" });
          }
        },
        requirements: {
          isSetSupported: (name: string, version: string) => host.supports[`${name} ${version}`] ?? false
        }
      }
    };
    const word = {
      run: async <T>(callback: (context: MockContext) => Promise<T>): Promise<T> => {
        host.runCount += 1;
        return callback(new MockContext(host));
      },
      ChangeTrackingMode: { off: "Off", trackAll: "TrackAll", trackMineOnly: "TrackMineOnly" },
      InsertLocation: { replace: "Replace" }
    };
    (globalThis as Record<string, unknown>).Office = office;
    (globalThis as Record<string, unknown>).Word = word;
    (globalThis as Record<string, unknown>).__nebulaMockWord = this;
    return this;
  }

  uninstall(): void {
    (globalThis as Record<string, unknown>).Office = this.previousOffice;
    (globalThis as Record<string, unknown>).Word = this.previousWord;
    delete (globalThis as Record<string, unknown>).__nebulaMockWord;
  }
}

/* ------------------------------------------------------------------------- */
/* Office.js object shapes                                                   */
/* ------------------------------------------------------------------------- */

class MockContext {
  document: MockDocument;

  constructor(host: MockWordHost) {
    this.document = new MockDocument(host);
  }

  async sync(): Promise<void> {
    return undefined;
  }

  trackedObjects = { add: () => undefined, remove: () => undefined };
}

class MockDocument {
  body: MockBody;
  activeWindow: { activePane: { pagesEnclosingViewport: MockPageCollection; pages: MockPageCollection } };
  onParagraphChanged: MockEventHandlers;
  onParagraphAdded: MockEventHandlers;
  onParagraphDeleted: MockEventHandlers;

  constructor(private host: MockWordHost) {
    this.body = new MockBody(host);
    const pane = {
      get pagesEnclosingViewport() {
        if (!host.supports["WordApiDesktop 1.2"]) {
          throw new Error("ApiNotFound: pagesEnclosingViewport");
        }
        return new MockPageCollection(host, host.visiblePages());
      },
      get pages() {
        return new MockPageCollection(host, host.pages());
      }
    };
    this.activeWindow = { activePane: pane };
    this.onParagraphChanged = new MockEventHandlers(host);
    this.onParagraphAdded = new MockEventHandlers(host);
    this.onParagraphDeleted = new MockEventHandlers(host);
  }

  get changeTrackingMode(): string {
    return this.host.changeTrackingMode;
  }

  set changeTrackingMode(value: string) {
    this.host.changeTrackingMode = value as MockWordHost["changeTrackingMode"];
  }

  load(): this {
    return this;
  }

  getSelection(): MockRange {
    return new MockRange(this.host, this.host.selection.from, this.host.selection.to);
  }
}

class MockEventHandlers {
  constructor(private host: MockWordHost) {}

  add(handler: Handler): { remove: () => void } {
    this.host.paragraphHandlers.add(handler);
    return { remove: () => this.host.paragraphHandlers.delete(handler) };
  }
}

class MockBody {
  constructor(private host: MockWordHost) {}

  get text(): string {
    return this.host.text;
  }

  get paragraphs(): { items: MockParagraph[]; load: () => void } {
    const host = this.host;
    return {
      items: host.paragraphs.map((_, index) => new MockParagraph(host, index)),
      load: () => undefined
    };
  }

  load(properties?: string): this {
    if (properties === "text") {
      this.host.bodyReads += 1;
    }
    return this;
  }

  get inlinePictures(): { items: MockInlinePicture[]; load: () => void } {
    const host = this.host;
    return { items: host.pictures.map((_, index) => new MockInlinePicture(host, index)), load: () => undefined };
  }

  get tables(): { items: MockTable[]; load: () => void } {
    const host = this.host;
    return { items: host.tableIds().map((id) => new MockTable(host, id)), load: () => undefined };
  }

  /** Word's Body.getComments (WordApi 1.4): content, author, resolved, replies, and the anchored range. */
  getComments(): { items: Array<Record<string, unknown>>; load: () => void } {
    const host = this.host;
    return {
      items: host.comments.map((comment, index) => ({
        id: `comment-${index + 1}`,
        content: comment.text,
        authorName: comment.author ?? "Mock Author",
        resolved: Boolean(comment.resolved),
        creationDate: new Date(Date.UTC(2026, 9, 1, 12, index)).toISOString(),
        replies: { items: (comment.replies ?? []).map((reply) => ({ content: reply.text, authorName: reply.author })), load: () => undefined },
        getRange: () => new MockRange(host, comment.from, comment.to),
        load: () => undefined
      })),
      load: () => undefined
    };
  }

  getRange(location: string = "Whole"): MockRange {
    const length = this.host.text.length;
    if (location === "Start") {
      return new MockRange(this.host, 0, 0);
    }
    if (location === "End") {
      return new MockRange(this.host, length, length);
    }
    return new MockRange(this.host, 0, length);
  }

  search(query: string, options?: { matchCase?: boolean; ignoreSpace?: boolean }): { items: MockRange[]; load: () => void } {
    const items = this.host.search(query, options).map((match) => new MockRange(this.host, match.from, match.to));
    return { items, load: () => undefined };
  }
}

export class MockRange {
  isNullObject = false;

  constructor(protected host: MockWordHost, public from: number, public to: number) {}

  get text(): string {
    return this.host.text.slice(this.from, this.to);
  }

  load(): this {
    return this;
  }

  /** Word's Range.font for the emphasis kinds the pane reads and writes. */
  get font(): MockFont {
    return new MockFont(this.host, this.from, this.to);
  }

  getRange(location: string = "Whole"): MockRange {
    if (location === "Start") {
      return new MockRange(this.host, this.from, this.from);
    }
    if (location === "End") {
      return new MockRange(this.host, this.to, this.to);
    }
    // "Whole" and "Content" (paragraph text without its mark) coincide here.
    return new MockRange(this.host, this.from, this.to);
  }

  search(query: string, options?: { matchCase?: boolean; ignoreSpace?: boolean }): { items: MockRange[]; load: () => void } {
    const items = this.host.search(query, options, { from: this.from, to: this.to }).map((match) => new MockRange(this.host, match.from, match.to));
    return { items, load: () => undefined };
  }

  expandTo(other: MockRange): MockRange {
    return new MockRange(this.host, Math.min(this.from, other.from), Math.max(this.to, other.to));
  }

  compareLocationWith(other: MockRange): { value: string } {
    if (this.from === other.from && this.to === other.to) {
      return { value: "Equal" };
    }
    if (this.to <= other.from) {
      return { value: "Before" };
    }
    if (this.from >= other.to) {
      return { value: "After" };
    }
    return { value: "Overlaps" };
  }

  get paragraphs(): { getFirst: () => MockParagraph; getLast: () => MockParagraph; items: MockParagraph[]; load: () => void } {
    const host = this.host;
    const from = this.from;
    const to = this.to;
    const first = host.paragraphIndexAt(from);
    const last = host.paragraphIndexAt(Math.max(from, to - (to > from ? 1 : 0)));
    const items: MockParagraph[] = [];
    for (let index = first; index <= last; index += 1) {
      items.push(new MockParagraph(host, index));
    }
    return {
      getFirst: () => new MockParagraph(host, first),
      getLast: () => new MockParagraph(host, last),
      items,
      load: () => undefined
    };
  }

  select(): void {
    this.host.setSelection(this.from, this.to);
  }

  insertText(text: string, location: string): MockRange {
    if (location === "Start") {
      const next = this.host.replaceRange(this.from, this.from, text);
      return new MockRange(this.host, next.from, next.to);
    }
    if (location === "End") {
      const next = this.host.replaceRange(this.to, this.to, text);
      return new MockRange(this.host, next.from, next.to);
    }
    if (location !== "Replace") {
      throw new Error(`Mock Word: unsupported insert location ${location}`);
    }
    const next = this.host.replaceRange(this.from, this.to, text);
    return new MockRange(this.host, next.from, next.to);
  }

  /** Word's getTextRanges: one range per piece ending at an ending mark (the mark kept when trimSpacing is false). */
  getTextRanges(endingMarks: string[], trimSpacing = false): { items: MockRange[]; load: () => void } {
    const text = this.text;
    const items: MockRange[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (endingMarks.includes(text[index])) {
        items.push(new MockRange(this.host, this.from + start, this.from + index + 1));
        start = index + 1;
      }
    }
    if (start < text.length) {
      items.push(new MockRange(this.host, this.from + start, this.from + text.length));
    }
    if (trimSpacing) {
      return { items: items.map((item) => { const piece = item.text; const trimmed = piece.trimEnd(); return new MockRange(this.host, item.from, item.from + trimmed.length); }), load: () => undefined };
    }
    return { items, load: () => undefined };
  }

  get fields(): { items: Array<{ result: MockRange; load: () => void }>; load: () => void } {
    const host = this.host;
    const items = host.fields
      .filter((field) => field.from < this.to && field.to > this.from)
      .map((field) => ({ result: new MockRange(host, field.from, field.to), load: () => undefined }));
    return { items, load: () => undefined };
  }

  delete(): void {
    this.host.replaceRange(this.from, this.to, "");
  }

  insertComment(text: string): { text: string } {
    this.host.comments.push({ from: this.from, to: this.to, anchorText: this.text, text });
    return { text };
  }
}

export class MockInlinePicture {
  lockAspectRatio = true;
  private readonly picked: MockPictureSeed;

  constructor(private host: MockWordHost, index: number) {
    this.picked = host.pictures[index];
  }

  /** Word picture proxies stay bound to their picture as others are added or removed. */
  private get seed(): MockPictureSeed {
    return this.picked;
  }

  private get index(): number {
    return this.host.pictures.indexOf(this.picked);
  }

  get width(): number {
    return this.seed.width;
  }

  set width(value: number) {
    this.seed.width = value;
  }

  get height(): number {
    return this.seed.height;
  }

  set height(value: number) {
    this.seed.height = value;
  }

  get altTextDescription(): string {
    return this.seed.altText ?? "";
  }

  get altTextTitle(): string {
    return "";
  }

  get paragraph(): MockParagraph {
    return new MockParagraph(this.host, this.seed.paragraphIndex);
  }

  load(): this {
    return this;
  }

  getBase64ImageSrc(): { value: string } {
    return { value: this.seed.base64 };
  }

  insertInlinePictureFromBase64(base64: string, location: string): MockInlinePicture {
    if (location !== "Replace") {
      throw new Error(`Mock Word: unsupported picture insert location ${location}`);
    }
    this.host.replacePicture(this.index, base64);
    return this;
  }

  delete(): void {
    this.host.deletePicture(this.index);
  }

  getRange(): MockRange {
    const range = this.host.paragraphRange(this.seed.paragraphIndex);
    return new MockRange(this.host, range.from, range.to);
  }

  select(): void {
    const range = this.host.paragraphRange(this.seed.paragraphIndex);
    this.host.setSelection(range.from, range.to);
  }
}

/** Uniform values read back as Word reports them; mixed ranges read null (bold/italic/underline) or "" (highlightColor). */
export class MockFont {
  constructor(private host: MockWordHost, private from: number, private to: number) {}

  load(): this {
    return this;
  }

  get bold(): boolean | null {
    return this.host.emphasisKindOver(this.from, this.to, "bold");
  }

  set bold(value: boolean) {
    this.host.setEmphasis(this.from, this.to, "bold", Boolean(value));
  }

  get italic(): boolean | null {
    return this.host.emphasisKindOver(this.from, this.to, "italic");
  }

  set italic(value: boolean) {
    this.host.setEmphasis(this.from, this.to, "italic", Boolean(value));
  }

  get underline(): string | null {
    const on = this.host.emphasisKindOver(this.from, this.to, "underline");
    return on === null ? null : on ? "Single" : "None";
  }

  set underline(value: string) {
    this.host.setEmphasis(this.from, this.to, "underline", value !== "None");
  }

  get highlightColor(): string | null {
    const on = this.host.emphasisKindOver(this.from, this.to, "highlight");
    return on === null ? "" : on ? "#FFFF00" : null;
  }

  set highlightColor(value: string | null) {
    this.host.setEmphasis(this.from, this.to, "highlight", Boolean(value));
  }
}

export class MockParagraph extends MockRange {
  constructor(host: MockWordHost, public index: number) {
    const range = host.paragraphRange(index);
    super(host, range.from, range.to);
  }

  /** Word paragraph proxies follow the document as it changes; so does this one. */
  private refresh(): this {
    const range = this.host.paragraphRange(this.index);
    this.from = range.from;
    this.to = range.to;
    return this;
  }

  override getRange(location: string = "Whole"): MockRange {
    return super.getRange.call(this.refresh(), location);
  }

  override getTextRanges(endingMarks: string[], trimSpacing = false): { items: MockRange[]; load: () => void } {
    return super.getTextRanges.call(this.refresh(), endingMarks, trimSpacing);
  }

  override expandTo(other: MockRange): MockRange {
    return super.expandTo.call(this.refresh(), other);
  }

  override insertText(text: string, location: string): MockRange {
    return super.insertText.call(this.refresh(), text, location);
  }

  override search(query: string, options?: { matchCase?: boolean; ignoreSpace?: boolean }): { items: MockRange[]; load: () => void } {
    return super.search.call(this.refresh(), query, options);
  }

  override get font(): MockFont {
    this.refresh();
    return new MockFont(this.host, this.from, this.to);
  }

  get text(): string {
    return this.host.paragraphs[this.index]?.text ?? "";
  }

  get style(): string {
    return this.host.paragraphs[this.index]?.style ?? "Normal";
  }

  get styleBuiltIn(): string {
    return this.host.paragraphs[this.index]?.styleBuiltIn ?? "Normal";
  }

  get outlineLevel(): number {
    return this.host.paragraphs[this.index]?.outlineLevel ?? 10;
  }

  get isListItem(): boolean {
    return Boolean(this.host.paragraphs[this.index]?.isListItem);
  }

  get tableNestingLevel(): number {
    return this.host.paragraphs[this.index]?.cell ? 1 : 0;
  }

  set styleBuiltIn(value: string) {
    const paragraph = this.host.paragraphs[this.index];
    if (paragraph) paragraph.styleBuiltIn = value;
  }

  get alignment(): string {
    return this.host.paragraphs[this.index]?.alignment ?? "Left";
  }

  set alignment(value: string) {
    const paragraph = this.host.paragraphs[this.index];
    if (paragraph) paragraph.alignment = value;
  }

  get inlinePictures(): { items: MockInlinePicture[]; load: () => void } {
    const host = this.host;
    const items = host.pictures.flatMap((picture, index) => (picture.paragraphIndex === this.index ? [new MockInlinePicture(host, index)] : []));
    return { items, load: () => undefined };
  }

  insertParagraph(text: string, location: string): MockParagraph {
    if (location !== "After" && location !== "Before") {
      throw new Error(`Mock Word: unsupported paragraph insert location ${location}`);
    }
    const at = location === "After" ? this.index + 1 : this.index;
    this.host.spliceParagraphs(at, 0, [{ text }]);
    if (location === "Before") {
      this.index += 1;
    }
    return new MockParagraph(this.host, at);
  }

  insertInlinePictureFromBase64(base64: string, location: string): MockInlinePicture {
    if (location !== "Start" && location !== "End") {
      throw new Error(`Mock Word: unsupported picture insert location ${location}`);
    }
    return new MockInlinePicture(this.host, this.host.insertPicture(this.index, base64));
  }

  override delete(): void {
    this.host.spliceParagraphs(this.index, 1, []);
  }

  insertTable(_rowCount: number, _columnCount: number, location: string, values: string[][]): MockTable {
    if (location !== "After") {
      throw new Error(`Mock Word: unsupported table insert location ${location}`);
    }
    return new MockTable(this.host, this.host.insertTable(this.index, values));
  }

  getPreviousOrNullObject(): MockParagraph {
    if (this.index === 0) {
      return nullParagraph(this.host);
    }
    return new MockParagraph(this.host, this.index - 1);
  }

  getNextOrNullObject(): MockParagraph {
    if (this.index >= this.host.paragraphs.length - 1) {
      return nullParagraph(this.host);
    }
    return new MockParagraph(this.host, this.index + 1);
  }
}

function nullParagraph(host: MockWordHost): MockParagraph {
  const paragraph = new MockParagraph(host, 0);
  paragraph.isNullObject = true;
  Object.defineProperty(paragraph, "text", { get: () => "" });
  return paragraph;
}

export class MockTable {
  nestingLevel = 1;
  isNullObject = false;

  constructor(private host: MockWordHost, public id: number) {}

  load(): this {
    return this;
  }

  get values(): string[][] {
    return this.host.tableGrid(this.id);
  }

  get rowCount(): number {
    return this.values.length;
  }

  get isUniform(): boolean {
    return !this.host.tableMeta.get(this.id)?.irregular;
  }

  set headerRowCount(value: number) {
    const meta = this.host.tableMeta.get(this.id);
    if (meta) meta.header = value;
  }

  set styleBuiltIn(value: string) {
    const meta = this.host.tableMeta.get(this.id);
    if (meta) meta.style = value;
  }

  get font(): MockFont {
    const range = this.host.tableRange(this.id);
    return new MockFont(this.host, range.from, range.to);
  }

  get rows(): { getFirst: () => MockTableRow } {
    return { getFirst: () => new MockTableRow(this.host, this.id, 0) };
  }

  getParagraphBeforeOrNullObject(): MockParagraph {
    const { first } = this.host.tableBlock(this.id);
    return first === 0 ? nullParagraph(this.host) : new MockParagraph(this.host, first - 1);
  }

  getCell(row: number, column: number): MockTableCell {
    const grid = this.values;
    if (!grid[row] || grid[row][column] === undefined) {
      throw new Error(`Mock Word: no cell ${row},${column}`);
    }
    return new MockTableCell(this.host, this.id, row, column);
  }

  deleteRows(row: number, count = 1): void {
    const grid = this.values;
    grid.splice(row, count);
    this.host.writeTable(this.id, grid.length ? grid : null, "deleteRows");
  }

  deleteColumns(column: number, count = 1): void {
    const grid = this.values.map((cells) => { const next = [...cells]; next.splice(column, count); return next; });
    this.host.writeTable(this.id, grid[0]?.length ? grid : null, "deleteColumns");
  }

  delete(): void {
    this.host.writeTable(this.id, null, "delete");
  }

  select(): void {
    const range = this.host.tableRange(this.id);
    this.host.setSelection(range.from, range.to);
  }
}

export class MockTableRow {
  constructor(private host: MockWordHost, private table: number, private row: number) {}

  get font(): MockFont {
    const range = this.host.tableRange(this.table, this.row);
    return new MockFont(this.host, range.from, range.to);
  }

  insertRows(location: string, count: number, values?: string[][]): void {
    const grid = this.host.tableGrid(this.table);
    const width = grid[0]?.length ?? 0;
    const rows = Array.from({ length: count }, (_, index) => Array.from({ length: width }, (_, column) => values?.[index]?.[column] ?? ""));
    grid.splice(location === "Before" ? this.row : this.row + 1, 0, ...rows);
    this.host.writeTable(this.table, grid, "insertRows");
  }
}

export class MockTableCell {
  constructor(private host: MockWordHost, private table: number, private row: number, private column: number) {}

  get value(): string {
    return this.host.tableGrid(this.table)[this.row]?.[this.column] ?? "";
  }

  set value(text: string) {
    const grid = this.host.tableGrid(this.table);
    grid[this.row][this.column] = text;
    this.host.writeTable(this.table, grid, "setCell");
  }

  get parentRow(): MockTableRow {
    return new MockTableRow(this.host, this.table, this.row);
  }

  get body(): { font: MockFont } {
    const range = this.host.tableRange(this.table, this.row, this.column);
    return { font: new MockFont(this.host, range.from, range.to) };
  }

  insertColumns(location: string, count: number): void {
    const at = location === "Before" ? this.column : this.column + 1;
    const grid = this.host.tableGrid(this.table).map((cells) => { const next = [...cells]; next.splice(at, 0, ...Array.from({ length: count }, () => "")); return next; });
    this.host.writeTable(this.table, grid, "insertColumns");
  }
}

class MockPageCollection {
  items: MockPage[];

  constructor(host: MockWordHost, pages: Array<{ index: number; from: number; to: number }>) {
    this.items = pages.map((page) => new MockPage(host, page));
  }

  load(): this {
    return this;
  }
}

class MockPage {
  index: number;

  constructor(private host: MockWordHost, private page: { index: number; from: number; to: number }) {
    this.index = page.index;
  }

  load(): this {
    return this;
  }

  getRange(location: string = "Whole"): MockRange {
    if (location === "Start") {
      return new MockRange(this.host, this.page.from, this.page.from);
    }
    if (location === "End") {
      return new MockRange(this.host, this.page.to, this.page.to);
    }
    return new MockRange(this.host, this.page.from, this.page.to);
  }
}

/* ------------------------------------------------------------------------- */
/* Sample document for browser demos                                         */
/* ------------------------------------------------------------------------- */

export function sampleGrantDocument(): MockParagraphSeed[] {
  return [
    { text: "Specific Aims", styleBuiltIn: "Heading1", style: "Heading 1", outlineLevel: 1 },
    { text: "Chromatin accessibility is actually a very important determinant of gene regulation, and it is the case that many studies have looked at it." },
    { text: "We propose to leverage single-cell multiome profiling in order to characterize the dynamics of enhancer activation during hematopoietic differentiation. Our central hypothesis is that transient accessibility states precede lineage commitment." },
    { text: "Aim 1. Map accessibility dynamics at single-cell resolution.", styleBuiltIn: "Heading2", style: "Heading 2", outlineLevel: 2 },
    { text: "We will profile 50,000 cells across six time points. It is important to note that the preliminary data (Fig. 1) demonstrate feasibility of the approach in our hands [1,2]." },
    { text: "Aim 2. Model enhancer–promoter coupling.", styleBuiltIn: "Heading2", style: "Heading 2", outlineLevel: 2 },
    { text: "Using the model f(x) = Σ w_i x_i, we will estimate coupling strength for each enhancer–promoter pair and validate predictions with CRISPRi perturbations (see Approach, section C.3)." },
    { text: "Research Strategy", styleBuiltIn: "Heading1", style: "Heading 1", outlineLevel: 1 },
    { text: "Significance", styleBuiltIn: "Heading2", style: "Heading 2", outlineLevel: 2 },
    { text: "There is a large body of literature that has been accumulating over the years which suggests that regulatory variation contributes substantially to disease risk. However, the mechanisms remain poorly understood, and this is a gap that our proposal will address." },
    { text: "Innovation", styleBuiltIn: "Heading2", style: "Heading 2", outlineLevel: 2 },
    { text: "The proposed work is innovative because it combines temporal multiome data with a mechanistic coupling model, which has not been done before to our knowledge." },
    { text: "Approach", styleBuiltIn: "Heading2", style: "Heading 2", outlineLevel: 2 },
    { text: "Rationale. Preliminary studies in our laboratory have shown that the assay is robust (Fig. 2). We will therefore proceed to apply it at scale, taking care to include appropriate controls at every step of the way." },
    { text: "Expected outcomes. We expect to identify on the order of 10,000 dynamic enhancers. Potential pitfalls include batch effects, which we will mitigate with a balanced design; alternative strategies include bulk ATAC-seq on sorted populations." }
  ];
}
