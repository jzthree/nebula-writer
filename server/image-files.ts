import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { AI_IMAGE_BYTES_LIMIT, AI_IMAGE_MIME_TYPES } from "../src/shared";
import { writerAttachmentsDirectory } from "./maintenance";

/**
 * Where document images and AI-produced replacements live: a subfolder of the
 * attachments directory (pruned with the rest of tmp/), served back to the
 * clients by name only — never by arbitrary path.
 */
export function writerImagesDirectory(): string {
  return join(writerAttachmentsDirectory(), "images");
}

export const IMAGE_ROUTE_PREFIX = "/api/ai/images/";

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp"
};
const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp"
};

/** Content type from the file's magic bytes, or null when it is not a supported raster image. */
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("latin1").startsWith("GIF8")) {
    return "image/gif";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}

export function imageMimeForName(name: string): string | null {
  return MIME_BY_EXTENSION[extname(name).slice(1).toLowerCase()] ?? null;
}

export interface StoredImage {
  name: string;
  path: string;
  url: string;
  mime: string;
  bytes: number;
}

/** Write image bytes into the images directory under a fresh name; returns null for unsupported or oversized data. */
export function storeImageBytes(bytes: Buffer, label = "image"): StoredImage | { error: string } {
  const mime = sniffImageMime(bytes);
  if (!mime || !AI_IMAGE_MIME_TYPES.includes(mime)) {
    return { error: "Only PNG, JPEG, GIF, and WebP images are supported." };
  }
  if (bytes.length > AI_IMAGE_BYTES_LIMIT) {
    return { error: `Images are limited to ${Math.round(AI_IMAGE_BYTES_LIMIT / (1024 * 1024))} MB.` };
  }
  const dir = writerImagesDirectory();
  mkdirSync(dir, { recursive: true });
  const safeLabel = basename(label).replace(/\.[A-Za-z0-9]+$/, "").replace(/[^\w-]+/g, "_").slice(0, 60) || "image";
  const name = `${randomUUID().slice(0, 8)}-${safeLabel}.${EXTENSION_BY_MIME[mime]}`;
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { name, path, url: `${IMAGE_ROUTE_PREFIX}${name}`, mime, bytes: bytes.length };
}

/** Copy an image file the agent produced into the images directory so it can be served and survives the agent's workspace. */
export function importImageFile(sourcePath: string, label = "replacement"): StoredImage | { error: string } {
  const absolute = resolve(sourcePath);
  if (!existsSync(absolute)) {
    return { error: `No file at ${sourcePath}.` };
  }
  const size = statSync(absolute).size;
  if (size > AI_IMAGE_BYTES_LIMIT) {
    return { error: `Images are limited to ${Math.round(AI_IMAGE_BYTES_LIMIT / (1024 * 1024))} MB; ${sourcePath} is ${Math.round(size / (1024 * 1024))} MB.` };
  }
  const bytes = readFileSync(absolute);
  const stored = storeImageBytes(bytes, label);
  if ("error" in stored) {
    return stored;
  }
  // storeImageBytes wrote a copy; keep the original's name in the label only.
  return stored;
}

/** Resolve a served image name to its file, refusing anything outside the images directory. */
export function servedImagePath(name: string): { path: string; mime: string } | null {
  const safe = basename(name);
  if (safe !== name || !safe) {
    return null;
  }
  const mime = imageMimeForName(safe);
  if (!mime) {
    return null;
  }
  const path = join(writerImagesDirectory(), safe);
  return existsSync(path) ? { path, mime } : null;
}

/** True when the path is one of our stored images (clients may only reference those). */
export function isStoredImagePath(path: string): boolean {
  const dir = resolve(writerImagesDirectory());
  const absolute = resolve(path);
  return absolute.startsWith(`${dir}/`) && existsSync(absolute);
}

export function copyImageInto(sourcePath: string, label: string): StoredImage | { error: string } {
  return importImageFile(sourcePath, label);
}

export { copyFileSync as _copyFileSync };
