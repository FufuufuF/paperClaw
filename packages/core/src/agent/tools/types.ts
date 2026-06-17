/**
 * Tool 系统的基础类型. 对齐 nanobot 的 `agent/tools/base.py`:
 * agent 可用工具属于 agent 子系统, 不单独放在 core 根目录.
 */
import type { ToolDef } from '../../providers/base.js';
import type { ToolContext } from './context.js';
import type { JsonSchema } from './schema.js';

export type { ToolDef };

export type ToolScope = 'core' | 'subagent' | string;

export interface ToolResult {
  success: boolean;
  /** 结构化数据 (各 tool 自定). 会被 JSON.stringify 后回传给 LLM */
  data: unknown;
  /** compaction 时替代完整结果的摘要 (一句话, 给 LLM 看) */
  summary?: string;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for arguments (OpenAI tools 规范) */
  parameters: JsonSchema;
  /** Whether this tool is side-effect free. Read-only tools can be parallelized later. */
  readOnly?: boolean;
  /** Whether this tool can run alongside other concurrency-safe tools. Defaults to readOnly. */
  concurrencySafe?: boolean;
  /** Whether this tool must run alone even if concurrent execution is enabled. */
  exclusive?: boolean;
  /** Optional execution timeout in milliseconds. Falls back to the runner default. */
  timeoutMs?: number;
  /** Scopes this tool is intended for. Missing means core. */
  scopes?: ToolScope[];
  /** Optional config key for future ToolLoader integration. */
  configKey?: string;
  /**
   * Prompt/documentation metadata for side-effecting tools. AgentRunner does
   * not enforce these patterns; the model's tool call is the execution intent.
   */
  confirmation?: {
    required: boolean;
    action: string;
    patterns: string[];
    guidance: string;
  };
  /** Optional context-aware enablement hook, matching nanobot's Tool.enabled(ctx). */
  enabled?: (ctx: ToolContext) => boolean;
  /**
   * 执行工具. 实现方负责返回 `success: false` 而不是抛错;
   * 但抛错也会被 ToolRegistry.execute 捕获并包装.
   */
  execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult>;
}

export interface PreparedToolCall {
  tool: Tool | null;
  args: Record<string, unknown>;
  error: string | null;
}
