import { resolve } from 'node:path';
import {
  AgentLoop,
  buildBasePrompt,
  CommandRouter,
  createLLMClient,
  FileSessionStore,
  loadEnv,
  registerBuiltinCommands,
  ToolRegistry,
  TraceBus,
  getRepoRoot,
} from '@paperclaw/core';
import { CLIChannel } from './adapter.js';
import { allDemoTools } from './demo-tools.js';

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

  // ── Infra ──────────────────────────────────────────────────────────
  const llm = createLLMClient(); // 默认 deepseek-chat
  const trace = new TraceBus(tracePath, 'master');
  const sessionStore = new FileSessionStore(sessionsDir);

  // ── Tools (demo) ───────────────────────────────────────────────────
  const tools = new ToolRegistry();
  for (const t of allDemoTools) tools.register(t);

  // ── Commands (内置) ────────────────────────────────────────────────
  const commands = new CommandRouter();
  registerBuiltinCommands(commands, { tools, sessionStore });

  // ── Channel ────────────────────────────────────────────────────────
  const channel = new CLIChannel({ senderId: 'cli:default' });

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
    buildPrompt: () => buildBasePrompt(tools),
    sessionIdFor: () => 'cli:default',
  });

  channel.onMessage((msg) => loop.processMessage(msg));

  // SIGINT: 让 channel.stop 优雅 close readline
  process.on('SIGINT', () => {
    void channel.stop().finally(() => process.exit(0));
  });

  await channel.start();
}

main().catch((err) => {
  console.error('[chat] fatal:', err);
  process.exit(1);
});
