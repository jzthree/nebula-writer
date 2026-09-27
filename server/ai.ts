import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { type AiModelOptions, AI_CONTEXT_CHAR_LIMIT, type AiProviderName, type AiRequest, type AiResponse, type AiSuggestion, type ProviderSmokeResponse, DEFAULT_AI_TOOL_ACCESS, isAiToolAccess, type AiToolAccess } from "../src/shared";

import { suggestionAnchorFor } from "../src/shared";
import { EMPHASIS_NOTATION_NOTE, renderEmphasis } from "../src/emphasis";
import { parseQuotedText, sameEmphasisSpans, stagedEmphasis } from "./emphasis-staging";
import { cliEnablementDiagnostic, cliTimeoutMs, formatCliTimeout, isCliExecutionEnabled, resolveCliCommand, type CliProviderName } from "./cli-runtime";
import { createAgentRun, deleteAgentRun, recordAgentActivity, type AgentRunContext } from "./agent-run";
import { describeWordHostContext } from "./word-context";
import { ensureWriterCliHome } from "./cli-home";
import { modelCliArgs } from "./model-catalog";
import { ClaudeStreamParser, CodexStreamParser, runAgentTurn, type AgentEvent } from "./agent-runtime";
import { broadcastAiProgress } from "./realtime";
import { containsAnchoredText, documentImageLabel, isImageCandidate, normalizeConfidence, normalizeWhitespace, replacementRequiresAuthorConfirmation, validateImageReplacementCandidate } from "./suggestion-validation";
import { imageMimeForName } from "./image-files";
import { describeFocus, linkRevision } from "./revisions";
import { nearestDocumentExcerpt, repairAnchor } from "./anchor-repair";

const SMOKE_TEST_TEXT = "This is actually very wordy [@smith2020] while $E=mc^2$ stays.";
const CLI_TIMEOUT_KILL_GRACE_MS = 500;
// Streaming CLI output (JSONL events plus partial deltas) is several times the
// size of the final reply, so the memory guard is generous.
/**
 * No cap on how much a CLI may print: agent runs with computer use stream a
 * screenshot per step. Lines are kept for parsing with long base64 payloads
 * (images, data URIs) replaced by a short marker, so memory stays bounded by
 * the text, not the pictures; stderr keeps its last STDERR_TAIL_CHARS.
 */
const ELIDE_PAYLOAD_MIN_CHARS = 8_000;
const STDERR_TAIL_CHARS = 200_000;
const LONG_PAYLOAD = new RegExp(`"(?:data:[^";,]{1,80};base64,)?[A-Za-z0-9+/=_\\\\-]{${ELIDE_PAYLOAD_MIN_CHARS},}"`, "g");

/** A stdout line with embedded binary payloads elided (text, including long JSON answers, is untouched). */
export function elideLongPayloads(line: string): string {
  if (line.length < ELIDE_PAYLOAD_MIN_CHARS) {
    return line;
  }
  return line.replace(LONG_PAYLOAD, (match) => `"[binary data elided: ${(match.length - 2).toLocaleString()} chars]"`);
}
const MAX_CLI_DIAGNOSTIC_CHARS = 4_000;
const CLI_ENV_OVERRIDES: NodeJS.ProcessEnv = {
  CLICOLOR: "0",
  FORCE_COLOR: "0",
  GIT_PAGER: "cat",
  NO_COLOR: "1",
  PAGER: "cat",
  TERM: "dumb"
};

export interface DocumentCoverageChunk {
  index: number;
  total: number;
  start: number;
  end: number;
  totalLength: number;
  text: string;
}

interface CliPromptOptions {
  coveragePass?: DocumentCoverageChunk;
}

/** Live events from a one-shot CLI run: the agent stream events plus how much of the reply has streamed so far. */
export type CliStreamEvent = AgentEvent | { kind: "output"; chars: number };

export interface CliTranscript {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Why the sidecar ended the process early (user stop, timeout, output cap), or null when it exited on its own. */
  ended: string | null;
}

interface AiRunOptions {
  signal?: AbortSignal;
  /** Resolved tool access for this run (see resolveToolAccess). */
  toolAccess?: AiToolAccess;
  /** Image files to hand the CLI as image inputs (Codex -i). */
  imagePaths?: string[];
  /** Called with each complete stdout line as it arrives (JSONL streaming). */
  onStdoutLine?: (line: string) => void;
  /** Receives parsed stream events while the provider is still running. */
  onStreamEvent?: (event: CliStreamEvent) => void;
  /** Called once with everything the process wrote, when it exits (diagnostics). */
  onTranscript?: (transcript: CliTranscript) => void;
}

export interface AiProgressSnapshot {
  provider: string;
  stage: string;
  /** True when the stage describes a tool call (counted as one in the conversation). */
  tool?: boolean;
  requestedBy: string | null;
  passIndex: number | null;
  passTotal: number | null;
  startedAt: string;
  updatedAt: string;
  /** Configured provider timeout, or null when the run has no time limit. */
  timeoutMs: number | null;
}

// Single-slot progress tracker for the local single-user sidecar. The UI polls
// GET /api/ai/progress while a request is in flight so long CLI calls show
// per-pass progress instead of a frozen spinner.
let currentAiProgress: AiProgressSnapshot | null = null;

export interface QueuedAiRequest {
  provider: string;
  requestedBy: string | null;
}

// CLI executions are serialized: two collaborators sending at once would race
// the progress display and contend for CPU; instead the second waits with an
// honest "queued behind X" state visible to everyone.
let aiQueue: QueuedAiRequest[] = [];
let aiChain: Promise<void> = Promise.resolve();

export function getAiProgress(): AiProgressSnapshot | null {
  return currentAiProgress;
}

export function getAiQueue(): QueuedAiRequest[] {
  return [...aiQueue];
}

function publishAiState(): void {
  broadcastAiProgress(currentAiProgress, getAiQueue());
}

async function runQueuedAiRequest<T>(entry: QueuedAiRequest, run: () => Promise<T>): Promise<T> {
  aiQueue.push(entry);
  publishAiState();
  const previous = aiChain;
  let release!: () => void;
  aiChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    aiQueue = aiQueue.filter((candidate) => candidate !== entry);
    publishAiState();
    return await run();
  } finally {
    aiQueue = aiQueue.filter((candidate) => candidate !== entry);
    release();
    publishAiState();
  }
}

function setAiProgress(provider: string, stage: string, pass?: { index: number; total: number }, requestedBy?: string | null, tool = false): void {
  const now = new Date().toISOString();
  currentAiProgress = {
    provider,
    stage,
    ...(tool ? { tool: true } : {}),
    requestedBy: requestedBy ?? currentAiProgress?.requestedBy ?? null,
    passIndex: pass?.index ?? null,
    passTotal: pass?.total ?? null,
    startedAt: currentAiProgress?.startedAt ?? now,
    updatedAt: now,
    timeoutMs: cliTimeoutMs() || null
  };
  publishAiState();
}

function clearAiProgress(): void {
  currentAiProgress = null;
  publishAiState();
}

export const AI_RESPONSE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    message: {
      type: "string",
      description: "A brief summary of what was proposed."
    },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {
            type: "string"
          },
          original: {
            type: "string",
            minLength: 1,
            description: "Exact source text copied verbatim from the provided Text block, including any emphasis markers (**bold**, *italic*, __underline__, ==highlight==) exactly as shown."
          },
          replacement: {
            type: "string",
            description: "Replacement text that preserves meaning unless the instruction asks otherwise. Emphasis markers in it set bold/italic/underline/highlight on the new text; leave them out to remove the original's emphasis. An empty string proposes DELETING the original — never invent filler text to stand in for a deletion."
          },
          rationale: {
            type: "string"
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1
          },
          imageIndex: {
            type: ["integer", "null"],
            description: "Only for an image replacement: the 0-based index of the document image to replace (see the Document images list). null for text edits."
          },
          imageFile: {
            type: ["string", "null"],
            description: "Only for an image replacement: absolute path of the PNG/JPEG/GIF/WebP file that replaces the image. null for text edits."
          }
        },
        required: ["title", "original", "replacement", "rationale", "confidence", "imageIndex", "imageFile"]
      }
    }
  },
  required: ["message", "suggestions"]
} as const;

export async function proposeChanges(request: AiRequest, options: AiRunOptions = {}): Promise<AiResponse> {
  if (!request.instruction.trim()) {
    return {
      message: "Give me a revision goal first, then I can propose a focused change.",
      provider: request.provider,
      suggestions: []
    };
  }

  if (request.provider === "demo") {
    return withModelOptions(request, linkRevision(request, { ...demoProvider(request), agentSessionId: request.agentSessionId ?? null }));
  }

  const provider = request.provider as CliProviderName;
  return linkRevision(request, await runQueuedAiRequest(
    { provider, requestedBy: request.requestedBy ?? null },
    () => {
      // The wait in the queue may outlive the requester (Stop button or a
      // closed tab aborts the HTTP request) — don't burn a CLI run for them.
      if (options.signal?.aborted) {
        throw new Error("The request was canceled while waiting in the AI queue.");
      }
      return cliProvider(provider, request, options);
    }
  ));
}

export async function smokeTestProvider(provider: CliProviderName): Promise<ProviderSmokeResponse> {
  const startedAt = Date.now();
  const response = await cliProvider(provider, {
    provider,
    instruction: "Smoke test this local provider by making the selected sentence shorter. Return one exact-source suggestion.",
    mode: "selection",
    documentHtml: `<p>${SMOKE_TEST_TEXT}</p>`,
    documentText: SMOKE_TEST_TEXT,
    selection: {
      from: 1,
      to: SMOKE_TEST_TEXT.length + 1,
      text: SMOKE_TEST_TEXT
    }
  });
  const safeSuggestions = response.suggestions.filter((suggestion) =>
    containsAnchoredText(SMOKE_TEST_TEXT, suggestion.original)
    && normalizeWhitespace(suggestion.original) !== normalizeWhitespace(suggestion.replacement)
  );
  const ok = safeSuggestions.length > 0;

  return {
    provider,
    ok,
    message: ok
      ? `${providerLabel(provider)} returned ${safeSuggestions.length} exact-source suggestion${safeSuggestions.length === 1 ? "" : "s"}.`
      : response.message,
    latencyMs: Date.now() - startedAt,
    suggestionCount: safeSuggestions.length
  };
}

function demoProvider(request: AiRequest): AiResponse {
  const source = request.mode === "selection" && request.selection?.text.trim()
    ? request.selection.text
    : pickGlobalTarget(request.documentText);
  const replacement = reviseText(source, request.instruction);

  const suggestion: AiSuggestion = {
    id: randomUUID(),
    title: request.mode === "selection" ? "Revise selected passage" : "Tighten opening passage",
    original: source,
    replacement,
    rationale: buildRationale(request.instruction, request.mode),
    confidence: 0.74,
    target: request.mode,
    range: request.mode === "selection" ? request.selection ?? null : null,
    status: "pending"
  };

  const suggestions = source.trim() && source !== replacement ? [suggestion] : [];

  return {
    provider: "demo",
    message: suggestions.length
      ? `I drafted one ${request.mode === "selection" ? "selection-specific" : "document-level"} change. Review it before applying.`
      : "I did not find a useful change for that instruction. Try selecting a more specific passage or changing the revision goal.",
    suggestions
  };
}

