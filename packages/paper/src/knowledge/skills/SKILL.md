---
description: 使用 paper graph 按需查询论文关系, 并在精读完成后自动沉淀节点和关系
always: true
---

# Knowledge Consolidation Skill

paperClaw 的长期知识分两层:

- Markdown note 保存单篇论文的详细内容。
- `output/knowledge-index.json` 只保存论文节点和论文之间的关系。

## 渐进式读取

- 不要直接读取完整 `knowledge-index.json`。
- 查询某篇论文是否在知识库中, 使用 `kg_get_node`。
- 查询某篇论文和旧论文的关系, 使用 `kg_neighbors`。
- 需要解释某条关系时, 使用 `kg_get_link`。
- 搜索旧论文节点, 使用 `kg_search_nodes`。
- 搜索已有关系, 使用 `kg_search_links`。
- 只有需要单篇论文细节时, 再根据 `note_path` 调用 `read_note`。

## 精读时的图谱更新

- `read_paper` 启动 guided reading 后会自动注册论文节点, 不需要主 agent 再重复写节点。
- `record_paper_section_note` 沉淀章节笔记后会更新阅读进度；完整读完后会触发 consolidation，更新 `summary_short` / `key_terms` 并自动建边。
- 普通进入新 section 时只用 `preview_section_relations` 做只读关联预览，不写图谱。
- 如果用户明确说“把这两篇的关系记下来 / 写入知识库”, 可以调用 `kg_upsert_link`。
- 不再使用 pending link review 流程。

## 主动关系发现

- 用户问“这和以前读过的有什么关系 / 有什么不同 / 能不能比较”时, 先用 `preview_section_relations` 或 `kg_neighbors`。
- 当前进入一个新 section 时，可以用 `preview_section_relations` 做只读候选检索。
- `preview_section_relations` 是只读工具，不会写入节点或关系。
- 不要每轮对话都做 LLM rerank 或 sub-agent consolidation。
- 整篇论文读完, 或用户要求“整理这篇和之前论文的关系 / 总结入库 / 更新知识库”时, 再调用 `consolidate_paper`。

## 写入约束

- 写入工具包括 `kg_upsert_node`, `kg_upsert_link`, `kg_update_link`, `kg_delete_link`, `consolidate_paper`。
- 这些工具需要明确用户意图或固定自动触发点。
- 节点的 `key_terms` 必须来自闭合词表，每篇最多 5 个。
- 正式关系必须包含 `reason`、`shared_terms` 和 evidence pointer；不再写 `type`、`confidence` 或 `created_by`。
- 关系 evidence 指向 note path / section, 不粘贴大段正文。
