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

/** `held`: the run is queued or still starting; the message is delivered the moment its session is ready. */
export type SteerResult = { ok: true; held?: boolean } | { ok: false; reason: "not-running" | "not-steerable" | "failed"; detail?: string };

export interface Steerable {
  provider: string;
  steer(text: string): Promise<SteerResult>;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const active = new Map<string, Steerable>();
/** Run ids whose request is in flight, even while no process is registered (queued, starting, between a turn and its follow-up). */
const inFlight = new Set<string>();
/** Messages for an in-flight run that had no live session yet; delivered when one registers. */
const held = new Map<string, string[]>();

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

/**
 * Mark a request in flight for its whole lifetime. The returned release
 * function reports messages that were held but never delivered (the run
 * ended without a session that could take them), so the client can send
 * them as the next turn instead of losing them.
 */
export function markRunInFlight(runId: string | null | undefined): () => string[] {
  if (!runId) {
    return () => [];
  }
  inFlight.add(runId);
  return () => {
    inFlight.delete(runId);
    active.delete(runId);
    const undelivered = held.get(runId) ?? [];
    held.delete(runId);
    return undelivered;
  };
}

/** Register the live process serving `runId`; the returned function unregisters it (only if still the same one). */
export function registerSteerable(runId: string | null | undefined, steerable: Steerable): () => void {
  if (!runId) {
    return () => undefined;
  }
  active.set(runId, steerable);
  const waiting = held.get(runId);
  if (waiting?.length) {
    held.delete(runId);
    void (async () => {
      for (const [index, text] of waiting.entries()) {
        const result = await steerable.steer(text).catch(() => ({ ok: false as const, reason: "failed" as const }));
        if (!result.ok) {
          held.set(runId, [...waiting.slice(index), ...(held.get(runId) ?? [])]);
          return;
        }
      }
    })();
  }
  return () => {
    if (active.get(runId) === steerable) {
      active.delete(runId);
    }
  };
}

export async function steerRun(runId: string, text: string): Promise<SteerResult> {
  const steerable = active.get(runId);
  if (!steerable) {
    if (!inFlight.has(runId)) {
      return { ok: false, reason: "not-running" };
    }
    held.set(runId, [...(held.get(runId) ?? []), text]);
    return { ok: true, held: true };
  }
  let result: SteerResult;
  try {
    result = await steerable.steer(text);
  } catch (error) {
    result = { ok: false, reason: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok && inFlight.has(runId)) {
    // The session just finished its turn (a follow-up may still run): hold
    // the message for the next session, or hand it back when the run ends.
    held.set(runId, [...(held.get(runId) ?? []), text]);
    return { ok: true, held: true };
  }
  return result;
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
  held.clear();
}
