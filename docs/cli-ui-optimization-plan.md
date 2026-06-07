# CLI UI 优化计划

> 创建日期: 2026-06-07  
> 范围: 优化本地 `pnpm chat` 的命令行交互体验, 不改 agent 的业务逻辑。  
> 状态: 执行中。阶段 1 已落地: Ink 主 UI、plain fallback、基础 loading、高亮和 CLI UI 测试。

## 目标

把现在“能聊天”的 CLI, 优化成一个更适合演示和日常使用的论文阅读命令行界面。

优化后的 CLI 应该让用户更容易看懂:

- agent 当前是在等待输入、思考、调用工具, 还是已经完成;
- 当前调用了哪些工具;
- 哪些输出需要用户继续操作;
- PDF、笔记、profile、session 等本地产物在哪里;
- 如果回答太长、工具跑太久、上下文混乱, 可以用哪些 slash command 恢复。

## 当前状态

CLI 入口在 `packages/cli/src/main.ts`, channel 选择器在 `packages/cli/src/channel/adapter.ts`。

原始行为:

- 使用 `readline/promises`;
- 输入提示符是简单的 `> `;
- 启动时只打印一行欢迎语;
- 输出只按消息类型加简单前缀: `clawbot`、`...`、`tool`、`error`;
- 没有终端宽度适配、分块排版、状态栏、颜色降级、快捷命令提示;
- 工具进度只展示 `AgentLoop.sendProgressForCheckpoint` 发出的工具名;
- slash command 输出是 core 里直接拼出的纯文本。

这个实现作为最小 transport 是够用的, 但作为项目主要演示界面还不够清楚。

当前实现进展:

- 本地 TTY 默认使用 Ink UI;
- `PAPERCLAW_CLI_UI=plain`、非 TTY、CI 自动使用 plain fallback;
- Ink UI 已包含状态栏、消息块、输入框、工具进度和基础 loading 动画;
- 工具名、错误、slash command、重要路径已有基础高亮;
- plain fallback 保留可复制、可重定向的文本输出;
- 已新增 CLI UI 测试并接入根 `pnpm test`。

## 非目标

- 不重写 agent loop。
- 不改变搜索、精读、cron、知识图谱、provider 的业务行为。
- 不把 CLI 做成复杂全屏应用后再开始优化。
- 不牺牲复制粘贴体验: 论文标题、arXiv id、PDF 路径、笔记路径必须仍然好复制。
- 不让 CLI 的 UI 设计污染 core 的通道抽象。
- 不让非 TTY 场景崩掉, 例如把输出重定向到文件。

## 产品原则

1. 先保证行式 CLI 好用。  
   用户仍然应该可以直接输入自然语言和 slash command。

2. 长任务必须看起来“不像卡住了”。  
   工具调用、进度、最终回答要有清晰区别。

3. 输出要适合复制。  
   不为了好看把路径、编号、论文 id 包进难复制的 UI 里。

4. 视觉克制。  
   可以使用颜色、缩进、分隔线、状态栏, 但不要做动画密集或装饰性很强的界面。

5. 保持分层干净。  
   CLI 渲染逻辑放在 `packages/cli`; 只有多个 channel 都需要时, 才扩展 `OutboundMessage` 的结构化协议。

## 计划中的用户体验

### 启动界面

把现在的单行欢迎语改成 Ink 组件化启动面板:

```text
paperClaw CLI
模型: deepseek-chat        profile: cold        session: cli:default

/help 查看命令          /status 查看状态          /quit 退出
```

如果启动时拿不到模型或 profile 信息, 就显示可降级内容:

```text
paperClaw CLI
/help 查看命令          /status 查看状态          /quit 退出
```

### 输入提示符

把 `readline` 的 `> ` 迁移成 Ink 输入组件, 视觉上保持简洁:

```text
you> 
```

当一轮任务开始执行时, 先打印一行稳定提示:

```text
agent 正在处理... ⠋
```

Ink 模式下可以使用基础 loading 动画。plain fallback 中只输出静态提示, 避免日志和重定向输出混入动画控制字符。

### 消息输出

不同消息类型使用不同渲染方式:

| 类型 | 渲染方式 |
|---|---|
| `final` | 用 `clawbot` 标签展示, 正文缩进, 关键路径和编号高亮 |
| `progress` | 一行轻量状态, Ink 模式下带 loading 动画 |
| `tool_hint` | 单独展示工具名, 当前运行工具高亮 |
| `reasoning` | 默认隐藏, 后续可用环境变量打开 |
| `error` | 明确的错误标签, 使用醒目颜色, 内容可复制 |

示例:

