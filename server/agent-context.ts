/**
 * Structural reads for agents: `writer_read_context`.
 *
 * Agents think in "the paragraph at the caret", "the section I'm in", "what is
 * on screen" — not in character offsets. This module answers those requests
 * against a run's document snapshot, using the paragraph index and window
 * state the Word add-in pushes (and falling back to line structure when a
 * request came from the web app). Offsets in every answer are offsets into
 * the run's document text, so results compose with writer_read_document and
 * writer_stage_suggestions.
 */

import type { WordHostContext, WordHostContextParagraph } from "../src/shared";
import { renderEmphasis } from "../src/emphasis";
import { currentHostContext, type AgentRunContext } from "./agent-run";

export type ContextKind = "selection" | "paragraph" | "section" | "page" | "outline" | "document";

export interface ContextParagraph {
  index: number;
  offset: number;
  length: number;
  level: number | null;
  style?: string | null;
}

export interface ContextHeading {
  index: number;
  offset: number;
  level: number | null;
  text: string;
}

export interface ContextReadResult {
  what: ContextKind;
  from: number;
  to: number;
  text: string;
  paragraphs: ContextParagraph[];
  heading: ContextHeading | null;
  caretOffset: number | null;
  /** True when the window state came from the add-in's latest push, not the request. */
  live: boolean;
  capturedAt: string | null;
  totalLength: number;
  paragraphCount: number;
  outline?: ContextHeading[];
  pages?: number[];
  note?: string;
}

export interface ContextReadParams {
  what?: unknown;
  around?: unknown;
  paragraphIndex?: unknown;
  before?: unknown;
  after?: unknown;
}

const TEXT_LIMIT = 60_000;
const MAX_NEIGHBOURS = 40;
const OUTLINE_LIMIT = 120;
const SECTION_FALLBACK_NEIGHBOURS = 3;

export function readAgentRunContext(run: AgentRunContext, params: ContextReadParams): ContextReadResult | { error: string } {
  const result = readAgentRunContextPlain(run, params);
  if ("error" in result || result.what === "outline" || !run.documentEmphasis?.length) {
    return result;
  }
  // Document slices carry their emphasis as markers, like every other read.
  return { ...result, text: renderEmphasis(result.text, run.documentEmphasis, result.from) };
}

