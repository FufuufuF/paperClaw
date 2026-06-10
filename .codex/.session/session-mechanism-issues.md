# Clawbot 会话机制问题说明

## 当前事实

现在 CLI 里的所有本地对话都会被映射到固定 session id：

```text
cli:default
```

相关实现位置：

- `packages/cli/src/main.ts` 创建 `FileSessionStore(output/sessions)`。
- `packages/cli/src/main.ts` 里把 CLI 的 `sessionIdFor` 写死为 `cli:default`。
- `packages/cli/src/channel/plain-channel.ts` 和 `packages/cli/src/channel/ink-channel.tsx` 的默认 `senderId` 也是 `cli:default`。

因此当前 CLI 聊天记录会写入同一个文件：

```text
output/sessions/cli_default.json
```

文件名是 `cli_default.json`，是因为 `FileSessionStore` 会把 session id 里不适合文件名的字符替换成 `_`，所以 `cli:default` 里的冒号变成了下划线。

## 为什么会出现这些问题

### 1. `cli:default` 不是一个真正的“会话 id”

现在的 `cli:default` 更像是“本地 CLI 这个发送者”的身份，而不是“某一次独立聊天”的身份。

这在单会话原型阶段可以工作，但它无法区分多个独立会话。

### 2. `/new` 当前只是重置当前 session

当前 `/new` 的实现会创建一个新的空 `Session`，但它沿用当前 session 的 id。

也就是说，执行 `/new` 时新建出来的 session id 仍然是：

```text
cli:default
```

然后 `AgentLoop` 把这个新 session 保存回同一个文件：

```text
output/sessions/cli_default.json
```

所以 `/new` 现在的实际语义更接近“清空当前会话并重新开始”，不是“创建一个新的会话文件”。

### 3. CLI 没有 active session 状态

当前 CLI 运行时没有维护类似下面这样的状态：

```text
currentSessionId = "某个会话 id"
```

因此后续输入永远会被路由到固定的 `cli:default`，也就没有地方让 `/use <id>` 或 `/switch <id>` 这类命令改变后续消息写入哪个 session。

### 4. 命令结果无法表达“切换会话”

当前 command 机制支持：

- 返回文本；
- 返回一个 `mutatedSession` 来替换当前 session；
- 返回 metadata。

但它没有办法表达：

```text
这条命令执行完以后，请把后续消息切换到另一个 session id。
```

因此即使 `/new` 生成了一个新的 session id，也还缺少从 command 到 AgentLoop，再到 CLI active session 状态的切换路径。

### 5. UI 层也有固定 session 假设

plain CLI 欢迎信息里直接写死显示 `session: cli:default`。Ink 状态栏目前也没有明确显示 active session id。

这会让用户无法确认自己当前到底在哪个会话里。

## 期望语义

CLI 应该区分三个概念：

- `senderId`：消息来自哪个通道发送者，例如本地 CLI 或飞书用户。
- `sessionId`：当前应该加载和保存哪份聊天记录。
- `activeSessionId`：本地 CLI 当前选中的会话。

对于本地 CLI，`senderId` 可以稳定不变，但 `sessionId` 应该来自 `activeSessionId`，而不是永远写死为 `cli:default`。

## 准备做的改动

### 1. 引入 CLI 侧 session controller

在 CLI 层增加一个很小的状态对象，负责维护当前 active session，例如：

```ts
class CliSessionController {
  current(): string;
  switchTo(id: string): void;
  createNextId(name?: string): string;
}
```

初始行为：

- 默认 active session 仍然是 `cli:default`，保证兼容现有 `output/sessions/cli_default.json`。
- `/new` 的参数是可选的。传参时作为 session name；不传参时创建未命名 session。
- 新 session id 统一使用 `channel:sessionName?:uid` 的结构。
- 对 CLI 来说，命名 session 形如 `cli:<session-name>:<uid>`；未命名 session 形如 `cli:<uid>`。
- `uid` 用随机字符串库生成，不手写随机逻辑。优先使用 `nanoid`，固定长度暂定 10 位。
- session name 进入 id 前要做 slug 化，避免空格、路径字符和控制字符进入 session id；原始展示名应该单独保存在 session metadata 中。
- 生成的新 id 要避免和已有 session 文件冲突。

