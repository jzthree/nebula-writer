import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type CliProviderName = "codex" | "claude";

type ProviderConfig = {
  executable: string;
  overrideEnv: string;
};

export type ResolvedCliCommand = {
  provider: CliProviderName;
  executable: string;
  overrideEnv: string;
  overrideValue: string | null;
  command: string | null;
  path: string | null;
  available: boolean;
  detail: string;
};

export type CliTimeoutConfig = {
  env: "WRITER_CLI_TIMEOUT_MS";
  value: string | null;
  /** Milliseconds before a provider process is killed; 0 means no timeout. */
  timeoutMs: number;
  defaultMs: number;
  minMs: number;
  maxMs: number | null;
  valid: boolean;
  clamped: boolean;
  detail: string;
};

const TRUTHY_CLI_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSY_CLI_VALUES = new Set(["0", "false", "no", "off"]);
// No timeout by default: a Codex/Claude request runs until it finishes or the
// user stops it. Long global passes routinely take longer than any fixed
// budget, and a killed run throws away minutes of work — the UI shows live
// progress instead. WRITER_CLI_TIMEOUT_MS remains an opt-in cap.
const DEFAULT_CLI_TIMEOUT_MS = 0;
const MIN_CLI_TIMEOUT_MS = 100;
const CLI_TIMEOUT_ENV = "WRITER_CLI_TIMEOUT_MS";
const DISABLED_CLI_TIMEOUT_VALUES = new Set(["0", "off", "none", "no", "false", "unlimited", "infinite"]);

const PROVIDER_CONFIG: Record<CliProviderName, ProviderConfig> = {
  codex: {
    executable: "codex",
    overrideEnv: "WRITER_CODEX_PATH"
  },
  claude: {
    executable: "claude",
    overrideEnv: "WRITER_CLAUDE_PATH"
  }
};

export function resolveCliCommand(provider: CliProviderName): ResolvedCliCommand {
  const config = PROVIDER_CONFIG[provider];
  const overrideValue = process.env[config.overrideEnv]?.trim() || null;

  if (overrideValue) {
    const overrideResolution = resolveOverride(overrideValue);
    if (overrideResolution.path) {
      return {
        provider,
        executable: config.executable,
        overrideEnv: config.overrideEnv,
        overrideValue,
        command: overrideResolution.command,
        path: overrideResolution.path,
        available: true,
        detail: `Uses ${config.overrideEnv} (${overrideResolution.path})`
      };
    }

    return {
      provider,
      executable: config.executable,
      overrideEnv: config.overrideEnv,
      overrideValue,
      command: null,
      path: null,
      available: false,
      detail: `${config.overrideEnv} is set but not executable: ${overrideValue}`
    };
  }

  const discoveredPath = commandPath(config.executable);
  if (!discoveredPath) {
    return {
      provider,
      executable: config.executable,
      overrideEnv: config.overrideEnv,
      overrideValue: null,
      command: null,
      path: null,
      available: false,
      detail: `${config.executable} was not found on PATH`
    };
  }

  return {
    provider,
    executable: config.executable,
    overrideEnv: config.overrideEnv,
    overrideValue: null,
    command: discoveredPath,
    path: discoveredPath,
    available: true,
    detail: `Uses ${discoveredPath}`
  };
}

export function isCliExecutionEnabled(value = process.env.WRITER_ALLOW_CLI): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return TRUTHY_CLI_VALUES.has(normalized);
}

export function cliEnablementDiagnostic(value = process.env.WRITER_ALLOW_CLI): string {
  if (!value || !value.trim()) {
    return "Local CLI execution enabled by default. Set WRITER_ALLOW_CLI=0 to lock it.";
  }

  if (isCliExecutionEnabled(value)) {
    return `Local CLI execution enabled via WRITER_ALLOW_CLI=${value.trim()}`;
  }

  if (FALSY_CLI_VALUES.has(value.trim().toLowerCase())) {
    return `Local CLI execution disabled via WRITER_ALLOW_CLI=${value.trim()}`;
  }

  return `WRITER_ALLOW_CLI=${value.trim()} does not enable local CLI execution. Use 1, true, yes, or on to enable; 0, false, no, or off to lock.`;
}

