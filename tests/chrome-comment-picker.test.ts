// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { openCommentPicker, type CommentPickerConfig } from "../src/chrome/commentPicker";

const config: CommentPickerConfig = {
  paneOrigin: "https://localhost:8443", extensionOrigin: `chrome-extension://${"a".repeat(32)}`,
  apiKey: "public-test-key", appId: "123456789", docId: "paper-id", documentName: "Test paper"
};
let popup: { closed: boolean; close: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> };
let channels: Array<{ port1: { onmessage: ((event: { data: unknown }) => void) | null; close: ReturnType<typeof vi.fn> }; port2: object }>;

beforeEach(() => {
  vi.useFakeTimers();
  channels = [];
  popup = { closed: false, close: vi.fn(), postMessage: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  vi.stubGlobal("MessageChannel", class {
    port1 = { onmessage: null, close: vi.fn() };
    port2 = {};
    constructor() { channels.push(this); }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function ready(overrides: { origin?: string; source?: Window; nonce?: string } = {}): void {
  const url = new URL(vi.mocked(window.open).mock.calls[0][0] as string);
  window.dispatchEvent(new MessageEvent("message", {
    origin: overrides.origin ?? config.paneOrigin,
    source: overrides.source ?? popup as unknown as Window,
    data: { nebula: "comment-picker-ready", nonce: overrides.nonce ?? url.searchParams.get("nonce") }
  }));
}

describe("per-document Google Picker connection", () => {
  it("sends only the origin needed by website-restricted API keys", () => {
    const page = new DOMParser().parseFromString(readFileSync("gdocs/comment-picker.html", "utf8"), "text/html");
    expect(page.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("strict-origin");
  });

  it("requires configured credentials before opening or requesting an OAuth token", async () => {
    const token = vi.fn(async () => "oauth-test-token");
    await expect(openCommentPicker({ ...config, apiKey: "" }, token)).rejects.toThrow("not configured");
    expect(window.open).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
  });

  it("sends the token only after an exact origin, window, and nonce handshake", async () => {
    const token = vi.fn(async () => "oauth-test-token");
    const pending = openCommentPicker(config, token);
    expect(String(vi.mocked(window.open).mock.calls[0][0])).not.toContain("oauth-test-token");
    ready({ origin: "https://example.com" });
    ready({ nonce: "wrong-nonce" });
    ready({ source: window });
    expect(token).not.toHaveBeenCalled();
    ready();
    await Promise.resolve();
    expect(token).toHaveBeenCalledTimes(1);
    expect(popup.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      nebula: "comment-picker-init", token: "oauth-test-token", appId: "123456789"
    }), config.paneOrigin, [channels[0].port2]);
    channels[0].port1.onmessage!({ data: { type: "picked", docId: "paper-id" } });
    await expect(pending).resolves.toBeUndefined();
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(channels[0].port1.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses to attach a different document", async () => {
    const pending = openCommentPicker(config, async () => "oauth-test-token");
    ready();
    await Promise.resolve();
    channels[0].port1.onmessage!({ data: { type: "picked", docId: "wrong-paper" } });
    await expect(pending).rejects.toThrow("different document");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up after cancellation or a closed popup", async () => {
    const pending = openCommentPicker(config, async () => "oauth-test-token");
    popup.closed = true;
    vi.advanceTimersByTime(500);
    await expect(pending).rejects.toThrow("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up when Google permission is denied", async () => {
    const pending = openCommentPicker(config, async () => { throw new Error("Denied"); });
    ready();
    await expect(pending).rejects.toThrow("did not grant");
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a blocked popup without requesting OAuth permission", async () => {
    vi.mocked(window.open).mockReturnValue(null);
    const token = vi.fn(async () => "oauth-test-token");
    await expect(openCommentPicker(config, token)).rejects.toThrow("blocked");
    expect(token).not.toHaveBeenCalled();
  });
});
