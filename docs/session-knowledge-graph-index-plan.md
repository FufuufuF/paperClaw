# Knowledge Graph Index Plan

日期: 2026-06-07

## 背景

当前 paperClaw 的长期知识主要沉淀在 Markdown 笔记和 `output/profile.md` 中。Markdown 适合人读, 但不适合作为 agent 的全局关系导航层。

本计划设计一套轻量 `knowledge-index.json`, 目标不是复制单篇论文内容, 而是记录**论文之间的关系**。agent 通过小粒度工具渐进式读取这份 index, 再按需下钻到具体 Markdown note。

核心原则:

- Markdown note 是单篇论文细节的 source of truth。
- Knowledge index 是跨论文关系导航层, 不存大段论文内容。
- agent 不能全量加载 index 到上下文。
- 所有读取都通过分页/限量 tool 暴露局部信息。
- 写入/修改图谱需要明确用户意图或在可控的自动触发点执行。

## 非目标

- 不引入 Neo4j/RDF/向量库作为第一版依赖。
- 不把每篇论文的 concepts/methods/claims 全量复制进 index。
- 不替代 `profile.md`。
- 不替代 Markdown notes。
- 不在系统 prompt 中注入完整 knowledge index。

## 文件位置

第一版使用单文件 JSON:

```text
output/knowledge-index.json
```

后续如果增长过大, 再拆成:

```text
output/knowledge/
  nodes.json
  links.json
  open-questions.json
  suggestion-cache.json
```

## Index Schema

### 顶层结构

```json
{
  "version": 1,
  "updated_at": "2026-06-07T00:00:00.000Z",
  "papers": {},
  "links": [],
  "open_questions": []
}
```

### papers

`papers` 是论文节点注册表, 只保留最小可导航信息。

```json
{
  "2401.07324": {
    "id": "2401.07324",
    "title": "Small LLMs Are Weak Tool Learners: A Multi-LLM Agent",
    "note_path": "output/2026-.../papers/2401.07324.md",
    "arxiv_id": "2401.07324",
    "status": "reading",
    "verdict": "maybe",
    "updated_at": "2026-06-07T00:00:00.000Z"
  }
}
```

字段含义:

- `id`: 图谱节点 id。默认用 note slug 或 arXiv id。
- `title`: 展示标题。
- `note_path`: 对应 Markdown note 路径。agent 需要细节时再调用 note tool 读取。
- `arxiv_id`: 可选, 方便和搜索结果对齐。
- `status`: `unread | reading | read | skipped`。
- `verdict`: `adopt | maybe | skip | unknown`。
- `updated_at`: 节点最后更新时间。

### links

`links` 是核心数据。每条边表示两篇论文之间的关系。

```json
{
  "id": "link_20260607_0001",
  "source": "2401.07324",
  "target": "agent-tool-failure-harness",
  "type": "complements",
  "directional": true,
  "reason_short": "一个研究模块化工具学习, 一个研究工具调用失败恢复评估。",
  "reason": "2401.07324 关注 planner/caller/summarizer 的模块化工具学习架构; agent-tool-failure-harness 关注工具调用失败、轨迹记录和恢复策略。后者可补充前者在可靠性评估层面的空白。",
  "evidence": [
    {
      "paper_id": "2401.07324",
      "note_path": "output/.../papers/2401.07324.md",
      "section": "Abstract"
    },
    {
      "paper_id": "agent-tool-failure-harness",
      "note_path": "output/.../papers/agent-tool-failure-harness.md",
      "section": "Evaluation Harness"
    }
  ],
  "confidence": 0.74,
  "created_by": "agent",
  "created_at": "2026-06-07T00:00:00.000Z",
  "updated_at": "2026-06-07T00:00:00.000Z"
}
```

推荐关系类型:

- `extends`: A 延续/扩展 B。
- `contrasts`: A 和 B 形成对比。
- `supports`: A 支持 B 的结论。
- `challenges`: A 挑战 B 的结论。
- `complements`: A 补充 B 的盲区。
- `uses_same`: 使用相同方法、任务、benchmark 或数据集。
- `applies_to`: A 的方法可用于 B 的问题。
- `precedes`: A 是 B 的背景/前置论文。
- `replaces`: A 在方法或结果上替代 B。

