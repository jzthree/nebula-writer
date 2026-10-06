#!/usr/bin/env node
// Remove Writer's Codex threads from the user's Codex history (the Codex app's
// chat list), keeping them in Writer's own Codex home.
//
//   npm run codex:forget-writer-threads
//
// Writer now records its Codex threads in ~/.nebula-writer/codex-full, so this
// only matters for threads made before that (Writer's app-server runs from
// 2026-10-05 on were listed by the app). For each thread whose working
// directory is Writer's CLI workspace and whose originator is Writer, the
// transcript is copied into Writer's Codex home first, then the thread is
// deleted from ~/.codex through Codex's own thread/delete. A thread the Codex
// app has open ("already has an active writer") is skipped: quit the app (or
// close that chat) and run this again.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

const userHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
const writerHome = process.env.WRITER_CODEX_FULL_HOME?.trim() || join(homedir(), ".nebula-writer", "codex-full");
const workspace = join(homedir(), ".nebula-writer", "cli-workspace");
const WRITER_ORIGINATORS = new Set(["nebula-writer"]);

const codex = process.env.WRITER_CODEX_PATH?.trim() || "codex";
const child = spawn(codex, ["app-server"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, CODEX_HOME: userHome } });
let nextId = 0;
let buffer = "";
const waiting = new Map();
const request = (method, params) => new Promise((resolve) => {
  const id = (nextId += 1);
  waiting.set(id, resolve);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      const message = JSON.parse(line);
      if (message.id && waiting.has(message.id) && !message.method) {
        waiting.get(message.id)(message);
        waiting.delete(message.id);
      }
    } catch {
      // Not JSON-RPC.
    }
    newline = buffer.indexOf("\n");
  }
});

await request("initialize", { clientInfo: { name: "nebula-writer-cleanup", version: "1" }, capabilities: null });
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);

const threads = [];
for (const archived of [false, true]) {
  let cursor = null;
  do {
    const listed = await request("thread/list", { cwd: workspace, archived, limit: 100, cursor });
    if (listed.error) {
      console.error(`thread/list failed: ${listed.error.message}`);
      break;
    }
    threads.push(...(listed.result?.data ?? []));
    cursor = listed.result?.nextCursor ?? null;
  } while (cursor);
}

let moved = 0;
let held = 0;
for (const thread of threads) {
  if (!WRITER_ORIGINATORS.has(thread.originator)) {
    continue;
  }
  if (thread.path && existsSync(thread.path)) {
    const destination = join(writerHome, relative(userHome, thread.path));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(thread.path, destination);
  }
  const deleted = await request("thread/delete", { threadId: thread.id });
  if (deleted.error) {
    held += 1;
    console.log(`kept ${thread.id}: ${deleted.error.message}`);
  } else {
    moved += 1;
  }
}
console.log(`Moved ${moved} Writer thread${moved === 1 ? "" : "s"} out of ${userHome}${held ? `; ${held} kept because the Codex app has them open — quit it and run this again` : ""}.`);
child.kill();
