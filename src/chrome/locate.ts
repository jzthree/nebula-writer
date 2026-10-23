/**
 * Locate for the Chrome extension. The Docs REST API cannot move the reader's
 * view, so the content script does it on the page: Docs paints text on a
 * canvas, and when its accessible text layer is on (SVG rects whose
 * aria-label is the text of each run) the passage is found there, scrolled
 * into view and highlighted. Without that layer the view scrolls to the
 * passage's estimated position in the document.
 *
 * Text is compared with all whitespace removed: runs split lines and tabs
 * differently from the document's own text.
 */

/** At most this many characters of the passage identify it on the page. */
const KEY_CHARS = 120;
const HIGHLIGHT_MS = 2_500;

export interface LocateRequest {
  /** The passage, whitespace removed. */
  needle: string;
  /** Which occurrence (0-based) of the passage's key the passage is, counted from the top. */
  occurrence: number;
  /** How many times the key occurs in the document. */
  total: number;
  /** Where the passage starts, as a fraction of the document's text. */
  fraction: number;
}

export interface LocateResult {
  located: "exact" | "approximate";
}

export function stripSpace(text: string): string {
  return text.replace(/[\s​﻿]+/gu, "");
}

function occurrences(haystack: string, key: string, before = Infinity): number {
  let count = 0;
  for (let at = haystack.indexOf(key); at >= 0 && at < before; at = haystack.indexOf(key, at + 1)) {
    count += 1;
  }
  return count;
}

/** Build the request for a range of the document (paragraph coordinates, as the pane sends them). */
export function buildLocateRequest(
  paragraphs: ReadonlyArray<{ text: string }>,
  range: { paragraphIndex: number; start: number; endParagraphIndex: number; end: number }
): LocateRequest | null {
  const first = paragraphs[range.paragraphIndex];
  const last = paragraphs[range.endParagraphIndex];
  if (!first || !last || range.endParagraphIndex < range.paragraphIndex) {
    return null;
  }
  const passage = range.paragraphIndex === range.endParagraphIndex
    ? first.text.slice(range.start, range.end)
    : [first.text.slice(range.start), ...paragraphs.slice(range.paragraphIndex + 1, range.endParagraphIndex).map((p) => p.text), last.text.slice(0, range.end)].join("\n");
  const needle = stripSpace(passage);
  if (!needle) {
    return null;
  }
  const before = stripSpace([...paragraphs.slice(0, range.paragraphIndex).map((p) => p.text), first.text.slice(0, range.start)].join(""));
  const whole = stripSpace(paragraphs.map((p) => p.text).join(""));
  const key = needle.slice(0, KEY_CHARS);
  return {
    needle,
    occurrence: occurrences(whole, key, before.length),
    total: Math.max(1, occurrences(whole, key)),
    fraction: whole.length ? before.length / whole.length : 0
  };
}

interface Run {
  rect: Element;
  text: string;
}

/** The accessible text runs Docs has rendered, in document order. */
export function collectRuns(root: ParentNode): Run[] {
  const runs: Run[] = [];
  for (const rect of root.querySelectorAll("svg rect[aria-label]")) {
    const text = stripSpace(rect.getAttribute("aria-label") ?? "");
    if (text) {
      runs.push({ rect, text });
    }
  }
  return runs;
}

export interface RunMatch {
  /** Pieces of runs the match covers: the run and the [from, to) characters of its stripped text. */
  pieces: Array<{ rect: Element; from: number; to: number; length: number }>;
}

/** Every place the passage's key starts among the runs; each match extends as far as the passage and the rendered runs agree. */
export function findInRuns(runs: Run[], needle: string): RunMatch[] {
  const key = needle.slice(0, KEY_CHARS);
  const joined = runs.map((run) => run.text).join("");
  const starts: number[] = [];
  let offset = 0;
  for (const run of runs) {
    starts.push(offset);
    offset += run.text.length;
  }
  const matches: RunMatch[] = [];
  for (let at = joined.indexOf(key); at >= 0; at = joined.indexOf(key, at + 1)) {
    let length = key.length;
    while (length < needle.length && at + length < joined.length && joined[at + length] === needle[length]) {
      length += 1;
    }
    const end = at + length;
    const pieces: RunMatch["pieces"] = [];
    runs.forEach((run, index) => {
      const from = Math.max(at, starts[index]);
      const to = Math.min(end, starts[index] + run.text.length);
      if (from < to) {
        pieces.push({ rect: run.rect, from: from - starts[index], to: to - starts[index], length: run.text.length });
      }
    });
    matches.push({ pieces });
  }
  return matches;
}

