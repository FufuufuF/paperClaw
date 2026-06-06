import { OpenAICompatibleClient } from './openai-compatible.js';
import type { ChatOpts, ChatResponse, LLMClient, ProviderRuntimeOpts } from './base.js';

export interface DeepSeekOpts extends ProviderRuntimeOpts {
  apiKey: string;
  /** default deepseek-chat (V3); deepseek-reasoner is overkill for triage */
  model?: string;
  baseUrl?: string;
}

/**
 * DeepSeek client — speaks the OpenAI-compatible REST shape. We default to
 * `deepseek-chat` because triage / planning are price-sensitive (AC7: < ¥1
 * per query flow).
 */
export class DeepSeekClient implements LLMClient {
  readonly id: string;
  private readonly inner: OpenAICompatibleClient;

  constructor(opts: DeepSeekOpts) {
    const model = opts.model ?? 'deepseek-chat';
    this.inner = new OpenAICompatibleClient({
      providerName: 'deepseek',
      apiKey: opts.apiKey,
      model,
      baseUrl: opts.baseUrl ?? 'https://api.deepseek.com',
      timeoutMs: opts.timeoutMs,
      retry: opts.retry,
    });
    this.id = this.inner.id;
  }

  async chat(opts: ChatOpts): Promise<ChatResponse> {
    return await this.inner.chat(opts);
  }
}
