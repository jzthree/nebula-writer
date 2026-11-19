/**
 * The installed version of each CLI, read without ever blocking the server.
 * `--version` is quick normally, but the first run of a freshly updated
 * binary can take seconds while macOS scans it, and the CLIs update
 * themselves often. Run synchronously, that stalled every request (the
 * Google Docs panel then gave up on the pane as "not reachable"). Versions
 * are cached per binary (path, size, mtime) and read in the background.
 */

import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";

const VERSION_TIMEOUT_MS = 8_000;

interface Entry { key: string; version: string | null; pending: Promise<string | null> | null }

const cache = new Map<string, Entry>();

function binaryKey(path: string): string {
  try {
    const real = realpathSync(path);
    const stat = statSync(real);
    return `${real}|${stat.size}|${Math.round(stat.mtimeMs)}`;
  } catch {
    return path;
  }
}

/** The version line in a CLI's answer: the first line on success, else the first line with a version number. */
export function versionFromOutput(stdout: string, stderr: string, ok: boolean): string | null {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  return ok ? lines[0] : lines.find((line) => /\d+\.\d+/.test(line)) ?? null;
}

function run(path: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, args, { encoding: "utf8", timeout: VERSION_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error.killed || (error as NodeJS.ErrnoException).code === "ENOENT")) {
        resolve(null);
        return;
      }
      resolve(versionFromOutput(String(stdout ?? ""), String(stderr ?? ""), !error));
    });
  });
}

async function readVersion(path: string): Promise<string | null> {
  for (const args of [["--version"], ["version"], ["-v"]]) {
    const version = await run(path, args);
    if (version) return version;
  }
  return null;
}

/** The CLI's version, reading it when the binary changed since last time. */
export function cliVersion(path: string): Promise<string | null> {
  const key = binaryKey(path);
  const entry = cache.get(path);
  if (entry && entry.key === key) {
    return entry.pending ?? Promise.resolve(entry.version);
  }
  const pending = readVersion(path).then((version) => {
    const current = cache.get(path);
    if (current?.pending === pending) cache.set(path, { key, version, pending: null });
    return version;
  });
  cache.set(path, { key, version: entry?.version ?? null, pending });
  return pending;
}

/** What is known now, without waiting: the last version read (possibly of the previous binary); reading a changed one starts in the background. */
export function knownCliVersion(path: string): string | null {
  void cliVersion(path);
  return cache.get(path)?.version ?? null;
}

export function clearCliVersionCache(): void {
  cache.clear();
}
