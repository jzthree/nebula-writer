import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliProviderName } from "./cli-runtime";

/**
 * Where the spawned CLIs keep their session transcripts / trajectories.
 *
 * By default Writer confines them to a Writer-owned home
 * (~/.nebula-writer/{claude,codex}) instead of spamming the user's personal
 * ~/.claude / ~/.codex with one transcript per AI request. The catch is auth:
 * Codex stores auth.json inside CODEX_HOME and Claude (on Linux) stores
 * credentials inside CLAUDE_CONFIG_DIR, so a fresh home would fail to
 * authenticate. We bridge that by symlinking the credential files from the
 * user's real home into the Writer home — a link, not a copy, so refreshed
 * tokens stay valid and secrets are never duplicated. On macOS Claude auth
 * lives in the keychain (shared across config dirs), so nothing is linked.
 *
 * Override the location with WRITER_CLAUDE_CONFIG_DIR / WRITER_CODEX_HOME, or
 * set either to "default" (or off/0/none) to opt out and let the CLI use its
 * own home.
 */

type ProviderHomeConfig = {
  overrideEnv: string;
  childEnv: string;
  defaultLeaf: string;
  sourceEnv: string;
  sourceLeaf: string;
  authFiles: string[];
};

const PROVIDER_HOME: Record<CliProviderName, ProviderHomeConfig> = {
  claude: {
    overrideEnv: "WRITER_CLAUDE_CONFIG_DIR",
    childEnv: "CLAUDE_CONFIG_DIR",
    defaultLeaf: "claude",
    sourceEnv: "CLAUDE_CONFIG_DIR",
    sourceLeaf: ".claude",
    // macOS keeps Claude auth in the keychain; .credentials.json only exists
    // on file-based (Linux) installs, where it must be bridged.
    authFiles: [".credentials.json"]
  },
  codex: {
    overrideEnv: "WRITER_CODEX_HOME",
    childEnv: "CODEX_HOME",
    defaultLeaf: "codex",
    sourceEnv: "CODEX_HOME",
    sourceLeaf: ".codex",
    authFiles: ["auth.json"]
  }
};

const OPT_OUT_VALUES = new Set(["default", "off", "0", "none", "false"]);

export type WriterCliHome = {
  childEnv: string;
  dir: string;
  sourceDir: string;
  authFiles: string[];
};

export function resolveWriterCliHome(
  provider: CliProviderName,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): WriterCliHome | null {
  const config = PROVIDER_HOME[provider];
  const override = env[config.overrideEnv]?.trim();
  if (override && OPT_OUT_VALUES.has(override.toLowerCase())) {
    return null;
  }
  const dir = override || join(home, ".nebula-writer", config.defaultLeaf);
  const sourceDir = env[config.sourceEnv]?.trim() || join(home, config.sourceLeaf);
  return { childEnv: config.childEnv, dir, sourceDir, authFiles: config.authFiles };
}

/**
 * Ensure the Writer home exists and its auth is reachable, returning the dir
 * to point the child's CLAUDE_CONFIG_DIR / CODEX_HOME at (or null when opted
 * out). Best-effort: any filesystem hiccup falls back to no redirect so a
 * failure here can never take AI offline.
 */
export function ensureWriterCliHome(
  provider: CliProviderName,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): string | null {
  // CRITICAL (verified 2026-07-08): on macOS, Claude Code's OAuth credential
  // lives in the login keychain BOUND TO the default ~/.claude config dir — it
  // is NOT shared across config dirs. Redirecting CLAUDE_CONFIG_DIR makes
  // claude report "Not logged in". This was masked because a Claude Code
  // session leaks CLAUDE_CODE_OAUTH_TOKEN into children; a launchd-started
  // sidecar has no such token and would break. So on macOS we do not redirect
  // claude's home. Transcript isolation still holds via the dedicated
  // cli-workspace cwd (claude keys transcripts by working directory). codex is
  // unaffected — file-based auth.json bridged by symlink works anywhere.
  if (provider === "claude" && platform === "darwin") {
    return null;
  }
  const resolved = resolveWriterCliHome(provider, env, home);
  if (!resolved) {
    return null;
  }
  try {
    mkdirSync(resolved.dir, { recursive: true });
  } catch {
    return null;
  }
  // Redirecting to a dir that is somehow the source (override points back at
  // the real home) needs no bridging and must not self-link.
  if (resolved.dir !== resolved.sourceDir) {
    for (const authFile of resolved.authFiles) {
      const source = join(resolved.sourceDir, authFile);
      const dest = join(resolved.dir, authFile);
      if (existsSync(source) && !existsSync(dest)) {
        try {
          symlinkSync(source, dest);
        } catch {
          // A pre-existing dest (race) or unsupported symlink is non-fatal;
          // Claude on macOS authenticates via keychain regardless.
        }
      }
    }
  }
  return resolved.dir;
}

