import type { MessageBus } from '../../bus/queue.js';
import type { SessionManager } from '../../session/manager.js';
import { DEFAULT_TOOLS_CONFIG, type ToolsConfig } from './config.js';

export interface RequestContext {
  channel: string;
  senderId: string;
  messageId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolContext {
  config: ToolsConfig;
  workspace: string;
  outputDir: string;
  request?: RequestContext;
  bus?: MessageBus;
  sessions?: SessionManager;
  timezone: string;
}

export function createToolContext(opts: Partial<ToolContext> & { workspace: string }): ToolContext {
  return {
    config: opts.config ?? DEFAULT_TOOLS_CONFIG,
    workspace: opts.workspace,
    outputDir: opts.outputDir ?? opts.workspace,
    request: opts.request,
    bus: opts.bus,
    sessions: opts.sessions,
    timezone: opts.timezone ?? 'UTC',
  };
}