字段含义:

- `id`: 边 id。
- `source` / `target`: 节点 id。
- `type`: 关系类型。
- `directional`: 是否有方向。比如 `extends` 有方向, `uses_same` 可无方向。
- `reason_short`: 给 agent 快速判断用的短解释。
- `reason`: 完整解释, 只有需要展开边时才读取。
- `evidence`: 指向 note 的证据指针, 不放全文。
- `confidence`: 0 到 1 的置信度。
- `created_by`: `agent | user | import | system`。
- `created_at` / `updated_at`: 时间戳。

### open_questions

跨论文层面的研究问题。

```json
{
  "id": "q_20260607_0001",
  "question": "如何系统评估 tool-use agent 的失败恢复能力?",
  "related_papers": ["agent-tool-failure-harness", "2401.07324"],
  "status": "open",
  "created_at": "2026-06-07T00:00:00.000Z"
}
```

## Tool 设计

### 读取类工具

读取工具不需要 confirmation gate, 但必须限量返回。

#### `kg_get_node`

读取单个论文节点的最小信息。

输入:

```json
{ "id": "2401.07324" }
```

输出:

```json
{
  "node": {
    "id": "2401.07324",
    "title": "...",
    "note_path": "output/.../papers/2401.07324.md",
    "status": "reading",
    "verdict": "maybe"
  }
}
```

用途:

- 用户问“我读过某篇论文吗?”
- agent 想从图节点找到 note path。

#### `kg_neighbors`

读取某个节点的一跳邻居。

输入:

```json
{
  "id": "2401.07324",
  "direction": "both",
  "types": ["complements", "extends"],
  "limit": 10
}
```

输出:

```json
{
  "node": "2401.07324",
  "neighbors": [
    {
      "paper_id": "agent-tool-failure-harness",
      "title": "Agent Tool Failure Harness",
      "direction": "out",
      "link_id": "link_20260607_0001",
      "link_type": "complements",
      "reason_short": "一个研究模块化工具学习, 一个研究工具调用失败恢复评估。",
      "confidence": 0.74
    }
  ],
  "truncated": false
}
```

用途:

- 推荐某篇论文之后的下一篇。
- 回答“这篇论文和我读过的哪些论文有关?”
- 帮 agent 选择是否需要进一步读某个 note。

#### `kg_get_link`

读取某条边的完整解释和证据指针。

输入:

```json
{ "id": "link_20260607_0001" }
```

输出:

```json
{
  "link": {
    "id": "link_20260607_0001",
    "source": "2401.07324",
    "target": "agent-tool-failure-harness",
    "type": "complements",
    "reason": "...",
    "evidence": [
      {
        "paper_id": "2401.07324",
        "note_path": "output/.../papers/2401.07324.md",
        "section": "Abstract"
      }
    ],
    "confidence": 0.74
  }
}
```

用途:

- agent 需要解释推荐原因。
- 用户质疑“为什么你说这两篇有关?”

#### `kg_search_nodes`

按 title/id/status/verdict 搜索节点, 不读 note。

输入:

```json
{
  "query": "tool learning",
  "status": ["read", "reading"],
  "limit": 10
}
```

输出:

```json
{
  "results": [
    {
      "id": "2401.07324",
      "title": "Small LLMs Are Weak Tool Learners...",
      "note_path": "output/.../papers/2401.07324.md",
      "matched": ["title"]
    }
  ],
  "truncated": false
}
```

#### `kg_search_links`

按关系类型、节点、关键词搜索边。

输入:

```json
{
  "query": "failure recovery",
  "types": ["complements", "uses_same"],
  "limit": 10
}
```

输出:

```json
{
  "results": [
    {
      "link_id": "link_20260607_0001",
      "source": "2401.07324",
      "target": "agent-tool-failure-harness",
      "type": "complements",
      "reason_short": "..."
    }
  ],
  "truncated": false
}
```

### 写入类工具

