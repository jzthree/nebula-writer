export type DiffSegment = { type: "same" | "del" | "ins"; text: string };

/**
 * Word-level diff (LCS) so suggestion cards show one readable line of
 * strikethrough/insert instead of two stacked paragraphs. Falls back to
 * null for very long texts (quadratic) or near-total rewrites where a
 * diff would be noise.
 */
export function wordDiffSegments(original: string, replacement: string): DiffSegment[] | null {
  const a = original.split(/(\s+)/).filter((part) => part !== "");
  const b = replacement.split(/(\s+)/).filter((part) => part !== "");
  if (a.length + b.length > 600) {
    return null;
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Array<number>(rows * cols).fill(0);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] = a[i] === b[j]
        ? lcs[(i + 1) * cols + j + 1] + 1
        : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }
  const segments: DiffSegment[] = [];
  const push = (type: DiffSegment["type"], text: string) => {
    const last = segments[segments.length - 1];
    if (last && last.type === type) {
      last.text += text;
    } else {
      segments.push({ type, text });
    }
  };
  let i = 0;
  let j = 0;
  let sameChars = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      sameChars += a[i].length;
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      push("del", a[i]);
      i += 1;
    } else {
      push("ins", b[j]);
      j += 1;
    }
  }
  while (i < a.length) {
    push("del", a[i]);
    i += 1;
  }
  while (j < b.length) {
    push("ins", b[j]);
    j += 1;
  }
  // A rewrite with almost nothing in common reads better as two blocks.
  if (sameChars < (original.length + replacement.length) * 0.15) {
    return null;
  }
  return segments;
}
