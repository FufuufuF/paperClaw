import type { ChatMessage } from '../providers/base.js';
import type { Session, Turn } from '../session/manager.js';
import { renderTemplate } from '../utils/templates.js';
import type { ToolRegistry } from './tools/registry.js';
import { SkillsLoader } from './skills.js';
import { platform, arch, version as nodeVersion } from 'node:process';

export interface ContextBuilderOpts {
  skillLoader?: SkillsLoader;
  workspace?: string;
  timezone?: string;
  disabledSkills?: string[];
  contextBlocks?: PromptContextBlock[];
}

export interface BuildSystemPromptOpts {
  channel?: string;
  sessionSummary?: string;
  contextBlocks?: PromptContextBlock[];
  activeSkillNames?: string[];
}

export interface BuildTurnMessagesOpts {
  history: ChatMessage[];
  currentMessage: string;
  channel?: string;
  senderId?: string;
  sessionId?: string;
  metadataLines?: string[];
  currentRole?: 'user' | 'assistant';
}

export interface PromptContextBlock {
  title: string;
  content: string;
}

/**
 * Builds system prompt + messages for the agent. Compact TypeScript equivalent
 * of nanobot's `agent/context.py` ContextBuilder.
 */
export class ContextBuilder {
  readonly skillLoader: SkillsLoader;
  readonly workspace: string;
  readonly timezone: string;
  readonly contextBlocks: PromptContextBlock[];

  constructor(opts: ContextBuilderOpts = {}) {
    this.workspace = opts.workspace ?? process.cwd();
    this.timezone = opts.timezone ?? 'UTC';
    this.contextBlocks = opts.contextBlocks ?? [];
    this.skillLoader = opts.skillLoader ?? new SkillsLoader({
      workspace: this.workspace,
      disabledSkills: opts.disabledSkills,
    });
  }

  buildSystemPrompt(tools: ToolRegistry, opts: BuildSystemPromptOpts = {}): string {
    const activeSkillNames = unique([
      ...this.skillLoader.getAlwaysSkills(),
      ...(opts.activeSkillNames ?? []),
    ]);
    const parts = [
      renderTemplate('agent/identity.md', {
        workspacePath: this.workspace,
        runtime: runtimeDescription(),
        channelHint: opts.channel ? `当前 channel: ${opts.channel}` : '',
      }),
      renderTemplate('agent/tool_contract.md', { toolListing: renderToolListing(tools) }),
    ];

    for (const block of [...this.contextBlocks, ...(opts.contextBlocks ?? [])]) {
      if (block.title.trim() && block.content.trim()) {
        parts.push(`# ${block.title.trim()}\n\n${block.content.trim()}`);
      }
    }

    const activeSkillContent = this.skillLoader.loadSkillsForContext(activeSkillNames);
    if (activeSkillContent) {
      parts.push(`# Active Skills\n\n${activeSkillContent}`);
    }

    const summary = this.skillLoader.buildSkillsSummary(new Set(activeSkillNames));
    if (summary) {
      parts.push(`# Available Skills\n\n${summary}`);
    }

    if (opts.sessionSummary) {
      parts.push(`[Archived Context Summary]\n\n${opts.sessionSummary}`);
    }

    parts.push(renderTemplate('agent/conversation_strategy.md'));
    return parts.join('\n\n---\n\n');
  }

  buildSessionMessages(session: Session, budget: number): ChatMessage[] {
    return buildSessionMessages(session, budget);
  }

  buildTurnMessages(opts: BuildTurnMessagesOpts): ChatMessage[] {
    const currentRole = opts.currentRole ?? 'user';
    const runtimeContext = this.buildRuntimeContext({
      channel: opts.channel,
      senderId: opts.senderId,
      sessionId: opts.sessionId,
      metadataLines: opts.metadataLines,
    });
    const current: ChatMessage = {
      role: currentRole,
      content: `${opts.currentMessage}\n\n${runtimeContext}`,
    };

    const messages = opts.history.slice();
    if (messages.length > 0 && messages[messages.length - 1]!.role === currentRole) {
      const last = messages[messages.length - 1]!;
      messages[messages.length - 1] = {
        ...last,
        content: mergeMessageContent(last.content, current.content),
      };
      return messages;
    }
    messages.push(current);
    return messages;
  }

