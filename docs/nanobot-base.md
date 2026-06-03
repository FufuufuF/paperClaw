# 简易 Nanobot 基座 — 实现文档

> 创建日期: 2026-06-03
> 目标: 实现 paperClaw 的对话式 AI agent 基座
> 不含: 业务 skill (search/read)、Memory layer、Web UI
> 参考: nanobot 源码 (`~/Desktop/personal-projects/nanobot`)

---

## 0. Scope

本文档覆盖 **基座** 的实现——即一个可独立运行的对话式 agent 框架。完成后，它能：
- 在 CLI 中和用户多轮对话
- 通过 Tool Registry 挂载任意 tool
- 管理对话 session（持久化、恢复、清空）
- 处理 slash commands
- 在 context 超限时自动压缩
- 为后续接入飞书留好 Channel 接口

**不在本 scope 内**: paper_search tool、read_paper tool、SubagentManager、NotesManager、IndexStore、ProfileManager、FeishuChannel。这些是业务层，在基座完成后挂载。

---

## 1. 目录结构

```
packages/core/src/
├── agent/                    # 基座核心
│   ├── types.ts              # 所有类型定义
│   ├── loop.ts               # AgentLoop class (5-state FSM)
│   ├── runner.ts             # runToolLoop() (内层 LLM↔Tool 循环)
│   ├── context.ts            # buildMessages() + compactToolResults()
│   ├── commands.ts           # CommandRouter + 内置命令
│   ├── session-store.ts      # FileSessionStore
│   └── prompt.ts             # buildSystemPrompt()
├── tools/                    # Tool 系统
│   ├── types.ts              # Tool, ToolResult, ToolDef interfaces
│   └── registry.ts           # ToolRegistry class
├── channels/                 # Channel 抽象
│   ├── types.ts              # Channel, InboundMessage, OutboundMessage
│   └── bus.ts                # MessageBus
├── llm/                      # 【已有】
│   ├── types.ts
│   ├── deepseek.ts
│   └── index.ts
├── trace.ts                  # 【已有】TraceBus
├── paths.ts                  # 【已有】
├── util.ts                   # 【已有】
└── index.ts                  # barrel re-export

packages/cli/src/
├── adapter.ts                # CLIChannel implements Channel
└── main.ts                   # 入口: 组装基座 + 启动
```

---

## 2. 组件依赖图

```
main.ts
  │
  ├── CLIChannel ──────────────────────────────┐
  │                                            │
  ├── AgentLoop ◄──────────────────────────────┤
  │     │                                      │
  │     ├── SessionStore (load/save sessions)  │
  │     ├── CommandRouter (拦截 /commands)      │
  │     ├── buildSystemPrompt()                │
  │     ├── buildMessages() (context mgmt)     │
  │     │                                      │
  │     └── runToolLoop() (Runner)             │
  │           │                                │
  │           ├── LLMClient (chat with tools)  │
  │           └── ToolRegistry (execute tools) │
  │                                            │
  └── MessageBus ──────────────────────────────┘
        (连接 Channel ↔ AgentLoop)
```

---

## 3. 核心类型定义

```typescript
// packages/core/src/agent/types.ts

// ─── Turn & Session ────────────────────────────────────────

export interface Turn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];     // assistant turn 发起的 tool calls
  toolCallId?: string;        // tool turn 对应哪个 call
  tokenEstimate: number;
  timestamp: number;          // unix ms
}

export interface Session {
  id: string;                 // e.g. "cli:default", "feishu:user_abc"
  turns: Turn[];
  metadata: {
    createdAt: string;        // ISO
    lastActiveAt: string;     // ISO
    totalUsage: { input: number; output: number };
  };
}

// ─── Runner ────────────────────────────────────────────────

export interface RunnerConfig {
  systemPrompt: string;
  tools: ToolRegistry;
  llm: LLMClient;
  maxIterations: number;
  contextBudget: number;      // token 上限
  agentId: string;
  trace?: TraceBus;
}

export interface RunnerResult {
  text: string;               // 最终回复
  newTurns: Turn[];           // 本次 run 产生的所有 turns (追加到 session)
  iterations: number;
  usage: { input: number; output: number };
}

// ─── AgentLoop ─────────────────────────────────────────────

export interface AgentLoopConfig {
  sessionStore: SessionStore;
  commands: CommandRouter;
  runner: Omit<RunnerConfig, 'systemPrompt'>;  // systemPrompt 由 BUILD 阶段动态生成
  channel: Channel;
  trace?: TraceBus;
  /** 动态生成 system prompt 的函数 */
  buildPrompt: () => Promise<string>;
}

// ─── SessionStore ──────────────────────────────────────────

export interface SessionStore {
  load(id: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<Array<{ id: string; lastActiveAt: string; turnCount: number }>>;
}

// ─── CommandRouter ─────────────────────────────────────────

export interface CommandResult {
  text: string;
  mutatedSession?: Session;   // command 可能修改 session (e.g. /clear)
}

export type CommandHandler = (args: string, session: Session) => CommandResult | Promise<CommandResult>;
```

