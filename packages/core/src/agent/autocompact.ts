import type { Session, SessionManager } from '../session/manager.js';
import { getLastSessionSummary, type Consolidator } from './consolidator.js';

export interface AutoCompactOpts {
  sessions: SessionManager;
  consolidator: Consolidator;
  idleCompactAfterMinutes: number;
  recentSuffixTurns?: number;
  now?: () => Date;
}

export interface PreparedSession {
  session: Session;
  summary?: string;
}

export type BackgroundScheduler = (task: () => Promise<void>) => void;

const DEFAULT_RECENT_SUFFIX_TURNS = 8;

export class AutoCompact {
  private readonly sessions: SessionManager;
  private readonly consolidator: Consolidator;
  private readonly idleCompactAfterMinutes: number;
  private readonly recentSuffixTurns: number;
  private readonly now: () => Date;
  private readonly archiving = new Set<string>();
  private readonly summaries = new Map<string, { text: string; lastActive: string }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: AutoCompactOpts) {
    this.sessions = opts.sessions;
    this.consolidator = opts.consolidator;
    this.idleCompactAfterMinutes = opts.idleCompactAfterMinutes;
    this.recentSuffixTurns = opts.recentSuffixTurns ?? DEFAULT_RECENT_SUFFIX_TURNS;
    this.now = opts.now ?? (() => new Date());
  }

  isEnabled(): boolean {
    return this.idleCompactAfterMinutes > 0;
  }

  isExpired(lastActiveAt: string, now = this.now()): boolean {
    if (!this.isEnabled()) return false;
    const last = Date.parse(lastActiveAt);
    if (!Number.isFinite(last)) return false;
    return now.getTime() - last >= this.idleCompactAfterMinutes * 60_000;
  }

  async checkExpired(
    scheduleBackground: BackgroundScheduler = defaultScheduler,
    activeSessionIds: Iterable<string> = [],
  ): Promise<void> {
    if (!this.isEnabled()) return;
    const active = new Set(activeSessionIds);
    const listings = await this.sessions.list();
    for (const item of listings) {
      if (!item.id || active.has(item.id) || this.archiving.has(item.id)) continue;
      if (!this.isExpired(item.lastActiveAt)) continue;
      this.archiving.add(item.id);
      scheduleBackground(async () => {
        await this.archive(item.id);
      });
    }
  }

  async prepareSession(session: Session, id = session.id): Promise<PreparedSession> {
    const hot = this.summaries.get(id);
    if (hot) {
      this.summaries.delete(id);
      return { session, summary: hot.text };
    }
    const cold = getLastSessionSummary(session);
    return cold?.text ? { session, summary: cold.text } : { session };
  }

  start(opts: {
    intervalMs?: number;
    activeSessionIds?: () => Iterable<string>;
    scheduleBackground?: BackgroundScheduler;
  } = {}): void {
    if (this.timer || !this.isEnabled()) return;
    const intervalMs = opts.intervalMs ?? 60_000;
    const tick = () => {
      void this.checkExpired(
        opts.scheduleBackground,
        opts.activeSessionIds?.() ?? [],
      );
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async archive(id: string): Promise<void> {
    try {
      const result = await this.consolidator.compactIdleSession(id, this.recentSuffixTurns);
      const fresh = await this.sessions.getOrCreate(id);
      const summary = result?.sessionSummary ?? getLastSessionSummary(fresh)?.text;
      if (summary) {
        this.summaries.set(id, {
          text: summary,
          lastActive: fresh.metadata.lastActiveAt,
        });
      }
    } finally {
      this.archiving.delete(id);
    }
  }
}

function defaultScheduler(task: () => Promise<void>): void {
  void task();
}
