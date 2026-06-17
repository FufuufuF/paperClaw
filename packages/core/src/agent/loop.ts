import { performance } from 'node:perf_hooks';
import type { InboundMessage, OutboundMessage } from '../bus/events.js';
import type { MessageBus } from '../bus/queue.js';
import type { Channel } from '../channels/base.js';
import type { CommandResult, CommandRouter, CommandRuntimeStatus } from '../command/router.js';
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
import type { AutoCompact } from './autocompact.js';
import { getLastSessionSummary, sessionReplayView } from './consolidator.js';
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
  /** Optional app-level factory for commands that create a fresh session id. */
  createSessionId?: (name?: string) => {
    id: string;
    sessionName?: string;
    uid?: string;
    channel?: string;
  } | Promise<{
    id: string;
    sessionName?: string;
    uid?: string;
    channel?: string;
  }>;
  /** Optional hook used by session commands such as /new and /switch. */
  switchSession?: (sessionId: string) => void | Promise<void>;
  /** Optional idle-session compactor. It must never mutate persisted turns. */
  autoCompact?: AutoCompact;
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

export type TurnStateEvent = 'ok' | 'dispatch' | 'shortcut';

export interface StateTraceEntry {
  state: TurnState;
  startedAt: number;
  durationMs: number;
  event: TurnStateEvent | '';
  error?: string;
}

export interface TurnContext {
  inbound: InboundMessage;
  sessionId: string;
  state: TurnState;
  session?: Session;
  userTurn?: Turn;
  systemPrompt?: string;
  sessionSummary?: string;
  runnerResult?: Awaited<ReturnType<AgentRunner['run']>>;
  commandName?: string;
  commandResult?: CommandResult;
  messages?: ChatMessage[];
  outbound?: OutboundMessage;
  trace: StateTraceEntry[];
}

/**
 * 对话式 agent 的外层状态机. 对应 nanobot 的 AgentLoop._process_message:
 * RESTORE → COMPACT → COMMAND → BUILD → RUN → SAVE → RESPOND → DONE.
 *
 * AgentLoop 只编排 session/command/context/runner/channel; 工具执行仍在 Runner.
 * 对 sub-agent 的调用走 Runner (runToolLoop), 不走 AgentLoop.
 */
export class AgentLoop {
  private static readonly TRANSITIONS: Record<string, TurnState> = {
    'RESTORE:ok': 'COMPACT',
    'COMPACT:ok': 'COMMAND',
    'COMMAND:dispatch': 'BUILD',
    'COMMAND:shortcut': 'DONE',
    'BUILD:ok': 'RUN',
    'RUN:ok': 'SAVE',
    'SAVE:ok': 'RESPOND',
    'RESPOND:ok': 'DONE',
  };

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

  getBusySessionIds(): string[] {
    return Array.from(new Set([...this.activeTasks.keys(), ...this.locks.keys()]));
  }

