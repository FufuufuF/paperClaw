# paperClaw 端到端测试计划与结果

日期: 2026-06-07

## 目标

通过真实 CLI agent 流程验证 paperClaw 的用户侧能力，而不是只依赖单元测试。

本轮重点验证三类能力:

1. 论文检索逻辑: agent 是否能根据 query 召回相关且质量较高的论文。
2. 论文精读: agent 是否能带用户逐节阅读短论文、回答追问，并沉淀阅读笔记。
3. 自动论文检索/推荐: agent 是否能基于已有论文笔记推荐下一步值得读的论文。

## 测试方法

- 单独启动一个 `pnpm chat` 进程。
- 通过 stdin/stdout 与 clawbot CLI 交互。
- 记录输入、工具调用、agent 回复、生成文件和通过/失败原因。
- 如果某个流程依赖真实 LLM/API/network，则记录实际环境结果，不把环境失败伪装成功能通过。
- 与 paperClaw 交互全程使用中文，方便 review。

## 测试用例

### T1: 论文检索质量

输入:

```text
帮我检索几篇篇幅较短、和 LLM agent tool use / tool learning 相关的论文，优先 arXiv，并说明为什么推荐。
```

预期:

- agent 调用 `paper_search`。
- 返回 shortlist，论文主题与 LLM agent、tool use、tool learning、小模型 agent 框架等相关。
- agent 只推荐，不自动下载或精读，除非用户明确要求。
- 推荐理由应说明为什么适合当前需求。

实际结果:

- 已执行。
- agent 调用了 `paper_search`。
- 返回了 5 篇候选:
  - `A Plan Reuse Mechanism for LLM-Driven Agent` (`2512.21309`)
  - `MuMath-Code: Combining Tool-Use LLMs with Multi-perspective Data Augmentation` (`2405.07551`)
  - `AgentGuard: Repurposing Agentic Orchestrator for Safety Evaluation of Tool Orchestration` (`2502.09809`)
  - `Context Engineering for Multi-Agent LLM Code Assistants` (`2508.08322`)
  - `MedAide: Information Fusion via LLM-based Agent Collaboration` (`2410.12532`)
- agent 没有自动下载或精读，而是询问是否下载第 1 篇。

初步结论:

- 通过。召回结果整体和 query 匹配，且行为符合“不自动下载/精读”的预期。
- 后续可以进一步检查每篇论文的实际 arXiv 元信息和篇幅，避免模型只基于 search 摘要判断“短论文”。

### T2: 论文精读与追问

候选论文:

- 优先选择 T1 里篇幅较短、主题最匹配的论文。
- 如果 T1 候选下载或文本抽取失败，则使用本地已下载且可抽取文本的短论文。

测试输入序列:

```text
请精读 <PDF path 或 shortlist 编号>。
开始吧。
这节主要解决什么问题？
这个方法和普通单 LLM agent 有什么区别？
把这一节的笔记沉淀下来。
继续下一节。
```

预期:

- `read_paper` 创建阅读计划、reader-state JSON 和 note 骨架。
- `read_paper_section` 只加载当前 section 正文，不写笔记、不调用 sub-agent。
- 主 agent 能基于当前 section 回答用户追问。
- 用户确认“沉淀/记录/保存笔记”后，agent 调用 `record_paper_section_note`。
- 笔记按 section 增量写入，不是一篇一次性总结。

实际结果:

- 已执行。
- 使用本地 PDF:
  - `/Users/user/Desktop/personal-projects/paperClaw/output/pdfs/2401.07324.pdf`
- 输入:
  - `请精读 /Users/user/Desktop/personal-projects/paperClaw/output/pdfs/2401.07324.pdf。`
  - `开始吧。`
  - `这节主要解决什么问题？`
  - `这个方法和普通单 LLM agent 有什么区别？`
  - `把这一节的笔记沉淀下来。`
  - `继续下一节。`
- 工具调用:
  - `read_paper`
  - `read_paper_section`
  - `record_paper_section_note`
  - `read_paper_section`
- 观察:
  - `read_paper` 成功创建 21 个 section 的阅读计划。
  - 对 `开始吧。`，agent 直接调用 `read_paper_section`，没有再出现正则确认循环。
  - agent 基于 Abstract 回答了两个追问:
    - “这节主要解决什么问题？”
    - “这个方法和普通单 LLM agent 有什么区别？”
  - 只有在用户明确说“把这一节的笔记沉淀下来”后，agent 才调用 `record_paper_section_note`。
  - `继续下一节。` 成功加载 Introduction。
