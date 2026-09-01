import type { MemoryOperation } from './schema.js';
import {
  COMPANION_ONTOLOGY_VERSION,
  CompanionCandidate,
  CompanionEntity,
  CompanionFact,
  CandidateTemporalStatus,
  stableEntityId,
  stableFactId,
  stableHash
} from './ontology.js';

export interface EntailmentVerdict {
  entailed: boolean;
  confidence: number;
  reason: string;
}

export type EntailmentChecker = (candidate: CompanionCandidate) => EntailmentVerdict;

export interface RejectedMemory {
  item: string;
  reason: string;
  evidenceIds: string[];
}
export interface ResolverState {
  facts: Map<string, CompanionFact>;
  entities: Map<string, CompanionEntity>;
  operations: MemoryOperation[];
  rejected: RejectedMemory[];
}

export interface ResolutionResult {
  state: ResolverState;
  operations: MemoryOperation[];
  rejected: RejectedMemory[];
}

const CONFLICT_DOMAINS: Array<[RegExp, string]> = [
  [/^profile\.(?:residence|location|city)\./, 'profile.residence.current'],
  [/^profile\.(?:childhood_place|origin|hometown)\./, 'profile.childhood_place.current'],
  [/^profile\.occupation\./, 'profile.occupation.current'],
  [/^profile\.identity\.full_name$/, 'profile.identity.full_name'],
  [/^profile\.identity\.age$/, 'profile.identity.age'],
  [/^preference\.reading\.long_form$/, 'preference.reading.long_form'],
  [/^preference\.beverage\.coffee$/, 'preference.beverage.coffee'],
  [/^preference\.automation\./, 'preference.automation.control'],
  [/^decision\.relocation\./, 'decision.relocation'],
  [/^context\.temporary\.sleep/, 'context.temporary.sleep'],
  [/^context\.temporary\.(?:fever|health)/, 'context.temporary.health'],
  [/^relationship\.identity\.companion_name$/, 'relationship.identity.companion_name']
];

export function conflictDomain(subject: string): string {
  for (const [pattern, domain] of CONFLICT_DOMAINS) {
    if (pattern.test(subject)) return domain;
  }
  return subject;
}

export function createResolverState(): ResolverState {
  return { facts: new Map(), entities: new Map(), operations: [], rejected: [] };
}

function scalarStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(scalarStrings);
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(scalarStrings);
  return [];
}

function defaultEntailment(candidate: CompanionCandidate): EntailmentVerdict {
  const source = candidate.source.text.trim();
  if (!source) return { entailed: false, confidence: 1, reason: 'Empty source span' };
  if (candidate.source.start < 0 || candidate.source.end < candidate.source.start) {
    return { entailed: false, confidence: 1, reason: 'Invalid source span offsets' };
  }
  if (candidate.polarity === 'negative') {
    return { entailed: false, confidence: 1, reason: 'Negative assertion cannot create a positive fact' };
  }
  if (['quoted', 'sarcastic', 'task_only', 'hypothetical'].includes(candidate.modality)) {
    return { entailed: false, confidence: 1, reason: `${candidate.modality} content is not asserted memory` };
  }
  if (candidate.modality === 'candidate' && candidate.temporalStatus !== 'proposed') {
    return { entailed: false, confidence: 1, reason: 'Candidate modality must remain proposed' };
  }

  const values = scalarStrings(candidate.value).filter(value => value.length > 1);
  const normalizedOnly = new Set([
    'active', 'historical', 'temporary', 'closed', 'proposed', 'candidate', 'canceled',
    'annual', 'only', 'timeline_step', 'timeline', 'relocation', 'none', 'low', 'oat', 'not_iced'
  ]);
  const unsupported = values.filter(value => !normalizedOnly.has(value) && !source.includes(value));
  if (unsupported.length > 0 && candidate.confidence >= 0.95) {
    return { entailed: false, confidence: 0.85, reason: `Normalized value lacks source support: ${unsupported.join(', ')}` };
  }
  return { entailed: true, confidence: unsupported.length ? 0.75 : 0.95, reason: unsupported.length ? 'Source supports the claim with normalized fields' : 'Source directly supports the claim' };
}

