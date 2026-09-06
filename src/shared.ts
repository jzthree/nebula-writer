export type AiProviderName = "demo" | "codex" | "claude";
export type LocalAiProviderName = "codex" | "claude";

export const AI_CONTEXT_CHAR_LIMIT = 120_000;

// True only for origins served from the viewer's own machine. Repo-based
// setup instructions ("npm run sidecar") assume the Nebula Writer checkout is
// present, which is only guaranteed when this page came from a local dev
// server. Any hosted origin (a cloud domain, a LAN IP a collaborator opened)
// must instead guide from git clone.
export function isLocalHostname(hostname: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(hostname.trim());
}

export type SuggestionStatus = "pending" | "accepted" | "rejected";

export interface SelectionContext {
  from: number;
  to: number;
  text: string;
}

/**
 * Reference file attached to an AI request. The file itself stays on the
 * machine that runs the CLI (the sidecar saves uploads under its tmp dir);
 * the extracted text travels in the request so providers whose tools are
 * disabled can still read it, and the path is included for providers that
 * can open files themselves.
 */
export interface AiAttachment {
  name: string;
  /** Absolute path on the sidecar machine. */
  path: string;
  /** Extracted text, capped at the attachment budget. */
  text: string;
  truncated?: boolean;
}

export const AI_ATTACHMENT_LIMIT = 8;
export const AI_ATTACHMENT_TEXT_CHAR_LIMIT = 40_000;
export const AI_ATTACHMENTS_TOTAL_CHAR_LIMIT = 80_000;

export interface AiRequest {
  provider: AiProviderName;
  instruction: string;
  mode: "global" | "selection";
  documentHtml?: string;
  documentText: string;
  maxSuggestions?: number | null;
  selection?: SelectionContext | null;
  stageSuggestions?: boolean;
  /** Collaborator (or agent) who asked, shown to everyone while the AI runs. */
  requestedBy?: string | null;
  /** Document room id; cloud deployments route the request with it. */
  docId?: string;
  /** Reference files the user attached in the chat. */
  attachments?: AiAttachment[];
  /**
   * Provider conversation to resume (agentic engine). The web app keeps one
   * per document+provider so follow-up chat messages share context.
   */
  agentSessionId?: string | null;
  /**
   * Live state of the host application's window (currently the Word add-in):
   * where the cursor is, what is selected, which pages are on screen, and
   * where the user has recently been. Lets the agent act on "this paragraph"
   * and prioritize the passage the author is actually looking at.
   */
  hostContext?: WordHostContext | null;
  /** Model / reasoning-level override for this run (null = the CLI's own default). */
  modelOptions?: AiModelOptions | null;
  /**
   * The conversation so far, oldest first, including what the user did with
   * earlier suggestions. Sent by chat-style clients so a follow-up ("make it
   * shorter", "same for Aim 2") has its referent even when the CLI session
   * could not be resumed.
   */
  conversation?: AiConversationTurn[];
}

export interface AiConversationDecision {
  ref?: string | null;
  title: string;
  status: "pending" | "applied" | "commented" | "dismissed" | "decided-elsewhere";
  note?: string | null;
}

export interface AiConversationTurn {
  role: "user" | "assistant";
  content: string;
  /** For assistant turns: what happened to each suggestion it staged. */
  decisions?: AiConversationDecision[];
}

/** Per-request model selection, passed straight to the CLI (--model/--effort or -m/-c). */
export interface AiModelOptions {
  model?: string | null;
  reasoning?: string | null;
}

export interface AiModelChoice {
  id: string;
  label: string;
  description?: string | null;
  /** Where this choice was discovered: the CLI's catalog, a documented alias, the binary, the user's settings, or typed in. */
  source: "catalog" | "alias" | "binary" | "settings" | "custom";
  /** Reasoning levels this model supports when the catalog says so; null = provider-wide list applies. */
  reasoningLevels?: string[] | null;
  defaultReasoning?: string | null;
  hidden?: boolean;
}

export interface AiReasoningChoice {
  id: string;
  label: string;
  description?: string | null;
}

