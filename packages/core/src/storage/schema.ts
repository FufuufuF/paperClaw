export interface SqliteMigration {
  version: number;
  sql: string;
}

export const SQLITE_MIGRATIONS: SqliteMigration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  total_input INTEGER NOT NULL DEFAULT 0,
  total_output INTEGER NOT NULL DEFAULT 0,
  session_name TEXT,
  uid TEXT,
  channel TEXT,
  runtime_checkpoint_json TEXT,
  last_summary_json TEXT,
  compact_json TEXT,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS session_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  command TEXT,
  tool_calls_json TEXT,
  tool_call_id TEXT,
  token_estimate INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  UNIQUE(session_id, idx)
);

CREATE INDEX IF NOT EXISTS sessions_last_active_idx
  ON sessions(last_active_at DESC);

CREATE INDEX IF NOT EXISTS session_turns_session_idx
  ON session_turns(session_id, idx);

CREATE TABLE IF NOT EXISTS memory_history (
  cursor INTEGER PRIMARY KEY,
  timestamp TEXT NOT NULL,
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_cursors (
  name TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS legacy_migration_files (
  source_path TEXT PRIMARY KEY,
  source_mtime_ms INTEGER,
  source_size INTEGER,
  imported_at TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);
`,
  },
];
