# paperClaw — 目录与文件组织重构方案 (nanobot-aligned)

> 创建日期: 2026-06-03
> 状态: 待 review
> 触发: 用户指出 prompts 堆在单文件不是最佳实践, 并要求目录组织直接参考 `/Users/user/Desktop/personal-projects/nanobot`

---

## 0. 结论先行

上一版方案偏“通用 TypeScript monorepo 最佳实践”, 提了 `packages/app`, `packages/memory`, `packages/channels/*` 等拆法。这个方向不够贴合本项目的明确参考实现 `nanobot`。

参考 `nanobot` 后, paperClaw 推荐改成:

- 保持现有 workspace 外壳: `packages/core`, `packages/search`, `packages/cli`.
- **核心框架内部目录直接对齐 nanobot 的子系统**:
  - `agent/`
  - `agent/tools/`
  - `command/`
  - `session/`
  - `channels/`
  - `bus/`
  - `config/`
  - `providers/`
  - `skills/`
  - `templates/`
  - `cron/`
  - `utils/`
- paperClaw 业务能力不要另起一个过重 `app` 包, 而是像 nanobot 的 builtin skills 一样组织为 `skills/paper-search`, `skills/paper-read`, 对应 TypeScript tool 工厂放在 `packages/search` / future reader 包中.
- Prompt 不要堆在 `agent/prompt.ts`; 参考 nanobot 的 `nanobot/templates/agent/*.md`, 改成 `packages/core/src/templates/agent/*.md` + `renderTemplate()`.

---

## 1. nanobot 的实际目录模式

`nanobot` 真实结构中, 关键目录是:

```text
nanobot/
├── nanobot.py                  # programmatic facade: Nanobot.from_config().run()
├── agent/
│   ├── loop.py                 # AgentLoop: RESTORE/COMPACT/COMMAND/BUILD/RUN/SAVE/RESPOND
│   ├── runner.py               # AgentRunner + AgentRunSpec + AgentRunResult
│   ├── context.py              # ContextBuilder: prompt + messages + runtime context
│   ├── subagent.py
│   ├── skills.py               # SkillsLoader: markdown SKILL.md loader
│   ├── memory.py
│   ├── autocompact.py
│   └── tools/
│       ├── registry.py
│       └── ... concrete tools ...
├── command/
│   ├── router.py               # CommandRouter + CommandContext
│   └── builtin.py              # builtin slash commands + command palette metadata
├── session/
│   ├── manager.py              # Session + SessionManager
│   ├── goal_state.py
│   └── webui_turns.py
├── bus/
│   ├── events.py               # InboundMessage / OutboundMessage
│   └── queue.py                # MessageBus
├── channels/
│   ├── base.py                 # BaseChannel
│   ├── registry.py
│   ├── manager.py
│   ├── feishu.py
│   ├── telegram.py
│   └── ... many adapters ...
├── config/
│   ├── loader.py
│   ├── paths.py
│   └── schema.py
├── providers/
│   ├── base.py
│   ├── factory.py
│   ├── registry.py
│   ├── anthropic_provider.py
│   ├── openai_compat_provider.py
│   └── ...
├── skills/
│   ├── README.md
│   ├── memory/SKILL.md
│   ├── cron/SKILL.md
│   └── ... builtin skills ...
├── templates/
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── USER.md
│   ├── agent/
│   │   ├── identity.md
│   │   ├── platform_policy.md
│   │   ├── skills_section.md
│   │   └── tool_contract.md
│   └── memory/
├── cron/
├── heartbeat/
├── utils/
└── tests/
    ├── agent/
    ├── command/
    ├── channels/
    ├── session/
    ├── config/
    └── utils/
```

这套结构给 paperClaw 的直接启发:

1. `command/` 应该从 `agent/` 里拆出来, 不要把 slash commands 塞在 `agent/commands.ts`.
2. `session/` 应该从 `agent/` 里拆出来, 不要把 `SessionStore` 和 AgentLoop 类型混在一个 `agent/types.ts`.
3. `bus/` 应该独立于 `channels/`, 不要把 bus 放在 channels 目录下.
4. LLM backend 更接近 nanobot 的 `providers/`, paperClaw 的 `llm/` 可以改名或至少按 provider 风格整理.
5. Prompt 模板应进入 `templates/`, 不应成为 `agent/prompt.ts` 的大字符串.
6. 业务能力应以 `skills/` 呈现给主 agent, 而不是在 `main.ts` 或 `agent/prompt.ts` 写死.
7. 测试应顶层 `tests/` 按子系统分目录, 而不是每个 package 下散落 `src/__tests__`.

