import type { DocsLocateRequest } from "../gdocs/protocol";

export interface DocsFindPosition {
  index: number;
  count: number;
}

export interface DocsLocatePlan {
  query: string;
  positions: Record<"exact" | "foldCase" | "foldAccents" | "foldBoth", DocsFindPosition>;
}

function normalize(text: string, foldCase: boolean, foldAccents: boolean): string {
  const value = foldAccents ? text.normalize("NFD").replace(/\p{M}/gu, "") : text;
  return foldCase ? value.toLowerCase() : value;
}

function position(body: string, query: string, offset: number, foldCase: boolean, foldAccents: boolean): DocsFindPosition {
  const haystack = normalize(body, foldCase, foldAccents);
  const needle = normalize(query, foldCase, foldAccents);
  const target = normalize(body.slice(0, offset), foldCase, foldAccents).length;
  let index = -1;
  let count = 0;
  let at = needle ? haystack.indexOf(needle) : -1;
  while (at >= 0) {
    if (at === target) index = count;
    count++;
    at = haystack.indexOf(needle, at + Math.max(1, needle.length));
  }
  return { index, count };
}

/** Build a literal, single-line Find query; verify the source before moving the UI. */
export function planDocsLocate(paragraphs: readonly { text: string }[], range: DocsLocateRequest): DocsLocatePlan {
  if (!range || typeof range.expected !== "string" || ![range.paragraphIndex, range.endParagraphIndex, range.start, range.end].every(Number.isInteger)
    || range.paragraphIndex < 0 || range.endParagraphIndex < range.paragraphIndex || range.endParagraphIndex >= paragraphs.length
    || range.start < 0 || range.start > paragraphs[range.paragraphIndex].text.length
    || range.end < 0 || range.end > paragraphs[range.endParagraphIndex].text.length) {
    throw new Error("Invalid Google Docs Locate range. Refresh Writer and try again.");
  }
  const body = paragraphs.map((paragraph) => paragraph.text).join("\n");
  let from = range.start;
  let to = range.end;
  for (let i = 0; i < range.paragraphIndex; i++) from += paragraphs[i].text.length + 1;
  for (let i = 0; i < range.endParagraphIndex; i++) to += paragraphs[i].text.length + 1;
  if (to <= from || body.slice(from, to) !== range.expected) {
    throw new Error("The passage changed since Writer read it. Refresh Writer before locating it.");
  }
  let start = from;
  while (start < to && /\s/.test(body[start])) start++;
  let end = Math.min(to, body.indexOf("\n", start) < 0 ? body.length : body.indexOf("\n", start), start + 180);
  while (end > start && /\s/.test(body[end - 1])) end--;
  if (end <= start) throw new Error("This passage has no searchable text.");
  const lineStart = body.lastIndexOf("\n", start - 1) + 1;
  const nextLine = body.indexOf("\n", end);
  const lineEnd = nextLine < 0 ? body.length : nextLine;
  // Include a little context when the same short phrase occurs more than once.
  for (const padding of [0, 24, 60]) {
    const left = Math.max(lineStart, start - padding);
    const right = Math.min(lineEnd, end + padding);
    const query = body.slice(left, right).trim();
    const offset = left + body.slice(left, right).indexOf(query);
    const loose = position(body, query, offset, true, true);
    if (loose.count === 1 || padding === 60) {
      const positions = {
        exact: position(body, query, offset, false, false),
        foldCase: position(body, query, offset, true, false),
        foldAccents: position(body, query, offset, false, true),
        foldBoth: loose
      };
      if (Object.values(positions).some((item) => item.index < 0)) throw new Error("This passage could not be verified for Locate.");
      return { query, positions };
    }
  }
  throw new Error("No searchable passage was found.");
}

export function isDocsLocatePlan(value: unknown): value is DocsLocatePlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<DocsLocatePlan>;
  return typeof plan.query === "string" && plan.query.length > 0 && plan.query.length <= 512 && !/[\r\n]/.test(plan.query)
    && !!plan.positions && ["exact", "foldCase", "foldAccents", "foldBoth"].every((key) => {
      const item = plan.positions?.[key as keyof DocsLocatePlan["positions"]];
      return item && Number.isInteger(item.index) && Number.isInteger(item.count) && item.index >= 0 && item.index < item.count;
    });
}
