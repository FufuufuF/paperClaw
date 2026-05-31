# clawbot — 设计文档

> 数据挖掘期末项目 · 2026 春
> 选题: 部署 openClaw 完成复杂任务 (自实现 agent 框架版)
> 创建日期: 2026-05-31

---

## 0. 项目一句话定位

**clawbot 把 paper-reader 里"由用户主导的论文 4 阶段精读"自动化, 前面加一段冷启动检索-初筛规划, 后面加一段跨论文聚合索引, 中间的单篇精读复用已有的 paper-reader 笔记模板. 输出: 一组 paper-reader 格式的中文笔记 (`papers/<slug>.md`) + 一份顶层 `INDEX.md`.**

---

## 1. 课程定位与评分点对齐

### 1.1 课程要求理解

老师给的备选选题之一是"使用 LLM 完成数据挖掘任务", 因此本选题中**经典数据挖掘算法不是评分点**, **下游任务也不要求是数据挖掘任务本身**. 课程关注的核心是:

> **多步推理与规划 (multi-step reasoning & planning)** —— agent 能否在不确定环境下自主拆解任务、根据中间结果调整后续行动.

### 1.2 为什么是"论文综述"而不是 multi-hop QA

最初考虑过 multi-hop QA (HotpotQA / MuSiQue 等), 但放弃, 理由:
- multi-hop QA 太"玩具", 跑分意义大于实际意义
- 论文综述任务有真实使用场景 (用户已经在用 paper-reader 手工读论文)
- 综述任务里的 replan 是真实的, 不是凑数:
  - **检索词演化**: 读到 ReAct 后, 是否要追加 "Reflexion" "Toolformer"
  - **何时停**: 覆盖度饱和判断
  - **结构生成**: 按方法分类 vs 按问题 vs 按时间, 取决于读到了什么
  - **冲突调和**: 论文间结论矛盾时如何 frame

### 1.3 评分点 → 项目特性映射

| 课程关注 | clawbot 体现 |
|---|---|
| 多步推理 | 每个研究问题平均触发 N 轮 search, M 次 replan, trace 可视化 |
| 工具编排 | 6-8 个工具, 平均链长 X, 显式 sub-agent 隔离 |
| 错误恢复 | API 失败 / PDF 解析失败的 trace 案例 |
| 评估 | (1) 拿用户已手工读完的 `Agent_Harness_Engineering_Survey` 当 ground truth 对比覆盖度; (2) 对照实验: 有 replan vs 无 replan, Claude vs DeepSeek, 单 agent vs 主-从 agent |

---

## 2. 与 paper-reader 的关系

### 2.1 现状理解

现有仓库 `~/Desktop/personal-projects/paper-reader/` 是一个**单篇辅助**工具:
- 用户给一个 PDF, 通过 `/paper-add` → `/paper-read` → `/paper-link` 三个 Claude Code skill 完成精读
- 4 阶段协议: skim → method → engineering → verdict
- 笔记模板 `papers/<slug>.md` 面向 agent 工程, 中文为主, 英文术语保留
- 关键句**中英对照** (用户英语阅读不流利)
- 笔记之间用 `[[slug]]` 互链
- **Claude 是助教, 不是替用户读**

### 2.2 clawbot 是上层调用

```
现在 (paper-reader): 用户已知道读哪篇 → Claude 帮忙精读
clawbot:             用户给一个研究问题 → clawbot 自主跑 检索→初筛→精读→聚合 整条链
```

不是替代关系, 而是**上层调用**. 综述 agent 的"精读"环节本质上是 `/paper-read` 4 阶段的自动化版.

### 2.3 资产复用边界

