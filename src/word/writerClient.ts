/**
 * Sidecar API surface used by the Word task pane. The pane is served BY the
 * sidecar (https://localhost:<tls port>/word/taskpane.html), so every call is
 * same-origin: no CORS, no share token, and the /events websocket works.
 */

import type {
  AiAttachment,
  AiCatalogResponse,
  AiSuggestion,
  SuggestionStatus,
  WriterChatMessage,
  WordHostContextUpdate,
  WordHostContextUpdateResponse,
  WordLiveSuggestionRequest,
  WordLiveSuggestionResponse, AiDocumentImage } from "../shared";
import {
  fetchWordLiveSuggestionsFromSidecar,
  getHealthFromSidecar,
  readError,
  readJson,
  setWriterSuggestionStatusInSidecar,
  uploadAiAttachmentToSidecar,
  type AiProgressSnapshot,
  type HealthResponse
} from "../sidecarClient";

const API_BASE = "";

export async function fetchHealth(): Promise<HealthResponse> {
  return getHealthFromSidecar(API_BASE);
}

export async function requestWordSuggestions(request: WordLiveSuggestionRequest, options: { signal?: AbortSignal } = {}): Promise<WordLiveSuggestionResponse> {
  const response = await fetchWordLiveSuggestionsFromSidecar(API_BASE, request, options);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return readJson<WordLiveSuggestionResponse>(response);
}

export async function pushWordContext(update: WordHostContextUpdate): Promise<WordHostContextUpdateResponse> {
  const response = await fetch(`${API_BASE}/api/word/context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update)
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return readJson<WordHostContextUpdateResponse>(response);
}

/** Upload a reference file (PDF, DOCX, text…); the sidecar extracts its text for the AI. */
export async function uploadAttachment(file: File): Promise<AiAttachment> {
  return uploadAiAttachmentToSidecar(API_BASE, file);
}

/** Push one of the document's pictures to the sidecar so the AI can look at it; returns its stored form. */
export async function uploadDocumentImage(
  blob: Blob,
  meta: { index: number; width?: number | null; height?: number | null; altText?: string | null; context?: string | null; paragraphIndex?: number | null; label?: string }
): Promise<AiDocumentImage> {
  const data = new FormData();
  data.append("file", blob, meta.label ?? `image-${meta.index + 1}`);
  data.append("index", String(meta.index));
  for (const key of ["width", "height", "altText", "context", "paragraphIndex"] as const) {
    const value = meta[key];
    if (value !== undefined && value !== null && value !== "") {
      data.append(key, String(value));
    }
  }
  const response = await fetch(`${API_BASE}/api/ai/images`, { method: "POST", body: data });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await readJson<{ image: AiDocumentImage }>(response)).image;
}

/** Fetch a sidecar-served image as raw base64 (what Office.js wants for insertion). */
export async function fetchImageAsBase64(url: string): Promise<string> {
  const response = await fetch(/^https?:/i.test(url) ? url : `${API_BASE}${url}`);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image."));
    reader.readAsDataURL(blob);
  });
}

/** Models and reasoning levels each installed CLI offers right now (discovered, cached per CLI build). */
export async function fetchModelCatalog(refresh = false): Promise<AiCatalogResponse> {
  const response = await fetch(`${API_BASE}/api/ai/models${refresh ? "?refresh=1" : ""}`);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return readJson<AiCatalogResponse>(response);
}

/** Mirror pane conversation turns into the shared session's chat history (best effort). */
export async function appendSessionChat(messages: WriterChatMessage[], expectedSessionId: string | null): Promise<void> {
  const response = await fetch(`${API_BASE}/api/session/chat-append`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatMessages: messages, ...(expectedSessionId ? { expectedSessionId } : {}) })
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

export interface SessionSuggestionsPayload {
  sessionId: string | null;
  revision: number | null;
  suggestions: AiSuggestion[];
}

export async function fetchSessionSuggestions(): Promise<SessionSuggestionsPayload> {
  const response = await fetch(`${API_BASE}/api/session/suggestions`);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const payload = await readJson<Partial<SessionSuggestionsPayload>>(response);
  return {
    sessionId: typeof payload.sessionId === "string" ? payload.sessionId : null,
    revision: typeof payload.revision === "number" ? payload.revision : null,
    suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : []
  };
}

export async function updateSuggestionStatus(id: string, status: SuggestionStatus, context: { decidedBy?: string; decisionNote?: string } = {}): Promise<void> {
  await setWriterSuggestionStatusInSidecar(API_BASE, id, status, context);
}

export interface WriterEventHandlers {
  onSessionUpdated?: (revision: number | null) => void;
  onAiProgress?: (progress: AiProgressSnapshot | null, queue: unknown[]) => void;
  onConnection?: (connected: boolean) => void;
}

/** Live notifications from the sidecar (review-queue changes, AI progress). Returns an unsubscribe. */
export function subscribeWriterEvents(handlers: WriterEventHandlers): () => void {
  if (typeof WebSocket === "undefined" || typeof location === "undefined") {
    return () => undefined;
  }
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/events`;
  let socket: WebSocket | null = null;
  let closed = false;
  let retryMs = 1_000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) {
      return;
    }
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleRetry();
      return;
    }
    socket.onopen = () => {
      retryMs = 1_000;
      handlers.onConnection?.(true);
    };
    socket.onmessage = (event) => {
      let message: { type?: string; revision?: number; progress?: AiProgressSnapshot | null; queue?: unknown[] } | null = null;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message || typeof message !== "object") {
        return;
      }
      if (message.type === "session-updated") {
        handlers.onSessionUpdated?.(typeof message.revision === "number" ? message.revision : null);
      } else if (message.type === "ai-progress") {
        handlers.onAiProgress?.(message.progress ?? null, Array.isArray(message.queue) ? message.queue : []);
      }
    };
    socket.onclose = () => {
      handlers.onConnection?.(false);
      scheduleRetry();
    };
    socket.onerror = () => {
      socket?.close();
    };
  };

  const scheduleRetry = () => {
    if (closed || retryTimer) {
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryMs = Math.min(retryMs * 2, 15_000);
      connect();
    }, retryMs);
  };

  connect();
  return () => {
    closed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
    }
    socket?.close();
  };
}
