#!/usr/bin/env node
// Generates the ribbon/task-pane icons for the Word add-in (public/word/icon-*.png)
// without any image dependency: a rounded blue tile with a white "N" mark,
// rendered with simple anti-aliased distance fields and encoded as PNG.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "word");
mkdirSync(outDir, { recursive: true });

const SIZES = [16, 32, 64, 80, 128];

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function roundedRectDistance(x, y, half, radius) {
  const dx = Math.abs(x) - (half - radius);
  const dy = Math.abs(y) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

function coverage(distance, edge = 0.7) {
  return Math.max(0, Math.min(1, 0.5 - distance / edge));
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const radius = size * 0.22;
  const stroke = size * 0.11;
  const top = -size * 0.24;
  const bottom = size * 0.24;
  const left = -size * 0.2;
  const right = size * 0.2;
  const samples = 3;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let tile = 0;
      let glyph = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples - half;
          const py = y + (sy + 0.5) / samples - half;
          tile += coverage(roundedRectDistance(px, py, half - 0.5, radius));
          const d = Math.min(
            segmentDistance(px, py, left, bottom, left, top),
            segmentDistance(px, py, left, top, right, bottom),
            segmentDistance(px, py, right, bottom, right, top)
          ) - stroke / 2;
          glyph += coverage(d);
        }
      }
      tile /= samples * samples;
      glyph /= samples * samples;
      // Gradient tile: blue (top-left) → violet (bottom-right).
      const t = (x + y) / (2 * size);
      const r = Math.round(26 + (91 - 26) * t);
      const g = Math.round(115 + (33 - 115) * t);
      const b = Math.round(232 + (182 - 232) * t);
      const offset = (y * size + x) * 4;
      const alpha = tile;
      const glyphMix = Math.min(1, glyph) * alpha;
      pixels[offset] = Math.round(r * (1 - glyphMix) + 255 * glyphMix);
      pixels[offset + 1] = Math.round(g * (1 - glyphMix) + 255 * glyphMix);
      pixels[offset + 2] = Math.round(b * (1 - glyphMix) + 255 * glyphMix);
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, pixels);
}

for (const size of SIZES) {
  const file = resolve(outDir, `icon-${size}.png`);
  writeFileSync(file, render(size));
  console.log(`wrote ${file}`);
}
