import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type {
  KnowledgeCreatedBy,
  KnowledgeEvidencePointer,
  KnowledgeIndex,
  KnowledgeLink,
  KnowledgeLinkSuggestion,
  KnowledgeLinkType,
  KnowledgeNeighbor,
  KnowledgeOpenQuestion,
  KnowledgePaperNode,
  KnowledgePaperStatus,
  KnowledgePaperVerdict,
  KnowledgePendingLink,
  KnowledgeStoreWriteResult,
  PendingLinkStatus,
} from './types.js';

const VALID_STATUSES = new Set<KnowledgePaperStatus>(['unread', 'reading', 'read', 'skipped']);
const VALID_VERDICTS = new Set<KnowledgePaperVerdict>(['adopt', 'maybe', 'skip', 'unknown']);
const VALID_LINK_TYPES = new Set<KnowledgeLinkType>([
  'extends',
  'contrasts',
  'supports',
  'challenges',
  'complements',
  'uses_same',
  'applies_to',
  'precedes',
  'replaces',
]);
const VALID_CREATED_BY = new Set<KnowledgeCreatedBy>(['agent', 'user', 'import', 'system']);
const VALID_PENDING_STATUS = new Set<PendingLinkStatus>(['pending_user_review', 'committed', 'rejected']);
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const NOTE_SNIPPET_CHARS = 3000;

export interface KnowledgeGraphStoreOpts {
  outputDir: string;
  indexPath?: string;
  now?: () => Date;
}

export interface SearchNodesInput {
  query?: string;
  status?: KnowledgePaperStatus[];
  verdict?: KnowledgePaperVerdict[];
  limit?: number;
}

export interface SearchNodeResult {
  id: string;
  title: string;
  summary_short?: string;
  note_path: string;
  arxiv_id?: string;
  status: KnowledgePaperStatus;
  verdict: KnowledgePaperVerdict;
  matched: string[];
}

export interface RecentNodesInput {
  status?: KnowledgePaperStatus[];
  verdict?: KnowledgePaperVerdict[];
  limit?: number;
}

export interface SearchLinksInput {
  query?: string;
  types?: KnowledgeLinkType[];
  source?: string;
  target?: string;
  limit?: number;
}

export interface NeighborInput {
  id: string;
  direction?: 'in' | 'out' | 'both';
  types?: KnowledgeLinkType[];
  limit?: number;
}

export interface UpsertNodeInput {
  id: string;
  title?: string;
  summary_short?: string;
  note_path?: string;
  arxiv_id?: string;
  status?: KnowledgePaperStatus;
  verdict?: KnowledgePaperVerdict;
}

export interface UpsertLinkInput {
  id?: string;
  source: string;
  target: string;
  type: KnowledgeLinkType;
  directional?: boolean;
  reason_short: string;
  reason?: string;
  evidence?: KnowledgeEvidencePointer[];
  confidence?: number;
  created_by?: KnowledgeCreatedBy;
}

export interface UpdateLinkInput {
  id: string;
  type?: KnowledgeLinkType;
  directional?: boolean;
  reason_short?: string;
  reason?: string;
  evidence?: KnowledgeEvidencePointer[];
  confidence?: number;
}

export interface PendingLinkInput extends UpsertLinkInput {
  status?: PendingLinkStatus;
}

export interface SuggestLinksInput {
  source: string;
  section_title?: string;
  section_summary?: string;
  query_hints?: string[];
  mode?: 'cheap' | 'rerank';
  limit?: number;
}

export interface RenameNodeInput {
  oldId: string;
  newId: string;
  note_path?: string;
}

export class KnowledgeGraphStore {
  readonly outputDir: string;
  readonly indexPath: string;
  private readonly now: () => Date;

  constructor(opts: KnowledgeGraphStoreOpts) {
    this.outputDir = resolve(opts.outputDir);
    this.indexPath = resolve(opts.indexPath ?? resolve(this.outputDir, 'knowledge-index.json'));
    this.now = opts.now ?? (() => new Date());
    assertInsideRoot(this.indexPath, this.outputDir, 'knowledge index path escapes outputDir');
  }