function pickGlobalTarget(documentText: string): string {
  const paragraphs = documentText
    .split(/\n{2,}|\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return paragraphs.find((paragraph) => paragraph.length > 60) ?? paragraphs[0] ?? documentText.trim().slice(0, 500);
}

function reviseText(source: string, instruction: string): string {
  const wantsShort = /short|tight|concise|trim|punch/i.test(instruction);
  const wantsWarm = /warm|friendly|human|conversational/i.test(instruction);
  const wantsFormal = /formal|professional|polish/i.test(instruction);

  let revised = source
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\b(really|very|basically|actually|just)\b\s*/gi, "")
    .trim();

  if (wantsShort) {
    revised = revised
      .replace(/\bin order to\b/gi, "to")
      .replace(/\bdue to the fact that\b/gi, "because")
      .replace(/\bat this point in time\b/gi, "now")
      .replace(/\ba sentence or paragraph\b/gi, "a passage")
      .replace(/\bthe proposed edit\b/gi, "the edit")
      .replace(/\bbefore accepting it\b/gi, "before accepting");
  }

  if (wantsWarm && revised) {
    revised = reviseParagraphs(revised, (paragraph) => {
      const warmer = paragraph.replace(/^The /, "This ");
      return `${warmer.replace(/[.!?]?$/, "")}.`;
    });
  }

  if (wantsFormal && revised) {
    revised = revised
      .replace(/\bkinda\b/gi, "somewhat")
      .replace(/\bgonna\b/gi, "going to")
      .replace(/\bwanna\b/gi, "want to");
  }

  return revised || source;
}

function reviseParagraphs(value: string, revise: (paragraph: string) => string): string {
  return value
    .split(/(\n+)/)
    .map((part) => part.includes("\n") ? part : revise(part))
    .join("");
}

function buildRationale(instruction: string, mode: AiRequest["mode"]): string {
  const scope = mode === "selection" ? "the selected text" : "the first substantive passage";
  return `Applies your instruction to ${scope}, removing filler and smoothing phrasing while preserving the original meaning. Instruction: "${instruction.trim()}".`;
}

async function cliProvider(provider: CliProviderName, request: AiRequest, options: AiRunOptions = {}): Promise<AiResponse> {
  if (!isCliExecutionEnabled()) {
    return {
      provider,
      message: `The ${provider} adapter is configured but local CLI execution is disabled. ${cliEnablementDiagnostic()}. Restart the sidecar with local CLI execution enabled.`,
      suggestions: []
    };
  }
  const engine = process.env.WRITER_AI_ENGINE?.trim().toLowerCase();
  if (engine === "oneshot") {
    return withModelOptions(request, await oneShotCliProvider(provider, request, options));
  }
  if (engine === "agentic") {
    return withModelOptions(request, await agenticCliProvider(provider, request, options));
  }
  // Per-provider default (docs/agentic-ai.md): Claude runs the agentic
  // engine, validated end-to-end under the lockdown recipe. Codex stays on
  // the one-shot pipeline: codex 0.142's non-interactive `exec` cancels MCP
  // tool calls through an approval elicitation no config override disables
  // ("user cancelled MCP tool call"), so its agentic mode is opt-in via
  // WRITER_AI_ENGINE=agentic until a codex release fixes that.
  return withModelOptions(request, provider === "claude"
    ? await agenticCliProvider(provider, request, options)
    : await oneShotCliProvider(provider, request, options));
}

/**
 * The request's tool access, else the sidecar default (WRITER_TOOL_ACCESS),
 * else "full": Writer runs the same CLI the user runs by hand, with the same
 * tools, unless they choose to narrow it.
 */
export function resolveToolAccess(request: Pick<AiRequest, "toolAccess">, env: NodeJS.ProcessEnv = process.env): AiToolAccess {
  if (isAiToolAccess(request.toolAccess)) {
    return request.toolAccess;
  }
  const configured = env.WRITER_TOOL_ACCESS?.trim().toLowerCase();
  return isAiToolAccess(configured) ? configured : DEFAULT_AI_TOOL_ACCESS;
}

/** Echo the model override a run was made with so the UI can label the result. */
function withModelOptions(request: AiRequest, response: AiResponse): AiResponse {
  return request.modelOptions ? { ...response, modelOptions: request.modelOptions } : response;
}