### 2. 让 AgentLoop 从 controller 获取当前 session

CLI 组装 AgentLoop 时改成：

```ts
sessionIdFor: () => sessionController.current()
```

这样 AgentLoop 仍然保持通用，CLI 自己决定当前 active session 是谁。

### 3. 给 command result 增加切换 session 的表达能力

给 command result 增加一个可选字段：

```ts
switchSessionId?: string
```

同时给 AgentLoop config 增加一个可选 hook：

```ts
switchSession?: (sessionId: string) => void | Promise<void>
```

当命令返回 `switchSessionId` 时，AgentLoop 在保存完当前命令记录后调用这个 hook，让 CLI 更新 active session。

### 4. 修改 `/new` 的语义

把 `/new [name]` 改成“创建并切换到新 session”。

期望行为：

- 老 session 文件继续保留；
- 新 session 文件出现在 `output/sessions` 下；
- `name` 是可选参数，作为用户可读的 session name；
- session id 按 `channel:sessionName?:uid` 生成，例如 `cli:agent-memory:K7p9xQ2mVa` 或 `cli:K7p9xQ2mVa`；
- `/new` 这条命令本身记录在老 session 中；
- `/new` 之后的普通消息写入新 session。

待定细节：

- 新 session 是否需要写入一条系统/assistant 标记，例如“从 cli:default 创建”。

### 5. 用 `/switch` 统一历史查看和会话切换

不再增加 `/use <session-id>`，也不要求用户记住完整 session id。

核心命令统一为：

```text
/switch
/switch <number>
```

`/switch` 不带参数时，展示所有已有 session 的元信息，类似 Claude Code 的 `/resume` 体验。

列表至少包含：

- 序号；
- 是否为当前 active session；
- session name；
- session id 的短形式或 uid；
- turn 数；
- last active 时间；
- 最后一条用户或 assistant 消息的 preview。

示例：

```text
可切换 sessions:
* 1. agent-memory  12 turns  last: 2026-06-10T15:03:07.894Z
     继续讨论 session 机制的实现边界
  2. 未命名 K7p9xQ2mVa  4 turns  last: 2026-06-10T14:22:10.001Z
     你好！有什么可以帮你的？

输入 /switch 2 切换到对应会话。
```

`/switch <number>` 根据当前排序后的 session 列表切换到对应会话。

后续应该：

- session 列表默认按 `lastActiveAt` 倒序；
- 当前 active session 用 `*` 标记；
- 数字参数越界时返回当前列表和错误提示；
- 不通过完整 session id 作为主要入口；
- 创建新 session 统一走 `/new [name]`。

### 6. 移除或降级 `/history`

`/history` 和 `/switch` 的核心目标重叠。后续应优先保留 `/switch` 作为统一入口。

可选兼容策略：

```text
/history
```

可以作为 `/switch` 的别名保留一段时间，但帮助文案里应引导用户使用 `/switch`。

### 7. 更新 session metadata

为了让 `/switch` 列表不依赖用户记住 session id，session 需要保存可展示元信息。

建议给 session metadata 增加：

```ts
sessionName?: string;
uid?: string;
channel?: string;
```

其中：

- `sessionName` 是 `/new [name]` 的原始展示名；
- `uid` 是随机字符串库生成的固定长度 uid；
- `channel` 是 `cli`、`feishu` 等通道名。

旧 session 没有这些字段时，应降级显示：

- session name：`默认会话` 或 `未命名`；
- uid：从 session id 尽力提取，提取不到就显示短 session id。

### 8. 更新 `/session`、`/status` 和 CLI 状态栏

`/session` 应该显示真实 active session id。

`CommandRuntimeStatus` 应该增加：

```ts
session: { id: string }
```

plain CLI 和 Ink 状态栏都应该显示这个值，不能再写死 `cli:default`。

