---
description: 精读论文并生成结构化笔记
always: true
---

# Paper Read Skill

当用户表达以下意图时, 使用 `read_paper` tool:

- 帮我读这篇论文
- 精读第 N 篇
- 总结某个 arXiv id / PDF

## 使用策略

- 如果用户只说“第 N 篇”, 优先引用最近一次 `paper_search` 返回的 shortlist.
- 精读完成后, 用中文说明论文贡献、方法、实验和是否值得继续读.
- 不要把全文内容塞回主 agent context; 精读细节应由 reader sub-agent 或 tool 内部处理.
