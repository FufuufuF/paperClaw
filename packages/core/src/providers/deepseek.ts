import { withRetry } from '../utils/retry.js';
import type { ChatOpts, ChatResponse, LLMClient, ToolCall } from './base.js';

export interface DeepSeekOpts {
  apiKey: string;
  /** default deepseek-chat (V3); deepseek-reasoner is overkill for triage */
  model?: string;
  baseUrl?: string;
}

interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OAIChatResponse {
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * DeepSeek client — speaks the OpenAI-compatible REST shape. We default to
 * `deepseek-chat` because triage / planning are price-sensitive (AC7: < ¥1
 * per query flow).
 */
export class DeepSeekClient implements LLMClient {
  readonly id: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: DeepSeekOpts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'deepseek-chat';
    this.baseUrl = opts.baseUrl ?? 'https://api.deepseek.com';
    this.id = `deepseek/${this.model}`;
  }

  async chat(opts: ChatOpts): Promise<ChatResponse> {
    const messages = opts.system
      ? [{ role: 'system' as const, content: opts.system }, ...opts.messages]
      : opts.messages;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => {
        const out: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        if (m.tool_calls) {
          out.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        return out;
      }),
      temperature: opts.temperature ?? 0.3,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.responseFormat === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const data = await withRetry(
      async () => {
        const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const txt = await res.text();
          // 5xx and 429 are retryable; the rest are caller bugs (bubble up)
          const transient = res.status >= 500 || res.status === 429;
          const err = new Error(`DeepSeek ${res.status}: ${txt.slice(0, 300)}`);
          (err as Error & { transient?: boolean }).transient = transient;
          throw err;
        }
        return (await res.json()) as OAIChatResponse;
      },
      { tries: 3, baseMs: 800 },
    );

    const choice = data.choices?.[0];
    if (!choice) throw new Error('DeepSeek: empty choices');
    const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));
    return {
      text: choice.message.content ?? undefined,
      toolCalls,
      usage: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}
