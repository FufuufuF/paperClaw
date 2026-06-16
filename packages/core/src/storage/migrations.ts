import type Database from 'better-sqlite3';
import { SQLITE_MIGRATIONS } from './schema.js';

export function runSqliteMigrations(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all()
      .map((row) => Number((row as { version: number }).version)),
  );

  const apply = db.transaction((version: number, sql: string) => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(version, new Date().toISOString());
  });

  for (const migration of SQLITE_MIGRATIONS.sort((a, b) => a.version - b.version)) {
    if (!applied.has(migration.version)) {
      apply(migration.version, migration.sql);
    }
  }
}
