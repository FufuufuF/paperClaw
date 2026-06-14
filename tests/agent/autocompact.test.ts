import { join } from 'node:path';
import {
  AutoCompact,
  Consolidator,
  createNewSession,
  FileSessionStore,
  MemoryStore,
  SessionManager,
  type Turn,
} from '../../packages/core/src/index.js';
import { assert, MockLLM, withTempDir } from '../fixtures/index.js';

function user(content: string, timestamp = Date.now()): Turn {
  return { role: 'user', content, timestamp, tokenEstimate: 1 };
}

function assistant(content: string, timestamp = Date.now()): Turn {
  return { role: 'assistant', content, timestamp, tokenEstimate: 1 };
}

async function testAutoCompactArchivesExpiredSession(): Promise<void> {
  await withTempDir(async (dir) => {
    const llm = new MockLLM();
    const memory = new MemoryStore(join(dir, 'store'));
    const sessionStore = new FileSessionStore(join(dir, 'sessions'));
    const sessions = new SessionManager(sessionStore);
    const consolidator = new Consolidator({ store: memory, llm, sessions });
    const auto = new AutoCompact({
      sessions,
      consolidator,
      idleCompactAfterMinutes: 5,
      recentSuffixTurns: 2,
      now: () => new Date('2026-01-01T01:00:00.000Z'),
    });

    const session = createNewSession('cli:default');
    session.metadata.lastActiveAt = '2026-01-01T00:00:00.000Z';
    session.turns.push(user('old'), assistant('old reply'), user('recent'), assistant('recent reply'));
    await sessionStore.save(session);
    llm.enqueue({
      text: JSON.stringify({
        sessionSummary: 'Summary for current session',
        historyFacts: '- Durable fact',
      }),
      usage: { input: 10, output: 4 },
    });

    const pending: Array<() => Promise<void>> = [];
    await auto.checkExpired((task) => pending.push(task));
    assert(pending.length === 1, 'expired session is scheduled');
    await pending[0]!();

    const saved = await sessions.getOrCreate('cli:default');
    const entries = await memory.readUnprocessedHistory(0);
    const prepared = await auto.prepareSession(saved);

    assert(saved.turns.length === 4, 'autocompact preserves persisted turns');
    assert(saved.metadata._compact?.sessionSummary === 'Summary for current session', 'summary persisted');
    assert(entries.length === 1 && entries[0]!.content.includes('Durable fact'), 'history facts persisted');
    assert(prepared.summary === 'Summary for current session', 'prepareSession exposes compact summary');
  });
}

async function testAutoCompactSkipsActiveSession(): Promise<void> {
  await withTempDir(async (dir) => {
    const llm = new MockLLM();
    const memory = new MemoryStore(join(dir, 'store'));
    const sessionStore = new FileSessionStore(join(dir, 'sessions'));
    const sessions = new SessionManager(sessionStore);
    const auto = new AutoCompact({
      sessions,
      consolidator: new Consolidator({ store: memory, llm, sessions }),
      idleCompactAfterMinutes: 5,
      now: () => new Date('2026-01-01T01:00:00.000Z'),
    });
    const session = createNewSession('cli:default');
    session.metadata.lastActiveAt = '2026-01-01T00:00:00.000Z';
    session.turns.push(user('old'), assistant('old reply'));
    await sessionStore.save(session);

    const pending: Array<() => Promise<void>> = [];
    await auto.checkExpired((task) => pending.push(task), ['cli:default']);
    assert(pending.length === 0, 'active session is skipped');
  });
}

async function main(): Promise<void> {
  await testAutoCompactArchivesExpiredSession();
  await testAutoCompactSkipsActiveSession();
  console.log('✓ autocompact tests passed.');
}

void main();
