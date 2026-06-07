/**
 * 离线 smoke 测试: 用 mock LLMClient 跑通 AgentLoop 全部 5 个状态.
 * 不需要 DEEPSEEK_API_KEY, 不发任何网络请求.
 *
 * 运行: pnpm test:chat
 */
import { join } from 'node:path';
import {
  AgentLoop,
  buildBasePrompt,
  CommandRouter,
  FileSessionStore,
  registerBuiltinCommands,
  ToolRegistry,
  addTool,
  bigTool,
  echoTool,
  multiplyTool,
} from '../../packages/core/src/index.js';
import { assert, MockChannel, MockLLM, withTempDir } from '../fixtures/index.js';

interface Harness {
  loop: AgentLoop;
  channel: MockChannel;
  llm: MockLLM;
  tools: ToolRegistry;
  sessionStore: FileSessionStore;
  commands: CommandRouter;
}

async function makeHarness(dir: string): Promise<Harness> {
  const tools = new ToolRegistry();
  for (const t of [echoTool, addTool, multiplyTool, bigTool]) tools.register(t);
  const sessionStore = new FileSessionStore(join(dir, 'sessions'));
  const commands = new CommandRouter();
  registerBuiltinCommands(commands, { tools, sessionStore });
  const channel = new MockChannel();
  const llm = new MockLLM();
  const loop = new AgentLoop({
    sessionStore,
    commands,
    runner: {
      tools,
      llm,
      maxIterations: 10,
      contextBudget: 4000,
      agentId: 'master',
    },
    channel,
    buildPrompt: () => buildBasePrompt(tools),
    sessionIdFor: () => 'cli:default',
  });
  channel.onMessage((m) => loop.processMessage(m));
  return { loop, channel, llm, tools, sessionStore, commands };
}

// ─── AC-1: basic chat (no tool call) ─────────────────────────────────────
async function testBasicChat(): Promise<void> {
  console.log('\n── AC-1: basic chat ──');
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    h.llm.enqueue({ text: '你好! 我是 clawbot.', usage: { input: 50, output: 20 } });
    await h.channel.simulate('你好');
    assert(h.channel.sent.length === 1, '单条回复');
    assert(h.channel.lastText().includes('clawbot'), '回复包含 clawbot');

    // 第二轮: messages 应当带上前一轮的 user + assistant
    h.llm.enqueue({ text: '1+1=2.', usage: { input: 60, output: 10 } });
    await h.channel.simulate('1+1 等于几?');
    const lastRoles = h.llm.receivedMessageRoles.at(-1)!;
    assert(lastRoles.length === 3, `第二轮带 3 条历史 (got ${lastRoles.length})`);
    assert(lastRoles[0] === 'user' && lastRoles[1] === 'assistant' && lastRoles[2] === 'user', '历史 roles 顺序对');

    // session usage 累计
    const session = await h.sessionStore.load('cli:default');
    assert(session !== null, 'session 已持久化');
    assert(session!.metadata.totalUsage.input === 110, `input 110 (got ${session!.metadata.totalUsage.input})`);
    assert(session!.metadata.totalUsage.output === 30, `output 30 (got ${session!.metadata.totalUsage.output})`);
  });
}

// ─── AC-2: tool 注册与调用 ───────────────────────────────────────────────
async function testToolCall(): Promise<void> {
  console.log('\n── AC-2: 单 tool 调用 ──');
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    h.llm.enqueue(
      {
        text: '我来调用 echo.',
        toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"hello"}' }],
        usage: { input: 80, output: 30 },
      },
      { text: '回显结果: hello.', usage: { input: 100, output: 20 } },
    );
    await h.channel.simulate('请用 echo 工具回显 "hello"');
    assert(h.channel.sent.length === 1, '只产出一条最终回复 (即便内部 2 轮 LLM)');
    assert(h.channel.lastText().includes('hello'), '回复包含 hello');

    // 第二轮 LLM 调用应该在 messages 里看到 tool result
    const lastRoles = h.llm.receivedMessageRoles.at(-1)!;
    assert(lastRoles.includes('tool'), '第二轮 messages 包含 tool turn');
    assert(h.llm.receivedToolCount[0]! >= 4, `LLM 看到工具定义 (got ${h.llm.receivedToolCount[0]!})`);
  });
}

// ─── AC-3: 多步 tool 调用 ───────────────────────────────────────────────
async function testMultiStepTool(): Promise<void> {
  console.log('\n── AC-3: 多步 tool 调用 ──');
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    h.llm.enqueue(
      {
        text: '先算 3+4.',
        toolCalls: [{ id: 'c1', name: 'add', arguments: '{"a":3,"b":4}' }],
        usage: { input: 50, output: 10 },
      },
      {
        text: '再算 7*5.',
        toolCalls: [{ id: 'c2', name: 'multiply', arguments: '{"a":7,"b":5}' }],
        usage: { input: 80, output: 10 },
      },
      { text: '结果是 35.', usage: { input: 110, output: 8 } },
    );
    await h.channel.simulate('帮我算 (3+4) * 5');
    assert(h.channel.sent.length === 1, '只产出一条最终回复');
    assert(h.channel.lastText().includes('35'), '回复包含 35');

    const session = await h.sessionStore.load('cli:default');
    // turns: user + assistant(tc) + tool(c1) + assistant(tc) + tool(c2) + assistant(final) = 6
    assert(session!.turns.length === 6, `session 应有 6 turn (got ${session!.turns.length})`);
    const toolTurns = session!.turns.filter((t) => t.role === 'tool');
    assert(toolTurns.length === 2, `两次 tool turn (got ${toolTurns.length})`);
  });
}

