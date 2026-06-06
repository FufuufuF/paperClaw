import {
  buildProviderSnapshot,
  createLLMClient,
  createLLMClientFromConfig,
  DEFAULT_CONFIG,
  OpenAICompatibleClient,
  parseOpenAIChatResponse,
  parsePaperClawConfig,
  resolveModelPreset,
} from '../../packages/core/src/index.js';
import { assert } from '../fixtures/index.js';

async function testOpenAICompatibleBody(): Promise<void> {
  const client = new OpenAICompatibleClient({
    providerName: 'custom',
    apiKey: 'sk-test',
    model: 'test-model',
    baseUrl: 'http://localhost:1234/',
    extraBody: { top_p: 0.9 },
  });
  const body = client.buildBody({
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    responseFormat: 'json_object',
    tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object' } }],
  });
  assert(body.model === 'test-model', 'body includes model');
  assert(body.top_p === 0.9, 'body merges extraBody');
  assert(Array.isArray(body.messages), 'body includes messages');
  assert((body.messages as Array<{ role: string }>)[0]?.role === 'system', 'system message is prepended');
  assert(Array.isArray(body.tools), 'body includes OpenAI tool definitions');
  assert(JSON.stringify(body.response_format).includes('json_object'), 'json response format set');
}

async function testParseOpenAIResponse(): Promise<void> {
  const parsed = parseOpenAIChatResponse({
    choices: [{
      message: {
        content: 'done',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hi"}' },
        }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  }, 'custom');
  assert(parsed.text === 'done', 'response text parsed');
  assert(parsed.toolCalls?.[0]?.name === 'echo', 'tool call parsed');
  assert(parsed.usage.input === 10 && parsed.usage.output === 2, 'usage parsed');
}

async function testFactoryDefaults(): Promise<void> {
  const client = createLLMClient({
    provider: 'custom',
    apiBase: 'http://localhost:9999',
    model: 'local-model',
  });
  assert(client.id === 'custom/local-model', 'custom provider id');

  let failed = false;
  try {
    createLLMClient({ provider: 'custom', model: 'missing-base' });
  } catch {
    failed = true;
  }
  assert(failed, 'custom provider requires apiBase');
}

async function testConfigFactory(): Promise<void> {
  const cfg = parsePaperClawConfig({
    agents: {
      defaults: {
        provider: 'custom',
        model: 'default-model',
        modelPreset: 'local',
      },
      presets: {
        local: {
          provider: 'custom',
          model: 'preset-model',
          maxTokens: 2048,
          contextWindowTokens: 12000,
          temperature: 0.2,
        },
      },
    },
    providers: {
      custom: {
        apiBase: 'http://localhost:4321',
        apiKey: 'sk-local',
        model: 'provider-model',
      },
    },
  });
  const preset = resolveModelPreset(cfg.agents);
  assert(preset.model === 'preset-model', 'model preset resolved');

  const snapshot = buildProviderSnapshot(cfg);
  assert(snapshot.client.id === 'custom/provider-model', 'provider config model override applied');
  assert(snapshot.contextWindowTokens === 12000, 'snapshot context window comes from preset');

  const client = createLLMClientFromConfig(cfg);
  assert(client.id === snapshot.client.id, 'config factory returns snapshot client');
}

async function testDefaultConfigStillDeepSeek(): Promise<void> {
  const cfg = parsePaperClawConfig({
    providers: { deepseek: { apiKey: 'sk-test' } },
  });
  const snapshot = buildProviderSnapshot(cfg);
  assert(snapshot.client.id === `deepseek/${DEFAULT_CONFIG.agents.defaults.model}`, 'default config builds deepseek');
}

async function main(): Promise<void> {
  await testOpenAICompatibleBody();
  await testParseOpenAIResponse();
  await testFactoryDefaults();
  await testConfigFactory();
  await testDefaultConfigStillDeepSeek();
  console.log('✓ provider tests passed.');
}

void main();
