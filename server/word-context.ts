/**
 * Word add-in window state ("host context") — validation and prompt rendering.
 *
 * The task pane captures where the author is inside Microsoft Word (caret,
 * selection, section heading, pages on screen, recent focus trail) and sends
 * it with AI requests and periodic context pushes. This module bounds and
 * validates that payload (it comes from a browser) and renders it as prompt
 * lines so both the agentic engine and the one-shot CLI prompt can act on
 * "this paragraph" / "the section I'm looking at".
 */

import {
  WORD_HOST_CONTEXT_LIMITS,
  type SelectionContext,
  type WordHostContext,
  type WordHostContextCursor,
  type WordHostContextFocusEntry,
  type WordHostContextOutlineEntry,
  type WordHostContextParagraph,
  type WordHostContextSection,
  type WordHostContextViewport
} from "../src/shared";

const SELECTION_INLINE_LIMIT = 1_200;
const PROMPT_EXCERPT_LIMIT = 160;
const PROMPT_PARAGRAPH_LIMIT = 400;
const PROMPT_OUTLINE_LIMIT = 40;
const PROMPT_FOCUS_LIMIT = 5;

export function parseWordHostContext(value: unknown): { hostContext: WordHostContext | null } | { error: string } {
  if (value === undefined || value === null) {
    return { hostContext: null };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "hostContext must be an object describing the Word window state when provided." };
  }
  const raw = value as Record<string, unknown>;
  const documentLength = finiteNonNegative(raw.documentLength);
  if (documentLength === null) {
    return { error: "hostContext.documentLength must be a non-negative number." };
  }
  const selection = parseSelection(raw.selection);
  if (selection !== null && "error" in selection) {
    return selection;
  }
  return {
    hostContext: {
      source: "word-addin",
      documentName: optionalString(raw.documentName, 200),
      capturedAt: typeof raw.capturedAt === "string" && raw.capturedAt.trim() ? raw.capturedAt.trim().slice(0, 40) : new Date().toISOString(),
      documentLength,
      paragraphCount: finiteNonNegative(raw.paragraphCount) ?? 0,
      selection: selection ?? null,
      cursor: parseCursor(raw.cursor),
      section: parseSection(raw.section),
      viewport: parseViewport(raw.viewport),
      recentFocus: parseFocusTrail(raw.recentFocus),
      outline: parseOutline(raw.outline),
      changeTrackingMode: optionalString(raw.changeTrackingMode, 40),
      ...(Array.isArray(raw.paragraphs) ? { paragraphs: parseParagraphs(raw.paragraphs) } : {})
    }
  };
}

const PARAGRAPH_INDEX_LIMIT = 6_000;

function parseParagraphs(value: unknown[]): WordHostContextParagraph[] {
  const paragraphs: WordHostContextParagraph[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const raw = item as Record<string, unknown>;
    const offset = finiteNonNegative(raw.offset);
    const length = finiteNonNegative(raw.length);
    if (offset === null || length === null) {
      continue;
    }
    paragraphs.push({ offset, length, level: headingLevel(raw.level), style: optionalString(raw.style, 60) });
    if (paragraphs.length >= PARAGRAPH_INDEX_LIMIT) {
      break;
    }
  }
  return paragraphs;
}

/** The selection an agent should treat as "the selected text", if any. */
export function hostContextSelection(hostContext: WordHostContext | null | undefined): SelectionContext | null {
  const selection = hostContext?.selection;
  return selection && selection.text.trim() ? selection : null;
}

export interface DescribeHostContextOptions {
  mode: "global" | "selection";
  /** "mcp" mentions the writer_* tools; "inline" is for the one-shot prompt whose Text block is the whole document. */
  tooling: "mcp" | "inline";
}

