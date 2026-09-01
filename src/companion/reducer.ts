import {
  canonicalPredicate,
  COMPANION_ONTOLOGY_VERSION,
  CompanionEntity,
  CompanionFact,
  stableEntityId,
  stableEventId,
  stableFactId,
  stableHash
} from './ontology.js';
import type { ResolverState } from './resolver.js';
import type {
  CompanionEpisode,
  CompanionUserModel,
  FullCompanionSnapshot,
  MemoryOperation
} from './schema.js';

interface WrappedValue {
  normalized?: unknown;
  sourceText?: string;
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && ('normalized' in value || 'sourceText' in value)) {
    return (value as WrappedValue).normalized;
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  const normalized = unwrap(value);
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : {};
}

function sourceText(fact: CompanionFact): string {
  const source = fact.sourceSpans.at(-1)?.text;
  if (source) return source;
  const value = unwrap(fact.value);
  return typeof value === 'string' ? value : '';
}

function displayValue(fact: CompanionFact | undefined): string | undefined {
  if (!fact) return undefined;
  const value = unwrap(fact.value);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  const source = sourceText(fact);
  return source || undefined;
}

function bySubject(facts: CompanionFact[], ...subjects: string[]): CompanionFact | undefined {
  return [...facts].reverse().find(fact => subjects.includes(fact.subject));
}

function bySubjectPrefix(facts: CompanionFact[], ...prefixes: string[]): CompanionFact[] {
  return facts.filter(fact => prefixes.some(prefix => fact.subject.startsWith(prefix)));
}

function profileAge(fact: CompanionFact | undefined): { age?: number; birthday?: string } {
  if (!fact) return {};
  const value = unwrap(fact.value);
  if (typeof value === 'number') return { age: value };
  const record = asRecord(value);
  return {
    age: typeof record.age === 'number' ? record.age : undefined,
    birthday: typeof record.birthday === 'string' ? record.birthday : undefined
  };
}

function coffeeText(fact: CompanionFact | undefined): string | undefined {
  if (!fact) return undefined;
  const value = asRecord(fact.value);
  const pieces: string[] = [];
  if (value.caffeine === 'none') pieces.push('无咖啡因');
  else if (value.caffeine === 'low') pieces.push('低因');
  if (value.milk === 'oat') pieces.push('燕麦奶');
  if (value.temperature === 'not_iced') pieces.push('非冰');
  return pieces.length ? pieces.join('、') : displayValue(fact);
}

function relationFacts(facts: CompanionFact[], entities: ReadonlyMap<string, CompanionEntity>): CompanionUserModel['important_relations'] {
  const result = new Map<string, CompanionUserModel['important_relations'][number]>();
  for (const fact of bySubjectPrefix(facts, 'people.relation.', 'people.entity.').filter(item => canonicalPredicate(item.predicate) === 'entity.relation')) {
    const value = asRecord(fact.value);
    const entity = fact.entityIds.map(id => entities.get(id)).find(Boolean);
    const scalar = unwrap(fact.value);
    const name = typeof value.name === 'string' ? value.name : entity?.canonicalName ?? '';
    const relation = typeof value.relation === 'string'
      ? value.relation
      : typeof scalar === 'string' ? scalar : entity?.relation ?? '';
    if (!name || !relation) continue;
    const key = fact.entityIds[0] ?? fact.factId;
    result.set(key, { name, relation, notes: sourceText(fact) || undefined, evidence_ids: fact.evidenceIds });
  }
  return [...result.values()];
}

function petFacts(facts: CompanionFact[]): CompanionUserModel['pets'] {
  const result = new Map<string, CompanionUserModel['pets'][number]>();
  for (const fact of bySubjectPrefix(facts, 'people.pet.', 'pet.')) {
    const value = asRecord(fact.value);
    const name = typeof value.name === 'string' ? value.name : '';
    const type = typeof value.type === 'string' ? value.type : '';
    if (!name || !type) continue;
    const key = fact.entityIds[0] ?? fact.factId;
    result.set(key, { name, type, notes: sourceText(fact) || undefined, evidence_ids: fact.evidenceIds });
  }
  return [...result.values()];
}

function episodeFromFact(fact: CompanionFact): CompanionEpisode {
  const value = asRecord(fact.value);
  const eventType = typeof value.eventType === 'string'
    ? value.eventType
    : typeof value.event_type === 'string'
      ? value.event_type
      : fact.predicate;
  const date = typeof value.eventDate === 'string'
    ? value.eventDate
    : typeof value.date === 'string'
      ? value.date
      : fact.validFrom ?? fact.sourceSpans[0]?.sessionDate ?? '';
  const event = typeof value.description === 'string'
    ? value.description
    : typeof value.event === 'string'
      ? value.event
      : sourceText(fact);
  const entityNames = fact.entityIds;
  const id = typeof value.id === 'string'
    ? value.id
    : stableEventId(eventType, date.slice(0, 10), entityNames, fact.factId);
  return {
    id,
    event_type: eventType,
    entities: entityNames.length ? entityNames : undefined,
    date,
    title: typeof value.title === 'string' ? value.title : event.slice(0, 32),
    event,
    outcome: typeof value.outcome === 'string' ? value.outcome : fact.temporalStatus === 'closed' ? 'closed' : '',
    retrieval_boundary: typeof value.retrievalBoundary === 'string'
      ? value.retrievalBoundary
      : typeof value.retrieval_boundary === 'string'
        ? value.retrieval_boundary
        : '',
    evidence_ids: fact.evidenceIds
  };
}

