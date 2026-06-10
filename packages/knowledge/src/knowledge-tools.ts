import type { LLMClient, Tool, ToolContext, ToolResult } from '@paperclaw/core';
import { KnowledgeGraphStore } from './graph-store.js';
import type {
  KnowledgeCreatedBy,
  KnowledgeEvidencePointer,
  KnowledgeLinkSuggestion,
  KnowledgeLinkType,
  KnowledgePaperStatus,
  KnowledgePaperVerdict,
  PendingLinkStatus,
} from './types.js';

export interface KnowledgeGraphToolsOpts {
  llm?: LLMClient;
}

export function createKnowledgeGraphTools(opts: KnowledgeGraphToolsOpts = {}): Tool[] {
  return [
    kgGetNodeTool,
    kgRecentNodesTool,
    kgNeighborsTool,
    kgGetLinkTool,
    kgSearchNodesTool,
    kgSearchLinksTool,
    createKgSuggestLinksTool(opts),
    kgListPendingLinksTool,
    kgUpsertNodeTool,
    kgUpsertLinkTool,
    kgUpdateLinkTool,
    kgDeleteLinkTool,
    kgCreatePendingLinkTool,
    kgCommitPendingLinkTool,
    kgRejectPendingLinkTool,
  ];
}

const kgGetNodeTool: Tool = {
  name: 'kg_get_node',
  description: 'Read one knowledge graph paper node by id. Returns only navigation metadata and note_path, never note content.',
  readOnly: true,
  concurrencySafe: true,
  scopes: ['paper-read'],
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const node = await store.getNode(stringArg(args.id));
    return ok({ node }, node ? `KG node ${node.id}` : `KG node not found: ${stringArg(args.id)}`);
  },
};

const kgNeighborsTool: Tool = {
  name: 'kg_neighbors',
  description: 'Read one-hop neighbors for a paper node with optional direction/type filters. Results are limited and do not include note content.',
  readOnly: true,
  concurrencySafe: true,
  scopes: ['paper-read'],
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      direction: { type: 'string', enum: ['in', 'out', 'both'] },
      types: { type: 'array', items: { type: 'string', enum: linkTypeValues() } },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['id'],
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.neighbors({
      id: stringArg(args.id),
      direction: enumArg(args.direction, ['in', 'out', 'both']),
      types: stringArray(args.types) as KnowledgeLinkType[] | undefined,
      limit: numberArg(args.limit),
    });
    return ok(result, `KG neighbors for ${result.node}: ${result.neighbors.length}`);
  },
};

const kgGetLinkTool: Tool = {
  name: 'kg_get_link',
  description: 'Read one knowledge graph relation edge with full reason and evidence pointers. Does not read note content.',
  readOnly: true,
  concurrencySafe: true,
  scopes: ['paper-read'],
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const link = await store.getLink(stringArg(args.id));
    return ok({ link }, link ? `KG link ${link.id}` : `KG link not found: ${stringArg(args.id)}`);
  },
};

const kgSearchNodesTool: Tool = {
  name: 'kg_search_nodes',
  description: 'Search knowledge graph paper nodes by id/title/summary/status/verdict. Returns limited navigation metadata only.',
  readOnly: true,
  concurrencySafe: true,
  scopes: ['paper-read'],
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      status: { type: 'array', items: { type: 'string', enum: ['unread', 'reading', 'read', 'skipped'] } },
      verdict: { type: 'array', items: { type: 'string', enum: ['adopt', 'maybe', 'skip', 'unknown'] } },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.searchNodes({
      query: optionalString(args.query),
      status: stringArray(args.status) as KnowledgePaperStatus[] | undefined,
      verdict: stringArray(args.verdict) as KnowledgePaperVerdict[] | undefined,
      limit: numberArg(args.limit),
    });
    return ok(result, `KG node search returned ${result.results.length}/${result.total}`);
  },
};

const kgRecentNodesTool: Tool = {
  name: 'kg_recent_nodes',
  description: 'List recently updated knowledge graph paper nodes, usually filtered by status=read for recommendation seeding.',
  readOnly: true,
  concurrencySafe: true,
  scopes: ['paper-read'],
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'array', items: { type: 'string', enum: ['unread', 'reading', 'read', 'skipped'] } },
      verdict: { type: 'array', items: { type: 'string', enum: ['adopt', 'maybe', 'skip', 'unknown'] } },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.recentNodes({
      status: stringArray(args.status) as KnowledgePaperStatus[] | undefined,
      verdict: stringArray(args.verdict) as KnowledgePaperVerdict[] | undefined,
      limit: numberArg(args.limit),
    });
    return ok(result, `KG recent nodes returned ${result.results.length}/${result.total}`);
  },
};

