import { createRequire } from "node:module";
import type * as YTypes from "yjs";

// Same CJS-instance rule as collab-bridge: the room docs are created inside
// y-websocket's CJS helper, so resolve yjs the same way or nothing lines up.
const require = createRequire(import.meta.url);
const { docs } = require("y-websocket/bin/utils") as { docs: Map<string, YTypes.Doc> };

/**
 * Mark-native agent access to inline suggestions (docs/suggesting-mode.md,
 * "MCP / agents read the suggestion list from the live document marks and
 * apply accept/reject as document edits"). The server holds every open
 * document's Yjs room; y-prosemirror stores suggestion marks as Y.XmlText
 * formatting attributes keyed by the mark name, so agents can list and
 * resolve suggestions here — no browser involved — and every connected
 * client sees the resolution instantly through normal Yjs sync.
 */

export interface InlineSuggestionSegment {
  kind: "insertion" | "deletion";
  text: string;
  changeId: string;
  authorName: string | null;
  role: string | null;
  createdAt: string | null;
}

export interface InlineSuggestionCluster {
  changeId: string;
  kind: "insertion" | "deletion" | "replacement";
  /** Text that would be REMOVED if accepted (deletion side). */
  deletedText: string;
  /** Text that would REMAIN if accepted (insertion side). */
  insertedText: string;
  authorName: string | null;
  role: string | null;
  createdAt: string | null;
}

interface DeltaOp {
  insert?: unknown;
  attributes?: Record<string, unknown>;
}

function roomDoc(docId: string): YTypes.Doc | null {
  return docs.get(docId) ?? null;
}

function collectXmlTexts(node: unknown, out: unknown[]): void {
  const candidate = node as { toDelta?: () => DeltaOp[]; forEach?: (cb: (child: unknown) => void) => void } | null;
  if (typeof candidate?.toDelta === "function") {
    out.push(candidate);
    return;
  }
  if (typeof candidate?.forEach === "function") {
    candidate.forEach((child) => collectXmlTexts(child, out));
  }
}

/**
 * y-prosemirror disambiguates NON-EXCLUSIVE marks (ours set excludes: "") by
 * suffixing the attribute key with a hash: "suggestionInsertion--E1i1EsH1".
 * Match by prefix and keep the actual key for format() calls.
 */
function markEntries(attributes: Record<string, unknown>): Array<{ kind: "insertion" | "deletion"; key: string; value: unknown }> {
  const entries: Array<{ kind: "insertion" | "deletion"; key: string; value: unknown }> = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "suggestionInsertion" || key.startsWith("suggestionInsertion--")) {
      entries.push({ kind: "insertion", key, value });
    } else if (key === "suggestionDeletion" || key.startsWith("suggestionDeletion--")) {
      entries.push({ kind: "deletion", key, value });
    }
  }
  return entries;
}

function segmentAttrs(value: unknown): { changeId: string; authorName: string | null; role: string | null; createdAt: string | null } | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const attrs = value as Record<string, unknown>;
  const changeId = typeof attrs.changeId === "string" ? attrs.changeId : null;
  if (!changeId) {
    return null;
  }
  return {
    changeId,
    authorName: typeof attrs.authorName === "string" ? attrs.authorName : null,
    role: typeof attrs.role === "string" ? attrs.role : null,
    createdAt: typeof attrs.createdAt === "string" ? attrs.createdAt : null
  };
}

function suggestionSegments(docId: string): InlineSuggestionSegment[] {
  const doc = roomDoc(docId);
  if (!doc) {
    return [];
  }
  const fragment = doc.getXmlFragment("default");
  const texts: unknown[] = [];
  fragment.forEach((node) => collectXmlTexts(node, texts));
  const segments: InlineSuggestionSegment[] = [];
  for (const text of texts) {
    const delta = (text as { toDelta: () => DeltaOp[] }).toDelta();
    for (const op of delta) {
      if (typeof op.insert !== "string" || !op.attributes) {
        continue;
      }
      for (const entry of markEntries(op.attributes)) {
        const attrs = segmentAttrs(entry.value);
        if (attrs) {
          segments.push({ kind: entry.kind, text: op.insert, ...attrs });
        }
      }
    }
  }
  return segments;
}

