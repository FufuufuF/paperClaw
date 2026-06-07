import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Channel } from './base.js';
import type { InboundHandler, InboundMessage, OutboundMessage } from '../bus/events.js';

export interface FeishuChannelOpts {
  port?: number;
  host?: string;
  path?: string;
  verifyToken?: string;
  allowedSenderIds?: string[];
  sendWebhookUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface FeishuNormalizeResult {
  message: InboundMessage | null;
  challenge?: string;
  ignored?: string;
}

/**
 * Minimal Feishu/Lark webhook channel.
 *
 * It supports event callbacks for inbound text and optional custom-bot webhook
 * sending for outbound text. Rich cards can be layered later through
 * OutboundMessage.data without changing AgentLoop.
 */
export class FeishuChannel implements Channel {
  readonly name = 'feishu';
  private readonly handlers: InboundHandler[] = [];
  private readonly sent: OutboundMessage[] = [];
  private server: Server | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly path: string;
  private readonly allowedSenderIds: Set<string> | null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: FeishuChannelOpts = {}) {
    this.port = opts.port ?? 8787;
    this.host = opts.host ?? '0.0.0.0';
    this.path = opts.path ?? '/feishu/events';
    this.allowedSenderIds = opts.allowedSenderIds && opts.allowedSenderIds.length > 0
      ? new Set(opts.allowedSenderIds)
      : null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  onMessage(handler: InboundHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
    if (!this.opts.sendWebhookUrl) return;
    const res = await this.fetchImpl(this.opts.sendWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toFeishuTextPayload(msg)),
    });
    if (!res.ok) {
      throw new Error(`Feishu send failed: HTTP ${res.status}`);
    }
  }

  getSentMessages(): OutboundMessage[] {
    return this.sent.slice();
  }

  normalizeEvent(body: unknown): FeishuNormalizeResult {
    return normalizeFeishuEvent(body, {
      verifyToken: this.opts.verifyToken,
      allowedSenderIds: this.allowedSenderIds,
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== this.path) {
      writeJson(res, 404, { error: 'not found' });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      writeJson(res, 400, { error: 'invalid json' });
      return;
    }

    const normalized = this.normalizeEvent(body);
    if (normalized.challenge) {
      writeJson(res, 200, { challenge: normalized.challenge });
      return;
    }
    if (normalized.ignored === 'token_mismatch') {
      writeJson(res, 403, { error: 'token mismatch' });
      return;
    }
    if (!normalized.message) {
      writeJson(res, 200, { ok: true, ignored: normalized.ignored ?? true });
      return;
    }

    for (const handler of this.handlers) {
      await handler(normalized.message);
    }
    writeJson(res, 200, { ok: true });
  }
}

export function normalizeFeishuEvent(
  body: unknown,
  opts: { verifyToken?: string; allowedSenderIds?: Set<string> | null } = {},
): FeishuNormalizeResult {
  const event = body as Record<string, unknown>;
  const token = stringAt(event, ['token']);
  if (opts.verifyToken && token !== opts.verifyToken) {
    return { message: null, ignored: 'token_mismatch' };
  }
  const challenge = stringAt(event, ['challenge']);
  if (challenge) return { message: null, challenge };

  const messageId =
    stringAt(event, ['event', 'message', 'message_id']) ??
    stringAt(event, ['event', 'message', 'open_message_id']) ??
    `feishu-${Date.now()}`;
  const senderId =
    stringAt(event, ['event', 'sender', 'sender_id', 'user_id']) ??
    stringAt(event, ['event', 'sender', 'sender_id', 'open_id']) ??
    stringAt(event, ['event', 'sender', 'sender_id', 'union_id']) ??
    stringAt(event, ['event', 'message', 'chat_id']);
  if (!senderId) return { message: null, ignored: 'missing_sender' };
  if (opts.allowedSenderIds && !opts.allowedSenderIds.has(senderId)) {
    return { message: null, ignored: 'sender_not_allowed' };
  }

  const text = extractFeishuText(event);
  if (!text) return { message: null, ignored: 'non_text_message' };
  return {
    message: {
      id: messageId,
      senderId: `feishu:${senderId}`,
      text,
      timestamp: parseFeishuTimestamp(event),
    },
  };
}

export function toFeishuTextPayload(msg: OutboundMessage): Record<string, unknown> {
  const prefix =
    msg.kind === 'progress' ? '[progress] ' :
    msg.kind === 'tool_hint' ? '[tool] ' :
    msg.kind === 'error' ? '[error] ' :
    '';
  return {
    msg_type: 'text',
    content: {
      text: `${prefix}${msg.text}`,
    },
  };
}

function extractFeishuText(event: Record<string, unknown>): string | null {
  const raw = stringAt(event, ['event', 'message', 'content']);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.text === 'string') return parsed.text.trim();
  } catch {
    return raw.trim();
  }
  return null;
}

function parseFeishuTimestamp(event: Record<string, unknown>): number {
  const raw =
    stringAt(event, ['event', 'message', 'create_time']) ??
    stringAt(event, ['event', 'message', 'update_time']);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : Date.now();
}

function stringAt(value: unknown, path: string[]): string | undefined {
  let cur = value;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : undefined;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