const kgSearchLinksTool: Tool = {
  name: 'kg_search_links',
  description: 'Search knowledge graph relation edges by query, type, source, or target. Returns limited edge metadata and reasons.',
  readOnly: true,
  concurrencySafe: true,
  scopes: ['paper-read'],
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      types: { type: 'array', items: { type: 'string', enum: linkTypeValues() } },
      source: { type: 'string' },
      target: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.searchLinks({
      query: optionalString(args.query),
      types: stringArray(args.types) as KnowledgeLinkType[] | undefined,
      source: optionalString(args.source),
      target: optionalString(args.target),
      limit: numberArg(args.limit),
    });
    return ok(result, `KG link search returned ${result.results.length}/${result.total}`);
  },
};

function createKgSuggestLinksTool(opts: KnowledgeGraphToolsOpts): Tool {
  return {
    name: 'kg_suggest_links',
    description: 'Suggest candidate paper-to-paper relations from the current section summary and the existing knowledge graph. Read-only: it never writes links.',
    readOnly: true,
    concurrencySafe: true,
    scopes: ['paper-read'],
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        section_title: { type: 'string' },
        section_summary: { type: 'string', maxLength: 8000 },
        query_hints: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        mode: { type: 'string', enum: ['cheap', 'rerank'] },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['source'],
    },
    async execute(args, ctx) {
      const store = storeFromContext(ctx);
      const input = {
        source: stringArg(args.source),
        section_title: optionalString(args.section_title),
        section_summary: optionalString(args.section_summary),
        query_hints: stringArray(args.query_hints),
        mode: enumArg(args.mode, ['cheap', 'rerank']),
        limit: numberArg(args.limit),
      };
      const result = await store.suggestLinks(input);
      if (input.mode === 'rerank' && opts.llm && result.suggestions.length > 1) {
        const reranked = await rerankSuggestions(opts.llm, {
          sectionTitle: input.section_title,
          sectionSummary: input.section_summary,
          queryHints: input.query_hints,
          suggestions: result.suggestions,
        });
        return ok({
          ...result,
          mode: 'rerank',
          suggestions: reranked,
          rerank: { used: true, model: opts.llm.id },
        }, `KG reranked ${reranked.length} relation candidates for ${result.source}`);
      }
      return ok({
        ...result,
        rerank: input.mode === 'rerank' ? { used: false, reason: opts.llm ? 'not enough candidates' : 'llm unavailable' } : undefined,
      }, `KG suggested ${result.suggestions.length} relation candidates for ${result.source}`);
    },
  };
}

const kgListPendingLinksTool: Tool = {
  name: 'kg_list_pending_links',
  description: 'List pending knowledge graph relation candidates awaiting user review. Read-only and limited.',
  readOnly: true,
  concurrencySafe: true,
  scopes: ['paper-read'],
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'array', items: { type: 'string', enum: ['pending_user_review', 'committed', 'rejected'] } },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.listPendingLinks({
      status: stringArray(args.status) as PendingLinkStatus[] | undefined,
      limit: numberArg(args.limit),
    });
    return ok(result, `KG pending links: ${result.pending_links.length}/${result.total}`);
  },
};

const kgUpsertNodeTool: Tool = {
  name: 'kg_upsert_node',
  description: 'Create or update a knowledge graph paper node. Use only for explicit knowledge-base updates or fixed reader integration points.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: kgWriteConfirmation('create or update a knowledge graph node'),
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      summary_short: { type: 'string' },
      note_path: { type: 'string' },
      arxiv_id: { type: 'string' },
      status: { type: 'string', enum: ['unread', 'reading', 'read', 'skipped'] },
      verdict: { type: 'string', enum: ['adopt', 'maybe', 'skip', 'unknown'] },
    },
    required: ['id'],
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.upsertNode({
      id: stringArg(args.id),
      title: optionalString(args.title),
      summary_short: optionalString(args.summary_short),
      note_path: optionalString(args.note_path),
      arxiv_id: optionalString(args.arxiv_id),
      status: enumArg(args.status, ['unread', 'reading', 'read', 'skipped']),
      verdict: enumArg(args.verdict, ['adopt', 'maybe', 'skip', 'unknown']),
    });
    return ok(result, `KG node saved: ${result.node.id}`);
  },
};

