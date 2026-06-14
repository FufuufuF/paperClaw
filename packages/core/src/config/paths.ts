import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walk up from this file to the repo root (where pnpm-workspace.yaml lives).
 * Falls back to cwd if not found.
 */
export function getRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** `<repo>/nanobot-store/<run_id>/` — created on demand. */
export async function runOutputDir(runId: string, repoRoot?: string): Promise<string> {
  const root = repoRoot ?? getRepoRoot();
  const dir = resolve(root, 'nanobot-store', runId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function defaultStoreDir(repoRoot?: string): string {
  return resolve(repoRoot ?? getRepoRoot(), 'nanobot-store');
}
