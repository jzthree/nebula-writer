import { getStoredShareToken } from "./shareToken";
import type {
  AiAttachment,
  AiRequest,
  AiResponse,
  AiSuggestion,
  CliTimeoutHealth,
  DocxBodySafeAnchor,
  DocxFeatureSummary,
  SourceTrackedChangePreview,
  ExportRequest,
  ImportedDocument,
  LocalAiProviderName,
  ProviderHealth,
  ProviderSmokeResponse,
  SuggestionStatus,
  WordLiveSuggestionRequest,
  WordLiveSuggestionResponse,
  WriterAutosavedSessionSummary,
  WriterChatMessage,
  WriterReviewSourceDocument,
  WriterRoutineRun,
  WriterSessionDocument,
  WriterSessionEnvelope,
  WriterSessionSummary
} from "./shared";

export interface HealthResponse {
  /** Random id of this sidecar process (used for suggestion origin claims). */
  instanceId?: string;
  ok: boolean;
  /** True when served by the Cloudflare deployment (no local sidecar features). */
  cloud?: boolean;
  /** True when the app is served by the local sidecar (local-first mode): AI + terminal same-origin. */
  local?: boolean;
  /** True when the local sidecar is also serving the web bundle. */
  servesWeb?: boolean;
  cliEnabled: boolean;
  cliTimeout?: CliTimeoutHealth;
  providers: string[];
  providerStatus?: ProviderHealth[];
  /** HTTPS listener serving the Word add-in, when configured. */
  tls?: { port: number; wordAddinUrl: string } | null;
}

export interface ExportReport {
  commentedSuggestionIds: string[];
  commentedSuggestionOriginals?: string[];
  commentedSuggestionReasonCounts?: Array<{ count: number; reason: string }>;
  commentedSuggestionReasons: string[];
  commentedSuggestionTitles: string[];
  commentedSuggestions: number;
  matchedSuggestionIds: string[];
  matchedSuggestionTitles?: string[];
  matchedSuggestions: number;
  totalSuggestions: number;
  unmatchedSuggestionIds: string[];
  unmatchedSuggestionOriginals?: string[];
  unmatchedSuggestionTitles: string[];
  unmatchedSuggestions: number;
}

export interface ExportDocxResult {
  blob: Blob;
  filename?: string;
  report: ExportReport | null;
}

export interface ReviewPlacement {
  handoff: string;
  id: string;
  originalLength: number;
  originalPreview: string;
  outcome: "tracked-change" | "word-comment" | "unresolved";
  reason?: string;
  replacementLength: number;
  replacementPreview: string;
  scale: string;
  sectionHint: string;
  title: string;
}

export interface ReviewSummary {
  commentedSuggestionTitles: string[];
  matchedSuggestionTitles: string[];
  piFactCheckHandoffs?: number;
  piFactCheckTitles?: string[];
  representedSuggestions: number;
  totalSuggestions: number;
  trackedChanges: number;
  unitSensitiveHandoffs?: number;
  unitSensitiveTitles?: string[];
  unresolvedSuggestions: number;
  unmatchedSuggestionTitles: string[];
  wordComments: number;
}

export interface WriterRoutineArtifactResult {
  blob: Blob;
  filename: string;
}

export interface WriterSessionStateResult {
  blob: Blob;
  filename: string;
}

export interface WriterAutosavedSessionsResult {
  sessions: WriterAutosavedSessionSummary[];
}

export interface WriterRoutineSuggestionsResult extends WriterSessionEnvelope<WriterSessionSummary> {
  syncedSuggestions: number;
}

export type WriterRoutineRunRequest = Pick<WriterRoutineRun, "routineId" | "label"> & Partial<Pick<WriterRoutineRun, "id" | "completedAt" | "artifactPath" | "downloadCopyPath" | "instruction" | "reportPath" | "suggestionsPath" | "report" | "sourceDocument">>;

export interface WriterSessionReviewExportRequest {
  copyToDownloads?: boolean;
  outputPath?: string;
  pendingOnly?: boolean;
  reportOutputPath?: string;
  sessionSnapshotOutputPath?: string;
  routineRun?: {
    completedAt?: string;
    id?: string;
    instruction?: string | null;
    label: string;
    routineId: string;
  };
  suggestionIds?: string[];
  suggestions?: AiSuggestion[];
  suggestionsOutputPath?: string;
}

