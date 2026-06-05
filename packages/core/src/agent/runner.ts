import type { ChatMessage, LLMClient } from '../providers/base.js';
import type { ToolRegistry } from './tools/registry.js';
import type { TraceBus } from '../trace.js';
import type { Turn } from '../session/manager.js';
import { compactToolResults, estimateMessagesTokens, estimateTokens } from './context.js';

export interface RunnerConfig {
  systemPrompt: string;
  tools: ToolRegistry;
  llm: LLMClient;
  /** 主 agent 默认 30, sub-agent 通常 5~20 */
  maxIterations: number;
  /** token 上限 (主 agent 24000) */
  contextBudget: number;
  /** trace 标识 */
  agentId: string;
  trace?: TraceBus;
  /** 透传给 LLM 的 temperature (默认随 provider 实现) */
  temperature?: number;
}

export interface RunnerResult {
  /** 最终回复 (无更多 tool call 时的 assistant text) */
  text: string;
  /** 本次 run 产生的所有 turns (assistant + tool, 按时间序). 追加到 session.turns */
  newTurns: Turn[];
  iterations: number;
  /** 累计 LLM 用量 */
  usage: { input: number; output: number };
  /** true = 因 maxIterations 中断; false = 正常 final response */
  truncated: boolean;
}

/**
 * 内层 tool-use 循环 (对应 nanobot AgentRunner.run).
 *
 * 输入: 已经组装好的 messages (system 从 config 里, 不在 messages 里).
 * 输出: 最终回复 + 本次 run 期间产生的所有新 turn (assistant + tool).
 *
 * 循环逻辑:
 *   1. llm.chat(messages, tools) → response
 *   2. 有 toolCalls?
 *        yes → 记录 assistant turn (含 toolCalls) + 执行 + 记录 tool turn → continue
 *        no  → 把 text 当 final response, return
 *   3. 每轮检查 token 预算, 超 80% → mid-loop compaction
 *   4. iteration 达 maxIterations → truncated:true 返回
 *
 * Runner 不动 session 本身 — 它只产 newTurns; AgentLoop 负责 append + save.
 */
export async function runToolLoop(
  config: RunnerConfig,
  initialMessages: ChatMessage[],
): Promise<RunnerResult> {
  let messages = initialMessages.slice();
  const newTurns: Turn[] = [];
  let usage = { input: 0, output: 0 };
  let truncated = false;
  let finalText = '';

  for (let iter = 0; iter < config.maxIterations; iter++) {
    // ── 检查预算: 超 80% 做 mid-loop compaction (在调 LLM 前压一次) ─────
    const used = estimateMessagesTokens(messages) + estimateTokens(config.systemPrompt);
    if (used > config.contextBudget * 0.8) {
      const compacted = compactToolResults(messages, 3);
      const newUsed = estimateMessagesTokens(compacted) + estimateTokens(config.systemPrompt);
      if (newUsed < used) {
        messages = compacted;
        await config.trace?.emit('runner', 'phase_begin', {
          note: 'mid-loop compaction',
          before: used,
          after: newUsed,
        });
      }
    }

    // ── 调 LLM ────────────────────────────────────────────────────────
    const toolDefs = config.tools.getToolDefs();
    const response = await config.llm.chat({
      system: config.systemPrompt,
      messages,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    });

    usage = {
      input: usage.input + (response.usage?.input ?? 0),
      output: usage.output + (response.usage?.output ?? 0),
    };

    const text = response.text ?? '';
    const toolCalls = response.toolCalls ?? [];

    // ── 没有 tool call → final response, 收工 ─────────────────────────
    if (toolCalls.length === 0) {
      finalText = text;
      const turn: Turn = {
        role: 'assistant',
        content: text,
        tokenEstimate: estimateTokens(text),
        timestamp: Date.now(),
      };
      newTurns.push(turn);
      messages.push({ role: 'assistant', content: text });
      await config.trace?.emit('runner', 'thought', {
        agent_id: config.agentId,
        text: text.slice(0, 200),
        iter,
      });
      return { text: finalText, newTurns, iterations: iter + 1, usage, truncated: false };
    }

    // ── 有 tool call → 记录 assistant turn (带 toolCalls), 执行, 收回结果 ──
    const assistantTurn: Turn = {
      role: 'assistant',
      content: text,
      toolCalls,
      tokenEstimate: estimateTokens(text) + toolCalls.reduce((s, tc) => s + estimateTokens(tc.arguments) + 8, 0),
      timestamp: Date.now(),
    };
    newTurns.push(assistantTurn);
    messages.push({
      role: 'assistant',
      content: text,
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      await config.trace?.emit('runner', 'tool_call', {
        agent_id: config.agentId,
        tool: tc.name,
        args: tc.arguments,
        iter,
      });

      const result = await config.tools.execute(tc.name, tc.arguments);
      const resultJson = JSON.stringify(result);

      const toolTurn: Turn = {
        role: 'tool',
        content: resultJson,
        toolCallId: tc.id,
        tokenEstimate: estimateTokens(resultJson),
        timestamp: Date.now(),
      };
      newTurns.push(toolTurn);
      messages.push({
        role: 'tool',
        content: resultJson,
        tool_call_id: tc.id,
      });

      await config.trace?.emit('runner', 'observation', {
        agent_id: config.agentId,
        tool: tc.name,
        success: result.success,
        summary: result.summary,
      });
    }
    // 下一轮: LLM 看到 tool 结果后再决定下一步 (再调 tool / 出 final)
  }

  // ── 跑出 maxIterations 仍没拿到 final → truncated ─────────────────────
  truncated = true;
  finalText = '[达到最大迭代次数, 未能给出最终回复. 请重试或简化请求.]';
  const turn: Turn = {
    role: 'assistant',
    content: finalText,
    tokenEstimate: estimateTokens(finalText),
    timestamp: Date.now(),
  };
  newTurns.push(turn);
  await config.trace?.emit('runner', 'error', {
    agent_id: config.agentId,
    reason: 'max_iterations',
    maxIterations: config.maxIterations,
  });
  return { text: finalText, newTurns, iterations: config.maxIterations, usage, truncated };
}
