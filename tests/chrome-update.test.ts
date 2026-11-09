// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ensureCurrentContent, readBuildId, readCodeIds, reloadIfOutdated } from "../src/chrome/extensionUpdate";

describe("Chrome extension self-update", () => {
  const check = (own: string | null, served: string | null, panelOpen = false) => {
    const reload = vi.fn();
    return { reload, run: () => reloadIfOutdated({ ownBuild: async () => own, servedBuild: async () => served, panelOpen: async () => panelOpen, reload }) };
  };

  it("reloads when the sidecar serves a newer build and no panel is open", async () => {
    const { reload, run } = check("aaaa1111", "bbbb2222");
    expect(await run()).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("waits while a Writer panel is open, and stays put when current or offline", async () => {
    for (const [own, served, open] of [["aaaa1111", "bbbb2222", true], ["aaaa1111", "aaaa1111", false], ["aaaa1111", null, false], [null, "bbbb2222", false]] as const) {
      const { reload, run } = check(own, served, open);
      expect(await run()).toBe(false);
      expect(reload).not.toHaveBeenCalled();
    }
  });

  it("accepts only well-formed build ids", () => {
    expect(readBuildId({ build: "0123abcd4567ef89" })).toBe("0123abcd4567ef89");
    expect(readBuildId({ build: "../../etc" })).toBeNull();
    expect(readBuildId(null)).toBeNull();
  });
});

describe("Chrome extension updates while a panel stays open", () => {
  const disk = { sidepanel: "5151aaaa", content: "c0c0bbbb" };

  it("reads both code ids from the build, or nothing", () => {
    expect(readCodeIds({ build: "ffff0000", ...disk })).toEqual(disk);
    expect(readCodeIds({ build: "ffff0000" })).toBeNull();
    expect(readCodeIds({ sidepanel: "__NEBULA_SIDEPANEL_CODE__", content: "c0c0bbbb" })).toBeNull();
  });

  it("injects the content script on disk into a tab running an older copy, or none", async () => {
    for (const before of ["0ld0c0de", null]) {
      let running: string | null = before;
      const inject = vi.fn(async () => { running = disk.content; });
      const code = await ensureCurrentContent(7, { disk: async () => disk, running: async () => running, inject });
      expect(inject).toHaveBeenCalledWith(7);
      expect(code).toBe(disk.content);
    }
  });

  it("leaves a current copy alone, and keeps whatever answers when the build cannot be read", async () => {
    const inject = vi.fn(async () => undefined);
    expect(await ensureCurrentContent(7, { disk: async () => disk, running: async () => disk.content, inject })).toBe(disk.content);
    expect(await ensureCurrentContent(7, { disk: async () => { throw new Error("gone"); }, running: async () => "0ld0c0de", inject })).toBe("0ld0c0de");
    expect(inject).not.toHaveBeenCalled();
  });

  it("reports nothing answering when injection is refused", async () => {
    const code = await ensureCurrentContent(7, { disk: async () => disk, running: async () => { throw new Error("No receiver"); }, inject: async () => undefined });
    expect(code).toBeNull();
  });
});
