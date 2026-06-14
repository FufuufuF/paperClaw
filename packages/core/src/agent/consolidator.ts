import type { LLMClient } from '../providers/base.js';
import {
  retainRecentLegalSuffix,
  type Session,
  type SessionManager,
  type Turn,
} from '../session/manager.js';
import { renderTemplate } from '../utils/templates.js';
import { formatTurns, type MemoryStore } from './memory.js';

export interface ConsolidatorOpts {
  store: MemoryStore;
  llm: LLMClient;
  sessions: SessionManager;
  maxArchiveInputChars?: number;
  maxSummaryChars?: number;
  maxCompletionTokens?: number;
}

export interface LastSessionSummary {
  text: string;
  lastActive: string;
}

export interface ConsolidationResult {
  sessionSummary: string | null;
  historyFacts: string | null;
}

export interface SessionCompactionMetadata {
  sessionSummary: string;
  historyFacts?: string;
  summarizedThroughTurn: number;
  lastCompactedAt: string;
  lastActiveAt: string;
}

const DEFAULT_ARCHIVE_INPUT_MAX_CHARS = 64_000;
const DEFAULT_SUMMARY_MAX_CHARS = 8_000;
const DEFAULT_MAX_COMPLETION_TOKENS = 2048;

export class Consolidator {
  private readonly store: MemoryStore;
  private readonly llm: LLMClient;
  private readonly sessions: SessionManager;
  private readonly maxArchiveInputChars: number;
  private readonly maxSummaryChars: number;
  private readonly maxCompletionTokens: number;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(opts: ConsolidatorOpts) {
    this.store = opts.store;
    this.llm = opts.llm;
    this.sessions = opts.sessions;
    this.maxArchiveInputChars = opts.maxArchiveInputChars ?? DEFAULT_ARCHIVE_INPUT_MAX_CHARS;
    this.maxSummaryChars = opts.maxSummaryChars ?? DEFAULT_SUMMARY_MAX_CHARS;
    this.maxCompletionTokens = opts.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
  }

  async consolidate(turns: Turn[], opts: { previousSessionSummary?: string } = {}): Promise<ConsolidationResult | null> {
    if (turns.length === 0) return null;
    try {
      const content = truncate(buildConsolidationInput(turns, opts.previousSessionSummary), this.maxArchiveInputChars);
      const response = await this.llm.chat({
        system: buildConsolidationPrompt(),
        messages: [{ role: 'user', content }],
        responseFormat: 'json_object',
        maxTokens: this.maxCompletionTokens,
        temperature: 0,
      });
      if (response.finishReason === 'error') {
        throw new Error(response.text || 'LLM returned error');
      }
      const result = parseConsolidationResult(response.text ?? '');
      const sessionSummary = cleanOutput(result.sessionSummary);
      const historyFacts = cleanOutput(result.historyFacts);
      if (!sessionSummary && !historyFacts) return { sessionSummary: null, historyFacts: null };
      if (historyFacts) {
        await this.store.appendHistory(truncate(historyFacts, this.maxSummaryChars), { maxChars: this.maxSummaryChars });
      }
      return {
        sessionSummary: sessionSummary ? truncate(sessionSummary, this.maxSummaryChars) : null,
        historyFacts: historyFacts ? truncate(historyFacts, this.maxSummaryChars) : null,
      };
    } catch {
      await this.store.rawArchive(turns);
      return null;
    }
  }

  async archive(turns: Turn[]): Promise<string | null> {
    const result = await this.consolidate(turns);
    return result?.historyFacts ?? null;
  }

  async compactIdleSession(sessionId: string, maxSuffix = 8): Promise<ConsolidationResult | null> {
    return await this.withLock(sessionId, async () => {
      const session = await this.sessions.getOrCreate(sessionId);
      const suffix = retainRecentLegalSuffix(session.turns, maxSuffix);
      const suffixStart = suffix.length > 0 ? session.turns.indexOf(suffix[0]!) : session.turns.length;
      const summarizedThrough = session.metadata._compact?.summarizedThroughTurn ?? 0;
      const archiveTurns = session.turns.slice(Math.max(0, summarizedThrough), suffixStart);
      if (archiveTurns.length === 0) return null;

      const lastActiveAt = session.metadata.lastActiveAt;
      const result = await this.consolidate(archiveTurns, {
        previousSessionSummary: session.metadata._compact?.sessionSummary,
      });
      if (result?.sessionSummary || result?.historyFacts) {
        const sessionSummary = result.sessionSummary
          ?? session.metadata._compact?.sessionSummary
          ?? result.historyFacts
          ?? '';
        session.metadata._compact = {
          sessionSummary,
          historyFacts: result.historyFacts ?? undefined,
          summarizedThroughTurn: suffixStart,
          lastCompactedAt: new Date().toISOString(),
          lastActiveAt,
        };
        session.metadata._lastSummary = {
          text: sessionSummary,
          lastActive: lastActiveAt,
        };
        await this.sessions.save(session);
      }
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
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }
}

export function getLastSessionSummary(session: Session): LastSessionSummary | undefined {
  const compact = session.metadata._compact;
  if (compact?.sessionSummary) {
    return { text: compact.sessionSummary, lastActive: compact.lastActiveAt };
  }
  return session.metadata._lastSummary;
}

export function getSessionCompaction(session: Session): SessionCompactionMetadata | undefined {
  return session.metadata._compact;
}

export function sessionReplayView(session: Session): Session {
  const compact = session.metadata._compact;
  if (!compact?.sessionSummary) return session;
  const summarizedThroughTurn = Math.min(Math.max(0, compact.summarizedThroughTurn), session.turns.length);
  return {
    ...session,
    turns: session.turns.slice(summarizedThroughTurn),
    metadata: { ...session.metadata },
  };
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (truncated)`;
}

function buildConsolidationPrompt(): string {
  return [
    'You are compacting an agent session without deleting the source transcript.',
    '',
    'Return one JSON object with exactly these string fields:',
    '- "sessionSummary": current-session continuity only. Include task state, unresolved work, temporary decisions, tool results, and context needed to continue this same session.',
    '- "historyFacts": cross-session long-term memory candidates only. Use the rules below.',
    '',
    renderTemplate('agent/consolidator_archive.md'),
    '',
    'Use "(nothing)" for an empty field. No markdown fence, no commentary.',
  ].join('\n');
}

function buildConsolidationInput(turns: Turn[], previousSummary?: string): string {
  const parts = [];
  if (previousSummary?.trim()) {
    parts.push(`Previous session summary:\n${previousSummary.trim()}`);
  }
  parts.push(`Conversation turns:\n${formatTurns(turns)}`);
  return parts.join('\n\n');
}

function parseConsolidationResult(text: string): ConsolidationResult {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed) as Partial<Record<'sessionSummary' | 'historyFacts', unknown>>;
    return {
      sessionSummary: typeof parsed.sessionSummary === 'string' ? parsed.sessionSummary : null,
      historyFacts: typeof parsed.historyFacts === 'string' ? parsed.historyFacts : null,
    };
  } catch {
    const value = trimmed || '(nothing)';
    return { sessionSummary: value, historyFacts: value };
  }
}

function cleanOutput(text: string | null): string | null {
  const trimmed = text?.trim();
  if (!trimmed || trimmed === '(nothing)') return null;
  return trimmed;
}
