import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  closePaperClawDatabase,
  MemoryStore,
  migrateLegacyMemoryHistory,
  openPaperClawDatabase,
  SqliteMemoryHistoryStore,
  type Turn,
} from '../../packages/core/src/index.js';
import { assert, withTempDir } from '../fixtures/index.js';

function user(content: string, timestamp = Date.UTC(2026, 0, 1)): Turn {
  return { role: 'user', content, timestamp, tokenEstimate: 1 };
}

async function testSqliteHistoryKeepsMemoryFiles(): Promise<void> {
  await withTempDir(async (dir) => {
    const db = await openPaperClawDatabase(join(dir, 'paperclaw.sqlite'));
    try {
      const storeDir = join(dir, 'store');
      const historyStore = new SqliteMemoryHistoryStore(db, { maxHistoryEntries: 2 });
      const store = new MemoryStore(storeDir, { historyStore });

      await store.writeMemory('facts');
      const first = await store.appendHistory('one');
      const second = await store.appendHistory('<think>hidden</think>two');
      await store.appendHistory('three');
      await store.compactHistory();

      assert(first === 1, 'sqlite history starts cursor at 1');
      assert(second === 2, 'sqlite history increments cursor');
      assert((await store.readMemory()) === 'facts', 'memory document remains file-backed');
      assert((await readFile(join(storeDir, 'memory', 'MEMORY.md'), 'utf8')) === 'facts', 'memory file exists on disk');

      const entries = await store.readUnprocessedHistory(0);
      assert(entries.length === 2, 'sqlite compact keeps tail');
      assert(entries[0]!.content === 'two', 'sqlite history strips think blocks');
      assert(entries[1]!.content === 'three', 'sqlite history keeps newest entry');
    } finally {
      closePaperClawDatabase(db);
    }
  });
}

async function testDreamCursorAndRawArchive(): Promise<void> {
  await withTempDir(async (dir) => {
    const db = await openPaperClawDatabase(join(dir, 'paperclaw.sqlite'));
    try {
      const store = new MemoryStore(join(dir, 'store'), {
        historyStore: new SqliteMemoryHistoryStore(db),
      });
      assert((await store.getLastDreamCursor()) === 0, 'missing sqlite dream cursor defaults to 0');
      await store.setLastDreamCursor(7);
      assert((await store.getLastDreamCursor()) === 7, 'sqlite dream cursor persists');

      await store.rawArchive([user('raw content')]);
      const entries = await store.readUnprocessedHistory(0);
      assert(entries[0]!.content.includes('[RAW] 1 turns'), 'raw archive writes sqlite history');
      assert(entries[0]!.content.includes('raw content'), 'raw archive includes turn content');
    } finally {
      closePaperClawDatabase(db);
    }
  });
}

async function testLegacyMemoryHistoryMigration(): Promise<void> {
  await withTempDir(async (dir) => {
    const memoryDir = join(dir, 'store', 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, 'history.jsonl'),
      [
        JSON.stringify({ cursor: 1, timestamp: '2026-01-01T00:00:00.000Z', content: 'one' }),
        'broken',
        JSON.stringify({ cursor: 2, timestamp: '2026-01-01T00:01:00.000Z', content: 'two' }),
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(memoryDir, '.cursor'), '2', 'utf8');
    await writeFile(join(memoryDir, '.dream_cursor'), '1', 'utf8');

    const db = await openPaperClawDatabase(join(dir, 'paperclaw.sqlite'));
    try {
      const result = await migrateLegacyMemoryHistory({ db, memoryDir });
      const store = new MemoryStore(join(dir, 'store'), {
        historyStore: new SqliteMemoryHistoryStore(db),
      });
      const entries = await store.readUnprocessedHistory(0);

      assert(result.imported === 3, 'imports history and cursor files');
      assert(entries.map((item) => item.content).join(',') === 'one,two', 'imports valid history jsonl lines');
      assert((await store.appendHistory('three')) === 3, 'continues from migrated history cursor');
      assert((await store.getLastDreamCursor()) === 1, 'imports dream cursor');
    } finally {
      closePaperClawDatabase(db);
    }
  });
}

async function main(): Promise<void> {
  await testSqliteHistoryKeepsMemoryFiles();
  await testDreamCursorAndRawArchive();
  await testLegacyMemoryHistoryMigration();
  console.log('✓ sqlite memory history tests passed.');
}

void main();
