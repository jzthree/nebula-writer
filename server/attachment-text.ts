import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { AiAttachment } from "../src/shared";
import { writerAttachmentsDirectory } from "./maintenance";

/** Where an attachment's full extracted text is kept: next to the file, never cut. */
export function attachmentTextPathFor(path: string): string {
  return `${path}.txt`;
}

/** The attachment's full-text file, when it is one Writer wrote (clients send paths back; only Writer's own are trusted). */
export function trustedAttachmentTextPath(textPath: unknown): string | null {
  if (typeof textPath !== "string" || !textPath.endsWith(".txt")) {
    return null;
  }
  const dir = resolve(writerAttachmentsDirectory());
  const resolved = resolve(textPath);
  return resolved.startsWith(dir + sep) ? resolved : null;
}

/** The whole extracted text: from the full-text file when there is one, else what the request carried. */
export function attachmentFullText(attachment: AiAttachment): string {
  const textPath = trustedAttachmentTextPath(attachment.textPath);
  if (textPath) {
    try {
      return readFileSync(textPath, "utf8");
    } catch {
      // Pruned or moved: fall back to the preview.
    }
  }
  return attachment.text;
}
