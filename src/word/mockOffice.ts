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

export interface MockParagraphSeed {
  text: string;
  style?: string;
  styleBuiltIn?: string;
  outlineLevel?: number;
  isListItem?: boolean;
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
}

const PARAGRAPH_SEPARATOR = "\n";

type Handler = () => void;

interface ParagraphState extends MockParagraphSeed {
  text: string;
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
  /** Every insertText/delete, tracked or not. */
  edits: MockTrackedChange[] = [];
  selectionHandlers = new Set<Handler>();
  paragraphHandlers = new Set<Handler>();
  runCount = 0;
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

  load(): this {
    return this;
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
    if (location !== "Replace") {
      throw new Error(`Mock Word: unsupported insert location ${location}`);
    }
    const next = this.host.replaceRange(this.from, this.to, text);
    return new MockRange(this.host, next.from, next.to);
  }

  delete(): void {
    this.host.replaceRange(this.from, this.to, "");
  }

  insertComment(text: string): { text: string } {
    this.host.comments.push({ from: this.from, to: this.to, anchorText: this.text, text });
    return { text };
  }
}

export class MockParagraph extends MockRange {
  constructor(host: MockWordHost, public index: number) {
    const range = host.paragraphRange(index);
    super(host, range.from, range.to);
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