export interface WriterSessionReviewExportResult extends WriterSessionEnvelope<WriterSessionSummary> {
  artifactPath: string;
  downloadCopyPath?: string | null;
  outputPath: string;
  reportPath: string;
  sessionSnapshotPath?: string | null;
  suggestionsPath: string;
  report: ExportReport | null;
  reviewSummary: ReviewSummary | null;
  routineRun: WriterRoutineRun | null;
  sourceDocument?: WriterReviewSourceDocument | null;
  sourceDocumentPath?: string | null;
  reviewPlacements: ReviewPlacement[];
}

export interface SidecarRequestOptions {
  signal?: AbortSignal;
}

/**
 * Optional optimistic-concurrency context for session mutations. When provided,
 * the sidecar rejects the write with HTTP 409 if the active session is a
 * different document (expectedSessionId) or has been updated since the client
 * last synced (expectedRevision), instead of silently clobbering it.
 */
export interface SessionWriteContext {
  expectedRevision?: number;
  expectedSessionId?: string;
  /** Routes the request to the right document room on cloud deployments. */
  docId?: string;
}

export interface SuggestionStatusContext extends SessionWriteContext {
  /** Optional reviewer note stored with the decision (visible to agents). */
  decisionNote?: string;
  /** Compare-and-swap guard: reject with 409 if the suggestion is no longer in this status. */
  expectedStatus?: SuggestionStatus;
  /** Collaborator or agent name recorded as the decision maker. */
  decidedBy?: string;
}

export interface SuggestionStatusConflict {
  decidedAt: string | null;
  decidedBy: string | null;
  id: string;
  status: SuggestionStatus;
}

/** HTTP-level failure from the sidecar, with status code and parsed body for callers that branch on conflicts. */
export class SidecarHttpError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "SidecarHttpError";
    this.status = status;
    this.body = body;
  }
}

export function normalizeSidecarApiBase(value: string | undefined, fallback = ""): string {
  const configured = value?.trim() || fallback;
  const withoutTrailingSlash = configured.replace(/\/+$/, "");
  return withoutTrailingSlash === "/" ? "" : withoutTrailingSlash;
}

export const SIDECAR_UNREACHABLE_MESSAGE =
  "The Writer sidecar is not reachable. Start it with `npm run dev:all` (or `npm run sidecar`) and try again.";

async function sidecarFetch(input: string, init?: RequestInit): Promise<Response> {
  const shareToken = getStoredShareToken();
  const request: RequestInit = shareToken
    ? { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), "X-Writer-Share-Token": shareToken } }
    : init ?? {};
  try {
    return await fetch(input, request);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    throw new Error(SIDECAR_UNREACHABLE_MESSAGE);
  }
}

export async function getHealthFromSidecar(apiBase = ""): Promise<HealthResponse> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/health"));
  return readJson(response);
}

/** Agent terminal (terminal-driven Writer): status/ensure via the LOCAL sidecar. */
export interface AgentTerminalStatus {
  available: boolean;
  running: boolean;
  url: string | null;
  tunnel: boolean;
  detail: string;
}

/** Ask the LOCAL Writer to bridge a document's room through the cloud relay. */
export async function ensureCollabBridgeOnSidecar(apiBase: string, docId: string): Promise<{ bridged: boolean; connected: boolean; cloud: string }> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/collab/bridge"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ docId })
  });
  return readJson(response);
}

export async function ensureAgentTerminalOnSidecar(apiBase: string, provider: "claude" | "codex"): Promise<AgentTerminalStatus> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/agent-terminal"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider })
  });
  return readJson(response);
}

export interface AiProgressSnapshot {
  provider: string;
  stage: string;
  /** True when the stage describes a tool call (counted as one in the conversation). */
  tool?: boolean;
  passIndex: number | null;
  passTotal: number | null;
  startedAt: string;
  updatedAt: string;
  /** Configured provider timeout, or null when the run has no time limit. */
  timeoutMs: number | null;
}

export async function getAiProgressFromSidecar(apiBase = ""): Promise<{ progress: AiProgressSnapshot | null }> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/ai/progress"));
  return readJson(response);
}

export interface ShareInfo {
  sharable: boolean;
  shareUrls: string[];
}

export async function getShareInfoFromSidecar(apiBase = ""): Promise<ShareInfo> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/share-info"));
  return readJson(response);
}

export async function importDocxToSidecar(apiBase: string, file: File): Promise<ImportedDocument> {
  const data = new FormData();
  data.append("file", file);
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/docx/import"), {
    method: "POST",
    body: data
  });
  return readJson(response);
}