- 生成文件:
  - note: `output/2026-06-07T100108966Z-ea1b/papers/2401.07324.md`
  - reader-state: `output/2026-06-07T100108966Z-ea1b/reader-state/2401.07324.json`
- 文件检查:
  - note 中 `Reading Plan` 的第 1 节已标记为 `[x]`。
  - note 中已写入 `### 1. Abstract` 的 section note。
  - reader-state 中第 1 节状态为 `done`，第 2 节状态为 `pending`。

初步结论:

- 通过。逐节精读、追问、显式沉淀笔记、继续下一节的主流程可用。
- 轻微问题: agent 写入的 section note 内容里又带了一个 `## Abstract` 标题，导致 note 中出现 `### 1. Abstract` 下嵌套 `## Abstract`。这不影响功能，但后续可以用 prompt 或写入工具规范要求 section note 不要再包含顶层标题。

### T3: 基于已有笔记的论文推荐

准备数据:

- 在 `output/<test_run>/papers/*.md` 下构造若干测试笔记。
- 测试笔记体现清晰兴趣画像，例如:
  - LLM agent 的工具使用能力。
  - 多 agent / 多 LLM 分工。
  - agent 评估、失败恢复、执行轨迹分析。
  - 小模型 agent 的工具学习能力。

输入:

```text
基于我已有的论文笔记，推荐几篇下一步值得读的 agent/tool-use 方向论文，不要下载，先给 shortlist 和理由。
```

预期:

- agent 读取已有 note/profile 信号。
- agent 基于笔记兴趣组织检索 query，并调用 `paper_search`。
- 推荐结果与构造出的兴趣画像匹配。
- agent 不自动下载、不自动精读。

实际结果:

- 已执行。
- 构造了 3 篇 synthetic notes:
  - `output/e2e-synthetic-20260607/papers/agent-tool-failure-harness.md`
  - `output/e2e-synthetic-20260607/papers/multi-llm-agent-decomposition.md`
  - `output/e2e-synthetic-20260607/papers/tool-learning-data-and-scaling.md`
- synthetic notes 的兴趣信号包括:
  - tool-use agent evaluation
  - failure recovery and trace analysis
  - benchmark harness for agent tool calls
  - multi-LLM decomposition
  - planner/caller/summarizer separation
  - small LLM tool learning
  - tool learning datasets
  - API/function calling benchmarks
  - data scaling law for tool-use LLMs
  - generalization across unseen tools
- 输入:

```text
基于我已有的论文笔记，推荐几篇下一步值得读的 agent/tool-use 方向论文，不要下载，先给 shortlist 和理由。
```

- 工具调用:
  - `list_notes`
  - `read_note` x4
  - `paper_search` x3
- agent 推荐 shortlist:
  - `Chain-of-Tools: Utilizing Massive Unseen Tools in the CoT Reasoning of Frozen Language Models` (`2503.16779`)
  - `RACER: Rich Language-Guided Failure Recovery Policies for Imitation Learning` (`2409.14674`)
  - `PPTC-R benchmark: Towards Evaluating the Robustness of LLMs for PowerPoint Task Completion` (`2403.03788`)
  - `CATP-LLM: Empowering Large Language Models for Cost-Aware Tool Planning` (`2411.16313`)
  - `MACA: A Modular Architecture for Conversational Agents` (`1705.00673`)
- 观察:
  - agent 明确提到推荐依据来自笔记库兴趣: 工具学习数据缩放、失败恢复评估、多 LLM 分解架构。
  - 推荐理由能对应 synthetic notes 中的兴趣信号，例如 unseen tools、failure recovery、benchmark harness、cost-aware tool planning、modular architecture。
  - agent 没有自动下载或自动精读，而是询问“想先精读哪篇 / 是否下载 PDF”。

初步结论:

- 通过。agent 能读取已有笔记，基于笔记兴趣组织检索，并给出匹配的推荐理由。
- 后续可加强: 推荐结果里有跨领域论文，例如机器人 imitation learning 的 failure recovery。它有方法论相关性，但不一定是最直接的 LLM agent/tool-use 论文。后续可以要求 `paper_search` 或 agent 排序时更严格区分“直接相关”和“可迁移相关”。

## 最终总结

- T1 论文检索: 通过。
- T2 论文精读: 通过。
- T3 基于已有笔记推荐: 通过。
- 主要风险/改进项:
  - T1 的“篇幅较短”目前依赖 search 摘要和 agent 判断，建议后续补充页数/文本长度检测。
  - T2 的 section note 格式需要进一步约束，避免写入重复标题。
  - T3 推荐能体现兴趣信号，但还需要更严格地区分直接相关论文和跨领域可迁移论文。
