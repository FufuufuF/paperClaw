import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import {
  getRunId,
  type LLMClient,
  type Tool,
  type ToolContext,
  type TraceBus,
} from '@paperclaw/core';
import { PaperKnowledgeStore } from '../knowledge/graph-store.js';
import { extractPdfText } from './pdf.js';
import { updateProfileFromNote } from '../shared/profile-updater.js';
import { inferTitleFromText, splitPaperSections, type PaperSection } from './sections.js';

export interface ReaderToolOpts {
  llm: LLMClient;
  outputDir: string;
  profilePath?: string;
  trace?: TraceBus;
  runId?: string;
}

export interface ReadPaperInput {
  pdfPath?: string;
  arxivId?: string;
  slug?: string;
}

export interface ReadPaperResult {
  slug: string;
  title: string;
  pdfPath: string;
  notePath: string;
  statePath: string;
  profilePath: string;
  profileUpdated: boolean;
  readingMode: 'guided';
  sections: Array<{ index: number; title: string; chars: number; status: ReadingSectionStatus }>;
  nextSection?: { index: number; title: string; chars: number };
  nextAction: string;
  knowledgeNode: { id: string; status: 'reading' | 'read'; notePath: string };
  usage: { input: number; output: number };
  isolation: {
    pdfTextPersistedToMainSession: false;
    subagentMessages: number;
  };
}

export interface ReadPaperSectionInput {
  statePath?: string;
  notePath?: string;
  slug?: string;
  sectionIndex?: number;
}

export interface ReadPaperSectionResult {
  slug: string;
  title: string;
  notePath: string;
  statePath: string;
  section: { index: number; title: string; chars: number; status: ReadingSectionStatus; text: string };
  completed: boolean;
  previousSection?: { index: number; title: string; chars: number };
  nextSection?: { index: number; title: string; chars: number };
  noteInstruction: string;
}

export interface RecordPaperSectionNoteInput extends ReadPaperSectionInput {
  note?: string;
}

export interface RecordPaperSectionNoteResult {
  slug: string;
  title: string;
  notePath: string;
  statePath: string;
  section: { index: number; title: string; chars: number; status: ReadingSectionStatus };
  completed: boolean;
  nextSection?: { index: number; title: string; chars: number };
  profileUpdated: boolean;
}

type ReadingSectionStatus = 'pending' | 'done';

interface GuidedReadingSection extends PaperSection {
  status: ReadingSectionStatus;
  note?: string;
  completedAt?: string;
}

interface GuidedReadingState {
  version: 1;
  slug: string;
  title: string;
  pdfPath: string;
  notePath: string;
  profilePath: string;
  extraction: string;
  extractionQuality: string;
  createdAt: string;
  updatedAt: string;
  completed: boolean;
  sections: GuidedReadingSection[];
}

export function createReaderTools(opts: ReaderToolOpts): Tool[] {
  return [createReadPaperTool(opts), createReadPaperSectionTool(opts), createRecordPaperSectionNoteTool(opts)];
}

export function createReadPaperTool(opts: ReaderToolOpts): Tool {
  return {
    name: 'read_paper',
    description: 'Start a guided paper reading session for a local PDF: extract text, split it into sections, and create a markdown note scaffold. It does not summarize the whole paper at once.',
    readOnly: false,
    concurrencySafe: false,
    exclusive: true,
    scopes: ['paper-read'],
    confirmation: {
      required: true,
      action: 'start guided PDF reading and create a note scaffold',
      patterns: ['精读', '读(一下|这篇|这个)?\\s*(论文|paper|pdf)', '阅读\\s*(论文|paper|pdf)', '总结\\s*(这篇|这个|.*pdf|.*论文|.*paper)', '生成\\s*(笔记|note)', 'read\\s*(paper|pdf)', 'summarize\\s*(paper|pdf)'],
      guidance: 'Ask the user to explicitly confirm PDF reading/note generation before calling read_paper.',
    },
    parameters: {
      type: 'object',
      properties: {
        pdfPath: { type: 'string', description: 'Local PDF path.' },
        arxivId: { type: 'string', description: 'arXiv id; resolves to <store>/pdfs/<id>.pdf.' },
        slug: { type: 'string', description: 'Optional note slug.' },
      },
    },
    async execute(args, ctx) {
      const result = await readPaper(
        {
          pdfPath: typeof args.pdfPath === 'string' ? args.pdfPath : undefined,
          arxivId: typeof args.arxivId === 'string' ? args.arxivId : undefined,
          slug: typeof args.slug === 'string' ? args.slug : undefined,
        },
        opts,
        ctx,
      );
      return {
        success: true,
        data: result,
        summary: `read_paper started guided reading for ${result.notePath}; sections=${result.sections.length}`,
      };
    },
  };
}