/** What one installed CLI offers right now — discovered, not hard-coded, so it follows CLI updates. */
export interface AiProviderCatalog {
  provider: LocalAiProviderName;
  available: boolean;
  version: string | null;
  path: string | null;
  models: AiModelChoice[];
  reasoning: { control: "effort" | "model_reasoning_effort"; levels: AiReasoningChoice[] } | null;
  /** What the CLI uses when nothing is chosen, and where that default was read from. */
  defaults: { model: string | null; reasoning: string | null; source: string | null };
  allowsCustomModel: boolean;
  discoveredAt: string;
  notes: string[];
}

export interface AiCatalogResponse {
  providers: AiProviderCatalog[];
  refreshed: boolean;
}

export interface AiSuggestion {
  commentOnly?: boolean;
  /** Sidecar instance that staged this suggestion — the origin's clients own
   * the inline-landing claim on shared docs, so two Writers never race. */
  origin?: string | null;
  id: string;
  title: string;
  original: string;
  replacement: string;
  rationale: string;
  confidence: number;
  target: "global" | "selection";
  range?: SelectionContext | null;
  /** For inline-mark cards: the changeIds of the marks this card covers, so
   * resolution touches exactly these marks even when another author's
   * suggestion overlaps the same text. */
  markChangeIds?: string[];
  status: SuggestionStatus;
  /** Collaborator or agent whose request produced this suggestion. */
  proposedBy?: string | null;
  /** Short handle (S1, S2, …) the proposing agent can use to place this suggestion inside its reply. */
  ref?: string;
  /** Who accepted/rejected this suggestion (collaborator name or agent label). */
  decidedBy?: string | null;
  /** Optional reviewer note on the decision (e.g. why it was rejected) — feedback agents read for their next round. */
  decisionNote?: string | null;
  /** When the accept/reject decision was recorded (ISO timestamp). */
  decidedAt?: string | null;
}

export interface AiResponse {
  message: string;
  suggestions: AiSuggestion[];
  provider: AiProviderName;
  stagedInSession?: boolean;
  /** Conversation id to pass back as agentSessionId on the next request. */
  agentSessionId?: string | null;
  /** The model/reasoning override the run was made with, echoed for the UI. */
  modelOptions?: AiModelOptions | null;
  /** Tool calls and status steps of an agentic run, in order. */
  activity?: AiActivityEntry[];
}

export interface WordLiveSuggestionRequest extends AiRequest {
  documentName?: string | null;
}

export interface WordLiveSuggestionResponse {
  ai: AiResponse;
  session: WriterSessionSummary;
  sessionReused: boolean;
}

/* ---------------------------------------------------------------------------
 * Word add-in window state ("host context")
 *
 * The task pane captures this from Office.js and sends it with every AI
 * request and, while the pane is open, pushes it to the sidecar so terminal
 * and MCP agents working the same document see where the author is. Every
 * offset is a character offset into `documentText` (the add-in's normalized
 * body text), so an agent can jump straight to the right window with
 * writer_read_document(offset, limit).
 * ------------------------------------------------------------------------- */

export const WORD_HOST_CONTEXT_LIMITS = {
  /** Characters kept for excerpts (viewport edges, focus trail, headings). */
  excerpt: 200,
  /** Characters kept for the cursor paragraph text. */
  paragraphText: 600,
  /** Characters kept for the cursor sentence. */
  sentence: 400,
  /** Most recent distinct places the author paused at. */
  recentFocus: 8,
  /** Document headings kept for orientation. */
  outline: 80
} as const;

export interface WordHostContextCursor {
  /** Character offset of the caret (selection start) in documentText. */
  offset: number;
  /** 0-based index into the add-in's paragraph list, null if unresolved. */
  paragraphIndex: number | null;
  /** Text of the paragraph containing the caret (bounded). */
  paragraphText: string | null;
  /** Sentence containing the caret (bounded). */
  sentence: string | null;
}

export interface WordHostContextSection {
  heading: string;
  /** Heading level 1-9 when known. */
  level: number | null;
  paragraphIndex: number;
  offset: number;
}

export interface WordHostContextViewport {
  /** Offset range of the text on the pages currently visible in Word. */
  from: number;
  to: number;
  /** 1-based Word page indexes shown in the window. */
  pages: number[];
  /** First words visible (bounded). */
  leadingText: string;
  /** Last words visible (bounded). */
  trailingText: string;
}

