import { assertOptionalString, asRecord } from '../config/validation.js';

export type ProviderName = 'deepseek' | 'custom' | 'openai-compatible';

export interface ProviderConfig {
  apiKey?: string;
  apiBase?: string;
  model?: string;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

export interface ProvidersConfig {
  deepseek: ProviderConfig;
  custom: ProviderConfig;
  openaiCompatible: ProviderConfig;
}

export const DEFAULT_PROVIDERS_CONFIG: ProvidersConfig = {
  deepseek: {
    apiBase: 'https://api.deepseek.com',
  },
  custom: {},
  openaiCompatible: {},
};

export function parseProvidersConfig(value: unknown, path = 'providers'): ProvidersConfig {
  const cfg = asRecord(value, path) as unknown as ProvidersConfig;
  validateProviderConfig(cfg.deepseek, `${path}.deepseek`);
  validateProviderConfig(cfg.custom, `${path}.custom`);
  validateProviderConfig(cfg.openaiCompatible, `${path}.openaiCompatible`);
  return cfg;
}

export function assertProviderName(value: unknown, path: string): asserts value is ProviderName {
  if (value !== 'deepseek' && value !== 'custom' && value !== 'openai-compatible') {
    throw new Error(`${path} must be one of: deepseek, custom, openai-compatible`);
  }
}

function validateProviderConfig(provider: ProviderConfig, path: string): void {
  asRecord(provider, path);
  assertOptionalString(provider.apiKey, `${path}.apiKey`);
  assertOptionalString(provider.apiBase, `${path}.apiBase`);
  assertOptionalString(provider.model, `${path}.model`);
  if (provider.extraHeaders !== undefined) asRecord(provider.extraHeaders, `${path}.extraHeaders`);
  if (provider.extraBody !== undefined) asRecord(provider.extraBody, `${path}.extraBody`);
}
