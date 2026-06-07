import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createKnowledgeGraphTools,
  createToolContext,
  KnowledgeGraphStore,
  ToolRegistry,
  type KnowledgeIndex,
} from '../../packages/core/src/index.js';
import { assert, withTempDir } from '../fixtures/index.js';

async function testStoreInitializesAndQueriesGraph(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    const store = new KnowledgeGraphStore({ outputDir });
    const empty = await store.load();
    assert(empty.version === 1, 'knowledge store initializes versioned index');
    assert(Object.keys(empty.papers).length === 0, 'knowledge store starts with no papers');

    await store.upsertNode({
      id: '2401.07324',
      title: 'Small LLMs Are Weak Tool Learners',
      note_path: join(outputDir, 'run-a/papers/2401.07324.md'),
      arxiv_id: '2401.07324',
      status: 'reading',
      verdict: 'maybe',
    });
    await store.upsertNode({
      id: 'agent-tool-failure-harness',
      title: 'Agent Tool Failure Harness',
      note_path: join(outputDir, 'run-a/papers/agent-tool-failure-harness.md'),
      status: 'read',
      verdict: 'adopt',
    });
    const link = await store.upsertLink({
      source: '2401.07324',
      target: 'agent-tool-failure-harness',
      type: 'complements',
      reason_short: '模块化 tool learning 和工具失败恢复评估互补。',
      reason: '一篇关注 multi-LLM tool learning 架构, 另一篇关注工具失败恢复评估。',
      confidence: 0.74,
      evidence: [
        { paper_id: '2401.07324', section: 'Abstract' },
        { paper_id: 'agent-tool-failure-harness', section: 'Evaluation Harness' },
      ],
    });
    assert(Boolean(link.write.backupPath), 'knowledge writes create backups after initial index exists');

    const neighbors = await store.neighbors({ id: '2401.07324', limit: 5 });
    assert(neighbors.neighbors.length === 1, 'knowledge store returns one-hop neighbors');
    assert(neighbors.neighbors[0].paper_id === 'agent-tool-failure-harness', 'neighbor result includes target paper id');
    assert(neighbors.neighbors[0].reason_short.includes('互补'), 'neighbor result includes short reason');

    const fullLink = await store.getLink(link.link.id);
    assert(fullLink?.reason?.includes('multi-LLM'), 'kg_get_link data can expose full relation reason');

    const search = await store.searchNodes({ query: 'tool', limit: 10 });
    assert(search.results.length === 2, 'node search matches title/id metadata');
    assert(search.results.every((item) => !('content' in item)), 'node search does not return note content');
  });
}

async function testPendingLinksAndSuggestionsStayProgressive(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    await mkdir(join(outputDir, 'run-a/papers'), { recursive: true });
    await writeFile(
      join(outputDir, 'run-a/papers/tool-learning.md'),
      '# Tool Learning\n\nThis note mentions planner caller summarizer decomposition and ToolBench.',
      'utf8',
    );
    const store = new KnowledgeGraphStore({ outputDir });
    await store.upsertNode({
      id: 'current-paper',
      title: 'Current Multi LLM Agent',
      note_path: join(outputDir, 'run-a/papers/current-paper.md'),
      status: 'reading',
      verdict: 'maybe',
    });
    await store.upsertNode({
      id: 'tool-learning',
      title: 'Tool Learning Data and Scaling',
      note_path: join(outputDir, 'run-a/papers/tool-learning.md'),
      status: 'read',
      verdict: 'adopt',
    });

    const suggestions = await store.suggestLinks({
      source: 'current-paper',
      section_title: 'Method',
      section_summary: 'The method uses planner caller summarizer decomposition for tool learning.',
      query_hints: ['planner caller summarizer', 'ToolBench'],
      mode: 'cheap',
      limit: 3,
    });
    assert(suggestions.suggestions.length === 1, 'kg_suggest_links finds a candidate from limited metadata/snippets');
    assert(JSON.stringify(suggestions).includes('Tool Learning Data and Scaling'), 'suggestion includes target title');
    assert(!JSON.stringify(suggestions).includes('This note mentions planner'), 'suggestion does not return note snippet content');

    const pending = await store.createPendingLink({
      source: 'current-paper',
      target: 'tool-learning',
      type: 'uses_same',
      reason_short: '两篇都涉及 planner/caller/summarizer 和 ToolBench。',
      confidence: 0.81,
    });
    const listed = await store.listPendingLinks();
    assert(listed.pending_links.length === 1, 'pending link can be listed for user review');
    const committed = await store.commitPendingLink(pending.pending.id);
    assert(committed.link.source === 'current-paper', 'pending link can be committed into formal links');
    const rejectedCandidate = await store.createPendingLink({
      source: 'current-paper',
      target: 'tool-learning',
      type: 'complements',
      reason_short: '用于测试 rejected pending link。',
      confidence: 0.4,
    });
    const rejected = await store.rejectPendingLink(rejectedCandidate.pending.id);
    assert(rejected.pending.status === 'rejected', 'pending link can still be marked rejected for audit');
  });
}