export async function exportDocxFromSidecar(apiBase: string, request: ExportRequest): Promise<ExportDocxResult> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/docx/export"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return {
    blob: await response.blob(),
    filename: readContentDispositionFilename(response) ?? undefined,
    report: readExportReport(response)
  };
}

export async function uploadAiAttachmentToSidecar(apiBase: string, file: File): Promise<AiAttachment> {
  const data = new FormData();
  data.append("file", file);
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/ai/attachments"), {
    method: "POST",
    body: data
  });
  const payload = await readJson<{ attachment: AiAttachment }>(response);
  return payload.attachment;
}

export async function requestAiSuggestionFromSidecar(apiBase: string, request: AiRequest, options: SidecarRequestOptions = {}): Promise<AiResponse> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/ai/suggest"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: options.signal,
    body: JSON.stringify(request)
  });
  return readJson(response);
}

export async function fetchWordLiveSuggestionsFromSidecar(apiBase: string, request: WordLiveSuggestionRequest, options: SidecarRequestOptions = {}): Promise<Response> {
  return sidecarFetch(sidecarUrl(apiBase, "/api/word/suggest"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: options.signal,
    body: JSON.stringify(request)
  });
}

export async function requestWordLiveSuggestionsFromSidecar(apiBase: string, request: WordLiveSuggestionRequest, options: SidecarRequestOptions = {}): Promise<WordLiveSuggestionResponse> {
  return readJson(await fetchWordLiveSuggestionsFromSidecar(apiBase, request, options));
}

export async function runProviderSmokeTestFromSidecar(apiBase: string, provider: LocalAiProviderName): Promise<ProviderSmokeResponse> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/ai/smoke"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider })
  });
  return readJson(response);
}

export async function getWriterSessionFromSidecar(apiBase = "", docId?: string): Promise<WriterSessionEnvelope<WriterSessionSummary>> {
  const response = await sidecarFetch(sidecarUrl(apiBase, `/api/session${docId ? `?doc=${encodeURIComponent(docId)}` : ""}`));
  return readJson(response);
}

export async function getWriterSessionDocumentFromSidecar(apiBase = "", docId?: string): Promise<WriterSessionEnvelope<WriterSessionDocument>> {
  const response = await sidecarFetch(sidecarUrl(apiBase, `/api/session/document${docId ? `?doc=${encodeURIComponent(docId)}` : ""}`));
  return readJson(response);
}

export interface CreateWriterSessionPayload {
  html: string;
  text: string;
  title?: string;
  name?: string;
  features?: DocxFeatureSummary;
  importMessages?: string[];
  bodySafeAnchors?: string[];
  bodySafeAnchorDetails?: DocxBodySafeAnchor[];
  sourceTrackedChanges?: SourceTrackedChangePreview[];
}

export async function createWriterSessionInSidecar(apiBase: string, payload: CreateWriterSessionPayload): Promise<WriterSessionEnvelope<WriterSessionDocument>> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/session/create"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return readJson(response);
}

export async function getWriterAutosavedSessionsFromSidecar(apiBase = ""): Promise<WriterAutosavedSessionsResult> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/session/autosaves"));
  return readJson(response);
}

export async function loadWriterAutosavedSessionFromSidecar(apiBase: string, id: string): Promise<WriterSessionEnvelope<WriterSessionDocument>> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/session/autosaves/load"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id })
  });
  return readJson(response);
}

export async function exportWriterSessionStateFromSidecar(apiBase = ""): Promise<WriterSessionStateResult> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/session/export-state"));
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return {
    blob: await response.blob(),
    filename: readContentDispositionFilename(response) ?? "nebula-writer-session.json"
  };
}

export async function importWriterSessionStateToSidecar(apiBase: string, file: File): Promise<WriterSessionEnvelope<WriterSessionDocument>> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/session/import-state"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await file.text()
  });
  return readJson(response);
}

export async function setWriterSuggestionStatusInSidecar(apiBase: string, id: string, status: SuggestionStatus, context: SuggestionStatusContext = {}): Promise<WriterSessionEnvelope<WriterSessionSummary>> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/session/suggestion-status"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, status, ...context })
  });
  return readJson(response);
}

export async function recordWriterSuggestionsInSidecar(apiBase: string, suggestions: AiSuggestion[], context: SessionWriteContext = {}): Promise<WriterSessionEnvelope<WriterSessionSummary> & { recorded: number }> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/session/record-suggestions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suggestions, ...context })
  });
  return readJson(response);
}

