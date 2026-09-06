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
  Crosshair,
  Eye,
  FileText,
  Loader2,
  MapPin,
  MessageSquarePlus,
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
  X
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AiActivityEntry, AiAttachment, AiModelChoice, AiProviderCatalog, AiReasoningChoice, AiSuggestion, LocalAiProviderName } from "../shared";
import { wordDiffSegments } from "../wordDiff";
import { parseAssistantReply, type ReplyGroup } from "./replyLayout";
import type { RequestScope } from "./wordContext";

export type HostStatus = "booting" | "ready" | "unavailable";
export type SidecarStatus = "checking" | "ok" | "offline";
export type RequestState = "idle" | "running" | "done" | "empty" | "error";
export type CardOutcome = "applied" | "commented" | "dismissed" | "decided-elsewhere" | null;

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
  | { id: string; role: "user"; at: string; text: string; sent: SentSummary }
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
  onComment: (suggestion: AiSuggestion) => void;
  onCycleMatch: (suggestion: AiSuggestion, direction: -1 | 1) => void;
  onDismiss: (suggestion: AiSuggestion) => void;
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
  settings: { requesterName: string; trackChanges: "always" | "word"; shareWithAgents: boolean; mirrorChat: boolean };
  sidecarDetail: string;
  sidecarStatus: SidecarStatus;
  suggestionById: (id: string) => AiSuggestion | null;
  turns: ChatTurn[];
}

