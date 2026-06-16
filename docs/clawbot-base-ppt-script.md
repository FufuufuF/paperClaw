# clawbot 基座实现汇报文字稿

---

## Slide 1: 这一部分讲什么

这一部分先不讲 paper 业务包，而是讲底层的 clawbot 基座。

clawbot 基座解决的是一个通用问题：如何把一个大模型包装成可以持续对话、可以调用工具、可以维护上下文、也可以接入不同输入输出渠道的 Agent 框架。

我会按六个模块讲：

1. Channel：连接 Agent 和输入输出源。
2. Tool：把外部能力包装成模型可调用的工具。
3. Skill：把工具使用策略写成可注入的指令。
4. Memory：维护长期记忆和历史压缩。
5. AgentLoop：处理一条用户消息的外层生命周期。
6. AgentRunner：处理模型和工具之间的内层循环。

---

## Slide 2: 整体分层

clawbot 可以分成外层编排和内层执行两层。

外层是 AgentLoop。它关心一条用户消息从进入系统到回复用户的完整生命周期，包括恢复 session、判断命令、构造 prompt、调用 runner、保存结果、发送回复。

内层是 AgentRunner。它只关心一件事：给定 system prompt、历史消息和工具集合之后，反复调用模型。如果模型要调用工具，就执行工具并把结果继续喂回模型；如果模型不再调用工具，就拿到最终回复。

```text
Channel -> AgentLoop -> AgentRunner -> LLM
                         AgentRunner -> ToolRegistry -> Tools
Channel <- AgentLoop <- final response
```

---

## Slide 3: Channel 模块

Channel 模块的目标是把“消息来自哪里、回复发到哪里”和 Agent 内核解耦。

在代码里，Channel 是一个很小的接口：

```ts
interface Channel {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  onMessage(handler: InboundHandler): void;
}
```

用户输入会被统一包装成 `InboundMessage`：

```ts
{
  id: string,
  senderId: string,
  text: string,
  timestamp: number
}
```

Agent 的输出会被统一包装成 `OutboundMessage`：

```ts
{
  kind?: 'final' | 'progress' | 'tool_hint' | 'error',
  text: string,
  replyTo?: string,
  metadata?: object
}
```

因此 AgentLoop 不需要知道消息来自 CLI、飞书还是未来的 Web 页面。它只处理统一的消息结构。

---

## Slide 4: Tool 模块

Tool 模块负责把外部能力包装成模型可以调用的函数。

一个 Tool 主要包含：

```ts
interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  readOnly?: boolean;
  concurrencySafe?: boolean;
  confirmation?: {...};
  execute(args, ctx): Promise<ToolResult>;
}
```

其中 `name`、`description`、`parameters` 描述工具能力和参数格式，`execute` 是真正执行工具的代码。

模型本身不会直接执行代码。它只返回 tool call；具体参数解析、参数校验、错误包装和函数调用，都由 Tool 模块负责。

所以 Tool 是模型和真实外部能力之间的边界层。

---

## Slide 5: ToolRegistry

`ToolRegistry` 是工具注册中心，它主要负责：

1. `register(tool)`：显式注册工具。
2. `getToolDefs()`：生成传给 LLM 的 tool schema。
3. `prepareCall()`：解析并校验模型传来的参数。
4. `execute()`：执行工具，并统一包装执行结果。
5. `scope()` / `scopeByTag()`：给 sub-agent 派生受限工具集。

这里有一个重要设计：`execute()` 尽量不把错误直接抛给上层。

如果工具名不存在、参数不合法、执行过程中抛错，都会被包装成：

```ts
{
  success: false,
  data: { error: ... },
  summary: ...
}
```

这样 Runner 可以稳定地把工具结果回传给模型，而不是让整个 Agent 流程直接崩掉。

---

## Slide 6: Skill 模块

Tool 只告诉模型“能调用什么函数”，但 Skill 告诉模型“什么时候调用、怎么组合这些工具”。

clawbot 的 Skill 是 Markdown 文件，通常叫 `SKILL.md`。它可以带一些元信息，例如：

```text
description: paper search workflow
always: true

这里写具体的使用策略和流程说明。
```

`SkillsLoader` 会扫描 workspace skills 和 builtin skills：

