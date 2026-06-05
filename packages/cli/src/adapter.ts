import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline/promises';
import type {
  Channel,
  InboundHandler,
  InboundMessage,
  OutboundMessage,
} from '@paperclaw/core';

/**
 * 基于 readline 的 CLI Channel.
 *
 * 行为:
 *  - 启动时打印欢迎语
 *  - 用 "> " 提示符等待输入
 *  - 空行跳过
 *  - /quit 或 /exit 退出 (立即, 不经 agent loop)
 *  - 收到输入 → 包装为 InboundMessage → 串行调用所有 handler → 等下一条
 *  - 处理过程中如果再来输入会被排队 (readline 自然行为)
 *
 * 注意: agent 处理消息时 stdin 不暂停 — 用户可以提前打字, 我们只是按行处理.
 */
export class CLIChannel implements Channel {
  readonly name = 'cli';
  private readonly handlers: InboundHandler[] = [];
  private rl: readline.Interface | null = null;
  private running = false;
  private msgCounter = 0;
  private readonly senderId: string;
  private readonly welcome: string;
  private readonly prompt: string;

  constructor(opts: { senderId?: string; welcome?: string; prompt?: string } = {}) {
    this.senderId = opts.senderId ?? 'cli:default';
    this.welcome = opts.welcome ?? defaultWelcome();
    this.prompt = opts.prompt ?? '> ';
  }

  onMessage(handler: InboundHandler): void {
    this.handlers.push(handler);
  }

  async send(msg: OutboundMessage): Promise<void> {
    // CLI 简单直出. 给一个 "clawbot:" 前缀让用户看清是 bot 在说话.
    const lines = msg.text.split('\n');
    const padded = lines.map((l, i) => (i === 0 ? `clawbot: ${l}` : `         ${l}`));
    stdout.write(padded.join('\n') + '\n');
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    stdout.write(this.welcome + '\n');

    while (this.running) {
      let input: string;
      try {
        input = await this.rl.question(this.prompt);
      } catch {
        // SIGINT / closed
        break;
      }
      const text = input.trim();
      if (!text) continue;
      if (text === '/quit' || text === '/exit') {
        stdout.write('再见.\n');
        break;
      }

      const msg: InboundMessage = {
        id: `cli-${++this.msgCounter}`,
        senderId: this.senderId,
        text,
        timestamp: Date.now(),
      };

      // 串行调度所有 handler. 处理失败时 (handler 自己已 trace + send), 这里
      // 仅 log 一行 stderr 让用户知道发生了, 不让 CLI 整体退出.
      for (const h of this.handlers) {
        try {
          await h(msg);
        } catch (err) {
          process.stderr.write(
            `[cli] handler error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }

    await this.stop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.rl?.close();
    this.rl = null;
  }
}

function defaultWelcome(): string {
  return [
    'clawbot CLI — 输入消息开始对话, /help 查看命令, /quit 退出.',
    '',
  ].join('\n');
}