/** Prompt lines describing the Word window state. Empty when there is nothing useful to say. */
export function describeWordHostContext(hostContext: WordHostContext | null | undefined, options: DescribeHostContextOptions): string[] {
  if (!hostContext) {
    return [];
  }
  const lines: string[] = [];
  const name = hostContext.documentName ? ` on "${hostContext.documentName}"` : "";
  lines.push(`Word window state (captured ${describeAge(hostContext.capturedAt)}): the author is working in Microsoft Word${name}. Offsets below are character offsets into the document text.`);

  const cursor = hostContext.cursor;
  if (cursor) {
    const where = [
      `offset ${formatInt(cursor.offset)} of ${formatInt(hostContext.documentLength)}`,
      cursor.paragraphIndex !== null && hostContext.paragraphCount > 0
        ? `paragraph ${formatInt(cursor.paragraphIndex + 1)} of ${formatInt(hostContext.paragraphCount)}`
        : null,
      hostContext.section ? `under the heading "${clip(hostContext.section.heading, PROMPT_EXCERPT_LIMIT)}"` : null
    ].filter((part): part is string => Boolean(part)).join(", ");
    lines.push(`- Caret: ${where}.`);
    if (cursor.paragraphText?.trim()) {
      lines.push(`- Paragraph at the caret: "${clip(cursor.paragraphText, PROMPT_PARAGRAPH_LIMIT)}"`);
    }
    if (cursor.sentence?.trim() && cursor.sentence.trim() !== cursor.paragraphText?.trim()) {
      lines.push(`- Sentence at the caret: "${clip(cursor.sentence, PROMPT_PARAGRAPH_LIMIT)}"`);
    }
  } else if (hostContext.section) {
    lines.push(`- The author is under the heading "${clip(hostContext.section.heading, PROMPT_EXCERPT_LIMIT)}".`);
  }

  const selection = hostContextSelection(hostContext);
  if (selection) {
    if (options.mode === "selection") {
      lines.push(`- The selection spans offsets ${formatInt(selection.from)}-${formatInt(selection.to)} (${formatInt(selection.text.length)} characters).`);
    } else if (selection.text.length <= SELECTION_INLINE_LIMIT) {
      lines.push(`- Selected text (offsets ${formatInt(selection.from)}-${formatInt(selection.to)}; the instruction may call it "this"):`, "<<<selected", selection.text, ">>>");
    } else {
      lines.push(`- Selected text: ${formatInt(selection.text.length)} characters at offsets ${formatInt(selection.from)}-${formatInt(selection.to)}, starting "${clip(selection.text, PROMPT_EXCERPT_LIMIT)}".`);
    }
  }

  const viewport = hostContext.viewport;
  if (viewport) {
    const pages = viewport.pages.length
      ? `page${viewport.pages.length === 1 ? "" : "s"} ${describePages(viewport.pages)}, `
      : "";
    const edges = [
      viewport.leadingText.trim() ? `starting "${clip(viewport.leadingText, PROMPT_EXCERPT_LIMIT)}"` : null,
      viewport.trailingText.trim() ? `ending "${clip(viewport.trailingText, PROMPT_EXCERPT_LIMIT)}"` : null
    ].filter((part): part is string => Boolean(part));
    lines.push(`- On screen right now: ${pages}offsets ${formatInt(viewport.from)}-${formatInt(viewport.to)}${edges.length ? `, ${edges.join(" and ")}` : ""}.`);
  }

  const trail = hostContext.recentFocus.slice(-PROMPT_FOCUS_LIMIT).reverse();
  if (trail.length) {
    lines.push(`- Recently paused at (most recent first): ${trail.map((entry) => `"${clip(entry.excerpt, 90)}" (offset ${formatInt(entry.offset)}${entry.heading ? `, under "${clip(entry.heading, 60)}"` : ""})`).join("; ")}.`);
  }

  if (hostContext.outline.length) {
    const shown = hostContext.outline.slice(0, PROMPT_OUTLINE_LIMIT);
    lines.push(`- Document outline: ${shown.map((entry) => `${entry.level ? `H${entry.level} ` : ""}"${clip(entry.heading, 70)}" @${formatInt(entry.offset)}`).join(" · ")}${hostContext.outline.length > shown.length ? ` · … (${hostContext.outline.length - shown.length} more)` : ""}.`);
  }

  if (hostContext.changeTrackingMode) {
    lines.push(`- Word change tracking: ${hostContext.changeTrackingMode}.`);
  }

  const readHint = options.tooling === "mcp"
    ? viewport
      ? ` writer_read_document(offset=${Math.max(0, viewport.from)}, limit=${Math.max(1, Math.min(60_000, viewport.to - viewport.from + 1))}) reads exactly what is on screen.`
      : cursor
        ? ` writer_read_document(offset=${Math.max(0, cursor.offset - 1_500)}, limit=4000) reads around the caret.`
        : ""
    : "";
  lines.push(
    options.mode === "selection"
      ? `Use this state for orientation only — the selection above is the scope for edits, not a limit on what you may read: read more of the document whenever the selection alone is not enough.${readHint}`
      : `Resolve deictic instructions ("this paragraph", "here", "the section I'm in") against this state, and unless the request is explicitly document-wide, prioritize the passage at the caret and the pages on screen before anything else.${readHint} Read further — up to the whole document — whenever that is needed to answer well.`
  );
  return lines;
}

/* ----------------------------- parsing helpers ----------------------------- */

