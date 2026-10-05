import { request as httpRequest } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Thin client for the shared nebula-agent-gateway (see
 * ../../nebula-agent-gateway and docs/agent-gateway-rfc.md). Writer routes CLI
 * spawns through the gateway's unix socket when it is running, and falls back
 * to spawning in-process when it is not — so the gateway being down can never
 * take Writer's AI offline. The gateway owns process spawning + auth-home
 * isolation; Writer keeps its arg building, MCP server, and stream parsing.
 */

function agentHomeRoot(): string {
  return process.env.NEBULA_AGENT_HOME?.trim() || join(homedir(), ".nebula-agent");
}

function socketPath(): string {
  return process.env.NEBULA_AGENT_SOCKET?.trim() || join(agentHomeRoot(), "sock");
}

function tokenPath(): string {
  return join(agentHomeRoot(), "token");
}

/** Reads the gateway token, or null if the gateway has never run. */
function readToken(): string | null {
  try {
    const token = readFileSync(tokenPath(), "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Is the gateway reachable? Cheap presence check (socket file + token exist);
 * the actual /exec call still falls back on any connection error, so this only
 * needs to be a fast negative for the common "gateway not installed" case.
 * Callers may force the in-process path with WRITER_USE_GATEWAY=0.
 */
export function gatewayAvailable(): boolean {
  // Never route through a real gateway from the test runner — server tests
  // exercise the in-process spawn path with fake CLIs.
  if (process.env.WRITER_USE_GATEWAY === "0" || process.env.VITEST) {
    return false;
  }
  return existsSync(socketPath()) && readToken() !== null;
}

export interface GatewayExecRequest {
  provider: "codex" | "claude";
  args: string[];
  bin?: string;
  label?: string;
  stdin?: string;
  /** Keep the child's stdin open after `stdin` (a gateway that supports it answers with a "started" frame). */
  stdinOpen?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  isolation?: "shared" | "off";
}

export interface GatewayProcess {
  /** Fires for each decoded stdout chunk (already utf8). */
  onStdout(cb: (text: string) => void): void;
  onStderr(cb: (text: string) => void): void;
  /** Resolves when the exec finishes; rejects on a gateway-level failure. */
  done: Promise<{ code: number | null; signal: string | null; timedOut: boolean }>;
  /** Abort the run (closes the connection → gateway SIGTERM→SIGKILL). */
  abort(): void;
  /**
   * More stdin for a stdinOpen exec. Resolves false when the gateway has no
   * open input for this run (an older gateway, or the child already exited).
   */
  writeInput(data: string): Promise<boolean>;
  /** Close the child's stdin (stdinOpen execs). */
  endInput(): void;
}

/**
 * Streams an /exec over the gateway socket. Returns null if the gateway is not
 * reachable (so the caller falls back to a local spawn). Throws only on an
 * unexpected error after a connection was established.
 */
export function execViaGateway(exec: GatewayExecRequest): GatewayProcess | null {
  const token = readToken();
  if (!gatewayAvailable() || !token) {
    return null;
  }

  const stdoutCbs: Array<(t: string) => void> = [];
  const stderrCbs: Array<(t: string) => void> = [];
  let resolveDone!: (v: { code: number | null; signal: string | null; timedOut: boolean }) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<{ code: number | null; signal: string | null; timedOut: boolean }>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const body = JSON.stringify(exec);
  const req = httpRequest(
    {
      socketPath: socketPath(),
      method: "POST",
      path: "/exec",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/x-ndjson",
        "content-length": Buffer.byteLength(body)
      }
    },
    (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        // A gateway that answered but refused (e.g. provider unavailable) is a
        // hard error, not a fallback — surface it.
        let errBody = "";
        res.on("data", (c: Buffer) => (errBody += c.toString()));
        res.on("end", () => rejectDone(new Error(`Gateway /exec ${res.statusCode}: ${errBody.slice(0, 300)}`)));
        return;
      }
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim()) {
            handleFrame(line);
          }
          nl = buffer.indexOf("\n");
        }
      });
      res.on("end", () => {
        if (buffer.trim()) {
          handleFrame(buffer);
        }
      });
    }
  );

  let finished = false;
  let execId: string | null = null;
  const idWaiters: Array<(id: string | null) => void> = [];
  const awaitId = (): Promise<string | null> => (execId || finished || !exec.stdinOpen
    ? Promise.resolve(execId)
    : new Promise((resolve) => {
      idWaiters.push(resolve);
      // An older gateway never sends "started": give up after a moment.
      setTimeout(() => resolve(execId), 3_000).unref();
    }));
  const postInput = async (payload: { data?: string; end?: boolean }): Promise<boolean> => {
    const id = await awaitId();
    if (!id || finished) {
      return false;
    }
    const json = JSON.stringify(payload);
    return new Promise((resolve) => {
      const input = httpRequest({
        socketPath: socketPath(),
        method: "POST",
        path: `/exec/${id}/stdin`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(json) }
      }, (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 300);
      });
      input.on("error", () => resolve(false));
      input.end(json);
    });
  };
  const handleFrame = (line: string) => {
    let frame: { t?: string; b64?: string; message?: string; code?: number | null; signal?: string | null; timedOut?: boolean };
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame.t === "stdout" && frame.b64 !== undefined) {
      const text = Buffer.from(frame.b64, "base64").toString("utf8");
      for (const cb of stdoutCbs) {
        cb(text);
      }
    } else if (frame.t === "stderr" && frame.b64 !== undefined) {
      const text = Buffer.from(frame.b64, "base64").toString("utf8");
      for (const cb of stderrCbs) {
        cb(text);
      }
    } else if (frame.t === "started" && typeof (frame as { id?: unknown }).id === "string") {
      execId = (frame as { id: string }).id;
      for (const resolveId of idWaiters.splice(0)) {
        resolveId(execId);
      }
    } else if (frame.t === "error") {
      finished = true;
      rejectDone(new Error(frame.message || "Gateway exec error."));
    } else if (frame.t === "exit") {
      finished = true;
      for (const resolveId of idWaiters.splice(0)) {
        resolveId(null);
      }
      resolveDone({ code: frame.code ?? null, signal: frame.signal ?? null, timedOut: Boolean(frame.timedOut) });
    }
  };

  req.on("error", (error) => {
    if (!finished) {
      rejectDone(error);
    }
  });
  req.write(body);
  req.end();

  return {
    onStdout: (cb) => stdoutCbs.push(cb),
    onStderr: (cb) => stderrCbs.push(cb),
    done,
    abort: () => req.destroy(),
    writeInput: (data) => postInput({ data }),
    endInput: () => {
      void postInput({ end: true });
    }
  };
}