export function createReadPaperSectionTool(opts: ReaderToolOpts): Tool {
  return {
    name: 'read_paper_section',
    description: 'Load exactly one section from a guided paper reading session for the main agent to discuss with the user. This does not write notes or call a sub-agent.',
    readOnly: true,
    concurrencySafe: true,
    scopes: ['paper-read'],
    parameters: {
      type: 'object',
      properties: {
        statePath: { type: 'string', description: 'Path to <store>/<runId>/reader-state/<slug>.json.' },
        notePath: { type: 'string', description: 'Path to the guided reading markdown note.' },
        slug: { type: 'string', description: 'Paper note slug; resolves to the newest guided reading state.' },
        sectionIndex: { type: 'integer', minimum: 1, description: 'Optional section index. Defaults to first pending section.' },
      },
    },
    async execute(args, ctx) {
      const result = await readPaperSection(
        {
          statePath: typeof args.statePath === 'string' ? args.statePath : undefined,
          notePath: typeof args.notePath === 'string' ? args.notePath : undefined,
          slug: typeof args.slug === 'string' ? args.slug : undefined,
          sectionIndex: typeof args.sectionIndex === 'number' ? args.sectionIndex : undefined,
        },
        opts,
        ctx,
      );
      return {
        success: true,
        data: result,
        summary: `read_paper_section loaded section ${result.section.index}: ${result.section.title}`,
      };
    },
  };
}

export function createRecordPaperSectionNoteTool(opts: ReaderToolOpts): Tool {
  return {
    name: 'record_paper_section_note',
    description: 'Persist the main agent generated note for one guided-reading section, mark it done in reader-state, and update the reading plan. Use after discussing a section with the user.',
    readOnly: false,
    concurrencySafe: false,
    exclusive: true,
    scopes: ['paper-read'],
    confirmation: {
      required: true,
      action: 'record a paper section note and update reading progress',
      patterns: ['记录', '沉淀', '写入', '保存', '更新\\s*(笔记|note|阅读进度)', 'mark\\s*(done|read)', 'record\\s*(note|section)', 'save\\s*(note|section)'],
      guidance: 'Ask the user to explicitly confirm before recording the section note.',
    },
    parameters: {
      type: 'object',
      properties: {
        statePath: { type: 'string', description: 'Path to <store>/<runId>/reader-state/<slug>.json.' },
        notePath: { type: 'string', description: 'Path to the guided reading markdown note.' },
        slug: { type: 'string', description: 'Paper note slug; resolves to the newest guided reading state.' },
        sectionIndex: { type: 'integer', minimum: 1, description: 'Section index to mark done. Defaults to first pending section.' },
        note: { type: 'string', description: 'Markdown note content for this section.' },
      },
      required: ['note'],
    },
    async execute(args, ctx) {
      const result = await recordPaperSectionNote(
        {
          statePath: typeof args.statePath === 'string' ? args.statePath : undefined,
          notePath: typeof args.notePath === 'string' ? args.notePath : undefined,
          slug: typeof args.slug === 'string' ? args.slug : undefined,
          sectionIndex: typeof args.sectionIndex === 'number' ? args.sectionIndex : undefined,
          note: typeof args.note === 'string' ? args.note : undefined,
        },
        opts,
        ctx,
      );
      return {
        success: true,
        data: result,
        summary: `record_paper_section_note recorded section ${result.section.index} in ${result.notePath}; completed=${result.completed}`,
      };
    },
  };
}

