# clawbot 基座实现计划：Nanobot 模块拆解与 paperClaw 适配

> 创建日期: 2026-06-06
> 参考仓库: `/Users/user/Desktop/personal-projects/nanobot`
> 目标仓库: `/Users/user/Desktop/personal-projects/paperClaw`
> 状态: 计划文档, 已根据反馈调整为“推倒重来 + 分模块 review gate”

---

## 0. 目标与原则

本计划的目标是把 `nanobot` 的通用个人 agent 基座，迁移和改造成适合 `paperClaw` 的 `clawbot` 基座。

实现策略从“在当前简化实现上补齐”调整为“以当前实现为学习材料和测试参考，但核心基座重新设计、重新实现”。这样做的原因是：这个项目本身也承担学习目的，代码需要足够贴近 nanobot 的真实结构和工程边界，不能只保留一个过度简化的 demo loop。

`paperClaw` 的产品目标不是复刻一个通用聊天机器人，而是支持长期构建 personal paper notes corpus：通过对话触发论文检索、论文精读、PDF 下载、笔记生成、profile 更新和后续个性化推荐。因此 clawbot 基座必须保留 nanobot 的 agent loop、tool system、session、channel、skill、provider、context governance 等核心能力，但可以把与论文工作流无关的通用平台能力放到后续阶段或待确认简化。

重要约束：
- 对 nanobot 模块做简化前必须先确认。本文件会把“建议简化”列为待确认项，不在实现中默认删除。
- 优先沿用当前 `paperClaw` 已有 TypeScript monorepo、目录结构和测试风格。
- 先做可运行的论文 agent 基座，再接入 paper_search / read_paper / Feishu / cron 等业务能力。
- 基座和业务 skill 分层：core 只提供机制，search/reader 提供论文能力。
- 每个模块独立实现、独立测试、独立 review。完成一个模块后停下来，不继续实现下一个模块，直到你 review 完并确认。
- 每个模块的代码应可逐行解释：少用“大而全”的抽象，优先清晰的数据结构、显式状态、明确边界。

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
- 模块通过测试后，我输出：
  - 改了哪些文件。
  - 每个文件的设计理由。
  - 建议你优先 review 的关键行。
  - 暂时保留的 TODO 和未实现能力。
- 然后暂停，等你确认后再进入下一个模块。

---

## 2. 当前 paperClaw 状态

当前 `paperClaw` 已经具备一个简化 nanobot 基座雏形：

- `packages/core/src/agent/loop.ts`: 外层 AgentLoop，处理 RESTORE → COMMAND → BUILD → RUN → RESPOND。
- `packages/core/src/agent/runner.ts`: 内层 tool-use loop，支持多轮 LLM 工具调用。
- `packages/core/src/agent/context.ts`: system prompt 构建、skills 注入、tool result compaction、token 估算。
- `packages/core/src/agent/tools/*`: Tool 类型、ToolRegistry、demo tools。
- `packages/core/src/session/manager.ts`: FileSessionStore，支持 atomic write。
- `packages/core/src/command/*`: slash command router 和 `/clear`、`/help`、`/history`、`/cost`、`/session`。
- `packages/core/src/channels/base.ts` + `bus/*`: channel 抽象和 MessageBus。
- `packages/core/src/providers/*`: DeepSeek provider 和 provider factory。
- `packages/core/src/skills/*`: Markdown SKILL.md loader，已有 `paper-search`、`paper-read`、`profile`。
- `packages/cli/src/*`: CLI channel 和 chat 入口。
- `packages/search/src/*`: arXiv search、triage、download、planner 等论文检索子模块。
- `tests/agent/smoke.test.ts`: 覆盖基础对话、tool 调用、多步 tool、session、commands、compaction、channel 解耦。

这些代码说明产品方向和已有思路是清楚的，但实现粒度偏 demo。后续不会在这些文件上简单“补丁式加功能”，而是按模块重建，并在必要时用旧实现作为测试 fixture 或迁移参考。

---

## 3. Nanobot 模块拆解总览

