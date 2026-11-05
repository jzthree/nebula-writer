import { describe, expect, it, vi } from "vitest";
import { entryScriptOf, reloadPaneIfOutdated } from "../src/word/paneUpdate";

describe("pane self-update", () => {
  it("reads the entry script of a built page", () => {
    expect(entryScriptOf('<script>x</script>\n<script type="module" crossorigin src="/assets/word-Kh_rpqso.js"></script>')).toBe("/assets/word-Kh_rpqso.js");
    expect(entryScriptOf("<p>no script</p>")).toBeNull();
  });

  it("reloads only for a different build, and only when idle", async () => {
    const run = async (served: string | null, idle: boolean) => {
      const reload = vi.fn();
      const did = await reloadPaneIfOutdated({ loaded: () => "/assets/word-a.js", served: async () => served, idle: () => idle, reload });
      expect(reload).toHaveBeenCalledTimes(did ? 1 : 0);
      return did;
    };
    expect(await run("/assets/word-b.js", true)).toBe(true);
    expect(await run("/assets/word-b.js", false)).toBe(false);
    expect(await run("/assets/word-a.js", true)).toBe(false);
    expect(await run(null, true)).toBe(false);
  });

  it("never fetches when the page has no built entry (dev server, tests)", async () => {
    const served = vi.fn(async () => "/assets/word-b.js");
    expect(await reloadPaneIfOutdated({ loaded: () => null, served, idle: () => true, reload: vi.fn() })).toBe(false);
    expect(served).not.toHaveBeenCalled();
  });

  it("treats an unreachable sidecar as no update", async () => {
    const reload = vi.fn();
    expect(await reloadPaneIfOutdated({ loaded: () => "/assets/word-a.js", served: async () => { throw new Error("offline"); }, idle: () => true, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
