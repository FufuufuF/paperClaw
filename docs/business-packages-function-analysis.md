# paperClaw 业务包功能分析

本文基于当前代码阅读结果，分析三个业务包提供的功能：

- `packages/search`
- `packages/reader`
- `packages/knowledge`

这三个包共同组成 paperClaw 的论文业务闭环：先搜索和下载论文，再逐节精读并写入笔记，最后把已读论文沉淀为可查询的轻量知识图谱。

## 总体关系

| 包 | 业务定位 | 主要产物 | 主要面向对象 |
|---|---|---|---|
| `@paperclaw/search` | 论文发现与下载 | shortlist、PDF 文件、搜索 trace | 用户的检索意图、arXiv、profile |
| `@paperclaw/reader` | 本地论文精读与笔记维护 | Markdown note、reader state、profile 更新 | 本地 PDF、用户逐节阅读流程 |
| `@paperclaw/knowledge` | 论文长期关系索引 | `knowledge-index.json` | 已读论文节点、论文关系、待确认关系 |

在 CLI 入口中，这三个包的工具和 skill 目录都会注册到 agent 基座：

- `createPaperSearchTools()` 注册 `paper_search`、`download_paper`。
- `createReaderTools()` 注册 guided reading 相关工具。
- `createPaperFileTools()` 注册 note/profile 文件维护工具。
- `createKnowledgeGraphTools()` 注册知识图谱查询和写入工具。
- 三个包分别暴露 `PAPER_SEARCH_SKILLS_DIR`、`PAPER_READ_SKILLS_DIR`、`KNOWLEDGE_SKILLS_DIR`，用于把业务策略注入 agent 上下文。

## `packages/search`

### 业务职责

`@paperclaw/search` 负责把用户的自然语言检索需求转成可执行的 arXiv 检索流程，并把原始候选论文加工成适合用户阅读决策的 shortlist。它不负责阅读论文正文，也不会在搜索后自动下载或精读，下载必须由用户明确触发。

核心能力包括：

- 将自然语言 query 拆成 1 到 4 个 arXiv 检索词。
- 调用 arXiv Atom API 获取候选论文。
- 过滤已读论文和显式排除的 arXiv id。
- 对每篇候选论文进行 LLM triage，给出 `recommend` / `maybe` / `skip`。
- 生成排序后的 shortlist，包含标题、作者、年份、arXiv id、推荐理由、中文摘要和 PDF URL。
- 在 `thorough` 模式下根据第一轮 triage 结果决定是否补充检索词并二次搜索。
- 支持 cron 推荐模式的兴趣推断入口。
- 保存每个 session 最近一次 shortlist，使用户可以说“下载第 1、3 篇”。
- 下载用户指定的 arXiv PDF 到 `output/pdfs/`。

### 对外导出

`packages/search/src/index.ts` 暴露了以下主要能力：

- `searchArxiv()`：底层 arXiv 搜索。
- `triageBatch()`：批量 LLM 论文筛选。
- `downloadPdf()` / `downloadPdfs()`：PDF 下载。
- `decomposeQuery()` / `decideReplan()` / `inferInterestForCron()`：搜索规划与 cron 兴趣推断。
- `createPaperSearchTools()`：一次性创建搜索和下载工具。
- `PaperSearchState`：保存 session 级 shortlist handoff 状态。

### Tool 功能

#### `paper_search`

只读工具，用于搜索论文并返回 shortlist。

输入参数：

- `query`：自然语言检索需求。非 cron 模式必填。
- `mode`：`fast`、`thorough` 或 `cron`，默认 `fast`。
- `maxResults`：每个检索词最多返回多少候选。
- `excludeArxivIds`：额外排除的 arXiv id。

执行流程：

1. 读取 `profile.md`，拿到已读论文 slug。
2. 使用 LLM 将 query 拆解为 arXiv 检索词。
3. 对每个检索词调用 arXiv API。
4. 去重，过滤已读和排除项。
5. 对候选论文逐篇调用 LLM triage。
6. `thorough` 模式下可能触发 replan 并补检索。
7. 将结果排序并截断为最多 12 条 shortlist。
8. 将 shortlist 保存到 `PaperSearchState`，供下载工具通过编号引用。

返回结果包含：

- `shortlist`
- `trace`
- `profile.path`
- `profile.readCount`
- `profile.personalization`

`personalization` 根据已读数量粗分为：

- `cold`：已读少于 3 篇。
- `weak`：已读至少 3 篇。
- `full`：已读至少 8 篇。

