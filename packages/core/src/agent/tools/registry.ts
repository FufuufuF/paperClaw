import type { ToolContext } from './context.js';
import { castParams, parseToolArgs, validateParams } from './schema.js';
import type { PreparedToolCall, Tool, ToolDef, ToolResult, ToolScope } from './types.js';

const TOOL_ERROR_HINT = 'Analyze the error above and try a different approach.';

/**
 * Tool 注册表. 一个进程里可以有多个 (主 agent / sub-agent 各一个),
 * 通过 `scope(names)` 派生子集.
 *
 * 不做自动发现 — paperClaw 的 tool 数量有限, 显式 register 更清楚.
 */
export class ToolRegistry {
  private readonly tools: Map<string, Tool>;
  private cachedToolDefs: ToolDef[] | null = null;

  constructor(
    initial?: Iterable<Tool>,
    private readonly context?: ToolContext,
  ) {
    this.tools = new Map();
    if (initial) for (const t of initial) this.register(t);
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: duplicate tool name "${tool.name}"`);
    }
    this.tools.set(tool.name, tool);
    this.cachedToolDefs = null;
  }

  unregister(name: string): void {
    this.tools.delete(name);
    this.cachedToolDefs = null;
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
    if (this.cachedToolDefs) return this.cachedToolDefs;
    const defs = Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    defs.sort((a, b) => a.name.localeCompare(b.name));
    this.cachedToolDefs = defs;
    return defs;
  }

  /** 列出所有 tool 名 (供 /help 等命令展示) */
  names(): string[] {
    return Array.from(this.tools.keys());
  }

  prepareCall(name: string, args: string | Record<string, unknown>): PreparedToolCall {
    const parsed = parseToolArgs(args);
    if (!parsed.ok) {
      return {
        tool: null,
        args: {},
        error: `${parsed.error}\n\n[${TOOL_ERROR_HINT}]`,
      };
    }

    const tool = this.tools.get(name);
    if (!tool) {
      return {
        tool: null,
        args: parsed.args,
        error: `Error: Tool "${name}" not found. Available: ${this.names().join(', ') || '(none)'}\n\n[${TOOL_ERROR_HINT}]`,
      };
    }

    const castArgs = castParams(parsed.args, tool.parameters);
    const errors = validateParams(castArgs, tool.parameters);
    if (errors.length > 0) {
      return {
        tool,
        args: castArgs,
        error: `Error: Invalid parameters for tool "${name}": ${errors.join('; ')}\n\n[${TOOL_ERROR_HINT}]`,
      };
    }

    return { tool, args: castArgs, error: null };
  }

  /**
   * 执行 tool. 处理两类入参:
   * - LLM 给的 raw JSON 字符串 (DeepSeek/OpenAI tool_calls.arguments 是 string)
   * - 已经 parse 好的对象 (内部直接调用时方便)
   *
   * 永远 resolve, 不 reject. 错误统一包装为 `{success: false, data: {error: ...}}`.
   */
  async execute(name: string, args: string | Record<string, unknown>): Promise<ToolResult> {
    const prepared = this.prepareCall(name, args);
    if (prepared.error) {
      return {
        success: false,
        data: { error: prepared.error },
        summary: prepared.error.split('\n')[0],
      };
    }

    try {
      return await prepared.tool!.execute(prepared.args, this.context);
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
    const sub = new ToolRegistry(undefined, this.context);
    for (const name of allowedNames) {
      const t = this.tools.get(name);
      if (!t) throw new Error(`ToolRegistry.scope: unknown tool "${name}"`);
      sub.register(t);
    }
    return sub;
  }

  scopeByTag(scope: ToolScope): ToolRegistry {
    const sub = new ToolRegistry(undefined, this.context);
    for (const tool of this.tools.values()) {
      const scopes = tool.scopes ?? ['core'];
      if (scopes.includes(scope)) sub.register(tool);
    }
    return sub;
  }

  concurrencySafe(name: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    return tool.concurrencySafe ?? (tool.readOnly === true && tool.exclusive !== true);
  }
}
