import { mkdtempSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneWriterTmpArtifacts, resolveWriterTmpPruneConfig } from "../server/maintenance";

describe("writer tmp pruning", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const dir = mkdtempSync(join(process.cwd(), ".writer-prune-test-"));
    tempDirs.push(dir);
    return dir;
  }

  function writeAged(dir: string, name: string, ageDays: number, content = "x"): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    const time = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    utimesSync(path, time, time);
    return path;
  }

  it("resolves sane defaults and honors env overrides", () => {
    expect(resolveWriterTmpPruneConfig({})).toEqual({ maxAgeDays: 14, maxSnapshots: 20, maxTotalMb: 2048 });
    expect(resolveWriterTmpPruneConfig({
      WRITER_RECOVERY_MAX_AGE_DAYS: "7",
      WRITER_RECOVERY_MAX_SNAPSHOTS: "5",
      WRITER_RECOVERY_MAX_TOTAL_MB: "100"
    })).toEqual({ maxAgeDays: 7, maxSnapshots: 5, maxTotalMb: 100 });
    expect(resolveWriterTmpPruneConfig({ WRITER_RECOVERY_MAX_AGE_DAYS: "-3" }).maxAgeDays).toBe(14);
  });

  it("deletes files older than the age limit and keeps fresh ones", async () => {
    const root = makeRoot();
    writeAged(root, "old-report.json", 30);
    writeAged(root, "fresh-report.json", 1);

    const result = await pruneWriterTmpArtifacts({ maxAgeDays: 14, maxSnapshots: 20, maxTotalMb: 2048 }, [root]);

    expect(result.deletedFiles).toBe(1);
    expect(readdirSync(root)).toEqual(["fresh-report.json"]);
  });

  it("keeps only the newest N recovery snapshots", async () => {
    const root = makeRoot();
    const recovery = join(root, "recovery");
    mkdirSync(recovery);
    writeAged(recovery, "writer-autorestore-a.json", 5);
    writeAged(recovery, "writer-autorestore-b.json", 3);
    writeAged(recovery, "writer-autorestore-c.json", 1);
    writeAged(recovery, "unrelated-export.docx", 5);

    await pruneWriterTmpArtifacts({ maxAgeDays: 365, maxSnapshots: 2, maxTotalMb: 2048 }, [root, recovery]);

    const remaining = readdirSync(recovery).sort();
    expect(remaining).toEqual(["unrelated-export.docx", "writer-autorestore-b.json", "writer-autorestore-c.json"]);
  });

  it("deletes oldest files first to enforce the size cap", async () => {
    const root = makeRoot();
    writeAged(root, "oldest.bin", 10, "a".repeat(1024 * 1024));
    writeAged(root, "middle.bin", 5, "b".repeat(1024 * 1024));
    writeAged(root, "newest.bin", 1, "c".repeat(1024 * 1024));

    await pruneWriterTmpArtifacts({ maxAgeDays: 365, maxSnapshots: 20, maxTotalMb: 2 }, [root]);

    const remaining = readdirSync(root).sort();
    expect(remaining).toEqual(["middle.bin", "newest.bin"]);
  });
});