#### `download_paper`

写工具，用于下载 PDF，带确认元数据。

输入参数：

- `arxivIds`：显式 arXiv id 列表。
- `indices`：最近一次 `paper_search` shortlist 的 1-based 编号。

执行流程：

1. 将编号映射为最近 shortlist 中的 arXiv id。
2. 与显式 id 合并去重。
3. 下载到 `output/pdfs/<arxiv_id>.pdf`，旧式 id 中的 `/` 会转为 `_`。
4. 已存在且非空的 PDF 视为缓存命中。
5. 多篇 PDF 顺序下载，避免对 arXiv 并发过高。

### 实现特点

- arXiv 搜索使用 `fast-xml-parser` 解析 Atom feed。
- 网络请求使用 `withRetry()`，对 5xx 和 429 做退避重试。
- triage 使用 `mapWithConcurrency()` 并发调用 LLM，默认并发为 8。
- 单篇 triage 失败不会中断整批搜索，而是返回 `skip` 并把错误写入 trace。
- `thorough` 模式有最多一轮补检索逻辑，避免无限循环。
- 搜索工具是只读的；下载工具是写工具且 `exclusive: true`。

### 当前边界

- 页数、篇幅、PDF 质量等判断主要依赖 title/abstract 和 LLM，暂未做 PDF 长度检测。
- arXiv API 是唯一论文来源。
- shortlist 是进程内 session 状态，不是长期持久化数据。
- cron 兴趣推断函数已存在，但 `paper_search` 的 cron 分支本身不读取 `knowledge-index.json`；CLI cron 层会先通过 knowledge tools 构造基于知识图谱的 query，再调用 `paper_search`。

## `packages/reader`

### 业务职责

`@paperclaw/reader` 负责本地论文 PDF 的 guided reading。它的设计重点不是一次性总结整篇论文，而是把 PDF 文本抽取后切成章节，让主 agent 一次只加载一个 section，和用户讨论后再由用户确认写入笔记。

核心能力包括：

- 从本地 PDF 或 `output/pdfs/<arxivId>.pdf` 启动精读。
- 抽取 PDF 文本，优先使用同名 `.txt` sidecar，其次 `pdftotext`，最后才使用粗糙 ASCII fallback。
- 判断抽取质量，不足时拒绝生成笔记。
- 从论文文本中推断标题并切分章节。
- 创建 guided reading Markdown 笔记骨架。
- 创建 reader-state JSON，记录章节、阅读进度和完成状态。
- 一次加载一个 section 的正文给主 agent。
- 用户确认后写入该 section 的笔记，标记阅读进度。
- 全部 section 完成后更新 `profile.md` 和 knowledge node。
- 提供独立 note/profile 文件工具，支持列表、读取、创建、编辑、追加、重命名。

### 对外导出

`packages/reader/src/index.ts` 暴露了以下主要能力：

- `createReaderTools()`：创建 guided reading 三个工具。
- `createPaperFileTools()`：创建 note/profile 文件工具。
- `readPaper()` / `readPaperSection()` / `recordPaperSectionNote()`：工具背后的业务函数。
- `extractPdfText()`：PDF 文本抽取。
- `updateProfileFromNote()`：从已完成 note 更新 profile。

### Guided Reading 工具

#### `read_paper`

写工具，用于启动 guided reading，带确认元数据。

输入参数：

- `pdfPath`：本地 PDF 路径。
- `arxivId`：解析为 `output/pdfs/<arxivId>.pdf`。
- `slug`：可选 note slug。

执行流程：

1. 解析并校验 PDF 路径，只允许 workspace 或 output 目录内的 PDF。
2. 抽取最多 160,000 字符的 PDF 文本。
3. 如果文本抽取不足，抛出明确错误，要求可抽取 PDF 或同名 `.txt` sidecar。
4. 生成 slug 和论文 title。
5. 切分 section，每个 section 最多约 14,000 字符，过长会拆成 part。
6. 写入 `output/<runId>/papers/<slug>.md`。
7. 写入 `output/<runId>/reader-state/<slug>.json`。
8. 在 `knowledge-index.json` 中注册或更新论文节点，状态为 `reading`，verdict 默认为 `maybe`。
9. 返回阅读计划和下一节，但不返回 PDF 全文。

返回中的 `isolation.pdfTextPersistedToMainSession` 固定为 `false`，体现它不会把全文持久塞进主会话。

