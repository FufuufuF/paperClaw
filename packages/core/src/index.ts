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
export {
  WorkspaceGuard,
  type GuardedPath,
  type WriteResult,
} from './security/index.js';

// ─── Bus / Channels (nanobot-style split) ───────────────────────────────
export type {
  InboundMessage,
  OutboundMessage,
  InboundHandler,
} from './bus/events.js';
export { MessageBus } from './bus/queue.js';
export type { Channel } from './channels/base.js';
export {
  FeishuChannel,
  normalizeFeishuEvent,
  toFeishuTextPayload,
  type FeishuChannelOpts,
  type FeishuNormalizeResult,
} from './channels/feishu.js';
export {
  CronService,
  type CronRunContext,
  type CronServiceOpts,
  type CronStateFile,
  type CronTaskConfig,
  type CronTaskHandler,
  type CronTaskResult,
  type CronTaskState,
} from './cron/index.js';

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
export type {
  CommandContext,
  CommandHandler,
  CommandMetadata,
  CommandResult,
  CommandRuntimeStatus,
} from './command/router.js';
export {
  registerBuiltinCommands,
  makeClearCommand,
  makeHelpCommand,
  makeHistoryCommand,
  makeCostCommand,
  makeSessionCommand,
  makeNewCommand,
  makeModelCommand,
  makeStatusCommand,
  makeStopCommand,
} from './command/builtin.js';

// ─── Agent ──────────────────────────────────────────────────────────────
export type {
  AgentCheckpoint,
  AgentRunResult,
  AgentRunSpec,
  AgentStopReason,
  RunnerConfig,
  RunnerResult,
  ToolRunEvent,
} from './agent/runner.js';
export type { AgentLoopConfig, TurnContext, TurnState } from './agent/loop.js';
export { AgentLoop } from './agent/loop.js';
export {
  AgentRunner,
  BACKFILL_TOOL_RESULT_CONTENT,
  EMPTY_FINAL_RESPONSE_MESSAGE,
  runToolLoop,
} from './agent/runner.js';
export { runSubagent, type SubagentResult, type SubagentSpec } from './agent/subagent.js';
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
