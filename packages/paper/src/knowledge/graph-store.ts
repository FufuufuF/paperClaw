import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LLMClient } from '@paperclaw/core';
import type {
  KeyTermVocabulary,
  PaperEvidencePointer,
  PaperKnowledgeIndex,
  PaperLink,
  PaperNeighbor,
  PaperNode,
  PaperRelationPreview,
  PaperStatus,
  PaperStoreWriteResult,
} from './types.js';

const VALID_STATUSES = new Set<PaperStatus>(['unread', 'reading', 'read', 'skipped']);
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_KEY_TERMS = 5;
const MAX_CONSOLIDATION_LINKS = 5;
const NOTE_SNIPPET_CHARS = 12000;
const SECTION_SNIPPET_CHARS = 6000;

let cachedVocabulary: KeyTermVocabulary | null = null;

export interface PaperKnowledgeStoreOpts {
  outputDir: string;
  indexPath?: string;
  now?: () => Date;
}

export interface SearchNodesInput {
  query?: string;
  status?: PaperStatus[];
  keyTerms?: string[];
  limit?: number;
}

export interface SearchNodeResult {
  id: string;
  title: string;
  summary_short?: string;
  note_path: string;
  arxiv_id?: string;
  status: PaperStatus;
  key_terms: string[];
  matched: string[];
}

export interface RecentNodesInput {
  status?: PaperStatus[];
  keyTerms?: string[];
  limit?: number;
}

export interface SearchLinksInput {
  query?: string;
  source?: string;
  target?: string;
  keyTerms?: string[];
  limit?: number;
}

export interface NeighborInput {
  id: string;
  limit?: number;
}

export interface UpsertNodeInput {
  id: string;
  title?: string;
  summary_short?: string;
  note_path?: string;
  arxiv_id?: string;
  status?: PaperStatus;
  key_terms?: string[];
}

export interface UpsertLinkInput {
  id?: string;
  source?: string;
  target?: string;
  paper_ids?: [string, string] | string[];
  reason: string;
  shared_terms?: string[];
  evidence?: PaperEvidencePointer[];
}

export interface UpdateLinkInput {
  id: string;
  reason?: string;
  shared_terms?: string[];
  evidence?: PaperEvidencePointer[];
}

export interface RenameNodeInput {
  oldId: string;
  newId: string;
  note_path?: string;
}

export interface ConsolidatePaperInput {
  id: string;
  title?: string;
  note_path: string;
  arxiv_id?: string;
  llm?: LLMClient;
}

export interface ConsolidatePaperResult {
  node: PaperNode;
  links: PaperLink[];
  candidates: number;
  llm: { used: boolean; model?: string; fallback?: string };
  write: PaperStoreWriteResult;
}

export interface PreviewSectionRelationsInput {
  statePath?: string;
  notePath?: string;
  slug?: string;
  sectionIndex: number;
  maxResults?: number;
  llm?: LLMClient;
}

export interface PreviewSectionRelationsResult {
  slug: string;
  section: { index: number; title: string };
  key_terms: string[];
  results: PaperRelationPreview[];
}

interface GuidedReadingStateLike {
  slug: string;
  title: string;
  notePath: string;
  sections: Array<{ index: number; title: string; text: string }>;
}

export class PaperKnowledgeStore {
  readonly outputDir: string;
  readonly indexPath: string;
  private readonly now: () => Date;

  constructor(opts: PaperKnowledgeStoreOpts) {
    this.outputDir = resolve(opts.outputDir);
    this.indexPath = resolve(opts.indexPath ?? resolve(this.outputDir, 'knowledge-index.json'));
    this.now = opts.now ?? (() => new Date());
    assertInsideRoot(this.indexPath, this.outputDir, 'knowledge index path escapes outputDir');
  }

