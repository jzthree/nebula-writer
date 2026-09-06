/**
 * Client-side collaboration session.
 *
 * One Yjs document, synced to the sidecar's /collab websocket, backs the
 * TipTap editor so two people (or a person and an agent-driven UI) edit the
 * same live document with visible remote cursors — Google-Docs style.
 *
 * In tests (vitest) no websocket is created: the editor still uses a local
 * Y.Doc through the Collaboration extension, which keeps undo/redo behavior
 * identical without network noise.
 */

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { getStoredShareToken } from "./shareToken";

export interface CollabUser {
  /** Stable per-browser id so the same person (across tabs/reloads) is one presence. */
  identity: string;
  color: string;
  name: string;
}

export interface CollabSession {
  doc: Y.Doc;
  provider: WebsocketProvider | null;
  user: CollabUser;
}

const CURSOR_COLORS = ["#1a73e8", "#13795b", "#9d6b00", "#b3261e", "#5b21b6", "#006b63"];
const USER_NAME_STORAGE_KEY = "nebula-writer-collab-name";
const USER_IDENTITY_STORAGE_KEY = "nebula-writer-collab-identity";
const USER_COLOR_STORAGE_KEY = "nebula-writer-collab-color";

function persistedRandom(key: string, generate: () => string): string {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored) {
      return stored;
    }
    const generated = generate();
    window.localStorage.setItem(key, generated);
    return generated;
  } catch {
    return generate();
  }
}

