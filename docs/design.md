# clawbot — 设计文档

> 数据挖掘期末项目 · 2026 春
> 选题: 部署 openClaw 完成复杂任务 (自实现 agent 框架版)
> 创建日期: 2026-05-31
> 最近更新: 2026-05-31 (产品定位重写)

---

## 0. 一句话定位

**clawbot 是建立在 paper-reader 之上的 agent 层. 帮用户从 0 篇笔记开始建立 personal paper notes corpus, 在使用过程中越来越懂用户的研究兴趣, 主动推荐论文并辅助精读.**

不是综述生成器. 不是 ChatGPT Deep Research 的替代品.

---

## 1. 产品定位

### 1.1 不可替代性 (vs ChatGPT Deep Research / Elicit / Perplexity)

这类工具能干的事 (基于一个 query 返回综述报告) 我们不打算赢. 我们的护城河只有一个:

**它们看不到用户的本地笔记仓库.**

clawbot 的差异化在于**长期使用产生 personal corpus**:
- 用户在 paper-reader 仓库里手工或半自动写下的笔记是**私有数据**, 任何 SaaS 都看不到
- 用户的 verdict ("采用/观望/弃用") / `[[slug]]` 互链 / 追问内容反映的是**用户视角**, 不是论文 abstract 的"作者视角"
- 越用越个性化: 第 1 次跑可能跟 ChatGPT 差不多, 第 30 次跑能给出"基于你过去读的 30 篇笔记的私人推荐"

### 1.2 解决冷启动

新用户 (包括项目作者本人) 第一次打开只有 0-1 篇笔记, 这是**常态**. 产品必须能在低数据下也提供价值, 同时让"使用过程本身"成为建库过程.

不假装永远有数据. Agent 行为根据 corpus 大小**自适应降级**:

| 笔记数 | 模式 |
|---|---|
| 0-2 | 退化成纯综述模式, 不做 personalization |
| 3-7 | 弱 personalization (profile 已有少量信号) |
| 8+ | 完整 personalization |

这个 graceful degradation 也是 agent 自主决策的展示点 — agent 自己判断目前有多少数据、采用什么策略.

### 1.3 课程评分点对齐

课程关注 **多步推理与规划 (multi-step reasoning & planning)**. clawbot 在以下环节体现:

| 课程关注 | clawbot 体现 |
|---|---|
| 多步推理 | Master agent 编写检索词 → 触发并行子调用读 abstract → 根据结果决定 replan / 精读 / 停止 |
| 工具编排 | 主 agent 持有 6-8 个工具, 子 agent (Reader) 持有自己的工具集, context 隔离 |
| 错误恢复 | API 失败、PDF 解析失败的 trace 案例 |
| 长期 memory | profile.md 跨 run 累积, agent 自维护用户阅读情况的认知 |
| 评估 | (1) 用户已读 `Agent_Harness_Engineering_Survey` 当 ground truth 对比覆盖度; (2) 对照实验: query vs cron 模式 / 有无 profile 的推荐质量 / Claude vs DeepSeek |

---

## 2. 两个核心功能 (完全独立模块)

### 2.0 架构总览: 两个独立模块

```
┌─────────────────────────────┐     ┌─────────────────────────────┐
│         检索模块             │     │         精读模块             │
│                             │     │                             │
│ 输入: query / cron 触发     │     │ 输入: 本地 PDF 文件路径      │
│ 输出: shortlist             │     │ 输出: papers/<slug>.md 笔记  │
│   (paper_id + reason + 简介)│     │   + 触发 profile 更新        │
│   + 下载用户确认的 PDF       │     │                             │
│                             │     │ 不关心论文从哪来             │
│ 不写笔记                    │     │ (检索下载的 / 用户自己拿的   │
│ 不更新 profile              │     │  / 别人发的 — 都行)          │
└─────────────────────────────┘     └─────────────────────────────┘
        │                                   ▲
        │ PDF 文件落盘到本地                  │ 用户手动启动
        └───────────────────────────────────┘
```

**两个模块的唯一物理耦合: 一个 PDF 文件在磁盘上.** 这是最松的耦合.

设计决策:
- 检索模块**不触发精读**, 中间有人类确认环节 ("你对哪些感兴趣?")
- 精读模块**不依赖检索模块**, 它的输入是本地 PDF, 不是 arxiv_id
- Profile 更新**只由精读模块触发** (产出笔记后), 检索模块不写 profile