| 资产 | 是否复用 | 说明 |
|---|---|---|
| `template.md` | ✅ 直接复用 | clawbot 的 Reader 写笔记时填这个模板 |
| 4 阶段协议 (skim/method/engineering/verdict) | ✅ 改写 | 自动版没有用户, Phase 2/3 的"追问"变成 self-ask |
| `[[slug]]` 互链 | ✅ | clawbot 写完一篇后扫已有笔记加链接 |
| 中英对照 | ❌ 不做 | 自动综述场景用不上 |
| `/paper-add` `/paper-read` Claude Code skill | ❌ 不复用 | 那是 skill, 不是独立程序 |
| `Agent_Harness_Engineering_Survey.md` | ✅ 当 ground truth | 用户已手工读完, 反推研究问题做对比基线 |

### 2.4 物理隔离

clawbot 的笔记**写到自己的 `output/<run_id>/papers/`**, 不污染 paper-reader 的 `papers/`. 用户跑完后可手动 `cp` 想要的笔记进 paper-reader 继续手工精读, 形成"clawbot 输出 → paper-reader 输入"的工作流闭环 (作为 future work 写进答辩 PPT).

---

## 3. 技术栈与运行形态

### 3.1 决策汇总

| 维度 | 决定 | 理由 |
|---|---|---|
| 主语言 | TypeScript / Node.js | 贴近 nanobot 风格, 符合"agent 框架"主题 |
| 脏活语言 | Python (FastAPI) | arxiv API / PDF 处理生态成熟 |
| Node↔Python 通信 | HTTP | 简单, 不上 MCP (避免协议层在 trace 里加噪声) |
| LLM 后端 | **多后端抽象** | 主推 Claude, 备 DeepSeek, 做对照实验, 是课程加分项 |
| 检索源 | **仅 arXiv** | 官方免费 API, 无需 key, 响应稳定, agent/AI 领域足够 |
| Monorepo 工具 | **pnpm workspace** | 不上 Turborepo (期末项目, 缓存配置纯负担) |
| 前端 | **React + Vite** | 监控 live trace, 答辩演示效果 |
| 后端 ↔ 前端 | **SSE (Server-Sent Events)** | 单向流式推 trace, 不需要 WebSocket 的双向 |
| Run 持久化 | **扫描 `output/` 目录** | 不上 SQLite, 期末够用 |
| 用户中途干预 | **不需要** | 纯看戏模式, 跑完才能看 |
| Python 服务启动 | **手动起两个进程** | 演示时可解释"前端/Node 编排/Python 工具服务"三层架构 |

### 3.2 多后端 LLM 抽象

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

三家 tool use 的差异点 (adapter 要处理):
- **Anthropic**: `tool_use` content block, parallel tool calls 原生, 需 `tool_result` 回传
- **OpenAI**: `tool_calls` 数组在 message 上, parallel 也支持, `role: tool` 回传
- **DeepSeek**: 接口跟 OpenAI 兼容, 但 `deepseek-chat` 的 tool use 在长链里偶有掉 `tool_call_id` 的 bug, 要做 defensive parsing

主跑 **Claude**, **DeepSeek 当便宜的 fallback / 对照实验后端**. 答辩时"在 Claude 上达到 X 覆盖率, 在 DeepSeek 上 Y 覆盖率, 成本差 Z 倍"是非常有说服力的对照表.

---

## 4. 仓库骨架