export async function readPaper(
  input: ReadPaperInput,
  opts: ReaderToolOpts,
  ctx?: ToolContext,
): Promise<ReadPaperResult> {
  const outputDir = guardedDir(ctx?.outputDir ?? opts.outputDir);
  const pdfPath = resolvePdfPath(input, outputDir);
  assertInsideAllowed(pdfPath, [ctx?.workspace, outputDir].filter(Boolean) as string[]);
  const extracted = await extractPdfText(pdfPath, 160_000);
  if (!extracted.sufficient) {
    throw new Error(`PDF text extraction insufficient: ${extracted.quality.reason}. Add a same-name .txt sidecar or use a PDF with extractable text.`);
  }
  const slug = normalizeSlug(input.slug ?? input.arxivId ?? extracted.titleHint);
  const title = inferTitleFromText(extracted.text, extracted.titleHint || slug);
  const runId = opts.runId ?? getRunId();
  const notePath = resolve(outputDir, runId, 'papers', `${slug}.md`);
  const statePath = resolve(outputDir, runId, 'reader-state', `${slug}.json`);
  const profilePath = opts.profilePath ?? resolve(outputDir, 'profile.md');
  assertInsideRoot(notePath, outputDir, 'note path escapes outputDir');
  assertInsideRoot(statePath, outputDir, 'state path escapes outputDir');

  const sections = splitPaperSections(extracted.text).map((section) => ({
    ...section,
    status: 'pending' as ReadingSectionStatus,
  }));
  const now = new Date().toISOString();
  const state: GuidedReadingState = {
    version: 1,
    slug,
    title,
    pdfPath,
    notePath,
    profilePath,
    extraction: extracted.extraction,
    extractionQuality: extracted.quality.reason,
    createdAt: now,
    updatedAt: now,
    completed: false,
    sections,
  };

  const note = renderGuidedNote({
    state,
    statePath,
  });
  await fs.mkdir(dirname(notePath), { recursive: true });
  await fs.mkdir(dirname(statePath), { recursive: true });
  await fs.writeFile(notePath, note, 'utf8');
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  await upsertPaperNode({
    outputDir,
    slug,
    title,
    notePath,
    arxivId: input.arxivId,
    status: 'reading',
  });

  await opts.trace?.emit('reader', 'observation', {
    slug,
    pdfPath,
    notePath,
    statePath,
    profilePath,
    sections: sections.length,
    profileUpdated: false,
    subagentMessages: 0,
  });

  const nextSection = nextPendingSection(state);
  return {
    slug,
    title,
    pdfPath,
    notePath,
    statePath,
    profilePath,
    profileUpdated: false,
    readingMode: 'guided',
    sections: publicSections(state),
    nextSection: nextSection ? publicSection(nextSection) : undefined,
    nextAction: nextSection
      ? `Ask the user whether to read section ${nextSection.index}: ${nextSection.title}. When the user wants to start or continue, call read_paper_section.`
      : 'No readable sections were found.',
    knowledgeNode: { id: slug, status: 'reading', notePath },
    usage: { input: 0, output: 0 },
    isolation: {
      pdfTextPersistedToMainSession: false,
      subagentMessages: 0,
    },
  };
}

export async function readPaperSection(
  input: ReadPaperSectionInput,
  opts: ReaderToolOpts,
  ctx?: ToolContext,
): Promise<ReadPaperSectionResult> {
  const outputDir = guardedDir(ctx?.outputDir ?? opts.outputDir);
  const statePath = await resolveStatePath(input, outputDir);
  const state = await loadState(statePath, outputDir);
  const section = selectSection(state, input.sectionIndex);

  await opts.trace?.emit('reader', 'observation', {
    slug: state.slug,
    notePath: state.notePath,
    statePath,
    sectionIndex: section.index,
    completed: state.completed,
    loadedChars: section.text.length,
    subagentMessages: 0,
  });

  const nextSection = nextSectionAfter(state, section.index);
  const previousSection = state.sections
    .filter((item) => item.index < section.index)
    .at(-1);
  return {
    slug: state.slug,
    title: state.title,
    notePath: state.notePath,
    statePath,
    section: publicSectionWithText(section),
    completed: state.completed,
    previousSection: previousSection ? publicSection(previousSection) : undefined,
    nextSection: nextSection ? publicSection(nextSection) : undefined,
    noteInstruction: `Discuss section ${section.index} with the user. When the user confirms the section note should be saved, call record_paper_section_note with sectionIndex=${section.index}.`,
  };
}

