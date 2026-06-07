# clawbot 基座实现计划：Nanobot 模块拆解与 paperClaw 适配

> 创建日期: 2026-06-06
> 最近更新: 2026-06-07
> 参考仓库: `/Users/user/Desktop/personal-projects/nanobot`
> 目标仓库: `/Users/user/Desktop/personal-projects/paperClaw`
> 状态: Checkpoint 1-10 已完成；Phase 1-4 最小闭环已完成；Phase 5 可选增强待确认

---

## 0. 目标与原则

本计划的目标是把 `nanobot` 的通用个人 agent 基座，迁移和改造成适合 `paperClaw` 的 `clawbot` 基座。

实现策略从“在当前简化实现上补齐”调整为“以当前实现为学习材料和测试参考，但核心基座重新设计、重新实现”。这样做的原因是：这个项目本身也承担学习目的，代码需要足够贴近 nanobot 的真实结构和工程边界，不能只保留一个过度简化的 demo loop。

`paperClaw` 的产品目标不是复刻一个通用聊天机器人，而是支持长期构建 personal paper notes corpus：通过对话触发论文检索、论文精读、PDF 下载、笔记生成、profile 更新和后续个性化推荐。因此 clawbot 基座必须保留 nanobot 的 agent loop、tool system、session、channel、skill、provider、context governance 等核心能力，但可以把与论文工作流无关的通用平台能力放到后续阶段或待确认简化。

重要约束：
- 对 nanobot 模块做简化前必须先确认。本文件会把“建议简化”列为待确认项，不在实现中默认删除。若后续一次性实现时遇到必须取舍的范围问题，优先按本文已确认方向推进，并在交付报告里明确说明未实现项和原因。
- 优先沿用当前 `paperClaw` 已有 TypeScript monorepo、目录结构和测试风格。
- 先做可运行的论文 agent 基座，再接入 paper_search / read_paper / Feishu / cron 等业务能力。
- 基座和业务 skill 分层：core 只提供机制，search/reader 提供论文能力。
- 每个模块仍需要独立实现、独立测试、独立提交，但不再逐 checkpoint 停下来等待 review。后续由实现者一次性完成剩余 checkpoint，并在完成后进行自主验收。
- 每个模块的代码应可逐行解释：少用“大而全”的抽象，优先清晰的数据结构、显式状态、明确边界；新增关键代码块应包含适当中文注释，便于后续集中 review。

---

## 1. 实施方式：推倒重来而不是补丁式补齐

当前 `paperClaw` 里已有一套简化版 agent 基座，但后续不把它当成必须保留的底座，而是把它分成三类处理：

1. **可保留为参考的代码**
   - smoke test 的验收思路。
   - DeepSeek provider 的基本 OpenAI-compatible 调用方式。
   - arXiv search / triage / download 这些论文业务函数。
   - Markdown skill 的基本文件组织。

2. **需要重写的基座代码**
   - AgentLoop。
   - AgentRunner。
   - ContextBuilder。
   - Tool 基类、ToolRegistry、ToolContext。
   - SessionManager。
   - CommandRouter 与 builtin commands。
   - MessageBus、Channel、CLI channel。
   - Config schema / provider factory。

3. **暂时保留但不继续扩展的旧实现**
   - 在新模块落地前，旧文件可作为对照。
   - 新模块通过测试后，再替换导出和入口。
   - 不做大规模一次性删除，避免 review 时失去参照。

推荐实现方法：

- 每个模块先写一份最小但完整的 nanobot-aligned 版本。
- 每个模块都配套一个小测试文件。
- 模块通过测试后，提交信息和最终交付报告需要说明：
  - 改了哪些文件。
  - 每个文件的设计理由。
  - 建议后续集中 review 的关键行。
  - 暂时保留的 TODO 和未实现能力。
- 后续不再逐 checkpoint 暂停；实现者需要一次性完成剩余 checkpoint，并在最终统一汇报验收结果、测试结果、风险和未实现项。

### 0.1 当前完成进度

截至 2026-06-07，当前工作树已完成：

| Checkpoint | 状态 | 主要内容 |
|---|---|---|
| Checkpoint 1 | 已完成 | nanobot-aligned config skeleton；配置按模块拆分，由根 schema 组合 |
| Checkpoint 2 | 已完成 | SessionManager/FileSessionStore；atomic write、corrupt recovery、legal suffix |
| Checkpoint 3 | 已完成 | Tool system；ToolContext、ToolRegistry、schema cast/validate、scoped tools |
| Checkpoint 4 | 已完成 | Provider abstraction；OpenAI-compatible provider、DeepSeek wrapper、provider factory |
| Checkpoint 5 | 已完成 | ContextBuilder 与 SkillsLoader；generic contextBlocks、active skills、runtime context |
| Checkpoint 6 | 已完成 | AgentRunner；message governance、tool loop、checkpoint callback、empty/length recovery |

待完成：

| Checkpoint | 状态 | 后续执行方式 |
|---|---|---|
| Checkpoint 7-10 | 已完成 | Command、Bus/Channel、AgentLoop FSM、paper_search/download_paper 已接入并测试 |
| Phase 2-3 | 已完成最小闭环 | 搜索/下载工具、Reader subagent、note 输出、profile updater 已接入并测试 |
| Phase 4 | 已完成最小闭环 | Feishu webhook channel、allowlist、cron service、`/cron` 手动触发、长驻推荐去重已接入并测试 |

---

## 2. 当前 paperClaw 状态

当前 `paperClaw` 已经具备一个简化 nanobot 基座雏形：

