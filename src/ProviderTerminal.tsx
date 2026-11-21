import { useEffect, useState } from "react";
import { AgentTerminal } from "./AgentTerminal";
import { providerName } from "./providers";
import type { AiProviderName } from "./shared";

/** The provider Writer's inline terminal runs for this choice; null when that CLI has no terminal mode in Writer. */
function terminalProvider(provider: Exclude<AiProviderName, "demo">): "codex" | "claude" | null {
  return provider === "codex" || provider === "claude" ? provider : null;
}

const MAX_TERMINAL_AGENTS = 8;

/**
 * The provider's agent terminals as tabs: each tab is its own agent (its own
 * CLI session on the server), so several can work on different parts of the
 * manuscript at once. Terminals keep running when you switch tabs or reload.
 */
export function ProviderTerminal({ provider }: { provider: Exclude<AiProviderName, "demo"> }) {
  const terminal = terminalProvider(provider);
  const [slots, setSlots] = useState<number[]>([1]);
  const [active, setActive] = useState(1);
  useEffect(() => {
    if (!terminal) {
      return;
    }
    let cancelled = false;
    // Agents already running (the page was reloaded): show a tab for each.
    void fetch("/api/agent-terminal/slots")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { slots?: Partial<Record<"claude" | "codex", number[]>> } | null) => {
        const live = (body?.slots?.[terminal] ?? []).filter((slot) => Number.isInteger(slot) && slot >= 1 && slot <= MAX_TERMINAL_AGENTS);
        if (!cancelled && live.length) {
          setSlots((current) => [...new Set([...current, ...live])].sort((a, b) => a - b));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [terminal]);
  if (!terminal) {
    return <p className="agent-terminal-unavailable">{providerName(provider)} can't run in Writer's terminal yet: it takes Writer's document tools only through its ACP server, not its interactive mode. Use it from the Word or Google Docs pane, or pick Codex or Claude Code here.</p>;
  }
  const addAgent = () => {
    const next = Array.from({ length: MAX_TERMINAL_AGENTS }, (_, index) => index + 1).find((slot) => !slots.includes(slot));
    if (next === undefined) {
      return;
    }
    setSlots((current) => [...current, next].sort((a, b) => a - b));
    setActive(next);
  };
  const closeAgent = (slot: number) => {
    if (slots.length <= 1) {
      return;
    }
    const rest = slots.filter((candidate) => candidate !== slot);
    setSlots(rest);
    if (active === slot) {
      setActive(rest[rest.length - 1]);
    }
    // After the tab's terminal has detached, end that agent's CLI (nothing reconnects to it).
    window.setTimeout(() => {
      void fetch("/api/agent-terminal/restart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: terminal, slot }) }).catch(() => undefined);
    }, 0);
  };
  return (
    <div className="agent-terminal-tabbed">
      <div className="agent-terminal-tabs" role="tablist" aria-label={`${providerName(provider)} agents`}>
        {slots.map((slot) => (
          <span key={slot} className={`agent-terminal-tab${slot === active ? " active" : ""}`}>
            <button type="button" role="tab" aria-selected={slot === active} onClick={() => setActive(slot)} title={`Agent ${slot}: its own ${providerName(provider)} session`}>
              Agent {slot}
            </button>
            {slots.length > 1 ? (
              <button type="button" className="agent-terminal-tab-close" onClick={() => closeAgent(slot)} aria-label={`Close agent ${slot}`} title={`Close agent ${slot} (ends its session; suggestions it staged stay in the queue)`}>×</button>
            ) : null}
          </span>
        ))}
        <button
          type="button"
          className="agent-terminal-tab-add"
          onClick={addAgent}
          disabled={slots.length >= MAX_TERMINAL_AGENTS}
          aria-label="Open another agent"
          title="Another agent in its own terminal — work on another part of the manuscript at the same time"
        >
          + Agent
        </button>
      </div>
      <AgentTerminal key={`${terminal}:${active}`} provider={terminal} slot={active} />
    </div>
  );
}
