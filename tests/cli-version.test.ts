// @vitest-environment node
import { chmodSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCliVersionCache, cliVersion, knownCliVersion, versionFromOutput } from "../server/cli-version";

describe("CLI versions without blocking the server", () => {
  let dir: string;
  let cli: string;
  beforeEach(() => {
    clearCliVersionCache();
    dir = mkdtempSync(join(tmpdir(), "writer-version-"));
    cli = join(dir, "fake-cli");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const install = (version: string, delayMs = 0) => {
    writeFileSync(cli, `#!/bin/sh\nsleep ${delayMs / 1000}\necho "${version}"\n`);
    chmodSync(cli, 0o755);
  };

  it("picks the version line from a CLI's answer", () => {
    expect(versionFromOutput("codex-cli 0.166.0\n", "", true)).toBe("codex-cli 0.166.0");
    expect(versionFromOutput("usage: thing\n", "thing 1.2.3\n", false)).toBe("thing 1.2.3");
    expect(versionFromOutput("", "", true)).toBeNull();
  });

  it("answers at once while a slow CLI is read in the background, then remembers it", async () => {
    install("slow-cli 1.0.0", 600);
    const started = Date.now();
    expect(knownCliVersion(cli)).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
    await expect(cliVersion(cli)).resolves.toBe("slow-cli 1.0.0");
    expect(knownCliVersion(cli)).toBe("slow-cli 1.0.0");
  });

  it("reads again when the binary is updated, showing the previous version meanwhile", async () => {
    install("tool 1.0.0");
    await cliVersion(cli);
    install("tool 1.1.0 (updated)", 300);
    utimesSync(cli, new Date(), new Date(Date.now() + 5_000));
    expect(knownCliVersion(cli)).toBe("tool 1.0.0");
    await expect(cliVersion(cli)).resolves.toBe("tool 1.1.0 (updated)");
  });

  it("gives null for a CLI that is gone", async () => {
    await expect(cliVersion(join(dir, "missing"))).resolves.toBeNull();
  });
});
