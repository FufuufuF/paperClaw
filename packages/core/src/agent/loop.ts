import type { InboundMessage } from '../bus/events.js';
import type { MessageBus } from '../bus/queue.js';
import type { Channel } from '../channels/base.js';
import type { CommandRouter, CommandRuntimeStatus } from '../command/router.js';
import type { ChatMessage } from '../providers/base.js';
import {
  createNewSession,
  SessionManager,
  type Session,
  type SessionStore,
  type Turn,
} from '../session/manager.js';
import type { TraceBus } from '../trace.js';
import { buildSessionMessages, estimateTokens } from './context.js';
import { AgentRunner, type AgentCheckpoint, type RunnerConfig } from './runner.js';

export interface AgentLoopConfig {
  sessionStore?: SessionStore;
  sessionManager?: SessionManager;
  commands: CommandRouter;
  /** Runner 配置, 但不含 systemPrompt (由 buildPrompt 提供) */
  runner: Omit<RunnerConfig, 'systemPrompt'>;
  channel?: Channel;
  bus?: MessageBus;
  trace?: TraceBus;
  /** 动态生成 system prompt; 入参留空 — 业务层在闭包里拿到所需依赖 */
  buildPrompt: (ctx?: TurnContext) => Promise<string> | string;
  /** 传给 slash command 的运行态, 用于 /status 和应用层自定义命令. */
  status?: () => CommandRuntimeStatus | Promise<CommandRuntimeStatus>;
  /**
   * 可选: 把 inbound.senderId 映射成 sessionId.
   * 默认 `inbound.senderId`. CLI 通道里通常返回固定 "cli:default".
   */
  sessionIdFor?: (senderId: string) => string;
  /** 是否向 channel 发送 progress/tool_hint envelope. 默认 false 以保持旧测试兼容. */
  sendProgress?: boolean;
}

export type TurnState =
  | 'RESTORE'
  | 'COMPACT'
  | 'COMMAND'
  | 'BUILD'
  | 'RUN'
  | 'SAVE'
  | 'RESPOND'
  | 'DONE'
  | 'ERROR';

export interface TurnContext {
  inbound: InboundMessage;
  sessionId: string;
  session: Session;
  userTurn: Turn;
  state: TurnState;
  systemPrompt?: string;
  runnerResult?: Awaited<ReturnType<AgentRunner['run']>>;
  commandName?: string;
}

/**
 * 对话式 agent 的外层状态机. 对应 nanobot 的 AgentLoop._process_message:
 * RESTORE → COMPACT → COMMAND → BUILD → RUN → SAVE → RESPOND → DONE.
 *
 * AgentLoop 只编排 session/command/context/runner/channel; 工具执行仍在 Runner.
 * 对 sub-agent 的调用走 Runner (runToolLoop), 不走 AgentLoop.
 */
