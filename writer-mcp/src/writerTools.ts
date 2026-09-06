/**
 * Nebula Writer MCP tools
 *
 * These tools talk to the local Writer sidecar over HTTP. Start the sidecar
 * first (npm run sidecar in the repo root) or point writer_url / NEBULA_WRITER_URL
 * at a running instance.
 */

import type { Tool } from './types.js';

type AiProviderName = 'codex' | 'claude';
type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

interface WriterToolParams {
  writer_url?: string;
}

interface WriterSession {
  documentText: string;
  features: Record<string, unknown>;
  id: string;
  importMessages: string[];
  name: string;
  pendingSuggestions: number;
  /** Monotonic counter bumped on every sidecar-side mutation; lets clients detect concurrent updates. */
  revision?: number;
  suggestions: WriterSuggestion[];
  title: string;
  updatedAt: string;
}

interface AiProgressSnapshot {
  provider: string;
  stage: string;
  requestedBy?: string | null;
  passIndex: number | null;
  passTotal: number | null;
  startedAt: string;
  updatedAt: string;
  timeoutMs: number;
}

interface WriterSuggestion {
  confidence: number;
  decidedBy?: string | null;
  decisionNote?: string | null;
  id: string;
  original: string;
  proposedBy?: string | null;
  rationale: string;
  replacement: string;
  status: SuggestionStatus;
  title: string;
}

interface WriterSessionEnvelope {
  session: WriterSession | null;
}

interface WriterSuggestEnvelope {
  ai: {
    message: string;
    provider: AiProviderName;
    suggestions: WriterSuggestion[];
  };
  session: WriterSession;
}

interface WriterExportEnvelope {
  outputPath: string;
  report: {
    commentedSuggestionTitles: string[];
    commentedSuggestions: number;
    matchedSuggestions: number;
    totalSuggestions: number;
    unmatchedSuggestionTitles: string[];
    unmatchedSuggestions: number;
  } | null;
  session: WriterSession;
}

const DEFAULT_WRITER_URL = 'http://127.0.0.1:8787';

export const writerStatusTool: Tool<WriterToolParams, { health: unknown; progress: AiProgressSnapshot | null; queue: Array<{ provider: string; requestedBy: string | null }>; session: WriterSession | null }> = {
  definition: {
    name: 'writer_status',
    description: 'Check the Nebula Writer sidecar: active shared session summary (including its revision), any AI request currently in progress, and provider health. Poll this while a writer_propose_changes call is running to see coverage-pass progress.',
    inputSchema: {
      type: 'object',
      properties: {
        writer_url: { type: 'string', description: 'Writer sidecar URL. Defaults to NEBULA_WRITER_URL, WRITER_SIDECAR_URL, or http://127.0.0.1:8787.' },
      },
    },
    annotations: { readOnlyHint: true },
  },

  async execute(params) {
    const baseUrl = writerUrl(params);
    const [health, session, progress] = await Promise.all([
      requestWriterJson<unknown>(baseUrl, '/api/health'),
      requestWriterJson<WriterSessionEnvelope>(baseUrl, '/api/session'),
      requestWriterJson<{ progress: AiProgressSnapshot | null; queue?: Array<{ provider: string; requestedBy: string | null }> }>(baseUrl, '/api/ai/progress').catch(() => ({ progress: null, queue: [] })),
    ]);
    return { success: true, data: { health, progress: progress.progress, queue: (progress as { queue?: Array<{ provider: string; requestedBy: string | null }> }).queue ?? [], session: session.session } };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { progress, session } = result.data!;
    const sessionText = session
      ? [
        `Active document: ${session.name}`,
        `Session revision: ${session.revision ?? 'unknown'} (pass expected_revision to writer_set_suggestion_status to detect concurrent edits)`,
        `Characters: ${session.documentText.length}`,
        `Pending suggestions: ${session.pendingSuggestions}`,
        `Updated: ${session.updatedAt}`,
      ].join('\n')
      : 'No active Writer document.';
    const queue = (result.data! as { progress: AiProgressSnapshot | null; queue?: Array<{ provider: string; requestedBy: string | null }> }).queue ?? [];
    const progressText = progress
      ? `AI request in progress: ${progress.provider}${progress.requestedBy ? ` (for ${progress.requestedBy})` : ''} — ${progress.stage} (started ${progress.startedAt})${queue.length ? `; ${queue.length} request${queue.length === 1 ? '' : 's'} queued` : ''}`
      : 'No AI request in progress.';
    return [{ type: 'text', text: `${sessionText}\n${progressText}\n\nHealth:\n${JSON.stringify(result.data!.health, null, 2)}` }];
  },
};

