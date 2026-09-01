export const COMPANION_ONTOLOGY_VERSION = 'companion-memory/v1' as const;

export type CompanionLayer =
  | 'USER_MODEL'
  | 'RELATIONSHIP'
  | 'COMPANION_IDENTITY'
  | 'EPISODIC_MEMORY'
  | 'CURRENT_CONTEXT';

export type CompanionAction = 'ADD' | 'UPDATE' | 'SUPERSEDE' | 'CLOSE' | 'REJECT';
export type CandidatePolarity = 'positive' | 'negative';
export type CandidateModality =
  | 'asserted'
  | 'candidate'
  | 'hypothetical'
  | 'quoted'
  | 'sarcastic'
  | 'corrective'
  | 'task_only';
export type CandidateAssertionMode = 'current' | 'historical' | 'candidate' | 'correction';
export type CandidateScope = 'turn' | 'temporary' | 'durable' | 'historical';
export type CandidateTemporalStatus = 'active' | 'temporary' | 'closed' | 'historical' | 'proposed';

export interface SourceSpan {
  messageId: string;
  sessionId: string;
  sessionDate: string;
  role: 'user' | 'assistant' | 'system';
  start: number;
  end: number;
  text: string;
}

export interface EntityMention {
  mentionId: string;
  surface: string;
  entityType: 'user' | 'person' | 'pet' | 'organization' | 'place' | 'companion' | 'object';
  relation?: string;
  qualifiers?: Record<string, string | number | boolean>;
  source: SourceSpan;
}

export interface CompanionEntity {
  entityId: string;
  canonicalName: string;
  entityType: EntityMention['entityType'];
  relation?: string;
  aliases: string[];
  qualifiers: Record<string, string | number | boolean>;
  evidenceIds: string[];
}

export interface CompanionCandidate {
  candidateId: string;
  ontologyVersion: typeof COMPANION_ONTOLOGY_VERSION;
  layer: CompanionLayer;
  subject: string;
  predicate: string;
  value: unknown;
  source: SourceSpan;
  supportingSources?: SourceSpan[];
  polarity: CandidatePolarity;
  modality: CandidateModality;
  assertionMode?: CandidateAssertionMode;
  scope: CandidateScope;
  temporalStatus: CandidateTemporalStatus;
  confidence: number;
  entityMentions: EntityMention[];
  correctionTargets: string[];
  supersedesOperationIds?: string[];
  eventTime?: string;
  validUntil?: string;
  discourseKey?: string;
  reason: string;
}

export interface CompanionFact {
  factId: string;
  ontologyVersion: typeof COMPANION_ONTOLOGY_VERSION;
  layer: CompanionLayer;
  subject: string;
  predicate: string;
  value: unknown;
  scope: CandidateScope;
  temporalStatus: CandidateTemporalStatus;
  validFrom?: string;
  validUntil?: string;
  entityIds: string[];
  evidenceIds: string[];
  sourceSpans: SourceSpan[];
  confidence: number;
  active: boolean;
  supersededBy?: string;
  closedBy?: string;
}

export interface DiscourseState {
  pending: Map<string, CompanionCandidate[]>;
  entities: CompanionEntity[];
  candidates: CompanionCandidate[];
}

