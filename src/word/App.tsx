import { newAiRunId } from "../sidecarClient";
/**
 * Nebula Writer — Word task pane container.
 *
 * Owns every piece of state and every Office.js / sidecar interaction:
 *  - boots the Word host, reads the document snapshot, and tracks the
 *    author's focus (selection, caret paragraph, pages on screen) live;
 *  - shares that window state with the sidecar so terminal/MCP agents on the
 *    same document know where the author is;
 *  - runs a chat-style conversation: each of the author's turns records what
 *    was sent (scope, size, window state, engine), each assistant turn owns
 *    the suggestions it staged;
 *  - lands suggestions in Word as tracked changes or comments, and keeps the
 *    conversation in step with the shared Writer session.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AI_ATTACHMENT_LIMIT, type AiActivityEntry, type AiAttachment, type AiConversationDecision, type AiConversationTurn, type AiModelOptions, type AiProviderCatalog, type AiSuggestion, type LocalAiProviderName, type SuggestionStatus, type WordLiveSuggestionRequest, type WriterChatMessage, DEFAULT_AI_TOOL_ACCESS, isAiToolAccess, type AiToolAccess, AI_DOCUMENT_IMAGE_LIMIT, type AiDocumentImage, type AiRequestFocus } from "../shared";
import type { HealthResponse } from "../sidecarClient";
import { generalBuiltInRoutines, r01BuiltInRoutines } from "../writingRoutines";
import {
  buildHostContext,
  describeFocus,
  describePages,
  excerpt,
  nearestHeading,
  resolveScope,
  updateFocusTrail,
  wordCount,
  type FocusTrailEntry,
  type RequestScope,
  type WordDocumentSnapshot,
  type WordFocusState
} from "./wordContext";
import {
  applySuggestions,
  chooseMatchIndex,
  commentSuggestion,
  detectCapabilities,
  findSuggestionMatches,
  locateSuggestion,
  readDocumentSnapshot,
  readFocus,
  subscribeParagraphChanges,
  subscribeSelectionChanges,
  waitForWordHost,
  type WordCapabilities, commentInlinePicture, readInlinePictureBase64, replaceInlinePicture, selectInlinePicture } from "./hostBridge";
import {
  appendSessionChat,
  fetchHealth,
  fetchModelCatalog,
  fetchSessionSuggestions,
  pushWordContext,
  requestWordSuggestions,
  subscribeWriterEvents,
  updateSuggestionStatus,
  uploadAttachment, fetchImageAsBase64, uploadDocumentImage, steerRun } from "./writerClient";
import {
  WordPane,
  type CardState,
  type CapabilityRow,
  type ChatTurn,
  type HostStatus,
  type Notice,
  type PresetOption,
  type RequestState,
  type ScopeOption,
  type SentSummary,
  type SidecarStatus
} from "./WordPane";
import type { MockWordHost } from "./mockOffice";

interface ModelPreference {
  model: string | null;
  reasoning: string | null;
}

interface PaneSettings {
  requesterName: string;
  trackChanges: "always" | "word";
  /** Hosts without tracked changes: colour the text Writer changed so it stands out. */
  highlightChanges: boolean;
  shareWithAgents: boolean;
  mirrorChat: boolean;
  toolAccess: AiToolAccess;
  provider: LocalAiProviderName;
  scope: RequestScope;
  models: Partial<Record<LocalAiProviderName, ModelPreference>>;
}

interface WordPreset extends PresetOption {
  scope?: RequestScope;
}

const SETTINGS_KEY = "nebula-writer:word-pane:settings";
const DEFAULT_SETTINGS: PaneSettings = {
  requesterName: "",
  trackChanges: "always",
  highlightChanges: true,
  shareWithAgents: true,
  mirrorChat: true,
  toolAccess: DEFAULT_AI_TOOL_ACCESS,
  provider: "claude",
  scope: "auto",
  models: {}
};

const FOCUS_DEBOUNCE_MS = 160;
const VIEWPORT_POLL_MS = 2_500;
const SNAPSHOT_DEBOUNCE_MS = 1_200;
const SNAPSHOT_POLL_MS = 20_000;
const SNAPSHOT_STALE_THROTTLE_MS = 1_500;
const CONTEXT_PUSH_DEBOUNCE_MS = 700;
const HEALTH_POLL_MS = 30_000;
const MAX_TURNS = 200;

const DEFAULT_CARD_STATE: CardState = { matchIndex: 0, matches: null, heading: null, paragraphIndex: null, outcome: null, detail: null, error: null };

const WORD_PRESETS: WordPreset[] = [
  { group: "Word", id: "word-paragraph", label: "Tighten this paragraph", scope: "paragraph", instruction: "Tighten the paragraph at my caret: remove hedging and filler, keep every claim, citation, and number exactly, and make each sentence carry one idea." },
  { group: "Word", id: "word-selection", label: "Polish the selection", scope: "selection", instruction: "Improve the selected text for clarity, flow, and reviewer impact without changing its meaning. Return concise anchored edits." },
  { group: "Word", id: "word-viewport", label: "Review the visible pages", scope: "viewport", instruction: "Review the pages on my screen as a critical reviewer. Propose the highest-impact edits for clarity, logic, and precision; flag any claim that needs support as an advisory note." },
  { group: "Word", id: "word-here", label: "What's weak right here?", scope: "paragraph", instruction: "Look at the passage where my caret is and the sentences around it. Point out the single weakest sentence and propose a stronger version; leave everything else alone." }
];

function loadSettings(): PaneSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<PaneSettings>;
    const models: PaneSettings["models"] = {};
    for (const provider of ["claude", "codex"] as const) {
      const entry = parsed.models?.[provider];
      if (entry && typeof entry === "object") {
        models[provider] = {
          model: typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : null,
          reasoning: typeof entry.reasoning === "string" && entry.reasoning.trim() ? entry.reasoning.trim() : null
        };
      }
    }
    return {
      requesterName: typeof parsed.requesterName === "string" ? parsed.requesterName : DEFAULT_SETTINGS.requesterName,
      trackChanges: parsed.trackChanges === "word" ? "word" : "always",
      highlightChanges: typeof parsed.highlightChanges === "boolean" ? parsed.highlightChanges : DEFAULT_SETTINGS.highlightChanges,
      shareWithAgents: typeof parsed.shareWithAgents === "boolean" ? parsed.shareWithAgents : DEFAULT_SETTINGS.shareWithAgents,
      mirrorChat: typeof parsed.mirrorChat === "boolean" ? parsed.mirrorChat : DEFAULT_SETTINGS.mirrorChat,
      toolAccess: isAiToolAccess(parsed.toolAccess) ? parsed.toolAccess : DEFAULT_SETTINGS.toolAccess,
      provider: parsed.provider === "codex" ? "codex" : "claude",
      scope: isScope(parsed.scope) ? parsed.scope : "auto",
      models
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: PaneSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or a locked-down webview: settings just don't persist.
  }
}

function isScope(value: unknown): value is RequestScope {
  return value === "auto" || value === "selection" || value === "paragraph" || value === "viewport" || value === "document";
}

function mockHost(): MockWordHost | null {
  const mock = (globalThis as { __nebulaMockWord?: MockWordHost }).__nebulaMockWord;
  return mock ?? null;
}

let turnCounter = 0;
function turnId(): string {
  turnCounter += 1;
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `turn-${Date.now().toString(36)}-${turnCounter}-${random}`;
}

