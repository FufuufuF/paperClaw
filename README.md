# paperClaw

## 1. 如何安装依赖

本地运行需要 Node.js 20+ 和 pnpm。

```bash
pnpm install
```

也可以使用 Docker Compose，不需要在本机安装 Node / pnpm:

```bash
docker compose build
```

Docker 镜像会安装运行所需的 Node、pnpm、SQLite native dependency 构建环境，以及 PDF 文本抽取依赖 `pdftotext`。

## 2. 如何配置大语言模型

项目默认使用 DeepSeek compatible API。先复制环境变量模板:

```bash
cp .env.example .env
```

然后编辑 `.env`，填入自己的 API Key:

```env
DEEPSEEK_API_KEY=sk-...
PAPERCLAW_CLI_UI=plain
```

本地运行时也可以手动创建 `.env`:

```bash
echo "DEEPSEEK_API_KEY=sk-..." > .env
```

## 3. 如何准备或导入数据

paperClaw 的运行态数据默认保存在项目根目录的 `paperclaw-store/`:

```text
paperclaw-store/
  paperclaw.sqlite             session 历史与 memory history
  pdfs/                        下载或导入的论文 PDF
  profile.md                   用户阅读 profile
  knowledge-index.json          论文关系图谱
  memory/                       长期记忆文件
```

首次运行时不需要手动创建这些文件，系统会按需生成。

导入已有数据时，可以把 PDF、Markdown 笔记、profile 或知识图谱文件复制到 `paperclaw-store/` 对应目录。

导入本地 PDF 有两种方式:

```text
方式 1: 放入 paperclaw-store/pdfs/，文件名使用 arXiv id，例如 2401.07324.pdf，然后在对话中说“精读 arXiv ID 2401.07324”
方式 2: 直接在对话中提供 PDF 路径，例如“精读 /path/to/paper.pdf”
```

使用 Docker Compose 时，宿主机的 `./paperclaw-store` 会挂载到容器内的 `/data`。例如宿主机文件:

```text
paperclaw-store/pdfs/demo.pdf
```

在容器内对应路径是:

```text
/data/pdfs/demo.pdf
```

## 4. 如何启动系统

本地启动 CLI:

```bash
pnpm chat
```

Docker Compose 启动 CLI:

```bash
docker compose run --rm paperclaw
```

退出 CLI:

```text
/exit
```

## 5. 如何使用主要功能

常用命令:

```text
/help       查看可用命令和工具
/status     查看当前模型、session、profile 状态
/papers     查看最近论文产物
/profile    查看用户 profile 状态
/cron run   手动触发论文推荐
```

主要功能示例:

```text
我现在想找一篇 agent tool learning 方向的短论文
下载第 1 篇
精读刚才下载的论文
开始读 Abstract
把这一节记录到笔记里
这篇和我之前读过的论文有什么关系?
```

运行过程中产生的数据会写入 `paperclaw-store/`，包括下载的 PDF、论文 Markdown 笔记、阅读进度、profile 和知识图谱。

## 6. 如何复现实验结果或示例结果

先运行基础检查:

```bash
pnpm typecheck
pnpm test
```

如果使用 Docker，先验证镜像可以构建和启动:

```bash
docker compose build
docker compose run --rm paperclaw
```

进入 CLI 后，按下面脚本复现实验示例:

```text
/status
我现在想找一篇 agent tool learning 方向的短论文
下载第 1 篇
精读刚才下载的论文
继续读下一节
把这一节记录到笔记里
/papers
/profile
```

由于搜索结果和大模型输出会受时间、模型版本和 arXiv 当前结果影响，文本内容不保证逐字一致。复现时主要检查这些结果是否出现:

- 能返回论文候选 shortlist。
- 能下载 PDF 到 `paperclaw-store/pdfs/`。
- 能创建论文阅读计划和 Markdown 笔记。
- 能逐节阅读并写入 section note。
- 能更新 `profile.md` 和 `knowledge-index.json`。
