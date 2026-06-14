import { promises as fs } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import type { LLMClient } from '../providers/base.js';
import { renderTemplate } from '../utils/templates.js';
import { AgentRunner } from './runner.js';
import { ToolRegistry } from './tools/registry.js';
import type { Tool } from './tools/types.js';
import type { MemoryHistoryEntry, MemoryStore } from './memory.js';

export interface DreamOpts {
  store: MemoryStore;
  llm: LLMClient;
  storeDir: string;
  maxBatchSize?: number;
  maxIterations?: number;
  maxToolResultChars?: number;
  maxCompletionTokens?: number;
}

export interface DreamRunResult {
  attempted: boolean;
  completed: boolean;
  processed: number;
  fromCursor: number;
  toCursor: number;
  summary: string;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 16_000;
const DEFAULT_MAX_COMPLETION_TOKENS = 4096;
const HISTORY_ENTRY_PREVIEW_MAX_CHARS = 4_000;
const MEMORY_FILE_MAX_CHARS = 32_000;
const SOUL_FILE_MAX_CHARS = 16_000;
const USER_FILE_MAX_CHARS = 16_000;
const STALE_THRESHOLD_DAYS = 14;

export class Dream {
  private readonly store: MemoryStore;
  private readonly llm: LLMClient;
  private readonly storeDir: string;
  private readonly maxBatchSize: number;
  private readonly maxIterations: number;
  private readonly maxToolResultChars: number;
  private readonly maxCompletionTokens: number;

  constructor(opts: DreamOpts) {
    this.store = opts.store;
    this.llm = opts.llm;
    this.storeDir = resolve(opts.storeDir);
    this.maxBatchSize = opts.maxBatchSize ?? DEFAULT_BATCH_SIZE;
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.maxToolResultChars = opts.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
    this.maxCompletionTokens = opts.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
  }

  async run(): Promise<DreamRunResult> {
    const fromCursor = await this.store.getLastDreamCursor();
    const entries = await this.store.readUnprocessedHistory(fromCursor);
    if (entries.length === 0) {
      return {
        attempted: false,
        completed: true,
        processed: 0,
        fromCursor,
        toCursor: fromCursor,
        summary: 'Dream: no unprocessed history.',
      };
    }

    const batch = entries.slice(0, this.maxBatchSize);
    const toCursor = batch.at(-1)!.cursor;
    const fileContext = await this.buildFileContext();
    const historyText = formatHistoryBatch(batch);
    const phase1 = await this.llm.chat({
      system: renderTemplate('agent/dream_phase1.md', {
        stale_threshold_days: String(STALE_THRESHOLD_DAYS),
      }),
      messages: [{
        role: 'user',
        content: `## Conversation History\n${historyText}\n\n${fileContext}`,
      }],
      maxTokens: this.maxCompletionTokens,
      temperature: 0,
    });
    if (phase1.finishReason === 'error') {
      return {
        attempted: true,
        completed: false,
        processed: 0,
        fromCursor,
        toCursor: fromCursor,
        summary: `Dream Phase 1 failed: ${phase1.text ?? 'LLM error'}`,
      };
    }

    const analysis = phase1.text?.trim() || '[SKIP]';
    const runner = new AgentRunner(this.llm);
    const result = await runner.run({
      systemPrompt: renderTemplate('agent/dream_phase2.md', {
        skill_creator_path: 'skills/skill-creator/SKILL.md',
      }),
      initialMessages: [{
        role: 'user',
        content: [
          `## Analysis Result\n${analysis}`,
          fileContext,
          await this.buildExistingSkillsContext(),
        ].filter(Boolean).join('\n\n'),
      }],
      tools: createDreamTools(this.storeDir),
      maxIterations: this.maxIterations,
      contextBudget: 64_000,
      maxToolResultChars: this.maxToolResultChars,
      agentId: 'dream',
      temperature: 0,
      maxTokens: this.maxCompletionTokens,
    });

    if (result.stopReason === 'completed') {
      await this.store.setLastDreamCursor(toCursor);
      await this.store.compactHistory();
      return {
        attempted: true,
        completed: true,
        processed: batch.length,
        fromCursor,
        toCursor,
        summary: `Dream processed ${batch.length} history entr${batch.length === 1 ? 'y' : 'ies'} through cursor ${toCursor}.`,
      };
    }

    return {
      attempted: true,
      completed: false,
      processed: 0,
      fromCursor,
      toCursor: fromCursor,
      summary: `Dream incomplete: ${result.stopReason}. Cursor was not advanced.`,
    };
  }

  private async buildFileContext(): Promise<string> {
    const currentDate = new Date().toISOString().slice(0, 10);
    const memory = truncate((await this.store.readMemory()) || '(empty)', MEMORY_FILE_MAX_CHARS);
    const soul = truncate((await this.store.readSoul()) || '(empty)', SOUL_FILE_MAX_CHARS);
    const user = truncate((await this.store.readUser()) || '(empty)', USER_FILE_MAX_CHARS);
    return [
      `## Current Date\n${currentDate}`,
      `## Current MEMORY.md (${memory.length} chars)\n${memory}`,
      `## Current SOUL.md (${soul.length} chars)\n${soul}`,
      `## Current USER.md (${user.length} chars)\n${user}`,
    ].join('\n\n');
  }

