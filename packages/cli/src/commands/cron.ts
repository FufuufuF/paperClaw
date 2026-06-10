import {
  CronService,
  type CommandRouter,
  type CronRunContext,
  type CronTaskResult,
  type ToolRegistry,
} from '@paperclaw/core';
import { PaperSearchState, type PaperSearchResult, type ShortlistItem } from '@paperclaw/search';

export const PAPER_RECOMMENDATION_TASK_ID = 'paper-recommendation';

export interface PaperCronRunnerOpts {
  tools: ToolRegistry;
  searchState: PaperSearchState;
  maxResults: number;
}

export function createPaperCronRunner(opts: PaperCronRunnerOpts) {
  return async (ctx: CronRunContext): Promise<CronTaskResult> => {
    const kgContext = await buildKnowledgeCronContext(opts.tools);
    const result = await opts.tools.execute('paper_search', {
      mode: 'cron',
      maxResults: opts.maxResults,
      ...(kgContext?.query ? { query: kgContext.query } : {}),
      ...(kgContext?.excludeArxivIds.length ? { excludeArxivIds: kgContext.excludeArxivIds } : {}),
    });
    if (!result.success) {
      return {
        summary: `cron 推荐失败: ${JSON.stringify(result.data)}`,
        data: result.data,
      };
    }
    const data = result.data as PaperSearchResult;
    const fresh = selectFreshRecommendations(data.shortlist, ctx.seenIds);
    opts.searchState.set('default', fresh);
    return {
      summary: formatCronRecommendation(data, fresh),
      dedupeIds: fresh.map((item) => item.arxiv_id),
      data: {
        ...data,
        shortlist: fresh,
        cronQuerySource: kgContext ? 'knowledge-index' : 'fallback',
        excludedArxivIds: kgContext?.excludeArxivIds ?? [],
      },
    };
  };
}

export function registerPaperCronCommand(
  commands: CommandRouter,
  opts: {
    cronService: CronService;
    runCronRecommendation: (ctx: CronRunContext) => Promise<CronTaskResult>;
  },
): void {
  commands.register(
    { command: '/cron', title: 'Cron', description: '手动触发或查看定时论文推荐', argHint: '[status|run]' },
    async (ctx) => {
      if (ctx.args.trim() === 'status') {
        const state = await opts.cronService.getTaskState(PAPER_RECOMMENDATION_TASK_ID);
        return {
          text: [
            `cron task: ${PAPER_RECOMMENDATION_TASK_ID}`,
            `lastCompletedAt: ${state.lastCompletedAt ?? 'never'}`,
            `runCount: ${state.runCount}`,
            `seenIds: ${state.seenIds.length}`,
            `lastSummary: ${state.lastSummary ?? '(none)'}`,
            state.lastError ? `lastError: ${state.lastError}` : '',
          ].filter(Boolean).join('\n'),
        };
      }
      const result = await opts.cronService.trigger(
        PAPER_RECOMMENDATION_TASK_ID,
        opts.runCronRecommendation,
        { force: true },
      );
      return { text: result.summary };
    },
  );
}

export function formatCronRecommendation(data: PaperSearchResult, fresh: ShortlistItem[]): string {
  if (fresh.length === 0) {
    return [
      '本次 cron 推荐没有发现新的未推送推荐论文。',
      `query: ${data.query}`,
      `terms: ${data.trace.terms.join(', ') || '(none)'}`,
    ].join('\n');
  }
  return [
    `本次 cron 推荐找到 ${fresh.length} 篇新候选:`,
    ...fresh.slice(0, 10).map((item) =>
      `${item.index}. ${item.title} (${item.arxiv_id}, ${item.year})\n   ${item.reason || item.summary}`,
    ),
    '',
    '回复“下载第 1、3 篇”即可下载对应 PDF。',
  ].join('\n');
}

interface RecentNodesData {
  results?: Array<{
    id?: string;
    title?: string;
    arxiv_id?: string;
    summary_short?: string;
  }>;
}

interface NeighborsData {
  neighbors?: Array<{
    paper_id?: string;
    title?: string;
    arxiv_id?: string;
    summary_short?: string;
    link_type?: string;
    reason_short?: string;
  }>;
}

interface KnowledgeCronContext {
  query: string;
  excludeArxivIds: string[];
}

function selectFreshRecommendations(shortlist: ShortlistItem[], seenIds: Set<string>): ShortlistItem[] {
  const unseen = shortlist.filter((item) => !seenIds.has(item.arxiv_id));
  const recommends = unseen.filter((item) => item.verdict === 'recommend');
  if (recommends.length > 0) return reindexShortlist(recommends);
  return reindexShortlist(unseen.filter((item) => item.verdict === 'maybe'));
}

function reindexShortlist(items: ShortlistItem[]): ShortlistItem[] {
  return items.map((item, idx) => ({ ...item, index: idx + 1 }));
}

async function buildKnowledgeCronContext(tools: ToolRegistry): Promise<KnowledgeCronContext | undefined> {
  if (!tools.has('kg_recent_nodes') || !tools.has('kg_neighbors')) return undefined;

  const recentResult = await tools.execute('kg_recent_nodes', {
    status: ['read'],
    limit: 1,
  });
  if (!recentResult.success) return undefined;
  const recent = ((recentResult.data as RecentNodesData).results ?? [])
    .find((item) => item.id && item.title);
  if (!recent?.id || !recent.title) return undefined;

  const neighborsResult = await tools.execute('kg_neighbors', {
    id: recent.id,
    limit: 5,
  });
  const neighbors = neighborsResult.success
    ? (((neighborsResult.data as NeighborsData).neighbors ?? []).filter((item) => item.paper_id || item.title))
    : [];

  return formatKnowledgeCronQuery({
    recent: {
      id: recent.id,
      title: recent.title,
      arxivId: recent.arxiv_id,
      summary: recent.summary_short,
    },
    neighbors: neighbors.map((item) => ({
      id: item.paper_id,
      title: item.title,
      arxivId: item.arxiv_id,
      summary: item.summary_short,
      relation: item.link_type,
      reason: item.reason_short,
    })),
  });
}

function formatKnowledgeCronQuery(input: {
  recent: { id: string; title: string; arxivId?: string; summary?: string };
  neighbors: Array<{ id?: string; title?: string; arxivId?: string; summary?: string; relation?: string; reason?: string }>;
}): KnowledgeCronContext {
  const neighborLines = input.neighbors.length > 0
    ? input.neighbors.slice(0, 5).map((item, idx) => [
        `${idx + 1}. ${item.title ?? item.id ?? 'unknown paper'}`,
        item.relation ? `relation=${item.relation}` : '',
        item.reason ? `reason=${item.reason}` : '',
        item.summary ? `summary=${item.summary}` : '',
      ].filter(Boolean).join('; '))
    : ['(no confirmed neighbors yet)'];

  const query = [
    'Find recent arXiv papers that are a strong next-read candidate based on this local paper knowledge graph context.',
    `Recent paper: ${input.recent.title} (${input.recent.id})`,
    input.recent.summary ? `Recent paper summary: ${input.recent.summary}` : '',
    'Related local papers:',
    ...neighborLines,
    'Prefer directly related LLM agent, tool-use, evaluation, benchmark, or methodology papers over broad surveys.',
  ].filter(Boolean).join('\n');
  return {
    query,
    excludeArxivIds: Array.from(new Set([
      input.recent.arxivId,
      ...input.neighbors.map((item) => item.arxivId),
    ].filter((item): item is string => Boolean(item)))),
  };
}
