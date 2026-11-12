/**
 * How a finished run becomes the reply in the conversation. The pane applies
 * it when it gets the result; the sidecar applies the same rules when it
 * saves a reply that no pane was open to receive, so both record the same.
 */

import type { AiSuggestion, WordLiveSuggestionResponse } from "./shared";

/** The suggestions as staged: each says who proposed it. */
export function stagedSuggestions(response: WordLiveSuggestionResponse, proposedBy: string): AiSuggestion[] {
  return response.ai.suggestions.map((suggestion) => ({ ...suggestion, proposedBy: suggestion.proposedBy ?? proposedBy }));
}

export function replyText(response: WordLiveSuggestionResponse, staged: number): string {
  return response.ai.message || (staged ? `${staged} suggestion${staged === 1 ? "" : "s"} staged.` : "No anchored suggestions were returned.");
}

/** The reply turn once its run finished; `undelivered` notes messages sent during it that it never took. */
export function finishedReply<Turn extends Record<string, unknown>>(running: Turn, response: WordLiveSuggestionResponse, staged: AiSuggestion[], options: { undelivered?: boolean } = {}): Turn {
  const steers = options.undelivered ? response.ai.undeliveredSteers ?? [] : [];
  const text = replyText(response, staged.length) + (steers.length ? `\n\nNot delivered to this reply (send again): ${steers.map((steer) => `“${steer}”`).join(", ")}` : "");
  const finished: Record<string, unknown> = { ...running, text, status: "done", progress: null, suggestionIds: staged.map((suggestion) => suggestion.id) };
  if (response.ai.activity?.length) finished.activity = response.ai.activity;
  delete finished.drafts;
  return finished as Turn;
}

/** The reply turn when its run failed or was stopped. */
export function failedReply<Turn extends Record<string, unknown>>(running: Turn, message: string): Turn {
  const failed: Record<string, unknown> = { ...running, text: message, status: "error", progress: null };
  delete failed.drafts;
  return failed as Turn;
}
