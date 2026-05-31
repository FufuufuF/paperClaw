import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import {
  type LLMClient,
  TraceBus,
  readProfile,
  getRunId,
  runOutputDir,
  getRepoRoot,
} from '@paperclaw/core';
import { searchArxiv, type ArxivCandidate } from '../tools/arxiv.js';
import { triageBatch, type TriageItem } from '../tools/triage.js';
import { decomposeQuery, decideReplan } from './planner.js';
import type { ShortlistEntry } from '../types.js';

export interface QueryFlowOpts {
  query: string;
  llm: LLMClient;
  /** absolute path to profile.md; defaults to <repo>/output/profile.md */
  profilePath?: string;
  /** target shortlist size; F3 / AC1 wants ≥5 */
  targetN?: number;
  /** per-term arXiv max results; default 30 keeps total candidates manageable */
  perTermMax?: number;
  /** triage parallelism */
  concurrency?: number;
  /** hard cap on replan rounds (AC2: 防止无限循环) */
  maxRounds?: number;
  /** override run id (mostly for tests) */
  runId?: string;
  /** override output dir (mostly for tests) */
  outDirOverride?: string;
}

export interface QueryFlowResult {
  run_id: string;
  out_dir: string;
  shortlist: ShortlistEntry[];
  rounds: number;
  used_terms: string[];
  filtered_already_read: string[];
  trace_path: string;
  shortlist_path: string;
  meta_path: string;
  usage: { input: number; output: number };
}

const RECOMMEND_FLOOR = 3; // AC2: < 3 → replan

/**
 * F3 / AC1 entrypoint.
 *
 *  query → decompose → search × N → triage (parallel) → replan? → loop
 *  → final shortlist (verdict !== 'skip', already-read filtered out)
 *
 * The shortlist is written to `output/<run_id>/shortlist.json` so the CLI
 * `search:download` step can consume arxiv_ids without re-running search.
 */
export async function queryFlow(opts: QueryFlowOpts): Promise<QueryFlowResult> {
  const root = getRepoRoot();
  const runId = opts.runId ?? getRunId();
  const outDir = opts.outDirOverride ?? (await runOutputDir(runId, root));
  const tracePath = join(outDir, 'trace.jsonl');
  const trace = new TraceBus(tracePath, 'master');

  const profilePath = opts.profilePath ?? join(root, 'output', 'profile.md');
  const profile = await readProfile(profilePath);

  const targetN = opts.targetN ?? 5;
  const perTermMax = opts.perTermMax ?? 30;
  const maxRounds = opts.maxRounds ?? 2;
  const concurrency = opts.concurrency ?? 8;

  await trace.emit('plan', 'phase_begin', { phase_name: 'query_flow', query: opts.query });
  await trace.emit('plan', 'thought', {
    text: `query="${opts.query}"; profile_known=${profile.raw !== null}; read_n=${profile.readSlugs.length}`,
  });

  // ── Round 1: decompose ──────────────────────────────────────────────────
  const decomp = await decomposeQuery(
    opts.llm,
    opts.query,
    profile.readSlugs.length > 0 ? profile.readSlugs.slice(0, 12).join(', ') : undefined,
  );
  await trace.emit('plan', 'tool_call', {
    tool: 'decompose_query',
    args: { query: opts.query },
    result: decomp,
  });

  const usedTerms: string[] = [];
  const allTriage: TriageItem[] = [];
  // Best-effort planner usage (decompose + replan calls). Triage cost is
  // dominant but tracked separately in trace 'triage' observations; we don't
  // bubble it into `usage` to keep this number's meaning crisp.
  let plannerIn = decomp.usage.input;
  let plannerOut = decomp.usage.output;
  let round = 0;
  let pendingTerms = decomp.terms.slice();

  while (pendingTerms.length > 0 && round < maxRounds) {
    round += 1;
    const roundTerms = pendingTerms.slice();
    pendingTerms = [];
    await trace.emit('plan', 'thought', { round, text: `running terms: ${JSON.stringify(roundTerms)}` });

    const candidates = await searchAcrossTerms(roundTerms, perTermMax, trace, profile.readSlugs);
    if (candidates.length === 0) {
      await trace.emit('search', 'observation', { round, n: 0, note: 'no candidates after dedup' });
      break;
    }

    const triaged = await triageBatch(candidates.map((c) => c.candidate), {
      llm: opts.llm,
      trace,
      query: opts.query,
      concurrency,
    });
    // attach matched term to each result via the parallel candidates list
    for (let i = 0; i < triaged.length; i++) {
      (triaged[i] as TriageItem & { matched_term?: string }).matched_term = candidates[i]!.matched_term;
    }
    allTriage.push(...triaged);
    usedTerms.push(...roundTerms);

    const recommendCount = triaged.filter((t) => t.verdict === 'recommend').length;
    const maybeCount = triaged.filter((t) => t.verdict === 'maybe').length;
    const skipCount = triaged.filter((t) => t.verdict === 'skip').length;

    await trace.emit('plan', 'observation', {
      round,
      recommend: recommendCount,
      maybe: maybeCount,
      skip: skipCount,
    });

    // Decide whether to replan. AC2: hard cap (maxRounds) + LLM judgement.
    if (round >= maxRounds) break;
    const totalRecommended = allTriage.filter((t) => t.verdict === 'recommend').length;
    if (totalRecommended >= RECOMMEND_FLOOR && totalRecommended >= targetN) break;

    const replan = await decideReplan(opts.llm, {
      query: opts.query,
      round,
      usedTerms,
      recommendCount,
      maybeCount,
      skipCount,
      sampleRecommendTitles: triaged
        .filter((t) => t.verdict === 'recommend')
        .map((t) => t.title)
        .slice(0, 6),
    });

    plannerIn += replan.usage.input;
    plannerOut += replan.usage.output;

    if (replan.should_replan && replan.new_terms.length > 0) {
      const fresh = replan.new_terms.filter((t) => !usedTerms.includes(t));
      await trace.emit('plan', 'replan', {
        round,
        new_terms: fresh,
        reason: replan.reason,
      });
      pendingTerms = fresh;
    } else {
      await trace.emit('plan', 'thought', { round, text: `no replan: ${replan.reason}` });
      break;
    }
  }

  // ── Build shortlist (already-read filtered, skip dropped, dedup) ────────
  const shortlist: ShortlistEntry[] = dedupeByArxivId(
    allTriage
      .filter((t) => t.verdict !== 'skip')
      .filter((t) => !profile.readSlugs.includes(t.arxiv_id.toLowerCase()))
      .map((t) => ({
        arxiv_id: t.arxiv_id,
        title: t.title,
        authors: t.authors,
        year: t.year,
        verdict: t.verdict,
        reason: t.reason,
        summary: t.summary,
        matched_term: (t as TriageItem & { matched_term?: string }).matched_term ?? '',
      })),
  ).sort(byVerdictThenYear);

  // Planner-only usage (decompose + replan). Triage usage is much larger
  // but its per-call totals live in trace 'triage' observation events; we
  // keep the two numbers separate so "did the planner blow up" can be
  // answered at a glance.
  const usage = { input: plannerIn, output: plannerOut };

  const shortlistPath = join(outDir, 'shortlist.json');
  await fs.writeFile(
    shortlistPath,
    JSON.stringify(
      { run_id: runId, query: opts.query, generated_at: new Date().toISOString(), shortlist },
      null,
      2,
    ),
    'utf8',
  );

  const metaPath = join(outDir, 'meta.json');
  await fs.writeFile(
    metaPath,
    JSON.stringify(
      {
        run_id: runId,
        flow: 'query',
        query: opts.query,
        rounds: round,
        used_terms: usedTerms,
        candidate_total: allTriage.length,
        recommend_total: allTriage.filter((t) => t.verdict === 'recommend').length,
        shortlist_size: shortlist.length,
        profile_used: profile.raw !== null,
        profile_read_n: profile.readSlugs.length,
      },
      null,
      2,
    ),
    'utf8',
  );

  await trace.emit('plan', 'phase_end', {
    phase_name: 'query_flow',
    shortlist_size: shortlist.length,
  });
  await trace.close();

  return {
    run_id: runId,
    out_dir: outDir,
    shortlist,
    rounds: round,
    used_terms: usedTerms,
    filtered_already_read: profile.readSlugs,
    trace_path: tracePath,
    shortlist_path: shortlistPath,
    meta_path: metaPath,
    usage,
  };
}

