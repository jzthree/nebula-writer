/**
 * Writer conversations, kept per document so reopening a document restores
 * the transcript, the suggestion cards and the CLI sessions to resume.
 *
 * Built to stay fast however long a conversation grows: everything lives in
 * one SQLite file (node:sqlite) with indexed tables, every write touches only
 * the rows that changed, and reads are paged — opening a document loads the
 * latest turns plus the suggestions still pending anywhere in the history,
 * and earlier turns are fetched a page at a time when the author scrolls back.
 *
 * Rows are opaque JSON written by the clients (the Word/Docs pane and the web
 * app each store their own turn shape); the store only orders, pages and
 * scopes them. "New conversation" starts a new epoch: earlier turns stay on
 * disk but are no longer restored, and the provider sessions are forgotten.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export const CONVERSATION_KEY_PATTERN = /^[A-Za-z0-9:_.\-/%@+=~ ]{1,512}$/;
export const DEFAULT_PAGE_TURNS = 40;
const MAX_PAGE_TURNS = 200;
/** Pending suggestions restored at most (the most recent ones). */
const MAX_PENDING = 500;

export interface StoredTurn {
  id: string;
  /** The client's turn object, as written. */
  turn: unknown;
}

export interface StoredSuggestion {
  id: string;
  turnId: string | null;
  suggestion: unknown;
}

export interface ConversationPage {
  key: string;
  epoch: number;
  /** Oldest first. */
  turns: StoredTurn[];
  /** The suggestions those turns staged, plus every suggestion still pending in the conversation. */
  suggestions: StoredSuggestion[];
  /** Card states for the suggestions returned, by suggestion id. */
  cards: Record<string, unknown>;
  /** Provider session ids to resume, by provider. */
  sessions: Record<string, string>;
  /** Cursor for the page before this one, or null at the start of the conversation. */
  before: number | null;
}

export interface ConversationWrite {
  turns?: StoredTurn[];
  suggestions?: StoredSuggestion[];
  /** Card state by suggestion id; `pending` decides whether it is restored with the first page. */
  cards?: Record<string, { state: unknown; pending: boolean }>;
  /** Provider session ids; an empty string forgets one. */
  sessions?: Record<string, string>;
}

function defaultPath(env: NodeJS.ProcessEnv): string {
  return env.WRITER_CONVERSATIONS_DB?.trim() || join(homedir(), ".nebula-writer", "conversations.sqlite");
}

