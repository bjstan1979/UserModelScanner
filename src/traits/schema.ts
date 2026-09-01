import { TraitCategory } from '../evidence/extract.js';

export type TraitStatus =
  | 'candidate'
  | 'working'
  | 'stable'
  | 'disputed'
  | 'retired'
  | 'revised';

export type OntologyLevel =
  | 'USER_GLOBAL'
  | 'DOMAIN'
  | 'TOOL'
  | 'ENVIRONMENT'
  | 'PROJECT'
  | 'CURRENT_CONTEXT';

export type TraitRole =
  | 'ACTION_GUIDANCE'
  | 'BACKGROUND_FACT'
  | 'DOMAIN_CONVENTION'
  | 'ENVIRONMENT_FACT'
  | 'RELATIONSHIP_CONTEXT';

export type SemanticStrength =
  | 'direct'
  | 'moderate-generalization'
  | 'strong-generalization';

export interface Trait {
  id: string;
  category: TraitCategory;
  ontology: OntologyLevel;
  statement: string;
  scope: string;
  domain?: string | null;
  tool?: string | null;
  environment?: string | null;
  project_id?: string | null;
  status: TraitStatus;
  confidence: number;
  portability_score: number; // 0.0 - 1.0
  behavioral_utility: number; // 0.0 - 1.0: does this meaningfully change agent behavior?
  entailment_score: number; // 0.0 - 1.0: is the wording strictly entailed by evidence?
  semantic_strength: SemanticStrength;
  trait_role: TraitRole;
  support_count: number;
  contradiction_count: number;
  distinct_sessions: number;
  distinct_contexts: number;
  first_seen: string;
  last_confirmed: string;
  evidence_ids: string[];
}
