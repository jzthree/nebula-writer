import type { AiSuggestion } from "./shared";

/** How much text either side of an applied deletion pins the place to put it back. */
const DELETION_CONTEXT_CHARS = 60;

/**
 * The change that undoes an applied suggestion, as a suggestion the host can
 * apply like any other: the revised text becomes the passage to find and the
 * original its replacement. A deletion left nothing to find, so the text
 * around it (from the staging anchor, within its paragraph) stands in for it.
 * Null when the change cannot be undone from the card: a comment, a deleted
 * table (nothing left to anchor it to) or a picture (the old bytes are gone)
 * — Word's own Undo still can.
 */
export function revertSuggestionOf(suggestion: AiSuggestion): AiSuggestion | null {
  if (suggestion.commentOnly) {
    return null;
  }
  if (suggestion.kind === "image") {
    return null;
  }
  if (suggestion.kind === "table") {
    const edit = suggestion.table;
    if (!edit?.rows) {
      return null;
    }
    if (edit.action === "insert") {
      return { ...suggestion, table: { action: "delete", index: null, rows: null, before: edit.rows } };
    }
    if (edit.action === "replace" && edit.before) {
      return { ...suggestion, table: { action: "replace", index: edit.index, rows: edit.before, before: edit.rows } };
    }
    return null;
  }
  const emphasis = suggestion.emphasis ? { original: suggestion.emphasis.replacement, replacement: suggestion.emphasis.original } : null;
  if (suggestion.replacement.trim()) {
    // The revised text sits where the original did, between the same neighbours: the anchor still holds.
    return { ...suggestion, original: suggestion.replacement, replacement: suggestion.original, emphasis, range: null };
  }
  const anchor = suggestion.anchor;
  const before = anchor ? tailWithinParagraph(anchor.before) : "";
  const after = anchor ? headWithinParagraph(anchor.after) : "";
  if (!anchor || (!before.trim() && !after.trim())) {
    return null;
  }
  return {
    ...suggestion,
    original: `${before}${after}`,
    replacement: `${before}${suggestion.original}${after}`,
    // Emphasis spans cover the passage alone, not the context around it.
    emphasis: null,
    range: null,
    anchor: {
      offset: anchor.offset - before.length,
      before: anchor.before.slice(0, anchor.before.length - before.length),
      after: anchor.after.slice(after.length)
    }
  };
}

function tailWithinParagraph(text: string): string {
  const paragraph = text.slice(text.lastIndexOf("\n") + 1);
  return paragraph.slice(-DELETION_CONTEXT_CHARS);
}

function headWithinParagraph(text: string): string {
  const end = text.indexOf("\n");
  const paragraph = end === -1 ? text : text.slice(0, end);
  return paragraph.slice(0, DELETION_CONTEXT_CHARS);
}