export async function recordPaperSectionNote(
  input: RecordPaperSectionNoteInput,
  opts: ReaderToolOpts,
  ctx?: ToolContext,
): Promise<RecordPaperSectionNoteResult> {
  const outputDir = guardedDir(ctx?.outputDir ?? opts.outputDir);
  const statePath = await resolveStatePath(input, outputDir);
  const state = await loadState(statePath, outputDir);
  const section = selectSection(state, input.sectionIndex);
  const noteContent = input.note?.trim();
  if (!noteContent) throw new Error('record_paper_section_note requires note content');

  section.status = 'done';
  section.note = noteContent;
  section.completedAt = new Date().toISOString();
  state.updatedAt = section.completedAt;
  state.completed = state.sections.every((item) => item.status === 'done');

  const original = await fs.readFile(state.notePath, 'utf8');
  const note = updateGuidedNote(original, state, section);
  await fs.writeFile(state.notePath, note, 'utf8');
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

  let profileUpdated = false;
  const verdict = extractVerdict(note);
  const summaryShort = state.completed ? buildSummaryShort(note, state) : undefined;
  if (state.completed) {
    const profile = await updateProfileFromNote({
      profilePath: state.profilePath,
      notePath: state.notePath,
      slug: state.slug,
      title: state.title,
      verdict,
    });
    profileUpdated = profile.created;
  }
  if (state.completed) {
    await upsertPaperNode({
      outputDir,
      slug: state.slug,
      title: state.title,
      notePath: state.notePath,
      status: 'read',
      summaryShort,
    });
    await consolidatePaperNode({
      outputDir,
      slug: state.slug,
      title: state.title,
      notePath: state.notePath,
      llm: opts.llm,
    });
  } else {
    await upsertPaperNode({
      outputDir,
      slug: state.slug,
      title: state.title,
      notePath: state.notePath,
      status: 'reading',
      summaryShort,
    });
  }

  await opts.trace?.emit('reader', 'observation', {
    slug: state.slug,
    notePath: state.notePath,
    statePath,
    sectionIndex: section.index,
    completed: state.completed,
    profileUpdated,
    subagentMessages: 0,
  });

  const nextSection = nextPendingSection(state);
  return {
    slug: state.slug,
    title: state.title,
    notePath: state.notePath,
    statePath,
    section: {
      index: section.index,
      title: section.title,
      chars: section.chars,
      status: section.status,
    },
    completed: state.completed,
    nextSection: nextSection ? publicSection(nextSection) : undefined,
    profileUpdated,
  };
}

async function upsertPaperNode(input: {
  outputDir: string;
  slug: string;
  title: string;
  notePath: string;
  arxivId?: string;
  status: 'reading' | 'read';
  summaryShort?: string;
}): Promise<void> {
  const store = new PaperKnowledgeStore({ outputDir: input.outputDir });
  await store.upsertNode({
    id: input.slug,
    title: input.title,
    summary_short: input.summaryShort,
    note_path: input.notePath,
    arxiv_id: input.arxivId,
    status: input.status,
  });
}

async function consolidatePaperNode(input: {
  outputDir: string;
  slug: string;
  title: string;
  notePath: string;
  llm: LLMClient;
}): Promise<void> {
  const store = new PaperKnowledgeStore({ outputDir: input.outputDir });
  await store.consolidatePaper({
    id: input.slug,
    title: input.title,
    note_path: input.notePath,
    llm: input.llm,
  });
}