---

## 2. paperClaw 目标目录 (参考 nanobot, 适配 TS workspace)

保留 TypeScript workspace 的包边界, 但 `packages/core/src` 内部尽量复刻 nanobot 子系统命名。

```text
packages/
├── core/
│   └── src/
│       ├── index.ts
│       ├── clawbot.ts                 # 类似 nanobot.py: programmatic facade (可选)
│       │
│       ├── agent/
│       │   ├── loop.ts                # AgentLoop + TurnState + TurnContext
│       │   ├── runner.ts              # AgentRunner/runToolLoop + RunnerConfig/Result
│       │   ├── context.ts             # ContextBuilder: buildSystemPrompt/buildMessages
│       │   ├── subagent.ts            # runSubagent / SubagentManager base
│       │   ├── skills.ts              # SkillsLoader: 读取 skills/*/SKILL.md
│       │   ├── autocompact.ts         # 后续需要再加; 当前可不建
│       │   ├── memory.ts              # session/history compaction memory; 非论文 profile
│       │   └── tools/
│       │       ├── types.ts
│       │       ├── registry.ts
│       │       └── demo.ts            # echo/add/multiply/big_tool demo tools
│       │
│       ├── command/
│       │   ├── router.ts              # CommandRouter + CommandContext
│       │   ├── builtin.ts             # /clear /help /history /cost /session
│       │   └── index.ts
│       │
│       ├── session/
│       │   ├── manager.ts             # Session + FileSessionStore(SessionManager)
│       │   └── index.ts
│       │
│       ├── bus/
│       │   ├── events.ts              # InboundMessage / OutboundMessage
│       │   ├── queue.ts               # MessageBus
│       │   └── index.ts
│       │
│       ├── channels/
│       │   ├── base.ts                # Channel interface / BaseChannel shape
│       │   ├── registry.ts            # optional later
│       │   ├── manager.ts             # optional later
│       │   └── index.ts
│       │
│       ├── providers/
│       │   ├── base.ts                # LLMClient / ChatMessage / ToolCall / ToolDef
│       │   ├── deepseek.ts
│       │   ├── factory.ts             # createLLMClient
│       │   └── index.ts
│       │
│       ├── config/
│       │   ├── loader.ts              # loadEnv / future config file loader
│       │   ├── paths.ts               # repo/output/workspace/session paths
│       │   ├── schema.ts              # AgentDefaults / model/budget config
│       │   └── index.ts
│       │
│       ├── templates/
│       │   ├── AGENTS.md              # 可选 bootstrap
│       │   ├── SOUL.md                # 可选 bootstrap
│       │   ├── USER.md                # 可选 bootstrap
│       │   └── agent/
│       │       ├── identity.md
│       │       ├── tool_contract.md
│       │       ├── skills_section.md
│       │       └── paperclaw_identity.md # paperClaw 专属身份, 若不想放 skill
│       │
│       ├── skills/
│       │   ├── README.md
│       │   ├── paper-search/
│       │   │   └── SKILL.md           # 告诉 agent 何时调用 paper_search
│       │   ├── paper-read/
│       │   │   └── SKILL.md           # 告诉 agent 何时调用 read_paper
│       │   └── profile/
│       │       └── SKILL.md           # 用户画像/笔记库策略
│       │
│       ├── cron/
│       │   ├── service.ts             # 后续 cron recommendation
│       │   └── types.ts
│       │
│       ├── utils/
│       │   ├── retry.ts
│       │   ├── concurrency.ts
│       │   ├── tokens.ts
│       │   ├── templates.ts           # renderTemplate(), 类似 nanobot.utils.prompt_templates
│       │   └── path.ts
│       │
│       ├── trace.ts
│       └── profile.ts                 # 临时保留; 后续迁到 paper domain memory
│
├── search/
│   └── src/
│       ├── paper-search-tool.ts       # createPaperSearchTool(): Tool
│       ├── prompts/                   # search 内部 LLM prompts, 可用 .md 或 .ts
│       │   ├── decompose.md
│       │   ├── replan.md
│       │   ├── cron-infer.md
│       │   └── triage.md
│       ├── tools/
│       │   ├── arxiv.ts
│       │   ├── triage.ts
│       │   └── download.ts
│       ├── subagent/
│       │   ├── evaluator.ts
│       │   ├── manager.ts
│       │   ├── tools.ts
│       │   └── prompts.ts
│       └── index.ts
│
├── cli/
│   └── src/
│       ├── adapter.ts                 # CLIChannel implementation
│       └── main.ts                    # thin host: load config -> create loop -> start CLI
│
└── reader/                            # future
    └── src/
        ├── read-paper-tool.ts
        ├── agent/
        ├── tools/
        └── index.ts

tests/
├── agent/
├── command/
├── session/
├── bus/
├── channels/
├── providers/
├── search/
└── cli/
```

