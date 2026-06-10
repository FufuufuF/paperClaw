import { fileURLToPath } from 'node:url';

export const KNOWLEDGE_SKILLS_DIR = fileURLToPath(new URL('./skills', import.meta.url));

export * from './types.js';
export {
  KnowledgeGraphStore,
  type KnowledgeGraphStoreOpts,
  type NeighborInput,
  type PendingLinkInput,
  type RenameNodeInput,
  type SearchLinksInput,
  type SearchNodeResult,
  type SearchNodesInput,
  type SuggestLinksInput,
  type UpdateLinkInput,
  type UpsertLinkInput,
  type UpsertNodeInput,
} from './graph-store.js';
export {
  createKnowledgeGraphTools,
  type KnowledgeGraphToolsOpts,
} from './knowledge-tools.js';