export function WordPane(props: WordPaneProps) {
  const running = props.requestState === "running";
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <div className="wp-shell">
      <header className="wp-header">
        <div className="wp-brand">
          <span className="wp-brand-mark" aria-hidden="true">N</span>
          <div>
            <p className="wp-eyebrow">Nebula Writer</p>
            <h1>Word review pane</h1>
          </div>
        </div>
        <div className="wp-status-pills">
          <StatusPill
            tone={props.hostStatus === "ready" ? "ok" : props.hostStatus === "booting" ? "pending" : "warn"}
            label={props.hostStatus === "ready" ? "Word" : props.hostStatus === "booting" ? "Word…" : "No Word"}
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
        <SettingsPanel capabilityRows={props.capabilityRows} modelControls={props.modelControls} onSettingsChange={props.onSettingsChange} settings={props.settings} />
      ) : null}

      <Transcript
        activeSuggestionId={props.activeSuggestionId}
        busy={Boolean(props.busyLabel)}
        cardState={props.cardState}
        hostReady={props.hostStatus === "ready"}
        onApply={props.onApply}
        onApplyGroup={props.onApplyGroup}
        onClear={props.onClearConversation}
        onComment={props.onComment}
        onCycleMatch={props.onCycleMatch}
        onDismiss={props.onDismiss}
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
        <form
          className="wp-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (running) {
              props.onStop();
            } else {
              props.onAsk();
            }
          }}
        >
          <textarea
            value={props.instruction}
            onChange={(event) => props.onInstructionChange(event.currentTarget.value)}
            placeholder="Tighten this paragraph… / Sharpen the visible pages for reviewers… / Review the whole Aims page"
            aria-label="Instruction for Writer"
            rows={3}
            disabled={running}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                if (props.canAsk) {
                  props.onAsk();
                }
              }
            }}
          />
          <button
            type="submit"
            className={`wp-send ${running ? "stop" : ""}`}
            disabled={!running && !props.canAsk}
            aria-label={running ? "Stop the request" : "Send to Writer (⌘↩)"}
            title={running ? "Stop" : "Send (⌘↩)"}
          >
            {running ? <Square size={15} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
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
  onComment: (suggestion: AiSuggestion) => void;
  onCycleMatch: (suggestion: AiSuggestion, direction: -1 | 1) => void;
  onDismiss: (suggestion: AiSuggestion) => void;
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
  useEffect(() => {
    const element = scrollRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lastTurnId]);

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
            <button type="button" className="wp-icon-button" onClick={props.onClear} disabled={props.busy} title="Clear the conversation (pending suggestions are dismissed)" aria-label="Clear the conversation"><Trash2 size={14} aria-hidden="true" /></button>
          ) : null}
        </div>
      </div>
      <div className="wp-turns" ref={scrollRef}>
        {props.turns.length ? props.turns.map((turn) => (
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
        <p className="wp-turn-text">{turn.text}</p>
        <SentDetails sent={turn.sent} />
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
            onLocate={() => props.onLocate(suggestion)}
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
          <p className="wp-turn-text quiet" role="status">{turn.progress ?? "Working…"}</p>
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
      <label className="wp-toggle">
        <input type="checkbox" checked={props.settings.shareWithAgents} onChange={(event) => props.onSettingsChange({ shareWithAgents: event.currentTarget.checked })} />
        <span>Share this document and my position with Writer agents (terminal / MCP)</span>
      </label>
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
  onRestore: () => void;
  state: CardState;
  suggestion: AiSuggestion;
  trackChanges: "always" | "word";
}) {
  const { suggestion, state } = props;
  const handled = state.outcome !== null;
  const segments = suggestion.commentOnly ? null : wordDiffSegments(suggestion.original, suggestion.replacement);
  const deletion = !suggestion.commentOnly && suggestion.replacement.trim() === "";
  if (handled) {
    return (
      <li className="wp-card handled" data-suggestion-id={suggestion.id} aria-label={`Handled suggestion: ${suggestion.title || "Suggested revision"}`}>
        <div className="wp-card-outcome">
          <span>
            {state.outcome === "applied" ? <Check size={12} aria-hidden="true" /> : state.outcome === "commented" ? <MessageSquarePlus size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />}
            <strong>{suggestion.title || "Suggested revision"}</strong> — {outcomeLabel(state.outcome)}{state.detail ? ` · ${state.detail}` : ""}
          </span>
          {state.outcome === "dismissed" ? (
            <button type="button" className="wp-text-button" onClick={props.onRestore} disabled={props.busy}><RotateCcw size={12} aria-hidden="true" /> Restore</button>
          ) : null}
        </div>
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
        ) : state.matches === 0 ? <span className="tag warn">not found in Word</span> : null}
      </p>
      {suggestion.commentOnly ? (
        <blockquote className="wp-quote">{withParagraphBreaks(compact(suggestion.original, 320))}</blockquote>
      ) : segments ? (
        <p className="wp-diff">
          {segments.map((segment, index) => (
            segment.type === "same"
              ? <span key={index}>{withParagraphBreaks(segment.text)}</span>
              : segment.type === "del"
                ? <del key={index}>{withParagraphBreaks(segment.text)}</del>
                : <ins key={index}>{withParagraphBreaks(segment.text)}</ins>
          ))}
        </p>
      ) : (
        <div className="wp-diff-blocks">
          <p className="original"><del>{withParagraphBreaks(compact(suggestion.original, 320))}</del></p>
          {deletion ? <p className="replacement quiet">(delete this text)</p> : <p className="replacement"><ins>{withParagraphBreaks(compact(suggestion.replacement, 320))}</ins></p>}
        </div>
      )}
      <p className="wp-rationale">{compact(suggestion.rationale, 360)}</p>
      {state.error ? <p className="wp-card-error" role="alert"><AlertTriangle size={12} aria-hidden="true" /> {state.error}</p> : null}
      <div className="wp-card-actions" onClick={(event) => event.stopPropagation()}>
        <button type="button" onClick={props.onLocate} disabled={props.busy || !props.hostReady} title="Select this passage in Word"><Crosshair size={13} aria-hidden="true" /> Locate</button>
        {suggestion.commentOnly ? null : (
          <button type="button" className="primary" onClick={props.onApply} disabled={props.busy || !props.hostReady} title={props.trackChanges === "always" ? "Replace the text as a Word tracked change" : "Replace the text (tracked if Word's Track Changes is on)"}>
            <Replace size={13} aria-hidden="true" /> Apply
          </button>
        )}
        <button type="button" onClick={props.onComment} disabled={props.busy || !props.hostReady} title="Leave the suggestion as a Word comment on this passage"><MessageSquarePlus size={13} aria-hidden="true" /> Comment</button>
        <button type="button" className="quiet" onClick={props.onDismiss} disabled={props.busy} title="Dismiss (recorded as rejected)"><X size={13} aria-hidden="true" /></button>
      </div>
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
function compact(text: string, maxLength: number): string {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/\n+/g, "\n").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
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
