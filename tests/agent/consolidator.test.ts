import { join } from 'node:path';
import {
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

function makeConsolidator(dir: string): {
  llm: MockLLM;
  memory: MemoryStore;
  sessions: SessionManager;
  consolidator: Consolidator;
} {
  const llm = new MockLLM();
  const memory = new MemoryStore(join(dir, 'store'));
  const sessions = new SessionManager(new FileSessionStore(join(dir, 'sessions')));
  return {
    llm,
    memory,
    sessions,
    consolidator: new Consolidator({ store: memory, llm, sessions }),
  };
}

async function testArchiveWritesSummary(): Promise<void> {
  await withTempDir(async (dir) => {
    const h = makeConsolidator(dir);
    h.llm.enqueue({
      text: JSON.stringify({
        sessionSummary: 'Current task: keep reviews small',
        historyFacts: '- User prefers small review slices',
      }),
      usage: { input: 10, output: 4 },
    });

    const result = await h.consolidator.consolidate([user('keep reviews small')]);
    const entries = await h.memory.readUnprocessedHistory(0);

    assert(result?.sessionSummary === 'Current task: keep reviews small', 'consolidate returns session summary');
    assert(result?.historyFacts === '- User prefers small review slices', 'consolidate returns history facts');
    assert(entries.length === 1, 'archive writes one history entry');
    assert(entries[0]!.content.includes('small review'), 'history contains summary');
    assert(h.llm.receivedMessages[0]!.messages[0]!.content.includes('keep reviews small'), 'LLM sees formatted turns');
  });
}

async function testArchiveFallsBackToRaw(): Promise<void> {
  await withTempDir(async (dir) => {
    const h = makeConsolidator(dir);

    const summary = await h.consolidator.archive([user('raw fallback')]);
    const entries = await h.memory.readUnprocessedHistory(0);

    assert(summary === null, 'archive returns null on LLM failure');
    assert(entries.length === 1, 'raw fallback writes history');
    assert(entries[0]!.content.includes('[RAW] 1 turns'), 'raw fallback labels history entry');
    assert(entries[0]!.content.includes('raw fallback'), 'raw fallback preserves turn content');
  });
}

async function testCompactIdleSession(): Promise<void> {
  await withTempDir(async (dir) => {
    const h = makeConsolidator(dir);
    const session = createNewSession('cli:default');
    session.turns.push(user('old 1'), assistant('old 2'), user('new 1'), assistant('new 2'));
    await h.sessions.save(session);
    h.llm.enqueue({
      text: JSON.stringify({
        sessionSummary: 'Session summary: old topic handled',
        historyFacts: '- Archived old topic',
      }),
      usage: { input: 10, output: 4 },
    });

    const result = await h.consolidator.compactIdleSession('cli:default', 2);
    const saved = await h.sessions.getOrCreate('cli:default');
    const entries = await h.memory.readUnprocessedHistory(0);

    assert(result?.sessionSummary === 'Session summary: old topic handled', 'compact returns session summary');
    assert(saved.turns.length === 4, 'compact preserves full transcript');
    assert(saved.turns[0]!.content === 'old 1', 'compact does not truncate persisted turns');
    assert(saved.metadata._compact?.sessionSummary === 'Session summary: old topic handled', 'compact stores session summary metadata');
    assert(saved.metadata._compact?.summarizedThroughTurn === 2, 'compact records replay boundary');
    assert(entries.length === 1, 'compact archives removed prefix');
  });
}

async function main(): Promise<void> {
  await testArchiveWritesSummary();
  await testArchiveFallsBackToRaw();
  await testCompactIdleSession();
  console.log('✓ consolidator tests passed.');
}

void main();
