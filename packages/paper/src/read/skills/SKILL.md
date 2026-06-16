---
description: 引导用户逐节精读论文并增量沉淀笔记
always: true
---

# Paper Read Skill

当用户表达以下意图时, 使用 `read_paper` tool 启动 guided reading:

- 帮我读这篇论文
- 精读第 N 篇
- 总结某个 arXiv id / PDF

## 使用策略

- 只有用户明确要求“精读 / 阅读 PDF / 总结这篇论文 / 生成笔记”时, 才调用 `read_paper`.
- 如果用户只说“找第 N 篇 / 推荐第 N 篇”, 不要自动精读; 先询问是否下载或精读.
- 如果用户明确说“精读第 N 篇”, 优先引用最近一次 `paper_search` 返回的 shortlist.
- `read_paper` 只负责创建阅读计划和笔记骨架, 不代表已经读完整篇论文.
- `read_paper` 返回 `nextSection` 后, 如果用户原话已经是在要求“读 / 精读 / 继续读 / 带我读”, 立刻调用 `read_paper_section` 加载第一节并开始讲解；不要只展示 reading plan 后问“要不要继续”。
- 只有用户明确只是想“创建笔记 / 建阅读计划 / 准备一下”时, 才在 `read_paper` 后停下来询问是否开始第一个 section。
- 当用户说“继续 / 下一节 / 读第 N 节”时, 调用 `read_paper_section`; 每次只把一个 section 的正文加载到主 agent 当前上下文。
- 每次 `read_paper_section` 返回后, 在回答用户之前必须调用 `preview_section_relations` 查询当前 section 和旧论文的关联；默认 `maxResults=3`。
- 主 agent 直接基于当前 section 带用户精读, 但默认不是生成完整 section 报告, 而是带用户逐步读懂。
- 进入一个 section 后, 先用一句话定位这一节在回答什么问题, 再把该 section 拆成 2-4 个小块。
- 每轮只讲当前小块。优先使用 `read_paper_section` 返回的 `teaching.firstBlock`; 不要一次性讲完整节, 不要把所有论点、实验、相关工作和结论一次铺开。
- 当前小块的解释应包括: 它在说什么、为什么重要、和前文/用户目标有什么关系。必要时给一个具体例子。
- 每轮结尾必须停下来给用户选择, 例如“理解这部分后我再带你看下一小块”, “要不要我用一个 tool-call failure 例子再讲一遍”, 或“要不要把这一小块保存成 section note”。
- 不要在 `read_paper_section` 后立刻自动写笔记; 先和用户讨论, 用户在最近一条消息中明确说“记录 / 沉淀 / 保存笔记 / 写入 note”后, 再调用 `record_paper_section_note`.
- 用户回答理解检查的选项, 或说“继续 / 下一块 / 下一节 / 再讲一个例子”, 都不是保存确认, 不得调用 `record_paper_section_note`.
- `record_paper_section_note` 负责把该节笔记写入 markdown, 标记阅读计划和 reader-state 进度。
- 不要一次性给整篇论文的最终总结; 只有全部 section 读完后, 才形成最终 verdict 并更新 profile.
- 如果 PDF 文本抽取不足, 不要基于标题或 metadata 编造笔记; 应告诉用户需要可抽取 PDF 或同名 `.txt` sidecar.
- 不要把全文内容塞回主 agent context; 每次只按需加载当前 section. 普通逐节精读不使用 sub-agent, 前文上下文交给 clawbot 基座 compaction 管理.
- sub-agent 仅保留给后续整篇综述、多 section synthesis 或多论文比较等批处理型任务.

## Section 讲解节奏

- 不要默认输出“概述 / 关键点 / 相关论文 / 小结”这种完整报告结构。
- 不要默认生成 Markdown 表格或长 bibliography。
- 不要只输出 section 标题、短引用和几条定义 bullet；那不是教学。
- 一次讲解应包含足够的教学密度: 先用白话翻译, 再解释为什么作者要这样说, 再给一个具体例子或 mental model, 最后指出一个容易误解的点。
- 讲解可以短, 但不能浅。默认至少用 4 个短段落来完成一个小块的教学闭环。
- 如果当前 section 有 knowledge graph 关联, 一轮最多引用 1-3 篇旧论文。
- 关联论文必须服务于当前小块的理解, 作为类比、证据或反例自然嵌入正文；不要机械列出所有 related papers。
- 一轮最多推进一个阅读小块。用户说“继续”后, 再讲下一个小块。

## 关联旧论文的方式

- 关联旧论文不是“附录”; 它必须帮助用户理解当前小块。
- 如果 `preview_section_relations` 返回结果, 只选最能解释当前小块的 1-2 篇。
- 关联表达应该像这样自然嵌入: “这里可以借 API-Bank 理解: 它把 malformed arguments 做成 benchmark case, 所以这节说的 schema validation 不是抽象洁癖, 而是在覆盖真实评测里的常见失败。”
- 如果关联结果不贴合当前小块, 明确忽略它, 不要硬讲。