export const writerOpenDocxTool: Tool<WriterToolParams & { path: string }, WriterSession> = {
  definition: {
    name: 'writer_open_docx',
    description: 'Open a local DOCX in the shared Nebula Writer sidecar session so both the user UI and agent tools can inspect/review it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or working-directory-relative path to the .docx file.' },
        writer_url: { type: 'string', description: 'Writer sidecar URL. Optional.' },
      },
      required: ['path'],
    },
  },

  async execute(params) {
    const result = await requestWriterJson<WriterSessionEnvelope>(writerUrl(params), '/api/session/open-docx', {
      method: 'POST',
      body: { path: params.path },
    });
    if (!result.session) {
      return { success: false, error: 'Writer sidecar did not return a session.' };
    }
    return { success: true, data: result.session };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const session = result.data!;
    return [{
      type: 'text',
      text: [
        `Opened: ${session.name}`,
        `Characters: ${session.documentText.length}`,
        `Pending suggestions: ${session.pendingSuggestions}`,
        `Features: ${formatFeatures(session.features)}`,
      ].join('\n'),
    }];
  },
};

export const writerGetDocumentTool: Tool<WriterToolParams & { max_chars?: number }, { maxChars: number; session: WriterSession }> = {
  definition: {
    name: 'writer_get_document',
    description: 'Read the active Nebula Writer document text, imported DOCX feature summary, and suggestion counts.',
    inputSchema: {
      type: 'object',
      properties: {
        max_chars: { type: 'number', description: 'Maximum document text characters to include in the MCP response. Defaults to 6000.' },
        writer_url: { type: 'string', description: 'Writer sidecar URL. Optional.' },
      },
    },
    annotations: { readOnlyHint: true },
  },

  async execute(params) {
    const result = await requestWriterJson<WriterSessionEnvelope>(writerUrl(params), '/api/session');
    if (!result.session) {
      return { success: false, error: 'No active Writer document. Call writer_open_docx first or import a DOCX in the web UI.' };
    }
    return {
      success: true,
      data: {
        maxChars: typeof params.max_chars === 'number' && Number.isFinite(params.max_chars)
          ? Math.max(500, Math.min(100000, Math.round(params.max_chars)))
          : 6000,
        session: result.session,
      },
    };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { maxChars, session } = result.data!;
    return [{
      type: 'text',
      text: [
        `Document: ${session.name}`,
        `Characters: ${session.documentText.length}`,
        `Pending suggestions: ${session.pendingSuggestions}`,
        `Features: ${formatFeatures(session.features)}`,
        '',
        truncate(session.documentText, maxChars),
      ].join('\n'),
    }];
  },
};

export const writerProposeChangesTool: Tool<WriterToolParams & {
  instruction: string;
  max_suggestions?: number;
  mode?: 'global' | 'selection';
  provider?: AiProviderName;
  requested_by?: string;
  selection_text?: string;
}, WriterSuggestEnvelope> = {
  definition: {
    name: 'writer_propose_changes',
    description: 'Ask Codex CLI or Claude Code to propose anchored revisions against the active Writer document and add them to the shared review queue (the user sees them live in the Writer web UI). Proposals anchor to the LIVE collaborative text, so accepted edits from earlier rounds are already part of what you are revising — multi-iteration workflows just call this again. To revise one of your own still-pending proposals, withdraw it first (writer_set_suggestion_status: rejected, expected_status pending), then propose the replacement; never edit around a proposal the user already accepted or rejected. Long documents run in multiple coverage passes and can take minutes; call writer_status from another turn to see pass-by-pass progress.',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'Revision instruction for the local AI provider.' },
        max_suggestions: { type: 'number', description: 'Optional cap on the number of suggestions to return. Omit for no cap.' },
        mode: { type: 'string', enum: ['global', 'selection'], default: 'global', description: 'Use global for whole-document review or selection for a specific text span.' },
        provider: { type: 'string', enum: ['codex', 'claude'], default: 'codex', description: 'Local AI provider to run through the Writer sidecar.' },
        requested_by: { type: 'string', description: 'Name shown to collaborators while this request runs and on the resulting suggestions. Defaults to "Agent".' },
        selection_text: { type: 'string', description: 'Exact selected text to revise when mode is selection.' },
        writer_url: { type: 'string', description: 'Writer sidecar URL. Optional.' },
      },
      required: ['instruction'],
    },
  },

  async execute(params) {
    const result = await requestWriterJson<WriterSuggestEnvelope>(writerUrl(params), '/api/session/suggest', {
      method: 'POST',
      // No timeout: multi-pass coverage reviews legitimately run for minutes.
      timeoutMs: null,
      body: {
        provider: params.provider ?? 'codex',
        instruction: params.instruction,
        mode: params.mode ?? 'global',
        selectionText: params.selection_text,
        maxSuggestions: params.max_suggestions,
        requestedBy: params.requested_by ?? 'Agent',
      },
    });
    return { success: true, data: result };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { ai, session } = result.data!;
    return [{
      type: 'text',
      text: [
        ai.message,
        '',
        `Added ${ai.suggestions.length} suggestion${ai.suggestions.length === 1 ? '' : 's'} to ${session.name}.`,
        formatSuggestions(ai.suggestions),
      ].filter(Boolean).join('\n'),
    }];
  },
};

