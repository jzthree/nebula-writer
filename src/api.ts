import type {
  AiAttachment,
  AiRequest,
  AiResponse,
  AiSuggestion,
  ExportRequest,
  ImportedDocument,
  LocalAiProviderName,
  ProviderSmokeResponse,
  SuggestionStatus,
  WriterChatMessage,
  WriterSessionDocument,
  WriterSessionEnvelope,
  WriterSessionSummary
} from "./shared";
import {
  appendWriterChatMessagesToSidecar,
  createWriterSessionInSidecar,
  downloadWriterRoutineArtifactFromSidecar,
  exportDocxFromSidecar,
  getAiProgressFromSidecar,
  getShareInfoFromSidecar,
  exportWriterSessionReviewFromSidecar,
  exportWriterSessionStateFromSidecar,
  getWriterAutosavedSessionsFromSidecar,
  getHealthFromSidecar,
  getWriterSessionDocumentFromSidecar,
  getWriterSessionFromSidecar,
  importDocxToSidecar,
  importWriterSessionStateToSidecar,
  loadWriterAutosavedSessionFromSidecar,
  recordWriterSuggestionsInSidecar,
  requestAiSuggestionFromSidecar,
  runProviderSmokeTestFromSidecar,
  setWriterSessionChatMessagesFromSidecar,
  setWriterRoutineProgressInSidecar,
  setWriterRoutineRunInSidecar,
  setWriterSuggestionStatusInSidecar,
  syncWriterRoutineSuggestionsFromSidecar,
  uploadAiAttachmentToSidecar,
  ensureAgentTerminalOnSidecar,
  ensureCollabBridgeOnSidecar,
  type AgentTerminalStatus,
  type AiProgressSnapshot,
  type ExportDocxResult,
  type HealthResponse,
  type SessionWriteContext,
  type ShareInfo,
  type SuggestionStatusConflict,
  type SuggestionStatusContext,
  type WriterRoutineArtifactResult,
  type WriterRoutineRunRequest,
  type WriterRoutineSuggestionsResult,
  type WriterAutosavedSessionsResult,
  type WriterSessionReviewExportRequest,
  type WriterSessionReviewExportResult,
  type WriterSessionStateResult, steerAiRunOnSidecar } from "./sidecarClient";

export { SidecarHttpError } from "./sidecarClient";
export type {
  AgentTerminalStatus,
  AiProgressSnapshot,
  ExportDocxResult,
  ExportReport,
  HealthResponse,
  SessionWriteContext,
  ShareInfo,
  SuggestionStatusConflict,
  SuggestionStatusContext,
  ReviewPlacement,
  WriterRoutineArtifactResult,
  WriterRoutineRunRequest,
  WriterRoutineSuggestionsResult,
  WriterAutosavedSessionsResult,
  WriterSessionReviewExportRequest,
  WriterSessionReviewExportResult,
  WriterSessionStateResult
} from "./sidecarClient";

export async function getHealth(): Promise<HealthResponse> {
  return getHealthFromSidecar();
}

export async function getAiProgress(): Promise<{ progress: AiProgressSnapshot | null }> {
  return getAiProgressFromSidecar();
}

export async function getShareInfo(): Promise<ShareInfo> {
  return getShareInfoFromSidecar();
}

export async function importDocx(file: File): Promise<ImportedDocument> {
  return importDocxToSidecar("", file);
}

export async function exportDocx(request: ExportRequest): Promise<ExportDocxResult> {
  return exportDocxFromSidecar("", request);
}

export async function requestAiSuggestion(request: AiRequest, options: { signal?: AbortSignal } = {}): Promise<AiResponse> {
  return requestAiSuggestionFromSidecar("", request, options);
}

export async function runProviderSmokeTest(provider: LocalAiProviderName): Promise<ProviderSmokeResponse> {
  return runProviderSmokeTestFromSidecar("", provider);
}

export async function getWriterSession(docId?: string): Promise<WriterSessionEnvelope<WriterSessionSummary>> {
  return getWriterSessionFromSidecar("", docId);
}

export async function getWriterSessionDocument(docId?: string): Promise<WriterSessionEnvelope<WriterSessionDocument>> {
  return getWriterSessionDocumentFromSidecar("", docId);
}

export async function createWriterSession(payload: import("./sidecarClient").CreateWriterSessionPayload): Promise<WriterSessionEnvelope<WriterSessionDocument>> {
  return createWriterSessionInSidecar("", payload);
}

export async function getWriterAutosavedSessions(): Promise<WriterAutosavedSessionsResult> {
  return getWriterAutosavedSessionsFromSidecar();
}

export async function loadWriterAutosavedSession(id: string): Promise<WriterSessionEnvelope<WriterSessionDocument>> {
  return loadWriterAutosavedSessionFromSidecar("", id);
}

export async function exportWriterSessionState(): Promise<WriterSessionStateResult> {
  return exportWriterSessionStateFromSidecar();
}