### 2.1 检索模块

#### 职责边界

检索模块**只做三件事**:
1. 生成检索词 + 搜索 arXiv
2. 对候选论文做 abstract 级 triage, 产出 shortlist
3. 用户确认后, 下载选中论文的 PDF 到本地

**不做**: 精读 / 写笔记 / 更新 profile. 检索到此结束.

#### 输出格式

```ts
interface SearchResult {
  arxiv_id: string
  title: string
  authors: string[]
  year: number
  abstract_summary: string   // AI 生成的 1-2 句简介
  recall_reason: string      // 为什么推荐这篇 (必须具体)
  verdict: 'recommend' | 'maybe' | 'skip'
}
```

返回给用户的是 `verdict !== 'skip'` 的列表, 用户勾选感兴趣的 → agent 下载 PDF → 完.

#### 触发模式 A: 用户输入 query

```
User: "我对 agent harness 设计感兴趣"
       │
       ▼
  检索 agent
  - 读取 profile.md (仅用于过滤已读, 不参与重排)
  - 拆解 query 为 1-N 个检索词
  - 调用 search_arxiv
       │
       ▼
  候选列表 (50-100 篇)
       │
       ▼
  并行 N 个 LLM 调用读 abstract (batch classification, 非 sub-agent)
  - 每个返回 {verdict, reason, summary}
       │
       ▼
  Agent 收集结果, 决策:
  - 是否需要补检索词 (replan)?
  - 是否覆盖度饱和 (停止)?
       │
       ▼
  shortlist[] 呈现给用户
       │
       ▼
  用户确认: "我对 #2, #5, #7 感兴趣"
       │
       ▼
  下载选中论文 PDF 到本地 → 检索结束
```

**Profile 在 Query 模式下的角色**: **仅用于过滤已读论文**, 不参与结果重排. 用户主动给的方向应被尊重, agent 不"自作主张"按 profile 偏好排序.

#### 触发模式 B: Cron 定时推送

Cron 模式不是全自动 daemon, 是**定时推送 + 异步确认** (类似 newsletter):

```
(定时触发, 无 query)
       │
       ▼
  检索 agent
  - 读取 profile.md
  - 推断"用户最近的研究方向 + 待补的基础论文"
  - 生成检索词
       │
       ▼
  Search → Triage (并行) → Agent 决策 → shortlist
       │
       ▼
  通知用户: "本周为你找到 N 篇候选"
  (推荐理由必须引用某条具体已读笔记)
       │
       ▼
  等待用户确认 (异步, 可能几小时后)
       │
       ▼
  用户选几篇 → 下载 PDF → 检索结束
       │
       ▼
  用户另行启动精读模块 (如果想读的话)
```

#### Query vs Cron 对比

| | Query 模式 | Cron 模式 |
|---|---|---|
| 输入 | user query | 无 |
| 第一步 | 直接生成检索词 | 先读 profile 推断该搜什么 |
| Triage 判断标准 | 相关性 (是否符合 query) | 新颖性 + 推断兴趣的相关性 |
| 目标函数 | 召回相关的 | 找用户该读但没读的 |
| Profile 角色 | 只过滤已读 | 既驱动检索词又过滤 |
| 产品形态 | 即时交互 | 定时推送 + 异步确认 (newsletter) |

**两个独立入口函数 (`query_flow` / `cron_flow`), 共享下游 search / triage 子模块**, 但顶层 prompt 和决策逻辑分两份.

#### 术语澄清

Triage 阶段那 N 个并行 LLM 调用**不是 sub-agent**, 是 batch classification (无 context 隔离需求, 单次调用就完成). 答辩讲"sub-agent context 隔离"时, 锚点是精读模块的 Reader, 不是这里.

### 2.2 精读模块

#### 职责边界

精读模块**完全不关心论文从哪来**:
- 检索模块下载的 PDF → 能精读
- 用户自己从别的渠道拿到的 PDF → 也能精读
- 别人发给用户的 PDF → 也能精读

**输入**: 本地 PDF 文件路径
**输出**: `papers/<slug>.md` 笔记 + 触发 profile 更新

