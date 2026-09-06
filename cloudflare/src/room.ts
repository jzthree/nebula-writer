/**
 * WriterRoom Durable Object.
 *
 * One instance per document (id = the #doc= document id). Each instance:
 *  - hosts the document's Yjs room (y-websocket wire protocol over hibernatable
 *    WebSockets, updates persisted to DO storage),
 *  - stores the session metadata JSON (suggestions, chat, title) with the same
 *    optimistic-concurrency semantics as the local sidecar,
 *  - broadcasts {session-updated, ai-progress} JSON to /events sockets.
 *
 */

import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

export interface Env {
  ROOM: DurableObjectNamespace;
  SHARE_TOKEN?: string;
}

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// Just under y-websocket's hardcoded 30s "no message received" reconnect
// timeout: without a periodic message a lone idle tab would close and resync
// every ~30s, costing a steady stream of requests. The standard y-websocket
// server pings for this reason; ours sends a no-op via a hibernation alarm.
const KEEPALIVE_MS = 24_000;
// messageAwareness + an empty (zero-client) awareness update: the client
// resets its reconnect timer on receipt and applies it as a no-op.
const KEEPALIVE_FRAME = new Uint8Array([MESSAGE_AWARENESS, 1, 0]);
const COMPACT_THRESHOLD = 64;

interface StoredSession {
  [key: string]: unknown;
  id: string;
  sourceDocumentId: string;
  name: string;
  title: string;
  revision: number;
  documentHtml: string;
  documentText: string;
  suggestions: Array<{
    [key: string]: unknown;
    id: string;
    status: string;
    decidedBy?: string | null;
    decidedAt?: string | null;
    proposedBy?: string | null;
  }>;
  chatMessages: Array<{ [key: string]: unknown; id?: string }>;
  updatedAt: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function summaryOf(session: StoredSession): Record<string, unknown> {
  const { documentHtml, ...rest } = session;
  return {
    ...rest,
    documentHtmlLength: documentHtml.length,
    pendingSuggestions: session.suggestions.filter((suggestion) => suggestion.status === "pending").length
  };
}

function documentOf(session: StoredSession): Record<string, unknown> {
  return { ...summaryOf(session), documentHtml: session.documentHtml };
}

export class WriterRoom extends DurableObject<Env> {
  private doc: Y.Doc | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.headers.get("Upgrade") === "websocket") {
      if (path === "/events") {
        return this.acceptTaggedSocket("events");
      }
      return this.acceptCollabSocket();
    }