  async load(): Promise<PaperKnowledgeIndex> {
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      return await normalizeIndex(JSON.parse(raw), this.isoNow());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultIndex(this.isoNow());
      throw err;
    }
  }

  async save(index: PaperKnowledgeIndex, opts: { backup?: boolean } = {}): Promise<PaperStoreWriteResult> {
    index.updated_at = this.isoNow();
    await fs.mkdir(dirname(this.indexPath), { recursive: true });
    let backupPath: string | undefined;
    if (opts.backup !== false) {
      backupPath = await backupIfExists(this.indexPath);
    }
    const normalized = await normalizeIndex(index, index.updated_at);
    const content = `${JSON.stringify(normalized, null, 2)}\n`;
    const tmp = `${this.indexPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, this.indexPath);
    return { path: this.indexPath, backupPath, bytes: Buffer.byteLength(content, 'utf8') };
  }

  async getVocabulary(): Promise<KeyTermVocabulary> {
    return readVocabulary();
  }

  async validateKeyTerms(terms: string[]): Promise<string[]> {
    return normalizeKeyTerms(terms, { strict: true });
  }

  async getNode(id: string): Promise<PaperNode | null> {
    const index = await this.load();
    return index.papers[cleanId(id)] ?? null;
  }

  async searchNodes(input: SearchNodesInput): Promise<{ results: SearchNodeResult[]; truncated: boolean; total: number }> {
    const index = await this.load();
    const limit = clampLimit(input.limit);
    const queryTokens = tokenize(input.query ?? '');
    const statuses = new Set(input.status ?? []);
    const termSet = new Set(await normalizeKeyTerms(input.keyTerms ?? [], { strict: false }));
    const rows = Object.values(index.papers)
      .map((node) => ({ node, matched: matchedNodeFields(node, queryTokens, termSet) }))
      .filter(({ node, matched }) => {
        if (statuses.size > 0 && !statuses.has(node.status)) return false;
        if (termSet.size > 0 && !node.key_terms.some((term) => termSet.has(term))) return false;
        return queryTokens.length === 0 || matched.length > 0;
      })
      .sort((a, b) => b.node.updated_at.localeCompare(a.node.updated_at) || a.node.id.localeCompare(b.node.id));
    return {
      results: rows.slice(0, limit).map(({ node, matched }) => toSearchNodeResult(node, matched)),
      truncated: rows.length > limit,
      total: rows.length,
    };
  }

  async recentNodes(input: RecentNodesInput = {}): Promise<{ results: SearchNodeResult[]; truncated: boolean; total: number }> {
    const index = await this.load();
    const limit = clampLimit(input.limit);
    const statuses = new Set(input.status ?? []);
    const termSet = new Set(await normalizeKeyTerms(input.keyTerms ?? [], { strict: false }));
    const rows = Object.values(index.papers)
      .filter((node) => {
        if (statuses.size > 0 && !statuses.has(node.status)) return false;
        if (termSet.size > 0 && !node.key_terms.some((term) => termSet.has(term))) return false;
        return true;
      })
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
    return {
      results: rows.slice(0, limit).map((node) => toSearchNodeResult(node, [])),
      truncated: rows.length > limit,
      total: rows.length,
    };
  }

  async neighbors(input: NeighborInput): Promise<{ node: string; neighbors: PaperNeighbor[]; truncated: boolean }> {
    const index = await this.load();
    const id = cleanId(input.id);
    const limit = clampLimit(input.limit);
    const rows: PaperNeighbor[] = [];
    for (const link of index.links) {
      if (!link.paper_ids.includes(id)) continue;
      const neighborId = link.paper_ids[0] === id ? link.paper_ids[1] : link.paper_ids[0];
      const neighbor = index.papers[neighborId];
      rows.push({
        paper_id: neighborId,
        title: neighbor?.title ?? neighborId,
        arxiv_id: neighbor?.arxiv_id,
        summary_short: neighbor?.summary_short,
        link_id: link.id,
        reason: link.reason,
        shared_terms: link.shared_terms,
      });
    }
    rows.sort((a, b) => b.shared_terms.length - a.shared_terms.length || a.paper_id.localeCompare(b.paper_id));
    return { node: id, neighbors: rows.slice(0, limit), truncated: rows.length > limit };
  }

  async getLink(id: string): Promise<PaperLink | null> {
    const index = await this.load();
    return index.links.find((link) => link.id === cleanId(id)) ?? null;
  }

  async searchLinks(input: SearchLinksInput): Promise<{ results: PaperLink[]; truncated: boolean; total: number }> {
    const index = await this.load();
    const limit = clampLimit(input.limit);
    const queryTokens = tokenize(input.query ?? '');
    const source = input.source ? cleanId(input.source) : undefined;
    const target = input.target ? cleanId(input.target) : undefined;
    const termSet = new Set(await normalizeKeyTerms(input.keyTerms ?? [], { strict: false }));
    const rows = index.links.filter((link) => {
      if (source && !link.paper_ids.includes(source)) return false;
      if (target && !link.paper_ids.includes(target)) return false;
      if (termSet.size > 0 && !link.shared_terms.some((term) => termSet.has(term))) return false;
      if (queryTokens.length === 0) return true;
      const text = [link.id, ...link.paper_ids, link.reason, ...link.shared_terms].join(' ').toLowerCase();
      return queryTokens.some((token) => text.includes(token));
    });
    rows.sort((a, b) => b.shared_terms.length - a.shared_terms.length || b.updated_at.localeCompare(a.updated_at));
    return { results: rows.slice(0, limit), truncated: rows.length > limit, total: rows.length };
  }

  async upsertNode(input: UpsertNodeInput): Promise<{ node: PaperNode; write: PaperStoreWriteResult }> {
    const id = cleanId(input.id);
    if (!id) throw new Error('node id is required');
    const index = await this.load();
    const previous = index.papers[id];
    const now = this.isoNow();
    const node: PaperNode = {
      id,
      title: input.title?.trim() || previous?.title || id,
      summary_short: cleanOptional(input.summary_short) ?? previous?.summary_short,
      note_path: input.note_path?.trim() || previous?.note_path || '',
      arxiv_id: input.arxiv_id?.trim() || previous?.arxiv_id,
      status: input.status ?? previous?.status ?? 'unread',
      key_terms: input.key_terms ? await normalizeKeyTerms(input.key_terms, { strict: true }) : previous?.key_terms ?? [],
      updated_at: now,
    };
    validateNode(node);
    index.papers[id] = node;
    const write = await this.save(index);
    return { node, write };
  }

  async upsertLink(input: UpsertLinkInput): Promise<{ link: PaperLink; write: PaperStoreWriteResult }> {
    const index = await this.load();
    const now = this.isoNow();
    const pair = normalizePaperPair(input);
    const existing = index.links.find((link) => pairKey(link.paper_ids[0], link.paper_ids[1]) === pairKey(pair[0], pair[1]));
    const id = cleanId(input.id ?? existing?.id ?? makeLinkId(pair));
    const shared = input.shared_terms
      ? await normalizeKeyTerms(input.shared_terms, { strict: true })
      : sharedTerms(index.papers[pair[0]]?.key_terms ?? [], index.papers[pair[1]]?.key_terms ?? []);
    const link: PaperLink = {
      id,
      paper_ids: pair,
      reason: input.reason.trim(),
      shared_terms: shared,
      evidence: normalizeEvidence(input.evidence ?? existing?.evidence ?? []),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    validateLink(link);
    if (existing) Object.assign(existing, link);
    else index.links.push(link);
    const write = await this.save(index);
    return { link, write };
  }

  async updateLink(input: UpdateLinkInput): Promise<{ link: PaperLink; write: PaperStoreWriteResult }> {
    const index = await this.load();
    const link = index.links.find((item) => item.id === cleanId(input.id));
    if (!link) throw new Error(`link not found: ${input.id}`);
    if (typeof input.reason === 'string') link.reason = input.reason.trim();
    if (input.shared_terms) link.shared_terms = await normalizeKeyTerms(input.shared_terms, { strict: true });
    if (input.evidence) link.evidence = normalizeEvidence(input.evidence);
    link.updated_at = this.isoNow();
    validateLink(link);
    const write = await this.save(index);
    return { link, write };
  }

  async deleteLink(id: string): Promise<{ deleted: PaperLink | null; write: PaperStoreWriteResult }> {
    const index = await this.load();
    const clean = cleanId(id);
    const idx = index.links.findIndex((link) => link.id === clean);
    const deleted = idx >= 0 ? index.links.splice(idx, 1)[0] ?? null : null;
    const write = await this.save(index);
    return { deleted, write };
  }

  async renameNode(input: RenameNodeInput): Promise<{ renamed: boolean; node: PaperNode | null; write?: PaperStoreWriteResult }> {
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
    const node: PaperNode = {
      ...existing,
      id: newId,
      note_path: input.note_path?.trim() || existing.note_path,
      updated_at: now,
    };
    delete index.papers[oldId];
    index.papers[newId] = node;
    for (const link of index.links) {
      const changed = link.paper_ids.map((id) => id === oldId ? newId : id) as [string, string];
      link.paper_ids = sortPair(changed[0], changed[1]);
      link.id = link.id === makeLinkId(sortPair(oldId, changed[1])) ? makeLinkId(link.paper_ids) : link.id;
      for (const evidence of link.evidence) {
        if (evidence.paper_id === oldId) {
          evidence.paper_id = newId;
          if (input.note_path) evidence.note_path = input.note_path;
        }
      }
      link.updated_at = now;
    }
    const write = await this.save(index);
    return { renamed: true, node, write };
  }

  async consolidatePaper(input: ConsolidatePaperInput): Promise<ConsolidatePaperResult> {
    const index = await this.load();
    const id = cleanId(input.id);
    if (!id) throw new Error('paper id is required');
    const notePath = resolveNotePath(input.note_path, this.outputDir);
    const note = await fs.readFile(notePath, 'utf8');
    const existing = index.papers[id];
    let llmUsed = false;
    let fallback: string | undefined;
    let summary = existing?.summary_short ?? deterministicSummary(note, input.title ?? existing?.title ?? id);
    let keyTerms = deterministicKeyTerms(note);
    if (input.llm) {
      try {
        const picked = await pickSummaryAndTerms(input.llm, note);
        summary = picked.summary_short || summary;
        keyTerms = picked.key_terms.length > 0 ? picked.key_terms : keyTerms;
        llmUsed = true;
      } catch (err) {
        fallback = (err as Error).message;
      }
    }
    const now = this.isoNow();
    const node: PaperNode = {
      id,
      title: input.title?.trim() || existing?.title || extractTitle(note) || id,
      summary_short: truncateSummary(summary, 500),
      note_path: notePath,
      arxiv_id: input.arxiv_id ?? existing?.arxiv_id,
      status: 'read',
      key_terms: await normalizeKeyTerms(keyTerms, { strict: false }),
      updated_at: now,
    };
    validateNode(node);
    index.papers[id] = node;

    const candidates = selectLinkCandidates(index, node);
    let selected = deterministicLinkSelections(node, candidates).slice(0, MAX_CONSOLIDATION_LINKS);
    if (input.llm && candidates.length > 0) {
      try {
        selected = await pickLinks(input.llm, node, candidates);
        llmUsed = true;
      } catch (err) {
        fallback ??= (err as Error).message;
      }
    }

    const links: PaperLink[] = [];
    for (const selection of selected.slice(0, MAX_CONSOLIDATION_LINKS)) {
      const target = index.papers[selection.paper_id];
      if (!target || target.id === node.id) continue;
      const pair = sortPair(node.id, target.id);
      const existingLink = index.links.find((link) => pairKey(link.paper_ids[0], link.paper_ids[1]) === pairKey(pair[0], pair[1]));
      const link: PaperLink = {
        id: existingLink?.id ?? makeLinkId(pair),
        paper_ids: pair,
        reason: selection.reason.trim() || buildLinkReason(node, target),
        shared_terms: sharedTerms(node.key_terms, target.key_terms),
        evidence: normalizeEvidence([
          { paper_id: node.id, note_path: node.note_path },
          { paper_id: target.id, note_path: target.note_path },
        ]),
        created_at: existingLink?.created_at ?? now,
        updated_at: now,
      };
      validateLink(link);
      if (existingLink) Object.assign(existingLink, link);
      else index.links.push(link);
      links.push(link);
    }

    const write = await this.save(index);
    return {
      node,
      links,
      candidates: candidates.length,
      llm: { used: llmUsed, model: llmUsed ? input.llm?.id : undefined, fallback },
      write,
    };
  }

  async previewSectionRelations(input: PreviewSectionRelationsInput): Promise<PreviewSectionRelationsResult> {
    const statePath = await this.resolveStatePath(input);
    const state = await this.loadGuidedState(statePath);
    const section = state.sections.find((item) => item.index === input.sectionIndex);
    if (!section) throw new Error(`section not found: ${input.sectionIndex}`);
    let keyTerms = deterministicKeyTerms(`${section.title}\n${section.text}`);
    if (input.llm) {
      try {
        const picked = await pickSectionTerms(input.llm, section.title, section.text);
        if (picked.length > 0) keyTerms = picked;
      } catch {
        // Keep the deterministic fallback; preview is read-only and should not fail just because LLM selection failed.
      }
    }
    keyTerms = await normalizeKeyTerms(keyTerms, { strict: false });
    const index = await this.load();
    const termSet = new Set(keyTerms);
    const rows = Object.values(index.papers)
      .filter((node) => node.id !== state.slug && node.status !== 'skipped')
      .map((node) => ({
        node,
        matched: node.key_terms.filter((term) => termSet.has(term)),
        link: findLinkBetween(index, state.slug, node.id),
      }))
      .filter((item) => item.matched.length > 0)
      .sort((a, b) => b.matched.length - a.matched.length || b.node.updated_at.localeCompare(a.node.updated_at));
    const limit = clampLimit(input.maxResults, 3);
    return {
      slug: state.slug,
      section: { index: section.index, title: section.title },
      key_terms: keyTerms,
      results: rows.slice(0, limit).map(({ node, matched, link }) => ({
        paper_id: node.id,
        title: node.title,
        summary_short: node.summary_short,
        matched_key_terms: matched,
        existing_link_reason: link?.reason,
        short_explanation: link?.reason ?? `Shares controlled terms: ${matched.join(', ')}`,
      })),
    };
  }

  private async resolveStatePath(input: PreviewSectionRelationsInput): Promise<string> {
    if (input.statePath) {
      const statePath = resolve(input.statePath);
      assertInsideRoot(statePath, this.outputDir, 'state path escapes outputDir');
      return statePath;
    }
    if (input.notePath) {
      const notePath = resolve(input.notePath);
      assertInsideRoot(notePath, this.outputDir, 'note path escapes outputDir');
      const note = await fs.readFile(notePath, 'utf8');
      const stateLine = note.split('\n').find((line) => /^reading_state:\s*/i.test(line));
      const statePath = stateLine?.replace(/^reading_state:\s*/i, '').trim();
      if (!statePath) throw new Error('guided reading state not found in note');
      const resolved = resolve(statePath);
      assertInsideRoot(resolved, this.outputDir, 'state path escapes outputDir');
      return resolved;
    }
    if (input.slug) {
      const found = await findNewestStateBySlug(this.outputDir, cleanSlug(input.slug));
      if (found) return found;
    }
    throw new Error('preview_section_relations requires statePath, notePath, or slug');
  }

  private async loadGuidedState(statePath: string): Promise<GuidedReadingStateLike> {
    assertInsideRoot(statePath, this.outputDir, 'state path escapes outputDir');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as GuidedReadingStateLike;
    if (!state.slug || !Array.isArray(state.sections)) throw new Error('invalid guided reading state');
    return state;
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

export async function readKeyTermVocabulary(): Promise<KeyTermVocabulary> {
  return readVocabulary();
}

async function defaultIndex(now: string): Promise<PaperKnowledgeIndex> {
  return {
    version: 2,
    updated_at: now,
    papers: {},
    links: [],
  };
}

async function normalizeIndex(value: unknown, now: string): Promise<PaperKnowledgeIndex> {
  const raw = isRecord(value) ? value : {};
  const papers: Record<string, PaperNode> = {};
  const rawPapers = isRecord(raw.papers) ? raw.papers : {};
  for (const [key, item] of Object.entries(rawPapers)) {
    if (!isRecord(item)) continue;
    const id = cleanId(asString(item.id) || key);
    if (!id) continue;
    const node: PaperNode = {
      id,
      title: asString(item.title) || id,
      summary_short: optionalString(item.summary_short),
      note_path: asString(item.note_path),
      arxiv_id: optionalString(item.arxiv_id),
      status: parseStatus(item.status),
      key_terms: await normalizeKeyTerms(asStringArray(item.key_terms), { strict: false }),
      updated_at: asString(item.updated_at) || now,
    };
    try {
      validateNode(node);
      papers[id] = node;
    } catch {
      // Skip malformed historical nodes.
    }
  }

  const links: PaperLink[] = [];
  const rawLinks = Array.isArray(raw.links) ? raw.links : [];
  for (const item of rawLinks) {
    const link = await parseLink(item, now, papers);
    if (!link) continue;
    const existing = links.find((candidate) => pairKey(candidate.paper_ids[0], candidate.paper_ids[1]) === pairKey(link.paper_ids[0], link.paper_ids[1]));
    if (existing) Object.assign(existing, { ...link, created_at: existing.created_at });
    else links.push(link);
  }

  return {
    version: 2,
    updated_at: asString(raw.updated_at) || now,
    papers,
    links,
  };
}

async function parseLink(value: unknown, now: string, papers: Record<string, PaperNode>): Promise<PaperLink | null> {
  if (!isRecord(value)) return null;
  const rawPair = Array.isArray(value.paper_ids)
    ? value.paper_ids.map(asString)
    : [asString(value.source), asString(value.target)];
  if (rawPair.length < 2) return null;
  const pair = sortPair(cleanId(rawPair[0] ?? ''), cleanId(rawPair[1] ?? ''));
  const reason = asString(value.reason) || asString(value.reason_short);
  const shared = asStringArray(value.shared_terms).length > 0
    ? await normalizeKeyTerms(asStringArray(value.shared_terms), { strict: false })
    : sharedTerms(papers[pair[0]]?.key_terms ?? [], papers[pair[1]]?.key_terms ?? []);
  const link: PaperLink = {
    id: cleanId(asString(value.id)) || makeLinkId(pair),
    paper_ids: pair,
    reason,
    shared_terms: shared,
    evidence: normalizeEvidence(Array.isArray(value.evidence) ? value.evidence : []),
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

async function readVocabulary(): Promise<KeyTermVocabulary> {
  if (cachedVocabulary) return cachedVocabulary;
  const path = fileURLToPath(new URL('./key-terms.json', import.meta.url));
  const raw = JSON.parse(await fs.readFile(path, 'utf8')) as KeyTermVocabulary;
  if (raw.version !== 1 || !Array.isArray(raw.terms)) throw new Error('invalid key term vocabulary');
  const seen = new Set<string>();
  for (const term of raw.terms) {
    if (!term.id || seen.has(term.id)) throw new Error(`invalid key term vocabulary id: ${term.id}`);
    seen.add(term.id);
  }
  cachedVocabulary = raw;
  return raw;
}

async function normalizeKeyTerms(terms: string[], opts: { strict: boolean }): Promise<string[]> {
  const vocab = await readVocabulary();
  const allowed = new Set(vocab.terms.map((term) => term.id));
  const out: string[] = [];
  for (const item of terms) {
    const term = item.trim().toLowerCase();
    if (!term) continue;
    if (!allowed.has(term)) {
      if (opts.strict) throw new Error(`unknown key term: ${term}`);
      continue;
    }
    if (!out.includes(term)) out.push(term);
    if (out.length >= MAX_KEY_TERMS) break;
  }
  return out;
}

function validateNode(node: PaperNode): void {
  if (!node.id) throw new Error('node id is required');
  if (!node.title) throw new Error('node title is required');
  if (!VALID_STATUSES.has(node.status)) throw new Error(`invalid node status: ${node.status}`);
  if (node.key_terms.length > MAX_KEY_TERMS) throw new Error(`paper can have at most ${MAX_KEY_TERMS} key_terms`);
}

function validateLink(link: PaperLink): void {
  if (!link.id) throw new Error('link id is required');
  if (link.paper_ids.length !== 2 || !link.paper_ids[0] || !link.paper_ids[1]) throw new Error('link paper_ids must contain two papers');
  if (link.paper_ids[0] === link.paper_ids[1]) throw new Error('link paper_ids must differ');
  if (!link.reason) throw new Error('link reason is required');
}

function normalizePaperPair(input: UpsertLinkInput): [string, string] {
  const pair = input.paper_ids ?? [input.source ?? '', input.target ?? ''];
  if (pair.length < 2) throw new Error('link requires two paper ids');
  return sortPair(cleanId(String(pair[0] ?? '')), cleanId(String(pair[1] ?? '')));
}

function normalizeEvidence(items: unknown[]): PaperEvidencePointer[] {
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

function toSearchNodeResult(node: PaperNode, matched: string[]): SearchNodeResult {
  return {
    id: node.id,
    title: node.title,
    summary_short: node.summary_short,
    note_path: node.note_path,
    arxiv_id: node.arxiv_id,
    status: node.status,
    key_terms: node.key_terms,
    matched,
  };
}

function matchedNodeFields(node: PaperNode, queryTokens: string[], termSet: Set<string>): string[] {
  const matched: string[] = [];
  if (termSet.size > 0 && node.key_terms.some((term) => termSet.has(term))) matched.push('key_terms');
  if (queryTokens.length === 0) return matched;
  const fields: Array<[string, string]> = [
    ['id', node.id],
    ['title', node.title],
    ['summary_short', node.summary_short ?? ''],
    ['arxiv_id', node.arxiv_id ?? ''],
    ['note_path', node.note_path],
    ['key_terms', node.key_terms.join(' ')],
  ];
  return matched.concat(fields.flatMap(([name, text]) => (
    queryTokens.some((token) => text.toLowerCase().includes(token)) ? [name] : []
  )));
}

function selectLinkCandidates(index: PaperKnowledgeIndex, node: PaperNode): PaperNode[] {
  const terms = new Set(node.key_terms);
  return Object.values(index.papers)
    .filter((candidate) => candidate.id !== node.id && candidate.status === 'read')
    .filter((candidate) => candidate.key_terms.some((term) => terms.has(term)))
    .sort((a, b) => sharedTerms(node.key_terms, b.key_terms).length - sharedTerms(node.key_terms, a.key_terms).length || b.updated_at.localeCompare(a.updated_at))
    .slice(0, 20);
}

function deterministicLinkSelections(node: PaperNode, candidates: PaperNode[]): Array<{ paper_id: string; reason: string }> {
  return candidates.map((candidate) => ({
    paper_id: candidate.id,
    reason: buildLinkReason(node, candidate),
  }));
}

function buildLinkReason(source: PaperNode, target: PaperNode): string {
  const shared = sharedTerms(source.key_terms, target.key_terms);
  return `${source.title} and ${target.title} are worth reading together because they share controlled terms: ${shared.join(', ') || 'related paper context'}.`;
}

async function pickSummaryAndTerms(llm: LLMClient, note: string): Promise<{ summary_short: string; key_terms: string[] }> {
  const vocab = await readVocabulary();
  const response = await llm.chat({
    responseFormat: 'json_object',
    temperature: 0,
    maxTokens: 900,
    messages: [
      {
        role: 'system',
        content: [
          'You maintain a paper knowledge graph.',
          'Return compact JSON: {"summary_short":"...","key_terms":["term-id"]}.',
          `Choose at most ${MAX_KEY_TERMS} key_terms and only from the provided closed vocabulary ids.`,
          'Do not invent terms.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          vocabulary: vocab.terms,
          note: note.slice(0, NOTE_SNIPPET_CHARS),
        }),
      },
    ],
  });
  const parsed = parseObject(response.text ?? '');
  return {
    summary_short: optionalString(parsed?.summary_short) ?? '',
    key_terms: await normalizeKeyTerms(asStringArray(parsed?.key_terms), { strict: false }),
  };
}

async function pickSectionTerms(llm: LLMClient, title: string, text: string): Promise<string[]> {
  const vocab = await readVocabulary();
  const response = await llm.chat({
    responseFormat: 'json_object',
    temperature: 0,
    maxTokens: 500,
    messages: [
      {
        role: 'system',
        content: [
          'You classify one paper section using a closed key term vocabulary.',
          'Return compact JSON: {"key_terms":["term-id"]}.',
          `Choose at most ${MAX_KEY_TERMS} key_terms and do not invent terms.`,
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          vocabulary: vocab.terms,
          section_title: title,
          section_excerpt: text.slice(0, SECTION_SNIPPET_CHARS),
        }),
      },
    ],
  });
  const parsed = parseObject(response.text ?? '');
  return normalizeKeyTerms(asStringArray(parsed?.key_terms), { strict: false });
}

async function pickLinks(llm: LLMClient, node: PaperNode, candidates: PaperNode[]): Promise<Array<{ paper_id: string; reason: string }>> {
  const allowed = new Set(candidates.map((candidate) => candidate.id));
  const response = await llm.chat({
    responseFormat: 'json_object',
    temperature: 0,
    maxTokens: 1200,
    messages: [
      {
        role: 'system',
        content: [
          'You choose paper-to-paper links for an undirected paper knowledge graph.',
          'Return compact JSON: {"links":[{"paper_id":"...","reason":"..."}]}.',
          `Choose at most ${MAX_CONSOLIDATION_LINKS} candidates. Do not output confidence.`,
          'Only choose from candidate ids.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          new_paper: {
            id: node.id,
            title: node.title,
            summary_short: node.summary_short,
            key_terms: node.key_terms,
          },
          candidates: candidates.map((candidate) => ({
            id: candidate.id,
            title: candidate.title,
            summary_short: candidate.summary_short,
            key_terms: candidate.key_terms,
            shared_terms: sharedTerms(node.key_terms, candidate.key_terms),
          })),
        }),
      },
    ],
  });
  const parsed = parseObject(response.text ?? '');
  const links = Array.isArray(parsed?.links) ? parsed.links : [];
  const out: Array<{ paper_id: string; reason: string }> = [];
  for (const item of links) {
    if (!isRecord(item)) continue;
    const paperId = cleanId(asString(item.paper_id));
    if (!allowed.has(paperId)) continue;
    const reason = asString(item.reason);
    out.push({ paper_id: paperId, reason });
    if (out.length >= MAX_CONSOLIDATION_LINKS) break;
  }
  return out.length > 0 ? out : deterministicLinkSelections(node, candidates).slice(0, MAX_CONSOLIDATION_LINKS);
}

function deterministicSummary(note: string, title: string): string {
  const cleaned = note
    .replace(/^#+\s+/gm, '')
    .split('\n')
    .map((line) => line.trim().replace(/^[-*]\s+/, ''))
    .filter((line) => line.length >= 20 && !/^(slug|source_pdf|reading_state|status|reading_mode):/i.test(line))
    .slice(0, 4)
    .join(' ');
  return truncateSummary(`${title}: ${cleaned || 'Completed paper reading note.'}`, 500);
}

function deterministicKeyTerms(text: string): string[] {
  const lower = text.toLowerCase();
  const scored: Array<[string, number]> = [
    ['llm-agents', score(lower, ['agent', 'agents', 'llm agent', 'language agent'])],
    ['tool-use', score(lower, ['tool', 'function call', 'api', 'toolbench'])],
    ['evaluation', score(lower, ['evaluation', 'evaluate', 'metric', 'error', 'reliability', 'failure'])],
    ['benchmarks', score(lower, ['benchmark', 'dataset', 'leaderboard', 'task suite'])],
    ['planning', score(lower, ['plan', 'planning', 'decomposition', 'retry', 'reflection'])],
    ['retrieval', score(lower, ['retrieval', 'rag', 'search', 'index', 'memory'])],
    ['multi-agent', score(lower, ['multi-agent', 'multiple agents', 'collaboration', 'debate'])],
    ['knowledge-graphs', score(lower, ['knowledge graph', 'graph', 'relation', 'node', 'edge'])],
    ['reasoning', score(lower, ['reasoning', 'proof', 'chain-of-thought', 'verify'])],
    ['safety', score(lower, ['safety', 'alignment', 'robustness', 'guardrail', 'risk'])],
    ['fine-tuning', score(lower, ['fine-tuning', 'finetuning', 'preference', 'sft', 'dpo'])],
    ['datasets', score(lower, ['data', 'dataset', 'annotation', 'synthetic'])],
    ['systems', score(lower, ['system', 'runtime', 'latency', 'cost', 'deployment'])],
    ['multimodal', score(lower, ['vision', 'image', 'multimodal', 'audio', 'video'])],
    ['human-ai-interaction', score(lower, ['human', 'user study', 'interface', 'feedback'])],
    ['robotics', score(lower, ['robot', 'robotics', 'embodied', 'navigation', 'manipulation'])],
  ];
  const chosen = scored
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([term]) => term)
    .slice(0, MAX_KEY_TERMS);
  return chosen.length > 0 ? chosen : ['llm-agents'];
}

function score(text: string, needles: string[]): number {
  return needles.reduce((acc, needle) => acc + (text.includes(needle) ? 1 : 0), 0);
}

function extractTitle(markdown: string): string | undefined {
  const line = markdown.split('\n').find((item) => /^#\s+/.test(item));
  return line ? line.replace(/^#\s+/, '').trim() : undefined;
}

function sharedTerms(a: string[], b: string[]): string[] {
  const bSet = new Set(b);
  return a.filter((term) => bSet.has(term)).slice(0, MAX_KEY_TERMS);
}

function findLinkBetween(index: PaperKnowledgeIndex, a: string, b: string): PaperLink | undefined {
  const key = pairKey(cleanId(a), cleanId(b));
  return index.links.find((link) => pairKey(link.paper_ids[0], link.paper_ids[1]) === key);
}

async function findNewestStateBySlug(outputDir: string, slug: string): Promise<string | null> {
  const matches: Array<{ path: string; mtimeMs: number }> = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
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

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

function parseStatus(value: unknown): PaperStatus {
  return typeof value === 'string' && VALID_STATUSES.has(value as PaperStatus)
    ? value as PaperStatus
    : 'unread';
}

function cleanId(value: string): string {
  return value.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

function cleanSlug(value: string): string {
  return value.toLowerCase().replace(/\.json$/i, '').replace(/[^a-z0-9._/-]+/g, '-').replace(/\//g, '_').replace(/^-+|-+$/g, '').slice(0, 100);
}

function makeLinkId(pair: [string, string]): string {
  return cleanId(`link-${pair[0]}-${pair[1]}`);
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('::');
}

function sortPair(a: string, b: string): [string, string] {
  const first = cleanId(a);
  const second = cleanId(b);
  return first.localeCompare(second) <= 0 ? [first, second] : [second, first];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter(Boolean);
}

function optionalString(value: unknown): string | undefined {
  const text = asString(value);
  return text || undefined;
}

function cleanOptional(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text || undefined;
}

function truncateSummary(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 3).trimEnd()}...`;
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