export const writerListSuggestionsTool: Tool<WriterToolParams, { revision: number | null; sessionId: string | null; suggestions: WriterSuggestion[] }> = {
  definition: {
    name: 'writer_list_suggestions',
    description: 'List AI suggestions currently held in the shared Nebula Writer review queue, with the session revision to use as expected_revision in writer_set_suggestion_status.',
    inputSchema: {
      type: 'object',
      properties: {
        writer_url: { type: 'string', description: 'Writer sidecar URL. Optional.' },
      },
    },
    annotations: { readOnlyHint: true },
  },

  async execute(params) {
    return { success: true, data: await requestWriterJson<{ revision: number | null; sessionId: string | null; suggestions: WriterSuggestion[] }>(writerUrl(params), '/api/session/suggestions') };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { revision, suggestions } = result.data!;
    const header = revision === null ? null : `Session revision: ${revision}`;
    return [{
      type: 'text',
      text: [header, suggestions.length ? formatSuggestions(suggestions) : 'No Writer suggestions in the active review queue.']
        .filter((part): part is string => part !== null)
        .join('\n\n'),
    }];
  },
};

export const writerSetSuggestionStatusTool: Tool<WriterToolParams & { decided_by?: string; expected_revision?: number; expected_status?: SuggestionStatus; id: string; note?: string; status: SuggestionStatus }, WriterSession> = {
  definition: {
    name: 'writer_set_suggestion_status',
    description: 'Mark a Writer suggestion as pending, accepted, or rejected in the shared review queue. The user sees the change immediately in the Writer web UI. Pass expected_status (usually "pending") so a decision the user or another agent made first is not silently overwritten — a conflict returns HTTP 409 with who decided. This is also how an agent withdraws or supersedes its own still-pending proposal: reject it (expected_status "pending", decided_by your name) and propose the revised edit with writer_propose_changes.',
    inputSchema: {
      type: 'object',
      properties: {
        decided_by: { type: 'string', description: 'Name recorded as the decision maker, shown to collaborators. Defaults to "Agent".' },
        expected_revision: { type: 'number', description: 'Optional optimistic-concurrency guard: the session revision this update is based on.' },
        expected_status: { type: 'string', enum: ['pending', 'accepted', 'rejected'], description: 'Compare-and-swap guard: fail with 409 if the suggestion is no longer in this status. Recommended: pass the status you last read.' },
        id: { type: 'string', description: 'Suggestion id from writer_list_suggestions.' },
        note: { type: 'string', description: 'Optional short note stored with the decision (e.g. why a proposal was withdrawn); collaborators see it on the card.' },
        status: { type: 'string', enum: ['pending', 'accepted', 'rejected'], description: 'New suggestion status.' },
        writer_url: { type: 'string', description: 'Writer sidecar URL. Optional.' },
      },
      required: ['id', 'status'],
    },
  },

  async execute(params) {
    const result = await requestWriterJson<WriterSessionEnvelope>(writerUrl(params), '/api/session/suggestion-status', {
      method: 'POST',
      body: {
        id: params.id,
        status: params.status,
        decidedBy: params.decided_by ?? 'Agent',
        decisionNote: params.note,
        expectedRevision: params.expected_revision,
        expectedStatus: params.expected_status,
      },
    });
    if (!result.session) {
      return { success: false, error: 'Writer sidecar did not return a session.' };
    }
    return { success: true, data: result.session };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    return [{ type: 'text', text: `Suggestion status updated. Pending suggestions: ${result.data!.pendingSuggestions}. Session revision is now ${result.data!.revision ?? 'unknown'}.` }];
  },
};