// ─── AC-4: session 持久化 ────────────────────────────────────────────────
async function testPersistence(): Promise<void> {
  console.log('\n── AC-4: session 持久化 ──');
  await withTempDir(async (dir) => {
    {
      const h = await makeHarness(dir);
      h.llm.enqueue({ text: '你好小明!', usage: { input: 30, output: 10 } });
      await h.channel.simulate('我叫小明');
    }
    // 模拟重启: 新 harness 共享同一个 dir, 应当能 load 出已有 session
    {
      const h2 = await makeHarness(dir);
      h2.llm.enqueue({ text: '你叫小明.', usage: { input: 50, output: 8 } });
      await h2.channel.simulate('我叫什么名字?');
      const lastRoles = h2.llm.receivedMessageRoles.at(-1)!;
      // 应包含: user(我叫小明) + assistant(你好小明) + user(我叫什么名字)
      assert(lastRoles.length === 3, `重启后历史保留 3 turn (got ${lastRoles.length})`);
      assert(h2.channel.lastText().includes('小明'), '回复仍能用上前文');
    }
  });
}

// ─── AC-5: slash commands ────────────────────────────────────────────────
async function testCommands(): Promise<void> {
  console.log('\n── AC-5: slash commands ──');
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);

    // /help — 不走 LLM, 列出 tools
    await h.channel.simulate('/help');
    assert(h.channel.lastText().includes('echo'), '/help 列出 echo');
    assert(h.channel.lastText().includes('/clear'), '/help 列出 /clear');
    assert(h.llm.receivedMessageRoles.length === 0, '/help 没调 LLM');

    await h.channel.simulate('/status');
    assert(h.channel.lastText().includes('provider:'), '/status 显示 provider');
    assert(h.channel.lastText().includes('model:'), '/status 显示 model');
    assert(h.channel.lastText().includes('tools:'), '/status 显示 tools');

    // 一轮真聊
    h.llm.enqueue({ text: '我记住了, 你叫小明.', usage: { input: 30, output: 10 } });
    await h.channel.simulate('我叫小明');
    let session = await h.sessionStore.load('cli:default');
    assert(session!.turns.length >= 4, `/help 后真聊累计 >=4 turn (got ${session!.turns.length})`);

    // /cost
    await h.channel.simulate('/cost');
    assert(h.channel.lastText().includes('input'), '/cost 显示 input');

    // /clear — 清空
    await h.channel.simulate('/clear');
    session = await h.sessionStore.load('cli:default');
    // /clear 之后 session.turns 应该只有 /clear 自己 (user 输入 /clear + bot "已清空")
    assert(session!.turns.length === 2, `/clear 后留 2 turn (got ${session!.turns.length})`);
    assert(session!.metadata.totalUsage.input === 0, '/clear 后 usage 归零');
  });
}

// ─── AC-6: context compaction ───────────────────────────────────────────
async function testCompaction(): Promise<void> {
  console.log('\n── AC-6: context compaction ──');
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    // 5 次 big_tool 调用 → 第 6 轮 LLM 看到的 messages 中, 最早几次 tool turn 应被压成 summary
    h.llm.enqueue(
      ...['t1', 't2', 't3', 't4', 't5'].map((tag) => ({
        text: `调用 big_tool ${tag}`,
        toolCalls: [{ id: `c-${tag}`, name: 'big_tool', arguments: `{"tag":"${tag}"}` }],
        usage: { input: 50, output: 10 },
      })),
      { text: '5 次调用完成.', usage: { input: 500, output: 20 } },
    );
    await h.channel.simulate('调用 big_tool 5 次, 标签 t1~t5');
    assert(h.channel.sent.length === 1, '一条最终回复');

    // 验证压缩: 最后一轮 LLM 调用看到的 tool messages 中, 最早的几条 content 应较短
    const lastMessages = h.llm.receivedMessages.at(-1)!.messages;
    const toolCount = lastMessages.filter((m) => m.role === 'tool').length;
    assert(toolCount >= 1, `最后一轮至少保留 1 条 tool message (got ${toolCount})`);
    assert(toolCount < 5, `最后一轮应压缩/裁剪旧 tool messages (got ${toolCount})`);

    // 看 session.turns 里的所有 tool turn — 它们的原始 content 仍在 session 里 (compaction 只动 messages 副本)
    const session = await h.sessionStore.load('cli:default');
    const sessionTools = session!.turns.filter((t) => t.role === 'tool');
    assert(sessionTools.length === 5, `session 仍保留全部 5 个 tool turn`);
    // 第一条原始 content 应当是大段文本 (未压缩)
    assert(
      sessionTools[0]!.content.length > 1000,
      `session 里第 1 条 tool turn 仍是完整内容 (got ${sessionTools[0]!.content.length})`,
    );
  });
}

