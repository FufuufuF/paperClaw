import type { Channel } from '../channels/base.js';
import type { InboundMessage, OutboundMessage } from './events.js';

/**
 * 消息总线 — 解耦 Channel 和 AgentLoop. 对齐 nanobot 的 `bus/queue.py`.
 */
export class MessageBus {
  private channel: Channel | null = null;
  private waiters: Array<(msg: InboundMessage) => void> = [];
  private buffer: InboundMessage[] = [];
  private handlers: Array<(msg: InboundMessage) => Promise<void>> = [];
  private outboundHandlers: Array<(msg: OutboundMessage) => Promise<void> | void> = [];

  attach(channel: Channel): void {
    this.channel = channel;
    channel.onMessage(async (msg) => {
      // 1. 喂给所有注册过的 handler
      for (const h of this.handlers) {
        await h(msg);
      }
      // 2. 唤醒一个 nextMessage waiter (FIFO)
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.buffer.push(msg);
    });
  }

  /** Channel 适配器内部直接灌消息 (测试 / mock 用) */
  pushInbound(msg: InboundMessage): void {
    for (const h of this.handlers) void h(msg);
    const w = this.waiters.shift();
    if (w) w(msg);
    else this.buffer.push(msg);
  }

  /** 主动 await 一条消息 (一次性 — 解决后再调一次拿下一条) */
  nextMessage(): Promise<InboundMessage> {
    const buffered = this.buffer.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise<InboundMessage>((resolve) => this.waiters.push(resolve));
  }

  /** AgentLoop 注册回调风格 handler */
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handlers.push(handler);
  }

  /** 测试或 rich channel 可订阅 outbound envelope, 不影响实际发送. */
  onOutbound(handler: (msg: OutboundMessage) => Promise<void> | void): void {
    this.outboundHandlers.push(handler);
  }

  /** 把回复路由到当前 channel */
  async respond(msg: OutboundMessage): Promise<void> {
    if (!this.channel) throw new Error('MessageBus: no channel attached');
    const outbound = { ...msg, kind: msg.kind ?? 'final' };
    for (const handler of this.outboundHandlers) await handler(outbound);
    await this.channel.send(outbound);
  }
}
