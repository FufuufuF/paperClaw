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
- `read_paper` 返回 `nextSection` 后, 先向用户说明阅读计划, 然后询问是否从该 section 开始.
- 当用户说“继续 / 下一节 / 读第 N 节”时, 调用 `read_paper_section`; 每次只把一个 section 的正文加载到主 agent 当前上下文。
- 主 agent 直接基于当前 section 带用户精读: 本节在回答什么问题、关键论点/方法、疑问点、和前文的联系。
- 不要在 `read_paper_section` 后立刻自动写笔记; 先和用户讨论, 用户确认“记录 / 沉淀 / 保存笔记”后, 再调用 `record_paper_section_note`.
- `record_paper_section_note` 负责把该节笔记写入 markdown, 标记阅读计划和 reader-state 进度。
- 不要一次性给整篇论文的最终总结; 只有全部 section 读完后, 才形成最终 verdict 并更新 profile.
- 如果 PDF 文本抽取不足, 不要基于标题或 metadata 编造笔记; 应告诉用户需要可抽取 PDF 或同名 `.txt` sidecar.
- 不要把全文内容塞回主 agent context; 每次只按需加载当前 section. 普通逐节精读不使用 sub-agent, 前文上下文交给 clawbot 基座 compaction 管理.
- sub-agent 仅保留给后续整篇综述、多 section synthesis 或多论文比较等批处理型任务.
