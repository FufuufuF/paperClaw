import { promises as fs } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { WorkspaceGuard, type GuardedPath, type Tool, type ToolContext, type ToolResult } from '@paperclaw/core';
import { PaperKnowledgeStore } from '../knowledge/graph-store.js';

export interface NoteListing {
  slug: string;
  title: string;
  path: string;
  runId?: string;
  modifiedAt: string;
  bytes: number;
}

export function createPaperFileTools(): Tool[] {
  return [
    listNotesTool,
    readNoteTool,
    createNoteTool,
    editNoteSectionTool,
    appendNoteSectionTool,
    updateProfileSectionTool,
    renameNoteSlugTool,
  ];
}

const listNotesTool: Tool = {
  name: 'list_notes',
  description: 'List markdown paper notes under the runtime store: <store>/<runId>/papers/*.md.',
  readOnly: true,
  concurrencySafe: true,
  scopes: ['paper-read'],
  parameters: {
    type: 'object',
    properties: {
      maxResults: { type: 'integer', minimum: 1, maximum: 200 },
    },
  },
  async execute(args, ctx) {
    const guard = guardFromContext(ctx);
    const maxResults = numberArg(args.maxResults, 50);
    const notes = await listNotes(guard);
    return ok({ notes: notes.slice(0, maxResults), total: notes.length }, `${notes.length} notes found`);
  },
};

const readNoteTool: Tool = {
  name: 'read_note',
  description: 'Read one paper note by output-relative path or slug.',
  readOnly: true,
  concurrencySafe: true,
  scopes: ['paper-read'],
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      slug: { type: 'string' },
      maxChars: { type: 'integer', minimum: 100, maximum: 50000 },
    },
  },
  async execute(args, ctx) {
    const guard = guardFromContext(ctx);
    const note = await resolveNote(guard, args);
    const maxChars = numberArg(args.maxChars, 20000);
    const content = await guard.readText(note.path, maxChars);
    return ok({
      path: note.path,
      relativePath: note.relativePath,
      truncated: content.length >= maxChars,
      content,
    }, `Read ${note.relativePath}`);
  },
};

const createNoteTool: Tool = {
  name: 'create_note',
  description: 'Create a markdown note at <store>/<runId>/papers/<slug>.md. Use only when the user explicitly asks to create/write a note.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: fileWriteConfirmation('create/write a note'),
  parameters: {
    type: 'object',
    properties: {
      runId: { type: 'string' },
      slug: { type: 'string' },
      title: { type: 'string' },
      content: { type: 'string' },
      overwrite: { type: 'boolean' },
    },
    required: ['runId', 'slug', 'title'],
  },
  async execute(args, ctx) {
    const guard = guardFromContext(ctx);
    const runId = safeSegment(String(args.runId));
    const slug = normalizeSlug(String(args.slug));
    if (!runId || !slug) throw new Error('runId and slug are required');
    const note = await requireNotePath(guard, `${runId}/papers/${slug}.md`);
    const exists = await pathExists(note.path);
    if (exists && args.overwrite !== true) {
      return fail(`Note already exists: ${note.relativePath}`);
    }
    const title = String(args.title);
    const content = typeof args.content === 'string' && args.content.trim()
      ? args.content
      : defaultNoteContent(title, slug);
    const write = await guard.atomicWriteText(note.path, content, { backup: exists });
    return ok({ ...write, relativePath: note.relativePath, slug }, `Created note ${note.relativePath}`);
  },
};

