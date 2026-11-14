/**
 * Antigravity through the Agent Client Protocol (`agy acp`, JSON-RPC over
 * stdio). ACP is the one way to give an Antigravity session Writer's per-run
 * MCP server: `session/new` takes MCP servers for that session alone, while
 * `agy -p` reads only the global config (and `--settings` rejects
 * `mcpServers`). One process serves one turn, as with Claude's print mode.
 *
 * Tool access maps onto Antigravity's own controls:
 *  - full: the CLI as the user runs it (their data dir and settings), in
 *    "auto" mode, which approves edits and safe commands itself;
 *  - read / document: a Writer-owned data dir (~/.gemini/nebula-writer, so
 *    Writer's conversations stay out of the user's history and the user's
 *    allow-lists do not apply), default mode.
 * A background run has nobody to approve anything, so every permission
 * request is answered here: Writer's own tools never ask; at "read",
 * read/search/fetch actions are allowed; everything else is declined, and the
 * activity log says what was declined.
 */

import { spawn } from "node:child_process";
import type { AiToolAccess } from "../src/shared";
import type { AgentEvent, AgentTurnOptions, AgentTurnResult } from "./agent-runtime";
import { getProviderCatalog } from "./model-catalog";

const KILL_GRACE_MS = 1_000;

/** Antigravity's data dir for Writer's runs, relative to ~/.gemini (it refuses absolute paths). */
export function antigravityDataDirArgs(toolAccess: AiToolAccess, env: NodeJS.ProcessEnv = process.env): string[] {
  if (toolAccess === "full") return [];
  const configured = env.WRITER_ANTIGRAVITY_DATA_DIR?.trim();
  if (configured && /^(default|off|0|none|false)$/i.test(configured)) return [];
  return ["--app-data-dir", configured || "nebula-writer"];
}

export function antigravityModeFor(toolAccess: AiToolAccess): string {
  return toolAccess === "full" ? "auto" : "default";
}

interface PermissionOption { optionId: string; name?: string; kind?: string }
interface ToolCallInfo { name?: string; kind?: string; title?: string; rawInput?: unknown; args?: unknown }

const READ_KINDS = new Set(["read", "search", "fetch", "think"]);

/** Whether a background run may let this action through; Writer's own tools never need asking. */
export function permits(toolAccess: AiToolAccess, call: ToolCallInfo): boolean {
  if (isWriterTool(call.name ?? "")) return true;
  return toolAccess !== "document" && READ_KINDS.has(call.kind ?? "");
}

function isWriterTool(name: string): boolean {
  return /^mcp_writer_/.test(name) || /^mcp__writer__/.test(name);
}

export function permissionAnswer(toolAccess: AiToolAccess, call: ToolCallInfo, options: PermissionOption[]): { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } } {
  const allow = permits(toolAccess, call);
  const choice = options.find((option) => (allow ? option.kind === "allow_once" : option.kind === "reject_once"))
    ?? options.find((option) => (allow ? option.kind?.startsWith("allow") : option.kind?.startsWith("reject")));
  return choice ? { outcome: { outcome: "selected", optionId: choice.optionId } } : { outcome: { outcome: "cancelled" } };
}

/** A tool call's input in the shape Writer's activity summaries read (command, description). */
export function toolCallInput(call: ToolCallInfo): Record<string, unknown> {
  const input = (call.rawInput ?? call.args ?? {}) as Record<string, unknown>;
  const command = typeof input.CommandLine === "string" ? input.CommandLine : input.command;
  const description = typeof input.toolSummary === "string" ? input.toolSummary : input.description;
  return { ...input, ...(command !== undefined ? { command } : {}), ...(description !== undefined ? { description } : {}) };
}

/**
 * Turns ACP session updates into Writer's agent events. Pure: the runtime
 * below feeds it; tests feed it recorded updates.
 */
export class AcpUpdateMapper {
  private text = "";
  private messageOpen = false;
  private thinking = false;
  private readonly announced = new Set<string>();

