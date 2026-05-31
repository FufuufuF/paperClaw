import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Best-effort dotenv loader (no extra dep). Reads `<repo>/.env` once and
 * sets values on `process.env` if the key isn't already defined.
 */
let envLoaded = false;
export function loadEnv(repoRoot?: string): void {
  if (envLoaded) return;
  envLoaded = true;
  const root = repoRoot ?? getRepoRoot();
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return;
  const txt = readFileSync(envPath, 'utf8');
  for (const line of txt.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

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

/**
 * Generate a run id matching design.md §13: ISO timestamp + short hash.
 * Hash is just 4 random hex chars — collision-resistant enough for one user.
 */
export function getRunId(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '').replace(/(\d{4})(\d{2})(\d{2})T(\d{6}).*/, '$1-$2-$3T$4');
  const hash = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${iso}-${hash}`;
}

/** `<repo>/output/<run_id>/` — created on demand. */
export async function runOutputDir(runId: string, repoRoot?: string): Promise<string> {
  const root = repoRoot ?? getRepoRoot();
  const dir = resolve(root, 'output', runId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
