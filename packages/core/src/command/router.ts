import type { Session } from '../session/manager.js';
import type { ToolRegistry } from '../agent/tools/registry.js';
import type { LLMClient } from '../providers/base.js';

export interface CommandMetadata {
  command: string;
  title: string;
  description: string;
  argHint?: string;
}

export interface CommandRuntimeStatus {
  provider?: string;
  model?: string;
  activeTask?: boolean;
  profile?: {
    path: string;
    readCount: number;
    personalization: 'cold' | 'weak' | 'full';
  };
  papers?: Array<{ id: string; title?: string; path?: string; createdAt?: string }>;
}

export interface CommandContext {
  session: Session;
  args: string;
  command: string;
  metadata: CommandMetadata;
  tools?: ToolRegistry;
  llm?: LLMClient;
  status?: () => CommandRuntimeStatus | Promise<CommandRuntimeStatus>;
  createSession?: (id: string) => Session;
  cancelActiveTask?: (sessionId: string) => boolean;
}

export interface CommandResult {
  text: string;
  /**
   * 若 command 修改了 session (e.g. /clear), 这里返回新 session;
   * AgentLoop 会用它替换内存中的 session 并持久化.
   */
  mutatedSession?: Session;
  metadata?: Record<string, unknown>;
}

export type CommandHandler = (
  ctx: CommandContext,
) => CommandResult | Promise<CommandResult>;

/**
 * Slash command 路由. 输入以 / 开头才尝试匹配; 命中返回 CommandResult,
 * 否则返回 null (Loop 会当普通 user input 喂给 LLM).
 *
 * 对齐 nanobot 的 `command/router.py`: router 只做 dispatch, 内置命令放 builtin.ts.
 */
export class CommandRouter {
  private readonly entries = new Map<string, { metadata: CommandMetadata; handler: CommandHandler }>();

  register(nameOrMetadata: string | CommandMetadata, handler: CommandHandler): void {
    const metadata = typeof nameOrMetadata === 'string'
      ? {
          command: nameOrMetadata,
          title: nameOrMetadata,
          description: '',
        }
      : nameOrMetadata;
    if (!metadata.command.startsWith('/')) {
      throw new Error(`CommandRouter: command name must start with /, got "${metadata.command}"`);
    }
    this.entries.set(metadata.command, { metadata, handler });
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  list(): string[] {
    return Array.from(this.entries.keys()).sort();
  }

  listMetadata(): CommandMetadata[] {
    return Array.from(this.entries.values())
      .map((entry) => entry.metadata)
      .sort((a, b) => a.command.localeCompare(b.command));
  }

  async handle(
    input: string,
    session: Session,
    runtime: Omit<CommandContext, 'args' | 'command' | 'metadata' | 'session'> = {},
  ): Promise<CommandResult | null> {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;
    const sep = trimmed.search(/\s/);
    const name = sep === -1 ? trimmed : trimmed.slice(0, sep);
    const args = sep === -1 ? '' : trimmed.slice(sep + 1).trim();
    const entry = this.entries.get(name);
    if (!entry) return null;
    return await entry.handler({
      ...runtime,
      session,
      args,
      command: name,
      metadata: entry.metadata,
    });
  }
}
