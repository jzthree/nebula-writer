import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { listInlineSuggestions, resolveInlineSuggestion } from "../server/inline-suggestions";

// The module under test reads rooms from y-websocket's CJS doc registry, so
// the test must build rooms through the same instance (the ESM yjs build is a
// different copy whose types would not match).
const require = createRequire(import.meta.url);
const Y = require("yjs") as typeof import("yjs");
const { getYDoc, docs } = require("y-websocket/bin/utils") as {
  getYDoc: (name: string) => import("yjs").Doc;
  docs: Map<string, import("yjs").Doc>;
};

let roomCounter = 0;

/** Build a room shaped exactly like y-prosemirror output: paragraph XmlElement
 * wrapping XmlText whose formatted runs carry the suggestion mark attrs. */
function makeRoom(build: (text: import("yjs").XmlText) => void): string {
  roomCounter += 1;
  const name = `inline-test-${roomCounter}`;
  docs.delete(name);
  const doc = getYDoc(name);
  const fragment = doc.getXmlFragment("default");
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  paragraph.insert(0, [text]);
  fragment.insert(0, [paragraph]);
  build(text);
  return name;
}

const insAttrs = (changeId: string) => ({ suggestionInsertion: { changeId, author: "ai-codex", authorName: "Codex", role: "ai", color: "#7b1fa2", createdAt: "2026-07-12T00:00:00Z" } });
const delAttrs = (changeId: string) => ({ suggestionDeletion: { changeId, author: "id-a", authorName: "Alice", role: "human", color: "#f00", createdAt: "2026-07-12T00:00:00Z" } });

function roomText(name: string): string {
  const fragment = docs.get(name)!.getXmlFragment("default");
  let out = "";
  fragment.forEach((node) => {
    (node as import("yjs").XmlElement).forEach((child) => {
      out += (child as import("yjs").XmlText).toString().replace(/<[^>]+>/g, "");
    });
  });
  return out;
}

describe("inline suggestions (server-side, mark-native)", () => {
  it("lists clusters grouped by changeId with author attribution", () => {
    const room = makeRoom((text) => {
      // Plain text first, then format ranges — the shape y-prosemirror
      // produces (inserting after a formatted run would inherit its marks).
      text.insert(0, "Hello worldplanet. Extra tail");
      text.format(6, 5, delAttrs("c1"));
      text.format(11, 6, insAttrs("c1"));
      text.format(24, 5, insAttrs("c2"));
    });
    const clusters = listInlineSuggestions(room);
    expect(clusters).toHaveLength(2);
    const replacement = clusters.find((cluster) => cluster.changeId === "c1")!;
    expect(replacement.kind).toBe("replacement");
    expect(replacement.deletedText).toBe("world");
    expect(replacement.insertedText).toBe("planet");
    const insertion = clusters.find((cluster) => cluster.changeId === "c2")!;
    expect(insertion.kind).toBe("insertion");
    expect(insertion.authorName).toBe("Codex");
  });

  it("accepting a replacement removes struck text and keeps the insertion unmarked", () => {
    const room = makeRoom((text) => {
      text.insert(0, "Hello worldplanet.");
      text.format(6, 5, delAttrs("c1"));
      text.format(11, 6, insAttrs("c1"));
    });
    expect(resolveInlineSuggestion(room, "c1", "accept")).toBe(true);
    expect(roomText(room)).toBe("Hello planet.");
    expect(listInlineSuggestions(room)).toHaveLength(0);
  });

  it("rejecting a replacement restores the original text", () => {
    const room = makeRoom((text) => {
      text.insert(0, "Hello worldplanet.");
      text.format(6, 5, delAttrs("c1"));
      text.format(11, 6, insAttrs("c1"));
    });
    expect(resolveInlineSuggestion(room, "c1", "reject")).toBe(true);
    expect(roomText(room)).toBe("Hello world.");
    expect(listInlineSuggestions(room)).toHaveLength(0);
  });

  it("is idempotent and scoped to the requested changeId", () => {
    const room = makeRoom((text) => {
      text.insert(0, "Base one two");
      text.format(5, 3, insAttrs("c1"));
      text.format(8, 4, insAttrs("c2"));
    });
    expect(resolveInlineSuggestion(room, "c1", "reject")).toBe(true);
    expect(roomText(room)).toBe("Base  two");
    // c2 untouched, still listed
    expect(listInlineSuggestions(room).map((cluster) => cluster.changeId)).toEqual(["c2"]);
    // resolving c1 again is a clean no-op
    expect(resolveInlineSuggestion(room, "c1", "reject")).toBe(false);
    // unknown room
    expect(resolveInlineSuggestion("nope-room", "c1", "accept")).toBe(false);
  });
});
