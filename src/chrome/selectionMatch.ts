import { collapseWithPositions } from "../gdocs/docsPlan";
import type { DocsSelectionPayload } from "../gdocs/protocol";

/** Match only whitespace differences; return coordinates and text from the document itself. */
export function locateDocsSelection(paragraphs: ReadonlyArray<{ text: string }>, copiedText: string): DocsSelectionPayload | null {
  const needle = collapseWithPositions(copiedText).text.trim();
  if (!needle) {
    return null;
  }
  const body = paragraphs.map((paragraph) => paragraph.text).join("\n");
  const collapsed = collapseWithPositions(body);
  const at = collapsed.text.indexOf(needle);
  if (at < 0 || collapsed.text.indexOf(needle, at + 1) >= 0) {
    return null;
  }
  const from = collapsed.positions[at];
  const to = collapsed.positions[at + needle.length - 1] + 1;
  let offset = 0;
  let start: { paragraph: number; offset: number } | null = null;
  let end: { paragraph: number; offset: number } | null = null;
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    const paragraphEnd = offset + paragraph.text.length;
    if (from >= offset && from < paragraphEnd) {
      start = { paragraph: index, offset: from - offset };
    }
    if (to > offset && to <= paragraphEnd) {
      end = { paragraph: index, offset: to - offset };
    }
    offset = paragraphEnd + 1;
  }
  if (!start || !end) {
    return null;
  }
  // Keep the exact original whitespace for focus offsets and verified edits.
  return {
    startParagraph: start.paragraph,
    startOffset: start.offset,
    endParagraph: end.paragraph,
    endOffset: end.offset,
    text: body.slice(from, to)
  };
}
