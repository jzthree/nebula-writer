import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the module at a temp dir BEFORE importing it.
const ROOMS = mkdtempSync(join(tmpdir(), "writer-rooms-"));
process.env.WRITER_ROOM_DIR = ROOMS;

const require = createRequire(import.meta.url);
const { docs, getYDoc } = require("y-websocket/bin/utils") as {
  docs: Map<string, import("yjs").Doc>;
  getYDoc: (name: string) => import("yjs").Doc;
};

function roomText(doc: import("yjs").Doc): string {
  let out = "";
  doc.getXmlFragment("default").forEach((node) => {
    (node as import("yjs").XmlElement).forEach((child) => {
      out += (child as import("yjs").XmlText).toString().replace(/<[^>]+>/g, "");
    });
  });
  return out;
}

describe("room persistence (drafts survive restarts)", () => {
  beforeAll(async () => {
    // Dynamic import: a static import would hoist above the WRITER_ROOM_DIR
    // assignment and the module would capture the real rooms directory.
    const { installRoomPersistence } = await import("../server/room-persistence");
    installRoomPersistence();
  });

  it("persists a room to disk and reloads it after a simulated restart", async () => {
    const name = "persist-test-doc";
    const doc = getYDoc(name);
    // Shape a paragraph the way y-prosemirror does, and stamp the meta the
    // session-reconstruction path checks.
    const Y = require("yjs") as typeof import("yjs");
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    doc.getXmlFragment("default").insert(0, [paragraph]);
    text.insert(0, "The draft that must survive.");
    doc.getMap("nebula-meta").set("sessionId", name);

    // Wait past the save debounce.
    await new Promise((resolve) => setTimeout(resolve, 1400));
    expect(existsSync(join(ROOMS, `${name}.yup`))).toBe(true);

    // "Restart": drop the in-memory room, then reopen it.
    docs.delete(name);
    const reloaded = getYDoc(name);
    expect(roomText(reloaded)).toBe("The draft that must survive.");
    expect(reloaded.getMap("nebula-meta").get("sessionId")).toBe(name);
  });

  it("keeps accumulating edits across reloads", async () => {
    const name = "persist-accumulate";
    const doc = getYDoc(name);
    const Y = require("yjs") as typeof import("yjs");
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    p.insert(0, [t]);
    doc.getXmlFragment("default").insert(0, [p]);
    t.insert(0, "one");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    docs.delete(name);

    const again = getYDoc(name);
    const frag = again.getXmlFragment("default");
    const textNode = (frag.get(0) as import("yjs").XmlElement).get(0) as import("yjs").XmlText;
    textNode.insert(3, " two");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    docs.delete(name);

    expect(roomText(getYDoc(name))).toBe("one two");
    expect(readdirSync(ROOMS).some((f) => f === `${name}.yup`)).toBe(true);
  });
});
