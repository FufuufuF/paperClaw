# Cron, Profile, and Knowledge-Based Recommendation Session Notes

日期: 2026-06-08
分支: `feat/cron-profile-recommendations`
状态: 讨论记录, 暂不修改代码逻辑

## 背景

当前实现里, cron 推荐主要从 `output/profile.md` 推断检索方向, 再调用 arXiv search 和 triage 生成 shortlist。

这个机制可以跑通最小闭环, 但和更理想的产品设想有偏差: paperClaw 的论文推荐应该主要利用已经沉淀的论文知识库, 尤其是 `knowledge-index.json` 中的论文节点、关系、阅读状态和 verdict。

## 已确认结论

- cron 推荐不应该主要依赖 `profile.md`。
- cron 推荐的主输入应该是 `knowledge-index.json`。
- `knowledge-index.json` 是论文事实和论文关系的机器可读索引。
- Markdown note 仍然是单篇论文细节的 source of truth。
- `profile.md` 不应该是 paper workflow 专属文件, 更适合作为 clawbot 基座的长期用户记忆。
- 本轮只讨论设计, 不直接改代码逻辑。

## 当前实现状态

clawbot 基座层还没有完整实现通用长期记忆机制。

当前已有的是 paper workflow 专用的轻量 profile 能力:

- `readProfile()` 位于 core 的 `agent/memory.ts`, 但它只读取 `output/profile.md`, 解析 `## 已读索引` 里的 `[[slug]]`, 并计算 cold / weak / full 信号。
- `/profile` 命令只展示 profile 路径、已读数量和 personalization 层级。
- `update_profile_section` 工具可以在用户明确要求时修改 `output/profile.md` 的某个 Markdown section。
- Reader 在读完整篇论文后会调用 profile updater, 追加或替换 `## 已读索引` 条目。
- Search / cron 会读取 profile, 用于过滤已读或推断 cron 检索方向。

当前缺少的是通用 clawbot memory 机制:

- 没有通用 `MemoryManager` / `ProfileManager`。
- 没有跨 domain 的用户偏好 schema。
- 没有把 profile summary 自动注入主 agent context。
- 没有 `/remember`、`/forget`、`/memory` 这类基座命令。
- 没有 dream / consolidation / archive 机制。
- 没有推荐反馈事件到 profile 的聚合流程。

因此, 现在的 `profile.md` 更准确地说是 paperClaw 业务层的阅读 profile, 不是 clawbot 基座级长期记忆。

## Knowledge Index 的推荐职责

cron 推荐应从最近阅读的论文出发, 使用这些论文在 `knowledge-index.json` 中的局部子图:

- 最近完成阅读的论文节点。
- 这些节点的一跳或二跳邻居。
- 已有正式关系, 例如 `extends`、`complements`、`uses_same`、`challenges`。
- pending links, 用来发现还没确认但值得比较的方向。
- open questions, 用来发现知识缺口。
- unread / reading / read / skipped 状态, 用来避免重复推荐。

推荐可以分两类:

- 图内推荐: 从已有知识图谱中推荐下一篇应该读、应该比较、应该补全的论文。
- 图外推荐: 用最近论文节点的摘要、tags、邻居关系生成 arXiv query, 搜索新论文。

推荐解释也应该尽量来自图谱证据:

```text
推荐 X, 因为你最近读过 A, A 和 B 都关注 tool-use failure recovery;
X 可能补充 B 没讨论的 benchmark robustness 问题。
```

## Knowledge Index 节点需要补充的信息

如果 cron 要从图谱生成高质量推荐, 每个论文节点不能只有 `title`、`note_path`、`status`、`verdict`。需要增加机器可用的轻量摘要。

当前先只新增一个字段:

```ts
summary_short: string;
```

`summary_short` 是 1-3 句论文概括, 用于推荐 query 和解释。暂不增加 problem/method/eval/contribution tags, 避免第一版 schema 变复杂。

这个字段不应该复制论文正文, 只做索引和导航。

## Knowledge Tool 当前完备度

现有 knowledge tools 已经覆盖基础图谱交互:

- `kg_search_nodes`: 按 query / status / verdict 搜索节点。
- `kg_get_node`: 读取单个节点。
- `kg_neighbors`: 查询一跳邻居。
- `kg_get_link`: 读取关系详情和 evidence pointer。
- `kg_search_links`: 搜索关系。
- `kg_suggest_links`: 基于当前 section summary 和已有图谱生成候选关系。
- `kg_list_pending_links`: 查看待 review 的关系候选。
- 写入工具: `kg_upsert_node`、`kg_upsert_link`、`kg_update_link`、`kg_delete_link`、`kg_create_pending_link`、`kg_commit_pending_link`、`kg_reject_pending_link`。

当前分支已补齐第一版 cron 推荐所需能力:

