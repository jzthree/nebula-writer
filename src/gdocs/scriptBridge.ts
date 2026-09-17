/**
 * Calls from the pane (an iframe served by the sidecar) to the add-in's Apps
 * Script functions. The sidebar page that embeds the pane owns
 * `google.script.run`; it forwards {fn, args} messages and posts the result
 * back. Tests (and a mock mode) install a transport directly.
 */

import type { DocsScriptFunction } from "./protocol";

export type ScriptTransport = (fn: DocsScriptFunction, args: unknown[]) => Promise<unknown>;

let transport: ScriptTransport | null = null;
let hostOrigin: string | null = null;
let hostWindow: Window | null = null;
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let sequence = 0;
let readyPromise: Promise<boolean> | null = null;

export function setScriptTransport(next: ScriptTransport | null): void {
  transport = next;
}

/** Sidebars that may host the pane: Google's add-in sidebar frames, and the Nebula Writer Chrome extension's side panel. */
function isGoogleOrigin(origin: string): boolean {
  return /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.googleusercontent\.com$/i.test(origin)
    || /^https:\/\/(?:docs|script)\.google\.com$/i.test(origin)
    || /^chrome-extension:\/\/[a-p]{32}$/i.test(origin);
}

function listen(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.addEventListener("message", (event) => {
    const data = event.data as { nebula?: string; id?: string; ok?: boolean; result?: unknown; error?: string } | null;
    if (!data || typeof data !== "object") {
      return;
    }
    if (data.nebula === "host-ready") {
      if (!isGoogleOrigin(event.origin) && event.origin !== window.location.origin) {
        return;
      }
      hostOrigin = event.origin;
      hostWindow = event.source as Window;
      return;
    }
    if (data.nebula === "script-result" && event.origin === hostOrigin && typeof data.id === "string") {
      const waiter = pending.get(data.id);
      if (!waiter) {
        return;
      }
      pending.delete(data.id);
      if (data.ok) {
        waiter.resolve(data.result);
      } else {
        waiter.reject(new Error(data.error || "The Google Docs script call failed."));
      }
    }
  });
}

let listening = false;

/** Resolve true once the embedding sidebar has announced itself (or a transport is installed). */
export function waitForScriptHost(timeoutMs = 8_000): Promise<boolean> {
  if (transport) {
    return Promise.resolve(true);
  }
  if (readyPromise) {
    return readyPromise;
  }
  if (!listening) {
    listen();
    listening = true;
  }
  readyPromise = new Promise<boolean>((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (hostOrigin) {
        resolve(true);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        resolve(false);
        return;
      }
      // Ask the parent to (re)announce itself in case its message came before we listened.
      try {
        window.parent?.postMessage({ nebula: "pane-ready" }, "*");
      } catch {
        // Not embedded.
      }
      setTimeout(tick, 250);
    };
    tick();
  });
  return readyPromise;
}

export function callScript<T>(fn: DocsScriptFunction, ...args: unknown[]): Promise<T> {
  if (transport) {
    return transport(fn, args) as Promise<T>;
  }
  if (!hostOrigin || !hostWindow) {
    return Promise.reject(new Error("The Google Docs sidebar is not connected."));
  }
  const id = `${Date.now().toString(36)}-${(sequence += 1)}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    hostWindow?.postMessage({ nebula: "script-call", id, fn, args }, hostOrigin as string);
  });
}
