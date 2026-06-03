# clawbot — 架构设计文档

> 创建日期: 2026-06-01
> 最近更新: 2026-06-01
> 前置阅读: `docs/design.md` (产品定位 + 需求)
> 参考实现: `~/Desktop/personal-projects/nanobot` (nanobot 源码)

---

## 0. 架构变更概述

原设计 (`design.md` §6-7) 是 **pipeline 形态**: CLI 命令 → 执行一次流程 → 产出文件.

新设计是 **对话式 Agent 形态**: 多轮聊天 → Agent 自主决定何时调用 skill (search / read) → 通过 channel 适配器接入 CLI / 飞书.

| | 原架构 | 新架构 |
|---|---|---|
| 交互 | `pnpm search:query "..."` 一次性执行 | 多轮自由对话, 技能在对话中触发 |
| 内核 | 线性 flow (decompose→search→triage→shortlist) | Agent Loop (BUILD→RUN→PROCESS) |
| 模块耦合 | search 和 reader 完全独立, 用 PDF 文件耦合 | 主 agent 统一调度 search/read tool |
| 上下文管理 | 无 (每次 run 独立) | Token budget + tool result compaction |
| 搜索评估 | batch classification (单次 LLM/paper) | Sub-agent per paper (ReAct loop, context 隔离) |
| 接入方式 | CLI 脚本 | Channel 抽象 (CLI → 飞书) |

**不变的**: 产品定位 (`design.md` §0-4), 评估方案 (§9), 技术栈选择 (TypeScript + pnpm monorepo), LLM 多后端抽象, Trace JSONL 格式.

---

## 1. 从 nanobot 学到的核心模式

> 以下总结 nanobot 源码中和 clawbot 最相关的 6 个设计模式. 完整分析见 `.claude/plans/graceful-jumping-mist.md`.

### 1.1 Agent Loop (nanobot: `agent/runner.py`)

nanobot 的内核是一个 **tool-use iteration loop**:

```
while iteration < max_iterations:
  1. 组装 messages (system prompt + history, 受 token 预算约束)
  2. 调 LLM (带 tool definitions)
  3. 如果 response 含 tool_calls → 执行 → 把结果追加到 history → continue
     否则 → final text response → break
```

外层再包一个 8-state FSM (RESTORE→COMPACT→COMMAND→BUILD→RUN→SAVE→RESPOND→DONE), 处理 session 恢复、compaction、slash command 等.

**clawbot 简化**: 不需要 FSM, 直接用 3-phase loop. Session 管理极简 (单用户场景为主).

### 1.2 Tool System (nanobot: `agent/tools/base.py` + `registry.py`)

```python
class Tool(ABC):
    name: str
    description: str
    parameters: dict  # JSON Schema
    async def execute(self, **kwargs) -> str
```

- Auto-discovery via `pkgutil.iter_modules`
- Scoped registries: `ToolLoader.load(ctx, registry, scope="subagent")` 给子 agent 受限工具集
- 并发执行: 标记 `concurrency_safe` 的 tools 可并行跑

**clawbot 简化**: 手动注册 (工具数量少), `registry.scope(names)` 派生子集给 sub-agent.

### 1.3 Skill System (nanobot: `skills/*.md`)

nanobot 的 skill 是 **纯文本指令** (Markdown + YAML frontmatter):
- `always: true` 的 skill 每轮注入 system prompt
- 其他 skill 只放一行摘要, LLM 决定何时 `read_file(SKILL.md)` 加载完整指令
- Skill 本身不包含代码, 只是"告诉 LLM 该怎么用某些 tools"

**clawbot 简化**: 不用 markdown 文件, skill = TypeScript 模块 (导出 tools 数组 + instructions 字符串).

### 1.4 Subagent (nanobot: `agent/subagent.py`)

- `SubagentManager.spawn()` → asyncio.Task → 独立 `AgentRunner.run()` (fresh conversation)
- 受限工具集 (`scope="subagent"`)
- 结果通过 `MessageBus` 以 `InboundMessage(channel="system")` 回传主 loop
- 主 agent 异步收到通知, 像收到用户消息一样处理

**clawbot 简化**: Sub-agent 是 **同步 await** 的 (不通过 MessageBus 异步). 因为搜索/精读 tool 需要等结果才能返回给主 agent.

### 1.5 Context Management (nanobot: `agent/memory.py` + `runner.py`)

三层策略:
1. **Micro-compaction**: 旧 tool results 替换为 `[result omitted]` (runner 内, 保留最近 10 条)
2. **Token-budget consolidation**: 超预算时用 LLM summarize 旧对话, 存入 `history.jsonl`
3. **AutoCompact**: 空闲 session 整体压缩

**clawbot 简化**: 只需 Layer 1 (tool result compaction) + 简单的 token budget 裁剪. 不需要 LLM-powered consolidation (session 生命周期短).

### 1.6 Channel Adapter (nanobot: `channels/base.py` + `feishu.py`)

```python
class BaseChannel(ABC):
    start() → None       # 长连接/轮询
    stop() → None
    send(msg) → None     # 发消息给用户
```

- `MessageBus`: inbound/outbound 双 asyncio.Queue
- Feishu: lark-oapi SDK + WebSocket 长连接 (无需公网 IP)
- 丰富的消息格式处理 (markdown → card, 流式更新)

**clawbot**: 保持相同抽象, CLI + Feishu 两个实现.

---

## 2. Package 结构

