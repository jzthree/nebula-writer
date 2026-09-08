import type { ReactNode } from "react";
import { parseEmphasis, renderEmphasisPerWord } from "./emphasis";
import type { AiSuggestion } from "./shared";

/**
 * Both sides of a suggestion as marker text, one marker pair per word, ready
 * for a word diff whose every segment then renders on its own (a pair never
 * straddles two segments). Suggestions without emphasis pass through.
 */
export function markedSides(suggestion: Pick<AiSuggestion, "original" | "replacement" | "emphasis">): { original: string; replacement: string; marked: boolean } {
  const emphasis = suggestion.emphasis;
  if (!emphasis || (!emphasis.original.length && !emphasis.replacement.length)) {
    return { original: suggestion.original, replacement: suggestion.replacement, marked: false };
  }
  return {
    original: renderEmphasisPerWord(suggestion.original, emphasis.original),
    replacement: renderEmphasisPerWord(suggestion.replacement, emphasis.replacement),
    marked: true
  };
}

/**
 * Marker text as React nodes: **bold**, *italic*, __underline__ and
 * ==highlight== become strong, em, u and mark. `plain` renders each
 * unformatted piece (so a caller can turn line breaks into ¶ marks).
 */
export function renderMarked(text: string, plain: (piece: string) => ReactNode = (piece) => piece): ReactNode {
  const { text: content, spans } = parseEmphasis(text);
  if (!spans.length) {
    return plain(content);
  }
  const nodes: ReactNode[] = [];
  let cursor = 0;
  spans.forEach((span, index) => {
    if (span.start > cursor) {
      nodes.push(<span key={`plain-${index}`}>{plain(content.slice(cursor, span.start))}</span>);
    }
    let node: ReactNode = plain(content.slice(span.start, span.end));
    if (span.highlight) {
      node = <mark>{node}</mark>;
    }
    if (span.underline) {
      node = <u>{node}</u>;
    }
    if (span.italic) {
      node = <em>{node}</em>;
    }
    if (span.bold) {
      node = <strong>{node}</strong>;
    }
    nodes.push(<span key={`emphasis-${index}`}>{node}</span>);
    cursor = span.end;
  });
  if (cursor < content.length) {
    nodes.push(<span key="tail">{plain(content.slice(cursor))}</span>);
  }
  return <>{nodes}</>;
}