function editorOf(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(".kix-appview-editor");
}

/** A match's vertical position in the editor's scrolled content. */
function contentTop(editor: HTMLElement, match: RunMatch): number {
  return match.pieces[0].rect.getBoundingClientRect().top - editor.getBoundingClientRect().top + editor.scrollTop;
}

function settle(view: Window): Promise<void> {
  // Docs renders the scrolled-to tiles over the next frames.
  return new Promise((resolve) => view.requestAnimationFrame(() => view.setTimeout(resolve, 120)));
}

let clearHighlight: (() => void) | null = null;

function highlight(doc: Document, editor: HTMLElement, match: RunMatch): void {
  clearHighlight?.();
  const view = doc.defaultView!;
  const layer = doc.createElement("div");
  layer.setAttribute("data-nebula-locate", "");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
  for (const piece of match.pieces) {
    const box = piece.rect.getBoundingClientRect();
    // Within a run, characters are taken as evenly wide.
    const left = box.left + (box.width * piece.from) / piece.length;
    const width = (box.width * (piece.to - piece.from)) / piece.length;
    const mark = doc.createElement("div");
    mark.style.cssText = `position:fixed;left:${left}px;top:${box.top - 1}px;width:${width}px;height:${box.height + 2}px;background:rgba(255,196,0,.45);border-radius:2px;transition:opacity .4s;`;
    layer.appendChild(mark);
  }
  doc.body.appendChild(layer);
  let timer = 0;
  const clear = () => {
    view.clearTimeout(timer);
    editor.removeEventListener("scroll", clear);
    layer.remove();
    if (clearHighlight === clear) {
      clearHighlight = null;
    }
  };
  editor.addEventListener("scroll", clear, { once: true });
  timer = view.setTimeout(clear, HIGHLIGHT_MS);
  clearHighlight = clear;
}

async function reveal(doc: Document, editor: HTMLElement, top: number, request: LocateRequest): Promise<boolean> {
  editor.scrollTop = Math.max(0, top - editor.clientHeight / 3);
  await settle(doc.defaultView!);
  // Positions are fresh after the scroll; pick the match nearest where it was found.
  const matches = findInRuns(collectRuns(doc), request.needle);
  const nearest = matches.sort((a, b) => Math.abs(contentTop(editor, a) - top) - Math.abs(contentTop(editor, b) - top))[0];
  if (!nearest) {
    return false;
  }
  highlight(doc, editor, nearest);
  return true;
}

/** Scroll the passage into view and highlight it. */
export async function locateInPage(doc: Document, request: LocateRequest): Promise<LocateResult> {
  const editor = editorOf(doc);
  if (!editor) {
    throw new Error("Writer could not find the Google Docs editor in this tab. Refresh the document and try again.");
  }
  const view = doc.defaultView!;
  const estimate = request.fraction * editor.scrollHeight;
  const hasTextLayer = collectRuns(doc).length > 0;
  if (!hasTextLayer) {
    editor.scrollTop = Math.max(0, estimate - editor.clientHeight / 3);
    return { located: "approximate" };
  }
  // A passage that occurs once: look where it should be first.
  if (request.total === 1) {
    editor.scrollTop = Math.max(0, estimate - editor.clientHeight / 3);
    await settle(view);
    const [match] = findInRuns(collectRuns(doc), request.needle);
    if (match && await reveal(doc, editor, contentTop(editor, match), request)) {
      return { located: "exact" };
    }
  }
  // Otherwise sweep the document from the top, counting occurrences in order.
  const seen: number[] = [];
  const step = Math.max(200, editor.clientHeight * 0.8);
  for (let top = 0; top < editor.scrollHeight; top += step) {
    editor.scrollTop = top;
    await settle(view);
    for (const match of findInRuns(collectRuns(doc), request.needle)) {
      const at = contentTop(editor, match);
      if (!seen.some((y) => Math.abs(y - at) < 2)) {
        seen.push(at);
        seen.sort((a, b) => a - b);
      }
    }
    if (seen.length > request.occurrence) {
      return { located: await reveal(doc, editor, seen[request.occurrence], request) ? "exact" : "approximate" };
    }
  }
  editor.scrollTop = Math.max(0, estimate - editor.clientHeight / 3);
  return { located: "approximate" };
}
