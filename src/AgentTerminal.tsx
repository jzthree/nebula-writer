import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

/**
 * Inline agent terminal: an xterm bound to the local Writer server's PTY
 * (/agent-terminal), which runs a real claude/codex REPL wired to the live
 * document. Same-origin (the local server serves this page), so no hop, tunnel,
 * or cross-origin auth is involved — the terminal is just part of the local app.
 */

// Reconnect backoff: quick first retries (a server restart takes ~2s), capped
// so a down server isn't hammered; after MAX_RETRIES the user can click the
// terminal to try again.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const MAX_RETRIES = 8;

export function AgentTerminal({ provider }: { provider: "claude" | "codex" }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let disposed = false;
    let cleanup: (() => void) | null = null;
    // xterm expects browser globals (self), so load it lazily in the effect —
    // importing this component stays safe in non-browser (test) environments.
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed) {
        return;
      }
      const term = new Terminal({
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        fontSize: 12,
        cursorBlink: true,
        // Light theme matching the app chrome (VS Code Light+-style ANSI
        // palette so the CLIs' colors stay readable on a light background).
        theme: {
          background: "#fdfdfd",
          foreground: "#24292f",
          cursor: "#24292f",
          cursorAccent: "#fdfdfd",
          selectionBackground: "#b6d7ff",
          black: "#24292f",
          red: "#cf222e",
          green: "#116329",
          yellow: "#805b10",
          blue: "#0969da",
          magenta: "#8250df",
          cyan: "#1b7c83",
          white: "#6e7781",
          brightBlack: "#57606a",
          brightRed: "#a40e26",
          brightGreen: "#1a7f37",
          brightYellow: "#9a6700",
          brightBlue: "#218bff",
          brightMagenta: "#a475f9",
          brightCyan: "#3192aa",
          brightWhite: "#8c959f"
        },
        scrollback: 5000
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      fit.fit();

      let socket: WebSocket | null = null;
      let retries = 0;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;

      const sendResize = () => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }));
        }
      };

      const connect = () => {
        if (disposed) {
          return;
        }
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        // Carry the fitted size in the URL so a fresh PTY spawns at the panel's
        // real dimensions — spawning at the 80x24 default and resizing after the
        // socket opens leaves the CLI's banner hard-wrapped at the wrong width in
        // the scrollback forever.
        const ws = new WebSocket(`${protocol}//${window.location.host}/agent-terminal?provider=${provider}&cols=${term.cols}&rows=${term.rows}`);
        socket = ws;
        // The server replays the room's full scrollback on attach, so start
        // this connection's view from a clean slate — otherwise a reconnect
        // duplicates everything already on screen.
        let awaitingFirstData = true;
        ws.onopen = () => {
          sendResize();
          // Never focus from here: connects happen without user intent (page
          // load, auto-reconnect after a server restart, provider switch), and
          // stealing focus silently reroutes the user's typing from the
          // document into the CLI prompt — dogfooding lost three paragraphs
          // that way. Guarding on document.activeElement is racy too: the
          // steal reproduced during a brief editor blur while initial content
          // loaded. Focus follows explicit user action only (clicking the
          // terminal, or the dock-open button which focuses it).
        };
        ws.onmessage = (event) => {
          if (awaitingFirstData) {
            awaitingFirstData = false;
            term.reset();
            retries = 0;
          }
          term.write(typeof event.data === "string" ? event.data : "");
        };
        ws.onclose = () => {
          if (disposed || socket !== ws) {
            return;
          }
          // The room died (PTY exit or server restart) or the network dropped.
          // Reattaching recreates the room server-side, so reconnect instead of
          // stranding the user on a dead pane until a page reload.
          if (retries >= MAX_RETRIES) {
            term.write("\r\n\x1b[2m[terminal disconnected — click here to reconnect]\x1b[0m\r\n");
            return;
          }
          const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** retries);
          retries += 1;
          term.write(`\r\n\x1b[2m[terminal disconnected — reconnecting…]\x1b[0m\r\n`);
          retryTimer = setTimeout(() => {
            retryTimer = null;
            connect();
          }, delay);
        };
      };
      connect();

      // Keystrokes → PTY.
      const dataDisposable = term.onData((data) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(data);
        }
      });

      // After retries are exhausted, a click revives the terminal.
      const onClick = () => {
        const gaveUp = retries >= MAX_RETRIES && !retryTimer;
        const dead = !socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING;
        if (gaveUp && dead) {
          retries = 0;
          connect();
        }
      };
      container.addEventListener("click", onClick);

      const resizeObserver = new ResizeObserver(() => {
        try {
          fit.fit();
          sendResize();
        } catch {
          // container detaching — ignore
        }
      });
      resizeObserver.observe(container);

      cleanup = () => {
        if (retryTimer) {
          clearTimeout(retryTimer);
        }
        container.removeEventListener("click", onClick);
        resizeObserver.disconnect();
        dataDisposable.dispose();
        socket?.close();
        term.dispose();
      };
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [provider]);

  return <div className="agent-terminal-surface" ref={containerRef} />;
}
