# AI-Maintained Knowledge Graph Plan

日期: 2026-06-08
分支: `feat/cron-profile-recommendations`
状态: 待 review, 暂不修改代码逻辑

## 背景

本轮决定调整知识图谱维护策略:

- 去掉 `pending_links` 机制。
- 知识图谱关系由 AI 直接维护正式 `links`。
- 用户不再 review / commit / reject 候选关系。
- 关系沉淀采用二元判断: 要么写入正式 `links`, 要么跳过; 不让 AI 输出置信度分数。
- 仍然保留可追溯 evidence, 避免关系变成无来源判断。

`pending_links` 不是本轮 cron 推荐改造才加入的机制。它最早出现在知识图谱设计文档中:

- `1fc4a4c` / 2026-06-07 21:17:14 +0800 / `docs: record paperclaw implementation plans`

随后在知识图谱工具落地时进入代码:

- `bcdf3c7` / 2026-06-07 21:17:40 +0800 / `feat: add knowledge graph tools`

本轮 `0ab0b27` 的 cron session 文档只是沿用了这个机制, 不是首次引入。

## 当前问题

`pending_links` 的原始目的, 是避免 agent 直接污染长期图谱。但现在产品方向已经调整为“知识图谱完全由 AI 维护”, 因此 pending 层会带来几个问题:

- 多了一套候选关系 schema, 增加 `knowledge-index.json` 复杂度。
- 多了一组 tool: `kg_create_pending_link`, `kg_list_pending_links`, `kg_commit_pending_link`, `kg_reject_pending_link`。
- 主流程需要区分“候选关系”和“正式关系”, 但用户并不想承担 review 关系的工作。
- cron / 推荐 / neighbors 只使用正式 `links`, pending 关系不会自然参与图谱推理。

所以第一原则应改成:

```text
AI 发现值得沉淀的论文关系时, 直接写入正式 links。
```

## 目标行为

### 整篇论文读完

当 guided reading 完成后:

1. 更新当前论文 node:
   - `status = read`
   - `verdict`
   - `summary_short`
   - `arxiv_id`
   - `note_path`
2. 触发一次低频 relation consolidation。
3. consolidation 查询相关旧节点和旧关系。
4. AI 判断哪些关系值得沉淀。
5. 直接写入正式 `links`。

写入条件建议:

- 必须有 `source`, `target`, `type`, `reason_short`。
- 必须有 evidence pointer, 至少指向当前论文 note。
- 如果能定位旧论文 note 或 section, evidence 也要指向旧论文。
- 不足以沉淀的关系直接跳过, 不写入 KG。

### 只读了一部分论文

如果用户只读了一部分, 不应自动大规模沉淀关系。但需要手动触发机制。

用户说类似:

```text
整理一下这篇和之前论文的关系。
把目前读到的内容沉淀到知识图谱。
这篇和之前读过的有什么联系, 直接记到 KG 里。
```

agent 应该能:

1. 根据当前 `slug` / `notePath` / `statePath` 找到当前论文 node。
2. 读取已沉淀的 section notes, 不读取整篇 PDF。
3. 调用关系 consolidation。
4. 直接写正式 `links`。
5. 返回本次新增或更新了哪些关系。

## P0 工作

### 1. 删除 pending schema

从 `KnowledgeIndex` 中移除:

- `pending_links`
- `KnowledgePendingLink`
- `PendingLinkStatus`

从 store 中移除:

- `PendingLinkInput`
- `createPendingLink`
- `listPendingLinks`
- `commitPendingLink`
- `rejectPendingLink`
- `parsePendingLink`
- `validatePendingLink`
- `parsePendingStatus`
- `renameNode` 中 pending link 重写逻辑

迁移策略:

- 读取旧 `knowledge-index.json` 时忽略 `pending_links`。
- 下一次保存时自然写出不含 `pending_links` 的新结构。
- 不自动把旧 pending 关系提升为正式 `links`, 因为旧 pending 本来就不是 authoritative KG。

### 2. 删除 pending tools

从 `createKnowledgeGraphTools()` 中移除:

- `kg_list_pending_links`
- `kg_create_pending_link`
- `kg_commit_pending_link`
- `kg_reject_pending_link`

保留正式关系写入工具:

- `kg_upsert_link`
- `kg_update_link`
- `kg_delete_link`

同时修改 tool 描述:

- `kg_upsert_link` 不再说 “confirmed pending relation”。
- `kg_suggest_links` 不再返回 `recommended_action = create_pending`。

### 3. 调整 relation suggestion 语义

`kg_suggest_links` 仍然可以保留为只读候选工具, 但它的输出语义应改成二元判断:

```ts
recommended_action: 'write' | 'skip'
```

含义:

- `write`: 证据足够, consolidation 可以直接写正式 link。
- `skip`: 不足以沉淀, 不写 KG。

不再保留 `mention_only`, 因为这个概念属于对话回答, 不属于 KG 写入决策。

### 4. 移除 AI 置信度语义

AI 输出 `confidence` 数值没有可靠校准意义, 第一版不要让 AI 为关系打分。

需要调整:

- 从 `KnowledgeLink` / link tool schema 中移除 `confidence`。
- `KnowledgeLinkSuggestion` 不再包含 `confidence`。
- `KnowledgeNeighbor` 不再返回 `confidence`。
- `kg_neighbors` 不再按 `confidence` 排序, 改用 `updated_at`、关系类型优先级或稳定的 id 顺序。
- consolidation 结果只区分 `written` / `skipped`。
- skipped item 需要给 `reason`, 用于调试为什么没有写入。

