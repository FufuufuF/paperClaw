import type {
  CommandRuntimeStatus,
  InboundHandler,
  OutboundMessage,
} from '@paperclaw/core';

export type CliUiMode = 'auto' | 'ink' | 'plain';

export interface CLIChannelOpts {
  senderId?: string;
  mode?: CliUiMode;
  getStatus?: () => CommandRuntimeStatus | Promise<CommandRuntimeStatus>;
}

export type CliMessageRole = 'user' | 'assistant' | 'progress' | 'tool' | 'error' | 'system';

export interface CliMessage {
  id: string;
  role: CliMessageRole;
  text: string;
  timestamp: number;
}

export type CliRunState = 'idle' | 'working' | 'error';

export interface CliViewState {
  messages: CliMessage[];
  runState: CliRunState;
  currentTools: string[];
  queuedCount: number;
  runtimeStatus?: CommandRuntimeStatus;
  lastError?: string;
}

export interface CliChannelRuntime {
  handlers: InboundHandler[];
  send(msg: OutboundMessage): Promise<void>;
}