```
packages/
  core/                          # 共享基础设施 (agent 内核 + tool 系统 + memory + channel)
    src/
      llm/                       # 【保留】LLMClient 抽象 + DeepSeek 实现
        types.ts                 # ChatMessage, ToolDef, ToolCall, LLMResponse, LLMClient
        deepseek.ts              # OpenAI-compatible REST adapter
        index.ts                 # createLLMClient factory
      agent/                     # 【新建】对话式 agent 内核 (简易 nanobot 基座)
        types.ts                 # Session, Turn, RunnerConfig, AgentLoopConfig
        loop.ts                  # AgentLoop class (5-state turn machine)
        runner.ts                # runToolLoop(): 内层 tool-use iteration
        context.ts               # buildMessages(), compactToolResults()
        commands.ts              # CommandRouter + 内置 slash commands
        session-store.ts         # FileSessionStore (JSON 持久化)
        prompt.ts                # buildSystemPrompt()
      tools/                     # 【新建】tool 注册系统
        types.ts                 # Tool interface, ToolResult
        registry.ts              # ToolRegistry class
      memory/                    # 【新建 + 迁移】三层记忆
        notes.ts                 # Layer 1: NotesManager (CRUD notes/<slug>.md)
        profile.ts               # Layer 2: ProfileManager (迁移自 core/src/profile.ts, 增加写)
        index-store.ts           # Layer 3: IndexStore (index.json CRUD)
      channels/                  # 【新建】channel 抽象层
        types.ts                 # Channel, InboundMessage, OutboundMessage interfaces
        bus.ts                   # MessageBus (simplified async queue)
      trace.ts                   # 【保留】TraceBus (JSONL append-only)
      paths.ts                   # 【保留】loadEnv, getRepoRoot, runOutputDir
      util.ts                    # 【保留】withRetry, mapWithConcurrency
      index.ts                   # Re-export barrel

  search/                        # 搜索模块 (重构为 Tool 形态)
    src/
      paper-search-tool.ts       # 主 agent 的 "paper_search" tool (入口)
      tools/
        arxiv.ts                 # 【保留】searchArxiv (arXiv Atom API)
        triage.ts                # 【保留】triageBatch (fast mode: 单次 LLM call/paper)
        download.ts              # 【保留】downloadPdf / downloadPdfs
      subagent/
        manager.ts               # SubagentManager (spawn evaluators, concurrency control)
        evaluator.ts             # runEvaluator(): 单篇论文 ReAct 评估 sub-agent
        tools.ts                 # Sub-agent tools: read_abstract, submit_verdict
      flows/
        planner.ts               # 【保留】decomposeQuery, decideReplan, inferInterestForCron
      index.ts

  reader/                        # 阅读模块 (全新, Phase 2)
    src/
      read-paper-tool.ts         # 主 agent 的 "read_paper" tool (入口)
      agent/
        reader.ts                # runReader(): 4-phase 精读 sub-agent
      tools/
        pdf-extract.ts           # PDF 文本抽取 (pdf-parse)
        write-section.ts         # 写笔记各 section
        self-ask.ts              # self-ask + self-answer tool
      profile-updater.ts         # 精读后更新 profile
      index.ts

  cli/                           # CLI 通道 (Phase 1 交互入口)
    src/
      adapter.ts                 # CLIChannel implements Channel (readline-based)
      main.ts                    # 入口: 组装 agent + channel → 启动主循环
      renderer.ts                # Pretty-print (markdown → terminal)

  feishu/                        # 飞书通道 (Phase 2)
    src/
      adapter.ts                 # FeishuChannel implements Channel
      cards.ts                   # Shortlist → Feishu Interactive Card 转换
      index.ts
```

### 依赖关系

```
cli ──────────┐
              ├──> core (agent + tools + memory + channels + llm)
feishu ───────┘
              ↑
search ───────┘ (core 的 llm, trace, tools, util, memory)
reader ───────┘
```

`search` 和 `reader` 之间**无直接依赖** (保持 `design.md` 的设计决策).

---

## 3. Agent Core 详设

paperClaw 的 agent core 是一个**简易 nanobot 基座**——不是一个 while 循环，而是一个有明确状态转移的框架。Search skill 和 Read skill 作为业务能力挂载在这个基座上，飞书/CLI 作为 channel 接入这个基座。

### 3.1 双层架构（对应 nanobot 的 loop.py + runner.py）

```
┌─────────────────────────────────────────────────────────────┐
│  外层: Turn State Machine (AgentLoop)                        │
│  处理一条用户消息的完整生命周期                                │
│                                                              │
│  RESTORE ──→ COMMAND ──→ BUILD ──→ RUN ──→ RESPOND          │
│     │            │                   │                       │
│     │         (shortcut)          (内层循环)                  │
│     v            v                   v                       │
│  [恢复 session] [直接回复]     ┌────────────────┐            │
│                               │ 内层: Runner    │            │
│                               │ tool-use loop   │            │
│                               │ (BUILD→RUN→     │            │
│                               │  PROCESS 迭代)  │            │
│                               └────────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 外层: 5-State Turn Machine

每收到一条用户消息，走一遍状态机：

```typescript
// packages/core/src/agent/loop.ts

enum TurnState {
  RESTORE  = 'RESTORE',   // 恢复 session
  COMMAND  = 'COMMAND',   // 拦截 slash commands
  BUILD    = 'BUILD',     // 组装 prompt + compact context
  RUN      = 'RUN',       // 内层 tool-use loop
  RESPOND  = 'RESPOND',   // 发回复 + 持久化 session
}
```

**状态转移**:

```
RESTORE ──ok──→ COMMAND ──dispatch──→ BUILD ──ok──→ RUN ──ok──→ RESPOND
                   │
                   └──shortcut──→ RESPOND  (slash command 直接回复, 不经 LLM)
