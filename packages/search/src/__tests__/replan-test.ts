/**
 * Replan logic test (AC2 + AC6).
 *
 * Uses a stub LLM that returns canned responses so we can assert:
 *   - on round-1 with < 3 recommend, decideReplan returns should_replan=true
 *     with new terms
 *   - the trace contains a kind='replan' event
 *   - maxRounds caps the loop
 *
 * Real arxiv calls are still made (cheap, deterministic for a given query).
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatOpts,
  ChatResponse,
  LLMClient,
} from '@paperclaw/core';
import { queryFlow } from '../flows/query-flow.js';

/**
 * Content-aware stub: dispatches based on system-prompt fingerprint so
 * decompose / triage / replan are answered correctly regardless of arXiv
 * candidate count.
 */
class StubLLM implements LLMClient {
  readonly id = 'stub/dispatch';
  triageCallCount = 0;
  decomposeCallCount = 0;
  replanCallCount = 0;
  constructor(
    private readonly handlers: {
      decompose: () => string;
      triage: (i: number) => string;
      replan: (i: number) => string;
    },
  ) {}
  async chat(opts: ChatOpts): Promise<ChatResponse> {
    const sys = opts.system ?? '';
    let text: string;
    if (/拆解成 1-N 个 arXiv 检索词/.test(sys)) {
      this.decomposeCallCount += 1;
      text = this.handlers.decompose();
    } else if (/triage 助手/.test(sys)) {
      const i = this.triageCallCount++;
      text = this.handlers.triage(i);
    } else if (/replan 决策器/.test(sys)) {
      const i = this.replanCallCount++;
      text = this.handlers.replan(i);
    } else {
      throw new Error(`StubLLM: unknown system prompt: ${sys.slice(0, 80)}`);
    }
    return { text, usage: { input: 1, output: 1 } };
  }
}

async function testReplanFires() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pc-replan-'));
  // Round 1: all triage → maybe → recommend=0 < FLOOR → triggers replan.
  // Round 2: all triage → recommend so the loop can satisfy targetN.
  let round = 1;
  const llm = new StubLLM({
    decompose: () => JSON.stringify({ terms: ['llm planning agent'], rationale: 'test' }),
    triage: () =>
      round === 1
        ? JSON.stringify({
            verdict: 'maybe',
            reason: '主题相关但贡献不显著',
            summary: '测试 maybe 摘要',
          })
        : JSON.stringify({
            verdict: 'recommend',
            reason: '具体提出 ReAct 框架, 在多个 benchmark 上验证',
            summary: '测试 recommend 摘要',
          }),
    replan: () => {
      // Once replan is asked, advance the round so subsequent triage calls
      // start returning recommend.
      round = 2;
      return JSON.stringify({
        should_replan: true,
        new_terms: ['react agent'],
        reason: 'recommend 不足, 补 react 方向',
      });
    },
  });

  const result = await queryFlow({
    query: 'force-replan-test',
    llm,
    profilePath: join(dir, 'no-profile.md'), // doesn't exist → cold start
    perTermMax: 5,
    targetN: 5,
    maxRounds: 3,
    concurrency: 4,
    runId: 'test-replan-run',
    outDirOverride: dir,
  });

  // AC2: at least 2 rounds happened
  assert.ok(result.rounds >= 2, `expected ≥2 rounds, got ${result.rounds}`);

  // AC6: trace contains a kind='replan' event
  const traceRaw = await fs.readFile(result.trace_path, 'utf8');
  const events = traceRaw
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { kind: string; phase: string; new_terms?: string[] });
  const replanEvents = events.filter((e) => e.kind === 'replan');
  assert.ok(replanEvents.length >= 1, 'trace should have at least one replan event');
  assert.deepEqual(replanEvents[0]!.new_terms, ['react agent']);

  // AC6: thought + tool_call + observation all present
  assert.ok(events.some((e) => e.kind === 'thought'));
  assert.ok(events.some((e) => e.kind === 'tool_call'));
  assert.ok(events.some((e) => e.kind === 'observation'));
  assert.ok(events.some((e) => e.kind === 'phase_begin'));
  assert.ok(events.some((e) => e.kind === 'phase_end'));

  // AC2: shortlist has at least some recommends after replan kicked in
  const recs = result.shortlist.filter((s) => s.verdict === 'recommend');
  assert.ok(recs.length >= 1, `expected ≥1 recommend after replan, got ${recs.length}`);

  // every kind=='replan' event has new_terms in the payload (per F6)
  for (const ev of replanEvents) {
    assert.ok(Array.isArray(ev.new_terms) && ev.new_terms.length > 0);
  }

  console.log('  ✓ replan fires + traced + caps at maxRounds');
}

async function testReplanCapped() {
  // Stub always says "yes replan". Verify maxRounds cap stops the loop.
  const dir = await fs.mkdtemp(join(tmpdir(), 'pc-cap-'));
  const llm = new StubLLM({
    decompose: () => JSON.stringify({ terms: ['llm'], rationale: 'test' }),
    triage: () => JSON.stringify({ verdict: 'maybe', reason: 'test', summary: 'x' }),
    replan: () =>
      JSON.stringify({ should_replan: true, new_terms: ['x', 'y'], reason: 'always' }),
  });
  const result = await queryFlow({
    query: 'cap-test',
    llm,
    profilePath: join(dir, 'no-profile.md'),
    perTermMax: 3,
    targetN: 5,
    maxRounds: 2, // hard cap
    concurrency: 3,
    runId: 'cap-test',
    outDirOverride: dir,
  });
  assert.equal(result.rounds, 2, `maxRounds cap not enforced: got ${result.rounds}`);
  console.log('  ✓ maxRounds cap enforced');
}

async function main() {
  console.log('paperClaw replan test (no live LLM, real arXiv)');
  await testReplanFires();
  await testReplanCapped();
  console.log('\nreplan tests passed.');
}

main().catch((err) => {
  console.error('REPLAN TEST FAILED:', err);
  process.exit(1);
});