```text
tool  search_arxiv, triage_papers

clawbot
  找到 5 篇候选论文:
  1. ...
```

### Slash Command 输出

slash command 仍然由 core 处理, 但 CLI 可以把结果排得更容易看。

优先优化:

- `/help`: 命令和工具分区展示;
- `/status`: provider、model、profile、session、tools 对齐展示;
- `/papers`: 保留编号和路径, 只截断特别长的标题;
- `/cost`: 突出总 token 数;
- `/cron status`: 保留原始计数, 但字段对齐。

如果 CLI 解析纯文本会变得脆弱, 再考虑让 command response 增加结构化 metadata。

### 论文工作流输出

论文搜索和精读是主要演示路径, CLI 要让关键产物更明显:

- 候选论文保持编号, 用户可以直接说“下载第 1、3 篇”;
- PDF 路径单独成行, 方便复制;
- note/profile 路径单独突出;
- 用户确认问题要像正常对话一样显示, 不混在工具进度里;
- 工具失败时说明失败在哪一步, 不只打印 stack message。

第一版可以只做通用排版。后续如果 paper shortlist、下载结果、笔记路径需要更好的结构化展示, 再扩展 `OutboundMessage.data`。

## CLI UI 框架评估

这次优化建议直接把 Ink 作为主 UI 方向, 因为用户希望有基础 loading 动画、高亮和更明显的运行状态。plain 文本渲染仍然保留, 但定位从“第一阶段主方案”调整为 fallback。

### 候选 1: Ink

Ink 的优势:

- 用 React 组件写命令行界面, 适合状态栏、消息列表、工具进度、输入框这类组件化 UI;
- 未来如果要做更像聊天应用的 CLI, Ink 比手写 readline 排版更好维护;
- 可以把“消息块”“工具进度”“底部状态栏”“输入区”拆成独立组件。

Ink 的风险:

- 会引入 React 和 Ink 的运行时复杂度;
- 当前 `CLIChannel` 是简单的 readline 循环, 迁到 Ink 后输入和输出生命周期需要重新设计;
- 如果 agent 输出很多长文本, 组件刷新和滚动行为要单独验证;
- 非 TTY 或重定向输出时必须有 fallback。

建议:

- 直接以 Ink 作为默认交互形态进行迁移;
- 使用 `PAPERCLAW_CLI_UI=plain` 保留纯文本 fallback;
- 非 TTY、日志重定向、CI、测试环境自动走 plain;
- 迁移时先覆盖现有功能, 再逐步加入更复杂的选择器和状态面板。

适合用 Ink 做的部分:

- 顶部或底部状态栏;
- 工具调用进度;
- 最近几条消息的分块展示;
- 输入框;
- 长任务期间的取消提示;
- 后续的论文候选列表选择界面。
- 基础 loading 动画;
- 高亮当前 agent 状态、工具名、错误和文件路径。

### 候选 2: Inquirer / Enquirer / prompts

这类库更适合“一次性提问”, 例如:

- 让用户从候选论文里多选要下载的条目;
- 让用户确认是否继续精读某一节;
- 让用户选择模型 preset;
- 让用户配置 cron。

它们不适合直接承载整个 chat loop, 因为 paperClaw 的主交互是自由对话。

建议:

- 不把主 CLI 改成问卷式流程;
- 后续可以在明确的节点使用多选或确认 prompt;
- 用之前要确认它不会破坏用户直接输入自然语言的体验。

### 候选 3: blessed / blessed-contrib

这类库更偏全屏终端应用或 dashboard。

可能适合:

- 专门的监控界面;
- 展示 trace、token、工具耗时、cron 状态;
- 后续做开发者调试面板。

不建议作为当前主 CLI 的第一选择, 因为:

- 全屏 UI 对演示和复制文本不一定友好;
- 当前需求主要是聊天、工具进度和论文产物展示;
- 工程复杂度比收益更高。

### 候选 4: 小型渲染工具

即使暂时不使用 Ink, 也可以引入小型工具提升文本渲染:

- `picocolors` 或类似库: 处理颜色, 支持 `NO_COLOR`;
- `wrap-ansi`: 按终端宽度换行;
- `string-width`: 正确计算中英文混排宽度;
- `cli-table3`: 渲染状态表格。

建议:

- 第一阶段优先考虑小型工具;
- 如果不用依赖也能写清楚, 可以先零依赖实现;
- 中英文宽度和颜色降级不要手写得太复杂, 复杂后再引入成熟库。

## 推荐技术路线

推荐路线是“Ink 主 UI + plain fallback”:

1. Ink 是默认本地交互层。  
   它负责消息列表、输入框、loading 动画、工具进度、高亮和状态栏。

