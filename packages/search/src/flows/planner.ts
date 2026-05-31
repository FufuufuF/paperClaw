import type { LLMClient } from '@paperclaw/core';

/**
 * Master-agent prompt utilities. Two LLM calls live here:
 *   1) `decomposeQuery` — turn the user's natural-language query into 1-N
 *      arxiv search terms.
 *   2) `decideReplan` — after the first round of triage, decide whether to
 *      add more search terms (replan) or stop.
 *
 * Both go through `response_format: json_object` so we don't fight the LLM
 * for syntactic correctness on every turn.
 */

export interface UsageStat {
  input: number;
  output: number;
}

export interface DecomposeResult {
  terms: string[];
  rationale: string;
  usage: UsageStat;
}

export interface ReplanResult {
  should_replan: boolean;
  new_terms: string[];
  reason: string;
  usage: UsageStat;
}

const DECOMPOSE_SYSTEM = `你是检索 agent 的规划器. 把用户的自然语言 query 拆解成 1-N 个 arXiv 检索词.

要求:
- 1-4 个检索词, 短而具体 (3-7 词的英文短语优先)
- 覆盖 query 的不同侧面, 避免互相高度重叠
- 不要加 boolean 操作符或 arXiv 字段限定 (会自动加)
- query 已经很具体时, 1 个检索词也行
- 返回严格 JSON: {"terms": ["...", ...], "rationale": "..."}`;

export async function decomposeQuery(
  llm: LLMClient,
  query: string,
  alreadyReadHint?: string,
): Promise<DecomposeResult> {
  const userMsg = alreadyReadHint
    ? `用户的 query: "${query}"\n\n用户已读过的方向 (避免重复推荐): ${alreadyReadHint}`
    : `用户的 query: "${query}"`;

  const res = await llm.chat({
    system: DECOMPOSE_SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
    responseFormat: 'json_object',
    temperature: 0.4,
    maxTokens: 300,
  });

  const parsed = safeJson(res.text ?? '');
  const terms = Array.isArray(parsed?.terms)
    ? parsed.terms.filter((t: unknown): t is string => typeof t === 'string').slice(0, 4)
    : [];
  if (terms.length === 0) {
    // Fallback: use the raw query as one term so the flow can still run.
    return { terms: [query], rationale: 'fallback: raw query', usage: res.usage };
  }
  return {
    terms,
    rationale: typeof parsed?.rationale === 'string' ? parsed.rationale : '',
    usage: res.usage,
  };
}

const REPLAN_SYSTEM = `你是检索 agent 的 replan 决策器. 看完第一轮 triage 结果, 决定是否需要补检索词.

判断:
- 已经有 ≥3 篇 verdict=recommend 且覆盖了 query 的主要侧面 → should_replan=false, new_terms=[]
- recommend 不足 / 召回明显跑题 / 漏掉关键侧面 → should_replan=true, 给 1-3 个新检索词
- 新检索词必须和已用过的 used_terms 不同
- 严禁同一查询循环 → 看 round, 已经到 round 2+ 时高度倾向停止

返回严格 JSON: {"should_replan": bool, "new_terms": ["..."], "reason": "30 字内"}`;

export async function decideReplan(
  llm: LLMClient,
  ctx: {
    query: string;
    round: number;
    usedTerms: string[];
    recommendCount: number;
    maybeCount: number;
    skipCount: number;
    sampleRecommendTitles: string[];
  },
): Promise<ReplanResult> {
  const userMsg = `query: "${ctx.query}"
round: ${ctx.round}
used_terms: ${JSON.stringify(ctx.usedTerms)}
本轮结果: recommend=${ctx.recommendCount}, maybe=${ctx.maybeCount}, skip=${ctx.skipCount}
recommend 中样本标题:
${ctx.sampleRecommendTitles.slice(0, 6).map((t, i) => `${i + 1}. ${t}`).join('\n') || '(none)'}`;

  const res = await llm.chat({
    system: REPLAN_SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
    responseFormat: 'json_object',
    temperature: 0.3,
    maxTokens: 250,
  });

  const parsed = safeJson(res.text ?? '');
  const should = parsed?.should_replan === true;
  const newTerms = Array.isArray(parsed?.new_terms)
    ? parsed.new_terms.filter((t: unknown): t is string => typeof t === 'string').slice(0, 3)
    : [];
  return {
    should_replan: should && newTerms.length > 0,
    new_terms: newTerms,
    reason: typeof parsed?.reason === 'string' ? parsed.reason : '',
    usage: res.usage,
  };
}

const CRON_INFER_SYSTEM = `你是定时推送 agent. 用户没有给 query, 你需要从 profile.md 推断他/她最近的研究兴趣, 决定该搜什么.

Profile 包含 "已读索引" / "用户兴趣推断" / "待补的基础论文" 等 section.

任务:
1. 推断 1-3 个明确的 research direction
2. 为每个方向提一个具体的 arXiv 检索词 (英文短语)
3. 在 reason 里**必须引用至少一个具体 [[slug]]** 作为依据 (AC5)

返回严格 JSON:
{
  "directions": [{"theme": "...", "term": "...", "evidence_slug": "react-agent"}],
  "summary": "一句话, 这次推送的整体定位"
}`;

export interface CronInference {
  directions: Array<{ theme: string; term: string; evidence_slug: string }>;
  summary: string;
  usage: UsageStat;
}

export async function inferInterestForCron(
  llm: LLMClient,
  profileMd: string,
): Promise<CronInference> {
  const res = await llm.chat({
    system: CRON_INFER_SYSTEM,
    messages: [{ role: 'user', content: `<profile.md>\n${profileMd}\n</profile.md>` }],
    responseFormat: 'json_object',
    temperature: 0.4,
    maxTokens: 600,
  });
  const parsed = safeJson(res.text ?? '');
  const dirsRaw = Array.isArray(parsed?.directions) ? parsed.directions : [];
  const directions = dirsRaw
    .map((d: Record<string, unknown>) => ({
      theme: typeof d?.theme === 'string' ? d.theme : '',
      term: typeof d?.term === 'string' ? d.term : '',
      evidence_slug: typeof d?.evidence_slug === 'string' ? d.evidence_slug : '',
    }))
    .filter((d: { term: string }) => d.term.length > 0)
    .slice(0, 3);
  return {
    directions,
    summary: typeof parsed?.summary === 'string' ? parsed.summary : '',
    usage: res.usage,
  };
}

function safeJson(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  try {
    const v = JSON.parse(cleaned);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
