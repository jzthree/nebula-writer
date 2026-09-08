import type { AiRequest, AiRequestFocus, AiResponse, AiSuggestion } from "../src/shared";

/**
 * "Refine S3": the user's message was about one earlier suggestion. The reply's
 * first text suggestion is that suggestion's revision; the earlier one is
 * withdrawn (superseded), not rejected, so the digest the AI reads next time
 * says what happened.
 */
export function linkRevision(request: Pick<AiRequest, "focus">, response: AiResponse): AiResponse {
  const focus = request.focus;
  if (!focus || !response.suggestions.length) {
    return response;
  }
  const index = response.suggestions.findIndex((suggestion) => suggestion.kind !== "image");
  if (index < 0) {
    return response;
  }
  const suggestions = response.suggestions.map((suggestion, position) => (position === index ? { ...suggestion, revises: focus.suggestionId } : suggestion));
  return { ...response, suggestions };
}

/** Mark every suggestion that a newcomer revises as superseded (a withdrawal recorded like a decision). */
export function supersedeRevisedSuggestions(suggestions: AiSuggestion[], incoming: AiSuggestion[], decidedBy: string): AiSuggestion[] {
  const revisions = new Map<string, string>();
  for (const suggestion of incoming) {
    if (suggestion.revises) {
      revisions.set(suggestion.revises, suggestion.id);
    }
  }
  if (!revisions.size) {
    return suggestions;
  }
  const now = new Date().toISOString();
  return suggestions.map((suggestion) => {
    const supersededBy = revisions.get(suggestion.id);
    if (!supersededBy || suggestion.id === supersededBy || suggestion.status !== "pending") {
      return suggestion;
    }
    return {
      ...suggestion,
      status: "rejected",
      supersededBy,
      decidedBy,
      decidedAt: now,
      decisionNote: "Superseded by a revised suggestion"
    };
  });
}

/** Prompt lines that put the AI in "revise this one suggestion" mode. */
export function describeFocus(focus: AiRequestFocus | null | undefined, engine: "oneshot" | "agentic"): string[] {
  if (!focus) {
    return [];
  }
  const label = focus.ref ? `${focus.ref} "${focus.title}"` : `"${focus.title}"`;
  const clip = (text: string) => (text.length > 1200 ? `${text.slice(0, 1197)}…` : text);
  return [
    "",
    `You are replying about ONE of your earlier suggestions, ${label}:`,
    `- its original (the passage it targets): ${JSON.stringify(clip(focus.original))}`,
    `- your proposed replacement: ${JSON.stringify(clip(focus.replacement))}`,
    ...(focus.rationale ? [`- your rationale: ${JSON.stringify(clip(focus.rationale))}`] : []),
    "The user's message below is feedback on that suggestion. Produce exactly ONE revised suggestion for the same passage (copy the original verbatim from the document again — it may be unchanged), applying their feedback; the earlier suggestion is withdrawn automatically. Do not restage your other suggestions. If the message is a question rather than a change, answer it in the message and stage nothing.",
    ...(engine === "agentic" ? ["Stage the revision with writer_stage_suggestions as a single item."] : [])
  ];
}
