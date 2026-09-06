import { spawn as ptySpawn, type IPty } from "node-pty";
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import { captureLoginPath } from "./login-path";

/**
 * npm sometimes strips the executable bit off node-pty's prebuilt
 * `spawn-helper`, and posix_spawnp then fails with "permission denied" the
 * first time a PTY is opened. Restore it once at load, before any spawn.
 */
function ensureSpawnHelperExecutable(): void {
  try {
    const require = createRequire(import.meta.url);
    const ptyRoot = dirname(dirname(require.resolve("node-pty")));
    for (const arch of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]) {
      const helper = join(ptyRoot, "prebuilds", arch, "spawn-helper");
      if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) {
        chmodSync(helper, 0o755);
      }
    }
  } catch {
    // best effort — if the layout differs, node-pty will surface its own error
  }
}
ensureSpawnHelperExecutable();

/**
 * The local agent terminal (local-first Writer, docs/terminal-writer-plan.md).
 * The Writer server owns the PTY — a real claude/codex REPL wired to the live
 * document — and streams it to an xterm in the SAME-ORIGIN local page. No hop,
 * no tunnel, no cross-origin: on your own machine the terminal is just part of
 * the app. (hop is only for reaching this Writer from another device.)
 *
 * One persistent, reattachable PTY per provider (a "room"): reloading the page
 * reattaches to the running claude with its scrollback, rather than killing it.
 */

type Provider = "claude" | "codex";

interface TerminalRoom {
  pty: IPty;
  provider: Provider;
  // A bounded ring of recent output so a (re)attaching client sees scrollback.
  scrollback: Buffer[];
  scrollbackBytes: number;
  clients: Set<WebSocket>;
  disposed: boolean;
}

const SCROLLBACK_MAX_BYTES = 256 * 1024;
const rooms = new Map<Provider, TerminalRoom>();

function repoRoot(): string {
  try {
    return resolve(fileURLToPath(new URL("..", import.meta.url)));
  } catch {
    return process.cwd();
  }
}