export function stableHash(value: string): string {
  let result = 2166136261;
  for (const char of value) {
    result ^= char.codePointAt(0) ?? 0;
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

export function stableCandidateId(messageId: string, subject: string, predicate: string, ordinal = 0): string {
  return `candidate-${stableHash(`${messageId}|${subject}|${predicate}|${ordinal}`)}`;
}

export function stableEntityId(type: EntityMention['entityType'], name: string, discriminator = ''): string {
  return `entity-${type}-${stableHash(`${name}|${discriminator}`)}`;
}

export function stableFactId(subject: string, predicate: string, entityIds: string[], discriminator = ''): string {
  return `fact-${stableHash(`${subject}|${predicate}|${[...entityIds].sort().join('|')}|${discriminator}`)}`;
}

export function stableEventId(eventType: string, date: string, entities: string[], discriminator = ''): string {
  return `event-${eventType}-${date}-${stableHash(`${[...entities].sort().join('|')}|${discriminator}`)}`;
}

export function wildcardSubject(subject: string): string {
  return subject.replace(/\.[^.]+$/, '.*');
}

export interface OntologyOperationShape {
  action: string;
  layer: string;
  scope?: string;
  temporal_status?: string;
}

export interface OntologyExpectationShape {
  action: string;
  layer: string;
  scope: string;
  temporalStatus: string;
}

const ACTION_ALIASES: Record<string, string[]> = {
  upsert: ['ADD', 'UPDATE'],
  merge: ['ADD', 'UPDATE'],
  upsert_distinct: ['ADD'],
  supersede: ['SUPERSEDE'],
  close: ['CLOSE'],
  reject: ['REJECT'],
  record_event: ['ADD']
};

const LAYER_ALIASES: Record<string, CompanionLayer[]> = {
  profile: ['USER_MODEL'],
  people: ['USER_MODEL'],
  preference: ['USER_MODEL'],
  relationship: ['RELATIONSHIP'],
  companion_identity: ['COMPANION_IDENTITY'],
  decision: ['CURRENT_CONTEXT'],
  context: ['CURRENT_CONTEXT', 'RELATIONSHIP'],
  episode: ['EPISODIC_MEMORY']
};

const SCOPE_ALIASES: Record<string, CandidateScope[]> = {
  durable: ['durable'],
  durable_history: ['historical'],
  candidate: ['temporary'],
  candidate_history: ['historical'],
  temporary: ['temporary'],
  temporary_history: ['historical'],
  episodic: ['historical'],
  turn: ['turn']
};

const TEMPORAL_ALIASES: Record<string, Array<CandidateTemporalStatus | 'temporary' | 'active' | 'closed' | 'historical'>> = {
  current: ['active'],
  current_at_message: ['active'],
  historical: ['historical'],
  proposed: ['temporary', 'proposed'],
  canceled: ['closed'],
  active: ['temporary', 'active'],
  closed: ['closed'],
  occurred: ['historical']
};
export const PREDICATE_ONTOLOGY = {
  'identity.full_name': ['fullName', 'name', 'full_name'],
  'identity.surname': ['surname'],
  'identity.age': ['age'],
  'identity.childhood_place': ['childhoodPlace', 'childhood_place'],
  'entity.current_location': ['currentResidence', 'location', 'current_location'],
  'entity.occupation': ['occupation'],
  'entity.relation': ['relation'],
  'context.contact_condition': ['contactCondition', 'contact_condition'],
  'context.sleep_disruption': ['sleepDisruption', 'sleep_disruption'],
  'context.health_state': ['healthState', 'health_state'],
  'context.stress_state': ['stress_state'],
  'context.resolution': ['resolution'],
  'preference.medium': ['longFormMedium', 'preferred_medium'],
  'preference.value': ['preference'],
  'preference.frequency': ['frequency'],
  'decision.plan': ['relocationPlan', 'plan'],
  'event.relocation': ['relocation'],
  'relationship.ordered_protocol': ['orderedResponseProtocol', 'conditional_risk_analysis', 'ordered_trigger_protocol'],
  'relationship.support_mode': ['supportMode', 'support_mode'],
  'communication.distress_mode': ['distressMode', 'distress_mode'],
  'communication.work_feedback': ['workFeedback', 'work_feedback'],
  'relationship.epistemic_layers': ['epistemicLayers', 'epistemic_layers'],
  'identity.memory_honesty': ['memoryHonesty', 'memory_honesty'],
  'identity.role_boundary': ['roleBoundary', 'role_boundary'],
  'identity.non_possessive_intimacy': ['nonPossessiveIntimacy', 'non_possessive_intimacy'],
  'identity.subjectivity': ['subjectivity'],
  'identity.value': ['value'],
  'relationship.achievement_attribution': ['achievementAttribution', 'achievement_attribution'],
  'relationship.companion_name': ['companionName', 'companion_name'],
  'relationship.user_nickname': ['userNickname', 'user_nickname'],
  'event.timeline_step': ['step', 'timeline_step'],
  'event.ordered_timeline': ['timeline', 'ordered_timeline'],
  'relationship.ritual': ['recurringTradition', 'ritual'],
  'episode.ritual_occurrence': ['ritual_occurrence'],
  'preference.pet': ['pet_preference'],
  'preference.meeting_time': ['meeting_time'],
  'preference.writing_instrument': ['writing_instrument'],
  'decision.task_request': ['task_request']
} as const satisfies Record<string, readonly string[]>;

export const SUBJECT_PATTERNS = [
  'profile.identity.*',
  'profile.residence.*',
  'profile.childhood_place.*',
  'profile.occupation.*',
  'people.relation.*',
  'people.entity.*',
  'people.pet.*',
  'preference.*.*',
  'communication.*.*',
  'value.*.*',
  'relationship.protocol.*',
  'relationship.identity.*',
  'relationship.ritual.*',
  'relationship.meme.*',
  'relationship.boundary.*',
  'identity.boundary.*',
  'identity.subjectivity.*',
  'decision.*.*',
  'context.*.*',
  'episode.event.*',
  'event.timeline.*'
] as const;

const PREDICATE_CANONICAL_BY_ALIAS = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(PREDICATE_ONTOLOGY)) {
  PREDICATE_CANONICAL_BY_ALIAS.set(canonical, canonical);
  for (const alias of aliases) {
    const existing = PREDICATE_CANONICAL_BY_ALIAS.get(alias);
    if (existing && existing !== canonical) throw new Error(`Predicate alias ${alias} belongs to both ${existing} and ${canonical}`);
    PREDICATE_CANONICAL_BY_ALIAS.set(alias, canonical);
  }
}
export const PREDICATE_SUBJECT_PATTERNS: Record<string, readonly string[]> = {
  'identity.full_name': ['profile.identity.*'],
  'entity.current_location': ['profile.residence.*', 'people.entity.*'],
  'entity.occupation': ['profile.occupation.*', 'people.entity.*'],
  'entity.relation': ['people.relation.*'],
  'preference.value': ['preference.*.*', 'people.entity.*'],
  'preference.medium': ['preference.*.*'],
  'decision.plan': ['decision.*.*'],
  'context.stress_state': ['context.*.*'],
  'context.resolution': ['context.*.*'],
  'relationship.ordered_protocol': ['relationship.protocol.*'],
  'relationship.ritual': ['relationship.ritual.*'],
  'episode.ritual_occurrence': ['episode.event.*'],
  'event.timeline_step': ['event.timeline.*'],
  'event.ordered_timeline': ['event.timeline.*']
};



export function canonicalPredicate(predicate: string): string | undefined {
  return PREDICATE_CANONICAL_BY_ALIAS.get(predicate);
}
export function predicateSubjectExpectationKnown(predicate: string, subjectPattern: string): boolean {
  const canonical = canonicalPredicate(predicate);
  const allowed = canonical ? PREDICATE_SUBJECT_PATTERNS[canonical] : undefined;
  return subjectExpectationKnown(subjectPattern) && (!allowed || allowed.includes(subjectPattern));
}



export function predicateVocabularyMatches(actual: string, expected: string): boolean {
  const actualCanonical = canonicalPredicate(actual);
  const expectedCanonical = canonicalPredicate(expected);
  if (actualCanonical || expectedCanonical) return actualCanonical !== undefined && actualCanonical === expectedCanonical;
  return actual === expected;
}

export function predicateVocabularyKnown(predicate: string): boolean {
  return canonicalPredicate(predicate) !== undefined;
}

export function subjectVocabularyKnown(pattern: string): boolean {
  const sample = pattern.replace(/\*/g, 'sample');
  return SUBJECT_PATTERNS.some(allowed => subjectPatternMatches(sample, allowed));
}
export function subjectExpectationKnown(pattern: string): boolean {
  return (SUBJECT_PATTERNS as readonly string[]).includes(pattern);
}



export interface SemanticExpectationVocabulary {
  layer: string;
  subjectPattern: string;
  predicate: string;
  scope: string;
  temporalStatus: string;
}

export interface OperationExpectationVocabulary extends SemanticExpectationVocabulary {
  action: string;
}
function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}


