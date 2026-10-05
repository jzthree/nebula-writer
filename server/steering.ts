/**
 * Mid-turn steering: a message the user sends while a CLI turn is running is
 * delivered INTO that turn, the way the Codex and Claude CLIs do it — Codex
 * through its app-server's `turn/steer`, Claude through a stream-json input
 * line on a session whose stdin stays open. The model sees the message at its
 * next step (after the current tool call) and answers both in the same turn.
 *
 * Each running process registers under the client-chosen run id of the
 * request it serves; POST /api/ai/steer looks it up. A run with nothing
 * registered (finished, demo provider, an older CLI) reports why, and the
 * client queues the message for the next turn instead.
 */

export type SteerResult = { ok: true } | { ok: false; reason: "not-running" | "not-steerable" | "failed"; detail?: string };

export interface Steerable {
  provider: string;
  steer(text: string): Promise<SteerResult>;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const active = new Map<string, Steerable>();
/** Run ids whose request is in flight, even while no process is registered (between a turn and its follow-up). */
const inFlight = new Set<string>();

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

export function markRunInFlight(runId: string | null | undefined): () => void {
  if (!runId) {
    return () => undefined;
  }
  inFlight.add(runId);
  return () => {
    inFlight.delete(runId);
    active.delete(runId);
  };
}

/** Register the live process serving `runId`; the returned function unregisters it (only if still the same one). */
export function registerSteerable(runId: string | null | undefined, steerable: Steerable): () => void {
  if (!runId) {
    return () => undefined;
  }
  active.set(runId, steerable);
  return () => {
    if (active.get(runId) === steerable) {
      active.delete(runId);
    }
  };
}

export async function steerRun(runId: string, text: string): Promise<SteerResult> {
  const steerable = active.get(runId);
  if (!steerable) {
    return { ok: false, reason: inFlight.has(runId) ? "not-steerable" : "not-running" };
  }
  try {
    return await steerable.steer(text);
  } catch (error) {
    return { ok: false, reason: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** How a steered message is phrased to the model: the user's words, plus how to treat them. */
export function steerMessageText(text: string): string {
  return [
    "Message from the user, sent while you were working on the request above:",
    text.trim(),
    "",
    "Take it into account and carry on; answer it as part of this same reply (your final answer keeps the format it was asked for)."
  ].join("\n");
}

/** For tests. */
export function resetSteering(): void {
  active.clear();
  inFlight.clear();
}
