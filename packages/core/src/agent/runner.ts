import type { ChatMessage, ChatResponse, LLMClient, ToolCall } from '../providers/base.js';
import type { TraceBus } from '../trace.js';
import type { Turn } from '../session/manager.js';
import {
  estimateMessagesTokens,
  estimateTokens,
} from './context.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ToolResult } from './tools/types.js';

export const BACKFILL_TOOL_RESULT_CONTENT = '[Tool result unavailable - call was interrupted or lost]';
export const EMPTY_FINAL_RESPONSE_MESSAGE = '[模型返回了空回复, 请重试或换一种问法.]';

// Runner 内部的恢复阈值。这里先固定为常量，后续如果需要开放给配置，再移动到 agent/config.ts。
const MAX_EMPTY_RETRIES = 2;
const MAX_LENGTH_RECOVERIES = 3;
const MICROCOMPACT_KEEP_RECENT = 10;
const MICROCOMPACT_MIN_CHARS = 500;
const TOOL_RESULT_DEFAULT_MAX_CHARS = 12_000;
const CONTEXT_SAFETY_BUFFER = 256;

/**
 * 单次 AgentRunner.run 的输入规格。
 *
 * 这里刻意不接收 Session 对象：Runner 只负责“模型 <-> 工具”的内层循环，
 * Session 的加载、保存、恢复由外层 AgentLoop/SessionManager 负责。
 */
export interface AgentRunSpec {
  /** 当前 run 使用的完整 system prompt。 */
  systemPrompt: string;
  /** 已经构造好的历史消息 + 当前用户消息。Runner 会复制一份，不直接改调用方数组。 */
  initialMessages: ChatMessage[];
  /** 本次 run 可见的工具集合，可以是主 registry，也可以是 sub-agent 的 scoped registry。 */
  tools: ToolRegistry;
  /** 最多允许多少轮 LLM 调用，防止模型无限 tool-call。 */
  maxIterations: number;
  /** 发给模型的上下文预算，用于 model-only 的历史裁剪。 */
  contextBudget: number;
  /** trace/checkpoint 中的 agent 标识。 */
  agentId: string;
  trace?: TraceBus;
  /** 透传给 provider 的采样温度。 */
  temperature?: number;
  /** 透传给 provider 的最大输出 token。 */
  maxTokens?: number;
  /** 单条 tool result 的最大保留字符数，超过后只给模型看摘要。 */
  maxToolResultChars?: number;
  /** 是否允许并发执行 concurrency-safe 的工具。 */
  concurrentTools?: boolean;
  /** 运行时 checkpoint 回调，由外层决定是否持久化到 Session.metadata。 */
  checkpointCallback?: (payload: AgentCheckpoint) => void | Promise<void>;
  /** maxIterations 触发时的自定义提示，可包含 `{maxIterations}`。 */
  maxIterationsMessage?: string;
}

/**
 * Runner 在关键阶段抛给外层的“可恢复现场”。
 *
 * nanobot 会把类似 payload 存到 session.metadata.runtime_checkpoint；
 * 这里 Runner 只负责产生 payload，不直接知道 Session 怎么持久化。
 */
export interface AgentCheckpoint {
  /** awaiting_tools: 已拿到 tool calls；tools_completed: tool result 已齐；final_response: 已完成最终回复。 */
  phase: 'awaiting_tools' | 'tools_completed' | 'final_response';
  iteration: number;
  agentId: string;
  /** 当前 iteration 的 assistant 消息，通常可能带 tool_calls。 */
  assistantMessage: ChatMessage;
  /** 已完成的 tool result；恢复时可以直接物化回历史。 */
  completedToolResults: ChatMessage[];
  /** 已发起但还没完成的 tool call；恢复时应补成 interrupted tool result。 */
  pendingToolCalls: ToolCall[];
}

/** 供 UI/trace 展示的工具执行摘要，不等同于发给 LLM 的完整 tool result。 */
export interface ToolRunEvent {
  name: string;
  status: 'ok' | 'error';
  detail: string;
}

