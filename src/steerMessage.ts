import type { AiRequestFocus, SelectionContext } from "./shared";

/** How much of a newly selected passage rides along with a steered message. */
const STEER_SELECTION_LIMIT = 4_000;

/**
 * The text of a message sent into a running turn. The turn was given the
 * selection the user had when they asked; a message typed later ("is this
 * accurate?") is usually about whatever they have selected NOW, so when that
 * differs it goes along with the words — otherwise "this" points at the old
 * passage.
 */
export function steerMessageBody(text: string, focus: AiRequestFocus | null, selectionNow: SelectionContext | null, selectionSent: SelectionContext | null): string {
  const body = focus ? `About ${focus.ref ? `${focus.ref} ` : ""}"${focus.title}": ${text}` : text;
  const passage = selectionNow?.text.trim() ? selectionNow : null;
  if (!passage || sameSelection(passage, selectionSent)) {
    return body;
  }
  const clipped = passage.text.length > STEER_SELECTION_LIMIT ? `${passage.text.slice(0, STEER_SELECTION_LIMIT).trimEnd()}…` : passage.text;
  return [
    body,
    "",
    `Since asking, the user has selected a different passage (characters ${(passage.from + 1).toLocaleString("en-US")}-${passage.to.toLocaleString("en-US")} of the document). This message is about it — "this" and "here" refer to it, not to the selection the request above was sent with:`,
    "<<<selection",
    clipped,
    ">>>"
  ].join("\n");
}

/** A short quote of a passage, for the conversation history. */
export function selectionExcerpt(selection: SelectionContext | null, limit = 140): string | null {
  const normalized = selection?.text.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized) {
    return null;
  }
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function sameSelection(a: SelectionContext, b: SelectionContext | null): boolean {
  return Boolean(b && a.from === b.from && a.to === b.to && a.text === b.text);
}