  private async processLocked(sessionId: string, inbound: InboundMessage): Promise<void> {
    const manager = this.getOrCreateSessionManager();
    const ctx: TurnContext = {
      inbound,
      sessionId,
      state: 'RESTORE',
      trace: [],
    };

    try {
      await this.runStateMachine(ctx, manager);
    } catch (err) {
      this.activeTasks.delete(sessionId);
      const msg = err instanceof Error ? err.message : String(err);
      await this.config.trace?.emit('loop', 'error', {
        session_id: sessionId,
        error: msg,
      });
      ctx.state = 'ERROR';
      if (ctx.session) {
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

  private async runStateMachine(ctx: TurnContext, manager: SessionManager): Promise<void> {
    while (ctx.state !== 'DONE') {
      const state = ctx.state;
      const startedAt = performance.now();
      let event: TurnStateEvent | '' = '';

      await this.config.trace?.emit('loop', 'phase_begin', {
        phase_name: state,
        session_id: ctx.sessionId,
      });

      try {
        event = await this.runStateHandler(ctx, manager);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.recordStateTrace(ctx, {
          state,
          startedAt,
          event: '',
          error: msg,
        });
        throw err;
      }

      await this.recordStateTrace(ctx, { state, startedAt, event });
      ctx.state = this.nextState(state, event);
    }
  }

  private async runStateHandler(ctx: TurnContext, manager: SessionManager): Promise<TurnStateEvent> {
    switch (ctx.state) {
      case 'RESTORE':
        return await this.stateRestore(ctx, manager);
      case 'COMPACT':
        return await this.stateCompact(ctx);
      case 'COMMAND':
        return await this.stateCommand(ctx, manager);
      case 'BUILD':
        return await this.stateBuild(ctx);
      case 'RUN':
        return await this.stateRun(ctx, manager);
      case 'SAVE':
        return await this.stateSave(ctx, manager);
      case 'RESPOND':
        return await this.stateRespond(ctx);
      case 'DONE':
      case 'ERROR':
        throw new Error(`AgentLoop: cannot run terminal state ${ctx.state}`);
    }
  }

  private async stateRestore(ctx: TurnContext, manager: SessionManager): Promise<TurnStateEvent> {
    let session = await manager.getOrCreate(ctx.sessionId);
    const prepared = await this.config.autoCompact?.prepareSession(session, ctx.sessionId);
    if (prepared) {
      session = prepared.session;
    }
    const sessionSummary = prepared?.summary ?? getLastSessionSummary(session)?.text;
    const userTurn: Turn = {
      role: 'user',
      content: ctx.inbound.text,
      tokenEstimate: estimateTokens(ctx.inbound.text),
      timestamp: ctx.inbound.timestamp,
    };

    ctx.session = session;
    ctx.userTurn = userTurn;
    ctx.sessionSummary = sessionSummary;

    session.turns.push(userTurn);
    session.metadata.lastActiveAt = new Date().toISOString();
    session.metadata.runtimeCheckpoint = undefined;
    await manager.save(session); // 早持久化: 崩溃也不会丢 user turn.
    return 'ok';
  }

  private async stateCompact(_ctx: TurnContext): Promise<TurnStateEvent> {
    return 'ok';
  }

  private async stateCommand(ctx: TurnContext, manager: SessionManager): Promise<TurnStateEvent> {
    const session = requiredSession(ctx);
    const userTurn = requiredUserTurn(ctx);
    const cmdResult = await this.config.commands.handle(ctx.inbound.text, session, {
      tools: this.config.runner.tools,
      llm: this.config.runner.llm,
      status: this.config.status,
      createSession: createNewSession,
      createSessionId: this.config.createSessionId,
      cancelActiveTask: (id) => this.cancelActiveTask(id),
    });

    if (!cmdResult) return 'dispatch';

    const commandName = ctx.inbound.text.split(/\s/)[0] ?? ctx.inbound.text;
    userTurn.command = commandName;
    ctx.commandName = commandName;
    ctx.commandResult = cmdResult;

    // shortcut: 不走 LLM. 把 user turn + assistant turn 都记下来.
    const assistantTurn: Turn = {
      role: 'assistant',
      content: cmdResult.text,
      command: commandName,
      tokenEstimate: estimateTokens(cmdResult.text),
      timestamp: Date.now(),
    };

    let outSession = session;
    if (cmdResult.mutatedSession && cmdResult.mutatedSession.id !== session.id && cmdResult.switchSessionId) {
      session.turns.push(assistantTurn);
      session.metadata.lastActiveAt = new Date().toISOString();
      await manager.save(session);
      await manager.save(cmdResult.mutatedSession);
      outSession = cmdResult.mutatedSession;
    } else if (cmdResult.mutatedSession) {
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
    if (!(cmdResult.mutatedSession && cmdResult.mutatedSession.id !== session.id && cmdResult.switchSessionId)) {
      await manager.save(outSession);
    }
    if (cmdResult.switchSessionId) {
      await this.config.switchSession?.(cmdResult.switchSessionId);
    }
    const metadata = cmdResult.uiIntent
      ? { ...cmdResult.metadata, uiIntent: cmdResult.uiIntent }
      : cmdResult.metadata;
    ctx.outbound = { kind: 'final', text: cmdResult.text, replyTo: ctx.inbound.id, metadata };
    await this.send(ctx.outbound);
    return 'shortcut';
  }

  private async stateBuild(ctx: TurnContext): Promise<TurnStateEvent> {
    const session = requiredSession(ctx);
    const systemPrompt = await this.config.buildPrompt(ctx);
    ctx.systemPrompt = systemPrompt;
    ctx.messages = withRuntimeContext(
      buildSessionMessages(sessionReplayView(session), this.config.runner.contextBudget),
      ctx,
      this.config.channel?.name,
    );
    return 'ok';
  }

  private async stateRun(ctx: TurnContext, manager: SessionManager): Promise<TurnStateEvent> {
    const session = requiredSession(ctx);
    const systemPrompt = requiredValue(ctx.systemPrompt, 'systemPrompt');
    const messages = requiredValue(ctx.messages, 'messages');
    const controller = new AbortController();
    this.activeTasks.set(ctx.sessionId, controller);
    try {
      const runner = new AgentRunner(this.config.runner.llm);
      ctx.runnerResult = await runner.run({
        ...this.config.runner,
        systemPrompt,
        initialMessages: messages,
        checkpointCallback: async (checkpoint) => {
          session.metadata.runtimeCheckpoint = checkpoint;
          await manager.save(session);
          await this.sendProgressForCheckpoint(ctx, checkpoint);
          await this.config.runner.checkpointCallback?.(checkpoint);
        },
      });
      return 'ok';
    } finally {
      this.activeTasks.delete(ctx.sessionId);
    }
  }

  private async stateSave(ctx: TurnContext, manager: SessionManager): Promise<TurnStateEvent> {
    const session = requiredSession(ctx);
    const result = requiredValue(ctx.runnerResult, 'runnerResult');

    // 把 Runner 产出的所有 newTurns 追加到 session
    for (const t of result.newTurns) session.turns.push(t);
    session.metadata.totalUsage.input += result.usage.input;
    session.metadata.totalUsage.output += result.usage.output;
    session.metadata.lastActiveAt = new Date().toISOString();
    session.metadata.runtimeCheckpoint = undefined;
    await manager.save(session);
    return 'ok';
  }

  private async stateRespond(ctx: TurnContext): Promise<TurnStateEvent> {
    const result = requiredValue(ctx.runnerResult, 'runnerResult');
    await this.send({ kind: 'final', text: result.text, replyTo: ctx.inbound.id });
    await this.config.trace?.emit('loop', 'usage', {
      session_id: ctx.sessionId,
      iterations: result.iterations,
      truncated: result.truncated,
      input: result.usage.input,
      output: result.usage.output,
    });
    return 'ok';
  }

  private nextState(state: TurnState, event: TurnStateEvent): TurnState {
    const next = AgentLoop.TRANSITIONS[`${state}:${event}`];
    if (!next) {
      throw new Error(`AgentLoop: no transition from ${state} on event "${event}"`);
    }
    return next;
  }

  private async recordStateTrace(
    ctx: TurnContext,
    entry: {
      state: TurnState;
      startedAt: number;
      event: TurnStateEvent | '';
      error?: string;
    },
  ): Promise<void> {
    const durationMs = performance.now() - entry.startedAt;
    ctx.trace.push({
      state: entry.state,
      startedAt: entry.startedAt,
      durationMs,
      event: entry.event,
      ...(entry.error ? { error: entry.error } : {}),
    });
    await this.config.trace?.emit('loop', entry.error ? 'error' : 'phase_end', {
      phase_name: entry.state,
      session_id: ctx.sessionId,
      event: entry.event,
      duration_ms: durationMs,
      ...(ctx.commandName ? { command: ctx.commandName } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    });
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

function requiredSession(ctx: TurnContext): Session {
  if (!ctx.session) throw new Error(`AgentLoop: state ${ctx.state} requires session`);
  return ctx.session;
}

function requiredUserTurn(ctx: TurnContext): Turn {
  if (!ctx.userTurn) throw new Error(`AgentLoop: state ${ctx.state} requires userTurn`);
  return ctx.userTurn;
}

function requiredValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`AgentLoop: missing ${name}`);
  return value;
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
