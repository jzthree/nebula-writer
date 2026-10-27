/**
 * Codex through its app-server (`codex app-server`, JSON-RPC over stdio)
 * instead of `codex exec`. The one thing exec cannot do is take input while a
 * turn runs; the app-server's `turn/steer` delivers a message into the active
 * turn, exactly like typing into the Codex CLI while it works.
 *
 * Everything downstream of the process stays as it was: app-server
 * notifications are translated into the JSONL events `codex exec --json`
 * prints (thread.started, item.started/completed with snake_case item types,
 * turn.completed/failed), so the stream parser, progress reporting,
 * transcripts and thread resume work unchanged.
 */

import { spawn } from "node:child_process";
import { elideLongPayloads } from "./cli-output";
import { registerSteerable, steerMessageText, type SteerResult } from "./steering";

export interface CodexAppServerRun {
  command: string;
  prompt: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  resumeThreadId: string | null;
  sandbox: "read-only" | "workspace-write";
  model?: string | null;
  effort?: string | null;
  outputSchema?: unknown;
  imagePaths?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Client run id: registers the turn for POST /api/ai/steer while it runs. */
  runId?: string | null;
  /** Each translated (exec-style) JSONL line, as it happens. */
  onLine?: (line: string) => void;
}

export interface CodexAppServerResult {
  /** The translated JSONL, one event per line (what `codex exec --json` would have printed). */
  output: string;
  /** The turn's final agent message (the structured reply). */
  finalMessage: string | null;
  threadId: string | null;
  stderr: string;
}

/** The app-server could not be used at all (an older Codex without it, or it failed to initialise): fall back to exec. */
export class CodexAppServerUnavailable extends Error {}

const KILL_GRACE_MS = 500;
const INITIALIZE_TIMEOUT_MS = 20_000;
const STDERR_TAIL_CHARS = 100_000;

type Json = Record<string, unknown>;

/** One app-server notification as the event `codex exec --json` prints for it, or null when exec has no counterpart. */
export function translateAppServerNotification(method: string, params: Json): Json | null {
  if (method === "turn/started") {
    return { type: "turn.started" };
  }
  if (method === "thread/compacted") {
    return { type: "thread.compacted" };
  }
  if (method === "item/started" || method === "item/completed") {
    const item = translateItem(params.item as Json | undefined);
    return item ? { type: method === "item/started" ? "item.started" : "item.completed", item } : null;
  }
  if (method === "turn/completed") {
    const turn = (params.turn ?? {}) as Json;
    const status = turn.status;
    if (status === "completed") {
      return { type: "turn.completed" };
    }
    const error = (turn.error ?? {}) as Json;
    const message = typeof error.message === "string" && error.message
      ? error.message
      : status === "interrupted" ? "Codex request was interrupted." : "Codex reported an error.";
    return { type: "turn.failed", message, error: { message } };
  }
  if (method === "error") {
    if (params.willRetry === true) {
      return null;
    }
    const error = (params.error ?? {}) as Json;
    const message = typeof error.message === "string" ? error.message : "Codex reported an error.";
    return { type: "error", message };
  }
  return null;
}

function translateItem(item: Json | undefined): Json | null {
  if (!item || typeof item.type !== "string") {
    return null;
  }
  const id = item.id;
  switch (item.type) {
    case "agentMessage":
      return { id, type: "agent_message", text: typeof item.text === "string" ? item.text : "" };
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? item.summary.join("\n") : "";
      const content = Array.isArray(item.content) ? item.content.join("\n") : "";
      return { id, type: "reasoning", text: summary || content };
    }
    case "commandExecution":
      return { id, type: "command_execution", command: item.command, aggregated_output: item.aggregatedOutput ?? "", exit_code: item.exitCode ?? null, status: item.status };
    case "mcpToolCall":
      return { id, type: "mcp_tool_call", server: item.server, tool: item.tool, arguments: item.arguments, result: item.result ?? null, error: item.error ?? null, status: item.status };
    case "contextCompaction":
      return { id, type: "context_compaction" };
    case "webSearch":
      return { id, type: "web_search", query: typeof item.query === "string" ? item.query : "" };
    case "userMessage": {
      // Kept for the transcript (a steered message shows where it landed); parsers ignore it.
      const content = Array.isArray(item.content) ? item.content as Json[] : [];
      return { id, type: "user_message", text: content.map((part) => (typeof part.text === "string" ? part.text : "")).join("") };
    }
    default:
      return null;
  }
}