function resolvePdfPath(input: ReadPaperInput, outputDir: string): string {
  if (input.pdfPath) return resolve(input.pdfPath);
  if (!input.arxivId) throw new Error('read_paper requires pdfPath or arxivId');
  const safe = input.arxivId.trim().replace(/\//g, '_');
  if (!/^[a-zA-Z0-9._-]+$/.test(safe)) throw new Error('invalid arxivId');
  return resolve(outputDir, 'pdfs', `${safe}.pdf`);
}

async function resolveStatePath(input: ReadPaperSectionInput, outputDir: string): Promise<string> {
  if (input.statePath) {
    const statePath = resolve(input.statePath);
    assertInsideRoot(statePath, outputDir, 'state path escapes outputDir');
    return statePath;
  }

  if (input.notePath) {
    const notePath = resolve(input.notePath);
    assertInsideRoot(notePath, outputDir, 'note path escapes outputDir');
    const note = await fs.readFile(notePath, 'utf8');
    const stateLine = note.split('\n').find((line) => /^reading_state:\s*/i.test(line));
    const statePath = stateLine?.replace(/^reading_state:\s*/i, '').trim();
    if (!statePath) throw new Error('guided reading state not found in note');
    const resolved = resolve(statePath);
    assertInsideRoot(resolved, outputDir, 'state path escapes outputDir');
    return resolved;
  }

  if (input.slug) {
    const found = await findNewestStateBySlug(outputDir, normalizeSlug(input.slug));
    if (found) return found;
  }

  throw new Error('read_paper_section requires statePath, notePath, or slug');
}

async function findNewestStateBySlug(outputDir: string, slug: string): Promise<string | null> {
  const matches: Array<{ path: string; mtimeMs: number }> = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name === `${slug}.json` && path.includes(`${sep}reader-state${sep}`)) {
        matches.push({ path, mtimeMs: (await fs.stat(path)).mtimeMs });
      }
    }
  };
  await walk(outputDir);
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.path ?? null;
}

async function loadState(statePath: string, outputDir: string): Promise<GuidedReadingState> {
  assertInsideRoot(statePath, outputDir, 'state path escapes outputDir');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as GuidedReadingState;
  assertInsideRoot(state.notePath, outputDir, 'note path escapes outputDir');
  assertInsideRoot(state.profilePath, outputDir, 'profile path escapes outputDir');
  return state;
}

function selectSection(state: GuidedReadingState, sectionIndex?: number): GuidedReadingSection {
  const section = typeof sectionIndex === 'number'
    ? state.sections.find((item) => item.index === sectionIndex)
    : nextPendingSection(state);
  if (!section) throw new Error('no pending section found for guided reading');
  return section;
}

function renderGuidedNote(opts: { state: GuidedReadingState; statePath: string }): string {
  const { state, statePath } = opts;
  return [
    `# ${state.title}`,
    '',
    `slug: ${state.slug}`,
    `source_pdf: ${state.pdfPath}`,
    `reading_mode: guided`,
    `reading_state: ${statePath}`,
    `status: in_progress`,
    `extraction: ${state.extraction}`,
    `extraction_quality: ${state.extractionQuality}`,
    '',
    '## Reading Plan',
    '',
    ...state.sections.map((section) => `- [ ] ${section.index}. ${section.title} (${section.chars} chars)`),
    '',
    '## Section Notes',
    '',
    '_逐节精读时, 每一节的笔记会追加到这里。_',
    '',
    '## Verdict',
    '',
    'pending: 逐节精读尚未完成。',
    '',
    '## Self-Ask',
    '',
    '- 后续章节需要验证哪些假设?',
    '- 哪些方法细节值得沉淀为实现参考?',
    '',
  ].join('\n');
}

function updateGuidedNote(markdown: string, state: GuidedReadingState, section: GuidedReadingSection): string {
  let next = updateStatusLines(markdown, state);
  next = updateReadingPlan(next, state);
  next = upsertSectionNote(next, section);
  if (state.completed) {
    next = replaceBlock(next, 'Verdict', 2, 'maybe: 所有计划内 section 已完成精读; 请结合逐节笔记再形成最终 adopt/skip 判断。');
  }
  return next;
}

function updateStatusLines(markdown: string, state: GuidedReadingState): string {
  return markdown
    .replace(/^status:\s*.*$/m, `status: ${state.completed ? 'completed' : 'in_progress'}`)
    .replace(/^reading_mode:\s*.*$/m, 'reading_mode: guided');
}

function updateReadingPlan(markdown: string, state: GuidedReadingState): string {
  let out = markdown;
  for (const section of state.sections) {
    const mark = section.status === 'done' ? 'x' : ' ';
    const re = new RegExp(`^- \\[[ xX]\\] ${section.index}\\. .*$`, 'm');
    const line = `- [${mark}] ${section.index}. ${section.title} (${section.chars} chars)`;
    out = re.test(out) ? out.replace(re, line) : out;
  }
  return out;
}

