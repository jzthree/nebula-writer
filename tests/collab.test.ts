// @vitest-environment node
/**
 * Real-time collaboration transport tests: Yjs document sync between two
 * clients through the sidecar's /collab websocket, and /events broadcasts
 * after session mutations.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { createRequire } from "node:module";
import { createWriterApp } from "../server/app";
import { attachWriterRealtime } from "../server/realtime";
import { whenCollabSynced, type CollabSession } from "../src/collab";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- no type declarations for the y-websocket server helper.
import { getYDoc } from "y-websocket/bin/utils";

// y-websocket's server helper uses the CommonJS yjs build; nodes inserted into
// its docs must come from the same module instance.
const requireCjs = createRequire(import.meta.url);
const Ycjs = requireCjs("yjs") as typeof Y;

describe("writer realtime collaboration", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  async function startServer(): Promise<{ port: number; server: Server }> {
    const server = createServer(createWriterApp());
    attachWriterRealtime(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server did not bind to a port");
    }
    return { port: address.port, server };
  }

  function connectProvider(port: number, doc: Y.Doc): WebsocketProvider {
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, "nebula-writer", doc, {
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket
    });
    cleanups.push(() => provider.destroy());
    return provider;
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Condition not met in time");
  }

  it("syncs document edits between two collab clients", async () => {
    const { port } = await startServer();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    connectProvider(port, docA);
    connectProvider(port, docB);

    docA.getText("shared").insert(0, "Hello from client A");
    await waitFor(() => docB.getText("shared").toString() === "Hello from client A");

    docB.getText("shared").insert(19, " and B");
    await waitFor(() => docA.getText("shared").toString() === "Hello from client A and B");
  });

  it("serves live collaborative text to session reads once the doc is stamped", async () => {
    const { port } = await startServer();

    // Import a DOCX to create the active session.
    const exportResponse = await fetch(`http://127.0.0.1:${port}/api/docx/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Live Text", html: "<p>Import-time snapshot text.</p>" })
    });
    const form = new FormData();
    form.append("file", new Blob([await exportResponse.arrayBuffer()]), "live-text.docx");
    const importResponse = await fetch(`http://127.0.0.1:${port}/api/docx/import`, { method: "POST", body: form });
    expect(importResponse.ok).toBe(true);
    const imported = await importResponse.json() as { id: string };

    // Simulate collaborators editing the hosted Yjs doc.
    const doc = getYDoc("nebula-writer") as Y.Doc;
    const fragment = doc.getXmlFragment("default");
    doc.transact(() => {
      fragment.delete(0, fragment.length);
      const paragraph = new Ycjs.XmlElement("paragraph");
      paragraph.insert(0, [new Ycjs.XmlText("Live collaborative text typed after import.")]);
      fragment.insert(0, [paragraph]);
    });

    // Without the session stamp the sidecar must not trust the live doc.
    const unstamped = await fetch(`http://127.0.0.1:${port}/api/session`).then((r) => r.json()) as { session: { documentText: string } };
    expect(unstamped.session.documentText).toContain("Import-time snapshot text.");

    // Once a client stamps the doc with the session id, reads go live.
    doc.getMap("nebula-meta").set("sessionId", imported.id);
    const stamped = await fetch(`http://127.0.0.1:${port}/api/session`).then((r) => r.json()) as { session: { documentText: string } };
    expect(stamped.session.documentText).toContain("Live collaborative text typed after import.");

    doc.getMap("nebula-meta").delete("sessionId");
  });

  it("broadcasts session-updated events after a mutation", async () => {
    const { port } = await startServer();
    const messages: Array<{ revision: number; type: string }> = [];
    const events = new WebSocket(`ws://127.0.0.1:${port}/events`);
    cleanups.push(() => events.close());
    events.on("message", (data) => {
      messages.push(JSON.parse(String(data)));
    });
    await new Promise<void>((resolve, reject) => {
      events.on("open", () => resolve());
      events.on("error", reject);
    });

    const exportResponse = await fetch(`http://127.0.0.1:${port}/api/docx/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Realtime", html: "<p>Broadcast me.</p>" })
    });
    expect(exportResponse.ok).toBe(true);
    const docxBuffer = await exportResponse.arrayBuffer();

    const form = new FormData();
    form.append("file", new Blob([docxBuffer]), "realtime.docx");
    const importResponse = await fetch(`http://127.0.0.1:${port}/api/docx/import`, {
      method: "POST",
      body: form
    });
    expect(importResponse.ok).toBe(true);

    await waitFor(() => messages.some((message) => message.type === "session-updated" && message.revision > 0));
  });

  it("scopes session-updated events to clients viewing that document", async () => {
    const { port } = await startServer();
    // Create the active session and learn its document id.
    const exportResponse = await fetch(`http://127.0.0.1:${port}/api/docx/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Scoped", html: "<p>Scoped doc.</p>" })
    });
    const form = new FormData();
    form.append("file", new Blob([await exportResponse.arrayBuffer()]), "scoped.docx");
    const imported = await fetch(`http://127.0.0.1:${port}/api/docx/import`, { method: "POST", body: form }).then((r) => r.json()) as { id: string };

    const matching: unknown[] = [];
    const other: unknown[] = [];
    const openSocket = (query: string, sink: unknown[]) => new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/events${query}`);
      cleanups.push(() => ws.close());
      ws.on("message", (data) => sink.push(JSON.parse(String(data))));
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
    await openSocket(`?doc=${encodeURIComponent(imported.id)}`, matching);
    await openSocket("?doc=some-other-document", other);

    // Mutate the active session (a status update triggers a scoped broadcast).
    await fetch(`http://127.0.0.1:${port}/api/session/record-suggestions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suggestions: [{ id: "s1", title: "T", original: "Scoped doc.", replacement: "Scoped document.", rationale: "r", confidence: 0.8 }] })
    });

    await waitFor(() => matching.some((m) => (m as { type?: string }).type === "session-updated"));
    // The client on a different document must not have received the notification.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(other.some((m) => (m as { type?: string }).type === "session-updated")).toBe(false);
  });

  it("late joiners receive existing room content without re-seeding", async () => {
    const { port } = await startServer();
    const docA = new Y.Doc();
    connectProvider(port, docA);
    docA.getText("shared").insert(0, "Seeded by the first client");

    // A second client joining afterward should receive the content via CRDT
    // sync — the reason a joiner must never seed again.
    const docB = new Y.Doc();
    connectProvider(port, docB);
    await waitFor(() => docB.getText("shared").toString() === "Seeded by the first client");
    expect(docB.getText("shared").toString()).toBe("Seeded by the first client");
  });

  it("whenCollabSynced fires immediately with synced=false when offline", () => {
    const offline = { doc: new Y.Doc(), provider: null, user: { identity: "x", color: "#000", name: "X" } } as CollabSession;
    let called: boolean | null = null;
    whenCollabSynced(offline, (synced) => { called = synced; });
    expect(called).toBe(false);
  });

  it("whenCollabSynced fires with synced=true once the provider syncs", async () => {
    const { port } = await startServer();
    const doc = new Y.Doc();
    const provider = connectProvider(port, doc);
    const session = { doc, provider, user: { identity: "y", color: "#000", name: "Y" } } as unknown as CollabSession;
    let synced: boolean | null = null;
    let calls = 0;
    whenCollabSynced(session, (value) => { synced = value; calls += 1; });
    await waitFor(() => synced === true);
    expect(synced).toBe(true);
    // Callback must run at most once even as further sync events fire.
    doc.getText("shared").insert(0, "more");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(1);
  });

  it("whenCollabSynced falls back to synced=false after the timeout when the server is unreachable", async () => {
    // Point at a port with no server so the provider never syncs.
    const doc = new Y.Doc();
    const provider = new WebsocketProvider("ws://127.0.0.1:1/collab", "dead-room", doc, {
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket
    });
    cleanups.push(() => provider.destroy());
    const session = { doc, provider, user: { identity: "z", color: "#000", name: "Z" } } as unknown as CollabSession;
    let synced: boolean | null = null;
    whenCollabSynced(session, (value) => { synced = value; }, { timeoutMs: 150 });
    await waitFor(() => synced !== null, 2000);
    expect(synced).toBe(false);
  });
});

describe("isSafariBrowser", () => {
  it("flags real Safari and not Chrome/Edge/Firefox", async () => {
    const { isSafariBrowser } = await import("../src/browser");
    expect(isSafariBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15")).toBe(true);
    expect(isSafariBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")).toBe(false);
    expect(isSafariBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0")).toBe(false);
    expect(isSafariBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0")).toBe(false);
    expect(isSafariBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.0.0 Mobile/15E148 Safari/604.1")).toBe(false);
  });
});

describe("wordDiffSegments", () => {
  it("marks word-level deletions and insertions and merges runs", async () => {
    const { wordDiffSegments } = await import("../src/App");
    const segments = wordDiffSegments("The quick brown fox jumps", "The swift brown fox leaps high");
    expect(segments).not.toBeNull();
    const dels = segments!.filter((seg) => seg.type === "del").map((seg) => seg.text.trim());
    const inss = segments!.filter((seg) => seg.type === "ins").map((seg) => seg.text.trim());
    expect(dels.join(" ")).toContain("quick");
    expect(inss.join(" ")).toContain("swift");
    expect(inss.join(" ")).toContain("high");
    expect(segments!.map((seg) => seg.text).join("")).toContain("brown fox");
  });

  it("returns null for near-total rewrites", async () => {
    const { wordDiffSegments } = await import("../src/App");
    expect(wordDiffSegments("alpha beta gamma", "completely different words entirely")).toBeNull();
  });
});