export function validateSemanticExpectationVocabulary(expected: SemanticExpectationVocabulary): string[] {
  const invalid: string[] = [];
  if (!hasOwn(LAYER_ALIASES, expected.layer)) invalid.push(`layer=${expected.layer}`);
  if (!subjectExpectationKnown(expected.subjectPattern)) invalid.push(`subjectPattern=${expected.subjectPattern}`);
  if (!predicateVocabularyKnown(expected.predicate)) invalid.push(`predicate=${expected.predicate}`);
  else if (subjectExpectationKnown(expected.subjectPattern) && !predicateSubjectExpectationKnown(expected.predicate, expected.subjectPattern)) {
    invalid.push(`predicateSubject=${expected.predicate}@${expected.subjectPattern}`);
  }
  if (!hasOwn(SCOPE_ALIASES, expected.scope)) invalid.push(`scope=${expected.scope}`);
  if (!hasOwn(TEMPORAL_ALIASES, expected.temporalStatus)) invalid.push(`temporalStatus=${expected.temporalStatus}`);
  return invalid;
}



export function validateOperationExpectationVocabulary(expected: OperationExpectationVocabulary): string[] {
  const invalid = hasOwn(ACTION_ALIASES, expected.action) ? [] : [`action=${expected.action}`];
  return [...invalid, ...validateSemanticExpectationVocabulary(expected)];
}

