import {
  addTool,
  AgentRunner,
  BACKFILL_TOOL_RESULT_CONTENT,
  echoTool,
  ToolRegistry,
  type AgentCheckpoint,
  type ChatMessage,
} from '../../packages/core/src/index.js';
import { assert, MockLLM } from '../fixtures/index.js';

function makeRunner(tools = new ToolRegistry([echoTool, addTool])): {
  llm: MockLLM;
  runner: AgentRunner;
  tools: ToolRegistry;
  checkpoints: AgentCheckpoint[];
} {
  const llm = new MockLLM();
  const runner = new AgentRunner(llm);
  return { llm, runner, tools, checkpoints: [] };
}

function baseSpec(
  h: ReturnType<typeof makeRunner>,
  initialMessages: ChatMessage[] = [{ role: 'user', content: 'hello' }],
) {
  return {
    systemPrompt: 'You are clawbot.',
    initialMessages,
    tools: h.tools,
    maxIterations: 5,
    contextBudget: 4000,
    agentId: 'test-agent',
    checkpointCallback: (payload: AgentCheckpoint) => h.checkpoints.push(payload),
  };
}

async function testFinalResponse(): Promise<void> {
  const h = makeRunner();
  h.llm.enqueue({ text: 'done', usage: { input: 10, output: 3 } });

  const result = await h.runner.run(baseSpec(h));

  assert(result.text === 'done', 'final text returned');
  assert(result.stopReason === 'completed', 'stop reason completed');
  assert(result.newTurns.length === 1 && result.newTurns[0]!.role === 'assistant', 'final assistant turn saved');
  assert(result.usage.input === 10 && result.usage.output === 3, 'usage accumulated');
  assert(h.checkpoints.at(-1)?.phase === 'final_response', 'final checkpoint emitted');
}

async function testToolCallExecution(): Promise<void> {
  const h = makeRunner();
  h.llm.enqueue(
    {
      text: 'calling echo',
      toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hello"}' }],
      usage: { input: 20, output: 4 },
    },
    { text: 'echo says hello', usage: { input: 30, output: 5 } },
  );

  const result = await h.runner.run(baseSpec(h));

  assert(result.text.includes('hello'), 'final answer can use tool result');
  assert(result.toolsUsed.join(',') === 'echo', 'tool usage tracked');
  assert(result.toolEvents[0]?.status === 'ok', 'tool event status ok');
  assert(result.newTurns.map((t) => t.role).join(',') === 'assistant,tool,assistant', 'new turns include assistant/tool/final');
  assert(h.llm.receivedMessageRoles[1]?.includes('tool') === true, 'second LLM call sees tool result');
  assert(h.checkpoints.map((c) => c.phase).join(',') === 'awaiting_tools,tools_completed,final_response', 'tool checkpoints emitted');
}

async function testBadToolArgsAreReturnedToModel(): Promise<void> {
  const h = makeRunner();
  h.llm.enqueue(
    {
      text: 'try add',
      toolCalls: [{ id: 'call_bad', name: 'add', arguments: '{"a":"nope","b":2}' }],
      usage: { input: 20, output: 4 },
    },
    { text: 'I will recover from the tool error.', usage: { input: 30, output: 5 } },
  );

  const result = await h.runner.run(baseSpec(h));
  const toolContent = result.newTurns.find((t) => t.role === 'tool')?.content ?? '';

  assert(result.stopReason === 'completed', 'bad args do not abort runner');
  assert(toolContent.includes('"success":false'), 'tool error is serialized for LLM');
  assert(toolContent.includes('Invalid parameters'), 'validation error is included');
}

async function testEmptyResponseRetryAndFinalization(): Promise<void> {
  const h = makeRunner();
  h.llm.enqueue(
    { text: '', usage: { input: 5, output: 0 } },
    { usage: { input: 5, output: 0 } },
    { text: 'final after retry', usage: { input: 4, output: 3 } },
  );

  const result = await h.runner.run(baseSpec(h));

  assert(result.text === 'final after retry', 'finalization retry supplies answer');
  assert(h.llm.receivedMessages.length === 3, 'two empty attempts plus finalization call');
  assert(h.llm.receivedMessages[2]!.tools === undefined, 'finalization retry does not expose tools');
  assert(result.usage.input === 14 && result.usage.output === 3, 'usage includes retry calls');
}

async function testMaxIterations(): Promise<void> {
  const h = makeRunner();
  h.llm.enqueue(
    {
      text: 'again',
      toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"a"}' }],
      usage: { input: 10, output: 2 },
    },
    {
      text: 'again',
      toolCalls: [{ id: 'call_2', name: 'echo', arguments: '{"text":"b"}' }],
      usage: { input: 10, output: 2 },
    },
  );

  const result = await h.runner.run({
    ...baseSpec(h),
    maxIterations: 2,
  });

  assert(result.stopReason === 'max_iterations', 'max iteration stop reason');
  assert(result.truncated === true, 'truncated flag set');
  assert(result.text.includes('maximum number'), 'actionable fallback text');
}

async function testMessageGovernanceRepairsModelContextOnly(): Promise<void> {
  const h = makeRunner();
  const initialMessages: ChatMessage[] = [
    { role: 'user', content: 'old task' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'missing_call', name: 'echo', arguments: '{"text":"lost"}' }],
    },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new task' },
  ];
  h.llm.enqueue({ text: 'done', usage: { input: 10, output: 3 } });

  const result = await h.runner.run(baseSpec(h, initialMessages));
  const modelMessages = h.llm.receivedMessages[0]!.messages;

  assert(
    modelMessages.some((m) => m.role === 'tool' && m.tool_call_id === 'missing_call' && m.content === BACKFILL_TOOL_RESULT_CONTENT),
    'model context receives backfilled tool result',
  );
  assert(
    !result.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'missing_call'),
    'returned messages do not persist synthetic backfill',
  );
}

async function testDropOrphanToolResults(): Promise<void> {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'tool', tool_call_id: 'orphan', content: 'stale' },
    { role: 'assistant', content: 'answer' },
  ];

  const cleaned = AgentRunner.dropOrphanToolResults(messages);

  assert(cleaned.length === 2, 'orphan tool result is removed');
  assert(cleaned.every((m) => m.tool_call_id !== 'orphan'), 'orphan id absent');
}

async function testLengthRecovery(): Promise<void> {
  const h = makeRunner();
  h.llm.enqueue(
    { text: 'partial', finishReason: 'length', usage: { input: 8, output: 4 } },
    { text: 'continued', usage: { input: 9, output: 4 } },
  );

  const result = await h.runner.run(baseSpec(h));

  assert(result.text === 'continued', 'runner continues after length finish');
  assert(h.llm.receivedMessageRoles[1]?.join(',') === 'user,assistant,user', 'second call includes continuation prompt');
  assert(result.newTurns.map((t) => t.role).join(',') === 'assistant,assistant', 'synthetic recovery prompt is not persisted as user turn');
}

async function main(): Promise<void> {
  await testFinalResponse();
  await testToolCallExecution();
  await testBadToolArgsAreReturnedToModel();
  await testEmptyResponseRetryAndFinalization();
  await testMaxIterations();
  await testMessageGovernanceRepairsModelContextOnly();
  await testDropOrphanToolResults();
  await testLengthRecovery();
  console.log('✓ runner tests passed.');
}

void main().catch((err) => {
  console.error('✗ runner tests failed:', err);
  process.exit(1);
});
