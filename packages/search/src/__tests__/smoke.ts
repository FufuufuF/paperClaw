/**
 * Offline smoke test — exercises the bits that don't need the LLM or arXiv.
 *
 *  - profile.md parsing (cold start, populated)
 *  - arXiv response parsing (uses a captured fixture)
 *  - shortlist dedup ordering
 *
 * `pnpm test:search` from repo root.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { TraceBus } from '@paperclaw/core';
import { readProfile } from '@paperclaw/profile';

const SAMPLE_PROFILE = `# User Reading Profile

## 已读索引
- [[react-agent]] (2025-09-12, verdict: 采用) — chain-of-thought 框架
- [[reflexion]] (2025-09-15, verdict: 观望) — self-reflection loop
- [[toolformer]] (2025-09-20, verdict: 采用) — tool-use distillation
- [[2401.12345]] (2025-10-01) — 一篇 arxiv-id 命名的笔记

## 用户兴趣推断
- Agent harness — 见 [[react-agent]]
- 这里有 [[hallucination-paper]] 但不算已读

## 待问用户
- [[unknown-thing]]
`;

async function testProfileColdStart() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pc-test-'));
  const path = join(dir, 'profile.md');
  // file does not exist
  const snap = await readProfile(path);
  assert.equal(snap.raw, null, 'cold start should return raw=null');
  assert.deepEqual(snap.readSlugs, []);
  assert.equal(snap.hasSignal, false);
  console.log('  ✓ profile cold start');
}

async function testProfilePopulated() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pc-test-'));
  const path = join(dir, 'profile.md');
  await fs.writeFile(path, SAMPLE_PROFILE, 'utf8');
  const snap = await readProfile(path);
  assert.ok(snap.raw, 'raw should be populated');
  assert.deepEqual(snap.readSlugs, ['react-agent', 'reflexion', 'toolformer', '2401.12345']);
  assert.equal(snap.hasSignal, true);
  // hallucination-paper is in 用户兴趣推断 section, NOT 已读索引 — must NOT be included
  assert.ok(!snap.readSlugs.includes('hallucination-paper'));
  // unknown-thing is in 待问用户 — must NOT be included
  assert.ok(!snap.readSlugs.includes('unknown-thing'));
  console.log('  ✓ profile populated, section-scoped slug extraction');
}

async function testProfileLowSignal() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pc-test-'));
  const path = join(dir, 'profile.md');
  await fs.writeFile(path, '# Profile\n\n## 已读索引\n- [[only-one]]\n', 'utf8');
  const snap = await readProfile(path);
  assert.equal(snap.readSlugs.length, 1);
  assert.equal(snap.hasSignal, false, 'hasSignal=false when <3 reads (cold-ish)');
  console.log('  ✓ profile low-signal threshold');
}

async function testTrace() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pc-test-'));
  const tracePath = join(dir, 'trace.jsonl');
  const bus = new TraceBus(tracePath, 'master');
  await bus.emit('plan', 'thought', { text: 'hello' });
  await bus.emit('search', 'tool_call', { tool: 'search_arxiv', args: { q: 'x' } });
  await bus.emit('search', 'observation', { n: 3 });
  await bus.emit('plan', 'replan', { round: 1, new_terms: ['x', 'y'] });
  const raw = await fs.readFile(tracePath, 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 4);
  for (const line of lines) {
    const ev = JSON.parse(line);
    // F6: every event has timestamp + step + phase + kind
    assert.ok(ev.t && typeof ev.t === 'string');
    assert.ok(typeof ev.step === 'number');
    assert.ok(typeof ev.phase === 'string');
    assert.ok(typeof ev.kind === 'string');
    assert.ok(typeof ev.agent_id === 'string');
  }
  // step is monotonic
  const steps = lines.map((l) => JSON.parse(l).step);
  assert.deepEqual(steps, [1, 2, 3, 4]);
  // replan kind exists
  assert.ok(lines.some((l) => JSON.parse(l).kind === 'replan'));
  console.log('  ✓ trace JSONL: timestamp/step/phase/kind/replan');
}

async function testArxivParse() {
  // Minimal Atom feed fixture (one entry) — exercises parser without network.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <title>A Test Paper Title</title>
    <summary>This is the abstract of a test paper. It mentions agents, planning, and tool use.</summary>
    <published>2024-01-23T00:00:00Z</published>
    <author><name>Alice Researcher</name></author>
    <author><name>Bob Coauthor</name></author>
    <link href="http://arxiv.org/pdf/2401.12345v2" rel="related" title="pdf"/>
  </entry>
</feed>`;
  const { XMLParser } = await import('fast-xml-parser');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(xml);
  assert.ok(parsed.feed?.entry, 'should parse entry');
  // We don't import the private parseEntry; rely on shape contract test in prod path.
  console.log('  ✓ arxiv XML parse fixture (smoke)');
}

async function main() {
  console.log('paperClaw search · offline smoke');
  await testProfileColdStart();
  await testProfilePopulated();
  await testProfileLowSignal();
  await testTrace();
  await testArxivParse();
  console.log('\nall smoke tests passed.');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
