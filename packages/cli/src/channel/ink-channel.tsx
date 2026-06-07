import { stdin, stderr, stdout } from 'node:process';
import { render, type Instance } from 'ink';
import type {
  Channel,
  InboundHandler,
  InboundMessage,
  OutboundMessage,
} from '@paperclaw/core';
import { InkCliApp } from '../ui/ink/App.js';
import { InkCliStore } from '../ui/ink/store.js';
import { extractToolNames } from '../ui/plain/render.js';
import type { CLIChannelOpts, CliMessageRole } from './types.js';

export class InkCLIChannel implements Channel {
  readonly name = 'cli';
  private readonly handlers: InboundHandler[] = [];
  private readonly store = new InkCliStore();
  private readonly queue: InboundMessage[] = [];
  private instance: Instance | null = null;
  private running = false;
  private processing = false;
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
    const kind = msg.kind ?? 'final';
    if (kind === 'reasoning' && process.env.PAPERCLAW_CLI_SHOW_REASONING !== '1') {
      return;
    }

    if (kind === 'tool_hint') {
      this.store.setRunState('working');
      this.store.setCurrentTools(extractToolNames(msg));
    } else if (kind === 'progress') {
      this.store.setRunState('working');
    } else if (kind === 'error') {
      this.store.setRunState('error', msg.text);
      this.store.setCurrentTools([]);
    }

    this.store.appendMessage({
      id: `out-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role: roleFor(kind),
      text: kind === 'tool_hint' ? toolHintText(msg) : msg.text,
      timestamp: Date.now(),
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.refreshStatus();
    this.instance = render(
      <InkCliApp
        store={this.store}
        onSubmit={(text) => void this.submit(text)}
        onExit={() => void this.requestExit()}
      />,
      {
        stdin,
        stdout,
        stderr,
        exitOnCtrlC: false,
        patchConsole: true,
        maxFps: 12,
      },
    );

    await this.instance.waitUntilExit();
    this.running = false;
  }

  async stop(): Promise<void> {
    this.running = false;
    const instance = this.instance;
    this.instance = null;
    if (!instance) return;
    instance.unmount();
    await instance.waitUntilExit().catch(() => undefined);
  }

  private async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed === '/quit' || trimmed === '/exit') {
      await this.requestExit();
      return;
    }

    const inbound: InboundMessage = {
      id: `cli-${++this.msgCounter}`,
      senderId: this.senderId,
      text: trimmed,
      timestamp: Date.now(),
    };

    this.store.appendMessage({
      id: `user-${inbound.id}`,
      role: 'user',
      text: trimmed,
      timestamp: inbound.timestamp,
    });
    this.queue.push(inbound);
    this.store.setQueuedCount(this.processing ? this.queue.length : Math.max(0, this.queue.length - 1));
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    this.store.setRunState('working');

    try {
      while (this.queue.length > 0 && this.running) {
        const msg = this.queue.shift()!;
        this.store.setQueuedCount(this.queue.length);
        this.store.setCurrentTools([]);

        for (const handler of this.handlers) {
          try {
            await handler(msg);
          } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[cli] handler error: ${text}\n`);
            this.store.setRunState('error', text);
            this.store.appendMessage({
              id: `err-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              role: 'error',
              text: `处理消息时出错: ${text}`,
              timestamp: Date.now(),
            });
          }
        }
      }
    } finally {
      this.processing = false;
      this.store.setQueuedCount(this.queue.length);
      if (this.running) {
        this.store.setCurrentTools([]);
        this.store.setRunState('idle');
        await this.refreshStatus();
      }
    }
  }

  private async requestExit(): Promise<void> {
    if (!this.running) return;
    this.store.appendMessage({
      id: `bye-${Date.now()}`,
      role: 'system',
      text: '再见.',
      timestamp: Date.now(),
    });
    await this.instance?.waitUntilRenderFlush().catch(() => undefined);
    await this.stop();
  }

  private async refreshStatus(): Promise<void> {
    try {
      const status = await this.getStatus?.();
      if (status) this.store.setRuntimeStatus(status);
    } catch {
      // 状态栏是辅助信息, 失败不影响 CLI 主流程.
    }
  }
}

function roleFor(kind: NonNullable<OutboundMessage['kind']>): CliMessageRole {
  return kind === 'progress' ? 'progress'
    : kind === 'tool_hint' ? 'tool'
      : kind === 'error' ? 'error'
        : 'assistant';
}

function toolHintText(msg: OutboundMessage): string {
  const tools = extractToolNames(msg);
  return tools.length > 0 ? tools.join(', ') : msg.text;
}
