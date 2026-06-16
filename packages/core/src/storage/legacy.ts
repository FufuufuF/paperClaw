import { promises as fs } from 'node:fs';
import { basename, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { normalizeSession, type SessionStore } from '../session/manager.js';
import type { MemoryHistoryEntry } from '../agent/memory.js';

export interface LegacyMigrationResult {
  imported: number;
  skipped: number;
  failed: number;
}

interface LegacyRow {
  source_path: string;
  source_mtime_ms: number | null;
  source_size: number | null;
  status: string;
}

export async function migrateLegacySessions(opts: {
  db: Database.Database;
  sessionsDir: string;
  store: SessionStore;
}): Promise<LegacyMigrationResult> {
  const result: LegacyMigrationResult = { imported: 0, skipped: 0, failed: 0 };
  const files = await readDirOrEmpty(opts.sessionsDir);
  for (const file of files.filter((item) => item.endsWith('.json'))) {
    const path = resolve(opts.sessionsDir, file);
    const stat = await fs.stat(path);
    if (alreadyImported(opts.db, path, stat)) {
      result.skipped += 1;
      continue;
    }
    try {
      const raw = await fs.readFile(path, 'utf8');
      const session = normalizeSession(JSON.parse(raw), basename(file, '.json'));
      await opts.store.save(session);
      recordLegacyMigration(opts.db, path, stat, 'imported');
      result.imported += 1;
    } catch (err) {
      recordLegacyMigration(opts.db, path, stat, 'failed', err instanceof Error ? err.message : String(err));
      result.failed += 1;
    }
  }
  return result;
}

export async function migrateLegacyMemoryHistory(opts: {
  db: Database.Database;
  memoryDir: string;
}): Promise<LegacyMigrationResult> {
  const result: LegacyMigrationResult = { imported: 0, skipped: 0, failed: 0 };
  const historyPath = resolve(opts.memoryDir, 'history.jsonl');
  const cursorPath = resolve(opts.memoryDir, '.cursor');
  const dreamCursorPath = resolve(opts.memoryDir, '.dream_cursor');

  const history = await migrateHistoryJsonl(opts.db, historyPath);
  addResult(result, history);

  const cursor = await migrateCursorFile(opts.db, cursorPath, 'history');
  if (cursor.imported === 0 && cursor.failed === 0) {
    const max = maxHistoryCursor(opts.db);
    if (max > 0 && getCursor(opts.db, 'history') === null) {
      setCursor(opts.db, 'history', max);
    }
  }
  addResult(result, cursor);

  const dream = await migrateCursorFile(opts.db, dreamCursorPath, 'dream');
  addResult(result, dream);
  return result;
}

function alreadyImported(db: Database.Database, path: string, stat: { mtimeMs: number; size: number }): boolean {
  const row = db.prepare('SELECT * FROM legacy_migration_files WHERE source_path = ?').get(path) as LegacyRow | undefined;
  return Boolean(
    row &&
    row.status === 'imported' &&
    row.source_mtime_ms === Math.trunc(stat.mtimeMs) &&
    row.source_size === stat.size
  );
}

export function recordLegacyMigration(
  db: Database.Database,
  path: string,
  stat: { mtimeMs: number; size: number },
  status: 'imported' | 'skipped' | 'failed',
  error?: string,
): void {
  db.prepare(`
INSERT INTO legacy_migration_files (
  source_path,
  source_mtime_ms,
  source_size,
  imported_at,
  status,
  error
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(source_path) DO UPDATE SET
  source_mtime_ms = excluded.source_mtime_ms,
  source_size = excluded.source_size,
  imported_at = excluded.imported_at,
  status = excluded.status,
  error = excluded.error
`).run(path, Math.trunc(stat.mtimeMs), stat.size, new Date().toISOString(), status, error ?? null);
}

async function readDirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function migrateHistoryJsonl(db: Database.Database, path: string): Promise<LegacyMigrationResult> {
  const result: LegacyMigrationResult = { imported: 0, skipped: 0, failed: 0 };
  const stat = await statOrNull(path);
  if (!stat) return result;
  if (alreadyImported(db, path, stat)) {
    result.skipped += 1;
    return result;
  }
  try {
    const text = await fs.readFile(path, 'utf8');
    const entries: MemoryHistoryEntry[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<MemoryHistoryEntry>;
        if (isHistoryEntry(parsed)) entries.push(parsed);
      } catch {
        // Bad historical lines are ignored, matching the file store reader.
      }
    }
    const insert = db.prepare(`
INSERT OR IGNORE INTO memory_history (cursor, timestamp, content)
VALUES (?, ?, ?)
`);
    const tx = db.transaction((rows: MemoryHistoryEntry[]) => {
      for (const entry of rows) insert.run(entry.cursor, entry.timestamp, entry.content);
    });
    tx(entries);
    recordLegacyMigration(db, path, stat, 'imported');
    result.imported += 1;
  } catch (err) {
    recordLegacyMigration(db, path, stat, 'failed', err instanceof Error ? err.message : String(err));
    result.failed += 1;
  }
  return result;
}

async function migrateCursorFile(db: Database.Database, path: string, name: string): Promise<LegacyMigrationResult> {
  const result: LegacyMigrationResult = { imported: 0, skipped: 0, failed: 0 };
  const stat = await statOrNull(path);
  if (!stat) return result;
  if (alreadyImported(db, path, stat)) {
    result.skipped += 1;
    return result;
  }
  try {
    const cursor = parseCursor(await fs.readFile(path, 'utf8'));
    if (cursor !== null) setCursor(db, name, cursor);
    recordLegacyMigration(db, path, stat, 'imported', cursor === null ? 'cursor file did not contain a non-negative integer' : undefined);
    result.imported += 1;
  } catch (err) {
    recordLegacyMigration(db, path, stat, 'failed', err instanceof Error ? err.message : String(err));
    result.failed += 1;
  }
  return result;
}

function addResult(target: LegacyMigrationResult, next: LegacyMigrationResult): void {
  target.imported += next.imported;
  target.skipped += next.skipped;
  target.failed += next.failed;
}

async function statOrNull(path: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    return await fs.stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function isHistoryEntry(value: Partial<MemoryHistoryEntry>): value is MemoryHistoryEntry {
  return Number.isInteger(value.cursor) &&
    typeof value.timestamp === 'string' &&
    typeof value.content === 'string';
}

function parseCursor(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

function maxHistoryCursor(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(cursor) AS cursor FROM memory_history').get() as { cursor: number | null };
  return typeof row.cursor === 'number' ? row.cursor : 0;
}

function getCursor(db: Database.Database, name: string): number | null {
  const row = db.prepare('SELECT cursor FROM memory_cursors WHERE name = ?').get(name) as { cursor: number } | undefined;
  return typeof row?.cursor === 'number' ? row.cursor : null;
}

function setCursor(db: Database.Database, name: string, cursor: number): void {
  db.prepare(`
INSERT INTO memory_cursors (name, cursor, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(name) DO UPDATE SET
  cursor = excluded.cursor,
  updated_at = excluded.updated_at
`).run(name, cursor, new Date().toISOString());
}