export const writerExportReviewDocxTool: Tool<WriterToolParams & { output_path?: string; pending_only?: boolean }, WriterExportEnvelope> = {
  definition: {
    name: 'writer_export_review_docx',
    description: 'Export the active Writer document as a DOCX review copy with matched suggestions as tracked changes and unsafe/unmatched suggestions as Word comments.',
    inputSchema: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: 'Where to write the review DOCX. Defaults to tmp/<title>_<timestamp>_review.docx under the sidecar working directory.' },
        pending_only: { type: 'boolean', default: true, description: 'Only export pending suggestions. Set false to also export accepted suggestions as Word tracked changes (use this after accepting suggestions via writer_set_suggestion_status so those edits reach the DOCX). Defaults to true.' },
        writer_url: { type: 'string', description: 'Writer sidecar URL. Optional.' },
      },
    },
  },

  async execute(params) {
    return {
      success: true,
      data: await requestWriterJson<WriterExportEnvelope>(writerUrl(params), '/api/session/export-review', {
        method: 'POST',
        // Large documents with many suggestions can take a while to patch.
        timeoutMs: 120_000,
        body: {
          outputPath: params.output_path,
          pendingOnly: params.pending_only ?? true,
        },
      }),
    };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { outputPath, report } = result.data!;
    const reportText = report
      ? `Matched ${report.matchedSuggestions}/${report.totalSuggestions}; comments ${report.commentedSuggestions}; unresolved ${report.unmatchedSuggestions}.`
      : 'Exported DOCX.';
    return [{ type: 'text', text: `Review DOCX written: ${outputPath}\n${reportText}` }];
  },
};


interface InlineSuggestionCluster {
  changeId: string;
  kind: 'insertion' | 'deletion' | 'replacement';
  deletedText: string;
  insertedText: string;
  authorName: string | null;
  role: string | null;
  createdAt: string | null;
}

function formatInlineSuggestions(clusters: InlineSuggestionCluster[]): string {
  return clusters.map((cluster) => {
    const change = cluster.kind === 'replacement'
      ? `replace "${cluster.deletedText}" with "${cluster.insertedText}"`
      : cluster.kind === 'deletion'
        ? `delete "${cluster.deletedText}"`
        : `insert "${cluster.insertedText}"`;
    return `- [${cluster.changeId}] ${change} (by ${cluster.authorName ?? 'unknown'}${cluster.role ? `, ${cluster.role}` : ''})`;
  }).join('\n');
}

export const writerListInlineSuggestionsTool: Tool<WriterToolParams & { doc_id?: string }, { docId: string; suggestions: InlineSuggestionCluster[] }> = {
  definition: {
    name: 'writer_list_inline_suggestions',
    description: 'List the INLINE suggestions carried as marks in the live Writer document (Google-Docs-style tracked changes from humans, agents, or an imported DOCX). Each entry has a changeId for writer_resolve_inline_suggestion. These are separate from the review-queue suggestions of writer_list_suggestions.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'Document id. Defaults to the active session document.' },
        writer_url: { type: 'string', description: 'Writer sidecar URL. Optional.' },
      },
    },
    annotations: { readOnlyHint: true },
  },

  async execute(params) {
    const query = params.doc_id ? `?doc=${encodeURIComponent(params.doc_id)}` : '';
    return { success: true, data: await requestWriterJson<{ docId: string; suggestions: InlineSuggestionCluster[] }>(writerUrl(params), `/api/collab/inline-suggestions${query}`) };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { suggestions } = result.data!;
    return [{
      type: 'text',
      text: suggestions.length
        ? `${suggestions.length} inline suggestion${suggestions.length === 1 ? '' : 's'} in the document:\n${formatInlineSuggestions(suggestions)}`
        : 'No inline suggestions in the document.',
    }];
  },
};

