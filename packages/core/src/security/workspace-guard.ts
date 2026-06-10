import { promises as fs } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

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

  private async realOutputDir(): Promise<string> {
    await fs.mkdir(this.outputDir, { recursive: true });
    return await fs.realpath(this.outputDir);
  }

  private async assertRealInsideOutput(path: string): Promise<void> {
    const realOutput = await this.realOutputDir();
    assertInsideRoot(path, realOutput, 'path escapes outputDir through realpath');
  }
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