```
paperClaw/
├── design.md                     # 本文件
├── pnpm-workspace.yaml
├── package.json
├── packages/
│   ├── core/                     # TS, agent 框架, 跟前端无关
│   │   ├── src/
│   │   │   ├── llm/              # LLM 多后端抽象
│   │   │   │   ├── types.ts      # ChatMessage, ToolCall, ToolResult 等接口
│   │   │   │   ├── anthropic.ts
│   │   │   │   ├── openai.ts
│   │   │   │   ├── deepseek.ts
│   │   │   │   └── index.ts      # createClient(provider, config)
│   │   │   ├── agent/
│   │   │   │   ├── loop.ts       # plan → act → observe 主循环
│   │   │   │   ├── memory.ts     # working memory (已读笔记摘要池)
│   │   │   │   └── trace.ts      # 每步落 JSONL, 答辩弹药
│   │   │   ├── tools/
│   │   │   │   ├── registry.ts   # tool 注册 + JSON schema
│   │   │   │   ├── search.ts     # 调 Python arxiv 服务
│   │   │   │   ├── pdf.ts        # 调 Python PDF 服务
│   │   │   │   ├── notes.ts      # 写 papers/<slug>.md (复用 paper-reader template)
│   │   │   │   └── index_writer.ts
│   │   │   └── pipeline/
│   │   │       ├── planner.ts    # 全局规划器 prompt + replan 决策
│   │   │       ├── triage.ts     # 摘要级初筛
│   │   │       ├── reader.ts     # 单篇精读 sub-agent
│   │   │       └── indexer.ts    # 跨论文聚合
│   │   └── package.json
│   ├── server/                   # HTTP + SSE, 暴露 core 给前端
│   │   └── src/
│   │       ├── routes/
│   │       │   ├── runs.ts       # POST /api/runs (启动一次 survey)
│   │       │   │                 # GET  /api/runs/:id
│   │       │   │                 # GET  /api/runs/:id/events  (SSE 推 trace)
│   │       │   ├── notes.ts      # GET  /api/runs/:id/notes/:slug
│   │       │   └── index_md.ts   # GET  /api/runs/:id/index
│   │       └── runner.ts         # 包 core, 拿 trace 转 SSE event
│   ├── web/                      # React + Vite
│   │   └── src/
│   │       ├── pages/
│   │       │   ├── Home.tsx              # 输入研究问题
│   │       │   ├── RunLive.tsx           # 主秀场: live trace + 进度
│   │       │   └── RunResult.tsx         # 跑完后看 INDEX + 笔记
│   │       ├── components/
│   │       │   ├── TraceStream.tsx       # 订阅 SSE
│   │       │   ├── PhaseStatus.tsx       # 现在在 Search/Triage/Read/Index 哪一阶段
│   │       │   ├── NoteViewer.tsx        # 渲染单篇 markdown
│   │       │   └── CostMeter.tsx         # token 实时计数
│   │       └── hooks/useRunStream.ts
│   └── cli/                      # 可选, 命令行入口 (不一定做)
│       └── src/run.ts            # clawbot run "agent harness 设计"
├── services/
│   └── paper-tools/              # Python FastAPI
│       ├── arxiv_search.py       # GET /search?q=...&max=...
│       ├── pdf_extract.py        # POST /extract  (内部用 pdftotext / pypdf)
│       ├── main.py               # FastAPI app
│       └── requirements.txt
└── output/
    └── <run_id>/
        ├── papers/               # 每篇笔记 (paper-reader 格式)
        ├── INDEX.md
        ├── trace.jsonl           # 完整 plan/act/observe 流水
        └── meta.json             # token 用量、耗时、replan 次数等
```

---

## 5. Pipeline 五段架构

```
research_question
        │
        ▼
   ┌─────────┐
   │ Planner │◄────────────────┐
   └────┬────┘                 │ replan
        │ search_terms[]       │ (覆盖度不够 / 新概念出现)
        ▼                      │
   ┌──────────┐                │
   │ Searcher │ ─arxiv API────►│
   └────┬─────┘                │
        │ candidates[]         │
        ▼                      │
   ┌────────┐                  │
   │ Triage │ ─只读 abstract──►│ 这篇值不值得花 PDF 解析的钱
   └────┬───┘                  │
        │ shortlist[]          │
        ▼                      │
   ┌────────┐                  │
   │ Reader │ ─PDF→4阶段笔记──►│ 单篇产出 papers/<slug>.md
   └────┬───┘                  │
        │ notes[]              │
        ▼                      │
   ┌─────────┐                 │
   │ Stop?   │─不够─────────────┘
   └────┬────┘
        │ 够了
        ▼
   ┌─────────┐
   │ Indexer │ ─跨论文聚合─► INDEX.md
   └─────────┘
```