export const writerResolveInlineSuggestionTool: Tool<WriterToolParams & { change_id: string; decision: 'accept' | 'reject'; doc_id?: string }, { ok: boolean }> = {
  definition: {
    name: 'writer_resolve_inline_suggestion',
    description: 'Accept or reject one INLINE suggestion (by changeId from writer_list_inline_suggestions) directly in the live document. Accepting applies the change (insertions stay, struck deletions are removed); rejecting reverts it. Every collaborator sees the resolution immediately. Only resolve suggestions the user asked you to review.',
    inputSchema: {
      type: 'object',
      properties: {
        change_id: { type: 'string', description: 'changeId from writer_list_inline_suggestions.' },
        decision: { type: 'string', enum: ['accept', 'reject'], description: 'accept applies the suggestion; reject reverts it.' },
        doc_id: { type: 'string', description: 'Document id. Defaults to the active session document.' },
        writer_url: { type: 'string', description: 'Writer sidecar URL. Optional.' },
      },
      required: ['change_id', 'decision'],
    },
  },

  async execute(params) {
    return {
      success: true,
      data: await requestWriterJson<{ ok: boolean }>(writerUrl(params), '/api/collab/inline-suggestions/resolve', {
        method: 'POST',
        body: { changeId: params.change_id, decision: params.decision, docId: params.doc_id },
      }),
    };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    return [{ type: 'text', text: 'Inline suggestion resolved. All collaborators see the change.' }];
  },
};

export const writerTools: Tool<any, any>[] = [
  writerStatusTool,
  writerOpenDocxTool,
  writerGetDocumentTool,
  writerProposeChangesTool,
  writerListSuggestionsTool,
  writerSetSuggestionStatusTool,
  writerListInlineSuggestionsTool,
  writerResolveInlineSuggestionTool,
  writerExportReviewDocxTool,
];

function writerUrl(params: WriterToolParams): string {
  return (params.writer_url || process.env.NEBULA_WRITER_URL || process.env.WRITER_SIDECAR_URL || DEFAULT_WRITER_URL).replace(/\/+$/, '');
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function sidecarUnreachableMessage(baseUrl: string): string {
  return `The Writer sidecar is not reachable at ${baseUrl}. Start it with \`npm run sidecar\` (or \`npm run dev:all\`) in the nebula-writer repo, or pass writer_url if it runs elsewhere.`;
}

async function requestWriterJson<T>(
  baseUrl: string,
  path: string,
  options: { body?: unknown; method?: string; timeoutMs?: number | null } = {}
): Promise<T> {
  // timeoutMs: undefined → default; null → no timeout (long AI runs).
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : options.timeoutMs;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`The Writer sidecar did not answer ${path} within ${Math.round((timeoutMs ?? 0) / 1000)}s. It may be busy or wedged — check writer_status or the sidecar terminal.`);
    }
    throw new Error(sidecarUnreachableMessage(baseUrl));
  }
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return response.json() as Promise<T>;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error || response.statusText;
  } catch {
    return response.statusText;
  }
}

function formatFeatures(features: Record<string, unknown>): string {
  const visible = Object.entries(features)
    .filter(([, value]) => typeof value === 'number' && value > 0)
    .map(([key, value]) => `${key}=${value}`);
  return visible.length ? visible.join(', ') : 'basic text';
}

function formatSuggestions(suggestions: WriterSuggestion[]): string {
  return suggestions.map((suggestion, index) => {
    // A self-rejection is a withdrawal (agent superseded its own proposal),
    // not a reviewer saying no — downstream rounds should treat them differently.
    const withdrawn = suggestion.status === 'rejected' && suggestion.decidedBy && suggestion.decidedBy === suggestion.proposedBy;
    const statusLabel = withdrawn ? 'withdrawn' : suggestion.status;
    const lines = [
      `${index + 1}. ${suggestion.title} (${statusLabel}${suggestion.decidedBy ? ` by ${suggestion.decidedBy}` : ''}, ${Math.round(suggestion.confidence * 100)}%, id=${suggestion.id})`,
      `Original: ${truncate(suggestion.original, 280)}`,
      `Replacement: ${truncate(suggestion.replacement, 280)}`,
      `Rationale: ${truncate(suggestion.rationale, 220)}`,
    ];
    if (suggestion.decisionNote) {
      lines.push(`Reviewer note: ${truncate(suggestion.decisionNote, 280)}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n... [truncated]`;
}