- `packages/core/src/agent/loop.ts`: 外层 AgentLoop，处理 RESTORE → COMPACT → COMMAND → BUILD → RUN → SAVE → RESPOND。
- `packages/core/src/agent/runner.ts`: 内层 tool-use loop，支持多轮 LLM 工具调用。
- `packages/core/src/agent/context.ts`: system prompt 构建、skills 注入、tool result compaction、token 估算。
- `packages/core/src/agent/tools/*`: Tool 类型、ToolRegistry、demo tools。
- `packages/core/src/session/manager.ts`: FileSessionStore，支持 atomic write。
- `packages/core/src/command/*`: slash command router 和 `/clear`、`/help`、`/history`、`/cost`、`/session`。
- `packages/core/src/channels/base.ts` + `bus/*`: channel 抽象和 MessageBus。
- `packages/core/src/channels/feishu.ts`: Feishu webhook channel，支持事件归一化、allowlist、verify token、文本发送。
- `packages/core/src/cron/service.ts`: CronService，支持持久化状态、周期触发、去重、错误记录。
- `packages/core/src/providers/*`: DeepSeek provider 和 provider factory。
- `packages/core/src/skills/*`: Markdown SKILL.md loader，已有 `paper-search`、`paper-read`、`profile`。
- `packages/cli/src/*`: CLI channel 和 chat 入口。
- `packages/search/src/*`: arXiv search、triage、download、planner 等论文检索子模块。
- `packages/reader/src/*`: Reader subagent、PDF text extract、note 输出、profile updater。
- `tests/agent/smoke.test.ts`: 覆盖基础对话、tool 调用、多步 tool、session、commands、compaction、channel 解耦。

这些代码说明产品方向和已有思路是清楚的，但实现粒度偏 demo。后续不会在这些文件上简单“补丁式加功能”，而是按模块重建，并在必要时用旧实现作为测试 fixture 或迁移参考。

---

## 3. Nanobot 模块拆解总览

| Nanobot 模块 | 作用 | paperClaw 当前状态 | clawbot 实现计划 |
|---|---|---|---|
| `agent/loop.py` | 外层 turn FSM，恢复 session、压缩、命令、构建上下文、运行、保存、响应 | 已完成显式 FSM | 已包含 SAVE/COMPACT、早持久化、并发防护、错误恢复 |
| `agent/runner.py` | 内层 LLM-tool iteration loop | 已完成 AgentRunner | 后续补与 Session runtime checkpoint 的恢复闭环、更多 hook/timeout 能力 |
| `agent/context.py` | system prompt、history、runtime context、skills、memory 注入 | 已完成 generic ContextBuilder + SkillsLoader | 后续补 bootstrap files、memory/archive 接入；业务 profile 不硬编码进基座 |
| `agent/tools/*` | 工具基类、registry、loader、内置工具、MCP | 已完成 Tool/Registry/Context 基础 | 自动 discovery/MCP 待确认；后续接入 paper tools |
| `agent/skills.py` + `skills/*` | Markdown skill 系统 | 已完成 SkillsLoader 基础 | 后续强化业务 skill 指令和按需加载策略 |
| `agent/memory.py` | MEMORY.md、history.jsonl、Dream consolidation | 已有 profile reader + reader profile updater | 论文 profile memory 已可读写；session archive/Dream 待确认 |
| `agent/subagent.py` | 后台 subagent、状态、结果回注主 agent | 已完成同步 runSubagent | Reader 使用同步隔离 subagent；后台异步 manager 待确认 |
| `session/manager.py` | session 持久化、history 裁剪、metadata | 已完成 SessionManager 基础和 runtimeCheckpoint 字段 | 后续补 checkpoint restore、preview、archive/new session 语义 |
| `session/goal_state.py` | 长期目标 `/goal` | 未实现 | 对课程 demo 价值高，但是否进入一期待确认 |
| `command/*` | slash commands 和结构化 command metadata | 已完成 metadata/context/builtin commands | 已补 `/new`、`/status`、`/model`、`/stop`、`/profile`、`/papers`、`/cron` |
| `bus/*` | inbound/outbound queue | 已完成 inbound/outbound envelope | 已补 progress/final/error/tool_hint envelope |
| `channels/*` | CLI、WebSocket、Feishu、Telegram 等 | CLI + Feishu webhook channel | 一期保 CLI；Feishu 已完成最小 webhook/custom-bot 适配；WebSocket/WebUI 待确认 |
| `providers/*` | 多 provider、fallback、streaming、reasoning | 已完成 provider factory + OpenAI-compatible 基础 | 后续补 streaming/reasoning、fallback 策略增强 |
| `config/*` | schema、loader、paths、env interpolation | 已完成 module-owned config skeleton | 后续按新模块补 command/channel/agent loop 配置项 |
| `cron/*` | 定时任务和 reminder | 已完成 CronService 基础 | cron 推荐论文已支持手动 `/cron` 和 env 启用长驻定时 |
| `heartbeat/*` | 长驻服务心跳 | 未实现 | 长驻 Feishu/cron 时再做，待确认 |
| `api/*` | OpenAI-compatible API | 未实现 | 对 paperClaw 非核心，建议暂不做，需确认 |
| `webui/*` | 浏览器聊天 UI | 未实现 | 对课程展示有价值但成本高，建议后置，需确认 |
| `security/*` + sandbox | 网络/文件/命令安全边界 | 已完成论文工具最小路径 guard | 通用 shell/file sandbox 不开放；论文 PDF/输出路径做最小越界保护 |
| `utils/*` | retry、token、document、artifacts、gitstore、media | 部分已有 | 按论文 workflow 补 document/PDF/artifact/path helpers |

---

## 4. 模块级实现计划