export interface WordHostContextFocusEntry {
  offset: number;
  paragraphIndex: number;
  excerpt: string;
  heading: string | null;
  /** ISO timestamp of when the author paused there. */
  at: string;
}

export interface WordHostContextOutlineEntry {
  heading: string;
  level: number | null;
  paragraphIndex: number;
  offset: number;
}

/** Compact paragraph index the pane pushes so agents can read by structure (paragraph / section). */
export interface WordHostContextParagraph {
  offset: number;
  length: number;
  /** Heading level 1-9, null for body text. */
  level: number | null;
  style?: string | null;
}

export interface WordHostContext {
  source: "word-addin";
  documentName: string | null;
  capturedAt: string;
  documentLength: number;
  paragraphCount: number;
  /** Non-collapsed selection, verbatim from documentText. */
  selection: SelectionContext | null;
  cursor: WordHostContextCursor | null;
  /** Nearest heading above the cursor. */
  section: WordHostContextSection | null;
  /** Pages on screen (null when the host cannot report the viewport). */
  viewport: WordHostContextViewport | null;
  /** Where the author has recently paused, most recent last. */
  recentFocus: WordHostContextFocusEntry[];
  /** Headings of the document for orientation (bounded). */
  outline: WordHostContextOutlineEntry[];
  /** Word's change-tracking mode ("Off" | "TrackAll" | "TrackMineOnly") when readable. */
  changeTrackingMode: string | null;
  /** Every paragraph's offset/length/heading level (not rendered into prompts; used by writer_read_context). */
  paragraphs?: WordHostContextParagraph[];
}

/** One step of an agentic run, shown in the pane's conversation as the tool-call trail. */
export interface AiActivityEntry {
  at: string;
  kind: "tool" | "status" | "thinking" | "text";
  tool?: string | null;
  summary: string;
}

/** POST /api/word/context — the add-in's periodic window-state push. */
export interface WordHostContextUpdate {
  documentName?: string | null;
  hostContext: WordHostContext;
  /**
   * Current document text. Sent when it changed since the last push so the
   * shared Writer session (what terminal/MCP agents read) tracks Word.
   */
  documentText?: string | null;
  /** Make this Word document the active Writer session even if another document is active. */
  adopt?: boolean;
}

export interface WordHostContextUpdateResponse {
  /** True when the active Writer session is this Word document. */
  adopted: boolean;
  sessionId: string | null;
  revision: number | null;
  pendingSuggestions: number;
}

export interface ProviderSmokeRequest {
  provider: LocalAiProviderName;
}

export interface ProviderSmokeResponse {
  provider: LocalAiProviderName;
  ok: boolean;
  message: string;
  latencyMs: number;
  suggestionCount: number;
}

export interface CliTimeoutHealth {
  env: string;
  value: string | null;
  timeoutMs: number;
  defaultMs: number;
  minMs: number;
  maxMs: number;
  valid: boolean;
  clamped: boolean;
  detail: string;
}

export interface ImportedDocument {
  bodySafeAnchors?: string[];
  bodySafeAnchorDetails?: DocxBodySafeAnchor[];
  id: string;
  name: string;
  html: string;
  plainText: string;
  messages: string[];
  features: DocxFeatureSummary;
  sourceTrackedChanges?: SourceTrackedChangePreview[];
}

export interface DocxBodySafeAnchor {
  section?: string | null;
  text: string;
}

export interface SourceTrackedChangePreview {
  author?: string;
  date?: string;
  kind: "inserted" | "deleted" | "movedFrom" | "movedTo";
  text: string;
  /** Accepted text immediately before the change, used to anchor an inline marker for deletions. */
  contextBefore?: string;
}

export interface WriterChatMessage {
  content: string;
  role: "assistant" | "system" | "user";
  /** Stable id so collaborating clients can append + dedupe instead of replacing the whole history. */
  id?: string;
  /** Display name of the human (or agent) who wrote the message. */
  author?: string | null;
  /** ISO timestamp used to order merged messages. */
  createdAt?: string | null;
}

