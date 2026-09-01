import crypto from 'node:crypto';
import { Trait } from './schema.js';
import { EvidenceCandidate } from '../evidence/extract.js';

export interface ScopeSplitResult {
  isSplit: boolean;
  splitTraits?: Trait[];
  reason?: string;
}

export function generateDeterministicTraitId(category: string, scope: string, canonicalKey: string): string {
  const hash = crypto.createHash('md5').update(`${category}::${scope}::${canonicalKey}`).digest('hex').slice(0, 10);
  return `trait_${hash}`;
}

/**
 * Detects if candidates or evidence represent different scopes (e.g. reversible vs destructive)
 * rather than a blunt global contradiction.
 */
export function checkScopeSplit(
  existingTrait: Trait,
  newCandidate: EvidenceCandidate
): ScopeSplitResult {
  const existingStatement = existingTrait.statement.toLowerCase();
  const newStatement = newCandidate.statement.toLowerCase();

  // Case 1: Autonomous vs Confirmation
  const existingAutonomy = existingStatement.includes('autonomous') || existingStatement.includes('自主推进');
  const existingConfirm = existingStatement.includes('confirmation') || existingStatement.includes('确认');

  const newAutonomy = newStatement.includes('autonomous') || newStatement.includes('自主推进');
  const newConfirm = newStatement.includes('confirmation') || newStatement.includes('确认') || newStatement.includes('destructive') || newStatement.includes('irreversible');

  if ((existingAutonomy && newConfirm) || (existingConfirm && newAutonomy)) {
    // Split into reversible vs irreversible scopes with deterministic IDs
    const reversibleTrait: Trait = {
      id: generateDeterministicTraitId('collaboration_style', 'reversible-actions', 'autonomous_reversible_work'),
      category: 'collaboration_style',
      ontology: 'USER_GLOBAL',
      statement: 'For reversible local engineering work, prefers autonomous progress without redundant confirmation.',
      scope: 'reversible-actions',
      status: 'working',
      confidence: 0.88,
      portability_score: 0.90,
      behavioral_utility: 0.95,
      entailment_score: 0.95,
      semantic_strength: 'direct',
      trait_role: 'ACTION_GUIDANCE',
      support_count: 1,
      contradiction_count: 0,
      distinct_sessions: 1,
      distinct_contexts: 1,
      first_seen: existingTrait.first_seen,
      last_confirmed: newCandidate.timestamp,
      evidence_ids: [...existingTrait.evidence_ids]
    };

    const irreversibleTrait: Trait = {
      id: generateDeterministicTraitId('collaboration_style', 'destructive-actions', 'confirm_destructive_actions'),
      category: 'collaboration_style',
      ontology: 'USER_GLOBAL',
      statement: 'For irreversible, destructive, or externally consequential actions, prefers stronger safeguards and explicit boundaries.',
      scope: 'destructive-actions',
      status: 'working',
      confidence: 0.9,
      portability_score: 0.90,
      behavioral_utility: 0.95,
      entailment_score: 0.95,
      semantic_strength: 'direct',
      trait_role: 'ACTION_GUIDANCE',
      support_count: 1,
      contradiction_count: 0,
      distinct_sessions: 1,
      distinct_contexts: 1,
      first_seen: newCandidate.timestamp,
      last_confirmed: newCandidate.timestamp,
      evidence_ids: [newCandidate.id]
    };

    return {
      isSplit: true,
      splitTraits: [reversibleTrait, irreversibleTrait],
      reason: 'Scope-split autonomous execution vs destructive confirmation'
    };
  }

  return { isSplit: false };
}