// The CLI runs as an agent locked to this run's MCP tools: it reads the
// document through windowed reads/search, stages suggestions through the
// validated staging tool (rejections come back with reasons it can act on),
// and finishes with a short summary. Suggestions accumulate in the run
// context, so a timeout or failure still returns everything staged so far —
// the same salvage behavior coverage passes had.
async function agenticCliProvider(provider: CliProviderName, request: AiRequest, options: AiRunOptions = {}): Promise<AiResponse> {
  const run = createAgentRun(request);
  try {
    throwIfAborted(provider, options.signal);
    setAiProgress(provider, `The ${providerLabel(provider)} agent is starting`, undefined, request.requestedBy ?? null);
    const toolAccess = resolveToolAccess(request);
    const runTurn = (sessionId: string | null) => runAgentTurn({
      provider,
      prompt: buildAgentTaskPrompt({ ...request, toolAccess, ...(sessionId ? {} : { agentSessionId: null }) }, run),
      runUrl: agentRunUrl(run.id),
      workspaceDir: cliWorkspaceDir(),
      env: cliChildEnv(provider, toolAccess),
      sessionId,
      toolAccess,
      modelOptions: request.modelOptions ?? null,
      signal: options.signal,
      onEvent: (event) => {
        recordActivity(run, event);
        applyAgentProgress(provider, request, event);
      }
    });
    let result: Awaited<ReturnType<typeof runAgentTurn>>;
    const resumeId = request.agentSessionId ?? null;
    try {
      result = await runTurn(resumeId);
    } catch (error) {
      if (!resumeId || options.signal?.aborted || !isMissingSessionError(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      result = await retryWithoutSession(provider, request, run, runTurn);
    }
    if (resumeId && !result.ok && isMissingSessionError(result.text) && !options.signal?.aborted) {
      result = await retryWithoutSession(provider, request, run, runTurn);
    }
    const suggestions = [...run.staged];
    const summary = formatCliDiagnostic(result.text) || defaultAgentSummary(suggestions.length);
    return {
      provider,
      activity: [...run.activity],
      message: result.ok
        ? summary
        // A completed-but-failed turn (e.g. claude emits an "out of usage
        // credits" result after its opening sentence) must name the cause AND
        // the fix — otherwise it reads as "the agent said one line then stopped".
        : `${providerLabel(provider)} could not complete this request: ${summary}${cliFailureGuidance(result.text)}${suggestions.length ? ` The ${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"} staged before the failure ${suggestions.length === 1 ? "is" : "are"} included.` : ""}`,
      suggestions,
      agentSessionId: result.sessionId ?? request.agentSessionId ?? null
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const suggestions = [...run.staged];
    if (suggestions.length && !options.signal?.aborted) {
      return {
        provider,
        message: `The ${provider} agent stopped early (${formatCliDiagnostic(rawMessage)}), but the ${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"} it staged ${suggestions.length === 1 ? "is" : "are"} kept.${cliFailureGuidance(rawMessage)}`,
        suggestions,
        agentSessionId: request.agentSessionId ?? null
      };
    }
    return {
      provider,
      message: `The ${provider} CLI could not complete this request: ${formatCliDiagnostic(rawMessage)}${cliFailureGuidance(rawMessage)}`,
      suggestions: []
    };
  } finally {
    deleteAgentRun(run.id);
    clearAiProgress();
  }
}

/**
 * A CLI session can vanish (the CLI was updated, its store pruned, or the
 * pane kept an id from another machine). Rather than failing the turn, start
 * a fresh session — the request's conversation digest carries the context.
 */
async function retryWithoutSession(
  provider: CliProviderName,
  request: AiRequest,
  run: AgentRunContext,
  runTurn: (sessionId: string | null) => ReturnType<typeof runAgentTurn>
): ReturnType<typeof runAgentTurn> {
  recordAgentActivity(run, { kind: "status", summary: "Earlier session is gone — starting a fresh one with the conversation digest" });
  setAiProgress(provider, "Earlier session is gone — starting a fresh one", undefined, request.requestedBy ?? null);
  return runTurn(null);
}

function isMissingCodexThreadError(text: string): boolean {
  return isMissingSessionError(text) || /no (?:recorded )?session|session (?:file )?(?:not|could not be) (?:found|loaded|read)|failed to (?:load|resume) (?:the )?(?:session|thread)|thread(?: id)? [^\n]{0,40}(?:not found|does not exist|unknown)/i.test(text);
}

export function isMissingSessionError(text: string): boolean {
  return /no conversation found|conversation (was )?not found|session[^.\n]{0,40}(not found|does not exist|expired|invalid|unknown)|unknown session|thread[^.\n]{0,40}(not found|does not exist)|invalid session id|could not resume|failed to resume|cannot resume/i.test(text);
}

function agentRunUrl(runId: string): string {
  const port = Number(process.env.WRITER_SIDECAR_PORT || 8787);
  return `http://127.0.0.1:${port}/api/agent-run/${runId}`;
}

function defaultAgentSummary(stagedCount: number): string {
  return stagedCount
    ? `Staged ${stagedCount} suggestion${stagedCount === 1 ? "" : "s"} for review.`
    : "No suggestions were staged for that instruction.";
}

const CONVERSATION_PROMPT_TURNS = 8;

/**
 * The chat so far, as the agent should see it: earlier requests, its earlier
 * replies, and — the part no CLI transcript contains — what the user did with
 * each staged suggestion. Applied/dismissed decisions are the strongest
 * feedback signal there is, so they are always included even when the
 * provider session is being resumed.
 */
export function describeConversation(request: AiRequest): string[] {
  const turns = request.conversation ?? [];
  if (!turns.length) {
    return [];
  }
  const resumed = Boolean(request.agentSessionId);
  const recent = turns.slice(-CONVERSATION_PROMPT_TURNS);
  const lines: string[] = ["", resumed
    ? "Conversation so far (you have this transcript; the decisions in brackets are what the user did with your suggestions since):"
    : "Conversation so far (oldest first). Follow-up instructions refer to this:"];
  for (const turn of recent) {
    const content = clipForPrompt(turn.content, resumed && turn.role === "assistant" ? 240 : 700);
    if (turn.role === "user") {
      lines.push(`User: ${content}`);
      continue;
    }
    const decisions = (turn.decisions ?? []).map((decision) => {
      const label = decision.ref ? `${decision.ref} "${decision.title}"` : `"${decision.title}"`;
      const note = decision.note ? ` ("${clipForPrompt(decision.note, 120)}")` : "";
      return `${label} — ${decision.status}${note}`;
    });
    lines.push(`You: ${content}${decisions.length ? ` [${decisions.join("; ")}]` : ""}`);
  }
  const pendingCount = recent.flatMap((turn) => turn.decisions ?? []).filter((decision) => decision.status === "pending").length;
  lines.push(`Treat "dismissed" as feedback to avoid similar edits, "applied" as the direction the user wants${pendingCount ? `, and do not re-stage the ${pendingCount} still-pending suggestion${pendingCount === 1 ? "" : "s"}` : ""}. When the new request refers to an earlier suggestion ("make it shorter", "same for Aim 2"), stage a revised version rather than repeating it.`);
  return lines;
}

function clipForPrompt(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function recordActivity(run: AgentRunContext, event: AgentEvent): void {
  switch (event.kind) {
    case "tool":
      recordAgentActivity(run, { kind: "tool", tool: event.tool, summary: capitalizeFirst(event.summary) });
      break;
    case "status":
      recordAgentActivity(run, { kind: "status", summary: event.detail ?? event.stage });
      break;
    case "thinking":
      recordAgentActivity(run, { kind: "thinking", summary: "Thinking" });
      break;
    case "text":
      recordAgentActivity(run, { kind: "text", summary: "Writing the reply" });
      break;
    default:
      break;
  }
}

function applyAgentProgress(provider: CliProviderName, request: AiRequest, event: AgentEvent): void {
  const requestedBy = request.requestedBy ?? null;
  switch (event.kind) {
    case "status":
      setAiProgress(provider, event.detail ?? event.stage, undefined, requestedBy);
      break;
    case "thinking":
      setAiProgress(provider, "Thinking", undefined, requestedBy);
      break;
    case "tool":
      setAiProgress(provider, capitalizeFirst(event.summary), undefined, requestedBy);
      break;
    case "text":
      setAiProgress(provider, "Writing the summary", undefined, requestedBy);
      break;
    default:
      break;
  }
}

function capitalizeFirst(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

const AGENT_SELECTION_INLINE_LIMIT = 2_000;
const READ_BEYOND_SELECTION = "Reading is NOT limited to the selection: whenever it alone does not tell you enough — a term defined elsewhere, a cross-reference, a question about consistency with another section — read more of the document, up to all of it, before answering. When the request is about the document as a whole, read all of it and stage edits across sections.";
// One-shot providers have no tools, so a selection-scoped prompt carries the
// surrounding document as read-only context: the whole document when it fits
// the budget, otherwise a window around the selection.
const SELECTION_CONTEXT_WINDOW_CHARS = 60_000;

function describeToolAccessForAgent(toolAccess: AiToolAccess): string {
  switch (toolAccess) {
    case "full":
      return "The document is reachable ONLY through the `writer` MCP tools — never by editing files. Beyond that you have your usual tools (web, files, shell, your own MCP servers), governed by your normal permission settings; use them whenever they help you answer or verify.";
    case "read":
      return "The document is reachable ONLY through the `writer` MCP tools. You may also search and fetch the web and read files on this machine; nothing else — there is no shell and nothing to write.";
    default:
      return "You interact ONLY through the `writer` MCP tools — there is no filesystem and no shell.";
  }
}

export function buildAgentTaskPrompt(request: AiRequest, run: Pick<AgentRunContext, "maxSuggestions" | "attachments"> & Partial<Pick<AgentRunContext, "images">>): string {
  const images = run.images ?? [];
  const selectionText = request.mode === "selection" ? request.selection?.text ?? "" : "";
  const attachmentLines = run.attachments.length
    ? [
        `The user attached ${run.attachments.length} reference file${run.attachments.length === 1 ? "" : "s"} (read them with writer_read_attachment):`,
        ...run.attachments.map((attachment) => `- ${attachment.name} (${attachment.text.length.toLocaleString()} characters of extracted text)`),
        "Attachments are reference material only: `original` must still quote the document, never an attachment."
      ]
    : [];

  return [
    "You are the editing agent embedded in Nebula Writer, revising the user's document.",
    describeToolAccessForAgent(resolveToolAccess(request)),
    "",
    `The document is ${request.documentText.length.toLocaleString()} characters long.`,
    EMPHASIS_NOTATION_NOTE,
    ...(request.mode === "selection"
      ? selectionText.length <= AGENT_SELECTION_INLINE_LIMIT
        ? [
            "The user selected this passage — it is where they are working. Decide from the instruction whether the request is about this passage or about the document as a whole, and act accordingly: edits may land anywhere in the document (say so when they do):",
            "<<<selection",
            selectionText,
            ">>>",
            READ_BEYOND_SELECTION
          ]
        : ["The user selected a passage (read it with writer_get_selection) — it is where they are working. Decide from the instruction whether the request is about that passage or about the document as a whole, and act accordingly: edits may land anywhere in the document (say so when they do).", READ_BEYOND_SELECTION]
      : []),
    ...(request.hostContext ? ["", ...describeWordHostContext(request.hostContext, { mode: request.mode, tooling: "mcp" })] : []),
    ...describeConversation(request),
    ...describeFocus(request.focus, "agentic"),
    "",
    "How to work:",
    "- Read by structure with writer_read_context: { what: \"paragraph\" } is the paragraph at the author's caret (before/after add neighbours), \"section\" the whole section under the nearest heading, \"page\" exactly what is on screen, \"outline\" every heading with offsets, \"document\" the size and outline. The window state is live: the author may move while you work, so re-read before staging when the request says \"here\" or \"this\".",
    "- For anything else, read windows with writer_read_document and locate passages with writer_search_document. Read what the instruction needs: start with the passage in scope, then widen freely — the section, the pages around it, or the entire document (writer_read_context({ what: \"document\" }) returns up to 60,000 characters at once) — whenever the scoped text is not enough to answer well. Never guess at content you could have read.",
    "- If the request is a question about the document rather than a request for edits, read what you need and answer it in your reply; stage nothing, or only commentOnly notes.",
    "- Every change your reply mentions must actually have been staged: if you write that you cut ten passages, ten suggestions exist.",
    "- Propose edits with writer_stage_suggestions, in small batches as you go. Each item's `original` must be copied VERBATIM from the " + (request.mode === "selection" ? "selection" : "document") + " — the tool validates every item and tells you which were rejected and why; fix those and retry.",
    "- Change only what the instruction asks for: carry every other token of original — markers, numbers, labels, links, formulas — into replacement unchanged.",
    "- Use commentOnly: true for advisory notes that need the author's judgment rather than a text change.",
    "- For broad review requests, spread edits across the document instead of only editing the opening.",
    run.maxSuggestions !== null
      ? `- Stage at most ${run.maxSuggestions} suggestion${run.maxSuggestions === 1 ? "" : "s"} — pick the highest-impact edits.`
      : "- Stage as many high-confidence, non-overlapping suggestions as are genuinely useful; avoid filler edits.",
    ...(request.agentSessionId
      ? ["- This is a follow-up in an ongoing conversation. The document may have changed since your earlier reads — re-verify anchors (writer_search_document) before staging."]
      : []),
    ...attachmentLines,
    ...(images.length
      ? [
          `The document has ${images.length} image${images.length === 1 ? "" : "s"}: ${images.map((image) => documentImageLabel(image)).join("; ")}. writer_list_images gives their file paths — open one with your image reader to see it. To replace one, write a new PNG/JPEG/GIF/WebP file and call writer_stage_image_replacement; the reviewer sees before/after previews.`
        ]
      : []),
    "",
    "When finished, write a short reply that organizes what you staged. Format: a line starting with `## ` opens a section (e.g. `## Significance`, `## Aim 2 approach`); one or two plain sentences of context; then each suggestion's ref from writer_stage_suggestions on its own line, like `[S3]`, in the order the user should review them. The user's pane shows each suggestion card exactly where you place it and offers Apply-all per section, so reference every staged suggestion once and do not repeat the suggestion text. If nothing was safe to stage, say why in 1-2 sentences.",
    "",
    "User request:",
    request.instruction
  ].filter((line): line is string => line !== null && line !== undefined).join("\n");
}

async function oneShotCliProvider(provider: CliProviderName, request: AiRequest, options: AiRunOptions = {}): Promise<AiResponse> {
  try {
    throwIfAborted(provider, options.signal);
    if (shouldUseCoveragePasses(request)) {
      return await runCoveragePasses(provider, request, options);
    }
    setAiProgress(provider, `Starting ${providerLabel(provider)}`, undefined, request.requestedBy ?? null);
    const reporter = createOneShotProgressReporter(provider, request);
    let threadId: string | null = null;
    const onStreamEvent = (event: CliStreamEvent) => {
      if (event.kind === "session") {
        threadId = event.sessionId;
      }
      reporter(event);
    };
    // Codex keeps a thread per conversation (Claude's one-shot mode has no
    // resume; its agentic engine resumes sessions instead).
    const resumeId = provider === "codex" ? request.agentSessionId ?? null : null;
    const toolAccess = resolveToolAccess(request);
    const imagePaths = provider === "codex" ? oneShotImagePaths(request) : [];
    let result: string;
    try {
      result = await runCli(provider, buildCliPrompt(request), { ...options, onStreamEvent, toolAccess, imagePaths }, request.modelOptions ?? null, resumeId);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!resumeId || options.signal?.aborted || !isMissingCodexThreadError(text)) {
        throw error;
      }
      // The recorded thread is gone (Codex home cleaned, different machine): start over without it.
      setAiProgress(provider, "Earlier conversation is gone — starting a fresh one", undefined, request.requestedBy ?? null);
      threadId = null;
      result = await runCli(provider, buildCliPrompt({ ...request, agentSessionId: null }), { ...options, onStreamEvent, toolAccess, imagePaths }, request.modelOptions ?? null, null);
    }
    setAiProgress(provider, "Checking the suggestions against the document", undefined, request.requestedBy ?? null);
    const parsed = parseCliResponseDetailed(provider, result, request);
    const response = await completeReply(provider, request, parsed.response, parsed.unplaced, { ...options, onStreamEvent, toolAccess, imagePaths }, provider === "codex" ? threadId ?? resumeId : null);
    return provider === "codex" ? { ...response, agentSessionId: threadId ?? resumeId } : response;
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = formatCliDiagnostic(rawMessage);
    const guidance = cliFailureGuidance(rawMessage);
    return {
      provider,
      message: `The ${provider} CLI could not complete this request: ${message}${guidance}`,
      suggestions: []
    };
  } finally {
    clearAiProgress();
  }
}

function cliFailureGuidance(rawMessage: string): string {
  // Out of credits / usage limit — the most common "it just stopped after the
  // first line" cause. Claude reports this mid-turn, so the agent prints an
  // opening sentence then halts. Name it plainly and offer the other provider.
  if (/out of (usage )?credit|usage limit|quota|insufficient_quota|billing/i.test(rawMessage)) {
    return " Your CLI account is out of usage credits. Top up (Claude: run `claude` and check /usage; Codex: check your OpenAI plan), or switch to the other provider in the picker.";
  }
  if (/rate.?limit|429|too many requests|overloaded|529/i.test(rawMessage)) {
    return " The provider is rate-limiting or overloaded right now. Wait a moment and resend, or switch to the other provider in the picker.";
  }
  if (/not logged in|unauthorized|401|authentication|please run \/login|log ?in/i.test(rawMessage)) {
    return " The CLI isn't logged in. Sign in on this machine (Claude: run `claude`; Codex: run `codex login`), then resend — no sidecar restart needed.";
  }
  if (/\btimed out after\b/i.test(rawMessage)) {
    return " The request hit the WRITER_CLI_TIMEOUT_MS limit configured for this sidecar. Raise it, or unset it to let requests run until you stop them (the default), then restart the sidecar.";
  }
  if (/status 127|ENOENT|command not found|no such file|not found on PATH|env: node/i.test(rawMessage)) {
    return " The CLI executable (or its `node` runtime) was not found on PATH. Install it, or point WRITER_CODEX_PATH / WRITER_CLAUDE_PATH at the binary, then restart the sidecar.";
  }
  if (/exited with status \d+|terminated by signal/i.test(rawMessage)) {
    return ` Run the provider smoke test (the activity button next to the provider picker) to diagnose, and read the full CLI transcript${lastTranscriptPath ? ` at ${lastTranscriptPath}` : ` under ${cliTranscriptDir() ?? "~/.nebula-writer/cli-transcripts"}`}.`;
  }
  return "";
}

/* ------------------------- CLI transcripts (diagnostics) ------------------------- */

// Every one-shot run leaves its prompt and raw output on disk so a bad reply can
// be inspected after the fact ("why did I only get one sentence?"). Local only,
// last N runs, off with WRITER_CLI_TRANSCRIPTS=off.
const CLI_TRANSCRIPT_KEEP = 30;
const CLI_TRANSCRIPT_SECTION_LIMIT = 2_500_000;
let lastTranscriptPath: string | null = null;

export function cliTranscriptDir(): string | null {
  const configured = process.env.WRITER_CLI_TRANSCRIPTS?.trim();
  if (configured && /^(0|off|no|false|none)$/i.test(configured)) {
    return null;
  }
  return configured || join(homedir(), ".nebula-writer", "cli-transcripts");
}

export function lastCliTranscriptPath(): string | null {
  return lastTranscriptPath;
}

function recordCliTranscript(provider: CliProviderName, prompt: string, transcript: CliTranscript): void {
  const dir = cliTranscriptDir();
  if (!dir) {
    return;
  }
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${stamp}-${provider}.log`);
    const clipSection = (text: string) => (text.length > CLI_TRANSCRIPT_SECTION_LIMIT ? `${text.slice(0, CLI_TRANSCRIPT_SECTION_LIMIT)}\n... truncated ...` : text);
    writeFileSync(
      path,
      [
        `# Nebula Writer CLI transcript — ${provider} — ${new Date().toISOString()}`,
        `# exit code: ${transcript.code === null ? "none" : transcript.code}${transcript.signal ? ` (signal ${transcript.signal})` : ""}`,
        `# ended by: ${transcript.ended ?? "the process exiting on its own"}`,
        "",
        "## prompt",
        clipSection(prompt),
        "",
        "## stdout",
        clipSection(transcript.stdout),
        "",
        "## stderr",
        clipSection(transcript.stderr),
        ""
      ].join("\n"),
      "utf8"
    );
    lastTranscriptPath = path;
    const stale = readdirSync(dir)
      .filter((name) => name.endsWith(".log"))
      .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(CLI_TRANSCRIPT_KEEP);
    for (const entry of stale) {
      unlinkSync(join(dir, entry.name));
    }
  } catch {
    // Diagnostics are best-effort.
  }
}

export function buildCliPrompt(request: AiRequest, options: CliPromptOptions = {}): string {
  const promptText = buildPromptText(request, options);
  const suggestionLimit = requestedSuggestionLimit(request);
  return [
    "You are an editorial assistant embedded in a DOCX-compatible writing tool.",
    "Return strict JSON only. The local CLI will validate the final answer against a JSON schema.",
    "Do not wrap the JSON in Markdown.",
    "This is a single turn and your reply is final: deliver the complete answer now. Never reply with a plan, a preamble, or a promise of what you will do next.",
    "Every change your message mentions must be present in suggestions, one item per change: if the message says ten cuts, suggestions holds ten. Never describe an edit you did not include, and never refer to an item \"below\" that is not there.",
    "If the instruction asks a question or for an assessment (a review, a score, a judgement), answer it fully in message — several paragraphs with `## ` sections are welcome — and add suggestions only where a concrete edit follows from the answer.",
    "Every suggestion must use exact text from the document: normally from the Text block (the user's current focus).",
    "Set original to a verbatim substring of the source text. Do not paraphrase original.",
    EMPHASIS_NOTATION_NOTE,
    "When a Document context block is present, the Text block is the user's selection: what they were looking at when they asked. Decide from the instruction what the request is about. A request about that passage is answered inside it; a request about the document as a whole — its argument, flow, structure, consistency — is answered across the whole Document context, with edits staged wherever they are needed (originals copied verbatim from wherever they sit). Never ask the user to select more text: you already have the whole document.",
    "Avoid generic repeated source-text targets such as headings, \"Rationale.\", \"Preliminary studies.\", or one-word placeholders by themselves; include nearby unique context in original so the DOCX review export can place the suggestion in the intended section.",
    "Do not edit Writer display metadata such as \"DOCX image preview unavailable\" placeholders; those mark preserved DOCX media and should remain untouched.",
    suggestionLimit === null
      ? "No explicit suggestion count cap is set. Return as many high-confidence, non-overlapping exact-source suggestions as are useful while keeping the JSON response valid and avoiding filler edits."
      : `Return up to ${suggestionLimit} high-confidence, non-overlapping exact-source suggestion${suggestionLimit === 1 ? "" : "s"}.`,
    "For a broad global R01 review, spread edits across the document instead of only editing the opening.",
    "To propose deleting a passage, set replacement to an empty string (\"\"). Never write a placeholder or filler sentence as the replacement for a deletion — the user's document would receive it verbatim.",
    "Change only what the instruction asks for: every other token of original — markers, numbers, labels, links, formulas — must appear unchanged in replacement.",
    "If you cannot find safe exact source text, return an empty suggestions array.",
    "Do not include unrelated commentary outside JSON.",
    "In message, you may organize the suggestions into sections: a line starting with `## ` is a section heading and a line `[S3]` places the third suggestion of your array (1-based) under it; reference each suggestion once. Keep the rest to 1-2 sentences per section.",
    "Response shape:",
    "{",
    "  \"message\": \"short summary, optionally with ## sections and [S#] placements\",",
    "  \"suggestions\": [",
    "    {",
    "      \"title\": \"imperative label\",",
    "      \"original\": \"exact text copied from the provided text\",",
    "      \"replacement\": \"replacement text\",",
    "      \"rationale\": \"why this helps\",",
    "      \"confidence\": 0.0",
    "    }",
    "  ]",
    "}",
    "",
    `Instruction: ${request.instruction}`,
    `Scope: ${request.mode}`,
    request.agentSessionId && !options.coveragePass
      ? "This continues the earlier conversation in this thread. The Text and Document context blocks below are the CURRENT document, which may have changed since your earlier turns; rely on them, not on earlier copies."
      : null,
    ...buildSelectionContextLines(request, options),
    options.coveragePass
      ? `Complete-document coverage pass ${options.coveragePass.index} of ${options.coveragePass.total}. The Text block is a contiguous chunk covering characters ${options.coveragePass.start + 1}-${options.coveragePass.end} of ${options.coveragePass.totalLength}. Across all passes, the sidecar covers the full document. Use only exact source text visible in this chunk.`
      : null,
    ...buildAttachmentPromptLines(request),
    ...buildDocumentImagePromptLines(request),
    ...(request.hostContext && !options.coveragePass ? describeWordHostContext(request.hostContext, { mode: request.mode, tooling: "inline" }) : []),
    ...(options.coveragePass ? [] : describeConversation(request)),
    ...(options.coveragePass ? [] : describeFocus(request.focus, "oneshot")),
    "Text:",
    promptText.text
  ].filter((line): line is string => line !== null).join("\n");
}

export function buildSelectionContextLines(request: AiRequest, options: CliPromptOptions = {}): string[] {
  if (options.coveragePass || request.mode !== "selection") {
    return [];
  }
  const selectionText = request.selection?.text ?? "";
  const document = request.documentText ?? "";
  if (!selectionText.trim() || !document.trim() || document.trim() === selectionText.trim()) {
    return [];
  }
  const budget = AI_CONTEXT_CHAR_LIMIT - Math.min(selectionText.length, AI_CONTEXT_CHAR_LIMIT);
  if (budget < 1_000) {
    return [];
  }
  if (document.length <= budget) {
    return [
      "Document context (the entire document; the Text block below is the user's selection — judge from the instruction whether the request concerns it or the whole document, and edit wherever needed):",
      "<<<document",
      renderEmphasis(document, request.documentEmphasis),
      ">>>"
    ];
  }
  const found = document.indexOf(selectionText);
  const anchor = found >= 0
    ? found
    : typeof request.selection?.from === "number" && request.selection.from >= 0 && request.selection.from < document.length
      ? request.selection.from
      : 0;
  const windowChars = Math.min(budget, SELECTION_CONTEXT_WINDOW_CHARS);
  const half = Math.floor(windowChars / 2);
  const start = Math.max(0, anchor - half);
  const end = Math.min(document.length, Math.max(anchor + selectionText.length + half, start + windowChars));
  return [
    `Document context (a window around the selection: characters ${(start + 1).toLocaleString()}-${end.toLocaleString()} of ${document.length.toLocaleString()}; the Text block below is the user's selection — judge from the instruction whether the request concerns it or the document, and edit wherever needed):`,
    "<<<document",
    renderEmphasis(document.slice(start, end), request.documentEmphasis, start),
    ">>>"
  ];
}

/**
 * The document's images, for one-shot providers: Codex receives the files as
 * image inputs (-i) so it can see them; every provider gets the list with
 * paths and captions, and the contract for proposing a replacement.
 */
function buildDocumentImagePromptLines(request: AiRequest): string[] {
  const images = request.documentImages ?? [];
  if (!images.length) {
    return ["Text suggestions set imageIndex and imageFile to null."];
  }
  return [
    `Document images (${images.length}, in document order${request.provider === "codex" ? "; the same files are attached to this request as image inputs, in this order" : ""}):`,
    ...images.map((image) => `- ${documentImageLabel(image)} — ${image.width && image.height ? `${Math.round(image.width)}×${Math.round(image.height)} ` : ""}${image.mime}, file: ${image.path}`),
    "To propose replacing an image with a file you produced (PNG/JPEG/GIF/WebP, written to your workspace), return a suggestion with imageIndex (0-based), imageFile (the absolute path), original set to the image's label as listed above, and replacement \"\". Text suggestions set imageIndex and imageFile to null."
  ];
}

const ONE_SHOT_IMAGE_INPUT_LIMIT = 8;

/** Files to hand Codex as image inputs: the document's images first, then attached image files. */
export function oneShotImagePaths(request: AiRequest): string[] {
  const fromDocument = (request.documentImages ?? []).map((image) => image.path);
  const fromAttachments = (request.attachments ?? []).filter((attachment) => imageMimeForName(attachment.name)).map((attachment) => attachment.path);
  return [...fromDocument, ...fromAttachments].slice(0, ONE_SHOT_IMAGE_INPUT_LIMIT);
}

// Attached reference files: content is inlined because Claude runs with tools
// disabled; the local path is included because Codex's read-only sandbox can
// open it (useful when the inline text was truncated).
function buildAttachmentPromptLines(request: AiRequest): string[] {
  const attachments = request.attachments ?? [];
  if (!attachments.length) {
    return [];
  }
  const lines: string[] = [
    `The user attached ${attachments.length} reference file${attachments.length === 1 ? "" : "s"}. Use them as context for the instruction. They are reference material only: suggestions must still quote exact text from the Text block, never from the attachments.`
  ];
  for (const attachment of attachments) {
    lines.push(`Attachment: ${attachment.name} (saved at ${attachment.path})`);
    if (attachment.text) {
      lines.push("<<<attachment");
      lines.push(attachment.text);
      lines.push(">>>");
      if (attachment.truncated) {
        lines.push(`(Attachment text truncated; the full file is at ${attachment.path}.)`);
      }
    } else {
      lines.push("(No text could be extracted from this file; if you can read files, the full content is at the path above.)");
    }
  }
  return lines;
}

function buildPromptText(request: AiRequest, options: CliPromptOptions): { text: string } {
  if (options.coveragePass) {
    return { text: renderEmphasis(options.coveragePass.text, request.documentEmphasis, options.coveragePass.start) };
  }

  if (request.mode === "selection") {
    const selectionText = (request.selection?.text ?? "").slice(0, AI_CONTEXT_CHAR_LIMIT);
    const offset = selectionOffsetInDocument(request);
    return {
      text: offset === null ? selectionText : renderEmphasis(selectionText, request.documentEmphasis, offset)
    };
  }

  return {
    text: renderEmphasis(request.documentText, request.documentEmphasis)
  };
}

/** Where the selection's text sits in documentText (so its emphasis can be rendered), or null when it cannot be placed. */
function selectionOffsetInDocument(request: AiRequest): number | null {
  const text = request.selection?.text ?? "";
  if (!text) {
    return null;
  }
  const from = request.selection?.from;
  if (typeof from === "number" && from >= 0 && request.documentText.slice(from, from + text.length) === text) {
    return from;
  }
  const found = request.documentText.indexOf(text);
  return found >= 0 ? found : null;
}

function shouldUseCoveragePasses(request: AiRequest): boolean {
  return request.mode === "global" && request.documentText.length > AI_CONTEXT_CHAR_LIMIT;
}

async function runCoveragePasses(provider: CliProviderName, request: AiRequest, options: AiRunOptions): Promise<AiResponse> {
  const chunks = buildDocumentCoverageChunks(request.documentText);
  const responses: AiResponse[] = [];
  let failedChunk: DocumentCoverageChunk | null = null;
  let failureMessage = "";

  for (const chunk of chunks) {
    throwIfAborted(provider, options.signal);
    const pass = { index: chunk.index, total: chunk.total };
    setAiProgress(provider, `Starting ${providerLabel(provider)}`, pass, request.requestedBy ?? null);
    const chunkRequest: AiRequest = {
      ...request,
      documentText: chunk.text
    };
    try {
      const result = await runCli(
        provider,
        buildCliPrompt(chunkRequest, { coveragePass: chunk }),
        { ...options, onStreamEvent: createOneShotProgressReporter(provider, request, pass), toolAccess: resolveToolAccess(request) },
        request.modelOptions ?? null
      );
      responses.push(parseCliProgressedResponse(provider, result, chunkRequest));
    } catch (error) {
      if (options.signal?.aborted || !responses.length) {
        // Nothing salvageable (or the user interrupted) — let the caller report the failure.
        throw error;
      }
      // Keep the completed passes instead of discarding minutes of work, and
      // stop here rather than spending another timeout on each remaining pass.
      failedChunk = chunk;
      failureMessage = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  const merged = mergeCoverageResponses(provider, chunks, responses, requestedSuggestionLimit(request));
  if (failedChunk) {
    merged.message = `${merged.message} Heads up: coverage pass ${failedChunk.index} of ${failedChunk.total} failed (${formatCliDiagnostic(failureMessage)}), so these suggestions only cover roughly the first ${Math.round((failedChunk.start / Math.max(1, failedChunk.totalLength)) * 100)}% of the document.${cliFailureGuidance(failureMessage)}`;
  }
  return merged;
}

export function buildDocumentCoverageChunks(text: string, maxChunkLength = AI_CONTEXT_CHAR_LIMIT): DocumentCoverageChunk[] {
  const chunkLength = Math.max(1_000, maxChunkLength);
  const chunks: Array<Omit<DocumentCoverageChunk, "index" | "total" | "totalLength">> = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(text.length, start + chunkLength);
    if (end < text.length) {
      end = findChunkBoundary(text, start, end, chunkLength);
    }
    if (end <= start) {
      end = Math.min(text.length, start + chunkLength);
    }
    chunks.push({
      start,
      end,
      text: text.slice(start, end)
    });
    start = end;
  }

  const total = chunks.length;
  return chunks.map((chunk, index) => ({
    ...chunk,
    index: index + 1,
    total,
    totalLength: text.length
  }));
}

function findChunkBoundary(text: string, start: number, hardEnd: number, chunkLength: number): number {
  const minimum = start + Math.floor(chunkLength * 0.6);
  const candidates = [
    lastBoundaryAfter(text, "\n\n", start, hardEnd, minimum),
    lastBoundaryAfter(text, "\n", start, hardEnd, minimum),
    lastBoundaryAfter(text, ". ", start, hardEnd, minimum),
    lastBoundaryAfter(text, " ", start, hardEnd, minimum)
  ].filter((value): value is number => value !== null);
  return candidates.length ? Math.max(...candidates) : hardEnd;
}

function lastBoundaryAfter(text: string, delimiter: string, start: number, hardEnd: number, minimum: number): number | null {
  const index = text.lastIndexOf(delimiter, hardEnd);
  const boundary = index >= start ? index + delimiter.length : -1;
  return boundary > minimum && boundary < hardEnd ? boundary : null;
}

function mergeCoverageResponses(provider: CliProviderName, chunks: DocumentCoverageChunk[], responses: AiResponse[], maxSuggestions: number | null): AiResponse {
  const seen = new Set<string>();
  const suggestions: AiSuggestion[] = [];

  for (const response of responses) {
    for (const suggestion of response.suggestions) {
      const key = `${normalizeWhitespace(suggestion.original)}\u0000${normalizeWhitespace(suggestion.replacement)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      suggestions.push(suggestion);
      if (maxSuggestions !== null && suggestions.length >= maxSuggestions) {
        break;
      }
    }
    if (maxSuggestions !== null && suggestions.length >= maxSuggestions) {
      break;
    }
  }

  const completedPasses = responses.length;
  const coverageLabel = completedPasses === chunks.length
    ? `the full document in ${chunks.length} coverage pass${chunks.length === 1 ? "" : "es"}`
    : `${completedPasses} of ${chunks.length} coverage passes`;
  return {
    provider,
    message: suggestions.length
      ? `Reviewed ${coverageLabel} and returned ${suggestions.length} exact-source suggestion${suggestions.length === 1 ? "" : "s"}.`
      : `Reviewed ${coverageLabel} but found no safe exact-source edits for that instruction.`,
    suggestions
  };
}

async function runCli(provider: CliProviderName, prompt: string, options: AiRunOptions = {}, modelOptions: AiModelOptions | null = null, resumeThreadId: string | null = null): Promise<string> {
  const resolvedCommand = resolveCliCommand(provider);
  if (!resolvedCommand.available || !resolvedCommand.command) {
    throw new Error(resolvedCommand.detail);
  }
  const command = resolvedCommand.command;
  const schemaFile = provider === "codex" ? writeCliSchemaFile() : null;
  // Codex writes its final agent message to this file: the authoritative
  // answer even when earlier (schema-shaped) preambles appeared in the stream.
  const lastMessagePath = schemaFile ? join(schemaFile.dir, "last-message.txt") : null;
  const primaryArgs = buildCliArgs(provider, schemaFile?.path, modelOptions, lastMessagePath ?? undefined, provider === "codex" ? resumeThreadId : null, options.toolAccess ?? "document", options.imagePaths ?? []);
  const observer = options.onStreamEvent ? createCliStreamObserver(provider, options.onStreamEvent) : null;
  const runOptions: AiRunOptions = {
    ...options,
    ...(observer ? { onStdoutLine: observer.consumeLine } : {}),
    onTranscript: (transcript) => {
      options.onTranscript?.(transcript);
      recordCliTranscript(provider, prompt, transcript);
    }
  };
  const preferLastMessage = (output: string): string => {
    if (!lastMessagePath) {
      return output;
    }
    try {
      const final = existsSync(lastMessagePath) ? readFileSync(lastMessagePath, "utf8").trim() : "";
      return final && parseStructuredResponse(final) ? final : output;
    } catch {
      return output;
    }
  };

  try {
    return preferLastMessage(await runCliCommand(provider, command, primaryArgs, prompt, runOptions));
  } catch (error) {
    const compatibilityArgs = buildCliCompatibilityArgs(provider, primaryArgs, error);
    if (!compatibilityArgs) {
      throw observer?.describeFailure(error) ?? error;
    }
    try {
      return preferLastMessage(await runCliCommand(provider, command, compatibilityArgs, prompt, runOptions));
    } catch (fallbackError) {
      const initialMessage = error instanceof Error ? error.message : String(error);
      const described = observer?.describeFailure(fallbackError) ?? fallbackError;
      const fallbackMessage = described instanceof Error ? described.message : String(described);
      throw new Error(`${fallbackMessage} (Structured-output compatibility fallback failed after: ${initialMessage})`);
    }
  } finally {
    if (schemaFile) {
      rmSync(schemaFile.dir, { recursive: true, force: true });
    }
  }
}

class CliInvocationError extends Error {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;

  constructor(message: string, options: { code: number | null; signal: NodeJS.Signals | null; output: string }) {
    super(message);
    this.code = options.code;
    this.signal = options.signal;
    this.output = options.output;
  }
}

function runCliCommand(
  provider: CliProviderName,
  command: string,
  args: string[],
  prompt: string,
  options: AiRunOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`${provider} request was interrupted.`));
      return;
    }
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | null = null;
    const finish = (callback: () => void, finishOptions: { preserveForceKillTimer?: boolean } = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (forceKillTimer && !finishOptions.preserveForceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (abortHandler) {
        signalRemoveAbortListener(optionsSignal, abortHandler);
        abortHandler = null;
      }
      callback();
    };
    const optionsSignal = options.signal;
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: cliWorkspaceDir(),
      env: cliChildEnv(provider, options.toolAccess ?? "document")
    });
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdinStream = child.stdin;
    if (!stdoutStream || !stderrStream || !stdinStream) {
      finish(() => reject(new Error(`Could not open ${provider} stdio streams`)));
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdinError: Error | null = null;
    let endedBy: string | null = null;
    const timeoutMs = cliTimeoutMs();
    const terminate = (message: string) => {
      endedBy = message;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, CLI_TIMEOUT_KILL_GRACE_MS);
      finish(() => reject(new Error(message)), { preserveForceKillTimer: true });
    };
    abortHandler = () => {
      terminate(`${provider} request was interrupted.`);
    };
    optionsSignal?.addEventListener("abort", abortHandler, { once: true });
    if (optionsSignal?.aborted) {
      abortHandler();
      return;
    }
    // stdout is kept line by line with binary payloads elided; the partial
    // last line waits for its newline (or the close) before it is kept.
    let stdoutPending = "";
    const appendStdout = (chunk: Buffer | string) => {
      stdoutPending += String(chunk);
      let newline = stdoutPending.indexOf("\n");
      while (newline >= 0) {
        stdout += `${elideLongPayloads(stdoutPending.slice(0, newline))}\n`;
        stdoutPending = stdoutPending.slice(newline + 1);
        newline = stdoutPending.indexOf("\n");
      }
    };
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        terminate(`${provider} timed out after ${formatCliTimeout(timeoutMs)}`);
      }, timeoutMs);
    }

    let stdoutLineBuffer = "";
    const onStdoutLine = options.onStdoutLine;
    stdoutStream.on("data", (chunk) => {
      if (settled) {
        return;
      }
      appendStdout(chunk);
      if (!onStdoutLine) {
        return;
      }
      stdoutLineBuffer += String(chunk);
      let newline = stdoutLineBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = elideLongPayloads(stdoutLineBuffer.slice(0, newline));
        stdoutLineBuffer = stdoutLineBuffer.slice(newline + 1);
        try {
          onStdoutLine(line);
        } catch {
          // Progress reporting is best-effort; never let it break the run.
        }
        newline = stdoutLineBuffer.indexOf("\n");
      }
    });
    stderrStream.on("data", (chunk) => {
      if (!settled) {
        stderr = (stderr + String(chunk)).slice(-STDERR_TAIL_CHARS);
      }
    });
    stdinStream.on("error", (error) => {
      stdinError = error;
    });
    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.on("close", (code, signal) => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (stdoutPending) {
        stdout += elideLongPayloads(stdoutPending);
        stdoutPending = "";
      }
      try {
        options.onTranscript?.({ stdout, stderr, code, signal, ended: endedBy });
      } catch {
        // Diagnostics must never affect the run.
      }
      if (settled) {
        return;
      }
      if (code === 0) {
        finish(() => resolve(selectCliSuccessOutput(stdout, stderr)));
        return;
      }
      const failure = selectCliFailureOutput(stdout, stderr);
      const message = failure || stdinError?.message || cliExitMessage(provider, code, signal);
      finish(() => reject(new CliInvocationError(message, { code, signal, output: failure })));
    });

    stdinStream.write(prompt, (error?: Error | null) => {
      if (error) {
        stdinError = error;
      }
    });
    stdinStream.end();
  });
}

function throwIfAborted(provider: CliProviderName, signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error(`${provider} request was interrupted.`);
  }
}

function signalRemoveAbortListener(signal: AbortSignal | undefined, handler: () => void): void {
  signal?.removeEventListener("abort", handler);
}

// Where Writer runs the CLIs. Claude Code keys its transcripts by working
// directory, so a dedicated, clearly-labeled folder keeps Writer's sessions
// out of your real projects' history. Override the workspace with
// WRITER_CLI_WORKSPACE.
let cachedCliWorkspace: string | null = null;
function cliWorkspaceDir(): string {
  if (cachedCliWorkspace) {
    return cachedCliWorkspace;
  }
  const dir = process.env.WRITER_CLI_WORKSPACE?.trim()
    || join(homedir(), ".nebula-writer", "cli-workspace");
  try {
    mkdirSync(dir, { recursive: true });
    cachedCliWorkspace = dir;
  } catch {
    // Fall back to the process cwd if the workspace can't be created.
    cachedCliWorkspace = process.cwd();
  }
  return cachedCliWorkspace;
}

export function cliChildEnv(provider: CliProviderName, toolAccess: AiToolAccess = "document"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...CLI_ENV_OVERRIDES
  };
  // Confine each CLI's session/trajectory store to a Writer-owned home by
  // default so AI requests do not pile transcripts into your personal
  // ~/.claude / ~/.codex. Auth is bridged into that home (see cli-home.ts).
  // Opt out with WRITER_CLAUDE_CONFIG_DIR=default / WRITER_CODEX_HOME=default.
  // Full tool access means "the CLI as you run it", so it keeps your own home:
  // your MCP servers, permission settings, and config defaults.
  const cliHome = toolAccess === "full" ? null : ensureWriterCliHome(provider);
  if (cliHome) {
    env[PROVIDER_CHILD_HOME_ENV[provider]] = cliHome;
  }
  return env;
}

const PROVIDER_CHILD_HOME_ENV: Record<CliProviderName, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME"
};

function cliExitMessage(
  provider: CliProviderName,
  code: number | null,
  signal: NodeJS.Signals | null
): string {
  if (signal) {
    return `${provider} terminated by signal ${signal}`;
  }
  if (typeof code === "number") {
    return `${provider} exited with status ${code}`;
  }
  return `${provider} exited before returning a status code`;
}

function buildCliCompatibilityArgs(provider: CliProviderName, args: string[], error: unknown): string[] | null {
  if (!isUnsupportedCliFlagError(error)) {
    return null;
  }

  const text = cliErrorText(error);
  if (provider === "codex") {
    let codexArgs = args;
    if (text.includes("output-schema")) {
      codexArgs = removeFlagWithValue(codexArgs, "--output-schema") ?? codexArgs;
    }
    if (text.includes("output-last-message")) {
      codexArgs = removeFlagWithValue(codexArgs, "--output-last-message") ?? codexArgs;
    }
    if (/--json\b/.test(text) && !text.includes("json-schema")) {
      codexArgs = removeFlag(codexArgs, "--json") ?? codexArgs;
    }
    return codexArgs.length === args.length ? null : codexArgs;
  }

  let compatibilityArgs = args;
  if (text.includes("include-partial-messages")) {
    compatibilityArgs = removeFlag(compatibilityArgs, "--include-partial-messages") ?? compatibilityArgs;
  }
  if (text.includes("stream-json")) {
    // Older builds: fall back to the buffered JSON envelope (no live progress).
    compatibilityArgs = removeFlag(compatibilityArgs, "--include-partial-messages") ?? compatibilityArgs;
    compatibilityArgs = removeFlag(compatibilityArgs, "--verbose") ?? compatibilityArgs;
    compatibilityArgs = compatibilityArgs.map((value, index) => (value === "stream-json" && compatibilityArgs[index - 1] === "--output-format" ? "json" : value));
  } else if (/\bverbose\b/.test(text)) {
    compatibilityArgs = removeFlag(compatibilityArgs, "--verbose") ?? compatibilityArgs;
  }
  // Older Claude Code builds predate --effort (and, long ago, --model): drop
  // the rejected flag and retry rather than failing the whole request.
  for (const flag of ["--effort", "--model"]) {
    if (text.includes(flag.slice(2)) && compatibilityArgs.includes(flag)) {
      compatibilityArgs = removeFlagWithValue(compatibilityArgs, flag) ?? compatibilityArgs;
    }
  }
  if (text.includes("json-schema")) {
    compatibilityArgs = removeFlagWithValue(compatibilityArgs, "--json-schema") ?? compatibilityArgs;
  }
  if (text.includes("--tools") || /\btools\b/.test(text)) {
    compatibilityArgs = removeFlagWithValue(compatibilityArgs, "--tools") ?? compatibilityArgs;
  }

  return compatibilityArgs.length === args.length && compatibilityArgs.every((value, index) => value === args[index]) ? null : compatibilityArgs;
}

function removeFlag(args: string[], flag: string): string[] | null {
  const flagIndex = args.indexOf(flag);
  if (flagIndex < 0) {
    return null;
  }
  return args.filter((_value, index) => index !== flagIndex);
}

function isUnsupportedCliFlagError(error: unknown): boolean {
  if (!(error instanceof CliInvocationError)) {
    return false;
  }

  const text = cliErrorText(error);
  const indicatesUnsupportedFlag = /(unknown|unrecognized|invalid|unexpected|unsupported)\s+(option|argument|flag)|does not support/.test(text);
  return indicatesUnsupportedFlag;
}

function cliErrorText(error: unknown): string {
  if (error instanceof CliInvocationError) {
    return `${error.message}\n${error.output}`.toLowerCase();
  }
  return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
}

function removeFlagWithValue(args: string[], flag: string): string[] | null {
  const flagIndex = args.indexOf(flag);
  if (flagIndex < 0) {
    return null;
  }
  return args.filter((_value, index) => index !== flagIndex && index !== flagIndex + 1);
}

function selectCliSuccessOutput(stdout: string, stderr: string): string {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  if (trimmedStdout && trimmedStderr) {
    const stdoutPayload = parseStructuredResponse(sanitizeCliOutput(trimmedStdout));
    const stderrPayload = parseStructuredResponse(sanitizeCliOutput(trimmedStderr));
    if (stderrPayload && !stdoutPayload) {
      return trimmedStderr;
    }
    if (!stdoutPayload && !stderrPayload) {
      return `${trimmedStdout}\n${trimmedStderr}`;
    }
  }

  if (trimmedStdout) {
    return trimmedStdout;
  }
  return trimmedStderr;
}

function selectCliFailureOutput(stdout: string, stderr: string): string {
  const trimmedStderr = stderr.trim();
  if (trimmedStderr) {
    return trimmedStderr;
  }
  return stdout.trim();
}

export function buildCliArgs(
  provider: CliProviderName,
  codexSchemaPath?: string,
  modelOptions: AiModelOptions | null = null,
  codexLastMessagePath?: string,
  codexResumeThreadId?: string | null,
  toolAccess: AiToolAccess = "document",
  imagePaths: string[] = []
): string[] {
  if (provider === "codex") {
    return [
      // `exec resume <thread>` continues the conversation Codex recorded for
      // the earlier turns (its home is Writer's own, see cli-home.ts), so a
      // follow-up like "continue" or "yes, do it" carries the whole context.
      ...(codexResumeThreadId ? ["exec", "resume", codexResumeThreadId] : ["exec"]),
      // JSONL events (thread/turn/item) so the UI can show what Codex is doing
      // while it works; the final agent_message carries the structured reply.
      "--json",
      "-c",
      'service_tier="fast"',
      ...modelCliArgs(provider, modelOptions),
      "--skip-git-repo-check",
      // `exec resume` keeps the session's sandbox and rejects the flag. Full
      // access may write inside the Writer workspace (cwd); never beyond it.
      ...(codexResumeThreadId ? [] : ["--sandbox", toolAccess === "full" ? "workspace-write" : "read-only"]),
      ...(codexSchemaPath ? ["--output-schema", codexSchemaPath] : []),
      ...(codexLastMessagePath ? ["--output-last-message", codexLastMessagePath] : []),
      // Image inputs (document figures, attached pictures) so the model can see them.
      ...imagePaths.flatMap((path) => ["-i", path]),
      "-"
    ];
  }

  return [
    "-p",
    ...modelCliArgs(provider, modelOptions),
    ...oneShotClaudeToolArgs(toolAccess),
    // stream-json (which requires --verbose) emits init/assistant/result events
    // as they happen; partial messages add deltas so the UI can show how much
    // of the reply has been written so far.
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--json-schema",
    JSON.stringify(AI_RESPONSE_SCHEMA)
  ];
}

/** Claude's one-shot mode: no tools, read-only helpers, or whatever the user's own settings allow. */
function oneShotClaudeToolArgs(toolAccess: AiToolAccess): string[] {
  switch (toolAccess) {
    case "full":
      return [];
    case "read":
      return ["--tools", READ_ONLY_CLAUDE_TOOLS, "--allowedTools", READ_ONLY_CLAUDE_TOOLS];
    default:
      return ["--tools", ""];
  }
}

const READ_ONLY_CLAUDE_TOOLS = "WebSearch WebFetch Read Glob Grep";

function formatCharCount(chars: number): string {
  return chars < 1000 ? `${chars} characters` : `${(chars / 1000).toFixed(1)}k characters`;
}

/**
 * Turns one-shot CLI stream events into the shared progress snapshot every
 * client renders (web busy pill, Word pane activity list). Stage text is only
 * republished when it changes, and streamed-output counts are throttled so
 * the websocket is not flooded by per-token deltas.
 */
function createOneShotProgressReporter(
  provider: CliProviderName,
  request: AiRequest,
  pass?: { index: number; total: number }
): (event: CliStreamEvent) => void {
  const requestedBy = request.requestedBy ?? null;
  const label = providerLabel(provider);
  let lastStage = "";
  let lastOutputPublishedAt = 0;
  const publish = (stage: string, force = false, tool = false) => {
    if (!force && stage === lastStage) {
      return;
    }
    lastStage = stage;
    setAiProgress(provider, stage, pass, requestedBy, tool);
  };
  return (event) => {
    switch (event.kind) {
      case "status":
        publish(event.stage === "connected" ? `${label} is reading the document` : event.detail ?? capitalizeFirst(event.stage));
        break;
      case "thinking":
        publish("Thinking");
        break;
      case "tool":
        // Claude runs with tools disabled, so its only "tool" is the structured reply.
        // Every tool call is its own step (two identical screenshots are two calls).
        publish(provider === "claude" ? "Writing suggestions" : capitalizeFirst(event.summary), provider !== "claude", provider !== "claude");
        break;
      case "text":
        publish("Writing suggestions");
        break;
      case "output": {
        const now = Date.now();
        if (now - lastOutputPublishedAt < 1000) {
          return;
        }
        lastOutputPublishedAt = now;
        publish(`Writing suggestions (${formatCharCount(event.chars)} so far)`, true);
        break;
      }
      case "result":
        publish(event.ok ? "Checking the suggestions" : "Reporting a provider error");
        break;
      default:
        break;
    }
  };
}

interface CliStreamObserver {
  consumeLine: (line: string) => void;
  /** When the provider reported a failure in-stream, return an error carrying that message instead of raw JSONL. */
  describeFailure: (error: unknown) => Error | null;
}

/** Streamed-delta length for a Claude `stream_event` line, or null when the line is not one. */
function partialDeltaLength(line: string): number | null {
  if (!line.includes('"stream_event"')) {
    return null;
  }
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event.type !== "stream_event") {
    return null;
  }
  const inner = event.event as Record<string, unknown> | undefined;
  if (inner?.type !== "content_block_delta") {
    return 0;
  }
  const delta = inner.delta as Record<string, unknown> | undefined;
  if (typeof delta?.text === "string") {
    return delta.text.length;
  }
  if (typeof delta?.partial_json === "string") {
    return delta.partial_json.length;
  }
  return 0;
}

function createCliStreamObserver(provider: CliProviderName, onEvent: (event: CliStreamEvent) => void): CliStreamObserver {
  const parser = provider === "claude" ? new ClaudeStreamParser() : new CodexStreamParser();
  let outputChars = 0;
  return {
    consumeLine(line) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        return;
      }
      const deltaLength = partialDeltaLength(trimmed);
      if (deltaLength !== null) {
        if (deltaLength > 0) {
          outputChars += deltaLength;
          onEvent({ kind: "output", chars: outputChars });
        }
        return;
      }
      for (const event of parser.consume(trimmed)) {
        onEvent(event);
      }
    },
    describeFailure(error) {
      const outcome = parser.outcome();
      if (!outcome.sawResult || outcome.ok || !outcome.text.trim()) {
        return null;
      }
      const code = error instanceof CliInvocationError ? error.code : null;
      const signal = error instanceof CliInvocationError ? error.signal : null;
      return new CliInvocationError(`${provider}: ${outcome.text.trim()}`, { code, signal, output: outcome.text.trim() });
    }
  };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20
};
const DESCRIBED_CHANGES = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:[a-z-]+\s+){0,2}?(?:cuts?|edits?|changes?|suggestions?|revisions?|deletions?|trims?|replacements?|fixes|rewrites?|tweaks?|proposals?)\b/gi;

/**
 * How many changes a reply's message claims ("These ten cuts save…", "12
 * suggestions"), or null when it names no count. Used to notice a model that
 * summarised more than it returned.
 */
export function describedChangeCount(message: string): number | null {
  let max: number | null = null;
  for (const match of message.matchAll(DESCRIBED_CHANGES)) {
    const token = match[1].toLowerCase();
    const value = /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token];
    if (value && (max === null || value > max)) {
      max = value;
    }
  }
  return max;
}

/**
 * One automatic follow-up turn, in the same thread when there is one, for two
 * things a one-shot model gets wrong: writing "these ten cuts…" and returning
 * one item (the budget went to thinking and the array stopped short), and
 * quoting an original that is not in the document even after anchor repair.
 * The follow-up asks for the missing items and for exact re-quotes of the
 * unplaced ones, then merges what comes back. Bounded to a single follow-up.
 */
async function completeReply(
  provider: CliProviderName,
  request: AiRequest,
  response: AiResponse,
  unplaced: UnplacedSuggestion[],
  runOptions: AiRunOptions,
  threadId: string | null
): Promise<AiResponse> {
  const claimed = describedChangeCount(response.message);
  const returned = response.suggestions.length;
  const underDelivered = claimed !== null && claimed >= 2 && claimed <= 60 && returned < claimed;
  const requotes = unplaced.slice(0, 20);
  if ((!underDelivered && !requotes.length) || runOptions.signal?.aborted) {
    return response;
  }
  const label = providerLabel(provider);
  const stage = [
    underDelivered ? `described ${claimed} changes but returned ${returned}` : null,
    requotes.length ? `${requotes.length} quote${requotes.length === 1 ? "" : "s"} did not match the document` : null
  ].filter(Boolean).join("; ");
  setAiProgress(provider, `${label} ${stage} — asking once more`, undefined, request.requestedBy ?? null);
  const already = response.suggestions.map((suggestion) => `"${suggestion.title}"`).join(", ");
  const clipQuote = (text: string) => (text.length > 160 ? `${text.slice(0, 157)}…` : text);
  const instruction = [
    underDelivered
      ? `Your previous reply described ${claimed} changes but its suggestions array contained only ${returned}. Return the remaining ${(claimed ?? 0) - returned} now as suggestions — each with the exact original text copied verbatim from the document and its replacement (an empty replacement deletes the passage).`
      : null,
    requotes.length
      ? [
          `${requotes.length === 1 ? "This suggestion" : `These ${requotes.length} suggestions`} could not be placed because the original text was not found verbatim in the document. Re-quote each one by copying the document's exact text — no corrections, no reformatting — and return it again with the same replacement, one suggestion each:`,
          ...requotes.map((entry) => {
            const nearest = nearestDocumentExcerpt(request.documentText, entry.original);
            return `- "${entry.title}": you quoted ${JSON.stringify(clipQuote(entry.original))}${nearest ? `; the document reads ${JSON.stringify(clipQuote(nearest))}` : "; nothing similar was found — quote a passage that exists"}.`;
          })
        ].join("\n")
      : null,
    `Plus a one-line message. Return nothing else${returned ? `; do not repeat the ${returned} already accepted: ${already}` : ""}.`
  ].filter((line): line is string => line !== null).join("\n");
  const followUp: AiRequest = {
    ...request,
    agentSessionId: threadId,
    conversation: [
      ...(request.conversation ?? []),
      { role: "user", content: request.instruction },
      { role: "assistant", content: response.message }
    ],
    instruction
  };
  try {
    const raw = await runCli(provider, buildCliPrompt(followUp), runOptions, request.modelOptions ?? null, provider === "codex" ? threadId : null);
    const more = parseCliResponseDetailed(provider, raw, followUp);
    const seen = new Set(response.suggestions.map((suggestion) => normalizeWhitespace(suggestion.original)));
    const fresh = more.response.suggestions
      .filter((suggestion) => !seen.has(normalizeWhitespace(suggestion.original)))
      .map((suggestion, index) => ({ ...suggestion, ref: `S${returned + index + 1}` }));
    const stillUnplaced = requotes.length - Math.min(requotes.length, fresh.length);
    const noteParts = [
      underDelivered ? `${label} first returned ${returned} of the ${claimed} changes it described` : null,
      requotes.length ? `${requotes.length} quote${requotes.length === 1 ? "" : "s"} did not match the document` : null
    ].filter(Boolean).join("; ");
    if (!fresh.length) {
      return { ...response, message: `${response.message}\n\n(${noteParts}; an automatic follow-up produced no further exact-source edits.)` };
    }
    return {
      ...response,
      suggestions: [...response.suggestions, ...fresh],
      message: `${response.message}\n\n(${noteParts}; ${fresh.length} suggestion${fresh.length === 1 ? "" : "s"} came from an automatic follow-up${stillUnplaced > 0 && requotes.length ? `, ${stillUnplaced} still could not be placed` : ""}.)`
    };
  } catch (error) {
    if (runOptions.signal?.aborted) {
      return response;
    }
    return { ...response, message: `${response.message}\n\n(${label} ${stage}; the follow-up failed: ${formatCliDiagnostic(error instanceof Error ? error.message : String(error))}.)` };
  }
}

/** Parse the reply and publish the validation step so the UI never sits on a stale "writing" stage. */
function parseCliProgressedResponse(provider: CliProviderName, raw: string, request: AiRequest): AiResponse {
  setAiProgress(provider, "Checking the suggestions against the document", undefined, request.requestedBy ?? null);
  return parseCliResponse(provider, raw, request);
}

function writeCliSchemaFile(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "nebula-writer-schema-"));
  const path = join(dir, "ai-response.schema.json");
  writeFileSync(path, JSON.stringify(AI_RESPONSE_SCHEMA, null, 2), "utf8");
  return { dir, path };
}

export function parseCliResponse(provider: CliProviderName, raw: string, request: AiRequest): AiResponse {
  return parseCliResponseDetailed(provider, raw, request).response;
}

/** A suggestion the model wrote that could not be anchored even after repair — what a re-quote follow-up needs. */
interface UnplacedSuggestion {
  title: string;
  original: string;
  replacement: string;
}

function parseCliResponseDetailed(provider: CliProviderName, raw: string, request: AiRequest): { response: AiResponse; unplaced: UnplacedSuggestion[] } {
  const cleanedRaw = sanitizeCliOutput(raw);
  const parsed = parseStructuredResponse(cleanedRaw);
  if (!parsed) {
    return {
      response: {
        provider,
        message: isEventStreamWithoutAnswer(cleanedRaw)
          ? `The ${provider} CLI ended the turn without an answer${lastTranscriptPath ? ` (transcript: ${lastTranscriptPath})` : ""}. Send the request again.`
          : formatCliDiagnostic(cleanedRaw) || `The ${provider} provider returned an empty response.`,
        suggestions: []
      },
      unplaced: []
    };
  }

  // Every candidate is examined so malformed ones are reported, not lost
  // (normalizeSuggestion treats an explicit empty replacement as a deletion
  // and only a missing one as malformed).
  const candidates = (parsed.suggestions ?? []).filter((item): item is Partial<AiSuggestion> => Boolean(item) && typeof item === "object");
  const suggestionLimit = requestedSuggestionLimit(request);
  const limitedCandidates = suggestionLimit === null ? candidates : candidates.slice(0, suggestionLimit);
  // Refs follow the model's own array order so `[S3]` in its message means
  // the third suggestion it wrote, even when an earlier one was filtered out.
  const suggestions: AiSuggestion[] = [];
  const skipped: Array<{ title: string; reason: SkipReason }> = [];
  const repaired: Array<{ title: string; note: string }> = [];
  const unplaced: UnplacedSuggestion[] = [];
  limitedCandidates.forEach((item, index) => {
    const outcome = normalizeSuggestion(item, request);
    const title = String(item.title ?? "").trim() || `suggestion ${index + 1}`;
    if ("suggestion" in outcome) {
      suggestions.push({ ...outcome.suggestion, ref: `S${index + 1}` });
      if (outcome.note) {
        repaired.push({ title, note: outcome.note });
      }
    } else {
      skipped.push({ title, reason: outcome.skipped });
      if (outcome.skipped === "not-found") {
        unplaced.push({ title, original: String(item.original ?? ""), replacement: String(item.replacement ?? "") });
      }
    }
  });
  const message = formatCliDiagnostic(parsed.message || `The ${provider} provider returned ${suggestions.length} exact-source suggestion${suggestions.length === 1 ? "" : "s"}.`);
  const notes = [
    ...(repaired.length ? [`${repaired.length} quote${repaired.length === 1 ? " was" : "s were"} repaired to match the document exactly: ${repaired.slice(0, 3).map((entry) => `"${entry.title}" (${entry.note})`).join("; ")}${repaired.length > 3 ? `, +${repaired.length - 3} more` : ""}.`] : []),
    ...(skipped.length ? [describeSkippedSuggestions(skipped)] : [])
  ];

  return {
    response: {
      provider,
      message: notes.length ? `${message} ${notes.join(" ")}` : message,
      suggestions
    },
    unplaced
  };
}

type SkipReason = "not-found" | "no-change" | "malformed" | "image";

/**
 * Name what was dropped and why, so a reviewer can tell "the model misquoted
 * three passages" from "it proposed nothing new" instead of guessing.
 */
function describeSkippedSuggestions(skipped: Array<{ title: string; reason: SkipReason }>): string {
  const byReason = new Map<SkipReason, string[]>();
  for (const entry of skipped) {
    byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), entry.title]);
  }
  const label: Record<SkipReason, (count: number) => string> = {
    "not-found": (count) => `${count} because ${count === 1 ? "its" : "their"} original text was not found verbatim in the document`,
    "no-change": (count) => `${count} because ${count === 1 ? "it" : "they"} changed nothing`,
    "malformed": (count) => `${count} because ${count === 1 ? "it was" : "they were"} malformed (no replacement text)`,
    "image": (count) => `${count} because ${count === 1 ? "its" : "their"} image replacement was invalid (no such image index, or the file is missing, too large, or not PNG/JPEG/GIF/WebP)`
  };
  const parts = (["not-found", "no-change", "malformed", "image"] as SkipReason[])
    .filter((reason) => byReason.has(reason))
    .map((reason) => {
      const titles = byReason.get(reason) ?? [];
      const shown = titles.slice(0, 3).map((title) => `"${title.length > 60 ? `${title.slice(0, 57)}…` : title}"`).join(", ");
      return `${label[reason](titles.length)} (${shown}${titles.length > 3 ? `, +${titles.length - 3} more` : ""})`;
    });
  return `${skipped.length} suggestion${skipped.length === 1 ? " was" : "s were"} skipped: ${parts.join("; ")}.`;
}

