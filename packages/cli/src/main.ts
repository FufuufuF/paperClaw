import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { cp, readdir, rename, rm } from 'node:fs/promises';
import {
  AgentLoop,
  AutoCompact,
  buildProviderSnapshot,
  type Channel,
  CommandRouter,
  Consolidator,
  ContextBuilder,
  CronService,
  createToolContext,
  defaultStoreDir,
  Dream,
  FeishuChannel,
  closePaperClawDatabase,
  loadConfig,
  MemoryStore,
  migrateLegacyMemoryHistory,
  migrateLegacySessions,
  openPaperClawDatabase,
  SqliteMemoryHistoryStore,
  SqliteSessionStore,
  SessionManager,
  type SessionStore,
  type CommandRuntimeStatus,
  registerBuiltinCommands,
  ToolRegistry,
  TraceBus,
  getRepoRoot,
} from '@paperclaw/core';
import {
  createPaperFileTools,
  createPaperKnowledgeTools,
  createPaperSearchTools,
  createReaderTools,
  KNOWLEDGE_SKILLS_DIR,
  PAPER_READ_SKILLS_DIR,
  PAPER_SEARCH_SKILLS_DIR,
  PaperSearchState,
  PROFILE_SKILLS_DIR,
  readProfile,
} from '@paperclaw/paper';
import { CLIChannel } from './channel/adapter.js';
import { CliSessionController, initializeCliSession } from './session-controller.js';
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
  const repoRoot = getRepoRoot();
  const config = loadConfig({ repoRoot });
  const providerSnapshot = buildProviderSnapshot(config);
  const timezone = config.agents.defaults.timezone;
  const explicitStoreDir = process.env.PAPERCLAW_STORE_DIR ?? process.env.PAPERCLAW_OUTPUT_DIR;
  const storeDir = resolveStoreDir(repoRoot);
  await migrateLegacyOutputDir(repoRoot, storeDir, explicitStoreDir === undefined);
  const outputDir = storeDir;
  const sessionsDir = resolve(storeDir, 'sessions');
  const dbPath = resolveDbPath(repoRoot, storeDir);
  const tracePath = resolve(storeDir, 'chat-trace.jsonl');
  const profilePath = resolve(storeDir, 'profile.md');
  const cronStatePath = resolve(storeDir, 'cron-state.json');

  // ── Infra ──────────────────────────────────────────────────────────
  const db = await openPaperClawDatabase(dbPath);
  let dbClosed = false;
  const closeDb = () => {
    if (dbClosed) return;
    closePaperClawDatabase(db);
    dbClosed = true;
  };
  const llm = providerSnapshot.client;
  const trace = new TraceBus(tracePath, 'master');
  const sessionStore = new SqliteSessionStore(db);
  await migrateLegacySessions({ db, sessionsDir, store: sessionStore });
  const sessionManager = new SessionManager(sessionStore);
  const memoryHistoryStore = new SqliteMemoryHistoryStore(db);
  await migrateLegacyMemoryHistory({ db, memoryDir: resolve(storeDir, 'memory') });
  const memoryStore = new MemoryStore(storeDir, { historyStore: memoryHistoryStore });
  const consolidator = new Consolidator({ store: memoryStore, llm, sessions: sessionManager });
  const autoCompact = new AutoCompact({
    sessions: sessionManager,
    consolidator,
    idleCompactAfterMinutes: numberEnv(
      'PAPERCLAW_IDLE_COMPACT_AFTER_MINUTES',
      numberEnv('PAPERCLAW_SESSION_TTL_MINUTES', 0),
    ),
  });
  const dream = new Dream({ store: memoryStore, llm, storeDir });
  const sessionController = new CliSessionController(sessionStore);
  await initializeCliSession(sessionController, sessionStore, {
    reuseDefault: boolEnv('PAPERCLAW_CLI_REUSE_DEFAULT_SESSION', false),
  });
  const searchState = new PaperSearchState();
  const contextBuilder = new ContextBuilder({
    workspace: repoRoot,
    timezone,
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
    timezone,
  }));
  for (const t of allDemoTools) tools.register(t);
  for (const t of createPaperFileTools()) tools.register(t);
  for (const t of createPaperKnowledgeTools({ llm })) tools.register(t);
  for (const t of createPaperSearchTools({ llm, outputDir, profilePath, trace, state: searchState })) {
    tools.register(t);
  }
  for (const t of createReaderTools({ llm, outputDir, profilePath, trace })) {
    tools.register(t);
  }

  const getRuntimeStatus = async (): Promise<CommandRuntimeStatus> => {
    const profile = await readProfile(profilePath);
    const pdfs = await listRecentPdfs(resolve(outputDir, 'pdfs'));
    const activeSessionId = sessionController.current();
    const activeSession = await sessionStore.load(activeSessionId);
    return {
      provider: providerSnapshot.provider,
      model: providerSnapshot.model,
      session: {
        id: activeSessionId,
        sessionName: activeSession?.metadata.sessionName,
        uid: activeSession?.metadata.uid,
        channel: activeSession?.metadata.channel,
      },
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
  registerBuiltinCommands(commands, {
    tools,
    sessionStore,
    getActiveSessionId: () => sessionController.current(),
  });
  registerPaperCommands(commands);
  commands.register({ command: '/dream', title: 'Dream', description: '整理 history 到长期记忆' }, async () => {
    const result = await dream.run();
    return { text: result.summary, metadata: { dream: true, ...result } };
  });

  // ── Channel ────────────────────────────────────────────────────────
  const channel = createChannelFromEnv(getRuntimeStatus, {
    listSessions: () => sessionStore.list(),
    loadSession: (id) => sessionStore.load(id),
    getActiveSessionId: () => sessionController.current(),
  });

  // ── Cron 推荐 ──────────────────────────────────────────────────────
  const paperCronEnabled = boolEnv('PAPERCLAW_CRON_ENABLED', false);
  const dreamCronEnabled = boolEnv('PAPERCLAW_DREAM_ENABLED', false);
  const cronService = new CronService({
    statePath: cronStatePath,
    tasks: [
      {
        id: PAPER_RECOMMENDATION_TASK_ID,
        intervalMinutes: numberEnv('PAPERCLAW_CRON_INTERVAL_MINUTES', 60 * 24 * 7),
        enabled: paperCronEnabled,
      },
      {
        id: DREAM_TASK_ID,
        intervalMinutes: numberEnv('PAPERCLAW_DREAM_INTERVAL_MINUTES', 60 * 24),
        enabled: dreamCronEnabled,
      },
    ],
  });
  const runCronRecommendation = createPaperCronRunner({
    tools,
    searchState,
    maxResults: numberEnv('PAPERCLAW_CRON_MAX_RESULTS', 10),
  });
  registerPaperCronCommand(commands, { cronService, runCronRecommendation });

  // ── AgentLoop ──────────────────────────────────────────────────────
  const loop = new AgentLoop({
    sessionManager,
    commands,
    runner: {
      tools,
      llm,
      maxIterations: config.agents.defaults.maxToolIterations,
      contextBudget: providerSnapshot.contextWindowTokens,
      agentId: 'master',
      trace,
      temperature: providerSnapshot.temperature,
      maxTokens: providerSnapshot.maxTokens,
    },
    channel,
    trace,
    autoCompact,
    buildPrompt: async (ctx) => contextBuilder.buildSystemPrompt(tools, {
      sessionSummary: ctx?.sessionSummary,
      contextBlocks: await memoryContextBlocks(memoryStore),
    }),
    status: getRuntimeStatus,
    sendProgress: true,
    sessionIdFor: (senderId) => channel.name === 'cli' ? sessionController.current() : senderId,
    createSessionId: (name) => sessionController.createNextId(name),
    switchSession: (sessionId) => sessionController.switchTo(sessionId),
  });

  channel.onMessage((msg) => loop.processMessage(msg));

  autoCompact.start({
    activeSessionIds: () => loop.getBusySessionIds(),
  });

  if (paperCronEnabled || dreamCronEnabled) {
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
      [DREAM_TASK_ID]: async () => {
        const result = await dream.run();
        return { summary: result.summary, data: result };
      },
    });
  }

  // SIGINT: 让 channel.stop 优雅关闭 readline/Ink.
  process.on('SIGINT', () => {
    autoCompact.stop();
    cronService.stop();
    void channel.stop().finally(() => {
      closeDb();
      process.exit(0);
    });
  });

  try {
    await channel.start();
  } finally {
    closeDb();
  }
}