export function App() {
  const [hostStatus, setHostStatus] = useState<HostStatus>("booting");
  const [hostDetail, setHostDetail] = useState("Connecting to the document…");
  const [capabilities, setCapabilities] = useState<WordCapabilities>(() => detectCapabilities(false));
  const [snapshot, setSnapshot] = useState<WordDocumentSnapshot | null>(null);
  const [focus, setFocus] = useState<WordFocusState | null>(null);
  const [trail, setTrail] = useState<FocusTrailEntry[]>([]);
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus>("checking");
  const [sidecarDetail, setSidecarDetail] = useState("Checking the Writer sidecar…");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [catalogs, setCatalogs] = useState<AiProviderCatalog[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [settings, setSettings] = useState<PaneSettings>(loadSettings);
  const [instruction, setInstruction] = useState("");
  const [requestState, setRequestState] = useState<RequestState>("idle");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [suggestions, setSuggestions] = useState<AiSuggestion[]>([]);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sharedWithAgents, setSharedWithAgents] = useState(false);
  const [attachments, setAttachments] = useState<AiAttachment[]>([]);
  const [uploading, setUploading] = useState(0);

  const capabilitiesRef = useRef(capabilities);
  const snapshotRef = useRef<WordDocumentSnapshot | null>(null);
  const focusRef = useRef<WordFocusState | null>(null);
  const trailRef = useRef<FocusTrailEntry[]>([]);
  const settingsRef = useRef(settings);
  const suggestionsRef = useRef<AiSuggestion[]>([]);
  const attachmentsRef = useRef<AiAttachment[]>([]);
  const cardsRef = useRef<Record<string, CardState>>({});
  const catalogsRef = useRef<AiProviderCatalog[] | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastPushedTextRef = useRef<string | null>(null);
  const focusInFlightRef = useRef(false);
  const snapshotInFlightRef = useRef<Promise<WordDocumentSnapshot | null> | null>(null);
  const lastStaleRefreshRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const imageUploadsRef = useRef(new Map<string, AiDocumentImage>());
  // One request runs at a time (the CLIs take a single prompt per turn), but
  // typing never stops: a message sent meanwhile waits here and goes out the
  // moment the current turn ends — in the same thread.
  const runningRef = useRef(false);
  /** Run id of the request in flight (mid-turn steering addresses it). */
  const runIdRef = useRef<string | null>(null);
  const askRef = useRef<((overrides?: { instruction?: string; focus?: AiRequestFocus | null }) => Promise<void>) | null>(null);
  const [queued, setQueued] = useState<{ text: string; focus: AiRequestFocus | null } | null>(null);
  const queuedRef = useRef<{ text: string; focus: AiRequestFocus | null } | null>(null);

  const runningTurnRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  // Provider conversation ids, keyed by provider + document, so follow-ups
  // resume the CLI's own session ("make it shorter" keeps its referent).
  const agentSessionsRef = useRef<Record<string, string>>({});
  const turnsRef = useRef<ChatTurn[]>([]);

  capabilitiesRef.current = capabilities;
  settingsRef.current = settings;
  turnsRef.current = turns;
  suggestionsRef.current = suggestions;
  attachmentsRef.current = attachments;
  cardsRef.current = cards;
  catalogsRef.current = catalogs;

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const showNotice = useCallback((tone: Notice["tone"], text: string) => {
    setNotice({ tone, text });
  }, []);

  const appendTurn = useCallback((turn: ChatTurn) => {
    setTurns((current) => [...current, turn].slice(-MAX_TURNS));
  }, []);

  const patchTurn = useCallback((id: string, patch: Partial<Extract<ChatTurn, { role: "assistant" }>>) => {
    setTurns((current) => current.map((turn) => (turn.id === id && turn.role === "assistant" ? { ...turn, ...patch } : turn)));
  }, []);

  /** Mirror turns into the shared session chat; returns false when there is no session yet. */
  const mirrorChat = useCallback((messages: WriterChatMessage[]): boolean => {
    if (!settingsRef.current.mirrorChat || !sessionIdRef.current) {
      return false;
    }
    void appendSessionChat(messages, sessionIdRef.current).catch(() => undefined);
    return true;
  }, []);

  /* ------------------------------------------------------------------ */
  /* Word reads                                                         */
  /* ------------------------------------------------------------------ */

  const refreshFocus = useCallback(async (snap: WordDocumentSnapshot | null = snapshotRef.current): Promise<WordFocusState | null> => {
    if (!snap || focusInFlightRef.current || !capabilitiesRef.current.host) {
      return focusRef.current;
    }
    focusInFlightRef.current = true;
    try {
      const next = await readFocus(snap, capabilitiesRef.current, focusRef.current);
      focusRef.current = next;
      setFocus(next);
      const nextTrail = updateFocusTrail(trailRef.current, next, snap);
      if (nextTrail !== trailRef.current) {
        trailRef.current = nextTrail;
        setTrail(nextTrail);
      }
      return next;
    } catch (error) {
      setHostDetail(errorMessage(error));
      return focusRef.current;
    } finally {
      focusInFlightRef.current = false;
    }
  }, []);

  const refreshSnapshot = useCallback(async (): Promise<WordDocumentSnapshot | null> => {
    if (!capabilitiesRef.current.host) {
      return null;
    }
    if (snapshotInFlightRef.current) {
      return snapshotInFlightRef.current;
    }
    const task = (async () => {
      try {
        const next = await readDocumentSnapshot(capabilitiesRef.current);
        snapshotRef.current = next;
        setSnapshot(next);
        await refreshFocus(next);
        return next;
      } catch (error) {
        setHostDetail(errorMessage(error));
        showNotice("error", `Could not read the document from Word: ${errorMessage(error)}`);
        return snapshotRef.current;
      } finally {
        snapshotInFlightRef.current = null;
      }
    })();
    snapshotInFlightRef.current = task;
    return task;
  }, [refreshFocus, showNotice]);

  useEffect(() => {
    if (!focus?.stale) {
      return;
    }
    const now = Date.now();
    if (now - lastStaleRefreshRef.current < SNAPSHOT_STALE_THROTTLE_MS) {
      return;
    }
    lastStaleRefreshRef.current = now;
    void refreshSnapshot();
  }, [focus, refreshSnapshot]);

  /* ------------------------------------------------------------------ */
  /* Boot                                                               */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    let cancelled = false;
    let unsubscribeSelection: (() => void) | null = null;
    let unsubscribeParagraphs: (() => Promise<void>) | null = null;
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
    let viewportInterval: ReturnType<typeof setInterval> | null = null;
    let snapshotInterval: ReturnType<typeof setInterval> | null = null;

    const scheduleFocus = () => {
      if (focusTimer) {
        clearTimeout(focusTimer);
      }
      focusTimer = setTimeout(() => {
        focusTimer = null;
        if (!cancelled) {
          void refreshFocus();
        }
      }, FOCUS_DEBOUNCE_MS);
    };
    const scheduleSnapshot = () => {
      if (snapshotTimer) {
        clearTimeout(snapshotTimer);
      }
      snapshotTimer = setTimeout(() => {
        snapshotTimer = null;
        if (!cancelled && !busyRef.current) {
          void refreshSnapshot();
        }
      }, SNAPSHOT_DEBOUNCE_MS);
    };

    (async () => {
      const boot = await waitForWordHost();
      if (cancelled) {
        return;
      }
      capabilitiesRef.current = boot.capabilities;
      setCapabilities(boot.capabilities);
      setHostDetail(boot.detail);
      if (!boot.ready) {
        setHostStatus("unavailable");
        return;
      }
      setHostStatus("ready");
      await refreshSnapshot();
      if (cancelled) {
        return;
      }
      unsubscribeSelection = subscribeSelectionChanges(scheduleFocus);
      unsubscribeParagraphs = await subscribeParagraphChanges(scheduleSnapshot, boot.capabilities);
      if (cancelled) {
        void unsubscribeParagraphs?.();
        return;
      }
      viewportInterval = setInterval(() => {
        if (typeof document === "undefined" || document.visibilityState === "visible") {
          void refreshFocus();
        }
      }, VIEWPORT_POLL_MS);
      if (!unsubscribeParagraphs) {
        snapshotInterval = setInterval(() => {
          if (!busyRef.current && (typeof document === "undefined" || document.visibilityState === "visible")) {
            void refreshSnapshot();
          }
        }, SNAPSHOT_POLL_MS);
      }
    })().catch((error) => {
      if (!cancelled) {
        setHostStatus("unavailable");
        setHostDetail(errorMessage(error));
      }
    });

    return () => {
      cancelled = true;
      unsubscribeSelection?.();
      void unsubscribeParagraphs?.();
      if (focusTimer) {
        clearTimeout(focusTimer);
      }
      if (snapshotTimer) {
        clearTimeout(snapshotTimer);
      }
      if (viewportInterval) {
        clearInterval(viewportInterval);
      }
      if (snapshotInterval) {
        clearInterval(snapshotInterval);
      }
    };
  }, [refreshFocus, refreshSnapshot]);

  /* ------------------------------------------------------------------ */
  /* Sidecar health, model catalog, live events                         */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const next = await fetchHealth();
        if (cancelled) {
          return;
        }
        setHealth(next);
        setSidecarStatus("ok");
        const available = (next.providerStatus ?? []).filter((provider) => provider.available).map((provider) => provider.name);
        setSidecarDetail(available.length ? `Writer sidecar ready · ${available.join(", ")}` : "Writer sidecar ready · no AI CLI found on PATH");
      } catch (error) {
        if (!cancelled) {
          setHealth(null);
          setSidecarStatus("offline");
          setSidecarDetail(errorMessage(error));
        }
      }
    };
    void check();
    const interval = setInterval(() => void check(), HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const loadCatalog = useCallback(async (refresh: boolean) => {
    setCatalogLoading(true);
    try {
      const response = await fetchModelCatalog(refresh);
      setCatalogs(response.providers);
      if (refresh) {
        const summary = response.providers
          .filter((provider) => provider.available)
          .map((provider) => `${provider.provider === "codex" ? "Codex" : "Claude Code"} ${provider.version ?? ""}: ${provider.models.length} models`)
          .join(" · ");
        showNotice("info", summary ? `Model list refreshed — ${summary}.` : "No AI CLI found to list models from.");
      }
    } catch (error) {
      if (refresh) {
        showNotice("error", `Could not load the model list: ${errorMessage(error)}`);
      }
    } finally {
      setCatalogLoading(false);
    }
  }, [showNotice]);

  useEffect(() => {
    if (sidecarStatus === "ok" && catalogs === null && !catalogLoading) {
      void loadCatalog(false);
    }
  }, [catalogLoading, catalogs, loadCatalog, sidecarStatus]);

  // A CLI upgrade shows up as a new version in health; re-discover the catalog.
  const providerVersions = (health?.providerStatus ?? []).map((provider) => `${provider.name}@${provider.version ?? ""}`).join(",");
  const providerVersionsRef = useRef(providerVersions);
  useEffect(() => {
    if (providerVersions && providerVersionsRef.current && providerVersions !== providerVersionsRef.current && catalogs !== null) {
      void loadCatalog(true);
    }
    providerVersionsRef.current = providerVersions;
  }, [catalogs, loadCatalog, providerVersions]);

  const syncSessionSuggestions = useCallback(async (reason: "restore" | "update") => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      return;
    }
    let payload: Awaited<ReturnType<typeof fetchSessionSuggestions>>;
    try {
      payload = await fetchSessionSuggestions();
    } catch {
      return;
    }
    if (payload.sessionId !== sessionId) {
      return;
    }
    const local = suggestionsRef.current;
    const localIds = new Set(local.map((suggestion) => suggestion.id));
    const incoming = payload.suggestions.filter((suggestion) => suggestion.status === "pending" && !localIds.has(suggestion.id));
    const decidedElsewhere = payload.suggestions.filter((suggestion) => suggestion.status !== "pending" && localIds.has(suggestion.id) && !cardsRef.current[suggestion.id]?.outcome);
    if (incoming.length) {
      setSuggestions((current) => [...current, ...incoming]);
      setActiveId((current) => current ?? incoming[0].id);
      appendTurn({
        id: turnId(),
        role: "assistant",
        at: new Date().toISOString(),
        text: reason === "restore"
          ? `Restored ${incoming.length} pending suggestion${incoming.length === 1 ? "" : "s"} from the Writer session.`
          : `${describeProposers(incoming)} staged ${incoming.length} suggestion${incoming.length === 1 ? "" : "s"} in the Writer session.`,
        status: "done",
        engine: describeProposers(incoming),
        suggestionIds: incoming.map((suggestion) => suggestion.id),
        progress: null,
        origin: "session",
        activity: []
      });
    }
    if (decidedElsewhere.length) {
      setCards((current) => {
        const next = { ...current };
        for (const suggestion of decidedElsewhere) {
          next[suggestion.id] = {
            ...(current[suggestion.id] ?? DEFAULT_CARD_STATE),
            outcome: "decided-elsewhere",
            detail: `${suggestion.status}${suggestion.decidedBy ? ` by ${suggestion.decidedBy}` : ""}`
          };
        }
        return next;
      });
    }
  }, [appendTurn]);

  useEffect(() => {
    return subscribeWriterEvents({
      onSessionUpdated: () => void syncSessionSuggestions("update"),
      onAiProgress: (progress) => {
        const runningId = runningTurnRef.current;
        if (!runningId) {
          return;
        }
        const text = progress ? describeProgress(progress.stage, progress.passIndex, progress.passTotal) : null;
        setTurns((current) => current.map((turn) => {
          if (turn.id !== runningId || turn.role !== "assistant") {
            return turn;
          }
          const last = turn.activity[turn.activity.length - 1];
          const isTool = Boolean(progress?.tool) || /^Staging|^Reading|^Searching|^Looking/i.test(text ?? "");
          const activity = text && (isTool || !last || last.summary !== text)
            ? [...turn.activity, { at: new Date().toISOString(), kind: isTool ? "tool" as const : "status" as const, summary: text }]
            : turn.activity;
          return { ...turn, progress: text, activity };
        }));
      }
    });
  }, [patchTurn, syncSessionSuggestions]);

  /* ------------------------------------------------------------------ */
  /* Share window state with the sidecar                                */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    if (hostStatus !== "ready" || !snapshot || sidecarStatus !== "ok") {
      return;
    }
    if (!settings.shareWithAgents) {
      setSharedWithAgents(false);
      return;
    }
    const timer = setTimeout(() => {
      const hostContext = buildHostContext(snapshot, focus, trailRef.current, capabilities.hostName === "Google Docs" ? "google-docs" : "word-addin");
      const textChanged = lastPushedTextRef.current !== snapshot.bodyText;
      pushWordContext({
        documentName: snapshot.documentName,
        hostContext,
        documentText: textChanged ? snapshot.bodyText : null,
        documentEmphasis: textChanged ? snapshot.emphasis ?? [] : null,
        adopt: true
      }).then((response) => {
        if (textChanged) {
          lastPushedTextRef.current = snapshot.bodyText;
        }
        setSharedWithAgents(response.adopted);
        if (response.adopted && response.sessionId) {
          const first = sessionIdRef.current === null;
          sessionIdRef.current = response.sessionId;
          if (first && response.pendingSuggestions > 0) {
            void syncSessionSuggestions("restore");
          }
        }
      }).catch(() => {
        setSharedWithAgents(false);
      });
    }, CONTEXT_PUSH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [focus, hostStatus, settings.shareWithAgents, sidecarStatus, snapshot, syncSessionSuggestions]);

  /* ------------------------------------------------------------------ */
  /* Ask Writer                                                         */
  /* ------------------------------------------------------------------ */

  const scopeResolution = useMemo(() => (snapshot ? resolveScope(settings.scope, snapshot, focus) : null), [focus, settings.scope, snapshot]);
  const activeCatalog = useMemo(() => catalogs?.find((catalog) => catalog.provider === settings.provider) ?? null, [catalogs, settings.provider]);
  const modelPreference: ModelPreference = settings.models[settings.provider] ?? { model: null, reasoning: null };

  const currentModelOptions = useCallback((): AiModelOptions | null => {
    const preference = settingsRef.current.models[settingsRef.current.provider];
    if (!preference || (!preference.model && !preference.reasoning)) {
      return null;
    }
    return { model: preference.model, reasoning: preference.reasoning };
  }, []);

  const engineLabel = useCallback((provider: LocalAiProviderName, modelOptions: AiModelOptions | null): string => {
    const catalog = catalogsRef.current?.find((entry) => entry.provider === provider) ?? null;
    const modelText = modelOptions?.model
      ? catalog?.models.find((model) => model.id === modelOptions.model)?.label ?? modelOptions.model
      : catalog?.defaults.model
        ? `${catalog.models.find((model) => model.id === catalog.defaults.model)?.label ?? catalog.defaults.model} (default)`
        : "default model";
    const levelLabel = (id: string) => catalog?.reasoning?.levels.find((level) => level.id === id)?.label ?? id;
    const reasoningText = modelOptions?.reasoning
      ? levelLabel(modelOptions.reasoning)
      : catalog?.defaults.reasoning
        ? `${levelLabel(catalog.defaults.reasoning)} (default)`
        : null;
    return [providerLabel(provider), modelText, reasoningText].filter(Boolean).join(" · ");
  }, []);

  const ask = useCallback(async (overrides: { instruction?: string; focus?: AiRequestFocus | null } = {}) => {
    const typed = (overrides.instruction ?? instruction).trim();
    if (!typed || hostStatus !== "ready") {
      return;
    }
    const activeFocus = overrides.focus ?? null;
    if (runningRef.current) {
      // Like the Codex and Claude CLIs: a message sent while the AI works goes
      // into the running turn; if that turn cannot take it, it is queued.
      if (overrides.instruction === undefined) {
        setInstruction("");
      }
      void steerOrQueue(typed, activeFocus);
      return;
    }
    runningRef.current = true;
    const runId = newAiRunId();
    runIdRef.current = runId;
    setNotice(null);
    setRequestState("running");
    const controller = new AbortController();
    abortRef.current = controller;
    const provider = settingsRef.current.provider;
    const modelOptions = currentModelOptions();
    const engine = engineLabel(provider, modelOptions);
    const askedText = typed;
    const assistantTurnId = turnId();
    runningTurnRef.current = assistantTurnId;
    setInstruction("");
    try {
      const snap = (await refreshSnapshot()) ?? snapshotRef.current;
      if (!snap || !snap.bodyText.trim()) {
        throw new Error("The Word document is empty — type something first.");
      }
      const currentFocus = focusRef.current;
      const resolved = resolveScope(settingsRef.current.scope, snap, currentFocus);
      const hostContext = buildHostContext(snap, currentFocus, trailRef.current);
      const documentImages = await syncDocumentImages(snap);
      const sessionKey = `${provider}:${snap.documentName ?? "untitled"}`;
      const agentSessionId = agentSessionsRef.current[sessionKey] ?? null;
      const conversation = buildConversationDigest(turnsRef.current, suggestionsRef.current, cardsRef.current);
      const request: WordLiveSuggestionRequest = {
        provider,
        runId,
        instruction: askedText,
        mode: resolved.mode,
        documentText: snap.bodyText,
        documentEmphasis: snap.emphasis ?? [],
        selection: resolved.selection ?? currentFocus?.selection ?? null,
        documentName: snap.documentName,
        requestedBy: settingsRef.current.requesterName.trim() || (capabilities.hostName ?? "Word"),
        toolAccess: settingsRef.current.toolAccess,
        ...(documentImages.length ? { documentImages } : {}),
        hostContext,
        ...(modelOptions ? { modelOptions } : {}),
        ...(attachmentsRef.current.length ? { attachments: attachmentsRef.current } : {}),
        ...(agentSessionId ? { agentSessionId } : {}),
        ...(conversation.length ? { conversation } : {}),
        ...(activeFocus ? { focus: activeFocus } : {})
      };
      const sent = summarizeSent(request, resolved.label, snap, currentFocus, hostContext.recentFocus.length, hostContext.outline.length, engine);
      const userTurn: ChatTurn = { id: turnId(), role: "user", at: new Date().toISOString(), text: askedText, sent, focus: activeFocus ? { ref: activeFocus.ref ?? null, title: activeFocus.title } : null };
      appendTurn(userTurn);
      appendTurn({ id: assistantTurnId, role: "assistant", at: new Date().toISOString(), text: "", status: "running", engine, suggestionIds: [], progress: `Asking ${engine} · ${resolved.label}`, origin: "pane", activity: [] });
      const userMessage: WriterChatMessage = { id: userTurn.id, role: "user", content: `${activeFocus ? `[About ${activeFocus.ref ? `${activeFocus.ref} ` : ""}"${activeFocus.title}"] ` : ""}${askedText}\n\n[Word pane sent ${sent.scopeLabel} · ${sent.engine}]`, author: request.requestedBy ?? "Word", createdAt: userTurn.at };
      const userMirrored = mirrorChat([userMessage]);

      const response = await requestWordSuggestions(request, { signal: controller.signal });
      if (response.ai.undeliveredSteers?.length) {
        // Sent during the run but no session could take them: they become the next turn.
        queueMessage(response.ai.undeliveredSteers.join("\n\n"), null);
      }
      if (controller.signal.aborted) {
        return;
      }
      sessionIdRef.current = response.session?.id ?? sessionIdRef.current;
      if (response.ai.agentSessionId) {
        agentSessionsRef.current[sessionKey] = response.ai.agentSessionId;
      }
      lastPushedTextRef.current = snap.bodyText;
      setSharedWithAgents(true);
      const fresh = response.ai.suggestions.map((suggestion) => ({ ...suggestion, proposedBy: suggestion.proposedBy ?? providerLabel(provider) }));
      // A revision withdraws the card it replaces (the sidecar did the same in the session).
      for (const suggestion of fresh) {
        const earlier = suggestion.revises ? suggestionsRef.current.find((candidate) => candidate.id === suggestion.revises) : null;
        if (earlier && !cardsRef.current[earlier.id]?.outcome) {
          patchCard(earlier.id, { outcome: "revised", detail: `see ${suggestion.ref ?? "the new suggestion"}`, error: null });
        }
      }
      if (fresh.length) {
        setSuggestions((current) => {
          const ids = new Set(fresh.map((suggestion) => suggestion.id));
          return [...current.filter((suggestion) => !ids.has(suggestion.id)), ...fresh];
        });
        setActiveId(fresh[0].id);
      }
      const replyText = response.ai.message || (fresh.length ? `${fresh.length} suggestion${fresh.length === 1 ? "" : "s"} staged.` : "No anchored suggestions were returned.");
      const activity: AiActivityEntry[] | undefined = response.ai.activity?.length ? response.ai.activity : undefined;
      patchTurn(assistantTurnId, { text: replyText, status: "done", suggestionIds: fresh.map((suggestion) => suggestion.id), progress: null, engine: response.ai.modelOptions ? engineLabel(provider, response.ai.modelOptions) : engine, ...(activity ? { activity } : {}) });
      setRequestState(fresh.length ? "done" : "empty");
      const assistantMessage: WriterChatMessage = { id: assistantTurnId, role: "assistant", content: replyText, author: engine, createdAt: new Date().toISOString() };
      // The first request creates the session, so the author's turn may not have had one to land in yet.
      mirrorChat(userMirrored ? [assistantMessage] : [userMessage, assistantMessage]);
    } catch (error) {
      if (controller.signal.aborted) {
        patchTurn(assistantTurnId, { text: "Stopped.", status: "error", progress: null });
        setRequestState("idle");
      } else {
        patchTurn(assistantTurnId, { text: errorMessage(error), status: "error", progress: null });
        setRequestState("error");
      }
      if (!askedText) {
        return;
      }
    } finally {
      abortRef.current = null;
      runningTurnRef.current = null;
      runningRef.current = false;
      runIdRef.current = null;
      const next = queuedRef.current;
      if (next) {
        queuedRef.current = null;
        setQueued(null);
        void ask({ instruction: next.text, focus: next.focus });
      }
    }
  }, [appendTurn, currentModelOptions, engineLabel, hostStatus, instruction, mirrorChat, patchTurn, refreshSnapshot]);

  askRef.current = ask;

  /** Hold a message for the turn after this one. */
  const queueMessage = useCallback((text: string, focus: AiRequestFocus | null) => {
    queuedRef.current = { text, focus };
    setQueued(queuedRef.current);
  }, []);

  /** Deliver a message into the running turn; true when the AI took it. */
  const steerRunning = useCallback(async (text: string, focus: AiRequestFocus | null): Promise<boolean> => {
    const runId = runIdRef.current;
    if (!runId) {
      return false;
    }
    const body = focus ? `About ${focus.ref ? `${focus.ref} ` : ""}"${focus.title}": ${text}` : text;
    const result = await steerRun(runId, body);
    if (!result.ok || runIdRef.current !== runId) {
      return false;
    }
    appendTurn({ id: turnId(), role: "user", at: new Date().toISOString(), text, steered: true, focus: focus ? { ref: focus.ref ?? null, title: focus.title } : null });
    return true;
  }, [appendTurn]);

  const steerOrQueue = useCallback(async (text: string, focus: AiRequestFocus | null) => {
    if (await steerRunning(text, focus)) {
      return;
    }
    if (runningRef.current) {
      queueMessage(text, focus);
      setNotice({ tone: "info", text: "This turn can't take new input right now — your message is queued and goes out when it finishes." });
    } else {
      void askRef.current?.({ instruction: text, focus });
    }
  }, [queueMessage, steerRunning]);

  /** Typed while a request runs: hold it for the next turn instead of sending it into this one. */
  const queueTyped = useCallback(() => {
    const typed = instruction.trim();
    if (!typed) {
      return;
    }
    setInstruction("");
    if (runningRef.current) {
      queueMessage(typed, null);
    } else {
      void askRef.current?.({ instruction: typed });
    }
  }, [instruction, queueMessage]);

  /** The queued message, now: into the running turn when it can take it, else stop the turn and send it. */
  const sendQueuedNow = useCallback(async () => {
    const next = queuedRef.current;
    if (!next) {
      return;
    }
    if (runningRef.current) {
      if (await steerRunning(next.text, next.focus)) {
        if (queuedRef.current === next) {
          queuedRef.current = null;
          setQueued(null);
        }
        return;
      }
      abortRef.current?.abort();
      return;
    }
    queuedRef.current = null;
    setQueued(null);
    void ask({ instruction: next.text, focus: next.focus });
  }, [ask, steerRunning]);

  const cancelQueued = useCallback(() => {
    queuedRef.current = null;
    setQueued(null);
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /* ------------------------------------------------------------------ */
  /* Suggestion actions                                                 */
  /* ------------------------------------------------------------------ */

  const cardState = useCallback((suggestion: AiSuggestion): CardState => cards[suggestion.id] ?? DEFAULT_CARD_STATE, [cards]);
  const suggestionById = useCallback((id: string): AiSuggestion | null => suggestions.find((suggestion) => suggestion.id === id) ?? null, [suggestions]);

  const patchCard = useCallback((id: string, patch: Partial<CardState>) => {
    setCards((current) => ({ ...current, [id]: { ...(current[id] ?? DEFAULT_CARD_STATE), ...patch } }));
  }, []);

  const runBusy = useCallback(async (label: string, action: () => Promise<void>) => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusyLabel(label);
    try {
      await action();
    } finally {
      busyRef.current = false;
      setBusyLabel(null);
    }
  }, []);

  const preferredOffset = useCallback((suggestion: AiSuggestion, snap: WordDocumentSnapshot): number | null => {
    if (suggestion.range && Number.isFinite(suggestion.range.from)) {
      return suggestion.range.from;
    }
    const first = snap.bodyText.indexOf(suggestion.original);
    if (first >= 0 && snap.bodyText.indexOf(suggestion.original, first + 1) < 0) {
      return first;
    }
    if (suggestion.anchor && Number.isFinite(suggestion.anchor.offset)) {
      return suggestion.anchor.offset;
    }
    return focusRef.current?.cursorOffset ?? null;
  }, []);

  /**
   * The document's pictures, as files the sidecar can hand to the AI. Bytes
   * are read from Word and uploaded once per picture (keyed by index, size,
   * alt text, and caption) and reused across requests.
   */
  const syncDocumentImages = useCallback(async (snap: WordDocumentSnapshot): Promise<AiDocumentImage[]> => {
    const pictures = (snap.pictures ?? []).slice(0, AI_DOCUMENT_IMAGE_LIMIT);
    const images: AiDocumentImage[] = [];
    for (const picture of pictures) {
      const key = `${picture.index}|${picture.width ?? ""}x${picture.height ?? ""}|${picture.altText ?? ""}|${picture.paragraphText.slice(0, 80)}`;
      const cached = imageUploadsRef.current.get(key);
      if (cached) {
        images.push({ ...cached, index: picture.index });
        continue;
      }
      try {
        const { base64 } = await readInlinePictureBase64(picture.index);
        const blob = base64ToBlob(base64);
        if (!blob) {
          continue;
        }
        const uploaded = await uploadDocumentImage(blob, {
          index: picture.index,
          width: picture.width,
          height: picture.height,
          altText: picture.altText,
          context: picture.paragraphText || null,
          paragraphIndex: picture.paragraphIndex,
          label: `image-${picture.index + 1}`
        });
        imageUploadsRef.current.set(key, uploaded);
        images.push(uploaded);
      } catch {
        // A picture Word cannot export (or the sidecar rejects) is simply left out.
      }
    }
    return images;
  }, []);

  const ensureMatches = useCallback(async (suggestion: AiSuggestion, snap: WordDocumentSnapshot, force = false): Promise<CardState> => {
    const existing = cardsRef.current[suggestion.id] ?? DEFAULT_CARD_STATE;
    if (suggestion.kind === "image") {
      const next: CardState = { ...existing, matchIndex: 0, matches: 1, heading: null, paragraphIndex: null, error: null };
      patchCard(suggestion.id, next);
      return next;
    }
    if (existing.matches !== null && !force) {
      return existing;
    }
    const found = await findSuggestionMatches(snap, suggestion);
    const matchIndex = chooseMatchIndex(found.matches, preferredOffset(suggestion, snap), suggestion.anchor ?? null);
    const match = found.matches[matchIndex] ?? null;
    const heading = match && match.paragraphIndex !== null ? nearestHeading(snap.paragraphs, match.paragraphIndex) : null;
    const next: CardState = {
      ...existing,
      matchIndex,
      matches: found.matches.length,
      heading: heading ? excerpt(heading.text, 60) : null,
      paragraphIndex: match?.paragraphIndex ?? null,
      error: found.matches.length ? null : "The document no longer contains this text — the passage may have changed."
    };
    patchCard(suggestion.id, next);
    return next;
  }, [patchCard, preferredOffset]);

  const locate = useCallback((suggestion: AiSuggestion) => {
    setActiveId(suggestion.id);
    const snap = snapshotRef.current;
    if (!snap || hostStatus !== "ready") {
      return;
    }
    if (suggestion.kind === "image" && suggestion.image) {
      const image = suggestion.image;
      void runBusy("Locating in Word…", async () => {
        try {
          await selectInlinePicture(image.index);
          patchCard(suggestion.id, { error: null });
        } catch (error) {
          patchCard(suggestion.id, { error: errorMessage(error) });
        }
      });
      return;
    }
    if (cardsRef.current[suggestion.id]?.outcome === "applied" && !suggestion.commentOnly && suggestion.replacement.trim()) {
      // Once applied, the original is gone from Word: jump to the revised text.
      void runBusy("Locating in Word…", async () => {
        try {
          await locateSuggestion(snap, { original: suggestion.replacement }, 0);
          patchCard(suggestion.id, { error: null });
        } catch (error) {
          patchCard(suggestion.id, { error: errorMessage(error) });
        }
      });
      return;
    }
    void runBusy("Locating in Word…", async () => {
      try {
        const state = await ensureMatches(suggestion, snap);
        if (!state.matches) {
          return;
        }
        await locateSuggestion(snap, suggestion, state.matchIndex);
        patchCard(suggestion.id, { error: null });
      } catch (error) {
        patchCard(suggestion.id, { error: errorMessage(error) });
      }
    });
  }, [ensureMatches, hostStatus, patchCard, runBusy]);

  const cycleMatch = useCallback((suggestion: AiSuggestion, direction: -1 | 1) => {
    const snap = snapshotRef.current;
    const state = cardsRef.current[suggestion.id];
    if (!snap || !state || !state.matches || state.matches < 2) {
      return;
    }
    const matchIndex = (state.matchIndex + direction + state.matches) % state.matches;
    patchCard(suggestion.id, { matchIndex });
    void runBusy("Locating in Word…", async () => {
      try {
        await locateSuggestion(snap, suggestion, matchIndex);
      } catch (error) {
        patchCard(suggestion.id, { error: errorMessage(error) });
      }
    });
  }, [patchCard, runBusy]);

  const recordDecision = useCallback(async (suggestion: AiSuggestion, status: SuggestionStatus, note: string) => {
    try {
      await updateSuggestionStatus(suggestion.id, status, {
        decidedBy: settingsRef.current.requesterName.trim() || (capabilities.hostName ?? "Word"),
        decisionNote: note
      });
    } catch {
      // A scratch suggestion the sidecar no longer holds — the pane's own state is the record.
    }
  }, []);

  /**
   * Apply suggestions inside an already-running busy scope, all in one batch
   * (a few round trips into Word, whatever the count). Cards are updated per
   * outcome; decisions are recorded in parallel afterwards.
   */
  const applyMany = useCallback(async (group: AiSuggestion[], snap: WordDocumentSnapshot): Promise<{ applied: AiSuggestion[]; failed: Array<{ suggestion: AiSuggestion; error: string }> }> => {
    const imageGroup = group.filter((suggestion) => suggestion.kind === "image" && suggestion.image);
    const textGroup = group.filter((suggestion) => suggestion.kind !== "image");
    const items = textGroup.map((suggestion) => {
      const state = cardsRef.current[suggestion.id];
      return {
        id: suggestion.id,
        suggestion,
        matchIndex: state && state.matches !== null ? state.matchIndex : null,
        preferredOffset: preferredOffset(suggestion, snap)
      };
    });
    const outcomes = items.length ? await applySuggestions(snap, items, { trackChanges: settingsRef.current.trackChanges, highlightChanges: settingsRef.current.highlightChanges }) : [];
    const byId = new Map(group.map((suggestion) => [suggestion.id, suggestion]));
    const applied: Array<{ suggestion: AiSuggestion; trackedChange: boolean }> = [];
    const failed: Array<{ suggestion: AiSuggestion; error: string }> = [];
    // Picture replacements: one Word round trip each (bytes come from the sidecar).
    for (const suggestion of imageGroup) {
      const image = suggestion.image;
      if (!image) {
        continue;
      }
      try {
        const base64 = await fetchImageAsBase64(image.url);
        const result = await replaceInlinePicture(image.index, base64, { trackChanges: settingsRef.current.trackChanges });
        patchCard(suggestion.id, { outcome: "applied", detail: result.trackedChange ? "tracked change" : "direct edit (Track Changes was off)", error: null, matches: 1, matchIndex: 0 });
        applied.push({ suggestion, trackedChange: result.trackedChange });
      } catch (error) {
        patchCard(suggestion.id, { error: errorMessage(error) });
        failed.push({ suggestion, error: errorMessage(error) });
      }
    }
    for (const outcome of outcomes) {
      const suggestion = byId.get(outcome.id);
      if (!suggestion) {
        continue;
      }
      if (outcome.ok) {
        patchCard(suggestion.id, {
          outcome: "applied",
          detail: outcome.result.trackedChange ? "tracked change" : "direct edit (Track Changes was off)",
          error: null,
          matches: outcome.result.matches,
          matchIndex: outcome.result.matchIndex
        });
        applied.push({ suggestion, trackedChange: outcome.result.trackedChange });
      } else {
        patchCard(suggestion.id, { error: outcome.error });
        failed.push({ suggestion, error: outcome.error });
      }
    }
    if (applied.length) {
      lastPushedTextRef.current = null;
      const appliedIds = new Set(applied.map((entry) => entry.suggestion.id));
      for (const other of suggestionsRef.current) {
        if (!appliedIds.has(other.id) && !cardsRef.current[other.id]?.outcome) {
          patchCard(other.id, { matches: null });
        }
      }
      await Promise.all(applied.map((entry) => recordDecision(entry.suggestion, "accepted", entry.trackedChange ? "Applied in Word as a tracked change" : "Applied in Word")));
    }
    return { applied: applied.map((entry) => entry.suggestion), failed };
  }, [patchCard, preferredOffset, recordDecision]);

  const apply = useCallback((suggestion: AiSuggestion) => {
    const snap = snapshotRef.current;
    if (!snap || hostStatus !== "ready" || suggestion.commentOnly) {
      return;
    }
    setActiveId(suggestion.id);
    void runBusy("Applying in Word…", async () => {
      const { applied, failed } = await applyMany([suggestion], snap);
      if (applied.length) {
        const detail = cardsRef.current[suggestion.id]?.detail ?? "";
        showNotice("success", detail.startsWith("tracked") ? "Applied as a tracked change — review it in Word." : "Applied directly (Word's Track Changes is off).");
      } else {
        showNotice("error", failed[0]?.error ?? "Could not apply this suggestion.");
      }
      await refreshSnapshot();
    });
  }, [applyMany, hostStatus, refreshSnapshot, runBusy, showNotice]);

  /** Apply a whole section of the reply as one batch: one read of Word before, one after. */
  const applyGroup = useCallback((group: AiSuggestion[]) => {
    if (hostStatus !== "ready" || !group.length) {
      return;
    }
    const candidates = group.filter((suggestion) => !cardsRef.current[suggestion.id]?.outcome && !suggestion.commentOnly);
    if (!candidates.length) {
      return;
    }
    void runBusy(`Applying ${candidates.length} change${candidates.length === 1 ? "" : "s"} in Word…`, async () => {
      const snap = (await refreshSnapshot()) ?? snapshotRef.current;
      if (!snap) {
        showNotice("error", "Could not read the document from Word.");
        return;
      }
      setActiveId(candidates[0].id);
      const { applied, failed } = await applyMany(candidates, snap);
      await refreshSnapshot();
      showNotice(failed.length ? "error" : "success", failed.length
        ? `Applied ${applied.length} of ${candidates.length}; could not apply: ${failed.map((entry) => entry.suggestion.title).join(", ")}.`
        : `Applied ${applied.length} suggestion${applied.length === 1 ? "" : "s"} as ${settingsRef.current.trackChanges === "always" ? "tracked changes" : "edits"}.`);
    });
  }, [applyMany, hostStatus, refreshSnapshot, runBusy, showNotice]);

  const comment = useCallback((suggestion: AiSuggestion) => {
    const snap = snapshotRef.current;
    if (!snap || hostStatus !== "ready") {
      return;
    }
    setActiveId(suggestion.id);
    void runBusy("Adding a Word comment…", async () => {
      try {
        if (suggestion.kind === "image" && suggestion.image) {
          await commentInlinePicture(suggestion.image.index, buildCommentText(suggestion));
        } else {
          const state = await ensureMatches(suggestion, snap);
          if (!state.matches) {
            return;
          }
          await commentSuggestion(snap, suggestion, buildCommentText(suggestion), state.matchIndex);
        }
        patchCard(suggestion.id, { outcome: "commented", detail: null, error: null });
        await recordDecision(suggestion, "accepted", "Left as a Word comment");
        showNotice("success", "Comment added in Word.");
      } catch (error) {
        patchCard(suggestion.id, { error: errorMessage(error) });
        showNotice("error", errorMessage(error));
      }
    });
  }, [ensureMatches, hostStatus, patchCard, recordDecision, runBusy, showNotice]);

  const dismiss = useCallback((suggestion: AiSuggestion) => {
    patchCard(suggestion.id, { outcome: "dismissed", detail: null, error: null });
    void recordDecision(suggestion, "rejected", "Dismissed in the Word pane");
  }, [patchCard, recordDecision]);

  const restore = useCallback((suggestion: AiSuggestion) => {
    patchCard(suggestion.id, { outcome: null, detail: null, error: null });
    void recordDecision(suggestion, "pending", "");
  }, [patchCard, recordDecision]);

  /** Forget the provider sessions and the transcript, but keep pending cards (carried into the new conversation) and attachments. */
  const startNewConversation = useCallback(() => {
    const pending = suggestionsRef.current.filter((suggestion) => !cardsRef.current[suggestion.id]?.outcome);
    agentSessionsRef.current = {};
    const now = new Date().toISOString();
    const carried: ChatTurn[] = pending.length
      ? [{
          id: turnId(),
          role: "assistant",
          at: now,
          text: `Carried over ${pending.length} pending suggestion${pending.length === 1 ? "" : "s"} from the previous conversation.`,
          status: "done",
          engine: describeProposers(pending),
          suggestionIds: pending.map((suggestion) => suggestion.id),
          progress: null,
          origin: "session",
          activity: []
        }]
      : [];
    setTurns([
      { id: turnId(), role: "system", at: now, text: "New conversation — earlier turns are no longer sent to the AI.", tone: "info" },
      ...carried
    ]);
    setRequestState("idle");
    setActiveId(pending[0]?.id ?? null);
  }, []);

  /** A note typed on a card: sent as a request about that one suggestion; the reply revises it. */
  const discuss = useCallback((suggestion: AiSuggestion, note: string) => {
    setActiveId(suggestion.id);
    const focus: AiRequestFocus = {
      suggestionId: suggestion.id,
      ref: suggestion.ref ?? null,
      title: suggestion.title || "Suggested revision",
      original: suggestion.original,
      replacement: suggestion.replacement,
      rationale: suggestion.rationale || null
    };
    void ask({ instruction: note, focus });
  }, [ask]);

  const clearConversation = useCallback(() => {
    for (const suggestion of suggestionsRef.current) {
      if (!cardsRef.current[suggestion.id]?.outcome) {
        void recordDecision(suggestion, "rejected", "Cleared from the Word pane");
      }
    }
    setTurns([]);
    setSuggestions([]);
    setCards({});
    setActiveId(null);
    setRequestState("idle");
    agentSessionsRef.current = {};
  }, [recordDecision]);

  /* ------------------------------------------------------------------ */
  /* Attachments (reference files sent with every request)             */
  /* ------------------------------------------------------------------ */

  const addFiles = useCallback((files: File[]) => {
    const room = AI_ATTACHMENT_LIMIT - attachmentsRef.current.length;
    if (room <= 0) {
      showNotice("error", `At most ${AI_ATTACHMENT_LIMIT} reference files can be attached — remove one first.`);
      return;
    }
    const accepted = files.slice(0, room);
    if (accepted.length < files.length) {
      showNotice("info", `Only ${accepted.length} of ${files.length} files attached (limit ${AI_ATTACHMENT_LIMIT}).`);
    }
    setUploading((count) => count + accepted.length);
    for (const file of accepted) {
      uploadAttachment(file).then((attachment) => {
        setAttachments((current) => [...current.filter((item) => item.name !== attachment.name), attachment]);
        showNotice("success", `Attached ${attachment.name}${attachment.text.length ? ` (${attachment.text.length.toLocaleString()} characters extracted${attachment.truncated ? ", truncated" : ""})` : " — no text could be extracted"}.`);
      }).catch((error) => {
        showNotice("error", `Could not attach ${file.name}: ${errorMessage(error)}`);
      }).finally(() => {
        setUploading((count) => Math.max(0, count - 1));
      });
    }
  }, [showNotice]);

  const removeAttachment = useCallback((name: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.name !== name));
  }, []);

  /* ------------------------------------------------------------------ */
  /* Derived view state                                                 */
  /* ------------------------------------------------------------------ */

  const pendingSuggestions = useMemo(() => suggestions.filter((suggestion) => (cards[suggestion.id]?.outcome ?? null) === null), [cards, suggestions]);

  useEffect(() => {
    if (!pendingSuggestions.length) {
      return;
    }
    if (!activeId || !pendingSuggestions.some((suggestion) => suggestion.id === activeId)) {
      setActiveId(pendingSuggestions[0].id);
    }
  }, [activeId, pendingSuggestions]);

  const navigate = useCallback((direction: -1 | 1) => {
    if (!pendingSuggestions.length) {
      return;
    }
    const index = pendingSuggestions.findIndex((suggestion) => suggestion.id === activeId);
    const next = pendingSuggestions[index < 0 ? 0 : (index + direction + pendingSuggestions.length) % pendingSuggestions.length];
    locate(next);
    if (typeof document !== "undefined") {
      document.querySelector<HTMLElement>(`[data-suggestion-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeId, locate, pendingSuggestions]);

  useEffect(() => {
    // Keyboard handling is deliberately minimal in a pane where people type:
    // no letter shortcuts at all, and the arrow keys / Enter only act while a
    // suggestion card itself has focus (standard list behaviour), never from
    // the window at large.
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || typeof target.closest !== "function" || !target.closest(".wp-card")) {
        return;
      }
      const active = activeId ? suggestionsRef.current.find((suggestion) => suggestion.id === activeId) : null;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          navigate(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          navigate(-1);
          break;
        case "Enter":
          if (active) {
            event.preventDefault();
            locate(active);
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeId, locate, navigate]);

  const presets = useMemo<WordPreset[]>(() => [
    ...WORD_PRESETS,
    ...generalBuiltInRoutines.map((routine) => ({ group: "Writing", id: routine.id, instruction: routine.prompt, label: routine.label, title: routine.title })),
    ...r01BuiltInRoutines.map((routine) => ({ group: "NIH R01", id: routine.id, instruction: routine.prompt, label: routine.label, title: routine.title }))
  ], []);

  const scopeOptions = useMemo<ScopeOption[]>(() => [
    { id: "auto", label: "Auto", detail: "Selection when you have one, otherwise the whole document with your position attached" },
    { id: "selection", label: "Selection", detail: "Only the selected text", disabled: !focus?.selection },
    { id: "paragraph", label: "Paragraph", detail: "The paragraph at the caret", disabled: !focus || focus.cursorParagraphIndex === null },
    { id: "viewport", label: "Visible", detail: "The pages currently on screen", disabled: !focus?.viewport },
    { id: "document", label: "Document", detail: "The whole document" }
  ], [focus]);

  const providerOptions = useMemo(() => {
    const status = new Map((health?.providerStatus ?? []).map((provider) => [provider.name, provider.available]));
    return [
      { value: "claude" as const, label: "Claude", available: status.get("claude") ?? true },
      { value: "codex" as const, label: "Codex", available: status.get("codex") ?? true }
    ];
  }, [health]);

  const contextStrip = useMemo(() => {
    const described = describeFocus(snapshot, focus);
    return {
      documentName: snapshot?.documentName ?? null,
      wordCount: snapshot ? wordCount(snapshot.bodyText) : 0,
      heading: described.heading,
      position: described.position,
      selection: described.selection,
      viewport: described.viewport,
      stale: Boolean(focus?.stale),
      sharedWithAgents,
      trail: trail.slice(-3).reverse().map((entry) => excerpt(entry.excerpt, 42))
    };
  }, [focus, sharedWithAgents, snapshot, trail]);

  const capabilityRows = useMemo<CapabilityRow[]>(() => [
    { label: `${capabilities.hostName ?? "Word"} host`, ok: capabilities.host, detail: capabilities.host ? `${capabilities.platform ?? "desktop"}${capabilities.officeVersion ? ` · Office ${capabilities.officeVersion}` : ""}` : hostDetail },
    { label: "Tracked changes & comments", ok: capabilities.trackChanges && capabilities.comments, detail: capabilities.trackChanges ? "WordApi 1.4" : capabilities.hostName === "Google Docs" ? "Google Docs applies edits directly — turn on change highlighting below" : "Needs WordApi 1.4 (update Word)" },
    { label: "Viewport (pages on screen)", ok: capabilities.viewport, detail: capabilities.viewport ? "WordApiDesktop 1.2" : "Not available in this Word build — caret and selection still work" },
    { label: "Selection events", ok: capabilities.selectionEvents, detail: capabilities.selectionEvents ? "Live caret tracking" : "Polling only" },
    { label: "Paragraph events", ok: capabilities.paragraphEvents, detail: capabilities.paragraphEvents ? "WordApi 1.6 — re-reads on edits" : "Polling every 20 s" },
    { label: "Writer sidecar", ok: sidecarStatus === "ok", detail: sidecarDetail },
    { label: "Served from", ok: true, detail: typeof location !== "undefined" ? location.origin : "" }
  ], [capabilities, hostDetail, sidecarDetail, sidecarStatus]);

  const mockControls = useMemo(() => {
    const mock = mockHost();
    if (!mock) {
      return null;
    }
    return [
      { label: "Caret → Aim 2", run: () => { const index = mock.text.indexOf("Using the model"); mock.setSelection(index, index); } },
      { label: "Select a sentence", run: () => mock.selectText("It is important to note that the preliminary data (Fig. 1) demonstrate feasibility of the approach in our hands [1,2].") },
      { label: "Scroll to Approach", run: () => { mock.scrollTo(mock.text.indexOf("Rationale.")); mock.fireSelectionChanged(); } },
      { label: "Edit outside pane", run: () => { const index = mock.text.indexOf("Innovation"); mock.replaceRange(index, index + "Innovation".length, "Innovation and impact"); } }
    ];
  }, []);

  // Typing while a request runs is fine: the message queues and is sent when
  // the turn ends. Only apply/locate work (busyLabel) blocks sending.
  const canAsk = hostStatus === "ready" && sidecarStatus === "ok" && Boolean(instruction.trim()) && (requestState === "running" || !busyLabel);

  const setModelPreference = useCallback((patch: Partial<ModelPreference>) => {
    setSettings((current) => {
      const provider = current.provider;
      const existing = current.models[provider] ?? { model: null, reasoning: null };
      return { ...current, models: { ...current.models, [provider]: { ...existing, ...patch } } };
    });
  }, []);

  return (
    <WordPane
      activeSuggestionId={activeId}
      attachments={attachments}
      uploading={uploading}
      onAddFiles={addFiles}
      onRemoveAttachment={removeAttachment}
      busyLabel={busyLabel}
      canAsk={canAsk}
      capabilityRows={capabilityRows}
      cardState={cardState}
      contextStrip={contextStrip}
      hostDetail={hostDetail}
      hostStatus={hostStatus}
      instruction={instruction}
      mockControls={mockControls}
      modelControls={{
        catalog: activeCatalog,
        loading: catalogLoading,
        model: modelPreference.model,
        reasoning: modelPreference.reasoning,
        onModelChange: (model) => setModelPreference({ model }),
        onReasoningChange: (reasoning) => setModelPreference({ reasoning }),
        onRefresh: () => void loadCatalog(true)
      }}
      notice={notice}
      onApply={apply}
      onApplyGroup={applyGroup}
      onAsk={() => void ask()}
      onClearConversation={clearConversation}
      onNewConversation={startNewConversation}
      onDiscuss={discuss}
      queued={queued ? { text: queued.text } : null}
      onSendQueuedNow={() => void sendQueuedNow()}
      onQueue={queueTyped}
      onCancelQueued={cancelQueued}
      onComment={comment}
      onCycleMatch={cycleMatch}
      onDismiss={dismiss}
      onInstructionChange={setInstruction}
      onLocate={locate}
      onNavigate={navigate}
      onPreset={(preset) => {
        setInstruction(preset.instruction);
        const scope = (preset as WordPreset).scope;
        if (scope) {
          setSettings((current) => ({ ...current, scope }));
        }
        showNotice("info", `Loaded "${preset.label}".`);
      }}
      onProviderChange={(provider) => setSettings((current) => ({ ...current, provider }))}
      onRestore={restore}
      onScopeChange={(scope) => setSettings((current) => ({ ...current, scope }))}
      onSettingsChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
      onStop={stop}
      onSync={() => {
        lastPushedTextRef.current = null;
        void runBusy("Re-reading the document…", async () => {
          await refreshSnapshot();
          showNotice("info", "Document re-read from Word.");
        });
      }}
      pendingCount={pendingSuggestions.length}
      presets={presets}
      provider={settings.provider}
      providerOptions={providerOptions}
      requestState={requestState}
      scope={settings.scope}
      scopeLabel={scopeResolution?.label ?? "Waiting for the document…"}
      scopeOptions={scopeOptions}
      hostName={capabilities.hostName ?? "Word"}
      tracksChanges={capabilities.trackChanges}
      settings={{ requesterName: settings.requesterName, trackChanges: settings.trackChanges, highlightChanges: settings.highlightChanges, shareWithAgents: settings.shareWithAgents, mirrorChat: settings.mirrorChat, toolAccess: settings.toolAccess }}
      sidecarDetail={sidecarDetail}
      sidecarStatus={sidecarStatus}
      suggestionById={suggestionById}
      turns={turns}
    />
  );
}

/* -------------------------------------------------------------------- */
/* helpers                                                              */
/* -------------------------------------------------------------------- */

/** What exactly went to the AI — the user turn shows this so nothing is sent silently. */
export function summarizeSent(
  request: WordLiveSuggestionRequest,
  scopeLabel: string,
  snapshot: WordDocumentSnapshot,
  focus: WordFocusState | null,
  trailLength: number,
  outlineLength: number,
  engine: string
): SentSummary {
  const scoped = request.mode === "selection" && request.selection ? request.selection.text : request.documentText;
  const paragraph = focus && focus.cursorParagraphIndex !== null ? snapshot.paragraphs[focus.cursorParagraphIndex] ?? null : null;
  const heading = paragraph ? nearestHeading(snapshot.paragraphs, paragraph.index) : null;
  return {
    scopeLabel,
    mode: request.mode,
    words: wordCount(scoped),
    chars: scoped.length,
    from: request.mode === "selection" && request.selection ? request.selection.from : null,
    to: request.mode === "selection" && request.selection ? request.selection.to : null,
    documentWords: wordCount(request.documentText),
    documentChars: request.documentText.length,
    excerptStart: excerpt(scoped.slice(0, 200), 110),
    excerptEnd: scoped.length > 260 ? excerpt(scoped.slice(-200), 70) : "",
    context: {
      cursor: paragraph ? `¶ ${paragraph.index + 1} of ${snapshot.paragraphs.length}` : null,
      heading: heading ? excerpt(heading.text, 60) : null,
      viewport: focus?.viewport && focus.viewport.pages.length ? `viewing page${focus.viewport.pages.length === 1 ? "" : "s"} ${describePages(focus.viewport.pages)}` : null,
      selectionWords: focus?.selection ? wordCount(focus.selection.text) : null,
      trail: trailLength,
      outline: outlineLength
    },
    engine,
    documentName: request.documentName ?? null,
    attachments: (request.attachments ?? []).map((attachment) => ({ name: attachment.name, chars: attachment.text.length, truncated: Boolean(attachment.truncated) })),
    conversationTurns: request.conversation?.length ?? 0,
    resumed: Boolean(request.agentSessionId)
  };
}

const DIGEST_TURN_LIMIT = 16;

/** The chat so far, with what happened to each staged suggestion, for the next request. */
export function buildConversationDigest(turns: ChatTurn[], suggestions: AiSuggestion[], cards: Record<string, CardState>): AiConversationTurn[] {
  const byId = new Map(suggestions.map((suggestion) => [suggestion.id, suggestion]));
  const digest: AiConversationTurn[] = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      digest.push({ role: "user", content: turn.focus ? `[About ${turn.focus.ref ? `${turn.focus.ref} ` : ""}"${turn.focus.title}"] ${turn.text}` : turn.text });
    } else if (turn.role === "assistant" && turn.status !== "running" && turn.origin !== "session") {
      const decisions = turn.suggestionIds
        .map((id) => byId.get(id))
        .filter((suggestion): suggestion is AiSuggestion => suggestion !== undefined)
        .map((suggestion): AiConversationDecision => {
          const state = cards[suggestion.id];
          return {
            ref: suggestion.ref ?? null,
            title: suggestion.title,
            status: state?.outcome === "revised" ? "superseded" : state?.outcome ?? "pending",
            note: state?.outcome === "dismissed" ? state.detail : state?.outcome === "decided-elsewhere" ? state.detail : state?.outcome === "revised" ? "replaced by a revision after the user's feedback" : null
          };
        });
      digest.push({ role: "assistant", content: turn.text || (turn.status === "error" ? "(the request failed)" : ""), ...(decisions.length ? { decisions } : {}) });
    }
  }
  return digest.slice(-DIGEST_TURN_LIMIT);
}

export function buildCommentText(suggestion: AiSuggestion): string {
  const replacement = suggestion.replacement.trim();
  const lines = [
    `Nebula Writer — ${suggestion.title.trim() || "Suggested revision"}`,
    ""
  ];
  if (suggestion.commentOnly || !replacement) {
    lines.push(suggestion.rationale.trim() || "(No rationale provided.)");
  } else {
    lines.push("Suggested:", replacement, "", "Why:", suggestion.rationale.trim() || "(No rationale provided.)");
  }
  const meta = [
    suggestion.proposedBy ? `proposed by ${suggestion.proposedBy}` : null,
    Number.isFinite(suggestion.confidence) ? `confidence ${Math.round(Math.max(0, Math.min(1, suggestion.confidence)) * 100)}%` : null
  ].filter(Boolean);
  if (meta.length) {
    lines.push("", `(${meta.join(" · ")})`);
  }
  return lines.join("\n");
}

function describeProposers(suggestions: AiSuggestion[]): string {
  const names = [...new Set(suggestions.map((suggestion) => suggestion.proposedBy).filter((name): name is string => Boolean(name)))];
  return names.length ? names.join(", ") : "A Writer agent";
}

function describeProgress(stage: string, passIndex: number | null, passTotal: number | null): string {
  const pass = passIndex !== null && passTotal !== null && passTotal > 1 ? ` (pass ${passIndex} of ${passTotal})` : "";
  return `${stage}${pass}`;
}

function providerLabel(provider: string): string {
  return provider === "codex" ? "Codex CLI" : provider === "demo" ? "Demo provider" : "Claude Code";
}

/** Raw base64 (as Office.js returns it) to a Blob whose type is sniffed from the leading bytes. */
function base64ToBlob(base64: string): Blob | null {
  const clean = base64.replace(/^data:[^,]*,/, "").trim();
  if (!clean) {
    return null;
  }
  const type = clean.startsWith("iVBOR") ? "image/png"
    : clean.startsWith("/9j/") ? "image/jpeg"
      : clean.startsWith("R0lGOD") ? "image/gif"
        : clean.startsWith("UklGR") ? "image/webp"
          : null;
  if (!type) {
    return null;
  }
  try {
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type });
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