这意味着精读模块是**产品的主入口** (使用频率比检索高 — 用户每天可能精读 1 篇, 但不是每天都检索).

#### 流程

```
本地 PDF 文件路径
       │
       ▼
  Reader agent (独立 context, sub-agent)
  - 4 阶段精读: skim → method → engineering → verdict
  - 追问变 self-ask + self-answer
       │
       ▼
  产出 papers/<slug>.md
       │
       ▼
  触发 profile updater agent
  - 读新笔记 + 当前 profile.md
  - append 新条目 + 可能更新"用户兴趣推断"
       │
       ▼
  完成
```

#### 已确认

- **Reader 是真正的 sub-agent**, 有 context 隔离需求 (主 agent 不被 PDF 全文污染)
- 复用 paper-reader 的 `template.md` (4 阶段: skim / method / engineering / verdict)
- 自动版相比 paper-reader 的差异: 没有用户互动, 追问变成 self-ask + self-answer
- 写到 `output/<run_id>/papers/<slug>.md`, 物理隔离, 不污染 paper-reader 的 `papers/`
- **写完一篇新笔记后, 触发 profile 更新 agent** (唯一触发 profile 更新的时机)

> ⚠️ **以下待详细讨论**, 笔记 template 与精读过程的 memory 管理留待后续讨论.

待讨论:
- 笔记 template 是否原样复用还是 clawbot 版调整
- Reader 内部循环 (4 phase 硬编码 vs 内部 agent loop)
- Reader 自己的 working memory compact 策略

---

## 3. Profile: 用户认知记忆 (核心数据资产)

Profile 是 clawbot 跨 run 的**长期 memory**, 一份 markdown 文件, 由 AI 自维护. 它是产品个性化的全部来源, 也是和 ChatGPT Deep Research 拉开差距的关键.

### 3.1 设计原则

**AI 维护, 但人类可读 + 可干预**:
- 文件路径: `paperClaw/output/profile.md` (跨 run 持久化, 不进 `<run_id>/`)
- 用户随时能打开看, 觉得不对可以手改
- AI 写入时**必须标注不确定性** (用 `## 待问用户` section), 给用户轻量纠错入口

**结构 fix, 内容 free**:
- 顶层 section 划分固定, AI 不能自由乱写
- 每个 section 内的内容由 AI 决定

**Append 为主, 阈值触发 rewrite**:
- 每次 update 默认 append delta (cheap)
- token 数超过阈值 (待定, ~10k 起步) 触发整文件 rewrite (LLM 重新整理)

### 3.2 固定 section 结构

```markdown
# User Reading Profile

## 已读索引
- [[react-agent]] (2025-09-12, verdict: 采用) — 一句话贡献
- [[reflexion]] (2025-09-15, verdict: 观望) — 一句话贡献
...

## 用户兴趣推断
基于已读笔记, 推断用户当前关注 (每条必须引用具体笔记作为证据):
1. Agent harness 工程 — 见 [[react-agent]] 的 engineering section
2. Self-reflection 机制 — ...

## 待补的基础论文
- ToolFormer — 用户读了 5 篇 RAG 但未读这篇基础
- ...

## 待问用户 (AI 不确定的)
- 用户在 [[react-agent]] verdict 写"想看 self-reflection 方向", 但近期实际读的是 RAG 方向, 是兴趣转移还是临时跑偏?
- ...
```

### 3.3 触发更新的时机

- **精读模块写完一篇新笔记后** (唯一的自动触发点): profile updater agent 读新笔记 + 当前 profile, append 新条目 + 可能更新"用户兴趣推断"
- **用户手改 profile 后**: clawbot 启动时检测 mtime, 如果 user-modified > last-AI-update, 视为人类信号, 优先尊重
- **检索模块**: 不触发 profile 更新, 只读
- **Cron 模式启动前**: 不更新, 只读

### 3.4 Sidecar 预留 (W3 不实现, 架构留口)

为后续 reactivate 三信号融合 (citation graph + embedding + LLM) 留接口:

```
output/
├── profile.md             # ← W1-W3 唯一的 personalization 来源
└── notes_index.json       # ← 预留, W3 不写, 模块抽象留 hook
                           #    后续承载: paper_id, embeddings,
                           #    references[], cited_by[], extracted features
```

