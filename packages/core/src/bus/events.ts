/**
 * Bus event types — nanobot 对应 `bus/events.py`.
 * Channel adapter 把平台消息规范化为 InboundMessage, AgentLoop 产生 OutboundMessage.
 */

export interface InboundMessage {
  /** 唯一消息 id (用于回执 / replyTo) */
  id: string;
  /** 频道侧的发送者 id. 也用作 session id, 例如 "cli:default" / "feishu:user_123" */
  senderId: string;
  text: string;
  /** unix ms */
  timestamp: number;
}

export interface OutboundMessage {
  text: string;
  /** 引用哪条用户消息 (channel 决定如何渲染) */
  replyTo?: string;
  /** 任意结构化数据, 给 rich-render 通道用 (CLI 忽略) */
  data?: unknown;
}

export type InboundHandler = (msg: InboundMessage) => Promise<void>;
