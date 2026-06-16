# CLI 会话恢复与论文阅读体验改进计划

## 背景

SQLite 迁移已经合并到 `main`，基座 session/history 的持久化工作完成。课堂汇报前的下一组问题不再是存储层，而是 CLI 交互、工具展示、论文阅读 workflow 和 Markdown 呈现。

用户反馈集中在四类：

- `/session` / `/history` / `/switch` 的命令语义和会话恢复 UI 不一致。
- 切换会话后没有把目标会话历史消息恢复到当前可见界面。
- 阅读论文时工具调用展示过于原始，多个同名 `kg_get_node` 连在一起像报错。
- 论文 section 解读太像报告生成，缺少“带用户逐步读”的互动节奏；知识图谱关系展示也太僵硬。
- CLI 缺少 Markdown 渲染，表格、标题、引用在终端里体验差。

这些问题相关但不应放在一个分支里解决。建议拆成 4 个后续分支，每个分支有明确边界和验收方式。

## 分支 1：`feat/session-resume-picker`

### 目标

把会话恢复体验做成类似 Claude Code `/resume` 的交互：

- 合并 `/session`、`/history`、`/switch` 的主要能力。
- 用户输入 `/session` 时弹出会话列表。
- Ink UI 下用方向键选择会话并切换。
- plain UI 下保留编号 fallback。
- 切换后立即把目标 session 的历史消息恢复到当前可见 transcript。

### 当前问题

当前命令语义分散：

- `/session` 只显示当前 session id 和 turn 数。
- `/switch` 列出历史 session，`/switch <number>` 切换。
- `/history` 是 `/switch` 的别名。
- Ink channel 内部已有 switch picker 和 `restoreVisibleSessionHistory()`，但命令式切换没有统一走这个 UI 恢复路径。

这导致：

- 用户记忆中“session 命令弹会话列表”的旧设计没有保留下来。
- 切换后虽然后续消息写入目标 session，但屏幕上仍显示旧会话上下文，容易误判。

### 改动范围

主要文件：

- `packages/core/src/command/builtin.ts`
- `packages/core/src/command/router.ts`
- `packages/core/src/agent/loop.ts`
- `packages/cli/src/channel/ink-channel.tsx`
- `packages/cli/src/channel/plain-channel.ts`
- `packages/cli/src/channel/types.ts`
- `packages/cli/src/session-controller.ts`
- `tests/cli/*`
- `tests/agent/smoke.test.ts`

### 设计要点

1. `/session` 成为主入口。

   - 无参数：打开 session picker。
   - 带数字或 id：切换到目标 session。
   - 当前 `/switch` 和 `/history` 保留为兼容别名，但 help 中弱化。

2. Command result 需要表达“打开 picker”。

   当前 command result 主要返回文本和 `switchSessionId`。需要新增一种 UI intent，例如：

   ```ts
   type CommandUiIntent =
     | { kind: 'session_picker' }
     | { kind: 'restore_session_history'; sessionId: string };
   ```

   或者在 outbound metadata 中加入稳定字段，由 CLI channel 识别。

3. 切换后恢复历史。

   Ink 已有 `restoreVisibleSessionHistory(sessionId)`，需要把 command 切换路径也接到这里。

   plain UI fallback 可以直接打印最近 N 条 transcript，或打印“已切换到 session: X”并附最近若干条摘要。

4. 会话列表展示要稳定。

   - 显示 session display name、uid、lastActiveAt、turnCount、preview。
   - 当前 session 高亮。
   - picker 中 Enter 切换，Esc 取消。

### 验收

- `/session` 在 Ink UI 中打开可上下移动的 session picker。
- `/session` 在 plain UI 中输出编号列表。
- `/session <number>` 能切换到对应 session。
- `/switch`、`/history` 仍可用，但只是兼容 alias。
- 切换后屏幕展示目标 session 的历史消息。
- 切换后继续聊天会写入目标 session。

## 分支 2：`feat/tool-progress-ux`

### 目标

优化工具调用展示，避免用户看到：

