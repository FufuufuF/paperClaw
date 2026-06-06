import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createNewSession,
  FileSessionStore,
  retainRecentLegalSuffix,
  SessionManager,
  type Turn,
} from '../../packages/core/src/index.js';
import { assert, withTempDir } from '../fixtures/index.js';

function user(content: string, timestamp = Date.now()): Turn {
  return { role: 'user', content, timestamp, tokenEstimate: 1 };
}

function assistant(content: string, timestamp = Date.now()): Turn {
  return { role: 'assistant', content, timestamp, tokenEstimate: 1 };
}

function tool(content: string, timestamp = Date.now()): Turn {
  return { role: 'tool', content, timestamp, tokenEstimate: 1, toolCallId: 'call-1' };
}

async function testCorruptRecovery(): Promise<void> {
  await withTempDir(async (dir) => {
    const store = new FileSessionStore(join(dir, 'sessions'));
    await mkdir(join(dir, 'sessions'), { recursive: true });
    await writeFile(store.pathFor('cli:default'), '{broken json', 'utf8');

    const loaded = await store.load('cli:default');
    assert(loaded === null, 'corrupt session loads as null');

    const files = await readdir(join(dir, 'sessions'));
    assert(files.some((name) => name.includes('.corrupt.')), 'corrupt file moved aside');
  });
}

async function testLegalSuffix(): Promise<void> {
  const turns = [
    user('u1', 1),
    assistant('a1', 2),
    user('u2', 3),
    assistant('calls tool', 4),
    tool('tool result', 5),
    assistant('a2', 6),
    user('u3', 7),
  ];

  const suffix = retainRecentLegalSuffix(turns, 4);
  assert(suffix[0]?.role === 'user', 'suffix starts at user boundary');
  assert(suffix.at(-1)?.content === 'u3', 'suffix keeps newest turn');

  const recoveredUserSuffix = retainRecentLegalSuffix([user('u'), assistant('a'), tool('orphan'), assistant('tail')], 2);
  assert(recoveredUserSuffix[0]?.role === 'user', 'tight suffix recovers nearest user boundary');

  const orphanToolSuffix = retainRecentLegalSuffix([tool('orphan'), assistant('tail')], 10);
  assert(orphanToolSuffix[0]?.role === 'assistant', 'orphan leading tool result is dropped');
}

async function testManagerUpdateSerializes(): Promise<void> {
  await withTempDir(async (dir) => {
    const manager = SessionManager.fileBacked(join(dir, 'sessions'), {
      config: { maxMessages: 20 },
    });

    await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        manager.update('cli:default', async (session) => {
          session.turns.push(user(`u${idx}`));
        }),
      ),
    );

    const session = await manager.getOrCreate('cli:default');
    assert(session.turns.length === 5, `serialized updates keep all turns (got ${session.turns.length})`);
  });
}

async function testManagerSaveAppliesCap(): Promise<void> {
  await withTempDir(async (dir) => {
    const store = new FileSessionStore(join(dir, 'sessions'));
    const manager = new SessionManager(store, { config: { maxMessages: 3 } });
    const session = createNewSession('cli:default');
    session.turns.push(user('u1'), assistant('a1'), user('u2'), assistant('a2'), user('u3'));

    await manager.save(session);
    const saved = await store.load('cli:default');
    assert(saved !== null, 'session saved');
    assert(saved!.turns.length === 3, `session capped to 3 turns (got ${saved!.turns.length})`);
    assert(saved!.turns[0]!.role === 'user', 'saved suffix starts at user');
  });
}

async function main(): Promise<void> {
  await testCorruptRecovery();
  await testLegalSuffix();
  await testManagerUpdateSerializes();
  await testManagerSaveAppliesCap();
  console.log('✓ session manager tests passed.');
}

void main();