function requestedSuggestionLimit(request: AiRequest): number | null {
  return typeof request.maxSuggestions === "number" && Number.isSafeInteger(request.maxSuggestions) && request.maxSuggestions > 0
    ? request.maxSuggestions
    : null;
}

type CliSuggestionPayload = {
  message?: string;
  suggestions?: Array<Partial<AiSuggestion>>;
};

function parseStructuredResponse(raw: string): CliSuggestionPayload | null {
  // Streamed output can carry several payload-shaped messages: with a JSON
  // output schema in force, a model's "I'll assess this…" preamble arrives as
  // {message, suggestions: []} before the real answer. So scan every line,
  // keep every payload, and let the final one win — preferring the last that
  // actually carries suggestions over a trailing "done" note.
  const payloads: CliSuggestionPayload[] = [];
  const streamedTextFragments: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const candidates = parseJsonLineCandidates(line);
    for (const candidate of candidates) {
      try {
        const parsedValue = JSON.parse(candidate);
        const payload = payloadFromValue(parsedValue);
        if (payload) {
          payloads.push(payload);
          continue;
        }
        streamedTextFragments.push(...extractStreamedTextFragments(parsedValue));
      } catch {
        // Ignore malformed fragments from mixed output.
      }
    }
  }
  if (payloads.length) {
    return selectFinalPayload(payloads);
  }

  // A single (possibly pretty-printed or fenced) JSON document.
  try {
    const direct = payloadFromValue(JSON.parse(extractJson(raw)));
    if (direct) {
      return direct;
    }
  } catch {
    // Fall through to streamed fragments.
  }

  if (streamedTextFragments.length > 0) {
    const payload = payloadFromValue(streamedTextFragments.join(""));
    if (payload) {
      return payload;
    }
  }

  return null;
}

