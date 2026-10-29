import { markedSides, renderMarked } from "../emphasisView";
/**
 * Presentational layer of the Word task pane, chat-style.
 *
 * Layout (top → bottom, the middle scrolls): status header · live "where you
 * are" strip · conversation transcript · composer pinned at the bottom.
 * Each of the author's turns records exactly what was sent (scope, size,
 * window state, engine); each assistant turn carries its own suggestion
 * cards, so nothing accumulates in a detached queue. All state and Office.js
 * calls live in App.tsx.
 */

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Crosshair,
  Eye,
  FileText,
  Loader2,
  MapPin,
  MessageSquarePlus,
  MessageSquareText,
  Paperclip,
  RefreshCw,
  Replace,
  RotateCcw,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  User,
  X, ListPlus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AI_TOOL_ACCESS_LEVELS, formatElapsedSince, type AiActivityEntry, type AiAttachment, type AiModelChoice, type AiProviderCatalog, type AiReasoningChoice, type AiSuggestion, type AiToolAccess, type LocalAiProviderName } from "../shared";
import { wordDiffSegments } from "../wordDiff";
import { parseAssistantReply, type ReplyGroup } from "./replyLayout";
import type { RequestScope } from "./wordContext";

export type HostStatus = "booting" | "ready" | "unavailable";
export type SidecarStatus = "checking" | "ok" | "offline";
export type RequestState = "idle" | "running" | "done" | "empty" | "error";
export type CardOutcome = "applied" | "commented" | "dismissed" | "decided-elsewhere" | "revised" | null;

export interface PresetOption {
  group: string;
  id: string;
  instruction: string;
  label: string;
  title?: string;
}

export interface ScopeOption {
  id: RequestScope;
  label: string;
  detail: string;
  disabled?: boolean;
}

export interface CardState {
  matchIndex: number;
  matches: number | null;
  heading: string | null;
  paragraphIndex: number | null;
  outcome: CardOutcome;
  detail: string | null;
  error: string | null;
}

export interface CapabilityRow {
  label: string;
  ok: boolean;
  detail: string;
}

export interface Notice {
  tone: "info" | "success" | "error";
  text: string;
}

/** Everything the pane sent with one request — shown under the author's turn. */
export interface SentSummary {
  scopeLabel: string;
  mode: "global" | "selection";
  words: number;
  chars: number;
  from: number | null;
  to: number | null;
  documentWords: number;
  documentChars: number;
  excerptStart: string;
  excerptEnd: string;
  context: {
    cursor: string | null;
    heading: string | null;
    viewport: string | null;
    selectionWords: number | null;
    trail: number;
    outline: number;
  };
  engine: string;
  documentName: string | null;
  attachments: Array<{ name: string; chars: number; truncated: boolean }>;
  /** Earlier turns (with decisions) sent as the conversation digest. */
  conversationTurns: number;
  /** True when the provider's own session was resumed for this turn. */
  resumed: boolean;
}

export type ChatTurn =
  | { id: string; role: "user"; at: string; text: string; sent?: SentSummary; focus?: { ref: string | null; title: string } | null; steered?: boolean }
  | { id: string; role: "assistant"; at: string; text: string; status: "running" | "done" | "error"; engine: string; suggestionIds: string[]; progress: string | null; origin: "pane" | "session"; activity: AiActivityEntry[] }
  | { id: string; role: "system"; at: string; text: string; tone: "info" | "error" };

export interface ModelControls {
  catalog: AiProviderCatalog | null;
  loading: boolean;
  model: string | null;
  reasoning: string | null;
  onModelChange: (model: string | null) => void;
  onReasoningChange: (reasoning: string | null) => void;
  onRefresh: () => void;
}

export interface WordPaneProps {
  activeSuggestionId: string | null;
  attachments: AiAttachment[];
  uploading: number;
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (name: string) => void;
  busyLabel: string | null;
  canAsk: boolean;
  capabilityRows: CapabilityRow[];
  cardState: (suggestion: AiSuggestion) => CardState;
  contextStrip: {
    documentName: string | null;
    wordCount: number;
    heading: string | null;
    position: string;
    selection: string | null;
    viewport: string | null;
    stale: boolean;
    sharedWithAgents: boolean;
    trail: string[];
  };
  hostDetail: string;
  hostStatus: HostStatus;
  instruction: string;
  mockControls: Array<{ label: string; run: () => void }> | null;
  modelControls: ModelControls;
  notice: Notice | null;
  onApply: (suggestion: AiSuggestion) => void;
  onApplyGroup: (suggestions: AiSuggestion[]) => void;
  onAsk: () => void;
  onClearConversation: () => void;
  onNewConversation: () => void;
  /** Earlier turns of the saved conversation exist beyond those in the pane. */
  hasEarlierTurns: boolean;
  loadingEarlierTurns: boolean;
  onLoadEarlierTurns: () => void;
  onComment: (suggestion: AiSuggestion) => void;
  onCycleMatch: (suggestion: AiSuggestion, direction: -1 | 1) => void;
  onDismiss: (suggestion: AiSuggestion) => void;
  /** A note typed on a card about that change: the reply revises the suggestion. */
  onDiscuss: (suggestion: AiSuggestion, note: string) => void;
  /** A message typed while a request runs, waiting to go out when it ends. */
  queued: { text: string } | null;
  onSendQueuedNow: () => void;
  /** While a request runs: hold the typed message for the next turn instead of sending it into this one. */
  onQueue: () => void;
  onCancelQueued: () => void;
  onInstructionChange: (value: string) => void;
  onLocate: (suggestion: AiSuggestion) => void;
  onNavigate: (direction: -1 | 1) => void;
  onPreset: (preset: PresetOption) => void;
  onProviderChange: (provider: LocalAiProviderName) => void;
  onRestore: (suggestion: AiSuggestion) => void;
  onScopeChange: (scope: RequestScope) => void;
  onSettingsChange: (patch: Partial<WordPaneProps["settings"]>) => void;
  onStop: () => void;
  onSync: () => void;
  pendingCount: number;
  presets: PresetOption[];
  provider: LocalAiProviderName;
  providerOptions: Array<{ label: string; value: LocalAiProviderName; available: boolean }>;
  requestState: RequestState;
  scope: RequestScope;
  scopeLabel: string;
  scopeOptions: ScopeOption[];
  settings: { requesterName: string; trackChanges: "always" | "word"; highlightChanges: boolean; shareWithAgents: boolean; mirrorChat: boolean; toolAccess: AiToolAccess };
  /** "Word" or "Google Docs" — for labels. */
  hostName: "Word" | "Google Docs";
  /** Whether the host records edits as tracked changes (Word) — else the highlight option is offered. */
  tracksChanges: boolean;
  sidecarDetail: string;
  sidecarStatus: SidecarStatus;
  suggestionById: (id: string) => AiSuggestion | null;
  turns: ChatTurn[];
}

