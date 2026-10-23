import { decodeHTMLStrict } from "entities";
import { collapseWithPositions } from "./gdocs/docsPlan";
import type { DocumentComment, SelectionCommentContext, SelectionCommentMatch, SelectionContext } from "./shared";

const NEARBY_CHARS = 400;
const SAME_PARAGRAPH_CHARS = 1_500;

/** Match typographic/whitespace differences, but never stem or semantically guess. */
function canonical(value: string): { text: string; positions: number[] } {
  const collapsed = collapseWithPositions(value);
  let text = "";
  const positions: number[] = [];
  for (let i = 0; i < collapsed.text.length; i++) {
    let char = collapsed.text[i];
    if (/[\u200b-\u200d\ufeff]/.test(char)) continue;
    if (/[\u2018\u2019]/.test(char)) char = "'";
    else if (/[\u201c\u201d]/.test(char)) char = '"';
    if (char === " " && text.endsWith(" ")) continue;
    text += char;
    positions.push(collapsed.positions[i]);
  }
  return { text, positions };
}

function floorIndex(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Location evidence only. Missing and repeated anchors never become confirmed attachments. */
export function matchCommentsToSelection(documentText: string, selection: SelectionContext | null | undefined, comments: readonly DocumentComment[]): SelectionCommentContext {
  const result: SelectionCommentContext = { state: "no-selection", selection: null, matches: [], unlocated: [], unrelatedCount: 0 };
  if (!selection || selection.from === selection.to) return result;
  if (!Number.isInteger(selection.from) || !Number.isInteger(selection.to) || selection.from < 0 || selection.to <= selection.from
    || selection.to > documentText.length || canonical(documentText.slice(selection.from, selection.to)).text.trim() !== canonical(selection.text).text.trim()) {
    return { ...result, state: "invalid-selection" };
  }
  result.selection = { from: selection.from, to: selection.to };
  const body = canonical(documentText);
  const starts = [0];
  for (let i = 0; i < documentText.length; i++) if (documentText[i] === "\n") starts.push(i + 1);
  const firstParagraph = floorIndex(starts, selection.from);
  const lastParagraph = floorIndex(starts, selection.to - 1);
  const cache = new Map<string, { count: number; ranges: Array<{ from: number; to: number }> }>();
  const rangesFor = (quote: string) => {
    const key = quote;
    if (!key) return { count: 0, ranges: [] };
    if (cache.has(key)) return cache.get(key)!;
    const before: Array<{ from: number; to: number }> = [];
    const overlap: Array<{ from: number; to: number }> = [];
    const after: Array<{ from: number; to: number }> = [];
    let count = 0;
    let at = body.text.indexOf(key);
    while (at >= 0) {
      const range = { from: body.positions[at], to: body.positions[at + key.length - 1] + 1 };
      count++;
      // Keep only local evidence, but count every occurrence so a repeated
      // quote can never become unique just because the highlight is late.
      if (range.to <= selection.from) { before.push(range); if (before.length > 5) before.shift(); }
      else if (range.from >= selection.to) { if (after.length < 5) after.push(range); }
      else if (overlap.length < 5) overlap.push(range);
      at = body.text.indexOf(key, at + 1);
    }
    const result = { count, ranges: [...before, ...overlap, ...after] };
    cache.set(key, result);
    return result;
  };
  const rank = (match: Pick<SelectionCommentMatch, "relationship" | "certainty">) =>
    ({ overlap: 0, "same-paragraph": 2, nearby: 4 }[match.relationship]) + (match.certainty === "ambiguous" ? 1 : 0);
  for (const comment of comments) {
    const quote = decodeHTMLStrict(comment.anchorText).trim();
    const validOffset = typeof comment.offset === "number" && Number.isInteger(comment.offset) && comment.offset >= 0 && comment.offset < documentText.length;
    let candidates: Array<{ from: number; to: number }>;
    let candidateCount = 1;
    let certainty: SelectionCommentMatch["certainty"] = "located";
    if (!quote) {
      if (validOffset) {
        candidates = [{ from: comment.offset!, to: comment.offset! }];
      } else {
        result.unlocated.push({ commentId: comment.id, reason: "missing-anchor" });
        continue;
      }
    } else {
      if ((quote.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 3 && !validOffset) {
        result.unlocated.push({ commentId: comment.id, reason: "weak-anchor" });
        continue;
      }
      const variants = [...new Set([comment.anchorText, quote].map((value) => canonical(value).text.trim()).filter(Boolean))];
      const offsetAt = validOffset ? floorIndex(body.positions, comment.offset!) : -1;
      const verified = variants.find((value) => offsetAt >= 0 && body.positions[offsetAt] === comment.offset && body.text.startsWith(value, offsetAt));
      const found = verified ? [] : variants.map(rangesFor);
      candidates = verified
        ? [{ from: comment.offset!, to: body.positions[offsetAt + verified.length - 1] + 1 }]
        : [...new Map(found.flatMap((value) => value.ranges).map((range) => [`${range.from}:${range.to}`, range])).values()];
      candidateCount = verified ? 1 : found.reduce((sum, value) => sum + value.count, 0);
      if (!candidateCount) {
        result.unlocated.push({ commentId: comment.id, reason: "anchor-not-found" });
        continue;
      }
      if (candidateCount > 1) certainty = "ambiguous";
    }
    const local = candidates.flatMap((range) => {
      const overlap = range.from < selection.to && (range.to > selection.from || (range.from === range.to && range.from >= selection.from));
      const distance = overlap ? 0 : Math.max(selection.from - range.to, range.from - selection.to, 0);
      const anchorFirst = floorIndex(starts, range.from);
      const anchorLast = floorIndex(starts, Math.max(range.from, range.to - 1));
      const sameParagraph = anchorFirst <= lastParagraph && anchorLast >= firstParagraph;
      const paragraphGap = Math.max(firstParagraph - anchorLast, anchorFirst - lastParagraph, 0);
      const relationship: SelectionCommentMatch["relationship"] | null = overlap ? "overlap" : sameParagraph && distance <= SAME_PARAGRAPH_CHARS ? "same-paragraph"
        : paragraphGap <= 1 && distance <= NEARBY_CHARS ? "nearby" : null;
      return relationship ? [{ range, relationship, distance }] : [];
    }).sort((a, b) => rank({ relationship: a.relationship, certainty }) - rank({ relationship: b.relationship, certainty }) || a.distance - b.distance);
    if (!local.length) { result.unrelatedCount++; continue; }
    result.matches.push({
      commentId: comment.id, relationship: local[0].relationship, certainty,
      anchorText: quote, ranges: local.slice(0, 5).map((item) => item.range), candidateCount, distance: local[0].distance
    });
  }
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  result.matches.sort((a, b) => rank(a) - rank(b) || Number(byId.get(a.commentId)?.resolved) - Number(byId.get(b.commentId)?.resolved) || a.distance - b.distance);
  result.state = result.matches.length ? "matched" : "no-matches";
  return result;
}
