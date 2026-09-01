import { Trait, TraitStatus } from './schema.js';
import { TraitCategory } from '../evidence/extract.js';

export interface ScoreResult {
  confidence: number;
  status: TraitStatus;
  reason: string;
}

export function computeTraitScore(params: {
  category: TraitCategory;
  supportCount: number;
  contradictionCount: number;
  distinctSessions: number;
  distinctContexts: number;
  hasExplicitDeclaration: boolean;
  currentStatus?: TraitStatus;
}): ScoreResult {
  const {
    category,
    supportCount,
    contradictionCount,
    distinctSessions,
    distinctContexts,
    hasExplicitDeclaration,
    currentStatus
  } = params;

  // 1. Check for disputed condition
  if (contradictionCount > 0) {
    const total = supportCount + contradictionCount;
    const ratio = contradictionCount / total;
    if (ratio >= 0.3 || (contradictionCount >= 2 && distinctSessions < 3)) {
      return {
        confidence: Math.max(0.2, 1.0 - ratio),
        status: 'disputed',
        reason: `Disputed due to significant contradictions (${contradictionCount}/${total})`
      };
    }
  }

  // 2. Base confidence calculation
  let baseScore = (supportCount + 1) / (supportCount + 2 * contradictionCount + 2);
  const sessionBoost = Math.min(0.25, (distinctSessions - 1) * 0.08);
  const contextBoost = Math.min(0.15, (distinctContexts - 1) * 0.05);
  const explicitBoost = hasExplicitDeclaration ? 0.1 : 0.0;

  let confidence = Math.min(0.98, Math.max(0.1, baseScore + sessionBoost + contextBoost + explicitBoost));
  confidence = Math.round(confidence * 100) / 100;

  // 3. Status State Machine Gating Rules
  // Rule (Criterion 6 & Section 7.2):
  // Values / Principles requires >= 4 distinct sessions to become stable.
  // Other categories require >= 3 distinct sessions to become stable.
  // Decision Style / Values CANNOT become stable from a single session (Criterion 5).
  const minStableSessions = category === 'values_principles' ? 4 : 3;

  let status: TraitStatus = 'candidate';
  let reason = 'Initial candidate evidence';

  if (distinctSessions >= minStableSessions && confidence >= 0.75 && contradictionCount === 0) {
    status = 'stable';
    reason = `Promoted to stable with ${distinctSessions} distinct sessions across ${distinctContexts} contexts`;
  } else if (
    distinctSessions >= 2 ||
    (hasExplicitDeclaration && category !== 'values_principles' && category !== 'decision_style')
  ) {
    status = 'working';
    reason = `Promoted to working with ${distinctSessions} sessions / explicit preference`;
  } else {
    status = 'candidate';
    reason = `Candidate status with ${distinctSessions} session(s)`;
  }

  // If already retired or disputed, keep it unless new overwhelming evidence arrives
  if (currentStatus === 'retired') {
    status = 'retired';
    reason = 'Previously retired';
  }

  return {
    confidence,
    status,
    reason
  };
}