### 为什么不再推荐 `packages/app` / `packages/memory`

- `nanobot` 的模式是单一主包 `nanobot/` 内按子系统分目录, 不是把 app assembly 再拆一个包.
- paperClaw 当前规模更小, 多拆 workspace package 会增加 exports/package.json/tsconfig 维护成本.
- `memory` 在 nanobot 中是 `agent/memory.py` + templates/memory + skills/memory 的组合; paperClaw 的论文 profile/notes/index 可以先作为 paper skill/domain tools 落在 `search`/future `reader` 或 `core/src/profile.ts` 的演进路径中, 不急着单独 package.
- 真要单独 package, 等 paper reader 和 notes schema 稳定后再拆, 不在基座重构第一阶段做.

---

## 3. 现有问题如何映射到 nanobot 风格修复

### 3.1 Prompt 组织: `agent/prompt.ts` → `templates/` + `agent/context.ts`

当前问题:

- `packages/core/src/agent/prompt.ts` 把 base prompt 堆成一个 TS 字符串.
- search prompts 散落在 `planner.ts` / `triage.ts`.

nanobot 参考:

- `nanobot/agent/context.py` 负责组装 prompt.
- `nanobot/templates/agent/identity.md`, `tool_contract.md`, `skills_section.md` 存具体模板.
- `nanobot/utils/prompt_templates.py` 做模板渲染.

paperClaw 修法:

```text
packages/core/src/templates/agent/identity.md
packages/core/src/templates/agent/tool_contract.md
packages/core/src/templates/agent/skills_section.md
packages/core/src/utils/templates.ts
packages/core/src/agent/context.ts
```

`ContextBuilder.buildSystemPrompt()` 负责:

1. render identity.
2. render tool contract.
3. 加载 always skills.
4. 构建 skill summary.
5. 注入 session/profile summary.

不再需要 `agent/prompt.ts`; 如果保留, 只作为兼容 wrapper.

### 3.2 Command 组织: `agent/commands.ts` → `command/router.ts` + `command/builtin.ts`

当前问题:

- router、handler、copy 全塞在 `packages/core/src/agent/commands.ts`.

nanobot 参考:

- `nanobot/command/router.py`
- `nanobot/command/builtin.py`

paperClaw 修法:

```text
packages/core/src/command/router.ts
packages/core/src/command/builtin.ts
packages/core/src/command/index.ts
```

`router.ts`:

```ts
export interface CommandContext {
  msg: InboundMessage;
  session: Session | null;
  key: string;
  raw: string;
  args: string;
  loop?: unknown;
}

export class CommandRouter { ... }
```

`builtin.ts`:

- `BUILTIN_COMMAND_SPECS`
- `cmdClear`
- `cmdHelp`
- `cmdHistory`
- `cmdCost`
- `cmdSession`
- `registerBuiltinCommands(router)`

### 3.3 Session 组织: `agent/types.ts` / `session-store.ts` → `session/manager.ts`

当前问题:

- `Session`, `Turn`, `SessionStore`, `FileSessionStore`, `createNewSession` 分布在 agent 目录, 还混在 `types.ts`.

nanobot 参考:

- `nanobot/session/manager.py` 同时拥有 `Session` 和 `SessionManager`.

paperClaw 修法:

```text
packages/core/src/session/manager.ts
packages/core/src/session/index.ts
```

内容:

- `Turn`
- `Session`
- `SessionListing`
- `SessionStore` interface
- `FileSessionStore` class
- `createNewSession()`

### 3.4 Bus/Channel 组织: `channels/bus.ts` → `bus/queue.ts`, `bus/events.ts`

当前问题:

- `MessageBus` 放在 `channels/bus.ts`, 但 nanobot 中 bus 是独立子系统.

nanobot 参考:

- `nanobot/bus/events.py`
- `nanobot/bus/queue.py`
- `nanobot/channels/base.py`

paperClaw 修法:

```text
packages/core/src/bus/events.ts       # InboundMessage / OutboundMessage
packages/core/src/bus/queue.ts        # MessageBus
packages/core/src/channels/base.ts    # Channel interface
```

