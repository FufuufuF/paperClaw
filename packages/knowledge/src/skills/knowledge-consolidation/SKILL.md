---
description: 使用知识图谱按需查询论文关系, 并在精读后生成可确认的关系候选
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
- `record_paper_section_note` 沉淀章节笔记后会更新节点状态。
- 普通逐节精读不要自动写正式 relation link。
- 如果用户明确说“把这两篇的关系记下来 / 写入知识库”, 可以调用 `kg_upsert_link`。
- agent 自己发现的关系默认先调用 `kg_create_pending_link`, 等用户 review 后再 `kg_commit_pending_link`。

## 主动关系发现

- 用户问“这和以前读过的有什么关系 / 有什么不同 / 能不能比较”时, 先用 `kg_suggest_links` 或 `kg_neighbors`。
- 当前 section 属于 Method / Results / Limitations / Conclusion, 且已经沉淀 section note 后, 可以用 `kg_suggest_links` 做 cheap candidate scan。
- `kg_suggest_links` 是只读候选工具, 不会写入图谱。
- 不要每轮对话都做 LLM rerank 或 sub-agent consolidation。
- 整篇论文读完, 或用户要求“整理这篇和之前论文的关系”时, 再做低频 consolidation, 生成 pending links。

## 写入约束

- 写入工具包括 `kg_upsert_node`, `kg_upsert_link`, `kg_update_link`, `kg_delete_link`, `kg_create_pending_link`, `kg_commit_pending_link`, `kg_reject_pending_link`。
- 这些工具需要明确用户意图或固定自动触发点。
- 正式关系必须包含 relation type、reason_short 和 evidence pointer。
- 关系 evidence 指向 note path / section, 不粘贴大段正文。
