// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let installed: () => void;
let startup: () => void;
let updated: (tabId: number, info: unknown, tab: { url?: string }) => void;
let activated: (info: { tabId: number }) => Promise<void>;

const setPanelBehavior = vi.fn(async (_options: unknown) => undefined);
const setOptions = vi.fn(async (_options: unknown) => undefined);
const query = vi.fn(async (_query: unknown): Promise<Array<{ id?: number; url?: string }>> => []);
const get = vi.fn(async (id: number): Promise<{ id: number; url?: string }> => ({ id }));

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  setPanelBehavior.mockResolvedValue(undefined);
  setOptions.mockResolvedValue(undefined);
  query.mockResolvedValue([]);
  vi.stubGlobal("chrome", {
    runtime: {
      onInstalled: { addListener: (listener: typeof installed) => { installed = listener; } },
      onStartup: { addListener: (listener: typeof startup) => { startup = listener; } }
    },
    sidePanel: { setPanelBehavior, setOptions },
    tabs: {
      query,
      get,
      onUpdated: { addListener: (listener: typeof updated) => { updated = listener; } },
      onActivated: { addListener: (listener: typeof activated) => { activated = listener; } }
    }
  });
  await import("../src/chrome/background");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Chrome tab-bound panel lifecycle", () => {
  it("configures existing document tabs when the extension is installed or updated", async () => {
    query.mockResolvedValue([
      { id: 27, url: "https://docs.google.com/document/d/example-document_123/edit" },
      { id: 28, url: "https://docs.google.com/document/u/1/d/other-document/edit" },
      { url: "https://docs.google.com/document/d/closed-document/edit" }
    ]);
    installed();
    await vi.waitFor(() => expect(setOptions).toHaveBeenCalledTimes(2));
    expect(setPanelBehavior).toHaveBeenCalledExactlyOnceWith({ openPanelOnActionClick: true });
    expect(query).toHaveBeenCalledExactlyOnceWith({ url: "https://docs.google.com/document/*" });
    expect(setOptions).toHaveBeenCalledWith({ tabId: 27, path: "sidepanel.html?tabId=27", enabled: true });
    expect(setOptions).toHaveBeenCalledWith({ tabId: 28, path: "sidepanel.html?tabId=28", enabled: true });
  });

  it("restores tab bindings after Chrome starts", async () => {
    query.mockResolvedValue([{ id: 27, url: "https://docs.google.com/document/d/example-document_123/edit" }]);
    startup();
    await vi.waitFor(() => expect(setOptions).toHaveBeenCalledExactlyOnceWith({
      tabId: 27, path: "sidepanel.html?tabId=27", enabled: true
    }));
    expect(setPanelBehavior).not.toHaveBeenCalled();
  });

  it("updates the panel for document navigation and disables it outside a document", () => {
    updated(27, {}, { url: "https://docs.google.com/document/u/2/d/example-document_123/edit" });
    expect(setOptions).toHaveBeenLastCalledWith({ tabId: 27, path: "sidepanel.html?tabId=27", enabled: true });
    updated(27, {}, { url: "https://docs.google.com/document/u/2/" });
    expect(setOptions).toHaveBeenLastCalledWith({ tabId: 27, enabled: false });
    updated(27, {}, { url: "https://example.com/" });
    expect(setOptions).toHaveBeenLastCalledWith({ tabId: 27, enabled: false });
  });

  it("configures the activated tab without querying another window's active document", async () => {
    get.mockResolvedValue({ id: 28, url: "https://docs.google.com/document/d/other-document/edit" });
    await activated({ tabId: 28 });
    expect(get).toHaveBeenCalledExactlyOnceWith(28);
    expect(setOptions).toHaveBeenCalledExactlyOnceWith({ tabId: 28, path: "sidepanel.html?tabId=28", enabled: true });
    expect(query).not.toHaveBeenCalled();
  });

  it("ignores an update that does not yet expose the tab URL", () => {
    updated(27, {}, {});
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("tolerates tabs that close while panel options are being configured", async () => {
    get.mockRejectedValueOnce(new Error("No tab with id: 27"));
    await expect(activated({ tabId: 27 })).resolves.toBeUndefined();
    get.mockResolvedValue({ id: 28, url: "https://docs.google.com/document/d/other-document/edit" });
    setOptions.mockRejectedValueOnce(new Error("No tab with id: 28"));
    await expect(activated({ tabId: 28 })).resolves.toBeUndefined();
  });
});
