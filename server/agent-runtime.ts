import type { AiModelOptions } from "../src/shared";
import { modelCliArgs } from "./model-catalog";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliTimeoutMs, formatCliTimeout, resolveCliCommand, type CliProviderName } from "./cli-runtime";
import type { AiToolAccess } from "../src/shared";
import { execViaGateway, gatewayAvailable } from "./gateway-client";

/**
 * Agentic CLI runner, ported from slides-mcp's agent-connector and adapted to
 * Writer. The CLI (Claude Code / Codex) is spawned as an agent whose entire
 * capability surface is Writer's per-run MCP server (server/agent-mcp.ts):
 * it reads the document through tools and stages suggestions through a
 * validated tool — it never sees the whole document in its prompt and never
 * writes files itself.
 *
 * Claude lockdown (validated end-to-end in slides-mcp):
 *  --tools "ToolSearch" restricts the BUILT-IN set to only ToolSearch, which
 *    strips Bash/Edit/Write/Read and every other built-in. MCP tools are a
 *    separate class and flow independently.
 *  --strict-mcp-config + a single-server config means the agent can reach
 *    nothing but this run's writer server.
 *  --allowedTools auto-approves those tools so nothing prompts.
 *
 * Codex has no built-in-tool allowlist; its confinement is the read-only
 * sandbox plus the single registered MCP server. Experimental, like in
 * slides-mcp.
 */

function codeRoot(): string {
  try {
    return resolve(fileURLToPath(new URL("..", import.meta.url)));
  } catch {
    // Non-file module URL (e.g. vitest's jsdom): the sidecar always runs
    // from the repo root, so fall back to cwd.
    return process.cwd();
  }
}

const KILL_GRACE_MS = 500;
const MAX_OUTPUT_CHARS = 400_000;

const CLI_ENV_OVERRIDES: NodeJS.ProcessEnv = {
  CLICOLOR: "0",
  FORCE_COLOR: "0",
  GIT_PAGER: "cat",
  NO_COLOR: "1",
  PAGER: "cat",
  TERM: "dumb",
  // The CLIs are Node programs; don't leak the sidecar's own loader hooks
  // (tsx, vitest) into them.
  NODE_OPTIONS: ""
};

export type AgentEvent =
  | { kind: "status"; stage: string; detail?: string }
  | { kind: "session"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "thinking" }
  | { kind: "tool"; tool: string; summary: string }
  | { kind: "result"; ok: boolean; text: string; cost: number | null; sessionId: string | null }
  | { kind: "error"; message: string };

export interface AgentTurnOptions {
  provider: CliProviderName;
  prompt: string;
  runUrl: string;
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: string | null;
  /** Model / reasoning override passed to the CLI (see model-catalog.ts). */
  modelOptions?: AiModelOptions | null;
  /** How much of the CLI's own tooling the turn may use (default: document only). */
  toolAccess?: AiToolAccess | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentTurnResult {
  ok: boolean;
  text: string;
  cost: number | null;
  sessionId: string | null;
  provider: CliProviderName;
}

function mcpServerLaunch(runUrl: string): { command: string; args: string[]; env: Record<string, string> } {
  const root = codeRoot();
  const entry = resolve(root, "server/agent-mcp.ts");
  const localTsx = resolve(root, "node_modules/.bin/tsx");
  const launch = existsSync(localTsx)
    ? { command: localTsx, args: [entry] }
    : { command: "npx", args: ["tsx", entry] };
  return { ...launch, env: { WRITER_AGENT_RUN_URL: runUrl } };
}

function writeMcpConfig(runUrl: string): { path: string; dispose: () => void } {
  const launch = mcpServerLaunch(runUrl);
  const dir = mkdtempSync(join(tmpdir(), "nebula-writer-agent-"));
  const path = join(dir, "mcp.json");
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        writer: { command: launch.command, args: launch.args, env: launch.env }
      }
    }),
    "utf8"
  );
  return {
    path,
    dispose: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort — a leaked temp dir is harmless.
      }
    }
  };
}

