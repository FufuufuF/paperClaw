import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryStore, type Turn } from '../../packages/core/src/index.js';
import { assert, withTempDir } from '../fixtures/index.js';

function user(content: string, timestamp = Date.UTC(2026, 0, 1)): Turn {
  return { role: 'user', content, timestamp, tokenEstimate: 1 };
}

async function testMemoryFiles(): Promise<void> {
  await withTempDir(async (dir) => {
    const store = new MemoryStore(dir);

    await store.writeMemory('facts');
    await store.writeSoul('soul');
    await store.writeUser('user');

    assert((await store.readMemory()) === 'facts', 'reads MEMORY.md');
    assert((await store.readSoul()) === 'soul', 'reads SOUL.md');
    assert((await store.readUser()) === 'user', 'reads USER.md');
    assert((await store.getMemoryContext()).includes('## Long-term Memory'), 'builds memory context');
  });
}

async function testHistoryCursorAndBadLines(): Promise<void> {
  await withTempDir(async (dir) => {
    const store = new MemoryStore(dir);

    const first = await store.appendHistory('one');
    const second = await store.appendHistory('<think>hidden</think>two');
    await writeFile(join(dir, 'memory', 'history.jsonl'), 'broken\n', { flag: 'a' });

    assert(first === 1, 'first history cursor is 1');
    assert(second === 2, 'second history cursor is 2');

    const entries = await store.readUnprocessedHistory(1);
    assert(entries.length === 1, 'reads only unprocessed valid entries');
    assert(entries[0]!.content === 'two', 'strips think blocks before persistence');
  });
}

async function testDreamCursor(): Promise<void> {
  await withTempDir(async (dir) => {
    const store = new MemoryStore(dir);

    assert((await store.getLastDreamCursor()) === 0, 'missing dream cursor defaults to 0');
    await store.setLastDreamCursor(7);
    assert((await store.getLastDreamCursor()) === 7, 'reads dream cursor');
  });
}

async function testRawArchive(): Promise<void> {
  await withTempDir(async (dir) => {
    const store = new MemoryStore(dir);
    const cursor = await store.rawArchive([user('raw content')]);

    assert(cursor === 1, 'raw archive appends history');
    const history = await readFile(join(dir, 'memory', 'history.jsonl'), 'utf8');
    assert(history.includes('[RAW] 1 turns'), 'raw archive labels fallback entry');
    assert(history.includes('raw content'), 'raw archive includes turn content');
  });
}

async function testCompactHistory(): Promise<void> {
  await withTempDir(async (dir) => {
    const store = new MemoryStore(dir, { maxHistoryEntries: 2 });
    await store.appendHistory('one');
    await store.appendHistory('two');
    await store.appendHistory('three');
    await store.compactHistory();

    const entries = await store.readUnprocessedHistory(0);
    assert(entries.length === 2, 'compact keeps configured history tail');
    assert(entries[0]!.content === 'two', 'compact drops oldest entry');
  });
}

async function main(): Promise<void> {
  await testMemoryFiles();
  await testHistoryCursorAndBadLines();
  await testDreamCursor();
  await testRawArchive();
  await testCompactHistory();
  console.log('✓ memory store tests passed.');
}

void main();