export async function importWriterSessionState(file: File): Promise<WriterSessionEnvelope<WriterSessionDocument>> {
  return importWriterSessionStateToSidecar("", file);
}

export async function setWriterSuggestionStatus(id: string, status: SuggestionStatus, context: SuggestionStatusContext = {}): Promise<WriterSessionEnvelope<WriterSessionSummary>> {
  return setWriterSuggestionStatusInSidecar("", id, status, context);
}

export async function setWriterSessionChatMessages(chatMessages: WriterChatMessage[], context: SessionWriteContext = {}): Promise<WriterSessionEnvelope<WriterSessionSummary>> {
  return setWriterSessionChatMessagesFromSidecar("", chatMessages, context);
}

export async function appendWriterChatMessages(chatMessages: WriterChatMessage[], context: SessionWriteContext = {}): Promise<WriterSessionEnvelope<WriterSessionSummary> & { appended: number }> {
  return appendWriterChatMessagesToSidecar("", chatMessages, context);
}

/** The visitor's own machine: cloud pages probe this for a personal AI runner. */
export const LOCAL_AI_BASE = "http://127.0.0.1:8787";

export async function getLocalAiHealth(): Promise<HealthResponse> {
  return getHealthFromSidecar(LOCAL_AI_BASE);
}

export async function requestLocalAiSuggestion(request: AiRequest, options: { signal?: AbortSignal } = {}): Promise<AiResponse> {
  return requestAiSuggestionFromSidecar(LOCAL_AI_BASE, request, options);
}

/** Upload a chat attachment to the Writer sidecar that will run the CLI. */
export async function uploadAiAttachment(file: File, target: "sidecar" | "local" = "sidecar"): Promise<AiAttachment> {
  return uploadAiAttachmentToSidecar(target === "local" ? LOCAL_AI_BASE : "", file);
}

export async function getLocalAiProgress(): Promise<{ progress: AiProgressSnapshot | null }> {
  return getAiProgressFromSidecar(LOCAL_AI_BASE);
}

/**
 * Ensure the hop-managed agent terminal exists and get its web URL. The
 * terminal is inherently local (it runs the user's own claude/codex), so a
 * cloud page always asks the visitor's OWN machine.
 */
export async function ensureAgentTerminal(provider: "claude" | "codex", target: "sidecar" | "local" = "sidecar"): Promise<AgentTerminalStatus> {
  return ensureAgentTerminalOnSidecar(target === "local" ? LOCAL_AI_BASE : "", provider);
}

/** Bridge a shared doc's room through the cloud relay (local server does the work). */
export async function ensureCollabBridge(docId: string): Promise<{ bridged: boolean; connected: boolean; cloud: string }> {
  return ensureCollabBridgeOnSidecar("", docId);
}

/** Convert a DOCX on the visitor's own Writer (cloud pages have no DOCX pipeline). */
export async function importDocxLocally(file: File): Promise<ImportedDocument> {
  return importDocxToSidecar(LOCAL_AI_BASE, file);
}

/** Rebuild a DOCX on the visitor's own Writer (cloud pages cannot convert). */
export async function exportDocxLocally(request: ExportRequest): Promise<ExportDocxResult> {
  return exportDocxFromSidecar(LOCAL_AI_BASE, request);
}

export async function recordWriterSuggestions(suggestions: AiSuggestion[], context: SessionWriteContext = {}): Promise<WriterSessionEnvelope<WriterSessionSummary> & { recorded: number }> {
  return recordWriterSuggestionsInSidecar("", suggestions, context);
}

export async function setWriterRoutineProgress(routineProgress: string[], context: SessionWriteContext = {}): Promise<WriterSessionEnvelope<WriterSessionSummary>> {
  return setWriterRoutineProgressInSidecar("", routineProgress, context);
}

export async function setWriterRoutineRun(run: WriterRoutineRunRequest, context: SessionWriteContext = {}): Promise<WriterSessionEnvelope<WriterSessionSummary>> {
  return setWriterRoutineRunInSidecar("", run, context);
}

export async function exportWriterSessionReview(request: WriterSessionReviewExportRequest): Promise<WriterSessionReviewExportResult> {
  return exportWriterSessionReviewFromSidecar("", request);
}

export async function downloadWriterRoutineArtifact(id: string): Promise<WriterRoutineArtifactResult> {
  return downloadWriterRoutineArtifactFromSidecar("", id);
}

export async function syncWriterRoutineSuggestions(id: string): Promise<WriterRoutineSuggestionsResult> {
  return syncWriterRoutineSuggestionsFromSidecar("", id);
}

/** Deliver a message into the running turn of request `runId` on the sidecar running it (mid-turn steering). */
export function steerAiRun(runId: string, text: string, target: "sidecar" | "local" = "sidecar") {
  return steerAiRunOnSidecar(target === "local" ? LOCAL_AI_BASE : "", runId, text);
}
