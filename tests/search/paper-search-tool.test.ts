import { join } from 'node:path';
import {
  createToolContext,
  ToolRegistry,
  type ToolContext,
} from '../../packages/core/src/index.js';
import {
  createPaperSearchTools,
  PaperSearchState,
  type ShortlistItem,
} from '../../packages/search/src/index.js';
import type { ArxivCandidate } from '../../packages/search/src/tools/arxiv.js';
import type { DownloadResult } from '../../packages/search/src/tools/download.js';
import { assert, MockLLM, withTempDir } from '../fixtures/index.js';
import { mkdir, writeFile } from 'node:fs/promises';

const candidates: ArxivCandidate[] = [
  {
    arxiv_id: '2401.00001',
    title: 'Agent Harness Evaluation',
    authors: ['A. Researcher'],
    year: 2024,
    abstract: 'A benchmark for agent harness reliability and tool-use failures.',
    pdf_url: 'https://arxiv.org/pdf/2401.00001.pdf',
    published: '2024-01-01T00:00:00Z',
  },
  {
    arxiv_id: '2401.00002',
    title: 'Tool Use Planning for LLM Agents',
    authors: ['B. Researcher'],
    year: 2024,
    abstract: 'Planning methods for language agents that call external tools.',
    pdf_url: 'https://arxiv.org/pdf/2401.00002.pdf',
    published: '2024-01-02T00:00:00Z',
  },
];

async function testPaperSearchAndDownloadHandoff(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, 'profile.md'),
      '## 已读索引\n\n- [[2401.00002]] Tool use planning\n',
      'utf8',
    );

    const llm = new MockLLM();
    llm.enqueue(
      {
        text: '{"terms":["agent harness evaluation"],"rationale":"fixture"}',
        usage: { input: 10, output: 4 },
      },
      {
        text: '{"verdict":"recommend","reason":"聚焦 harness 可靠性和工具失败模式","summary":"提出 agent harness 评估方法。"}',
        usage: { input: 20, output: 8 },
      },
    );

    const downloaded: string[][] = [];
    const state = new PaperSearchState();
    const tools = createPaperSearchTools({
      llm,
      outputDir,
      profilePath: join(outputDir, 'profile.md'),
      state,
      searchFn: async () => candidates,
      downloadFn: async (ids, pdfDir): Promise<DownloadResult[]> => {
        downloaded.push(ids);
        return ids.map((id) => ({ arxiv_id: id, ok: true, path: join(pdfDir, `${id}.pdf`), bytes: 2048 }));
      },
    });
    const ctx: ToolContext = createToolContext({
      workspace: dir,
      outputDir,
      timezone: 'Asia/Shanghai',
      request: { channel: 'test', senderId: 'u1', sessionId: 's1' },
    });
    const registry = new ToolRegistry(tools, ctx);

    const search = await registry.execute('paper_search', {
      query: 'agent harness',
      mode: 'fast',
      maxResults: 5,
    });
    assert(search.success === true, 'paper_search succeeds');
    const searchData = search.data as { shortlist: ShortlistItem[]; trace: { terms: string[]; triageCounts: Record<string, number> } };
    const shortlist = searchData.shortlist;
    assert(shortlist.length === 1, `already-read paper filtered (got ${shortlist.length})`);
    assert(shortlist[0]!.arxiv_id === '2401.00001', 'shortlist keeps unread candidate');
    assert(searchData.trace.terms.includes('agent harness evaluation'), 'search trace records query terms');
    assert(searchData.trace.triageCounts.recommend === 1, 'search trace records triage counts');

    const download = await registry.execute('download_paper', { indices: [1] });
    assert(download.success === true, 'download_paper succeeds by shortlist index');
    assert(downloaded[0]?.join(',') === '2401.00001', 'download uses latest shortlist handoff');
  });
}

async function main(): Promise<void> {
  await testPaperSearchAndDownloadHandoff();
  console.log('✓ paper search tool tests passed.');
}

void main().catch((err) => {
  console.error('✗ paper search tool tests failed:', err);
  process.exit(1);
});