### 3.5 LLM 组织: `llm/` → `providers/`

当前问题:

- `packages/core/src/llm` 可工作, 但参考 nanobot 更像 provider layer.

nanobot 参考:

- `nanobot/providers/base.py`
- `factory.py`
- provider implementations.

paperClaw 修法:

```text
packages/core/src/providers/base.ts       # ChatMessage / LLMClient / ToolDef
packages/core/src/providers/deepseek.ts
packages/core/src/providers/factory.ts
packages/core/src/providers/index.ts
```

是否立即 rename `llm` → `providers` 可单独 review。若担心 churn, 可先保留 `llm/`, 但文档和新代码按 provider 概念组织。

### 3.6 Skills: 业务 prompt 和 tool usage instructions 进入 `skills/`

当前问题:

- paper_search/read_paper 的 “什么时候调用、如何展示结果、何时问用户” 未来可能塞进 master prompt.

nanobot 参考:

- `nanobot/skills/<skill>/SKILL.md`
- `SkillsLoader` progressive loading.

paperClaw 修法:

```text
packages/core/src/skills/paper-search/SKILL.md
packages/core/src/skills/paper-read/SKILL.md
packages/core/src/skills/profile/SKILL.md
packages/core/src/agent/skills.ts
```

示例 `paper-search/SKILL.md`:

```markdown
---
description: 搜索 arXiv 论文并返回 shortlist
metadata:
  always: true
---

# Paper Search Skill

当用户表达“找论文 / 搜索论文 / 推荐论文 / 相关工作”时, 使用 `paper_search` tool.

## 使用策略
- 默认 mode = fast.
- 用户明确说“仔细评估 / thorough / demo agent 能力”时, mode = thorough.
- 返回结果用中文表格, 保留论文标题英文.
```

这样 master prompt 只需要列 skill summary, 不需要把所有业务策略硬塞进 `agent/prompt.ts`.

### 3.7 Tests: package-local `src/__tests__` → root `tests/<subsystem>`

当前问题:

- `packages/cli/src/__tests__/smoke.ts` 内联 MockLLM/MockChannel.
- `packages/search/src/__tests__/replan-test.ts` 已坏.

nanobot 参考:

```text
tests/agent/
tests/command/
tests/channels/
tests/session/
tests/config/
tests/utils/
```

paperClaw 修法:

```text
tests/
├── agent/smoke.test.ts
├── command/router.test.ts
├── session/store.test.ts
├── bus/queue.test.ts
├── channels/cli.test.ts
├── providers/deepseek.test.ts
├── search/smoke.test.ts
└── fixtures/
    ├── mock-channel.ts
    ├── mock-llm.ts
    └── tmpdir.ts
```

这比 `packages/core/src/testing` 更贴 nanobot。测试 fixture 放 `tests/fixtures`, 不进入 runtime package export.

---

## 4. 建议迁移顺序

### Phase 0: 恢复仓库 baseline

1. 删除或归档 `packages/search/src/__tests__/replan-test.ts`.
2. 删除 root `search:query`, `search:cron`, `search:download` stale scripts.
3. 更新 README 快速开始为 `pnpm chat` / `pnpm test:chat`.
4. 确保 `pnpm --filter @paperclaw/core typecheck`, `pnpm --filter @paperclaw/cli typecheck`, `pnpm test:chat` 绿色.

### Phase 1: 建 nanobot-style 目录骨架 (不大改逻辑)

1. 新建:

   ```text
   packages/core/src/command/
   packages/core/src/session/
   packages/core/src/bus/
   packages/core/src/channels/base.ts
   packages/core/src/config/
   packages/core/src/templates/agent/
   packages/core/src/skills/
   packages/core/src/utils/
   tests/fixtures/
   ```

2. 先放 index/re-export 或空 stub, 让目录形态稳定.

### Phase 2: command/session/bus 三个纯搬迁

1. `agent/commands.ts` → `command/router.ts` + `command/builtin.ts`.
2. `agent/session-store.ts` + `agent/types.ts` 中 session 类型 → `session/manager.ts`.
3. `channels/types.ts` 的 message types → `bus/events.ts`.
4. `channels/bus.ts` → `bus/queue.ts`.
5. `channels/types.ts` 的 Channel interface → `channels/base.ts`.
6. 更新 imports + root barrel.

### Phase 3: prompt/template 改造

