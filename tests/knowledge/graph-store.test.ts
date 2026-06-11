import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createToolContext,
  ToolRegistry,
} from '../../packages/core/src/index.js';
import {
  createPaperKnowledgeTools,
  PaperKnowledgeStore,
  type PaperKnowledgeIndex,
} from '../../packages/paper/src/index.js';
import { assert, MockLLM, withTempDir } from '../fixtures/index.js';

async function testStoreInitializesV2AndQueriesGraph(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    const store = new PaperKnowledgeStore({ outputDir });
    const empty = await store.load();
    assert(empty.version === 2, 'paper knowledge store initializes v2 index');
    assert(Object.keys(empty.papers).length === 0, 'paper knowledge store starts with no papers');

    await store.upsertNode({
      id: '2401.07324',
      title: 'Small LLMs Are Weak Tool Learners',
      summary_short: 'Studies tool learning weaknesses.',
      note_path: join(outputDir, 'run-a/papers/2401.07324.md'),
      arxiv_id: '2401.07324',
      status: 'reading',
      key_terms: ['tool-use', 'evaluation', 'tool-use', 'llm-agents', 'benchmarks', 'planning'],
    });
    await store.upsertNode({
      id: 'agent-tool-failure-harness',
      title: 'Agent Tool Failure Harness',
      summary_short: 'Evaluates tool-call failures and recovery behavior.',
      note_path: join(outputDir, 'run-a/papers/agent-tool-failure-harness.md'),
      status: 'read',
      key_terms: ['llm-agents', 'tool-use', 'evaluation'],
    });
    const link = await store.upsertLink({
      source: '2401.07324',
      target: 'agent-tool-failure-harness',
      reason: 'Both papers connect tool-use evaluation with agent failure behavior.',
      evidence: [
        { paper_id: '2401.07324', section: 'Abstract' },
        { paper_id: 'agent-tool-failure-harness', section: 'Evaluation Harness' },
      ],
    });
    assert(Boolean(link.write.backupPath), 'paper graph writes create backups after initial index exists');
    assert(link.link.paper_ids.join(',') === '2401.07324,agent-tool-failure-harness', 'paper link stores sorted undirected pair');
    assert(link.link.shared_terms.join(',') === 'tool-use,evaluation,llm-agents', 'paper link derives shared_terms');

    const neighbors = await store.neighbors({ id: '2401.07324', limit: 5 });
    assert(neighbors.neighbors.length === 1, 'paper graph returns one-hop neighbors');
    assert(neighbors.neighbors[0].paper_id === 'agent-tool-failure-harness', 'neighbor includes target paper id');
    assert(neighbors.neighbors[0].reason.includes('tool-use'), 'neighbor includes relation reason');

    const fullLink = await store.getLink(link.link.id);
    assert(fullLink?.reason.includes('failure behavior'), 'kg_get_link data exposes full relation reason');

    const search = await store.searchNodes({ query: 'tool', limit: 10 });
    assert(search.results.length === 2, 'node search matches title/id/summary/key_terms metadata');
    assert(search.results.some((item) => item.key_terms.includes('tool-use')), 'node search returns key_terms');
    assert(search.results.every((item) => !('content' in item)), 'node search does not return note content');

    const recent = await store.recentNodes({ status: ['read'], limit: 1 });
    assert(recent.results[0]?.id === 'agent-tool-failure-harness', 'recentNodes returns latest read node');
  });
}