  private async buildExistingSkillsContext(): Promise<string> {
    const skillsDir = resolve(this.storeDir, 'skills');
    let names: string[];
    try {
      names = await fs.readdir(skillsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
    const entries: string[] = [];
    for (const name of names.sort()) {
      const skillPath = resolve(skillsDir, name, 'SKILL.md');
      try {
        const content = await fs.readFile(skillPath, 'utf8');
        const description = content.match(/^description:\s*(.+)$/mi)?.[1]?.trim() ?? '(no description)';
        entries.push(`${name} - ${description}`);
      } catch {
        continue;
      }
    }
    return entries.length ? `## Existing Skills\n${entries.map((entry) => `- ${entry}`).join('\n')}` : '';
  }
}

export function createDreamTools(storeDir: string): ToolRegistry {
  const root = resolve(storeDir);
  return new ToolRegistry([
    readMemoryFileTool(root),
    editMemoryFileTool(root),
    writeSkillFileTool(root),
  ]);
}

function readMemoryFileTool(root: string): Tool {
  return {
    name: 'read_file',
    description: 'Read an allowed memory file relative to the store root.',
    readOnly: true,
    concurrencySafe: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        maxChars: { type: 'integer', minimum: 1, maximum: 100000 },
      },
      required: ['path'],
    },
    async execute(args) {
      const target = resolveAllowedReadFile(root, String(args.path));
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : 50_000;
      const content = truncate(await readFileOrEmpty(target), maxChars);
      return { success: true, data: { path: relativeFromRoot(root, target), content }, summary: `Read ${relativeFromRoot(root, target)}` };
    },
  };
}

function editMemoryFileTool(root: string): Tool {
  return {
    name: 'edit_file',
    description: 'Replace exact text in SOUL.md, USER.md, or memory/MEMORY.md.',
    readOnly: false,
    concurrencySafe: false,
    exclusive: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
      },
      required: ['path', 'oldText', 'newText'],
    },
    async execute(args) {
      const target = resolveAllowedMemoryFile(root, String(args.path));
      const oldText = String(args.oldText);
      const newText = String(args.newText);
      if (!oldText) return fail('oldText is required');
      const current = await readFileOrEmpty(target);
      const index = current.indexOf(oldText);
      if (index === -1) {
        return fail(`oldText not found in ${relativeFromRoot(root, target)}`);
      }
      const next = `${current.slice(0, index)}${newText}${current.slice(index + oldText.length)}`;
      await writeFileEnsured(target, next);
      return { success: true, data: { path: relativeFromRoot(root, target) }, summary: `Edited ${relativeFromRoot(root, target)}` };
    },
  };
}

function writeSkillFileTool(root: string): Tool {
  return {
    name: 'write_file',
    description: 'Create a new skills/<name>/SKILL.md file. Existing files are never overwritten.',
    readOnly: false,
    concurrencySafe: false,
    exclusive: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    async execute(args) {
      const target = resolveSkillFile(root, String(args.path));
      if (await exists(target)) return fail(`file already exists: ${relativeFromRoot(root, target)}`);
      await writeFileEnsured(target, String(args.content));
      return { success: true, data: { path: relativeFromRoot(root, target) }, summary: `Created ${relativeFromRoot(root, target)}` };
    },
  };
}

function formatHistoryBatch(entries: MemoryHistoryEntry[]): string {
  return entries
    .map((entry) => `[${entry.timestamp}] ${truncate(entry.content, HISTORY_ENTRY_PREVIEW_MAX_CHARS)}`)
    .join('\n');
}

function resolveAllowedMemoryFile(root: string, input: string): string {
  const normalized = normalizeRelative(input);
  if (!['SOUL.md', 'USER.md', 'memory/MEMORY.md'].includes(normalized)) {
    throw new Error('Dream memory edits are limited to SOUL.md, USER.md, and memory/MEMORY.md');
  }
  return assertInside(root, resolve(root, normalized));
}

function resolveAllowedReadFile(root: string, input: string): string {
  const normalized = normalizeRelative(input);
  if (['SOUL.md', 'USER.md', 'memory/MEMORY.md'].includes(normalized)) {
    return assertInside(root, resolve(root, normalized));
  }
  if (/^skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md$/.test(normalized)) {
    return assertInside(resolve(root, 'skills'), resolve(root, normalized));
  }
  throw new Error('Dream reads are limited to memory files and skills/<name>/SKILL.md');
}

function resolveSkillFile(root: string, input: string): string {
  const normalized = normalizeRelative(input);
  if (!/^skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md$/.test(normalized)) {
    throw new Error('Dream skill writes are limited to skills/<kebab-name>/SKILL.md');
  }
  return assertInside(resolve(root, 'skills'), resolve(root, normalized));
}

function normalizeRelative(input: string): string {
  return input.replaceAll('\\', '/').replace(/^\/+/, '').replace(/^\.\//, '');
}

function assertInside(root: string, target: string): string {
  const base = resolve(root);
  const resolved = resolve(target);
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new Error(`path escapes allowed root: ${target}`);
  }
  return resolved;
}

function relativeFromRoot(root: string, target: string): string {
  return normalizeRelative(target.slice(root.length + (target.startsWith(root + sep) ? 1 : 0))) || basename(target);
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

async function writeFileEnsured(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content, 'utf8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function fail(summary: string) {
  return { success: false, data: { error: summary }, summary };
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (truncated)`;
}
