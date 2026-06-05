import type { InboundMessage } from '../bus/events.js';
import type { Channel } from '../channels/base.js';
import type { CommandRouter } from '../command/router.js';
import { createNewSession, type Session, type SessionStore, type Turn } from '../session/manager.js';
import type { TraceBus } from '../trace.js';
import { buildMessages, estimateTokens } from './context.js';
import { runToolLoop, type RunnerConfig } from './runner.js';

export interface AgentLoopConfig {
  sessionStore: SessionStore;
  commands: CommandRouter;
  /** Runner 配置, 但不含 systemPrompt (由 buildPrompt 提供) */
  runner: Omit<RunnerConfig, 'systemPrompt'>;
  channel: Channel;
  trace?: TraceBus;
  /** 动态生成 system prompt; 入参留空 — 业务层在闭包里拿到所需依赖 */
  buildPrompt: () => Promise<string> | string;
  /**
   * 可选: 把 inbound.senderId 映射成 sessionId.
   * 默认 `inbound.senderId`. CLI 通道里通常返回固定 "cli:default".
   */
  sessionIdFor?: (senderId: string) => string;
}

/**
 * 对话式 agent 的外层状态机. 对应 nanobot 的 AgentLoop._process_message,
 * 但只保留 5 个状态 (RESTORE → COMMAND → BUILD → RUN → RESPOND).
 *
 * 使用方式 (典型):
 *
 *   const loop = new AgentLoop(config);
 *   channel.onMessage(msg => loop.processMessage(msg));
 *
 * 注: AgentLoop 不直接持有 channel state — 它通过 config.channel.send 回复.
 * 对 sub-agent 的调用走 Runner (runToolLoop), 不走 AgentLoop.
 */
export class AgentLoop {
  constructor(private readonly config: AgentLoopConfig) {}

  /**
   * 处理一条用户消息的完整生命周期. 串行调用安全
   * (AgentLoop 自身无可变状态, 状态都在 Session 文件里).
   *
   * 即便内部抛错, 也会尽力 channel.send 一条错误回复, 不让 channel 静默挂掉.
   */
  async processMessage(inbound: InboundMessage): Promise<void> {
    const sessionId = this.config.sessionIdFor
      ? this.config.sessionIdFor(inbound.senderId)
      : inbound.senderId;
    let session: Session;

    try {
      // ── RESTORE ─────────────────────────────────────────────────────
      session = (await this.config.sessionStore.load(sessionId)) ?? createNewSession(sessionId);
      const userTurn: Turn = {
        role: 'user',
        content: inbound.text,
        tokenEstimate: estimateTokens(inbound.text),
        timestamp: inbound.timestamp,
      };
      session.turns.push(userTurn);
      session.metadata.lastActiveAt = new Date().toISOString();

      // ── COMMAND ─────────────────────────────────────────────────────
      const cmdResult = await this.config.commands.handle(inbound.text, session);
      if (cmdResult) {
        // shortcut: 不走 LLM. 把 user turn + assistant turn 都记下来.
        const assistantTurn: Turn = {
          role: 'assistant',
          content: cmdResult.text,
          tokenEstimate: estimateTokens(cmdResult.text),
          timestamp: Date.now(),
        };

        let outSession = session;
        if (cmdResult.mutatedSession) {
          // /clear 这类命令返回新 session — 用它替换当前的. 但 userTurn
          // 之前已经 push 进旧 session 了, 新 session 里没有 — 我们把它
          // 补进去, 让 transcript 仍然显示 "user 输入了 /clear".
          outSession = cmdResult.mutatedSession;
          outSession.turns.push(userTurn, assistantTurn);
        } else {
          outSession.turns.push(assistantTurn);
        }
        outSession.metadata.lastActiveAt = new Date().toISOString();

        await this.config.sessionStore.save(outSession);
        await this.config.channel.send({ text: cmdResult.text, replyTo: inbound.id });

        await this.config.trace?.emit('loop', 'phase_end', {
          phase_name: 'COMMAND',
          session_id: sessionId,
          command: inbound.text.split(/\s/)[0],
        });
        return;
      }

      // ── BUILD ───────────────────────────────────────────────────────
      const systemPrompt = await this.config.buildPrompt();
      const messages = buildMessages(session, this.config.runner.contextBudget);

      // ── RUN ─────────────────────────────────────────────────────────
      const result = await runToolLoop(
        { ...this.config.runner, systemPrompt },
        messages,
      );

      // 把 Runner 产出的所有 newTurns 追加到 session
      for (const t of result.newTurns) session.turns.push(t);
      session.metadata.totalUsage.input += result.usage.input;
      session.metadata.totalUsage.output += result.usage.output;
      session.metadata.lastActiveAt = new Date().toISOString();

      // ── RESPOND ─────────────────────────────────────────────────────
      await this.config.sessionStore.save(session);
      await this.config.channel.send({ text: result.text, replyTo: inbound.id });

      await this.config.trace?.emit('loop', 'usage', {
        session_id: sessionId,
        iterations: result.iterations,
        truncated: result.truncated,
        input: result.usage.input,
        output: result.usage.output,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.config.trace?.emit('loop', 'error', {
        session_id: sessionId,
        error: msg,
      });
      // 尽力发一条错误回复给用户, 不要让 channel 卡死
      try {
        await this.config.channel.send({
          text: `抱歉, 处理这条消息时出错: ${msg}`,
          replyTo: inbound.id,
        });
      } catch {
        // channel 也挂了 — 已经记 trace, 让上层自己处理
      }
      // 重抛: 由 channel/main 决定要不要 crash
      throw err;
    }
  }
}