### 5.1 Planner — 全局规划器

- **输入**: 研究问题
- **第一轮**: 产出 3-5 个**多样性**检索词 (中英都行, 实际查 arXiv 用英文)
- **后续轮**: 看 working memory (已读笔记的 title + 一句话定位 + 关键术语), 判断:
  - 是否覆盖度饱和 (连续 2 轮新检索词命中已有论文 > 80% → 停)
  - 是否要补检索词 (读到 ReAct 后, 是否要追加 "Reflexion" "Toolformer")
  - 是否要 broaden / narrow (结果 0 篇 → broaden; 结果 200 篇 → narrow)

### 5.2 Searcher — 检索执行器

- **工具**: `search_arxiv(query, max_n)`
- **返回**: `[{title, abstract, authors, year, arxiv_id}]`
- **不**自己判断好坏, 只搜

### 5.3 Triage — 摘要级初筛

- 对每个 candidate, 只用 abstract 跑一次 LLM 判断: `{verdict: 精读/略过, reason}`
- 对应 paper-reader 里 Phase 1 的"建议: 值得精读 / 略读 / 跳过"
- **关键设计**: Triage reject 的论文不直接进笔记, 但**进 INDEX 的"未精读但提及"区**

### 5.4 Reader — 单篇精读 sub-agent

- 复用 paper-reader 的 `template.md` 不变
- 自动版 4 阶段:
  - **Phase 1 (skim)**: 读 PDF 1-2 页 + 末 1-2 页 → 填"一句话定位"
  - **Phase 2 (method)**: 定位 method section → 填"核心方法"伪代码
  - **Phase 3 (engineering)**: 读 experiment + appendix → 填"能抄什么" + "工程考虑"
  - **Phase 4 (verdict)**: 自动给"采用/观望/弃用", 附置信度 (综述场景多数会是"观望")
- 跟 paper-reader 的差异:
  - 没有用户互动, Phase 2/3 的"追问"变成 agent **self-ask + self-answer** (这本身就是规划的一种)
  - **不做**中英对照 (综述给自己看 INDEX, 不需要)
- **Reader 作为独立 sub-agent 调用**, context 隔离, 主 agent 不被 PDF 内容污染

### 5.5 Indexer — 跨论文聚合

最值得展示规划深度的一环, **不要敷衍**.

- **输入**: N 篇笔记的全文 + Triage 留底
- **输出 `INDEX.md`** 包含:
  1. **研究问题原话** + 一句话总结
  2. **主题分组**: agent 自己决定按方法 / 按问题 / 按时间分类 (这个分类决策本身要 log 出来作为规划证据). 每组下挂 `[[slug]]` 链接 + 1 句话该篇贡献
  3. **演化时间线**: 按发表年份的脉络
  4. **冲突 / 争议**: 论文间互相打脸的地方, 显式标出
  5. **未精读但提及**: Triage 刷下来的, 带一句话理由
  6. **覆盖度自评**: agent 说"我觉得我可能漏了 X 方向"

---

## 6. clawbot 框架核心组件 (参考 nanobot)

| 组件 | 必做 | 说明 |
|---|---|---|
| Plan-Act-Observe 主循环 | ✅ | 最小骨架, 不需要花哨的状态机 |
| Tool 注册与调度 | ✅ | 6-8 个工具, JSON schema 驱动 |
| Working memory | ✅ | 读过的笔记摘要塞进每轮 prompt; 超 K 篇之后只保留摘要 |
| Trace 日志 | ✅ | **每一步的 thought / action / observation 落到 JSONL**, 答辩弹药 |
| Sub-agent (Reader 当独立 agent) | ✅ | 主 agent 调 sub-agent, sub-agent 只管读一篇, context 隔离 |
| 失败重试 / 退避 | ✅ | API rate limit、PDF 下载失败 |
| Token / 成本 counter | ✅ | "读 10 篇花了 X 元"在答辩很有说服力 |