const editNoteSectionTool: Tool = {
  name: 'edit_note_section',
  description: 'Replace or create a markdown section in a paper note. Use only when the user explicitly asks to edit/modify a note.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: fileWriteConfirmation('edit a note section'),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      slug: { type: 'string' },
      heading: { type: 'string' },
      content: { type: 'string' },
      level: { type: 'integer', minimum: 1, maximum: 6 },
    },
    required: ['heading', 'content'],
  },
  async execute(args, ctx) {
    const guard = guardFromContext(ctx);
    const note = await resolveNote(guard, args);
    const original = await guard.readText(note.path);
    const next = replaceSection(original, {
      heading: String(args.heading),
      content: String(args.content),
      level: numberArg(args.level, 2),
      append: false,
    });
    const write = await guard.atomicWriteText(note.path, next);
    return ok({ ...write, relativePath: note.relativePath }, `Edited section ${String(args.heading)} in ${note.relativePath}`);
  },
};

const appendNoteSectionTool: Tool = {
  name: 'append_note_section',
  description: 'Append content to a markdown section in a paper note, creating it if missing. Use only when the user explicitly asks to append/update a note.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: fileWriteConfirmation('append to a note section'),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      slug: { type: 'string' },
      heading: { type: 'string' },
      content: { type: 'string' },
      level: { type: 'integer', minimum: 1, maximum: 6 },
    },
    required: ['heading', 'content'],
  },
  async execute(args, ctx) {
    const guard = guardFromContext(ctx);
    const note = await resolveNote(guard, args);
    const original = await guard.readText(note.path);
    const next = replaceSection(original, {
      heading: String(args.heading),
      content: String(args.content),
      level: numberArg(args.level, 2),
      append: true,
    });
    const write = await guard.atomicWriteText(note.path, next);
    return ok({ ...write, relativePath: note.relativePath }, `Appended section ${String(args.heading)} in ${note.relativePath}`);
  },
};

const updateProfileSectionTool: Tool = {
  name: 'update_profile_section',
  description: 'Replace or append a markdown section in <store>/profile.md. Use only when the user explicitly asks to update profile.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: fileWriteConfirmation('update profile.md'),
  parameters: {
    type: 'object',
    properties: {
      heading: { type: 'string' },
      content: { type: 'string' },
      level: { type: 'integer', minimum: 1, maximum: 6 },
      append: { type: 'boolean' },
    },
    required: ['heading', 'content'],
  },
  async execute(args, ctx) {
    const guard = guardFromContext(ctx);
    const profile = await requireProfilePath(guard);
    const original = await pathExists(profile.path) ? await guard.readText(profile.path) : '# paperClaw Profile\n';
    const next = replaceSection(original, {
      heading: String(args.heading),
      content: String(args.content),
      level: numberArg(args.level, 2),
      append: args.append === true,
    });
    const write = await guard.atomicWriteText(profile.path, next);
    return ok({ ...write, relativePath: profile.relativePath }, `Updated profile section ${String(args.heading)}`);
  },
};

const renameNoteSlugTool: Tool = {
  name: 'rename_note_slug',
  description: 'Rename a note slug inside the same papers folder and update its slug: line. Use only when the user explicitly asks to rename a note.',
  readOnly: false,
  concurrencySafe: false,
  exclusive: true,
  scopes: ['paper-read'],
  confirmation: fileWriteConfirmation('rename a note'),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      slug: { type: 'string' },
      newSlug: { type: 'string' },
      overwrite: { type: 'boolean' },
    },
    required: ['newSlug'],
  },
  async execute(args, ctx) {
    const guard = guardFromContext(ctx);
    const note = await resolveNote(guard, args);
    const newSlug = normalizeSlug(String(args.newSlug));
    if (!newSlug) throw new Error('newSlug is required');
    const target = await requireNotePath(guard, `${relative(guard.outputDir, dirname(note.path))}/${newSlug}.md`);
    if (await pathExists(target.path) && args.overwrite !== true) {
      return fail(`Target note already exists: ${target.relativePath}`);
    }
    const original = await guard.readText(note.path);
    const updated = upsertSlugLine(original, newSlug);
    const backupPath = await guard.backupIfExists(note.path);
    await guard.atomicWriteText(target.path, updated, { backup: args.overwrite === true });
    await fs.unlink(note.path);
    const kgRename = await renameKnowledgeNodeForNote(ctx, {
      oldSlug: basename(note.path, '.md'),
      newSlug,
      notePath: target.path,
    });
    return ok({
      oldPath: note.path,
      path: target.path,
      relativePath: target.relativePath,
      backupPath,
      slug: newSlug,
      knowledgeNodeRenamed: kgRename.renamed,
    }, `Renamed ${note.relativePath} to ${target.relativePath}`);
  },
};

