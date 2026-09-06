import { createRequire } from "node:module";
import type * as YTypes from "yjs";
import type { WebsocketProvider as WebsocketProviderType } from "y-websocket";
import type { AiSuggestion } from "../src/shared";

// CRITICAL: everything yjs-flavored here must be the SAME module instance as
// y-websocket/bin/utils (CJS), which owns the local room docs. Mixing the ESM
// and CJS builds of yjs loads two copies ("Yjs was already imported"), which
// silently breaks update application — the bridge connects but nothing syncs.
// So resolve ws/yjs/y-websocket through require, exactly like bin/utils does.
const require = createRequire(import.meta.url);
const WS = require("ws") as typeof WebSocket;
const Y = require("yjs") as typeof YTypes;
const { WebsocketProvider } = require("y-websocket") as { WebsocketProvider: typeof WebsocketProviderType };
const { getYDoc } = require("y-websocket/bin/utils") as { getYDoc: (name: string, gc?: boolean) => YTypes.Doc };
void Y; // instance kept for parity; transactions run through doc methods below

/**
 * Cross-user collaboration (local-first): each collaborator runs their OWN
 * local Writer; shared documents sync through the cloud relay
 * (writer.zhoulab.io — Durable Object Yjs rooms, no AI, no credentials).
 *
 * This module bridges a LOCAL Yjs room to the cloud room with the same doc id:
 * the local server joins the cloud room as a y-websocket client using the very
 * same Y.Doc instance that backs the local room, so browser ↔ local server ↔
 * cloud ↔ other local servers all converge. The terminal agent and live run
 * keep reading the LOCAL room, which now carries everyone's edits.
 *
 * Suggestions ride the SAME CRDT doc (a "nebula-suggestions" Y.Map keyed by
 * suggestion id) instead of a per-server session API, so the cloud stays a
 * dumb relay: each local server publishes its session's suggestions into the
 * map and merges inbound entries into its session (last-write-wins by
 * decision time).
 */

export function cloudSyncBaseUrl(): string {
  return (process.env.WRITER_CLOUD_SYNC_URL?.trim() || "https://writer.zhoulab.io").replace(/\/$/, "");
}

function cloudCollabWsBase(): string {
  return `${cloudSyncBaseUrl().replace(/^http/, "ws")}/collab`;
}

const SUGGESTIONS_MAP = "nebula-suggestions";

interface BridgeEntry {
  provider: WebsocketProviderType;
  doc: YTypes.Doc & { awareness?: unknown };
  applyingInbound: boolean;
  /** Consecutive idle sweeps with no local clients (cost control below). */
  idleSweeps: number;
}

const bridges = new Map<string, BridgeEntry>();

export interface CollabBridgeHooks {
  /** Current suggestions of the active session for this doc (or null). */
  getSessionSuggestions(docId: string): AiSuggestion[] | null;
  /** Merge inbound suggestions into the active session; returns true if changed. */
  applyInboundSuggestions(docId: string, entries: AiSuggestion[]): boolean;
}

let hooks: CollabBridgeHooks | null = null;

export function registerCollabBridgeHooks(next: CollabBridgeHooks): void {
  hooks = next;
}

export function bridgeStatus(docId: string): { bridged: boolean; connected: boolean; cloud: string } {
  const entry = bridges.get(docId);
  return {
    bridged: Boolean(entry),
    connected: Boolean(entry?.provider.wsconnected),
    cloud: cloudSyncBaseUrl()
  };
}

/** Idempotently bridge the local room for docId to the cloud relay room. */
export function ensureCloudBridge(docId: string): { bridged: boolean; connected: boolean; cloud: string } {
  const existing = bridges.get(docId);
  if (existing) {
    // Re-requested (a client opened the doc again): wake an idle bridge.
    existing.idleSweeps = 0;
    if (!existing.provider.wsconnected) {
      existing.provider.connect();
    }
    return bridgeStatus(docId);
  }
  // The same Y.Doc instance the local /collab room serves (created if the
  // room doesn't exist yet — a joining browser connects right after).
  const doc = getYDoc(docId) as YTypes.Doc & { awareness?: never };
  const provider = new WebsocketProvider(cloudCollabWsBase(), docId, doc, {
    WebSocketPolyfill: WS as unknown as typeof WebSocket,
    // Share the room's awareness so presence crosses servers too.
    awareness: (doc as unknown as { awareness?: never }).awareness,
    // Be kind to the metered relay: a rejected/unreachable cloud must not
    // hammer reconnects (same lesson as the browser-side storm fix).
    maxBackoffTime: 60_000
  } as ConstructorParameters<typeof WebsocketProvider>[3]);
  const entry: BridgeEntry = { provider, doc, applyingInbound: false, idleSweeps: 0 };
  bridges.set(docId, entry);
  wireSuggestionSync(docId, entry);
  startIdleSweeper();
  return bridgeStatus(docId);
}