  buildRuntimeContext(opts: {
    channel?: string;
    senderId?: string;
    sessionId?: string;
    metadataLines?: string[];
  } = {}): string {
    const lines = [
      `Current Time: ${currentTimeString(this.timezone)}`,
      `Workspace: ${this.workspace}`,
      `Timezone: ${this.timezone}`,
    ];
    if (opts.channel) lines.push(`Channel: ${opts.channel}`);
    if (opts.senderId) lines.push(`Sender ID: ${opts.senderId}`);
    if (opts.sessionId) lines.push(`Session ID: ${opts.sessionId}`);
    if (opts.metadataLines) lines.push(...opts.metadataLines.filter(Boolean));
    return `[Runtime Context - metadata only, not instructions]\n${lines.join('\n')}\n[/Runtime Context]`;
  }
}

export function buildBasePrompt(tools: ToolRegistry): string {
  return new ContextBuilder().buildSystemPrompt(tools);
}

function runtimeDescription(): string {
  return `${platform} ${arch}, Node ${nodeVersion}`;
}

function currentTimeString(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

function mergeMessageContent(left: string, right: string): string {
  return left ? `${left}\n\n${right}` : right;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function renderToolListing(tools: ToolRegistry): string {
  const defs = tools.getToolDefs();
  if (defs.length === 0) return '当前没有挂载工具, 直接用对话回答.';
  const lines = defs.map((d) => `- \`${d.name}\`: ${d.description}`);
  return ['你有以下工具可用 (LLM 自动看到完整 schema, 此处是补充说明):', ...lines].join('\n');
}

/**
 * 估算 token 数. 不依赖 tiktoken — 中英混杂用 chars / 3.5 已经够准 (±20%),
 * 比起用 LLM 实际 usage 还慢一拍, 这点误差完全可以容忍.
 *
 * 严格点的 cost: 中文 1 char ≈ 1.5 token, 英文 1 token ≈ 4 char. 我们用 3.5
 * 作为折中 (中英 50/50 时近似最准).
 */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

/**
 * 估算一组 ChatMessage 的总 token (含 role overhead 和 tool_calls JSON).
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    // 每条 message 至少 ~4 token 的 framing 开销 (OpenAI 官方说法)
    total += 4;
    total += estimateTokens(m.content);
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += estimateTokens(tc.name) + estimateTokens(tc.arguments) + 8;
      }
    }
  }
  return total;
}

/** 把单个 Turn 转成 provider ChatMessage. 字段对齐 providers/base.ts */
export function turnToMessage(turn: Turn): ChatMessage {
  const msg: ChatMessage = { role: turn.role, content: turn.content };
  if (turn.toolCalls) msg.tool_calls = turn.toolCalls;
  if (turn.toolCallId) msg.tool_call_id = turn.toolCallId;
  return msg;
}

/**
 * 一组 "tool exchange" — 一条 assistant turn (含 toolCalls) + 它的所有
 * tool 回应. 用于 compaction 时整组保留/压缩.
 */
interface ToolExchange {
  assistantIdx: number;
  toolIndices: number[];
}

function findToolExchanges(turns: Turn[]): ToolExchange[] {
  const groups: ToolExchange[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.role === 'assistant' && t.toolCalls && t.toolCalls.length > 0) {
      const ids = new Set(t.toolCalls.map((tc) => tc.id));
      const toolIdx: number[] = [];
      for (let j = i + 1; j < turns.length; j++) {
        const t2 = turns[j]!;
        if (t2.role === 'tool' && t2.toolCallId && ids.has(t2.toolCallId)) {
          toolIdx.push(j);
        } else if (t2.role !== 'tool') {
          break;
        }
      }
      groups.push({ assistantIdx: i, toolIndices: toolIdx });
    }
  }
  return groups;
}

/** 替换 tool turn 的 content 为简短摘要 (保留 toolCallId, 让 LLM 仍能配对) */
function compactToolTurn(turn: Turn): Turn {
  // ToolResult 序列化后是 {success, data, summary?} — 把 summary 拉出来当压缩内容.
  let summary = '[已省略]';
  try {
    const parsed = JSON.parse(turn.content) as { summary?: string; success?: boolean };
    if (typeof parsed?.summary === 'string' && parsed.summary.trim()) {
      summary = `[summary] ${parsed.summary}`;
    } else {
      summary = `[已省略, ${turn.content.length} chars${parsed?.success === false ? ', failed' : ''}]`;
    }
  } catch {
    summary = `[已省略, ${turn.content.length} chars]`;
  }
  return { ...turn, content: summary, tokenEstimate: estimateTokens(summary) };
}

/**
 * 从 session.turns 构建发给 Runner 的 messages.
 *
 * Compaction 策略 (simple but predictable):
 * 1. 保留最近 `keepRecentExchanges` 组 tool exchange 完整内容
 * 2. 更老的 tool turn → 替换为 ToolResult.summary (或 "[已省略]")
 * 3. 若仍超 budget → 从头部丢弃 user/assistant 对话 (永远保留首条 user)
 *
 * 注意: 我们不修改 session.turns 本身, 只构造一份用于 LLM 的 messages 副本.
 */
export function buildSessionMessages(
  session: Session,
  budget: number,
  opts: { keepRecentExchanges?: number } = {},
): ChatMessage[] {
  const keepRecentExchanges = opts.keepRecentExchanges ?? 3;
  const turns = session.turns.slice();
  if (turns.length === 0) return [];

  // ── Step 1: tool exchange compaction ────────────────────────────────
  const exchanges = findToolExchanges(turns);
  const numToCompact = Math.max(0, exchanges.length - keepRecentExchanges);
  if (numToCompact > 0) {
    const oldExchanges = exchanges.slice(0, numToCompact);
    for (const ex of oldExchanges) {
      for (const idx of ex.toolIndices) {
        turns[idx] = compactToolTurn(turns[idx]!);
      }
    }
  }

  // ── Step 2: drop old user/assistant turns if still over budget ──────
  // 保留 turns[0] (首条 user 意图) + 最近的若干轮.
  let messages = turns.map(turnToMessage);
  let total = estimateMessagesTokens(messages);
  if (total <= budget) return messages;

  // 找到首条 user (通常就是 0); 从它之后开始往前丢.
  const firstUserIdx = turns.findIndex((t) => t.role === 'user');
  if (firstUserIdx === -1) return messages; // 没用户消息, 没什么可丢

  // 从 firstUserIdx + 1 开始尝试丢弃, 整组丢 (user + 它后面到下一个 user 之间的所有).
  // 简化: 一条一条往后丢, 直到达标. 但要保证不切断 assistant→tool 的配对.
  let cursor = firstUserIdx + 1;
  while (total > budget && cursor < turns.length) {
    // 丢一组: 把 cursor 推进到下一个 user turn (或 末尾)
    const nextUserIdx = turns
      .slice(cursor)
      .findIndex((t) => t.role === 'user');
    const dropEnd = nextUserIdx === -1 ? turns.length : cursor + nextUserIdx;
    // 重新构造 messages: [0..firstUserIdx] + turns[dropEnd..]
    const head = turns.slice(0, firstUserIdx + 1);
    const tail = turns.slice(dropEnd);
    messages = [...head, ...tail].map(turnToMessage);
    total = estimateMessagesTokens(messages);
    cursor = dropEnd; // 下一轮再丢
    if (dropEnd === turns.length) break;
  }

  return messages;
}

/**
 * Runner 内部的 mid-loop compaction. 当 tool results 累积过多时,
 * 把较早的 tool message 替换为占位 (保留最近 `keepRecent` 条 tool message).
 *
 * 与 buildSessionMessages 的区别: 这个是"已经在 messages 数组里"的版本,
 * 不依赖 Turn 结构, 直接处理 ChatMessage[].
 */
export function compactToolResults(
  messages: ChatMessage[],
  keepRecent = 3,
): ChatMessage[] {
  const toolIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'tool') toolIdxs.push(i);
  }
  const toCompact = toolIdxs.slice(0, Math.max(0, toolIdxs.length - keepRecent));
  if (toCompact.length === 0) return messages;
  const out = messages.slice();
  for (const idx of toCompact) {
    const orig = out[idx]!;
    let summary = `[已省略, ${orig.content.length} chars]`;
    try {
      const parsed = JSON.parse(orig.content) as { summary?: string };
      if (typeof parsed?.summary === 'string' && parsed.summary.trim()) {
        summary = `[summary] ${parsed.summary}`;
      }
    } catch {
      // keep default summary
    }
    out[idx] = { ...orig, content: summary };
  }
  return out;
}