#### `read_paper_section`

只读工具，用于加载一个 section。

输入参数：

- `statePath`
- `notePath`
- `slug`
- `sectionIndex`

解析优先级：

1. 直接使用 `statePath`。
2. 从 note 中的 `reading_state:` 行解析。
3. 根据 slug 在 output 下寻找最新 reader-state。

返回内容：

- 当前 section 的标题、序号、字符数、状态和正文。
- 前一节和下一节的轻量信息。
- `noteInstruction`，提示主 agent 讨论后再调用写笔记工具。

该工具不会写 note，不会更新状态，也不会调用 LLM。

#### `record_paper_section_note`

写工具，用于保存当前 section 的笔记并推进阅读进度，带确认元数据。

输入参数：

- `statePath` / `notePath` / `slug`
- `sectionIndex`
- `note`

执行流程：

1. 加载 reader-state。
2. 选择指定 section，或默认选择第一个 pending section。
3. 将 section 标记为 `done`。
4. 将笔记插入 Markdown 的 `## Section Notes` 下，标题格式为 `### <index>. <title>`。
5. 更新 `## Reading Plan` 中对应 checkbox。
6. 如果全部 section 完成，将 note 状态改为 completed，并把 `## Verdict` 改成默认 `maybe` 完成提示。
7. 全部完成时调用 `updateProfileFromNote()` 更新 `output/profile.md`。
8. 更新 knowledge node：未完成为 `reading`，完成为 `read`；完成时还会写入 `summary_short`。

### 文件工具

`createPaperFileTools()` 提供一组 Markdown 文件维护工具：

- `list_notes`：列出 `output/**/papers/*.md`。
- `read_note`：按 path 或 slug 读取 note，slug 重名时读取最新修改的。
- `create_note`：创建 `output/<runId>/papers/<slug>.md`。
- `edit_note_section`：替换或创建指定 Markdown section。
- `append_note_section`：追加到指定 Markdown section。
- `update_profile_section`：更新 `output/profile.md` 的指定 section。
- `rename_note_slug`：重命名 note slug，更新 `slug:` 行，并同步重命名 knowledge graph node。

这些写工具都带确认元数据。文件访问通过 `WorkspaceGuard` 限制在 output 范围内，测试覆盖了路径穿越和 symlink escape 场景。

### 实现特点

- PDF 抽取优先级是 sidecar `.txt` > `pdftotext` > ASCII fallback。
- 对 sidecar、pdftotext、ASCII fallback 使用不同最低质量阈值。
- section heading 识别支持常见无编号标题和数字编号标题。
- references / bibliography 之后不再继续切分为正文 section。
- profile 更新只维护一个基础的 `已读索引`，并补齐 `用户兴趣推断`、`待问用户` section。
- reader 与 knowledge 直接集成：启动阅读和记录章节时都会 upsert knowledge node。

### 当前边界

- `ReaderToolOpts` 要求传入 `llm`，但当前 guided reading 工具本身不会调用 LLM；精读解释由主 agent 基于 section 文本完成。
- profile 更新逻辑较轻量，只维护已读索引和基础结构，不做深度兴趣建模。
- 最终 verdict 通过 note 文本中是否包含 `adopt` / `skip` / `maybe` 的简单规则抽取。
- 扫描版 PDF 或文本层质量很差的 PDF 需要 OCR 或同名 `.txt` sidecar。
- 多 section synthesis、多论文比较和 sub-agent 批处理还没有在当前工具中实现。

## `packages/knowledge`

### 业务职责

`@paperclaw/knowledge` 负责维护轻量论文知识图谱。它不保存论文全文，而是保存论文节点、论文间关系、开放问题和待用户确认的关系候选。详细内容仍保存在 Markdown note 中，knowledge index 只提供导航、关系和证据指针。

核心能力包括：

- 初始化、读取、规范化 `output/knowledge-index.json`。
- 创建或更新论文节点。
- 查询论文节点、最近节点、节点邻居。
- 创建、查询、更新、删除正式关系。
- 创建、列出、提交、拒绝 pending relation。
- 基于当前 section summary 和已有 note 片段做 cheap relation suggestion。
- 可选使用 LLM 对关系候选 rerank。
- note 重命名时同步更新 node id、link source/target 和 evidence。

### 数据模型

`KnowledgeIndex` 的结构为：

- `version`
- `updated_at`
- `papers`
- `links`
- `open_questions`
- `pending_links`