const kgUpsertLinkTool: Tool = {
  name: 'kg_upsert_link',
  description: 'Create or update a formal knowledge graph relation edge. Use only after explicit user intent or confirmed pending relation.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: kgWriteConfirmation('create or update a formal knowledge graph relation'),
  parameters: {
    type: 'object',
    properties: linkInputProperties(),
    required: ['source', 'target', 'type', 'reason_short'],
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.upsertLink(linkInput(args));
    return ok(result, `KG link saved: ${result.link.id}`);
  },
};

const kgUpdateLinkTool: Tool = {
  name: 'kg_update_link',
  description: 'Update a formal knowledge graph relation edge. Use only when the user asks to correct or refine a relation.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: kgWriteConfirmation('update a knowledge graph relation'),
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      type: { type: 'string', enum: linkTypeValues() },
      directional: { type: 'boolean' },
      reason_short: { type: 'string' },
      reason: { type: 'string' },
      evidence: evidenceSchema(),
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['id'],
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.updateLink({
      id: stringArg(args.id),
      type: enumArg(args.type, linkTypeValues()) as KnowledgeLinkType | undefined,
      directional: typeof args.directional === 'boolean' ? args.directional : undefined,
      reason_short: optionalString(args.reason_short),
      reason: optionalString(args.reason),
      evidence: evidenceArg(args.evidence),
      confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
    });
    return ok(result, `KG link updated: ${result.link.id}`);
  },
};

const kgDeleteLinkTool: Tool = {
  name: 'kg_delete_link',
  description: 'Delete a formal knowledge graph relation edge. This does not delete any note.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: kgWriteConfirmation('delete a knowledge graph relation'),
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.deleteLink(stringArg(args.id));
    return ok(result, result.deleted ? `KG link deleted: ${result.deleted.id}` : `KG link not found: ${stringArg(args.id)}`);
  },
};

const kgCreatePendingLinkTool: Tool = {
  name: 'kg_create_pending_link',
  description: 'Create a pending knowledge graph relation candidate for later user review. Use for agent-suggested relations before formal write.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: kgWriteConfirmation('create a pending knowledge graph relation'),
  parameters: {
    type: 'object',
    properties: {
      ...linkInputProperties(),
      status: { type: 'string', enum: ['pending_user_review', 'committed', 'rejected'] },
    },
    required: ['source', 'target', 'type', 'reason_short'],
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.createPendingLink({
      ...linkInput(args),
      status: enumArg(args.status, ['pending_user_review', 'committed', 'rejected']),
    });
    return ok(result, `KG pending link saved: ${result.pending.id}`);
  },
};

const kgCommitPendingLinkTool: Tool = {
  name: 'kg_commit_pending_link',
  description: 'Commit a pending relation candidate into formal knowledge graph links after user approval.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: kgWriteConfirmation('commit a pending knowledge graph relation'),
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.commitPendingLink(stringArg(args.id));
    return ok(result, `KG pending link committed: ${result.pending.id} -> ${result.link.id}`);
  },
};

const kgRejectPendingLinkTool: Tool = {
  name: 'kg_reject_pending_link',
  description: 'Reject a pending knowledge graph relation candidate. Keeps the pending item marked rejected for audit.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: kgWriteConfirmation('reject a pending knowledge graph relation'),
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.rejectPendingLink(stringArg(args.id));
    return ok(result, `KG pending link rejected: ${result.pending.id}`);
  },
};

function storeFromContext(ctx?: ToolContext): KnowledgeGraphStore {
  if (!ctx) throw new Error('tool context is required');
  return new KnowledgeGraphStore({ outputDir: ctx.outputDir });
}