function projectEpisodes(facts: CompanionFact[]): CompanionEpisode[] {
  return facts
    .filter(fact => fact.layer === 'EPISODIC_MEMORY' && fact.predicate !== 'timeline')
    .map(episodeFromFact)
    .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
}

function activeFacts(state: ResolverState): CompanionFact[] {
  return [...state.facts.values()].filter(fact => fact.active && fact.temporalStatus !== 'proposed');
}

function valueArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function projectCompanionState(
  state: ResolverState,
  rejectedItems: Array<{ item: string; reason: string }> = [],
  asOfDate?: string
): FullCompanionSnapshot {
  const active = activeFacts(state);
  const all = [...state.facts.values()].sort((left, right) => left.factId.localeCompare(right.factId));
  const identityFacts = active.filter(fact => fact.layer === 'COMPANION_IDENTITY');
  const relationshipFacts = active.filter(fact => fact.layer === 'RELATIONSHIP');
  const contextFacts = active.filter(fact => fact.layer === 'CURRENT_CONTEXT');

  const fullName = bySubject(active, 'profile.identity.full_name', 'profile.name');
  const age = profileAge(bySubject(active, 'profile.identity.age', 'profile.age'));
  const residence = bySubject(active, 'profile.residence.current', 'profile.location.current', 'profile.city', 'profile.origin');
  const occupation = bySubject(active, 'profile.occupation.current', 'profile.role');
  const nickname = bySubject(relationshipFacts, 'relationship.identity.user_nickname', 'relationship.user_nickname');
  const companionName = bySubject(relationshipFacts, 'relationship.identity.companion_name', 'relationship.companion_name');

  const boundaryFacts = active.filter(fact =>
    fact.subject.startsWith('boundary.') ||
    fact.subject.startsWith('identity.boundary.') ||
    fact.subject.startsWith('relationship.boundary.')
  );
  const protocols = bySubjectPrefix(relationshipFacts, 'relationship.protocol.');
  const rituals = [
    ...bySubjectPrefix(relationshipFacts, 'relationship.ritual.'),
    ...bySubjectPrefix(active, 'context.recurring_tradition')
  ];
  const memes = bySubjectPrefix(relationshipFacts, 'relationship.meme.');

  const priorityFact = bySubject(contextFacts, 'context.priorities');
  const currentHealth = contextFacts.filter(fact =>
    fact.subject.startsWith('context.temporary.') || fact.subject.startsWith('context.health.')
  );
  const closed = all.filter(fact => fact.temporalStatus === 'closed');
  const relocation = projectEpisodes(all).filter(item => item.event_type === 'relocation').at(-1);

  return {
    ontology_version: COMPANION_ONTOLOGY_VERSION,
    fact_store: all,
    entities: [...state.entities.values()].sort((left, right) => left.entityId.localeCompare(right.entityId)),
    user_model: {
      name: displayValue(fullName),
      age: age.age,
      birthday: age.birthday,
      location: displayValue(residence),
      occupation: displayValue(occupation),
      emotional_support_mode: displayValue(bySubject(active, 'communication.support.distress', 'communication.distress_mode')),
      work_feedback_mode: displayValue(bySubject(active, 'communication.feedback.work', 'communication.work_feedback')),
      humor_preference: displayValue(bySubject(active, 'preference.communication.humor', 'communication.humor_scope')),
      core_values: displayValue(bySubject(active, 'value.autonomy.optionality', 'value.optionality')),
      coffee_preference: coffeeText(bySubject(active, 'preference.beverage.coffee', 'preference.coffee')),
      audio_message_preference: displayValue(bySubject(active, 'preference.communication.voice_message', 'preference.voice_messages')),
      analysis_preference: displayValue(bySubject(active, 'relationship.protocol.epistemic_layers', 'communication.epistemic_layers')),
      automation_preference: displayValue(bySubject(active, 'preference.automation.control', 'preference.automation')),
      important_relations: relationFacts(active, state.entities),
      pets: petFacts(active),
      boundaries: boundaryFacts.map(fact => ({ rule: sourceText(fact), evidence_ids: fact.evidenceIds })).filter(item => item.rule)
    },
    relationship_model: {
      user_name: displayValue(nickname),
      companion_name: displayValue(companionName),
      naming_lore: companionName ? sourceText(companionName) || undefined : undefined,
      communication_protocols: protocols.map(fact => ({ protocol: sourceText(fact), evidence_ids: fact.evidenceIds })),
      shared_rituals: rituals.map(fact => ({ ritual: sourceText(fact), evidence_ids: fact.evidenceIds })),
      shared_memes: memes.map(fact => ({ meme: sourceText(fact), evidence_ids: fact.evidenceIds })),
      repair_mechanism: displayValue(bySubject(relationshipFacts, 'relationship.protocol.epistemic_layers', 'communication.epistemic_layers')),
      achievement_attribution: displayValue(bySubject(relationshipFacts, 'relationship.boundary.achievement_attribution', 'relationship.achievement_attribution')),
      non_performative_memory: displayValue(bySubject(relationshipFacts, 'relationship.boundary.non_performative_memory', 'relationship.non_performative_memory'))
    },
    companion_identity: {
      name: displayValue(companionName),
      tone: displayValue(bySubject(identityFacts, 'identity.tone')),
      epistemic_honesty: displayValue(bySubject(identityFacts, 'identity.boundary.memory_honesty', 'identity.epistemic_honesty')),
      role_boundary: displayValue(bySubject(identityFacts, 'identity.boundary.no_diagnosis', 'boundary.unsolicited_diagnosis')),
      non_possessive_intimacy: displayValue(bySubject(identityFacts, 'identity.boundary.non_possessive', 'identity.non_possessive')),
      subjectivity: displayValue(bySubject(identityFacts, 'identity.subjectivity.honest_disagreement', 'identity.honest_disagreement'))
    },
    episodic_memory: projectEpisodes(all),
    current_context: {
      as_of_date: asOfDate,
      location_and_home: relocation?.event,
      career_status: displayValue(bySubject(contextFacts, 'context.career.status', 'goal.career_transition', 'context.interview_status')),
      priorities: priorityFact ? valueArray(unwrap(priorityFact.value)) : [],
      sleep_and_health: currentHealth.length ? currentHealth.map(sourceText).filter(Boolean).join(' | ') : undefined,
      closed_states: closed.map(fact => ({
        state: fact.subject,
        resolution_notes: fact.sourceSpans.at(-1)?.text ?? fact.closedBy ?? 'closed'
      }))
    },
    operations_log: state.operations,
    rejected_items: [...state.rejected, ...rejectedItems].map(item => ({ item: item.item, reason: item.reason }))
  };
}

