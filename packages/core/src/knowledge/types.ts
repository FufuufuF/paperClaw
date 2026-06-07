export type KnowledgePaperStatus = 'unread' | 'reading' | 'read' | 'skipped';
export type KnowledgePaperVerdict = 'adopt' | 'maybe' | 'skip' | 'unknown';

export type KnowledgeLinkType =
  | 'extends'
  | 'contrasts'
  | 'supports'
  | 'challenges'
  | 'complements'
  | 'uses_same'
  | 'applies_to'
  | 'precedes'
  | 'replaces';

export type KnowledgeCreatedBy = 'agent' | 'user' | 'import' | 'system';
export type PendingLinkStatus = 'pending_user_review' | 'committed' | 'rejected';

export interface KnowledgePaperNode {
  id: string;
  title: string;
  note_path: string;
  arxiv_id?: string;
  status: KnowledgePaperStatus;
  verdict: KnowledgePaperVerdict;
  updated_at: string;
}

export interface KnowledgeEvidencePointer {
  paper_id: string;
  note_path?: string;
  section?: string;
}

export interface KnowledgeLink {
  id: string;
  source: string;
  target: string;
  type: KnowledgeLinkType;
  directional: boolean;
  reason_short: string;
  reason?: string;
  evidence: KnowledgeEvidencePointer[];
  confidence: number;
  created_by: KnowledgeCreatedBy;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeOpenQuestion {
  id: string;
  question: string;
  related_papers: string[];
  status: 'open' | 'closed';
  created_at: string;
}

export interface KnowledgePendingLink extends Omit<KnowledgeLink, 'id' | 'updated_at'> {
  id: string;
  status: PendingLinkStatus;
  updated_at: string;
}

export interface KnowledgeIndex {
  version: 1;
  updated_at: string;
  papers: Record<string, KnowledgePaperNode>;
  links: KnowledgeLink[];
  open_questions: KnowledgeOpenQuestion[];
  pending_links: KnowledgePendingLink[];
}

export interface KnowledgeNeighbor {
  paper_id: string;
  title: string;
  direction: 'in' | 'out' | 'both';
  link_id: string;
  link_type: KnowledgeLinkType;
  reason_short: string;
  confidence: number;
}

export interface KnowledgeLinkSuggestion {
  target: string;
  target_title: string;
  type: KnowledgeLinkType;
  reason_short: string;
  evidence: KnowledgeEvidencePointer[];
  confidence: number;
  recommended_action: 'mention_only' | 'create_pending' | 'skip';
}

export interface KnowledgeStoreWriteResult {
  path: string;
  backupPath?: string;
  bytes: number;
}