/** Diagnostics for the list endpoint: whether the room exists and what the
 * server can see in it (helps callers distinguish "no marks" from "no room"). */
export function inlineSuggestionDiagnostics(docId: string): { roomFound: boolean; textNodes: number; sampleAttributeKeys: string[] } {
  const doc = roomDoc(docId);
  if (!doc) {
    return { roomFound: false, textNodes: 0, sampleAttributeKeys: [] };
  }
  const fragment = doc.getXmlFragment("default");
  const texts: unknown[] = [];
  fragment.forEach((node) => collectXmlTexts(node, texts));
  const keys = new Set<string>();
  for (const text of texts) {
    for (const op of (text as { toDelta: () => DeltaOp[] }).toDelta()) {
      Object.keys(op.attributes ?? {}).forEach((key) => keys.add(key));
    }
  }
  return { roomFound: true, textNodes: texts.length, sampleAttributeKeys: [...keys] };
}

/** All pending inline suggestions in a document's live room, grouped by changeId. */
export function listInlineSuggestions(docId: string): InlineSuggestionCluster[] {
  const clusters = new Map<string, InlineSuggestionCluster>();
  for (const segment of suggestionSegments(docId)) {
    const existing = clusters.get(segment.changeId);
    if (!existing) {
      clusters.set(segment.changeId, {
        changeId: segment.changeId,
        kind: segment.kind,
        deletedText: segment.kind === "deletion" ? segment.text : "",
        insertedText: segment.kind === "insertion" ? segment.text : "",
        authorName: segment.authorName,
        role: segment.role,
        createdAt: segment.createdAt
      });
      continue;
    }
    if (segment.kind === "deletion") {
      existing.deletedText += segment.text;
    } else {
      existing.insertedText += segment.text;
    }
    if (existing.deletedText && existing.insertedText) {
      existing.kind = "replacement";
    }
  }
  return [...clusters.values()];
}

/**
 * Resolve one inline suggestion by changeId, straight in the Yjs room doc:
 * accept keeps insertions (dropping the mark) and removes struck deletions;
 * reject removes insertions and unstrikes deletions. One Yjs transaction, so
 * remote ProseMirror clients apply it atomically. Returns false when the
 * changeId has no marks left (already resolved elsewhere) — idempotent.
 */
export function resolveInlineSuggestion(docId: string, changeId: string, decision: "accept" | "reject"): boolean {
  const doc = roomDoc(docId);
  if (!doc) {
    return false;
  }
  const fragment = doc.getXmlFragment("default");
  const texts: unknown[] = [];
  fragment.forEach((node) => collectXmlTexts(node, texts));

  interface PendingOp { text: { delete: (index: number, length: number) => void; format: (index: number, length: number, attributes: Record<string, unknown>) => void }; index: number; length: number; action: "delete" | { clear: string } }
  const operations: PendingOp[] = [];
  for (const text of texts) {
    const target = text as PendingOp["text"] & { toDelta: () => DeltaOp[] };
    let index = 0;
    for (const op of target.toDelta()) {
      const length = typeof op.insert === "string" ? op.insert.length : 1;
      if (typeof op.insert === "string" && op.attributes) {
        for (const entry of markEntries(op.attributes)) {
          const attrs = segmentAttrs(entry.value);
          if (attrs?.changeId !== changeId) {
            continue;
          }
          if (entry.kind === "insertion") {
            operations.push({ text: target, index, length, action: decision === "accept" ? { clear: entry.key } : "delete" });
          } else {
            operations.push({ text: target, index, length, action: decision === "accept" ? "delete" : { clear: entry.key } });
          }
          break;
        }
      }
      index += length;
    }
  }
  if (!operations.length) {
    return false;
  }
  doc.transact(() => {
    // Within each text, apply back-to-front so indexes stay valid.
    for (const operation of operations.sort((left, right) => right.index - left.index)) {
      if (operation.action === "delete") {
        operation.text.delete(operation.index, operation.length);
      } else {
        operation.text.format(operation.index, operation.length, { [operation.action.clear]: null });
      }
    }
  });
  return true;
}