async function rerankSuggestions(
  llm: LLMClient,
  input: {
    sectionTitle?: string;
    sectionSummary?: string;
    queryHints?: string[];
    suggestions: KnowledgeLinkSuggestion[];
  },
): Promise<KnowledgeLinkSuggestion[]> {
  const response = await llm.chat({
    responseFormat: 'json_object',
    temperature: 0,
    maxTokens: 1200,
    messages: [
      {
        role: 'system',
        content: [
          'You rerank paper relation candidates for a knowledge graph.',
          'Return a compact JSON object: {"suggestions":[...]}',
          'Each suggestion must keep the original target and target_title, and may adjust type, reason_short, confidence, recommended_action.',
          'Do not invent new targets. Do not include note content.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          section_title: input.sectionTitle,
          section_summary: input.sectionSummary,
          query_hints: input.queryHints,
          candidates: input.suggestions.map((item) => ({
            target: item.target,
            target_title: item.target_title,
            type: item.type,
            reason_short: item.reason_short,
            confidence: item.confidence,
            recommended_action: item.recommended_action,
          })),
        }),
      },
    ],
  });
  const parsed = parseRerankJson(response.text ?? '');
  if (!parsed) return input.suggestions;
  const byTarget = new Map(input.suggestions.map((item) => [item.target, item]));
  const out: KnowledgeLinkSuggestion[] = [];
  for (const item of parsed) {
    const target = optionalString(item.target);
    const original = target ? byTarget.get(target) : undefined;
    if (!original) continue;
    out.push({
      ...original,
      type: enumArg(item.type, linkTypeValues()) ?? original.type,
      reason_short: optionalString(item.reason_short) ?? original.reason_short,
      confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : original.confidence,
      recommended_action: enumArg(item.recommended_action, ['mention_only', 'create_pending', 'skip']) ?? original.recommended_action,
    });
  }
  return out.length > 0 ? out : input.suggestions;
}

function parseRerankJson(text: string): Array<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const suggestions = (parsed as { suggestions?: unknown }).suggestions;
    return Array.isArray(suggestions)
      ? suggestions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : null;
  } catch {
    return null;
  }
}

function linkInput(args: Record<string, unknown>) {
  return {
    id: optionalString(args.id),
    source: stringArg(args.source),
    target: stringArg(args.target),
    type: enumArg(args.type, linkTypeValues()) as KnowledgeLinkType,
    directional: typeof args.directional === 'boolean' ? args.directional : undefined,
    reason_short: stringArg(args.reason_short),
    reason: optionalString(args.reason),
    evidence: evidenceArg(args.evidence),
    confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
    created_by: enumArg(args.created_by, ['agent', 'user', 'import', 'system']) as KnowledgeCreatedBy | undefined,
  };
}

function linkInputProperties() {
  return {
    id: { type: 'string' },
    source: { type: 'string' },
    target: { type: 'string' },
    type: { type: 'string', enum: linkTypeValues() },
    directional: { type: 'boolean' },
    reason_short: { type: 'string' },
    reason: { type: 'string' },
    evidence: evidenceSchema(),
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    created_by: { type: 'string', enum: ['agent', 'user', 'import', 'system'] },
  };
}

function evidenceSchema() {
  return {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        paper_id: { type: 'string' },
        note_path: { type: 'string' },
        section: { type: 'string' },
      },
      required: ['paper_id'],
    },
  };
}

function evidenceArg(value: unknown): KnowledgeEvidencePointer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const paperId = optionalString(record.paper_id);
    if (!paperId) return [];
    return [{
      paper_id: paperId,
      note_path: optionalString(record.note_path),
      section: optionalString(record.section),
    }];
  });
}

function kgWriteConfirmation(action: string): Tool['confirmation'] {
  return {
    required: true,
    action,
    patterns: [
      '确认',
      '写入',
      '记录',
      '保存',
      '更新',
      '删除',
      '加入',
      '提交',
      '拒绝',
      'commit',
      'reject',
      'delete',
      'save',
      'record',
      'update',
    ],
    guidance: 'Ask the user to explicitly confirm the knowledge graph write before calling this tool.',
  };
}

function linkTypeValues(): KnowledgeLinkType[] {
  return ['extends', 'contrasts', 'supports', 'challenges', 'complements', 'uses_same', 'applies_to', 'precedes', 'replaces'];
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(value: unknown): string | undefined {
  const text = stringArg(value);
  return text || undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map(stringArg).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function numberArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function enumArg<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : undefined;
}

function ok(data: unknown, summary: string): ToolResult {
  return { success: true, data, summary };
}
