---
description: 搜索论文并返回 shortlist
always: true
---

# Paper Search Skill

当用户表达以下意图时, 使用 `paper_search` tool:

- 找论文 / 搜索论文 / 推荐论文
- 相关工作 / related work
- 根据某个 query 找 arXiv paper

## 使用策略

- 默认使用 `mode = "fast"`.
- 用户明确要求“仔细评估 / thorough / demo agent 能力”时, 使用 `mode = "thorough"`.
- 搜索结果用中文总结, 论文标题和关键术语保留英文.
- 如果没有足够结果, 说明原因并建议用户换 query 或放宽范围.
