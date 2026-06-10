import type {
  CommandHandler,
  CommandRouter,
} from '@paperclaw/core';

export function makeProfileCommand(): CommandHandler {
  return async (ctx) => {
    const status = await ctx.status?.();
    const profile = status?.profile;
    if (!profile) return { text: 'profile: not configured' };
    return {
      text: [
        `profile path: ${profile.path}`,
        `read papers: ${profile.readCount}`,
        `personalization: ${profile.personalization}`,
      ].join('\n'),
    };
  };
}

export function makePapersCommand(): CommandHandler {
  return async (ctx) => {
    const status = await ctx.status?.();
    const papers = status?.papers ?? [];
    if (papers.length === 0) return { text: '暂无论文产物.' };
    return {
      text: [
        '最近论文:',
        ...papers.slice(0, 20).map((paper, idx) =>
          `${idx + 1}. ${paper.title ?? paper.id}${paper.path ? ` — ${paper.path}` : ''}`,
        ),
      ].join('\n'),
    };
  };
}

export function registerPaperCommands(router: CommandRouter): void {
  router.register({ command: '/profile', title: 'Profile', description: '查看 profile 状态' }, makeProfileCommand());
  router.register({ command: '/papers', title: 'Papers', description: '查看最近论文产物' }, makePapersCommand());
}