2. plain 是兼容层。  
   它负责非 TTY、日志重定向、CI、测试和 Ink 出问题时的稳定输出。

这样可以满足更好的交互体验, 同时避免把所有场景都绑定到实时终端 UI。

建议环境变量:

```bash
PAPERCLAW_CLI_UI=plain pnpm chat
PAPERCLAW_CLI_UI=ink pnpm chat
```

默认值建议:

- 本地 TTY: 默认 `ink`;
- 非 TTY / 重定向输出 / CI: 自动 `plain`;
- 手动指定 `PAPERCLAW_CLI_UI=plain` 时强制 plain。

## 技术拆分

### 1. Ink 主 UI

在 `packages/cli/src/` 下归档:

- `channel/ink-channel.tsx`: 把 `OutboundMessage` 接入 Ink 状态;
- `ui/ink/App.tsx`: CLI 主组件;
- `ui/ink/store.ts`: Ink UI 状态 store;
- `ui/ink/components/MessageBlock.tsx`: 展示用户消息、agent 回复、错误;
- `ui/ink/components/ToolProgress.tsx`: 展示当前工具和 loading 动画;
- `ui/ink/components/StatusBar.tsx`: 展示模型、profile、session、运行状态;
- `ui/ink/components/InputBox.tsx`: 输入自然语言和 slash command。

Ink 状态管理要保持简单, 优先用一个 reducer 管理消息、运行状态、当前工具和错误。

### 2. plain fallback 渲染模块

在 `packages/cli/src/` 下归档:

- `ui/terminal.ts`: 判断 TTY、颜色能力、终端宽度、`NO_COLOR`;
- `ui/plain/render.ts`: 把 `OutboundMessage` 渲染成纯文本块。

plain renderer 用于非 TTY 和测试, 也作为 Ink 出问题时的安全回退。

### 3. CLIChannel 重构

更新 `CLIChannel`:

- `channel/adapter.ts` 负责选择 Ink 或 plain adapter;
- `send` 不再直接拼字符串;
- 保留 `/quit` 和 `/exit`;
- 确保每次输出后下一次 prompt 不错位;
- 非 TTY 输出不带颜色、不依赖交互能力。

### 4. 运行时状态注入

启动面板需要知道 model/profile/session, 但现在 `CLIChannel` 不知道 `AgentLoop` 的 `status` 回调。

可选方案:

- 短期: 启动面板只显示静态提示;
- 更好: `CLIChannel` 支持 `getStatus?: () => Promise<CliRuntimeStatus>`;
- 如果类型可以复用, 直接复用 core 里的 `CommandRuntimeStatus`。

优先选择不会造成循环依赖的方案。

### 5. 结构化输出扩展

后续评估是否让 `OutboundMessage.data` 携带结构化数据:

- 论文候选列表;
- 下载后的 PDF 文件;
- 最近论文;
- profile 摘要;
- 工具进度事件。

只有当 CLI 解析纯文本变得脆弱, 或 Feishu/Web 也需要同样结构时, 再扩展协议。

## 实施阶段

### 阶段 1: Ink 基础迁移

任务:

- [x] 引入 Ink 和必要依赖;
- [x] 新增 Ink app、channel adapter 和基础组件;
- [x] 用 Ink 接管本地 TTY 下的输入和输出;
- [x] 实现消息列表、输入框、状态栏、工具进度;
- [x] 增加基础 loading 动画;
- [x] 高亮当前工具名、错误、重要路径和 slash command;
- [x] 保留 `PAPERCLAW_CLI_UI=plain`。

验收:

- `pnpm --filter @paperclaw/cli typecheck` 通过;
- `pnpm test` 通过;
- `pnpm chat` 默认进入 Ink UI;
- 输入自然语言、`/help`、`/status`、`/quit` 可用;
- 工具调用期间能看到 loading 动画和当前工具;
- 非 TTY 自动走 plain。

### 阶段 2: plain fallback 和命令输出优化

任务:

- [x] 新增或整理 plain renderer;
- [x] 确保重定向输出不带颜色控制字符;
- [x] 优化启动面板;
- [x] 加入运行时状态注入;
- 优化 `/help`、`/status`、`/papers`、`/cost` 的 CLI 展示;
- 保持 core command 仍然对 Feishu 等 channel 友好。

验收:

- `pnpm chat` 启动后能看到清楚的状态和常用命令提示;
- slash command 输出更容易扫读;
- 非 CLI channel 行为不回退。

### 阶段 3: Ink 交互增强

任务:

- 优化消息滚动和长文本展示;
- 增加更清晰的运行状态: idle、thinking、tool、error;
- 优化 loading 动画的节奏, 避免刷屏;
- 增加 `/stop` 提示;
- 给关键组件或状态 reducer 加测试。

验收:

- 长回答不会破坏输入区;
- 长任务看起来有明确进度;
- plain 模式不受 Ink 改动影响。

### 阶段 4: 论文工作流专项优化

任务:

- 优化论文 shortlist 的展示;
- 优化 PDF 路径、note 路径、profile 路径的展示;
- 评估是否为 paper workflow 增加 `OutboundMessage.data`;
- 如有必要, 加入多选 prompt 选择下载论文。

验收:

- 搜索结果容易扫描和选择;
- 下载文件和笔记位置明显;
- 精读流程中的用户确认问题不被进度信息淹没;
- 搜索和 reader 现有测试不回退。

### 阶段 5: 长任务控制

任务:

- 长任务期间提示 `/stop`;
- 评估 `/verbose` 或环境变量展示更多 progress/reasoning;
- 评估主题或颜色配置, 但不优先做。

验收:

- 用户能判断任务还在运行;
- 用户知道如何停止任务;
- 输出噪音可控。

## 测试策略

自动化测试:

- renderer 使用固定宽度做单元测试;
- 关键消息类型做小型 snapshot 或字符串断言;
- 如果 adapter 支持 fake stream, 给 CLIChannel 加发送测试;
- Ink 原型至少测试状态 reducer 或核心组件渲染。

需要运行:

```bash
pnpm --filter @paperclaw/cli typecheck
pnpm test
```

人工 smoke checklist:

- `pnpm chat`
- `/help`
- `/status`
- `/papers`
- 一条普通自然语言消息
- 一条会触发工具调用的论文搜索请求
- `/stop`
- `/quit`
- `PAPERCLAW_CLI_UI=plain pnpm chat`
- `PAPERCLAW_CLI_UI=ink pnpm chat`
- `pnpm chat > /tmp/paperclaw.log`

## 当前实现证据

已新增或修改:

- `packages/cli/src/channel/adapter.ts`: 根据终端环境选择 Ink 或 plain channel;
- `packages/cli/src/channel/ink-channel.tsx`: Ink channel, 负责消息队列、发送、退出和状态刷新;
- `packages/cli/src/ui/ink/App.tsx`: Ink 主组件;
- `packages/cli/src/ui/ink/components/StatusBar.tsx`: 状态栏;
- `packages/cli/src/ui/ink/components/MessageBlock.tsx`: 消息块和基础高亮;
- `packages/cli/src/ui/ink/components/ToolProgress.tsx`: loading 动画和工具进度;
- `packages/cli/src/ui/ink/components/InputBox.tsx`: 输入框;
- `packages/cli/src/channel/plain-channel.ts`: plain fallback channel;
- `packages/cli/src/ui/plain/render.ts`: plain 文本渲染;
- `packages/cli/src/ui/terminal.ts`: UI 模式选择和 TTY 判断;
- `tests/cli/ui.test.ts`: CLI UI 模式和 plain 渲染测试。

已验证:

```bash
pnpm --filter @paperclaw/cli typecheck
pnpm typecheck
pnpm test
PAPERCLAW_CLI_UI=ink pnpm chat
PAPERCLAW_CLI_UI=plain pnpm chat
```

## 风险

- Ink 引入后, 输入输出生命周期会比 readline 复杂。
- 全屏或实时刷新 UI 可能影响复制长文本。
- 纯文本 command 输出如果在 CLI 侧强行解析, 后续容易脆弱。
- 颜色和宽度处理在中英文混排下容易出问题。
- 太早设计复杂 UI 会分散对搜索、精读主流程的注意力。

## 当前推荐结论

建议直接迁移到 Ink, 但必须保留 plain fallback。

短期目标:

- 把本地 TTY 的主体验迁到 Ink;
- 加入基础 loading 动画和高亮;
- 不影响 Feishu 和测试;
- 保证重定向输出和 CI 仍然稳定。

中期目标:

- 进一步优化论文 shortlist、下载路径、笔记路径的组件化展示;
- 在合适节点加入多选或确认 prompt;
- plain 模式长期保留, 用于日志、测试、重定向和兼容问题排查。

## 待定问题

- 第一阶段是否引入 `picocolors`、`wrap-ansi`、`string-width` 这类小依赖。
- Ink UI 继续放在 `packages/cli/src/ui/ink/`, 还是后续拆成单独 package。
- command response 是否需要结构化 metadata。
- reasoning 消息默认隐藏, 还是通过环境变量打开。
- 是否要在论文 shortlist 上使用多选 prompt。