```

**各状态职责**:

| 状态 | 职责 | 对应 nanobot |
|------|------|-------------|
| RESTORE | 从 SessionStore 加载 session (turns history + metadata). 首次对话则创建新 session | `_state_restore` |
| COMMAND | 检查是否是 slash command (`/clear`, `/profile`, `/help`, `/history`). 是 → 直接处理, 转 RESPOND; 否 → 转 BUILD | `_state_command` |
| BUILD | 组装 system prompt (注入 profile summary + context). 对 history 做 compaction (压缩旧 tool results). 检查 token 预算 | `_state_compact` + `_state_build` 合并 |
| RUN | 把组装好的 messages 交给内层 Runner 执行 tool-use loop. Runner 返回最终文本 | `_state_run` |
| RESPOND | 将回复发送到 channel. 持久化 session (写盘). 更新 usage 统计 | `_state_save` + `_state_respond` 合并 |

**与 nanobot 8-state 的对比**:

| nanobot 状态 | paperClaw 处理方式 | 理由 |
|---|---|---|
| RESTORE | ✅ 保留 | 飞书场景: 用户早上问, 下午回来继续 |
| COMPACT | 合并到 BUILD | 不需要独立的 idle-compact 检查 (我们没有 TTL 自动压缩) |
| COMMAND | ✅ 保留 | 需要 `/clear`, `/profile`, `/help` 等快捷命令 |
| BUILD | ✅ 保留 | 核心: 组装 prompt |
| RUN | ✅ 保留 | 核心: 内层 loop |
| SAVE | 合并到 RESPOND | 回复和存盘总是一起发生, 不需要拆开 |
| RESPOND | ✅ 保留 | 核心: 发回复 |
| DONE | 去掉 | 函数 return 即可 |

### 3.3 内层: Runner (Tool-Use Loop)

Runner 是纯粹的 LLM ↔ Tool 迭代循环，被 RUN 状态调用：

```typescript
// packages/core/src/agent/runner.ts

export async function runToolLoop(
  config: RunnerConfig,
  messages: ChatMessage[],
): Promise<RunnerResult> {

  for (let i = 0; i < config.maxIterations; i++) {
    // ── 调 LLM ─────────────────────────────────────────────
    const response = await config.llm.chat({
      system: config.systemPrompt,
      messages,
      tools: config.tools.getToolDefs(),
    });

    // ── 判断 ───────────────────────────────────────────────
    if (response.toolCalls?.length) {
      // 记录 assistant turn
      messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });

      // 执行 tool calls
      for (const tc of response.toolCalls) {
        const result = await config.tools.execute(tc.name, tc.arguments);
        messages.push({ role: 'tool', content: JSON.stringify(result), toolCallId: tc.id });
        config.trace?.emit('tool_call', { tool: tc.name, agent_id: config.agentId });
      }

      // 检查是否需要 mid-loop compaction
      if (estimateTokens(messages) > config.contextBudget * 0.8) {
        messages = compactToolResults(messages);
      }
    } else {
      // 无 tool call → final response
      return { text: response.text, messages, iterations: i + 1 };
    }
  }

  return { text: '[达到最大迭代次数]', messages, iterations: config.maxIterations };
}
```

**Runner 对 sub-agent 同样复用**: evaluator sub-agent 和 reader sub-agent 内部都调用同一个 `runToolLoop`，只是 config 不同 (更小的 maxIterations 和 contextBudget，受限的 tool set).

### 3.4 核心类型定义

```typescript
// packages/core/src/agent/types.ts

/** 外层 Loop 配置 */
export interface AgentLoopConfig {
  /** Session 持久化存储 */
  sessionStore: SessionStore;
  /** Command router (处理 slash commands) */
  commands: CommandRouter;
  /** Runner 配置 */
  runner: RunnerConfig;
  /** Channel (用于 RESPOND 阶段发消息) */
  channel: Channel;
  /** Trace */
  trace?: TraceBus;
}

/** 内层 Runner 配置 (主 agent 和 sub-agent 共用, 参数不同) */
export interface RunnerConfig {
  systemPrompt: string;
  tools: ToolRegistry;
  llm: LLMClient;
  maxIterations: number;      // 主 agent: 30, evaluator: 5, reader: 20
  contextBudget: number;      // 主 agent: 24000, evaluator: 4000, reader: 16000
  agentId: string;
  trace?: TraceBus;
}

/** 内层 Runner 返回 */
export interface RunnerResult {
  text: string;
  messages: ChatMessage[];
  iterations: number;
}

/** Session (跨消息持久化) */
export interface Session {
  id: string;                  // session key (e.g. "feishu:user_123" or "cli:default")
  turns: Turn[];               // 完整对话历史
  metadata: {
    createdAt: string;
    lastActiveAt: string;
    totalUsage: { input: number; output: number };
  };
}

/** 对话中的一个 turn */
export interface Turn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  tokenEstimate: number;
  timestamp: number;
}

/** Session 持久化接口 */
export interface SessionStore {
  load(sessionId: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  delete(sessionId: string): Promise<void>;
  /** 列出所有 session (用于 /history 命令) */
  list(): Promise<Array<{ id: string; lastActiveAt: string; turnCount: number }>>;
}
```

### 3.5 AgentLoop 外层伪代码

```typescript
// packages/core/src/agent/loop.ts

export class AgentLoop {
  constructor(private config: AgentLoopConfig) {}

  /**
   * 处理一条用户消息的完整生命周期.
   * 对应 nanobot 的 _process_message.
   */
  async processMessage(inbound: InboundMessage): Promise<void> {
    let state: TurnState = TurnState.RESTORE;
    let session: Session;
    let runnerResult: RunnerResult | null = null;
    let directResponse: string | null = null;

    // ── RESTORE ──────────────────────────────────────────────
    session = await this.config.sessionStore.load(inbound.senderId)
              ?? createNewSession(inbound.senderId);
    session.turns.push(inboundToTurn(inbound));
    session.metadata.lastActiveAt = new Date().toISOString();

    state = TurnState.COMMAND;

    // ── COMMAND ──────────────────────────────────────────────
    if (inbound.text.startsWith('/')) {
      const result = this.config.commands.handle(inbound.text, session);
      if (result) {
        directResponse = result.text;
        if (result.mutatedSession) session = result.mutatedSession;
        state = TurnState.RESPOND;  // shortcut: 跳过 BUILD + RUN
      } else {
        state = TurnState.BUILD;
      }
    } else {
      state = TurnState.BUILD;
    }

    // ── BUILD ────────────────────────────────────────────────
    if (state === TurnState.BUILD) {
      // 1. 组装 system prompt (注入 profile summary)
      const systemPrompt = await buildSystemPrompt(this.config);

      // 2. 对 session.turns 做 compaction (压缩旧 tool results)
      const messages = buildMessages(session, this.config.runner.contextBudget);

      state = TurnState.RUN;

      // ── RUN ──────────────────────────────────────────────
      runnerResult = await runToolLoop({
        ...this.config.runner,
        systemPrompt,
      }, messages);

      // 将 runner 产出的新 turns 追加到 session
      appendRunnerTurns(session, runnerResult);

      state = TurnState.RESPOND;
    }

    // ── RESPOND ──────────────────────────────────────────────
    const responseText = directResponse ?? runnerResult?.text ?? '[无回复]';
    await this.config.channel.send({ text: responseText });

    // 持久化 session
    await this.config.sessionStore.save(session);
  }
}
```

### 3.6 Command Router (Slash Commands)

```typescript
// packages/core/src/agent/commands.ts

export interface CommandResult {
  text: string;
  mutatedSession?: Session;  // 如果 command 修改了 session (e.g. /clear)
}

export class CommandRouter {
  private commands = new Map<string, CommandHandler>();

