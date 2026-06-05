/**
 * Tool 系统的基础类型. 对齐 nanobot 的 `agent/tools/base.py`:
 * agent 可用工具属于 agent 子系统, 不单独放在 core 根目录.
 */
import type { ToolDef } from '../../providers/base.js';

export type { ToolDef };

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
  parameters: Record<string, unknown>;
  /**
   * 执行工具. 实现方负责返回 `success: false` 而不是抛错;
   * 但抛错也会被 ToolRegistry.execute 捕获并包装.
   */
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}
