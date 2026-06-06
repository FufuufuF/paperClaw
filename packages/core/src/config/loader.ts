import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRepoRoot } from './paths.js';
import { resolveEnvRefs } from './env.js';
import { parsePaperClawConfig, type PaperClawConfig } from './schema.js';

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

export interface LoadConfigOpts {
  repoRoot?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(opts: LoadConfigOpts = {}): PaperClawConfig {
  const root = opts.repoRoot ?? getRepoRoot();
  loadEnv(root);

  const configPath = opts.configPath ?? findConfigFile(root);
  if (!configPath) {
    return parsePaperClawConfig(resolveEnvRefs({}, opts.env));
  }

  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  const resolved = resolveEnvRefs(raw, opts.env);
  return parsePaperClawConfig(resolved);
}

export function findConfigFile(repoRoot = getRepoRoot()): string | null {
  const candidates = [
    join(repoRoot, 'paperclaw.config.json'),
    join(repoRoot, 'config', 'paperclaw.json'),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}
