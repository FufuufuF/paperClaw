import { promises as fs } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { ToolCall } from '../providers/base.js';
import { DEFAULT_SESSION_CONFIG, type SessionConfig } from './config.js';
import type { AgentCheckpoint } from '../agent/runner.js';

export type TurnRole = 'user' | 'assistant' | 'tool';

export interface Turn {
  role: TurnRole;
  content: string;
  /** assistant turn 发起的 tool calls */
  toolCalls?: ToolCall[];
  /** tool turn 对应哪个 call */
  toolCallId?: string;
  /** 估算 token 数 (chars/3.5) — 用于 buildSessionMessages 的预算裁剪 */
  tokenEstimate: number;
  /** unix ms */
  timestamp: number;
}

export interface Session {
  /** 例: "cli:default" / "feishu:user_abc" */
  id: string;
  turns: Turn[];
  metadata: {
    /** ISO */
    createdAt: string;
    /** ISO */
    lastActiveAt: string;
    totalUsage: { input: number; output: number };
    runtimeCheckpoint?: AgentCheckpoint;
  };
}

export interface SessionListing {
  id: string;
  lastActiveAt: string;
  turnCount: number;
  preview?: string;
}

export interface SessionStore {
  load(id: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<SessionListing[]>;
}

export interface SessionManagerOpts {
  config?: Partial<SessionConfig>;
}

/**
 * 文件系统 session store. 一个 session = `<dir>/<sanitized_id>.json`.
 *
 * 写入用 tmp + rename atomic write — 防止 Ctrl-C 写一半留下半截 JSON.
 */
export class FileSessionStore implements SessionStore {
  constructor(private readonly dir: string) {}

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /** 把 session id 转成安全文件名. 仅替换不安全字符, 保留可读性. */
  private fileFor(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9._-]/g, '_');
    return resolve(this.dir, `${safe}.json`);
  }

  /** Exposed for tests and future migration code; callers must not write directly. */
  pathFor(id: string): string {
    return this.fileFor(id);
  }

  async load(id: string): Promise<Session | null> {
    const path = this.fileFor(id);
    try {
      const txt = await fs.readFile(path, 'utf8');
      return normalizeSession(JSON.parse(txt), id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (err instanceof SyntaxError) {
        await this.moveCorruptFile(path);
        return null;
      }
      throw err;
    }
  }

  async save(session: Session): Promise<void> {
    await this.ensureDir();
    const target = this.fileFor(session.id);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(session, null, 2), 'utf8');
    await fs.rename(tmp, target);
  }

  async delete(id: string): Promise<void> {
    try {
      await fs.unlink(this.fileFor(id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  async list(): Promise<SessionListing[]> {
    await this.ensureDir();
    const files = await fs.readdir(this.dir);
    const listings: SessionListing[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const txt = await fs.readFile(resolve(this.dir, f), 'utf8');
        const fallbackId = basename(f, '.json');
        const s = normalizeSession(JSON.parse(txt), fallbackId);
        listings.push({
          id: s.id,
          lastActiveAt: s.metadata?.lastActiveAt ?? '',
          turnCount: s.turns?.length ?? 0,
          preview: previewSession(s),
        });
      } catch {
        // 损坏文件忽略, 不让 list 整体挂掉
        continue;
      }
    }
    listings.sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
    return listings;
  }

  private async moveCorruptFile(path: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${path}.corrupt.${stamp}`;
    try {
      await fs.rename(path, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }
}

/**
 * SessionManager owns higher-level session behavior: create-on-load,
 * per-session serialized mutation, and legal history slicing for model replay.
 *
 * FileSessionStore remains the low-level persistence adapter so existing code
 * can keep using the old SessionStore interface during the rewrite.
 */
export class SessionManager {
  private readonly config: SessionConfig;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: SessionStore,
    opts: SessionManagerOpts = {},
  ) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...opts.config };
  }

  static fileBacked(dir = DEFAULT_SESSION_CONFIG.dir, opts: SessionManagerOpts = {}): SessionManager {
    return new SessionManager(new FileSessionStore(dir), {
      ...opts,
      config: { ...opts.config, dir },
    });
  }

  async getOrCreate(id: string): Promise<Session> {
    return (await this.store.load(id)) ?? createNewSession(id);
  }

  async save(session: Session): Promise<void> {
    const copy = cloneSession(session);
    copy.turns = retainRecentLegalSuffix(copy.turns, this.config.maxMessages);
    copy.metadata.lastActiveAt = new Date().toISOString();
    await this.store.save(copy);
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }

  async list(): Promise<SessionListing[]> {
    return await this.store.list();
  }

  getHistory(session: Session, maxMessages = this.config.maxMessages): Turn[] {
    return retainRecentLegalSuffix(session.turns, maxMessages);
  }

  async update<T>(
    id: string,
    fn: (session: Session) => T | Promise<T>,
  ): Promise<T> {
    return await this.withLock(id, async () => {
      const session = await this.getOrCreate(id);
      const result = await fn(session);
      await this.save(session);
      return result;
    });
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(id, tail);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === tail) {
        this.locks.delete(id);
      }
    }
  }
}

/** 工厂方法: 创建一个空 session */
export function createNewSession(id: string): Session {
  const now = new Date().toISOString();
  return {
    id,
    turns: [],
    metadata: {
      createdAt: now,
      lastActiveAt: now,
      totalUsage: { input: 0, output: 0 },
    },
  };
}

export function retainRecentLegalSuffix(turns: Turn[], maxMessages: number): Turn[] {
  if (maxMessages <= 0 || turns.length <= maxMessages) {
    return dropIllegalToolPrefix(turns.slice());
  }

  let suffix = turns.slice(-maxMessages);
  const firstUser = suffix.findIndex((turn) => turn.role === 'user');
  if (firstUser >= 0) {
    suffix = suffix.slice(firstUser);
  } else {
    const lastUser = findLastIndex(turns, (turn) => turn.role === 'user');
    if (lastUser >= 0) {
      suffix = turns.slice(lastUser, Math.min(turns.length, lastUser + maxMessages));
    }
  }

  return dropIllegalToolPrefix(suffix);
}

function dropIllegalToolPrefix(turns: Turn[]): Turn[] {
  let start = 0;
  while (start < turns.length) {
    const turn = turns[start]!;
    if (turn.role !== 'tool') break;
    start++;
  }
  return turns.slice(start);
}

function normalizeSession(value: unknown, fallbackId: string): Session {
  const raw = value as Partial<Session>;
  const now = new Date().toISOString();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    turns: Array.isArray(raw.turns) ? raw.turns.filter(isTurn) : [],
    metadata: {
      createdAt: raw.metadata?.createdAt ?? now,
      lastActiveAt: raw.metadata?.lastActiveAt ?? now,
      totalUsage: {
        input: raw.metadata?.totalUsage?.input ?? 0,
        output: raw.metadata?.totalUsage?.output ?? 0,
      },
    },
  };
}

function isTurn(value: unknown): value is Turn {
  const turn = value as Partial<Turn>;
  return (
    (turn.role === 'user' || turn.role === 'assistant' || turn.role === 'tool') &&
    typeof turn.content === 'string' &&
    typeof turn.timestamp === 'number'
  );
}

function previewSession(session: Session): string {
  const last = [...session.turns].reverse().find((turn) => turn.role === 'user' || turn.role === 'assistant');
  if (!last) return '';
  return last.content.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function cloneSession(session: Session): Session {
  return JSON.parse(JSON.stringify(session)) as Session;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i]!)) return i;
  }
  return -1;
}
