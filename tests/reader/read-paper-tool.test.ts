import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createToolContext,
  ToolRegistry,
} from '../../packages/core/src/index.js';
import {
  createReaderTools,
  type ReadPaperResult,
  type ReadPaperSectionResult,
  type RecordPaperSectionNoteResult,
} from '../../packages/reader/src/index.js';
import { assert, MockLLM, withTempDir } from '../fixtures/index.js';

async function testReadPaperStartsGuidedReading(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    const pdfDir = join(outputDir, 'pdfs');
    await mkdir(pdfDir, { recursive: true });
    const pdfPath = join(pdfDir, '2401.12345.pdf');
    await writeFile(pdfPath, Buffer.from('%PDF-1.4 fake pdf fixture'), 'utf8');
    await writeFile(
      pdfPath.replace(/\.pdf$/, '.txt'),
      [
        'Agent Harness Paper',
        'Abstract',
        'Agent harness paper. It studies tool failures, recovery, and evaluation protocols.',
        '1 Introduction',
        'The method defines an execution harness for language agents, observes failed tool calls,',
        '2 Method',
        'and compares retry behavior across benchmark tasks. The paper is useful for note testing.',
      ].join(' '),
      'utf8',
    );

    const llm = new MockLLM();

    const registry = new ToolRegistry(
      createReaderTools({
        llm,
        outputDir,
        profilePath: join(outputDir, 'profile.md'),
        runId: 'test-run',
      }),
      createToolContext({ workspace: dir, outputDir, timezone: 'Asia/Shanghai' }),
    );

    const result = await registry.execute('read_paper', {
      pdfPath,
      slug: 'agent-harness-paper',
    });
    assert(result.success === true, 'read_paper succeeds');
    const data = result.data as ReadPaperResult;
    assert(data.isolation.pdfTextPersistedToMainSession === false, 'reader reports main-session isolation');
    assert(data.notePath.endsWith('output/test-run/papers/agent-harness-paper.md'), 'note path uses run id and slug');
    assert(data.statePath.endsWith('output/test-run/reader-state/agent-harness-paper.json'), 'state path uses run id and slug');
    assert(data.readingMode === 'guided', 'read_paper starts guided reading');
    assert(data.sections.length >= 1, 'guided reading has section plan');
    assert(data.nextSection?.index === 1, 'next section starts at first section');
    assert(data.profileUpdated === false, 'profile is not updated before guided reading completes');
    assert(llm.receivedMessages.length === 0, 'read_paper does not summarize whole paper immediately');

    const note = await readFile(data.notePath, 'utf8');
    assert(note.includes('source_pdf:'), 'note contains source pdf');
    assert(note.includes('reading_mode: guided'), 'note records guided mode');
    assert(note.includes('## Reading Plan'), 'note contains reading plan');
    assert(note.includes('## Section Notes'), 'note contains section notes placeholder');
    assert(note.includes('## Verdict'), 'note contains reader verdict section');
    assert(!JSON.stringify(result).includes('Agent harness paper. It studies tool failures'), 'tool result omits PDF excerpt');

    const kg = JSON.parse(await readFile(join(outputDir, 'knowledge-index.json'), 'utf8')) as {
      papers: Record<string, { title: string; note_path: string; status: string; verdict: string }>;
      links: unknown[];
    };
    assert(kg.papers['agent-harness-paper']?.status === 'reading', 'read_paper registers a reading knowledge graph node');
    assert(kg.papers['agent-harness-paper']?.note_path === data.notePath, 'knowledge node points at the guided note');
    assert(kg.links.length === 0, 'read_paper does not auto-create knowledge graph links');
  });
}

