/**
 * Vendor-neutral LLM types. The `LLMClient.chat` shape mirrors the design doc
 * §5.2 — text + (optional) tool calls + token usage.
 *
 * For W1 we only use `text` (with `response_format: json_object`); tool-call
 * support is wired through but not yet exercised by the search module.
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
  usage: { input: number; output: number };
}

export interface LLMClient {
  /** identifier shown in trace events: e.g. "deepseek/deepseek-chat" */
  readonly id: string;
  chat(opts: ChatOpts): Promise<ChatResponse>;
}