// ─── AC-7: channel 解耦 (mock channel 已经在用) ──────────────────────────
async function testChannelDecoupling(): Promise<void> {
  console.log('\n── AC-7: channel 解耦 ──');
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    h.llm.enqueue({ text: 'hi from clawbot', usage: { input: 10, output: 5 } });
    await h.channel.simulate('你好');
    assert(h.channel.lastText().includes('clawbot'), 'AgentLoop 不依赖 stdin/stdout, 只调 channel.send');
  });
}

// ─── extra: runtime context + session lock ──────────────────────────────
async function testRuntimeContextAndSessionLock(): Promise<void> {
  console.log('\n── extra: runtime context / session lock ──');
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    h.llm.enqueue({ text: 'hi', usage: { input: 10, output: 3 } });
    await h.channel.simulate('你好');
    const firstMessage = h.llm.receivedMessages[0]!.messages[0]!.content;
    assert(firstMessage.includes('Runtime Context'), 'LLM current turn includes runtime context');
    assert(firstMessage.includes('Session ID: cli:default'), 'runtime context includes session id');
  });

  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    h.llm.enqueue(
      { text: 'first done', usage: { input: 10, output: 3 } },
      { text: 'second done', usage: { input: 10, output: 3 } },
    );
    await Promise.all([
      h.loop.processMessage({ id: 'm1', senderId: 'cli:default', text: 'first', timestamp: Date.now() }),
      h.loop.processMessage({ id: 'm2', senderId: 'cli:default', text: 'second', timestamp: Date.now() }),
    ]);
    const session = await h.sessionStore.load('cli:default');
    assert(session!.turns.length === 4, `session lock preserved both turns (got ${session!.turns.length})`);
    assert(h.channel.sent.length === 2, 'both concurrent messages got responses');
  });
}

// ─── extra: 错误路径 — 未注册 / 命令不走 LLM, JSON parse 错误回包 ────────
async function testErrorPaths(): Promise<void> {
  console.log('\n── extra: 错误路径 ──');
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    // 未注册 / 命令: handle 返回 null → 进 LLM 路径
    h.llm.enqueue({ text: '我不认识这个命令, 但我会假装它是普通消息.', usage: { input: 10, output: 5 } });
    await h.channel.simulate('/nope foo bar');
    assert(h.llm.receivedMessageRoles.length === 1, '未注册 / 命令进了 LLM');

    // 工具参数 JSON 错误: ToolRegistry 应包错误为 success:false
    const result = await h.tools.execute('echo', '{not valid json');
    assert(result.success === false, '坏 JSON → success false');
  });
}

// ─── extra: AgentLoop 新 FSM 行为 — progress 和错误持久化 ───────────────
async function testLoopProgressAndErrorPersistence(): Promise<void> {
  console.log('\n── extra: AgentLoop progress / error persistence ──');
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    const progressLoop = new AgentLoop({
      sessionStore: h.sessionStore,
      commands: h.commands,
      runner: {
        tools: h.tools,
        llm: h.llm,
        maxIterations: 5,
        contextBudget: 4000,
        agentId: 'master',
      },
      channel: h.channel,
      buildPrompt: () => buildBasePrompt(h.tools),
      sessionIdFor: () => 'cli:default',
      sendProgress: true,
    });
    h.channel.reset();

    h.llm.enqueue(
      {
        text: 'calling echo',
        toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hello"}' }],
        usage: { input: 10, output: 2 },
      },
      { text: 'done hello', usage: { input: 20, output: 4 } },
    );
    await progressLoop.processMessage({
      id: 'progress-1',
      senderId: 'cli:default',
      text: 'call echo',
      timestamp: Date.now(),
    });
    assert(h.channel.sent.some((msg) => msg.kind === 'tool_hint'), 'progress tool_hint envelope emitted');
    assert(h.channel.sent.at(-1)?.kind === 'final', 'final envelope emitted last');
  });

  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    try {
      await h.channel.simulate('this will make mock LLM throw');
    } catch {
      // AgentLoop rethrows after sending and persisting the error turn.
    }
    const session = await h.sessionStore.load('cli:default');
    assert(session !== null, 'errored session was saved');
    assert(session!.turns[0]!.role === 'user', 'user turn was early-persisted');
    assert(session!.turns.at(-1)?.role === 'assistant', 'assistant error turn was persisted');
    assert(h.channel.sent.at(-1)?.kind === 'error', 'error envelope sent');
  });
}

// ─── 主入口 ──────────────────────────────────────────────────────────────
async function main() {
  await testBasicChat();
  await testToolCall();
  await testMultiStepTool();
  await testPersistence();
  await testCommands();
  await testCompaction();
  await testChannelDecoupling();
  await testRuntimeContextAndSessionLock();
  await testErrorPaths();
  await testLoopProgressAndErrorPersistence();
  console.log('\n✓ 所有 smoke 测试通过.');
}

main().catch((err) => {
  console.error('\n✗ smoke crashed:', err);
  process.exit(1);
});