async function testReadPaperSectionLoadsContentOnly(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    const pdfDir = join(outputDir, 'pdfs');
    await mkdir(pdfDir, { recursive: true });
    const pdfPath = join(pdfDir, '2401.12345.pdf');
    await writeFile(pdfPath, Buffer.from('%PDF-1.4 fake pdf fixture'), 'utf8');
    await writeFile(
      pdfPath.replace(/\.pdf$/, '.txt'),
      [
        'Agent Harness Paper',
        'Abstract',
        'Agent harness paper studies tool failures and recovery protocols.',
        '1 Introduction',
        'The introduction motivates reliable agent execution traces.',
        '2 Method',
        'The method defines a failure taxonomy for tool calls.',
      ].join('\n'),
      'utf8',
    );

    const llm = new MockLLM();

    const registry = new ToolRegistry(
      createReaderTools({
        llm,
        outputDir,
        profilePath: join(outputDir, 'profile.md'),
        runId: 'test-run',
      }),
      createToolContext({ workspace: dir, outputDir, timezone: 'Asia/Shanghai' }),
    );

    const start = await registry.execute('read_paper', {
      pdfPath,
      slug: 'agent-harness-paper',
    });
    assert(start.success === true, 'read_paper succeeds');
    const startData = start.data as ReadPaperResult;

    const section = await registry.execute('read_paper_section', {
      statePath: startData.statePath,
    });
    assert(section.success === true, 'read_paper_section succeeds');
    const data = section.data as ReadPaperSectionResult;
    assert(data.section.index === 1, 'first section read');
    assert(data.section.text.includes('tool failures and recovery protocols'), 'section text is returned to main agent');
    assert(data.completed === false, 'one section does not complete multi-section paper');
    assert(data.nextSection?.index === 2, 'next section is exposed');

    const note = await readFile(startData.notePath, 'utf8');
    assert(note.includes('- [ ] 1.'), 'read_paper_section does not mark section done');
    assert(!note.includes('### 1. Abstract'), 'read_paper_section does not write section note');
    assert(llm.receivedMessages.length === 0, 'read_paper_section does not call reader subagent');
  });
}

async function testRecordPaperSectionNoteWritesNoteAndProgress(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    const pdfDir = join(outputDir, 'pdfs');
    await mkdir(pdfDir, { recursive: true });
    const pdfPath = join(pdfDir, '2401.12345.pdf');
    await writeFile(pdfPath, Buffer.from('%PDF-1.4 fake pdf fixture'), 'utf8');
    await writeFile(
      pdfPath.replace(/\.pdf$/, '.txt'),
      [
        'Agent Harness Paper',
        'Abstract',
        'Agent harness paper studies tool failures and recovery protocols.',
        '1 Introduction',
        'The introduction motivates reliable agent execution traces.',
        '2 Method',
        'The method defines a failure taxonomy for tool calls.',
      ].join('\n'),
      'utf8',
    );

    const llm = new MockLLM();
    const registry = new ToolRegistry(
      createReaderTools({
        llm,
        outputDir,
        profilePath: join(outputDir, 'profile.md'),
        runId: 'test-run',
      }),
      createToolContext({ workspace: dir, outputDir, timezone: 'Asia/Shanghai' }),
    );

    const start = await registry.execute('read_paper', {
      pdfPath,
      slug: 'agent-harness-paper',
    });
    assert(start.success === true, 'read_paper succeeds');
    const startData = start.data as ReadPaperResult;

    const record = await registry.execute('record_paper_section_note', {
      statePath: startData.statePath,
      sectionIndex: 1,
      note: [
        '#### Reading Guide',
        '先抓住本文的问题: agent 工具失败如何被观测与恢复。',
        '',
        '#### Key Points',
        '- Abstract 聚焦 tool failures 和 recovery protocols。',
        '',
        '#### Details',
        '- 当前 section 没有展开实验, 只给出论文目标。',
        '',
        '#### Questions',
        '- failure taxonomy 在后文如何定义?',
        '',
        '#### Section Takeaway',
        '本文适合继续读 method。',
      ].join('\n'),
    });
    assert(record.success === true, 'record_paper_section_note succeeds');
    const data = record.data as RecordPaperSectionNoteResult;
    assert(data.section.status === 'done', 'record marks section done');
    assert(data.completed === false, 'one recorded section does not complete multi-section paper');
    assert(data.nextSection?.index === 2, 'record exposes next pending section');

    const note = await readFile(startData.notePath, 'utf8');
    assert(note.includes('- [x] 1.'), 'reading plan marks first section done');
    assert(note.includes('### 1. Abstract'), 'section note heading written');
    assert(note.includes('#### Reading Guide'), 'section note content written');
    assert(!note.includes('### 2. 1 Introduction\n\n#### Reading Guide'), 'only one section is written');
    assert(llm.receivedMessages.length === 0, 'record_paper_section_note does not call reader subagent');

    const kg = JSON.parse(await readFile(join(outputDir, 'knowledge-index.json'), 'utf8')) as {
      papers: Record<string, { status: string }>;
      links: unknown[];
    };
    assert(kg.papers['agent-harness-paper']?.status === 'reading', 'record_paper_section_note keeps node reading until all sections complete');
    assert(kg.links.length === 0, 'record_paper_section_note does not auto-create knowledge graph links');
  });
}

