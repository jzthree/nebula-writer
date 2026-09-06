// @vitest-environment node
/**
 * Share-token capability auth: in sharing mode, non-local clients must present
 * the crypto-random token on API requests and websocket upgrades; the owner's
 * loopback browser stays trusted without one.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createWriterApp } from "../server/app";
import { attachWriterRealtime } from "../server/realtime";

const TEST_TOKEN = "test-share-token-1234567890";

describe("share-token auth", () => {
  const cleanups: Array<() => void> = [];
  const savedEnv = { host: process.env.WRITER_HOST, token: process.env.WRITER_SHARE_TOKEN };

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    process.env.WRITER_HOST = savedEnv.host;
    process.env.WRITER_SHARE_TOKEN = savedEnv.token;
    if (savedEnv.host === undefined) {
      delete process.env.WRITER_HOST;
    }
    if (savedEnv.token === undefined) {
      delete process.env.WRITER_SHARE_TOKEN;
    }
  });

  async function startSharedServer(): Promise<number> {
    process.env.WRITER_HOST = "0.0.0.0";
    process.env.WRITER_SHARE_TOKEN = TEST_TOKEN;
    const server: Server = createServer(createWriterApp());
    attachWriterRealtime(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("no port");
    }
    return address.port;
  }

  it("trusts loopback requests without a token", async () => {
    const port = await startSharedServer();
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(response.status).toBe(200);
  });

  it("rejects forwarded network clients without the token and accepts them with it", async () => {
    const port = await startSharedServer();

    const anonymous = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { "X-Forwarded-For": "192.168.1.50" }
    });
    expect(anonymous.status).toBe(401);
    const body = await anonymous.json() as { error: string };
    expect(body.error).toContain("share link");

    const withToken = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { "X-Forwarded-For": "192.168.1.50", "X-Writer-Share-Token": TEST_TOKEN }
    });
    expect(withToken.status).toBe(200);

    const wrongToken = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { "X-Forwarded-For": "192.168.1.50", "X-Writer-Share-Token": "wrong" }
    });
    expect(wrongToken.status).toBe(401);
  });

  it("guards websocket upgrades the same way", async () => {
    const port = await startSharedServer();

    const rejected = new WebSocket(`ws://127.0.0.1:${port}/events`, {
      headers: { "X-Forwarded-For": "192.168.1.50" }
    });
    await new Promise<void>((resolve) => {
      rejected.on("error", () => resolve());
      rejected.on("open", () => {
        throw new Error("Unauthorized websocket should not open");
      });
    });

    const accepted = new WebSocket(`ws://127.0.0.1:${port}/events?token=${TEST_TOKEN}`, {
      headers: { "X-Forwarded-For": "192.168.1.50" }
    });
    await new Promise<void>((resolve, reject) => {
      accepted.on("open", () => resolve());
      accepted.on("error", reject);
    });
    accepted.close();
  });

  it("keeps everything open when sharing mode is off", async () => {
    delete process.env.WRITER_SHARE_TOKEN;
    process.env.WRITER_HOST = "127.0.0.1";
    const server: Server = createServer(createWriterApp());
    attachWriterRealtime(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { "X-Forwarded-For": "192.168.1.50" }
    });
    expect(response.status).toBe(200);
  });
});