/** True when the output is only stream events (thread/turn started…) with no answer in them — an interrupted or empty turn. */
function isEventStreamWithoutAnswer(raw: string): boolean {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    return false;
  }
  for (const line of lines) {
    if (!line.startsWith("{")) {
      return false;
    }
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown } };
      if (typeof event.type !== "string" || event.type === "result" || event.item?.type === "agent_message") {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export function selectFinalPayload(payloads: CliSuggestionPayload[]): CliSuggestionPayload {
  const withSuggestions = payloads.filter((payload) => Array.isArray(payload.suggestions) && payload.suggestions.length > 0);
  const pool = withSuggestions.length ? withSuggestions : payloads;
  return pool[pool.length - 1];
}

function parseJsonLineCandidates(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }

  // Accept SSE-style streamed output where JSON is prefixed by `data:`.
  const dataPrefix = "data:";
  if (trimmed.startsWith(dataPrefix)) {
    const value = trimmed.slice(dataPrefix.length).trim();
    if (!value || value === "[DONE]") {
      return [];
    }
    const prefixedDataCandidates = extractInlineJsonCandidates(value);
    return prefixedDataCandidates.length ? prefixedDataCandidates : looksLikeJson(value) ? [value] : [];
  }

  return extractInlineJsonCandidates(trimmed);
}

