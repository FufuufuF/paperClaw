import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILTIN_SKILLS_DIR = join(SRC_ROOT, 'skills');

export interface SkillMetadata {
  description?: string;
  always?: boolean;
}

export interface SkillEntry {
  name: string;
  path: string;
  metadata: SkillMetadata;
}

/**
 * Markdown skill loader. Mirrors nanobot's `agent/skills.py` in a compact form.
 */
export class SkillsLoader {
  constructor(private readonly skillsDir = BUILTIN_SKILLS_DIR) {}

  listSkills(): SkillEntry[] {
    if (!existsSync(this.skillsDir)) return [];
    const out: SkillEntry[] = [];
    for (const name of readdirSync(this.skillsDir)) {
      const skillPath = join(this.skillsDir, name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      out.push({ name, path: skillPath, metadata: this.getSkillMetadata(name) ?? {} });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  getAlwaysSkills(): string[] {
    return this.listSkills()
      .filter((s) => s.metadata.always === true)
      .map((s) => s.name);
  }

  loadSkill(name: string): string | null {
    const skillPath = join(this.skillsDir, name, 'SKILL.md');
    if (!existsSync(skillPath)) return null;
    return readFileSync(skillPath, 'utf8');
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
    const lines = this.listSkills()
      .filter((s) => !exclude.has(s.name))
      .map((s) => `- **${s.name}** — ${s.metadata.description ?? s.name}  \`${s.path}\``);
    return lines.join('\n');
  }

  getSkillMetadata(name: string): SkillMetadata | null {
    const raw = this.loadSkill(name);
    if (!raw) return null;
    const fm = readFrontmatter(raw);
    if (!fm) return {};
    const meta: SkillMetadata = {};
    for (const line of fm.split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key === 'description') meta.description = unquote(value);
      if (key === 'always') meta.always = value === 'true';
    }
    return meta;
  }
}

function readFrontmatter(markdown: string): string | null {
  if (!markdown.startsWith('---')) return null;
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return null;
  return markdown.slice(3, end).trim();
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