### 4.1 AgentLoop：外层 turn state machine

Nanobot 设计：
- `RESTORE → COMPACT → COMMAND → BUILD → RUN → SAVE → RESPOND → DONE`
- user turn 早持久化，避免中途崩溃丢消息。
- 支持 pending user injection、active task cancellation、progress callbacks、session lock。

重写目标：
- 不复用当前 `AgentLoop` 的控制流，只复用测试中的行为预期。
- 代码结构贴近 nanobot：`TurnState`、`TurnContext`、transition table、每个 state 一个 handler。
- 先实现同步单进程版本，不引入复杂后台任务。

实现计划：
1. 把状态显式化为 `TurnState` 和 `TurnContext`，便于 trace 和测试。
2. 增加 `COMPACT`：在 RUN 前裁剪 session history，并记录压缩原因。
3. 增加 `SAVE`：把 session 保存和 channel 响应拆开，保证持久化失败/发送失败可分别处理。
4. user turn 进入后先保存一次，runner 成功后再追加 assistant/tool turns。
5. 增加 per-session queue 或 mutex，避免 CLI/Feishu 多消息并发改同一个 session 文件。
6. 错误路径保存 assistant error turn，避免 transcript 中只有用户消息没有结果。

验收：
- 同一 session 连续快速消息不会互相覆盖。
- LLM/tool 抛错后 session 仍能恢复，并记录错误回复。
- smoke test 覆盖每个状态和错误状态。

自主验收：
- 完成 AgentLoop 后不再等待单独 review。
- 实现者需要自行运行相关测试，并在最终报告中列出 `loop.ts`、对应测试、关键状态转移的 review 建议。

### 4.2 AgentRunner：内层 tool-use loop

Nanobot 设计：
- 每轮调用前做 context governance：drop orphan tool result、backfill missing tool result、microcompact、tool result budget、history snip。
- 支持 streaming、reasoning、tool checkpoint、空回复重试、length recovery、LLM timeout、工具并发。
- 工具错误可提示模型换策略，也可 fail fast。

重写目标：
- 不在当前 `runToolLoop` 上继续堆逻辑。
- 新建 `AgentRunner` + `AgentRunSpec` + `AgentRunResult`，保留兼容 wrapper 只作为过渡。
- 每个治理步骤都拆成小函数，便于你 review。

实现计划：
1. 增加 `AgentRunner` class，保留 `runToolLoop` 作为兼容 wrapper。
2. 在每轮模型调用前补 `repairMessages()`：
   - drop orphan tool results。
   - backfill missing tool results。
   - 保证 role/tool_call_id 合法。
3. 增加 tool result budget：超长结果用 `ToolResult.summary` 或截断摘要替代。
4. 增加空回复重试和 `finish_reason=length` 续写恢复。
5. 给工具定义增加 `readOnly`、`concurrencySafe`、`exclusive` 元信息；先默认顺序执行，后续可并发执行安全工具。
6. 增加 checkpoint/hook 接口，用于 CLI/Feishu 展示“正在搜索/正在下载/正在精读”。

验收：
- mock LLM 返回空内容时会重试，超过次数给明确错误。
- malformed history 不会直接发给 provider。
- tool result 超长不会撑爆 context。

状态：
- 已完成基础 AgentRunner。
- 后续若继续增强，需要重点自查 iteration loop、message repair、tool result normalization、runtime checkpoint 恢复闭环。

### 4.3 ContextBuilder：prompt、history、runtime context

Nanobot 设计：
- system prompt = identity + workspace bootstrap files + tool contract + memory + active skills + skill summary + recent history + archived summary。
- 当前用户消息追加 runtime context：当前时间、channel、chat id、sender id、goal state、MCP/CLI attachments。
- 保持 provider-friendly role alternation。

重写目标：
- 新 ContextBuilder 负责 system prompt 和 messages，不再把 prompt 拼装散落在 runner/loop。
- prompt 模板使用 `templates/agent/*.md`。
- runtime context 明确标为 metadata，不作为用户指令。

实现计划：
1. 补 `RuntimeContext`：
   - 当前时间与 timezone。
   - channel name、sender id、session id。
   - 当前 workspace/output 路径。
   - profile signal 状态：0-2 / 3-7 / 8+ notes。
2. 补 bootstrap files 读取：
   - `AGENTS.md` / `SOUL.md` / `USER.md` 可选读取。
   - paperClaw 可优先读取 `output/profile.md` 摘要。
3. 明确区分：
   - 长期产品 memory：profile、已读索引、兴趣推断。
   - 会话 history：session turns。
4. `buildMessages` 增加合法边界裁剪，不能从 tool turn 或 assistant tool_call 中间开始。
5. 把 search/read/profile skills 的 always 注入策略改为可配置，避免 system prompt 常驻过长。

验收：
- prompt 中包含可验证的 runtime metadata。
- 裁剪后的 messages 能通过 OpenAI-compatible provider 的 tool-call 顺序要求。
- profile 不存在时能明确 cold start 降级。

状态：
- 已完成 generic ContextBuilder 与 SkillsLoader 基础。
- 后续需要自查 prompt 组成顺序、history 裁剪、runtime metadata 注入方式，以及是否出现 paperClaw 业务硬编码。

### 4.4 Tool 系统

Nanobot 设计：
- `Tool` class 提供 JSON Schema、参数 cast、validate、scope、read_only、concurrency_safe、exclusive。
- `ToolLoader` 支持自动发现内置工具和 plugin entry points。
- `ToolContext` 注入 workspace、config、file state、运行态。