async function testReadPaperFailsOnInsufficientPdfText(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    const pdfDir = join(outputDir, 'pdfs');
    await mkdir(pdfDir, { recursive: true });
    const pdfPath = join(pdfDir, 'bad.pdf');
    await writeFile(pdfPath, Buffer.from('%PDF-1.4 fake'), 'utf8');

    const llm = new MockLLM();
    const registry = new ToolRegistry(
      createReaderTools({
        llm,
        outputDir,
        profilePath: join(outputDir, 'profile.md'),
        runId: 'test-run',
      }),
      createToolContext({ workspace: dir, outputDir, timezone: 'Asia/Shanghai' }),
    );

    const result = await registry.execute('read_paper', {
      pdfPath,
      slug: 'bad-paper',
    });
    assert(result.success === false, 'read_paper fails when PDF text extraction is insufficient');
    assert(String((result.data as { error: string }).error).includes('PDF text extraction insufficient'), 'insufficient extraction error is explicit');
    assert(llm.receivedMessages.length === 0, 'reader LLM is not called when extraction is insufficient');
  });
}

async function testProfileUpdaterReplacesExistingSlug(): Promise<void> {
  await withTempDir(async (dir) => {
    const outputDir = join(dir, 'output');
    const pdfDir = join(outputDir, 'pdfs');
    await mkdir(pdfDir, { recursive: true });
    await writeFile(
      join(outputDir, 'profile.md'),
      [
        '# paperClaw Profile',
        '',
        '## 已读索引',
        '',
        '- [[2401.07324]] 2401.07324 — verdict: skip; note: /old/bad-note.md',
        '',
      ].join('\n'),
      'utf8',
    );
    const pdfPath = join(pdfDir, '2401.07324.pdf');
    await writeFile(pdfPath, Buffer.from('%PDF-1.4 fake pdf fixture'), 'utf8');
    await writeFile(
      pdfPath.replace(/\.pdf$/, '.txt'),
      [
        'Small LLMs Are Weak Tool Learners: A Multi-LLM Agent.',
        'The paper proposes a multi-LLM agent framework with planner, caller, and summarizer modules.',
        'It evaluates tool-use benchmarks and reports improved performance for smaller models.',
      ].join(' '),
      'utf8',
    );

    const llm = new MockLLM();

    const registry = new ToolRegistry(
      createReaderTools({
        llm,
        outputDir,
        profilePath: join(outputDir, 'profile.md'),
        runId: 'new-run',
      }),
      createToolContext({ workspace: dir, outputDir, timezone: 'Asia/Shanghai' }),
    );

    const result = await registry.execute('read_paper', {
      pdfPath,
      slug: '2401.07324',
    });
    assert(result.success === true, 'read_paper succeeds for existing profile slug');
    const startData = result.data as ReadPaperResult;
    const section = await registry.execute('record_paper_section_note', {
      statePath: startData.statePath,
      sectionIndex: 1,
      note: [
        '#### Reading Guide',
        '读 Abstract 即可判断这篇论文和 multi-LLM tool learning 相关。',
        '',
        '#### Key Points',
        'adopt: useful agent tool-learning paper.',
        '',
        '#### Details',
        '- 提出 planner/caller/summarizer 的多模型拆分。',
        '',
        '#### Questions',
        '- 后续需要核对实验设置。',
        '',
        '#### Section Takeaway',
        '值得继续跟进。',
      ].join('\n'),
    });
    assert(section.success === true, 'record_paper_section_note succeeds for existing profile slug');
    const profile = await readFile(join(outputDir, 'profile.md'), 'utf8');
    assert(profile.includes('verdict: adopt'), 'profile updater replaces old verdict for same slug');
    assert(profile.includes('output/new-run/papers/2401.07324.md'), 'profile updater replaces old note path for same slug');
    assert(!profile.includes('/old/bad-note.md'), 'profile no longer points to old bad note');
  });
}

async function main(): Promise<void> {
  await testReadPaperStartsGuidedReading();
  await testReadPaperSectionLoadsContentOnly();
  await testRecordPaperSectionNoteWritesNoteAndProgress();
  await testReadPaperFailsOnInsufficientPdfText();
  await testProfileUpdaterReplacesExistingSlug();
  console.log('✓ reader tool tests passed.');
}

void main().catch((err) => {
  console.error('✗ reader tool tests failed:', err);
  process.exit(1);
});
