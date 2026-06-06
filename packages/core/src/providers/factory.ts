import { DeepSeekClient } from './deepseek.js';
import { OpenAICompatibleClient } from './openai-compatible.js';
import type { LLMClient, ProviderRuntimeOpts } from './base.js';
import type { AgentDefaultsConfig, AgentsConfig, ModelPresetConfig } from '../agent/config.js';
import type { PaperClawConfig } from '../config/schema.js';
import type { ProviderConfig, ProviderName, ProvidersConfig } from './config.js';

export type Provider = ProviderName;

export interface CreateClientOpts extends ProviderRuntimeOpts {
  provider?: Provider;
  apiKey?: string;
  apiBase?: string;
  model?: string;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

/**
 * Default provider factory. W1 supports DeepSeek only; Anthropic backend is on
 * the roadmap (design.md §5.2 — "对照实验"), but not implemented yet.
 */
export function createLLMClient(opts: CreateClientOpts = {}): LLMClient {
  const provider = opts.provider ?? 'deepseek';
  if (provider === 'deepseek') {
    const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY missing — set it in .env or pass apiKey');
    }
    return new DeepSeekClient({
      apiKey,
      model: opts.model,
      baseUrl: opts.apiBase,
      timeoutMs: opts.timeoutMs,
      retry: opts.retry,
    });
  }
  if (provider === 'custom' || provider === 'openai-compatible') {
    if (!opts.apiBase) {
      throw new Error(`${provider} provider requires apiBase`);
    }
    if (!opts.model) {
      throw new Error(`${provider} provider requires model`);
    }
    return new OpenAICompatibleClient({
      providerName: provider,
      apiKey: opts.apiKey,
      model: opts.model,
      baseUrl: opts.apiBase,
      extraHeaders: opts.extraHeaders,
      extraBody: opts.extraBody,
      timeoutMs: opts.timeoutMs,
      retry: opts.retry,
    });
  }
  throw new Error(`Unknown provider: ${provider}`);
}

export interface ProviderSnapshot {
  client: LLMClient;
  provider: ProviderName;
  model: string;
  contextWindowTokens: number;
  signature: readonly unknown[];
}

export function createLLMClientFromConfig(config: PaperClawConfig): LLMClient {
  return buildProviderSnapshot(config).client;
}

export function buildProviderSnapshot(config: PaperClawConfig): ProviderSnapshot {
  const preset = resolveModelPreset(config.agents);
  const providerConfig = providerConfigFor(config.providers, preset.provider);
  const client = createLLMClient({
    provider: preset.provider,
    apiKey: providerConfig.apiKey,
    apiBase: providerConfig.apiBase,
    model: providerConfig.model ?? preset.model,
    extraHeaders: providerConfig.extraHeaders,
    extraBody: providerConfig.extraBody,
  });
  return {
    client,
    provider: preset.provider,
    model: providerConfig.model ?? preset.model,
    contextWindowTokens: preset.contextWindowTokens,
    signature: providerSignature(preset, providerConfig),
  };
}

export function resolveModelPreset(agents: AgentsConfig): ModelPresetConfig {
  const selected = agents.defaults.modelPreset;
  if (selected) {
    const preset = agents.presets[selected];
    if (!preset) throw new Error(`Unknown model preset: ${selected}`);
    return preset;
  }
  return defaultsAsPreset(agents.defaults);
}

export function providerConfigFor(providers: ProvidersConfig, provider: ProviderName): ProviderConfig {
  if (provider === 'deepseek') return providers.deepseek;
  if (provider === 'custom') return providers.custom;
  return providers.openaiCompatible;
}

function defaultsAsPreset(defaults: AgentDefaultsConfig): ModelPresetConfig {
  return {
    provider: defaults.provider,
    model: defaults.model,
    maxTokens: defaults.maxTokens,
    contextWindowTokens: defaults.contextWindowTokens,
    temperature: defaults.temperature,
  };
}

function providerSignature(preset: ModelPresetConfig, provider: ProviderConfig): readonly unknown[] {
  return [
    preset.provider,
    provider.model ?? preset.model,
    provider.apiKey ?? null,
    provider.apiBase ?? null,
    provider.extraHeaders ?? null,
    provider.extraBody ?? null,
    preset.maxTokens,
    preset.contextWindowTokens,
    preset.temperature,
  ];
}