async function testRenameNodeUpdatesEdges(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    const store = new KnowledgeGraphStore({ outputDir });
    await store.upsertNode({ id: 'old-slug', title: 'Old Slug', note_path: join(outputDir, 'run/papers/old-slug.md') });
    await store.upsertNode({ id: 'neighbor', title: 'Neighbor', note_path: join(outputDir, 'run/papers/neighbor.md') });
    await store.upsertLink({
      source: 'old-slug',
      target: 'neighbor',
      type: 'extends',
      reason_short: 'old-slug extends neighbor.',
      evidence: [{ paper_id: 'old-slug', note_path: join(outputDir, 'run/papers/old-slug.md') }],
    });

    const renamed = await store.renameNode({
      oldId: 'old-slug',
      newId: 'new-slug',
      note_path: join(outputDir, 'run/papers/new-slug.md'),
    });
    assert(renamed.renamed === true, 'renameNode reports renamed node');
    const oldNode = await store.getNode('old-slug');
    const newNode = await store.getNode('new-slug');
    assert(oldNode === null, 'renameNode removes old node id');
    assert(newNode?.note_path.endsWith('new-slug.md') === true, 'renameNode updates note path');
    const neighbors = await store.neighbors({ id: 'new-slug' });
    assert(neighbors.neighbors.length === 1, 'renameNode updates link source/target references');
    const link = (await store.searchLinks({ source: 'new-slug' })).results[0];
    assert(link?.evidence[0]?.paper_id === 'new-slug', 'renameNode updates evidence paper id');
  });
}

async function testToolMetadataAndExecution(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    const tools = createKnowledgeGraphTools();
    const readToolNames = new Set(['kg_get_node', 'kg_neighbors', 'kg_get_link', 'kg_search_nodes', 'kg_search_links', 'kg_suggest_links', 'kg_list_pending_links']);
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
      note_path: join(outputDir, 'run/papers/paper-a.md'),
      status: 'reading',
      verdict: 'maybe',
    });
    assert(write.success === true, 'kg_upsert_node executes through tool registry');
    const read = await registry.execute('kg_get_node', { id: 'paper-a' });
    assert(read.success === true, 'kg_get_node executes through tool registry');
    assert(JSON.stringify(read.data).includes('Paper A'), 'kg_get_node returns node metadata');

    const index = JSON.parse(await readFile(join(outputDir, 'knowledge-index.json'), 'utf8')) as KnowledgeIndex;
    assert(index.papers['paper-a']?.title === 'Paper A', 'tool write persists output/knowledge-index.json');
  });
}

async function main(): Promise<void> {
  await testStoreInitializesAndQueriesGraph();
  await testPendingLinksAndSuggestionsStayProgressive();
  await testRenameNodeUpdatesEdges();
  await testToolMetadataAndExecution();
  console.log('✓ knowledge graph tests passed.');
}

void main().catch((err) => {
  console.error('✗ knowledge graph tests failed:', err);
  process.exit(1);
});