重写目标：
- 重新定义 Tool/Schema/ToolContext/ToolRegistry。
- 比当前 interface 更接近 nanobot，但保持 TypeScript 可读性。
- 先手动注册，自动发现待确认。

实现计划：
1. 扩展 `Tool` interface：
   - `readOnly?: boolean`
   - `concurrencySafe?: boolean`
   - `exclusive?: boolean`
   - `summarizeResult?()`
2. 引入 `ToolContext`，工具工厂统一从 context 拿 workspace/output/profile/session。
3. 增加 JSON Schema 参数校验和轻量 cast：
   - `"3"` → number/integer。
   - `"true"` → boolean。
   - required/missing/type/enum/min/max 校验。
4. 注册论文业务工具：
   - `paper_search`
   - `download_paper`
   - `read_paper`，二期
   - `profile_status`
5. 保留手动注册作为一期实现；自动 discovery 进入待确认简化项。

验收：
- 工具参数错误返回结构化 `success:false`，并带给 LLM 可执行的修复提示。
- `/help` 能展示工具名和描述。
- paper_search tool 可被主 agent 调用并返回 shortlist summary。

状态：
- 已完成 Tool system 基础。
- 后续接入业务 tools 时，需要自查 schema validation、参数 cast、错误返回格式。

### 4.5 Skill 系统

Nanobot 设计：
- Markdown `SKILL.md` + frontmatter。
- always skills 全量注入；其他 skills 只注入摘要和路径，由模型按需读取。

paperClaw 当前状态：
- 已有 Markdown skills loader。
- 已有 `paper-search`、`paper-read`、`profile`。

实现计划：
1. 完善 frontmatter：
   - `description`
   - `always`
   - `tools`
   - `phase`
2. `paper-search/SKILL.md` 改成明确 tool contract：
   - query 模式。
   - cron 模式。
   - 用户确认下载的交互约束。
3. `paper-read/SKILL.md` 明确“精读细节不污染主 context”。
4. `profile/SKILL.md` 明确冷启动、弱 personalization、完整 personalization 阈值。
5. 增加 skill summary 测试，保证 prompt 不会无限变长。

验收：
- system prompt 中 active skills 和 available skills 可预测。
- 用户说“帮我找 agent harness 的论文”时，模型能自然调用 `paper_search`。

状态：
- 已完成 SkillsLoader 基础。
- 后续完善业务 skills 时，需要自查 frontmatter 解析、always skill 注入、available skill summary。

### 4.6 Session 管理

Nanobot 设计：
- session 保存完整 messages，支持 cap、preview、history replay、corruption tolerance。
- 对 history 做 legal suffix 和 token budget 裁剪。

重写目标：
- Session 不只是 JSON store，而是负责 history replay、legal suffix、preview、corruption handling。
- 旧 `FileSessionStore` 可作为参考，但新实现要有清晰的 SessionManager 边界。

实现计划：
1. 增加 `SessionManager` wrapper：
   - per-session in-memory lock。
   - load/create/save/invalidate。
   - session TTL 或 max turn cap。
2. session 文件损坏时：
   - 自动移到 `.corrupt.<timestamp>`。
   - 新建 session 并写 trace。
3. session listing 增加 preview，方便 `/history`。
4. 支持 `/new` 语义：清空当前 session，但旧内容可归档到 history。

验收：
- 损坏 JSON 不会导致整个 agent 崩溃。
- session 超长时保留 legal recent suffix。

状态：
- 已完成 SessionManager 基础与 runtimeCheckpoint 字段。
- 后续需要自查 checkpoint restore、atomic write、损坏文件处理、history slicing。

### 4.7 Command 系统

Nanobot 设计：
- 内置 `/new`、`/stop`、`/restart`、`/status`、`/model`、`/history`、`/goal`、`/dream`、`/help`、`/pairing`。
- command 有结构化 metadata，WebUI 可生成 command palette。

重写目标：
- CommandRouter 不只 dispatch 字符串，还要提供 `CommandContext` 和 command metadata。
- 内置命令独立测试，不依赖真实 LLM。

实现计划：
1. 增加 command metadata：
   - command
   - title
   - description
   - argHint
2. 增加一期命令：
   - `/new`: 开启新会话，旧会话保留。
   - `/status`: provider、model、session、tool、profile 状态。
   - `/model`: 查看或切换 model preset。
   - `/stop`: 取消当前 session 正在运行的任务。
3. 增加 paperClaw 专属命令：
   - `/profile`: 显示 profile 状态、已读数量、personalization 层级。
   - `/papers`: 显示最近下载/精读的论文。
4. `/goal`、`/dream`、`/restart`、`/pairing` 放入待确认简化项。

验收：
- command 不走 LLM。
- 每个 command 被记录为 session turn 或 command metadata，行为一致。

自主验收：
- 完成 Command 系统后不再等待单独 review。
- 实现者需要自查 command context、session mutation、command 是否写入 transcript。

### 4.8 Bus 与 Channel

Nanobot 设计：
- `MessageBus` 连接 inbound/outbound。
- channel manager 管理多个 channel，支持 streaming、reasoning、tool hint、发送重试、allowlist/pairing。

重写目标：
- 新 MessageBus 明确 inbound/outbound 两条路径。
- AgentLoop 只通过 bus/channel 抽象发送，不直接依赖 CLI。
- CLI channel 先实现最小但结构正确的版本。

实现计划：
1. 让 AgentLoop 只依赖 bus 或 channel 二选一，建议统一为 bus。
2. `OutboundMessage` 扩展：
   - `kind: final | progress | reasoning | tool_hint | error`
   - `metadata`
   - `data`
3. CLI channel 支持 progress rendering：
   - “正在搜索 arXiv...”
   - “正在评估 30 篇 abstract...”
   - “正在下载 PDF...”
