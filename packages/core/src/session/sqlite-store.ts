import type Database from 'better-sqlite3';
import type { ToolCall } from '../providers/base.js';
import { jsonOrNull, parseJson, type PaperClawDatabase } from '../storage/sqlite.js';
import {
  normalizeSession,
  previewSession,
  type Session,
  type SessionListing,
  type SessionMetadata,
  type SessionStore,
  type Turn,
  type TurnRole,
} from './manager.js';

interface SessionRow {
  id: string;
  created_at: string;
  last_active_at: string;
  total_input: number;
  total_output: number;
  session_name: string | null;
  uid: string | null;
  channel: string | null;
  runtime_checkpoint_json: string | null;
  last_summary_json: string | null;
  compact_json: string | null;
  metadata_json: string | null;
}

interface TurnRow {
  idx: number;
  role: TurnRole;
  content: string;
  command: string | null;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  token_estimate: number;
  timestamp: number;
}

export class SqliteSessionStore implements SessionStore {
  private readonly loadSessionStmt: Database.Statement<[string], SessionRow>;
  private readonly loadTurnsStmt: Database.Statement<[string], TurnRow>;
  private readonly listSessionsStmt: Database.Statement<[], SessionRow>;
  private readonly upsertSessionStmt: Database.Statement<unknown[]>;
  private readonly deleteTurnsStmt: Database.Statement<[string]>;
  private readonly insertTurnStmt: Database.Statement<unknown[]>;
  private readonly deleteSessionStmt: Database.Statement<[string]>;
  private readonly saveTransaction: (session: Session) => void;

  constructor(private readonly db: PaperClawDatabase) {
    this.loadSessionStmt = db.prepare('SELECT * FROM sessions WHERE id = ?') as Database.Statement<[string], SessionRow>;
    this.loadTurnsStmt = db.prepare('SELECT * FROM session_turns WHERE session_id = ? ORDER BY idx ASC') as Database.Statement<[string], TurnRow>;
    this.listSessionsStmt = db.prepare('SELECT * FROM sessions ORDER BY last_active_at DESC') as Database.Statement<[], SessionRow>;
    this.upsertSessionStmt = db.prepare(`
INSERT INTO sessions (
  id,
  created_at,
  last_active_at,
  total_input,
  total_output,
  session_name,
  uid,
  channel,
  runtime_checkpoint_json,
  last_summary_json,
  compact_json,
  metadata_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  created_at = excluded.created_at,
  last_active_at = excluded.last_active_at,
  total_input = excluded.total_input,
  total_output = excluded.total_output,
  session_name = excluded.session_name,
  uid = excluded.uid,
  channel = excluded.channel,
  runtime_checkpoint_json = excluded.runtime_checkpoint_json,
  last_summary_json = excluded.last_summary_json,
  compact_json = excluded.compact_json,
  metadata_json = excluded.metadata_json
`);
    this.deleteTurnsStmt = db.prepare('DELETE FROM session_turns WHERE session_id = ?') as Database.Statement<[string]>;
    this.insertTurnStmt = db.prepare(`
INSERT INTO session_turns (
  session_id,
  idx,
  role,
  content,
  command,
  tool_calls_json,
  tool_call_id,
  token_estimate,
  timestamp
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
    this.deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE id = ?') as Database.Statement<[string]>;
    this.saveTransaction = db.transaction((session: Session) => {
      this.upsertSessionStmt.run(...sessionParams(session));
      this.deleteTurnsStmt.run(session.id);
      session.turns.forEach((turn, idx) => {
        this.insertTurnStmt.run(...turnParams(session.id, idx, turn));
      });
    });
  }

  async load(id: string): Promise<Session | null> {
    const row = this.loadSessionStmt.get(id);
    if (!row) return null;
    return this.sessionFromRow(row, this.loadTurns(row.id));
  }

  async save(session: Session): Promise<void> {
    this.saveTransaction(cloneSession(session));
  }

  async delete(id: string): Promise<void> {
    this.deleteSessionStmt.run(id);
  }

  async list(): Promise<SessionListing[]> {
    return this.listSessionsStmt.all().map((row) => {
      const session = this.sessionFromRow(row, this.loadTurns(row.id));
      return {
        id: session.id,
        lastActiveAt: session.metadata.lastActiveAt,
        turnCount: session.turns.length,
        preview: previewSession(session),
        sessionName: session.metadata.sessionName,
        uid: session.metadata.uid,
        channel: session.metadata.channel,
      };
    });
  }

  private loadTurns(sessionId: string): Turn[] {
    return this.loadTurnsStmt.all(sessionId).map(turnFromRow);
  }

  private sessionFromRow(row: SessionRow, turns: Turn[]): Session {
    const extraMetadata = parseJson<Partial<SessionMetadata>>(row.metadata_json, {});
    return normalizeSession({
      id: row.id,
      turns,
      metadata: {
        ...extraMetadata,
        createdAt: row.created_at,
        lastActiveAt: row.last_active_at,
        totalUsage: {
          input: row.total_input,
          output: row.total_output,
        },
        runtimeCheckpoint: parseJson(row.runtime_checkpoint_json, undefined),
        _lastSummary: parseJson(row.last_summary_json, undefined),
        _compact: parseJson(row.compact_json, undefined),
        sessionName: row.session_name ?? undefined,
        uid: row.uid ?? undefined,
        channel: row.channel ?? undefined,
      },
    }, row.id);
  }
}

function sessionParams(session: Session): unknown[] {
  const metadata = session.metadata;
  return [
    session.id,
    metadata.createdAt,
    metadata.lastActiveAt,
    metadata.totalUsage.input,
    metadata.totalUsage.output,
    metadata.sessionName ?? null,
    metadata.uid ?? null,
    metadata.channel ?? null,
    jsonOrNull(metadata.runtimeCheckpoint),
    jsonOrNull(metadata._lastSummary),
    jsonOrNull(metadata._compact),
    JSON.stringify(metadata),
  ];
}

function turnParams(sessionId: string, idx: number, turn: Turn): unknown[] {
  return [
    sessionId,
    idx,
    turn.role,
    turn.content,
    turn.command ?? null,
    jsonOrNull(turn.toolCalls),
    turn.toolCallId ?? null,
    turn.tokenEstimate,
    turn.timestamp,
  ];
}

function turnFromRow(row: TurnRow): Turn {
  return {
    role: row.role,
    content: row.content,
    ...(row.command ? { command: row.command } : {}),
    ...(row.tool_calls_json ? { toolCalls: parseJson<ToolCall[]>(row.tool_calls_json, []) } : {}),
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    tokenEstimate: row.token_estimate,
    timestamp: row.timestamp,
  };
}

function cloneSession(session: Session): Session {
  return JSON.parse(JSON.stringify(session)) as Session;
}
