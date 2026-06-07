import type {
  Channel,
  InboundHandler,
  OutboundMessage,
} from '@paperclaw/core';
import { InkCLIChannel } from './ink-channel.js';
import { PlainCLIChannel } from './plain-channel.js';
import { requestedCliUiMode, shouldUseInk } from '../ui/terminal.js';
import type { CLIChannelOpts } from './types.js';

export function createCLIChannel(opts: CLIChannelOpts = {}): Channel {
  const mode = opts.mode ?? requestedCliUiMode();
  return shouldUseInk({ mode })
    ? new InkCLIChannel({ ...opts, mode })
    : new PlainCLIChannel({ ...opts, mode });
}

/**
 * 兼容旧入口的 CLI channel facade.
 *
 * 本地 TTY 默认使用 Ink; 非 TTY、CI、PAPERCLAW_CLI_UI=plain 自动回退到
 * plain readline channel.
 */
export class CLIChannel implements Channel {
  readonly name = 'cli';
  private readonly delegate: Channel;

  constructor(opts: CLIChannelOpts = {}) {
    this.delegate = createCLIChannel(opts);
  }

  onMessage(handler: InboundHandler): void {
    this.delegate.onMessage(handler);
  }

  send(msg: OutboundMessage): Promise<void> {
    return this.delegate.send(msg);
  }

  start(): Promise<void> {
    return this.delegate.start();
  }

  stop(): Promise<void> {
    return this.delegate.stop();
  }
}

export { InkCLIChannel } from './ink-channel.js';
export { PlainCLIChannel } from './plain-channel.js';
export type { CLIChannelOpts, CliUiMode } from './types.js';
