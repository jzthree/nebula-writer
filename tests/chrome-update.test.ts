// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readBuildId, reloadIfOutdated } from "../src/chrome/extensionUpdate";

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