写入类工具必须有明确用户意图, 或者由固定自动触发点执行。默认创建 `.bak`。

#### `kg_upsert_node`

注册或更新论文节点。

触发时机:

- `read_paper` 创建 note scaffold 后。
- `record_paper_section_note` 首次写入 note 后。
- 用户明确要求“把这篇加入知识库”。

输入:

```json
{
  "id": "2401.07324",
  "title": "Small LLMs Are Weak Tool Learners...",
  "note_path": "output/.../papers/2401.07324.md",
  "arxiv_id": "2401.07324",
  "status": "reading",
  "verdict": "maybe"
}
```

#### `kg_upsert_link`

新增或更新论文关系边。

触发时机:

- 用户明确说“这篇和那篇有关/形成对比/补充”。
- agent 在精读后提出候选关系, 用户确认。
- 批处理型 synthesis 任务结束后, agent 提议写入关系。

输入:

```json
{
  "source": "2401.07324",
  "target": "agent-tool-failure-harness",
  "type": "complements",
  "reason_short": "...",
  "reason": "...",
  "evidence": [],
  "confidence": 0.74
}
```

#### `kg_update_link`

修改关系类型、解释或置信度。

触发时机:

- 用户纠正关系。
- agent 读到新证据后提出修改, 用户确认。

#### `kg_delete_link`

删除错误关系。

触发时机:

- 用户明确要求删除。

## Agent 何时更新 Knowledge Index

### 自动/半自动节点更新

1. `read_paper` 成功后:
   - 调 `kg_upsert_node`。
   - status = `reading`。
   - note_path 指向新 note。
   - 不创建 links。

2. `record_paper_section_note` 后:
   - 调 `kg_upsert_node` 更新 `updated_at`。
   - 如果所有 section 完成, status = `read`, verdict 来自 note/profile。

3. `rename_note_slug` 后:
   - 更新 node id 或 note_path。
   - 保持旧 id 的 alias/redirect 是否需要支持, 后续再定。

### 关系更新

默认不全自动写 link, 避免图谱污染。

推荐流程:

1. agent 发现候选关系。
2. agent 告诉用户:
   - 关系类型
   - short reason
   - 涉及的论文
3. 用户确认后, agent 调 `kg_upsert_link`。

允许的轻自动场景:

- 用户明确说“把刚才讨论的联系记下来”。
- 用户明确说“这篇补充/挑战/延续了前一篇”。
- 批量综述/synthesis 任务中, 用户提前授权“完成后把论文关系写入知识库”。

## 主动关系发现与触发策略

目标: agent 应该能主动发现当前论文和历史论文之间的关系, 但不能每轮对话都触发高成本 LLM rerank 或 sub-agent。关系发现分成多层触发, 先便宜筛选, 再按需升级。

### 触发层级

#### L0: 不触发

以下情况不做关系检索:

- 用户只是问定义、翻译或解释某句话。
- 当前 section 太短, 或没有方法/实验/结论信息。
- 当前 section 是纯背景铺垫, 没有新的实体、claim、benchmark、failure mode。
- 同一个 section 的 relation suggestion 已经跑过, 且 section note 未变化。
- 用户明确说“先别关联旧论文”。

#### L1: Cheap Candidate Scan

可以较频繁触发, 但只使用本地 index 和轻量启发式, 不调用 LLM/sub-agent。

触发条件:

- 新 section 被加载后, 且 section 标题或内容明显包含方法、benchmark、claim、failure mode。
- 用户问“这和以前读过的有什么关系?”。
- section 标题属于 Method / Experiments / Results / Limitations / Conclusion。
- 当前 section note 刚被 `record_paper_section_note` 写入。

动作:

- 调 `kg_search_nodes`。
- 调 `kg_search_links`。
- 调 `kg_neighbors`。
- 做关键词/标题/reason_short 的轻量匹配。
- 如果候选很弱, 不打扰用户。

#### L2: LLM Rerank

只在 cheap scan 找到足够候选时触发。

触发条件:

- cheap scan 的 top candidates >= 3。
- top cheap score >= 配置阈值, 默认 `0.5`。
- 当前 section 是高价值 section: Method / Results / Limitations / Conclusion。
- 用户正在深入追问“比较 / 关系 / 和之前有什么不同”。
- 当前 section note 已经沉淀, 可用压缩后的 note 作为 rerank 输入。

动作:

- 给 LLM 一个很小的候选集。
- 输入只包含:
  - 当前 section title。
  - 当前 section note 或短 summary。
  - 候选论文 title / reason_short / note snippet。
  - 已有 link 摘要。
- LLM 输出:
  - 是否相关。
  - 推荐 link type。
  - reason_short。
  - confidence。
  - recommended_action: `mention_only | create_pending | skip`。

#### L3: Sub-agent Consolidation

低频触发, 用于系统性整理整篇论文和知识图谱的关系。

触发条件:

- 一篇论文全部 section 读完。
- 用户说“总结这篇并沉淀到知识库”。
- 用户说“帮我整理这篇和之前论文的关系”。
- cron/maintenance 空闲任务。
- 累积了多个 pending relation, 需要批量 review。

动作:

- 开 sub-agent 运行 `knowledge-consolidation` 流程。
- sub-agent 读取当前论文 note 摘要。
- 查询 graph 中相关候选。
- 读取少量候选 note section。
- 生成 pending links。
- 主 agent 向用户展示候选关系, 等待确认或批量接受。

### 触发时机表

| 时机 | 默认动作 | 是否 LLM rerank | 是否 sub-agent |
|---|---|---:|---:|
| 加载 section 后 | 不做或 cheap scan | 否 | 否 |
| 用户问“和以前有什么关系” | cheap scan + 可 rerank | 是 | 否 |
| 沉淀 section note 后 | cheap scan; 高价值 section 可 rerank | 可选 | 否 |
| 读完整篇论文后 | consolidation | 是 | 是 |
| cron/空闲整理 | batch consolidation | 是 | 是 |
| 用户明确要求整理关系 | full relation mining | 是 | 是 |

### 推荐的第一版策略

第一版不要每节自动开 LLM:

- section 导读中: 只有用户问关系/比较时, 才允许 LLM rerank。
- `record_paper_section_note` 后: 默认只 cheap scan, 可缓存候选, 不打扰用户。
- 整篇读完后: 开 sub-agent 做系统 consolidation, 生成 pending links。
- 用户确认后: pending links 转正式 links。

## Link Suggestion Tool

### `kg_suggest_links`

候选关系生成器。它不写 `knowledge-index.json`, 只返回少量候选关系。

输入:

```json
{
  "source": "2401.07324",
  "section_title": "3.2 The α-UMi Framework",
  "section_summary": "本节介绍 planner/caller/summarizer decomposition for tool learning.",
  "query_hints": [
    "planner caller summarizer",
    "multi-LLM decomposition",
    "tool learning architecture"
  ],
  "mode": "cheap",
  "limit": 5
}
```

字段:

- `source`: 当前论文节点 id。
- `section_title`: 当前 section 标题。
- `section_summary`: 当前 section 的短摘要或已沉淀 section note, 不传全文。
- `query_hints`: 主 agent 从当前 section 抽取的关键词/短语。
- `mode`: `cheap | rerank`。第一版默认 `cheap`; 用户问关系或高价值 section 才允许 `rerank`。
- `limit`: 最多返回候选数量。

输出:

```json
{
  "source": "2401.07324",
  "mode": "cheap",
  "suggestions": [
    {
      "target": "agent-tool-failure-harness",
      "target_title": "Agent Tool Failure Harness",
      "type": "complements",
      "reason_short": "当前 section 讲工具调用架构拆分; 旧笔记关注工具调用失败恢复评估。",
      "evidence": [
        {
          "paper_id": "2401.07324",
          "section": "3.2 The α-UMi Framework"
        },
        {
          "paper_id": "agent-tool-failure-harness",
          "note_path": "output/.../papers/agent-tool-failure-harness.md",
          "section": "Evaluation Harness"
        }
      ],
      "confidence": 0.68,
      "recommended_action": "mention_only"
    }
  ],
  "truncated": false
}
```