4. Feishu channel 二期实现：
   - 用户消息到 inbound。
   - shortlist card 或 markdown 输出。
   - 下载确认可以先用普通文本编号，不先做复杂交互卡。
5. 多平台 ChannelManager、pairing、transcription 放入待确认简化项。

验收：
- mock channel 能收到 progress 和 final。
- CLI 不因 progress 打乱最终回复。

自主验收：
- 完成 Bus/Channel 后不再等待单独 review。
- 实现者需要自查 outbound event shape、progress/final/error 的区分。

### 4.9 Provider 与模型配置

Nanobot 设计：
- 多 provider registry。
- model preset。
- fallback models。
- streaming/reasoning 适配。
- env interpolation。

paperClaw 当前状态：
- DeepSeek client。
- `createLLMClient()` 基础工厂。
- `.env` 加载。

实现计划：
1. 增加 `config/schema.ts`：
   - default provider/model。
   - context window。
   - max iterations。
   - temperature/maxTokens。
   - fallback_models。
2. 增加 `paperclaw.config.json` 或 `config/paperclaw.json` 加载。
3. 支持 `${ENV_NAME}` env interpolation。
4. 增加 OpenAI-compatible/custom provider，便于切换本地或 API gateway。
5. Provider 加统一 timeout 和 retry metadata。
6. streaming/reasoning 先保留接口，不要求一期完整实现。

验收：
- 不改代码即可切换 provider/model。
- provider 出现 429/5xx 有可观测 retry。
- `/status` 能显示当前 provider/model。

状态：
- 已完成 Provider/Config 基础。
- 后续增强时需要自查 config schema、env interpolation、provider factory。

### 4.10 Memory：论文 profile 与会话归档

Nanobot 设计：
- `MEMORY.md` 保存长期事实。
- `history.jsonl` 保存近期历史。
- Dream 定期整理 memory。

paperClaw 产品需要：
- `output/profile.md` 是用户研究兴趣、已读索引、待补基础论文的核心 memory。
- Search query 模式主要用 profile 过滤已读。
- Cron 模式用 profile 生成推荐方向。
- Reader 完成后触发 profile 更新。

实现计划：
1. 保留 `readProfile()`，补 `ProfileManager`：
   - read snapshot。
   - parse read slugs。
   - parse interests。
   - write/update profile，二期由 reader 触发。
2. 增加 `HistoryArchive`：
   - session `/new` 或 compaction 后归档。
   - 不替代论文 profile。
3. Dream-style 自动整理建议暂不进入一期，需确认。
4. 设计 profile updater agent：
   - 输入新笔记 + 当前 profile。
   - 输出 profile patch 或完整新 profile。

验收：
- profile 不存在时 cold start 不中断。
- profile 已有 3/8 篇时 prompt 呈现不同 personalization 状态。
- reader 写完笔记后 profile 可更新，且有备份。

自主验收：
- 完成 Memory 后不再等待单独 review。
- 实现者需要自查 profile parser、cold start 降级、写入备份策略。

### 4.11 Subagent

Nanobot 设计：
- `SubagentManager.spawn()` 后台运行。
- 受限工具集。
- 结果通过 bus 注入主 agent。
- 有 status、tool events、usage。

paperClaw 需要：
- Reader 是真正 sub-agent，避免 PDF 全文污染主 context。
- Search thorough mode 也可能用 evaluator sub-agents。
- 大多数论文流程需要同步等待结果。

实现计划：
1. 一期实现 `runSubagent()` 同步函数：
   - 独立 system prompt。
   - 独立 ToolRegistry scope。
   - 独立 context budget。
   - 返回 final text / structured result / usage / trace。
2. 二期实现 `SubagentManager`：
   - task id/status。
   - max concurrency。
   - cancel。
   - bus result injection。
3. Search fast mode 仍用 batch triage，不伪装成 subagent。
4. Reader 必须走 subagent。

验收：
- reader/search subagent 的 messages 不进入主 session。
- 主 agent 只看到摘要和产物路径。

自主验收：
- 完成 Subagent 后不再等待单独 review。
- 实现者需要自查 subagent context 隔离、tool scope、结果回传格式。

### 4.12 Search 业务接入

当前 `packages/search` 已有：
- `searchArxiv`
- `triageBatch`
- `downloadPdf(s)`
- `decomposeQuery`
- `decideReplan`
- `inferInterestForCron`

实现计划：
1. 新增 `paper-search-tool.ts`：
   - args: `{ query?: string, mode?: "fast" | "thorough", maxResults?: number }`
   - query 模式要求 query。
   - cron 模式可由 command/cron service 触发。
2. 工具内部流程：
   - 读取 profile。
   - decompose query。
   - arXiv search。
   - triage batch。
   - decide replan，最多 1-2 轮。
   - 返回 shortlist 和 summary。
3. 新增 `download_paper` tool：
   - 支持 arxiv id 列表。
   - 默认下载到 `output/pdfs/`。
   - 可引用最近一次 shortlist，二期可做。
4. trace：
   - query terms。
   - candidate count。
   - triage verdict count。
   - replan decision。
   - download paths。

验收：
- 用户在 CLI 中说“帮我找 agent harness 的论文”，主 agent 能调用 `paper_search` 并展示 shortlist。
- 用户后续说“下载第 2、5 篇”，能下载 PDF。

状态：
- 已完成 `paper_search` / `download_paper` tool 接入。
- 已完成 Runner 层 side-effect confirmation gate：搜索请求默认只返回 shortlist；`download_paper` 只有在用户明确要求下载/精读/生成笔记时才会执行。
- 已完成 prompt/skill 约束：搜索后不自动下载或精读，必须等用户确认。