  constructor(private readonly summarize: (toolName: string, input: unknown) => string, private readonly toolName: (name: string) => string) {}

  consume(update: Record<string, unknown>): AgentEvent[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type !== "text" || !content.text) return [];
        if (!this.messageOpen) {
          // A new message after tool calls replaces the earlier text: the final message is the reply.
          this.text = "";
          this.messageOpen = true;
        }
        this.thinking = false;
        this.text += content.text;
        return [{ kind: "text", text: content.text }];
      }
      case "agent_thought_chunk": {
        this.messageOpen = false;
        if (this.thinking) return [];
        this.thinking = true;
        return [{ kind: "thinking" }];
      }
      case "tool_call":
      case "tool_call_update": {
        this.messageOpen = false;
        this.thinking = false;
        const id = typeof update.toolCallId === "string" ? update.toolCallId : null;
        const name = typeof update.name === "string" ? update.name : typeof update.title === "string" ? update.title : "tool";
        if (!id || this.announced.has(id)) return [];
        this.announced.add(id);
        return [{ kind: "tool", tool: this.toolName(name), summary: this.summarize(name, toolCallInput(update as ToolCallInfo)) }];
      }
      case "plan": {
        const entries = Array.isArray(update.entries) ? update.entries as Array<{ content?: string; status?: string }> : [];
        const current = entries.find((entry) => entry.status === "in_progress") ?? entries.find((entry) => entry.status !== "completed");
        return current?.content ? [{ kind: "status", stage: "working", detail: current.content.slice(0, 120) }] : [];
      }
      default:
        return [];
    }
  }

  reply(): string {
    return this.text.trim();
  }
}

interface RpcMessage { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string } }

export class AcpError extends Error {}

/**
 * One Antigravity turn: start `agy acp`, open (or reload) the session with
 * Writer's MCP server, pick the model and mode, send the prompt, and stream
 * the updates as agent events until the turn ends.
 */