/** 单次 run 的停止原因；外层可以据此决定是否提示用户、是否重试。 */
export type AgentStopReason =
  | 'completed'
  | 'max_iterations'
  | 'empty_final_response'
  | 'length_limit';

/**
 * AgentRunner.run 的输出。
 *
 * `messages` 是本次 run 后的完整模型消息副本；`newTurns` 是应该追加进 Session 的新 turn。
 * 两者分开是为了避免把 backfill/microcompact 这类 model-only 修复持久化。
 */
export interface AgentRunResult {
  text: string;
  messages: ChatMessage[];
  newTurns: Turn[];
  iterations: number;
  usage: { input: number; output: number };
  stopReason: AgentStopReason;
  truncated: boolean;
  toolsUsed: string[];
  toolEvents: ToolRunEvent[];
}

/**
 * 旧入口 runToolLoop 的配置形状。
 *
 * 目前保留是为了让已有调用方平滑迁移；真正的实现都委托给 AgentRunner。
 */
export interface RunnerConfig {
  systemPrompt: string;
  tools: ToolRegistry;
  llm: LLMClient;
  maxIterations: number;
  contextBudget: number;
  agentId: string;
  trace?: TraceBus;
  temperature?: number;
  maxTokens?: number;
  maxToolResultChars?: number;
  concurrentTools?: boolean;
  checkpointCallback?: (payload: AgentCheckpoint) => void | Promise<void>;
  maxIterationsMessage?: string;
}

export type RunnerResult = AgentRunResult;

/**
 * Nanobot 风格的内层执行循环：
 * 1. 修复/裁剪消息，生成只给模型看的 messagesForModel。
 * 2. 请求 LLM。
 * 3. 如果 LLM 返回 tool_calls，则执行工具并继续下一轮。
 * 4. 如果没有 tool_calls，则产出最终回复。
 *
 * Runner 不直接修改 Session。它只返回 newTurns，由 AgentLoop 决定如何保存。
 */
export class AgentRunner {
  constructor(private readonly llm: LLMClient) {}

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    // 运行期 messages 是一份副本，代表本次 run 内部不断增长的对话上下文。
    const messages = spec.initialMessages.slice();

    // newTurns 是唯一应该被外层追加到 Session.turns 的内容。
    const newTurns: Turn[] = [];
    const toolsUsed: string[] = [];
    const toolEvents: ToolRunEvent[] = [];
    const usage = { input: 0, output: 0 };

    // 两个恢复计数器都按“连续异常回复”计算，成功 tool call 或正常回复后会重置。
    let emptyResponseRetries = 0;
    let lengthRecoveries = 0;

    for (let iteration = 0; iteration < spec.maxIterations; iteration++) {
      // 每轮请求模型前，先治理上下文；治理结果只给模型看，不回写 messages/newTurns。
      const messagesForModel = this.prepareMessagesForModel(spec, messages);
      const response = await this.requestModel(spec, messagesForModel);
      accumulateUsage(usage, response.usage);

      const text = response.text ?? '';
      const toolCalls = response.toolCalls ?? [];

      // finish_reason=length 时即使 provider 携带了 tool call，也不能可靠执行，先走续写恢复。
      const hasExecutableToolCalls = toolCalls.length > 0 && response.finishReason !== 'length';

      if (hasExecutableToolCalls) {
        // 记录 assistant 发起 tool call 的消息：这条需要持久化，否则后续 tool result 无法配对。
        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: text,
          tool_calls: toolCalls,
        };
        messages.push(assistantMessage);
        newTurns.push(assistantTurn(text, toolCalls));
        toolsUsed.push(...toolCalls.map((tc) => tc.name));

        // 工具开始执行前保存 checkpoint，进程中断时可以恢复“哪些工具还没跑完”。
        await this.emitCheckpoint(spec, {
          phase: 'awaiting_tools',
          iteration,
          agentId: spec.agentId,
          assistantMessage,
          completedToolResults: [],
          pendingToolCalls: toolCalls,
        });

        // 执行 tool_calls，并把每个结果转成 role=tool 的 ChatMessage。
        const toolMessages = await this.executeToolCalls(spec, toolCalls, iteration, messagesForModel);
        for (const item of toolMessages) {
          messages.push(item.message);
          newTurns.push(toolTurn(item.message));
          toolEvents.push(item.event);
        }

        // 工具全部完成后再保存 checkpoint，恢复时可以直接把 assistant/tool 物化回历史。
        await this.emitCheckpoint(spec, {
          phase: 'tools_completed',
          iteration,
          agentId: spec.agentId,
          assistantMessage,
          completedToolResults: toolMessages.map((item) => item.message),
          pendingToolCalls: [],
        });

        // 工具链继续推进，说明前面的空回复/截断状态已经被打断。
        emptyResponseRetries = 0;
        lengthRecoveries = 0;
        continue;
      }