### 6.1 Tool 清单 (暴露给 LLM 的)

```
plan_search(question, current_memory) → terms[]
search_arxiv(query, max_n)
triage(abstract) → verdict
fetch_pdf(arxiv_id) → local_path
read_pdf_pages(path, range)
write_note(slug, sections)
read_notes_summary()           // working memory 的接口
write_index(content)
decide_stop(memory) → bool + reason
```

### 6.2 Trace 格式 (JSONL, 一行一事件)

```jsonl
{"t":"2026-05-31T12:00:01Z","step":1,"phase":"plan","kind":"thought","text":"..."}
{"t":"2026-05-31T12:00:03Z","step":2,"phase":"search","kind":"tool_call","tool":"search_arxiv","args":{"query":"agent harness"}}
{"t":"2026-05-31T12:00:04Z","step":2,"phase":"search","kind":"observation","result":{"n":47}}
{"t":"2026-05-31T12:00:10Z","step":3,"phase":"triage","kind":"verdict","arxiv_id":"2310.xxx","verdict":"deep_read","reason":"..."}
{"t":"2026-05-31T12:01:30Z","step":15,"phase":"plan","kind":"replan","reason":"after reading ReAct, adding Reflexion to search terms"}
```

每条带 `step`, `phase`, `kind` 三个维度, 方便前端筛选展示.

---

## 7. Web UI 设计

### 7.1 三个视图

#### Home
极简, 一个 textarea 输入研究问题, 几个高级选项 (LLM 后端选 Claude/DeepSeek, 最多读几篇, 超时上限), Run 按钮.

#### RunLive (项目主秀场)
- **左半屏 TraceStream**: agent 的每一步实时滚动:
  ```
  [Planner] thinking…
  [Tool: search_arxiv("agent harness")]
  [Observation: 47 candidates]
  [Triage: paper 1/47…]
  ```
- **右上 PhaseStatus**: 5 个阶段流水灯 (Plan / Search / Triage / Read / Index), 当前阶段亮
- **右下 CostMeter**: tokens / API calls / replan 次数 / 已读论文数 实时计数
- **底部**: 已经写完的笔记列表, 点开侧边抽屉看 markdown

这就是答辩 PPT 那张截图. 老师能直观看到"哦, 这个 agent 在自己规划".

#### RunResult
跑完后的结果页:
- 中间: `INDEX.md` 渲染
- 左边: 目录树 (分组结构 + 笔记列表)
- 右边: 切换"trace 回放"——把整个 trace.jsonl 用时间轴重放, 讲 multi-step reasoning 的最佳载体

### 7.2 后端 ↔ 前端协议

- **SSE (Server-Sent Events)** 单向推 trace
- core 的 trace bus 是 EventEmitter → `server/runner.ts` 订阅, 转 SSE 帧 → 顺手也写一份到 `trace.jsonl` 落盘
- 前端 `useRunStream` 用 `EventSource` 订阅 `/api/runs/:id/events`

### 7.3 不做的事

- ❌ 用户中途干预 (跑完才能看)
- ❌ Run 历史用 SQLite (扫描 `output/` 目录就够了)
- ❌ 复杂的认证 / 多用户

---

## 8. 排期 (2-3 周)

| 周 | 目标 | 关键产出 |
|---|---|---|
| **W1** | clawbot 主循环 + tool 注册 + trace + 跑通"问题→1 篇笔记"端到端 | `core` package 可用, hello agent 能跑通 |
| **W2** | Searcher / Triage / 多论文 working memory / 停止判断 + Indexer; 在 1 个研究问题上稳定跑出 5-10 篇笔记 | 一个完整的 `output/<run_id>/` |
| **W3** | `server` SSE + Web UI (RunLive + RunResult) + 对照实验 + 答辩材料 | 可现场 demo, 对比实验数据齐 |

### 评估方案 (W3 末)

