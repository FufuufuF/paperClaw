# paperClaw

> 数据挖掘期末项目 · 2026 春
> agent 框架版 personal paper notes corpus

## 现状 (W1)

实现 **检索模块** (`packages/search`), 见 `.claude/plan-search-module.md`.

## 快速开始

```bash
# 1. 装依赖
pnpm install

# 2. 配置 DeepSeek key (已在 .env)
echo "DEEPSEEK_API_KEY=sk-..." > .env

# 3. 跑 query 模式
pnpm search:query "agent harness design"

# 4. 跑 cron 模式 (需要 output/profile.md 有内容)
pnpm search:cron

# 5. 下载用户选中的 PDF
pnpm search:download <run_id> 2401.12345 2402.56789
```

## 架构

详见 `docs/design.md` 与 `.claude/plan-search-module.md`.

```
packages/
  core/        # LLM 抽象 / trace / profile reader
  search/      # 检索模块: arxiv / triage / download / query_flow / cron_flow
  cli/         # 命令行入口
output/
  profile.md           # 跨 run, 用户阅读 profile (本仓库不写)
  pdfs/<id>.pdf        # 检索模块下载的 PDF
  <run_id>/
    trace.jsonl        # 完整 plan/act/observe 流水
    shortlist.json     # 最终 shortlist
    meta.json          # token 用量 / 耗时
```

## 不在本次范围

精读模块 (Reader) / Profile 写入 / Web UI / Cron scheduler — 见 plan 文档.
