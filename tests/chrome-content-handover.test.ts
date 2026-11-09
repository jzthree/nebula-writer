// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

type Listener = (message: unknown, sender: unknown, respond: (reply: unknown) => void) => boolean;

describe("Chrome content script handover", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
    delete (globalThis as { __nebulaWriterContent?: unknown }).__nebulaWriterContent;
    vi.resetModules();
  });

  it("lets only the newest injected copy answer, and reports its code id", async () => {
    const listeners: Listener[] = [];
    (globalThis as { chrome?: unknown }).chrome = { runtime: { onMessage: { addListener: (listener: Listener) => listeners.push(listener) } } };
    await import("../src/chrome/content");
    vi.resetModules();
    await import("../src/chrome/content");
    expect(listeners).toHaveLength(2);
    const [older, newer] = listeners;
    const olderReply = vi.fn();
    expect(older({ type: "nebula-writer:ping" }, {}, olderReply)).toBe(false);
    expect(olderReply).not.toHaveBeenCalled();
    const newerReply = vi.fn();
    expect(newer({ type: "nebula-writer:ping" }, {}, newerReply)).toBe(true);
    expect(newerReply).toHaveBeenCalledWith({ code: "__NEBULA_CONTENT_CODE__", url: location.href });
  });
});

describe("Pane view of the extension panel", () => {
  afterEach(() => vi.resetModules());

  async function announce(data: object) {
    const bridge = await import("../src/gdocs/scriptBridge");
    void bridge.waitForScriptHost(50);
    window.dispatchEvent(new MessageEvent("message", { data, origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", source: window }));
    return bridge;
  }

  it("flags an extension panel that cannot update itself as out of date", async () => {
    const bridge = await announce({ nebula: "host-ready" });
    expect(bridge.extensionHostIsOutdated()).toBe(true);
  });

  it("asks a self-updating panel to reload only after it says it has newer code", async () => {
    const bridge = await announce({ nebula: "host-ready", selfUpdating: true });
    expect(bridge.extensionHostIsOutdated()).toBe(false);
    expect(bridge.hostWantsReload()).toBe(false);
    window.dispatchEvent(new MessageEvent("message", { data: { nebula: "host-outdated" }, origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", source: window }));
    expect(bridge.hostWantsReload()).toBe(true);
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    bridge.reloadHost();
    expect(post).toHaveBeenCalledWith({ nebula: "reload-host" }, "chrome-extension://abcdefghijklmnopabcdefghijklmnop");
  });
});