| Nanobot 模块 | 作用 | paperClaw 当前状态 | clawbot 实现计划 |
|---|---|---|---|
| `agent/loop.py` | 外层 turn FSM，恢复 session、压缩、命令、构建上下文、运行、保存、响应 | 已有 5-state 简化版 | 重写为显式 FSM，包含 SAVE/COMPACT、早持久化、并发防护、错误恢复 |
| `agent/runner.py` | 内层 LLM-tool iteration loop | 已有简化版 | 重写为 AgentRunner class，包含工具参数校验、空回复/截断恢复、checkpoint/hook |
| `agent/context.py` | system prompt、history、runtime context、skills、memory 注入 | 已有简化版 | 重写 ContextBuilder，补 runtime metadata、bootstrap files、profile 摘要、合法消息边界 |
| `agent/tools/*` | 工具基类、registry、loader、内置工具、MCP | 已有手动 registry | 重写 Tool/Registry/Context；自动 discovery/MCP 待确认 |
| `agent/skills.py` + `skills/*` | Markdown skill 系统 | 已有 | 强化 frontmatter、按需 skill 摘要、业务 skill 指令 |
| `agent/memory.py` | MEMORY.md、history.jsonl、Dream consolidation | 只有 profile reader | 分成论文 profile memory 与 session archive；Dream 是否做待确认 |
| `agent/subagent.py` | 后台 subagent、状态、结果回注主 agent | 未实现通用版 | 先做同步/受控 subagent runner 给 reader/search 用；后台异步待确认 |
| `session/manager.py` | session 持久化、history 裁剪、metadata | 已有 FileSessionStore | 重写 SessionManager/FileSessionStore，补 legal boundary、preview、cap、corruption repair |
| `session/goal_state.py` | 长期目标 `/goal` | 未实现 | 对课程 demo 价值高，但是否进入一期待确认 |
| `command/*` | slash commands 和结构化 command metadata | 已有基础版 | 重写 command context + metadata，补 `/new`、`/status`、`/model`、`/stop`，paperClaw 专属命令 |
| `bus/*` | inbound/outbound queue | 已有简化版 | 重写 inbound/outbound bus，补 progress events、stream/reasoning/tool hint envelope |
| `channels/*` | CLI、WebSocket、Feishu、Telegram 等 | 只有 CLI | 一期保 CLI；Feishu 为二期；WebSocket/WebUI 待确认 |
| `providers/*` | 多 provider、fallback、streaming、reasoning | 只有 DeepSeek | 抽象保持；补 OpenAI-compatible/custom、fallback_models、timeout/retry |
| `config/*` | schema、loader、paths、env interpolation | 有 env + paths | 补 `paperclaw.config.json`、schema defaults、env interpolation、model presets |
| `cron/*` | 定时任务和 reminder | 未实现 | 用于 cron 推荐论文，二期实现 |
| `heartbeat/*` | 长驻服务心跳 | 未实现 | 长驻 Feishu/cron 时再做，待确认 |
| `api/*` | OpenAI-compatible API | 未实现 | 对 paperClaw 非核心，建议暂不做，需确认 |
| `webui/*` | 浏览器聊天 UI | 未实现 | 对课程展示有价值但成本高，建议后置，需确认 |
| `security/*` + sandbox | 网络/文件/命令安全边界 | 未实现 | paperClaw 本地 PDF/文件工具需要最小 workspace guard |
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

Review gate：
- 完成 AgentLoop 后暂停。
- 你逐行 review `loop.ts`、对应测试、关键状态转移。
- 确认后再进入 AgentRunner。

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

Review gate：
- 完成 AgentRunner 后暂停。
- 重点 review iteration loop、message repair、tool result normalization。

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

Review gate：
- 完成 ContextBuilder 后暂停。
- 重点 review prompt 组成顺序、history 裁剪、runtime metadata 注入方式。

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

Review gate：
- 完成 Tool 系统后暂停。
- 重点 review schema validation、参数 cast、错误返回格式。

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

Review gate：
- 完成 Skill 系统后暂停。
- 重点 review frontmatter 解析、always skill 注入、available skill summary。

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

Review gate：
- 完成 Session 管理后暂停。
- 重点 review atomic write、损坏文件处理、history slicing。

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

Review gate：
- 完成 Command 系统后暂停。
- 重点 review command context、session mutation、command 是否写入 transcript。

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

Review gate：
- 完成 Bus/Channel 后暂停。
- 重点 review outbound event shape、progress/final/error 的区分。

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

Review gate：
- 完成 Provider/Config 后暂停。
- 重点 review config schema、env interpolation、provider factory。

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

Review gate：
- 完成 Memory 后暂停。
- 重点 review profile parser、cold start 降级、写入备份策略。

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

Review gate：
- 完成 Subagent 后暂停。
- 重点 review subagent context 隔离、tool scope、结果回传格式。

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

Review gate：
- 完成 Search tool 后暂停。
- 重点 review search flow、trace、shortlist 数据结构、下载确认状态。

