/**
 * Saves a conversation to the sidecar as it changes, sending only what
 * changed. Clients keep their state immutable (a changed turn, suggestion or
 * card is a new object), so "changed" is an identity check against what was
 * last saved — no deep comparison, no re-sending the history. Saves are
 * debounced and run one at a time, in order; a failed save is retried with
 * the next one.
 */

import type { StoredConversationWrite } from "./sidecarClient";

export interface ConversationState<Turn, Suggestion, Card> {
  /** Turns in order; `persist: false` for ones not final yet (a running reply) or not part of the record. */
  turns: Array<{ id: string; turn: Turn; persist: boolean }>;
  suggestions: Array<{ id: string; turnId: string | null; suggestion: Suggestion }>;
  cards: Array<{ id: string; state: Card; pending: boolean }>;
}

export class ConversationSync<Turn extends object, Suggestion extends object, Card extends object> {
  private saved = { turns: new Map<string, unknown>(), suggestions: new Map<string, unknown>(), cards: new Map<string, unknown>() };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latest: (() => ConversationState<Turn, Suggestion, Card>) | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly save: (change: StoredConversationWrite<Turn, Suggestion, Card>) => Promise<void>,
    private readonly delayMs = 600
  ) {}

  /** Record objects as already saved (e.g. just restored from the sidecar). */
  markSaved(state: Partial<ConversationState<Turn, Suggestion, Card>>): void {
    for (const turn of state.turns ?? []) {
      this.saved.turns.set(turn.id, turn.turn);
    }
    for (const suggestion of state.suggestions ?? []) {
      this.saved.suggestions.set(suggestion.id, suggestion.suggestion);
    }
    for (const card of state.cards ?? []) {
      this.saved.cards.set(card.id, card.state);
    }
  }

  /** What changed in `state` since the last save. */
  diff(state: ConversationState<Turn, Suggestion, Card>): StoredConversationWrite<Turn, Suggestion, Card> {
    const turns = state.turns.filter((turn) => turn.persist && this.saved.turns.get(turn.id) !== turn.turn).map(({ id, turn }) => ({ id, turn }));
    const suggestions = state.suggestions.filter((suggestion) => this.saved.suggestions.get(suggestion.id) !== suggestion.suggestion);
    const cards = state.cards.filter((card) => this.saved.cards.get(card.id) !== card.state);
    return {
      ...(turns.length ? { turns } : {}),
      ...(suggestions.length ? { suggestions } : {}),
      ...(cards.length ? { cards: Object.fromEntries(cards.map((card) => [card.id, { state: card.state, pending: card.pending }])) } : {})
    };
  }

  /** Save what changed, after the debounce; `read` is called then, so it sees the latest state. */
  schedule(read: () => ConversationState<Turn, Suggestion, Card>): void {
    this.latest = read;
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  /** Save now (and wait for every save so far). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const read = this.latest;
    this.latest = null;
    if (read) {
      const state = read();
      const change = this.diff(state);
      if (change.turns || change.suggestions || change.cards) {
        // Count it saved now so a save in flight is not sent twice; undone on failure.
        this.markSaved({ turns: (change.turns ?? []).map((turn) => ({ ...turn, persist: true })), suggestions: change.suggestions, cards: Object.entries(change.cards ?? {}).map(([id, card]) => ({ id, ...card })) });
        this.chain = this.chain.then(() => this.save(change)).catch(() => {
          for (const turn of change.turns ?? []) {
            this.saved.turns.delete(turn.id);
          }
          for (const suggestion of change.suggestions ?? []) {
            this.saved.suggestions.delete(suggestion.id);
          }
          for (const id of Object.keys(change.cards ?? {})) {
            this.saved.cards.delete(id);
          }
          this.latest ??= read;
        });
      }
    }
    return this.chain;
  }

  /** Save the given sessions (provider → id; "" forgets one), in order with the other saves. */
  saveSessions(sessions: Record<string, string>): Promise<void> {
    this.chain = this.chain.then(() => this.save({ sessions })).catch(() => undefined);
    return this.chain;
  }

  /** Forget what was saved (a new or cleared conversation) and drop the pending save. */
  forget(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.latest = null;
    this.saved = { turns: new Map(), suggestions: new Map(), cards: new Map() };
  }

  /** Run `task` after every save so far (e.g. a reset that must not race them). */
  after(task: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(task).catch(() => undefined);
    return this.chain;
  }
}