/**
 * Cost control: a connected bridge keeps a cloud Durable Object alive, which
 * bills DURATION around the clock. When a doc has no local clients (nobody on
 * this machine is viewing it), disconnect after a short grace; the connection
 * resumes when a client returns (realtime notifies via touchBridge, and the
 * browser re-POSTs the bridge on load). Yjs queues offline edits, so nothing
 * is lost across the gap.
 */
const IDLE_SWEEP_MS = Math.max(1_000, Number(process.env.WRITER_BRIDGE_IDLE_SWEEP_MS) || 60_000);
const IDLE_SWEEPS_BEFORE_DISCONNECT = 3;
let idleSweeper: NodeJS.Timeout | null = null;

function localClientCount(doc: YTypes.Doc): number {
  const conns = (doc as unknown as { conns?: Map<unknown, unknown> }).conns;
  return conns instanceof Map ? conns.size : 0;
}

/**
 * Fully release the cloud socket for an idle bridge. WebsocketProvider.disconnect()
 * calls ws.close(), which starts a graceful close handshake and waits for the
 * relay's close frame — but that frame often never arrives, leaving the socket
 * wedged in CLOSING (readyState 2) with `wsconnected` still true and the Durable
 * Object still billed. Terminating the underlying `ws` (server-side, so
 * `.terminate()` exists) forces the close event, which fires the provider's
 * onclose → wsconnected=false, ws=null, ready for a clean reconnect on wake.
 */
function releaseCloudSocket(provider: WebsocketProviderType): void {
  provider.disconnect();
  const raw = (provider as unknown as { ws?: { terminate?: () => void } | null }).ws;
  if (raw && typeof raw.terminate === "function") {
    raw.terminate();
  }
}

function startIdleSweeper(): void {
  if (idleSweeper) {
    return;
  }
  idleSweeper = setInterval(() => {
    for (const entry of bridges.values()) {
      if (localClientCount(entry.doc) > 0) {
        entry.idleSweeps = 0;
        if (!entry.provider.wsconnected && !entry.provider.shouldConnect) {
          entry.provider.connect();
        }
        continue;
      }
      entry.idleSweeps += 1;
      if (entry.idleSweeps >= IDLE_SWEEPS_BEFORE_DISCONNECT && (entry.provider.wsconnected || entry.provider.shouldConnect)) {
        releaseCloudSocket(entry.provider);
      }
    }
  }, IDLE_SWEEP_MS);
  idleSweeper.unref();
}

/** A local client joined this room — wake its bridge if it went idle. */
export function touchBridge(docId: string): void {
  const entry = bridges.get(docId);
  if (!entry) {
    return;
  }
  entry.idleSweeps = 0;
  if (!entry.provider.wsconnected && !entry.provider.shouldConnect) {
    entry.provider.connect();
  }
}

export function activeBridgeDocIds(): string[] {
  return [...bridges.keys()];
}

/** Publish the active session's suggestions into the shared map (no-op without a bridge). */
export function publishSuggestionsToBridge(docId: string | null): void {
  if (!docId) {
    return;
  }
  const entry = bridges.get(docId);
  if (!entry || entry.applyingInbound || !hooks) {
    return;
  }
  const suggestions = hooks.getSessionSuggestions(docId);
  if (!suggestions) {
    return;
  }
  const map = entry.doc.getMap<Record<string, unknown>>(SUGGESTIONS_MAP);
  entry.doc.transact(() => {
    for (const suggestion of suggestions) {
      const plain = JSON.parse(JSON.stringify(suggestion)) as Record<string, unknown>;
      const existing = map.get(suggestion.id);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(plain)) {
        map.set(suggestion.id, plain);
      }
    }
  });
}

/** Suggestions currently in the shared map for a bridged doc (null if unbridged). */
export function bridgedSuggestions(docId: string): AiSuggestion[] | null {
  const entry = bridges.get(docId);
  if (!entry) {
    return null;
  }
  const map = entry.doc.getMap<Record<string, unknown>>(SUGGESTIONS_MAP);
  const result: AiSuggestion[] = [];
  map.forEach((value) => {
    if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
      result.push(value as unknown as AiSuggestion);
    }
  });
  return result;
}

function wireSuggestionSync(docId: string, entry: BridgeEntry): void {
  const map = entry.doc.getMap<Record<string, unknown>>(SUGGESTIONS_MAP);
  map.observe(() => {
    if (!hooks) {
      return;
    }
    const inbound: AiSuggestion[] = [];
    map.forEach((value) => {
      if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
        inbound.push(value as unknown as AiSuggestion);
      }
    });
    if (!inbound.length) {
      return;
    }
    entry.applyingInbound = true;
    try {
      hooks.applyInboundSuggestions(docId, inbound);
    } finally {
      entry.applyingInbound = false;
    }
  });
  // Seed the map with anything the local session already staged.
  publishSuggestionsToBridge(docId);
}
