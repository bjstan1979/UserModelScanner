import { Trait } from './schema.js';
import { EvidenceCandidate } from '../evidence/extract.js';

export interface ConflictAssessment {
  hasConflict: boolean;
  type?: 'direct_contradiction' | 'scope_difference' | 'preference_evolution';
  resolution?: 'dispute' | 'scope_split' | 'revise';
  reason?: string;
}

export function assessConflict(
  existingTrait: Trait,
  newCandidate: EvidenceCandidate
): ConflictAssessment {
  if (existingTrait.category !== newCandidate.category) {
    return { hasConflict: false };
  }

  const stmtA = existingTrait.statement.toLowerCase();
  const stmtB = newCandidate.statement.toLowerCase();

  // Check for antonym / negation patterns
  const isDirectNegation =
    (stmtA.includes('autonomous') && stmtB.includes('confirmation')) ||
    (stmtA.includes('pnpm') && stmtB.includes('npm') && !stmtB.includes('pnpm')) ||
    (stmtA.includes('typescript') && stmtB.includes('plain javascript')) ||
    (newCandidate.signal_type === 'contradiction');

  if (isDirectNegation) {
    // If scope can be split
    if (existingTrait.category === 'collaboration_style') {
      return {
        hasConflict: true,
        type: 'scope_difference',
        resolution: 'scope_split',
        reason: 'Conflict is attributable to differing operational scopes (reversible vs destructive)'
      };
    }

    return {
      hasConflict: true,
      type: 'direct_contradiction',
      resolution: 'dispute',
      reason: `Direct contradiction between "${existingTrait.statement}" and "${newCandidate.statement}"`
    };
  }

  return { hasConflict: false };
}
