export type PaperStatus = 'unread' | 'reading' | 'read' | 'skipped';

export interface PaperKnowledgeIndex {
  version: 2;
  updated_at: string;
  papers: Record<string, PaperNode>;
  links: PaperLink[];
}

export interface PaperNode {
  id: string;
  title: string;
  summary_short?: string;
  note_path: string;
  arxiv_id?: string;
  status: PaperStatus;
  key_terms: string[];
  updated_at: string;
}

export interface PaperLink {
  id: string;
  paper_ids: [string, string];
  reason: string;
  shared_terms: string[];
  evidence: PaperEvidencePointer[];
  created_at: string;
  updated_at: string;
}

export interface PaperEvidencePointer {
  paper_id: string;
  note_path?: string;
  section?: string;
}

export interface KeyTermVocabulary {
  version: 1;
  terms: Array<{
    id: string;
    label: string;
    description: string;
  }>;
}

export interface PaperNeighbor {
  paper_id: string;
  title: string;
  arxiv_id?: string;
  summary_short?: string;
  link_id: string;
  reason: string;
  shared_terms: string[];
}

export interface PaperStoreWriteResult {
  path: string;
  backupPath?: string;
  bytes: number;
}

export interface PaperRelationPreview {
  paper_id: string;
  title: string;
  summary_short?: string;
  matched_key_terms: string[];
  existing_link_reason?: string;
  short_explanation: string;
}