function readAgentRunContextPlain(run: AgentRunContext, params: ContextReadParams): ContextReadResult | { error: string } {
  const what = parseKind(params.what);
  if (!what) {
    return { error: "what must be one of: selection, paragraph, section, page, outline, document." };
  }
  const { hostContext, live } = currentHostContext(run);
  const text = run.documentText;
  const paragraphs = paragraphIndex(text, hostContext);
  const base = {
    live,
    capturedAt: hostContext?.capturedAt ?? null,
    totalLength: text.length,
    paragraphCount: paragraphs.length,
    caretOffset: hostContext?.cursor?.offset ?? null
  };
  const before = clampCount(params.before);
  const after = clampCount(params.after);

  if (what === "document") {
    // The whole document (bounded like every other read) so an agent whose
    // scoped passage is not enough can widen to everything in one call.
    const outline = outlineOf(text, paragraphs, hostContext);
    const body = bounded(text);
    const complete = body.length >= text.length;
    return {
      ...base,
      what,
      from: 0,
      to: body.length,
      text: body,
      paragraphs: paragraphs.filter((paragraph) => paragraph.offset < body.length),
      heading: null,
      outline,
      pages: hostContext?.viewport?.pages ?? [],
      note: complete
        ? `The document is ${text.length.toLocaleString()} characters in ${paragraphs.length} paragraphs — this is all of it.`
        : `The document is ${text.length.toLocaleString()} characters in ${paragraphs.length} paragraphs; this is the first ${TEXT_LIMIT.toLocaleString()}. Read the rest with writer_read_document(offset=${TEXT_LIMIT}, limit=${TEXT_LIMIT}) and onwards, or locate passages with writer_search_document.`
    };
  }

  if (what === "outline") {
    const outline = outlineOf(text, paragraphs, hostContext);
    const anchor = anchorParagraph(paragraphs, hostContext, params);
    const current = anchor === null ? null : headingFor(paragraphs, anchor, outline);
    return {
      ...base,
      what,
      from: 0,
      to: text.length,
      text: outline.map((entry) => `${"#".repeat(Math.max(1, Math.min(6, entry.level ?? 1)))} ${entry.text}  [offset ${entry.offset}, paragraph ${entry.index}]`).join("\n"),
      paragraphs: [],
      heading: current,
      outline,
      note: outline.length ? undefined : "No headings were found; the document may use plain paragraphs for its structure."
    };
  }

  if (what === "selection") {
    const selection = hostContext?.selection ?? run.selection ?? null;
    if (!selection || !selection.text.trim()) {
      const caret = anchorParagraph(paragraphs, hostContext, { around: "caret" });
      const fallback = caret === null ? null : sliceParagraphs(text, paragraphs, caret, 0, 0);
      return {
        ...base,
        what,
        from: fallback?.from ?? (base.caretOffset ?? 0),
        to: fallback?.to ?? (base.caretOffset ?? 0),
        text: fallback?.text ?? "",
        paragraphs: fallback?.paragraphs ?? [],
        heading: caret === null ? null : headingFor(paragraphs, caret, outlineOf(text, paragraphs, hostContext)),
        note: "Nothing is selected; this is the paragraph at the caret instead."
      };
    }
    const covered = paragraphs.filter((paragraph) => paragraph.offset < selection.to && paragraph.offset + paragraph.length > selection.from);
    return {
      ...base,
      what,
      from: selection.from,
      to: selection.to,
      text: selection.text,
      paragraphs: covered,
      heading: covered.length ? headingFor(paragraphs, covered[0].index, outlineOf(text, paragraphs, hostContext)) : null
    };
  }

  if (what === "page") {
    const viewport = hostContext?.viewport ?? null;
    if (!viewport || viewport.to <= viewport.from) {
      const caret = anchorParagraph(paragraphs, hostContext, params);
      const fallback = caret === null ? null : sliceParagraphs(text, paragraphs, caret, 5, 5);
      return {
        ...base,
        what,
        from: fallback?.from ?? 0,
        to: fallback?.to ?? 0,
        text: fallback?.text ?? "",
        paragraphs: fallback?.paragraphs ?? [],
        heading: caret === null ? null : headingFor(paragraphs, caret, outlineOf(text, paragraphs, hostContext)),
        note: "Pages are only known while the Word add-in is open on this document; this is the neighbourhood of the caret instead."
      };
    }
    const from = Math.max(0, Math.min(text.length, viewport.from));
    const to = Math.max(from, Math.min(text.length, viewport.to));
    const covered = paragraphs.filter((paragraph) => paragraph.offset < to && paragraph.offset + paragraph.length > from);
    return {
      ...base,
      what,
      from,
      to,
      text: bounded(text.slice(from, to)),
      paragraphs: covered,
      heading: covered.length ? headingFor(paragraphs, covered[0].index, outlineOf(text, paragraphs, hostContext)) : null,
      pages: viewport.pages,
      note: to - from > TEXT_LIMIT ? `Text truncated to ${TEXT_LIMIT.toLocaleString()} characters.` : undefined
    };
  }

  const anchor = anchorParagraph(paragraphs, hostContext, params);
  if (anchor === null) {
    return {
      ...base,
      what,
      from: 0,
      to: 0,
      text: "",
      paragraphs: [],
      heading: null,
      note: "No caret position is known for this run (the request did not come from the Word add-in) — pass `around` (a character offset) or `paragraph_index`."
    };
  }
  const outline = outlineOf(text, paragraphs, hostContext);

  if (what === "paragraph") {
    const slice = sliceParagraphs(text, paragraphs, anchor, before, after);
    return { ...base, what, ...slice, heading: headingFor(paragraphs, anchor, outline) };
  }

  // section
  const heading = headingFor(paragraphs, anchor, outline);
  if (!heading) {
    const slice = sliceParagraphs(text, paragraphs, anchor, SECTION_FALLBACK_NEIGHBOURS, SECTION_FALLBACK_NEIGHBOURS);
    return { ...base, what, ...slice, heading: null, note: "No heading above this point; returning the surrounding paragraphs instead." };
  }
  const level = heading.level ?? 1;
  const next = outline.find((entry) => entry.index > heading.index && (entry.level ?? 1) <= level);
  const lastIndex = next ? next.index - 1 : paragraphs.length - 1;
  const slice = sliceRange(text, paragraphs, heading.index, lastIndex);
  return { ...base, what, ...slice, heading, note: slice.text.length >= TEXT_LIMIT ? `Section truncated to ${TEXT_LIMIT.toLocaleString()} characters; use writer_read_document for the rest.` : undefined };
}

/* ------------------------------------------------------------------------ */

function parseKind(value: unknown): ContextKind | null {
  const kinds: ContextKind[] = ["selection", "paragraph", "section", "page", "outline", "document"];
  return typeof value === "string" && kinds.includes(value as ContextKind) ? (value as ContextKind) : null;
}

function clampCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : 0;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.min(MAX_NEIGHBOURS, Math.floor(parsed));
}

