import { EvidenceCandidate } from './extract.js';

export interface MergedCandidateGroup {
  category: string;
  representativeStatement: string;
  normalizedCandidate: string;
  scope: string;
  candidates: EvidenceCandidate[];
  distinctSessions: Set<string>;
  distinctContexts: Set<string>;
  firstSeen: string;
  lastConfirmed: string;
  avgStrength: number;
}

export function groupCandidatesBySimilarity(candidates: EvidenceCandidate[]): MergedCandidateGroup[] {
  const groups: Map<string, MergedCandidateGroup> = new Map();

  for (const cand of candidates) {
    const key = `${cand.category}::${cand.candidate.trim().toLowerCase()}`;

    if (!groups.has(key)) {
      groups.set(key, {
        category: cand.category,
        representativeStatement: cand.statement,
        normalizedCandidate: cand.candidate,
        scope: 'global',
        candidates: [],
        distinctSessions: new Set(),
        distinctContexts: new Set(),
        firstSeen: cand.timestamp,
        lastConfirmed: cand.timestamp,
        avgStrength: cand.strength
      });
    }

    const group = groups.get(key)!;
    group.candidates.push(cand);
    group.distinctSessions.add(cand.source.session_id);
    if (cand.context.project) {
      group.distinctContexts.add(cand.context.project);
    }

    if (new Date(cand.timestamp).getTime() < new Date(group.firstSeen).getTime()) {
      group.firstSeen = cand.timestamp;
    }
    if (new Date(cand.timestamp).getTime() > new Date(group.lastConfirmed).getTime()) {
      group.lastConfirmed = cand.timestamp;
    }
  }

  // Calculate average strength
  for (const group of groups.values()) {
    const total = group.candidates.reduce((sum, c) => sum + c.strength, 0);
    group.avgStrength = group.candidates.length > 0 ? total / group.candidates.length : 0.5;
  }

  return Array.from(groups.values());
}