function entityDiscriminator(_candidate: CompanionCandidate, relation?: string, qualifiers?: Record<string, string | number | boolean>): string {
  const context = qualifiers?.location ?? qualifiers?.organization ?? qualifiers?.occupation ?? '';
  return `${relation ?? ''}|${String(context)}`;
}

function resolveEntities(candidate: CompanionCandidate, state: ResolverState): string[] {
  const ids: string[] = [];
  for (const item of candidate.entityMentions) {
    const discriminator = entityDiscriminator(candidate, item.relation, item.qualifiers);
    const existingIdentity = [...state.entities.values()].find(entity =>
      entity.entityType === item.entityType && entity.canonicalName === item.surface && entity.relation === item.relation
    );
    const entityId = existingIdentity?.entityId ?? stableEntityId(item.entityType, item.surface, discriminator);
    const existing = state.entities.get(entityId);
    if (existing) {
      if (!existing.aliases.includes(item.surface)) existing.aliases.push(item.surface);
      if (!existing.evidenceIds.includes(item.source.messageId)) existing.evidenceIds.push(item.source.messageId);
      existing.qualifiers = { ...existing.qualifiers, ...(item.qualifiers ?? {}) };
      if (!existing.relation && item.relation) existing.relation = item.relation;
    } else {
      state.entities.set(entityId, {
        entityId,
        canonicalName: item.surface,
        entityType: item.entityType,
        relation: item.relation,
        aliases: [item.surface],
        qualifiers: { ...(item.qualifiers ?? {}) },
        evidenceIds: [item.source.messageId]
      });
    }
    ids.push(entityId);
  }
  return [...new Set(ids)];
}

function operationId(candidate: CompanionCandidate, action: MemoryOperation['action']): string {
  return `op-${stableHash(`${candidate.candidateId}|${action}`)}`;
}

function toOperation(
  candidate: CompanionCandidate,
  action: MemoryOperation['action'],
  entityIds: string[],
  supersedes: string[] = [],
  reason = candidate.reason
): MemoryOperation {
  const temporalStatus = candidate.temporalStatus === 'proposed' ? 'temporary' : candidate.temporalStatus;
  return {
    operationId: operationId(candidate, action),
    ontologyVersion: COMPANION_ONTOLOGY_VERSION,
    action,
    layer: candidate.layer,
    subject: candidate.subject,
    predicate: candidate.predicate,
    value: candidate.value,
    evidenceIds: [...new Set((candidate.supportingSources ?? [candidate.source]).map(source => source.messageId))],
    sourceSpans: candidate.supportingSources ?? [candidate.source],
    entityIds,
    confidence: candidate.confidence,
    validFrom: candidate.eventTime ?? candidate.source.sessionDate,
    validUntil: candidate.validUntil,
    supersedes: supersedes.length ? supersedes : undefined,
    temporal_status: temporalStatus,
    scope: candidate.scope,
    reason
  };
}

function activeConflicts(candidate: CompanionCandidate, state: ResolverState): CompanionFact[] {
  const explicitSubjects = new Set(candidate.correctionTargets);
  if (explicitSubjects.size > 0) {
    return [...state.facts.values()].filter(fact => fact.active && explicitSubjects.has(fact.subject));
  }
  const domain = conflictDomain(candidate.subject);
  return [...state.facts.values()].filter(fact =>
    fact.active && conflictDomain(fact.subject) === domain
  );
}

function factDiscriminator(candidate: CompanionCandidate): string {
  const valueHash = stableHash(JSON.stringify(candidate.value));
  if (candidate.layer !== 'EPISODIC_MEMORY') return valueHash;
  return `${candidate.eventTime ?? candidate.source.sessionDate}|${valueHash}`;
}

