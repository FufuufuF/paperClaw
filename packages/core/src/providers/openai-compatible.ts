import { withRetry } from '../utils/retry.js';
import type { ChatMessage, ChatOpts, ChatResponse, LLMClient, ProviderRuntimeOpts, ToolCall } from './base.js';

export interface OpenAICompatibleOpts extends ProviderRuntimeOpts {
  providerName: string;
  apiKey?: string;
  model: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OAIChatResponse {
  choices?: Array<{
    message?: {
      role?: 'assistant';
      content?: string | null;
      tool_calls?: OAIToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatibleClient implements LLMClient {
  readonly id: string;
  private readonly providerName: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly extraBody: Record<string, unknown>;
  private readonly timeoutMs: number;
  private readonly retry: Required<NonNullable<ProviderRuntimeOpts['retry']>>;

  constructor(opts: OpenAICompatibleOpts) {
    this.providerName = opts.providerName;
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = stripTrailingSlash(opts.baseUrl);
    this.extraHeaders = opts.extraHeaders ?? {};
    this.extraBody = opts.extraBody ?? {};
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.retry = {
      tries: opts.retry?.tries ?? 3,
      baseMs: opts.retry?.baseMs ?? 800,
    };
    this.id = `${this.providerName}/${this.model}`;
  }

  async chat(opts: ChatOpts): Promise<ChatResponse> {
    const body = this.buildBody(opts);
    const data = await withRetry(
      () => this.request(body),
      this.retry,
    );
    return parseOpenAIChatResponse(data, this.providerName);
  }

  buildBody(opts: ChatOpts): Record<string, unknown> {
    const messages = opts.system
      ? [{ role: 'system' as const, content: opts.system }, ...opts.messages]
      : opts.messages;

    const body: Record<string, unknown> = {
      ...this.extraBody,
      model: this.model,
      messages: messages.map(toOpenAIMessage),
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
    return body;
  }

  private async request(body: Record<string, unknown>): Promise<OAIChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text();
        const err = new Error(`${this.providerName} ${res.status}: ${txt.slice(0, 300)}`);
        (err as Error & { transient?: boolean }).transient = isTransientStatus(res.status);
        throw err;
      }
      return (await res.json()) as OAIChatResponse;
    } catch (err) {
      if (isAbortError(err)) {
        const timeout = new Error(`${this.providerName}: request timed out after ${this.timeoutMs}ms`);
        (timeout as Error & { transient?: boolean }).transient = true;
        throw timeout;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...this.extraHeaders,
    };
  }
}

export function parseOpenAIChatResponse(data: OAIChatResponse, providerName: string): ChatResponse {
  const choice = data.choices?.[0];
  if (!choice?.message) throw new Error(`${providerName}: empty choices`);
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

function toOpenAIMessage(message: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.tool_call_id) out.tool_call_id = message.tool_call_id;
  if (message.tool_calls) {
    out.tool_calls = message.tool_calls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return out;
}

function stripTrailingSlash(input: string): string {
  return input.replace(/\/+$/, '');
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
