import { describe, expect, it } from "vitest";
import { scrubTerminalQueries } from "../server/terminal-pty";

describe("scrubTerminalQueries (replayed scrollback must never re-ask)", () => {
  it("removes color, DA, and cursor-position queries but keeps normal output", () => {
    const backlog = [
      "\x1b[1mWelcome to Codex\x1b[0m\r\n",
      "\x1b]10;?\x07",            // fg color query
      "\x1b]11;?\x1b\\",          // bg color query (ST-terminated)
      "\x1b]4;5;?\x07",           // palette query
      "\x1b[c", "\x1b[>0c",       // device attributes
      "\x1b[6n", "\x1b[?6n", "\x1b[5n", // cursor position / status
      "\x1bP+q544e\x1b\\",        // XTGETTCAP
      "\x1b[?u",                  // kitty keyboard query
      "\x1b[?2026$p",             // DECRQM
      "model: gpt-5.6-sol\r\n"
    ].join("");
    const scrubbed = scrubTerminalQueries(backlog);
    expect(scrubbed).toContain("Welcome to Codex");
    expect(scrubbed).toContain("model: gpt-5.6-sol");
    expect(scrubbed).not.toContain(";?");
    expect(scrubbed).not.toContain("\x1b[6n");
    expect(scrubbed).not.toContain("\x1b[c");
    expect(scrubbed).not.toContain("\x1bP+q");
  });

  it("keeps color SETTERS and ordinary CSI styling intact", () => {
    const backlog = "\x1b]11;rgb:fdfd/fdfd/fdfd\x07\x1b[38;5;208mtext\x1b[0m\x1b[2J\x1b[H";
    expect(scrubTerminalQueries(backlog)).toBe(backlog);
  });
});