export async function appendWriterChatMessagesToSidecar(apiBase: string, chatMessages: WriterChatMessage[], context: SessionWriteContext = {}): Promise<WriterSessionEnvelope<WriterSessionSummary> & { appended: number }> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/session/chat-append"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatMessages, ...context })
  });
  return readJson(response);
}

export async function setWriterSessionChatMessagesFromSidecar(apiBase: string, chatMessages: WriterChatMessage[], context: SessionWriteContext = {}): Promise<WriterSessionEnvelope<WriterSessionSummary>> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/session/chat-messages"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatMessages, ...context })
  });
  return readJson(response);
}

export async function setWriterRoutineProgressInSidecar(apiBase: string, routineProgress: string[], context: SessionWriteContext = {}): Promise<WriterSessionEnvelope<WriterSessionSummary>> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/session/routine-progress"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ routineProgress, ...context })
  });
  return readJson(response);
}

export async function setWriterRoutineRunInSidecar(apiBase: string, run: WriterRoutineRunRequest, context: SessionWriteContext = {}): Promise<WriterSessionEnvelope<WriterSessionSummary>> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/session/routine-run"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...run, ...context })
  });
  return readJson(response);
}

export async function exportWriterSessionReviewFromSidecar(apiBase: string, request: WriterSessionReviewExportRequest): Promise<WriterSessionReviewExportResult> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/session/export-review"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });
  return readJson(response);
}

export async function downloadWriterRoutineArtifactFromSidecar(apiBase: string, id: string): Promise<WriterRoutineArtifactResult> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/session/routine-artifact"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id })
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return {
    blob: await response.blob(),
    filename: readContentDispositionFilename(response) ?? "nebula-writer-review.docx"
  };
}

export async function syncWriterRoutineSuggestionsFromSidecar(apiBase: string, id: string): Promise<WriterRoutineSuggestionsResult> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/session/routine-suggestions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id })
  });
  return readJson(response);
}

export async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.clone().json();
    } catch {
      // Body was not JSON.
    }
    throw new SidecarHttpError(await readError(response), response.status, body);
  }
  return response.json() as Promise<T>;
}

export async function readError(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = await response.clone().json() as { error?: string };
    detail = typeof body.error === "string" ? body.error : "";
  } catch {
    // Body was not JSON; fall back to a status-based hint below.
  }
  if (detail) {
    return detail;
  }
  return sidecarHttpHint(response.status)
    ?? `${response.statusText || "Request failed"} (HTTP ${response.status})`;
}

function sidecarHttpHint(status: number): string | null {
  if (status === 413) {
    return "This file is larger than the 20 MB import limit. Remove embedded media or split the document, then try again.";
  }
  if (status === 404 || status === 502 || status === 503 || status === 504) {
    return `The Writer sidecar did not answer this request (HTTP ${status}). It may still be starting — make sure it is running via \`npm run dev:all\` and try again.`;
  }
  if (status >= 500) {
    return `The Writer sidecar hit an internal error (HTTP ${status}). Check the sidecar terminal output for details.`;
  }
  return null;
}

