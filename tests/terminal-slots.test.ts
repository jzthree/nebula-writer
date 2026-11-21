// @vitest-environment node
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in PTY: records what it was started with, never launches a CLI.
const spawned = vi.hoisted(() => [] as Array<{ env: Record<string, string>; kill: () => void; writes: string[] }>);
vi.mock("node-pty", () => ({
  spawn: (_shell: string, _args: string[], options: { env: Record<string, string> }) => {
    let exit: (() => void) | null = null;
    const pty = {
      env: options.env,
      writes: [] as string[],
      onData: () => undefined,
      onExit: (callback: () => void) => {
        exit = callback;
      },
      write(data: string) {
        pty.writes.push(data);
      },
      resize: () => undefined,
      kill: () => exit?.()
    };
    spawned.push(pty);
    return pty;
  }
}));

const { attachTerminal, restartTerminalRoom, terminalSlot, terminalSlots } = await import("../server/terminal-pty");

class FakeSocket extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

describe("agent terminal slots", () => {
  beforeEach(() => {
    for (const provider of ["claude", "codex"] as const) {
      for (const slot of terminalSlots()[provider]) restartTerminalRoom(provider, slot);
    }
    spawned.length = 0;
  });

  it("runs one agent per tab: separate terminals, listed, and closed one at a time", () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    attachTerminal(first as never, "claude", undefined, 1);
    attachTerminal(second as never, "claude", undefined, 2);
    expect(spawned).toHaveLength(2);
    expect(spawned.map((pty) => pty.env.WRITER_AGENT_SLOT)).toEqual(["1", "2"]);
    expect(terminalSlots()).toEqual({ claude: [1, 2], codex: [] });

    // Keystrokes reach only the tab they were typed in.
    second.emit("message", Buffer.from("tighten the methods"), false);
    expect(spawned[1].writes).toEqual(["tighten the methods"]);
    expect(spawned[0].writes).toEqual([]);

    // Reattaching to a tab (reload, tab switch) reuses its terminal.
    attachTerminal(new FakeSocket() as never, "claude", undefined, 2);
    expect(spawned).toHaveLength(2);

    expect(restartTerminalRoom("claude", 2)).toBe(true);
    expect(terminalSlots()).toEqual({ claude: [1], codex: [] });
    expect(restartTerminalRoom("claude", 2)).toBe(false);
  });

  it("accepts slots 1 to 8 and falls back to the first", () => {
    expect(terminalSlot("3")).toBe(3);
    expect(terminalSlot(8)).toBe(8);
    expect(terminalSlot(9)).toBe(1);
    expect(terminalSlot("x")).toBe(1);
    expect(terminalSlot(undefined)).toBe(1);
  });
});
