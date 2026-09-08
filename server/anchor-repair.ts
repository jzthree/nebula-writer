import { wordDiffSegments } from "../src/wordDiff";

/**
 * Self-healing for quoted originals. A model asked to copy a passage
 * verbatim often almost does: curly quotes for straight ones, an en dash for
 * a hyphen, a non-breaking space, or — the expensive case — a "correction"
 * inside a long quote (author names it happens to know, a fixed typo). The
 * validator would drop such a suggestion outright. Instead, find the passage
 * the model meant, snap `original` to the document's exact text, and carry
 * the same correction into `replacement` so the misquote never lands.
 */
export interface AnchorRepair {
  original: string;
  replacement: string;
  /** What was wrong with the quote, for the message and the card. */
  note: string;
}

const HEAD_TAIL_LENGTHS = [80, 60, 40, 28];
const MAX_CHANGED_FRACTION = 0.12;
const MAX_MATCH_POSITIONS = 24;

/** Length-preserving canonical form: typographic variants collapse to their plain counterparts, positions stay aligned. */
export function canonicalText(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, "\"")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/[\u00A0\u2007\u202F\u2009\u200A\u2002\u2003]/g, " ")
    .replace(/\u2026/g, "…");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function positionsOf(haystack: string, needle: string, fromEnd = false): number[] {
  const positions: number[] = [];
  if (!needle) {
    return positions;
  }
  let cursor = fromEnd ? haystack.lastIndexOf(needle) : haystack.indexOf(needle);
  while (cursor >= 0 && positions.length < MAX_MATCH_POSITIONS) {
    positions.push(cursor);
    cursor = fromEnd ? (cursor === 0 ? -1 : haystack.lastIndexOf(needle, cursor - 1)) : haystack.indexOf(needle, cursor + 1);
  }
  return positions;
}

/**
 * Runs of change between two texts: consecutive del/ins segments, with the
 * whitespace between them kept inside the run, so "J, Troyanskaya OG." maps
 * to "J et al." as one pair rather than three word-sized fragments.
 */
function changeRuns(from: string, to: string): Array<{ misquote: string; truth: string }> {
  const segments = wordDiffSegments(from, to);
  if (!segments) {
    return [];
  }
  const runs: Array<{ misquote: string; truth: string }> = [];
  let misquote = "";
  let truth = "";
  const flush = () => {
    if (misquote.trim() || truth.trim()) {
      runs.push({ misquote, truth });
    }
    misquote = "";
    truth = "";
  };
  for (const segment of segments) {
    if (segment.type === "same") {
      if (!segment.text.trim() && (misquote || truth)) {
        misquote += segment.text;
        truth += segment.text;
      } else {
        flush();
      }
    } else if (segment.type === "del") {
      misquote += segment.text;
    } else {
      truth += segment.text;
    }
  }
  flush();
  return runs;
}

/** Carry the quote's corrections into the replacement: wherever the model's misquoted text survives there, use the document's text. */
function adjustReplacement(replacement: string, quoted: string, actual: string): string {
  let adjusted = replacement;
  for (const run of changeRuns(quoted, actual)) {
    const needle = run.misquote.trim();
    if (needle.length >= 3 && /[\p{L}\p{N}]/u.test(needle) && adjusted.includes(needle)) {
      adjusted = adjusted.split(needle).join(run.truth.trim());
    }
  }
  return adjusted;
}

function changedFraction(actual: string, quoted: string): number | null {
  const segments = wordDiffSegments(actual, quoted);
  if (!segments) {
    return null;
  }
  const changed = segments.filter((segment) => segment.type !== "same").reduce((sum, segment) => sum + segment.text.length, 0);
  return changed / Math.max(actual.length, quoted.length, 1);
}

export function repairAnchor(documentText: string, original: string, replacement: string): AnchorRepair | null {
  const quoted = original.trim();
  if (!quoted || documentText.includes(quoted)) {
    return null;
  }
  const canonDocument = canonicalText(documentText);
  const canonQuoted = canonicalText(quoted);

  // 1. Same text, different typography (quotes, dashes, spaces).
  const direct = canonDocument.indexOf(canonQuoted);
  if (direct >= 0) {
    const actual = documentText.slice(direct, direct + canonQuoted.length);
    return { original: actual, replacement: adjustReplacement(replacement, quoted, actual), note: "the quote used different punctuation or spacing than the document" };
  }

  // 2. Same words, different whitespace (line breaks, double spaces).
  const words = canonQuoted.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && canonQuoted.length <= 8000) {
    const pattern = new RegExp(words.map(escapeRegExp).join("\\s+"));
    const match = pattern.exec(canonDocument);
    if (match) {
      const actual = documentText.slice(match.index, match.index + match[0].length);
      return { original: actual, replacement: adjustReplacement(replacement, quoted, actual), note: "the quote's spacing or line breaks differed from the document" };
    }
  }

  // 3. A near miss inside a long quote: anchor on its head and tail, then check the span is nearly identical.
  for (const length of HEAD_TAIL_LENGTHS) {
    if (canonQuoted.length < length * 2 + 8) {
      continue;
    }
    const head = canonQuoted.slice(0, length);
    const tail = canonQuoted.slice(-length);
    const heads = positionsOf(canonDocument, head);
    const tails = positionsOf(canonDocument, tail, true);
    if (!heads.length || !tails.length) {
      continue;
    }
    let best: { start: number; end: number; fraction: number } | null = null;
    for (const start of heads) {
      for (const tailStart of tails) {
        const end = tailStart + length;
        const span = end - start;
        if (end <= start || span < quoted.length * 0.7 || span > quoted.length * 1.3) {
          continue;
        }
        const actual = documentText.slice(start, end);
        const fraction = changedFraction(actual, quoted);
        if (fraction === null || fraction > MAX_CHANGED_FRACTION) {
          continue;
        }
        if (!best || fraction < best.fraction) {
          best = { start, end, fraction };
        }
      }
    }
    if (best) {
      const actual = documentText.slice(best.start, best.end);
      const differences = changeRuns(quoted, actual).length || 1;
      return {
        original: actual,
        replacement: adjustReplacement(replacement, quoted, actual),
        note: `the quote differed from the document in ${differences} place${differences === 1 ? "" : "s"}`
      };
    }
  }
  return null;
}

/** The document text nearest to an unplaceable quote, for asking the model to re-quote it. */
export function nearestDocumentExcerpt(documentText: string, original: string, limit = 320): string | null {
  const quoted = canonicalText(original.trim());
  const canonDocument = canonicalText(documentText);
  for (const length of [40, 28, 18]) {
    if (quoted.length < length) {
      continue;
    }
    const at = canonDocument.indexOf(quoted.slice(0, length));
    if (at >= 0) {
      return documentText.slice(at, Math.min(documentText.length, at + Math.max(quoted.length, length) + 60)).slice(0, limit);
    }
  }
  return null;
}
