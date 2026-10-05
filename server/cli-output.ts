/**
 * No cap on how much a CLI may print: agent runs with computer use stream a
 * screenshot per step. Lines are kept for parsing with long base64 payloads
 * (images, data URIs) replaced by a short marker, so memory stays bounded by
 * the text, not the pictures; stderr keeps its last STDERR_TAIL_CHARS.
 */
const ELIDE_PAYLOAD_MIN_CHARS = 8_000;
export const STDERR_TAIL_CHARS = 200_000;
const LONG_PAYLOAD = new RegExp(`"(?:data:[^";,]{1,80};base64,)?[A-Za-z0-9+/=_\\\\-]{${ELIDE_PAYLOAD_MIN_CHARS},}"`, "g");

/** A stdout line with embedded binary payloads elided (text, including long JSON answers, is untouched). */
export function elideLongPayloads(line: string): string {
  if (line.length < ELIDE_PAYLOAD_MIN_CHARS) {
    return line;
  }
  return line.replace(LONG_PAYLOAD, (match) => `"[binary data elided: ${(match.length - 2).toLocaleString()} chars]"`);
}