```typescript
// packages/core/src/tools/types.ts

export interface ToolResult {
  success: boolean;
  data: unknown;
  /** compaction 时替代完整结果的摘要 */
  summary?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: object;         // JSON Schema
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: object;
}
```

```typescript
// packages/core/src/channels/types.ts

export interface InboundMessage {
  id: string;
  senderId: string;
  text: string;
  timestamp: number;
}

export interface OutboundMessage {
  text: string;
  replyTo?: string;
}

export interface Channel {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
}
```

---

## 4. 各组件设计

### 4.1 ToolRegistry

```typescript
// packages/core/src/tools/registry.ts

export class ToolRegistry {
  private tools: Map<string, Tool>;

  register(tool: Tool): void;
  unregister(name: string): void;
  has(name: string): boolean;

  /** 返回所有 tool 的 schema (传给 LLM) */
  getToolDefs(): ToolDef[];

  /** 执行 tool, 返回 ToolResult. 处理 JSON parse 和错误包装 */
  execute(name: string, args: Record<string, unknown> | string): Promise<ToolResult>;

  /** 派生子集 (用于给 sub-agent 受限工具集) */
  scope(allowedNames: string[]): ToolRegistry;

  /** 当前注册的 tool 数量 */
  get size(): number;
}
```

### 4.2 Runner (内层 Loop)

```typescript
// packages/core/src/agent/runner.ts

/**
 * 内层 tool-use 循环.
 * 对应 nanobot 的 AgentRunner.run().
 *
 * 循环逻辑:
 *   1. 调 LLM (带 tool definitions)
 *   2. 如果 response 有 tool_calls → 执行 → 追加结果 → continue
 *   3. 如果无 tool_calls → 作为 final response 返回
 *   4. 每轮检查 token 预算, 超 80% 时做 mid-loop compaction
 *
 * 不负责: session 持久化, slash command, channel 通信.
 * 只负责: 给我 messages, 我跑到 LLM 不再调 tool 为止.
 */
export async function runToolLoop(config: RunnerConfig, messages: ChatMessage[]): Promise<RunnerResult>;
```

### 4.3 Context Manager

```typescript
// packages/core/src/agent/context.ts

/**
 * 从 session.turns 构建传给 Runner 的 messages.
 *
 * Compaction 策略:
 * 1. 保留最近 3 组 tool exchange (assistant+tool turns) 的完整内容
 * 2. 更老的 tool turns → 替换为其 ToolResult.summary (若有) 或 "[已省略, N chars]"
 * 3. 若仍超 budget → 从头部开始丢弃整组 user+assistant 对话
 * 4. 永远保留第一条 user message (首次意图不能丢)
 */
export function buildMessages(session: Session, budget: number): ChatMessage[];

/**
 * Runner 内部的 mid-loop compaction.
 * 当 tool results 累积过多时, 压缩较早的结果.
 */
export function compactToolResults(messages: ChatMessage[], keepRecent: number): ChatMessage[];

/**
 * 估算 token 数 (简单实现: chars / 3.5 for 中文, chars / 4 for 英文)
 */
export function estimateTokens(text: string): number;
```

### 4.4 Command Router

```typescript
// packages/core/src/agent/commands.ts

export class CommandRouter {
  register(name: string, handler: CommandHandler): void;

  /**
   * 尝试匹配 slash command.
   * - 输入以 / 开头 → 查找注册的 handler
   * - 匹配到 → 执行 handler, 返回 CommandResult
   * - 未匹配 → 返回 null (交给 LLM 处理)
   */
  handle(input: string, session: Session): Promise<CommandResult | null>;
}
```

**内置命令**:

| Command | 行为 |
|---------|------|
| `/clear` | 清空 session.turns, 返回 "对话已清空" |
| `/help` | 列出可用命令 + 当前挂载的 tools |
| `/history` | 列出所有 sessions (id + lastActive + turnCount) |
| `/cost` | 打印当前 session 的 token 消耗 |
| `/session` | 打印当前 session id 和 turn 数 |

### 4.5 Session Store

```typescript
// packages/core/src/agent/session-store.ts

/**
 * 基于文件系统的 session 持久化.
 * 存储路径: output/sessions/<session_id>.json
 *
 * 写入策略: atomic write (写 .tmp → rename)
 * 读取策略: JSON.parse 整个文件
 */
export class FileSessionStore implements SessionStore {
  constructor(private dir: string);
}
```

