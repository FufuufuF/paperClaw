import type Database from 'better-sqlite3';
import { cleanHistoryContent, type AppendHistoryOpts, type MemoryHistoryEntry, type MemoryHistoryStore } from './memory.js';

const DEFAULT_MAX_HISTORY_ENTRIES = 1000;
const DEFAULT_HISTORY_ENTRY_MAX_CHARS = 64_000;

interface CursorRow {
  cursor: number;
}

interface HistoryRow {
  cursor: number;
  timestamp: string;
  content: string;
}

export interface SqliteMemoryHistoryStoreOpts {
  maxHistoryEntries?: number;
}

export class SqliteMemoryHistoryStore implements MemoryHistoryStore {
  private readonly maxHistoryEntries: number;
  private readonly appendTransaction: (content: string) => number;

  constructor(private readonly db: Database.Database, opts: SqliteMemoryHistoryStoreOpts = {}) {
    this.maxHistoryEntries = opts.maxHistoryEntries ?? DEFAULT_MAX_HISTORY_ENTRIES;
    this.appendTransaction = db.transaction((content: string) => {
      const cursor = this.nextCursor();
      const timestamp = new Date().toISOString();
      this.db.prepare('INSERT INTO memory_history (cursor, timestamp, content) VALUES (?, ?, ?)')
        .run(cursor, timestamp, content);
      this.setCursor('history', cursor);
      return cursor;
    });
  }

  async appendHistory(entry: string, opts: AppendHistoryOpts = {}): Promise<number> {
    const limit = opts.maxChars ?? DEFAULT_HISTORY_ENTRY_MAX_CHARS;
    return this.appendTransaction(cleanHistoryContent(entry, limit));
  }

  async readUnprocessedHistory(sinceCursor: number): Promise<MemoryHistoryEntry[]> {
    return this.db.prepare(`
SELECT cursor, timestamp, content
FROM memory_history
WHERE cursor > ?
ORDER BY cursor ASC
`).all(sinceCursor).map(toHistoryEntry);
  }

  async compactHistory(): Promise<void> {
    if (this.maxHistoryEntries <= 0) return;
    this.db.prepare(`
DELETE FROM memory_history
WHERE cursor NOT IN (
  SELECT cursor FROM memory_history ORDER BY cursor DESC LIMIT ?
)
`).run(this.maxHistoryEntries);
  }

  async getLastDreamCursor(): Promise<number> {
    return this.getCursor('dream') ?? 0;
  }

  async setLastDreamCursor(cursor: number): Promise<void> {
    this.setCursor('dream', cursor);
  }

  private nextCursor(): number {
    const persisted = this.getCursor('history');
    if (persisted !== null) return persisted + 1;
    const row = this.db.prepare('SELECT MAX(cursor) AS cursor FROM memory_history').get() as CursorRow;
    return (typeof row.cursor === 'number' ? row.cursor : 0) + 1;
  }

  private getCursor(name: string): number | null {
    const row = this.db.prepare('SELECT cursor FROM memory_cursors WHERE name = ?').get(name) as CursorRow | undefined;
    return typeof row?.cursor === 'number' ? row.cursor : null;
  }

  private setCursor(name: string, cursor: number): void {
    this.db.prepare(`
INSERT INTO memory_cursors (name, cursor, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(name) DO UPDATE SET
  cursor = excluded.cursor,
  updated_at = excluded.updated_at
`).run(name, cursor, new Date().toISOString());
  }
}

function toHistoryEntry(row: unknown): MemoryHistoryEntry {
  const value = row as HistoryRow;
  return {
    cursor: value.cursor,
    timestamp: value.timestamp,
    content: value.content,
  };
}
