import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolCall } from '../providers/base.js';

export type TurnRole = 'user' | 'assistant' | 'tool';

export interface Turn {
  role: TurnRole;
  content: string;
  /** assistant turn 发起的 tool calls */
  toolCalls?: ToolCall[];
  /** tool turn 对应哪个 call */
  toolCallId?: string;
  /** 估算 token 数 (chars/3.5) — 用于 buildMessages 的预算裁剪 */
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
  };
}

export interface SessionListing {
  id: string;
  lastActiveAt: string;
  turnCount: number;
}

export interface SessionStore {
  load(id: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<SessionListing[]>;
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

  async load(id: string): Promise<Session | null> {
    try {
      const txt = await fs.readFile(this.fileFor(id), 'utf8');
      return JSON.parse(txt) as Session;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
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
        const s = JSON.parse(txt) as Session;
        listings.push({
          id: s.id,
          lastActiveAt: s.metadata?.lastActiveAt ?? '',
          turnCount: s.turns?.length ?? 0,
        });
      } catch {
        // 损坏文件忽略, 不让 list 整体挂掉
        continue;
      }
    }
    listings.sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
    return listings;
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