未来若引入 Semantic Scholar API 拿 citation graph、若给笔记跑 embedding, 数据落到这里; 现在不实现, 但 `RecommendationStrategy` 抽象留出 sidecar 输入.

### 3.5 Profile 自维护的风险与取舍 (诚实评估)

承认这个方案有 cost:
- **有损压缩**: profile 是 LLM-summarized, 第 30 篇时第 1 篇细节会被压缩没. 风险: 失去精确召回能力
- **Hallucination amplification**: AI 一次写错, 后续 update reinforce. 缓解: `## 待问用户` 让用户能纠错
- **失去精确查询能力**: SQL/向量查询干不了, 只能穷举让 LLM 判断, 成本 100×

短期接受这个 cost (W1-W3 内笔记数 < 30, 影响有限), 长期通过 sidecar 升级.

---

## 4. 与 paper-reader 的关系

### 4.1 现状理解

`~/Desktop/personal-projects/paper-reader/` 是单篇辅助工具:
- 用户给 PDF, 通过 `/paper-add` → `/paper-read` → `/paper-link` 三个 Claude Code skill 完成精读
- 4 阶段协议: skim → method → engineering → verdict
- 笔记模板 `papers/<slug>.md` 中文为主, 关键句中英对照
- 笔记之间用 `[[slug]]` 互链
- Claude 是助教, 不是替用户读

### 4.2 clawbot 是上层调用

```
现在 (paper-reader): 用户给一个 PDF → Claude 帮忙精读
clawbot:             用户给方向 (或不给) → clawbot 自己拉论文 → 精读 → 沉淀
                     长期: clawbot 主动推 → 用户决定要不要深读
```

不是替代关系. clawbot 的精读环节本质上是 `/paper-read` 的自动化版.

### 4.3 资产复用边界

| 资产 | 是否复用 | 说明 |
|---|---|---|
| `template.md` | ✅ 直接复用 | clawbot Reader 写笔记时填这个模板 |
| 4 阶段协议 | ✅ 改写 | 自动版 Phase 2/3 的"追问"变 self-ask |
| `[[slug]]` 互链 | ✅ | clawbot 写完一篇后扫已有笔记加链接 |
| 中英对照 | ❌ 不做 | 自动场景用不上, 减少 token |
| `/paper-add` `/paper-read` skill | ❌ | 那是 Claude Code skill, 不是独立程序 |
| `Agent_Harness_Engineering_Survey.md` | ✅ 当 ground truth | 评估基线 |

### 4.4 物理隔离

- clawbot 笔记: `paperClaw/output/<run_id>/papers/<slug>.md`
- paper-reader 笔记: `paper-reader/papers/<slug>.md`
- profile: `paperClaw/output/profile.md` (跨 run, 不进 run_id)

用户跑完后可手动 `cp` 想要的笔记进 paper-reader 继续手工精读, 形成"clawbot 输出 → paper-reader 输入"的工作流闭环 (作为 future work 写进答辩 PPT).

---

## 5. 技术栈与运行形态

### 5.1 决策汇总

| 维度 | 决定 | 理由 |
|---|---|---|
| 主语言 | TypeScript / Node.js | 贴近 nanobot 风格, 符合 agent 框架主题 |
| 脏活语言 | Python (FastAPI) | arxiv API / PDF 处理生态成熟 |
| Node ↔ Python 通信 | HTTP | 简单, 不上 MCP (避免协议层在 trace 里加噪声) |
| LLM 后端 | 多后端抽象 | 主 DeepSeek, 备 Claude, 做对照实验 |
| 检索源 (W3) | 仅 arXiv | 免费稳定; Semantic Scholar 列入 future work (拉 citation graph) |
| Monorepo 工具 | pnpm workspace | 期末项目, Turborepo 是负担 |
| 前端 | React + Vite | 监控 live trace, 答辩演示 |
| 后端 ↔ 前端 | SSE | 单向流式推 trace |
| Run 持久化 | 扫描 `output/` 目录 | 不上 SQLite, 期末够用 |
| Profile 持久化 | 文件 (`output/profile.md`) | 同上 |
| 用户中途干预 | W3 不做, 但架构不阻断 | "待问用户"是异步纠错, 不是同步阻塞 |
| Cron 实现 | Node `node-cron` 或系统 crontab | W3 末做最小可跑版 |

