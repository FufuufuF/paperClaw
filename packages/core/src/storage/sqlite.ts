import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { runSqliteMigrations } from './migrations.js';

export type PaperClawDatabase = Database.Database;

export interface OpenPaperClawDatabaseOpts {
  migrate?: boolean;
}

export async function openPaperClawDatabase(
  path: string,
  opts: OpenPaperClawDatabaseOpts = {},
): Promise<PaperClawDatabase> {
  const dbPath = resolve(path);
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  configureDatabase(db);
  if (opts.migrate !== false) runSqliteMigrations(db);
  return db;
}

export function configureDatabase(db: PaperClawDatabase): void {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
}

export function closePaperClawDatabase(db: PaperClawDatabase): void {
  db.close();
}

export function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
