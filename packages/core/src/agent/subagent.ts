import { AgentRunner, type AgentRunResult } from './runner.js';
import { ToolRegistry } from './tools/registry.js';
import type { ChatMessage, LLMClient } from '../providers/base.js';
import type { TraceBus } from '../trace.js';

export interface SubagentSpec {
  id: string;
  llm: LLMClient;
  systemPrompt: string;
  messages: ChatMessage[];
  tools?: ToolRegistry;
  maxIterations?: number;
  contextBudget?: number;
  trace?: TraceBus;
  temperature?: number;
  maxTokens?: number;
}

export interface SubagentResult {
  id: string;
  text: string;
  usage: { input: number; output: number };
  iterations: number;
  toolsUsed: string[];
  trace: {
    isolatedMessages: number;
    persistedToMainSession: false;
  };
  raw: AgentRunResult;
}

/**
 * 轻量同步 sub-agent runner. 它不接收 Session, 也不返回 Turn 给主循环持久化;
 * 调用方只能拿到最终摘要/产物路径, 从机制上避免 PDF 全文进入主 session.
 */
export async function runSubagent(spec: SubagentSpec): Promise<SubagentResult> {
  const runner = new AgentRunner(spec.llm);
  const result = await runner.run({
    systemPrompt: spec.systemPrompt,
    initialMessages: spec.messages,
    tools: spec.tools ?? new ToolRegistry(),
    maxIterations: spec.maxIterations ?? 6,
    contextBudget: spec.contextBudget ?? 16_000,
    agentId: spec.id,
    trace: spec.trace,
    temperature: spec.temperature,
    maxTokens: spec.maxTokens,
  });

  return {
    id: spec.id,
    text: result.text,
    usage: result.usage,
    iterations: result.iterations,
    toolsUsed: result.toolsUsed,
    trace: {
      isolatedMessages: spec.messages.length,
      persistedToMainSession: false,
    },
    raw: result,
  };
}
