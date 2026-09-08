/**
 * Real-time collaboration transport for the Writer sidecar.
 *
 * Two WebSocket endpoints share the sidecar's HTTP server:
 *  - /collab  — Yjs document sync (y-websocket protocol). All clients join the
 *               single shared room, mirroring the sidecar's single active
 *               session, so concurrent edits merge via CRDT and remote cursors
 *               are visible in every editor.
 *  - /events  — lightweight JSON notifications. The sidecar broadcasts
 *               {type: "session-updated", revision} after every session
 *               mutation so clients refetch the review queue immediately
 *               instead of waiting for their next poll.
 */

import type { IncomingMessage, Server } from "node:http";
import { emphasisFromPieces, type EmphasisFormat, type EmphasisSpan } from "../src/emphasis";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type * as Y from "yjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- y-websocket ships this server helper without type declarations.
import { docs, setupWSConnection } from "y-websocket/bin/utils";
import { upgradeIsAuthorized } from "./shareAuth";
import { attachTerminal, isTerminalProvider } from "./terminal-pty";
import { publishSuggestionsToBridge, touchBridge } from "./collab-bridge";

// Rooms are keyed by document id (the #doc= fragment in share URLs); the
// legacy single-room name remains valid for older clients.
function roomNameFromPath(pathname: string): string {
  const segment = decodeURIComponent(pathname.replace(/^\/collab\/?/, "")).split("/")[0];
  const sanitized = segment.replace(/[^A-Za-z0-9._-]/g, "");
  return sanitized || "nebula-writer";
}

// Each events client is tracked with the document it is viewing (the ?doc=
// query param), so session mutations only notify clients on that document
// instead of forcing every open tab to refetch. null means the client did not
// scope to a document and receives all notifications.
const eventClients = new Map<WebSocket, string | null>();
let pendingBroadcast: NodeJS.Timeout | null = null;
let pendingRevision = 0;
let pendingDocIdProvider: (() => string | null) | null = null;