论文节点 `KnowledgePaperNode` 包含：

- `id`
- `title`
- `summary_short`
- `note_path`
- `arxiv_id`
- `status`：`unread`、`reading`、`read`、`skipped`
- `verdict`：`adopt`、`maybe`、`skip`、`unknown`
- `updated_at`

关系 `KnowledgeLink` 包含：

- `source`
- `target`
- `type`
- `directional`
- `reason_short`
- `reason`
- `evidence`
- `confidence`
- `created_by`
- `created_at`
- `updated_at`

支持的 relation type：

- `extends`
- `contrasts`
- `supports`
- `challenges`
- `complements`
- `uses_same`
- `applies_to`
- `precedes`
- `replaces`

### 对外导出

`packages/knowledge/src/index.ts` 暴露了以下主要能力：

- `KnowledgeGraphStore`
- `createKnowledgeGraphTools()`
- 全套 knowledge 类型定义。
- `KNOWLEDGE_SKILLS_DIR`

### Store 功能

`KnowledgeGraphStore` 是该包的核心。它基于 `outputDir` 工作，默认索引路径为 `output/knowledge-index.json`。

主要方法：

- `load()`：读取并规范化索引；文件不存在时返回空索引。
- `save()`：原子写入 JSON，默认写入前生成备份。
- `getNode()` / `searchNodes()` / `recentNodes()`：节点查询。
- `neighbors()`：一跳邻居查询。
- `getLink()` / `searchLinks()`：关系查询。
- `upsertNode()`：创建或更新节点。
- `upsertLink()` / `updateLink()` / `deleteLink()`：正式关系写入和维护。
- `renameNode()`：节点重命名并同步所有关系和证据引用。
- `createPendingLink()` / `listPendingLinks()` / `commitPendingLink()` / `rejectPendingLink()`：关系候选 review 流程。
- `suggestLinks()`：基于当前阅读内容和已有节点/笔记片段建议关系候选。

### Tool 功能

只读工具：

- `kg_get_node`
- `kg_recent_nodes`
- `kg_neighbors`
- `kg_get_link`
- `kg_search_nodes`
- `kg_search_links`
- `kg_suggest_links`
- `kg_list_pending_links`

写工具：

- `kg_upsert_node`
- `kg_upsert_link`
- `kg_update_link`
- `kg_delete_link`
- `kg_create_pending_link`
- `kg_commit_pending_link`
- `kg_reject_pending_link`

所有写工具都具有：

- `readOnly: false`
- `concurrencySafe: false`
- `exclusive: true`
- confirmation 元数据

这意味着 agent 必须在明确用户意图或固定自动触发点下写入知识图谱。

### 关系建议机制

`kg_suggest_links` 是只读候选工具，不会直接写入图谱。

执行逻辑：

1. 确认 source node 存在。
2. 将 `section_title`、`section_summary`、`query_hints` 合成检索提示。
3. 遍历已有论文节点，跳过 source、自身、`skipped` 节点和已有关系 pair。
4. 读取目标 note 的前 3,000 字符作为内部打分材料，但不会返回 note 片段。
5. 用 token 命中规则生成分数和 confidence。
6. 基于文本中的关键词推断 relation type。
7. 给出 `recommended_action`：`create_pending`、`mention_only` 或 `skip`。
8. 如果 mode 为 `rerank` 且传入 LLM，则允许 LLM 在候选集合内重排和修正类型/理由/置信度。

该设计符合“渐进式读取”：先查关系和摘要，只有需要细节时再用 reader 的 `read_note` 打开具体 Markdown。

### 实现特点

- `knowledge-index.json` 不存在时自动初始化。
- 保存时使用临时文件 + rename 做原子写入。
- 默认为已有索引写 `.bak.<timestamp>` 备份。
- id 会被清洗，限制为字母、数字、点、下划线、冒号、短横线等字符。
- note path 解析被限制在 output 范围内，避免索引引用越界文件。
- `contrasts`、`complements`、`uses_same` 默认视为非方向关系，其他关系默认有方向。
- pending link commit 后不会删除 pending 项，而是标记为 `committed`，保留审计轨迹。

### 当前边界

- 它是轻量 JSON 索引，不是图数据库。
- `suggestLinks()` 的 cheap 模式是启发式 token 匹配，不是语义向量检索。
- open questions 数据结构存在，但当前工具集中没有专门维护 open questions 的工具。
- 正式关系不会由 reader 自动创建；自动发现的关系应先进入 pending link。