### 4.13 Reader 业务接入

当前状态：
- 尚未实现 reader package。
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

Review gate：
- 完成 Reader 后暂停。
- 重点 review PDF text 不进入主 context、note 输出、profile updater。

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

Review gate：
- 完成 Cron 后暂停。
- 重点 review 去重、持久化、异步确认模型。

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

Review gate：
- 完成 Security 后暂停。
- 重点 review workspace guard、路径规范化、网络边界。

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

## 5. 逐模块 review 顺序

因为这个项目同时承担学习目的，实现顺序需要比常规工程更细。以下顺序是建议的 review checkpoint：

### Checkpoint 0：目录清理与重写策略确认

不写核心逻辑，只确认：
- 新旧文件如何共存。
- 哪些旧入口暂时保留。
- 哪些测试先复制/重写。
- 每个模块的文件命名。

暂停 review 后进入 Checkpoint 1。

### Checkpoint 1：types 与 config skeleton

实现：
- 基础类型：message、turn、session、tool、provider、config。
- config schema 和 defaults。
- 不接 LLM、不跑 loop。

目的：
- 先把系统的名词和边界定清楚。
- 后续模块都依赖这些类型。

暂停 review 后进入 Checkpoint 2。

### Checkpoint 2：SessionManager

实现：
- session load/save/list/delete。
- atomic write。
- corrupt file recovery。
- history slicing / legal suffix。

暂停 review 后进入 Checkpoint 3。

### Checkpoint 3：Tool system

实现：
- Tool base/interface。
- ToolContext。
- ToolRegistry。
- schema validation/cast。
- demo tools。

暂停 review 后进入 Checkpoint 4。

### Checkpoint 4：Provider abstraction

实现：
- LLMClient/Provider base。
- DeepSeek provider。
- custom OpenAI-compatible provider skeleton。
- retry/timeout。

暂停 review 后进入 Checkpoint 5。

### Checkpoint 5：ContextBuilder 与 SkillsLoader

实现：
- templates。
- skill loading。
- runtime context。
- profile signal 注入。
- message building。

暂停 review 后进入 Checkpoint 6。

### Checkpoint 6：AgentRunner

实现：
- tool-use iteration loop。
- message repair。
- tool execution。
- checkpoint hooks。
- empty/length recovery。

暂停 review 后进入 Checkpoint 7。

### Checkpoint 7：Command system

实现：
- CommandRouter。
- CommandContext。
- builtin commands。
- command metadata。

暂停 review 后进入 Checkpoint 8。

### Checkpoint 8：MessageBus 与 CLIChannel

实现：
- inbound/outbound queue。
- CLI channel。
- progress/final/error rendering。

暂停 review 后进入 Checkpoint 9。

### Checkpoint 9：AgentLoop

实现：
- explicit FSM。
- per-session lock。
- early persist。
- COMPACT/RUN/SAVE/RESPOND。

暂停 review 后进入 Checkpoint 10。

### Checkpoint 10：paper_search tool

实现：
- search tool wrapper。
- profile read。
- query decomposition。
- triage/replan。
- shortlist result。

暂停 review 后进入后续 reader/feishu/cron。

---

## 6. 实施阶段

### Phase 1：补齐可运行基座

目标：重新实现一个稳定 CLI agent 基座。

任务：
1. 按 Checkpoint 0-9 逐模块重写。
2. 每个 checkpoint 完成后暂停 review。
3. 最后接回 CLI chat 入口。
4. Tests 覆盖错误路径、并发、损坏 session、tool schema、FSM 状态。

交付物：
- CLI 下稳定多轮对话。
- demo tools 和 paper profile 状态可用。
- `pnpm test` 通过。

### Phase 2：接入论文检索

目标：主 agent 可通过 tool 完成论文搜索、shortlist、下载。

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

任务：
1. Feishu channel。
2. progress / final / error 消息格式。
3. cron service。
4. cron 模式推荐 + 异步确认下载。
5. allowlist 或 pairing 策略。

交付物：
- Feishu 上可对话检索、确认下载、触发精读。
- 定时推荐可运行。

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
| 直接复刻 nanobot 会过重 | 分 checkpoint 实现；所有非论文刚需模块先列为待确认简化 |
| 推倒重来导致短期不可运行 | 新旧入口短期共存；每个 checkpoint 有局部测试；最后再切主入口 |
| 逐行 review 节奏被大改动破坏 | 单模块小步提交；每次只改当前 checkpoint 相关文件 |
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
