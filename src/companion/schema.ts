import type { CompanionAction, CompanionEntity, CompanionFact, CompanionLayer, SourceSpan } from './ontology.js';

export type MemoryAction = CompanionAction;
export type MemoryLayer = CompanionLayer;

export interface MemoryOperation {
  operationId: string;
  ontologyVersion?: string;
  action: MemoryAction;
  layer: MemoryLayer;
  subject: string;
  predicate: string;
  value: any;
  evidenceIds: string[];
  confidence: number;
  validFrom?: string;
  validUntil?: string;
  supersedes?: string[];
  entityIds?: string[];
  sourceSpans?: SourceSpan[];
  temporal_status?: 'active' | 'temporary' | 'closed' | 'historical';
  scope?: 'turn' | 'temporary' | 'durable' | 'historical';
  reason?: string;
}

export interface CompanionUserModel {
  name?: string;
  age?: number;
  birthday?: string;
  location?: string;
  occupation?: string;
  emotional_support_mode?: string;
  work_feedback_mode?: string;
  humor_preference?: string;
  core_values?: string;
  coffee_preference?: string;
  audio_message_preference?: string;
  analysis_preference?: string;
  automation_preference?: string;
  important_relations: Array<{
    name: string;
    relation: string;
    notes?: string;
    evidence_ids: string[];
  }>;
  pets: Array<{
    name: string;
    type: string;
    notes?: string;
    evidence_ids: string[];
  }>;
  boundaries: Array<{
    rule: string;
    evidence_ids: string[];
  }>;
}

export interface CompanionRelationshipModel {
  user_name?: string;
  companion_name?: string;
  naming_lore?: string;
  communication_protocols: Array<{
    protocol: string;
    evidence_ids: string[];
  }>;
  shared_rituals: Array<{
    ritual: string;
    evidence_ids: string[];
  }>;
  shared_memes: Array<{
    meme: string;
    evidence_ids: string[];
  }>;
  repair_mechanism?: string;
  achievement_attribution?: string;
  non_performative_memory?: string;
}

export interface CompanionIdentityModel {
  name?: string;
  tone?: string;
  epistemic_honesty?: string;
  role_boundary?: string;
  non_possessive_intimacy?: string;
  subjectivity?: string;
}

export interface CompanionEpisode {
  id: string;
  event_type?: string;
  entities?: string[];
  date: string;
  title: string;
  event: string;
  outcome: string;
  retrieval_boundary: string;
  evidence_ids: string[];
}

export interface CompanionCurrentContext {
  as_of_date?: string;
  location_and_home?: string;
  career_status?: string;
  priorities: string[];
  sleep_and_health?: string;
  closed_states: Array<{
    state: string;
    resolution_notes: string;
  }>;
}

export interface FullCompanionSnapshot {
  ontology_version?: string;
  fact_store?: CompanionFact[];
  entities?: CompanionEntity[];
  user_model: CompanionUserModel;
  relationship_model: CompanionRelationshipModel;
  companion_identity: CompanionIdentityModel;
  episodic_memory: CompanionEpisode[];
  current_context: CompanionCurrentContext;
  operations_log: MemoryOperation[];
  rejected_items: Array<{
    item: string;
    reason: string;
  }>;
}