### 4.6 System Prompt Builder

```typescript
// packages/core/src/agent/prompt.ts

/**
 * 组装 system prompt.
 *
 * 基座只提供框架性的 prompt 模板.
 * 业务层 (main.ts) 通过 AgentLoopConfig.buildPrompt 注入动态内容 (如 profile summary).
 *
 * 模板结构:
 * - 身份与行为准则
 * - 可用能力说明 (从 ToolRegistry 自动生成)
 * - 动态上下文 (由 buildPrompt 回调提供)
 * - 对话策略
 */
export function buildBasePrompt(tools: ToolRegistry): string;
```

### 4.7 AgentLoop (外层 FSM)

```typescript
// packages/core/src/agent/loop.ts

/**
 * 对话式 agent 的外层状态机.
 * 对应 nanobot 的 AgentLoop._process_message.
 *
 * 生命周期:
 *   收到 InboundMessage → RESTORE → COMMAND → BUILD → RUN → RESPOND
 *
 * 使用方式:
 *   const loop = new AgentLoop(config);
 *   channel.onMessage(msg => loop.processMessage(msg));
 */
export class AgentLoop {
  constructor(config: AgentLoopConfig);

  /** 处理一条用户消息 (完整走一遍 FSM) */
  async processMessage(inbound: InboundMessage): Promise<void>;
}
```

### 4.8 MessageBus

```typescript
// packages/core/src/channels/bus.ts

/**
 * 消息总线: 解耦 Channel 和 AgentLoop.
 *
 * 流向:
 *   Channel → pushInbound → [queue] → AgentLoop polls via nextMessage()
 *   AgentLoop → respond() → Channel.send()
 *
 * 为什么需要 bus 而不是直接调用:
 * - Channel 和 AgentLoop 可以独立初始化
 * - 后续飞书 channel 是 event-driven (消息来了 push), 不是 loop pull
 * - 便于测试 (mock bus, 不需要真实 channel)
 */
export class MessageBus {
  attach(channel: Channel): void;
  pushInbound(msg: InboundMessage): void;
  nextMessage(): Promise<InboundMessage>;
  respond(msg: OutboundMessage): Promise<void>;
}
```

### 4.9 CLI Channel

```typescript
// packages/cli/src/adapter.ts

/**
 * 基于 readline 的 CLI channel.
 *
 * 行为:
 * - 启动时打印欢迎信息
 * - 用 "> " 提示符等待输入
 * - 空行跳过
 * - /quit 或 /exit 退出进程
 * - 收到输入 → 包装为 InboundMessage → 通知 handler
 * - 收到回复 → 打印到 stdout (可选: markdown 简单渲染)
 */
export class CLIChannel implements Channel { ... }
```

---

## 5. 数据流

### 5.1 正常对话 (走 LLM)

```
用户输入 "你好"
    │
    ▼
CLIChannel.onMessage → handler(InboundMessage)
    │
    ▼
AgentLoop.processMessage(msg)
    │
    ├── RESTORE: sessionStore.load("cli:default") → session (或新建)
    │            session.turns.push(userTurn)
    │
    ├── COMMAND: "/" 开头? → NO → 继续
    │
    ├── BUILD:  buildPrompt() → systemPrompt
    │           buildMessages(session, budget) → messages[]
    │
    ├── RUN:    runToolLoop({ systemPrompt, tools, llm, ... }, messages)
    │           │
    │           │  iteration 1:
    │           │    llm.chat(messages, tools) → { text: "你好！我是 clawbot...", toolCalls: [] }
    │           │    无 tool calls → 返回 final text
    │           │
    │           └── return RunnerResult { text: "你好！...", newTurns: [...] }
    │
    ├── RESPOND: channel.send({ text: "你好！..." })
    │            session.turns.push(assistantTurn)
    │            sessionStore.save(session)
    │
    └── done
```

### 5.2 Tool 调用场景

```
用户输入 "搜索 agent 论文"
    │
    ▼
... RESTORE → COMMAND(NO) → BUILD → RUN:

    runToolLoop:
    │
    │  iteration 1:
    │    llm.chat(messages, tools) → { toolCalls: [{ name: "paper_search", args: {...} }] }
    │    tools.execute("paper_search", args) → ToolResult { data: shortlist, summary: "8 篇" }
    │    追加 assistant turn (带 toolCalls) + tool turn (结果)
    │
    │  iteration 2:
    │    llm.chat(更新后的 messages) → { text: "找到 8 篇论文...", toolCalls: [] }
    │    无 tool calls → 返回
    │
    └── RunnerResult { text: "找到 8 篇...", iterations: 2 }

... → RESPOND → done
```