function storeFact(
  candidate: CompanionCandidate,
  entityIds: string[],
  state: ResolverState,
  active: boolean,
  superseded: CompanionFact[] = []
): CompanionFact {
  const factId = stableFactId(candidate.subject, candidate.predicate, entityIds, factDiscriminator(candidate));
  const previous = state.facts.get(factId);
  const fact: CompanionFact = {
    factId,
    ontologyVersion: COMPANION_ONTOLOGY_VERSION,
    layer: candidate.layer,
    subject: candidate.subject,
    predicate: candidate.predicate,
    value: candidate.value,
    scope: candidate.scope,
    temporalStatus: candidate.temporalStatus,
    validFrom: candidate.eventTime ?? candidate.source.sessionDate,
    validUntil: candidate.validUntil,
    entityIds,
    evidenceIds: [...new Set([...(previous?.evidenceIds ?? []), ...(candidate.supportingSources ?? [candidate.source]).map(source => source.messageId)])],
    sourceSpans: [...(previous?.sourceSpans ?? []), ...(candidate.supportingSources ?? [candidate.source])],
    confidence: candidate.confidence,
    active,
    supersededBy: previous?.supersededBy,
    closedBy: previous?.closedBy
  };
  state.facts.set(factId, fact);
  for (const old of superseded) {
    old.active = false;
    old.supersededBy = factId;
    old.temporalStatus = old.temporalStatus === 'temporary' || old.temporalStatus === 'proposed' ? 'closed' : 'historical';
  }
  return fact;
}

function closeFacts(candidate: CompanionCandidate, conflicts: CompanionFact[], state: ResolverState): string[] {
  const ids: string[] = [];
  for (const fact of conflicts) {
    fact.active = false;
    fact.closedBy = candidate.candidateId;
    fact.validUntil = candidate.eventTime ?? candidate.source.sessionDate;
    fact.temporalStatus = 'closed';
    ids.push(fact.factId);
  }
  return ids;
}

function actionFor(candidate: CompanionCandidate, conflicts: CompanionFact[], exact?: CompanionFact): MemoryOperation['action'] {
  if (candidate.temporalStatus === 'closed') return 'CLOSE';
  if (candidate.modality === 'corrective' || candidate.correctionTargets.length > 0) return conflicts.length ? 'SUPERSEDE' : 'UPDATE';
  if (exact) return 'UPDATE';
  return 'ADD';
}

export function resolveCandidates(
  candidates: CompanionCandidate[],
  state: ResolverState = createResolverState(),
  checkEntailment: EntailmentChecker = defaultEntailment
): ResolutionResult {
  const operations: MemoryOperation[] = [];
  const rejected: RejectedMemory[] = [];

  for (const candidate of candidates) {
    const verdict = checkEntailment(candidate);
    if (!verdict.entailed) {
      const item: RejectedMemory = {
        item: candidate.source.text,
        reason: verdict.reason,
        evidenceIds: [candidate.source.messageId]
      };
      rejected.push(item);
      state.rejected.push(item);
      operations.push(toOperation(candidate, 'REJECT', [], [], verdict.reason));
      continue;
    }

    const entityIds = resolveEntities(candidate, state);
    const conflicts = activeConflicts(candidate, state);
    const exactId = stableFactId(candidate.subject, candidate.predicate, entityIds, factDiscriminator(candidate));
    const exact = state.facts.get(exactId);
    const action = actionFor(candidate, conflicts, exact);

    if (action === 'CLOSE') {
      const closed = closeFacts(candidate, conflicts, state);
      operations.push(toOperation(candidate, 'CLOSE', entityIds, closed, candidate.reason));
      continue;
    }

    const shouldDeactivate = candidate.temporalStatus === 'historical';
    const superseded = action === 'SUPERSEDE'
      ? conflicts.filter(fact => fact.factId !== exactId)
      : [];
    const fact = storeFact(candidate, entityIds, state, !shouldDeactivate, superseded);
    const supersedes = [...new Set([...superseded.map(item => item.factId), ...(exact && action === 'UPDATE' ? [exact.factId] : [])])];
    operations.push(toOperation(candidate, action, entityIds, supersedes, `${candidate.reason}; fact=${fact.factId}`));
  }

  state.operations.push(...operations);
  return { state, operations, rejected };
}

export function activeFacts(state: ResolverState, includeProposed = false): CompanionFact[] {
  return [...state.facts.values()].filter(fact => fact.active && (includeProposed || fact.temporalStatus !== 'proposed'));
}

export function factsByTemporalStatus(state: ResolverState, status: CandidateTemporalStatus): CompanionFact[] {
  return [...state.facts.values()].filter(fact => fact.temporalStatus === status);
}