async function testV1MigrationDropsReviewAndConfidenceFields(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, 'knowledge-index.json'),
      JSON.stringify({
        version: 1,
        updated_at: '2026-01-01T00:00:00.000Z',
        papers: {
          a: {
            id: 'a',
            title: 'Paper A',
            note_path: join(outputDir, 'run/papers/a.md'),
            status: 'read',
            verdict: 'adopt',
          },
          b: {
            id: 'b',
            title: 'Paper B',
            note_path: join(outputDir, 'run/papers/b.md'),
            status: 'read',
          },
        },
        links: [{
          id: 'old-link',
          source: 'b',
          target: 'a',
          type: 'complements',
          directional: false,
          reason_short: 'Old relation summary.',
          confidence: 0.9,
          created_by: 'agent',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        }],
        pending_links: [{
          id: 'pending',
          source: 'a',
          target: 'b',
          type: 'extends',
          reason_short: 'Should be dropped.',
          status: 'pending_user_review',
        }],
      }),
      'utf8',
    );

    const store = new PaperKnowledgeStore({ outputDir });
    const migrated = await store.load();
    assert(migrated.version === 2, 'v1 index migrates to v2');
    assert(!('pending_links' in migrated), 'pending_links are not retained in v2');
    assert(migrated.papers.a?.key_terms.length === 0, 'migrated nodes get key_terms array');
    assert(migrated.links[0]?.paper_ids.join(',') === 'a,b', 'old source/target link migrates to sorted paper_ids');
    assert(migrated.links[0]?.reason === 'Old relation summary.', 'old reason_short migrates to reason');
    assert(!('confidence' in migrated.links[0]!), 'confidence is not retained in v2 link');
    assert(!('created_by' in migrated.links[0]!), 'created_by is not retained in v2 link');
  });
}

async function testKeyTermsVocabularyValidation(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    const store = new PaperKnowledgeStore({ outputDir });
    const valid = await store.upsertNode({
      id: 'paper-a',
      title: 'Paper A',
      note_path: join(outputDir, 'run/papers/a.md'),
      key_terms: ['tool-use', 'tool-use', 'evaluation', 'planning', 'benchmarks', 'llm-agents'],
    });
    assert(valid.node.key_terms.join(',') === 'tool-use,evaluation,planning,benchmarks,llm-agents', 'key_terms are deduped and capped at 5');

    let failed = false;
    try {
      await store.upsertNode({
        id: 'paper-b',
        title: 'Paper B',
        note_path: join(outputDir, 'run/papers/b.md'),
        key_terms: ['invented-term'],
      });
    } catch {
      failed = true;
    }
    assert(failed, 'unknown key_terms are rejected on write');
  });
}

async function testConsolidationAutoCreatesUndirectedLinks(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    await mkdir(join(outputDir, 'run/papers'), { recursive: true });
    const notePath = join(outputDir, 'run/papers/current-paper.md');
    await writeFile(
      notePath,
      '# Current Agent Harness\n\nThis paper studies LLM agents, tool failure evaluation, and benchmark protocols.',
      'utf8',
    );

    const store = new PaperKnowledgeStore({ outputDir });
    await store.upsertNode({
      id: 'old-paper',
      title: 'Old Tool Evaluation Paper',
      summary_short: 'Prior paper about tool-use evaluation for LLM agents.',
      note_path: join(outputDir, 'run/papers/old-paper.md'),
      arxiv_id: '2401.00001',
      status: 'read',
      key_terms: ['llm-agents', 'tool-use', 'evaluation'],
    });

    const llm = new MockLLM();
    llm.enqueue(
      {
        text: '{"summary_short":"Current paper evaluates LLM agent tool failures.","key_terms":["llm-agents","tool-use","evaluation","invented-term"]}',
        usage: { input: 10, output: 5 },
      },
      {
        text: '{"links":[{"paper_id":"old-paper","reason":"Both evaluate LLM agent tool-use failures."}]}',
        usage: { input: 10, output: 5 },
      },
    );
    const result = await store.consolidatePaper({
      id: 'current-paper',
      title: 'Current Agent Harness',
      note_path: notePath,
      llm,
    });
    assert(result.node.status === 'read', 'consolidation marks node read');
    assert(result.node.key_terms.join(',') === 'llm-agents,tool-use,evaluation', 'LLM key_terms are constrained to vocabulary');
    assert(result.links.length === 1, 'consolidation creates one selected link');
    assert(result.links[0]?.paper_ids.join(',') === 'current-paper,old-paper', 'consolidation writes undirected sorted pair');
    assert(result.links[0]?.shared_terms.join(',') === 'llm-agents,tool-use,evaluation', 'consolidation writes shared_terms');

    const repeat = await store.consolidatePaper({
      id: 'current-paper',
      title: 'Current Agent Harness',
      note_path: notePath,
    });
    assert(repeat.links.length === 1, 'fallback consolidation still selects existing candidate');
    const index = await store.load();
    assert(index.links.length === 1, 'repeated consolidation updates existing pair instead of duplicating');
  });
}

