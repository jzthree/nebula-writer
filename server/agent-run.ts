import { randomUUID } from "node:crypto";
import { parseEmphasis, renderEmphasis, type EmphasisSpan } from "../src/emphasis";
import type { AiActivityEntry, AiAttachment, AiDocumentImage, AiRequest, AiSuggestion, WordHostContext, DocumentComment, DocumentCommentsStatus } from "../src/shared";
import { isImageCandidate, validateImageReplacementCandidate, validateSuggestionCandidate, type SuggestionCandidate } from "./suggestion-validation";

/**
 * Per-run context for agentic AI requests. The spawned agent's MCP tools read
 * the document, search it, and stage suggestions against this snapshot — the
 * exact text the request was made on — so scratch drafts (which live only in
 * the browser) work the same as shared sessions, and anchors are validated
 * against precisely what the user saw.
 *
 * Contexts are in-memory and short-lived: created when a run starts, deleted
 * when it finishes, with an orphan sweep as a backstop.
 */

export interface AgentRunContext {
  id: string;
  provider: string;
  instruction: string;
  mode: AiRequest["mode"];
  documentText: string;
  /** Emphasis spans over documentText; reads render them as markers. */
  documentEmphasis: EmphasisSpan[];
  selection: AiRequest["selection"];
  /** Word add-in window state (caret, selection, pages on screen) as of the request. */
  hostContext?: WordHostContext | null;
  /** Tool calls and status steps, in order — surfaced in the pane's conversation. */
  activity: AiActivityEntry[];
  attachments: AiAttachment[];
  /** The document's images, extracted to files the agent can look at. */
  images: AiDocumentImage[];
  /** Reviewer comments in the document (writer_list_comments). */
  comments: DocumentComment[];
  commentsStatus?: DocumentCommentsStatus | null;
  maxSuggestions: number | null;
  staged: AiSuggestion[];
  rejectedCount: number;
  createdAt: number;
}

export interface StageResultItem {
  index: number;
  staged: boolean;
  id?: string;
  /** Handle to place the suggestion in the reply: `[S3]` on its own line. */
  ref?: string;
  reason?: string;
  /** Staged, but the quote was repaired to match the document; says how. */
  note?: string;
}

const ORPHAN_RUN_MAX_AGE_MS = 60 * 60 * 1000;
const SEARCH_CONTEXT_CHARS = 120;
const DEFAULT_READ_LIMIT = 24_000;
const MAX_READ_LIMIT = 60_000;

const runs = new Map<string, AgentRunContext>();

export function createAgentRun(request: AiRequest): AgentRunContext {
  sweepOrphanedRuns();
  const run: AgentRunContext = {
    id: randomUUID(),
    provider: request.provider,
    instruction: request.instruction,
    mode: request.mode,
    documentText: request.documentText,
    documentEmphasis: request.documentEmphasis ?? [],
    selection: request.mode === "selection" ? request.selection ?? null : null,
    hostContext: request.hostContext ?? null,
    activity: [],
    attachments: request.attachments ?? [],
    images: request.documentImages ?? [],
    comments: request.documentComments ?? [],
    commentsStatus: request.documentCommentsStatus,
    maxSuggestions: typeof request.maxSuggestions === "number" && Number.isSafeInteger(request.maxSuggestions) && request.maxSuggestions > 0
      ? request.maxSuggestions
      : null,
    staged: [],
    rejectedCount: 0,
    createdAt: Date.now()
  };
  runs.set(run.id, run);
  return run;
}

/**
 * Live window state from the Word add-in, registered by the app. A run created
 * from a Word request follows the author while the agent works (caret,
 * selection, pages on screen), as long as it is still the same document.
 */
export interface LiveHostContextSnapshot {
  documentName: string;
  hostContext: WordHostContext;
}

let liveHostContextSource: (() => LiveHostContextSnapshot | null) | null = null;

export function setLiveHostContextSource(source: (() => LiveHostContextSnapshot | null) | null): void {
  liveHostContextSource = source;
}

/** The freshest window state applicable to this run (live push when it matches the run's document). */
export function currentHostContext(run: AgentRunContext): { hostContext: WordHostContext | null; live: boolean } {
  const requestTime = run.hostContext ?? null;
  const live = liveHostContextSource?.() ?? null;
  if (live && (run.id === "live" || (requestTime && requestTime.documentName === live.documentName))) {
    return { hostContext: live.hostContext, live: true };
  }
  return { hostContext: requestTime, live: false };
}

export function recordAgentActivity(run: AgentRunContext, entry: Omit<AiActivityEntry, "at">): void {
  const last = run.activity[run.activity.length - 1];
  if (last && last.kind === entry.kind && last.summary === entry.summary && (last.tool ?? null) === (entry.tool ?? null)) {
    return;
  }
  run.activity.push({ at: new Date().toISOString(), ...entry });
  if (run.activity.length > 400) {
    run.activity.splice(0, run.activity.length - 400);
  }
}