1. workspace skill 可以覆盖 builtin skill。
2. disabled skill 会被隐藏。
3. `always: true` 的 skill 会自动注入 system prompt。
4. 其他 skill 会出现在可用 skill 摘要里。

所以 Skill 本质上不是可执行代码，而是可配置、可扩展的 Agent 行为说明。

---

## Slide 7: Tool 和 Skill 如何进入模型上下文

Tool 和 Skill 都会影响模型决策，但进入模型的方式不完全一样。

Tool 有两层入口：

1. `ContextBuilder` 会把工具列表渲染进 system prompt，给模型一个可读的工具说明。
2. `AgentRunner` 在请求 LLM 时会传入 `tools.getToolDefs()`，这是模型真正产生 tool call 所依赖的 schema。

Skill 主要通过 `ContextBuilder` 进入 system prompt：

1. `always: true` 的 skill 会作为 Active Skills 完整注入。
2. 其他 skill 会作为 Available Skills 摘要出现。

所以可以这样理解：

```text
Tool = prompt 中的说明 + LLM API tools schema
Skill = prompt 中的行为策略和工具组合方法
```

---

## Slide 8: Memory 模块

Memory 模块解决的是长期上下文问题。

普通聊天系统只靠当前 session 历史，很容易遇到两个问题：

1. 历史太长，超过上下文窗口。
2. 长期偏好、用户画像、历史经验无法稳定复用。

clawbot 的 Memory 主要有几类文件：

```text
nanobot-store/
  MEMORY.md      # 长期记忆
  SOUL.md        # agent 自我设定或长期行为约束
  USER.md        # 用户相关信息
  memory/
    history.jsonl
    .cursor
    .dream_cursor
```

其中 `MEMORY.md`、`SOUL.md`、`USER.md` 会作为 context block 注入 prompt。

---

## Slide 9: Memory 和 Session 的关系

Session 和 Memory 需要区分。

Session 保存的是当前对话的逐轮历史，包括 user turn、assistant turn、tool turn。它用于恢复当前会话，让模型知道刚才聊了什么。

Memory 保存的是跨 session 的长期信息。比如用户长期关注什么方向、过去沉淀过哪些重要事实、系统应该长期遵守什么行为偏好。

项目里还有几个和 Memory 相关的模块：

1. `AutoCompact`：在 session 空闲或超预算时触发压缩。
2. `Consolidator`：把旧对话整理成摘要。
3. `Dream`：把 history 进一步整理进长期 memory。

所以 session 更像短期工作记忆，memory 更像长期记忆。

---

## Slide 10: AgentLoop 当前实现

AgentLoop 负责处理一条用户消息的外层生命周期。

当前代码里的阶段是：

```text
RESTORE -> COMPACT -> COMMAND -> BUILD -> RUN -> SAVE -> RESPOND -> DONE
```

各阶段含义是：

1. `RESTORE`：加载或创建 session，并先保存用户消息。
2. `COMPACT`：准备 session 压缩结果或摘要。
3. `COMMAND`：判断是否是 slash command；如果命中，就可以短路返回。
4. `BUILD`：构造 system prompt 和发给模型的历史消息。
5. `RUN`：交给 AgentRunner 执行模型和工具循环。
6. `SAVE`：把 Runner 产生的新 turn 写回 session。
7. `RESPOND`：通过 Channel 把最终结果发给用户。

这里需要说明一个现状：当前实现是按这些阶段串行组织代码，还不是 nanobot 里那种显式 `_TRANSITIONS` 转移表驱动的状态机。

---

## Slide 11: AgentLoop 的可靠性设计

虽然当前 AgentLoop 还是串行阶段实现，但它已经承担了外层可靠性职责。

最典型的一点是：在 `RESTORE` 阶段先保存用户消息。

```ts
let session = await manager.getOrCreate(sessionId);

const userTurn = {
  role: 'user',
  content: inbound.text,
  tokenEstimate: estimateTokens(inbound.text),
  timestamp: inbound.timestamp,
};

session.turns.push(userTurn);
await manager.save(session);
```

这意味着系统不是先调用模型，而是先确保用户消息已经落盘。

即使后面 LLM 请求失败、工具执行失败、进程中断，用户刚才输入的内容也不会丢。