const READ_ONLY_CLAUDE_TOOLS = "WebSearch WebFetch Read Glob Grep";

/**
 * Claude's tool surface per access level. "document" is the original lockdown
 * (nothing but Writer's MCP server); "read" adds web and read-only files;
 * "full" drops the restrictions so the CLI runs as the user runs it — their
 * own MCP servers load alongside Writer's, and their permission settings
 * decide what else may run (a tool they have not allowed is denied, not
 * prompted, in print mode). Writer's tools are always pre-approved.
 */
function claudeToolArgs(toolAccess: AiToolAccess): string[] {
  switch (toolAccess) {
    case "full":
      return ["--allowedTools", "mcp__writer ToolSearch"];
    case "read":
      return ["--strict-mcp-config", "--tools", `ToolSearch ${READ_ONLY_CLAUDE_TOOLS}`, "--allowedTools", `mcp__writer ToolSearch ${READ_ONLY_CLAUDE_TOOLS}`];
    default:
      return ["--strict-mcp-config", "--tools", "ToolSearch", "--allowedTools", "mcp__writer ToolSearch"];
  }
}

export function buildAgentClaudeArgs(prompt: string, mcpConfigPath: string, sessionId: string | null, modelOptions: AiModelOptions | null = null, toolAccess: AiToolAccess = "document"): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfigPath,
    ...claudeToolArgs(toolAccess),
    ...modelCliArgs("claude", modelOptions)
  ];
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  return args;
}

export function buildAgentCodexArgs(prompt: string, runUrl: string, workspaceDir: string, sessionId: string | null, modelOptions: AiModelOptions | null = null, toolAccess: AiToolAccess = "document"): string[] {
  const launch = mcpServerLaunch(runUrl);
  const head = sessionId ? ["exec", "resume", sessionId] : ["exec"];
  // `codex exec` is non-interactive (no approval flag); confinement comes
  // from the sandbox (read-only, or workspace-write inside the Writer
  // workspace for full access) plus the registered MCP server. `exec resume`
  // keeps the session's sandbox and cwd and rejects those flags.
  return [
    ...head,
    "--json",
    "--skip-git-repo-check",
    ...(sessionId ? [] : ["-s", toolAccess === "full" ? "workspace-write" : "read-only", "-C", workspaceDir]),
    "-c",
    'service_tier="fast"',
    "-c",
    `mcp_servers.writer.command=${tomlString(launch.command)}`,
    "-c",
    `mcp_servers.writer.args=${tomlStringArray(launch.args)}`,
    "-c",
    `mcp_servers.writer.env.WRITER_AGENT_RUN_URL=${tomlString(runUrl)}`,
    ...modelCliArgs("codex", modelOptions),
    prompt
  ];
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
}

/**
 * A running agent CLI, abstracted so the stream-consumption logic below serves
 * two spawn paths identically: the shared gateway (server/gateway-client) when
 * it is running, and an in-process spawn otherwise. The gateway owns process
 * spawning + auth-home isolation; everything else — arg building, the MCP
 * server, stream parsing, timeout/abort — stays here.
 */
interface AgentProcess {
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  wait(): Promise<{ code: number | null }>;
  abort(): void;
}