1. 新增 `utils/templates.ts`.
2. 把 `agent/prompt.ts` 的 base prompt 拆到:

   ```text
   templates/agent/identity.md
   templates/agent/tool_contract.md
   templates/agent/skills_section.md
   ```

3. `agent/context.ts` 引入 `ContextBuilder`, 接管 `buildSystemPrompt()` / `buildMessages()`.
4. `agent/prompt.ts` 标记 deprecated 或删除.

### Phase 4: skills loader + paper skills

1. 新增 `agent/skills.ts`, 参考 nanobot `SkillsLoader` 的简化版:
   - 扫 `packages/core/src/skills/*/SKILL.md`
   - 解析 frontmatter
   - 支持 `always: true`
   - 生成 skills summary
2. 新增 `skills/paper-search/SKILL.md`, `skills/paper-read/SKILL.md`, `skills/profile/SKILL.md`.
3. `ContextBuilder.buildSystemPrompt()` 注入 always skills + skills summary.

### Phase 5: agent 内部整理

1. `agent/context.ts` 内部可继续像 nanobot 一样承担 prompt + message building, 但 token helpers 移到 `utils/tokens.ts`.
2. `agent/runner.ts` 保留 RunnerConfig/RunnerResult colocated.
3. 新增 `agent/subagent.ts`, 抽 `runSubagent()`.
4. `agent/tools/demo.ts` 从 `cli/src/demo-tools.ts` 迁入.

### Phase 6: providers/config/utils 对齐

1. 可选: `llm/` 改名 `providers/`.
2. `paths.ts` 拆到 `config/loader.ts`, `config/paths.ts`, `config/schema.ts`.
3. `util.ts` 拆到 `utils/retry.ts`, `utils/concurrency.ts`, `utils/tokens.ts`.

### Phase 7: tests 对齐 nanobot

1. `packages/cli/src/__tests__/smoke.ts` 迁到 `tests/agent/smoke.test.ts` 或 `tests/cli/smoke.test.ts`.
2. MockLLM/MockChannel 迁到 `tests/fixtures`.
3. Root script:

   ```json
   "test": "tsx tests/**/*.test.ts"
   ```

   或继续分包, 但测试位置按 root `tests/` 管.

---

## 5. 与上一版方案的差异

| 主题 | 上一版 | nanobot-aligned 版 |
|---|---|---|
| 产品装配 | 新增 `packages/app` | 不新增 app 包; host/main 暂保持 thin, 未来可用 `clawbot.ts` facade |
| Memory | 新增 `packages/memory` | 先不拆 package; 按 nanobot 放 `agent/memory.ts` / skills / templates, 论文 profile 后续再定 |
| Prompt | `agent/prompts/*.ts` typed object | 更贴 nanobot: `templates/agent/*.md` + `utils/templates.ts` + `ContextBuilder` |
| Skills | 未充分体现 | 新增 `skills/*/SKILL.md` + `agent/skills.ts` |
| Command | `agent/commands/*` | `command/router.ts` + `command/builtin.ts`, 直接对齐 nanobot |
| Session | `agent/session.ts` | `session/manager.ts`, 对齐 nanobot |
| Bus | `channels/bus.ts` | `bus/events.ts` + `bus/queue.ts`, 对齐 nanobot |
| Tests | `core/src/testing` | root `tests/fixtures`, 对齐 nanobot |
| LLM | 保持 `llm/` | 建议逐步改名 `providers/`, 对齐 nanobot |

---

## 6. 最小可执行重构切片

如果你要我下一步直接动代码, 我建议先做这个最小切片:

1. **目录搬迁但不改行为**
   - `agent/commands.ts` → `command/router.ts` + `command/builtin.ts`
   - `agent/session-store.ts` + session types → `session/manager.ts`
   - `channels/types.ts` + `channels/bus.ts` → `bus/events.ts`, `bus/queue.ts`, `channels/base.ts`
2. **Prompt 拆到 templates**
   - `agent/prompt.ts` → `templates/agent/*.md` + `utils/templates.ts` + `agent/context.ts` wrapper
3. **Demo tools 移位**
   - `cli/src/demo-tools.ts` → `core/src/agent/tools/demo.ts`
4. **修 baseline**
   - 删除 stale search scripts / broken replan test
   - `pnpm --filter @paperclaw/core typecheck`
   - `pnpm --filter @paperclaw/cli typecheck`
   - `pnpm test:chat`

这个切片能直接解决你最关心的“目录随便、prompt 堆文件”问题, 且不会提前引入 `app/memory` 这种新包复杂度。