export function resolveCliTimeoutConfig(value = process.env.WRITER_CLI_TIMEOUT_MS): CliTimeoutConfig {
  const rawValue = value?.trim() || null;
  const base = {
    env: CLI_TIMEOUT_ENV,
    value: rawValue,
    defaultMs: DEFAULT_CLI_TIMEOUT_MS,
    minMs: MIN_CLI_TIMEOUT_MS,
    maxMs: null,
    clamped: false
  } as const;
  if (!rawValue) {
    return {
      ...base,
      timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
      valid: true,
      detail: "No CLI timeout (default): requests run until they finish or you stop them."
    };
  }

  if (DISABLED_CLI_TIMEOUT_VALUES.has(rawValue.toLowerCase())) {
    return {
      ...base,
      timeoutMs: 0,
      valid: true,
      detail: `CLI timeout disabled via ${CLI_TIMEOUT_ENV}=${rawValue}`
    };
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return {
      ...base,
      timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
      valid: false,
      detail: `${CLI_TIMEOUT_ENV}=${rawValue} is not a valid millisecond timeout; using ${formatCliTimeout(DEFAULT_CLI_TIMEOUT_MS)}.`
    };
  }

  const rounded = Math.round(parsed);
  if (rounded <= 0) {
    return {
      ...base,
      timeoutMs: 0,
      valid: true,
      detail: `CLI timeout disabled via ${CLI_TIMEOUT_ENV}=${rawValue}`
    };
  }
  const timeoutMs = Math.max(MIN_CLI_TIMEOUT_MS, rounded);
  const clamped = timeoutMs !== rounded;
  return {
    ...base,
    timeoutMs,
    valid: true,
    clamped,
    detail: clamped
      ? `${CLI_TIMEOUT_ENV}=${rawValue} is below the ${MIN_CLI_TIMEOUT_MS} ms minimum; using ${formatCliTimeout(timeoutMs)}.`
      : `CLI timeout ${formatCliTimeout(timeoutMs)} via ${CLI_TIMEOUT_ENV}`
  };
}

/** Effective provider timeout in milliseconds; 0 means no timeout. */
export function cliTimeoutMs(value = process.env.WRITER_CLI_TIMEOUT_MS): number {
  return resolveCliTimeoutConfig(value).timeoutMs;
}

export function formatCliTimeout(timeoutMs: number): string {
  if (timeoutMs <= 0) {
    return "no timeout";
  }
  const seconds = timeoutMs / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function resolveOverride(value: string): { command: string | null; path: string | null } {
  if (value.includes("/")) {
    const resolvedPath = isAbsolute(value) ? value : resolve(process.cwd(), value);
    if (isExecutable(resolvedPath)) {
      return { command: resolvedPath, path: resolvedPath };
    }
    return { command: null, path: null };
  }

  const discoveredPath = commandPath(value);
  if (!discoveredPath) {
    return { command: null, path: null };
  }
  return { command: discoveredPath, path: discoveredPath };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandPath(command: string): string | null {
  // The sidecar's own PATH wins (the launchd wrapper and a terminal both set
  // it deliberately); a login shell is only a fallback for sparse
  // environments. A login shell re-sources the user's profile and can reorder
  // PATH — it once picked a stale Homebrew `claude` over the current
  // ~/.local/bin one, so every Claude request failed with "does not support
  // this model".
  for (const flags of ["-c", "-lc"]) {
    try {
      const found = execFileSync("sh", [flags, `command -v ${shellQuote(command)}`], { encoding: "utf8" }).trim();
      if (found) {
        return found;
      }
    } catch {
      // Try the next lookup.
    }
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
