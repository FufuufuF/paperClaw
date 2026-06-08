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
import { PaperSearchState, type PaperSearchResult, type TriageVerdict } from '../../packages/search/src/index.js';
import { assert, withTempDir } from '../fixtures/index.js';

function fakeSearchResult(ids: string[], verdicts: TriageVerdict[] = []): PaperSearchResult {
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
      verdict: verdicts[idx] ?? 'recommend',
      reason: verdicts[idx] === 'skip' ? '与当前推荐方向无关' : '适合当前 profile 推断方向',
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
    assert(second.summary.includes('没有发现新的未推送推荐论文'), 'cron command runner filters already-seen papers');
  });
}

async function testCronCommandDoesNotPushSkipVerdicts(): Promise<void> {
  await withTempDir(async (dir) => {
    const paperSearchTool: Tool = {
      name: 'paper_search',
      description: 'fake cron search',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { success: true, data: fakeSearchResult(['2601.keep', '2601.skip'], ['recommend', 'skip']) };
      },
    };
    const tools = new ToolRegistry([paperSearchTool]);
    const searchState = new PaperSearchState();
    const cronService = new CronService({
      statePath: join(dir, 'cron-state.json'),
      tasks: [{ id: PAPER_RECOMMENDATION_TASK_ID, intervalMinutes: 60 }],
    });
    const runner = createPaperCronRunner({ tools, searchState, maxResults: 5 });
    const result = await cronService.trigger(PAPER_RECOMMENDATION_TASK_ID, runner, { force: true });
    assert(result.summary.includes('Paper 2601.keep'), 'cron summary includes recommend paper');
    assert(!result.summary.includes('Paper 2601.skip'), 'cron summary hides skip paper');
    assert(searchState.get('default').map((item) => item.arxiv_id).join(',') === '2601.keep', 'cron shortlist stores only pushable papers');
    const state = await cronService.getTaskState(PAPER_RECOMMENDATION_TASK_ID);
    assert(state.seenIds.join(',') === '2601.keep', 'cron seenIds record only pushed papers');
  });
}

async function testCronCommandFallsBackToMaybeWhenNoRecommend(): Promise<void> {
  await withTempDir(async (dir) => {
    const paperSearchTool: Tool = {
      name: 'paper_search',
      description: 'fake cron search',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { success: true, data: fakeSearchResult(['2601.maybe', '2601.skip'], ['maybe', 'skip']) };
      },
    };
    const tools = new ToolRegistry([paperSearchTool]);
    const searchState = new PaperSearchState();
    const cronService = new CronService({
      statePath: join(dir, 'cron-state.json'),
      tasks: [{ id: PAPER_RECOMMENDATION_TASK_ID, intervalMinutes: 60 }],
    });
    const runner = createPaperCronRunner({ tools, searchState, maxResults: 5 });
    const result = await cronService.trigger(PAPER_RECOMMENDATION_TASK_ID, runner, { force: true });
    assert(result.summary.includes('Paper 2601.maybe'), 'cron falls back to maybe paper');
    assert(!result.summary.includes('Paper 2601.skip'), 'cron still hides skip paper');
    assert(searchState.get('default').map((item) => item.arxiv_id).join(',') === '2601.maybe', 'cron stores maybe fallback shortlist');
  });
}

async function testCronCommandBuildsQueryFromKnowledgeGraph(): Promise<void> {
  await withTempDir(async (dir) => {
    let searchArgs: Record<string, unknown> | undefined;
    const kgRecentTool: Tool = {
      name: 'kg_recent_nodes',
      description: 'fake recent nodes',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return {
          success: true,
          data: {
            results: [{
              id: 'agent-tool-failure-harness',
              title: 'Agent Tool Failure Harness',
              arxiv_id: '2401.00001',
              summary_short: '研究 LLM agent 工具调用失败恢复和评估 harness。',
            }],
            total: 1,
            truncated: false,
          },
        };
      },
    };
    const kgNeighborsTool: Tool = {
      name: 'kg_neighbors',
      description: 'fake neighbors',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return {
          success: true,
          data: {
            node: 'agent-tool-failure-harness',
            neighbors: [{
              paper_id: 'tool-learning-data',
              title: 'Tool Learning Data and Scaling',
              arxiv_id: '2401.00002',
              summary_short: '关注 tool-use 数据规模和泛化到 unseen tools。',
              link_type: 'complements',
              reason_short: '失败恢复评估和工具学习数据扩展互补。',
            }],
            truncated: false,
          },
        };
      },
    };
    const paperSearchTool: Tool = {
      name: 'paper_search',
      description: 'fake cron search',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string' },
          maxResults: { type: 'integer' },
          query: { type: 'string' },
        },
      },
      async execute(args) {
        searchArgs = args;
        return { success: true, data: fakeSearchResult(['2601.9']) };
      },
    };
    const tools = new ToolRegistry([kgRecentTool, kgNeighborsTool, paperSearchTool]);
    const searchState = new PaperSearchState();
    const cronService = new CronService({
      statePath: join(dir, 'cron-state.json'),
      tasks: [{ id: PAPER_RECOMMENDATION_TASK_ID, intervalMinutes: 60 }],
    });
    const runner = createPaperCronRunner({ tools, searchState, maxResults: 5 });
    await cronService.trigger(PAPER_RECOMMENDATION_TASK_ID, runner, { force: true });
    assert(searchArgs?.mode === 'cron', 'cron still calls paper_search in cron mode');
    assert(String(searchArgs?.query ?? '').includes('Agent Tool Failure Harness'), 'cron query includes recent KG node');
    assert(String(searchArgs?.query ?? '').includes('unseen tools'), 'cron query includes neighbor summary');
    assert(Array.isArray(searchArgs?.excludeArxivIds), 'cron passes KG arxiv ids as search exclusions');
    assert((searchArgs!.excludeArxivIds as string[]).join(',') === '2401.00001,2401.00002', 'cron excludes KG arxiv ids');
  });
}

async function main(): Promise<void> {
  await testCronCommandRunsAndStoresShortlist();
  await testCronCommandFiltersAlreadySeen();
  await testCronCommandDoesNotPushSkipVerdicts();
  await testCronCommandFallsBackToMaybeWhenNoRecommend();
  await testCronCommandBuildsQueryFromKnowledgeGraph();
  console.log('✓ paper cron command tests passed.');
}

void main().catch((err) => {
  console.error('✗ paper cron command tests failed:', err);
  process.exit(1);
});