---

## Slide 12: AgentRunner 的职责

AgentRunner 是内层执行循环。它不关心 Channel，也不直接保存 Session。

它拿到的是：

1. system prompt。
2. 当前对话 messages。
3. ToolRegistry。
4. LLM client。
5. 最大迭代次数和上下文预算。

它返回的是：

1. 最终回复文本。
2. 本次运行产生的新 turns。
3. token usage。
4. 使用过哪些工具。
5. 停止原因。

所以 Runner 的边界很清楚：它只负责“模型和工具怎么跑到最终答案为止”，不负责外部生命周期。

---

## Slide 13: AgentRunner 的内层循环

AgentRunner 的核心逻辑是 tool-use iteration loop：

```text
while iteration < maxIterations:
  1. 整理 messages，控制上下文预算
  2. 调 LLM，携带 tool definitions
  3. 如果模型返回 tool_calls：
       执行工具
       把 tool result 追加为 tool message
       继续下一轮
  4. 如果没有 tool_calls：
       当前 assistant text 就是最终回复
       返回给 AgentLoop
```

这里有两个关键点：

第一，工具调用不是外层硬编码决定的，而是模型根据 prompt、skill 和 tool schema 自己决定。

第二，工具结果不会直接展示给用户，而是先回到模型上下文里，让模型基于真实结果组织最终回答。

---

## Slide 14: Runner 的上下文治理

Runner 每轮请求模型前，会先治理消息上下文。

主要包括：

1. 删除孤立的 tool result，避免 provider 拒绝非法消息序列。
2. 给缺失 tool result 的 tool call 补占位结果，保证工具调用配对完整。
3. 压缩过长的 tool result。
4. 根据 context budget 裁剪历史。
5. 对空回复和 length 截断做恢复。

这个设计让 Runner 更像一个健壮的执行引擎，而不是简单地调用一次 LLM API。

尤其是在工具调用很多、PDF 内容很长、搜索结果很长的场景下，上下文治理是保证系统能持续运行的关键。

---

## Slide 15: 一条普通消息的完整链路

把这些模块串起来看，一条普通用户消息的流程是：

```text
1. 用户在 CLI 输入一句话
2. Channel 把它包装成 InboundMessage
3. AgentLoop 根据 senderId 找到 session
4. AgentLoop 保存 user turn
5. AgentLoop 判断是否是 slash command
6. ContextBuilder 构造 system prompt
   - 加入 Tool 列表说明
   - 加入 Skill 内容
   - 加入 Memory context
7. AgentRunner 调用 LLM，并传入 tool schema
8. 如果 LLM 要用工具，ToolRegistry 执行工具
9. 工具结果回到 Runner，再次交给 LLM
10. LLM 生成最终回复
11. AgentLoop 保存 assistant turn
12. Channel 把回复打印回终端
```

这样，clawbot 基座就完成了一轮从输入到输出的闭环。

---

## Slide 16: 这套基座的价值

我认为 clawbot 基座的价值主要有三点。

第一，它把输入输出、Agent 生命周期、工具执行、长期记忆和业务技能分开了。每个模块职责比较清楚。

第二，它让业务能力可以插件化挂载。后面 paper 包里的论文搜索、PDF 阅读、知识图谱维护，本质上都是通过 Tool 和 Skill 接到这个基座上的。

第三，它把可靠性问题前置到了框架层。比如 session 持久化、上下文压缩、工具错误包装、命令短路，都不需要每个业务工具重复实现。

所以 paperClaw 不是直接写一个“论文搜索脚本”，而是先做了一个可扩展的对话式 Agent 基座，再把论文阅读能力放到这个基座上运行。

---

## Slide 17: 过渡到 paper 包

讲完 clawbot 基座后，下一部分就可以讲 paper 包。

paper 包不是重新实现一套 Agent，而是在基座上挂载论文阅读相关能力：

1. 论文搜索工具。
2. PDF 下载工具。
3. 分章节阅读工具。
4. 笔记写入工具。
5. 用户 profile 更新。
6. 论文知识图谱维护。

也就是说，clawbot 提供通用 Agent 框架，paper 包提供面向论文场景的具体工具和技能。

这就是整个项目的分层关系。