```text
tool
  kg_get_node, kg_get_node, kg_get_node, ...
```

这种像报错的输出。

### 当前问题解释

这不是工具报错。当前这轮阅读中：

1. `read_paper_section` 读取第 2 节。
2. `preview_section_relations` 找到相关论文关系。
3. 模型为了拿到每个相关论文的 node metadata，又连续调用多个 `kg_get_node`。

功能上是正常的：它确实在阅读多个关联节点。问题在于 UI 把同名工具调用原样平铺，用户会误以为重复调用或死循环。

### 改动范围

主要文件：

- `packages/cli/src/channel/ink-channel.tsx`
- `packages/cli/src/ui/ink/components/ToolProgress.tsx`
- `packages/cli/src/ui/ink/components/MessageBlock.tsx`
- `packages/cli/src/ui/plain/render.ts`
- `packages/core/src/agent/runner.ts`
- `packages/core/src/agent/tools/types.ts`
- `tests/cli/ui.test.ts`
- `tests/agent/runner.test.ts`

### 设计要点

1. 聚合同名工具。

   展示从：

   ```text
   kg_get_node, kg_get_node, kg_get_node
   ```

   改成：

   ```text
   Reading related papers: kg_get_node × 7
   ```

2. 按工具语义生成用户友好文案。

   初始映射：

   | 工具 | 展示 |
   |---|---|
   | `read_paper_section` | Reading paper section |
   | `preview_section_relations` | Finding related papers |
   | `kg_get_node` | Loading related paper metadata |
   | `kg_neighbors` | Reading paper graph neighbors |
   | `paper_search` | Searching papers |
   | `download_paper` | Downloading PDFs |

3. 区分 progress 和 transcript。

   工具调用是工作进度，不应该像普通聊天消息一样长期占据大块 transcript。Ink UI 可以显示 compact progress row；最终消息里只保留必要摘要。

4. 对多工具批次做阶段化展示。

   例如：

   ```text
   Reading section -> Finding graph links -> Loading 7 related papers
   ```

### 验收

- 同一轮多个同名工具被聚合显示为 `tool × N`。
- `kg_get_node × 7` 不再像错误日志。
- plain UI 也有简洁展示。
- 工具失败时仍能明确显示具体失败工具。

## 分支 3：`feat/guided-reading-workflow`

### 目标

把论文 section 阅读从“生成一份小报告”改成“主 agent 带用户逐步读懂”。

### 当前问题

当前回答结构太僵硬：

- 先粗略概括 section。
- 再大段列出 7 篇相关论文。
- 关联论文篇幅超过 section 本身。
- 缺少“确认用户理解后再继续”的教学节奏。

对于 guided reading，用户需要的是逐步理解，不是一次性综述。

### 改动范围

主要文件：

- `packages/paper/src/read/skills/SKILL.md`
- `packages/paper/src/knowledge/skills/SKILL.md`
- `packages/core/src/templates/agent/tool_contract.md`
- `packages/core/src/agent/context.ts`
- `packages/paper/src/read/read-paper-tool.ts`
- `tests/reader/read-paper-tool.test.ts`
- 可能新增 prompt/golden transcript 测试

### 新 workflow

一轮 section 阅读默认遵循：

1. 先给 section 的一句话定位。

   例：

   > 这一节不是在讲“有哪些工具”，而是在讲 harness 如何把工具调用失败变成可检测、可恢复的工程事件。

2. 把 section 拆成 2-4 个小块。

   不一次讲完整节。先讲第一小块，并问用户是否理解。

3. 默认只读当前小块。

   用户说“继续”后再进入下一小块。

4. 知识图谱关联只作为旁注。

   关联论文应该自然嵌入解释，例如：

   > 这里可以借 API-Bank 理解：它把 malformed arguments 做成 benchmark case，所以这节说的 schema validation 不是抽象工程洁癖，而是在覆盖真实评测里的常见失败。

   而不是列出：

   ```text
   ① API-Bank ...
   ② AgentBench ...
   ```

