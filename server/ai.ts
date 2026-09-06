import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { type AiModelOptions, AI_CONTEXT_CHAR_LIMIT, type AiProviderName, type AiRequest, type AiResponse, type AiSuggestion, type ProviderSmokeResponse } from "../src/shared";
import { cliEnablementDiagnostic, cliTimeoutMs, formatCliTimeout, isCliExecutionEnabled, resolveCliCommand, type CliProviderName } from "./cli-runtime";
import { createAgentRun, deleteAgentRun, recordAgentActivity, type AgentRunContext } from "./agent-run";
import { describeWordHostContext } from "./word-context";
import { ensureWriterCliHome } from "./cli-home";
import { modelCliArgs } from "./model-catalog";
import { runAgentTurn, type AgentEvent } from "./agent-runtime";
import { broadcastAiProgress } from "./realtime";
import { containsAnchoredText, missingProtectedTokens, normalizeConfidence, normalizeWhitespace, replacementRequiresAuthorConfirmation } from "./suggestion-validation";

const SMOKE_TEST_TEXT = "This is actually very wordy [@smith2020] while $E=mc^2$ stays.";
const CLI_TIMEOUT_KILL_GRACE_MS = 500;
const MAX_CLI_OUTPUT_CHARS = 200_000;
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

interface AiRunOptions {
  signal?: AbortSignal;
}

export interface AiProgressSnapshot {
  provider: string;
  stage: string;
  requestedBy: string | null;
  passIndex: number | null;
  passTotal: number | null;
  startedAt: string;
  updatedAt: string;
  timeoutMs: number;
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

function setAiProgress(provider: string, stage: string, pass?: { index: number; total: number }, requestedBy?: string | null): void {
  const now = new Date().toISOString();
  currentAiProgress = {
    provider,
    stage,
    requestedBy: requestedBy ?? currentAiProgress?.requestedBy ?? null,
    passIndex: pass?.index ?? null,
    passTotal: pass?.total ?? null,
    startedAt: currentAiProgress?.startedAt ?? now,
    updatedAt: now,
    timeoutMs: cliTimeoutMs()
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
            description: "Exact source text copied verbatim from the provided Text block."
          },
          replacement: {
            type: "string",
            description: "Replacement text that preserves meaning unless the instruction asks otherwise. An empty string proposes DELETING the original — never invent filler text to stand in for a deletion."
          },
          rationale: {
            type: "string"
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1
          }
        },
        required: ["title", "original", "replacement", "rationale", "confidence"]
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
    return withModelOptions(request, { ...demoProvider(request), agentSessionId: request.agentSessionId ?? null });
  }

  const provider = request.provider as CliProviderName;
  return runQueuedAiRequest(
    { provider, requestedBy: request.requestedBy ?? null },
    () => {
      // The wait in the queue may outlive the requester (Stop button or a
      // closed tab aborts the HTTP request) — don't burn a CLI run for them.
      if (options.signal?.aborted) {
        throw new Error("The request was canceled while waiting in the AI queue.");
      }
      return cliProvider(provider, request, options);
    }
  );
}

