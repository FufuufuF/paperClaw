import { fileURLToPath } from 'node:url';

export const PAPER_SEARCH_SKILLS_DIR = fileURLToPath(new URL('./skills', import.meta.url));

export { searchArxiv, type ArxivCandidate } from './tools/arxiv.js';
export { triageBatch, type TriageItem, type TriageVerdict } from './tools/triage.js';
export { downloadPdf, downloadPdfs, type DownloadResult } from './tools/download.js';
export { decomposeQuery, decideReplan, inferInterestForCron } from './flows/planner.js';
export {
  buildKnowledgeSearchContext,
  createDownloadPaperTool,
  createPaperSearchTool,
  createPaperSearchTools,
  PaperSearchState,
  type KnowledgeSearchContext,
  type PaperSearchResult,
  type PaperSearchSource,
  type PaperSearchToolOpts,
  type SearchTrace,
  type ShortlistItem,
} from './paper-search-tool.js';