  register(name: string, handler: CommandHandler): void;

  /** 尝试处理. 返回 null 表示不是 command, 交给 LLM */
  handle(input: string, session: Session): CommandResult | null;
}

// 内置 commands:
// /clear  — 清空当前 session, 重新开始
// /profile — 打印当前 profile.md 内容
// /help   — 列出可用命令
// /history — 列出历史 session
// /cost   — 打印当前 session 的 token 消耗
```

**为什么需要 Command Router**:
- 不走 LLM → 零延迟响应, 零 token 消耗
- 提供"管理面"能力 (清 session, 查状态)
- 参考 nanobot: `CommandRouter` 在 `_state_command` 阶段拦截 `/stop`, `/new`, `/model` 等

### 3.7 Session 持久化

```typescript
// packages/core/src/agent/session-store.ts

/**
 * 文件系统 session store.
 * 每个 session 存为 output/sessions/<session_id>.json
 * 
 * 对应 nanobot 的 session/manager.py (JSONL 格式).
 * 我们简化为 JSON (session 不会太大, 不需要 append-only).
 */
export class FileSessionStore implements SessionStore {
  constructor(private sessionsDir: string) {}

  async load(id: string): Promise<Session | null>;
  async save(session: Session): Promise<void>;   // atomic write (tmp + rename)
  async delete(id: string): Promise<void>;
  async list(): Promise<...>;
}
```

### 3.8 Context Compaction

在 BUILD 阶段, 对 session.turns 做 compaction 后再传入 Runner:

```typescript
// packages/core/src/agent/context.ts

/**
 * 从 session.turns 构建发给 Runner 的 messages, 遵守 token 预算.
 *
 * 策略 (简化版 nanobot micro-compaction):
 * 1. 保留最近 3 次 tool exchange 的完整结果
 * 2. 更老的 tool result → 替换为该 tool 返回的 summary 字段
 *    (每个 ToolResult 都带一个 summary, 就是为此设计的)
 * 3. 如果仍超预算 → 从最早的 turn 开始丢弃 (保证最近对话完整)
 * 4. 被丢弃的 turns 不删除 (仍在 session.turns 里), 只是不发给 LLM
 */
export function buildMessages(session: Session, budget: number): ChatMessage[] {
  // ... 实现
}
```

**与 nanobot 的对比**:

| | nanobot | clawbot |
|---|---|---|
| Tool result compaction | 保留最近 10 条, 其余 `[omitted]` | 保留最近 3 条, 其余用 ToolResult.summary |
| 超预算处理 | LLM-powered summarization (expensive) | 丢弃旧 turns (good enough for <30 turn sessions) |
| Idle compaction | TTL 后 auto-compact + LLM summary 存档 | 不需要 (session 自然短, 持久化的是完整 turns) |
| Session 持久化 | JSONL (append-only, 支持 2000+ messages) | JSON (整体读写, session 不会太大) |

### 3.9 System Prompt 结构

```typescript
// packages/core/src/agent/prompt.ts

export async function buildSystemPrompt(config: AgentLoopConfig): Promise<string> {
  const profileSummary = await config.profileManager.getSummary();
  return SYSTEM_PROMPT_TEMPLATE.replace('{profileSummary}', profileSummary);
}
```

```markdown
你是 clawbot, 一个帮助用户发现和精读学术论文的 AI 助手. 你逐步建立用户的个人论文笔记库 (personal paper corpus).

## 行为准则
- 默认中文回复 (关键术语保留英文)
- 对话式交互, 简洁高效
- 搜索时主动解释在做什么, 结果用表格呈现
- 不确定时问用户, 不自作主张

## 可用能力
你有以下工具可用 (LLM 自动看到 tool definitions, 这里是补充说明):
- paper_search: 搜索论文. 支持 mode="fast" (批量分类, 快) 或 mode="thorough" (子agent逐篇评估, 慢但精准)
- read_paper: 精读一篇已下载的 PDF, 生成结构化笔记
- read_notes: 查看已有的论文笔记
- read_profile: 查看用户画像 (研究兴趣、已掌握知识)
- list_papers: 列出所有已知论文 (含状态: 已读/推荐/跳过)

## 当前用户概况
{profileSummary}  // 动态注入: 2-3 行 (已读 N 篇, 方向, 最近活动)

## 对话策略
- 用户给出明确 query → 调用 paper_search
- 用户说"帮我读 xxx" → 调用 read_paper
- 用户问已读论文细节 → 调用 read_notes
- 用户无明确指令 → 基于 profile 推荐下一步动作
- 用户笔记数 < 3 → 不做 personalization, 退化为纯搜索助手
```

---

## 4. Tool System 详设

### 4.1 Tool Interface

```typescript
// packages/core/src/tools/types.ts

export interface ToolResult {
  success: boolean;
  data: unknown;           // 结构化数据 (由各 tool 自定)
  /** 可选: 给 context compaction 用的摘要 (当完整结果被压缩时展示) */
  summary?: string;
}

export interface Tool {
  name: string;
  description: string;     // LLM 可见描述
  parameters: object;      // JSON Schema
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}
```

### 4.2 ToolRegistry

```typescript
// packages/core/src/tools/registry.ts

export class ToolRegistry {
  private tools: Map<string, Tool>;