function looksLikeJson(value: string): boolean {
  return value.startsWith("{") || value.startsWith("[") || value.startsWith('"');
}

function extractInlineJsonCandidates(value: string): string[] {
  const candidates: string[] = [];
  const direct = parseableJsonCandidate(value);
  if (direct) {
    candidates.push(direct);
  }

  for (const candidate of extractBalancedJsonCandidates(value)) {
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function parseableJsonCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!looksLikeJson(trimmed)) {
    return null;
  }

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    const extracted = extractJson(trimmed).trim();
    if (extracted === trimmed || !looksLikeJson(extracted)) {
      return null;
    }
    try {
      JSON.parse(extracted);
      return extracted;
    } catch {
      return null;
    }
  }
}

function extractBalancedJsonCandidates(value: string): string[] {
  const candidates: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "{" && char !== "[") {
      continue;
    }
    const end = findBalancedJsonEnd(value, index);
    if (end === null) {
      continue;
    }
    const candidate = value.slice(index, end + 1).trim();
    try {
      JSON.parse(candidate);
      candidates.push(candidate);
      index = end;
    } catch {
      // Keep scanning; this may be a log fragment before the real payload.
    }
  }
  return candidates;
}

function findBalancedJsonEnd(value: string, start: number): number | null {
  const opener = value[start];
  const firstCloser = opener === "{" ? "}" : opener === "[" ? "]" : null;
  if (!firstCloser) {
    return null;
  }

  const stack = [firstCloser];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      stack.push("}");
      continue;
    }
    if (char === "[") {
      stack.push("]");
      continue;
    }
    if (char === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) {
        return index;
      }
    }
  }
  return null;
}

