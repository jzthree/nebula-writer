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

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

/**
 * Early signs of a turn the exec-shaped events only report once a whole item is
 * done: each reasoning headline as soon as it is written, and each suggestion's
 * title as the JSON reply reaches it. Per-token deltas go no further than here.
 */
export class TurnDeltaTracker {
  private readonly headlines = new Map<string, string>();
  private readonly announced = new Set<string>();
  private reply = "";
  private replyScanned = 0;
  private drafted = 0;
  private readonly objects = new SuggestionObjectScanner();

  consume(method: string, params: Json): Json[] {
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (!delta) {
      return [];
    }
    if (method === "item/reasoning/summaryTextDelta") {
      const key = `${String(params.itemId)}:${String(params.summaryIndex ?? 0)}`;
      const text = (this.headlines.get(key) ?? "") + delta;
      this.headlines.set(key, text);
      const headline = /^\s*\*\*(.+?)\*\*/.exec(text)?.[1];
      if (!headline || this.announced.has(key)) {
        return [];
      }
      this.announced.add(key);
      return [{ type: "reasoning.headline", item_id: params.itemId, text: headline }];
    }
    if (method === "item/agentMessage/delta") {
      this.reply += delta;
      const events: Json[] = [];
      const pattern = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      pattern.lastIndex = this.replyScanned;
      for (let match = pattern.exec(this.reply); match; match = pattern.exec(this.reply)) {
        this.replyScanned = pattern.lastIndex;
        this.drafted += 1;
        let title = match[1];
        try {
          title = JSON.parse(`"${match[1]}"`) as string;
        } catch {
          // Shown as written.
        }
        events.push({ type: "suggestion.drafted", index: this.drafted, title });
      }
      for (const item of this.objects.push(delta)) {
        events.push({ type: "suggestion.parsed", item });
      }
      return events;
    }
    return [];
  }
}

/**
 * Each object of the reply's "suggestions" array, as soon as its closing brace
 * streams in. Strings are tracked so braces inside quoted text do not count.
 */
export class SuggestionObjectScanner {
  private text = "";
  private position = 0;
  private arrayFound = false;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private objectStart = -1;

  push(delta: string): Json[] {
    this.text += delta;
    const found: Json[] = [];
    if (!this.arrayFound) {
      const match = /"suggestions"\s*:\s*\[/.exec(this.text);
      if (!match) {
        return found;
      }
      this.arrayFound = true;
      this.position = match.index + match[0].length;
    }
    for (; this.position < this.text.length; this.position += 1) {
      const char = this.text[this.position];
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
        } else if (char === "\\") {
          this.escaped = true;
        } else if (char === '"') {
          this.inString = false;
        }
        continue;
      }
      if (char === '"') {
        this.inString = true;
      } else if (char === "{" || char === "[") {
        if (char === "{" && this.depth === 0) {
          this.objectStart = this.position;
        }
        this.depth += 1;
      } else if (char === "}" || char === "]") {
        if (this.depth === 0) {
          // The suggestions array closed.
          this.position = this.text.length;
          this.arrayFound = true;
          this.text = "";
          return found;
        }
        this.depth -= 1;
        if (char === "}" && this.depth === 0 && this.objectStart >= 0) {
          try {
            const parsed = JSON.parse(this.text.slice(this.objectStart, this.position + 1)) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              found.push(parsed as Json);
            }
          } catch {
            // Not a whole object after all; the final reply is the record.
          }
          this.objectStart = -1;
        }
      }
    }
    return found;
  }
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

/**
 * How long an idle app-server is kept for the next turn (WRITER_CODEX_KEEPALIVE_MS;
 * 0 starts one per turn). Reopening a thread in a fresh process costs seconds
 * (MCP servers, plugins, the thread's history) and can change the skills Codex
 * announces, which it then re-sends into the conversation.
 */
export function codexKeepAliveMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WRITER_CODEX_KEEPALIVE_MS?.trim();
  if (raw && /^\d+$/.test(raw)) {
    return Number(raw);
  }
  return DEFAULT_KEEPALIVE_MS;
}

const DEFAULT_KEEPALIVE_MS = 30 * 60_000;

interface TurnSink {
  notify(method: string, params: Json): void;
  closed(error: Error): void;
}

/** One running `codex app-server`: shared by every turn whose settings match, until it sits idle. */
class AppServerProcess {
  readonly ready: Promise<void>;
  readonly loadedThreads = new Set<string>();
  closed = false;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  private readonly sinks = new Map<string, TurnSink>();
  private nextId = 0;
  private buffer = "";
  private stderrText = "";
  private stderrTotal = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private initialized = false;

