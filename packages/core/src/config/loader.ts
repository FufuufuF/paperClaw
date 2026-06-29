import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRepoRoot } from './paths.js';
import { resolveEnvRefs } from './env.js';
import { parsePaperClawConfig, type PaperClawConfig } from './schema.js';
import { mergeConfig } from './merge.js';
import { DEFAULT_AGENTS_CONFIG } from '../agent/config.js';
import type { ProviderName, ProvidersConfig } from '../providers/config.js';

/**
 * Best-effort dotenv loader (no extra dep). Reads `<repo>/.env` once and
 * sets values on `process.env` if the key isn't already defined.
 */
const envLoadedRoots = new Set<string>();
export function loadEnv(repoRoot?: string): void {
  const root = repoRoot ?? getRepoRoot();
  if (envLoadedRoots.has(root)) return;
  envLoadedRoots.add(root);
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
  const env = opts.env ?? process.env;
  const raw = configPath
    ? JSON.parse(readFileSync(configPath, 'utf8')) as unknown
    : {};
  const resolved = resolveEnvRefs(raw, env);
  const parsed = parsePaperClawConfig(resolved);
  return applyEnvOverrides(parsed, env);
}

export function findConfigFile(repoRoot = getRepoRoot()): string | null {
  const candidates = [
    join(repoRoot, 'paperclaw.config.json'),
    join(repoRoot, 'config', 'paperclaw.json'),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

interface ProviderEnvProfile {
  provider: ProviderName;
  providerConfigKey: keyof ProvidersConfig;
  apiBase?: string;
  defaultModel?: string;
  apiKeyEnv: readonly string[];
  apiBaseEnv: readonly string[];
  modelEnv: readonly string[];
}

const PROVIDER_ENV_PROFILES = {
  deepseek: {
    provider: 'deepseek',
    providerConfigKey: 'deepseek',
    apiBase: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    apiKeyEnv: ['DEEPSEEK_API_KEY'],
    apiBaseEnv: ['DEEPSEEK_API_BASE', 'DEEPSEEK_BASE_URL'],
    modelEnv: ['DEEPSEEK_MODEL'],
  },
  openai: {
    provider: 'openai-compatible',
    providerConfigKey: 'openaiCompatible',
    apiBase: 'https://api.openai.com',
    defaultModel: 'gpt-4o-mini',
    apiKeyEnv: ['OPENAI_API_KEY'],
    apiBaseEnv: ['OPENAI_API_BASE', 'OPENAI_BASE_URL'],
    modelEnv: ['OPENAI_MODEL'],
  },
  openrouter: {
    provider: 'openai-compatible',
    providerConfigKey: 'openaiCompatible',
    apiBase: 'https://openrouter.ai/api',
    defaultModel: 'openai/gpt-4o-mini',
    apiKeyEnv: ['OPENROUTER_API_KEY'],
    apiBaseEnv: ['OPENROUTER_API_BASE', 'OPENROUTER_BASE_URL'],
    modelEnv: ['OPENROUTER_MODEL'],
  },
  moonshot: {
    provider: 'openai-compatible',
    providerConfigKey: 'openaiCompatible',
    apiBase: 'https://api.moonshot.cn',
    defaultModel: 'moonshot-v1-8k',
    apiKeyEnv: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    apiBaseEnv: ['MOONSHOT_API_BASE', 'MOONSHOT_BASE_URL', 'KIMI_API_BASE', 'KIMI_BASE_URL'],
    modelEnv: ['MOONSHOT_MODEL', 'KIMI_MODEL'],
  },
  dashscope: {
    provider: 'openai-compatible',
    providerConfigKey: 'openaiCompatible',
    apiBase: 'https://dashscope.aliyuncs.com/compatible-mode',
    defaultModel: 'qwen-plus',
    apiKeyEnv: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
    apiBaseEnv: ['DASHSCOPE_API_BASE', 'DASHSCOPE_BASE_URL', 'QWEN_API_BASE', 'QWEN_BASE_URL'],
    modelEnv: ['DASHSCOPE_MODEL', 'QWEN_MODEL'],
  },
  siliconflow: {
    provider: 'openai-compatible',
    providerConfigKey: 'openaiCompatible',
    apiBase: 'https://api.siliconflow.cn',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    apiKeyEnv: ['SILICONFLOW_API_KEY'],
    apiBaseEnv: ['SILICONFLOW_API_BASE', 'SILICONFLOW_BASE_URL'],
    modelEnv: ['SILICONFLOW_MODEL'],
  },
  'openai-compatible': {
    provider: 'openai-compatible',
    providerConfigKey: 'openaiCompatible',
    apiKeyEnv: [],
    apiBaseEnv: [],
    modelEnv: [],
  },
  custom: {
    provider: 'custom',
    providerConfigKey: 'custom',
    apiKeyEnv: ['CUSTOM_API_KEY'],
    apiBaseEnv: ['CUSTOM_API_BASE', 'CUSTOM_BASE_URL'],
    modelEnv: ['CUSTOM_MODEL'],
  },
} as const satisfies Record<string, ProviderEnvProfile>;

type ProviderEnvAlias = keyof typeof PROVIDER_ENV_PROFILES;

function applyEnvOverrides(config: PaperClawConfig, env: NodeJS.ProcessEnv): PaperClawConfig {
  const overrides: Record<string, unknown> = {};
  const providerAlias = normalizeProviderAlias(envValue(env, 'PAPERCLAW_PROVIDER'));
  const profile: ProviderEnvProfile | undefined = providerAlias
    ? PROVIDER_ENV_PROFILES[providerAlias]
    : undefined;

  if (profile) {
    const providerConfig: Record<string, unknown> = {};
    const apiKey = envValue(env, 'PAPERCLAW_API_KEY') ?? envValue(env, ...profile.apiKeyEnv);
    const apiBase = envValue(env, 'PAPERCLAW_API_BASE', 'PAPERCLAW_BASE_URL')
      ?? envValue(env, ...profile.apiBaseEnv)
      ?? profile.apiBase;
    const model = envValue(env, 'PAPERCLAW_MODEL')
      ?? envValue(env, ...profile.modelEnv)
      ?? profile.defaultModel;
    const hasConfiguredModel = Boolean(config.providers[profile.providerConfigKey].model)
      || config.agents.defaults.model !== DEFAULT_AGENTS_CONFIG.defaults.model;

    if (!model && !hasConfiguredModel) {
      throw new Error(`PAPERCLAW_MODEL is required when PAPERCLAW_PROVIDER=${providerAlias}`);
    }

    if (apiKey) providerConfig.apiKey = apiKey;
    if (apiBase) providerConfig.apiBase = apiBase;
    if (model) providerConfig.model = model;

    setNested(overrides, ['agents', 'defaults', 'provider'], profile.provider);
    if (model) setNested(overrides, ['agents', 'defaults', 'model'], model);
    setNested(overrides, ['providers', profile.providerConfigKey], providerConfig);
  } else {
    const deepseekConfig: Record<string, unknown> = {};
    const apiKey = envValue(env, 'DEEPSEEK_API_KEY');
    const apiBase = envValue(env, 'DEEPSEEK_API_BASE', 'DEEPSEEK_BASE_URL');
    const model = envValue(env, 'PAPERCLAW_MODEL', 'DEEPSEEK_MODEL');

    if (apiKey) deepseekConfig.apiKey = apiKey;
    if (apiBase) deepseekConfig.apiBase = apiBase;
    if (model) {
      deepseekConfig.model = model;
      setNested(overrides, ['agents', 'defaults', 'model'], model);
    }
    if (Object.keys(deepseekConfig).length > 0) {
      setNested(overrides, ['providers', 'deepseek'], deepseekConfig);
    }
  }

  setNumberOverride(overrides, env, 'PAPERCLAW_MAX_TOKENS', ['agents', 'defaults', 'maxTokens'], positiveInteger);
  setNumberOverride(
    overrides,
    env,
    'PAPERCLAW_CONTEXT_WINDOW_TOKENS',
    ['agents', 'defaults', 'contextWindowTokens'],
    positiveInteger,
  );
  setNumberOverride(
    overrides,
    env,
    'PAPERCLAW_MAX_TOOL_ITERATIONS',
    ['agents', 'defaults', 'maxToolIterations'],
    positiveInteger,
  );
  setNumberOverride(
    overrides,
    env,
    'PAPERCLAW_TEMPERATURE',
    ['agents', 'defaults', 'temperature'],
    temperature,
  );

  if (Object.keys(overrides).length === 0) return config;
  return parsePaperClawConfig(mergeConfig(config, overrides));
}

function normalizeProviderAlias(value: string | undefined): ProviderEnvAlias | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replaceAll('_', '-');
  const alias = normalized === 'qwen'
    ? 'dashscope'
    : normalized === 'kimi'
      ? 'moonshot'
      : normalized;
  if (alias in PROVIDER_ENV_PROFILES) return alias as ProviderEnvAlias;
  throw new Error(
    `PAPERCLAW_PROVIDER must be one of: ${Object.keys(PROVIDER_ENV_PROFILES).join(', ')}`,
  );
}

function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function setNumberOverride(
  target: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  name: string,
  path: string[],
  parse: (name: string, value: string) => number,
): void {
  const raw = envValue(env, name);
  if (raw === undefined) return;
  setNested(target, path, parse(name, raw));
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function temperature(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    throw new Error(`${name} must be a number between 0 and 2`);
  }
  return parsed;
}

function setNested(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor = target;
  for (const key of path.slice(0, -1)) {
    const existing = cursor[key];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1] as string] = value;
}
