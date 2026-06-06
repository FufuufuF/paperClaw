/**
 * Vendor-neutral LLM provider types. 对齐 nanobot 的 `providers/base.py`.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** when role === 'tool', the tool_call_id this message is responding to */
  tool_call_id?: string;
  /** when role === 'assistant' and the model emitted tool calls */
  tool_calls?: ToolCall[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments object */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** raw JSON string of arguments (per OpenAI / DeepSeek convention) */
  arguments: string;
}

export interface ChatOpts {
  messages: ChatMessage[];
  system?: string;
  tools?: ToolDef[];
  /** force JSON object response (DeepSeek + OpenAI both support) */
  responseFormat?: 'text' | 'json_object';
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  text?: string;
  toolCalls?: ToolCall[];
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error' | string;
  usage: { input: number; output: number };
}

export interface LLMClient {
  /** identifier shown in trace events: e.g. "deepseek/deepseek-chat" */
  readonly id: string;
  chat(opts: ChatOpts): Promise<ChatResponse>;
}

export interface ProviderRuntimeOpts {
  timeoutMs?: number;
  retry?: {
    tries?: number;
    baseMs?: number;
  };
}
