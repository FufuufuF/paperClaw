import { fileURLToPath } from 'node:url';

export const KNOWLEDGE_SKILLS_DIR = fileURLToPath(new URL('./skills', import.meta.url));

export * from './types.js';
export {
  PaperKnowledgeStore,
  readKeyTermVocabulary,
  type ConsolidatePaperInput,
  type ConsolidatePaperResult,
  type NeighborInput,
  type PaperKnowledgeStoreOpts,
  type PreviewSectionRelationsInput,
  type PreviewSectionRelationsResult,
  type RecentNodesInput,
  type RenameNodeInput,
  type SearchLinksInput,
  type SearchNodeResult,
  type SearchNodesInput,
  type UpdateLinkInput,
  type UpsertLinkInput,
  type UpsertNodeInput,
} from './graph-store.js';
export {
  createPaperKnowledgeTools,
  type PaperKnowledgeToolsOpts,
} from './knowledge-tools.js';