async function testSectionRelationPreviewIsReadOnly(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    await mkdir(join(outputDir, 'run/reader-state'), { recursive: true });
    const statePath = join(outputDir, 'run/reader-state/current-paper.json');
    await writeFile(
      statePath,
      JSON.stringify({
        slug: 'current-paper',
        title: 'Current Paper',
        notePath: join(outputDir, 'run/papers/current-paper.md'),
        sections: [{
          index: 1,
          title: 'Method',
          text: 'The method evaluates LLM agent tool-use failures with benchmark protocols.',
        }],
      }),
      'utf8',
    );
    const store = new PaperKnowledgeStore({ outputDir });
    await store.upsertNode({
      id: 'old-paper',
      title: 'Old Tool Evaluation Paper',
      summary_short: 'Prior paper about tool-use evaluation.',
      note_path: join(outputDir, 'run/papers/old-paper.md'),
      status: 'read',
      key_terms: ['llm-agents', 'tool-use', 'evaluation'],
    });
    const before = JSON.stringify(await store.load());
    const preview = await store.previewSectionRelations({ statePath, sectionIndex: 1, maxResults: 3 });
    const after = JSON.stringify(await store.load());
    assert(preview.results.length === 1, 'preview returns related old paper');
    assert(preview.results[0]?.matched_key_terms.includes('tool-use'), 'preview returns matched key terms');
    assert(before === after, 'preview_section_relations does not write the paper graph');
  });
}

async function testToolMetadataAndExecution(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    const tools = createPaperKnowledgeTools();
    const names = tools.map((tool) => tool.name);
    assert(!names.includes('kg_list_pending_links'), 'pending link tools are removed');
    assert(names.includes('preview_section_relations'), 'section relation preview tool exists');
    assert(names.includes('consolidate_paper'), 'paper consolidation tool exists');

    const readToolNames = new Set(['kg_get_node', 'kg_recent_nodes', 'kg_neighbors', 'kg_get_link', 'kg_search_nodes', 'kg_search_links', 'preview_section_relations']);
    for (const tool of tools) {
      if (readToolNames.has(tool.name)) {
        assert(tool.readOnly === true, `${tool.name} is read-only`);
        assert(!tool.confirmation, `${tool.name} has no confirmation gate`);
      } else {
        assert(tool.readOnly === false, `${tool.name} is a write tool`);
        assert(tool.confirmation?.required === true, `${tool.name} requires confirmation metadata`);
      }
    }

    const registry = new ToolRegistry(tools, createToolContext({ workspace: dir, outputDir, timezone: 'Asia/Shanghai' }));
    const write = await registry.execute('kg_upsert_node', {
      id: 'paper-a',
      title: 'Paper A',
      summary_short: 'Paper A short summary.',
      note_path: join(outputDir, 'run/papers/paper-a.md'),
      status: 'reading',
      key_terms: ['tool-use', 'evaluation'],
    });
    assert(write.success === true, 'kg_upsert_node executes through tool registry');
    const read = await registry.execute('kg_get_node', { id: 'paper-a' });
    assert(read.success === true, 'kg_get_node executes through tool registry');
    assert(JSON.stringify(read.data).includes('Paper A'), 'kg_get_node returns node metadata');

    const index = JSON.parse(await readFile(join(outputDir, 'knowledge-index.json'), 'utf8')) as PaperKnowledgeIndex;
    assert(index.version === 2, 'tool write persists v2 output/knowledge-index.json');
    assert(index.papers['paper-a']?.key_terms.join(',') === 'tool-use,evaluation', 'tool write persists key_terms');
  });
}

async function main(): Promise<void> {
  await testStoreInitializesV2AndQueriesGraph();
  await testV1MigrationDropsReviewAndConfidenceFields();
  await testKeyTermsVocabularyValidation();
  await testConsolidationAutoCreatesUndirectedLinks();
  await testSectionRelationPreviewIsReadOnly();
  await testToolMetadataAndExecution();
  console.log('✓ paper knowledge graph tests passed.');
}

void main().catch((err) => {
  console.error('✗ paper knowledge graph tests failed:', err);
  process.exit(1);
});