自主验收：
- 完成 Search tool 后不再等待单独 review。
- 实现者需要自查 search flow、trace、shortlist 数据结构、下载确认状态。

### 4.13 Reader 业务接入

当前状态：
- 已实现 `packages/reader` 最小闭环。
- docs/design.md 已定义 reader 作为独立模块。

实现计划：
1. 新建 `packages/reader`。
2. 新增 `read_paper` tool：
   - 输入本地 PDF path 或 arXiv id/PDF path。
   - 输出 `output/<run_id>/papers/<slug>.md`。
3. Reader subagent：
   - skim。
   - method。
   - engineering。
   - verdict。
4. reader tools：
   - `extract_pdf_text`
   - `read_section`
   - `write_note_section`
   - `self_ask`
   - `submit_reader_verdict`
5. 完成后触发 profile updater。

验收：
- PDF 全文不进入主 agent session。
- 产出的 note 可追溯到 PDF path 和 run id。
- profile updater 只在 reader 完成后触发。

状态：
- 已完成 `packages/reader`：`read_paper` tool、PDF text extract、Reader subagent、note 输出、profile updater。
- 已完成 PDF extraction guard：优先 `.txt` sidecar，其次系统 `pdftotext`，最后 ASCII fallback；抽取质量不足时 fail fast，不生成基于标题/metadata 的笔记。
- 已完成 Runner 层 side-effect confirmation gate：`read_paper` 只有在用户明确要求精读/阅读/总结/生成笔记时才会执行。
- 已完成 `packages/core/src/agent/subagent.ts`：同步隔离 subagent runner，主 session 只接收摘要和产物路径。
- 已完成测试：`tests/reader/read-paper-tool.test.ts` 覆盖 note path、profile 更新、PDF 摘录不回传主 context。

自主验收：
- 完成 Reader 后不再等待单独 review。
- 实现者需要自查 PDF text 不进入主 context、note 输出、profile updater。

### 4.14 Cron 推荐

Nanobot 设计：
- cron service 支持周期任务、持久化、自然语言 schedule。

paperClaw 需要：
- 定时推送论文推荐，用户异步确认下载。

实现计划：
1. 一期不做 daemon，只保留 `inferInterestForCron` 和手动 `/cron` 或 CLI 命令。
2. 二期实现 `packages/core/src/cron/service.ts`：
   - schedule config。
   - 上次运行时间。
   - 防重复。
   - 触发 `paper_search` cron 模式。
3. Feishu 接入后再做真正长驻 cron。

验收：
- 手动触发 cron 模式能基于 profile 生成推荐。
- 长驻模式不会重复推送同一批论文。

状态：
- 已完成 `packages/core/src/cron/service.ts`：周期任务、atomic state、runCount、seenIds 去重、错误状态持久化。
- 已完成 CLI `/cron`：手动触发 cron 推荐、`/cron status` 查看状态。
- 已完成 env 长驻模式：`PAPERCLAW_CRON_ENABLED=true` 时启动定时推荐，并通过当前 channel 发送结果。
- 已完成测试：`tests/cron/service.test.ts`、`tests/cron/paper-cron-command.test.ts`。

自主验收：
- 完成 Cron 后不再等待单独 review。
- 实现者需要自查去重、持久化、异步确认模型。

### 4.15 Security、Sandbox 与文件边界

Nanobot 设计：
- workspace restriction。
- network security。
- shell/exec sandbox。
- 文件读写状态跟踪。

paperClaw 需要：
- 主要操作在 workspace/output/pdfs/papers/profile。
- 暂时不需要通用 shell tool。

实现计划：
1. 增加 `WorkspaceGuard`：
   - output 下写入。
   - PDF/notes/profile 白名单路径。
   - 禁止 `..` 越界。
2. download/read/write 工具全部走 path helper。
3. 不开放通用 shell/file edit tool，除非后续确认。
4. 网络访问先限 arXiv 和 PDF URL，后续可配置。

验收：
- 工具不能写出 workspace/output。
- 恶意 arXiv id/path 不会导致路径穿越。

状态：
- 已完成最小论文工具边界：`download_paper` 写入 output/pdfs，`read_paper` 只允许 workspace/output 下 PDF，arXiv id 规范化。
- 未开放通用 shell/file edit tool；通用 sandbox、网络 allowlist 仍属于后续增强。

自主验收：
- 完成 Security 后不再等待单独 review。
- 实现者需要自查 workspace guard、路径规范化、网络边界。

### 4.16 WebUI、API、Image Generation、Pairing 等通用能力

这些是 nanobot 的重要通用模块，但不是 paperClaw 论文工作流的一期刚需。

建议状态：
- WebUI：建议后置，课程展示可先用 CLI/Feishu。需确认。
- OpenAI-compatible API：建议暂不做。需确认。
- image generation：与论文 agent 无关，建议不做。需确认。
- pairing/allowlist：Feishu 单用户时可以用简单 allowlist 代替。需确认。
- transcription/media：除 PDF 外暂不做。需确认。
- MCP：对后续扩展有价值，但一期不做。需确认。

---

## 5. Checkpoint 顺序与当前状态

因为项目计划已经从“逐模块 review”调整为“一次性完成剩余 checkpoint 并自主验收”，本节保留 checkpoint 顺序作为实现路线和后续集中 review 的索引。已完成 checkpoint 标记为“已完成”；未完成部分不再逐个暂停。

### Checkpoint 0：目录清理与重写策略确认（已完成）

