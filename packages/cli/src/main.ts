import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import {
  AgentLoop,
  type Channel,
  CommandRouter,
  ContextBuilder,
  CronService,
  createToolContext,
  createLLMClient,
  FeishuChannel,
  FileSessionStore,
  loadEnv,
  type CommandRuntimeStatus,
  registerBuiltinCommands,
  ToolRegistry,
  TraceBus,
  getRepoRoot,
} from '@paperclaw/core';
import { createKnowledgeGraphTools, KNOWLEDGE_SKILLS_DIR } from '@paperclaw/knowledge';
import { readProfile, PROFILE_SKILLS_DIR } from '@paperclaw/profile';
import { createPaperFileTools, createReaderTools, PAPER_READ_SKILLS_DIR } from '@paperclaw/reader';
import { createPaperSearchTools, PAPER_SEARCH_SKILLS_DIR, PaperSearchState } from '@paperclaw/search';
import { CLIChannel } from './channel/adapter.js';
import {
  createPaperCronRunner,
  PAPER_RECOMMENDATION_TASK_ID,
  registerPaperCronCommand,
} from './commands/cron.js';
import { registerPaperCommands } from './commands/paper.js';
import { allDemoTools } from './tools/demo-tools.js';

/**
 * Chat 入口 — 组装基座, 注册 demo tools, 启动 CLI channel.
 *
 * 这是 nanobot-base.md 描述的最小可跑形态. 业务 tool (paper_search /
 * read_paper) 后续直接 tools.register(...) 即可挂载, 不动这里的骨架.
 */
async function main() {
  loadEnv();

  const repoRoot = getRepoRoot();
  const outputDir = resolve(repoRoot, 'output');
  const sessionsDir = resolve(outputDir, 'sessions');
  const tracePath = resolve(outputDir, 'chat-trace.jsonl');
  const profilePath = resolve(outputDir, 'profile.md');
  const cronStatePath = resolve(outputDir, 'cron-state.json');

  // ── Infra ──────────────────────────────────────────────────────────
  const llm = createLLMClient(); // 默认 deepseek-chat
  const trace = new TraceBus(tracePath, 'master');
  const sessionStore = new FileSessionStore(sessionsDir);
  const searchState = new PaperSearchState();
  const contextBuilder = new ContextBuilder({
    workspace: repoRoot,
    timezone: 'Asia/Shanghai',
    builtinSkillsDirs: [
      PAPER_SEARCH_SKILLS_DIR,
      PAPER_READ_SKILLS_DIR,
      KNOWLEDGE_SKILLS_DIR,
      PROFILE_SKILLS_DIR,
    ],
  });

  // ── Tools (demo) ───────────────────────────────────────────────────
  const tools = new ToolRegistry(undefined, createToolContext({
    workspace: repoRoot,
    outputDir,
    timezone: 'Asia/Shanghai',
  }));
  for (const t of allDemoTools) tools.register(t);
  for (const t of createPaperFileTools()) tools.register(t);
  for (const t of createKnowledgeGraphTools({ llm })) tools.register(t);
  for (const t of createPaperSearchTools({ llm, outputDir, profilePath, trace, state: searchState })) {
    tools.register(t);
  }
  for (const t of createReaderTools({ llm, outputDir, profilePath, trace })) {
    tools.register(t);
  }

  const getRuntimeStatus = async (): Promise<CommandRuntimeStatus> => {
    const profile = await readProfile(profilePath);
    const pdfs = await listRecentPdfs(resolve(outputDir, 'pdfs'));
    return {
      provider: llm.id.split('/')[0],
      model: llm.id.split('/').slice(1).join('/') || llm.id,
      profile: {
        path: profile.path,
        readCount: profile.readSlugs.length,
        personalization: profile.readSlugs.length >= 8 ? 'full' : profile.readSlugs.length >= 3 ? 'weak' : 'cold',
      },
      papers: pdfs,
    };
  };

  // ── Commands (内置) ────────────────────────────────────────────────
  const commands = new CommandRouter();
  registerBuiltinCommands(commands, { tools, sessionStore });
  registerPaperCommands(commands);

  // ── Channel ────────────────────────────────────────────────────────
  const channel = createChannelFromEnv(getRuntimeStatus);

  // ── Cron 推荐 ──────────────────────────────────────────────────────
  const cronService = new CronService({
    statePath: cronStatePath,
    tasks: [{
      id: PAPER_RECOMMENDATION_TASK_ID,
      intervalMinutes: numberEnv('PAPERCLAW_CRON_INTERVAL_MINUTES', 60 * 24 * 7),
      enabled: boolEnv('PAPERCLAW_CRON_ENABLED', false),
    }],
  });
  const runCronRecommendation = createPaperCronRunner({
    tools,
    searchState,
    maxResults: numberEnv('PAPERCLAW_CRON_MAX_RESULTS', 10),
  });
  registerPaperCronCommand(commands, { cronService, runCronRecommendation });

  // ── AgentLoop ──────────────────────────────────────────────────────
  const loop = new AgentLoop({
    sessionStore,
    commands,
    runner: {
      tools,
      llm,
      maxIterations: 30,
      contextBudget: 24000,
      agentId: 'master',
      trace,
    },
    channel,
    trace,
    buildPrompt: () => contextBuilder.buildSystemPrompt(tools),
    status: getRuntimeStatus,
    sendProgress: true,
    sessionIdFor: (senderId) => channel.name === 'cli' ? 'cli:default' : senderId,
  });

  channel.onMessage((msg) => loop.processMessage(msg));

  if (boolEnv('PAPERCLAW_CRON_ENABLED', false)) {
    await cronService.start({
      [PAPER_RECOMMENDATION_TASK_ID]: async (ctx) => {
        const result = await runCronRecommendation(ctx);
        await channel.send({
          kind: 'final',
          text: result.summary,
          metadata: { cron: true, taskId: PAPER_RECOMMENDATION_TASK_ID },
        });
        return result;
      },
    });
  }

  // SIGINT: 让 channel.stop 优雅关闭 readline/Ink.
  process.on('SIGINT', () => {
    void channel.stop().finally(() => process.exit(0));
  });

  await channel.start();
}

