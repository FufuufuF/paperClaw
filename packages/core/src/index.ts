// ─── Providers ──────────────────────────────────────────────────────────
export * from './providers/base.js';
export { createLLMClient, type CreateClientOpts } from './providers/factory.js';
export { DeepSeekClient } from './providers/deepseek.js';

// ─── Existing infra ─────────────────────────────────────────────────────
export { TraceBus, type TraceEvent, type TraceEventKind } from './trace.js';
export { readProfile, type ProfileSnapshot } from './agent/memory.js';
export { loadEnv, getRunId, getRepoRoot, runOutputDir } from './config/index.js';
export { withRetry } from './utils/retry.js';
export { mapWithConcurrency } from './utils/concurrency.js';

// ─── Agent tools ────────────────────────────────────────────────────────
export type { Tool, ToolResult, ToolDef } from './agent/tools/types.js';
export { ToolRegistry } from './agent/tools/registry.js';
export {
  echoTool,
  addTool,
  multiplyTool,
  bigTool,
  allDemoTools,
} from './agent/tools/demo.js';

// ─── Bus / Channels (nanobot-style split) ───────────────────────────────
export type {
  InboundMessage,
  OutboundMessage,
  InboundHandler,
} from './bus/events.js';
export { MessageBus } from './bus/queue.js';
export type { Channel } from './channels/base.js';

// ─── Session ────────────────────────────────────────────────────────────
export type {
  Turn,
  TurnRole,
  Session,
  SessionStore,
  SessionListing,
} from './session/manager.js';
export { FileSessionStore, createNewSession } from './session/manager.js';

// ─── Command ────────────────────────────────────────────────────────────
export { CommandRouter } from './command/router.js';
export type { CommandHandler, CommandResult } from './command/router.js';
export {
  registerBuiltinCommands,
  makeClearCommand,
  makeHelpCommand,
  makeHistoryCommand,
  makeCostCommand,
  makeSessionCommand,
} from './command/builtin.js';

// ─── Agent ──────────────────────────────────────────────────────────────
export type { RunnerConfig, RunnerResult } from './agent/runner.js';
export type { AgentLoopConfig } from './agent/loop.js';
export { AgentLoop } from './agent/loop.js';
export { runToolLoop } from './agent/runner.js';
export {
  buildMessages,
  compactToolResults,
  estimateTokens,
  estimateMessagesTokens,
  turnToMessage,
  buildBasePrompt,
  ContextBuilder,
} from './agent/context.js';
export { SkillsLoader, type SkillEntry, type SkillMetadata } from './agent/skills.js';

// ─── Templates ──────────────────────────────────────────────────────────
export { renderTemplate } from './utils/templates.js';
