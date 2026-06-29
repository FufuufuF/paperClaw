import {
  DEFAULT_CONFIG,
  DEFAULT_AGENTS_CONFIG,
  loadConfig,
  parsePaperClawConfig,
  resolveEnvRefs,
} from '../../packages/core/src/index.js';
import { assert, withTempDir } from '../fixtures/index.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function testDefaults(): Promise<void> {
  const cfg = parsePaperClawConfig();
  assert(cfg.version === 1, 'default config version');
  assert(cfg.agents.defaults.provider === 'deepseek', 'default provider');
  assert(cfg.agents.defaults.botName === DEFAULT_AGENTS_CONFIG.defaults.botName, 'agent defaults come from agent module');
  assert(cfg.session.dir === DEFAULT_CONFIG.session.dir, 'session defaults merged');
}

async function testMergeAndValidate(): Promise<void> {
  const cfg = parsePaperClawConfig({
    agents: {
      defaults: {
        maxToolIterations: 12,
        temperature: 0.1,
      },
      presets: {
        cheap: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          maxTokens: 1024,
          contextWindowTokens: 8000,
          temperature: 0.2,
        },
      },
    },
  });
  assert(cfg.agents.defaults.maxToolIterations === 12, 'nested defaults override');
  assert(cfg.agents.defaults.model === 'deepseek-chat', 'nested defaults keep omitted values');
  assert(cfg.agents.presets.cheap?.maxTokens === 1024, 'preset parsed');
  assert(cfg.tools.maxResultChars === DEFAULT_CONFIG.tools.maxResultChars, 'tools defaults merged');
}

async function testEnvResolution(): Promise<void> {
  const resolved = resolveEnvRefs(
    { providers: { deepseek: { apiKey: '${TEST_DEEPSEEK_KEY}' } } },
    { TEST_DEEPSEEK_KEY: 'sk-test' },
  );
  assert(resolved.providers.deepseek.apiKey === 'sk-test', 'env ref resolved');

  let failed = false;
  try {
    resolveEnvRefs('${MISSING_TEST_KEY}', {});
  } catch {
    failed = true;
  }
  assert(failed, 'missing env ref fails fast');
}

async function testLoadConfig(): Promise<void> {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, '.env'), 'TEST_CONFIG_KEY=sk-from-env\n', 'utf8');
    await mkdir(join(dir, 'config'));
    await writeFile(
      join(dir, 'config', 'paperclaw.json'),
      JSON.stringify({
        providers: { deepseek: { apiKey: '${TEST_CONFIG_KEY}' } },
        agents: { defaults: { maxToolIterations: 9 } },
      }),
      'utf8',
    );

    const cfg = loadConfig({ repoRoot: dir });
    assert(cfg.providers.deepseek.apiKey === 'sk-from-env', 'loadConfig reads .env refs');
    assert(cfg.agents.defaults.maxToolIterations === 9, 'loadConfig merges file config');
  });
}

async function testEnvProviderOverrides(): Promise<void> {
  await withTempDir(async (dir) => {
    const cfg = loadConfig({
      repoRoot: dir,
      env: {
        PAPERCLAW_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-openai',
        PAPERCLAW_MODEL: 'gpt-test',
        PAPERCLAW_CONTEXT_WINDOW_TOKENS: '128000',
        PAPERCLAW_MAX_TOKENS: '4096',
        PAPERCLAW_TEMPERATURE: '0.1',
      },
    });

    assert(cfg.agents.defaults.provider === 'openai-compatible', 'openai env alias selects OpenAI-compatible provider');
    assert(cfg.agents.defaults.model === 'gpt-test', 'env model overrides agent default');
    assert(cfg.providers.openaiCompatible.apiKey === 'sk-openai', 'openai api key alias is read');
    assert(cfg.providers.openaiCompatible.apiBase === 'https://api.openai.com', 'openai api base default is set');
    assert(cfg.providers.openaiCompatible.model === 'gpt-test', 'provider model follows env model');
    assert(cfg.agents.defaults.contextWindowTokens === 128000, 'context window env override parsed');
    assert(cfg.agents.defaults.maxTokens === 4096, 'max tokens env override parsed');
    assert(cfg.agents.defaults.temperature === 0.1, 'temperature env override parsed');
  });
}

async function testDeepSeekEnvCompatibility(): Promise<void> {
  await withTempDir(async (dir) => {
    const cfg = loadConfig({
      repoRoot: dir,
      env: {
        DEEPSEEK_API_KEY: 'sk-deepseek',
        DEEPSEEK_MODEL: 'deepseek-reasoner',
      },
    });

    assert(cfg.agents.defaults.provider === 'deepseek', 'deepseek remains the default provider');
    assert(cfg.agents.defaults.model === 'deepseek-reasoner', 'deepseek model env alias is read');
    assert(cfg.providers.deepseek.apiKey === 'sk-deepseek', 'deepseek api key remains compatible');
    assert(cfg.providers.deepseek.model === 'deepseek-reasoner', 'deepseek provider model is set');
  });
}

async function main(): Promise<void> {
  await testDefaults();
  await testMergeAndValidate();
  await testEnvResolution();
  await testLoadConfig();
  await testEnvProviderOverrides();
  await testDeepSeekEnvCompatibility();
  console.log('✓ config schema tests passed.');
}

void main();