### 5.2 多后端 LLM 抽象

```ts
interface LLMClient {
  chat(opts: {
    messages: ChatMessage[]
    tools?: ToolDef[]            // JSON Schema 数组
    system?: string
  }): Promise<{
    text?: string
    toolCalls?: ToolCall[]       // 统一格式, 各家 SDK 差异在 adapter 内吃掉
    usage: { input: number; output: number }
  }>
}
```

主 DeepSeek (便宜, 日常开发), Claude 当对照实验后端. 答辩时"在 DeepSeek 上达到 X 覆盖率, 在 Claude 上 Y 覆盖率, 成本差 Z 倍"是有说服力的对照表.

---

## 6. 仓库骨架

```
paperClaw/
├── docs/
│   └── design.md
├── pnpm-workspace.yaml
├── package.json
├── packages/
│   ├── core/                       # TS, agent 框架 (共享基础设施)
│   │   ├── src/
│   │   │   ├── llm/                # LLM 多后端抽象
│   │   │   │   ├── types.ts
│   │   │   │   ├── anthropic.ts
│   │   │   │   ├── deepseek.ts
│   │   │   │   └── index.ts        # createClient(provider, config)
│   │   │   ├── agent/
│   │   │   │   ├── loop.ts         # plan-act-observe 通用主循环
│   │   │   │   └── trace.ts        # JSONL trace bus
│   │   │   ├── tools/
│   │   │   │   └── registry.ts     # tool 注册 + JSON schema
│   │   │   └── profile/
│   │   │       ├── reader.ts       # 读 profile.md
│   │   │       └── updater.ts      # profile updater agent
│   │   └── package.json
│   │
│   ├── search/                     # 检索模块 (独立)
│   │   ├── src/
│   │   │   ├── flows/
│   │   │   │   ├── query_flow.ts   # 用户 query 入口
│   │   │   │   └── cron_flow.ts    # 定时推送入口
│   │   │   ├── tools/
│   │   │   │   ├── search_arxiv.ts # 调 Python arxiv 服务
│   │   │   │   ├── triage.ts       # abstract batch classification
│   │   │   │   └── download.ts     # 下载 PDF 到本地
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── reader/                     # 精读模块 (独立)
│   │   ├── src/
│   │   │   ├── agent/
│   │   │   │   ├── reader.ts       # Reader sub-agent (4 阶段精读)
│   │   │   │   └── memory.ts       # Reader working memory
│   │   │   ├── tools/
│   │   │   │   ├── pdf.ts          # 调 Python PDF 服务
│   │   │   │   ├── notes.ts        # 写 papers/<slug>.md
│   │   │   │   └── self_ask.ts     # self-ask 工具
│   │   │   └── index.ts            # 入口: 接受本地 PDF path
│   │   └── package.json
│   │
│   ├── server/                     # HTTP + SSE
│   │   └── src/
│   │       ├── routes/
│   │       │   ├── search.ts       # POST /api/search (启动检索)
│   │       │   │                   # POST /api/search/:id/confirm (用户确认)
│   │       │   ├── read.ts         # POST /api/read (启动精读, 传 PDF path)
│   │       │   ├── notes.ts        # GET /api/notes/:slug
│   │       │   └── profile.ts      # GET /api/profile, PUT (用户手改)
│   │       └── runner.ts           # 包 search/reader, 拿 trace 转 SSE
│   │
│   ├── web/                        # React + Vite
│   │   └── src/
│   │       ├── pages/
│   │       │   ├── Home.tsx        # 输入 query / 查看推送 / 拖 PDF
│   │       │   ├── SearchLive.tsx  # 检索 live trace
│   │       │   ├── SearchResult.tsx# shortlist + 确认交互
│   │       │   ├── ReadLive.tsx    # 精读 live trace
│   │       │   ├── ReadResult.tsx  # 笔记渲染
│   │       │   └── Profile.tsx     # 看/改 profile
│   │       ├── components/
│   │       │   ├── TraceStream.tsx
│   │       │   ├── PhaseStatus.tsx
│   │       │   ├── NoteViewer.tsx
│   │       │   └── CostMeter.tsx
│   │       └── hooks/useRunStream.ts
│   │
│   └── cli/                        # 可选, 命令行入口
│       └── src/
│           ├── search.ts           # clawbot search "agent harness"
│           └── read.ts             # clawbot read ./papers/xxx.pdf
│
└── services/
    └── paper-tools/                # Python FastAPI
        ├── arxiv_search.py         # GET /search?q=...&max=...
        ├── pdf_extract.py          # POST /extract
        ├── main.py
        └── requirements.txt

output/
├── profile.md                      # 跨 run, AI 自维护
├── pdfs/                           # 检索模块下载的 PDF 落盘位置
│   └── <arxiv_id>.pdf
└── <run_id>/
    ├── papers/<slug>.md            # 精读模块产出的笔记
    ├── trace.jsonl                 # 完整 plan/act/observe 流水
    └── meta.json                   # token 用量 / 耗时 / replan 次数
```