      if (isBlank(text)) {
        // 空回复先静默重试，避免偶发 provider 空 content 直接污染 Session。
        emptyResponseRetries++;
        if (emptyResponseRetries < MAX_EMPTY_RETRIES) {
          await spec.trace?.emit('runner', 'phase_begin', {
            note: 'empty response retry',
            agent_id: spec.agentId,
            iteration,
            retry: emptyResponseRetries,
          });
          continue;
        }

        // 连续空回复后，给模型一个“现在必须给最终答案”的补救提示，并且不再暴露 tools。
        const retryResponse = await this.requestFinalizationRetry(spec, messagesForModel);
        accumulateUsage(usage, retryResponse.usage);
        const retryText = retryResponse.text ?? '';
        if (!isBlank(retryText)) {
          return await this.finish(spec, {
            messages,
            newTurns,
            text: retryText,
            iteration,
            usage,
            stopReason: 'completed',
            toolsUsed,
            toolEvents,
          });
        }

        return await this.finish(spec, {
          messages,
          newTurns,
          text: EMPTY_FINAL_RESPONSE_MESSAGE,
          iteration,
          usage,
          stopReason: 'empty_final_response',
          toolsUsed,
          toolEvents,
        });
      }

      if (response.finishReason === 'length' && lengthRecoveries < MAX_LENGTH_RECOVERIES) {
        // 输出被截断时，保留已生成的 assistant 片段，再追加一个临时 user 提示让模型续写。
        // 这个临时 user 提示只存在于本次 Runner messages 里，不进入 newTurns。
        lengthRecoveries++;
        messages.push({ role: 'assistant', content: text });
        newTurns.push(assistantTurn(text));
        messages.push({
          role: 'user',
          content: 'Continue the previous answer from exactly where it stopped. Do not repeat completed text.',
        });
        await spec.trace?.emit('runner', 'phase_begin', {
          note: 'length recovery',
          agent_id: spec.agentId,
          iteration,
          recovery: lengthRecoveries,
        });
        continue;
      }

