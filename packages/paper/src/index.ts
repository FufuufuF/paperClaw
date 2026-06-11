import { fileURLToPath } from 'node:url';
import type { LLMClient, Tool, TraceBus } from '@paperclaw/core';
import { createPaperKnowledgeTools } from './knowledge/index.js';
import { createPaperFileTools, createReaderTools } from './read/index.js';
import { createPaperSearchTools, PaperSearchState } from './search/index.js';

export const PAPER_SKILLS_DIR = fileURLToPath(new URL('.', import.meta.url));

export * from './knowledge/index.js';
export * from './read/index.js';
export * from './search/index.js';
export * from './shared/index.js';

export interface PaperToolsOpts {
  llm: LLMClient;
  outputDir: string;
  profilePath?: string;
  trace?: TraceBus;
  state?: PaperSearchState;
}

export function createPaperTools(opts: PaperToolsOpts): Tool[] {
  return [
    ...createPaperFileTools(),
    ...createPaperKnowledgeTools({ llm: opts.llm }),
    ...createPaperSearchTools(opts),
    ...createReaderTools(opts),
  ];
}