`recommended_action`:

- `mention_only`: 导读时可顺口提示, 不写入。
- `create_pending`: 建议写 pending link, 等用户确认。
- `skip`: 相关性弱, 不建议使用。

实现流程:

1. 读取 source node。
2. 根据 `section_title`、`section_summary`、`query_hints` 构造候选查询。
3. 通过 `kg_search_nodes`、`kg_search_links`、`kg_neighbors` 找候选旧论文。
4. 过滤 source 自身、已存在同类型 link、skipped 节点和低分候选。
5. 对 top K 候选读取有限 note snippet, 例如前 3000 字或未来的 `read_note_section`。
6. cheap mode 使用启发式打分:
   - query hint 和 title/note/reason_short 的重叠。
   - 是否命中相同 benchmark/method/failure mode。
   - 是否命中用户近期兴趣。
   - 图距离是否较近。
7. rerank mode 在 cheap top K 上调用 LLM, 判断相关性、关系类型、reason_short 和 confidence。
8. 返回排序后的候选, 不写入 index。

### Pending Link Tools

为避免 agent 直接污染长期图谱, 第一版建议引入 pending 关系。

#### `kg_create_pending_link`

把候选关系写入 `pending_links`, 等用户 review。

#### `kg_list_pending_links`

分页列出待确认关系。

#### `kg_commit_pending_link`

把 pending link 转成正式 `links`。

#### `kg_reject_pending_link`

拒绝候选关系, 保留审计记录或直接删除。

### Pending Schema

```json
{
  "pending_links": [
    {
      "id": "pending_20260607_0001",
      "source": "2401.07324",
      "target": "agent-tool-failure-harness",
      "type": "complements",
      "reason_short": "...",
      "reason": "...",
      "evidence": [],
      "confidence": 0.71,
      "status": "pending_user_review",
      "created_by": "agent",
      "created_at": "2026-06-07T00:00:00.000Z"
    }
  ]
}
```

## 成本控制与缓存

### 配置

建议新增 `knowledge.linkSuggestion` 配置:

```json
{
  "knowledge": {
    "linkSuggestion": {
      "cheapScan": true,
      "llmRerank": "on_demand",
      "maxReranksPerPaper": 3,
      "maxCandidatesForRerank": 8,
      "minCheapScore": 0.5,
      "triggerSections": ["method", "results", "limitations", "conclusion"],
      "autoPendingThreshold": 0.8
    }
  }
}
```

含义:

- `cheapScan`: 是否启用便宜候选扫描。
- `llmRerank`: `off | on_demand | auto_for_high_value_sections`。
- `maxReranksPerPaper`: 单篇论文最多 LLM rerank 次数。
- `maxCandidatesForRerank`: 每次给 LLM 的候选上限。
- `minCheapScore`: 进入 rerank 的最低启发式分数。
- `triggerSections`: 自动考虑 rerank 的 section 类型。
- `autoPendingThreshold`: 超过该置信度可写入 pending, 但不直接写正式 links。

### Suggestion Cache

避免同一 section 反复花钱。

建议单独存:

```text
output/knowledge/suggestion-cache.json
```

结构:

```json
{
  "2401.07324#3.2 The α-UMi Framework": {
    "section_note_hash": "sha256:...",
    "last_run_at": "2026-06-07T00:00:00.000Z",
    "mode": "llm_rerank",
    "suggestions": []
  }
}
```

缓存策略:

- section note hash 未变化时, 不重复 rerank。
- cheap scan 可短 TTL 缓存。
- LLM rerank 长 TTL 缓存。
- 用户手动修改 note 后 hash 变化, 允许重新建议。

## Knowledge Consolidation Skill

新增 skill: `knowledge-consolidation`。

触发:

- 整篇论文读完。
- 用户说“总结这篇并沉淀到知识库”。
- 用户授权“整理这篇和之前论文的关系”。
- cron/maintenance 任务。

职责:

- 读取当前论文 note 的摘要和 section notes。
- 查询 knowledge graph 中相关节点和边。
- 读取少量候选 note section。
- 运行 LLM/sub-agent 生成 pending links。
- 向主 agent 返回候选关系列表和推荐操作。

约束:

- 默认写 pending links, 不直接写正式 links。
- 如果要直接写正式 links, 需要用户提前授权或置信度策略明确允许。
- sub-agent 输入必须是 note 摘要和候选 snippets, 不读取所有 notes。

## 渐进式暴露流程示例

### 推荐下一篇论文

1. agent 调 `kg_search_nodes` 找最近读过或 adopt 的节点。
2. agent 对候选节点调 `kg_neighbors(limit=5)`。
3. 如果某条边看起来重要, 调 `kg_get_link` 获取完整 reason/evidence。
4. 如需细节, 再通过 `note_path` 调 `read_note` 或未来的 `read_note_section`。
5. 给出推荐。

### 用户问“这篇和我之前读的有什么关系?”

1. `kg_get_node(current_id)`。
2. `kg_neighbors(current_id, limit=10)`。
3. 对最相关的 1-3 条边调 `kg_get_link`。
4. 必要时读 evidence 指向的 note section。

### 精读过程中沉淀关系

1. 主 agent 带用户读 section。
2. 用户说“这和之前那篇失败恢复 harness 很像/互补”。
3. agent 用 `kg_search_nodes` 找目标论文。
4. agent 提议一条 link。
5. 用户确认后 `kg_upsert_link`。

## 与现有模块边界

- `output/profile.md`
  - 继续作为用户兴趣和阅读偏好的自然语言摘要。
  - 不承担论文间关系图功能。

- Markdown notes
  - 保持单篇论文细节。
  - 是 evidence 的下钻目标。

- `reader-state/*.json`
  - 保持单篇论文阅读进度和 section 原文。
  - 不参与全局跨论文关系。

- `knowledge-index.json`
  - 只保存节点和边。
  - 用于导航、推荐、解释和关系查询。

## 实现阶段

### Phase 1: Store + Read Tools

- 新增 `KnowledgeGraphStore`:
  - load/save
  - validate schema
  - atomic write + backup
  - upsert node/link
  - neighbor/search query helpers
- 新增读取工具:
  - `kg_get_node`
  - `kg_neighbors`
  - `kg_get_link`
  - `kg_search_nodes`
  - `kg_search_links`
- 测试:
  - 空 index 初始化
  - 邻居查询限量
  - 搜索不返回 note 全文
  - path guard: 只读写 `output/knowledge-index.json`

### Phase 2: Write Tools

- 新增写入工具:
  - `kg_upsert_node`
  - `kg_upsert_link`
  - `kg_update_link`
  - `kg_delete_link`
- 写入工具需要 confirmation 或明确用户意图。
- 所有写入创建 backup。
- 测试:
  - upsert 幂等
  - 删除只删除 link 不删 note
  - invalid node/link 被拒绝

### Phase 3: Reader Integration

- `read_paper` 成功后注册 node。
- `record_paper_section_note` 后更新 node timestamp/status。
- 完成整篇阅读后更新 verdict/status。
- 不自动创建 links。

### Phase 4: Recommendation Integration

- 推荐论文前优先使用:
  - `kg_search_nodes`
  - `kg_neighbors`
  - `kg_search_links`
- 没有足够图谱信号时 fallback 到 `profile.md` 和 notes。
- 让推荐理由优先引用 link reason/evidence。

### Phase 5: Relationship Suggestion

- 新增只读/候选工具或 agent prompt 流程:
  - 从当前 section/note 和已有 graph 里提出候选 links。
  - 不直接写入, 先让用户确认。

## 验收标准

- agent 不会把完整 `knowledge-index.json` 放入主上下文。
- 能查询某个节点的一跳邻居。
- 能读取某条边的完整解释。
- 能通过 node 的 `note_path` 下钻到 Markdown note。
- 写入关系需要明确用户意图。
- `read_paper` 能注册 node。
- `record_paper_section_note` 能更新 node 状态, 但不会自动污染 links。
- 推荐流程能基于 graph links 给出可解释推荐。
