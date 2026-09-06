import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Agent terminal via hop (docs/terminal-writer-plan.md). The terminal-driven
 * Writer runs a real claude/codex REPL in a hop-managed PTY; the user reaches
 * it through hop's web terminal behind hop's established security stack
 * (Cloudflare tunnel via outbound cloudflared — no inbound local port —
 * password + TOTP 2FA, secure cookies). The sidecar is the trusted LOCAL
 * process that talks to hop's loopback API with the bearer token from
 * ~/.hop2/.tunnel-state; the browser never gets that token — it only gets the
 * hop web URL, where hop's own auth challenges the user.
 */

export const AGENT_TERMINAL_SESSION = "writer-agent";

interface HopState {
  apiBase: string;
  token: string;
  webUrl: string;
  tunnelUrl: string | null;
}

function repoRoot(): string {
  try {
    return resolve(fileURLToPath(new URL("..", import.meta.url)));
  } catch {
    return process.cwd();
  }
}

export function readHopState(): HopState | null {
  try {
    const statePath = process.env.HOP_STATE_FILE?.trim() || join(homedir(), ".hop2", ".tunnel-state");
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { port?: number; url?: string; sessionSecret?: string };
    if (!parsed.port || !parsed.sessionSecret) {
      return null;
    }
    const local = `http://127.0.0.1:${parsed.port}`;
    return {
      apiBase: local,
      token: parsed.sessionSecret,
      // Prefer the tunnel URL (works from anywhere, TLS at Cloudflare's edge);
      // the local auth proxy is the fallback when no tunnel is configured.
      webUrl: parsed.url?.trim() || local,
      tunnelUrl: parsed.url?.trim() || null
    };
  } catch {
    return null;
  }
}

async function hopApi(state: HopState, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${state.apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${state.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8_000)
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // non-JSON (e.g. the auth page) — treated as unavailable by callers
  }
  return { status: response.status, json };
}

export interface AgentTerminalStatus {
  available: boolean;
  running: boolean;
  url: string | null;
  tunnel: boolean;
  detail: string;
}

function sessionUrl(state: HopState): string {
  return `${state.webUrl.replace(/\/$/, "")}/s/${encodeURIComponent(AGENT_TERMINAL_SESSION)}/`;
}

export async function agentTerminalStatus(): Promise<AgentTerminalStatus> {
  const state = readHopState();
  if (!state) {
    return { available: false, running: false, url: null, tunnel: false, detail: "hop is not running on this machine (no ~/.hop2/.tunnel-state). Install/start hop to use the agent terminal." };
  }
  const list = await hopApi(state, "GET", "/api/sessions").catch(() => null);
  if (!list || list.status !== 200 || typeof list.json !== "object" || list.json === null) {
    return { available: false, running: false, url: null, tunnel: false, detail: "hop daemon did not answer its API — is it running? (hop status)" };
  }
  const sessions = (list.json as { sessions?: Array<{ name?: string; live?: boolean; foregroundProcess?: string }> }).sessions ?? [];
  const existing = sessions.find((session) => session.name === AGENT_TERMINAL_SESSION);
  return {
    available: true,
    running: Boolean(existing?.live ?? existing),
    url: sessionUrl(state),
    tunnel: Boolean(state.tunnelUrl),
    detail: existing ? "Agent terminal session is running." : "hop is available; the agent terminal session will be created on open."
  };
}

const SHELL_PROCESSES = new Set(["zsh", "bash", "sh", "fish", "-zsh", "-bash", "login", ""]);

async function sessionForeground(state: HopState): Promise<string | null> {
  const list = await hopApi(state, "GET", "/api/sessions").catch(() => null);
  if (!list || list.status !== 200) {
    return null;
  }
  const sessions = (list.json as { sessions?: Array<{ name?: string; foregroundProcess?: string }> }).sessions ?? [];
  const existing = sessions.find((session) => session.name === AGENT_TERMINAL_SESSION);
  return existing ? existing.foregroundProcess ?? "" : null;
}

/** Ensure the writer-agent hop session exists (create if missing) and return its web URL. */
export async function ensureAgentTerminal(provider: "claude" | "codex"): Promise<AgentTerminalStatus> {
  const status = await agentTerminalStatus();
  if (!status.available) {
    return status;
  }
  const state = readHopState()!;
  const startup = `scripts/writer-agent-terminal.sh ${provider}`;
  if (!status.running) {
    const created = await hopApi(state, "POST", "/api/terminals", {
      name: AGENT_TERMINAL_SESSION,
      cwd: repoRoot(),
      startup
    }).catch(() => null);
    const ok = created && created.status === 200 && (created.json as { ok?: boolean } | null)?.ok;
    // 409 = name already in use (raced another creator) — that's "running".
    if (!ok && created?.status !== 409) {
      return { ...status, running: false, detail: `hop could not create the terminal session (status ${created?.status ?? "?"}).` };
    }
  } else {
    // Session already exists. If it fell back to a bare shell (e.g. created
    // before the sidecar was up), relaunch the agent into it so the user
    // always lands in claude/codex, not a shell.
    const foreground = await sessionForeground(state);
    if (foreground !== null && SHELL_PROCESSES.has(foreground)) {
      const terminals = await hopApi(state, "GET", "/api/terminals").catch(() => null);
      const list = (terminals?.json as { terminals?: Array<{ id?: string; name?: string; sessionName?: string }> } | null)?.terminals ?? [];
      const term = list.find((entry) => entry.name === AGENT_TERMINAL_SESSION || entry.sessionName === AGENT_TERMINAL_SESSION);
      if (term?.id) {
        await hopApi(state, "POST", `/api/terminals/${encodeURIComponent(term.id)}/write`, { data: `${startup}\r` }).catch(() => null);
      }
    }
  }
  return { ...status, running: true, detail: "Agent terminal is ready." };
}
