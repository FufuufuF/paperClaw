import { promises as fs } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';

export interface GuardedPath {
  path: string;
  relativePath: string;
}

export interface WriteResult {
  path: string;
  backupPath?: string;
  bytes: number;
}

export class WorkspaceGuard {
  readonly workspace: string;
  readonly outputDir: string;

  constructor(opts: { workspace: string; outputDir: string }) {
    this.workspace = resolve(opts.workspace);
    this.outputDir = resolve(opts.outputDir);
  }

  async resolveOutputPath(input: string): Promise<GuardedPath> {
    if (!input || input.trim().length === 0) {
      throw new Error('path is required');
    }
    if (input.includes('\0')) {
      throw new Error('path contains NUL byte');
    }

    const candidate = resolve(this.outputDir, input);
    this.assertInsideOutput(candidate);
    await this.assertNoSymlinkEscape(candidate);
    return {
      path: candidate,
      relativePath: relative(this.outputDir, candidate),
    };
  }

  async requireProfilePath(input = 'profile.md'): Promise<GuardedPath> {
    const resolved = await this.resolveOutputPath(input);
    if (resolved.path !== resolve(this.outputDir, 'profile.md')) {
      throw new Error('profile writes are limited to output/profile.md');
    }
    return resolved;
  }

  async requireNotePath(input: string): Promise<GuardedPath> {
    const resolved = await this.resolveOutputPath(input);
    if (!isMarkdown(resolved.path) || !resolved.relativePath.split(sep).includes('papers')) {
      throw new Error('note writes are limited to output/**/papers/*.md');
    }
    const parts = resolved.relativePath.split(sep);
    const papersIdx = parts.lastIndexOf('papers');
    if (papersIdx < 1 || papersIdx !== parts.length - 2) {
      throw new Error('note path must be output/<run_id>/papers/<slug>.md');
    }
    return resolved;
  }

  async findNoteBySlug(slug: string): Promise<GuardedPath | null> {
    const safe = normalizeSlug(slug);
    if (!safe) throw new Error('slug is required');
    const notes = await this.listNotes();
    const matches = notes.filter((note) => basename(note.path, '.md') === safe);
    if (matches.length === 0) return null;
    const withStats = await Promise.all(matches.map(async (note) => ({
      note,
      mtimeMs: (await fs.stat(note.path)).mtimeMs,
    })));
    withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return withStats[0]!.note;
  }

  async listNotes(): Promise<GuardedPath[]> {
    const out: GuardedPath[] = [];
    await this.walkOutput(async (path, rel) => {
      const parts = rel.split(sep);
      if (parts.includes('papers') && parts.at(-1)?.endsWith('.md')) {
        out.push({ path, relativePath: rel });
      }
    });
    return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  async readText(path: string, maxChars?: number): Promise<string> {
    const real = await this.assertExistingInsideOutput(path);
    const text = await fs.readFile(real, 'utf8');
    return maxChars && maxChars > 0 ? text.slice(0, maxChars) : text;
  }

  async atomicWriteText(path: string, content: string, opts: { backup?: boolean } = {}): Promise<WriteResult> {
    this.assertInsideOutput(path);
    await this.assertNoSymlinkEscape(path);
    await fs.mkdir(dirname(path), { recursive: true });

    let backupPath: string | undefined;
    if (opts.backup !== false) {
      backupPath = await this.backupIfExists(path);
    }

    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, path);
    return { path, backupPath, bytes: Buffer.byteLength(content, 'utf8') };
  }

  async backupIfExists(path: string): Promise<string | undefined> {
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

  private assertInsideOutput(path: string): void {
    const target = resolve(path);
    if (target !== this.outputDir && !target.startsWith(this.outputDir + sep)) {
      throw new Error(`path escapes outputDir: ${path}`);
    }
  }

  private async assertExistingInsideOutput(path: string): Promise<string> {
    const resolved = resolve(path);
    this.assertInsideOutput(resolved);
    const real = await fs.realpath(resolved);
    await this.assertRealInsideOutput(real);
    return real;
  }

  private async assertNoSymlinkEscape(path: string): Promise<void> {
    const target = resolve(path);
    const realOutput = await this.realOutputDir();
    let current = target;
    const missing: string[] = [];
    while (current !== this.outputDir && current.startsWith(this.outputDir + sep)) {
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) {
          const real = await fs.realpath(current);
          assertInsideRoot(real, realOutput, 'path escapes outputDir through symlink');
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        missing.push(current);
      }
      current = dirname(current);
    }
    // Missing descendants are fine as long as their nearest existing parent is inside outputDir.
    void missing;
    const parent = await nearestExistingParent(dirname(target), this.outputDir);
    const realParent = await fs.realpath(parent);
    assertInsideRoot(realParent, realOutput, 'path escapes outputDir through realpath');
  }

  private async walkOutput(visitor: (path: string, rel: string) => Promise<void> | void): Promise<void> {
    await fs.mkdir(this.outputDir, { recursive: true });
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const path = resolve(dir, entry.name);
        const rel = relative(this.outputDir, path);
        if (entry.isSymbolicLink()) {
          await this.assertNoSymlinkEscape(path);
          continue;
        }
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (entry.isFile()) await visitor(path, rel);
      }
    };
    await walk(this.outputDir);
  }

  private async realOutputDir(): Promise<string> {
    await fs.mkdir(this.outputDir, { recursive: true });
    return await fs.realpath(this.outputDir);
  }

  private async assertRealInsideOutput(path: string): Promise<void> {
    const realOutput = await this.realOutputDir();
    assertInsideRoot(path, realOutput, 'path escapes outputDir through realpath');
  }
}

export function normalizeSlug(value: string): string {
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

async function nearestExistingParent(start: string, stop: string): Promise<string> {
  let current = resolve(start);
  const root = resolve(stop);
  while (current !== root && current.startsWith(root + sep)) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isDirectory()) return current;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    current = dirname(current);
  }
  return root;
}

function assertInsideRoot(path: string, root: string, message: string): void {
  const target = resolve(path);
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`${message}: ${path}`);
  }
}