## 三包协同流程

一个完整业务链路如下：

1. 用户提出检索需求。
2. `paper_search` 拆 query、查 arXiv、triage，返回 shortlist。
3. 用户明确要求下载某几篇。
4. `download_paper` 将 PDF 保存到 `output/pdfs/`。
5. 用户明确要求精读。
6. `read_paper` 抽取 PDF 文本，创建 note 和 reader-state，同时注册 knowledge node。
7. 用户说继续读某节。
8. `read_paper_section` 返回单个 section 正文。
9. 主 agent 和用户讨论该 section。
10. 用户确认保存笔记。
11. `record_paper_section_note` 写入 note，更新 reader-state，并更新 knowledge node。
12. 所有 section 完成后，reader 更新 profile，将 knowledge node 标为 `read` 并写入 `summary_short`。
13. 用户询问和旧论文的关系。
14. `kg_neighbors` / `kg_suggest_links` / `kg_search_nodes` 查询或建议关系。
15. 用户确认关系后，`kg_create_pending_link` 或 `kg_upsert_link` 写入长期知识索引。

## 设计取舍总结

这三个包体现了几个一致的业务设计：

- 搜索、下载、阅读、写知识库被拆为独立工具，由 agent 决策层组合。
- 搜索和关系查询偏只读，下载、写笔记、写图谱都需要显式确认。
- 长 PDF 不一次性进入主上下文，而是通过 reader-state 逐节加载。
- Markdown note 是单篇论文详情资产，knowledge index 只保存关系和导航信息。
- profile 提供用户长期阅读历史，search 用它过滤已读和粗略判断个性化强度。
- knowledge graph 支持“先建议、后确认、再提交”的关系沉淀流程。

当前代码已经形成可演示的最小闭环：`搜索 -> 下载 -> 精读 -> 写笔记 -> 更新 profile -> 更新知识图谱节点 -> 查询/沉淀论文关系`。后续增强重点主要在搜索质量、profile 深度建模、自动关系发现、pending relation review 体验和最终整篇综合总结。

## 三个自动化机制的支持情况

### search 是否支持解析 knowledge-index 自动推荐论文

部分支持，但支持点不在 `packages/search` 包内部。

`paper_search` 自身只读取 `profile.md`，用已读 slug 做过滤和个性化强度判断；它不会直接解析 `output/knowledge-index.json`。真正使用 knowledge index 的是 CLI cron 推荐层：`createPaperCronRunner()` 会调用 `kg_recent_nodes` 找最近已读论文，再调用 `kg_neighbors` 取其邻居关系，把这些信息拼成一个 cron query，然后以 `mode: "cron"` 调用 `paper_search`。

因此当前能力可以描述为：定时推荐路径支持基于 knowledge index 的轻量推荐上下文，但普通用户主动调用 `paper_search` 时没有自动读取 knowledge index。

### reader 是否在读完论文或用户触发时更新 knowledge-index

支持论文节点更新，但不自动写论文关系。

`read_paper` 启动 guided reading 时会自动 upsert knowledge node，状态为 `reading`。`record_paper_section_note` 每次记录章节笔记后都会再次 upsert node；如果所有 section 都完成，则把节点状态更新为 `read`，并写入 `summary_short`。同时 reader 会更新 `profile.md`。

但 reader 不会在读完一篇论文时自动创建正式 relation link。关系发现和写入属于 knowledge 工具能力：用户明确要求“把这两篇关系记下来”时，agent 可以调用 `kg_upsert_link`；如果是 agent 自己发现的候选关系，应该先调用 `kg_create_pending_link`，再由用户 review 后 `kg_commit_pending_link`。

### reader 是否在进入新 session 时自动检索 session 和 knowledge-index 的关联

不支持。

当前 session 流程由 `AgentLoop` 恢复 session、压缩历史、处理命令、构建 prompt、运行 agent。这个流程没有 session-start hook，也没有自动调用 `kg_search_nodes`、`kg_neighbors` 或 `kg_suggest_links` 的步骤。知识图谱 skill 会指导 agent 在用户询问关系、比较、关联旧论文时主动使用 knowledge tools，但这仍是由对话意图触发，不是每个新 session 自动触发。

如果要实现这个机制，需要新增一个显式的会话入口预检流程，例如在构建 prompt 前根据当前用户输入提取关键词，调用 `kg_search_nodes` 或 `kg_suggest_links`，再把结果作为 runtime context 注入本轮对话。