  register(tool: Tool): void;
  unregister(name: string): void;

  /** 返回所有 tool 的 JSON Schema 定义 (传给 LLM) */
  getToolDefs(): ToolDef[];

  /** 执行 tool, 处理 JSON parse + 错误包装 */
  execute(name: string, argsJson: string | Record<string, unknown>): Promise<ToolResult>;

  /** 创建子集 registry (用于 sub-agent 的受限工具集) */
  scope(allowedNames: string[]): ToolRegistry;
}
```

### 4.3 主 Agent Tool 清单

| Tool | Package | 描述 |
|------|---------|------|
| `paper_search` | `@paperclaw/search` | 搜索论文 (query + mode) |
| `download_papers` | `@paperclaw/search` | 下载指定论文的 PDF |
| `read_paper` | `@paperclaw/reader` | 精读 PDF, 产出笔记 |
| `read_notes` | `@paperclaw/core` | 读取已有笔记内容 |
| `read_profile` | `@paperclaw/core` | 读取用户画像 |
| `list_papers` | `@paperclaw/core` | 列出 index.json 中所有论文 |

### 4.4 Sub-agent Tool 清单

**Evaluator sub-agent** (搜索阶段, 每篇论文一个):

| Tool | 描述 |
|------|------|
| `read_abstract` | 读取被评估论文的 abstract + meta |
| `submit_verdict` | 提交评估结果 {verdict, reason, summary, confidence} |

**Reader sub-agent** (精读阶段, 每篇论文一个):

| Tool | 描述 |
|------|------|
| `read_section` | 读取 PDF 指定 section 的文本 |
| `write_note_section` | 写笔记某个 section 的内容 |
| `self_ask` | self-ask: 提出问题并尝试从论文中回答 |
| `submit_note` | 提交完成的笔记 + verdict |

---

## 5. Search Skill 详设 (带 Sandbox)

### 5.1 完整数据流

```
User: "帮我找 agent harness 相关论文"
         │
         v
Main Agent (AgentLoop → Runner)
         │ LLM 决定调用 paper_search
         v
┌── paper_search tool.execute({query: "agent harness", mode: "thorough"}) ──┐
│                                                                            │
│  1. profileManager.read()                                                  │
│     → readSlugs: ["react-agent", "reflexion"]                              │
│                                                                            │
│  2. indexStore.knownIds()                                                   │
│     → Set<"2401.12345", "2310.06770", ...>                                 │
│                                                                            │
│  3. decomposeQuery("agent harness")  [复用 planner.ts]                     │
│     → ["agent harness design", "LLM tool use framework"]                   │
│                                                                            │
│  4. searchArxiv(terms)  [复用 arxiv.ts]                                    │
│     → 40 candidates (ArxivCandidate[])                                     │
│                                                                            │
│  5. filter: 去除 readSlugs + knownIds 已有的                               │
│     → 35 new candidates                                                    │
│                                                                            │
│  6. mode == 'thorough'?                                                    │
│     ├── YES → SubagentManager.evaluateBatch(candidates)                    │
│     │         (每篇论文 spawn 一个 evaluator sub-agent, max 6 并发)         │
│     └── NO  → triageBatch(candidates)  [复用 triage.ts, fast mode]          │
│                                                                            │
│  7. 收集结果 → rank (recommend > maybe > skip, 同级按 year desc)            │
│                                                                            │
│  8. indexStore.upsertBatch(newEntries)  [写入新发现的论文]                   │
│                                                                            │
│  9. return { success: true, data: shortlist, summary: "找到 8 篇..." }     │
└────────────────────────────────────────────────────────────────────────────┘
         │
         v
Main Agent 收到 tool result (shortlist)
         │ LLM 生成自然语言回复, 呈现结果
         v
User sees: "找到 8 篇相关论文, 推荐 5 篇: [表格]"
```

### 5.2 Evaluator Sub-agent (Sandbox)

每个 evaluator 是一个独立的 mini-agent, 运行完整的 `runAgentLoop`:

```typescript
// packages/search/src/subagent/evaluator.ts

const EVALUATOR_SYSTEM_PROMPT = (query: string) => `
你是一个论文评估助手. 你的任务是评估一篇论文是否与用户的研究方向相关.

用户正在搜索: "${query}"

流程:
1. 调用 read_abstract 获取论文的标题、作者、摘要
2. 基于摘要判断与搜索方向的相关性
3. 调用 submit_verdict 提交你的判断

评判标准:
- recommend: 高度相关, 有明确的方法论贡献或工程洞察
- maybe: 有一定相关性, 但不确定是否值得精读
- skip: 不相关, 或内容过于基础/重复
`;

export async function runEvaluator(
  candidate: ArxivCandidate,
  context: { query: string; llm: LLMClient; trace?: TraceBus },
): Promise<EvaluationResult> {
  const tools = new ToolRegistry();
  tools.register(makeReadAbstractTool(candidate));
  tools.register(makeSubmitVerdictTool());

  const config: AgentConfig = {
    systemPrompt: EVALUATOR_SYSTEM_PROMPT(context.query),
    tools,
    llm: context.llm,
    maxIterations: 5,       // 评估很轻量, 2-3 轮就够
    contextBudget: 4000,    // 只需要装下 abstract + 推理
    agentId: `evaluator-${candidate.arxiv_id}`,
    trace: context.trace,
  };

  const state: AgentState = {
    turns: [{ role: 'user', content: `评估这篇论文: "${candidate.title}"`, ... }],
    iteration: 0,
    usage: { input: 0, output: 0 },
    done: false,
  };

  const response = await runAgentLoop(config, state);
  return extractVerdictFromState(state);  // 从 submit_verdict tool call 中提取结果
}
```

### 5.3 SubagentManager

```typescript
// packages/search/src/subagent/manager.ts

export class SubagentManager {
  constructor(private opts: {
    concurrency: number;  // default: 6
    llm: LLMClient;
    trace?: TraceBus;
  }) {}

