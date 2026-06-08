import { resolve, sep } from 'node:path';
import {
  readProfile,
  type LLMClient,
  type Tool,
  type ToolContext,
  type TraceBus,
} from '@paperclaw/core';
import { decomposeQuery, decideReplan } from './flows/planner.js';
import { downloadPdfs, type DownloadResult } from './tools/download.js';
import { searchArxiv, type ArxivCandidate } from './tools/arxiv.js';
import { triageBatch, type TriageItem } from './tools/triage.js';

export interface PaperSearchToolOpts {
  llm: LLMClient;
  outputDir: string;
  profilePath?: string;
  trace?: TraceBus;
  state?: PaperSearchState;
  searchFn?: typeof searchArxiv;
  triageFn?: typeof triageBatch;
  downloadFn?: typeof downloadPdfs;
}

export interface ShortlistItem {
  index: number;
  arxiv_id: string;
  title: string;
  authors: string[];
  year: number;
  verdict: TriageItem['verdict'];
  reason: string;
  summary: string;
  pdf_url?: string;
}

export interface SearchTrace {
  query: string;
  mode: 'fast' | 'thorough' | 'cron';
  terms: string[];
  candidateCount: number;
  triageCounts: Record<string, number>;
  replan?: {
    should_replan: boolean;
    new_terms: string[];
    reason: string;
  };
}

export interface PaperSearchResult {
  query: string;
  mode: 'fast' | 'thorough' | 'cron';
  shortlist: ShortlistItem[];
  trace: SearchTrace;
  profile: {
    path: string;
    readCount: number;
    personalization: 'cold' | 'weak' | 'full';
  };
}

export class PaperSearchState {
  private readonly shortlistBySession = new Map<string, ShortlistItem[]>();

  set(sessionId: string, items: ShortlistItem[]): void {
    this.shortlistBySession.set(sessionId, items);
  }

  get(sessionId: string): ShortlistItem[] {
    return this.shortlistBySession.get(sessionId) ?? [];
  }
}

export function createPaperSearchTools(opts: PaperSearchToolOpts): Tool[] {
  const state = opts.state ?? new PaperSearchState();
  return [
    createPaperSearchTool({ ...opts, state }),
    createDownloadPaperTool({ ...opts, state }),
  ];
}

export function createPaperSearchTool(opts: PaperSearchToolOpts & { state: PaperSearchState }): Tool {
  return {
    name: 'paper_search',
    description: 'Search arXiv for papers, triage candidates, and return a ranked shortlist. This tool only searches; do not download PDFs or read papers unless the user explicitly asks for that follow-up.',
    readOnly: true,
    concurrencySafe: false,
    scopes: ['paper-search'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language paper search query. Required outside cron mode.' },
        mode: { type: 'string', enum: ['fast', 'thorough', 'cron'], description: 'Search mode.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum candidates per term.' },
        excludeArxivIds: { type: 'array', items: { type: 'string' }, description: 'arXiv ids to exclude from results.' },
      },
    },
    async execute(args, ctx) {
      const result = await runPaperSearch(args, opts, ctx);
      const sessionId = ctx?.request?.sessionId ?? 'default';
      opts.state.set(sessionId, result.shortlist);
      return {
        success: true,
        data: result,
        summary: summarizeShortlist(result.shortlist),
      };
    },
  };
}

export function createDownloadPaperTool(opts: PaperSearchToolOpts & { state: PaperSearchState }): Tool {
  return {
    name: 'download_paper',
    description: 'Download arXiv PDFs by arXiv id, or by 1-based indexes from the latest paper_search shortlist. Use only when the user explicitly asks to download/save PDFs.',
    readOnly: false,
    concurrencySafe: false,
    exclusive: true,
    scopes: ['paper-search'],
    confirmation: {
      required: true,
      action: 'download PDFs',
      patterns: ['下载', 'download', '保存\\s*(pdf|论文)', 'save\\s*(pdf|paper)', '拉取\\s*(pdf|论文)', '精读', '阅读\\s*(论文|paper|pdf)', '读(一下|这篇|这个|第)?\\s*(论文|paper|pdf|\\d+)', '生成\\s*(笔记|note)', '总结\\s*(这篇|这个|.*pdf|.*论文|.*paper)'],
      guidance: 'Ask the user which shortlist items or arXiv ids they want to download before calling download_paper.',
    },
    parameters: {
      type: 'object',
      properties: {
        arxivIds: { type: 'array', items: { type: 'string' }, description: 'Explicit arXiv ids to download.' },
        indices: { type: 'array', items: { type: 'integer' }, description: '1-based indexes from latest paper_search shortlist.' },
      },
    },
    async execute(args, ctx) {
      const ids = resolveDownloadIds(args, opts.state, ctx?.request?.sessionId ?? 'default');
      if (ids.length === 0) {
        return {
          success: false,
          data: { error: 'No arXiv ids or shortlist indexes were provided.' },
          summary: 'download_paper missing ids',
        };
      }
      const outputDir = guardedOutputDir(ctx, opts.outputDir, 'pdfs');
      const results = await (opts.downloadFn ?? downloadPdfs)(ids, outputDir);
      return {
        success: results.every((item) => item.ok),
        data: { results },
        summary: summarizeDownloads(results),
      };
    },
  };
}