export class ConversationStore {
  private db: DatabaseSync;
  private statements: Record<string, StatementSync> = {};

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS conversations (
        key TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL DEFAULT 0,
        sessions TEXT NOT NULL DEFAULT '{}',
        next_seq INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        key TEXT NOT NULL,
        id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (key, id)
      );
      CREATE INDEX IF NOT EXISTS turns_by_seq ON turns (key, epoch, seq);
      CREATE TABLE IF NOT EXISTS suggestions (
        key TEXT NOT NULL,
        id TEXT NOT NULL,
        turn_id TEXT,
        json TEXT NOT NULL,
        PRIMARY KEY (key, id)
      );
      CREATE INDEX IF NOT EXISTS suggestions_by_turn ON suggestions (key, turn_id);
      CREATE TABLE IF NOT EXISTS cards (
        key TEXT NOT NULL,
        suggestion_id TEXT NOT NULL,
        pending INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (key, suggestion_id)
      );
      CREATE INDEX IF NOT EXISTS cards_pending ON cards (key, pending, updated);
    `);
  }

  private statement(sql: string): StatementSync {
    return (this.statements[sql] ??= this.db.prepare(sql));
  }

  private conversation(key: string): { epoch: number; sessions: Record<string, string>; nextSeq: number } {
    const row = this.statement("SELECT epoch, sessions, next_seq FROM conversations WHERE key = ?").get(key) as { epoch: number; sessions: string; next_seq: number } | undefined;
    if (!row) {
      return { epoch: 0, sessions: {}, nextSeq: 1 };
    }
    let sessions: Record<string, string> = {};
    try {
      sessions = JSON.parse(row.sessions) as Record<string, string>;
    } catch {
      sessions = {};
    }
    return { epoch: row.epoch, sessions, nextSeq: row.next_seq };
  }

  private saveConversation(key: string, value: { epoch: number; sessions: Record<string, string>; nextSeq: number }): void {
    this.statement(`INSERT INTO conversations (key, epoch, sessions, next_seq, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET epoch = excluded.epoch, sessions = excluded.sessions, next_seq = excluded.next_seq, updated_at = excluded.updated_at`)
      .run(key, value.epoch, JSON.stringify(value.sessions), value.nextSeq, new Date().toISOString());
  }

  /** The latest turns (or the page before `before`), with their suggestions, card states and sessions. */
  read(key: string, options: { limit?: number; before?: number | null } = {}): ConversationPage {
    const meta = this.conversation(key);
    const limit = Math.max(1, Math.min(MAX_PAGE_TURNS, Math.floor(options.limit ?? DEFAULT_PAGE_TURNS)));
    const before = options.before ?? Number.MAX_SAFE_INTEGER;
    const rows = this.statement("SELECT id, seq, json FROM turns WHERE key = ? AND epoch = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
      .all(key, meta.epoch, before, limit + 1) as Array<{ id: string; seq: number; json: string }>;
    const more = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    const turns = page.map((row) => ({ id: row.id, turn: JSON.parse(row.json) as unknown }));
    const suggestions = new Map<string, StoredSuggestion>();
    const bySuggestionTurn = this.statement("SELECT id, turn_id, json FROM suggestions WHERE key = ? AND turn_id = ?");
    for (const row of page) {
      for (const suggestion of bySuggestionTurn.all(key, row.id) as Array<{ id: string; turn_id: string | null; json: string }>) {
        suggestions.set(suggestion.id, { id: suggestion.id, turnId: suggestion.turn_id, suggestion: JSON.parse(suggestion.json) as unknown });
      }
    }
    // The first page also restores what is still waiting for a decision, wherever it was staged.
    if (options.before === undefined || options.before === null) {
      const pending = this.statement(`SELECT s.id, s.turn_id, s.json FROM cards c JOIN suggestions s ON s.key = c.key AND s.id = c.suggestion_id
        WHERE c.key = ? AND c.pending = 1 ORDER BY c.updated DESC LIMIT ?`).all(key, MAX_PENDING) as Array<{ id: string; turn_id: string | null; json: string }>;
      for (const suggestion of pending) {
        suggestions.set(suggestion.id, { id: suggestion.id, turnId: suggestion.turn_id, suggestion: JSON.parse(suggestion.json) as unknown });
      }
    }
    const cards: Record<string, unknown> = {};
    const card = this.statement("SELECT json FROM cards WHERE key = ? AND suggestion_id = ?");
    for (const id of suggestions.keys()) {
      const row = card.get(key, id) as { json: string } | undefined;
      if (row) {
        cards[id] = JSON.parse(row.json) as unknown;
      }
    }
    return {
      key,
      epoch: meta.epoch,
      turns,
      suggestions: [...suggestions.values()],
      cards,
      sessions: meta.sessions,
      before: more && page.length ? page[0].seq : null
    };
  }

  /** Upsert turns (new ones are appended in order), suggestions, card states and sessions. */
  write(key: string, change: ConversationWrite): void {
    this.db.exec("BEGIN");
    try {
      const meta = this.conversation(key);
      const existing = this.statement("SELECT seq FROM turns WHERE key = ? AND id = ?");
      const upsertTurn = this.statement(`INSERT INTO turns (key, id, epoch, seq, json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key, id) DO UPDATE SET json = excluded.json`);
      for (const turn of change.turns ?? []) {
        const seq = (existing.get(key, turn.id) as { seq: number } | undefined)?.seq ?? meta.nextSeq++;
        upsertTurn.run(key, turn.id, meta.epoch, seq, JSON.stringify(turn.turn));
      }
      const upsertSuggestion = this.statement(`INSERT INTO suggestions (key, id, turn_id, json) VALUES (?, ?, ?, ?)
        ON CONFLICT(key, id) DO UPDATE SET json = excluded.json, turn_id = COALESCE(excluded.turn_id, suggestions.turn_id)`);
      for (const suggestion of change.suggestions ?? []) {
        upsertSuggestion.run(key, suggestion.id, suggestion.turnId, JSON.stringify(suggestion.suggestion));
      }
      const upsertCard = this.statement(`INSERT INTO cards (key, suggestion_id, pending, updated, json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key, suggestion_id) DO UPDATE SET pending = excluded.pending, updated = excluded.updated, json = excluded.json`);
      const now = Date.now();
      for (const [id, card] of Object.entries(change.cards ?? {})) {
        upsertCard.run(key, id, card.pending ? 1 : 0, now, JSON.stringify(card.state));
      }
      for (const [provider, session] of Object.entries(change.sessions ?? {})) {
        if (session) {
          meta.sessions[provider] = session;
        } else {
          delete meta.sessions[provider];
        }
      }
      this.saveConversation(key, meta);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * "new": a new epoch — earlier turns are no longer restored and the
   * sessions are forgotten; pending suggestions stay. "clear": forget the
   * conversation entirely.
   */
  reset(key: string, mode: "new" | "clear"): void {
    if (mode === "clear") {
      this.db.exec("BEGIN");
      try {
        for (const table of ["turns", "suggestions", "cards", "conversations"]) {
          this.statement(`DELETE FROM ${table} WHERE key = ?`).run(key);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return;
    }
    const meta = this.conversation(key);
    this.saveConversation(key, { epoch: meta.epoch + 1, sessions: {}, nextSeq: meta.nextSeq });
  }

  close(): void {
    this.db.close();
  }
}

let shared: ConversationStore | null = null;

export function conversationStore(env: NodeJS.ProcessEnv = process.env): ConversationStore {
  return (shared ??= new ConversationStore(defaultPath(env)));
}

/** For tests. */
export function resetConversationStore(): void {
  shared?.close();
  shared = null;
}