不写核心逻辑，只确认：
- 新旧文件如何共存。
- 哪些旧入口暂时保留。
- 哪些测试先复制/重写。
- 每个模块的文件命名。

已完成：通过本计划文档确认推倒重来、模块边界和重写顺序。

### Checkpoint 1：types 与 config skeleton（已完成）

实现：
- 基础类型：message、turn、session、tool、provider、config。
- config schema 和 defaults。
- 不接 LLM、不跑 loop。

目的：
- 先把系统的名词和边界定清楚。
- 后续模块都依赖这些类型。

已完成：配置按模块归属拆分，根 schema 只负责组合。

### Checkpoint 2：SessionManager（已完成）

实现：
- session load/save/list/delete。
- atomic write。
- corrupt file recovery。
- history slicing / legal suffix。

已完成：包含 atomic write、corrupt recovery、legal suffix、per-session update lock；已补 runtimeCheckpoint 字段。

### Checkpoint 3：Tool system（已完成）

实现：
- Tool base/interface。
- ToolContext。
- ToolRegistry。
- schema validation/cast。
- demo tools。

已完成：ToolRegistry、ToolContext、schema validation/cast、scoped tools、demo tools。

### Checkpoint 4：Provider abstraction（已完成）

实现：
- LLMClient/Provider base。
- DeepSeek provider。
- custom OpenAI-compatible provider skeleton。
- retry/timeout。

已完成：OpenAI-compatible provider、DeepSeek wrapper、provider factory、model preset 基础。

### Checkpoint 5：ContextBuilder 与 SkillsLoader（已完成）

实现：
- templates。
- skill loading。
- runtime context。
- generic contextBlocks 注入。
- message building。

已完成：ContextBuilder 保持通用，不硬编码 paperClaw 业务逻辑；SkillsLoader 支持 always/active/disabled/workspace override。

### Checkpoint 6：AgentRunner（已完成）

实现：
- tool-use iteration loop。
- message repair。
- tool execution。
- checkpoint hooks。
- empty/length recovery。

已完成：AgentRunner class、message governance、tool execution、checkpoint callback、empty/length recovery、runner tests。

### Checkpoint 7：Command system（已完成）

实现：
- CommandRouter。
- CommandContext。
- builtin commands。
- command metadata。

执行方式：不再暂停等待 review；实现者完成后自行测试并在最终报告中说明 command context、metadata、session mutation 行为。

### Checkpoint 8：MessageBus 与 CLIChannel（已完成）

实现：
- inbound/outbound queue。
- CLI channel。
- progress/final/error rendering。

执行方式：不再暂停等待 review；实现者完成后自行测试 progress/final/error envelope 和 CLI 渲染。

### Checkpoint 9：AgentLoop（已完成）

实现：
- explicit FSM。
- per-session lock。
- early persist。
- COMPACT/RUN/SAVE/RESPOND。

执行方式：不再暂停等待 review；实现者完成后自行测试 FSM、per-session lock、early persist、checkpoint restore。

### Checkpoint 10：paper_search tool（已完成）

实现：
- search tool wrapper。
- profile read。
- query decomposition。
- triage/replan。
- shortlist result。

执行方式：不再暂停等待 review；实现者完成后自行测试 search flow、shortlist、download handoff、trace。

---

## 6. 实施阶段

### Phase 1：补齐可运行基座

目标：重新实现一个稳定 CLI agent 基座。

当前状态：
- Checkpoint 1-6 已完成。
- Phase 1 剩余重点是 Checkpoint 7-9：Command system、MessageBus/CLIChannel、AgentLoop 显式 FSM。

任务：
1. 按 Checkpoint 7-9 一次性完成剩余基座模块。
2. 不再逐 checkpoint 暂停 review；实现者需要自主验收并在最终报告中列出测试、风险和建议 review 文件。
3. 最后接回 CLI chat 入口。
4. Tests 覆盖错误路径、并发、损坏 session、tool schema、FSM 状态。

交付物：
- CLI 下稳定多轮对话。
- demo tools 和 paper profile 状态可用。
- `pnpm test` 通过。

### Phase 2：接入论文检索

目标：主 agent 可通过 tool 完成论文搜索、shortlist、下载。

执行方式：
- 默认不再逐模块暂停 review。
- 实现者需要一次性完成搜索 tool 的最小闭环，并自主运行 search/tool/agent 集成测试。

任务：
1. 实现 `paper_search` tool。
2. 实现 `download_paper` tool。
3. 打通 profile 过滤已读。
4. search trace 标准化。
5. CLI 对 shortlist 做清晰展示。

交付物：
- 用户自然语言触发论文搜索。
- 用户按编号下载 PDF。

### Phase 3：Reader subagent 与 profile updater

目标：本地 PDF 精读生成 note，并更新 profile。

执行方式：
- 默认不再逐模块暂停 review。
- 实现者需要自主验证 Reader subagent 与主 session 的上下文隔离。

任务：
1. 新建 `packages/reader`。
2. 实现 `runSubagent()` 或轻量 `SubagentManager`。
3. 实现 PDF extract 和 reader tools。
4. 输出结构化 markdown note。
5. 实现 profile updater。

交付物：
- `read_paper` tool 可对本地 PDF 产出笔记。
- profile 根据新笔记更新。

### Phase 4：Feishu 与 cron 推荐

目标：从 CLI 进入长驻个人论文助手形态。

执行方式：
- 默认不再逐模块暂停 review。
- 若 Feishu/cron 范围过大，可先完成 CLI 手动 cron/search/read 闭环，再在最终报告中标注长驻能力缺口。

任务：
1. Feishu channel。
2. progress / final / error 消息格式。
3. cron service。
4. cron 模式推荐 + 异步确认下载。
5. allowlist 或 pairing 策略。

