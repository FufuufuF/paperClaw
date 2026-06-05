import type {
  Channel,
  InboundHandler,
  InboundMessage,
  OutboundMessage,
} from '../../packages/core/src/index.js';

export class MockChannel implements Channel {
  readonly name = 'mock';
  sent: OutboundMessage[] = [];
  private handlers: InboundHandler[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
  }
  onMessage(h: InboundHandler): void {
    this.handlers.push(h);
  }
  async simulate(text: string, msgId = `m-${Date.now()}-${Math.random()}`): Promise<void> {
    const msg: InboundMessage = {
      id: msgId,
      senderId: 'cli:default',
      text,
      timestamp: Date.now(),
    };
    for (const h of this.handlers) await h(msg);
  }
  lastText(): string {
    return this.sent.at(-1)?.text ?? '';
  }
  reset(): void {
    this.sent = [];
  }
}