function launcherEnv(): { [key: string]: string } {
  // Same login-shell PATH story as the CLI spawns: a launchd-started server has
  // a sparse PATH, but claude/codex (and their node shebang) need the real one.
  // node-pty's posix_spawnp fails if the env object carries undefined values,
  // so build it with defined strings only.
  const raw: Record<string, string | undefined> = {
    PATH: captureLoginPath(),
    HOME: process.env.HOME ?? homedir(),
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME ?? process.env.USER,
    SHELL: process.env.SHELL ?? "/bin/zsh",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "xterm-256color",
    TMPDIR: process.env.TMPDIR,
    // This PTY runs the login shell (.zshrc), which may auto-launch a terminal
    // multiplexer (e.g. hop) for interactive sessions — that would take over
    // the pane instead of the CLI. This is the documented bypass; the inline
    // terminal wants the bare claude/codex REPL, nothing wrapping it.
    HOP_DISABLE_AUTO_LAUNCH: "1",
    WRITER_SIDECAR_PORT: String(process.env.WRITER_SIDECAR_PORT || 8787)
  };
  const env: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * Remove escape sequences that ASK the terminal to report something — color
 * queries (OSC …;?), device attributes (CSI c), cursor position / status
 * (CSI 6n/5n), DCS capability queries, mode/version/keyboard queries. These
 * only make sense to answer live, once; a replayed copy must never re-ask.
 */
export function scrubTerminalQueries(data: string): string {
  return data
    // OSC queries: ESC ] <params> ; ? terminated by BEL or ST (color, palette, clipboard)
    .replace(/\x1b\](?:[\dA-Za-z]+;)+\?(?:\x07|\x1b\\)/g, "")
    // DCS queries: XTGETTCAP (+q), DECRQSS ($q)
    .replace(/\x1bP[+$]q[\s\S]*?\x1b\\/g, "")
    // Device status / cursor position reports
    .replace(/\x1b\[\??[56]n/g, "")
    // Device attributes (primary / secondary / tertiary)
    .replace(/\x1b\[[>=]?0?c/g, "")
    // XTVERSION, kitty keyboard protocol query, DECRQM mode queries
    .replace(/\x1b\[>0?q/g, "")
    .replace(/\x1b\[\?u/g, "")
    .replace(/\x1b\[\??\d+\$p/g, "");
}

function createRoom(provider: Provider, size?: TerminalSize): TerminalRoom {
  const shell = process.env.SHELL?.trim() || "/bin/zsh";
  // Launch the agent terminal script in a login shell so the user also gets a
  // normal prompt if claude/codex exits.
  const pty = ptySpawn(shell, ["-l", "-c", `scripts/writer-agent-terminal.sh ${provider}; exec ${shell} -l`], {
    name: "xterm-256color",
    // Spawn at the first client's fitted size when known — the CLI draws its
    // banner immediately, and lines hard-wrapped at the 80-col default stay
    // mangled in the scrollback after any later resize.
    cols: size?.cols ?? 80,
    rows: size?.rows ?? 24,
    cwd: repoRoot(),
    env: launcherEnv()
  });
  const room: TerminalRoom = { pty, provider, scrollback: [], scrollbackBytes: 0, clients: new Set(), disposed: false };
  pty.onData((data) => {
    const buf = Buffer.from(data, "utf8");
    room.scrollback.push(buf);
    room.scrollbackBytes += buf.length;
    while (room.scrollbackBytes > SCROLLBACK_MAX_BYTES && room.scrollback.length > 1) {
      room.scrollbackBytes -= room.scrollback.shift()!.length;
    }
    for (const client of room.clients) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    }
  });
  pty.onExit(() => {
    room.disposed = true;
    rooms.delete(provider);
    for (const client of room.clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
  });
  return room;
}

function ensureRoom(provider: Provider, size?: TerminalSize): TerminalRoom {
  const existing = rooms.get(provider);
  if (existing && !existing.disposed) {
    return existing;
  }
  const room = createRoom(provider, size);
  rooms.set(provider, room);
  return room;
}

/**
 * Attach a websocket to the provider's terminal room. Wire protocol: text
 * frames are raw keystrokes for the PTY; a JSON frame `{"resize":{cols,rows}}`
 * resizes it. Server→client frames are raw PTY output (text). `size` sets the
 * initial dimensions if this attach creates the room (existing rooms keep
 * theirs; clients still send resize frames as usual).
 */
export function attachTerminal(socket: WebSocket, provider: Provider, size?: TerminalSize): void {
  const room = ensureRoom(provider, size);
  room.clients.add(socket);

  // Replay scrollback so a reattaching client sees the running session.
  // Scrub terminal QUERY sequences from the replayed copy: xterm.js answers
  // them anew on every replay, and once the CLI that asked has exited those
  // answers land in the plain shell and echo as garbage ("rgb:2424/2929/…",
  // "0;26R", "1;2c") that grows with every idle reconnect. Live output is
  // untouched — the client attached when a running CLI asks still answers.
  const backlog = scrubTerminalQueries(Buffer.concat(room.scrollback).toString("utf8"));
  if (backlog && socket.readyState === socket.OPEN) {
    socket.send(backlog);
  }

  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (room.disposed) {
      return;
    }
    const text = data.toString("utf8");
    if (!isBinary && text.startsWith("{")) {
      try {
        const msg = JSON.parse(text) as { resize?: { cols?: number; rows?: number } };
        if (msg.resize && Number.isFinite(msg.resize.cols) && Number.isFinite(msg.resize.rows)) {
          room.pty.resize(Math.max(2, msg.resize.cols!), Math.max(1, msg.resize.rows!));
          return;
        }
      } catch {
        // not a control frame — fall through and treat as input
      }
    }
    room.pty.write(text);
  });

  const detach = () => {
    room.clients.delete(socket);
  };
  socket.on("close", detach);
  socket.on("error", detach);
}

/**
 * Kill a provider's terminal room so the next attach starts fresh. The
 * recovery path when the CLI's initial launch failed (needs an update, auth
 * expired, crashed): killing the PTY fires onExit, which disposes the room
 * and closes its client sockets — every attached terminal auto-reconnects,
 * and the reconnect creates a brand-new room with a fresh briefed launch.
 * Returns false when there is no room to restart (the next attach will
 * create one anyway).
 */
export function restartTerminalRoom(provider: Provider): boolean {
  const room = rooms.get(provider);
  if (!room || room.disposed) {
    return false;
  }
  try {
    room.pty.kill();
  } catch {
    // Already dead — onExit handles the bookkeeping either way.
  }
  return true;
}

export function isTerminalProvider(value: string | null): value is Provider {
  return value === "claude" || value === "codex";
}