export interface DocxFeatureSummary {
  formulas: number;
  citationFields: number;
  fields: number;
  contentControls: number;
  customXml: number;
  hyperlinks: number;
  bookmarks: number;
  commentRanges: number;
  notes: number;
  trackedChanges: number;
  tables: number;
  images: number;
  textBoxes: number;
  /** Header/footer parts containing text — shown nowhere in the browser editor. */
  headerFooterParts?: number;
  bibliographySections: number;
  preservationRecommended: boolean;
}

export interface ExportRequest {
  downloadFilename?: string;
  title: string;
  html?: string;
  sourceDocumentId?: string | null;
  trackedChanges?: boolean;
  suggestions?: AiSuggestion[];
}

export interface WriterRoutineRunReport {
  commentedSuggestionIds?: string[];
  commentedSuggestionOriginals?: string[];
  commentedSuggestionReasonCounts?: Array<{ count: number; reason: string }>;
  commentedSuggestionReasons?: string[];
  commentedSuggestionTitles?: string[];
  commentedSuggestions: number;
  matchedSuggestionIds?: string[];
  matchedSuggestionTitles?: string[];
  matchedSuggestions: number;
  representedSuggestions?: number;
  unmatchedSuggestionIds?: string[];
  totalSuggestions: number;
  unmatchedSuggestionOriginals?: string[];
  unmatchedSuggestionTitles?: string[];
  unmatchedSuggestions: number;
}

export interface WriterReviewSourceDocument {
  afterReadModifiedAt?: string;
  afterReadModifiedMs?: number;
  afterReadSizeBytes?: number;
  changedWhileReading?: boolean;
  filesystemSizeBytes?: number;
  modifiedAt?: string;
  modifiedMs?: number;
  path: string;
  readAt?: string;
  sizeBytes?: number;
  unavailableReason?: string;
  usedInMemoryFallback?: boolean;
}

export interface WriterRoutineRun {
  id: string;
  routineId: string;
  label: string;
  completedAt: string;
  artifactPath?: string | null;
  downloadCopyPath?: string | null;
  instruction?: string | null;
  reportPath?: string | null;
  suggestionsPath?: string | null;
  report?: WriterRoutineRunReport | null;
  sourceDocument?: WriterReviewSourceDocument | null;
}

export interface ProviderHealth {
  name: AiProviderName;
  available: boolean;
  enabled: boolean;
  detail: string;
  overrideEnv: string;
  overrideValue: string | null;
  path?: string | null;
  version?: string | null;
}

export interface WriterSessionSummary {
  bodySafeAnchors?: string[];
  bodySafeAnchorDetails?: DocxBodySafeAnchor[];
  chatMessages?: WriterChatMessage[];
  id: string;
  name: string;
  title: string;
  /** Monotonic counter bumped on every sidecar-side session mutation; lets clients detect concurrent updates. */
  revision?: number;
  sourceDocumentId: string;
  sourceDocument?: WriterReviewSourceDocument | null;
  documentText: string;
  documentHtmlLength: number;
  features: DocxFeatureSummary;
  importMessages: string[];
  sourceTrackedChanges?: SourceTrackedChangePreview[];
  routineProgress?: string[];
  routineRuns?: WriterRoutineRun[];
  suggestions: AiSuggestion[];
  pendingSuggestions: number;
  updatedAt: string;
}

export interface WriterSessionDocument extends WriterSessionSummary {
  documentHtml: string;
}

export interface WriterSessionEnvelope<TSession = WriterSessionSummary> {
  session: TSession | null;
}

export interface WriterSessionSnapshot {
  exportedAt: string;
  session: {
    chatMessages?: WriterChatMessage[];
    name: string;
    routineProgress: string[];
    routineRuns: WriterRoutineRun[];
    /** Stable document id so share URLs (#doc=...) survive restores and sidecar restarts. */
    sourceDocumentId?: string;
    sourceTrackedChanges?: SourceTrackedChangePreview[];
    suggestions: AiSuggestion[];
    title: string;
  };
  sourceDocumentPath: string | null;
  version: 1;
}

export interface WriterAutosavedSessionSummary {
  chatMessageCount: number;
  exportedAt: string;
  filename: string;
  id: string;
  name: string;
  pendingSuggestions: number;
  routineRunCount: number;
  sourceDocumentAvailable: boolean;
  sourceDocumentPath: string | null;
  suggestionCount: number;
  title: string;
}