  /**
   * 并发评估一批候选论文.
   * 使用 mapWithConcurrency (复用 core/util.ts) 控制并发.
   */
  async evaluateBatch(
    candidates: ArxivCandidate[],
    context: { query: string },
  ): Promise<EvaluationResult[]> {
    return mapWithConcurrency(
      candidates,
      this.opts.concurrency,
      (candidate) => runEvaluator(candidate, {
        query: context.query,
        llm: this.opts.llm,
        trace: this.opts.trace,
      }),
    );
  }
}
```

### 5.4 两种模式对比

| | Fast Mode | Thorough Mode |
|---|---|---|
| 实现 | 复用 `triageBatch` (单次 LLM call/paper) | Sub-agent per paper (ReAct loop) |
| 上下文隔离 | 无 (batch classification) | 完全隔离 (独立 AgentState) |
| 推理深度 | 1 步 (看 abstract → 判断) | 2-3 步 (read → think → submit) |
| 成本 | ~1x | ~3-5x |
| 用途 | 日常使用 (默认) | Demo 演示 agent 架构能力 |
| 答辩价值 | 基线 | "sub-agent context 隔离" 核心论点 |

用户在对话中可控制: `"找论文, 仔细评估"` → thorough; 默认 → fast.

---

## 6. Read Skill 详设

### 6.1 Reader Sub-agent

精读是完全隔离的 sub-agent, **PDF 全文只存在于 reader 的 context 内**, 不进入主 agent:

```
read_paper tool.execute({arxiv_id: "2401.12345"})
  │
  ├── 1. downloadPdf(arxiv_id) → local PDF path  [复用 download.ts]
  ├── 2. extractText(pdfPath) → sections[]        [pdf-parse]
  └── 3. runReader(sections, config)              [独立 sub-agent]
              │
              │  tools: [read_section, write_note_section, self_ask, submit_note]
              │  context budget: 16000 tokens
              │  max iterations: 20
              │
              │  Phase 1 (Skim):
              │    read_section("abstract") → read_section("conclusion")
              │    → write_note_section("skim", content)
              │
              │  Phase 2 (Method):
              │    read_section("method") → self_ask("核心算法是什么?")
              │    → write_note_section("method", content)
              │
              │  Phase 3 (Engineering):
              │    read_section("experiments") → self_ask("有无开源实现?")
              │    → write_note_section("engineering", content)
              │
              │  Phase 4 (Verdict):
              │    综合前 3 phase → submit_note(verdict: "adopt", note: ...)
              │
              v
         返回 { slug, verdict, oneLiner }
```

### 6.2 精读后记忆更新链

```typescript
// read_paper tool 的 execute 末尾:

// 1. 存笔记文件
await notesManager.write(note);

// 2. 更新 index.json
await indexStore.upsert({
  arxiv_id,
  slug: note.slug,
  title: note.title,
  year: note.year,
  verdict: note.verdict,
  discoveredAt: existing?.discoveredAt ?? now,
  readAt: now,
  tags: note.extractedTags,
});

// 3. 更新 profile
await profileUpdater.afterRead(note);
```

---

## 7. 三层记忆系统

### 7.1 总览

| Layer | 存储 | 谁写 | 谁读 | 更新频率 | 用途 |
|-------|------|------|------|----------|------|
| 1. Notes | `output/notes/<slug>.md` | Reader sub-agent | 用户 + 主 agent (read_notes tool) | 每精读一篇 | 给用户看的论文笔记 |
| 2. Profile | `output/profile.md` | Reader (精读后触发) | Search + 主 agent system prompt | 每精读一篇 | 推荐触发 + AI 了解用户 |
| 3. Index | `output/index.json` | Search (发现) + Reader (精读后) | Search (去重) + 主 agent (list_papers) | 每次搜索/精读 | 论文状态机器索引 |

### 7.2 Layer 1: Notes (`output/notes/<slug>.md`)

```typescript
// packages/core/src/memory/notes.ts

export interface PaperNote {
  slug: string;           // e.g. "react-agent"
  arxivId: string;        // e.g. "2210.03629"
  title: string;
  createdAt: string;      // ISO date
  verdict: 'adopt' | 'watch' | 'skip';
  content: string;        // full markdown content
}

export class NotesManager {
  constructor(private notesDir: string) {}

  async list(): Promise<PaperNote[]>;       // 列出所有笔记
  async read(slug: string): Promise<PaperNote | null>;
  async write(note: PaperNote): Promise<void>;
  async slugs(): Promise<string[]>;          // 快速获取所有 slug (不读内容)
}
```

笔记模板 (复用 paper-reader 的 4 阶段):

```markdown
# {title}

## Meta
- arxiv_id: {arxiv_id}
- slug: {slug}
- created: {date}
- verdict: {adopt|watch|skip}

## Skim
{一段话概括论文要解决什么问题, 提出了什么方法}

## Method
{核心方法/算法的技术描述}

## Engineering
{实现细节, 开源否, 可复现性}

## Verdict
{为什么采用/观望/跳过, 对自己研究的关系}
```

### 7.3 Layer 2: Profile (`output/profile.md`)

结构继承 `design.md` §3.2, 扩展写入能力:

```typescript
// packages/core/src/memory/profile.ts

export interface ProfileSnapshot {
  readSlugs: string[];            // 从 "已读索引" section 解析
  hasSignal: boolean;             // readSlugs.length >= 3
  raw: string;                    // 完整文件内容
}

export class ProfileManager {
  constructor(private profilePath: string) {}

  /** 读取 profile (复用现有 readProfile 逻辑) */
  async read(): Promise<ProfileSnapshot>;

  /** 追加一条已读记录 */
  async appendReadEntry(entry: {
    slug: string;
    date: string;
    verdict: string;
    oneLiner: string;
  }): Promise<void>;

  /** 更新"用户兴趣推断"section (LLM-powered) */
  async updateInterests(context: {
    newNote: PaperNote;
    currentProfile: string;
    llm: LLMClient;
  }): Promise<void>;

