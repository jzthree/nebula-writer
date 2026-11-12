/**
 * Runs that outlive the pane that started them. A pane that is refreshed or
 * closed mid-reply only loses its connection; the CLI keeps working, and the
 * result waits here (and in the saved conversation, see app.ts) for the pane
 * to come back for it. Stop is explicit (POST /api/ai/runs/:id/stop), never
 * a dropped connection.
 */

export type RunOutcome =
  | { status: "done"; result: unknown }
  | { status: "error"; error: string; stopped: boolean };

export interface RunState {
  runId: string;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt: number | null;
  result?: unknown;
  error?: string;
  stopped?: boolean;
}

interface Entry extends RunState {
  controller: AbortController;
  waiters: Set<() => void>;
}

/** Finished runs are kept this long, for a pane that comes back for its reply. */
export const FINISHED_RUN_TTL_MS = 24 * 60 * 60 * 1000;
const FINISHED_RUN_LIMIT = 200;

export class RunRegistry {
  private readonly runs = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Register a run; null when a run with this id exists (each request has its own id). */
  start(runId: string): { signal: AbortSignal } | null {
    this.prune();
    if (this.runs.has(runId)) return null;
    const controller = new AbortController();
    this.runs.set(runId, { runId, status: "running", startedAt: this.now(), finishedAt: null, controller, waiters: new Set() });
    return { signal: controller.signal };
  }

  finish(runId: string, outcome: RunOutcome): void {
    const entry = this.runs.get(runId);
    if (!entry || entry.status !== "running") return;
    entry.finishedAt = this.now();
    if (outcome.status === "done") {
      entry.status = "done";
      entry.result = outcome.result;
    } else {
      entry.status = "error";
      entry.error = outcome.error;
      entry.stopped = outcome.stopped;
    }
    for (const wake of entry.waiters) wake();
    entry.waiters.clear();
  }

  /** Ask a running run to stop; false when there is none. */
  stop(runId: string): boolean {
    const entry = this.runs.get(runId);
    if (!entry || entry.status !== "running") return false;
    entry.controller.abort();
    return true;
  }

  get(runId: string): RunState | null {
    const entry = this.runs.get(runId);
    if (!entry) return null;
    const { controller: _controller, waiters: _waiters, ...state } = entry;
    return state;
  }

  /** The run's state once it finishes, or after `timeoutMs` while it still runs (or `cancel` fires). */
  async wait(runId: string, timeoutMs: number, cancel?: AbortSignal): Promise<RunState | null> {
    const entry = this.runs.get(runId);
    if (entry?.status === "running" && timeoutMs > 0 && !cancel?.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          entry.waiters.delete(done);
          cancel?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        entry.waiters.add(done);
        cancel?.addEventListener("abort", done, { once: true });
      });
    }
    return this.get(runId);
  }

  private prune(): void {
    const finished = [...this.runs.values()].filter((entry) => entry.status !== "running").sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    const cutoff = this.now() - FINISHED_RUN_TTL_MS;
    finished.forEach((entry, index) => {
      if ((entry.finishedAt ?? 0) < cutoff || finished.length - index > FINISHED_RUN_LIMIT) this.runs.delete(entry.runId);
    });
  }
}

export const detachedRuns = new RunRegistry();