async function runPaperSearch(
  args: Record<string, unknown>,
  opts: PaperSearchToolOpts,
  ctx?: ToolContext,
): Promise<PaperSearchResult> {
  const mode = normalizeMode(args.mode);
  const maxResults = clampInt(args.maxResults, 10, 1, 50);
  const profilePath = opts.profilePath ?? resolve(guardedOutputDir(ctx, opts.outputDir), 'profile.md');
  const profile = await readProfile(profilePath);
  const personalization = profile.readSlugs.length >= 8 ? 'full' : profile.readSlugs.length >= 3 ? 'weak' : 'cold';

  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const excludedArxivIds = normalizeArxivIds(args.excludeArxivIds);
  if (!query && mode !== 'cron') {
    throw new Error('paper_search requires query unless mode="cron"');
  }

  let effectiveQuery = query;
  let terms: string[] = [];
  if (mode === 'cron') {
    if (query) {
      const decompose = await decomposeQuery(opts.llm, query);
      terms = decompose.terms;
      effectiveQuery = query;
    } else {
      effectiveQuery = 'recent LLM agents papers';
      terms = [effectiveQuery];
    }
  } else {
    const decompose = await decomposeQuery(
      opts.llm,
      query,
      profile.readSlugs.length > 0 ? profile.readSlugs.slice(0, 20).join(', ') : undefined,
    );
    terms = decompose.terms;
  }

  const searchFn = opts.searchFn ?? searchArxiv;
  const triageFn = opts.triageFn ?? triageBatch;
  const candidates = dedupeCandidates(
    (await runSearchTerms(terms, maxResults, searchFn)).filter((item) =>
      !isAlreadyRead(item, profile.readSlugs) && !isExcludedArxivId(item, excludedArxivIds),
    ),
  );
  const triage = await triageFn(candidates, {
    llm: opts.llm,
    trace: opts.trace,
    query: mode === 'cron' ? undefined : effectiveQuery,
    inferredInterest: mode === 'cron' ? effectiveQuery : undefined,
  });

  let allCandidates = candidates;
  let allTriage = triage;
  let replan: SearchTrace['replan'];
  if (mode === 'thorough') {
    const counts = countVerdicts(triage);
    const decision = await decideReplan(opts.llm, {
      query: effectiveQuery,
      round: 1,
      usedTerms: terms,
      recommendCount: counts.recommend ?? 0,
      maybeCount: counts.maybe ?? 0,
      skipCount: counts.skip ?? 0,
      sampleRecommendTitles: triage.filter((item) => item.verdict === 'recommend').map((item) => item.title),
    });
    replan = {
      should_replan: decision.should_replan,
      new_terms: decision.new_terms,
      reason: decision.reason,
    };
    if (decision.should_replan) {
      const extraCandidates = dedupeCandidates(
        (await runSearchTerms(decision.new_terms, maxResults, searchFn))
          .filter((item) => !isAlreadyRead(item, profile.readSlugs) && !isExcludedArxivId(item, excludedArxivIds)),
      ).filter((item) => !allCandidates.some((existing) => existing.arxiv_id === item.arxiv_id));
      const extraTriage = await triageFn(extraCandidates, {
        llm: opts.llm,
        trace: opts.trace,
        query: effectiveQuery,
      });
      allCandidates = allCandidates.concat(extraCandidates);
      allTriage = allTriage.concat(extraTriage);
      terms = terms.concat(decision.new_terms);
    }
  }

  const byId = new Map(allCandidates.map((item) => [item.arxiv_id, item]));
  const ranked = rankTriage(allTriage)
    .slice(0, 12)
    .map((item, idx) => toShortlistItem(item, byId.get(item.arxiv_id), idx + 1));

  const trace: SearchTrace = {
    query: effectiveQuery,
    mode,
    terms,
    candidateCount: allCandidates.length,
    triageCounts: countVerdicts(allTriage),
    ...(replan ? { replan } : {}),
  };
  await opts.trace?.emit('search', 'observation', { ...trace });

  return {
    query: effectiveQuery,
    mode,
    shortlist: ranked,
    trace,
    profile: {
      path: profile.path,
      readCount: profile.readSlugs.length,
      personalization,
    },
  };
}