5. 每轮最多引用 1-3 篇关联论文。

   关联论文服务于理解当前小块，不是展示图谱数量。

6. 结尾必须给用户选择。

   例：

   - “要不要我用一个具体 tool-call failure 例子再讲一遍？”
   - “理解这部分后，我再带你看下一小块。”
   - “你也可以让我把这一小块保存成 section note。”

### Skill 文案约束

需要在 read skill 中明确：

- 不要默认生成完整 section 报告。
- 不要一次性展开所有 related papers。
- 不要把 knowledge graph 关系列表化成 bibliography。
- 关联论文要作为解释当前概念的类比或证据。
- 一轮最多推进一个阅读小块。

### 验收

- 用户请求读 section 2 时，回答不会一次性讲完整 section。
- 回答会提出下一步确认，而不是直接问“要不要保存整节笔记”。
- 关联论文数量控制在 1-3 个。
- 关联说明自然嵌入正文，而不是机械列表。

## 分支 4：`feat/cli-markdown-rendering`

### 目标

让 CLI 支持 Markdown 渲染，改善标题、列表、引用、代码块、表格的终端显示。

### 当前问题

模型输出 Markdown 时，plain/Ink UI 基本按原文输出。长表格、标题和引用在终端里不够清晰。论文阅读尤其依赖结构化输出，因此 Markdown 渲染会显著影响观感。

### 改动范围

主要文件：

- `packages/cli/src/ui/plain/render.ts`
- `packages/cli/src/ui/ink/components/MessageBlock.tsx`
- `packages/cli/src/ui/ink/components/*`
- `packages/cli/package.json`
- `tests/cli/ui.test.ts`

### 设计要点

1. 选择轻量 Markdown renderer。

   候选：

   - `marked` / `markdown-it` 做 AST 或 tokenization。
   - plain UI 可用 ANSI 样式渲染。
   - Ink UI 可把 token 映射为 `<Text bold>`、缩进列表、代码块色块等。

2. 先支持常见子集。

   - headings
   - unordered / ordered list
   - blockquote
   - inline code
   - fenced code block
   - bold / italic
   - horizontal rule

3. 表格先做降级。

   Markdown table 在终端里容易溢出。第一版可以：

   - 保持 monospace 原样。
   - 或转成 key/value list。

4. 不要破坏路径和代码块。

   文件路径、命令、JSON、tool output 必须保持可复制。

### 验收

- `## Heading` 在 Ink/plain 中有明显层级。
- 列表缩进稳定。
- 代码块不被错误换行或吞字符。
- 长表格不会把 UI 撑乱。
- 原始 Markdown 仍可复制理解。

## 建议执行顺序

1. `feat/session-resume-picker`

   先修会话恢复。这个影响所有 demo 的操作稳定性。

2. `feat/tool-progress-ux`

   再修工具展示。这个能立刻消除“重复 kg_get_node 像报错”的观感问题。

3. `feat/guided-reading-workflow`

   然后修读论文的对话策略。这个需要调 prompt 和行为测试，风险比 UI 展示更高。

4. `feat/cli-markdown-rendering`

   最后补 Markdown 渲染。它会影响所有输出，需要单独验证 UI 不回归。

## 课堂汇报临时规避方案

如果明天汇报前来不及实现全部分支，建议 demo 时规避几个坑：

- 不展示完整 tool transcript，只展示最终回答和 `knowledge-index.json` / note 文件。
- 提问时明确让 paperClaw “只引用 2-3 篇最相关论文，不要列出全部关系”。
- 提问时明确 “先带我读第一小块，等我确认后再继续”。
- 避免让模型生成 Markdown 表格，要求用短段落和 bullet。

推荐临时 prompt：

```text
继续读 Agent_Harness_Engineering_Survey 的第 2 节。
请只讲这一节的第一个小点，用自然语言带我理解。
可以参考 knowledge-index 里的关联论文，但最多引用 2 篇，并把关联作为解释的一部分，不要列论文清单。
讲完后停下来问我是否理解。
```
