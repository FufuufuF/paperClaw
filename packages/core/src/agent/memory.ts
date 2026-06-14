import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Turn } from '../session/manager.js';

export interface MemoryHistoryEntry {
  cursor: number;
  timestamp: string;
  content: string;
}

export interface AppendHistoryOpts {
  maxChars?: number;
}

export interface MemoryStoreOpts {
  maxHistoryEntries?: number;
}

const DEFAULT_MAX_HISTORY_ENTRIES = 1000;
const DEFAULT_HISTORY_ENTRY_MAX_CHARS = 64_000;
const DEFAULT_RAW_ARCHIVE_MAX_CHARS = 16_000;

export class MemoryStore {
  private readonly maxHistoryEntries: number;
  private readonly memoryDir: string;
  private readonly memoryFile: string;
  private readonly historyFile: string;
  private readonly cursorFile: string;
  private readonly dreamCursorFile: string;
  private readonly soulFile: string;
  private readonly userFile: string;

  constructor(storeDir: string, opts: MemoryStoreOpts = {}) {
    this.maxHistoryEntries = opts.maxHistoryEntries ?? DEFAULT_MAX_HISTORY_ENTRIES;
    this.memoryDir = resolve(storeDir, 'memory');
    this.memoryFile = resolve(this.memoryDir, 'MEMORY.md');
    this.historyFile = resolve(this.memoryDir, 'history.jsonl');
    this.cursorFile = resolve(this.memoryDir, '.cursor');
    this.dreamCursorFile = resolve(this.memoryDir, '.dream_cursor');
    this.soulFile = resolve(storeDir, 'SOUL.md');
    this.userFile = resolve(storeDir, 'USER.md');
  }

  async readMemory(): Promise<string> {
    return await readFileOrEmpty(this.memoryFile);
  }

  async writeMemory(content: string): Promise<void> {
    await writeFileEnsured(this.memoryFile, content);
  }

  async readSoul(): Promise<string> {
    return await readFileOrEmpty(this.soulFile);
  }

  async writeSoul(content: string): Promise<void> {
    await writeFileEnsured(this.soulFile, content);
  }

  async readUser(): Promise<string> {
    return await readFileOrEmpty(this.userFile);
  }

  async writeUser(content: string): Promise<void> {
    await writeFileEnsured(this.userFile, content);
  }

  async getMemoryContext(): Promise<string> {
    const memory = (await this.readMemory()).trim();
    return memory ? `## Long-term Memory\n${memory}` : '';
  }

  async appendHistory(entry: string, opts: AppendHistoryOpts = {}): Promise<number> {
    await fs.mkdir(this.memoryDir, { recursive: true });
    const cursor = await this.nextCursor();
    const limit = opts.maxChars ?? DEFAULT_HISTORY_ENTRY_MAX_CHARS;
    const content = stripThink(entry.trimEnd()).slice(0, limit);
    const record: MemoryHistoryEntry = {
      cursor,
      timestamp: new Date().toISOString(),
      content,
    };
    await fs.appendFile(this.historyFile, `${JSON.stringify(record)}\n`, 'utf8');
    await fs.writeFile(this.cursorFile, String(cursor), 'utf8');
    return cursor;
  }

  async readUnprocessedHistory(sinceCursor: number): Promise<MemoryHistoryEntry[]> {
    const entries = await this.readEntries();
    return entries.filter((entry) => entry.cursor > sinceCursor);
  }

  async compactHistory(): Promise<void> {
    if (this.maxHistoryEntries <= 0) return;
    const entries = await this.readEntries();
    if (entries.length <= this.maxHistoryEntries) return;
    await this.writeEntries(entries.slice(-this.maxHistoryEntries));
  }

  async getLastDreamCursor(): Promise<number> {
    const text = await readFileOrEmpty(this.dreamCursorFile);
    return parseCursorText(text) ?? 0;
  }

  async setLastDreamCursor(cursor: number): Promise<void> {
    await writeFileEnsured(this.dreamCursorFile, String(cursor));
  }

  async rawArchive(turns: Turn[], opts: AppendHistoryOpts = {}): Promise<number> {
    const limit = opts.maxChars ?? DEFAULT_RAW_ARCHIVE_MAX_CHARS;
    const formatted = formatTurns(turns).slice(0, limit);
    return await this.appendHistory(`[RAW] ${turns.length} turns\n${formatted}`, { maxChars: limit + 128 });
  }

  private async nextCursor(): Promise<number> {
    const persisted = parseCursorText(await readFileOrEmpty(this.cursorFile));
    if (persisted !== null) return persisted + 1;
    const entries = await this.readEntries();
    return entries.reduce((max, entry) => Math.max(max, entry.cursor), 0) + 1;
  }

  private async readEntries(): Promise<MemoryHistoryEntry[]> {
    const text = await readFileOrEmpty(this.historyFile);
    const entries: MemoryHistoryEntry[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<MemoryHistoryEntry>;
        if (isHistoryEntry(parsed)) entries.push(parsed);
      } catch {
        continue;
      }
    }
    return entries;
  }

  private async writeEntries(entries: MemoryHistoryEntry[]): Promise<void> {
    await fs.mkdir(this.memoryDir, { recursive: true });
    const content = entries.map((entry) => JSON.stringify(entry)).join('\n');
    const tmp = `${this.historyFile}.tmp`;
    await fs.writeFile(tmp, content ? `${content}\n` : '', 'utf8');
    await fs.rename(tmp, this.historyFile);
  }
}

export function formatTurns(turns: Turn[]): string {
  return turns
    .filter((turn) => turn.content || turn.toolCalls?.length)
    .map((turn) => {
      const tools = turn.toolCalls?.length ? ` [tools: ${turn.toolCalls.map((call) => call.name).join(', ')}]` : '';
      return `[${new Date(turn.timestamp).toISOString()}] ${turn.role.toUpperCase()}${tools}: ${turn.content}`;
    })
    .join('\n');
}

function isHistoryEntry(value: Partial<MemoryHistoryEntry>): value is MemoryHistoryEntry {
  return Number.isInteger(value.cursor) && typeof value.timestamp === 'string' && typeof value.content === 'string';
}

function parseCursorText(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

function stripThink(text: string): string {
  return text
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<think[\s\S]*$/gi, '')
    .replace(/<\|?channel\|?>/gi, '')
    .trim();
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

async function writeFileEnsured(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content, 'utf8');
}