/** The run's paragraph list: the add-in's pushed index when present, otherwise line structure. */
export function paragraphIndex(text: string, hostContext: WordHostContext | null): ContextParagraph[] {
  const pushed = hostContext?.paragraphs;
  if (pushed && pushed.length && consistent(pushed, text)) {
    return pushed.map((paragraph, index) => ({ index, offset: paragraph.offset, length: paragraph.length, level: paragraph.level, style: paragraph.style ?? null }));
  }
  const paragraphs: ContextParagraph[] = [];
  const outlineByOffset = new Map((hostContext?.outline ?? []).map((entry) => [entry.offset, entry.level]));
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.trim()) {
      paragraphs.push({ index: paragraphs.length, offset, length: line.length, level: outlineByOffset.get(offset) ?? null });
    }
    offset += line.length + 1;
  }
  return paragraphs;
}

function consistent(pushed: WordHostContextParagraph[], text: string): boolean {
  const last = pushed[pushed.length - 1];
  return last.offset + last.length <= text.length + 1;
}

function outlineOf(text: string, paragraphs: ContextParagraph[], hostContext: WordHostContext | null): ContextHeading[] {
  const fromParagraphs = paragraphs
    .filter((paragraph) => paragraph.level !== null && text.slice(paragraph.offset, paragraph.offset + paragraph.length).trim())
    .map((paragraph) => ({ index: paragraph.index, offset: paragraph.offset, level: paragraph.level, text: clip(text.slice(paragraph.offset, paragraph.offset + paragraph.length)) }));
  if (fromParagraphs.length) {
    return fromParagraphs.slice(0, OUTLINE_LIMIT);
  }
  return (hostContext?.outline ?? [])
    .map((entry) => ({ index: paragraphAt(paragraphs, entry.offset)?.index ?? entry.paragraphIndex, offset: entry.offset, level: entry.level, text: entry.heading }))
    .slice(0, OUTLINE_LIMIT);
}

function anchorParagraph(paragraphs: ContextParagraph[], hostContext: WordHostContext | null, params: ContextReadParams): number | null {
  if (!paragraphs.length) {
    return null;
  }
  const explicitIndex = typeof params.paragraphIndex === "number" ? params.paragraphIndex : typeof params.paragraphIndex === "string" && params.paragraphIndex.trim() ? Number(params.paragraphIndex) : NaN;
  if (Number.isInteger(explicitIndex) && explicitIndex >= 0 && explicitIndex < paragraphs.length) {
    return explicitIndex;
  }
  const around = params.around;
  if (typeof around === "number" || (typeof around === "string" && /^\d+$/.test(around.trim()))) {
    return paragraphAt(paragraphs, Number(around))?.index ?? null;
  }
  if (around === "selection" && hostContext?.selection) {
    return paragraphAt(paragraphs, hostContext.selection.from)?.index ?? null;
  }
  const caret = hostContext?.cursor?.offset;
  if (typeof caret === "number") {
    return paragraphAt(paragraphs, caret)?.index ?? null;
  }
  if (hostContext?.selection) {
    return paragraphAt(paragraphs, hostContext.selection.from)?.index ?? null;
  }
  return null;
}

function paragraphAt(paragraphs: ContextParagraph[], offset: number): ContextParagraph | null {
  if (!paragraphs.length) {
    return null;
  }
  let low = 0;
  let high = paragraphs.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (paragraphs[mid].offset <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return paragraphs[low];
}

function headingFor(paragraphs: ContextParagraph[], index: number, outline: ContextHeading[]): ContextHeading | null {
  let best: ContextHeading | null = null;
  for (const entry of outline) {
    if (entry.index <= index) {
      best = entry;
    } else {
      break;
    }
  }
  return best ?? (paragraphs[index]?.level !== null ? null : null);
}

function sliceParagraphs(text: string, paragraphs: ContextParagraph[], index: number, before: number, after: number): { from: number; to: number; text: string; paragraphs: ContextParagraph[] } {
  const first = Math.max(0, index - before);
  const last = Math.min(paragraphs.length - 1, index + after);
  return sliceRange(text, paragraphs, first, last);
}

function sliceRange(text: string, paragraphs: ContextParagraph[], first: number, last: number): { from: number; to: number; text: string; paragraphs: ContextParagraph[] } {
  const from = paragraphs[first]?.offset ?? 0;
  const end = paragraphs[last];
  const to = end ? end.offset + end.length : from;
  return { from, to, text: bounded(text.slice(from, to)), paragraphs: paragraphs.slice(first, last + 1) };
}

function bounded(text: string): string {
  return text.length <= TEXT_LIMIT ? text : text.slice(0, TEXT_LIMIT);
}

function clip(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 159)}…`;
}
