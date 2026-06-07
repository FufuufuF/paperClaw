import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline/promises';
import type {
  Channel,
  InboundHandler,
  InboundMessage,
  OutboundMessage,
} from '@paperclaw/core';
import { renderPlainMessage, renderPlainWelcome } from '../ui/plain/render.js';
import type { CLIChannelOpts } from './types.js';

/**
 * 非 TTY、日志重定向和显式 PAPERCLAW_CLI_UI=plain 时使用的稳定文本 channel.
 */
export class PlainCLIChannel implements Channel {
  readonly name = 'cli';
  private readonly handlers: InboundHandler[] = [];
  private rl: readline.Interface | null = null;
  private running = false;
  private msgCounter = 0;
  private readonly senderId: string;
  private readonly getStatus?: CLIChannelOpts['getStatus'];

  constructor(opts: CLIChannelOpts = {}) {
    this.senderId = opts.senderId ?? 'cli:default';
    this.getStatus = opts.getStatus;
  }

  onMessage(handler: InboundHandler): void {
    this.handlers.push(handler);
  }

  async send(msg: OutboundMessage): Promise<void> {
    const output = renderPlainMessage(msg);
    if (output) stdout.write(output);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.rl = readline.createInterface({
      input: stdin,
      output: stdout,
      terminal: Boolean(stdin.isTTY && stdout.isTTY),
    });

    stdout.write(renderPlainWelcome(await this.safeStatus()));

    while (this.running) {
      let input: string;
      try {
        input = await this.rl.question('you> ');
      } catch {
        break;
      }

      const text = input.trim();
      if (!text) continue;
      if (text === '/quit' || text === '/exit') {
        stdout.write('再见.\n');
        break;
      }

      await this.dispatch(text);
    }

    await this.stop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.rl?.close();
    this.rl = null;
  }

  private async dispatch(text: string): Promise<void> {
    const msg: InboundMessage = {
      id: `cli-${++this.msgCounter}`,
      senderId: this.senderId,
      text,
      timestamp: Date.now(),
    };

    for (const handler of this.handlers) {
      try {
        await handler(msg);
      } catch (err) {
        process.stderr.write(
          `[cli] handler error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  private async safeStatus() {
    try {
      return await this.getStatus?.();
    } catch {
      return undefined;
    }
  }
}