async function renameKnowledgeNodeForNote(
  ctx: ToolContext | undefined,
  input: { oldSlug: string; newSlug: string; notePath: string },
): Promise<{ renamed: boolean }> {
  if (!ctx) return { renamed: false };
  const store = new PaperKnowledgeStore({ outputDir: ctx.outputDir });
  const result = await store.renameNode({
    oldId: input.oldSlug,
    newId: input.newSlug,
    note_path: input.notePath,
  });
  return { renamed: result.renamed };
}

async function listNotes(guard: WorkspaceGuard): Promise<NoteListing[]> {
  const paths = await listNotePaths(guard);
  const out: NoteListing[] = [];
  for (const item of paths) {
    const stat = await fs.stat(item.path);
    const text = await guard.readText(item.path, 4000);
    const title = extractTitle(text) ?? basename(item.path, '.md');
    out.push({
      slug: basename(item.path, '.md'),
      title,
      path: item.path,
      runId: inferRunId(item.relativePath),
      modifiedAt: stat.mtime.toISOString(),
      bytes: stat.size,
    });
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

async function resolveNote(guard: WorkspaceGuard, args: Record<string, unknown>) {
  if (typeof args.path === 'string' && args.path.trim()) {
    return await requireNotePath(guard, args.path);
  }
  if (typeof args.slug === 'string' && args.slug.trim()) {
    const found = await findNoteBySlug(guard, args.slug);
    if (!found) throw new Error(`note slug not found: ${args.slug}`);
    return found;
  }
  throw new Error('path or slug is required');
}

function replaceSection(
  markdown: string,
  opts: { heading: string; content: string; level: number; append: boolean },
): string {
  const heading = opts.heading.trim().replace(/^#+\s*/, '');
  if (!heading) throw new Error('heading is required');
  const level = Math.max(1, Math.min(6, opts.level));
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const headingRe = new RegExp(`^#{1,6}\\s+${escapeRegExp(heading)}\\s*$`, 'i');
  const start = lines.findIndex((line) => headingRe.test(line));
  const newBlock = [`${'#'.repeat(level)} ${heading}`, '', opts.content.trim(), ''];

  if (start === -1) {
    const base = markdown.trimEnd();
    return `${base}${base ? '\n\n' : ''}${newBlock.join('\n')}`;
  }

  let end = start + 1;
  const currentLevel = headingLevel(lines[start]!) ?? level;
  while (end < lines.length) {
    const nextLevel = headingLevel(lines[end]!);
    if (nextLevel !== null && nextLevel <= currentLevel) break;
    end++;
  }

  if (opts.append) {
    const existing = lines.slice(start + 1, end).join('\n').trimEnd();
    const merged = existing
      ? [`${lines[start]}`, existing, '', opts.content.trim(), '']
      : newBlock;
    lines.splice(start, end - start, ...merged);
  } else {
    lines.splice(start, end - start, ...newBlock);
  }
  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
}

function upsertSlugLine(markdown: string, slug: string): string {
  const lines = markdown.split('\n');
  const idx = lines.findIndex((line) => /^slug:\s*/i.test(line));
  if (idx >= 0) {
    lines[idx] = `slug: ${slug}`;
  } else {
    const titleIdx = lines.findIndex((line) => /^#\s+/.test(line));
    lines.splice(titleIdx >= 0 ? titleIdx + 1 : 0, 0, `slug: ${slug}`);
  }
  return lines.join('\n');
}

function guardFromContext(ctx?: ToolContext): WorkspaceGuard {
  if (!ctx) throw new Error('ToolContext is required for file tools');
  return new WorkspaceGuard({ workspace: ctx.workspace, outputDir: ctx.outputDir });
}

async function requireProfilePath(guard: WorkspaceGuard, input = 'profile.md'): Promise<GuardedPath> {
  const resolved = await guard.resolveOutputPath(input);
  if (resolved.path !== resolve(guard.outputDir, 'profile.md')) {
    throw new Error('profile writes are limited to <store>/profile.md');
  }
  return resolved;
}

async function requireNotePath(guard: WorkspaceGuard, input: string): Promise<GuardedPath> {
  const resolved = await guard.resolveOutputPath(input);
  if (!isMarkdown(resolved.path) || !resolved.relativePath.split(sep).includes('papers')) {
    throw new Error('note writes are limited to <store>/**/papers/*.md');
  }
  const parts = resolved.relativePath.split(sep);
  const papersIdx = parts.lastIndexOf('papers');
  if (papersIdx < 1 || papersIdx !== parts.length - 2) {
    throw new Error('note path must be <store>/<run_id>/papers/<slug>.md');
  }
  return resolved;
}

async function findNoteBySlug(guard: WorkspaceGuard, slug: string): Promise<GuardedPath | null> {
  const safe = normalizeSlug(slug);
  if (!safe) throw new Error('slug is required');
  const notes = await listNotePaths(guard);
  const matches = notes.filter((note) => basename(note.path, '.md') === safe);
  if (matches.length === 0) return null;
  const withStats = await Promise.all(matches.map(async (note) => ({
    note,
    mtimeMs: (await fs.stat(note.path)).mtimeMs,
  })));
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0]!.note;
}

async function listNotePaths(guard: WorkspaceGuard): Promise<GuardedPath[]> {
  const out: GuardedPath[] = [];
  await walkOutput(guard.outputDir, async (path, rel) => {
    const parts = rel.split(sep);
    if (parts.includes('papers') && parts.at(-1)?.endsWith('.md')) {
      out.push({ path, relativePath: rel });
    }
  });
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function walkOutput(root: string, visitor: (path: string, rel: string) => Promise<void> | void): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      const rel = relative(root, path);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile()) await visitor(path, rel);
    }
  };
  await walk(root);
}

function normalizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\//g, '_')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith('.md');
}

function fileWriteConfirmation(action: string): Tool['confirmation'] {
  return {
    required: true,
    action,
    patterns: [
      '创建\\s*(笔记|note)',
      '新建\\s*(笔记|note)',
      '写(入|一篇)?\\s*(笔记|note)',
      '修改',
      '编辑',
      '改成',
      '更新\\s*(profile|笔记|note|section|章节|小节)',
      '追加',
      '补充',
      '重命名',
      'rename',
      'edit',
      'append',
      'create\\s*(note)?',
      'update\\s*(profile|note|section)',
    ],
    guidance: `Ask the user to explicitly confirm before ${action}.`,
  };
}

function ok(data: unknown, summary: string): ToolResult {
  return { success: true, data, summary };
}

function fail(summary: string): ToolResult {
  return { success: false, data: { error: summary }, summary };
}

function numberArg(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function defaultNoteContent(title: string, slug: string): string {
  return [`# ${title}`, '', `slug: ${slug}`, '', '## Notes', '', ''].join('\n');
}

function extractTitle(markdown: string): string | null {
  const line = markdown.split('\n').find((item) => /^#\s+/.test(item));
  return line ? line.replace(/^#\s+/, '').trim() : null;
}

function inferRunId(relativePath: string): string | undefined {
  const parts = relativePath.split(/[\\/]/);
  const papersIdx = parts.lastIndexOf('papers');
  return papersIdx > 0 ? parts[papersIdx - 1] : undefined;
}

function headingLevel(line: string): number | null {
  const match = /^(#{1,6})\s+/.exec(line);
  return match ? match[1]!.length : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
