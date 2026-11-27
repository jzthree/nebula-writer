/**
 * Turn an assistant reply into sections with suggestion cards placed where
 * the agent put them.
 *
 * The engines are asked to write replies like:
 *
 *   ## Significance
 *   Two claims were softer than the data supports.
 *   [S1]
 *   [S2]
 *   ## Approach
 *   [S3]
 *
 * `[S3]` (also `{{S3}}` / `[[S3]]`) is the ref the staging tool returned.
 * Anything the agent did not reference is appended as a final group so no
 * suggestion is ever hidden. Pure, so it is unit-tested directly.
 */

import type { AiSuggestion } from "../shared";

export type ReplyBlock =
  | { kind: "text"; text: string }
  | { kind: "cards"; ids: string[] };

export interface ReplyGroup {
  /** Section heading written by the agent; null for the lead-in or a headingless reply. */
  heading: string | null;
  blocks: ReplyBlock[];
  /** Every suggestion id placed in this group, in order. */
  ids: string[];
}

export interface ReplyLayout {
  groups: ReplyGroup[];
  /** True when the reply placed at least one suggestion itself. */
  structured: boolean;
}

const REF_TOKEN = /\[\[?\s*S(\d+)\s*\]\]?|\{\{\s*S(\d+)\s*\}\}/gi;
const HEADING_LINE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const BOLD_HEADING_LINE = /^\s*\*\*([^*]{2,80})\*\*:?\s*$/;
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;

export function parseAssistantReply(text: string, suggestions: AiSuggestion[]): ReplyLayout {
  const byRef = new Map<string, AiSuggestion>();
  suggestions.forEach((suggestion, index) => {
    byRef.set(`S${index + 1}`, suggestion);
  });
  // Explicit refs win over positional ones.
  for (const suggestion of suggestions) {
    if (suggestion.ref) {
      byRef.set(suggestion.ref.toUpperCase(), suggestion);
    }
  }

  const groups: ReplyGroup[] = [];
  const placed = new Set<string>();
  let current: ReplyGroup = { heading: null, blocks: [], ids: [] };
  let structured = false;

  // Lines go in as written (indentation and blank lines included) so the
  // reply's Markdown (paragraphs, nested lists, code, tables) renders intact.
  const pushText = (line: string) => {
    const last = current.blocks[current.blocks.length - 1];
    if (last && last.kind === "text") {
      last.text = `${last.text}\n${line}`;
    } else if (line.trim()) {
      current.blocks.push({ kind: "text", text: line });
    }
  };
  const pushCards = (ids: string[]) => {
    const fresh = [...new Set(ids)].filter((id) => !placed.has(id));
    if (!fresh.length) {
      return;
    }
    for (const id of fresh) {
      placed.add(id);
    }
    const last = current.blocks[current.blocks.length - 1];
    if (last && last.kind === "cards") {
      last.ids.push(...fresh);
    } else {
      current.blocks.push({ kind: "cards", ids: [...fresh] });
    }
    current.ids.push(...fresh);
    structured = true;
  };
  const closeGroup = () => {
    current.blocks = current.blocks
      .map((block) => (block.kind === "text" ? { ...block, text: block.text.replace(/^(?:[ \t]*\n)+/, "").trimEnd() } : block))
      .filter((block) => block.kind !== "text" || block.text.trim());
    if (current.blocks.length || current.heading !== null) {
      groups.push(current);
    }
  };

  let fence: string | null = null;
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    // Inside a code fence every line is code: no headings, no refs.
    const fenceMatch = FENCE_LINE.exec(rawLine);
    if (fence !== null || fenceMatch) {
      if (fence === null) {
        fence = fenceMatch![1];
      } else if (fenceMatch && fenceMatch[1].startsWith(fence) && !rawLine.trim().slice(fenceMatch[1].length).trim()) {
        fence = null;
      }
      pushText(rawLine);
      continue;
    }
    const headingMatch = HEADING_LINE.exec(rawLine) ?? BOLD_HEADING_LINE.exec(rawLine);
    if (headingMatch) {
      closeGroup();
      current = { heading: headingMatch[1].trim(), blocks: [], ids: [] };
      continue;
    }
    const refs: string[] = [];
    const remainder = rawLine.replace(REF_TOKEN, (_match, a: string | undefined, b: string | undefined) => {
      const suggestion = byRef.get(`S${a ?? b}`);
      if (suggestion) {
        refs.push(suggestion.id);
      }
      return "";
    });
    if (refs.length || remainder !== rawLine) {
      // A ref came out: close the gap it left, and drop a line it emptied.
      const body = remainder.replace(/^\s*[-*•]\s*$/, "").replace(/\s{2,}/g, " ").trim();
      if (body) {
        pushText(`${/^\s*/.exec(rawLine)![0]}${body}`);
      }
    } else {
      pushText(rawLine.trimEnd());
    }
    if (refs.length) {
      pushCards(refs);
    }
  }
  closeGroup();

  const leftovers = suggestions.map((suggestion) => suggestion.id).filter((id) => !placed.has(id));
  if (leftovers.length) {
    const headed = groups.some((group) => group.heading !== null);
    if (!structured && groups.length === 1 && groups[0].heading === null) {
      // Plain reply: keep the prose and hang every card under it.
      groups[0].blocks.push({ kind: "cards", ids: leftovers });
      groups[0].ids.push(...leftovers);
    } else {
      groups.push({ heading: headed || structured ? "Other suggestions" : null, blocks: [{ kind: "cards", ids: leftovers }], ids: [...leftovers] });
    }
  }
  if (!groups.length) {
    groups.push({ heading: null, blocks: [], ids: [] });
  }
  return { groups, structured };
}