- 节点 schema 增加 `summary_short`。
- `kg_get_node` / `kg_search_nodes` / `kg_neighbors` 可返回 `summary_short`。
- 新增 `kg_recent_nodes`, 支持按 status / verdict / limit 查询最近更新节点。
- `kg_upsert_node` 可写入 `summary_short`。
- Reader 读完整篇论文后会从 section note 中提取短摘要并写入 KG 节点。
- cron runner 会先通过 KG tools 获取最近 read 节点和邻居摘要, 生成 KG-informed query, 再调用 `paper_search(mode="cron")`。
- cron runner 会把 KG 中已知的 `arxiv_id` 传给 `paper_search.excludeArxivIds`, 避免重复推荐已经在知识图谱中的论文。
- cron 推送只展示 `recommend`; 如果没有 `recommend`, 才退而展示 `maybe`。
- `skip` 候选不展示, 不进入下载 shortlist, 也不写入 cron `seenIds`。

第一版仍然保持保守: 没有引入 tags, 没有读取完整 note, 也没有自动写正式关系。

## Knowledge Index 的更新时机

已经确认: 用于推荐的稳定知识应在**读完一篇论文后**更新。

更精确地说:

- `read_paper` 开始时可以注册临时节点, 状态为 `reading`。
- 逐节阅读过程中可以更新阅读进度, 但不应把未稳定的内容当作推荐主依据。
- 读完整篇论文后, 写入或更新稳定节点信息:
  - `status = read`
  - `verdict`
  - `summary_short`
  - tags
  - note path
  - arXiv id
- 读完整篇论文后, 可以生成候选关系:
  - 自动生成的关系先进入 `pending_links`。
  - 用户确认后再写入正式 `links`。

这样可以避免 cron 被半成品笔记和未确认判断带偏。

## Profile 的重新定位

`profile.md` 不应该承担论文知识库职责。它更适合成为 clawbot 基座层的长期用户记忆。

建议职责:

- 记录用户长期目标。
- 记录用户偏好。
- 记录用户不感兴趣或明确排除的方向。
- 记录推荐偏好, 例如偏新论文、偏 benchmark、偏 method、偏 foundational work。
- 记录交互偏好, 例如回答长度、是否喜欢先给 shortlist、是否偏中文解释。
- 记录跨任务的稳定信息, 不限于 paper workflow。

不建议职责:

- 不作为论文关系图谱。
- 不复制论文摘要和正文。
- 不作为已读论文唯一索引。
- 不保存大量推荐曝光流水。
- 不替代 `knowledge-index.json`、notes 或 cron state。

## Profile 的更新时机建议

profile 作为基座长期记忆后, 更新时机不应绑定到“每读完一篇论文”。读完论文应该优先更新 `knowledge-index.json`。

建议使用分层更新机制。

### 1. 用户显式表达偏好时立即更新

例如用户说:

```text
以后不要推荐纯 survey。
我现在主要关注 tool-use agent evaluation。
我更想找能作为 related work 的论文, 不急着看最新 preprint。
```

这类信息可以进入 profile, 但仍应经过写入确认或明确的记忆规则。

### 2. 推荐反馈先记录事件, 再聚合进 profile

用户对推荐的行为不一定都应该马上改 profile。

可以先记录为事件:

- 推荐被展示。
- 用户下载。
- 用户跳过。
- 用户说“不相关”。
- 用户后来读完并给出 `adopt` / `maybe` / `skip`。

这些事件更适合放在推荐反馈日志或 cron state 附近。只有当多次反馈形成稳定偏好时, 再合并进 profile。

### 3. 会话结束或定期 consolidation 时更新

clawbot 基座可以提供长期记忆整理机制, 在这些时机更新 profile:

- `/new` 开启新会话前。
- 用户明确说“记住这个偏好”。
- 长驻模式下定期 dream / consolidation。
- 一轮推荐和阅读闭环结束后, 把稳定偏好合并到 profile。

### 4. 读完论文后不默认直接更新 profile

读完论文时可以产生 profile update candidate, 但不应该无条件写入。

原因:

- 单篇论文的 verdict 不一定代表长期偏好。
- 论文事实应进入 `knowledge-index.json`。
- profile 应记录稳定的用户偏好, 而不是所有阅读事实。

可选策略:

```text
读完论文
  -> 更新 knowledge-index
  -> 记录 reading event
  -> 如果 verdict 或用户评论透露稳定偏好, 生成 profile update candidate
  -> 用户确认或 consolidation 后写入 profile
```

## Profile 建议结构

如果继续使用 Markdown, 可以改成更通用的结构:

```md
# Clawbot Profile

## Long-Term Goals

## Current Focus

## Preferences

## Avoid / Low Priority

## Paper Reading Preferences

## Recommendation Feedback Summary

## User-Corrected Facts
```

paperClaw 可以只读取其中与论文推荐相关的 section。

## 三类文件的职责边界

```text
knowledge-index.json
  论文节点、论文关系、verdict、summary/tags、open questions

profile.md
  用户长期目标、偏好、排除规则、跨任务记忆

cron-state.json / recommendation event log
  运行次数、seen ids、曝光历史、推荐反馈事件
```

## 待确认问题

- `profile.md` 是否继续放在 `output/profile.md`, 还是迁移到更明确的基座 memory 路径。
- profile 写入是否一律需要用户确认, 还是允许 consolidation 自动写入。
- 推荐反馈事件放在 `cron-state.json` 里, 还是单独建 `recommendation-events.jsonl`。
- knowledge node 第一版已确定先只做 `summary_short`; 后续是否增加 tags 另行评估。
- cron 推荐第一版先做图内推荐, 还是同时做图外 arXiv 搜索。
