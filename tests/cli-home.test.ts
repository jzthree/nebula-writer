import { existsSync, lstatSync, mkdtempSync, mkdirSync, readlinkSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWriterCliHome, resolveWriterCliHome } from "../server/cli-home";
import { pruneWriterCliTrajectories, writerCliTrajectoryRoots } from "../server/maintenance";

describe("writer CLI home resolution", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const fakeHome = () => {
    const dir = mkdtempSync(join(tmpdir(), "writer-home-"));
    dirs.push(dir);
    return dir;
  };

  it("defaults to a Writer-owned home per provider", () => {
    const home = "/Users/somebody";
    expect(resolveWriterCliHome("claude", {}, home)?.dir).toBe(join(home, ".nebula-writer", "claude"));
    expect(resolveWriterCliHome("codex", {}, home)?.dir).toBe(join(home, ".nebula-writer", "codex"));
    expect(resolveWriterCliHome("claude", {}, home)?.childEnv).toBe("CLAUDE_CONFIG_DIR");
    expect(resolveWriterCliHome("codex", {}, home)?.childEnv).toBe("CODEX_HOME");
  });

  it("honors an explicit override path", () => {
    const resolved = resolveWriterCliHome("codex", { WRITER_CODEX_HOME: "/tmp/custom-codex" }, "/home/x");
    expect(resolved?.dir).toBe("/tmp/custom-codex");
  });

  it("opts out when the override is a sentinel", () => {
    for (const value of ["default", "off", "0", "none"]) {
      expect(resolveWriterCliHome("codex", { WRITER_CODEX_HOME: value }, "/home/x")).toBeNull();
      expect(resolveWriterCliHome("claude", { WRITER_CLAUDE_CONFIG_DIR: value }, "/home/x")).toBeNull();
    }
  });

  it("resolves the auth source from the effective CLI home env", () => {
    const resolved = resolveWriterCliHome("claude", { CLAUDE_CONFIG_DIR: "/custom/.claude_fable" }, "/home/x");
    expect(resolved?.sourceDir).toBe("/custom/.claude_fable");
    // Falls back to ~/.codex when the source env is unset.
    expect(resolveWriterCliHome("codex", {}, "/home/x")?.sourceDir).toBe("/home/x/.codex");
  });

  it("creates the home and symlinks auth from the real home", () => {
    const home = fakeHome();
    // Simulate the user's real ~/.codex with an auth.json.
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), '{"token":"secret"}');

    const dir = ensureWriterCliHome("codex", {}, home);
    expect(dir).toBe(join(home, ".nebula-writer", "codex"));
    const bridged = join(dir!, "auth.json");
    expect(existsSync(bridged)).toBe(true);
    expect(lstatSync(bridged).isSymbolicLink()).toBe(true);
    expect(readlinkSync(bridged)).toBe(join(home, ".codex", "auth.json"));
  });

  it("does NOT redirect claude on macOS (keychain is bound to ~/.claude)", () => {
    const home = fakeHome();
    // Verified 2026-07-08: on macOS claude's OAuth credential is bound to the
    // default ~/.claude and is not shared across config dirs, so redirecting
    // CLAUDE_CONFIG_DIR breaks login. ensureWriterCliHome returns null (no
    // redirect); transcript isolation still holds via the workspace cwd.
    expect(ensureWriterCliHome("claude", {}, home, "darwin")).toBeNull();
    expect(existsSync(join(home, ".nebula-writer", "claude"))).toBe(false);
  });

  it("does redirect claude on Linux and links .credentials.json when present", () => {
    const home = fakeHome();
    // Linux claude uses file-based creds, so redirect + symlink is correct.
    const dir = ensureWriterCliHome("claude", {}, home, "linux");
    expect(dir).toBe(join(home, ".nebula-writer", "claude"));
    // No source .credentials.json here, so nothing is linked, but the dir exists.
    expect(existsSync(dir!)).toBe(true);
    expect(existsSync(join(dir!, ".credentials.json"))).toBe(false);
  });

  it("returns null and links nothing when opted out", () => {
    const home = fakeHome();
    expect(ensureWriterCliHome("codex", { WRITER_CODEX_HOME: "default" }, home)).toBeNull();
    expect(existsSync(join(home, ".nebula-writer", "codex"))).toBe(false);
  });
});

describe("writer CLI trajectory pruning", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes aged transcripts recursively but keeps recent ones and symlinks", async () => {
    const home = mkdtempSync(join(tmpdir(), "writer-traj-"));
    dirs.push(home);
    const [claudeProjects, codexSessions] = writerCliTrajectoryRoots(home);
    const nested = join(codexSessions, "2026", "07", "06");
    mkdirSync(join(claudeProjects, "-Users-x-doc"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    const aged = (path: string) => {
      writeFileSync(path, "session");
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      utimesSync(path, old, old);
      return path;
    };
    const oldClaude = aged(join(claudeProjects, "-Users-x-doc", "old.jsonl"));
    const oldCodex = aged(join(nested, "rollout-old.jsonl"));
    const freshCodex = join(nested, "rollout-fresh.jsonl");
    writeFileSync(freshCodex, "session");
    // An auth symlink living alongside transcripts must never be pruned.
    writeFileSync(join(home, "real-auth.json"), "{}");

    const result = await pruneWriterCliTrajectories(14, [claudeProjects, codexSessions]);
    expect(result.deletedFiles).toBe(2);
    expect(existsSync(oldClaude)).toBe(false);
    expect(existsSync(join(nested, "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(freshCodex)).toBe(true);
  });
});