async function runSearchTerms(
  terms: string[],
  maxResults: number,
  searchFn: typeof searchArxiv,
): Promise<ArxivCandidate[]> {
  const out: ArxivCandidate[] = [];
  for (const term of terms.length > 0 ? terms : ['recent LLM agents papers']) {
    out.push(...await searchFn(term, maxResults));
  }
  return out;
}

function rankTriage(items: TriageItem[]): TriageItem[] {
  const score = { recommend: 0, maybe: 1, skip: 2 };
  return items.slice().sort((a, b) => score[a.verdict] - score[b.verdict] || b.year - a.year);
}

function toShortlistItem(item: TriageItem, candidate: ArxivCandidate | undefined, index: number): ShortlistItem {
  return {
    index,
    arxiv_id: item.arxiv_id,
    title: item.title,
    authors: item.authors,
    year: item.year,
    verdict: item.verdict,
    reason: item.reason,
    summary: item.summary,
    pdf_url: candidate?.pdf_url,
  };
}

function dedupeCandidates(items: ArxivCandidate[]): ArxivCandidate[] {
  const seen = new Set<string>();
  const out: ArxivCandidate[] = [];
  for (const item of items) {
    if (seen.has(item.arxiv_id)) continue;
    seen.add(item.arxiv_id);
    out.push(item);
  }
  return out;
}

function isAlreadyRead(item: ArxivCandidate, slugs: string[]): boolean {
  const id = item.arxiv_id.toLowerCase();
  return slugs.includes(id) || slugs.includes(id.replace(/\//g, '_'));
}

function isExcludedArxivId(item: ArxivCandidate, excluded: Set<string>): boolean {
  const id = item.arxiv_id.toLowerCase();
  return excluded.has(id) || excluded.has(id.replace(/\//g, '_'));
}

function normalizeArxivIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value
    .filter((item): item is string => typeof item === 'string')
    .flatMap((item) => {
      const id = item.trim().toLowerCase();
      return id ? [id, id.replace(/\//g, '_')] : [];
    }));
}

function countVerdicts(items: TriageItem[]): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    acc[item.verdict] = (acc[item.verdict] ?? 0) + 1;
    return acc;
  }, { recommend: 0, maybe: 0, skip: 0 });
}

function resolveDownloadIds(
  args: Record<string, unknown>,
  state: PaperSearchState,
  sessionId: string,
): string[] {
  const explicit = Array.isArray(args.arxivIds)
    ? args.arxivIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const shortlist = state.get(sessionId);
  const fromIndexes = Array.isArray(args.indices)
    ? args.indices
        .filter((item): item is number => typeof item === 'number' && Number.isInteger(item))
        .map((idx) => shortlist[idx - 1]?.arxiv_id)
        .filter((item): item is string => Boolean(item))
    : [];
  return Array.from(new Set([...explicit, ...fromIndexes]));
}

function guardedOutputDir(ctx: ToolContext | undefined, fallback: string, child?: string): string {
  const root = resolve(ctx?.outputDir ?? fallback);
  const target = resolve(root, child ?? '.');
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`output path escapes outputDir: ${target}`);
  }
  return target;
}

function normalizeMode(value: unknown): 'fast' | 'thorough' | 'cron' {
  return value === 'thorough' || value === 'cron' ? value : 'fast';
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function summarizeShortlist(items: ShortlistItem[]): string {
  if (items.length === 0) return 'No papers matched the search.';
  return items.slice(0, 5).map((item) => `${item.index}. ${item.title} (${item.arxiv_id})`).join('\n');
}

function summarizeDownloads(results: DownloadResult[]): string {
  const ok = results.filter((item) => item.ok).length;
  const failed = results.length - ok;
  return `Downloaded ${ok}/${results.length} PDFs${failed ? `, ${failed} failed` : ''}.`;
}