  /** 获取 system prompt 用的 2-3 行摘要 */
  async getSummary(): Promise<string>;
}
```

### 7.4 Layer 3: Index (`output/index.json`)

```typescript
// packages/core/src/memory/index-store.ts

export interface PaperIndexEntry {
  arxiv_id: string;
  slug: string;
  title: string;
  year: number;
  verdict: 'recommend' | 'maybe' | 'skip' | 'adopt' | 'watch';
  discoveredAt: string;       // ISO, 搜索发现时间
  readAt: string | null;      // ISO, 精读完成时间 (null = 未读)
  tags: string[];             // 从笔记中提取的标签
}

export class IndexStore {
  constructor(private indexPath: string) {}

  async load(): Promise<PaperIndexEntry[]>;
  async upsert(entry: Partial<PaperIndexEntry> & { arxiv_id: string }): Promise<void>;
  async upsertBatch(entries: PaperIndexEntry[]): Promise<void>;
  async knownIds(): Promise<Set<string>>;          // 快速去重
  async filter(pred: (e: PaperIndexEntry) => boolean): Promise<PaperIndexEntry[]>;
}
```

### 7.5 记忆交互矩阵

```
                    reads                   writes
              ┌─────────────────────┬─────────────────────┐
  paper_search │ Profile (过滤已读)  │ Index (新发现论文)    │
              │ Index (去重)         │                     │
              ├─────────────────────┼─────────────────────┤
  read_paper  │ Index (查 meta)     │ Notes (新笔记)       │
              │                     │ Index (更新 readAt)  │
              │                     │ Profile (追加+推断)  │
              ├─────────────────────┼─────────────────────┤
  read_notes  │ Notes (读内容)       │ (无)                │
              ├─────────────────────┼─────────────────────┤
  read_profile│ Profile (读全文)     │ (无)                │
              ├─────────────────────┼─────────────────────┤
  list_papers │ Index (全量)         │ (无)                │
              └─────────────────────┴─────────────────────┘
```

---

## 8. Channel 适配层

### 8.1 接口定义

```typescript
// packages/core/src/channels/types.ts

export interface InboundMessage {
  id: string;               // unique message id
  senderId: string;         // channel-specific user identifier
  text: string;             // user input text
  timestamp: number;        // unix ms
  attachments?: Array<{
    type: 'pdf' | 'image' | 'file';
    path?: string;          // local path (if already downloaded)
    url?: string;           // remote url (channel fetches for us)
  }>;
}

export interface OutboundMessage {
  text: string;             // markdown formatted response
  data?: unknown;           // structured data for rich rendering (shortlist, etc.)
  replyTo?: string;         // 引用哪条消息
}

export interface Channel {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
}
```

### 8.2 MessageBus

```typescript
// packages/core/src/channels/bus.ts

/**
 * 简易消息总线, 解耦 channel adapter 和 agent loop.
 * nanobot 用双 asyncio.Queue; 我们用 Promise-based wait.
 */
export class MessageBus {
  /** Channel adapter 调用: 收到用户消息 */
  pushInbound(msg: InboundMessage): void;

  /** Agent loop 调用: 等待下一条用户消息 */
  nextMessage(): Promise<InboundMessage>;

  /** Agent loop 调用: 发送回复 (路由到当前 channel) */
  respond(msg: OutboundMessage): Promise<void>;

