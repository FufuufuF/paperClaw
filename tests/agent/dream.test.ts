import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Dream, MemoryStore } from '../../packages/core/src/index.js';
import { assert, MockLLM, withTempDir } from '../fixtures/index.js';

async function testDreamUpdatesMemoryAndAdvancesCursor(): Promise<void> {
  await withTempDir(async (dir) => {
    const storeDir = join(dir, 'store');
    const store = new MemoryStore(storeDir);
    await store.writeMemory('# Memory\n');
    await store.appendHistory('- User prefers concise implementation summaries');

    const llm = new MockLLM();
    llm.enqueue(
      {
        text: '[MEMORY] User prefers concise implementation summaries',
        usage: { input: 10, output: 4 },
      },
      {
        text: 'editing memory',
        toolCalls: [{
          id: 'edit-1',
          name: 'edit_file',
          arguments: JSON.stringify({
            path: 'memory/MEMORY.md',
            oldText: '# Memory\n',
            newText: '# Memory\n- User prefers concise implementation summaries.\n',
          }),
        }],
        usage: { input: 10, output: 4 },
      },
      { text: 'done', usage: { input: 10, output: 2 } },
    );

    const result = await new Dream({ store, llm, storeDir }).run();
    const memory = await readFile(join(storeDir, 'memory', 'MEMORY.md'), 'utf8');

    assert(result.completed === true, 'dream completes');
    assert(result.processed === 1, 'dream processes one history entry');
    assert((await store.getLastDreamCursor()) === 1, 'dream advances cursor on completion');
    assert(memory.includes('concise implementation'), 'dream tool edits memory file');
  });
}

async function testDreamDoesNotAdvanceCursorOnIncompleteRun(): Promise<void> {
  await withTempDir(async (dir) => {
    const storeDir = join(dir, 'store');
    const store = new MemoryStore(storeDir);
    await store.appendHistory('- Durable fact');
    const llm = new MockLLM();
    llm.enqueue(
      { text: '[MEMORY] Durable fact', usage: { input: 10, output: 4 } },
      {
        text: 'still working',
        toolCalls: [{
          id: 'missing-old-text',
          name: 'edit_file',
          arguments: JSON.stringify({
            path: 'memory/MEMORY.md',
            oldText: 'does not exist',
            newText: 'replacement',
          }),
        }],
        usage: { input: 10, output: 4 },
      },
    );

    const result = await new Dream({ store, llm, storeDir, maxIterations: 1 }).run();
    assert(result.completed === false, 'dream reports incomplete run');
    assert((await store.getLastDreamCursor()) === 0, 'dream does not advance cursor when incomplete');
  });
}

async function main(): Promise<void> {
  await testDreamUpdatesMemoryAndAdvancesCursor();
  await testDreamDoesNotAdvanceCursorOnIncompleteRun();
  console.log('✓ dream tests passed.');
}

void main();
