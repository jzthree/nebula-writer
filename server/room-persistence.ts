import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as YTypes from "yjs";

// Same CJS-instance rule as everywhere yjs touches the room docs.
const require = createRequire(import.meta.url);
const Y = require("yjs") as typeof YTypes;
const { setPersistence } = require("y-websocket/bin/utils") as {
  setPersistence: (p: { bindState: (docName: string, ydoc: YTypes.Doc) => void; writeState: (docName: string, ydoc: YTypes.Doc) => Promise<void>; provider: unknown }) => void;
};

/**
 * Durability for local documents. Dogfooding found the worst property a
 * local-first writing app can have: drafts lived only in the server's memory
 * (in-memory Yjs rooms + in-memory draft sessions), so any restart destroyed
 * unexported work. Every collab room is now mirrored to a file and reloaded
 * when the room is next opened — text, suggestion marks, and the nebula-meta
 * session stamp all ride the same Y.Doc, so after a restart the client
 * reconnects, the room refills from disk, and the session reconstructs from
 * the live text (activateSessionForDoc's existing room-text path).
 *
 * Storage: one merged Yjs update per room at ~/.nebula-writer/rooms/<id>.yup,
 * rewritten (tmp + rename) on a short debounce after each change. Room names
 * are already sanitized to [A-Za-z0-9._-] by roomNameFromPath. Rooms idle for
 * PRUNE_AFTER_DAYS are pruned at startup.
 */

const ROOMS_DIR = process.env.WRITER_ROOM_DIR || join(homedir(), ".nebula-writer", "rooms");
const SAVE_DEBOUNCE_MS = 800;
const PRUNE_AFTER_DAYS = 60;

const saveTimers = new Map<string, NodeJS.Timeout>();

function roomFile(docName: string): string {
  return join(ROOMS_DIR, `${docName}.yup`);
}

function saveRoom(docName: string, ydoc: YTypes.Doc): void {
  try {
    const update = Y.encodeStateAsUpdate(ydoc);
    const target = roomFile(docName);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, Buffer.from(update));
    renameSync(tmp, target);
  } catch {
    // Persistence is best-effort; the live room stays authoritative.
  }
}

function scheduleSave(docName: string, ydoc: YTypes.Doc): void {
  const existing = saveTimers.get(docName);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    saveTimers.delete(docName);
    saveRoom(docName, ydoc);
  }, SAVE_DEBOUNCE_MS);
  timer.unref();
  saveTimers.set(docName, timer);
}

function pruneOldRooms(): void {
  try {
    const cutoff = Date.now() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(ROOMS_DIR)) {
      if (!name.endsWith(".yup") && !name.endsWith(".yup.tmp")) {
        continue;
      }
      const path = join(ROOMS_DIR, name);
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
      }
    }
  } catch {
    // fresh install / nothing to prune
  }
}

export function installRoomPersistence(): void {
  mkdirSync(ROOMS_DIR, { recursive: true });
  pruneOldRooms();
  setPersistence({
    provider: "nebula-file",
    bindState: (docName, ydoc) => {
      // Load synchronously so the first sync a client receives already
      // carries the persisted content (no empty-room seeding race).
      const path = roomFile(docName);
      if (existsSync(path)) {
        try {
          Y.applyUpdate(ydoc, new Uint8Array(readFileSync(path)));
        } catch {
          // Corrupt file: keep the room usable; the next save overwrites it.
        }
      }
      ydoc.on("update", () => scheduleSave(docName, ydoc));
    },
    writeState: async (docName, ydoc) => {
      // Called when the room closes — flush the final state immediately.
      const timer = saveTimers.get(docName);
      if (timer) {
        clearTimeout(timer);
        saveTimers.delete(docName);
      }
      saveRoom(docName, ydoc);
    }
  });
}
