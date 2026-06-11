import type { LLMClient, Tool, ToolContext, ToolResult } from '@paperclaw/core';
import { PaperKnowledgeStore } from './graph-store.js';
import type { PaperEvidencePointer, PaperStatus } from './types.js';

export interface PaperKnowledgeToolsOpts {
  llm?: LLMClient;
}

export function createPaperKnowledgeTools(opts: PaperKnowledgeToolsOpts = {}): Tool[] {
  return [
    kgGetNodeTool,
    kgRecentNodesTool,
    kgNeighborsTool,
    kgGetLinkTool,
    kgSearchNodesTool,
    kgSearchLinksTool,
    kgUpsertNodeTool,
    kgUpsertLinkTool,
    kgUpdateLinkTool,
    kgDeleteLinkTool,
    createConsolidatePaperTool(opts),
    createPreviewSectionRelationsTool(opts),
  ];
}

const kgGetNodeTool: Tool = {
  name: 'kg_get_node',
  description: 'Read one paper graph node by id. Returns metadata and note_path, never note content.',
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
  description: 'Read undirected one-hop paper graph neighbors. Results are limited and do not include note content.',
  readOnly: true,
  concurrencySafe: true,
  scopes: ['paper-read'],
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['id'],
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.neighbors({
      id: stringArg(args.id),
      limit: numberArg(args.limit),
    });
    return ok(result, `KG neighbors for ${result.node}: ${result.neighbors.length}`);
  },
};

const kgGetLinkTool: Tool = {
  name: 'kg_get_link',
  description: 'Read one paper graph relation with full reason and evidence pointers. Does not read note content.',
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
  description: 'Search paper graph nodes by id/title/summary/status/key_terms. Returns limited navigation metadata only.',
  readOnly: true,
  concurrencySafe: true,
  scopes: ['paper-read'],
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      status: { type: 'array', items: { type: 'string', enum: ['unread', 'reading', 'read', 'skipped'] } },
      keyTerms: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.searchNodes({
      query: optionalString(args.query),
      status: stringArray(args.status) as PaperStatus[] | undefined,
      keyTerms: stringArray(args.keyTerms),
      limit: numberArg(args.limit),
    });
    return ok(result, `KG node search returned ${result.results.length}/${result.total}`);
  },
};

const kgRecentNodesTool: Tool = {
  name: 'kg_recent_nodes',
  description: 'List recently updated paper graph nodes, usually filtered by status=read for recommendation seeding.',
  readOnly: true,
  concurrencySafe: true,
  scopes: ['paper-read'],
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'array', items: { type: 'string', enum: ['unread', 'reading', 'read', 'skipped'] } },
      keyTerms: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.recentNodes({
      status: stringArray(args.status) as PaperStatus[] | undefined,
      keyTerms: stringArray(args.keyTerms),
      limit: numberArg(args.limit),
    });
    return ok(result, `KG recent nodes returned ${result.results.length}/${result.total}`);
  },
};

const kgSearchLinksTool: Tool = {
  name: 'kg_search_links',
  description: 'Search paper graph relation edges by query, source/target, or shared key terms. Returns limited edge metadata and reasons.',
  readOnly: true,
  concurrencySafe: true,
  scopes: ['paper-read'],
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      source: { type: 'string' },
      target: { type: 'string' },
      keyTerms: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.searchLinks({
      query: optionalString(args.query),
      source: optionalString(args.source),
      target: optionalString(args.target),
      keyTerms: stringArray(args.keyTerms),
      limit: numberArg(args.limit),
    });
    return ok(result, `KG link search returned ${result.results.length}/${result.total}`);
  },
};

const kgUpsertNodeTool: Tool = {
  name: 'kg_upsert_node',
  description: 'Create or update a paper graph node. key_terms must come from the closed vocabulary and at most 5 are kept.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: kgWriteConfirmation('create or update a paper graph node'),
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      summary_short: { type: 'string' },
      note_path: { type: 'string' },
      arxiv_id: { type: 'string' },
      status: { type: 'string', enum: ['unread', 'reading', 'read', 'skipped'] },
      key_terms: { type: 'array', items: { type: 'string' }, maxItems: 5 },
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
      key_terms: stringArray(args.key_terms),
    });
    return ok(result, `KG node saved: ${result.node.id}`);
  },
};

