import { join } from 'node:path';
import {
  CommandRouter,
  createNewSession,
  CronService,
  ToolRegistry,
  type Tool,
} from '../../packages/core/src/index.js';
import {
  createPaperCronRunner,
  PAPER_RECOMMENDATION_TASK_ID,
  registerPaperCronCommand,
} from '../../packages/cli/src/commands/cron.js';
import { PaperSearchState, type PaperSearchResult } from '../../packages/search/src/index.js';
import { assert, withTempDir } from '../fixtures/index.js';

function fakeSearchResult(ids: string[]): PaperSearchResult {
  return {
    query: 'cron inferred query',
    mode: 'cron',
    trace: {
      query: 'cron inferred query',
      mode: 'cron',
      terms: ['agent harness'],
      candidateCount: ids.length,
      triageCounts: { recommend: ids.length, maybe: 0, skip: 0 },
    },
    profile: {
      path: '/tmp/profile.md',
      readCount: 3,
      personalization: 'weak',
    },
    shortlist: ids.map((id, idx) => ({
      index: idx + 1,
      arxiv_id: id,
      title: `Paper ${id}`,
      authors: ['A'],
      year: 2026,
      verdict: 'recommend',
      reason: '适合当前 profile 推断方向',
      summary: 'summary',
    })),
  };
}

async function testCronCommandRunsAndStoresShortlist(): Promise<void> {
  await withTempDir(async (dir) => {
    const paperSearchTool: Tool = {
      name: 'paper_search',
      description: 'fake cron search',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { success: true, data: fakeSearchResult(['2601.1', '2601.2']) };
      },
    };
    const tools = new ToolRegistry([paperSearchTool]);
    const searchState = new PaperSearchState();
    const cronService = new CronService({
      statePath: join(dir, 'cron-state.json'),
      tasks: [{ id: PAPER_RECOMMENDATION_TASK_ID, intervalMinutes: 60 }],
    });
    const commands = new CommandRouter();
    registerPaperCronCommand(commands, {
      cronService,
      runCronRecommendation: createPaperCronRunner({ tools, searchState, maxResults: 5 }),
    });

    const run = await commands.handle('/cron run', createNewSession('cli:default'));
    assert(run !== null, '/cron command is registered');
    assert(run!.text.includes('2 篇新候选'), '/cron command returns recommendation summary');
    assert(searchState.get('default').length === 2, '/cron stores latest shortlist for async download confirmation');

    const status = await commands.handle('/cron status', createNewSession('cli:default'));
    assert(status!.text.includes('runCount: 1'), '/cron status reports persisted run count');
    assert(status!.text.includes('seenIds: 2'), '/cron status reports dedupe count');
  });
}

async function testCronCommandFiltersAlreadySeen(): Promise<void> {
  await withTempDir(async (dir) => {
    const paperSearchTool: Tool = {
      name: 'paper_search',
      description: 'fake cron search',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { success: true, data: fakeSearchResult(['2601.1']) };
      },
    };
    const tools = new ToolRegistry([paperSearchTool]);
    const searchState = new PaperSearchState();
    const cronService = new CronService({
      statePath: join(dir, 'cron-state.json'),
      tasks: [{ id: PAPER_RECOMMENDATION_TASK_ID, intervalMinutes: 60 }],
    });
    const runner = createPaperCronRunner({ tools, searchState, maxResults: 5 });
    await cronService.trigger(PAPER_RECOMMENDATION_TASK_ID, runner, { force: true });
    const second = await cronService.trigger(PAPER_RECOMMENDATION_TASK_ID, runner, { force: true });
    assert(second.summary.includes('没有发现新的未推送论文'), 'cron command runner filters already-seen papers');
  });
}

async function main(): Promise<void> {
  await testCronCommandRunsAndStoresShortlist();
  await testCronCommandFiltersAlreadySeen();
  console.log('✓ paper cron command tests passed.');
}

void main().catch((err) => {
  console.error('✗ paper cron command tests failed:', err);
  process.exit(1);
});