**依赖关系**: `search` → `core`, `reader` → `core`, `server` → `search` + `reader`, `web` → `server` (HTTP).
`search` 和 `reader` 之间**无直接依赖**.

---

## 7. Agent 框架核心组件 (参考 nanobot)

| 组件 | 必做 | 说明 |
|---|---|---|
| Plan-Act-Observe 主循环 | ✅ | 最小骨架, 不需要花哨状态机 |
| Tool 注册与调度 | ✅ | JSON schema 驱动 |
| Sub-agent (Reader) | ✅ | context 隔离, 主 agent 不被 PDF 内容污染 |
| Working memory (单 run) | ✅ | 读过的笔记摘要塞进每轮 prompt |
| Profile (cross-run memory) | ✅ | 长期 memory, AI 自维护, 详见 §3 |
| Trace 日志 | ✅ | 每步落 JSONL, 答辩弹药 |
| 失败重试 / 退避 | ✅ | API rate limit / PDF 下载失败 |
| Token / 成本 counter | ✅ | "读 10 篇花了 X 元"答辩用 |

### 7.1 Tool 清单

**检索模块 agent 工具**:
```
read_profile() → profile_content          # 过滤已读 / cron 模式推断兴趣
search_arxiv(query, max_n) → candidates[] # 调 Python arxiv 服务
triage_abstract(abstract, context) → verdict  # batch classification (非 sub-agent)
download_pdf(arxiv_id) → local_path       # 用户确认后下载
decide_replan(results, memory) → bool + new_terms  # 补检索词决策
```

**精读模块 Reader agent 工具** (待 §2.2 详细讨论):
```
read_pdf_pages(path, range)
write_note_section(slug, section, content)
self_ask(question) → answer               # self-ask + self-answer
trigger_profile_update(slug) → diff       # 精读完成后触发
... (TBD)
```

注: 两个模块的 tool 集合**完全独立**, 检索 agent 没有 `read_pdf_pages`, Reader 没有 `search_arxiv`.

### 7.2 Trace 格式 (JSONL, 一行一事件)

```jsonl
{"t":"...","step":1,"phase":"plan","kind":"thought","agent_id":"master","text":"..."}
{"t":"...","step":2,"phase":"search","kind":"tool_call","agent_id":"master","tool":"search_arxiv","args":{...}}
{"t":"...","step":2,"phase":"search","kind":"observation","agent_id":"master","result":{"n":47}}
{"t":"...","step":15,"phase":"plan","kind":"replan","agent_id":"master","reason":"after reading ReAct, adding Reflexion"}
{"t":"...","step":20,"phase":"read","kind":"thought","agent_id":"reader-react-agent","parent":"master","text":"..."}
```

带 `agent_id` + `parent` 字段以支持前端树状展示. 详细 schema (token 计数 / error / span begin-end) W1 实现时定.

---

## 8. Web UI 设计

### 8.1 视图

#### Home
- 顶部: profile 摘要卡片 (已读 N 篇 / 兴趣推断 / 待问用户)
- 中部: 输入 query 按钮 (启动 query 模式)
- 底部: 历史 run 列表

#### RunLive (主秀场)
- **左半屏 TraceStream**: agent 每一步实时滚动
  ```
  [Master] thinking…
  [Tool: search_arxiv("agent harness")]
  [Observation: 47 candidates]
  [Triage: paper 1/47…]
  ```
- **右上 PhaseStatus**: 当前阶段流水灯
- **右下 CostMeter**: tokens / API calls / replan 次数 / 已读论文数
- **底部**: sub-agent 树状视图, 点开看 Reader 的 trace
- **侧抽屉**: 已写完的笔记 markdown