function collabIdentity(): string {
  return persistedRandom(USER_IDENTITY_STORAGE_KEY, () =>
    (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}`)
  );
}

function collabColor(): string {
  // Stable color per browser so a person keeps the same cursor color across reloads.
  return persistedRandom(USER_COLOR_STORAGE_KEY, () => CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)]);
}

function collabUserName(): string {
  try {
    const stored = window.localStorage.getItem(USER_NAME_STORAGE_KEY);
    if (stored?.trim()) {
      return stored.trim();
    }
    const generated = `Writer ${Math.floor(100 + Math.random() * 900)}`;
    window.localStorage.setItem(USER_NAME_STORAGE_KEY, generated);
    return generated;
  } catch {
    return "Writer";
  }
}

export function setCollabUserName(session: CollabSession, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }
  try {
    window.localStorage.setItem(USER_NAME_STORAGE_KEY, trimmed);
  } catch {
    // Best effort.
  }
  session.user = { ...session.user, name: trimmed };
  session.provider?.awareness.setLocalStateField("user", session.user);
}

// One collab session per document room, shared across React remounts: during
// dev, Vite hot updates remount the App without unloading the page, and a
// per-mount provider would leak a live websocket each time — every leaked
// connection shows up as a phantom collaborator for everyone in the room.
const sessionsByRoom = new Map<string, CollabSession>();

/**
 * docId identifies the document room (from the #doc= URL). null means a
 * private local scratch document: no network provider, nothing shared until
 * the user uploads a DOCX or explicitly starts sharing.
 */
export function getCollabSession(docId: string | null): CollabSession {
  // Tests render the App many times in one module lifetime; each render must
  // get an isolated document. Only real pages share singletons.
  if (import.meta.env.MODE === "test") {
    return createCollabSession(docId);
  }
  const key = docId ?? "__local__";
  let session = sessionsByRoom.get(key);
  if (!session) {
    session = createCollabSession(docId);
    sessionsByRoom.set(key, session);
  }
  // Only one room is active at a time. Disconnect every other room's websocket
  // so the user stops appearing as a ghost collaborator in rooms they left, and
  // (re)connect the active room in case it was disconnected on a prior switch.
  sessionsByRoom.forEach((cached, cachedKey) => {
    if (cachedKey !== key) {
      cached.provider?.disconnect();
    }
  });
  if (session.provider && !session.provider.wsconnected && !session.provider.wsconnecting) {
    session.provider.connect();
  }
  return session;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    sessionsByRoom.forEach((session) => session.provider?.destroy());
    sessionsByRoom.clear();
  });
}

export function createCollabSession(docId: string | null): CollabSession {
  const doc = new Y.Doc();
  const user: CollabUser = {
    identity: collabIdentity(),
    color: collabColor(),
    name: collabUserName()
  };

  if (docId === null || import.meta.env.MODE === "test" || typeof WebSocket === "undefined") {
    return { doc, provider: null, user };
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const shareToken = getStoredShareToken();
  const provider = new WebsocketProvider(`${protocol}//${window.location.host}/collab`, docId, doc, {
    params: shareToken ? { token: shareToken } : {},
    // y-websocket's default backoff caps at 2.5s, so a connection the server
    // keeps rejecting (e.g. a tab whose share token is missing/expired) retries
    // ~24×/min forever. On a metered host every /collab handshake is a billed
    // Durable Object request — ~34k/day per stuck tab. Cap the backoff far
    // higher so even a persistent failure plateaus near 1/min, and let the
    // circuit breaker below stop it entirely.
    maxBackoffTime: 60000
  });
  provider.awareness.setLocalStateField("user", user);

  // Circuit breaker: a rejected handshake closes before Yjs ever syncs. If we
  // see repeated closes with no successful sync in between, the room is
  // unreachable for us (bad/expired token, gone document) — stop hammering the
  // server and go offline. A real connection (sync) or the tab regaining focus
  // re-arms it. This is what actually kills the tokenless-storm; the backoff
  // cap just bounds the damage while the breaker trips.
  const FAST_FAILURE_LIMIT = 5;
  let failuresSinceSync = 0;
  let everSynced = false;
  let trippedOffline = false;

  const trip = () => {
    if (!trippedOffline) {
      trippedOffline = true;
      provider.disconnect();
    }
  };
  const rearm = () => {
    failuresSinceSync = 0;
    if (trippedOffline && !document.hidden) {
      trippedOffline = false;
      provider.connect();
    }
  };

  provider.on("synced", (synced: boolean) => {
    if (synced) {
      everSynced = true;
      failuresSinceSync = 0;
    }
  });
  provider.on("connection-close", () => {
    failuresSinceSync += 1;
    // Give a room that has genuinely synced before more slack than one that
    // never connected at all (likely an auth rejection).
    if (failuresSinceSync >= (everSynced ? FAST_FAILURE_LIMIT * 3 : FAST_FAILURE_LIMIT)) {
      trip();
    }
  });
  provider.on("connection-error", () => {
    failuresSinceSync += 1;
    if (failuresSinceSync >= (everSynced ? FAST_FAILURE_LIMIT * 3 : FAST_FAILURE_LIMIT)) {
      trip();
    }
  });

  // Do NOT disconnect a healthy collab socket when the tab is merely
  // backgrounded: a collaborator who tabs away must still receive live edits,
  // and a stable connection is cheap — it was the reconnect STORM (rejected
  // handshakes retried forever) that burned Cloudflare requests, and the
  // circuit breaker above already stops that. Regaining focus only re-arms a
  // tripped breaker (e.g. a token that has since become valid) and reconnects.
  const onFocus = () => {
    if (!document.hidden) {
      rearm();
    }
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
  }

  // Clear our presence the instant the page goes away (reload, close, navigate)
  // so we don't linger as a ghost collaborator on everyone else's screen.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => provider.disconnect(), { once: true });
  }
  return { doc, provider, user };
}

/**
 * Runs `callback(synced)` once the provider finishes its first sync — or
 * immediately with `synced=false` when offline. If the sync never completes
 * (e.g. the sidecar is down or restarting) a timeout fires the callback with
 * `synced=false` so the editor can fall back to local/offline content instead
 * of hanging on a blank page. The callback runs at most once.
 */
export function whenCollabSynced(
  session: CollabSession,
  callback: (synced: boolean) => void,
  options: { timeoutMs?: number } = {}
): void {
  if (!session.provider) {
    callback(false);
    return;
  }
  if (session.provider.synced) {
    callback(true);
    return;
  }
  let done = false;
  const finish = (synced: boolean) => {
    if (done) {
      return;
    }
    done = true;
    session.provider?.off("synced", handler);
    if (timer !== null && typeof clearTimeout !== "undefined") {
      clearTimeout(timer);
    }
    callback(synced);
  };
  const handler = (synced: boolean) => {
    if (synced) {
      finish(true);
    }
  };
  const timeoutMs = options.timeoutMs ?? 6000;
  const timer = typeof setTimeout !== "undefined" ? setTimeout(() => finish(false), timeoutMs) : null;
  session.provider.on("synced", handler);
}