### 9. 补测试

需要补以下测试：

- `/new` 会创建并切换到一个不同的 session id；
- `/new <name>` 生成的 session id 符合 `channel:sessionName:uid`；
- `/new` 不带参数时生成的 session id 符合 `channel:uid`；
- uid 来自随机字符串库，长度固定，暂定 10 位；
- `/new` 后老 session 文件仍然存在；
- `/new` 后的普通消息写入新 session 文件；
- `/switch` 可以列出多个 session，并标记当前 active session；
- `/switch <number>` 可以切回已有 session；
- `/switch <number>` 不要求用户输入完整 session id；
- `/history` 如果保留，应作为 `/switch` 的兼容别名。

## 最小实现顺序

1. 增加 command result 和 AgentLoop 的 session switch plumbing。
2. 在 CLI 层增加 session controller。
3. 在 CLI 组装处把 `sessionIdFor` 改为读取 controller。
4. 引入随机字符串库，优先使用 `nanoid`，生成固定长度 uid。
5. 实现 CLI 语义下的 `/new [name]` 和 `/switch [number]`。
6. 更新 session metadata、status、welcome、status bar 显示 active session。
7. 补 session 创建、切换、历史列表相关测试。

## 兼容性说明

现有的：

```text
output/sessions/cli_default.json
```

应该继续作为默认会话加载。

`FileSessionStore` 的 JSON 持久化格式不需要改变。当前问题主要出在 session 路由和命令语义，不是底层文件格式。

## E2E 测试记录 2026-06-10

测试方式：用真实 CLI 入口启动 agent 进程。

```bash
PAPERCLAW_CLI_UI=plain pnpm chat
```

测试命令序列：

```text
/status
/new e2e memory check
/status
/switch
/switch 2
/status
/switch
/switch 2
/status
/new
/status
/switch
/quit
```

观测结果：

- CLI 欢迎区显示当前 session 为 `cli:default`。
- `/status` 在默认会话中显示 `session: cli:default`。
- `/new e2e memory check` 返回 `已开启新会话: e2e memory check`。
- 随后的 `/status` 显示 active session 已切换为 `cli:e2e-memory-check:6TmNSAKEct`。
- `/switch` 展示多个 session，并用 `*` 标记当前 active session。
- `/switch 2` 可以按序号切回默认会话，不需要输入完整 session id。
- 切回默认会话后，`/status` 显示 `session: cli:default`。
- 再次 `/switch 2` 可以按序号切回命名会话。
- `/new` 不带参数会创建未命名会话，返回 `已开启新会话: TKr4Docciu`。
- 随后的 `/status` 显示 active session 为 `cli:TKr4Docciu`，符合 `channel:uid` 结构。

落盘结果：

```text
output/sessions/cli_default.json
output/sessions/cli_e2e-memory-check_6TmNSAKEct.json
output/sessions/cli_TKr4Docciu.json
```

JSON 摘要：

```text
cli_default.json
- id: cli:default
- turns: 10
- metadata: no sessionName/uid/channel, 兼容旧默认会话

cli_e2e-memory-check_6TmNSAKEct.json
- id: cli:e2e-memory-check:6TmNSAKEct
- turns: 10
- metadata.sessionName: e2e memory check
- metadata.uid: 6TmNSAKEct
- metadata.channel: cli

cli_TKr4Docciu.json
- id: cli:TKr4Docciu
- turns: 4
- metadata.uid: TKr4Docciu
- metadata.channel: cli
```

结论：

- `/new [name]` 已能创建独立 session 文件，并切换 active session。
- `/new` 不带参数已能创建未命名 session，id 结构为 `cli:<10位uid>`。
- `/switch` 已能列出历史会话并按序号切换。
- 默认会话 `cli:default` 仍能继续作为兼容入口保留。
- 本次测试只使用 slash command 路径，没有触发普通 LLM 对话，因此没有验证 provider 对真实自然语言聊天的回复质量；但 session 路由、切换和持久化路径已经通过真实 CLI 进程验证。