export async function runAcpTurn(options: AgentTurnOptions, command: string, mcpServer: { command: string; args: string[]; env: Record<string, string> },
  helpers: { summarize: (toolName: string, input: unknown) => string; toolName: (name: string) => string; childEnv: NodeJS.ProcessEnv }): Promise<AgentTurnResult> {
  const toolAccess = options.toolAccess ?? "document";
  const onEvent = options.onEvent ?? (() => undefined);
  const child = spawn(command, ["acp", ...antigravityDataDirArgs(toolAccess)], { cwd: options.workspaceDir, stdio: ["pipe", "pipe", "pipe"], env: { ...helpers.childEnv, ...options.env } });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let stderr = "";
  let buffer = "";
  let closed = false;
  let sessionId: string | null = null;
  let streaming = false;
  const mapper = new AcpUpdateMapper(helpers.summarize, helpers.toolName);

  const write = (message: object) => {
    if (!closed && child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const request = <T>(method: string, params: object): Promise<T> => new Promise<T>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    write({ id, method, params });
  });

  const handle = (message: RpcMessage) => {
    if (message.id !== undefined && !message.method) {
      const waiter = pending.get(Number(message.id));
      if (!waiter) return;
      pending.delete(Number(message.id));
      if (message.error) waiter.reject(new AcpError(message.error.message || "Antigravity reported an error."));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === "session/update") {
      // Updates replayed while a session reloads are history, not this turn.
      if (!streaming) return;
      for (const event of mapper.consume((message.params?.update ?? {}) as Record<string, unknown>)) onEvent(event);
      return;
    }
    if (message.method === "session/request_permission" && message.id !== undefined) {
      const call = (message.params?.toolCall ?? {}) as ToolCallInfo;
      const answer = permissionAnswer(toolAccess, call, (message.params?.options ?? []) as PermissionOption[]);
      if (!permits(toolAccess, call)) {
        const what = helpers.summarize(call.name ?? call.title ?? "an action", toolCallInput(call));
        onEvent({ kind: "status", stage: "declined", detail: `Declined: ${what} (nobody can approve it in a background run)` });
      }
      write({ id: message.id, result: answer });
      return;
    }
    if (message.id !== undefined && message.method) {
      // Writer offers no client capabilities (files, terminals): say so instead of leaving the agent waiting.
      write({ id: message.id, error: { code: -32601, message: `${message.method} is not available in Writer.` } });
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("{")) {
        try { handle(JSON.parse(line) as RpcMessage); } catch { /* Not a protocol line. */ }
      }
      newline = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4_000); });
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", (error) => { stderr += `\n${error.message}`; resolve(null); });
    child.on("close", (code) => resolve(code));
  });
  void exited.then((code) => {
    closed = true;
    for (const waiter of pending.values()) waiter.reject(new AcpError(stderr.trim() || `Antigravity exited with status ${code ?? "unknown"}.`));
    pending.clear();
  });

  let killTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let abort: (() => void) | null = null;
  const stop = () => {
    if (sessionId) write({ method: "session/cancel", params: { sessionId } });
    killTimer ??= setTimeout(() => child.kill("SIGTERM"), KILL_GRACE_MS);
  };
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => { stop(); reject(new Error(`${options.provider} request was interrupted.`)); };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    if ((options.timeoutMs ?? 0) > 0) {
      timeoutTimer = setTimeout(() => { stop(); reject(new Error(`${options.provider} timed out.`)); }, options.timeoutMs);
    }
  });
  interrupted.catch(() => undefined);

  const turn = (async (): Promise<AgentTurnResult> => {
    await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const mcpServers = [{ name: "writer", command: mcpServer.command, args: mcpServer.args, env: Object.entries(mcpServer.env).map(([name, value]) => ({ name, value })) }];
    let session: { sessionId?: string; models?: { currentModelId?: string; availableModels?: Array<{ modelId: string }> } };
    if (options.sessionId) {
      await request("session/load", { sessionId: options.sessionId, cwd: options.workspaceDir, mcpServers }).catch((error: Error) => {
        throw new AcpError(`Could not resume Antigravity conversation ${options.sessionId}: session not found (${error.message})`);
      });
      session = { sessionId: options.sessionId };
    } else {
      session = await request("session/new", { cwd: options.workspaceDir, mcpServers });
    }
    sessionId = session.sessionId ?? null;
    if (!sessionId) throw new AcpError("Antigravity did not open a session.");
    onEvent({ kind: "session", sessionId });
    onEvent({ kind: "status", stage: "connected", detail: "Connected to the document." });
    // Writer's own data dir has none of the user's settings: start it on the model they chose as default.
    const model = options.modelOptions?.model?.trim()
      || (antigravityDataDirArgs(toolAccess).length ? (await getProviderCatalog("antigravity").catch(() => null))?.defaults.model ?? null : null);
    if (model && model !== session.models?.currentModelId) {
      await request("session/set_model", { sessionId, modelId: model });
    }
    await request("session/set_mode", { sessionId, modeId: antigravityModeFor(toolAccess) }).catch(() => undefined);
    streaming = true;
    const result = await request<{ stopReason?: string }>("session/prompt", { sessionId, prompt: [{ type: "text", text: options.prompt }] });
    const ok = result?.stopReason === "end_turn";
    const text = mapper.reply() || (ok ? "" : `Antigravity stopped (${result?.stopReason ?? "unknown reason"}).`);
    onEvent({ kind: "result", ok, text, cost: null, sessionId });
    return { ok, text, cost: null, sessionId, provider: options.provider };
  })();

  turn.catch(() => undefined);
  try {
    return await Promise.race([turn, interrupted]);
  } finally {
    if (abort) options.signal?.removeEventListener("abort", abort);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    child.stdin.end();
    killTimer ??= setTimeout(() => child.kill("SIGTERM"), KILL_GRACE_MS);
    void exited.then(() => clearTimeout(killTimer));
  }
}
