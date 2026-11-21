import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each tab's terminal: which provider and slot it attached to.
vi.mock("../src/AgentTerminal", () => ({
  AgentTerminal: ({ provider, slot }: { provider: string; slot?: number }) => <div data-testid="terminal">{`${provider}:${slot ?? 1}`}</div>
}));

const { ProviderTerminal } = await import("../src/ProviderTerminal");

const calls: Array<{ url: string; body?: unknown }> = [];
let liveSlots: Record<string, number[]> = { claude: [], codex: [] };

beforeEach(() => {
  calls.length = 0;
  liveSlots = { claude: [], codex: [] };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/agent-terminal/slots") {
      return new Response(JSON.stringify({ slots: liveSlots }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("agent terminal tabs", () => {
  it("opens another agent in its own terminal, and closing a tab ends that agent", async () => {
    render(<ProviderTerminal provider="claude" />);
    expect(screen.getByTestId("terminal").textContent).toBe("claude:1");
    expect(screen.queryByLabelText("Close agent 1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Open another agent"));
    expect(screen.getByTestId("terminal").textContent).toBe("claude:2");
    expect(screen.getByRole("tab", { name: "Agent 2" })).toHaveAttribute("aria-selected", "true");

    // Switching tabs attaches to that agent's terminal; it keeps running on the server meanwhile.
    fireEvent.click(screen.getByRole("tab", { name: "Agent 1" }));
    expect(screen.getByTestId("terminal").textContent).toBe("claude:1");

    fireEvent.click(screen.getByLabelText("Close agent 2"));
    expect(screen.queryByRole("tab", { name: "Agent 2" })).not.toBeInTheDocument();
    await waitFor(() => expect(calls).toContainEqual({ url: "/api/agent-terminal/restart", body: { provider: "claude", slot: 2 } }));
  });

  it("shows a tab for every agent already running after a reload", async () => {
    liveSlots = { claude: [], codex: [1, 3] };
    render(<ProviderTerminal provider="codex" />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Agent 3" })).toBeInTheDocument());
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Agent 1", "Agent 3"]);
    // A new agent takes the first free slot.
    fireEvent.click(screen.getByLabelText("Open another agent"));
    expect(screen.getByTestId("terminal").textContent).toBe("codex:2");
  });
});