const kgUpsertLinkTool: Tool = {
  name: 'kg_upsert_link',
  description: 'Create or update an undirected paper graph relation. Existing paper pairs are updated instead of duplicated.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: kgWriteConfirmation('create or update a paper graph relation'),
  parameters: {
    type: 'object',
    properties: linkInputProperties(),
    required: ['source', 'target', 'reason'],
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.upsertLink(linkInput(args));
    return ok(result, `KG link saved: ${result.link.id}`);
  },
};

const kgUpdateLinkTool: Tool = {
  name: 'kg_update_link',
  description: 'Update a paper graph relation reason, shared_terms, or evidence.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: kgWriteConfirmation('update a paper graph relation'),
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      reason: { type: 'string' },
      shared_terms: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      evidence: evidenceSchema(),
    },
    required: ['id'],
  },
  async execute(args, ctx) {
    const store = storeFromContext(ctx);
    const result = await store.updateLink({
      id: stringArg(args.id),
      reason: optionalString(args.reason),
      shared_terms: stringArray(args.shared_terms),
      evidence: evidenceArg(args.evidence),
    });
    return ok(result, `KG link updated: ${result.link.id}`);
  },
};

const kgDeleteLinkTool: Tool = {
  name: 'kg_delete_link',
  description: 'Delete a paper graph relation edge. This does not delete any note.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: kgWriteConfirmation('delete a paper graph relation'),
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

function createConsolidatePaperTool(opts: PaperKnowledgeToolsOpts): Tool {
  return {
    name: 'consolidate_paper',
    description: 'Summarize one paper note into the paper graph, assign closed-vocabulary key_terms, and auto-create up to 5 paper links.',
    readOnly: false,
    concurrencySafe: false,
    exclusive: true,
    scopes: ['paper-read'],
    confirmation: kgWriteConfirmation('consolidate a paper into the paper graph'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        note_path: { type: 'string' },
        arxiv_id: { type: 'string' },
      },
      required: ['id', 'note_path'],
    },
    async execute(args, ctx) {
      const store = storeFromContext(ctx);
      const result = await store.consolidatePaper({
        id: stringArg(args.id),
        title: optionalString(args.title),
        note_path: stringArg(args.note_path),
        arxiv_id: optionalString(args.arxiv_id),
        llm: opts.llm,
      });
      return ok(result, `Consolidated ${result.node.id}; links=${result.links.length}`);
    },
  };
}

function createPreviewSectionRelationsTool(opts: PaperKnowledgeToolsOpts): Tool {
  return {
    name: 'preview_section_relations',
    description: 'Read-only preview of related old papers for one guided-reading section using closed-vocabulary section key terms.',
    readOnly: true,
    concurrencySafe: true,
    scopes: ['paper-read'],
    parameters: {
      type: 'object',
      properties: {
        statePath: { type: 'string' },
        notePath: { type: 'string' },
        slug: { type: 'string' },
        sectionIndex: { type: 'integer', minimum: 1 },
        maxResults: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['sectionIndex'],
    },
    async execute(args, ctx) {
      const store = storeFromContext(ctx);
      const result = await store.previewSectionRelations({
        statePath: optionalString(args.statePath),
        notePath: optionalString(args.notePath),
        slug: optionalString(args.slug),
        sectionIndex: numberArg(args.sectionIndex) ?? 1,
        maxResults: numberArg(args.maxResults),
        llm: opts.llm,
      });
      return ok(result, `Previewed ${result.results.length} related papers for section ${result.section.index}`);
    },
  };
}

function storeFromContext(ctx?: ToolContext): PaperKnowledgeStore {
  if (!ctx) throw new Error('tool context is required');
  return new PaperKnowledgeStore({ outputDir: ctx.outputDir });
}

function linkInput(args: Record<string, unknown>) {
  return {
    id: optionalString(args.id),
    source: stringArg(args.source),
    target: stringArg(args.target),
    reason: stringArg(args.reason),
    shared_terms: stringArray(args.shared_terms),
    evidence: evidenceArg(args.evidence),
  };
}

function linkInputProperties() {
  return {
    id: { type: 'string' },
    source: { type: 'string' },
    target: { type: 'string' },
    reason: { type: 'string' },
    shared_terms: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    evidence: evidenceSchema(),
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

function evidenceArg(value: unknown): PaperEvidencePointer[] | undefined {
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
      '总结入库',
      '建关系',
      'commit',
      'delete',
      'save',
      'record',
      'update',
      'consolidate',
    ],
    guidance: 'Ask the user to explicitly confirm the paper graph write before calling this tool.',
  };
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