  /** 绑定 channel */
  attach(channel: Channel): void;
}
```

### 8.3 CLI Channel (Phase 1)

```typescript
// packages/cli/src/adapter.ts

/**
 * readline-based CLI adapter.
 * - 用 > 提示符等待输入
 * - 支持 /quit, /exit 退出
 * - 回复用 markdown 直出 (terminal 可读)
 */
export class CLIChannel implements Channel { ... }
```

### 8.4 Feishu Channel (Phase 2)

```typescript
// packages/feishu/src/adapter.ts

/**
 * Feishu/Lark adapter.
 *
 * 使用 @larksuiteoapi/node-sdk (官方 Node.js SDK):
 * - WebSocket 长连接 (不需要公网 IP)
 * - 接收 im.message.receive_v1 事件
 * - 发送文本/card 消息
 *
 * 参考: nanobot/channels/feishu.py (Python 版本的等价实现)
 *
 * 关键设计:
 * - 简短回复 → text 消息
 * - Shortlist → Interactive Card (table)
 * - 长文回复 → post (rich text)
 * - group chat: 只在 @bot 时响应
 */
export class FeishuChannel implements Channel { ... }
```

### 8.5 主入口 (组装)

```typescript
// packages/cli/src/main.ts

async function main() {
  // 1. 初始化基础设施
  const llm = createLLMClient('deepseek');
  const trace = new TraceBus(resolve(outputDir, 'trace.jsonl'));
  const sessionStore = new FileSessionStore(resolve(outputDir, 'sessions'));

  // 2. 初始化 Memory
  const notesManager = new NotesManager(resolve(outputDir, 'notes'));
  const profileManager = new ProfileManager(resolve(outputDir, 'profile.md'));
  const indexStore = new IndexStore(resolve(outputDir, 'index.json'));

  // 3. 注册 Tools
  const tools = new ToolRegistry();
  tools.register(createPaperSearchTool({ llm, indexStore, profileManager, trace }));
  tools.register(createReadPaperTool({ llm, notesManager, indexStore, profileManager }));
  tools.register(createReadNotesTool({ notesManager }));
  tools.register(createReadProfileTool({ profileManager }));
  tools.register(createListPapersTool({ indexStore }));

  // 4. 注册 Slash Commands
  const commands = new CommandRouter();
  commands.register('/clear', handleClear);
  commands.register('/profile', handleProfile);
  commands.register('/help', handleHelp);
  commands.register('/history', handleHistory);
  commands.register('/cost', handleCost);

  // 5. 启动 Channel
  const channel = new CLIChannel();

  // 6. 组装 AgentLoop (基座)
  const agent = new AgentLoop({
    sessionStore,
    commands,
    runner: {
      tools,
      llm,
      maxIterations: 30,
      contextBudget: 24000,
      agentId: 'master',
      trace,
    },
    channel,
    profileManager,
    trace,
  });

  // 7. 启动: channel 收到消息 → agent.processMessage 处理
  channel.onMessage(msg => agent.processMessage(msg));
  await channel.start();
}
```

---

## 9. 代码复用明细

### 9.1 直接保留 (无需修改)

| 文件 | 用途 | 被谁调用 |
|------|------|----------|
| `core/src/llm/types.ts` | LLMClient 接口定义 | 全局 |
| `core/src/llm/deepseek.ts` | DeepSeek adapter | 主 agent + sub-agents |
| `core/src/llm/index.ts` | createLLMClient factory | main.ts |
| `core/src/trace.ts` | TraceBus (JSONL) | agent loop + tools |
| `core/src/util.ts` | withRetry, mapWithConcurrency | SubagentManager, arxiv.ts |
| `core/src/paths.ts` | loadEnv, getRepoRoot | main.ts |
| `search/src/tools/arxiv.ts` | searchArxiv() | paper_search tool |
| `search/src/tools/triage.ts` | triageBatch() | paper_search tool (fast mode) |
| `search/src/tools/download.ts` | downloadPdf() | paper_search + read_paper tools |

### 9.2 迁移 + 扩展

| 原文件 | 新位置 | 改动 |
|--------|--------|------|
| `core/src/profile.ts` | `core/src/memory/profile.ts` | 增加 write 方法 (appendReadEntry, updateInterests) |
| `search/src/flows/planner.ts` | 保持原位 | decomposeQuery + decideReplan 逻辑不变, 被 paper_search tool 内部调用 |
| `search/src/flows/query-flow.ts` | 拆散 | 其内部逻辑分散到 paper-search-tool.ts execute 方法中 |
| `search/src/flows/cron-flow.ts` | 拆散 | inferInterestForCron 保留, flow 逻辑合并入 paper_search tool 的 cron 模式 |
| `search/src/__tests__/` | 保持原位 | smoke test 仍可用; 增加 sub-agent 相关测试 |

### 9.3 删除

| 文件 | 理由 |
|------|------|
| `cli/src/search-query.ts` | 被对话式 CLI (main.ts) 取代 |
| `cli/src/search-cron.ts` | 同上 |
| `cli/src/search-download.ts` | 同上 |
| `search/src/types.ts` (ShortlistEntry) | 被 ToolResult 中的结构化数据取代 |

### 9.4 全新编写

| 路径 | 说明 |
|------|------|
| `core/src/agent/*` | Agent 内核 (loop, context, types) |
| `core/src/tools/*` | Tool 系统 (registry, types) |
| `core/src/memory/notes.ts` | Notes CRUD |
| `core/src/memory/index-store.ts` | Index JSON store |
| `core/src/channels/*` | Channel 抽象 + MessageBus |
| `search/src/paper-search-tool.ts` | paper_search tool 入口 |
| `search/src/subagent/*` | Sub-agent 系统 |
| `reader/*` | 整个阅读模块 |
| `cli/src/adapter.ts` | CLI channel |
| `cli/src/main.ts` | 入口 |
| `feishu/*` | 飞书 channel |

---

## 10. 开发阶段与验收标准

### Phase 1 (Week 1): Agent Core + Search + CLI

**目标**: 在 CLI 中能和 bot 对话, 搜索论文, 多轮追问.

| Day | 模块 | 产出 |
|-----|------|------|
| 1-2 | `core/src/agent/*` + `core/src/tools/*` | Agent loop 能跑 (mock tool 验证) |
| 3-4 | `search/src/paper-search-tool.ts` + `search/src/subagent/*` | 搜索 tool 端到端 |
| 5-6 | `core/src/channels/*` + `cli/src/*` | CLI 对话能跑 |
| 7 | `core/src/memory/index-store.ts` + 集成 | 搜索结果持久化, 多轮引用 |

**验收**: 终端输入 "帮我找 agent harness 相关论文" → 搜索 → 返回 shortlist → "第 3 篇详细说说" → 从 index 读取回复.

### Phase 2 (Week 2): Read Skill + Memory

**目标**: 搜索 → 精读 → 笔记 → profile 更新, 闭环.

| Day | 模块 | 产出 |
|-----|------|------|
| 1-3 | `reader/*` | Reader sub-agent 能精读 PDF, 产出笔记 |
| 4-5 | `core/src/memory/notes.ts` + `profile.ts` 扩展 | 三层记忆联动 |
| 6-7 | Cron 推荐逻辑 + 多轮稳定性 | Profile-driven 推荐 |

**验收**: 搜索 → "帮我读第 2 篇" → 精读 → 笔记生成 → profile 更新 → 再次搜索时过滤已读.

### Phase 3 (Week 3): Feishu + 评估

**目标**: 飞书可用 + 对比实验数据.

| Day | 模块 | 产出 |
|-----|------|------|
| 1-2 | `feishu/*` | 飞书 @bot 可交互 |
| 3-5 | Web UI (可选, 根据精力) | Live trace 展示 |
| 6-7 | 评估实验 + Demo | 覆盖度数据, 对照表 |

**验收**: 飞书中 @clawbot 触发搜索, 收到 card 格式结果; 有/无 profile 对照数据.

---

## 11. 与原 design.md 的关系

本文档**替代** `design.md` 中以下 section 的技术实现部分:
- §6 (仓库骨架) → 本文 §2
- §7 (Agent 框架核心组件) → 本文 §3-5
- §10 (排期) → 本文 §10

以下 section **保持不变**, 继续以 `design.md` 为准:
- §0-4 (产品定位, 两个核心功能, Profile 设计, paper-reader 关系)
- §5 (技术栈决策, LLM 多后端)
- §8 (Web UI) — Phase 3 再细化
- §9 (评估方案)
- §11 (Future Work)

**新增的核心变化** (本文档引入, design.md 未涉及):
- 对话式 Agent Loop (不再是 flow 函数直接调用)
- Channel 抽象 (CLI + 飞书)
- MessageBus (解耦 input/output)
- Sub-agent sandbox (evaluator per paper, 独立 AgentState)
- Tool 注册系统 (统一接口, scoped registry)