这就是答辩 PPT 那张截图. 老师能直观看到 agent 在自己规划.

#### RunResult
- **左**: 该 run 产出的笔记列表
- **中**: 选中笔记渲染
- **右**: trace 回放 (时间轴)

#### Profile (新)
- 渲染 `profile.md`, 用户可编辑保存
- 高亮 `## 待问用户` section, 用户能直接回答 → 触发 profile 更新

### 8.2 后端 ↔ 前端协议

- **SSE (Server-Sent Events)** 单向推 trace
- core 的 trace bus 是 EventEmitter → `server/runner.ts` 订阅, 转 SSE 帧 → 也写一份到 `trace.jsonl` 落盘
- 前端 `useRunStream` 用 `EventSource` 订阅 `/api/runs/:id/events`

### 8.3 不做

- ❌ 用户中途干预 (跑完才能看)
- ❌ Run 历史 SQLite (扫描 `output/` 目录就够)
- ❌ 复杂认证 / 多用户

---

## 9. 评估方案

### 9.1 覆盖度对比 (产品级)

用 `Agent_Harness_Engineering_Survey.md` (用户已手工读完) 反推研究问题, 让 clawbot Query 模式跑同一问题, 对比覆盖度 + 是否找到关键论文 + 漏了哪些.

### 9.2 对照实验 (课程级)

1. **有 profile vs 无 profile**: 跑同一 query, 看是否过滤掉已读、推荐质量是否更准
2. **Query vs Cron**: Cron 跑出的推荐和 Query 手动给的, 哪种用户更愿意精读 (主观评价)
3. **Claude vs DeepSeek**: 同 query, 覆盖度 / 成本两个轴
4. **单 agent vs Master + Reader sub-agent**: Reader 隔不隔离 context, 笔记质量是否有差异

### 9.3 Dogfood 叙事 (产品级)

W3 演示从笔记数 1 → 10+ 的完整 onboarding 过程. 用户 (开发者本人) 用 clawbot 建库后, 第二次跑能否给出"基于已读笔记"的有意义推荐. 这是回应"vs ChatGPT 区别在哪"的最强答辩素材.

---

## 10. 排期 (3 周)

| 周 | 目标 | 关键产出 |
|---|---|---|
| **W1** | Master agent + Reader sub-agent + tool 注册 + trace + 跑通 query 模式端到端 (1 篇笔记) | `core` package 可用, hello agent 能跑通 |
| **W2** | Profile 自维护 + Cron 模式 + 多笔记 working memory + 在 1 个研究问题上稳定跑出 5-10 篇笔记 | 完整 `output/<run_id>/` + profile.md |
| **W3** | Server SSE + Web UI + 对照实验 + 答辩材料 | 可现场 demo, 数据齐 |

---

## 11. Future Work (写进答辩 PPT)

设计时**预留接口**但 W1-W3 不做的事:

### 11.1 Sidecar 三信号融合
当笔记数 > 30, 引入:
- Semantic Scholar API 拉 citation graph (信号 1)
- 笔记 embedding (SPECTER2 或 OpenAI embedding) → 兴趣中心 (信号 2)
- Profile 维持 (信号 3)
- 三信号融合 + LLM 重排 + 必须引用具体笔记给推荐理由

### 11.2 跨 run session 持久化
笔记数大后, working memory 跨 run 重建. 推荐策略: LLM 写一段 session summary 存盘, 恢复时塞 summary.

### 11.3 交互式精读 (Tier 2)
clawbot 顺便提供单篇 PDF 交互式精读服务. PhaseExecutor 抽象在 Reader 模块就为它留好接口:
```ts
interface Interlocutor {
  ask(question: string, context: PhaseContext): Promise<string>
}
```
survey 模式注入 `SelfCriticInterlocutor`, 交互模式注入 `UserInterlocutor`.

### 11.4 MCP wrapper
把 `paper-tools` 包装成 MCP server, 供 Claude Code 等 MCP host 直接调.

### 11.5 知识库管家 daemon
- 检测笔记之间的隐含矛盾
- 提醒"你这个 2024 笔记的结论已被 2025 推翻"
- 建议合并 / 拆分笔记
- 定期重写 INDEX

