import type { ChatOpts, ChatResponse, LLMClient } from '../../packages/core/src/index.js';

export class MockLLM implements LLMClient {
  readonly id = 'mock/llm';
  private queue: ChatResponse[] = [];
  receivedToolCount: number[] = [];
  receivedMessageRoles: string[][] = [];

  enqueue(...responses: ChatResponse[]): void {
    this.queue.push(...responses);
  }

  async chat(opts: ChatOpts): Promise<ChatResponse> {
    this.receivedToolCount.push(opts.tools?.length ?? 0);
    this.receivedMessageRoles.push(opts.messages.map((m) => m.role));
    const next = this.queue.shift();
    if (!next) throw new Error('MockLLM: queue empty');
    return next;
  }
}
