import type { TriageVerdict } from './tools/triage.js';

/**
 * Final user-facing shortlist row. Matches plan AC1 + design.md §2.1 output:
 *  arxiv_id / title / verdict / reason / summary
 *
 * `authors` and `year` are kept (not required by AC) because the CLI prints
 * them and downstream consumers find them useful.
 */
export interface ShortlistEntry {
  arxiv_id: string;
  title: string;
  authors: string[];
  year: number;
  verdict: TriageVerdict;
  reason: string;
  summary: string;
  /** the search term that surfaced this paper (debug aid + UI grouping) */
  matched_term: string;
}
