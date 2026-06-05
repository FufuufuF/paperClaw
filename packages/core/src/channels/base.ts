import type { InboundHandler, OutboundMessage } from '../bus/events.js';

/**
 * Channel 抽象 — 把 "用户输入/输出" 的具体载体 (CLI / 飞书 / Web) 和
 * AgentLoop 解耦. 对应 nanobot 的 `channels/base.py`.
 */
export interface Channel {
  readonly name: string;
  /** 启动 (打开 stdin / 建立 WebSocket / etc). 可能 block 直到关闭. */
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  onMessage(handler: InboundHandler): void;
}
