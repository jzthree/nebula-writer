// @vitest-environment node
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWriterApp } from "../server/app";
import { conversationStore } from "../server/conversation-store";
import { FINISHED_RUN_TTL_MS, RunRegistry } from "../server/detached-runs";

describe("run registry", () => {
  it("wakes a waiter when the run finishes, and keeps the result for a returning pane", async () => {
    const runs = new RunRegistry();
    expect(runs.start("r1")).not.toBeNull();
    expect(runs.start("r1")).toBeNull();
    const waiting = runs.wait("r1", 5_000);
    runs.finish("r1", { status: "done", result: { ok: 1 } });
    await expect(waiting).resolves.toMatchObject({ status: "done", result: { ok: 1 } });
    expect(runs.get("r1")).toMatchObject({ status: "done" });
    // Finishing twice does not overwrite the outcome.
    runs.finish("r1", { status: "error", error: "late", stopped: false });
    expect(runs.get("r1")?.status).toBe("done");
  });

  it("returns while still running after the wait, and stops a run on request", async () => {
    const runs = new RunRegistry();
    const run = runs.start("r2")!;
    await expect(runs.wait("r2", 20)).resolves.toMatchObject({ status: "running" });
    expect(runs.stop("r2")).toBe(true);
    expect(run.signal.aborted).toBe(true);
    runs.finish("r2", { status: "error", error: "Stopped.", stopped: true });
    expect(runs.stop("r2")).toBe(false);
    expect(runs.get("nope")).toBeNull();
  });

  it("forgets finished runs after a day", () => {
    let now = 1_000;
    const runs = new RunRegistry(() => now);
    runs.start("old");
    runs.finish("old", { status: "done", result: null });
    now += FINISHED_RUN_TTL_MS + 1;
    runs.start("new");
    expect(runs.get("old")).toBeNull();
    expect(runs.get("new")?.status).toBe("running");
  });
});

describe("detached pane runs over the API", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createWriterApp().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const documentText = "Chromatin accessibility is actually a very important determinant of gene regulation.";
  const key = "gdocs:detached-test";
  const userTurn = { id: "u-1", role: "user", at: "2026-11-12T10:00:00.000Z", text: "Make this shorter" };
  const replyTurn = { id: "a-1", role: "assistant", at: "2026-11-12T10:00:00.000Z", text: "", status: "running", engine: "Demo", suggestionIds: [], progress: null, origin: "pane", activity: [], runId: "run-detached-1", provider: "demo" };
  const request = (runId: string, extra: object = {}) => ({
    provider: "demo", runId, instruction: "Make this shorter", mode: "selection", documentText, documentName: "Aims.docx", detach: true,
    selection: { from: 0, to: documentText.length, text: documentText }, ...extra
  });
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("answers at once, finishes without the pane, and saves the exchange and its reply", async () => {
    const started = await post("/api/word/suggest", request("run-detached-1", { record: { key, userTurn, replyTurn, proposedBy: "Demo" } }));
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ runId: "run-detached-1", status: "running" });

    const state = await (await fetch(`${base}/api/ai/runs/run-detached-1?wait=10`)).json() as { status: string; result?: { ai: { suggestions: Array<{ id: string }> } } };
    expect(state.status).toBe("done");
    const suggestions = state.result!.ai.suggestions;
    expect(suggestions.length).toBeGreaterThan(0);

    // Nobody saved the reply but the sidecar: it is in the conversation, finished, with its cards.
    const saved = conversationStore().read(key, {});
    expect(saved.turns.map((entry) => entry.id)).toEqual(["u-1", "a-1"]);
    const reply = saved.turns[1].turn as { status: string; suggestionIds: string[]; text: string };
    expect(reply.status).toBe("done");
    expect(reply.suggestionIds).toEqual(suggestions.map((suggestion) => suggestion.id));
    expect(saved.suggestions.map((entry) => (entry.suggestion as { id: string; proposedBy?: string }).proposedBy)).toContain("Demo");

    // A late save from a pane that still thought it was running does not undo that.
    await post("/api/conversations", { key, turns: [{ id: "a-1", turn: replyTurn }] });
    expect((conversationStore().read(key, {}).turns[1].turn as { status: string }).status).toBe("done");
  });

  it("says when it has no record of a run, and validates ids and records", async () => {
    const missing = await fetch(`${base}/api/ai/runs/never-started`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toContain("restarted");
    expect((await fetch(`${base}/api/ai/runs/has%20space`)).status).toBe(400);
    expect((await post("/api/word/suggest", request("run-bad-record", { record: { key, userTurn: { role: "user" }, replyTurn, proposedBy: "Demo" } }))).status).toBe(400);
    expect((await post("/api/ai/runs/never-started/stop", {})).status).toBe(200);
  });

  it("keeps the old behaviour for a request that does not ask to detach", async () => {
    const response = await post("/api/word/suggest", { ...request("run-attached"), detach: false });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ai: { suggestions: unknown[] } }).ai.suggestions.length).toBeGreaterThan(0);
  });
});