/** True when a drag carries files (not text or a link dragged from the page). */
function draggingFiles(event: { dataTransfer: DataTransfer | null }): boolean {
  return Boolean(event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files"));
}

export function WordPane(props: WordPaneProps) {
  const running = props.requestState === "running";
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Files dropped anywhere on the pane are attached. Nested elements fire
  // enter/leave in pairs, so a depth counter tells when the drag really left.
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const onAddFiles = props.onAddFiles;
  useEffect(() => {
    // A file dropped outside the drop zone must never replace the pane with the file.
    const guard = (event: DragEvent) => {
      if (draggingFiles(event)) {
        event.preventDefault();
      }
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);
  return (
    <div
      className={`wp-shell${dropping ? " dropping" : ""}`}
      onDragEnter={(event) => {
        if (draggingFiles(event)) {
          event.preventDefault();
          dragDepth.current += 1;
          setDropping(true);
        }
      }}
      onDragOver={(event) => {
        if (draggingFiles(event)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={(event) => {
        if (draggingFiles(event)) {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) {
            setDropping(false);
          }
        }
      }}
      onDrop={(event) => {
        if (!draggingFiles(event)) {
          return;
        }
        event.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length) {
          onAddFiles(files);
        }
      }}
    >
      {dropping ? (
        <div className="wp-drop-overlay" aria-hidden="true">
          <Paperclip size={20} />
          <span>Drop to attach as reference files</span>
        </div>
      ) : null}
      <header className="wp-header">
        <div className="wp-brand">
          <span className="wp-brand-mark" aria-hidden="true">N</span>
          <div>
            <p className="wp-eyebrow">Nebula Writer</p>
            <h1>{props.hostName === "Google Docs" ? "Google Docs review pane" : "Word review pane"}</h1>
          </div>
        </div>
        <div className="wp-status-pills">
          <StatusPill
            tone={props.hostStatus === "ready" ? "ok" : props.hostStatus === "booting" ? "pending" : "warn"}
            label={props.hostStatus === "ready" ? props.hostName : props.hostStatus === "booting" ? `${props.hostName}…` : `No ${props.hostName}`}
            title={props.hostDetail}
          />
          <StatusPill
            tone={props.sidecarStatus === "ok" ? "ok" : props.sidecarStatus === "checking" ? "pending" : "warn"}
            label={props.sidecarStatus === "ok" ? "Writer" : props.sidecarStatus === "checking" ? "Writer…" : "No Writer"}
            title={props.sidecarDetail}
          />
          <button type="button" className="wp-icon-button" onClick={props.onSync} disabled={props.hostStatus !== "ready" || Boolean(props.busyLabel)} title="Re-read the document from Word" aria-label="Re-read the document from Word">
            <RefreshCw size={14} aria-hidden="true" />
          </button>
          <button type="button" className={`wp-icon-button ${settingsOpen ? "active" : ""}`} onClick={() => setSettingsOpen((open) => !open)} title="Settings & diagnostics" aria-label="Settings & diagnostics" aria-expanded={settingsOpen}>
            <Settings2 size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      <ContextStrip {...props.contextStrip} hostStatus={props.hostStatus} />

      {props.mockControls ? (
        <div className="wp-mock-bar" aria-label="Mock Word controls">
          <span>Mock Word</span>
          {props.mockControls.map((control) => (
            <button key={control.label} type="button" onClick={control.run}>{control.label}</button>
          ))}
        </div>
      ) : null}

      {settingsOpen ? (
        <SettingsPanel tracksChanges={props.tracksChanges} capabilityRows={props.capabilityRows} modelControls={props.modelControls} onSettingsChange={props.onSettingsChange} settings={props.settings} />
      ) : null}

      <Transcript
        activeSuggestionId={props.activeSuggestionId}
        busy={Boolean(props.busyLabel)}
        cardState={props.cardState}
        hostReady={props.hostStatus === "ready"}
        onApply={props.onApply}
        onApplyGroup={props.onApplyGroup}
        onClear={props.onClearConversation}
        onNew={props.onNewConversation}
        hasEarlier={props.hasEarlierTurns}
        loadingEarlier={props.loadingEarlierTurns}
        onLoadEarlier={props.onLoadEarlierTurns}
        onComment={props.onComment}
        onCycleMatch={props.onCycleMatch}
        onDismiss={props.onDismiss}
        onDiscuss={props.onDiscuss}
        onLocate={props.onLocate}
        onNavigate={props.onNavigate}
        onRestore={props.onRestore}
        pendingCount={props.pendingCount}
        suggestionById={props.suggestionById}
        trackChanges={props.settings.trackChanges}
        turns={props.turns}
      />

      <section className="wp-composer" aria-label="Ask Writer">
        <div className="wp-scope" role="radiogroup" aria-label="Request scope">
          {props.scopeOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={props.scope === option.id}
              className={props.scope === option.id ? "active" : ""}
              onClick={() => props.onScopeChange(option.id)}
              disabled={option.disabled || running}
              title={option.detail}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="wp-scope-label"><Crosshair size={12} aria-hidden="true" /> {props.scopeLabel}</p>
        <div className="wp-engine-row">
          <label className="wp-select wp-select-provider">
            <span className="sr-only">Provider</span>
            <select value={props.provider} onChange={(event) => props.onProviderChange(event.currentTarget.value as LocalAiProviderName)} disabled={running} aria-label="AI provider" title={props.modelControls.catalog?.version ? `${props.modelControls.catalog.version}` : undefined}>
              {props.providerOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}{option.available ? "" : " (not found)"}</option>
              ))}
            </select>
          </label>
          <ModelPicker controls={props.modelControls} disabled={running} />
        </div>
        <div className="wp-composer-row">
          <label className="wp-icon-button wp-attach" title="Attach reference files (PDF, DOCX, text) for this conversation" aria-label="Attach reference files">
            {props.uploading ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Paperclip size={14} aria-hidden="true" />}
            <input
              type="file"
              multiple
              className="sr-only"
              aria-label="Attach reference files"
              disabled={running}
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                if (files.length) {
                  props.onAddFiles(files);
                }
              }}
            />
          </label>
          <label className="wp-select">
            <span className="sr-only">Preset</span>
            <select value="" onChange={(event) => {
              const preset = props.presets.find((item) => item.id === event.currentTarget.value);
              if (preset) {
                props.onPreset(preset);
              }
            }} disabled={running} aria-label="Load a preset instruction">
              <option value="">Presets…</option>
              {groupPresets(props.presets).map((group) => (
                <optgroup key={group.name} label={group.name}>
                  {group.items.map((preset) => <option key={preset.id} value={preset.id} title={preset.title}>{preset.label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
        {props.attachments.length ? (
          <ul className="wp-attachments" aria-label="Attached reference files">
            {props.attachments.map((attachment) => (
              <li key={attachment.name} title={`${attachment.text.length.toLocaleString()} characters extracted${attachment.truncated ? " (truncated)" : ""} · sent with every request until removed`}>
                <Paperclip size={11} aria-hidden="true" />
                <span>{attachment.name}</span>
                <small>{formatChars(attachment.text.length)}{attachment.truncated ? "+" : ""}</small>
                <button type="button" onClick={() => props.onRemoveAttachment(attachment.name)} aria-label={`Remove ${attachment.name}`} disabled={running}><X size={11} aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        ) : null}
        {props.queued ? (
          <div className="wp-queued" role="status">
            <span className="wp-queued-text">Queued: "{props.queued.text}"</span>
            <button type="button" className="wp-text-button" onClick={props.onSendQueuedNow} title="Send it into the running turn now">Send now</button>
            <button type="button" className="wp-icon-button tiny" onClick={props.onCancelQueued} aria-label="Discard the queued message" title="Discard"><X size={12} aria-hidden="true" /></button>
          </div>
        ) : null}
        <form
          className="wp-form"
          onSubmit={(event) => {
            event.preventDefault();
            props.onAsk();
          }}
        >
          <textarea
            value={props.instruction}
            onChange={(event) => props.onInstructionChange(event.currentTarget.value)}
            placeholder={running
              ? "Add to the running turn (⌘↩), or queue it for after (⇧⌘↩)"
              : "Tighten this paragraph… / Sharpen the visible pages for reviewers… / Review the whole Aims page"}
            aria-label="Instruction for Writer"
            rows={3}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                if (props.canAsk) {
                  if (running && event.shiftKey) {
                    props.onQueue();
                  } else {
                    props.onAsk();
                  }
                }
              }
            }}
          />
          {running ? (
            <button type="button" className="wp-send stop" onClick={props.onStop} aria-label="Stop the request" title="Stop">
              <Square size={15} aria-hidden="true" />
            </button>
          ) : null}
          {running ? (
            <button type="button" className="wp-send queue" onClick={props.onQueue} disabled={!props.canAsk} aria-label="Queue for after this turn (⇧⌘↩)" title="Queue — sent when the current turn finishes (⇧⌘↩)">
              <ListPlus size={15} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="submit"
            className="wp-send"
            disabled={!props.canAsk}
            aria-label={running ? "Send now, into the running turn (⌘↩)" : "Send to Writer (⌘↩)"}
            title={running ? "Send now — the AI takes it into account in this turn (⌘↩)" : "Send (⌘↩)"}
          >
            <Send size={16} aria-hidden="true" />
          </button>
        </form>
        <StatusLine notice={props.notice} busyLabel={props.busyLabel} />
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Header + context                                                           */
/* -------------------------------------------------------------------------- */

function StatusPill(props: { tone: "ok" | "pending" | "warn"; label: string; title: string }) {
  return (
    <span className={`wp-pill ${props.tone}`} title={props.title}>
      {props.tone === "pending" ? <Loader2 size={11} className="spin" aria-hidden="true" /> : <span className="dot" aria-hidden="true" />}
      {props.label}
    </span>
  );
}

function ContextStrip(props: WordPaneProps["contextStrip"] & { hostStatus: HostStatus }) {
  if (props.hostStatus !== "ready") {
    return (
      <section className="wp-context muted" aria-label="Where you are in Word">
        <p><FileText size={13} aria-hidden="true" /> {props.hostStatus === "booting" ? "Connecting to Word…" : "Open this pane from Word's Home tab to read the document."}</p>
      </section>
    );
  }
  return (
    <section className="wp-context" aria-label="Where you are in Word" aria-live="polite">
      <div className="wp-context-doc">
        <FileText size={13} aria-hidden="true" />
        <span className="wp-context-name" title={props.documentName ?? undefined}>{props.documentName ?? "Untitled document"}</span>
        <span className="wp-context-count">{props.wordCount.toLocaleString()} words</span>
        {props.sharedWithAgents ? <span className="wp-context-shared" title="Terminal and MCP agents read this document and your position"><Bot size={11} aria-hidden="true" /> agents</span> : null}
        {props.stale ? <span className="wp-context-stale" title="Word's text changed; re-reading">syncing…</span> : null}
      </div>
      <div className="wp-context-where">
        <MapPin size={13} aria-hidden="true" />
        <div>
          {props.heading ? <strong>{props.heading}</strong> : <strong className="quiet">No heading above the caret</strong>}
          <span>{props.position}</span>
        </div>
      </div>
      <div className="wp-context-chips">
        {props.selection ? <span className="chip selection">{props.selection}</span> : <span className="chip quiet">Nothing selected</span>}
        {props.viewport ? <span className="chip"><Eye size={11} aria-hidden="true" /> {props.viewport}</span> : null}
      </div>
      {props.trail.length ? (
        <p className="wp-context-trail" title="Where you paused recently (shared with the AI)">Recently: {props.trail.join(" · ")}</p>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Model picker                                                               */
/* -------------------------------------------------------------------------- */

const CUSTOM_MODEL = "__custom__";
/** Turns rendered at a time in the transcript. */
const TRANSCRIPT_WINDOW = 40;

function ModelPicker(props: { controls: ModelControls; disabled: boolean }) {
  const { controls } = props;
  const catalog = controls.catalog;
  const [customDraft, setCustomDraft] = useState<string | null>(null);
  // The CLI's configured default is already the first option, so don't list it twice.
  const listed = catalog?.models.filter((model) => !model.hidden && !(model.source === "settings" && model.id === catalog.defaults.model)) ?? [];
  const hiddenModels = catalog?.models.filter((model) => model.hidden) ?? [];
  const knownIds = new Set((catalog?.models ?? []).map((model) => model.id));
  const currentModel = controls.model;
  const selectedChoice = currentModel ? catalog?.models.find((model) => model.id === currentModel) ?? null : null;
  const levels: AiReasoningChoice[] = catalog?.reasoning
    ? selectedChoice?.reasoningLevels
      ? catalog.reasoning.levels.filter((level) => selectedChoice.reasoningLevels?.includes(level.id))
      : catalog.reasoning.levels
    : [];
  // The closed select shows the CLI's own default by name (compact, like any
  // picker); the option's title says where that default comes from.
  const defaultModelLabel = catalog?.defaults.model ? labelFor(catalog.defaults.model, catalog.models) : "Default model";
  const defaultReasoning = selectedChoice?.defaultReasoning ?? catalog?.defaults.reasoning ?? null;
  const defaultReasoningLabel = defaultReasoning ? levelLabel(defaultReasoning, catalog?.reasoning?.levels ?? []) : "Default";
  const defaultSource = catalog?.defaults.source ? `CLI default (${shortPath(catalog.defaults.source)})` : "CLI default";
  const selectValue = customDraft !== null ? CUSTOM_MODEL : currentModel ?? "";

  return (
    <div className="wp-model-picker" aria-label="Model and reasoning">
      <label className="wp-select">
        <span className="sr-only">Model</span>
        <select
          value={selectValue}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === CUSTOM_MODEL) {
              setCustomDraft(currentModel && !knownIds.has(currentModel) ? currentModel : "");
              return;
            }
            setCustomDraft(null);
            controls.onModelChange(value || null);
          }}
          disabled={props.disabled || controls.loading}
          aria-label="Model"
          title={catalog?.notes.join(" ") || undefined}
        >
          <optgroup label={defaultSource}>
            <option value="">{controls.loading ? "Loading models…" : defaultModelLabel}</option>
          </optgroup>
          {listed.length ? (
            <optgroup label={catalog?.version ? `Available in ${catalog.version}` : "Available"}>
              {listed.map((model) => <option key={model.id} value={model.id} title={model.description ?? undefined}>{shortModelLabel(model.label)}</option>)}
            </optgroup>
          ) : null}
          {hiddenModels.length ? (
            <optgroup label="Hidden in the CLI's own picker">
              {hiddenModels.map((model) => <option key={model.id} value={model.id} title={model.description ?? undefined}>{shortModelLabel(model.label)}</option>)}
            </optgroup>
          ) : null}
          {currentModel && !knownIds.has(currentModel) && customDraft === null ? (
            <option value={currentModel}>{currentModel} (custom)</option>
          ) : null}
          {catalog?.allowsCustomModel !== false ? <option value={CUSTOM_MODEL}>Custom model id…</option> : null}
        </select>
      </label>
      {customDraft !== null ? (
        <input
          type="text"
          className="wp-custom-model"
          value={customDraft}
          placeholder="model id, e.g. claude-opus-5 or gpt-5.5"
          aria-label="Custom model id"
          autoFocus
          onChange={(event) => setCustomDraft(event.currentTarget.value)}
          onBlur={() => {
            const trimmed = customDraft.trim();
            controls.onModelChange(trimmed || null);
            setCustomDraft(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              setCustomDraft(null);
            }
          }}
        />
      ) : null}
      <label className="wp-select wp-select-reasoning">
        <span className="sr-only">Reasoning level</span>
        <select
          value={controls.reasoning ?? ""}
          onChange={(event) => controls.onReasoningChange(event.currentTarget.value || null)}
          disabled={props.disabled || controls.loading || (!levels.length && !controls.reasoning)}
          aria-label="Reasoning level"
          title={catalog?.reasoning ? `Passed as ${catalog.reasoning.control === "effort" ? "--effort" : "model_reasoning_effort"}` : "This CLI does not expose a reasoning level"}
        >
          <optgroup label={selectedChoice?.defaultReasoning ? `Default for ${labelFor(selectedChoice.id, catalog?.models ?? [])}` : defaultSource}>
            <option value="">{levels.length || controls.reasoning ? defaultReasoningLabel : "No reasoning control"}</option>
          </optgroup>
          {levels.length ? (
            <optgroup label="Levels">
              {levels.map((level) => <option key={level.id} value={level.id} title={level.description ?? undefined}>{level.label}</option>)}
            </optgroup>
          ) : null}
          {controls.reasoning && !levels.some((level) => level.id === controls.reasoning) ? <option value={controls.reasoning}>{controls.reasoning} (custom)</option> : null}
        </select>
      </label>
    </div>
  );
}

/** Picker label: the provider column already says "Claude", so drop the family prefix to save room. */
function labelFor(id: string, models: AiModelChoice[]): string {
  return shortModelLabel(models.find((model) => model.id === id)?.label ?? id);
}

function shortModelLabel(label: string): string {
  return label.replace(/^Claude\s+/, "");
}

function levelLabel(id: string, levels: AiReasoningChoice[]): string {
  return levels.find((level) => level.id === id)?.label ?? id;
}

/* -------------------------------------------------------------------------- */
/* Transcript                                                                 */
/* -------------------------------------------------------------------------- */

function Transcript(props: {
  activeSuggestionId: string | null;
  busy: boolean;
  cardState: (suggestion: AiSuggestion) => CardState;
  hostReady: boolean;
  onApply: (suggestion: AiSuggestion) => void;
  onApplyGroup: (suggestions: AiSuggestion[]) => void;
  onClear: () => void;
  onNew: () => void;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  onComment: (suggestion: AiSuggestion) => void;
  onCycleMatch: (suggestion: AiSuggestion, direction: -1 | 1) => void;
  onDismiss: (suggestion: AiSuggestion) => void;
  onDiscuss: (suggestion: AiSuggestion, note: string) => void;
  onLocate: (suggestion: AiSuggestion) => void;
  onNavigate: (direction: -1 | 1) => void;
  onRestore: (suggestion: AiSuggestion) => void;
  pendingCount: number;
  suggestionById: (id: string) => AiSuggestion | null;
  trackChanges: "always" | "word";
  turns: ChatTurn[];
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastTurnId = props.turns[props.turns.length - 1]?.id ?? null;
  // Only the latest turns are rendered, however long the conversation: the
  // pane stays as quick on turn 1,000 as on turn 10. Earlier ones are shown
  // (or fetched from the saved conversation) a window at a time.
  const [windowSize, setWindowSize] = useState(TRANSCRIPT_WINDOW);
  const visible = props.turns.length > windowSize ? props.turns.slice(-windowSize) : props.turns;
  const hiddenInPane = props.turns.length - visible.length;
  const firstVisibleId = visible[0]?.id ?? null;
  const anchorRef = useRef<{ firstId: string | null; height: number }>({ firstId: null, height: 0 });
  useEffect(() => {
    const element = scrollRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lastTurnId]);
  // Turns revealed above keep the reader where they were.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const anchor = anchorRef.current;
    if (element && anchor.firstId && anchor.firstId !== firstVisibleId) {
      element.scrollTop += element.scrollHeight - anchor.height;
    }
    anchorRef.current = { firstId: null, height: 0 };
  }, [firstVisibleId]);
  const showEarlier = () => {
    anchorRef.current = { firstId: firstVisibleId, height: scrollRef.current?.scrollHeight ?? 0 };
    if (hiddenInPane < TRANSCRIPT_WINDOW && props.hasEarlier) {
      props.onLoadEarlier();
    }
    setWindowSize((size) => size + TRANSCRIPT_WINDOW);
  };

  return (
    <section className="wp-transcript" aria-label="Conversation">
      <div className="wp-transcript-head">
        <span className={`wp-pending ${props.pendingCount ? "has" : ""}`}>{props.pendingCount ? `${props.pendingCount} pending` : "Nothing pending"}</span>
        <div className="wp-nav">
          {props.pendingCount > 1 ? (
            <>
              <button type="button" className="wp-icon-button" onClick={() => props.onNavigate(-1)} title="Previous pending suggestion (↑)" aria-label="Previous pending suggestion"><ArrowUp size={14} aria-hidden="true" /></button>
              <button type="button" className="wp-icon-button" onClick={() => props.onNavigate(1)} title="Next pending suggestion (↓)" aria-label="Next pending suggestion"><ArrowDown size={14} aria-hidden="true" /></button>
            </>
          ) : null}
          {props.turns.length ? (
            <button type="button" className="wp-icon-button" onClick={props.onNew} disabled={props.busy} title="Start a new conversation (the AI forgets earlier turns; pending suggestions and attachments stay)" aria-label="Start a new conversation"><MessageSquarePlus size={14} aria-hidden="true" /></button>
          ) : null}
          {props.turns.length ? (
            <button type="button" className="wp-icon-button" onClick={props.onClear} disabled={props.busy} title="Clear the conversation (pending suggestions are dismissed)" aria-label="Clear the conversation"><Trash2 size={14} aria-hidden="true" /></button>
          ) : null}
        </div>
      </div>
      <div className="wp-turns" ref={scrollRef}>
        {hiddenInPane || props.hasEarlier ? (
          <button type="button" className="wp-show-earlier" onClick={showEarlier} disabled={props.loadingEarlier}>
            {props.loadingEarlier ? "Loading earlier turns…" : props.hasEarlier ? "Show earlier turns" : `Show ${Math.min(hiddenInPane, TRANSCRIPT_WINDOW)} earlier turn${Math.min(hiddenInPane, TRANSCRIPT_WINDOW) === 1 ? "" : "s"}`}
          </button>
        ) : null}
        {visible.length ? visible.map((turn) => (
          <TurnView
            key={turn.id}
            activeSuggestionId={props.activeSuggestionId}
            busy={props.busy}
            cardState={props.cardState}
            hostReady={props.hostReady}
            onApply={props.onApply}
            onApplyGroup={props.onApplyGroup}
            onComment={props.onComment}
            onCycleMatch={props.onCycleMatch}
            onDismiss={props.onDismiss}
            onDiscuss={props.onDiscuss}
            onLocate={props.onLocate}
            onRestore={props.onRestore}
            suggestionById={props.suggestionById}
            trackChanges={props.trackChanges}
            turn={turn}
          />
        )) : (
          <div className="wp-empty" role="status">
            <Sparkles size={18} aria-hidden="true" />
            <strong>Start a conversation</strong>
            <span>Put the caret where you are working (or select a passage), describe the change, and send. Each reply shows what was sent and lands its suggestions right here — nothing touches the document until you apply it.</span>
          </div>
        )}
      </div>
    </section>
  );
}

function TurnView(props: {
  activeSuggestionId: string | null;
  busy: boolean;
  cardState: (suggestion: AiSuggestion) => CardState;
  hostReady: boolean;
  onApply: (suggestion: AiSuggestion) => void;
  onApplyGroup: (suggestions: AiSuggestion[]) => void;
  onComment: (suggestion: AiSuggestion) => void;
  onCycleMatch: (suggestion: AiSuggestion, direction: -1 | 1) => void;
  onDismiss: (suggestion: AiSuggestion) => void;
  onDiscuss: (suggestion: AiSuggestion, note: string) => void;
  onLocate: (suggestion: AiSuggestion) => void;
  onRestore: (suggestion: AiSuggestion) => void;
  suggestionById: (id: string) => AiSuggestion | null;
  trackChanges: "always" | "word";
  turn: ChatTurn;
}) {
  const { turn } = props;
  if (turn.role === "system") {
    return <p className={`wp-turn system ${turn.tone}`} role={turn.tone === "error" ? "alert" : "status"}>{turn.tone === "error" ? <AlertTriangle size={12} aria-hidden="true" /> : null} {turn.text}</p>;
  }
  if (turn.role === "user") {
    return (
      <article className="wp-turn user" aria-label="Your request">
        <div className="wp-turn-head"><User size={12} aria-hidden="true" /> You <time dateTime={turn.at}>{clock(turn.at)}</time></div>
        {turn.focus ? <p className="wp-turn-focus"><Sparkles size={11} aria-hidden="true" /> About {turn.focus.ref ? `${turn.focus.ref} ` : ""}"{turn.focus.title}"</p> : null}
        <p className="wp-turn-text">{turn.text}</p>
        {turn.steered ? <p className="wp-turn-steered">Sent into the running turn — the AI takes it into account in this reply</p> : null}
        {turn.sent ? <SentDetails sent={turn.sent} /> : null}
      </article>
    );
  }
  const suggestions = turn.suggestionIds.map(props.suggestionById).filter((suggestion): suggestion is AiSuggestion => suggestion !== null);
  const layout = turn.status === "done" ? parseAssistantReply(turn.text, suggestions) : null;
  const byId = new Map(suggestions.map((suggestion) => [suggestion.id, suggestion]));
  const renderCards = (ids: string[]) => {
    const cards = ids.map((id) => byId.get(id)).filter((suggestion): suggestion is AiSuggestion => Boolean(suggestion));
    return cards.length ? (
      <ol className="wp-cards">
        {cards.map((suggestion) => (
          <SuggestionCard
            key={suggestion.id}
            active={props.activeSuggestionId === suggestion.id}
            busy={props.busy}
            hostReady={props.hostReady}
            onApply={() => props.onApply(suggestion)}
            onComment={() => props.onComment(suggestion)}
            onCycleMatch={(direction) => props.onCycleMatch(suggestion, direction)}
            onDismiss={() => props.onDismiss(suggestion)}
            onDiscuss={(note) => props.onDiscuss(suggestion, note)}
            onLocate={() => props.onLocate(suggestion)}
            revisionOf={suggestion.revises ? describeRevisionOf(props.suggestionById(suggestion.revises)) : null}
            onRestore={() => props.onRestore(suggestion)}
            state={props.cardState(suggestion)}
            suggestion={suggestion}
            trackChanges={props.trackChanges}
          />
        ))}
      </ol>
    ) : null;
  };
  const applicable = (group: ReplyGroup) => group.ids
    .map((id) => byId.get(id))
    .filter((suggestion): suggestion is AiSuggestion => suggestion !== undefined)
    .filter((suggestion) => !suggestion.commentOnly && props.cardState(suggestion).outcome === null);
  const allPending = layout ? layout.groups.flatMap(applicable) : [];
  const replyApplyAll = layout && layout.groups.length > 1 && allPending.length > 1;
  return (
    <article className={`wp-turn assistant ${turn.status}`} aria-label="Writer reply">
      <div className="wp-turn-head">
        <Bot size={12} aria-hidden="true" /> {turn.engine} <time dateTime={turn.at}>{clock(turn.at)}</time>
        {turn.status === "running" ? <Loader2 size={12} className="spin" aria-hidden="true" /> : null}
      </div>
      {replyApplyAll ? (
        <div className="wp-reply-apply-all">
          <button
            type="button"
            className="wp-apply-all"
            onClick={() => props.onApplyGroup(allPending)}
            disabled={props.busy || !props.hostReady}
            title={`Apply every pending suggestion in this reply (${allPending.length}) in order, as ${props.trackChanges === "always" ? "tracked changes" : "edits"}`}
            aria-label={`Apply all ${allPending.length} in this reply`}
          >
            <Replace size={12} aria-hidden="true" /> Apply all {allPending.length} in this reply
          </button>
        </div>
      ) : null}
      {turn.status === "running" ? (
        <>
          <p className="wp-turn-text quiet" role="status">{turn.progress ?? "Working…"} <ElapsedSince at={turn.at} /></p>
          {turn.activity.length ? (
            <ol className="wp-activity live" aria-label="Tool calls so far">
              {turn.activity.slice(-4).map((entry, index) => <li key={`${entry.at}-${index}`} className={entry.kind}>{entry.summary}</li>)}
            </ol>
          ) : null}
        </>
      ) : turn.status === "error" ? (
        <p className="wp-turn-text error" role="alert">{turn.text}</p>
      ) : null}
      {turn.status !== "running" && turn.activity.length ? (
        <details className="wp-activity-log">
          <summary>{describeActivity(turn.activity)}</summary>
          <ol className="wp-activity" aria-label="Tool calls">
            {turn.activity.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className={entry.kind} title={entry.tool ?? undefined}>
                <time dateTime={entry.at}>{clock(entry.at)}</time> {entry.summary}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {layout ? layout.groups.map((group, index) => {
        const pending = applicable(group);
        return (
          <section key={index} className={`wp-reply-group ${group.heading ? "headed" : ""}`} aria-label={group.heading ?? "Reply"}>
            {group.heading || pending.length > 1 ? (
              <div className="wp-reply-group-head">
                {group.heading ? <h4>{group.heading}</h4> : <span className="wp-reply-group-spacer" />}
                {pending.length > 1 ? (
                  <button
                    type="button"
                    className="wp-apply-all"
                    onClick={() => props.onApplyGroup(pending)}
                    disabled={props.busy || !props.hostReady}
                    title={`Apply the ${pending.length} pending suggestions in this section, one after another, as ${props.trackChanges === "always" ? "tracked changes" : "edits"}`}
                    aria-label={`Apply all ${pending.length} in ${group.heading ?? "this reply"}`}
                  >
                    <Replace size={12} aria-hidden="true" /> Apply all {pending.length}
                  </button>
                ) : null}
              </div>
            ) : null}
            {group.blocks.map((block, blockIndex) => (
              block.kind === "text"
                ? <p key={blockIndex} className="wp-turn-text">{block.text}</p>
                : <div key={blockIndex}>{renderCards(block.ids)}</div>
            ))}
          </section>
        );
      }) : null}
    </article>
  );
}

function SentDetails(props: { sent: SentSummary }) {
  const { sent } = props;
  const size = sent.mode === "selection"
    ? `${sent.words.toLocaleString()} words (${sent.chars.toLocaleString()} chars${sent.from !== null && sent.to !== null ? `, offsets ${sent.from.toLocaleString()}–${sent.to.toLocaleString()}` : ""}) of ${sent.documentWords.toLocaleString()}`
    : `whole document · ${sent.documentWords.toLocaleString()} words (${sent.documentChars.toLocaleString()} chars)`;
  const contextBits = [
    sent.context.cursor ? `caret ${sent.context.cursor}` : null,
    sent.context.heading ? `under "${sent.context.heading}"` : null,
    sent.context.viewport,
    sent.context.selectionWords !== null && sent.mode === "global" ? `${sent.context.selectionWords} words selected` : null,
    sent.context.trail ? `${sent.context.trail} recent stop${sent.context.trail === 1 ? "" : "s"}` : null,
    sent.context.outline ? `${sent.context.outline} heading${sent.context.outline === 1 ? "" : "s"}` : null
  ].filter((bit): bit is string => Boolean(bit));
  return (
    <details className="wp-sent">
      <summary title="What was sent to the AI for this request">
        <Send size={11} aria-hidden="true" /> Sent {sent.scopeLabel}{sent.attachments.length ? ` + ${sent.attachments.length} file${sent.attachments.length === 1 ? "" : "s"}` : ""} · {sent.engine}
      </summary>
      <dl>
        <dt>Text</dt>
        <dd>{size}</dd>
        {sent.excerptStart ? (
          <>
            <dt>Excerpt</dt>
            <dd className="wp-sent-excerpt">“{sent.excerptStart}{sent.excerptEnd ? ` … ${sent.excerptEnd}` : ""}”</dd>
          </>
        ) : null}
        <dt>Window state</dt>
        <dd>{contextBits.length ? contextBits.join(" · ") : "none"}</dd>
        {sent.conversationTurns ? (
          <>
            <dt>Memory</dt>
            <dd>{sent.conversationTurns} earlier turn{sent.conversationTurns === 1 ? "" : "s"} with your decisions{sent.resumed ? " · provider session resumed" : ""}</dd>
          </>
        ) : null}
        {sent.attachments.length ? (
          <>
            <dt>Attachments</dt>
            <dd>{sent.attachments.map((attachment) => `${attachment.name} (${formatChars(attachment.chars)}${attachment.truncated ? ", truncated" : ""})`).join(" · ")}</dd>
          </>
        ) : null}
        <dt>Engine</dt>
        <dd>{sent.engine}</dd>
        {sent.documentName ? (
          <>
            <dt>Document</dt>
            <dd>{sent.documentName}</dd>
          </>
        ) : null}
      </dl>
    </details>
  );
}

/** Ticking "42s" next to a running turn: the request has no time limit, so show that it is still alive. */
function ElapsedSince(props: { at: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="wp-elapsed" aria-label="elapsed">{formatElapsedSince(props.at, now)}</span>;
}

function StatusLine(props: { notice: Notice | null; busyLabel: string | null }) {
  if (props.busyLabel) {
    return <p className="wp-statusline pending" role="status"><Loader2 size={13} className="spin" aria-hidden="true" /> {props.busyLabel}</p>;
  }
  if (props.notice) {
    return <p className={`wp-statusline ${props.notice.tone}`} role={props.notice.tone === "error" ? "alert" : "status"}>{props.notice.text}</p>;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

function SettingsPanel(props: {
  capabilityRows: CapabilityRow[];
  modelControls: ModelControls;
  onSettingsChange: (patch: Partial<WordPaneProps["settings"]>) => void;
  settings: WordPaneProps["settings"];
  tracksChanges: boolean;
}) {
  const catalog = props.modelControls.catalog;
  return (
    <section className="wp-settings" aria-label="Settings and diagnostics">
      <label className="wp-field">
        <span>Your name (recorded on applied changes)</span>
        <input type="text" value={props.settings.requesterName} onChange={(event) => props.onSettingsChange({ requesterName: event.currentTarget.value })} maxLength={80} />
      </label>
      <label className="wp-field">
        <span>Applying a suggestion</span>
        <select value={props.settings.trackChanges} onChange={(event) => props.onSettingsChange({ trackChanges: event.currentTarget.value as "always" | "word" })}>
          <option value="always">Always as a tracked change</option>
          <option value="word">Follow Word's Track Changes setting</option>
        </select>
      </label>
      <label className="wp-field">
        <span>Tools the AI may use</span>
        <select value={props.settings.toolAccess} onChange={(event) => props.onSettingsChange({ toolAccess: event.currentTarget.value as AiToolAccess })} aria-label="Tools the AI may use">
          {AI_TOOL_ACCESS_LEVELS.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
        </select>
        <small className="wp-field-detail">{AI_TOOL_ACCESS_LEVELS.find((level) => level.id === props.settings.toolAccess)?.detail}</small>
      </label>
      <label className="wp-toggle">
        <input type="checkbox" checked={props.settings.shareWithAgents} onChange={(event) => props.onSettingsChange({ shareWithAgents: event.currentTarget.checked })} />
        <span>Share this document and my position with Writer agents (terminal / MCP)</span>
      </label>
      {props.tracksChanges ? null : (
        <label className="wp-toggle">
          <input type="checkbox" checked={props.settings.highlightChanges} onChange={(event) => props.onSettingsChange({ highlightChanges: event.currentTarget.checked })} />
          <span>Highlight the text Writer changes in the document</span>
        </label>
      )}
      <label className="wp-toggle">
        <input type="checkbox" checked={props.settings.mirrorChat} onChange={(event) => props.onSettingsChange({ mirrorChat: event.currentTarget.checked })} />
        <span>Mirror this conversation into the shared Writer session</span>
      </label>
      {catalog ? (
        <div className="wp-catalog-info">
          <strong>{catalog.provider === "codex" ? "Codex" : "Claude Code"} {catalog.version ?? ""}</strong>
          <span>Default: {catalog.defaults.model ?? "CLI default"}{catalog.defaults.reasoning ? ` · ${catalog.defaults.reasoning}` : ""}{catalog.defaults.source ? ` (${shortPath(catalog.defaults.source)})` : ""}</span>
          <span>
            {catalog.models.length} model{catalog.models.length === 1 ? "" : "s"}{catalog.reasoning ? ` · ${catalog.reasoning.levels.length} reasoning levels via ${catalog.reasoning.control === "effort" ? "--effort" : "model_reasoning_effort"}` : " · no reasoning control"} · discovered {clock(catalog.discoveredAt)} ·{" "}
            <button type="button" className="wp-link-button" onClick={props.modelControls.onRefresh} disabled={props.modelControls.loading} aria-label="Rediscover models" title="Re-read the model list from the installed CLIs (it also refreshes on its own when a CLI updates)">
              {props.modelControls.loading ? "rediscovering…" : "rediscover"}
            </button>
          </span>
          {catalog.notes.map((note) => <span key={note} className="quiet">{note}</span>)}
        </div>
      ) : null}
      <ul className="wp-caps" aria-label="Capabilities">
        {props.capabilityRows.map((row) => (
          <li key={row.label} className={row.ok ? "ok" : ""}>
            {row.ok ? <Check size={12} aria-hidden="true" /> : <AlertTriangle size={12} aria-hidden="true" />}
            <strong>{row.label}</strong>
            <span>{row.detail}</span>
          </li>
        ))}
      </ul>
      <p className="wp-hint">Keys: ↑/↓ move between pending · ↩ locate · A apply · C comment · X dismiss · ⌘↩ send.</p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Suggestion card                                                            */
/* -------------------------------------------------------------------------- */

function SuggestionCard(props: {
  active: boolean;
  busy: boolean;
  hostReady: boolean;
  onApply: () => void;
  onComment: () => void;
  onCycleMatch: (direction: -1 | 1) => void;
  onDismiss: () => void;
  onLocate: () => void;
  onDiscuss: (note: string) => void;
  onRestore: () => void;
  /** "S3 Tighten the opening claim" when this card revises an earlier one. */
  revisionOf?: string | null;
  state: CardState;
  suggestion: AiSuggestion;
  trackChanges: "always" | "word";
}) {
  const { suggestion, state } = props;
  const handled = state.outcome !== null;
  const deletion = !suggestion.commentOnly && suggestion.replacement.trim() === "";
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"original" | "revised" | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const sendNote = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    props.onDiscuss(trimmed);
    setNote("");
    setNoteOpen(false);
  };
  const copy = async (which: "original" | "revised") => {
    const ok = await copyText(which === "original" ? suggestion.original : suggestion.replacement);
    setCopied(ok ? which : null);
    window.setTimeout(() => setCopied(null), 1500);
  };
  if (handled) {
    // The record of what was proposed stays available after the decision —
    // the author often keeps editing after accepting and wants to look back.
    return (
      <li className={`wp-card handled ${open ? "open" : ""}`} data-suggestion-id={suggestion.id} aria-label={`Handled suggestion: ${suggestion.title || "Suggested revision"}`}>
        <div className="wp-card-outcome">
          <span>
            {state.outcome === "applied" ? <Check size={12} aria-hidden="true" /> : state.outcome === "commented" ? <MessageSquarePlus size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />}
            <strong>{suggestion.title || "Suggested revision"}</strong> — {outcomeLabel(state.outcome)}{state.detail ? ` · ${state.detail}` : ""}
          </span>
          <span className="wp-outcome-actions">
            {state.outcome === "dismissed" ? (
              <button type="button" className="wp-text-button" onClick={props.onRestore} disabled={props.busy}><RotateCcw size={12} aria-hidden="true" /> Restore</button>
            ) : null}
            <button type="button" className="wp-text-button" onClick={() => setOpen((current) => !current)} aria-expanded={open} title={open ? "Hide the proposed change" : "Show what was proposed: the original and the revised text"}>
              {open ? <ChevronLeft size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />} {open ? "Hide change" : "Show change"}
            </button>
          </span>
        </div>
        {open ? (
          <div className="wp-card-body">
            <SuggestionText suggestion={suggestion} expanded={expanded} onToggle={() => setExpanded((current) => !current)} />
            <p className="wp-rationale">{tidy(suggestion.rationale)}</p>
            <div className="wp-card-actions" onClick={(event) => event.stopPropagation()}>
              <button type="button" onClick={props.onLocate} disabled={props.busy || !props.hostReady} title={state.outcome === "applied" && !deletion ? "Select the revised text in the document" : "Select this passage in the document"}><Crosshair size={13} aria-hidden="true" /> Locate</button>
              <button type="button" onClick={() => void copy("original")} title="Copy the original text to the clipboard"><Copy size={13} aria-hidden="true" /> {copied === "original" ? "Copied" : "Copy original"}</button>
              {suggestion.commentOnly || deletion ? null : (
                <button type="button" onClick={() => void copy("revised")} title="Copy the revised text to the clipboard"><Copy size={13} aria-hidden="true" /> {copied === "revised" ? "Copied" : "Copy revised"}</button>
              )}
            </div>
          </div>
        ) : null}
      </li>
    );
  }
  return (
    <li
      className={`wp-card ${props.active ? "active" : ""}`}
      data-suggestion-id={suggestion.id}
      tabIndex={0}
      onClick={props.onLocate}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault();
          props.onLocate();
        }
      }}
      aria-label={`Suggestion: ${suggestion.title || "Suggested revision"}`}
      aria-current={props.active ? "true" : undefined}
    >
      <div className="wp-card-top">
        <h3>{suggestion.title || "Suggested revision"}</h3>
        <span className="wp-confidence" title="The provider's own estimate of how safe this edit is">{confidenceLabel(suggestion.confidence)}</span>
      </div>
      <p className="wp-card-meta">
        {props.revisionOf ? <span className="tag revision" title="Written after your feedback on the earlier suggestion">Revision of {props.revisionOf}</span> : null}
        {suggestion.proposedBy ? <span>{suggestion.proposedBy}</span> : null}
        {suggestion.commentOnly ? <span className="tag">advisory</span> : deletion ? <span className="tag">deletion</span> : null}
        {state.heading ? <span title="Section in Word">§ {state.heading}</span> : null}
        {state.paragraphIndex !== null ? <span>¶ {state.paragraphIndex + 1}</span> : null}
        {state.matches !== null && state.matches > 1 ? (
          <span className="wp-match" title="This text appears more than once — pick the occurrence to act on">
            <button type="button" className="wp-icon-button tiny" onClick={(event) => { event.stopPropagation(); props.onCycleMatch(-1); }} aria-label="Previous occurrence"><ChevronLeft size={12} aria-hidden="true" /></button>
            match {state.matchIndex + 1}/{state.matches}
            <button type="button" className="wp-icon-button tiny" onClick={(event) => { event.stopPropagation(); props.onCycleMatch(1); }} aria-label="Next occurrence"><ChevronRight size={12} aria-hidden="true" /></button>
          </span>
        ) : state.matches === 0 ? <span className="tag warn">not found in document</span> : null}
      </p>
      <SuggestionText suggestion={suggestion} expanded={expanded} onToggle={() => setExpanded((current) => !current)} />
      <p className="wp-rationale">{tidy(suggestion.rationale)}</p>
      {state.error ? <p className="wp-card-error" role="alert"><AlertTriangle size={12} aria-hidden="true" /> {state.error}</p> : null}
      <div className="wp-card-actions" onClick={(event) => event.stopPropagation()}>
        <button type="button" onClick={props.onLocate} disabled={props.busy || !props.hostReady} title="Select this passage in the document"><Crosshair size={13} aria-hidden="true" /> Locate</button>
        {suggestion.commentOnly ? null : (
          <button type="button" className="primary" onClick={props.onApply} disabled={props.busy || !props.hostReady} title={props.trackChanges === "always" ? "Replace the text as a Word tracked change" : "Replace the text (tracked if Word's Track Changes is on)"}>
            <Replace size={13} aria-hidden="true" /> Apply
          </button>
        )}
        <button type="button" className={noteOpen ? "active" : ""} onClick={() => setNoteOpen((current) => !current)} disabled={props.busy} aria-expanded={noteOpen} title="Comment on this change — say what to keep or change and Writer replies with a revised suggestion"><MessageSquareText size={13} aria-hidden="true" /> Comment</button>
        <button type="button" className="quiet" onClick={props.onComment} disabled={props.busy || !props.hostReady} title="Leave the suggestion as a Word comment on this passage" aria-label="Leave as a Word comment"><MessageSquarePlus size={13} aria-hidden="true" /></button>
        <button type="button" className="quiet" onClick={props.onDismiss} disabled={props.busy} title="Dismiss (recorded as rejected)"><X size={13} aria-hidden="true" /></button>
      </div>
      {noteOpen ? (
        <div className="wp-card-note" onClick={(event) => event.stopPropagation()}>
          <textarea
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            placeholder="What should change? e.g. keep the citation, shorter, a different angle…"
            aria-label="Your note about this change"
            rows={2}
            autoFocus
            disabled={props.busy}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                sendNote(note);
              }
            }}
          />
          <div className="wp-card-note-actions">
            {QUICK_REFINEMENTS.map((quick) => (
              <button key={quick.label} type="button" className="wp-text-button" onClick={() => sendNote(quick.instruction)} disabled={props.busy} title={quick.instruction}>{quick.label}</button>
            ))}
            <button type="button" className="primary" onClick={() => sendNote(note)} disabled={props.busy || !note.trim()} aria-label="Send this note about the change" title="Send (⌘↩)"><Send size={12} aria-hidden="true" /> Send</button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function describeActivity(activity: AiActivityEntry[]): string {
  const tools = activity.filter((entry) => entry.kind === "tool").length;
  const reads = activity.filter((entry) => entry.kind === "tool" && /^Reading|^Searching/.test(entry.summary)).length;
  const stages = activity.filter((entry) => entry.kind === "tool" && /^Staging/.test(entry.summary)).length;
  const parts = [reads ? `${reads} read${reads === 1 ? "" : "s"}` : null, stages ? `${stages} staging call${stages === 1 ? "" : "s"}` : null].filter(Boolean);
  return `${tools} tool call${tools === 1 ? "" : "s"}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}

function outcomeLabel(outcome: CardOutcome): string {
  switch (outcome) {
    case "applied":
      return "applied in Word";
    case "commented":
      return "left as a Word comment";
    case "dismissed":
      return "dismissed";
    case "decided-elsewhere":
      return "decided in Writer";
    case "revised":
      return "revised";
    default:
      return "";
  }
}

function groupPresets(presets: PresetOption[]): Array<{ name: string; items: PresetOption[] }> {
  const groups = new Map<string, PresetOption[]>();
  for (const preset of presets) {
    const list = groups.get(preset.group) ?? [];
    list.push(preset);
    groups.set(preset.group, list);
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
}

function confidenceLabel(confidence: number): string {
  if (!Number.isFinite(confidence)) {
    return "—";
  }
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
}

/** Collapse runs of spaces but keep paragraph breaks, which the card shows as ¶. */
const QUICK_REFINEMENTS: ReadonlyArray<{ label: string; instruction: string }> = [
  { label: "Shorter", instruction: "Make this suggestion shorter while keeping its point." },
  { label: "Keep my wording", instruction: "Keep my original wording wherever it already works; change only what is necessary." },
  { label: "Different angle", instruction: "Try a different approach to this passage — a different structure or emphasis, not a light edit." }
];

function describeRevisionOf(earlier: AiSuggestion | null): string {
  if (!earlier) {
    return "an earlier suggestion";
  }
  return `${earlier.ref ? `${earlier.ref} ` : ""}${earlier.title || "Suggested revision"}`;
}

/** Whitespace-normalised, never truncated: the card is where the whole proposed change is read. */
function tidy(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/\n+/g, "\n").trim();
}

/** Changes longer than this start folded, with a control that reveals all of it. */
const LONG_CHANGE_CHARS = 900;

/** The proposed change itself: an inline word diff when one reads well, else the original and the revised text in full. */
function SuggestionText(props: { suggestion: AiSuggestion; expanded: boolean; onToggle: () => void }) {
  const { suggestion } = props;
  if (suggestion.kind === "image" && suggestion.image) {
    const image = suggestion.image;
    return (
      <figure className="wp-image-change">
        {image.originalUrl ? <img src={image.originalUrl} alt="Current picture" /> : <span className="wp-image-missing">current picture</span>}
        <span className="wp-image-arrow" aria-hidden="true">→</span>
        <img src={image.url} alt="Proposed picture" />
        <figcaption>{suggestion.original}</figcaption>
      </figure>
    );
  }
  const deletion = !suggestion.commentOnly && suggestion.replacement.trim() === "";
  // Emphasis rides as per-word markers through the diff and renders as real bold/italic/underline/highlight.
  const sides = markedSides(suggestion);
  const segments = suggestion.commentOnly ? null : wordDiffSegments(sides.original, sides.replacement);
  const length = suggestion.original.length + suggestion.replacement.length;
  const long = length > LONG_CHANGE_CHARS;
  const clamped = long && !props.expanded;
  const body = suggestion.commentOnly ? (
    <blockquote className="wp-quote">{renderMarked(tidy(sides.original), withParagraphBreaks)}</blockquote>
  ) : segments ? (
    <p className="wp-diff">
      {segments.map((segment, index) => (
        segment.type === "same"
          ? <span key={index}>{renderMarked(segment.text, withParagraphBreaks)}</span>
          : segment.type === "del"
            ? <del key={index}>{renderMarked(segment.text, withParagraphBreaks)}</del>
            : <ins key={index}>{renderMarked(segment.text, withParagraphBreaks)}</ins>
      ))}
    </p>
  ) : (
    <div className="wp-diff-blocks">
      <p className="original"><del>{renderMarked(tidy(sides.original), withParagraphBreaks)}</del></p>
      {deletion ? <p className="replacement quiet">(delete this text)</p> : <p className="replacement"><ins>{renderMarked(tidy(sides.replacement), withParagraphBreaks)}</ins></p>}
    </div>
  );
  return (
    <>
      <div className={`wp-change ${clamped ? "clamped" : ""}`}>{body}</div>
      {long ? (
        <button type="button" className="wp-text-button wp-change-toggle" onClick={(event) => { event.stopPropagation(); props.onToggle(); }} aria-expanded={props.expanded}>
          {props.expanded ? "Show less" : `Show the full change (${length.toLocaleString()} characters)`}
        </button>
      ) : null}
    </>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based copy (older webviews).
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Render "\n" inside suggestion text as a visible paragraph mark plus a line break. */
function withParagraphBreaks(text: string): ReactNode {
  const parts = text.split("\n");
  if (parts.length === 1) {
    return text;
  }
  return parts.map((part, index) => (
    <span key={index}>
      {index > 0 ? <><span className="wp-para-break" title="paragraph break">¶</span><br /></> : null}
      {part}
    </span>
  ));
}

function formatChars(chars: number): string {
  return chars >= 10_000 ? `${Math.round(chars / 1000)}k chars` : `${chars.toLocaleString()} chars`;
}

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}