  async load(): Promise<KnowledgeIndex> {
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      return normalizeIndex(JSON.parse(raw), this.isoNow());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultIndex(this.isoNow());
      throw err;
    }
  }

  async save(index: KnowledgeIndex, opts: { backup?: boolean } = {}): Promise<KnowledgeStoreWriteResult> {
    index.updated_at = this.isoNow();
    await fs.mkdir(dirname(this.indexPath), { recursive: true });
    let backupPath: string | undefined;
    if (opts.backup !== false) {
      backupPath = await backupIfExists(this.indexPath);
    }
    const content = `${JSON.stringify(normalizeIndex(index, index.updated_at), null, 2)}\n`;
    const tmp = `${this.indexPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, this.indexPath);
    return { path: this.indexPath, backupPath, bytes: Buffer.byteLength(content, 'utf8') };
  }

  async getNode(id: string): Promise<KnowledgePaperNode | null> {
    const index = await this.load();
    return index.papers[cleanId(id)] ?? null;
  }

  async searchNodes(input: SearchNodesInput): Promise<{ results: SearchNodeResult[]; truncated: boolean; total: number }> {
    const index = await this.load();
    const limit = clampLimit(input.limit);
    const queryTokens = tokenize(input.query ?? '');
    const statuses = new Set(input.status ?? []);
    const verdicts = new Set(input.verdict ?? []);
    const rows = Object.values(index.papers)
      .map((node) => ({ node, matched: matchedNodeFields(node, queryTokens) }))
      .filter(({ node, matched }) => {
        if (statuses.size > 0 && !statuses.has(node.status)) return false;
        if (verdicts.size > 0 && !verdicts.has(node.verdict)) return false;
        return queryTokens.length === 0 || matched.length > 0;
      })
      .sort((a, b) => b.node.updated_at.localeCompare(a.node.updated_at) || a.node.id.localeCompare(b.node.id));
    return {
      results: rows.slice(0, limit).map(({ node, matched }) => ({
        id: node.id,
        title: node.title,
        summary_short: node.summary_short,
        note_path: node.note_path,
        arxiv_id: node.arxiv_id,
        status: node.status,
        verdict: node.verdict,
        matched,
      })),
      truncated: rows.length > limit,
      total: rows.length,
    };
  }

  async recentNodes(input: RecentNodesInput = {}): Promise<{ results: SearchNodeResult[]; truncated: boolean; total: number }> {
    const index = await this.load();
    const limit = clampLimit(input.limit);
    const statuses = new Set(input.status ?? []);
    const verdicts = new Set(input.verdict ?? []);
    const rows = Object.values(index.papers)
      .filter((node) => {
        if (statuses.size > 0 && !statuses.has(node.status)) return false;
        if (verdicts.size > 0 && !verdicts.has(node.verdict)) return false;
        return true;
      })
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
    return {
      results: rows.slice(0, limit).map((node) => ({
        id: node.id,
        title: node.title,
        summary_short: node.summary_short,
        note_path: node.note_path,
        arxiv_id: node.arxiv_id,
        status: node.status,
        verdict: node.verdict,
        matched: [],
      })),
      truncated: rows.length > limit,
      total: rows.length,
    };
  }

  async neighbors(input: NeighborInput): Promise<{ node: string; neighbors: KnowledgeNeighbor[]; truncated: boolean }> {
    const index = await this.load();
    const id = cleanId(input.id);
    const direction = input.direction ?? 'both';
    const typeSet = new Set(input.types ?? []);
    const limit = clampLimit(input.limit);
    const rows: KnowledgeNeighbor[] = [];
    for (const link of index.links) {
      if (typeSet.size > 0 && !typeSet.has(link.type)) continue;
      const outbound = link.source === id;
      const inbound = link.target === id;
      if (direction === 'out' && !outbound) continue;
      if (direction === 'in' && !inbound) continue;
      if (direction === 'both' && !outbound && !inbound) continue;
      const neighborId = outbound ? link.target : link.source;
      const neighbor = index.papers[neighborId];
      rows.push({
        paper_id: neighborId,
        title: neighbor?.title ?? neighborId,
        arxiv_id: neighbor?.arxiv_id,
        summary_short: neighbor?.summary_short,
        direction: outbound && inbound ? 'both' : outbound ? 'out' : 'in',
        link_id: link.id,
        link_type: link.type,
        reason_short: link.reason_short,
        confidence: link.confidence,
      });
    }
    rows.sort((a, b) => b.confidence - a.confidence || a.paper_id.localeCompare(b.paper_id));
    return { node: id, neighbors: rows.slice(0, limit), truncated: rows.length > limit };
  }

  async getLink(id: string): Promise<KnowledgeLink | null> {
    const index = await this.load();
    return index.links.find((link) => link.id === cleanId(id)) ?? null;
  }

  async searchLinks(input: SearchLinksInput): Promise<{ results: KnowledgeLink[]; truncated: boolean; total: number }> {
    const index = await this.load();
    const limit = clampLimit(input.limit);
    const queryTokens = tokenize(input.query ?? '');
    const typeSet = new Set(input.types ?? []);
    const source = input.source ? cleanId(input.source) : undefined;
    const target = input.target ? cleanId(input.target) : undefined;
    const rows = index.links.filter((link) => {
      if (typeSet.size > 0 && !typeSet.has(link.type)) return false;
      if (source && link.source !== source) return false;
      if (target && link.target !== target) return false;
      if (queryTokens.length === 0) return true;
      const text = [link.id, link.source, link.target, link.type, link.reason_short, link.reason].join(' ');
      return queryTokens.some((token) => text.toLowerCase().includes(token));
    });
    rows.sort((a, b) => b.confidence - a.confidence || b.updated_at.localeCompare(a.updated_at));
    return { results: rows.slice(0, limit), truncated: rows.length > limit, total: rows.length };
  }

  async upsertNode(input: UpsertNodeInput): Promise<{ node: KnowledgePaperNode; write: KnowledgeStoreWriteResult }> {
    const id = cleanId(input.id);
    if (!id) throw new Error('node id is required');
    const index = await this.load();
    const previous = index.papers[id];
    const now = this.isoNow();
    const node: KnowledgePaperNode = {
      id,
      title: input.title?.trim() || previous?.title || id,
      summary_short: cleanOptional(input.summary_short) ?? previous?.summary_short,
      note_path: input.note_path?.trim() || previous?.note_path || '',
      arxiv_id: input.arxiv_id?.trim() || previous?.arxiv_id,
      status: input.status ?? previous?.status ?? 'unread',
      verdict: input.verdict ?? previous?.verdict ?? 'unknown',
      updated_at: now,
    };
    validateNode(node);
    index.papers[id] = node;
    const write = await this.save(index);
    return { node, write };
  }

  async upsertLink(input: UpsertLinkInput): Promise<{ link: KnowledgeLink; write: KnowledgeStoreWriteResult }> {
    const index = await this.load();
    const now = this.isoNow();
    const id = cleanId(input.id ?? findExistingLinkId(index, input) ?? makeId('link', now, index.links.length + 1));
    const existing = index.links.find((link) => link.id === id);
    const link: KnowledgeLink = {
      id,
      source: cleanId(input.source),
      target: cleanId(input.target),
      type: input.type,
      directional: input.directional ?? defaultDirectional(input.type),
      reason_short: input.reason_short.trim(),
      reason: input.reason?.trim() || existing?.reason,
      evidence: normalizeEvidence(input.evidence ?? existing?.evidence ?? []),
      confidence: clampConfidence(input.confidence ?? existing?.confidence ?? 0.5),
      created_by: input.created_by ?? existing?.created_by ?? 'agent',
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    validateLink(link);
    if (existing) Object.assign(existing, link);
    else index.links.push(link);
    const write = await this.save(index);
    return { link, write };
  }

  async updateLink(input: UpdateLinkInput): Promise<{ link: KnowledgeLink; write: KnowledgeStoreWriteResult }> {
    const index = await this.load();
    const link = index.links.find((item) => item.id === cleanId(input.id));
    if (!link) throw new Error(`link not found: ${input.id}`);
    if (input.type) link.type = input.type;
    if (typeof input.directional === 'boolean') link.directional = input.directional;
    if (typeof input.reason_short === 'string') link.reason_short = input.reason_short.trim();
    if (typeof input.reason === 'string') link.reason = input.reason.trim();
    if (input.evidence) link.evidence = normalizeEvidence(input.evidence);
    if (typeof input.confidence === 'number') link.confidence = clampConfidence(input.confidence);
    link.updated_at = this.isoNow();
    validateLink(link);
    const write = await this.save(index);
    return { link, write };
  }

  async deleteLink(id: string): Promise<{ deleted: KnowledgeLink | null; write: KnowledgeStoreWriteResult }> {
    const index = await this.load();
    const clean = cleanId(id);
    const idx = index.links.findIndex((link) => link.id === clean);
    const deleted = idx >= 0 ? index.links.splice(idx, 1)[0] ?? null : null;
    const write = await this.save(index);
    return { deleted, write };
  }

  async renameNode(input: RenameNodeInput): Promise<{ renamed: boolean; node: KnowledgePaperNode | null; write?: KnowledgeStoreWriteResult }> {
    const index = await this.load();
    const oldId = cleanId(input.oldId);
    const newId = cleanId(input.newId);
    if (!oldId || !newId) throw new Error('oldId and newId are required');
    const existing = index.papers[oldId];
    if (!existing) return { renamed: false, node: null };
    if (oldId !== newId && index.papers[newId]) {
      throw new Error(`target node already exists: ${newId}`);
    }
    const now = this.isoNow();
    const node: KnowledgePaperNode = {
      ...existing,
      id: newId,
      note_path: input.note_path?.trim() || existing.note_path,
      updated_at: now,
    };
    delete index.papers[oldId];
    index.papers[newId] = node;
    for (const link of index.links) {
      if (link.source === oldId) link.source = newId;
      if (link.target === oldId) link.target = newId;
      for (const evidence of link.evidence) {
        if (evidence.paper_id === oldId) {
          evidence.paper_id = newId;
          if (input.note_path) evidence.note_path = input.note_path;
        }
      }
      link.updated_at = now;
    }
    for (const pending of index.pending_links) {
      if (pending.source === oldId) pending.source = newId;
      if (pending.target === oldId) pending.target = newId;
      for (const evidence of pending.evidence) {
        if (evidence.paper_id === oldId) {
          evidence.paper_id = newId;
          if (input.note_path) evidence.note_path = input.note_path;
        }
      }
      pending.updated_at = now;
    }
    const write = await this.save(index);
    return { renamed: true, node, write };
  }

  async createPendingLink(input: PendingLinkInput): Promise<{ pending: KnowledgePendingLink; write: KnowledgeStoreWriteResult }> {
    const index = await this.load();
    const now = this.isoNow();
    const id = cleanId(input.id ?? makeId('pending', now, index.pending_links.length + 1));
    const pending: KnowledgePendingLink = {
      id,
      source: cleanId(input.source),
      target: cleanId(input.target),
      type: input.type,
      directional: input.directional ?? defaultDirectional(input.type),
      reason_short: input.reason_short.trim(),
      reason: input.reason?.trim(),
      evidence: normalizeEvidence(input.evidence ?? []),
      confidence: clampConfidence(input.confidence ?? 0.5),
      created_by: input.created_by ?? 'agent',
      created_at: now,
      updated_at: now,
      status: input.status ?? 'pending_user_review',
    };
    validatePendingLink(pending);
    const existing = index.pending_links.find((item) => item.id === id);
    if (existing) Object.assign(existing, pending);
    else index.pending_links.push(pending);
    const write = await this.save(index);
    return { pending, write };
  }

  async listPendingLinks(input: { status?: PendingLinkStatus[]; limit?: number } = {}): Promise<{ pending_links: KnowledgePendingLink[]; truncated: boolean; total: number }> {
    const index = await this.load();
    const limit = clampLimit(input.limit);
    const statuses = new Set(input.status ?? ['pending_user_review']);
    const rows = index.pending_links
      .filter((item) => statuses.size === 0 || statuses.has(item.status))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { pending_links: rows.slice(0, limit), truncated: rows.length > limit, total: rows.length };
  }

  async commitPendingLink(id: string): Promise<{ pending: KnowledgePendingLink; link: KnowledgeLink; write: KnowledgeStoreWriteResult }> {
    const index = await this.load();
    const pending = index.pending_links.find((item) => item.id === cleanId(id));
    if (!pending) throw new Error(`pending link not found: ${id}`);
    if (pending.status !== 'pending_user_review') throw new Error(`pending link is not pending: ${id}`);
    const now = this.isoNow();
    pending.status = 'committed';
    pending.updated_at = now;
    const link: KnowledgeLink = {
      id: makeId('link', now, index.links.length + 1),
      source: pending.source,
      target: pending.target,
      type: pending.type,
      directional: pending.directional,
      reason_short: pending.reason_short,
      reason: pending.reason,
      evidence: pending.evidence,
      confidence: pending.confidence,
      created_by: pending.created_by,
      created_at: now,
      updated_at: now,
    };
    validateLink(link);
    index.links.push(link);
    const write = await this.save(index);
    return { pending, link, write };
  }

  async rejectPendingLink(id: string): Promise<{ pending: KnowledgePendingLink; write: KnowledgeStoreWriteResult }> {
    const index = await this.load();
    const pending = index.pending_links.find((item) => item.id === cleanId(id));
    if (!pending) throw new Error(`pending link not found: ${id}`);
    if (pending.status !== 'pending_user_review') throw new Error(`pending link is not pending: ${id}`);
    pending.status = 'rejected';
    pending.updated_at = this.isoNow();
    const write = await this.save(index);
    return { pending, write };
  }

  async suggestLinks(input: SuggestLinksInput): Promise<{ source: string; mode: 'cheap' | 'rerank'; suggestions: KnowledgeLinkSuggestion[]; truncated: boolean }> {
    const index = await this.load();
    const source = cleanId(input.source);
    const sourceNode = index.papers[source];
    if (!sourceNode) throw new Error(`source node not found: ${source}`);
    const limit = clampLimit(input.limit, 5);
    const mode = input.mode ?? 'cheap';
    const hints = [
      input.section_title ?? '',
      input.section_summary ?? '',
      ...(input.query_hints ?? []),
    ].join(' ');
    const queryTokens = tokenize(hints);
    const existingPairs = new Set(index.links.map((link) => pairKey(link.source, link.target)));
    const candidates: Array<KnowledgeLinkSuggestion & { score: number }> = [];
    for (const node of Object.values(index.papers)) {
      if (node.id === source || node.status === 'skipped') continue;
      const pair = pairKey(source, node.id);
      if (existingPairs.has(pair)) continue;
      const localText = [
        node.id,
        node.title,
        ...index.links
          .filter((link) => link.source === node.id || link.target === node.id)
          .map((link) => link.reason_short),
      ].join(' ');
      const snippet = await this.readNoteSnippet(node.note_path);
      const score = scoreCandidate(queryTokens, `${localText}\n${snippet}`);
      if (score <= 0) continue;
      const confidence = Math.min(0.95, Math.max(0.1, score));
      const type = inferLinkType(hints, localText);
      candidates.push({
        target: node.id,
        target_title: node.title,
        type,
        reason_short: buildReasonShort(input.section_title, node.title, type),
        evidence: [
          { paper_id: source, note_path: sourceNode.note_path, section: input.section_title },
          { paper_id: node.id, note_path: node.note_path },
        ].filter((item) => item.section !== undefined || item.note_path !== undefined),
        confidence,
        recommended_action: confidence >= 0.8 ? 'create_pending' : confidence >= 0.45 ? 'mention_only' : 'skip',
        score,
      });
    }
    candidates.sort((a, b) => b.score - a.score || a.target.localeCompare(b.target));
    return {
      source,
      mode,
      suggestions: candidates.slice(0, limit).map(({ score: _score, ...item }) => item),
      truncated: candidates.length > limit,
    };
  }

  private async readNoteSnippet(notePath: string): Promise<string> {
    if (!notePath) return '';
    try {
      const path = resolveNotePath(notePath, this.outputDir);
      const text = await fs.readFile(path, 'utf8');
      return text.slice(0, NOTE_SNIPPET_CHARS);
    } catch {
      return '';
    }
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

function defaultIndex(now: string): KnowledgeIndex {
  return {
    version: 1,
    updated_at: now,
    papers: {},
    links: [],
    open_questions: [],
    pending_links: [],
  };
}

function normalizeIndex(value: unknown, now: string): KnowledgeIndex {
  const raw = isRecord(value) ? value : {};
  const papers: Record<string, KnowledgePaperNode> = {};
  const rawPapers = isRecord(raw.papers) ? raw.papers : {};
  for (const [key, item] of Object.entries(rawPapers)) {
    if (!isRecord(item)) continue;
    const id = cleanId(asString(item.id) || key);
    if (!id) continue;
    const node: KnowledgePaperNode = {
      id,
      title: asString(item.title) || id,
      summary_short: optionalString(item.summary_short),
      note_path: asString(item.note_path),
      arxiv_id: optionalString(item.arxiv_id),
      status: parseStatus(item.status),
      verdict: parseVerdict(item.verdict),
      updated_at: asString(item.updated_at) || now,
    };
    papers[id] = node;
  }
  return {
    version: 1,
    updated_at: asString(raw.updated_at) || now,
    papers,
    links: Array.isArray(raw.links) ? raw.links.map((item) => parseLink(item, now)).filter(Boolean) as KnowledgeLink[] : [],
    open_questions: Array.isArray(raw.open_questions)
      ? raw.open_questions.map((item) => parseOpenQuestion(item, now)).filter(Boolean) as KnowledgeOpenQuestion[]
      : [],
    pending_links: Array.isArray(raw.pending_links)
      ? raw.pending_links.map((item) => parsePendingLink(item, now)).filter(Boolean) as KnowledgePendingLink[]
      : [],
  };
}

function parseLink(value: unknown, now: string): KnowledgeLink | null {
  if (!isRecord(value)) return null;
  const type = parseLinkType(value.type);
  const link: KnowledgeLink = {
    id: cleanId(asString(value.id)),
    source: cleanId(asString(value.source)),
    target: cleanId(asString(value.target)),
    type,
    directional: typeof value.directional === 'boolean' ? value.directional : defaultDirectional(type),
    reason_short: asString(value.reason_short),
    reason: optionalString(value.reason),
    evidence: normalizeEvidence(Array.isArray(value.evidence) ? value.evidence : []),
    confidence: clampConfidence(typeof value.confidence === 'number' ? value.confidence : 0.5),
    created_by: parseCreatedBy(value.created_by),
    created_at: asString(value.created_at) || now,
    updated_at: asString(value.updated_at) || now,
  };
  try {
    validateLink(link);
    return link;
  } catch {
    return null;
  }
}

function parsePendingLink(value: unknown, now: string): KnowledgePendingLink | null {
  if (!isRecord(value)) return null;
  const link = parseLink(value, now);
  if (!link) return null;
  return {
    ...link,
    status: parsePendingStatus(value.status),
  };
}

function parseOpenQuestion(value: unknown, now: string): KnowledgeOpenQuestion | null {
  if (!isRecord(value)) return null;
  const id = cleanId(asString(value.id));
  const question = asString(value.question);
  if (!id || !question) return null;
  return {
    id,
    question,
    related_papers: Array.isArray(value.related_papers) ? value.related_papers.map(asString).map(cleanId).filter(Boolean) : [],
    status: value.status === 'closed' ? 'closed' : 'open',
    created_at: asString(value.created_at) || now,
  };
}

function validateNode(node: KnowledgePaperNode): void {
  if (!node.id) throw new Error('node id is required');
  if (!node.title) throw new Error('node title is required');
  if (!VALID_STATUSES.has(node.status)) throw new Error(`invalid node status: ${node.status}`);
  if (!VALID_VERDICTS.has(node.verdict)) throw new Error(`invalid node verdict: ${node.verdict}`);
}

function validateLink(link: KnowledgeLink): void {
  if (!link.id) throw new Error('link id is required');
  if (!link.source || !link.target) throw new Error('link source and target are required');
  if (link.source === link.target) throw new Error('link source and target must differ');
  if (!VALID_LINK_TYPES.has(link.type)) throw new Error(`invalid link type: ${link.type}`);
  if (!link.reason_short) throw new Error('link reason_short is required');
  if (!VALID_CREATED_BY.has(link.created_by)) throw new Error(`invalid created_by: ${link.created_by}`);
  if (link.confidence < 0 || link.confidence > 1) throw new Error('confidence must be between 0 and 1');
}

function validatePendingLink(link: KnowledgePendingLink): void {
  validateLink(link);
  if (!VALID_PENDING_STATUS.has(link.status)) throw new Error(`invalid pending status: ${link.status}`);
}

function findExistingLinkId(index: KnowledgeIndex, input: UpsertLinkInput): string | null {
  const source = cleanId(input.source);
  const target = cleanId(input.target);
  return index.links.find((link) => link.source === source && link.target === target && link.type === input.type)?.id ?? null;
}

function normalizeEvidence(items: unknown[]): KnowledgeEvidencePointer[] {
  return items.flatMap((item) => {
    if (!isRecord(item)) return [];
    const paper_id = cleanId(asString(item.paper_id));
    if (!paper_id) return [];
    return [{
      paper_id,
      note_path: optionalString(item.note_path),
      section: optionalString(item.section),
    }];
  });
}

function matchedNodeFields(node: KnowledgePaperNode, queryTokens: string[]): string[] {
  if (queryTokens.length === 0) return [];
  const fields: Array<[string, string]> = [
    ['id', node.id],
    ['title', node.title],
    ['summary_short', node.summary_short ?? ''],
    ['arxiv_id', node.arxiv_id ?? ''],
    ['note_path', node.note_path],
  ];
  return fields.flatMap(([name, text]) => (
    queryTokens.some((token) => text.toLowerCase().includes(token)) ? [name] : []
  ));
}

function scoreCandidate(queryTokens: string[], targetText: string): number {
  if (queryTokens.length === 0) return 0;
  const target = targetText.toLowerCase();
  let hits = 0;
  for (const token of new Set(queryTokens)) {
    if (target.includes(token)) hits += token.length >= 7 ? 1.4 : 1;
  }
  return hits / Math.max(3, Math.min(10, queryTokens.length));
}

function inferLinkType(sourceText: string, targetText: string): KnowledgeLinkType {
  const text = `${sourceText} ${targetText}`.toLowerCase();
  if (/(challenge|contradict|反驳|挑战)/.test(text)) return 'challenges';
  if (/(contrast|compare|对比|不同)/.test(text)) return 'contrasts';
  if (/(extend|extension|扩展|延续)/.test(text)) return 'extends';
  if (/(benchmark|dataset|toolbench|toolalpaca|same|相同)/.test(text)) return 'uses_same';
  if (/(apply|应用)/.test(text)) return 'applies_to';
  return 'complements';
}

function buildReasonShort(sectionTitle: string | undefined, targetTitle: string, type: KnowledgeLinkType): string {
  const section = sectionTitle?.trim() ? `当前 section "${sectionTitle.trim()}"` : '当前阅读内容';
  const relation = type === 'uses_same' ? '可能共享方法、任务或 benchmark' : `可能与 "${targetTitle}" 形成 ${type} 关系`;
  return `${section} ${relation}; 建议进一步读取对应 note 证据后再写入正式关系。`;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5._-]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 80);
}

function clampLimit(value: unknown, fallback = DEFAULT_LIMIT): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(MAX_LIMIT, raw));
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function defaultDirectional(type: KnowledgeLinkType): boolean {
  return !['contrasts', 'complements', 'uses_same'].includes(type);
}

function parseStatus(value: unknown): KnowledgePaperStatus {
  return typeof value === 'string' && VALID_STATUSES.has(value as KnowledgePaperStatus)
    ? value as KnowledgePaperStatus
    : 'unread';
}

function parseVerdict(value: unknown): KnowledgePaperVerdict {
  return typeof value === 'string' && VALID_VERDICTS.has(value as KnowledgePaperVerdict)
    ? value as KnowledgePaperVerdict
    : 'unknown';
}

function parseLinkType(value: unknown): KnowledgeLinkType {
  return typeof value === 'string' && VALID_LINK_TYPES.has(value as KnowledgeLinkType)
    ? value as KnowledgeLinkType
    : 'complements';
}

function parseCreatedBy(value: unknown): KnowledgeCreatedBy {
  return typeof value === 'string' && VALID_CREATED_BY.has(value as KnowledgeCreatedBy)
    ? value as KnowledgeCreatedBy
    : 'agent';
}

function parsePendingStatus(value: unknown): PendingLinkStatus {
  return typeof value === 'string' && VALID_PENDING_STATUS.has(value as PendingLinkStatus)
    ? value as PendingLinkStatus
    : 'pending_user_review';
}

function cleanId(value: string): string {
  return value.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

function makeId(prefix: string, now: string, seq: number): string {
  const stamp = now.replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}_${stamp}_${String(seq).padStart(4, '0')}`;
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('::');
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(value: unknown): string | undefined {
  const text = asString(value);
  return text || undefined;
}

function cleanOptional(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function backupIfExists(path: string): Promise<string | undefined> {
  try {
    await fs.lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const backupPath = `${path}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await fs.copyFile(path, backupPath);
  return backupPath;
}

function resolveNotePath(notePath: string, outputDir: string): string {
  const output = resolve(outputDir);
  const workspace = dirname(output);
  const path = isAbsolute(notePath)
    ? resolve(notePath)
    : notePath === 'output' || notePath.startsWith(`output${sep}`) || notePath.startsWith('output/')
      ? resolve(workspace, notePath)
      : resolve(output, notePath);
  assertInsideRoot(path, output, 'note path escapes outputDir');
  return path;
}

function assertInsideRoot(path: string, root: string, message: string): void {
  const target = resolve(path);
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`${message}: ${path}`);
  }
}
