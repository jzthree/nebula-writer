import { spawnSync } from "node:child_process";

/**
 * The user's interactive login-shell PATH. A launchd-started server gets a
 * sparse PATH (/usr/bin:/bin:...), but the CLIs we spawn (claude/codex) are
 * node scripts whose `#!/usr/bin/env node` shebang needs the real PATH. Capture
 * it once with a sentinel so init-time stdout (nvm greetings, etc.) can't
 * corrupt it.
 */
const SENTINEL = "WRITER_LOGIN_PATH=";
let cached: string | null = null;

export function captureLoginPath(): string {
  if (cached !== null) {
    return cached;
  }
  const shell = process.env.SHELL?.trim() || "/bin/zsh";
  try {
    const result = spawnSync(shell, ["-lic", `printf "${SENTINEL}%s\\n" "$PATH"`], { encoding: "utf8", timeout: 10_000 });
    const line = (result.stdout ?? "").split("\n").reverse().find((entry) => entry.startsWith(SENTINEL));
    const captured = line?.slice(SENTINEL.length).trim();
    if (captured) {
      cached = captured;
      return cached;
    }
  } catch {
    // fall through to the fallback
  }
  const parts = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    if (!parts.includes(dir)) {
      parts.push(dir);
    }
  }
  cached = parts.join(":");
  return cached;
}