function createAgentProcess(options: AgentTurnOptions, command: string, args: string[]): AgentProcess {
  // Prefer the gateway. It builds a clean login-shell env and handles homes
  // correctly (notably: on macOS it does NOT redirect claude's CLAUDE_CONFIG_DIR,
  // which would break keychain auth), so the gateway path only forwards the
  // colour/pager overrides — never process.env or a home var.
  if (gatewayAvailable()) {
    const gw = execViaGateway({
      provider: options.provider,
      bin: command,
      args,
      label: "writer",
      cwd: options.workspaceDir,
      env: { ...CLI_ENV_OVERRIDES } as Record<string, string>,
      // Let the client-side timeout below drive cancellation; give the gateway
      // a looser guard so the client wins the race and produces the nicer error.
      // With no local timeout, ask for the gateway's maximum (it caps at 1h).
      timeoutMs: gatewayTimeoutMs(options.timeoutMs ?? cliTimeoutMs())
    });
    if (gw) {
      return {
        onStdout: gw.onStdout,
        onStderr: gw.onStderr,
        wait: () => gw.done.then(({ code }) => ({ code })),
        abort: gw.abort
      };
    }
  }
  // In-process fallback: the gateway isn't running. Spawn exactly as before.
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: options.workspaceDir,
    env: { ...process.env, ...CLI_ENV_OVERRIDES, ...options.env }
  });
  let forceKillTimer: NodeJS.Timeout | undefined;
  return {
    onStdout: (cb) => child.stdout?.on("data", (chunk: Buffer) => cb(chunk.toString("utf8"))),
    onStderr: (cb) => child.stderr?.on("data", (chunk: Buffer) => cb(chunk.toString("utf8"))),
    wait: () => new Promise((resolvePromise, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        resolvePromise({ code });
      });
    }),
    abort: () => {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }
  };
}

export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const resolved = resolveCliCommand(options.provider);
  if (!resolved.available || !resolved.command) {
    throw new Error(resolved.detail);
  }
  const command = resolved.command;
  const onEvent = options.onEvent ?? (() => undefined);
  const mcpConfig = writeMcpConfig(options.runUrl);
  const args = options.provider === "claude"
    ? buildAgentClaudeArgs(options.prompt, mcpConfig.path, options.sessionId ?? null, options.modelOptions ?? null, options.toolAccess ?? "document")
    : buildAgentCodexArgs(options.prompt, options.runUrl, options.workspaceDir, options.sessionId ?? null, options.modelOptions ?? null, options.toolAccess ?? "document");
  const timeoutMs = options.timeoutMs ?? cliTimeoutMs();
  const parser = options.provider === "claude" ? new ClaudeStreamParser() : new CodexStreamParser();

  try {
    return await new Promise<AgentTurnResult>((resolvePromise, reject) => {
      let settled = false;
      let stdoutBuffer = "";
      let stderr = "";
      let outputChars = 0;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | null = null;

      const proc = createAgentProcess(options, command, args);

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        if (abortHandler && options.signal) {
          options.signal.removeEventListener("abort", abortHandler);
        }
        fn();
      };

      const terminate = (message: string) => {
        proc.abort();
        finish(() => reject(new Error(message)));
      };

      abortHandler = () => terminate(`${options.provider} request was interrupted.`);
      if (options.signal) {
        if (options.signal.aborted) {
          proc.abort();
          reject(new Error(`${options.provider} request was interrupted.`));
          return;
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          terminate(`${options.provider} timed out after ${formatCliTimeout(timeoutMs)}.`);
        }, timeoutMs);
      }

      proc.onStdout((chunk) => {
        if (settled) {
          return;
        }
        outputChars += chunk.length;
        if (outputChars > MAX_OUTPUT_CHARS) {
          terminate(`${options.provider} produced too much output; stopping.`);
          return;
        }
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          for (const event of parser.consume(line)) {
            onEvent(event);
          }
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });

      proc.onStderr((chunk) => {
        stderr = (stderr + chunk).slice(-4_000);
      });

      proc.wait().then(({ code }) => {
        if (settled) {
          return;
        }
        for (const event of parser.consume(stdoutBuffer)) {
          onEvent(event);
        }
        const outcome = parser.outcome();
        if (code === 0 || outcome.sawResult) {
          finish(() => resolvePromise({
            ok: outcome.ok,
            text: outcome.text,
            cost: outcome.cost,
            sessionId: outcome.sessionId,
            provider: options.provider
          }));
          return;
        }
        const message = outcome.text
          || stderr.trim()
          || `${options.provider} exited with status ${code ?? "unknown"}.`;
        finish(() => reject(new AgentTurnError(message, stderr)));
      }, (error: Error) => {
        finish(() => reject(error));
      });
    });
  } finally {
    mcpConfig.dispose();
  }
}

