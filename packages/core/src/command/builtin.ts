import type { ToolRegistry } from '../agent/tools/registry.js';
import {
  createNewSession,
  type SessionListing,
  type SessionStore,
} from '../session/manager.js';
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

/** /switch — 展示历史 session, 或用序号切换 session */
export function makeSwitchCommand(opts: {
  sessionStore: SessionStore;
  getActiveSessionId?: () => string;
}): CommandHandler {
  return async (ctx) => {
    const list = await opts.sessionStore.list();
    const activeId = opts.getActiveSessionId?.() ?? ctx.session.id;
    const target = ctx.args.trim();
    if (!target) {
      return { text: renderSwitchList(list, activeId) };
    }

    if (!/^\d+$/.test(target)) {
      return {
        text: [
          `无法识别的 session 序号: ${target}`,
          '',
          renderSwitchList(list, activeId),
        ].join('\n'),
      };
    }

    const index = Number(target);
    const selected = list[index - 1];
    if (!selected) {
      return {
        text: [
          `session 序号 ${index} 不存在。`,
          '',
          renderSwitchList(list, activeId),
        ].join('\n'),
      };
    }

    if (selected.id === activeId) {
      return { text: `已在当前 session: ${sessionDisplayName(selected)}` };
    }

    return {
      text: `已切换到 session: ${sessionDisplayName(selected)}`,
      switchSessionId: selected.id,
      metadata: { sessionId: selected.id },
    };
  };
}

/** /history — /switch 的兼容别名 */
export function makeHistoryCommand(opts: { sessionStore: SessionStore }): CommandHandler {
  return makeSwitchCommand({ sessionStore: opts.sessionStore });
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
  return async (ctx) => {
    const name = ctx.args.trim() || undefined;
    const next = await ctx.createSessionId?.(name);
    if (next) {
      const fresh = (ctx.createSession ?? createNewSession)(next.id, {
        sessionName: next.sessionName,
        uid: next.uid,
        channel: next.channel,
      });
      return {
        text: `已开启新会话: ${next.sessionName ?? next.uid ?? next.id}`,
        mutatedSession: fresh,
        switchSessionId: next.id,
        metadata: { previousTurnCount: ctx.session.turns.length, sessionId: next.id },
      };
    }

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
      `session: ${status?.session?.id ?? ctx.session.id} (${ctx.session.turns.length} turns)`,
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
    getActiveSessionId?: () => string;
  },
): void {
  register(router, { command: '/clear', title: 'Clear', description: '清空当前 session' }, makeClearCommand());
  register(router, { command: '/new', title: 'New Session', description: '开启新会话', argHint: '[name]' }, makeNewCommand());
  register(router, { command: '/help', title: 'Help', description: '查看命令和工具' }, makeHelpCommand({ router, tools: deps.tools }));
  register(router, { command: '/switch', title: 'Switch Session', description: '查看并切换历史 session', argHint: '[number]' }, makeSwitchCommand({ sessionStore: deps.sessionStore, getActiveSessionId: deps.getActiveSessionId }));
  register(router, { command: '/history', title: 'History', description: '查看历史 session (/switch 的别名)' }, makeHistoryCommand({ sessionStore: deps.sessionStore }));
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

function renderSwitchList(list: SessionListing[], activeId: string): string {
  if (list.length === 0) return '暂无可切换 session。';
  const lines = ['可切换 sessions:'];
  list.forEach((session, idx) => {
    const marker = session.id === activeId ? '*' : ' ';
    const preview = session.preview?.trim() || '(暂无消息)';
    lines.push(`${marker} ${idx + 1}. ${sessionDisplayName(session)}  ${session.turnCount} turns  last: ${session.lastActiveAt || 'unknown'}`);
    lines.push(`     ${preview}`);
  });
  lines.push('', '输入 /switch <number> 切换到对应会话。');
  return lines.join('\n');
}

function sessionDisplayName(session: SessionListing): string {
  const parsed = parseSessionId(session.id);
  const name = session.sessionName?.trim()
    || parsed.sessionName
    || (session.id === 'cli:default' ? '默认会话' : '未命名');
  const uid = session.uid ?? parsed.uid;
  return uid ? `${name} ${uid}` : name;
}

function parseSessionId(id: string): { channel?: string; sessionName?: string; uid?: string } {
  const parts = id.split(':').filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { uid: parts[0] };
  if (parts.length === 2) return { channel: parts[0], uid: parts[1] };
  return {
    channel: parts[0],
    sessionName: parts.slice(1, -1).join(':'),
    uid: parts.at(-1),
  };
}