function sidecarUrl(apiBase: string, path: string): string {
  const base = normalizeSidecarApiBase(apiBase);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function readExportReport(response: Response): ExportReport | null {
  const total = readNumberHeader(response, "X-Nebula-Writer-Suggestions-Total");
  const matched = readNumberHeader(response, "X-Nebula-Writer-Suggestions-Matched");
  const unmatched = readNumberHeader(response, "X-Nebula-Writer-Suggestions-Unmatched");
  const matchedIds = readJsonHeader<string[]>(response, "X-Nebula-Writer-Suggestions-Matched-Ids") ?? [];
  const matchedTitles = readJsonHeader<string[]>(response, "X-Nebula-Writer-Suggestions-Matched-Titles") ?? [];
  const unmatchedIds = readJsonHeader<string[]>(response, "X-Nebula-Writer-Suggestions-Unmatched-Ids") ?? [];
  const unmatchedTitles = readJsonHeader<string[]>(response, "X-Nebula-Writer-Suggestions-Unmatched-Titles") ?? [];
  const commented = readNumberHeader(response, "X-Nebula-Writer-Suggestions-Commented") ?? 0;
  const commentedIds = readJsonHeader<string[]>(response, "X-Nebula-Writer-Suggestions-Commented-Ids") ?? [];
  const commentedReasons = readJsonHeader<string[]>(response, "X-Nebula-Writer-Suggestions-Commented-Reasons") ?? [];
  const commentedTitles = readJsonHeader<string[]>(response, "X-Nebula-Writer-Suggestions-Commented-Titles") ?? [];
  if (total === null || matched === null || unmatched === null) {
    return null;
  }
  return {
    commentedSuggestionIds: commentedIds.filter((id) => typeof id === "string"),
    commentedSuggestionReasons: commentedReasons.filter((reason) => typeof reason === "string"),
    commentedSuggestionTitles: commentedTitles.filter((title) => typeof title === "string"),
    commentedSuggestions: commented,
    matchedSuggestionIds: matchedIds.filter((id) => typeof id === "string"),
    matchedSuggestionTitles: matchedTitles.filter((title) => typeof title === "string"),
    totalSuggestions: total,
    matchedSuggestions: matched,
    unmatchedSuggestionIds: unmatchedIds.filter((id) => typeof id === "string"),
    unmatchedSuggestionTitles: unmatchedTitles.filter((title) => typeof title === "string"),
    unmatchedSuggestions: unmatched
  };
}

function readNumberHeader(response: Response, name: string): number | null {
  const value = response.headers.get(name);
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readJsonHeader<T>(response: Response, name: string): T | null {
  const value = response.headers.get(name);
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(decodeURIComponent(value)) as T;
  } catch {
    return null;
  }
}

function readContentDispositionFilename(response: Response): string | null {
  const value = response.headers.get("Content-Disposition");
  if (!value) {
    return null;
  }
  const match = /filename=\"?([^\";]+)\"?/i.exec(value);
  return match?.[1] ?? null;
}

/** Deliver a message into the running turn of request `runId` (mid-turn steering). */
export async function steerAiRunOnSidecar(apiBase: string, runId: string, text: string): Promise<import("./shared").AiSteerResponse> {
  try {
    const response = await sidecarFetch(sidecarUrl(apiBase, "/api/ai/steer"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, text })
    });
    if (!response.ok) {
      return { ok: false, reason: "failed", detail: `HTTP ${response.status}` };
    }
    return await response.json() as import("./shared").AiSteerResponse;
  } catch (error) {
    return { ok: false, reason: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** A fresh id for one AI request (steering addresses the run by it). */
export function newAiRunId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `run-${random}`.slice(0, 64);
}

/* ------------------------------------------------------------------------- */
/* Conversations per document (server/conversation-store.ts)                */
/* ------------------------------------------------------------------------- */

export interface StoredConversationPage<Turn = unknown, Suggestion = unknown, Card = unknown> {
  key: string;
  epoch: number;
  turns: Array<{ id: string; turn: Turn }>;
  suggestions: Array<{ id: string; turnId: string | null; suggestion: Suggestion }>;
  cards: Record<string, Card>;
  sessions: Record<string, string>;
  /** Cursor for the page before this one; null at the start of the conversation. */
  before: number | null;
}

export interface StoredConversationWrite<Turn = unknown, Suggestion = unknown, Card = unknown> {
  turns?: Array<{ id: string; turn: Turn }>;
  suggestions?: Array<{ id: string; turnId: string | null; suggestion: Suggestion }>;
  cards?: Record<string, { state: Card; pending: boolean }>;
  sessions?: Record<string, string>;
}

export async function fetchConversationFromSidecar<Turn, Suggestion, Card>(apiBase: string, key: string, options: { before?: number | null; limit?: number } = {}): Promise<StoredConversationPage<Turn, Suggestion, Card>> {
  const query = new URLSearchParams({ key, ...(options.limit ? { limit: String(options.limit) } : {}), ...(options.before ? { before: String(options.before) } : {}) });
  const response = await sidecarFetch(sidecarUrl(apiBase, `/api/conversations?${query}`));
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return readJson<StoredConversationPage<Turn, Suggestion, Card>>(response);
}

export async function writeConversationToSidecar<Turn, Suggestion, Card>(apiBase: string, key: string, change: StoredConversationWrite<Turn, Suggestion, Card>): Promise<void> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/conversations/write"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, ...change })
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

export async function resetConversationOnSidecar(apiBase: string, key: string, mode: "new" | "clear"): Promise<void> {
  const response = await sidecarFetch(sidecarUrl(apiBase, "/api/conversations/reset"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, mode })
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}