export async function smokeTestProvider(provider: CliProviderName): Promise<ProviderSmokeResponse> {
  const startedAt = Date.now();
  const response = await cliProvider(provider, {
    provider,
    instruction: "Smoke test this local provider by making the selected sentence shorter while preserving the citation marker and formula exactly. Return one exact-source suggestion.",
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
    && missingProtectedTokens(suggestion.original, suggestion.replacement).length === 0
  );
  const ok = safeSuggestions.length > 0;

  return {
    provider,
    ok,
    message: ok
      ? `${providerLabel(provider)} returned ${safeSuggestions.length} exact-source, protected-token-safe suggestion${safeSuggestions.length === 1 ? "" : "s"}.`
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
    const runTurn = (sessionId: string | null) => runAgentTurn({
      provider,
      prompt: buildAgentTaskPrompt(sessionId ? request : { ...request, agentSessionId: null }, run),
      runUrl: agentRunUrl(run.id),
      workspaceDir: cliWorkspaceDir(),
      env: cliChildEnv(provider),
      sessionId,
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

export function buildAgentTaskPrompt(request: AiRequest, run: Pick<AgentRunContext, "maxSuggestions" | "attachments">): string {
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
    "You interact ONLY through the `writer` MCP tools — there is no filesystem and no shell.",
    "",
    `The document is ${request.documentText.length.toLocaleString()} characters long.`,
    ...(request.mode === "selection"
      ? selectionText.length <= AGENT_SELECTION_INLINE_LIMIT
        ? [
            "The user selected this passage; propose edits ONLY within it:",
            "<<<selection",
            selectionText,
            ">>>"
          ]
        : ["The user selected a passage; read it with writer_get_selection and propose edits ONLY within it."]
      : []),
    ...(request.hostContext ? ["", ...describeWordHostContext(request.hostContext, { mode: request.mode, tooling: "mcp" })] : []),
    ...describeConversation(request),
    "",
    "How to work:",
    "- Read by structure with writer_read_context: { what: \"paragraph\" } is the paragraph at the author's caret (before/after add neighbours), \"section\" the whole section under the nearest heading, \"page\" exactly what is on screen, \"outline\" every heading with offsets, \"document\" the size and outline. The window state is live: the author may move while you work, so re-read before staging when the request says \"here\" or \"this\".",
    "- For anything else, read windows with writer_read_document and locate passages with writer_search_document. Read what the instruction needs — often that is not the whole document.",
    "- Propose edits with writer_stage_suggestions, in small batches as you go. Each item's `original` must be copied VERBATIM from the " + (request.mode === "selection" ? "selection" : "document") + " — the tool validates every item and tells you which were rejected and why; fix those and retry.",
    "- Preserve citation markers, reference numbers, URLs, DOIs, equation labels, and math/formula tokens exactly. The validator enforces this.",
    "- Use commentOnly: true for advisory notes that need the author's judgment rather than a text change.",
    "- For broad review requests, spread edits across the document instead of only editing the opening.",
    run.maxSuggestions !== null
      ? `- Stage at most ${run.maxSuggestions} suggestion${run.maxSuggestions === 1 ? "" : "s"} — pick the highest-impact edits.`
      : "- Stage as many high-confidence, non-overlapping suggestions as are genuinely useful; avoid filler edits.",
    ...(request.agentSessionId
      ? ["- This is a follow-up in an ongoing conversation. The document may have changed since your earlier reads — re-verify anchors (writer_search_document) before staging."]
      : []),
    ...attachmentLines,
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
    setAiProgress(provider, `Waiting for the ${provider} CLI response`, undefined, request.requestedBy ?? null);
    const prompt = buildCliPrompt(request);
    const result = await runCli(provider, prompt, options, request.modelOptions ?? null);
    return parseCliResponse(provider, result, request);
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
    return " For long R01 sections, try a smaller selection or restart the sidecar with a larger WRITER_CLI_TIMEOUT_MS value (for example WRITER_CLI_TIMEOUT_MS=600000 for 10 minutes).";
  }
  if (/status 127|ENOENT|command not found|no such file|not found on PATH|env: node/i.test(rawMessage)) {
    return " The CLI executable (or its `node` runtime) was not found on PATH. Install it, or point WRITER_CODEX_PATH / WRITER_CLAUDE_PATH at the binary, then restart the sidecar.";
  }
  if (/exited with status \d+|terminated by signal/i.test(rawMessage)) {
    return " Run the provider smoke test (the activity button next to the provider picker) to diagnose, and check the sidecar terminal for the full CLI output.";
  }
  return "";
}

export function buildCliPrompt(request: AiRequest, options: CliPromptOptions = {}): string {
  const promptText = buildPromptText(request, options);
  const suggestionLimit = requestedSuggestionLimit(request);
  return [
    "You are an editorial assistant embedded in a DOCX-compatible writing tool.",
    "Return strict JSON only. The local CLI will validate the final answer against a JSON schema.",
    "Do not wrap the JSON in Markdown.",
    "Every suggestion must use exact text from the provided Text block.",
    "Set original to a verbatim substring of the Text block. Do not paraphrase original.",
    "Avoid generic repeated source-text targets such as headings, \"Rationale.\", \"Preliminary studies.\", or one-word placeholders by themselves; include nearby unique context in original so the DOCX review export can place the suggestion in the intended section.",
    "Do not edit Writer display metadata such as \"DOCX image preview unavailable\" placeholders; those mark preserved DOCX media and should remain untouched.",
    suggestionLimit === null
      ? "No explicit suggestion count cap is set. Return as many high-confidence, non-overlapping exact-source suggestions as are useful while keeping the JSON response valid and avoiding filler edits."
      : `Return up to ${suggestionLimit} high-confidence, non-overlapping exact-source suggestion${suggestionLimit === 1 ? "" : "s"}.`,
    "For a broad global R01 review, spread edits across the document instead of only editing the opening.",
    "To propose deleting a passage, set replacement to an empty string (\"\"). Never write a placeholder or filler sentence as the replacement for a deletion — the user's document would receive it verbatim.",
    "Preserve citation markers, reference numbers, URLs, DOIs, equation labels, and math/formula tokens exactly.",
    "Do not rewrite citation keys, LaTeX reference commands, or formulas. If a requested change would alter them, leave those protected tokens unchanged.",
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
    options.coveragePass
      ? `Complete-document coverage pass ${options.coveragePass.index} of ${options.coveragePass.total}. The Text block is a contiguous chunk covering characters ${options.coveragePass.start + 1}-${options.coveragePass.end} of ${options.coveragePass.totalLength}. Across all passes, the sidecar covers the full document. Use only exact source text visible in this chunk.`
      : null,
    ...buildAttachmentPromptLines(request),
    ...(request.hostContext && !options.coveragePass ? describeWordHostContext(request.hostContext, { mode: request.mode, tooling: "inline" }) : []),
    ...(options.coveragePass ? [] : describeConversation(request)),
    "Text:",
    promptText.text
  ].filter((line): line is string => line !== null).join("\n");
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
    return { text: options.coveragePass.text };
  }

  const scopedText = request.mode === "selection" ? request.selection?.text ?? "" : request.documentText;
  if (request.mode === "selection") {
    return {
      text: scopedText.slice(0, AI_CONTEXT_CHAR_LIMIT)
    };
  }

  return {
    text: scopedText
  };
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
    setAiProgress(provider, `Coverage pass ${chunk.index} of ${chunk.total}`, { index: chunk.index, total: chunk.total }, request.requestedBy ?? null);
    const chunkRequest: AiRequest = {
      ...request,
      documentText: chunk.text
    };
    try {
      const result = await runCli(provider, buildCliPrompt(chunkRequest, { coveragePass: chunk }), options, request.modelOptions ?? null);
      responses.push(parseCliResponse(provider, result, chunkRequest));
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

async function runCli(provider: CliProviderName, prompt: string, options: AiRunOptions = {}, modelOptions: AiModelOptions | null = null): Promise<string> {
  const resolvedCommand = resolveCliCommand(provider);
  if (!resolvedCommand.available || !resolvedCommand.command) {
    throw new Error(resolvedCommand.detail);
  }
  const command = resolvedCommand.command;
  const schemaFile = provider === "codex" ? writeCliSchemaFile() : null;
  const primaryArgs = buildCliArgs(provider, schemaFile?.path, modelOptions);

  try {
    return await runCliCommand(provider, command, primaryArgs, prompt, options);
  } catch (error) {
    const compatibilityArgs = buildCliCompatibilityArgs(provider, primaryArgs, error);
    if (!compatibilityArgs) {
      throw error;
    }
    try {
      return await runCliCommand(provider, command, compatibilityArgs, prompt, options);
    } catch (fallbackError) {
      const initialMessage = error instanceof Error ? error.message : String(error);
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
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
      env: cliChildEnv(provider)
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
    const timeoutMs = cliTimeoutMs();
    const terminate = (message: string) => {
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
    const appendOutput = (streamName: "stdout" | "stderr", current: string, chunk: Buffer | string) => {
      if (settled) {
        return current;
      }
      const next = current + String(chunk);
      if (next.length > MAX_CLI_OUTPUT_CHARS) {
        terminate(`${provider} produced more than ${MAX_CLI_OUTPUT_CHARS} characters on ${streamName}; aborting local provider request.`);
        return next.slice(0, MAX_CLI_OUTPUT_CHARS);
      }
      return next;
    };
    timeoutTimer = setTimeout(() => {
      terminate(`${provider} timed out after ${formatCliTimeout(timeoutMs)}`);
    }, timeoutMs);

    stdoutStream.on("data", (chunk) => {
      stdout = appendOutput("stdout", stdout, chunk);
    });
    stderrStream.on("data", (chunk) => {
      stderr = appendOutput("stderr", stderr, chunk);
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

export function cliChildEnv(provider: CliProviderName): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...CLI_ENV_OVERRIDES
  };
  // Confine each CLI's session/trajectory store to a Writer-owned home by
  // default so AI requests do not pile transcripts into your personal
  // ~/.claude / ~/.codex. Auth is bridged into that home (see cli-home.ts).
  // Opt out with WRITER_CLAUDE_CONFIG_DIR=default / WRITER_CODEX_HOME=default.
  const cliHome = ensureWriterCliHome(provider);
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
    return text.includes("output-schema") ? removeFlagWithValue(args, "--output-schema") : null;
  }

  let compatibilityArgs = args;
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

  return compatibilityArgs.length === args.length ? null : compatibilityArgs;
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

export function buildCliArgs(provider: CliProviderName, codexSchemaPath?: string, modelOptions: AiModelOptions | null = null): string[] {
  if (provider === "codex") {
    return [
      "exec",
      "-c",
      'service_tier="fast"',
      ...modelCliArgs(provider, modelOptions),
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      ...(codexSchemaPath ? ["--output-schema", codexSchemaPath] : []),
      "-"
    ];
  }

  return [
    "-p",
    ...modelCliArgs(provider, modelOptions),
    "--tools",
    "",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(AI_RESPONSE_SCHEMA)
  ];
}

function writeCliSchemaFile(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "nebula-writer-schema-"));
  const path = join(dir, "ai-response.schema.json");
  writeFileSync(path, JSON.stringify(AI_RESPONSE_SCHEMA, null, 2), "utf8");
  return { dir, path };
}

export function parseCliResponse(provider: CliProviderName, raw: string, request: AiRequest): AiResponse {
  const cleanedRaw = sanitizeCliOutput(raw);
  const parsed = parseStructuredResponse(cleanedRaw);
  if (!parsed) {
    return {
      provider,
      message: formatCliDiagnostic(cleanedRaw) || `The ${provider} provider returned an empty response.`,
      suggestions: []
    };
  }

  const candidates = (parsed.suggestions ?? [])
    // An explicit empty replacement is a deletion; only a missing one is malformed.
    .filter((item) => item.original && typeof item.replacement === "string");
  const suggestionLimit = requestedSuggestionLimit(request);
  const limitedCandidates = suggestionLimit === null ? candidates : candidates.slice(0, suggestionLimit);
  // Refs follow the model's own array order so `[S3]` in its message means
  // the third suggestion it wrote, even when an earlier one was filtered out.
  const suggestions = limitedCandidates
    .map((item, index): AiSuggestion | null => {
      const normalized = normalizeSuggestion(item, request);
      return normalized ? { ...normalized, ref: `S${index + 1}` } : null;
    })
    .filter((item): item is AiSuggestion => item !== null);
  const rejectedCount = limitedCandidates.length - suggestions.length;
  const message = formatCliDiagnostic(parsed.message || `The ${provider} provider returned ${suggestions.length} exact-source suggestion${suggestions.length === 1 ? "" : "s"}.`);

  return {
    provider,
    message: rejectedCount
      ? `${message} ${rejectedCount} suggestion${rejectedCount === 1 ? " was" : "s were"} skipped because it was not safely placed, was a no-op, or would drop protected reference/formula text.`
      : message,
    suggestions
  };
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
  try {
    const direct = payloadFromValue(JSON.parse(extractJson(raw)));
    if (direct) {
      return direct;
    }
  } catch {
    // Fall through to line-delimited JSON parsing.
  }

  const streamedTextFragments: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const candidates = parseJsonLineCandidates(line);
    for (const candidate of candidates) {
      try {
        const parsedValue = JSON.parse(candidate);
        const payload = payloadFromValue(parsedValue);
        if (payload) {
          return payload;
        }
        streamedTextFragments.push(...extractStreamedTextFragments(parsedValue));
      } catch {
        // Ignore malformed fragments from mixed output.
      }
    }
  }

  if (streamedTextFragments.length > 0) {
    const payload = payloadFromValue(streamedTextFragments.join(""));
    if (payload) {
      return payload;
    }
  }

  return null;
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

function normalizeSuggestion(item: Partial<AiSuggestion>, request: AiRequest): AiSuggestion | null {
  const original = String(item.original ?? "").trim();
  let replacement = String(item.replacement ?? "").trim();
  let deletionRescued = false;
  if (!original) {
    return null;
  }
  if (isDisguisedDeletion(item, original, replacement, request.documentText)) {
    replacement = "";
    deletionRescued = true;
  }
  // An explicit empty string proposes deleting the original (same contract as
  // the agentic staging tool); a missing field is malformed.
  if (!replacement && typeof item.replacement !== "string" && !deletionRescued) {
    return null;
  }
  if (normalizeWhitespace(original) === normalizeWhitespace(replacement)) {
    return null;
  }

  const scopeText = request.mode === "selection" ? request.selection?.text ?? "" : request.documentText;
  if (!containsAnchoredText(scopeText, original)) {
    return null;
  }
  if (missingProtectedTokens(original, replacement).length > 0) {
    return null;
  }

  const commentOnly = item.commentOnly === true || replacementRequiresAuthorConfirmation(replacement);
  return {
    ...(commentOnly ? { commentOnly: true } : {}),
    id: randomUUID(),
    title: item.title || "Revise passage",
    original,
    replacement,
    rationale: `${item.rationale || "Proposed by the selected local AI provider."}${deletionRescued ? " (The provider wrote placeholder text instead of an empty replacement; it was discarded and this is proposed as a deletion.)" : ""}`,
    confidence: normalizeConfidence(item.confidence),
    target: request.mode,
    range: request.mode === "selection" ? request.selection ?? null : null,
    status: "pending"
  };
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
