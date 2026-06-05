import type { ToolRegistry } from '../agent/tools/registry.js';
import { createNewSession, type SessionStore } from '../session/manager.js';
import { CommandRouter, type CommandHandler } from './router.js';

/**
 * Built-in slash command handlers. 对齐 nanobot 的 `command/builtin.py`:
 * router 是机制, builtin 是默认命令集.
 */

/** /clear — 清空当前 session.turns */
export function makeClearCommand(): CommandHandler {
  return (_args, session) => {
    const fresh = createNewSession(session.id);
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
    const cmds = opts.router.list().join(', ');
    const toolNames = opts.tools.names();
    const toolPart = toolNames.length === 0 ? '(无)' : toolNames.join(', ');
    const text = [
      '可用命令: ' + cmds,
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
  return (_args, session) => {
    const u = session.metadata.totalUsage;
    const text = `本次会话消耗: input ${u.input.toLocaleString()} tokens, output ${u.output.toLocaleString()} tokens (合计 ${(u.input + u.output).toLocaleString()}).`;
    return { text };
  };
}

/** /session — 当前 session id 和 turn 数 */
export function makeSessionCommand(): CommandHandler {
  return (_args, session) => {
    const text = `当前 session: ${session.id} | turns: ${session.turns.length} | createdAt: ${session.metadata.createdAt}`;
    return { text };
  };
}

export function registerBuiltinCommands(
  router: CommandRouter,
  deps: { tools: ToolRegistry; sessionStore: SessionStore },
): void {
  router.register('/clear', makeClearCommand());
  router.register('/help', makeHelpCommand({ router, tools: deps.tools }));
  router.register('/history', makeHistoryCommand({ sessionStore: deps.sessionStore }));
  router.register('/cost', makeCostCommand());
  router.register('/session', makeSessionCommand());
}
