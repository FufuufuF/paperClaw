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
    const result = await opts.tools.execute('paper_search', { mode: 'cron', maxResults: opts.maxResults });
    if (!result.success) {
      return {
        summary: `cron 推荐失败: ${JSON.stringify(result.data)}`,
        data: result.data,
      };
    }
    const data = result.data as PaperSearchResult;
    const fresh = data.shortlist.filter((item) => !ctx.seenIds.has(item.arxiv_id));
    opts.searchState.set('default', fresh.length > 0 ? fresh : data.shortlist);
    return {
      summary: formatCronRecommendation(data, fresh),
      dedupeIds: fresh.map((item) => item.arxiv_id),
      data: { ...data, shortlist: fresh },
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
      '本次 cron 推荐没有发现新的未推送论文。',
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