export const OPERATION_ONTOLOGY = {
  version: COMPANION_ONTOLOGY_VERSION,
  actions: Object.keys(ACTION_ALIASES),
  layers: Object.keys(LAYER_ALIASES),
  scopes: Object.keys(SCOPE_ALIASES),
  temporalStatuses: Object.keys(TEMPORAL_ALIASES),
  subjectPatterns: SUBJECT_PATTERNS,
  predicates: PREDICATE_ONTOLOGY
} as const;
export function actionVocabularyMatches(actual: string, expected: string): boolean {
  return (ACTION_ALIASES[expected] ?? [expected.toUpperCase()]).includes(actual);
}

export function layerVocabularyMatches(actual: string, expected: string): boolean {
  return (LAYER_ALIASES[expected] ?? [expected as CompanionLayer]).includes(actual as CompanionLayer);
}

export function scopeVocabularyMatches(actual: string | undefined, expected: string): boolean {
  return (SCOPE_ALIASES[expected] ?? [expected as CandidateScope]).includes(actual as CandidateScope);
}

export function temporalVocabularyMatches(actual: string | undefined, expected: string): boolean {
  return (TEMPORAL_ALIASES[expected] ?? [expected as CandidateTemporalStatus]).includes(actual as CandidateTemporalStatus);
}

export function operationVocabularyMatches(actual: OntologyOperationShape, expected: OntologyExpectationShape): boolean {
  return actionVocabularyMatches(actual.action, expected.action)
    && layerVocabularyMatches(actual.layer, expected.layer)
    && scopeVocabularyMatches(actual.scope, expected.scope)
    && temporalVocabularyMatches(actual.temporal_status, expected.temporalStatus);
}

export function subjectPatternMatches(subject: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(subject);
}
