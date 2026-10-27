// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { ConversationStore, resetConversationStore } from "../server/conversation-store";
import { createWriterApp } from "../server/app";

let store: ConversationStore;

beforeEach(() => {
  store = new ConversationStore(":memory:");
});

afterEach(() => {
  store.close();
});

const turn = (id: string, text = id) => ({ id, turn: { id, role: "user", text } });

describe("conversation store", () => {
  it("restores the latest page, earlier pages on demand, and the sessions to resume", () => {
    for (let index = 1; index <= 5; index += 1) {
      store.write("word:/a.docx", { turns: [turn(`t${index}`)] });
    }
    store.write("word:/a.docx", { sessions: { codex: "thread-1" } });
    const latest = store.read("word:/a.docx", { limit: 2 });
    expect(latest.turns.map((entry) => entry.id)).toEqual(["t4", "t5"]);
    expect(latest.sessions).toEqual({ codex: "thread-1" });
    const earlier = store.read("word:/a.docx", { limit: 2, before: latest.before });
    expect(earlier.turns.map((entry) => entry.id)).toEqual(["t2", "t3"]);
    const first = store.read("word:/a.docx", { limit: 2, before: earlier.before });
    expect(first.turns.map((entry) => entry.id)).toEqual(["t1"]);
    expect(first.before).toBeNull();
    expect(store.read("word:/other.docx").turns).toEqual([]);
  });

  it("updates a turn in place, keeping its position", () => {
    store.write("k", { turns: [turn("a"), turn("b")] });
    store.write("k", { turns: [{ id: "a", turn: { id: "a", role: "assistant", text: "done" } }] });
    expect(store.read("k").turns.map((entry) => [entry.id, (entry.turn as { text: string }).text])).toEqual([["a", "done"], ["b", "b"]]);
  });

  it("returns each page's suggestions and card states, and every pending suggestion with the first page", () => {
    store.write("k", {
      turns: [turn("old"), turn("new")],
      suggestions: [{ id: "s-old", turnId: "old", suggestion: { title: "old" } }, { id: "s-new", turnId: "new", suggestion: { title: "new" } }, { id: "s-done", turnId: "old", suggestion: { title: "done" } }],
      cards: { "s-old": { state: { outcome: "pending" }, pending: true }, "s-done": { state: { outcome: "applied" }, pending: false } }
    });
    const latest = store.read("k", { limit: 1 });
    expect(latest.turns.map((entry) => entry.id)).toEqual(["new"]);
    // s-old is pending from an earlier page; s-done (decided, earlier page) waits for its page.
    expect(latest.suggestions.map((entry) => entry.id).sort()).toEqual(["s-new", "s-old"]);
    expect(latest.cards).toEqual({ "s-old": { outcome: "pending" } });
    const earlier = store.read("k", { limit: 1, before: latest.before });
    expect(earlier.suggestions.map((entry) => entry.id).sort()).toEqual(["s-done", "s-old"]);
    expect(earlier.cards["s-done"]).toEqual({ outcome: "applied" });
  });

  it("starts a new conversation without the earlier turns or sessions, and clears entirely", () => {
    store.write("k", { turns: [turn("a")], sessions: { claude: "s1" }, suggestions: [{ id: "p", turnId: "a", suggestion: {} }], cards: { p: { state: {}, pending: true } } });
    store.reset("k", "new");
    const fresh = store.read("k");
    expect(fresh.turns).toEqual([]);
    expect(fresh.sessions).toEqual({});
    expect(fresh.suggestions.map((entry) => entry.id)).toEqual(["p"]);
    store.write("k", { turns: [turn("b")] });
    expect(store.read("k").turns.map((entry) => entry.id)).toEqual(["b"]);
    store.reset("k", "clear");
    expect(store.read("k")).toMatchObject({ turns: [], suggestions: [], sessions: {} });
  });

  it("stays fast however long the conversation grows", () => {
    const big = "x".repeat(2_000);
    for (let batch = 0; batch < 100; batch += 1) {
      const turns = Array.from({ length: 100 }, (_, index) => turn(`t${batch * 100 + index}`, big));
      const suggestions = turns.map((entry) => ({ id: `s-${entry.id}`, turnId: entry.id, suggestion: { title: entry.id } }));
      store.write("long", { turns, suggestions, cards: Object.fromEntries(suggestions.map((entry) => [entry.id, { state: { outcome: "applied" }, pending: false }])) });
    }
    const started = performance.now();
    const latest = store.read("long", { limit: 40 });
    const earlier = store.read("long", { limit: 40, before: latest.before });
    store.write("long", { turns: [turn("one-more")] });
    const elapsed = performance.now() - started;
    expect(latest.turns).toHaveLength(40);
    expect(earlier.turns[39].id).toBe("t9959");
    // 10,000 turns (20 MB): a page read and an append stay in milliseconds.
    expect(elapsed).toBeLessThan(100);
  });
});

describe("conversation API", () => {
  afterEach(() => resetConversationStore());

  it("writes, pages and resets a document's conversation", async () => {
    const server = createWriterApp().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const get = (query: Record<string, string>) => fetch(`${base}/api/conversations?${new URLSearchParams(query)}`);
    try {
      const key = "word:file:///Users/me/Grant Draft.docx";
      expect((await post("/api/conversations/write", { key, turns: [turn("a"), turn("b")], sessions: { codex: "t-1" } })).status).toBe(200);
      const page = await (await get({ key, limit: "1" })).json();
      expect(page.turns.map((entry: { id: string }) => entry.id)).toEqual(["b"]);
      expect(page.sessions).toEqual({ codex: "t-1" });
      const earlier = await (await get({ key, limit: "1", before: String(page.before) })).json();
      expect(earlier.turns.map((entry: { id: string }) => entry.id)).toEqual(["a"]);
      expect((await post("/api/conversations/reset", { key, mode: "new" })).status).toBe(200);
      expect((await (await get({ key })).json()).turns).toEqual([]);
      expect((await get({ key: "" })).status).toBe(400);
      expect((await post("/api/conversations/write", { key, turns: [{ turn: {} }] })).status).toBe(400);
    } finally {
      server.close();
    }
  });
});
