import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CronService,
  type CronTaskHandler,
} from '../../packages/core/src/index.js';
import { assert, withTempDir } from '../fixtures/index.js';

async function testCronPersistsStateAndDedupe(): Promise<void> {
  await withTempDir(async (dir) => {
    let now = new Date('2026-06-07T00:00:00.000Z');
    const service = new CronService({
      statePath: join(dir, 'cron-state.json'),
      tasks: [{ id: 'paper-recommendation', intervalMinutes: 60 }],
      now: () => now,
    });
    let runs = 0;
    const handler: CronTaskHandler = async (ctx) => {
      runs += 1;
      assert(ctx.seenIds.size === 0, 'first cron run starts with no seen ids');
      return { summary: 'first run', dedupeIds: ['2401.1', '2401.2'] };
    };

    const first = await service.runDue({ 'paper-recommendation': handler });
    assert(first.length === 1, 'due cron task runs once');
    assert(runs === 1, 'handler ran once');

    const skipped = await service.runDue({ 'paper-recommendation': handler });
    assert(skipped.length === 0, 'not-due cron task does not run');

    const forced = await service.trigger('paper-recommendation', async (ctx) => {
      assert(ctx.seenIds.has('2401.1'), 'forced run receives persisted seen ids');
      return { summary: 'forced run', dedupeIds: ['2401.3'] };
    }, { force: true });
    assert(forced.summary === 'forced run', 'force trigger returns handler summary');

    const raw = JSON.parse(await readFile(join(dir, 'cron-state.json'), 'utf8')) as {
      tasks: Record<string, { runCount: number; seenIds: string[] }>;
    };
    assert(raw.tasks['paper-recommendation']!.runCount === 2, 'cron runCount persisted');
    assert(raw.tasks['paper-recommendation']!.seenIds.join(',') === '2401.1,2401.2,2401.3', 'seen ids merged');

    now = new Date('2026-06-07T01:01:00.000Z');
    await service.runDue({
      'paper-recommendation': async (ctx) => {
        assert(ctx.seenIds.has('2401.3'), 'due run receives latest seen ids');
        return { summary: 'second due run' };
      },
    });
  });
}

async function testCronErrorState(): Promise<void> {
  await withTempDir(async (dir) => {
    const service = new CronService({
      statePath: join(dir, 'cron-state.json'),
      tasks: [{ id: 'paper-recommendation', intervalMinutes: 1 }],
    });
    try {
      await service.trigger('paper-recommendation', async () => {
        throw new Error('boom');
      }, { force: true });
    } catch {
      // expected
    }
    const state = await service.getTaskState('paper-recommendation');
    assert(state.lastError === 'boom', 'cron error persisted');
    assert(Boolean(state.lastErrorAt), 'cron error timestamp persisted');
  });
}

async function main(): Promise<void> {
  await testCronPersistsStateAndDedupe();
  await testCronErrorState();
  console.log('✓ cron service tests passed.');
}

void main().catch((err) => {
  console.error('✗ cron service tests failed:', err);
  process.exit(1);
});