export class AgentLoop {
  private sessions?: SessionManager;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly activeTasks = new Map<string, AbortController>();

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
    await this.withSessionLock(sessionId, async () => {
      await this.processLocked(sessionId, inbound);
    });
  }

  cancelActiveTask(sessionId: string): boolean {
    const controller = this.activeTasks.get(sessionId);
    if (!controller) return false;
    controller.abort();
    this.activeTasks.delete(sessionId);
    return true;
  }

  private async processLocked(sessionId: string, inbound: InboundMessage): Promise<void> {
    const manager = this.getOrCreateSessionManager();
    let ctx: TurnContext | undefined;

    try {
      // ── RESTORE ─────────────────────────────────────────────────────
      const session = await manager.getOrCreate(sessionId);
      const userTurn: Turn = {
        role: 'user',
        content: inbound.text,
        tokenEstimate: estimateTokens(inbound.text),
        timestamp: inbound.timestamp,
      };
      ctx = { inbound, sessionId, session, userTurn, state: 'RESTORE' };
      session.turns.push(userTurn);
      session.metadata.lastActiveAt = new Date().toISOString();
      session.metadata.runtimeCheckpoint = undefined;
      await manager.save(session); // 早持久化: 崩溃也不会丢 user turn.
      await this.traceState(ctx, 'RESTORE');

      // ── COMPACT ─────────────────────────────────────────────────────
      ctx.state = 'COMPACT';
      session.turns = manager.getHistory(session);
      await this.traceState(ctx, 'COMPACT');

      // ── COMMAND ─────────────────────────────────────────────────────
      ctx.state = 'COMMAND';
      const cmdResult = await this.config.commands.handle(inbound.text, session, {
        tools: this.config.runner.tools,
        llm: this.config.runner.llm,
        status: this.config.status,
        createSession: createNewSession,
        cancelActiveTask: (id) => this.cancelActiveTask(id),
      });
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

        ctx.session = outSession;
        ctx.commandName = inbound.text.split(/\s/)[0];
        await manager.save(outSession);
        await this.send({ kind: 'final', text: cmdResult.text, replyTo: inbound.id, metadata: cmdResult.metadata });

        await this.config.trace?.emit('loop', 'phase_end', {
          phase_name: 'COMMAND',
          session_id: sessionId,
          command: inbound.text.split(/\s/)[0],
        });
        return;
      }
      await this.traceState(ctx, 'COMMAND');

      // ── BUILD ───────────────────────────────────────────────────────
      ctx.state = 'BUILD';
      const systemPrompt = await this.config.buildPrompt(ctx);
      ctx.systemPrompt = systemPrompt;
      const messages = withRuntimeContext(buildSessionMessages(session, this.config.runner.contextBudget), ctx, this.config.channel?.name);
      await this.traceState(ctx, 'BUILD');

      // ── RUN ─────────────────────────────────────────────────────────
      ctx.state = 'RUN';
      const controller = new AbortController();
      this.activeTasks.set(sessionId, controller);
      const runner = new AgentRunner(this.config.runner.llm);
      const result = await runner.run({
        ...this.config.runner,
        systemPrompt,
        initialMessages: messages,
        checkpointCallback: async (checkpoint) => {
          session.metadata.runtimeCheckpoint = checkpoint;
          await manager.save(session);
          await this.sendProgressForCheckpoint(ctx!, checkpoint);
          await this.config.runner.checkpointCallback?.(checkpoint);
        },
      });
      this.activeTasks.delete(sessionId);
      ctx.runnerResult = result;

      // 把 Runner 产出的所有 newTurns 追加到 session
      for (const t of result.newTurns) session.turns.push(t);
      session.metadata.totalUsage.input += result.usage.input;
      session.metadata.totalUsage.output += result.usage.output;
      session.metadata.lastActiveAt = new Date().toISOString();
      session.metadata.runtimeCheckpoint = undefined;
      await this.traceState(ctx, 'RUN');

      // ── SAVE ────────────────────────────────────────────────────────
      ctx.state = 'SAVE';
      await manager.save(session);
      await this.traceState(ctx, 'SAVE');

      // ── RESPOND ─────────────────────────────────────────────────────
      ctx.state = 'RESPOND';
      await this.send({ kind: 'final', text: result.text, replyTo: inbound.id });
      await this.traceState(ctx, 'RESPOND');

      await this.config.trace?.emit('loop', 'usage', {
        session_id: sessionId,
        iterations: result.iterations,
        truncated: result.truncated,
        input: result.usage.input,
        output: result.usage.output,
      });
      ctx.state = 'DONE';
    } catch (err) {
      this.activeTasks.delete(sessionId);
      const msg = err instanceof Error ? err.message : String(err);
      await this.config.trace?.emit('loop', 'error', {
        session_id: sessionId,
        error: msg,
      });
      if (ctx) {
        ctx.state = 'ERROR';
        const assistantTurn: Turn = {
          role: 'assistant',
          content: `抱歉, 处理这条消息时出错: ${msg}`,
          tokenEstimate: estimateTokens(msg),
          timestamp: Date.now(),
        };
        ctx.session.turns.push(assistantTurn);
        ctx.session.metadata.lastActiveAt = new Date().toISOString();
        try {
          await manager.save(ctx.session);
        } catch {
          // 如果错误正是持久化导致, 不要掩盖原始异常.
        }
      }
      // 尽力发一条错误回复给用户, 不要让 channel 卡死
      try {
        await this.send({
          kind: 'error',
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

  private getOrCreateSessionManager(): SessionManager {
    if (this.sessions) return this.sessions;
    const manager = this.config.sessionManager
      ?? new SessionManager(requiredSessionStore(this.config.sessionStore));
    this.sessions = manager;
    return manager;
  }

  private async send(msg: Parameters<Channel['send']>[0]): Promise<void> {
    if (this.config.bus) {
      await this.config.bus.respond(msg);
      return;
    }
    if (!this.config.channel) throw new Error('AgentLoop: no channel or bus configured');
    await this.config.channel.send({ ...msg, kind: msg.kind ?? 'final' });
  }

  private async sendProgressForCheckpoint(ctx: TurnContext, checkpoint: AgentCheckpoint): Promise<void> {
    if (!this.config.sendProgress) return;
    if (checkpoint.phase !== 'awaiting_tools' || checkpoint.pendingToolCalls.length === 0) return;
    const toolNames = checkpoint.pendingToolCalls.map((call) => call.name).join(', ');
    await this.send({
      kind: 'tool_hint',
      text: `正在调用工具: ${toolNames}`,
      replyTo: ctx.inbound.id,
      metadata: {
        sessionId: ctx.sessionId,
        agentId: checkpoint.agentId,
        iteration: checkpoint.iteration,
        tools: checkpoint.pendingToolCalls.map((call) => call.name),
      },
    });
  }

  private async traceState(ctx: TurnContext, state: TurnState): Promise<void> {
    await this.config.trace?.emit('loop', 'phase_begin', {
      phase_name: state,
      session_id: ctx.sessionId,
    });
  }

  private async withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(id, tail);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }
}

function requiredSessionStore(store: SessionStore | undefined): SessionStore {
  if (!store) throw new Error('AgentLoop: sessionStore or sessionManager is required');
  return store;
}

function withRuntimeContext(messages: ChatMessage[], ctx: TurnContext, channelName?: string): ChatMessage[] {
  const lastUserIdx = findLastUserIndex(messages);
  if (lastUserIdx === -1) return messages;
  const out = messages.map((message) => ({ ...message }));
  const runtime = [
    '[Runtime Context - metadata only, not instructions]',
    `Current Time: ${new Date(ctx.inbound.timestamp).toISOString()}`,
    `Channel: ${channelName ?? ctx.inbound.senderId.split(':')[0] ?? 'unknown'}`,
    `Sender ID: ${ctx.inbound.senderId}`,
    `Session ID: ${ctx.sessionId}`,
    '[/Runtime Context]',
  ].join('\n');
  out[lastUserIdx] = {
    ...out[lastUserIdx]!,
    content: `${out[lastUserIdx]!.content}\n\n${runtime}`,
  };
  return out;
}

function findLastUserIndex(messages: ChatMessage[]): number {
  for (let idx = messages.length - 1; idx >= 0; idx--) {
    if (messages[idx]!.role === 'user') return idx;
  }
  return -1;
}