function upsertSectionNote(markdown: string, section: GuidedReadingSection): string {
  const heading = `${section.index}. ${section.title}`;
  return replaceBlock(markdown, heading, 3, section.note ?? '');
}

function replaceBlock(markdown: string, heading: string, level: number, content: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const headingLine = `${'#'.repeat(level)} ${heading}`;
  const headingRe = new RegExp(`^#{${level}}\\s+${escapeRegExp(heading)}\\s*$`, 'i');
  const start = lines.findIndex((line) => headingRe.test(line));
  const block = [headingLine, '', content.trim(), ''];

  if (start === -1) {
    const sectionNotesIdx = lines.findIndex((line) => /^##\s+Section Notes\s*$/i.test(line));
    if (level === 3 && sectionNotesIdx >= 0) {
      let insertAt = sectionNotesIdx + 1;
      while (insertAt < lines.length && !/^##\s+/.test(lines[insertAt]!)) insertAt++;
      lines.splice(insertAt, 0, '', ...block);
      return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
    }
    return `${normalized.trimEnd()}\n\n${block.join('\n')}`;
  }

  let end = start + 1;
  while (end < lines.length) {
    const nextLevel = headingLevel(lines[end]!);
    if (nextLevel !== null && nextLevel <= level) break;
    end++;
  }
  lines.splice(start, end - start, ...block);
  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
}

function extractVerdict(text: string): 'adopt' | 'maybe' | 'skip' | 'unknown' {
  const lower = text.toLowerCase();
  if (lower.includes('adopt')) return 'adopt';
  if (lower.includes('skip')) return 'skip';
  if (lower.includes('maybe')) return 'maybe';
  return 'unknown';
}

function buildSummaryShort(note: string, state: GuidedReadingState): string {
  const takeaways = extractSubsectionText(note, 'Section Takeaway');
  const keyPoints = extractSubsectionText(note, 'Key Points');
  const source = uniqueSummaryLines([...takeaways, ...keyPoints]).slice(0, 4).join(' ');
  const fallback = `完成 guided reading, verdict=${extractVerdict(note)}.`;
  return truncateSummary(`${state.title}: ${source || fallback}`, 500);
}

function uniqueSummaryLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function extractSubsectionText(markdown: string, heading: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`^####\\s+${escapeRegExp(heading)}\\s*$`, 'gim');
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const start = match.index + match[0].length;
    const next = markdown.slice(start).search(/\n#{2,4}\s+/);
    const block = next >= 0 ? markdown.slice(start, start + next) : markdown.slice(start);
    const cleaned = cleanSummaryBlock(block);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

function cleanSummaryBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('```'))
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateSummary(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 3).trimEnd()}...`;
}

function normalizeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\//g, '_')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || `paper-${Date.now()}`;
}

function guardedDir(path: string): string {
  return resolve(path);
}

function assertInsideAllowed(path: string, roots: string[]): void {
  const target = resolve(path);
  const allowed = roots.map((root) => resolve(root));
  if (allowed.some((root) => target === root || target.startsWith(root + sep))) return;
  throw new Error(`PDF path is outside allowed workspace/output roots: ${basename(path)}`);
}

function assertInsideRoot(path: string, root: string, message: string): void {
  const target = resolve(path);
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`${message}: ${path}`);
  }
}

function publicSections(state: GuidedReadingState): ReadPaperResult['sections'] {
  return state.sections.map((section) => ({
    index: section.index,
    title: section.title,
    chars: section.chars,
    status: section.status,
  }));
}

function publicSection(section: GuidedReadingSection): { index: number; title: string; chars: number } {
  return {
    index: section.index,
    title: section.title,
    chars: section.chars,
  };
}

function publicSectionWithText(section: GuidedReadingSection): ReadPaperSectionResult['section'] {
  return {
    index: section.index,
    title: section.title,
    chars: section.chars,
    status: section.status,
    text: section.text,
  };
}

function nextPendingSection(state: GuidedReadingState): GuidedReadingSection | undefined {
  return state.sections.find((section) => section.status === 'pending');
}

function nextSectionAfter(state: GuidedReadingState, index: number): GuidedReadingSection | undefined {
  return state.sections.find((section) => section.index > index);
}

function headingLevel(line: string): number | null {
  const match = /^(#{1,6})\s+/.exec(line);
  return match ? match[1]!.length : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
