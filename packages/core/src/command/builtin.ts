import type { ToolRegistry } from '../agent/tools/registry.js';
import { createNewSession, type SessionStore } from '../session/manager.js';
import {
  CommandRouter,
  type CommandHandler,
  type CommandMetadata,
  type CommandRuntimeStatus,
} from './router.js';

/**
 * Built-in slash command handlers. 对齐 nanobot 的 `command/builtin.py`:
 * router 是机制, builtin 是默认命令集.
 */

/** /clear — 清空当前 session.turns */
export function makeClearCommand(): CommandHandler {
  return (ctx) => {
    const fresh = (ctx.createSession ?? createNewSession)(ctx.session.id);
    return {
      text: '对话已清空, 重新开始.',
      mutatedSession: fresh,
    };
  };
}

/** /help — 列出可用命令 + 当前挂载的 tools */
export function makeHelpCommand(opts: {
  router: CommandRouter;
  tools: ToolRegistry;
}): CommandHandler {
  return () => {
    const cmds = opts.router
      .listMetadata()
      .map((cmd) => `${cmd.command}${cmd.argHint ? ` ${cmd.argHint}` : ''} — ${cmd.description || cmd.title}`)
      .join('\n');
    const toolNames = opts.tools.names();
    const toolPart = toolNames.length === 0 ? '(无)' : toolNames.join(', ');
    const text = [
      '可用命令:',
      cmds || '(无)',
      '当前挂载工具: ' + toolPart,
    ].join('\n');
    return { text };
  };
}

/** /history — 列出所有 session */
export function makeHistoryCommand(opts: { sessionStore: SessionStore }): CommandHandler {
  return async () => {
    const list = await opts.sessionStore.list();
    if (list.length === 0) return { text: '暂无历史 session.' };
    const lines = list.map(
      (s) => `- ${s.id}  (${s.turnCount} turns, last: ${s.lastActiveAt || 'unknown'})`,
    );
    return { text: ['历史 sessions:', ...lines].join('\n') };
  };
}

/** /cost — 当前 session 的 token 消耗 */
export function makeCostCommand(): CommandHandler {
  return (ctx) => {
    const u = ctx.session.metadata.totalUsage;
    const text = `本次会话消耗: input ${u.input.toLocaleString()} tokens, output ${u.output.toLocaleString()} tokens (合计 ${(u.input + u.output).toLocaleString()}).`;
    return { text };
  };
}

/** /session — 当前 session id 和 turn 数 */
export function makeSessionCommand(): CommandHandler {
  return (ctx) => {
    const text = `当前 session: ${ctx.session.id} | turns: ${ctx.session.turns.length} | createdAt: ${ctx.session.metadata.createdAt}`;
    return { text };
  };
}

/** /new — 新开当前会话窗口. 旧 transcript 的归档由外层后续 HistoryArchive 接管. */
export function makeNewCommand(): CommandHandler {
  return (ctx) => {
    const fresh = (ctx.createSession ?? createNewSession)(ctx.session.id);
    return {
      text: '已开启新会话.',
      mutatedSession: fresh,
      metadata: { previousTurnCount: ctx.session.turns.length },
    };
  };
}

/** /status — 结构化展示当前运行态, 不走 LLM. */
export function makeStatusCommand(opts: { tools: ToolRegistry }): CommandHandler {
  return async (ctx) => {
    const status = await ctx.status?.();
    const profile = status?.profile;
    const lines = [
      `provider: ${status?.provider ?? providerFromId(ctx.llm?.id) ?? 'unknown'}`,
      `model: ${status?.model ?? modelFromId(ctx.llm?.id) ?? 'unknown'}`,
      `session: ${ctx.session.id} (${ctx.session.turns.length} turns)`,
      `tools: ${opts.tools.names().join(', ') || '(none)'}`,
      `active_task: ${status?.activeTask ? 'yes' : 'no'}`,
    ];
    if (profile) {
      lines.push(
        `profile: ${profile.readCount} read, personalization=${profile.personalization}, path=${profile.path}`,
      );
    } else {
      lines.push('profile: not configured');
    }
    return { text: lines.join('\n') };
  };
}

/** /model — 一期只做查看; 切换 preset 需要配置热加载后再补. */
export function makeModelCommand(): CommandHandler {
  return (ctx) => {
    const id = ctx.llm?.id ?? 'unknown/unknown';
    if (ctx.args.trim()) {
      return {
        text: `当前运行时暂不支持直接切换 model preset. 当前模型: ${id}`,
        metadata: { requested: ctx.args.trim() },
      };
    }
    return { text: `当前模型: ${id}` };
  };
}

/** /stop — 取消当前 session 的活动任务; 无任务时返回稳定状态. */
export function makeStopCommand(): CommandHandler {
  return (ctx) => {
    const cancelled = ctx.cancelActiveTask?.(ctx.session.id) ?? false;
    return { text: cancelled ? '已请求停止当前任务.' : '当前没有正在运行的任务.' };
  };
}

export function registerBuiltinCommands(
  router: CommandRouter,
  deps: {
    tools: ToolRegistry;
    sessionStore: SessionStore;
    status?: () => CommandRuntimeStatus | Promise<CommandRuntimeStatus>;
  },
): void {
  register(router, { command: '/clear', title: 'Clear', description: '清空当前 session' }, makeClearCommand());
  register(router, { command: '/new', title: 'New Session', description: '开启新会话' }, makeNewCommand());
  register(router, { command: '/help', title: 'Help', description: '查看命令和工具' }, makeHelpCommand({ router, tools: deps.tools }));
  register(router, { command: '/history', title: 'History', description: '列出历史 session' }, makeHistoryCommand({ sessionStore: deps.sessionStore }));
  register(router, { command: '/cost', title: 'Cost', description: '查看当前 session token 消耗' }, makeCostCommand());
  register(router, { command: '/session', title: 'Session', description: '查看当前 session' }, makeSessionCommand());
  register(router, { command: '/status', title: 'Status', description: '查看 provider/model/session/profile/tools 状态' }, makeStatusCommand({ tools: deps.tools }));
  register(router, { command: '/model', title: 'Model', description: '查看当前模型', argHint: '[preset]' }, makeModelCommand());
  register(router, { command: '/stop', title: 'Stop', description: '请求停止当前任务' }, makeStopCommand());
}

function register(router: CommandRouter, metadata: CommandMetadata, handler: CommandHandler): void {
  router.register(metadata, handler);
}

function providerFromId(id?: string): string | undefined {
  return id?.split('/')[0];
}

function modelFromId(id?: string): string | undefined {
  const parts = id?.split('/');
  return parts && parts.length > 1 ? parts.slice(1).join('/') : undefined;
}
