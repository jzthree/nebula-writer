import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeUserHistoryLocations } from "../server/ai";

const homes: string[] = [];
function fakeHome(dirs: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "writer-home-"));
  homes.push(home);
  for (const dir of dirs) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  return home;
}
afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("where the user's own session histories are", () => {
  it("names only the history folders that exist in this user's home", () => {
    const home = fakeHome([".codex/sessions", ".claude/projects", ".claude-work/projects", ".claude-empty"]);
    const [line] = describeUserHistoryLocations("full", home, {});
    expect(line).toContain(join(home, ".codex", "sessions"));
    expect(line).toContain(join(home, ".claude", "projects"));
    expect(line).toContain(join(home, ".claude-work", "projects"));
    expect(line).not.toContain("archived_sessions");
    expect(line).not.toContain(".claude-empty");
  });

  it("follows CODEX_HOME and CLAUDE_CONFIG_DIR set elsewhere", () => {
    const home = fakeHome(["elsewhere/codex/sessions", "elsewhere/claude/projects"]);
    const [line] = describeUserHistoryLocations("read", home, { CODEX_HOME: join(home, "elsewhere/codex"), CLAUDE_CONFIG_DIR: join(home, "elsewhere/claude") });
    expect(line).toContain(join(home, "elsewhere/codex/sessions"));
    expect(line).toContain(join(home, "elsewhere/claude/projects"));
  });

  it("says nothing when the run cannot read files, or there is no history", () => {
    expect(describeUserHistoryLocations("document", fakeHome([".codex/sessions"]), {})).toEqual([]);
    expect(describeUserHistoryLocations("full", fakeHome([]), {})).toEqual([]);
  });
});
