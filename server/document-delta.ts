/**
 * What changed in the document since the previous turn of a resumed CLI
 * thread. A one-shot prompt carries the whole document every turn; in a
 * resumed thread the model already holds the copy it was given last turn, so
 * re-sending it makes every turn as large as the document and fills the
 * thread's context in a few turns (each one then slower, and soon compacted).
 * Instead the prompt says the document is unchanged, or lists the paragraphs
 * that changed — falling back to the full text when the change is large or
 * the thread may no longer hold the earlier copy (see the thread ledger in
 * conversation-store.ts).
 */

/** Above this share of the document changed, the full text is simpler and safer than a diff. */
const MAX_CHANGED_SHARE = 0.3;
const MAX_HUNKS = 40;
/** Largest middle section diffed paragraph by paragraph (cells of the LCS table). */
const MAX_LCS_CELLS = 4_000_000;

export interface ParagraphHunk {
  /** 0-based index of the first paragraph replaced, in the previous text. */
  oldStart: number;
  removed: string[];
  /** 0-based index where the new paragraphs start, in the current text. */
  newStart: number;
  added: string[];
}

/** Paragraph-level differences between two texts (paragraphs are lines). */
export function diffParagraphs(previous: string, current: string): ParagraphHunk[] {
  const a = previous.split("\n");
  const b = current.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (!midA.length && !midB.length) {
    return [];
  }
  if (!midA.length || !midB.length || midA.length * midB.length > MAX_LCS_CELLS) {
    return [{ oldStart: start, removed: midA, newStart: start, added: midB }];
  }
  // LCS over the middle, then walk it into hunks.
  const n = midA.length;
  const m = midB.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const hunks: ParagraphHunk[] = [];
  let open: ParagraphHunk | null = null;
  let i = 0;
  let j = 0;
  const flush = () => {
    if (open) {
      hunks.push(open);
      open = null;
    }
  };
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      flush();
      i += 1;
      j += 1;
      continue;
    }
    open ??= { oldStart: start + i, removed: [], newStart: start + j, added: [] };
    if (j < m && (i >= n || table[i][j + 1] >= table[i + 1][j])) {
      open.added.push(midB[j]);
      j += 1;
    } else {
      open.removed.push(midA[i]);
      i += 1;
    }
  }
  flush();
  return hunks;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `…${flat.slice(flat.length - limit + 1)}`;
}

/**
 * Prompt lines standing in for the document, or null when the full text
 * should be sent (the change is too large to describe as a diff).
 */
export function describeDocumentDelta(previous: string, current: string): string[] | null {
  if (previous === current) {
    return [
      "Document: unchanged since your previous turn in this thread — the full text you were given then is still exact, character for character. Copy `original` from it."
    ];
  }
  const hunks = diffParagraphs(previous, current);
  const changed = hunks.reduce((sum, hunk) => sum + hunk.removed.join("\n").length + hunk.added.join("\n").length, 0);
  if (!hunks.length || hunks.length > MAX_HUNKS || changed > MAX_CHANGED_SHARE * Math.max(previous.length, current.length)) {
    return null;
  }
  const paragraphs = current.split("\n");
  const lines = [
    `Document: changed since your previous turn in this thread. Below is every change, paragraph by paragraph (numbers are paragraph positions in the CURRENT document, which has ${paragraphs.length} paragraphs); everything else is exactly as in the full text you were given then. Copy \`original\` from the current wording: unchanged paragraphs from that earlier text, changed ones from the "now" lines here.`,
    "<<<changes"
  ];
  for (const hunk of hunks) {
    const before = hunk.newStart > 0 ? ` after the paragraph ending "${clip(paragraphs[hunk.newStart - 1], 60)}"` : " at the start";
    const where = hunk.added.length
      ? `paragraph${hunk.added.length === 1 ? "" : "s"} ${hunk.newStart + 1}${hunk.added.length > 1 ? `–${hunk.newStart + hunk.added.length}` : ""}`
      : `removed${before}`;
    lines.push(`@@ ${where}${hunk.added.length ? before : ""}`);
    for (const paragraph of hunk.removed) {
      lines.push(`was: ${paragraph}`);
    }
    for (const paragraph of hunk.added) {
      lines.push(`now: ${paragraph}`);
    }
  }
  lines.push(">>>");
  return lines;
}
