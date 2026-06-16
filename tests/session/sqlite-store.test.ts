import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createNewSession,
  closePaperClawDatabase,
  migrateLegacySessions,
  openPaperClawDatabase,
  SqliteSessionStore,
  type Turn,
} from '../../packages/core/src/index.js';
import { assert, withTempDir } from '../fixtures/index.js';

function user(content: string, timestamp = Date.now()): Turn {
  return { role: 'user', content, timestamp, tokenEstimate: 1 };
}

async function testSaveLoadListDelete(): Promise<void> {
  await withTempDir(async (dir) => {
    const db = await openPaperClawDatabase(join(dir, 'paperclaw.sqlite'));
    try {
      const store = new SqliteSessionStore(db);
      const session = createNewSession('cli:default', {
        sessionName: 'Default',
        uid: 'abc123',
        channel: 'cli',
      });
      session.turns.push(user('hello', 1));
      session.metadata.totalUsage.input = 10;
      session.metadata._compact = {
        sessionSummary: 'summary',
        summarizedThroughTurn: 1,
        lastCompactedAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
      };

      await store.save(session);
      const loaded = await store.load('cli:default');
      assert(loaded?.turns[0]?.content === 'hello', 'sqlite store loads turns');
      assert(loaded.metadata.sessionName === 'Default', 'sqlite store keeps session metadata');
      assert(loaded.metadata._compact?.sessionSummary === 'summary', 'sqlite store keeps compact metadata');

      const listed = await store.list();
      assert(listed.length === 1, 'sqlite store lists sessions');
      assert(listed[0]!.preview === 'hello', 'sqlite store builds preview');

      await store.delete('cli:default');
      assert((await store.load('cli:default')) === null, 'sqlite store deletes sessions');
    } finally {
      closePaperClawDatabase(db);
    }
  });
}

async function testLegacySessionMigration(): Promise<void> {
  await withTempDir(async (dir) => {
    const sessionsDir = join(dir, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const legacy = createNewSession('cli:legacy');
    legacy.turns.push(user('from json', 1));
    await writeFile(join(sessionsDir, 'cli_legacy.json'), JSON.stringify(legacy), 'utf8');
    await writeFile(join(sessionsDir, 'broken.json'), '{broken', 'utf8');

    const db = await openPaperClawDatabase(join(dir, 'paperclaw.sqlite'));
    try {
      const store = new SqliteSessionStore(db);
      const result = await migrateLegacySessions({ db, sessionsDir, store });
      const loaded = await store.load('cli:legacy');

      assert(result.imported === 1, 'imports valid legacy session');
      assert(result.failed === 1, 'records corrupt legacy session');
      assert(loaded?.turns[0]?.content === 'from json', 'legacy session is readable from sqlite');

      const again = await migrateLegacySessions({ db, sessionsDir, store });
      assert(again.skipped >= 1, 'second migration skips imported session');
    } finally {
      closePaperClawDatabase(db);
    }
  });
}

async function main(): Promise<void> {
  await testSaveLoadListDelete();
  await testLegacySessionMigration();
  console.log('✓ sqlite session store tests passed.');
}

void main();