function operationSource(operation: MemoryOperation) {
  const span = operation.sourceSpans?.at(-1);
  if (span) return span;
  const value = operation.value as WrappedValue;
  const text = value && typeof value === 'object' && typeof value.sourceText === 'string'
    ? value.sourceText
    : typeof unwrap(operation.value) === 'string'
      ? String(unwrap(operation.value))
      : '';
  return {
    messageId: operation.evidenceIds[0] ?? operation.operationId,
    sessionId: 'legacy',
    sessionDate: operation.validFrom ?? '',
    role: 'user' as const,
    start: 0,
    end: text.length,
    text
  };
}

/** Compatibility adapter for callers that still persist only an operation log. */
export function reduceCompanionOperations(
  operations: MemoryOperation[],
  rejectedItems: Array<{ item: string; reason: string }>,
  asOfDate?: string
): FullCompanionSnapshot {
  const state: ResolverState = { facts: new Map(), entities: new Map(), operations, rejected: [] };
  const activeBySubject = new Map<string, string>();

  for (const operation of operations) {
    const domain = operation.subject;
    const currentId = activeBySubject.get(domain);
    if (operation.action === 'REJECT') continue;
    if (operation.action === 'CLOSE') {
      if (currentId) {
        const current = state.facts.get(currentId);
        if (current) {
          current.active = false;
          current.temporalStatus = 'closed';
          current.validUntil = operation.validFrom;
        }
        activeBySubject.delete(domain);
      }
      continue;
    }
    if (currentId && ['UPDATE', 'SUPERSEDE'].includes(operation.action)) {
      const current = state.facts.get(currentId);
      if (current) {
        current.active = false;
        current.temporalStatus = 'historical';
      }
    }
    const entityIds = operation.entityIds ?? [];
    const value = unwrap(operation.value);
    const factId = stableFactId(operation.subject, operation.predicate, entityIds, stableHash(JSON.stringify(value)));
    const temporalStatus = operation.temporal_status ?? 'active';
    state.facts.set(factId, {
      factId,
      ontologyVersion: COMPANION_ONTOLOGY_VERSION,
      layer: operation.layer,
      subject: operation.subject,
      predicate: operation.predicate,
      value,
      scope: operation.scope ?? 'durable',
      temporalStatus,
      validFrom: operation.validFrom,
      validUntil: operation.validUntil,
      entityIds,
      evidenceIds: operation.evidenceIds,
      sourceSpans: [operationSource(operation)],
      confidence: operation.confidence,
      active: temporalStatus !== 'historical' && temporalStatus !== 'closed'
    });
    if (temporalStatus !== 'historical' && temporalStatus !== 'closed') activeBySubject.set(domain, factId);
    for (const [index, entityId] of entityIds.entries()) {
      if (!state.entities.has(entityId)) state.entities.set(entityId, {
        entityId,
        canonicalName: `entity-${index + 1}`,
        entityType: 'person',
        aliases: [],
        qualifiers: {},
        evidenceIds: operation.evidenceIds
      });
    }
  }

  return projectCompanionState(state, rejectedItems, asOfDate);
}