### 5. 新增直接维护关系的 consolidation 入口

需要一个明确入口来替代 pending 流程。建议新增 tool:

```text
kg_consolidate_links
```

职责:

- 输入当前论文 id / notePath / section 范围。
- 搜索已有 KG nodes / links。
- 读取必要 note snippets。
- 生成候选关系。
- 直接 `upsertLink` 到正式 `links`。
- 返回 `created`, `updated`, `skipped` 列表。

建议输入:

```json
{
  "source": "2401.07324",
  "scope": "completed_paper",
  "section_titles": ["Method", "Limitations"],
  "limit": 5
}
```

`scope` 可选:

- `completed_paper`: 整篇读完后自动触发。
- `recorded_sections`: 用户只读部分论文时手动触发。
- `manual`: 用户明确要求整理关系。

### 6. 读完整篇论文后自动写 links

在 `record_paper_section_note` 完成最后一个 section 后:

1. 继续更新 node 和 `summary_short`。
2. 调用 consolidation。
3. 直接写正式 `links`。

第一版限制:

- 最多写 5 条关系。
- 只写 AI 二元判断为 `write` 的关系。
- source 必须是当前论文。
- 不写 source=旧论文、target=旧论文 的第三方关系。

### 7. arXiv id 稳定写入

当前只有 `read_paper({ arxivId })` 能稳定写入 `arxiv_id`。如果用户用 `pdfPath` 读本地 PDF, 即使文件名是 `2401.07324.pdf`, 也不会自动推断。

需要补齐:

- 从 `input.arxivId` 优先取。
- 否则从 PDF 文件名推断:
  - `2401.07324.pdf`
  - `2401.07324v2.pdf`
  - `cs_0506075.pdf` / `cs/0506075` 的 legacy id 映射需要谨慎处理。
- 否则从 slug 推断。
- 写入 KG node 的 `arxiv_id`。
- `knowledgeNode` 返回值也带上 `arxivId`, 方便 agent 后续引用。

## P1 工作

### 1. open questions tools

当前 schema 有 `open_questions`, 但没有完整 tool 层能力。

建议新增:

- `kg_create_open_question`
- `kg_search_open_questions`
- `kg_update_open_question`
- `kg_close_open_question`

用途:

- 读论文时沉淀研究缺口。
- cron 推荐时用 open questions 生成 query。
- 用户问“现在还有哪些问题没解决”时可直接查询。

### 2. 半读论文的进度查询

当前 agent 可以通过:

```json
kg_search_nodes({ "status": ["reading"] })
```

找到“读了一半”的论文, 但它只能返回 node 元数据。若用户问“读到第几节”, 需要再读 note 或 reader-state。

建议新增轻量 tool:

```text
read_paper_progress
```

返回:

- slug
- title
- completed sections
- total sections
- next section
- notePath
- statePath

这不阻塞 P0, 但会让“有哪些论文读了一半”这个体验更完整。

### 3. relation quality audit

既然去掉用户 review, 需要补一点自动质量控制:

- link 必须有 evidence。
- link reason_short 不能太空泛。
- 同一 source-target-type 走 upsert, 避免重复边。
- consolidation 返回 skipped reason, 便于调试。
- 测试覆盖 AI 判断为 `skip` 的候选不会写入正式 links。

## 需要修改的文件

核心代码:

- `packages/core/src/knowledge/types.ts`
- `packages/core/src/knowledge/graph-store.ts`
- `packages/core/src/agent/tools/knowledge-tools.ts`
- `packages/core/src/skills/knowledge-consolidation/SKILL.md`
- `packages/reader/src/read-paper-tool.ts`

测试:

- `tests/knowledge/graph-store.test.ts`
- `tests/reader/read-paper-tool.test.ts`
- 可能新增 `tests/knowledge/consolidate-links.test.ts`

文档:

- `README.md`
- `docs/session-knowledge-graph-index-plan.md`
- `docs/session-cron-profile-recommendation-plan.md`

## 验证计划

基础验证:

```bash
pnpm typecheck
pnpm test:knowledge
pnpm test:reader
pnpm test:cron
pnpm test
```

E2E 验证:

1. 清理测试用 `output/`。
2. 准备两篇已有 KG 论文节点和 note。
3. 读完一篇新论文。
4. 验证 `knowledge-index.json`:
   - 没有 `pending_links`。
   - 新论文 node 有 `summary_short` 和稳定 `arxiv_id`。
   - 新增正式 `links`。
   - `links[].evidence` 指向 note。
5. 跑 `/cron run`, 验证推荐仍基于正式 links / summary_short。

## 暂不做

- 不做图内论文推荐。
- 不恢复 `profile.md` 相关长期记忆设计。
- 不把每个 section 后都自动写关系。
- 不让 consolidation 读取所有 notes。
- 不引入复杂 tags schema。

## 已确认决策

- 去掉 pending 后, 不保留 `mention_only` 这种 KG 写入动作。
- 读完整篇论文后自动写正式 links 的默认上限暂定 5 条。
- 不使用 AI 输出的 `confidence` 数值, 改成 `write` / `skip` 二元判断。
- 旧 `pending_links` 数据直接丢弃, 不迁移为正式 `links`。