function payloadFromValue(value: unknown, depth = 0): CliSuggestionPayload | null {
  if (depth > 12 || !value) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const payload = payloadFromValue(item, depth + 1);
      if (payload) {
        return payload;
      }
    }
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return payloadFromValue(JSON.parse(extractJson(trimmed)), depth + 1);
    } catch {
      return null;
    }
  }

  if (typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.suggestions)) {
    return {
      message: typeof record.message === "string" ? record.message : undefined,
      suggestions: record.suggestions as Array<Partial<AiSuggestion>>
    };
  }

  const nestedKeys = [
    "response",
    "result",
    "structured_output",
    "output",
    "data",
    "message",
    "content",
    "text",
    "output_text",
    "params",
    "item",
    "msg"
  ];
  for (const key of nestedKeys) {
    const payload = payloadFromValue(record[key], depth + 1);
    if (payload) {
      return payload;
    }
  }

  return null;
}

function extractStreamedTextFragments(value: unknown, depth = 0): string[] {
  if (depth > 12 || value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractStreamedTextFragments(item, depth + 1));
  }

  if (typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const fragments: string[] = [];

  if (typeof record.delta === "string") {
    fragments.push(record.delta);
  }

  if (
    record.type === "content_block_delta"
    && record.delta
    && typeof record.delta === "object"
    && (record.delta as Record<string, unknown>).type === "text_delta"
    && typeof (record.delta as Record<string, unknown>).text === "string"
  ) {
    fragments.push((record.delta as Record<string, unknown>).text as string);
  }

  if (
    (record.type === "output_text" || record.type === "text_delta")
    && typeof record.text === "string"
  ) {
    fragments.push(record.text);
  }

  if (typeof record.output_text === "string") {
    fragments.push(record.output_text);
  }

  const nestedKeys = ["response", "result", "output", "data", "message", "content", "item", "event", "params", "msg"];
  for (const key of nestedKeys) {
    fragments.push(...extractStreamedTextFragments(record[key], depth + 1));
  }

  return fragments;
}