/**
 * Answers to requests the app-server sends the client mid-turn. Writer runs
 * Codex non-interactively, so it answers the way `codex exec` does: nothing
 * is approved on the user's behalf beyond what the sandbox already allows.
 */
function serverRequestResponse(method: string): { result?: unknown; error?: { code: number; message: string } } {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { result: { decision: "decline" } };
    case "mcpServer/elicitation/request":
      return { result: { action: "cancel", content: null, _meta: null } };
    case "item/tool/requestUserInput":
      return { result: { answers: {} } };
    default:
      return { error: { code: -32601, message: `Nebula Writer cannot answer ${method} while running Codex non-interactively.` } };
  }
}

export function runCodexAppServer(run: CodexAppServerRun): Promise<CodexAppServerResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (run.signal?.aborted) {
      rejectPromise(new Error("codex request was interrupted."));
      return;
    }
    let child;
    try {
      child = spawn(run.command, ["app-server"], { cwd: run.cwd, env: run.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      rejectPromise(new CodexAppServerUnavailable(error instanceof Error ? error.message : String(error)));
      return;
    }
    let settled = false;
    let initialized = false;
    let threadId: string | null = null;
    let turnId: string | null = null;
    let finalMessage: string | null = null;
    let stderr = "";
    const lines: string[] = [];
    let buffer = "";
    let nextId = 0;
    const waiting = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
    let timeoutTimer: NodeJS.Timeout | undefined;
    let initTimer: NodeJS.Timeout | undefined;
    let unregister: () => void = () => undefined;

    const emit = (event: Json) => {
      const line = elideLongPayloads(JSON.stringify(event));
      lines.push(line);
      try {
        run.onLine?.(line);
      } catch {
        // Progress reporting must never break the run.
      }
    };
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const finish = (outcome: { ok: true } | { ok: false; error: Error }) => {
      if (settled) {
        return;
      }
      settled = true;
      unregister();
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (initTimer) {
        clearTimeout(initTimer);
      }
      run.signal?.removeEventListener("abort", onAbort);
      for (const waiter of waiting.values()) {
        waiter.reject(new Error("codex app-server closed"));
      }
      waiting.clear();
      kill();
      if (outcome.ok) {
        resolvePromise({ output: lines.join("\n"), finalMessage, threadId, stderr });
      } else {
        rejectPromise(outcome.error);
      }
    };
    const onAbort = () => {
      if (threadId && turnId) {
        void request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      }
      finish({ ok: false, error: new Error("codex request was interrupted.") });
    };
    run.signal?.addEventListener("abort", onAbort, { once: true });

    const write = (message: Json) => {
      if (!child.stdin.destroyed) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      }
    };
    const request = (method: string, params: unknown): Promise<Json> => new Promise((resolve, reject) => {
      const id = (nextId += 1);
      waiting.set(id, { resolve, reject });
      write({ id, method, params });
    });

    const handle = (message: Json) => {
      if (typeof message.id === "number" && !message.method) {
        const waiter = waiting.get(message.id);
        if (waiter) {
          waiting.delete(message.id);
          if (message.error) {
            const error = message.error as Json;
            waiter.reject(new Error(typeof error.message === "string" ? error.message : JSON.stringify(error)));
          } else {
            waiter.resolve((message.result ?? {}) as Json);
          }
        }
        return;
      }
      const method = typeof message.method === "string" ? message.method : "";
      const params = (message.params ?? {}) as Json;
      if (message.id !== undefined && method) {
        write({ id: message.id, ...serverRequestResponse(method) });
        return;
      }
      if (method === "turn/started") {
        const turn = (params.turn ?? {}) as Json;
        if (typeof turn.id === "string") {
          turnId = turn.id;
        }
      }
      const translated = translateAppServerNotification(method, params);
      if (!translated) {
        return;
      }
      const item = translated.item as Json | undefined;
      if (translated.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
        finalMessage = item.text;
      }
      emit(translated);
      if (translated.type === "turn.completed") {
        finish({ ok: true });
      } else if (translated.type === "turn.failed" || translated.type === "error") {
        finish({ ok: false, error: new Error(String(translated.message)) });
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            handle(JSON.parse(line) as Json);
          } catch {
            // Not JSON-RPC: ignore (diagnostics only).
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      finish({ ok: false, error: initialized ? error : new CodexAppServerUnavailable(error.message) });
    });
    child.on("close", (code) => {
      const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
      const message = `codex app-server exited${code === null ? "" : ` with code ${code}`} before the turn finished${detail ? `: ${detail}` : ""}`;
      finish({ ok: false, error: initialized ? new Error(message) : new CodexAppServerUnavailable(message) });
    });

    initTimer = setTimeout(() => {
      if (!initialized) {
        finish({ ok: false, error: new CodexAppServerUnavailable("codex app-server did not initialise in time") });
      }
    }, INITIALIZE_TIMEOUT_MS);

    void (async () => {
      try {
        await request("initialize", { clientInfo: { name: "nebula-writer", version: "1" }, capabilities: null });
      } catch (error) {
        finish({ ok: false, error: new CodexAppServerUnavailable(error instanceof Error ? error.message : String(error)) });
        return;
      }
      initialized = true;
      if (initTimer) {
        clearTimeout(initTimer);
      }
      write({ method: "initialized" });
      if (run.timeoutMs && run.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => finish({ ok: false, error: new Error(`codex timed out after ${Math.round(run.timeoutMs! / 1000)} s`) }), run.timeoutMs);
      }
      try {
        const threadParams = { cwd: run.cwd, sandbox: run.sandbox, approvalPolicy: "never", serviceTier: "fast" };
        const opened = run.resumeThreadId
          ? await request("thread/resume", { threadId: run.resumeThreadId, ...threadParams })
          : await request("thread/start", threadParams);
        const thread = (opened.thread ?? {}) as Json;
        threadId = typeof thread.id === "string" ? thread.id : run.resumeThreadId;
        if (threadId) {
          emit({ type: "thread.started", thread_id: threadId });
        }
        const input = [
          { type: "text", text: run.prompt, text_elements: [] },
          ...(run.imagePaths ?? []).map((path) => ({ type: "localImage", path }))
        ];
        const started = await request("turn/start", {
          threadId,
          input,
          ...(run.model ? { model: run.model } : {}),
          ...(run.effort ? { effort: run.effort } : {}),
          ...(run.outputSchema ? { outputSchema: run.outputSchema } : {})
        });
        const turn = (started.turn ?? {}) as Json;
        if (typeof turn.id === "string") {
          turnId = turn.id;
        }
        unregister = registerSteerable(run.runId, {
          provider: "codex",
          steer: async (text): Promise<SteerResult> => {
            if (settled || !threadId || !turnId) {
              return { ok: false, reason: "not-running" };
            }
            try {
              await request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: steerMessageText(text), text_elements: [] }] });
              return { ok: true };
            } catch (error) {
              return { ok: false, reason: "failed", detail: error instanceof Error ? error.message : String(error) };
            }
          }
        });
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error : new Error(String(error)) });
      }
    })();
  });
}
