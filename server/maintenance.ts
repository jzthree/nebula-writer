import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Recovery snapshots (writer-autorestore-*.json) live in their own
// subdirectory so they are not mixed with ad-hoc review exports in tmp/.
export function writerTmpDirectory(): string {
  return join(process.cwd(), "tmp");
}

export function writerRecoveryDirectory(): string {
  return join(writerTmpDirectory(), "recovery");
}

// Chat attachments the sidecar saved for AI requests; pruned with the rest
// of tmp/ so reference files don't accumulate forever.
export function writerAttachmentsDirectory(): string {
  return join(writerTmpDirectory(), "attachments");
}

export interface WriterTmpPruneConfig {
  maxAgeDays: number;
  maxSnapshots: number;
  maxTotalMb: number;
}

export interface WriterTmpPruneResult {
  deletedFiles: number;
  freedBytes: number;
}

// Defaults: keep two weeks of artifacts, at most 20 recovery snapshots, and
// cap the whole tmp/ tree at 2 GB. All overridable via environment variables.
export function resolveWriterTmpPruneConfig(env: NodeJS.ProcessEnv = process.env): WriterTmpPruneConfig {
  return {
    maxAgeDays: positiveNumber(env.WRITER_RECOVERY_MAX_AGE_DAYS, 14),
    maxSnapshots: positiveNumber(env.WRITER_RECOVERY_MAX_SNAPSHOTS, 20),
    maxTotalMb: positiveNumber(env.WRITER_RECOVERY_MAX_TOTAL_MB, 2048)
  };
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Writer confines the CLIs' transcripts to ~/.nebula-writer/{claude,codex}
// (see cli-home.ts). Those grow one transcript per AI request, so age them
// out too — a resumable chat session only needs to survive same-day
// follow-ups, so two weeks is generous. Auth files (symlinks) are never
// touched.
export function writerCliTrajectoryRoots(home: string = homedir()): string[] {
  const base = join(home, ".nebula-writer");
  return [join(base, "claude", "projects"), join(base, "codex", "sessions")];
}

export async function pruneWriterCliTrajectories(
  maxAgeDays = positiveNumber(process.env.WRITER_CLI_TRAJECTORY_MAX_AGE_DAYS, 14),
  roots: string[] = writerCliTrajectoryRoots()
): Promise<WriterTmpPruneResult> {
  const result: WriterTmpPruneResult = { deletedFiles: 0, freedBytes: 0 };
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const root of roots) {
    await pruneAgedFilesRecursively(root, cutoff, result);
  }
  return result;
}

async function pruneAgedFilesRecursively(dir: string, cutoff: number, result: WriterTmpPruneResult): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, String(entry.name));
    if (entry.isDirectory()) {
      await pruneAgedFilesRecursively(path, cutoff, result);
      continue;
    }
    // Skip symlinks (bridged auth files) entirely — never follow or delete.
    if (entry.isSymbolicLink() || !entry.isFile()) {
      continue;
    }
    try {
      const info = await stat(path);
      if (info.mtimeMs < cutoff) {
        await rm(path, { force: true });
        result.deletedFiles += 1;
        result.freedBytes += info.size;
      }
    } catch {
      // File vanished or is locked; leave it for the next sweep.
    }
  }
}

interface TmpFileEntry {
  path: string;
  mtimeMs: number;
  size: number;
  isRecoverySnapshot: boolean;
}

export async function pruneWriterTmpArtifacts(
  config: WriterTmpPruneConfig = resolveWriterTmpPruneConfig(),
  roots: string[] = [writerTmpDirectory(), writerRecoveryDirectory(), writerAttachmentsDirectory()]
): Promise<WriterTmpPruneResult> {
  const entries = await collectTmpFiles(roots);
  const result: WriterTmpPruneResult = { deletedFiles: 0, freedBytes: 0 };
  const deleted = new Set<string>();
  const remove = async (entry: TmpFileEntry) => {
    if (deleted.has(entry.path)) {
      return;
    }
    try {
      await rm(entry.path, { force: true });
      deleted.add(entry.path);
      result.deletedFiles += 1;
      result.freedBytes += entry.size;
    } catch {
      // Best effort; a locked file just stays for the next prune.
    }
  };

  // 1. Age limit for everything under tmp/.
  const cutoff = Date.now() - config.maxAgeDays * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (entry.mtimeMs < cutoff) {
      await remove(entry);
    }
  }

  // 2. Snapshot count limit (newest first survive).
  const snapshots = entries
    .filter((entry) => entry.isRecoverySnapshot && !deleted.has(entry.path))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const entry of snapshots.slice(config.maxSnapshots)) {
    await remove(entry);
  }

  // 3. Total size cap: delete oldest files until under the limit.
  const maxTotalBytes = config.maxTotalMb * 1024 * 1024;
  const survivors = entries
    .filter((entry) => !deleted.has(entry.path))
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  let totalBytes = survivors.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of survivors) {
    if (totalBytes <= maxTotalBytes) {
      break;
    }
    await remove(entry);
    totalBytes -= entry.size;
  }

  return result;
}

async function collectTmpFiles(roots: string[]): Promise<TmpFileEntry[]> {
  const entries: TmpFileEntry[] = [];
  for (const root of roots) {
    let filenames: string[];
    try {
      filenames = await readdir(root);
    } catch {
      continue;
    }
    for (const filename of filenames) {
      const path = join(root, filename);
      try {
        const info = await stat(path);
        if (!info.isFile()) {
          continue;
        }
        entries.push({
          path,
          mtimeMs: info.mtimeMs,
          size: info.size,
          isRecoverySnapshot: /^writer-autorestore-.*\.json$/i.test(filename)
        });
      } catch {
        // File vanished between readdir and stat; ignore.
      }
    }
  }
  return entries;
}