export function getAgentRun(runId: string): AgentRunContext | null {
  return runs.get(runId) ?? null;
}

export function deleteAgentRun(runId: string): void {
  runs.delete(runId);
}

function sweepOrphanedRuns(): void {
  const cutoff = Date.now() - ORPHAN_RUN_MAX_AGE_MS;
  for (const [id, run] of runs) {
    if (run.createdAt < cutoff) {
      runs.delete(id);
    }
  }
}

export function readAgentRunDocument(run: AgentRunContext, offsetInput?: unknown, limitInput?: unknown): {
  text: string;
  offset: number;
  limit: number;
  totalLength: number;
} {
  const totalLength = run.documentText.length;
  const offset = clampInteger(offsetInput, 0, Math.max(0, totalLength), 0);
  const limit = clampInteger(limitInput, 1, MAX_READ_LIMIT, DEFAULT_READ_LIMIT);
  return {
    text: renderEmphasis(run.documentText.slice(offset, offset + limit), run.documentEmphasis, offset),
    offset,
    limit,
    totalLength
  };
}

export function searchAgentRunDocument(run: AgentRunContext, query: string, maxResults?: unknown): {
  matches: Array<{ offset: number; context: string }>;
  totalMatches: number;
} {
  const cap = clampInteger(maxResults, 1, 50, 10);
  const text = run.documentText;
  const matches: Array<{ offset: number; context: string }> = [];
  let totalMatches = 0;
  // The agent may search with the emphasis markers it saw; the document is plain.
  query = parseEmphasis(query).text;
  if (!query) {
    return { matches, totalMatches };
  }
  let cursor = 0;
  while (cursor <= text.length - query.length) {
    const index = text.indexOf(query, cursor);
    if (index < 0) {
      break;
    }
    totalMatches += 1;
    if (matches.length < cap) {
      const start = Math.max(0, index - SEARCH_CONTEXT_CHARS);
      const end = Math.min(text.length, index + query.length + SEARCH_CONTEXT_CHARS);
      matches.push({ offset: index, context: renderEmphasis(text.slice(start, end), run.documentEmphasis, start) });
    }
    cursor = index + Math.max(1, query.length);
  }
  return { matches, totalMatches };
}

export function stageAgentRunSuggestions(run: AgentRunContext, candidates: SuggestionCandidate[]): {
  results: StageResultItem[];
  stagedCount: number;
  remainingBudget: number | null;
} {
  const results: StageResultItem[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (run.maxSuggestions !== null && run.staged.length >= run.maxSuggestions) {
      results.push({
        index,
        staged: false,
        reason: `The request caps suggestions at ${run.maxSuggestions} and that budget is used; stop staging and write your summary.`
      });
      run.rejectedCount += 1;
      continue;
    }
    const verdict = isImageCandidate(candidates[index])
      ? validateImageReplacementCandidate(candidates[index], run.images)
      : validateSuggestionCandidate(candidates[index], run);
    if (!verdict.ok) {
      results.push({ index, staged: false, reason: verdict.reason });
      run.rejectedCount += 1;
      continue;
    }
    const duplicate = run.staged.some((existing) =>
      existing.original === verdict.suggestion.original && existing.replacement === verdict.suggestion.replacement);
    if (duplicate) {
      results.push({ index, staged: false, reason: "An identical suggestion is already staged in this run." });
      run.rejectedCount += 1;
      continue;
    }
    const ref = `S${run.staged.length + 1}`;
    const staged = { ...verdict.suggestion, ref };
    run.staged.push(staged);
    results.push({ index, staged: true, id: staged.id, ref, ...(verdict.note ? { note: verdict.note } : {}) });
  }
  return {
    results,
    stagedCount: run.staged.length,
    remainingBudget: run.maxSuggestions === null ? null : Math.max(0, run.maxSuggestions - run.staged.length)
  };
}

export function readAgentRunAttachment(run: AgentRunContext, name: string, offsetInput?: unknown, limitInput?: unknown): {
  name: string;
  text: string;
  offset: number;
  totalLength: number;
  note?: string;
} | null {
  const attachment = run.attachments.find((candidate) => candidate.name === name);
  if (!attachment) {
    return null;
  }
  const totalLength = attachment.text.length;
  const offset = clampInteger(offsetInput, 0, Math.max(0, totalLength), 0);
  const limit = clampInteger(limitInput, 1, MAX_READ_LIMIT, DEFAULT_READ_LIMIT);
  return {
    name: attachment.name,
    text: attachment.text.slice(offset, offset + limit),
    offset,
    totalLength,
    ...(attachment.truncated ? { note: `The extracted text was truncated at upload; the full file is at ${attachment.path}.` } : {}),
    ...(totalLength === 0 ? { note: `No text could be extracted from this file; the raw file is at ${attachment.path}.` } : {})
  };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}
