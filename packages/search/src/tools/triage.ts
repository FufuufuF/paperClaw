import { mapWithConcurrency, type LLMClient, type TraceBus } from '@paperclaw/core';
import type { ArxivCandidate } from './arxiv.js';

export type TriageVerdict = 'recommend' | 'maybe' | 'skip';

export interface TriageItem {
  arxiv_id: string;
  title: string;
  verdict: TriageVerdict;
  reason: string;
  summary: string;
  /** the abstract that was classified (kept for trace replay) */
  abstract: string;
  /** which input candidate this came from */
  authors: string[];
  year: number;
}

export interface TriageOpts {
  llm: LLMClient;
  trace?: TraceBus;
  /** the user's query (Query mode) — passed to the LLM as relevance anchor */
  query?: string;
  /** Cron mode: inferred interest themes (passed to LLM in lieu of a query) */
  inferredInterest?: string;
  /** parallelism cap; AC7 wants 50 candidates < 30s end-to-end */
  concurrency?: number;
}

/**
 * Plan F2: per-paper LLM judgement, run in parallel (not serial). One LLM
 * call per paper because batching abstracts into one call has shown poor
 * recall in our local testing on DeepSeek (the model latches onto a couple
 * of abstracts and forgets the rest).
 *
 * `verdict ∈ {recommend, maybe, skip}` per design.md §2.1. `reason` must be
 * concrete (AC3 forbids "this paper is relevant"-style boilerplate).
 */
export async function triageBatch(
  candidates: ArxivCandidate[],
  opts: TriageOpts,
): Promise<TriageItem[]> {
  if (candidates.length === 0) return [];

  const concurrency = opts.concurrency ?? 8;
  const t0 = Date.now();

  const results = await mapWithConcurrency(candidates, concurrency, async (c, idx) => {
    try {
      const r = await triageOne(c, opts);
      return r;
    } catch (err) {
      // Triage is best-effort: a single LLM hiccup shouldn't kill the run.
      // Return a 'skip' verdict with the error so the trace tells the story.
      const msg = err instanceof Error ? err.message : String(err);
      await opts.trace?.emit('triage', 'error', { arxiv_id: c.arxiv_id, error: msg, idx });
      return {
        arxiv_id: c.arxiv_id,
        title: c.title,
        verdict: 'skip' as const,
        reason: `triage failed: ${msg}`,
        summary: '',
        abstract: c.abstract,
        authors: c.authors,
        year: c.year,
      };
    }
  });

  const elapsed = Date.now() - t0;
  const counts = countVerdicts(results);
  await opts.trace?.emit('triage', 'observation', {
    n: results.length,
    elapsed_ms: elapsed,
    ...counts,
  });

  return results;
}

async function triageOne(c: ArxivCandidate, opts: TriageOpts): Promise<TriageItem> {
  const anchor = opts.query
    ? `用户的检索意图: "${opts.query}".`
    : opts.inferredInterest
    ? `根据用户笔记推断的研究方向: ${opts.inferredInterest}.`
    : '当前是无 query / 无 profile 的冷启动检索, 请按"是否是值得读的近期 agent / LLM 研究"判断.';

  const system = `你是一个论文 triage 助手. 接收一篇论文的 title + abstract, 输出严格的 JSON:
{
  "verdict": "recommend" | "maybe" | "skip",
  "reason": "20-60 字中文, 必须具体引用 abstract 中出现的方法 / 现象 / 数据集 / 论点; 严禁英文; 严禁 'this paper is relevant' 这类废话",
  "summary": "1-2 句中文简介, 概括论文做了什么 + 结果; 必须使用中文, 不要用英文"
}

判断标准:
- recommend: 与用户意图强相关, 方法或结论明显有意思
- maybe: 主题相关但贡献不显著, 或不确定
- skip: 跑题 / 仅 abstract 复述背景 / 与意图无关

重要: reason 和 summary 必须全部使用中文回复, 不要使用英文.
只输出 JSON, 不要前后文.`;

  const userMsg = `${anchor}

论文: ${c.title}
作者: ${c.authors.slice(0, 4).join(', ')}${c.authors.length > 4 ? ' 等' : ''}
年份: ${c.year}
arxiv_id: ${c.arxiv_id}

Abstract:
${c.abstract}`;

  const res = await opts.llm.chat({
    system,
    messages: [{ role: 'user', content: userMsg }],
    responseFormat: 'json_object',
    temperature: 0.2,
    maxTokens: 400,
  });

  const parsed = parseTriageJson(res.text ?? '');

  return {
    arxiv_id: c.arxiv_id,
    title: c.title,
    verdict: parsed.verdict,
    reason: parsed.reason,
    summary: parsed.summary,
    abstract: c.abstract,
    authors: c.authors,
    year: c.year,
  };
}

interface ParsedTriage {
  verdict: TriageVerdict;
  reason: string;
  summary: string;
}

function parseTriageJson(text: string): ParsedTriage {
  // Strip code fences if the model misbehaves
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    return { verdict: 'skip', reason: `unparseable LLM output: ${cleaned.slice(0, 80)}`, summary: '' };
  }
  const obj = (raw ?? {}) as Record<string, unknown>;
  const v = String(obj.verdict ?? '').toLowerCase();
  const verdict: TriageVerdict =
    v === 'recommend' || v === 'maybe' || v === 'skip' ? v : 'skip';
  return {
    verdict,
    reason: typeof obj.reason === 'string' ? obj.reason : '',
    summary: typeof obj.summary === 'string' ? obj.summary : '',
  };
}

function countVerdicts(items: TriageItem[]): Record<string, number> {
  const out: Record<string, number> = { recommend: 0, maybe: 0, skip: 0 };
  for (const it of items) out[it.verdict] = (out[it.verdict] ?? 0) + 1;
  return out;
}