export function attachWriterRealtime(server: Server): void {
  const collabServer = new WebSocketServer({ noServer: true });
  const eventsServer = new WebSocketServer({ noServer: true });
  const terminalServer = new WebSocketServer({ noServer: true });

  collabServer.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const docName = roomNameFromPath(pathname);
    setupWSConnection(socket, request, { docName });
    // A local client joined this room — wake its cloud bridge if it went idle.
    touchBridge(docName);
  });

  eventsServer.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const docParam = new URL(request.url ?? "/", "http://localhost").searchParams.get("doc");
    eventClients.set(socket, docParam && docParam.trim() ? docParam.trim() : null);
    socket.on("close", () => eventClients.delete(socket));
    socket.on("error", () => eventClients.delete(socket));
  });

  terminalServer.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const params = new URL(request.url ?? "/", "http://localhost").searchParams;
    const provider = params.get("provider");
    const cols = Number(params.get("cols"));
    const rows = Number(params.get("rows"));
    const size = Number.isFinite(cols) && Number.isFinite(rows) && cols >= 2 && rows >= 1
      ? { cols: Math.floor(cols), rows: Math.floor(rows) }
      : undefined;
    attachTerminal(socket, isTerminalProvider(provider) ? provider : "claude", size);
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!upgradeIsAuthorized(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    // y-websocket clients connect to /collab/<room-name>.
    if (pathname === "/collab" || pathname.startsWith("/collab/")) {
      collabServer.handleUpgrade(request, socket, head, (ws) => {
        collabServer.emit("connection", ws, request);
      });
    } else if (pathname === "/events") {
      eventsServer.handleUpgrade(request, socket, head, (ws) => {
        eventsServer.emit("connection", ws, request);
      });
    } else if (pathname === "/agent-terminal") {
      // The local agent terminal PTY. Only served when the Writer server runs
      // locally (the terminal spawns real CLIs on this machine) — the cloud
      // Worker never handles this upgrade, so a hosted page can't reach it.
      terminalServer.handleUpgrade(request, socket, head, (ws) => {
        terminalServer.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });
}

/**
 * Plain text of the live collaborative document, extracted from the Yjs doc
 * this sidecar hosts for the /collab room. Returns null when no collaborative
 * editing has happened (no room yet) or the doc is empty — callers fall back
 * to the session's import-time snapshot. This keeps AI requests and agent
 * reads anchored to what collaborators actually see, not stale text.
 */
export function liveCollabDocumentText(expectedSourceDocumentId: string): string | null {
  const docsMap = docs as Map<string, Y.Doc>;
  // Per-doc rooms are keyed by document id; the legacy shared room may also
  // carry the document (older clients), so check both.
  const doc = docsMap.get(expectedSourceDocumentId) ?? docsMap.get("nebula-writer");
  if (!doc) {
    return null;
  }
  // Clients stamp the collab doc with the session it carries; without a match
  // the live doc may still hold a previous document, so fall back to the
  // session snapshot rather than serving the wrong text.
  const meta = doc.getMap("nebula-meta");
  if (meta.get("sessionId") !== expectedSourceDocumentId) {
    return null;
  }
  // TipTap's Collaboration extension binds the editor to the "default" fragment.
  const fragment = doc.getXmlFragment("default");
  if (fragment.length === 0) {
    return null;
  }
  return collabFragmentText(fragment) || null;
}

/** Plain text of a collaborative document fragment (blocks joined by newlines, runs of blank lines collapsed, trimmed). */
export function collabFragmentText(fragment: { forEach: (cb: (node: unknown) => void) => void }): string {
  const blocks: string[] = [];
  fragment.forEach((node) => {
    const text = xmlNodeText(node);
    blocks.push(text);
  });
  return blocks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Emphasis spans over `liveCollabDocumentText`'s result: the marks (bold,
 * italic, underline, highlight) the collaborative document carries, walked
 * the same way and trimmed/collapsed in step with the text.
 */
export function liveCollabDocumentEmphasis(expectedSourceDocumentId: string): EmphasisSpan[] {
  const docsMap = docs as Map<string, Y.Doc>;
  const doc = docsMap.get(expectedSourceDocumentId) ?? docsMap.get("nebula-writer");
  if (!doc || doc.getMap("nebula-meta").get("sessionId") !== expectedSourceDocumentId) {
    return [];
  }
  const fragment = doc.getXmlFragment("default");
  if (fragment.length === 0) {
    return [];
  }
  return collabFragmentEmphasis(fragment);
}

/** Emphasis spans over `collabFragmentText(fragment)`. */
export function collabFragmentEmphasis(fragment: { forEach: (cb: (node: unknown) => void) => void }): EmphasisSpan[] {
  const chars: Array<{ char: string; format: EmphasisFormat | null }> = [];
  let firstBlock = true;
  fragment.forEach((node) => {
    if (!firstBlock) {
      chars.push({ char: "\n", format: null });
    }
    firstBlock = false;
    xmlNodeChars(node, chars);
  });
  // Mirror `.replace(/\n{3,}/g, "\n\n").trim()` on the character stream.
  const collapsed: typeof chars = [];
  let newlines = 0;
  for (const entry of chars) {
    if (entry.char === "\n") {
      newlines += 1;
      if (newlines > 2) {
        continue;
      }
    } else {
      newlines = 0;
    }
    collapsed.push(entry);
  }
  let start = 0;
  let end = collapsed.length;
  while (start < end && /\s/.test(collapsed[start].char)) {
    start += 1;
  }
  while (end > start && /\s/.test(collapsed[end - 1].char)) {
    end -= 1;
  }
  return emphasisFromPieces(collapsed.slice(start, end).map((entry) => ({ text: entry.char, format: entry.format })));
}

function xmlNodeChars(node: unknown, out: Array<{ char: string; format: EmphasisFormat | null }>): void {
  const candidate = node as {
    forEach?: (cb: (child: unknown) => void) => void;
    toDelta?: () => Array<{ insert?: unknown; attributes?: Record<string, unknown> }>;
  } | null;
  if (typeof candidate?.toDelta === "function") {
    for (const op of candidate.toDelta()) {
      if (typeof op.insert !== "string") {
        continue;
      }
      const attributes = op.attributes ?? {};
      const format: EmphasisFormat = {
        ...(attributes.bold ? { bold: true } : {}),
        ...(attributes.italic ? { italic: true } : {}),
        ...(attributes.underline ? { underline: true } : {}),
        ...(attributes.highlight ? { highlight: true } : {})
      };
      for (const char of op.insert) {
        out.push({ char, format });
      }
    }
    return;
  }
  if (typeof candidate?.forEach === "function") {
    const children: unknown[] = [];
    candidate.forEach((child) => {
      children.push(child);
    });
    const allInlineText = children.every((child) => typeof (child as { toDelta?: unknown })?.toDelta === "function");
    children.forEach((child, index) => {
      if (index > 0 && !allInlineText) {
        out.push({ char: "\n", format: null });
      }
      xmlNodeChars(child, out);
    });
  }
}

// Duck-typed on purpose: the docs created inside y-websocket's CJS server
// helper come from a different yjs module instance than our ESM import, so
// `instanceof Y.XmlText` checks would always be false across that boundary.
function xmlNodeText(node: unknown): string {
  const candidate = node as { forEach?: (cb: (child: unknown) => void) => void; toDelta?: () => Array<{ insert?: unknown }> } | null;
  if (typeof candidate?.toDelta === "function") {
    // Y.XmlText: toDelta() yields string inserts plus embeds; keep the strings.
    return candidate.toDelta()
      .map((op) => (typeof op.insert === "string" ? op.insert : ""))
      .join("");
  }
  if (typeof candidate?.forEach === "function") {
    // Y.XmlElement: recurse; nested block children separate with newlines.
    const parts: string[] = [];
    let allInlineText = true;
    candidate.forEach((child) => {
      if (typeof (child as { toDelta?: unknown })?.toDelta !== "function") {
        allInlineText = false;
      }
      parts.push(xmlNodeText(child));
    });
    return parts.join(allInlineText ? "" : "\n");
  }
  return "";
}

/**
 * Broadcast AI request progress so every collaborator sees a long-running
 * review advancing (e.g. "coverage pass 3 of 8"), not just the client that
 * started it. A null progress signals completion.
 */
export function broadcastAiProgress(progress: unknown, queue: unknown[] = []): void {
  const payload = JSON.stringify({ type: "ai-progress", progress: progress ?? null, queue });
  for (const client of eventClients.keys()) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

/**
 * Coalesce broadcasts: mutations bump the revision synchronously while the new
 * session object is still being assembled, so notify on the next tick (after
 * assignment) and merge bursts into one message.
 */
export function scheduleSessionUpdateBroadcast(revision: number, docIdProvider?: () => string | null): void {
  pendingRevision = Math.max(pendingRevision, revision);
  if (docIdProvider) {
    pendingDocIdProvider = docIdProvider;
  }
  if (pendingBroadcast) {
    return;
  }
  pendingBroadcast = setTimeout(() => {
    pendingBroadcast = null;
    // Resolved at fire time, after the mutated session has been assigned.
    const docId = pendingDocIdProvider?.() ?? null;
    // Every session mutation flows through here, so this is also where the
    // suggestion CRDT map is refreshed for cloud-bridged docs (no-op unless
    // bridged and something changed).
    publishSuggestionsToBridge(docId);
    const payload = JSON.stringify({ type: "session-updated", revision: pendingRevision, docId });
    for (const [client, clientDocId] of eventClients) {
      if (client.readyState !== client.OPEN) {
        continue;
      }
      // Deliver to clients scoped to this document, plus unscoped clients and
      // broadcasts with no document (which every client should still see).
      if (docId && clientDocId && clientDocId !== docId) {
        continue;
      }
      client.send(payload);
    }
  }, 25);
  pendingBroadcast.unref?.();
}
