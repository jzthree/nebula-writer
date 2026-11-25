/**
 * Autoheal for suggestions whose passage changed after they were made.
 *
 * A suggestion quotes the document as it was. By the time the author applies
 * it, another suggestion or their own typing may have changed that passage,
 * and the exact quote is gone. Rather than fail, find the passage's current
 * version (by the context saved around it, or the quote's own head and tail)
 * and merge: the edits made since (base -> current) and the suggestion's
 * edits (base -> replacement) are combined word by word when they touch
 * different words. Only when both changed the same words is the author asked
 * to redo it. Pure functions; the hosts apply the result like any suggestion.
 */

import type { AiSuggestion } from "./shared";

export type RebaseResult =
  /** The current passage with the suggestion's own edits merged in. */
  | { kind: "clean"; original: string; replacement: string }
  /** The document already reads as the suggestion would make it. */
  | { kind: "already" }
  /** The passage is there, but it and the suggestion changed the same words. */
  | { kind: "conflict"; current: string }
  /** The passage cannot be found any more. */
  | { kind: "lost" };

const CONTEXT_LENGTHS = [60, 40, 24, 14];
const QUOTE_EDGE_LENGTHS = [48, 32, 20];
const MAX_TOKENS = 1_500;

/** Words, runs of whitespace and single punctuation marks: merges work on whole words. */
export function tokenize(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

interface Hunk {
  start: number;
  end: number;
  tokens: string[];
}

/** The changes that turn `base` into `next`, as replaced base token ranges (longest common subsequence). */
function hunks(base: string[], next: string[]): Hunk[] {
  const n = base.length;
  const m = next.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = base[i] === next[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  const close = () => {
    if (open) {
      out.push(open);
      open = null;
    }
  };
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === next[j]) {
      close();
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      open ??= { start: i, end: i, tokens: [] };
      open.tokens.push(next[j]);
      j += 1;
    } else {
      open ??= { start: i, end: i, tokens: [] };
      open.end = i + 1;
      i += 1;
    }
  }
  close();
  return out;
}

const sameHunk = (a: Hunk, b: Hunk) => a.start === b.start && a.end === b.end && a.tokens.join("") === b.tokens.join("");

function collides(a: Hunk, b: Hunk): boolean {
  if (sameHunk(a, b)) {
    return false;
  }
  // Two insertions at one point, or an insertion inside the other's replaced range.
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

/** Three-way merge by word: null when both sides changed the same words. */
export function threeWayMerge(base: string, ours: string, theirs: string): string | null {
  const b = tokenize(base);
  const o = tokenize(ours);
  const t = tokenize(theirs);
  if (b.length > MAX_TOKENS || o.length > MAX_TOKENS || t.length > MAX_TOKENS) {
    return null;
  }
  const mine = hunks(b, o);
  const yours = hunks(b, t);
  if (mine.some((a) => yours.some((c) => collides(a, c)))) {
    return null;
  }
  const all = [...mine, ...yours.filter((c) => !mine.some((a) => sameHunk(a, c)))].sort((x, y) => x.start - y.start || x.end - y.end);
  const merged: string[] = [];
  let at = 0;
  for (const hunk of all) {
    merged.push(...b.slice(at, hunk.start), ...hunk.tokens);
    at = Math.max(at, hunk.end);
  }
  merged.push(...b.slice(at));
  return merged.join("");
}

/**
 * Where the suggestion's passage is now: between the end of the context that
 * preceded it and the start of the context that followed it, or between the
 * quote's own first and last words. Null when neither pair can be found in order.
 */
export function currentPassage(documentText: string, suggestion: Pick<AiSuggestion, "original" | "anchor">): { from: number; to: number; text: string } | null {
  const original = suggestion.original;
  const near = suggestion.anchor?.offset ?? null;
  const plausible = (from: number, to: number) => to > from && to - from <= Math.max(original.length * 3, original.length + 400) && to - from >= Math.min(original.length / 4, 40);
  const pick = (froms: number[], findTo: (from: number) => number) => {
    let best: { from: number; to: number } | null = null;
    for (const from of froms) {
      const to = findTo(from);
      if (to >= 0 && plausible(from, to) && (!best || (near !== null && Math.abs(from - near) < Math.abs(best.from - near)))) {
        best = { from, to };
      }
    }
    return best;
  };
  const occurrences = (needle: string) => {
    const found: number[] = [];
    for (let at = documentText.indexOf(needle); at >= 0 && found.length < 50; at = documentText.indexOf(needle, at + 1)) {
      found.push(at);
    }
    return found;
  };
  const anchor = suggestion.anchor ?? null;
  if (anchor) {
    for (const length of CONTEXT_LENGTHS) {
      const before = anchor.before.slice(-length);
      const after = anchor.after.slice(0, length);
      if (before.length < Math.min(length, 8) || after.length < Math.min(length, 8)) continue;
      const best = pick(occurrences(before).map((at) => at + before.length), (from) => documentText.indexOf(after, from));
      if (best) return { ...best, text: documentText.slice(best.from, best.to) };
    }
  }
  for (const length of QUOTE_EDGE_LENGTHS) {
    if (original.length < length * 2) continue;
    const head = original.slice(0, length);
    const tail = original.slice(-length);
    const best = pick(occurrences(head), (from) => {
      const end = documentText.indexOf(tail, from + head.length);
      return end >= 0 ? end + tail.length : -1;
    });
    if (best) return { ...best, text: documentText.slice(best.from, best.to) };
  }
  return null;
}

/** Bring a suggestion whose quote no longer matches up to date with the document. */
export function rebaseSuggestion(documentText: string, suggestion: Pick<AiSuggestion, "original" | "replacement" | "anchor">): RebaseResult {
  const replacement = suggestion.replacement;
  if (replacement.trim().length >= 24 && documentText.includes(replacement) && !documentText.includes(suggestion.original)) {
    return { kind: "already" };
  }
  const passage = currentPassage(documentText, suggestion);
  if (!passage) {
    return { kind: "lost" };
  }
  if (passage.text === suggestion.original) {
    return { kind: "clean", original: passage.text, replacement };
  }
  const merged = threeWayMerge(suggestion.original, passage.text, replacement);
  if (merged === null) {
    return { kind: "conflict", current: passage.text };
  }
  if (merged === passage.text) {
    return { kind: "already" };
  }
  return { kind: "clean", original: passage.text, replacement: merged };
}
