import { DeepSeekClient } from './deepseek.js';
import type { LLMClient } from './types.js';

export type Provider = 'deepseek';

export interface CreateClientOpts {
  provider?: Provider;
  apiKey?: string;
  model?: string;
}

/**
 * Default client factory. W1 supports DeepSeek only; Anthropic backend is on
 * the roadmap (design.md §5.2 — "对照实验"), but not in plan-search-module.
 */
export function createLLMClient(opts: CreateClientOpts = {}): LLMClient {
  const provider = opts.provider ?? 'deepseek';
  if (provider === 'deepseek') {
    const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY missing — set it in .env or pass apiKey');
    }
    return new DeepSeekClient({ apiKey, model: opts.model });
  }
  throw new Error(`Unknown provider: ${provider}`);
}