const DELETION_TITLE = /^\s*(delete|remove|cut|drop|strike)\b/i;
const DELETION_RATIONALE = /\b(delet\w*|remov\w*|cut(ting)?|drop\w*|strik\w*)\b/i;

/**
 * Models forced to fill a required `replacement` while meaning "delete this"
 * have been seen to emit filler ("Also, it does not seem possible for us to
 * make it any better.") that would land verbatim in the document. A
 * suggestion whose title and rationale both describe a deletion, and whose
 * replacement is neither a trimmed form of the original nor text from the
 * document, is a deletion.
 */
function isDisguisedDeletion(item: Partial<AiSuggestion>, original: string, replacement: string, documentText: string): boolean {
  if (!replacement || !DELETION_TITLE.test(String(item.title ?? "")) || !DELETION_RATIONALE.test(String(item.rationale ?? ""))) {
    return false;
  }
  const normalizedOriginal = normalizeWhitespace(original).toLowerCase();
  const normalizedReplacement = normalizeWhitespace(replacement).toLowerCase();
  if (normalizedOriginal.includes(normalizedReplacement) || normalizeWhitespace(documentText).toLowerCase().includes(normalizedReplacement)) {
    return false;
  }
  const words = (text: string) => new Set(text.split(/[^a-z0-9]+/).filter((word) => word.length > 3));
  const originalWords = words(normalizedOriginal);
  const shared = [...words(normalizedReplacement)].filter((word) => originalWords.has(word)).length;
  return shared <= 1;
}

function normalizeSuggestion(item: Partial<AiSuggestion>, request: AiRequest): { suggestion: AiSuggestion; note?: string } | { skipped: SkipReason } {
  if (isImageCandidate(item)) {
    const verdict = validateImageReplacementCandidate(item, request.documentImages ?? []);
    return verdict.ok ? { suggestion: verdict.suggestion } : { skipped: "image" };
  }
  const quotedOriginal = parseQuotedText(item.original);
  const quotedReplacement = parseQuotedText(item.replacement);
  const original = quotedOriginal.text;
  let replacement = quotedReplacement.text;
  let deletionRescued = false;
  if (!original) {
    return { skipped: "malformed" };
  }
  if (isDisguisedDeletion(item, original, replacement, request.documentText)) {
    replacement = "";
    deletionRescued = true;
  }
  // An explicit empty string proposes deleting the original (same contract as
  // the agentic staging tool); a missing field is malformed.
  if (!replacement && typeof item.replacement !== "string" && !deletionRescued) {
    return { skipped: "malformed" };
  }
  if (normalizeWhitespace(original) === normalizeWhitespace(replacement) && sameEmphasisSpans(quotedOriginal.spans, quotedReplacement.spans)) {
    return { skipped: "no-change" };
  }

  const selectionText = request.mode === "selection" ? request.selection?.text ?? "" : "";
  const inSelection = request.mode === "selection" && containsAnchoredText(selectionText, original);
  let anchoredOriginal = original;
  let anchoredReplacement = replacement;
  let note: string | undefined;
  if (!inSelection && !containsAnchoredText(request.documentText, original)) {
    // Self-healing: snap a near-miss quote to the document's exact text.
    const repaired = repairAnchor(request.documentText, original, replacement);
    if (!repaired) {
      return { skipped: "not-found" };
    }
    anchoredOriginal = repaired.original;
    anchoredReplacement = repaired.replacement;
    note = repaired.note;
  }

  const commentOnly = item.commentOnly === true || replacementRequiresAuthorConfirmation(anchoredReplacement);
  const anchor = suggestionAnchorFor(request.documentText, anchoredOriginal, inSelection ? request.selection?.from ?? null : null);
  const emphasis = stagedEmphasis({
    documentEmphasis: request.documentEmphasis,
    anchorOffset: anchor?.offset ?? null,
    original: anchoredOriginal,
    quotedReplacement,
    replacement: anchoredReplacement,
    explicit: quotedOriginal.marked || quotedReplacement.marked
  });
  return { ...(note ? { note } : {}), suggestion: {
    ...(commentOnly ? { commentOnly: true } : {}),
    ...(emphasis ? { emphasis } : {}),
    id: randomUUID(),
    title: item.title || "Revise passage",
    original: anchoredOriginal,
    replacement: anchoredReplacement,
    rationale: `${item.rationale || "Proposed by the selected local AI provider."}${deletionRescued ? " (The provider wrote placeholder text instead of an empty replacement; it was discarded and this is proposed as a deletion.)" : ""}`,
    confidence: normalizeConfidence(item.confidence),
    target: inSelection ? "selection" : "global",
    range: inSelection ? request.selection ?? null : null,
    anchor,
    status: "pending"
  } };
}


function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return extractBalancedJsonCandidates(raw.slice(first, last + 1))[0] ?? raw.slice(first, last + 1);
  }
  return raw;
}

function sanitizeCliOutput(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/\u0000/g, "")
    .replace(/\u001B\[[0-9;]*m/g, "")
    .trim();
}

function formatCliDiagnostic(value: string): string {
  const cleaned = sanitizeCliOutput(value);
  if (cleaned.length <= MAX_CLI_DIAGNOSTIC_CHARS) {
    return cleaned;
  }

  const marker = "\n... provider output truncated ...\n";
  const sliceBudget = MAX_CLI_DIAGNOSTIC_CHARS - marker.length;
  const headLength = Math.ceil(sliceBudget / 2);
  const tailLength = Math.floor(sliceBudget / 2);
  return `${cleaned.slice(0, headLength)}${marker}${cleaned.slice(-tailLength)}`;
}

function providerLabel(provider: CliProviderName): string {
  return provider === "codex" ? "Codex CLI" : "Claude Code";
}