1. **覆盖度对比**: 用户已手工读完的 `Agent_Harness_Engineering_Survey.md` → 反推研究问题 → 让 clawbot 跑同一问题 → 对比 clawbot 的笔记集与人工 survey 的覆盖度
2. **对照实验**:
   - 有 replan vs 无 replan
   - Claude 4.5 vs DeepSeek (覆盖度 / 成本两个轴画对比图)
   - 单 agent vs 主-从 agent (Reader 隔不隔离 context)

---

## 9. Future Work (写进答辩 PPT)

设计时**预留接口**但 W1-W3 不做的事, 显示对设计空间有认识:

### 9.1 交互式精读 (Tier 2)
- clawbot 顺便提供单篇论文交互式精读服务
- PhaseExecutor 抽象其实在 Reader 模块就为它留好接口
- 实现方式: 抽出 `Interlocutor` 接口, survey 模式注入 `SelfCriticInterlocutor`, 交互模式注入 `UserInterlocutor`
  ```ts
  interface Interlocutor {
    ask(question: string, context: PhaseContext): Promise<string>
  }
  ```
- 还需要: 输入路由器 (命令 / 自由问答 / 阶段内回答 / 阶段外回答四类分发) + REPL

### 9.2 Session 持久化 (跨日继续读)
- 难点是恢复时怎么把之前的对话重建给 LLM
- 推荐策略: **LLM 写一段 session summary 存盘, 恢复时塞 summary** (中速度、中成本、效果最优)

### 9.3 autonomous ↔ interactive 衔接
- survey 跑出来的 shortlist 可以无缝切到精读
- 主循环要变成可暂停的状态机

### 9.4 MCP wrapper
- 把 `paper-tools` 服务包装成 MCP server
- 供 Claude Code 等 MCP host 直接调

### 9.5 Run 历史 + SQLite
- 多 run 对比、tag 检索
- 当前用扫描 `output/` 目录代替

### 9.6 clawbot 输出 → paper-reader 输入闭环
- clawbot 跑完综述, 用户对感兴趣的笔记复制进 paper-reader 继续手工精读
- 形成"批量初筛 → 单篇深读"的工作流闭环

---

## 10. 决策日志 (讨论中拍板的关键)

记录避免后续反悔:

1. **任务选型**: 论文综述 (放弃 multi-hop QA, 因玩具化)
2. **输入模式**: 冷启动 (只给一个研究问题, 不做 snowball seed)
3. **输出形式**: 一组 paper-reader 格式笔记 + 顶层 INDEX (不做单独的综述报告/对比表)
4. **LLM 后端**: 多后端抽象 (主 Claude, 备 DeepSeek)
5. **运行语言**: TS/Node 主导, Python 做工具服务, HTTP 通信
6. **MCP**: 不做 (W3 末若有余力可加 wrapper, 列入 future work)
7. **检索源**: 仅 arXiv
8. **前端**: Web UI (React + Vite), monorepo 组织
9. **后端持久化**: 扫描 `output/` 目录, 不上 SQLite
10. **用户中途干预**: 不做, 纯看戏模式
11. **Python 服务启动**: 手动起两个进程, 可解释三层架构
12. **Monorepo 工具**: pnpm workspace, 不上 Turborepo
13. **交互式精读**: 延后, survey 跑通再决定是否做
14. **笔记产物隔离**: clawbot 写到 `output/<run_id>/papers/`, 不污染 paper-reader

---

## 11. 命名约定

- **项目名**: paperClaw (仓库名) / clawbot (agent 名)
- **run_id**: ISO 时间戳 + 短哈希, 如 `2026-05-31T120000-a3f2`
- **paper slug**: 沿用 paper-reader 规则 (lowercase, hyphens only, no spaces, 例 `react-agent`)
- **工具命名**: snake_case (`search_arxiv`, `read_pdf_pages`)
- **TS module**: kebab-case 文件名, PascalCase 类型名
