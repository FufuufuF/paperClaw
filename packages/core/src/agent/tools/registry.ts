import type { Tool, ToolDef, ToolResult } from './types.js';

/**
 * Tool 注册表. 一个进程里可以有多个 (主 agent / sub-agent 各一个),
 * 通过 `scope(names)` 派生子集.
 *
 * 不做自动发现 — paperClaw 的 tool 数量有限, 显式 register 更清楚.
 */
export class ToolRegistry {
  private readonly tools: Map<string, Tool>;

  constructor(initial?: Iterable<Tool>) {
    this.tools = new Map();
    if (initial) for (const t of initial) this.register(t);
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: duplicate tool name "${tool.name}"`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 当前注册的 tool 数量 */
  get size(): number {
    return this.tools.size;
  }

  /** 返回所有 tool 的 schema (传给 LLM tools 参数). 空时返回 [] */
  getToolDefs(): ToolDef[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /** 列出所有 tool 名 (供 /help 等命令展示) */
  names(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * 执行 tool. 处理两类入参:
   * - LLM 给的 raw JSON 字符串 (DeepSeek/OpenAI tool_calls.arguments 是 string)
   * - 已经 parse 好的对象 (内部直接调用时方便)
   *
   * 永远 resolve, 不 reject. 错误统一包装为 `{success: false, data: {error: ...}}`.
   */
  async execute(name: string, args: string | Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        data: { error: `unknown tool: ${name}` },
        summary: `未注册的工具 ${name}`,
      };
    }
    let parsed: Record<string, unknown>;
    if (typeof args === 'string') {
      const trimmed = args.trim();
      if (trimmed === '') {
        parsed = {};
      } else {
        try {
          const obj = JSON.parse(trimmed);
          if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
            return {
              success: false,
              data: { error: `tool args must be a JSON object, got ${typeof obj}` },
              summary: '参数解析失败',
            };
          }
          parsed = obj as Record<string, unknown>;
        } catch (err) {
          return {
            success: false,
            data: { error: `JSON parse error: ${(err as Error).message}`, raw: args },
            summary: '参数 JSON 解析失败',
          };
        }
      }
    } else {
      parsed = args;
    }

    try {
      return await tool.execute(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: { error: msg },
        summary: `${name} 执行抛错: ${msg.slice(0, 100)}`,
      };
    }
  }

  /**
   * 派生一个仅包含指定 tools 的子 registry. 共享底层 Tool 对象 (引用相同).
   * 给 sub-agent 受限工具集用.
   */
  scope(allowedNames: string[]): ToolRegistry {
    const sub = new ToolRegistry();
    for (const name of allowedNames) {
      const t = this.tools.get(name);
      if (!t) throw new Error(`ToolRegistry.scope: unknown tool "${name}"`);
      sub.register(t);
    }
    return sub;
  }
}
