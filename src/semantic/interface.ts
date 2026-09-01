import { CanonicalEvent } from '../normalize/canonical-event.js';
import { SessionDigest } from '../normalize/session-digest.js';
import { EvidenceCandidate, TraitCategory } from '../evidence/extract.js';
import { Trait } from '../traits/schema.js';
import { EvidenceEventRow } from '../storage/sqlite.js';

export type TraitMatchDecision =
  | { type: 'support'; traitId: string; reason?: string }
  | { type: 'oppose'; traitId: string; reason?: string }
  | { type: 'duplicate'; traitId: string; reason?: string }
  | { type: 'scope_variant'; traitId: string; scope: string; statement?: string; reason?: string }
  | { type: 'new_trait'; statement: string; category: TraitCategory; scope?: string; canonical_key?: string; reason?: string };

export interface SemanticProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;

  extractEvidence(
    digest: SessionDigest,
    events: CanonicalEvent[]
  ): Promise<EvidenceCandidate[]>;

  matchEvidenceToTraits(
    evidence: EvidenceCandidate,
    existingTraits: Trait[]
  ): Promise<TraitMatchDecision>;

  synthesizeTrait(
    evidence: EvidenceEventRow[],
    existingTrait?: Trait
  ): Promise<string>;
}
