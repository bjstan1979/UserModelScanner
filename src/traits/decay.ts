import { Trait } from './schema.js';

export interface DecayResult {
  updatedTrait: Trait;
  hasChanged: boolean;
  reason?: string;
}

export function applyTimeDecay(trait: Trait, currentTime: Date = new Date()): DecayResult {
  const lastConfirmedTime = new Date(trait.last_confirmed).getTime();
  const diffDays = Math.max(0, (currentTime.getTime() - lastConfirmedTime) / (1000 * 60 * 60 * 24));

  // 1. Current Goals: Strong TTL (30 days)
  if (trait.category === 'current_goals') {
    if (diffDays > 30 && trait.status !== 'retired') {
      return {
        updatedTrait: {
          ...trait,
          status: 'retired',
          confidence: 0.1
        },
        hasChanged: true,
        reason: `Retired due to TTL expiry (${Math.round(diffDays)} days since last confirmed)`
      };
    }
  }

  // 2. Preferences: Medium decay (after 60 days)
  if (trait.category === 'preferences') {
    if (diffDays > 60) {
      const decayCycles = Math.floor((diffDays - 60) / 30);
      const newConfidence = Math.max(0.3, Math.round((trait.confidence - decayCycles * 0.05) * 100) / 100);
      if (newConfidence !== trait.confidence) {
        const newStatus = newConfidence < 0.5 && trait.status === 'stable' ? 'working' : trait.status;
        return {
          updatedTrait: {
            ...trait,
            confidence: newConfidence,
            status: newStatus
          },
          hasChanged: true,
          reason: `Decayed confidence to ${newConfidence} due to ${Math.round(diffDays)} days of inactivity`
        };
      }
    }
  }

  // 3. Decision & Collaboration: Slow decay (after 90 days)
  if (trait.category === 'decision_style' || trait.category === 'collaboration_style') {
    if (diffDays > 90) {
      const decayCycles = Math.floor((diffDays - 90) / 30);
      const newConfidence = Math.max(0.4, Math.round((trait.confidence - decayCycles * 0.02) * 100) / 100);
      if (newConfidence !== trait.confidence) {
        return {
          updatedTrait: {
            ...trait,
            confidence: newConfidence
          },
          hasChanged: true,
          reason: `Slow decay to ${newConfidence} due to ${Math.round(diffDays)} days of inactivity`
        };
      }
    }
  }

  // 4. Values / Principles: Persistent, no time decay
  return {
    updatedTrait: trait,
    hasChanged: false
  };
}
