import type { Session } from '../session/manager.js';

export interface CommandResult {
  text: string;
  /**
   * 若 command 修改了 session (e.g. /clear), 这里返回新 session;
   * AgentLoop 会用它替换内存中的 session 并持久化.
   */
  mutatedSession?: Session;
}

export type CommandHandler = (
  args: string,
  session: Session,
) => CommandResult | Promise<CommandResult>;

/**
 * Slash command 路由. 输入以 / 开头才尝试匹配; 命中返回 CommandResult,
 * 否则返回 null (Loop 会当普通 user input 喂给 LLM).
 *
 * 对齐 nanobot 的 `command/router.py`: router 只做 dispatch, 内置命令放 builtin.ts.
 */
export class CommandRouter {
  private readonly handlers = new Map<string, CommandHandler>();

  register(name: string, handler: CommandHandler): void {
    if (!name.startsWith('/')) {
      throw new Error(`CommandRouter: command name must start with /, got "${name}"`);
    }
    this.handlers.set(name, handler);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  list(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }

  async handle(input: string, session: Session): Promise<CommandResult | null> {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;
    const sep = trimmed.search(/\s/);
    const name = sep === -1 ? trimmed : trimmed.slice(0, sep);
    const args = sep === -1 ? '' : trimmed.slice(sep + 1).trim();
    const handler = this.handlers.get(name);
    if (!handler) return null;
    return await handler(args, session);
  }
}