const DREAM_TASK_ID = 'dream-memory';

async function memoryContextBlocks(store: MemoryStore): Promise<Array<{ title: string; content: string }>> {
  const memory = await store.getMemoryContext();
  const soul = (await store.readSoul()).trim();
  const user = (await store.readUser()).trim();
  return [
    memory ? { title: 'Memory Context', content: memory } : null,
    soul ? { title: 'SOUL', content: soul } : null,
    user ? { title: 'USER', content: user } : null,
  ].filter((item): item is { title: string; content: string } => item !== null);
}

function resolveStoreDir(repoRoot: string): string {
  const configured = process.env.PAPERCLAW_STORE_DIR ?? process.env.PAPERCLAW_OUTPUT_DIR;
  return configured ? resolve(repoRoot, configured) : defaultStoreDir(repoRoot);
}

function resolveDbPath(repoRoot: string, storeDir: string): string {
  const configured = process.env.PAPERCLAW_DB_PATH;
  return configured ? resolve(repoRoot, configured) : resolve(storeDir, 'paperclaw.sqlite');
}

async function migrateLegacyOutputDir(repoRoot: string, storeDir: string, enabled: boolean): Promise<void> {
  if (!enabled) return;
  const legacy = resolve(repoRoot, 'output');
  if (storeDir === legacy || existsSync(storeDir) || !existsSync(legacy)) return;
  try {
    await rename(legacy, storeDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await cp(legacy, storeDir, { recursive: true });
    await rm(legacy, { recursive: true, force: true });
  }
}

function createChannelFromEnv(
  getStatus: () => CommandRuntimeStatus | Promise<CommandRuntimeStatus>,
  sessionUi?: {
    listSessions?: () => ReturnType<SessionStore['list']>;
    loadSession?: (id: string) => ReturnType<SessionStore['load']>;
    getActiveSessionId?: () => string;
  },
): Channel {
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
  return new CLIChannel({
    senderId: 'cli:default',
    getStatus,
    listSessions: sessionUi?.listSessions,
    loadSession: sessionUi?.loadSession,
    getActiveSessionId: sessionUi?.getActiveSessionId,
  });
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
