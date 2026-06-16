import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline/promises';
import type {
  Channel,
  InboundHandler,
  InboundMessage,
  OutboundMessage,
  Session,
  Turn,
  CommandUiIntent,
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
  private readonly loadSession?: CLIChannelOpts['loadSession'];

  constructor(opts: CLIChannelOpts = {}) {
    this.senderId = opts.senderId ?? 'cli:default';
    this.getStatus = opts.getStatus;
    this.loadSession = opts.loadSession;
  }

  onMessage(handler: InboundHandler): void {
    this.handlers.push(handler);
  }

  async send(msg: OutboundMessage): Promise<void> {
    const output = renderPlainMessage(msg);
    if (output) stdout.write(output);
    const uiIntent = parseUiIntent(msg.metadata?.uiIntent);
    if (uiIntent?.kind === 'restore_session_history') {
      const restored = await this.renderRestoredHistory(uiIntent.sessionId);
      if (restored) stdout.write(restored);
    }
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

  private async renderRestoredHistory(sessionId: string): Promise<string> {
    if (!this.loadSession) return '';
    const session = await this.loadSession(sessionId);
    if (!session) return '';
    const turns = session.turns.filter(isVisibleTurn).slice(-12);
    const lines = [`history: 已恢复 session: ${displaySessionName(session)}`];
    for (const turn of turns) {
      const prefix = turn.role === 'user' ? 'you' : 'clawbot';
      const text = turn.content.replace(/\n+/g, '\n');
      const split = text.split('\n');
      const pad = ' '.repeat(prefix.length);
      split.forEach((line, idx) => {
        lines.push(idx === 0 ? `${prefix}: ${line}` : `${pad}  ${line}`);
      });
    }
    return lines.join('\n') + '\n';
  }
}

function parseUiIntent(value: unknown): CommandUiIntent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const intent = value as { kind?: unknown; sessionId?: unknown };
  if (intent.kind === 'session_picker') return { kind: 'session_picker' };
  if (intent.kind === 'restore_session_history' && typeof intent.sessionId === 'string') {
    return { kind: 'restore_session_history', sessionId: intent.sessionId };
  }
  return undefined;
}

function isVisibleTurn(turn: Turn): boolean {
  return (
    (turn.role === 'user' || turn.role === 'assistant') &&
    !turn.command &&
    !turn.content.trim().startsWith('/')
  );
}

function displaySessionName(session: Session): string {
  return session.metadata.sessionName || session.id;
}