交付物：
- Feishu 上可对话检索、确认下载、触发精读。
- 定时推荐可运行。

状态：
- 已完成 Feishu webhook channel：事件归一化、URL challenge、verify token、allowlist、text outbound webhook、progress/final/error 前缀。
- 已完成 CLI channel 选择：`PAPERCLAW_CHANNEL=feishu` 时启动 Feishu channel；默认仍为 CLI。
- 已完成 cron service：状态文件、interval、去重、错误记录、手动 `/cron`、env 长驻启动。
- 已完成异步确认下载模型：cron 推送后更新最近 shortlist，用户后续可用自然语言要求下载编号。
- 已完成测试：`tests/channels/feishu.test.ts`、`tests/cron/service.test.ts`、`tests/cron/paper-cron-command.test.ts`。

后续可选增强：
- Feishu rich card / 交互卡未做；当前使用普通文本编号确认。
- 多平台 ChannelManager 未做；当前由单一 channel env 选择 CLI 或 Feishu。
- 心跳/运维 health dashboard 未做；当前 Feishu HTTP GET 返回简单 ok。

### Phase 5：可选增强

需确认后再做：
- WebUI。
- OpenAI-compatible API。
- MCP tool integration。
- Dream-style memory consolidation。
- `/goal` 长期任务。
- generic file/shell tools。
- 多 channel manager。

---

## 7. 待你确认的简化项

下面这些模块我建议不进入一期，但因为你要求“简化时必须过问”，需要你确认：

计划调整后，这些仍然是边界问题，但不再要求在每个 checkpoint 前单独确认。后续实现时的默认策略是：
- 不影响 CLI/search/reader 主链路的 nanobot 通用能力，先后置。
- 如果某项能力是完成主链路的必要依赖，则实现最小版本，并在最终报告中明确说明简化点。
- 不擅自把 paperClaw 业务逻辑硬编码进 clawbot 基座；业务能力应通过 tools/skills/subagent 接入。

1. 是否一期不做 WebUI，只保 CLI，Feishu 放 Phase 4？
2. 是否一期不做 OpenAI-compatible API server？
3. 是否一期不做 MCP tool discovery，只保手动注册 paperClaw tools？
4. 是否一期不做 Dream memory consolidation，把 memory 聚焦在 `output/profile.md`？
5. 是否一期不做 `/goal` 长期目标？
6. 是否一期不做通用 shell/file edit tools，只做论文相关文件/PDF工具？
7. 是否一期不做多平台 ChannelManager，只保 CLI channel，后续加 Feishu？
8. 是否一期不做 image generation、voice transcription、pairing/social network 这类 nanobot 通用功能？

这些确认后，Phase 1 的实现范围才算锁定。

---

## 8. 建议的代码落点

优先改动：
- `packages/core/src/agent/loop.ts`
- `packages/core/src/agent/runner.ts`
- `packages/core/src/agent/context.ts`
- `packages/core/src/agent/tools/types.ts`
- `packages/core/src/agent/tools/registry.ts`
- `packages/core/src/session/manager.ts`
- `packages/core/src/command/*`
- `packages/core/src/config/*`
- `packages/core/src/utils/*`
- `tests/agent/*`

Phase 2 新增：
- `packages/search/src/paper-search-tool.ts`
- `packages/search/src/download-paper-tool.ts`
- `packages/search/src/flow.ts`
- `tests/search/*`

Phase 3 新增：
- `packages/reader/*`
- `packages/core/src/agent/subagent.ts`
- `tests/reader/*`
- `tests/agent/subagent.test.ts`

---

## 9. 风险与处理

| 风险 | 处理 |
|---|---|
| 直接复刻 nanobot 会过重 | 剩余 checkpoint 一次性实现，但仍按模块提交；所有非论文刚需模块先列为待确认简化 |
| 推倒重来导致短期不可运行 | 新旧入口短期共存；每个 checkpoint 有局部测试；最后再切主入口 |
| 不再逐 checkpoint review 后隐藏问题变多 | 实现者自主验收；每个模块单独测试和提交；最终报告列出建议集中 review 文件和风险点 |
| Tool call history 不合法导致 provider 报错 | Runner 增加 repair/drop/backfill 测试 |
| PDF/论文内容撑爆主 context | Reader 强制 subagent 隔离，只回传摘要和产物路径 |
| profile 写坏影响长期记忆 | profile updater 写前备份，输出 patch/atomic write |
| Feishu 交互复杂 | 先普通文本编号确认，后续再做交互卡 |
| cron 推荐重复 | 保存 run metadata 和已推荐 arXiv id |

---

## 10. 第一批验收标准

Phase 1 完成时应满足：

1. `pnpm test` 全部通过。
2. CLI 对话、多轮 session、tool call、slash commands 稳定。
3. 同一 session 并发消息不会覆盖 session 文件。
4. session 文件损坏时不会崩溃。
5. tool 参数类型错误能返回结构化错误。
6. context 裁剪后仍满足 provider tool-call 消息顺序。
7. `/status` 能展示 provider/model/session/profile/tools。
8. system prompt 明确包含 paperClaw 身份、工具契约、skills、runtime context。

Phase 2 完成时应满足：

1. 用户自然语言能触发 `paper_search`。
2. 搜索流程能产出 shortlist。
3. 用户能按编号下载 PDF。
4. trace 中能复盘 search/replan/triage/download。

Phase 3 完成时应满足：

1. `read_paper` 对本地 PDF 生成 note。
2. Reader subagent 不污染主 session。
3. profile updater 在精读后更新 `output/profile.md`。