  constructor(command: string, cwd: string, env: NodeJS.ProcessEnv, private readonly keepAliveMs: number, private readonly onClose: () => void) {
    this.child = spawn(command, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrText = (this.stderrText + chunk).slice(-STDERR_TAIL_CHARS);
      this.stderrTotal += chunk.length;
    });
    this.child.stdin.on("error", () => undefined);
    let failed: (error: Error) => void = () => undefined;
    const startFailure = new Promise<never>((_, reject) => {
      failed = reject;
    });
    startFailure.catch(() => undefined);
    this.child.on("error", (error) => {
      failed(new CodexAppServerUnavailable(error.message));
      this.shutdown(error);
    });
    this.child.on("close", (code) => {
      const detail = this.stderrText.trim().split("\n").slice(-3).join(" ").slice(0, 400);
      const message = `codex app-server exited${code === null ? "" : ` with code ${code}`}${this.sinks.size ? " before the turn finished" : ""}${detail ? `: ${detail}` : ""}`;
      failed(new CodexAppServerUnavailable(message));
      this.shutdown(new Error(message));
    });
    this.ready = Promise.race([
      startFailure,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new CodexAppServerUnavailable("codex app-server did not initialise in time")), INITIALIZE_TIMEOUT_MS).unref();
      }),
      (async () => {
        try {
          await this.request("initialize", { clientInfo: { name: "nebula-writer", version: "1" }, capabilities: null });
        } catch (error) {
          throw new CodexAppServerUnavailable(error instanceof Error ? error.message : String(error));
        }
        this.initialized = true;
        this.write({ method: "initialized" });
      })()
    ]);
    this.ready.catch(() => this.kill());
  }

  request(method: string, params: unknown): Promise<Json> {
    if (this.closed) {
      return Promise.reject(new Error("codex app-server closed"));
    }
    return new Promise((resolve, reject) => {
      const id = (this.nextId += 1);
      this.waiting.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  /** Route the thread's notifications to `sink` while its turn runs. */
  attach(threadId: string, sink: TurnSink): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.child.ref();
    this.sinks.set(threadId, sink);
  }

  detach(threadId: string, sink: TurnSink): void {
    if (this.sinks.get(threadId) === sink) {
      this.sinks.delete(threadId);
    }
    this.idleIfUnused();
  }

  busy(threadId: string): boolean {
    return this.sinks.has(threadId);
  }

  /** Where stderr stands now, to report only what a turn added. */
  stderrMark(): number {
    return this.stderrTotal;
  }

  stderrSince(mark: number): string {
    const added = this.stderrTotal - mark;
    return added <= 0 ? "" : this.stderrText.slice(-Math.min(added, this.stderrText.length));
  }

  idleIfUnused(): void {
    if (this.sinks.size || this.closed) {
      return;
    }
    if (this.keepAliveMs <= 0) {
      this.kill();
      return;
    }
    // Idle: it must not keep the sidecar (or a test run) alive.
    this.child.unref();
    if (!this.idleTimer) {
      this.idleTimer = setTimeout(() => this.kill(), this.keepAliveMs);
      this.idleTimer.unref();
    }
  }

  kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      setTimeout(() => this.child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    }
    this.shutdown(new Error("codex app-server closed"));
  }

  private shutdown(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    for (const waiter of this.waiting.values()) {
      waiter.reject(this.initialized ? error : new CodexAppServerUnavailable(error.message));
    }
    this.waiting.clear();
    for (const sink of [...this.sinks.values()]) {
      sink.closed(error);
    }
    this.sinks.clear();
    this.onClose();
  }

  private write(message: Json): void {
    if (!this.child.stdin.destroyed) {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    }
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        let message: Json | null = null;
        try {
          message = JSON.parse(line) as Json;
        } catch {
          // Not JSON-RPC: ignore (diagnostics only).
        }
        if (message) {
          this.handle(message);
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private handle(message: Json): void {
    if (typeof message.id === "number" && !message.method) {
      const waiter = this.waiting.get(message.id);
      if (waiter) {
        this.waiting.delete(message.id);
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
      this.write({ id: message.id, ...serverRequestResponse(method) });
      return;
    }
    // Notifications name their thread; one without a name belongs to the only turn running, if there is one.
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const sink = threadId ? this.sinks.get(threadId) : this.sinks.size === 1 ? [...this.sinks.values()][0] : undefined;
    sink?.notify(method, params);
  }
}

const pool = new Map<string, AppServerProcess>();

function processFor(run: CodexAppServerRun, keepAliveMs: number): AppServerProcess {
  if (keepAliveMs <= 0) {
    return new AppServerProcess(run.command, run.cwd, run.env, 0, () => undefined);
  }
  // Same binary, folder, sandbox and environment (CODEX_HOME, tool access) → the same process.
  const key = JSON.stringify([run.command, run.cwd, run.sandbox, Object.entries(run.env).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))]);
  const existing = pool.get(key);
  if (existing && !existing.closed) {
    return existing;
  }
  const created = new AppServerProcess(run.command, run.cwd, run.env, keepAliveMs, () => {
    if (pool.get(key) === created) {
      pool.delete(key);
    }
  });
  pool.set(key, created);
  return created;
}

/** Stop every kept app-server (sidecar shutdown, tests). */
export function closeCodexAppServers(): void {
  for (const process of [...pool.values()]) {
    process.kill();
  }
  pool.clear();
}

process.once("exit", closeCodexAppServers);

export async function runCodexAppServer(run: CodexAppServerRun): Promise<CodexAppServerResult> {
  if (run.signal?.aborted) {
    throw new Error("codex request was interrupted.");
  }
  let server: AppServerProcess;
  try {
    server = processFor(run, codexKeepAliveMs());
  } catch (error) {
    throw new CodexAppServerUnavailable(error instanceof Error ? error.message : String(error));
  }
  await server.ready;
  const stderrMark = server.stderrMark();
  const lines: string[] = [];
  let finalMessage: string | null = null;
  let threadId: string | null = null;
  let turnId: string | null = null;
  const emit = (event: Json) => {
    const line = elideLongPayloads(JSON.stringify(event));
    lines.push(line);
    try {
      run.onLine?.(line);
    } catch {
      // Progress reporting must never break the run.
    }
  };

  return new Promise<CodexAppServerResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let unregister: () => void = () => undefined;
    const deltas = new TurnDeltaTracker();
    const sink: TurnSink = {
      notify: (method, params) => {
        // A stopped turn on this thread can still report in: only this turn's events count.
        const turnOf = typeof params.turnId === "string" ? params.turnId : typeof (params.turn as Json | undefined)?.id === "string" ? (params.turn as Json).id as string : null;
        if (method === "turn/started") {
          if (turnId === null && turnOf) {
            turnId = turnOf;
          }
        } else if (turnOf && turnId !== null && turnOf !== turnId) {
          return;
        } else if (turnOf && turnId === null) {
          return;
        }
        for (const early of deltas.consume(method, params)) {
          emit(early);
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
      },
      closed: (error) => finish({ ok: false, error })
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
      run.signal?.removeEventListener("abort", onAbort);
      if (threadId) {
        server.detach(threadId, sink);
      } else {
        server.idleIfUnused();
      }
      const stderr = server.stderrSince(stderrMark);
      if (outcome.ok) {
        resolvePromise({ output: lines.join("\n"), finalMessage, threadId, stderr });
      } else {
        rejectPromise(outcome.error);
      }
    };
    // Stopping a turn interrupts it; the process stays for the next one.
    const interrupt = (error: Error) => {
      if (threadId && turnId) {
        void server.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      }
      finish({ ok: false, error });
    };
    const onAbort = () => interrupt(new Error("codex request was interrupted."));
    run.signal?.addEventListener("abort", onAbort, { once: true });
    if (run.timeoutMs && run.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => interrupt(new Error(`codex timed out after ${Math.round(run.timeoutMs! / 1000)} s`)), run.timeoutMs);
    }

    void (async () => {
      try {
        const threadParams = { cwd: run.cwd, sandbox: run.sandbox, approvalPolicy: "never", serviceTier: "fast" };
        if (run.resumeThreadId && server.loadedThreads.has(run.resumeThreadId)) {
          // Still loaded from an earlier turn in this process: nothing to reopen.
          threadId = run.resumeThreadId;
        } else {
          const opened = run.resumeThreadId
            ? await server.request("thread/resume", { threadId: run.resumeThreadId, ...threadParams })
            : await server.request("thread/start", threadParams);
          const thread = (opened.thread ?? {}) as Json;
          threadId = typeof thread.id === "string" ? thread.id : run.resumeThreadId;
        }
        if (settled) {
          return;
        }
        if (!threadId) {
          throw new Error("codex app-server did not return a thread.");
        }
        if (server.busy(threadId)) {
          throw new Error("This conversation already has a Codex turn running.");
        }
        server.loadedThreads.add(threadId);
        server.attach(threadId, sink);
        emit({ type: "thread.started", thread_id: threadId });
        const input = [
          { type: "text", text: run.prompt, text_elements: [] },
          ...(run.imagePaths ?? []).map((path) => ({ type: "localImage", path }))
        ];
        const started = await server.request("turn/start", {
          threadId,
          input,
          ...(run.model ? { model: run.model } : {}),
          ...(run.effort ? { effort: run.effort } : {}),
          // What the model is working on, while it thinks; it adds no measurable time.
          summary: "auto",
          ...(run.outputSchema ? { outputSchema: run.outputSchema } : {})
        });
        const turn = (started.turn ?? {}) as Json;
        if (typeof turn.id === "string") {
          turnId = turn.id;
        }
        if (settled) {
          return;
        }
        unregister = registerSteerable(run.runId, {
          provider: "codex",
          steer: async (text): Promise<SteerResult> => {
            if (settled || !threadId || !turnId) {
              return { ok: false, reason: "not-running" };
            }
            try {
              await server.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: steerMessageText(text), text_elements: [] }] });
              return { ok: true };
            } catch (error) {
              return { ok: false, reason: "failed", detail: error instanceof Error ? error.message : String(error) };
            }
          }
        });
      } catch (error) {
        if (threadId && run.resumeThreadId === threadId && !settled) {
          // A thread this process thought it had may be gone: reopen it next time.
          server.loadedThreads.delete(threadId);
        }
        finish({ ok: false, error: error instanceof Error ? error : new Error(String(error)) });
      }
    })();
  });
}