interface MatchedCandidate {
  candidate: ArxivCandidate;
  matched_term: string;
}

/**
 * Run all of `terms` against arXiv in parallel, dedupe by arxiv_id, and drop
 * anything already in the user's read history. Returns candidates paired
 * with the term that surfaced them (used for shortlist UI grouping).
 */
async function searchAcrossTerms(
  terms: string[],
  perTermMax: number,
  trace: TraceBus,
  readSlugs: string[],
): Promise<MatchedCandidate[]> {
  const seen = new Set<string>();
  const readSet = new Set(readSlugs.map((s) => s.toLowerCase()));
  const out: MatchedCandidate[] = [];

  // Run searches in parallel; arXiv tolerates this for ≤4 concurrent calls.
  const perTerm = await Promise.all(
    terms.map(async (term) => {
      try {
        await trace.emit('search', 'tool_call', {
          tool: 'search_arxiv',
          args: { query: term, max_n: perTermMax },
        });
        const cs = await searchArxiv(term, perTermMax);
        await trace.emit('search', 'observation', { tool: 'search_arxiv', term, n: cs.length });
        return { term, cs };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await trace.emit('search', 'error', { tool: 'search_arxiv', term, error: msg });
        return { term, cs: [] as ArxivCandidate[] };
      }
    }),
  );

  for (const { term, cs } of perTerm) {
    for (const c of cs) {
      const key = c.arxiv_id.toLowerCase();
      if (seen.has(key)) continue;
      if (readSet.has(key)) continue; // already-read filter
      seen.add(key);
      out.push({ candidate: c, matched_term: term });
    }
  }
  return out;
}

function dedupeByArxivId(rows: ShortlistEntry[]): ShortlistEntry[] {
  const seen = new Set<string>();
  const out: ShortlistEntry[] = [];
  for (const r of rows) {
    if (seen.has(r.arxiv_id)) continue;
    seen.add(r.arxiv_id);
    out.push(r);
  }
  return out;
}

function byVerdictThenYear(a: ShortlistEntry, b: ShortlistEntry): number {
  const rank = { recommend: 0, maybe: 1, skip: 2 } as const;
  const va = rank[a.verdict];
  const vb = rank[b.verdict];
  if (va !== vb) return va - vb;
  return (b.year || 0) - (a.year || 0);
}
