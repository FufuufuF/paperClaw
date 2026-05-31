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
import { inferInterestForCron } from './planner.js';
import type { ShortlistEntry } from '../types.js';

export interface CronFlowOpts {
  llm: LLMClient;
  profilePath?: string;
  targetN?: number;
  perTermMax?: number;
  concurrency?: number;
  runId?: string;
  outDirOverride?: string;
}

export interface CronFlowResult {
  run_id: string;
  out_dir: string;
  shortlist: ShortlistEntry[];
  directions: Array<{ theme: string; term: string; evidence_slug: string }>;
  summary: string;
  trace_path: string;
  shortlist_path: string;
  meta_path: string;
  /** set when profile is too thin to recommend (AC5: 报错 not crash) */
  not_enough_profile?: { reason: string };
}

/**
 * F4 / AC5 entrypoint. No query input — we read profile.md and infer 1-3
 * directions ourselves.
 *
 * Per AC5: when profile is missing OR has too few notes (< 3), do NOT crash;
 * return a structured `not_enough_profile` flag and an empty shortlist. The
 * threshold matches design.md §1.2 (笔记数 0-2: 不做 personalization).
 */
export async function cronFlow(opts: CronFlowOpts): Promise<CronFlowResult> {
  const root = getRepoRoot();
  const runId = opts.runId ?? getRunId();
  const outDir = opts.outDirOverride ?? (await runOutputDir(runId, root));
  const tracePath = join(outDir, 'trace.jsonl');
  const trace = new TraceBus(tracePath, 'master');

  const profilePath = opts.profilePath ?? join(root, 'output', 'profile.md');
  const profile = await readProfile(profilePath);

  await trace.emit('plan', 'phase_begin', { phase_name: 'cron_flow' });
  await trace.emit('plan', 'thought', {
    text: `profile_known=${profile.raw !== null}; read_n=${profile.readSlugs.length}; signal=${profile.hasSignal}`,
  });

  // AC5: empty/missing profile → graceful 报错
  if (!profile.raw || !profile.hasSignal) {
    const reason = !profile.raw
      ? 'profile.md 不存在'
      : `已读笔记不足 (${profile.readSlugs.length} < 3), 无法推断兴趣方向`;
    await trace.emit('plan', 'thought', { text: `cron_flow halting: ${reason}` });
    const shortlistPath = join(outDir, 'shortlist.json');
    const metaPath = join(outDir, 'meta.json');
    await fs.writeFile(
      shortlistPath,
      JSON.stringify({ run_id: runId, generated_at: new Date().toISOString(), shortlist: [] }, null, 2),
      'utf8',
    );
    await fs.writeFile(
      metaPath,
      JSON.stringify(
        {
          run_id: runId,
          flow: 'cron',
          aborted: true,
          abort_reason: reason,
          profile_used: profile.raw !== null,
          profile_read_n: profile.readSlugs.length,
        },
        null,
        2,
      ),
      'utf8',
    );
    await trace.emit('plan', 'phase_end', { phase_name: 'cron_flow', aborted: true });
    await trace.close();
    return {
      run_id: runId,
      out_dir: outDir,
      shortlist: [],
      directions: [],
      summary: '',
      trace_path: tracePath,
      shortlist_path: shortlistPath,
      meta_path: metaPath,
      not_enough_profile: { reason },
    };
  }

  // ── Infer interest directions from profile ──────────────────────────────
  const inference = await inferInterestForCron(opts.llm, profile.raw);
  await trace.emit('plan', 'tool_call', {
    tool: 'infer_interest',
    args: { profile_chars: profile.raw.length },
    result: inference,
  });

  if (inference.directions.length === 0) {
    const reason = 'LLM 未能从 profile 推断出有效检索方向';
    await trace.emit('plan', 'error', { text: reason });
    const shortlistPath = join(outDir, 'shortlist.json');
    const metaPath = join(outDir, 'meta.json');
    await fs.writeFile(
      shortlistPath,
      JSON.stringify({ run_id: runId, shortlist: [] }, null, 2),
      'utf8',
    );
    await fs.writeFile(
      metaPath,
      JSON.stringify(
        { run_id: runId, flow: 'cron', aborted: true, abort_reason: reason },
        null,
        2,
      ),
      'utf8',
    );
    await trace.close();
    return {
      run_id: runId,
      out_dir: outDir,
      shortlist: [],
      directions: [],
      summary: '',
      trace_path: tracePath,
      shortlist_path: shortlistPath,
      meta_path: metaPath,
      not_enough_profile: { reason },
    };
  }

  // ── Search across all directions, dedupe, drop already-read ─────────────
  const perTermMax = opts.perTermMax ?? 25;
  const concurrency = opts.concurrency ?? 8;
  const inferredInterest = inference.directions.map((d) => `${d.theme} (${d.term})`).join('; ');

  const seen = new Set<string>();
  const readSet = new Set(profile.readSlugs.map((s) => s.toLowerCase()));
  const candidates: Array<{ c: ArxivCandidate; matched_term: string; theme: string; evidence_slug: string }> = [];

  await Promise.all(
    inference.directions.map(async (dir) => {
      try {
        await trace.emit('search', 'tool_call', {
          tool: 'search_arxiv',
          args: { query: dir.term, max_n: perTermMax },
        });
        const cs = await searchArxiv(dir.term, perTermMax);
        await trace.emit('search', 'observation', { tool: 'search_arxiv', term: dir.term, n: cs.length });
        for (const c of cs) {
          const key = c.arxiv_id.toLowerCase();
          if (seen.has(key) || readSet.has(key)) continue;
          seen.add(key);
          candidates.push({ c, matched_term: dir.term, theme: dir.theme, evidence_slug: dir.evidence_slug });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await trace.emit('search', 'error', { term: dir.term, error: msg });
      }
    }),
  );

  if (candidates.length === 0) {
    await trace.emit('plan', 'thought', { text: 'no candidates after search' });
  }

  // ── Triage with cron-mode prompt (inferred interest, not query) ─────────
  const triaged = await triageBatch(candidates.map((x) => x.c), {
    llm: opts.llm,
    trace,
    inferredInterest,
    concurrency,
  });

  // ── Build shortlist with reasons that reference an evidence_slug ────────
  const shortlist: ShortlistEntry[] = triaged
    .filter((t) => t.verdict !== 'skip')
    .map((t, i) => {
      const meta = candidates[i]!;
      // AC5: 推荐理由必须引用具体笔记 slug
      const reasonWithSlug = meta.evidence_slug
        ? `[基于 [[${meta.evidence_slug}]]] ${t.reason}`
        : t.reason;
      return {
        arxiv_id: t.arxiv_id,
        title: t.title,
        authors: t.authors,
        year: t.year,
        verdict: t.verdict,
        reason: reasonWithSlug,
        summary: t.summary,
        matched_term: meta.matched_term,
      };
    })
    .sort((a, b) => {
      const rank = { recommend: 0, maybe: 1, skip: 2 } as const;
      const ra = rank[a.verdict];
      const rb = rank[b.verdict];
      if (ra !== rb) return ra - rb;
      return (b.year || 0) - (a.year || 0);
    });

  const shortlistPath = join(outDir, 'shortlist.json');
  await fs.writeFile(
    shortlistPath,
    JSON.stringify(
      {
        run_id: runId,
        flow: 'cron',
        generated_at: new Date().toISOString(),
        directions: inference.directions,
        summary: inference.summary,
        shortlist,
      },
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
        flow: 'cron',
        directions: inference.directions,
        candidate_total: triaged.length,
        recommend_total: triaged.filter((t) => t.verdict === 'recommend').length,
        shortlist_size: shortlist.length,
        profile_read_n: profile.readSlugs.length,
      },
      null,
      2,
    ),
    'utf8',
  );

  await trace.emit('plan', 'phase_end', {
    phase_name: 'cron_flow',
    shortlist_size: shortlist.length,
  });
  await trace.close();

  return {
    run_id: runId,
    out_dir: outDir,
    shortlist,
    directions: inference.directions,
    summary: inference.summary,
    trace_path: tracePath,
    shortlist_path: shortlistPath,
    meta_path: metaPath,
  };
}
