import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

export interface CronTaskConfig {
  id: string;
  intervalMinutes: number;
  enabled?: boolean;
}

export interface CronTaskState {
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  lastSummary?: string;
  runCount: number;
  seenIds: string[];
}

export interface CronStateFile {
  version: 1;
  tasks: Record<string, CronTaskState>;
}

export interface CronRunContext {
  task: CronTaskConfig;
  state: CronTaskState;
  now: Date;
  seenIds: Set<string>;
}

export interface CronTaskResult {
  summary: string;
  dedupeIds?: string[];
  data?: unknown;
}

export type CronTaskHandler = (ctx: CronRunContext) => Promise<CronTaskResult>;

export interface CronServiceOpts {
  statePath: string;
  tasks: CronTaskConfig[];
  tickMs?: number;
  maxSeenIds?: number;
  now?: () => Date;
}

/**
 * Persistent cron runner. It owns only scheduling, locking, and dedupe state;
 * paper-specific work stays in search/reader/CLI handlers.
 */
export class CronService {
  private timer: NodeJS.Timeout | null = null;
  private readonly locks = new Set<string>();
  private readonly taskById: Map<string, CronTaskConfig>;
  private readonly tickMs: number;
  private readonly maxSeenIds: number;
  private readonly now: () => Date;

  constructor(private readonly opts: CronServiceOpts) {
    this.taskById = new Map(opts.tasks.map((task) => [task.id, task]));
    this.tickMs = opts.tickMs ?? 60_000;
    this.maxSeenIds = opts.maxSeenIds ?? 1000;
    this.now = opts.now ?? (() => new Date());
  }

  async start(handlers: Record<string, CronTaskHandler>): Promise<void> {
    if (this.timer) return;
    await this.runDue(handlers);
    this.timer = setInterval(() => {
      void this.runDue(handlers);
    }, this.tickMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runDue(handlers: Record<string, CronTaskHandler>): Promise<CronTaskResult[]> {
    const out: CronTaskResult[] = [];
    for (const task of this.taskById.values()) {
      if (task.enabled === false) continue;
      if (!this.isDue(task, await this.getTaskState(task.id))) continue;
      const handler = handlers[task.id];
      if (!handler) continue;
      out.push(await this.trigger(task.id, handler, { force: false }));
    }
    return out;
  }

  async trigger(
    taskId: string,
    handler: CronTaskHandler,
    opts: { force?: boolean } = {},
  ): Promise<CronTaskResult> {
    const task = this.taskById.get(taskId);
    if (!task) throw new Error(`CronService: unknown task "${taskId}"`);
    if (this.locks.has(taskId)) {
      return { summary: `Cron task "${taskId}" is already running.` };
    }

    const stateFile = await this.loadState();
    const state = stateFile.tasks[taskId] ?? emptyTaskState();
    if (!opts.force && !this.isDue(task, state)) {
      return { summary: `Cron task "${taskId}" is not due yet.`, data: { skipped: true } };
    }

    this.locks.add(taskId);
    const now = this.now();
    state.lastStartedAt = now.toISOString();
    stateFile.tasks[taskId] = state;
    await this.saveState(stateFile);

    try {
      const result = await handler({
        task,
        state,
        now,
        seenIds: new Set(state.seenIds),
      });
      state.lastCompletedAt = this.now().toISOString();
      state.lastSummary = result.summary;
      state.runCount += 1;
      state.seenIds = mergeSeenIds(state.seenIds, result.dedupeIds ?? [], this.maxSeenIds);
      delete state.lastError;
      delete state.lastErrorAt;
      await this.saveState(stateFile);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.lastError = msg;
      state.lastErrorAt = this.now().toISOString();
      await this.saveState(stateFile);
      throw err;
    } finally {
      this.locks.delete(taskId);
    }
  }

  async getTaskState(taskId: string): Promise<CronTaskState> {
    const state = await this.loadState();
    return state.tasks[taskId] ?? emptyTaskState();
  }

  async loadState(): Promise<CronStateFile> {
    try {
      const raw = await fs.readFile(this.opts.statePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CronStateFile>;
      return {
        version: 1,
        tasks: normalizeTasks(parsed.tasks),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, tasks: {} };
      }
      throw err;
    }
  }

  private async saveState(state: CronStateFile): Promise<void> {
    await fs.mkdir(dirname(this.opts.statePath), { recursive: true });
    const tmp = `${this.opts.statePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, this.opts.statePath);
  }

  private isDue(task: CronTaskConfig, state: CronTaskState): boolean {
    if (!state.lastCompletedAt) return true;
    const last = Date.parse(state.lastCompletedAt);
    if (!Number.isFinite(last)) return true;
    const elapsedMs = this.now().getTime() - last;
    return elapsedMs >= task.intervalMinutes * 60_000;
  }
}

function emptyTaskState(): CronTaskState {
  return { runCount: 0, seenIds: [] };
}

function normalizeTasks(raw: unknown): Record<string, CronTaskState> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, CronTaskState> = {};
  for (const [id, value] of Object.entries(raw as Record<string, Partial<CronTaskState>>)) {
    out[id] = {
      lastStartedAt: typeof value.lastStartedAt === 'string' ? value.lastStartedAt : undefined,
      lastCompletedAt: typeof value.lastCompletedAt === 'string' ? value.lastCompletedAt : undefined,
      lastErrorAt: typeof value.lastErrorAt === 'string' ? value.lastErrorAt : undefined,
      lastError: typeof value.lastError === 'string' ? value.lastError : undefined,
      lastSummary: typeof value.lastSummary === 'string' ? value.lastSummary : undefined,
      runCount: typeof value.runCount === 'number' ? value.runCount : 0,
      seenIds: Array.isArray(value.seenIds)
        ? value.seenIds.filter((item): item is string => typeof item === 'string')
        : [],
    };
  }
  return out;
}

function mergeSeenIds(existing: string[], additions: string[], max: number): string[] {
  const merged = Array.from(new Set([...existing, ...additions.filter(Boolean)]));
  return merged.slice(Math.max(0, merged.length - max));
}
