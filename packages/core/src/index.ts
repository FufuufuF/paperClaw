// ─── Providers ──────────────────────────────────────────────────────────
export * from './providers/base.js';
export {
  buildProviderSnapshot,
  createLLMClient,
  createLLMClientFromConfig,
  providerConfigFor,
  resolveModelPreset,
  type CreateClientOpts,
  type ProviderSnapshot,
} from './providers/factory.js';
export { DeepSeekClient } from './providers/deepseek.js';
export {
  OpenAICompatibleClient,
  parseOpenAIChatResponse,
  type OpenAICompatibleOpts,
} from './providers/openai-compatible.js';

// ─── Existing infra ─────────────────────────────────────────────────────
export { TraceBus, type TraceEvent, type TraceEventKind } from './trace.js';
export { readProfile, type ProfileSnapshot } from './agent/memory.js';
export {
  DEFAULT_CONFIG,
  findConfigFile,
  getRepoRoot,
  getRunId,
  loadConfig,
  loadEnv,
  parsePaperClawConfig,
  resolveEnvRefs,
  runOutputDir,
  type LoadConfigOpts,
  type PaperClawConfig,
} from './config/index.js';
export { withRetry } from './utils/retry.js';
export { mapWithConcurrency } from './utils/concurrency.js';

// ─── Module configs (nanobot-style: owned by each subsystem) ───────────
export {
  DEFAULT_AGENTS_CONFIG,
  parseAgentsConfig,
  type AgentDefaultsConfig,
  type AgentsConfig,
  type FallbackModel,
  type InlineFallbackModel,
  type ModelPresetConfig,
} from './agent/config.js';
export {
  DEFAULT_PROVIDERS_CONFIG,
  parseProvidersConfig,
  type ProviderConfig,
  type ProviderName,
  type ProvidersConfig,
} from './providers/config.js';
export {
  DEFAULT_TOOLS_CONFIG,
  parseToolsConfig,
  type ToolsConfig,
} from './agent/tools/config.js';
export {
  DEFAULT_CHANNELS_CONFIG,
  parseChannelsConfig,
  type ChannelsConfig,
} from './channels/config.js';
export {
  DEFAULT_SESSION_CONFIG,
  parseSessionConfig,
  type SessionConfig,
} from './session/config.js';

// ─── Agent tools ────────────────────────────────────────────────────────
export type {
  PreparedToolCall,
  Tool,
  ToolResult,
  ToolDef,
  ToolScope,
} from './agent/tools/types.js';
export { ToolRegistry } from './agent/tools/registry.js';
export {
  createToolContext,
  type RequestContext,
  type ToolContext,
} from './agent/tools/context.js';
export {
  castParams,
  parseToolArgs,
  validateJsonSchemaValue,
  validateParams,
  type JsonSchema,
  type ParsedToolArgs,
} from './agent/tools/schema.js';
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
export {
  FileSessionStore,
  SessionManager,
  createNewSession,
  retainRecentLegalSuffix,
} from './session/manager.js';

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
  buildSessionMessages,
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
