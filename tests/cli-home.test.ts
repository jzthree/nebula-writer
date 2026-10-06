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

describe("Codex mirror home (full access without the user's history)", () => {
  it("links the user's setup in, keeps history and state out, and follows later changes", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readdirSync, lstatSync, readlinkSync, rmSync, existsSync, renameSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ensureWriterCodexMirrorHome, isCodexPrivateEntry } = await import("../server/cli-home");
    const home = mkdtempSync(join(tmpdir(), "writer-mirror-"));
    try {
      const source = join(home, ".codex");
      mkdirSync(join(source, "sessions", "2026"), { recursive: true });
      mkdirSync(join(source, "plugins"), { recursive: true });
      mkdirSync(join(source, "computer-use"), { recursive: true });
      for (const name of ["config.toml", "auth.json", "AGENTS.md", "hooks.json", "state_5.sqlite", "state_5.sqlite-wal", "thread_history_1.sqlite", "session_index.jsonl", "history.jsonl", "logs_2.sqlite", "config.toml.backup-123"]) {
        writeFileSync(join(source, name), name);
      }
      const dir = ensureWriterCodexMirrorHome({}, home);
      expect(dir).toBe(join(home, ".nebula-writer", "codex-full"));
      const linked = readdirSync(dir!).sort();
      expect(linked).toEqual(["AGENTS.md", "auth.json", "computer-use", "config.toml", "hooks.json", "plugins"]);
      for (const name of linked) {
        expect(lstatSync(join(dir!, name)).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(dir!, name))).toBe(join(source, name));
      }
      // Codex writes its own history into the mirror; later runs leave it alone.
      mkdirSync(join(dir!, "sessions"), { recursive: true });
      writeFileSync(join(dir!, "state_5.sqlite"), "writer-own");
      // The user adds a skill and removes hooks; Codex replaced the linked config with a file.
      mkdirSync(join(source, "skills"));
      rmSync(join(source, "hooks.json"));
      renameSync(join(dir!, "config.toml"), join(dir!, "tmp-cfg"));
      writeFileSync(join(dir!, "config.toml"), "rewritten by codex");
      rmSync(join(dir!, "tmp-cfg"));
      ensureWriterCodexMirrorHome({}, home);
      expect(lstatSync(join(dir!, "skills")).isSymbolicLink()).toBe(true);
      expect(existsSync(join(dir!, "hooks.json"))).toBe(false);
      expect(lstatSync(join(dir!, "config.toml")).isSymbolicLink()).toBe(true);
      expect(readdirSync(dir!).some((name) => name.startsWith("config.toml.writer-local-"))).toBe(true);
      expect(lstatSync(join(dir!, "state_5.sqlite")).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(dir!, "sessions")).isSymbolicLink()).toBe(false);
      expect(ensureWriterCodexMirrorHome({ WRITER_CODEX_HOME: "default" }, home)).toBeNull();
      for (const name of ["sessions", "archived_sessions", "session_index.jsonl", "state_5.sqlite-shm", "thread_history_1.sqlite", "goals_1.sqlite", "memories_1.sqlite", "app-server-daemon", "logs_2.sqlite", ".codex-global-state.json", ".app-server-state-reconciled-v1", "..codex-global-state.json.tmp-1"]) {
        expect(isCodexPrivateEntry(name)).toBe(true);
      }
      for (const name of ["config.toml", "auth.json", "plugins", "computer-use", "skills", "rules", "AGENTS.md", "vendor_imports", "node_repl", "packages", "browser"]) {
        expect(isCodexPrivateEntry(name)).toBe(false);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