### 5.3 Slash Command (不走 LLM)

```
用户输入 "/clear"
    │
    ▼
... RESTORE → COMMAND:
    │
    │  commands.handle("/clear", session) → { text: "对话已清空", mutatedSession: emptySession }
    │  → shortcut to RESPOND
    │
    ├── RESPOND: channel.send({ text: "对话已清空" })
    │            sessionStore.save(emptySession)
    │
    └── done (跳过了 BUILD + RUN)
```

---

## 6. 验收标准

### AC-1: 基本对话

```
> 你好
clawbot: 你好！我是 clawbot，一个帮助你搜索和精读学术论文的 AI 助手。有什么可以帮你的？
> 1+1 等于几？
clawbot: 1+1=2。
```

**通过条件**: LLM 正确回复，无 tool 调用，多轮 context 保持。

### AC-2: Tool 注册与调用

注册一个 dummy tool `echo`，验证 agent 能调用它：

```
> 请用 echo 工具回显 "hello"
clawbot: [调用 echo tool] 结果: hello
```

**通过条件**: LLM 正确识别 tool → 调用 → 获取结果 → 组织回复。

### AC-3: 多轮 Tool 调用

注册 `add(a, b)` 和 `multiply(a, b)` 两个 dummy tools：

```
> 帮我算 (3+4) * 5
clawbot: [先调用 add(3,4) → 7, 再调用 multiply(7,5) → 35] 结果是 35。
```

**通过条件**: Runner 在一次 processMessage 中完成多次迭代（多次 tool call）。

### AC-4: Session 持久化

```
> 我叫小明
clawbot: 你好小明！
> /quit

[重启进程]

> 我叫什么名字？
clawbot: 你叫小明。
```

**通过条件**: session 写盘 → 重启后 load → 上下文恢复。

### AC-5: Slash Commands

```
> /help
clawbot: 可用命令: /clear, /help, /history, /cost, /session
         当前挂载工具: echo, add, multiply

> /cost
clawbot: 本次会话消耗: input 1,234 tokens, output 567 tokens

> /clear
clawbot: 对话已清空。

> 我叫什么名字？
clawbot: [不知道, 因为 context 被清了]
```

**通过条件**: command 正确拦截、不走 LLM、/clear 确实清空了 session。

### AC-6: Context Compaction

注册一个返回大量文本 (>2000 chars) 的 tool，连续调用 5 次：

```
> 调用 big_tool 5 次
clawbot: [5 次调用全部完成]
         (内部: 前 2 次的 tool result 已被 compaction 为 summary)

> 第 5 次返回了什么？
clawbot: [正确回答, 因为第 5 次结果仍完整保留]

> 第 1 次返回了什么？
clawbot: [只能给出 summary 级别的回答, 因为完整内容已被压缩]
```

**通过条件**: 不 OOM / 不超 context window / 最近结果完整 / 旧结果被压缩。

### AC-7: Channel 解耦

能够用同一个 AgentLoop 实例，只换 channel adapter 就能工作：

```typescript
// 验证: 用 mock channel 代替 CLI, agent 行为不变
const mockChannel = new MockChannel();
const loop = new AgentLoop({ ...config, channel: mockChannel });
mockChannel.simulateMessage("你好");
assert(mockChannel.lastSent.text.includes("clawbot"));
```

**通过条件**: AgentLoop 不直接依赖 readline / stdout，只依赖 Channel 接口。

---

## 7. 不在 scope 内 (后续挂载)

| 后续工作 | 依赖基座的什么 |
|----------|---------------|
| paper_search tool | ToolRegistry.register() |
| read_paper tool | ToolRegistry.register() |
| SubagentManager | runToolLoop() (sub-agent 复用同一个 Runner) |
| Memory (notes/profile/index) | 被 tools 内部使用, 基座不感知 |
| FeishuChannel | Channel 接口 + MessageBus |
| Trace 可视化 | TraceBus (已有) |

---

## 8. 技术约束

| 约束 | 值 | 理由 |
|------|---|------|
| 主 agent maxIterations | 30 | 搜索+精读最多十几步, 30 留余量 |
| 主 agent contextBudget | 24,000 tokens | DeepSeek context 64k, 留一半给 response + safety |
| Session 持久化格式 | JSON | session 不会超过几百 KB, 整体读写够用 |
| Token 估算 | chars / 3.5 (中文) 或 chars / 4 (英文) | 粗略但 fast, 不依赖 tiktoken |
| Tool result compaction | 保留最近 3 组 | 平衡 context 利用率和信息保留 |
| Slash command 前缀 | `/` | 和 nanobot 一致 |