export class AgentTurnError extends Error {
  stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

interface ParserOutcome {
  ok: boolean;
  text: string;
  cost: number | null;
  sessionId: string | null;
  sawResult: boolean;
}

function stripMcpPrefix(toolName: string): string {
  return toolName.replace(/^mcp__writer__/, "").replace(/^mcp__[^_]+__/, "");
}

function summarizeToolInput(toolName: string, input: unknown): string {
  const bare = stripMcpPrefix(toolName);
  if (toolName === "ToolSearch") {
    return "looking up Writer tools";
  }
  if (!input || typeof input !== "object") {
    return bare;
  }
  const record = input as Record<string, unknown>;
  if (bare === "writer_stage_suggestions" && Array.isArray(record.suggestions)) {
    const count = record.suggestions.length;
    return `staging ${count} suggestion${count === 1 ? "" : "s"}`;
  }
  if (bare === "writer_read_document") {
    const offset = typeof record.offset === "number" ? record.offset : 0;
    return offset > 0 ? `reading the document from character ${offset}` : "reading the document";
  }
  if (bare === "writer_search_document" && typeof record.query === "string") {
    return `searching for "${record.query.slice(0, 40)}${record.query.length > 40 ? "…" : ""}"`;
  }
  if (bare === "writer_read_attachment" && typeof record.name === "string") {
    return `reading attachment ${record.name}`;
  }
  if (bare === "writer_get_selection") {
    return "reading the selection";
  }
  if (bare === "writer_read_context") {
    const what = typeof record.what === "string" ? record.what : "context";
    const anchor = typeof record.paragraph_index === "number"
      ? ` at paragraph ${record.paragraph_index + 1}`
      : typeof record.around === "number" || (typeof record.around === "string" && /^\d+$/.test(record.around))
        ? ` around offset ${record.around}`
        : "";
    const noun = what === "page" ? "the pages on screen" : what === "selection" ? "the selection" : what === "outline" ? "the outline" : what === "document" ? "the document structure" : `the ${what} at the caret`;
    return `reading ${noun}${anchor}`;
  }
  return bare;
}

const GATEWAY_MAX_TIMEOUT_MS = 60 * 60_000;

function gatewayTimeoutMs(localTimeoutMs: number): number {
  return localTimeoutMs > 0 ? localTimeoutMs + 30_000 : GATEWAY_MAX_TIMEOUT_MS;
}

export class ClaudeStreamParser {
  private text = "";
  private cost: number | null = null;
  private sessionId: string | null = null;
  private ok = false;
  private sawResult = false;

  consume(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed) {
      return [];
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return [];
    }
    const type = event.type;

    if (type === "system" && event.subtype === "init") {
      const sessionId = typeof event.session_id === "string" ? event.session_id : null;
      if (sessionId) {
        this.sessionId = sessionId;
        return [{ kind: "session", sessionId }, { kind: "status", stage: "connected", detail: "Connected to the document." }];
      }
      return [{ kind: "status", stage: "connected", detail: "Connected to the document." }];
    }

    if (type === "assistant") {
      return this.consumeAssistant(event);
    }

    if (type === "result") {
      this.sawResult = true;
      this.ok = event.subtype === "success" && event.is_error !== true;
      if (typeof event.result === "string" && event.result.trim()) {
        this.text = event.result.trim();
      }
      if (typeof event.total_cost_usd === "number") {
        this.cost = event.total_cost_usd;
      }
      if (typeof event.session_id === "string") {
        this.sessionId = event.session_id;
      }
      return [{ kind: "result", ok: this.ok, text: this.text, cost: this.cost, sessionId: this.sessionId }];
    }

    return [];
  }