function createChannelFromEnv(getStatus: () => CommandRuntimeStatus | Promise<CommandRuntimeStatus>): Channel {
  const mode = (process.env.PAPERCLAW_CHANNEL ?? 'cli').toLowerCase();
  if (mode === 'feishu') {
    return new FeishuChannel({
      port: numberEnv('FEISHU_PORT', numberEnv('PAPERCLAW_FEISHU_PORT', 8787)),
      path: process.env.FEISHU_PATH ?? process.env.PAPERCLAW_FEISHU_PATH ?? '/feishu/events',
      verifyToken: process.env.FEISHU_VERIFY_TOKEN ?? process.env.PAPERCLAW_FEISHU_VERIFY_TOKEN,
      sendWebhookUrl: process.env.FEISHU_WEBHOOK_URL ?? process.env.PAPERCLAW_FEISHU_WEBHOOK_URL,
      allowedSenderIds: listEnv('FEISHU_ALLOWLIST') ?? listEnv('PAPERCLAW_FEISHU_ALLOWLIST'),
    });
  }
  return new CLIChannel({ senderId: 'cli:default', getStatus });
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listEnv(name: string): string[] | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

async function listRecentPdfs(dir: string): Promise<Array<{ id: string; path: string }>> {
  try {
    const files = await readdir(dir);
    return files
      .filter((name) => name.endsWith('.pdf'))
      .slice(-20)
      .reverse()
      .map((name) => ({ id: name.replace(/\.pdf$/i, ''), path: resolve(dir, name) }));
  } catch {
    return [];
  }
}

main().catch((err) => {
  console.error('[chat] fatal:', err);
  process.exit(1);
});