### 11.6 SQLite + 多 run 对比
当前用扫描 `output/` 目录代替.

### 11.7 clawbot → paper-reader 闭环
clawbot 跑完, 用户对感兴趣的笔记复制进 paper-reader 继续手工精读, 形成"批量初筛 → 单篇深读"的工作流闭环.

---

## 12. 决策日志

### 已拍板 (避免反悔)

1. **产品定位**: personal paper notes corpus 的 agent 层, 不是综述生成器 (放弃和 ChatGPT Deep Research 直接竞争)
2. **核心差异化**: 看得到用户本地笔记仓库 (SaaS 看不到)
3. **冷启动策略**: graceful degradation, 笔记数决定 personalization 强度
4. **两个核心功能**: 检索 (query / cron 双模式) + 精读
5. **个性化方案**: 单一信号 (LLM 自维护 profile.md), 砍掉短期不可行的 citation / embedding 信号, 但架构留 sidecar 钩子
6. **Profile 实现**: AI 自维护 + 结构 fix + append 为主 + 阈值 rewrite + 必须标"待问用户"
7. **两个入口分离**: query_flow / cron_flow 独立, 共享下游 search / triage 子模块
8. **Sub-agent 边界**: Reader 才是真 sub-agent (context 隔离), Triage 那批是 batch classification
9. **任务选型**: 论文综述 + 长期个性化 (放弃 multi-hop QA, 因玩具化)
10. **输出形式**: 一组 paper-reader 格式笔记 + profile.md (不做单独的综述报告)
11. **LLM 后端**: 多后端抽象 (主 Claude, 备 DeepSeek)
12. **运行语言**: TS/Node 主导, Python 做工具服务, HTTP 通信
13. **MCP**: 不做 (W3 末若有余力可加 wrapper, 列入 future work)
14. **检索源**: W3 仅 arXiv, S2 列 future work
15. **前端**: Web UI (React + Vite), monorepo 组织
16. **持久化**: 扫文件目录, 不上 SQLite
17. **Python 服务启动**: 手动起两个进程, 可解释三层架构
18. **Monorepo 工具**: pnpm workspace, 不上 Turborepo
19. **笔记物理隔离**: clawbot 写 `paperClaw/output/<run_id>/papers/`, profile 写 `paperClaw/output/profile.md`, 不污染 paper-reader
20. **检索与精读完全独立**: 两个模块无直接依赖, 唯一耦合是磁盘上的 PDF 文件
21. **检索不产出笔记**: 检索模块只返回 shortlist (paper_id + reason + 简介) + 下载用户确认的 PDF, 到此结束
22. **精读不依赖检索**: 精读模块输入是本地 PDF path, 不关心论文来源 (检索下载的 / 用户自己拿到的 / 别人发的)
23. **人类确认环节**: 检索 → 精读之间必须经过用户确认 "对哪些感兴趣", agent 不自作主张
24. **Profile 只由精读触发更新**: 检索模块不写 profile, 只有精读产出笔记后才触发 profile updater
25. **Cron 模式是推送不是 daemon**: 定时触发 → 产出 shortlist → 通知用户 → 等确认, 不是全自动跑完

### 待讨论

- 笔记 template 是否原样复用还是 clawbot 版调整 (§2.2)
- Reader 内部循环具体形式 (4 phase 硬编码 vs 内部 agent loop)
- Reader working memory compact 策略
- Plan-Act-Observe 主循环具体实现 (ReAct 文本风格 vs Native tool use API)
- 检索模块的 replan 触发机制 (硬规则 fallback + LLM 自决)
- Profile rewrite 的 token 阈值
- Trace schema 细节 (span begin/end / token 计数 / error 字段)
- 用户确认交互的具体 UX (Web UI 里 shortlist 怎么呈现 / 怎么勾选确认)

---

## 13. 命名约定

- **项目名**: paperClaw (仓库名) / clawbot (agent 名)
- **run_id**: ISO 时间戳 + 短哈希, 如 `2026-05-31T120000-a3f2`
- **paper slug**: 沿用 paper-reader 规则 (lowercase, hyphens only, no spaces, 例 `react-agent`)
- **工具命名**: snake_case (`search_arxiv`, `read_pdf_pages`)
- **TS module**: kebab-case 文件名, PascalCase 类型名
