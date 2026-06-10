import type {
  CommandRuntimeStatus,
  InboundHandler,
  OutboundMessage,
  Session,
  SessionListing,
} from '@paperclaw/core';

export type CliUiMode = 'auto' | 'ink' | 'plain';

export interface CLIChannelOpts {
  senderId?: string;
  mode?: CliUiMode;
  getStatus?: () => CommandRuntimeStatus | Promise<CommandRuntimeStatus>;
  listSessions?: () => SessionListing[] | Promise<SessionListing[]>;
  loadSession?: (id: string) => Session | null | Promise<Session | null>;
  getActiveSessionId?: () => string;
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
  switchPicker?: CliSwitchPickerState;
  runtimeStatus?: CommandRuntimeStatus;
  lastError?: string;
}

export interface CliSwitchPickerItem {
  index: number;
  id: string;
  label: string;
  preview: string;
  lastActiveAt: string;
  turnCount: number;
  active: boolean;
}

export interface CliSwitchPickerState {
  items: CliSwitchPickerItem[];
  selectedIndex: number;
}

export interface CliChannelRuntime {
  handlers: InboundHandler[];
  send(msg: OutboundMessage): Promise<void>;
}
