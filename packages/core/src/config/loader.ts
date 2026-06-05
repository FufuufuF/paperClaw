import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRepoRoot } from './paths.js';

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