function parseSelection(value: unknown): SelectionContext | { error: string } | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object") {
    return { error: "hostContext.selection must be an object with from/to/text when provided." };
  }
  const raw = value as Record<string, unknown>;
  const from = finiteNonNegative(raw.from);
  const to = finiteNonNegative(raw.to);
  if (from === null || to === null || typeof raw.text !== "string") {
    return { error: "hostContext.selection requires numeric from/to offsets and a text string." };
  }
  if (!raw.text.trim()) {
    return null;
  }
  return { from: Math.min(from, to), to: Math.max(from, to), text: raw.text };
}

function parseCursor(value: unknown): WordHostContextCursor | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const offset = finiteNonNegative(raw.offset);
  if (offset === null) {
    return null;
  }
  return {
    offset,
    paragraphIndex: finiteNonNegative(raw.paragraphIndex),
    paragraphText: optionalString(raw.paragraphText, WORD_HOST_CONTEXT_LIMITS.paragraphText),
    sentence: optionalString(raw.sentence, WORD_HOST_CONTEXT_LIMITS.sentence)
  };
}

function parseSection(value: unknown): WordHostContextSection | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const heading = optionalString(raw.heading, WORD_HOST_CONTEXT_LIMITS.excerpt);
  const paragraphIndex = finiteNonNegative(raw.paragraphIndex);
  const offset = finiteNonNegative(raw.offset);
  if (!heading || paragraphIndex === null || offset === null) {
    return null;
  }
  return { heading, level: headingLevel(raw.level), paragraphIndex, offset };
}

function parseViewport(value: unknown): WordHostContextViewport | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const from = finiteNonNegative(raw.from);
  const to = finiteNonNegative(raw.to);
  if (from === null || to === null) {
    return null;
  }
  const pages = Array.isArray(raw.pages)
    ? raw.pages.filter((page): page is number => typeof page === "number" && Number.isSafeInteger(page) && page > 0).slice(0, 50)
    : [];
  return {
    from: Math.min(from, to),
    to: Math.max(from, to),
    pages,
    leadingText: optionalString(raw.leadingText, WORD_HOST_CONTEXT_LIMITS.excerpt) ?? "",
    trailingText: optionalString(raw.trailingText, WORD_HOST_CONTEXT_LIMITS.excerpt) ?? ""
  };
}

function parseFocusTrail(value: unknown): WordHostContextFocusEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: WordHostContextFocusEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const raw = item as Record<string, unknown>;
    const offset = finiteNonNegative(raw.offset);
    const paragraphIndex = finiteNonNegative(raw.paragraphIndex);
    const excerpt = optionalString(raw.excerpt, WORD_HOST_CONTEXT_LIMITS.excerpt);
    if (offset === null || paragraphIndex === null || !excerpt) {
      continue;
    }
    entries.push({
      offset,
      paragraphIndex,
      excerpt,
      heading: optionalString(raw.heading, WORD_HOST_CONTEXT_LIMITS.excerpt),
      at: typeof raw.at === "string" ? raw.at.slice(0, 40) : ""
    });
  }
  return entries.slice(-WORD_HOST_CONTEXT_LIMITS.recentFocus);
}

function parseOutline(value: unknown): WordHostContextOutlineEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: WordHostContextOutlineEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const raw = item as Record<string, unknown>;
    const heading = optionalString(raw.heading, WORD_HOST_CONTEXT_LIMITS.excerpt);
    const paragraphIndex = finiteNonNegative(raw.paragraphIndex);
    const offset = finiteNonNegative(raw.offset);
    if (!heading || paragraphIndex === null || offset === null) {
      continue;
    }
    entries.push({ heading, level: headingLevel(raw.level), paragraphIndex, offset });
    if (entries.length >= WORD_HOST_CONTEXT_LIMITS.outline) {
      break;
    }
  }
  return entries;
}

function headingLevel(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 9 ? value : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function optionalString(value: unknown, limit: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

/* ----------------------------- rendering helpers ----------------------------- */

function clip(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function describePages(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (sorted.length <= 1) {
    return String(sorted[0] ?? "");
  }
  const contiguous = sorted.every((page, index) => index === 0 || page === sorted[index - 1] + 1);
  return contiguous ? `${sorted[0]}-${sorted[sorted.length - 1]}` : sorted.join(", ");
}

function describeAge(capturedAt: string): string {
  const captured = Date.parse(capturedAt);
  if (!Number.isFinite(captured)) {
    return "just now";
  }
  const seconds = Math.max(0, Math.round((Date.now() - captured) / 1000));
  if (seconds < 5) {
    return "just now";
  }
  if (seconds < 90) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}