  private consumeAssistant(event: Record<string, unknown>): AgentEvent[] {
    const message = event.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message?.content : [];
    const events: AgentEvent[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        this.text = block.text.trim();
        events.push({ kind: "text", text: block.text });
      } else if (block.type === "thinking") {
        events.push({ kind: "thinking" });
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        events.push({ kind: "tool", tool: stripMcpPrefix(block.name), summary: summarizeToolInput(block.name, block.input) });
      }
    }
    return events;
  }

  outcome(): ParserOutcome {
    return { ok: this.ok, text: this.text, cost: this.cost, sessionId: this.sessionId, sawResult: this.sawResult };
  }
}

/**
 * Codex reasoning items carry a short markdown summary ("**Reviewing Aim 2
 * rationale**\n\nThe paragraph…"). Keep the headline so progress reads as what
 * the model is doing right now, not a wall of text.
 */
export function summarizeReasoning(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[#>*\-\s]+|[*\s]+$/g, "").trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return "";
  }
  return firstLine.length > 120 ? `${firstLine.slice(0, 117).trimEnd()}…` : firstLine;
}

export class CodexStreamParser {
  private text = "";
  private sessionId: string | null = null;
  private sawResult = false;
  private ok = false;
  private readonly seenSearches = new Map<string, "start" | "query">();

  consume(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) {
      return [];
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return [];
    }
    const type = event.type;

    if (type === "thread.started" && typeof event.thread_id === "string") {
      this.sessionId = event.thread_id;
      return [{ kind: "session", sessionId: event.thread_id }, { kind: "status", stage: "connected", detail: "Connected to the document." }];
    }

    if (type === "turn.started") {
      return [{ kind: "status", stage: "working", detail: "Working…" }];
    }

    if (type === "item.started" || type === "item.completed") {
      return this.consumeItem(event, type === "item.completed");
    }

    if (type === "turn.completed") {
      this.sawResult = true;
      this.ok = true;
      return [{ kind: "result", ok: true, text: this.text, cost: null, sessionId: this.sessionId }];
    }

    if (type === "turn.failed" || type === "error") {
      this.sawResult = true;
      this.ok = false;
      const message = typeof event.message === "string" ? event.message : "Codex reported an error.";
      this.text = message;
      return [{ kind: "result", ok: false, text: message, cost: null, sessionId: this.sessionId }];
    }

    return [];
  }

  private consumeItem(event: Record<string, unknown>, completed: boolean): AgentEvent[] {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item || typeof item.type !== "string") {
      return [];
    }
    if (item.type === "agent_message") {
      if (completed && typeof item.text === "string" && item.text.trim()) {
        this.text = item.text.trim();
        return [{ kind: "text", text: item.text }];
      }
      return [];
    }
    if (item.type === "reasoning") {
      if (!completed) {
        return [{ kind: "thinking" }];
      }
      const summary = typeof item.text === "string" ? summarizeReasoning(item.text) : "";
      return summary ? [{ kind: "status", stage: "thinking", detail: summary }] : [];
    }
    if ((item.type === "mcp_tool_call" || item.type === "command_execution") && !completed) {
      const name = typeof item.tool === "string" ? item.tool : item.type === "command_execution" ? "command" : "tool";
      return [{ kind: "tool", tool: stripMcpPrefix(name), summary: summarizeToolInput(name, item.arguments ?? item) }];
    }
    if (item.type === "web_search") {
      // Codex announces the search on start with an empty query and fills the
      // query in on completion: report once at start, and again with the query
      // when it becomes known (never twice with the same information).
      const id = typeof item.id === "string" ? item.id : `${item.type}:${JSON.stringify(item.query ?? "")}`;
      const query = typeof item.query === "string" ? item.query.trim() : "";
      const seen = this.seenSearches.get(id);
      if (seen === "query" || (seen === "start" && !query)) {
        return [];
      }
      this.seenSearches.set(id, query ? "query" : "start");
      return [{ kind: "tool", tool: "web_search", summary: query ? `Searched the web for "${query.length > 80 ? `${query.slice(0, 77)}…` : query}"` : "Searching the web" }];
    }
    return [];
  }

  outcome(): ParserOutcome {
    return { ok: this.ok, text: this.text, cost: null, sessionId: this.sessionId, sawResult: this.sawResult };
  }
}