/**
 * Entries of a Codex home that hold the user's history and runtime state —
 * what the Codex app lists as chat history (sessions, the thread/state
 * databases and their indexes) plus logs, locks, sockets and scratch space.
 * A mirror home never links these, so Writer's threads are recorded in
 * Writer's own home and never appear in the app.
 */
const CODEX_PRIVATE_ENTRY = /^(?:sessions|archived_sessions|session_index|history|log|logs?_\d|state_\d|thread_history|thread-writer-locks|goals_\d|queue_\d|memories|shell_snapshots|tmp|worktrees|app-server|ipc|process_manager|sqlite|automations|ambient-suggestions|attachments|generated_images|dictation-history|transcription-history|realtime-voice|visualizations|pets|tui-|rollout-migrations|external_agent_session_imports)|\.corrupt-|\.pre-index-repair-|\.backup-|-backup$|\.hop-backup$/i;

export function isCodexPrivateEntry(name: string): boolean {
  return CODEX_PRIVATE_ENTRY.test(name);
}

/**
 * Codex home for "everything your CLI has" runs: the user's own setup
 * without the user's history. Every entry of ~/.codex — config.toml, auth,
 * MCP servers, plugins, computer use, skills, rules, hooks, caches — is
 * linked in, except the history and state stores (isCodexPrivateEntry), so
 * Codex runs exactly as the user runs it while the threads Writer starts are
 * recorded here and stay out of the Codex app's chat history. Links are
 * refreshed on every run, so anything the user adds to ~/.codex carries over.
 * Null when opted out (WRITER_CODEX_HOME=default) or on a filesystem failure,
 * in which case the CLI's own home is used.
 */
export function ensureWriterCodexMirrorHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  const resolved = resolveWriterCliHome("codex", env, home);
  if (!resolved) {
    return null;
  }
  const dir = env.WRITER_CODEX_FULL_HOME?.trim() || join(home, ".nebula-writer", "codex-full");
  if (dir === resolved.sourceDir) {
    return null;
  }
  try {
    mkdirSync(dir, { recursive: true });
    const sourceEntries = existsSync(resolved.sourceDir) ? readdirSync(resolved.sourceDir) : [];
    const wanted = new Set(sourceEntries.filter((name) => !isCodexPrivateEntry(name)));
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let link: string | null = null;
      try {
        link = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
      } catch {
        link = null;
      }
      // Drop links to entries that are gone (or have become private).
      if (link !== null && (!wanted.has(name) || link !== join(resolved.sourceDir, name))) {
        unlinkSync(path);
      }
    }
    for (const name of wanted) {
      const source = join(resolved.sourceDir, name);
      const dest = join(dir, name);
      let stat: ReturnType<typeof lstatSync> | null = null;
      try {
        stat = lstatSync(dest);
      } catch {
        stat = null;
      }
      if (stat?.isSymbolicLink()) {
        continue;
      }
      if (stat && name === "config.toml") {
        // Codex rewrote the linked config in place (a rename replaces the link):
        // keep that copy aside and follow the user's config again.
        renameSync(dest, join(dir, `config.toml.writer-local-${Date.now()}`));
      } else if (stat) {
        continue; // Codex created its own copy here (e.g. a refreshed auth.json): leave it.
      }
      symlinkSync(source, dest);
    }
    return dir;
  } catch {
    return null;
  }
}