    switch (path) {
      case "/init":
        return this.handleInit(request);
      case "/api/session":
        return this.handleSessionGet(false);
      case "/api/session/document":
        return this.handleSessionGet(true);
      case "/api/session/suggestion-status":
        return this.handleSuggestionStatus(request);
      case "/api/session/chat-append":
        return this.handleChatAppend(request);
      case "/api/session/record-suggestions":
        return this.handleRecordSuggestions(request);
      default:
        return json({ error: `Unknown room path: ${path}` }, 404);
    }
  }

  // ---------------------------------------------------------------- sessions
  //
  // DO storage caps each value at 2 MB, and an image-heavy grant converts to
  // more HTML than that. The session record is stored without documentHtml,
  // which is sharded across html:<n> keys (256K chars/chunk keeps even
  // worst-case UTF-8 expansion under the limit) and reassembled on read.

  private async getSession(): Promise<StoredSession | null> {
    const base = (await this.ctx.storage.get<StoredSession>("session")) ?? null;
    if (!base) {
      return null;
    }
    if (base.documentHtml) {
      return base; // Legacy single-key record.
    }
    const stored = await this.ctx.storage.list<string>({ prefix: "html:" });
    const html = [...stored.entries()]
      .sort(([a], [b]) => Number(a.slice("html:".length)) - Number(b.slice("html:".length)))
      .map(([, chunk]) => chunk)
      .join("");
    return { ...base, documentHtml: html };
  }

  private static readonly HTML_CHUNK_CHARS = 256 * 1024;

  private async writeSession(session: StoredSession): Promise<void> {
    const { documentHtml, ...rest } = session;
    const writes: Record<string, unknown> = { session: { ...rest, documentHtml: "" } };
    const chunkCount = Math.ceil(documentHtml.length / WriterRoom.HTML_CHUNK_CHARS) || 0;
    for (let index = 0; index < chunkCount; index += 1) {
      writes[`html:${index}`] = documentHtml.slice(index * WriterRoom.HTML_CHUNK_CHARS, (index + 1) * WriterRoom.HTML_CHUNK_CHARS);
    }
    const staleKeys = [...(await this.ctx.storage.list({ prefix: "html:" })).keys()]
      .filter((key) => Number(key.slice("html:".length)) >= chunkCount);
    await this.ctx.storage.put(writes);
    if (staleKeys.length) {
      await this.ctx.storage.delete(staleKeys);
    }
  }

  private async putSession(session: StoredSession): Promise<void> {
    await this.writeSession(session);
    this.broadcastEvent({ type: "session-updated", revision: session.revision, docId: session.sourceDocumentId });
  }

  private async handleInit(request: Request): Promise<Response> {
    const body = await request.json<{ session: StoredSession }>();
    const existing = await this.getSession();
    if (existing) {
      return json({ session: documentOf(existing) });
    }
    await this.writeSession(body.session);
    return json({ session: documentOf(body.session) });
  }

  private async handleSessionGet(full: boolean): Promise<Response> {
    const session = await this.getSession();
    if (!session) {
      return json({ session: null });
    }
    const live = await this.liveDocumentText(session.sourceDocumentId);
    const effective = live ? { ...session, documentText: live } : session;
    return json({ session: full ? documentOf(effective) : summaryOf(effective) });
  }

  private async handleSuggestionStatus(request: Request): Promise<Response> {
    const body = await request.json<{
      id?: string;
      status?: string;
      expectedStatus?: string;
      decidedBy?: string;
      decisionNote?: string;
    }>();
    const session = await this.getSession();
    if (!session) {
      return json({ error: "No active Writer session for this document." }, 400);
    }
    if (!body.id || !["pending", "accepted", "rejected"].includes(body.status ?? "")) {
      return json({ error: "Suggestion status updates require id and a valid status." }, 400);
    }
    const target = session.suggestions.find((suggestion) => suggestion.id === body.id);
    if (!target) {
      return json({ error: `No suggestion with id ${body.id}.` }, 404);
    }
    if (body.expectedStatus && target.status !== body.expectedStatus) {
      return json({
        error: `Suggestion was already marked ${target.status}${target.decidedBy ? ` by ${target.decidedBy}` : ""} — refresh before changing it.`,
        conflict: { id: target.id, status: target.status, decidedBy: target.decidedBy ?? null, decidedAt: target.decidedAt ?? null }
      }, 409);
    }
    const now = new Date().toISOString();
    const next: StoredSession = {
      ...session,
      suggestions: session.suggestions.map((suggestion) => suggestion.id === body.id
        ? {
            ...suggestion,
            status: body.status as string,
            decidedBy: body.status === "pending" ? null : body.decidedBy ?? null,
            decidedAt: body.status === "pending" ? null : now,
            decisionNote: body.status === "pending"
              ? null
              : (typeof body.decisionNote === "string" && body.decisionNote.trim() ? body.decisionNote.trim().slice(0, 280) : (suggestion as { decisionNote?: string | null }).decisionNote ?? null)
          }
        : suggestion),
      revision: session.revision + 1,
      updatedAt: now
    };
    await this.putSession(next);
    return json({ session: summaryOf(next) });
  }

  private async handleChatAppend(request: Request): Promise<Response> {
    const body = await request.json<{ chatMessages?: Array<{ [key: string]: unknown; id?: string }> }>();
    const session = await this.getSession();
    if (!session) {
      return json({ error: "No active Writer session for this document." }, 400);
    }
    const incoming = Array.isArray(body.chatMessages) ? body.chatMessages : [];
    const existingIds = new Set(session.chatMessages.map((message) => message.id).filter(Boolean));
    const additions = incoming.filter((message) => message.id && !existingIds.has(message.id));
    if (!additions.length) {
      return json({ appended: 0, session: summaryOf(session) });
    }
    const next: StoredSession = {
      ...session,
      chatMessages: [...session.chatMessages, ...additions].slice(-200),
      revision: session.revision + 1,
      updatedAt: new Date().toISOString()
    };
    await this.putSession(next);
    return json({ appended: additions.length, session: summaryOf(next) });
  }

  private async handleRecordSuggestions(request: Request): Promise<Response> {
    const body = await request.json<{ suggestions?: Array<{ [key: string]: unknown; id: string; status: string }> }>();
    const session = await this.getSession();
    if (!session) {
      return json({ error: "No active Writer session for this document." }, 400);
    }
    const incoming = Array.isArray(body.suggestions) ? body.suggestions : [];
    if (!incoming.length) {
      return json({ error: "Recording Writer suggestions requires a non-empty suggestions array." }, 400);
    }
    const existingIds = new Set(session.suggestions.map((suggestion) => suggestion.id));
    const additions = incoming.filter((suggestion) => suggestion.id && !existingIds.has(suggestion.id));
    if (!additions.length) {
      return json({ recorded: 0, session: summaryOf(session) });
    }
    const next: StoredSession = {
      ...session,
      suggestions: [...(additions as StoredSession["suggestions"]), ...session.suggestions],
      revision: session.revision + 1,
      updatedAt: new Date().toISOString()
    };
    await this.putSession(next);
    return json({ recorded: additions.length, session: summaryOf(next) });
  }

  // ---------------------------------------------------------------------- AI

  // ------------------------------------------------------------------- collab

  private async ensureDoc(): Promise<Y.Doc> {
    if (this.doc) {
      return this.doc;
    }
    const doc = new Y.Doc();
    const stored = await this.ctx.storage.list<Uint8Array>({ prefix: "yupdate:" });
    const updates = [...stored.entries()]
      .sort(([a], [b]) => Number(a.slice("yupdate:".length)) - Number(b.slice("yupdate:".length)))
      .map(([, value]) => value);
    if (updates.length) {
      Y.applyUpdate(doc, Y.mergeUpdates(updates));
    }
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      void this.persistUpdate(update);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcastCollab(encoding.toUint8Array(encoder), origin instanceof WebSocket ? origin : null);
    });
    this.doc = doc;
    return doc;
  }

  private async persistUpdate(update: Uint8Array): Promise<void> {
    const seq = ((await this.ctx.storage.get<number>("yseq")) ?? 0) + 1;
    await this.ctx.storage.put(`yupdate:${seq}`, update);
    await this.ctx.storage.put("yseq", seq);
    if (seq % COMPACT_THRESHOLD === 0 && this.doc) {
      // Compact the update log into one snapshot so room loads stay fast.
      const merged = Y.encodeStateAsUpdate(this.doc);
      const keys = [...(await this.ctx.storage.list({ prefix: "yupdate:" })).keys()];
      await this.ctx.storage.delete(keys);
      await this.ctx.storage.put("yupdate:1", merged);
      await this.ctx.storage.put("yseq", 1);
    }
  }

  private acceptCollabSocket(): Response {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["collab"]);
    void this.welcomeCollabSocket(pair[1]);
    void this.scheduleKeepalive();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async scheduleKeepalive(): Promise<void> {
    if (this.ctx.getWebSockets("collab").length === 0) {
      return;
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
    }
  }

  // Fires while collab clients are connected: nudge each one so it does not
  // hit y-websocket's reconnect timeout, then reschedule until the room empties.
  // Between alarms the instance still hibernates, so idle duration stays low.
  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets("collab").filter((socket) => socket.readyState === WebSocket.READY_STATE_OPEN);
    for (const socket of sockets) {
      try {
        socket.send(KEEPALIVE_FRAME);
      } catch {
        // Socket is going away; the close handler will clean up.
      }
    }
    if (sockets.length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
    }
  }

  private async welcomeCollabSocket(socket: WebSocket): Promise<void> {
    const doc = await this.ensureDoc();
    const sync = encoding.createEncoder();
    encoding.writeVarUint(sync, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(sync, doc);
    socket.send(encoding.toUint8Array(sync));
    // Presence is relayed statelessly (no server-side Awareness object — its
    // internal interval would block hibernation and burn the daily duration
    // quota). New joiners see peers within ~15s, when clients re-broadcast
    // their awareness state, as the y-protocols client does automatically.
  }

  private acceptTaggedSocket(tag: string): Response {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [tag]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const tags = this.ctx.getTags(socket);
    if (!tags.includes("collab") || typeof message === "string") {
      return;
    }
    const doc = await this.ensureDoc();
    const decoder = decoding.createDecoder(new Uint8Array(message));
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, doc, socket);
      if (encoding.length(encoder) > 1) {
        socket.send(encoding.toUint8Array(encoder));
      }
    } else if (messageType === MESSAGE_AWARENESS) {
      // Stateless relay: forward presence bytes to the other clients.
      this.broadcastCollab(new Uint8Array(message), socket);
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    this.dropSocket(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.dropSocket(socket);
  }

  private dropSocket(socket: WebSocket): void {
    // Last collab client gone: release the in-memory doc (state is persisted;
    // the next joiner reloads it) so the instance can be evicted immediately,
    // and stop the keepalive so nothing wakes the hibernated instance.
    if (!this.ctx.getWebSockets("collab").some((candidate) => candidate !== socket && candidate.readyState === WebSocket.READY_STATE_OPEN)) {
      if (this.doc) {
        this.doc.destroy();
        this.doc = null;
      }
      void this.ctx.storage.deleteAlarm();
    }
  }

  // -------------------------------------------------------------- broadcasting

  private broadcastCollab(data: Uint8Array, except: WebSocket | null): void {
    for (const socket of this.ctx.getWebSockets("collab")) {
      if (socket !== except && socket.readyState === WebSocket.READY_STATE_OPEN) {
        socket.send(data);
      }
    }
  }

  private broadcastEvent(payload: Record<string, unknown>): void {
    const message = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets("events")) {
      if (socket.readyState === WebSocket.READY_STATE_OPEN) {
        socket.send(message);
      }
    }
  }

  private async liveDocumentText(expectedSessionId: string): Promise<string | null> {
    if (!this.ctx.getWebSockets("collab").length && !this.doc) {
      return null;
    }
    const doc = await this.ensureDoc();
    if (doc.getMap("nebula-meta").get("sessionId") !== expectedSessionId) {
      return null;
    }
    const fragment = doc.getXmlFragment("default");
    if (fragment.length === 0) {
      return null;
    }
    const blocks: string[] = [];
    fragment.forEach((node) => {
      blocks.push(node.toString().replace(/<[^>]+>/g, ""));
    });
    const joined = blocks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return joined || null;
  }
}