      // 走到这里说明没有 tool call、不是空回复，也不需要继续 length recovery，可以收尾。
      return await this.finish(spec, {
        messages,
        newTurns,
        text,
        iteration,
        usage,
        stopReason: response.finishReason === 'length' ? 'length_limit' : 'completed',
        toolsUsed,
        toolEvents,
      });
    }

    // 超过最大迭代数仍没最终答复：生成一条 assistant fallback，确保外层有内容可回复。
    const text = spec.maxIterationsMessage
      ? spec.maxIterationsMessage.replaceAll('{maxIterations}', String(spec.maxIterations))
      : `I reached the maximum number of tool call iterations (${spec.maxIterations}) without completing the task. You can try breaking the task into smaller steps.`;
    return await this.finish(spec, {
      messages,
      newTurns,
      text,
      iteration: Math.max(0, spec.maxIterations - 1),
      usage,
      stopReason: 'max_iterations',
      toolsUsed,
      toolEvents,
    });
  }

  private prepareMessagesForModel(spec: AgentRunSpec, messages: ChatMessage[]): ChatMessage[] {
    try {
      // 治理顺序很重要：
      // 1. 先删掉孤立 tool result，避免 provider 拒绝非法消息序列。
      // 2. 再补齐 assistant tool_calls 缺失的 tool result，让历史配对完整。
      // 3. 压缩/截断超长 tool result，控制上下文体积。
      // 4. 最后按 contextBudget 裁剪历史，并再次修复裁剪产生的新孤儿。
      let prepared = AgentRunner.dropOrphanToolResults(messages);
      prepared = AgentRunner.backfillMissingToolResults(prepared);
      prepared = AgentRunner.microcompact(prepared);
      prepared = this.applyToolResultBudget(spec, prepared);
      prepared = AgentRunner.snipHistory(spec, prepared);
      prepared = AgentRunner.dropOrphanToolResults(prepared);
      prepared = AgentRunner.backfillMissingToolResults(prepared);
      return prepared;
    } catch (err) {
      // 治理失败不能阻断主流程；降级到最小修复，尽量让模型请求继续。
      const msg = err instanceof Error ? err.message : String(err);
      void spec.trace?.emit('runner', 'error', {
        agent_id: spec.agentId,
        reason: 'context_governance_failed',
        error: msg,
      });
      try {
        return AgentRunner.backfillMissingToolResults(AgentRunner.dropOrphanToolResults(messages));
      } catch {
        return messages;
      }
    }
  }

  private async requestModel(spec: AgentRunSpec, messages: ChatMessage[]): Promise<ChatResponse> {
    // 常规模型请求：带 system prompt、上下文 messages、工具 schema 和 provider 参数。
    return await this.llm.chat({
      system: spec.systemPrompt,
      messages,
      tools: spec.tools.getToolDefs(),
      ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
      ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
    });
  }

  private async requestFinalizationRetry(
    spec: AgentRunSpec,
    messages: ChatMessage[],
  ): Promise<ChatResponse> {
    // 空回复补救请求不传 tools，避免模型继续进入工具循环而不是给最终答复。
    const retryMessages = messages.concat({
      role: 'user',
      content: 'Your previous response was empty. Provide a concise final answer now. Do not call tools.',
    });
    return await this.llm.chat({
      system: spec.systemPrompt,
      messages: retryMessages,
      ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
      ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
    });
  }

  private async executeToolCalls(
    spec: AgentRunSpec,
    toolCalls: ToolCall[],
    iteration: number,
    messagesForModel: ChatMessage[],
  ): Promise<Array<{ message: ChatMessage; event: ToolRunEvent }>> {
    // 按工具的并发安全性分批执行：只把 read-only/显式安全的工具放到同一批。
    const batches = this.partitionToolBatches(spec, toolCalls);
    const out: Array<{ message: ChatMessage; event: ToolRunEvent }> = [];

    for (const batch of batches) {
      const results = spec.concurrentTools && batch.length > 1
        ? await Promise.all(batch.map((tc) => this.executeSingleTool(spec, tc, iteration, messagesForModel)))
        : await runSequential(batch, (tc) => this.executeSingleTool(spec, tc, iteration, messagesForModel));
      out.push(...results);
    }

    return out;
  }

  private async executeSingleTool(
    spec: AgentRunSpec,
    toolCall: ToolCall,
    iteration: number,
    messagesForModel: ChatMessage[],
  ): Promise<{ message: ChatMessage; event: ToolRunEvent }> {
    // trace 事件给外部观察用，不参与模型上下文。
    await spec.trace?.emit('runner', 'tool_call', {
      agent_id: spec.agentId,
      tool: toolCall.name,
      args: toolCall.arguments,
      iter: iteration,
    });

    const result = await spec.tools.execute(toolCall.name, toolCall.arguments);
    const content = this.normalizeToolResult(spec, toolCall.id, toolCall.name, result);

    // OpenAI/DeepSeek 风格协议要求 tool result 使用 tool_call_id 绑定上一条 assistant tool_call。
    const message: ChatMessage = {
      role: 'tool',
      content,
      tool_call_id: toolCall.id,
    };
    const event = toolEvent(toolCall.name, result);

    await spec.trace?.emit('runner', 'observation', {
      agent_id: spec.agentId,
      tool: toolCall.name,
      success: result.success,
      summary: result.summary,
    });

    return { message, event };
  }

  private normalizeToolResult(
    spec: AgentRunSpec,
    toolCallId: string,
    toolName: string,
    result: ToolResult,
  ): string {
    // LLM 只能消费字符串 content，所以 ToolResult 在这里统一 JSON 序列化。
    let content = JSON.stringify(result);
    if (isBlank(content)) {
      content = `(${toolName} completed with no output)`;
    }

    // 超长结果不直接塞进上下文；优先保留 summary，让模型知道发生了什么。
    const maxChars = spec.maxToolResultChars ?? TOOL_RESULT_DEFAULT_MAX_CHARS;
    if (content.length > maxChars) {
      const summary = result.summary ? ` summary=${result.summary}` : '';
      return `[${toolName} result truncated from ${content.length} chars.${summary} tool_call_id=${toolCallId}]`;
    }
    return content;
  }

  private applyToolResultBudget(spec: AgentRunSpec, messages: ChatMessage[]): ChatMessage[] {
    // 这是对历史 tool message 的预算治理，不会修改原始 messages 数组。
    const maxChars = spec.maxToolResultChars ?? TOOL_RESULT_DEFAULT_MAX_CHARS;
    let updated: ChatMessage[] | null = null;
    const toolNames = toolNameByCallId(messages);

    for (let idx = 0; idx < messages.length; idx++) {
      const message = messages[idx]!;
      if (message.role !== 'tool' || message.content.length <= maxChars) continue;
      if (!updated) updated = messages.map((m) => ({ ...m }));
      const name = toolNames.get(message.tool_call_id ?? '') ?? 'tool';
      updated[idx]!.content = `[${name} result truncated from ${message.content.length} chars]`;
    }

    return updated ?? messages;
  }

  private partitionToolBatches(spec: AgentRunSpec, toolCalls: ToolCall[]): ToolCall[][] {
    // 默认串行执行，保持最保守、最容易 review 的行为。
    if (!spec.concurrentTools) return toolCalls.map((tc) => [tc]);

    const batches: ToolCall[][] = [];
    let current: ToolCall[] = [];
    for (const toolCall of toolCalls) {
      // concurrencySafe 的工具可以暂存在当前批次；遇到非安全工具时先 flush 当前批次。
      if (spec.tools.concurrencySafe(toolCall.name)) {
        current.push(toolCall);
        continue;
      }
      if (current.length > 0) {
        batches.push(current);
        current = [];
      }
      batches.push([toolCall]);
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  private async finish(
    spec: AgentRunSpec,
    opts: {
      messages: ChatMessage[];
      newTurns: Turn[];
      text: string;
      iteration: number;
      usage: { input: number; output: number };
      stopReason: AgentStopReason;
      toolsUsed: string[];
      toolEvents: ToolRunEvent[];
    },
  ): Promise<AgentRunResult> {
    // 最终回复必须同时进入 messages 和 newTurns：前者给返回值，后者给 Session 持久化。
    const assistantMessage: ChatMessage = { role: 'assistant', content: opts.text };
    opts.messages.push(assistantMessage);
    opts.newTurns.push(assistantTurn(opts.text));

    // final_response checkpoint 让外层知道当前 run 已经有可恢复的最终 assistant 消息。
    await this.emitCheckpoint(spec, {
      phase: 'final_response',
      iteration: opts.iteration,
      agentId: spec.agentId,
      assistantMessage,
      completedToolResults: [],
      pendingToolCalls: [],
    });

    await spec.trace?.emit('runner', opts.stopReason === 'completed' ? 'thought' : 'error', {
      agent_id: spec.agentId,
      text: opts.text.slice(0, 200),
      reason: opts.stopReason,
      iter: opts.iteration,
    });

    return {
      text: opts.text,
      messages: opts.messages,
      newTurns: opts.newTurns,
      iterations: opts.iteration + 1,
      usage: opts.usage,
      stopReason: opts.stopReason,
      truncated: opts.stopReason === 'max_iterations' || opts.stopReason === 'length_limit',
      toolsUsed: opts.toolsUsed,
      toolEvents: opts.toolEvents,
    };
  }

  private async emitCheckpoint(spec: AgentRunSpec, payload: AgentCheckpoint): Promise<void> {
    // Runner 不持久化 checkpoint，只把 payload 交给外层；外层可以写入 Session.metadata。
    if (spec.checkpointCallback) await spec.checkpointCallback(payload);
  }

  static dropOrphanToolResults(messages: ChatMessage[]): ChatMessage[] {
    // 合法 tool message 必须能在前文 assistant.tool_calls 中找到对应 id。
    const declared = new Set<string>();
    let updated: ChatMessage[] | null = null;

    for (let idx = 0; idx < messages.length; idx++) {
      const message = messages[idx]!;
      if (message.role === 'assistant') {
        for (const toolCall of message.tool_calls ?? []) {
          declared.add(toolCall.id);
        }
      }
      if (message.role === 'tool' && message.tool_call_id && !declared.has(message.tool_call_id)) {
        if (!updated) updated = messages.slice(0, idx).map((m) => ({ ...m }));
        continue;
      }
      if (updated) updated.push({ ...message });
    }

    return updated ?? messages;
  }

  static backfillMissingToolResults(messages: ChatMessage[]): ChatMessage[] {
    // 某些中断/裁剪会留下 assistant.tool_calls，但缺失对应 tool result；
    // 这里插入合成 tool result，保证 provider 看到的是完整 tool exchange。
    const declared: Array<{ assistantIdx: number; call: ToolCall }> = [];
    const fulfilled = new Set<string>();

    for (let idx = 0; idx < messages.length; idx++) {
      const message = messages[idx]!;
      if (message.role === 'assistant') {
        for (const call of message.tool_calls ?? []) declared.push({ assistantIdx: idx, call });
      } else if (message.role === 'tool' && message.tool_call_id) {
        fulfilled.add(message.tool_call_id);
      }
    }

    const missing = declared.filter(({ call }) => !fulfilled.has(call.id));
    if (missing.length === 0) return messages;

    const updated = messages.map((m) => ({ ...m }));
    let offset = 0;
    for (const item of missing) {
      let insertAt = item.assistantIdx + 1 + offset;
      while (insertAt < updated.length && updated[insertAt]!.role === 'tool') insertAt++;
      updated.splice(insertAt, 0, {
        role: 'tool',
        tool_call_id: item.call.id,
        content: BACKFILL_TOOL_RESULT_CONTENT,
      });
      offset++;
    }
    return updated;
  }

  static microcompact(messages: ChatMessage[]): ChatMessage[] {
    // 保留最近的 tool result 原文，更老且很长的结果替换为一行占位摘要。
    const toolIndices: number[] = [];
    for (let idx = 0; idx < messages.length; idx++) {
      if (messages[idx]!.role === 'tool') toolIndices.push(idx);
    }
    if (toolIndices.length <= MICROCOMPACT_KEEP_RECENT) return messages;

    const stale = toolIndices.slice(0, toolIndices.length - MICROCOMPACT_KEEP_RECENT);
    const toolNames = toolNameByCallId(messages);
    let updated: ChatMessage[] | null = null;
    for (const idx of stale) {
      const message = messages[idx]!;
      if (message.content.length < MICROCOMPACT_MIN_CHARS) continue;
      if (!updated) updated = messages.map((m) => ({ ...m }));
      const name = toolNames.get(message.tool_call_id ?? '') ?? 'tool';
      updated[idx]!.content = `[${name} result omitted from context]`;
    }
    return updated ?? messages;
  }

  static snipHistory(spec: AgentRunSpec, messages: ChatMessage[]): ChatMessage[] {
    // contextBudget 包含 system prompt，所以普通 messages 只能使用扣除 system 和安全缓冲后的预算。
    const budget = spec.contextBudget - estimateTokens(spec.systemPrompt) - CONTEXT_SAFETY_BUFFER;
    if (budget <= 0 || estimateMessagesTokens(messages) <= budget) return messages;

    // 尽量保留最早的 user 意图，避免裁剪后模型失去任务起点。
    const headUserIdx = messages.findIndex((m) => m.role === 'user');
    if (headUserIdx === -1) return messages;

    const head = messages.slice(0, headUserIdx + 1);
    let tail = messages.slice(headUserIdx + 1);

    while (tail.length > 0 && estimateMessagesTokens([...head, ...tail]) > budget) {
      // 从较老的 user 边界开始丢弃，避免切在一组 tool exchange 中间。
      const nextUser = tail.findIndex((m, idx) => idx > 0 && m.role === 'user');
      if (nextUser === -1) {
        // 如果没有更多 user 边界，只保留最后几条，再交给后续 repair 清理非法 tool 前缀。
        tail = tail.slice(Math.max(0, tail.length - 4));
        break;
      }
      tail = tail.slice(nextUser);
    }

    return [...head, ...tail];
  }
}

export async function runToolLoop(
  config: RunnerConfig,
  initialMessages: ChatMessage[],
): Promise<RunnerResult> {
  // 兼容旧函数入口：新逻辑全部交给 AgentRunner，避免两套 runner 行为分叉。
  const runner = new AgentRunner(config.llm);
  return await runner.run({
    systemPrompt: config.systemPrompt,
    initialMessages,
    tools: config.tools,
    maxIterations: config.maxIterations,
    contextBudget: config.contextBudget,
    agentId: config.agentId,
    trace: config.trace,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    maxToolResultChars: config.maxToolResultChars,
    concurrentTools: config.concurrentTools,
    checkpointCallback: config.checkpointCallback,
    maxIterationsMessage: config.maxIterationsMessage,
  });
}

function assistantTurn(content: string, toolCalls?: ToolCall[]): Turn {
  // 把 provider 层 ChatMessage/ToolCall 转成 session 层 Turn，供外层持久化。
  return {
    role: 'assistant',
    content,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    tokenEstimate: estimateTokens(content) + (toolCalls ?? []).reduce(
      (sum, tc) => sum + estimateTokens(tc.arguments) + estimateTokens(tc.name) + 8,
      0,
    ),
    timestamp: Date.now(),
  };
}

function toolTurn(message: ChatMessage): Turn {
  // tool turn 必须保留 toolCallId，否则下次回放给模型时无法和 assistant.tool_calls 配对。
  return {
    role: 'tool',
    content: message.content,
    toolCallId: message.tool_call_id,
    tokenEstimate: estimateTokens(message.content),
    timestamp: Date.now(),
  };
}

function toolEvent(name: string, result: ToolResult): ToolRunEvent {
  // ToolRunEvent 是给 trace/UI 的短摘要，完整数据仍在 role=tool 的消息 content 里。
  const detail = result.summary
    ? result.summary
    : JSON.stringify(result.data).replace(/\s+/g, ' ').slice(0, 120);
  return {
    name,
    status: result.success ? 'ok' : 'error',
    detail: detail || '(empty)',
  };
}

function accumulateUsage(
  target: { input: number; output: number },
  addition: { input: number; output: number } | undefined,
): void {
  // provider 可能不返回 usage；这种情况下按 0 累加。
  target.input += addition?.input ?? 0;
  target.output += addition?.output ?? 0;
}

function isBlank(value: string | undefined | null): boolean {
  // 空字符串、undefined、纯空白都视作空回复。
  return !value || value.trim().length === 0;
}

function toolNameByCallId(messages: ChatMessage[]): Map<string, string> {
  // 从 assistant.tool_calls 建立 call_id -> tool name 映射，后续压缩 tool result 时使用。
  const out = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.tool_calls ?? []) out.set(call.id, call.name);
  }
  return out;
}

async function runSequential<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  // 明确串行 await，避免副作用工具被 Promise.all 隐式并发执行。
  const out: R[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
}
