import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILTIN_SKILLS_DIR = join(SRC_ROOT, 'skills');

export interface SkillMetadata {
  description?: string;
  always?: boolean;
  metadata?: Record<string, unknown>;
  requires?: {
    bins?: string[];
    env?: string[];
  };
  [key: string]: unknown;
}

export interface SkillEntry {
  name: string;
  path: string;
  source: 'workspace' | 'builtin';
  metadata: SkillMetadata;
  available: boolean;
  missingRequirements: string[];
}

export interface SkillsLoaderOpts {
  workspace?: string;
  builtinSkillsDir?: string;
  disabledSkills?: Iterable<string>;
}

/**
 * Markdown skill loader. Mirrors nanobot's `agent/skills.py`:
 * workspace skills override builtin skills, disabled skills are hidden, and
 * frontmatter carries availability/always metadata.
 */
export class SkillsLoader {
  readonly workspace?: string;
  readonly workspaceSkillsDir?: string;
  readonly builtinSkillsDir: string;
  readonly disabledSkills: Set<string>;

  constructor(opts: SkillsLoaderOpts | string = {}) {
    if (typeof opts === 'string') {
      this.workspace = undefined;
      this.workspaceSkillsDir = undefined;
      this.builtinSkillsDir = opts;
      this.disabledSkills = new Set();
      return;
    }
    this.workspace = opts.workspace;
    this.workspaceSkillsDir = opts.workspace ? join(opts.workspace, 'skills') : undefined;
    this.builtinSkillsDir = opts.builtinSkillsDir ?? BUILTIN_SKILLS_DIR;
    this.disabledSkills = new Set(opts.disabledSkills ?? []);
  }

  listSkills(filterUnavailable = true): SkillEntry[] {
    const out: SkillEntry[] = [];

    if (this.workspaceSkillsDir) {
      out.push(...this.skillEntriesFromDir(this.workspaceSkillsDir, 'workspace'));
    }

    const workspaceNames = new Set(out.map((entry) => entry.name));
    out.push(...this.skillEntriesFromDir(this.builtinSkillsDir, 'builtin', workspaceNames));

    const filtered = out.filter((entry) => !this.disabledSkills.has(entry.name));
    const available = filterUnavailable
      ? filtered.filter((entry) => entry.available)
      : filtered;
    available.sort((a, b) => a.name.localeCompare(b.name));
    return available;
  }

  private skillEntriesFromDir(
    base: string,
    source: 'workspace' | 'builtin',
    skipNames: Set<string> = new Set(),
  ): SkillEntry[] {
    if (!existsSync(base)) return [];
    const out: SkillEntry[] = [];
    for (const name of readdirSync(base)) {
      if (skipNames.has(name)) continue;
      const skillPath = join(base, name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      const metadata = readMetadataFromFile(skillPath);
      const missingRequirements = getMissingRequirements(metadata);
      out.push({
        name,
        path: skillPath,
        source,
        metadata,
        available: missingRequirements.length === 0,
        missingRequirements,
      });
    }
    return out;
  }

  getAlwaysSkills(): string[] {
    return this.listSkills(true)
      .filter((s) => isAlwaysSkill(s.metadata))
      .map((s) => s.name);
  }

  loadSkill(name: string): string | null {
    for (const root of this.skillRoots()) {
      const skillPath = join(root, name, 'SKILL.md');
      if (existsSync(skillPath) && !this.disabledSkills.has(name)) {
        return readFileSync(skillPath, 'utf8');
      }
    }
    return null;
  }

  loadSkillsForContext(names: string[]): string {
    const parts = names.flatMap((name) => {
      const raw = this.loadSkill(name);
      if (!raw) return [];
      return [`### Skill: ${name}\n\n${stripFrontmatter(raw)}`];
    });
    return parts.join('\n\n---\n\n');
  }

  buildSkillsSummary(exclude: Set<string> = new Set()): string {
    const lines = this.listSkills(false)
      .filter((s) => !exclude.has(s.name))
      .map((s) => {
        const desc = typeof s.metadata.description === 'string' ? s.metadata.description : s.name;
        const unavailable = s.available ? '' : ` (unavailable: ${s.missingRequirements.join(', ')})`;
        return `- **${s.name}** — ${desc}${unavailable}  \`${s.path}\``;
      });
    return lines.join('\n');
  }

  getSkillMetadata(name: string): SkillMetadata | null {
    const raw = this.loadSkill(name);
    return raw ? parseSkillMetadata(raw) : null;
  }

  private skillRoots(): string[] {
    return [
      ...(this.workspaceSkillsDir ? [this.workspaceSkillsDir] : []),
      this.builtinSkillsDir,
    ];
  }
}

function readMetadataFromFile(path: string): SkillMetadata {
  return parseSkillMetadata(readFileSync(path, 'utf8')) ?? {};
}

function readFrontmatter(markdown: string): string | null {
  if (!markdown.startsWith('---')) return null;
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return null;
  return markdown.slice(3, end).trim();
}

function parseSkillMetadata(markdown: string): SkillMetadata | null {
  const fm = readFrontmatter(markdown);
  if (!fm) return {};
  const meta: SkillMetadata = {};
  for (const line of fm.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = parseScalar(trimmed.slice(idx + 1).trim());
    meta[key] = value;
  }
  return meta;
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown.trim();
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return markdown.trim();
  return markdown.slice(end + '\n---'.length).trim();
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseScalar(value: string): unknown {
  const unquoted = unquote(value);
  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;
  if (/^\[.*\]$/.test(unquoted)) {
    return unquoted
      .slice(1, -1)
      .split(',')
      .map((item) => unquote(item.trim()))
      .filter(Boolean);
  }
  return unquoted;
}

function isAlwaysSkill(metadata: SkillMetadata): boolean {
  if (metadata.always === true) return true;
  const nested = metadata.metadata;
  return Boolean(nested && typeof nested === 'object' && (nested as { always?: unknown }).always === true);
}

function getMissingRequirements(metadata: SkillMetadata): string[] {
  const requires = metadata.requires;
  if (!requires || typeof requires !== 'object') return [];
  const missing: string[] = [];
  for (const bin of requires.bins ?? []) {
    if (!commandExists(bin)) missing.push(`CLI: ${bin}`);
  }
  for (const env of requires.env ?? []) {
    if (!process.env[env]) missing.push(`ENV: ${env}`);
  }
  return missing;
}

function commandExists(_name: string): boolean {
  // Keep the checkpoint dependency-free. Real CLI requirement probing can be
  // added when workspace/file tools are implemented.
  return true;
}
