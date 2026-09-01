import fs from 'node:fs';
import path from 'node:path';
import type { CandidateExtractionResult } from './candidate-extractor.js';
import type { CompanionSession } from './engine.js';
import type {
  CandidateAssertionMode,
  CandidateModality,
  CandidateScope,
  CandidateTemporalStatus,
  CompanionCandidate,
  CompanionLayer,
  DiscourseState,
  EntityMention,
  SourceSpan
} from './ontology.js';
import {
  COMPANION_ONTOLOGY_VERSION,
  OPERATION_ONTOLOGY,
  PREDICATE_SUBJECT_PATTERNS,
  canonicalPredicate,
  predicateVocabularyKnown,
  stableCandidateId,
  stableHash,
  subjectVocabularyKnown
} from './ontology.js';
import type { MemoryOperation } from './schema.js';
import type {
  MiniMaxChatMessage,
  MiniMaxChatOptions,
  MiniMaxResponderConfig,
  MiniMaxToolDefinition
} from './minimax-responder.js';
import { requestMiniMaxChat } from './minimax-responder.js';
import type {
  CandidateExtractionInput,
  CompanionSemanticProvider,
  EntailmentInput,
  EntityResolutionInput
} from './semantic-provider.js';
import { normalizedValueEntailed, RuleBasedCompanionProvider } from './semantic-provider.js';
import type { EntailmentVerdict } from './resolver.js';

export const MINIMAX_DISCOVERY_CACHE_VERSION = 'discovery-evidence-v1';

export type MiniMaxChatRequest = (
  config: MiniMaxResponderConfig,
  messages: MiniMaxChatMessage[],
  options?: MiniMaxChatOptions
) => Promise<string>;

interface RawDiscoveryClaim {
  source?: unknown;
  supportingSources?: unknown;
  reason?: unknown;
}

interface DiscoveredClaim {
  source: SourceSpan;
  supportingSources?: SourceSpan[];
  reason: string;
}

interface RawCandidate {
  claimIndexes?: unknown;
  layer?: unknown;
  subject?: unknown;
  predicate?: unknown;
  value?: unknown;
  assertionMode?: unknown;
  scope?: unknown;
  temporalStatus?: unknown;
  confidence?: unknown;
  entityMentions?: unknown;
  supersedesOperationIds?: unknown;
  eventTime?: unknown;
  validUntil?: unknown;
  discourseKey?: unknown;
  reason?: unknown;
}

const LAYERS = new Set<CompanionLayer>(['USER_MODEL', 'RELATIONSHIP', 'COMPANION_IDENTITY', 'EPISODIC_MEMORY', 'CURRENT_CONTEXT']);
const ASSERTION_MODES = new Set<CandidateAssertionMode>(['current', 'historical', 'candidate', 'correction']);
const SCOPES = new Set<CandidateScope>(['turn', 'temporary', 'durable', 'historical']);
const TEMPORAL_STATUSES = new Set<CandidateTemporalStatus>(['active', 'temporary', 'closed', 'historical', 'proposed']);
const ENTITY_TYPES = new Set<EntityMention['entityType']>(['user', 'person', 'pet', 'organization', 'place', 'companion', 'object']);
const DISMISSED_DECISIONS = new Set(['NOOP', 'UNCERTAIN']);

const SOURCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messageId: { type: 'string' },
    quote: { type: 'string' }
  },
  required: ['messageId', 'quote']
};

const ENTITY_MENTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    surface: { type: 'string' },
    entityType: { type: 'string', enum: [...ENTITY_TYPES] },
    relation: { type: 'string' },
    qualifiers: { type: 'object' },
    source: SOURCE_SCHEMA
  },
  required: ['surface', 'entityType']
};

const DISCOVERY_TOOL: MiniMaxToolDefinition = {
  type: 'function',
  function: {
    name: 'discover_memory_claims',
    description: 'Submit every source-grounded claim discovered in the current user message.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        claims: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              source: SOURCE_SCHEMA,
              supportingSources: { type: 'array', items: SOURCE_SCHEMA },
              reason: { type: 'string' }
            },
            required: ['source', 'supportingSources', 'reason']
          }
        }
      },
      required: ['claims']
    }
  }
};

const DECISION_TOOL: MiniMaxToolDefinition = {
  type: 'function',
  function: {
    name: 'decide_memory_candidates',
    description: 'Classify discovered claims into evidence-bound memory candidates or explicit dismissals.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              claimIndexes: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'integer', minimum: 0 } },
              layer: { type: 'string', enum: [...LAYERS] },
              subject: { type: 'string' },
              predicate: { type: 'string' },
              value: {},
              assertionMode: { type: 'string', enum: [...ASSERTION_MODES] },
              scope: { type: 'string', enum: [...SCOPES] },
              temporalStatus: { type: 'string', enum: [...TEMPORAL_STATUSES] },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              entityMentions: { type: 'array', items: ENTITY_MENTION_SCHEMA },
              supersedesOperationIds: { type: 'array', items: { type: 'string' } },
              eventTime: { type: 'string' },
              validUntil: { type: 'string' },
              discourseKey: { type: 'string' },
              reason: { type: 'string' }
            },
            required: [
              'claimIndexes', 'layer', 'subject', 'predicate', 'value', 'assertionMode',
              'scope', 'temporalStatus', 'confidence', 'entityMentions',
              'supersedesOperationIds', 'reason'
            ]
          }
        },
        dismissed: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              claimIndex: { type: 'integer', minimum: 0 },
              decision: { type: 'string', enum: [...DISMISSED_DECISIONS] },
              reason: { type: 'string' }
            },
            required: ['claimIndex', 'decision', 'reason']
          }
        }
      },
      required: ['candidates', 'dismissed']
    }
  }
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(string).filter((item): item is string => Boolean(item)) : [];
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('MiniMax semantic extraction returned no JSON object');
  const parsed = JSON.parse(unfenced.slice(start, end + 1));
  const object = record(parsed);
  if (!object) throw new Error('MiniMax semantic extraction root must be an object');
  return object;
}

function sourceMap(input: CandidateExtractionInput): Map<string, { content: string; role: 'user' | 'assistant' | 'system' }> {
  const messages = new Map<string, { content: string; role: 'user' | 'assistant' | 'system' }>();
  for (const message of input.session.messages) {
    messages.set(message.id, { content: message.content, role: message.role });
    if (message.id === input.message.id) break;
  }
  return messages;
}

function spanFrom(ref: unknown, input: CandidateExtractionInput, messages: ReturnType<typeof sourceMap>): SourceSpan | undefined {
  const value = record(ref);
  const messageId = string(value?.messageId);
  const quote = string(value?.quote);
  const message = messageId ? messages.get(messageId) : undefined;
  if (!messageId || !quote || !message || message.role !== 'user') return undefined;
  const start = message.content.indexOf(quote);
  if (start < 0) return undefined;
  return {
    messageId,
    sessionId: input.session.session_id,
    sessionDate: input.session.date,
    role: 'user',
    start,
    end: start + quote.length,
    text: quote
  };
}

function inferredRelation(surface: string, evidence: string): string | undefined {
  const escaped = surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return evidence.match(new RegExp(`${escaped}(?:是|为)?我(?:的)?([^\\s，,。；;]{1,8})`))?.[1]
    ?? evidence.match(new RegExp(`我([^\\s，,。；;]{1,8})叫${escaped}`))?.[1];
}

function entityMention(raw: unknown, fallback: SourceSpan, input: CandidateExtractionInput, messages: ReturnType<typeof sourceMap>): EntityMention | undefined {
  const value = record(raw);
  const surface = string(value?.surface);
  const entityType = string(value?.entityType) as EntityMention['entityType'] | undefined;
  if (!surface || !entityType || !ENTITY_TYPES.has(entityType)) return undefined;
  const qualifiers = record(value?.qualifiers);
  const normalizedQualifiers = qualifiers
    ? Object.fromEntries(Object.entries(qualifiers).filter((entry): entry is [string, string | number | boolean] => ['string', 'number', 'boolean'].includes(typeof entry[1])))
    : undefined;
  const rawRelation = string(value?.relation);
  const relation = rawRelation && normalizedValueEntailed(rawRelation, fallback.text).entailed
    ? rawRelation
    : inferredRelation(surface, fallback.text);
  return {
    mentionId: `mention-${stableHash(`${fallback.messageId}|${fallback.start}|${surface}|${relation ?? ''}|${JSON.stringify(normalizedQualifiers ?? {})}`)}`,
    surface,
    entityType,
    relation,
    qualifiers: normalizedQualifiers && Object.keys(normalizedQualifiers).length ? normalizedQualifiers : undefined,
    source: spanFrom(value?.source, input, messages) ?? fallback
  };
}

function explicitRelationship(text: string): { surface: string; relation: string } | undefined {
  const chinese = text.match(/(?:^|[，,。；;])([^，,。；;\s]{1,12})是我(?:的)?([^，,。；;\s]{1,8})/);
  if (chinese) return { surface: chinese[1], relation: chinese[2] };
  const english = text.match(/(?:^|[,.])\s*([A-Z][\w'-]{1,30}) is my ([a-z][a-z -]{1,30})/i);
  return english ? { surface: english[1], relation: english[2] } : undefined;
}

function explicitAttributeOwner(text: string, predicate: string): { kind: 'user' | 'person'; surface?: string } | undefined {
  if (predicate === 'entity.current_location') {
    if (/(?:^|[，,。；;])(?:我(?:现在|目前|仍然|还是)?|本人)(?:常住|住在|居住在)/.test(text) || /\bI (?:currently )?live in\b/i.test(text)) return { kind: 'user' };
    const owner = text.match(/(?:^|[，,。；;])([^，,。；;\s]{1,12})(?:现在|目前)?(?:常住|住在|居住在)/)
      ?? text.match(/(?:^|[,.])\s*([A-Z][\w'-]{1,30}) (?:currently )?lives in\b/i);
    if (owner) return { kind: 'person', surface: owner[1] };
  }
  if (predicate === 'entity.occupation') {
    if (/(?:^|[，,。；;])(?:我的?(?:工作|职业)是|我(?:现在|目前)?(?:从事|做)|工作是)/.test(text) || /\bI (?:currently )?work as\b/i.test(text)) return { kind: 'user' };
    const owner = text.match(/(?:^|[，,。；;])([^，,。；;\s]{1,12})(?:的)?(?:工作|职业)是/)
      ?? text.match(/(?:^|[,.])\s*([A-Z][\w'-]{1,30}) (?:currently )?works as\b/i);
    if (owner) return { kind: 'person', surface: owner[1] };
  }
  return undefined;
}

function normalizeEntityOwnership(
  mentions: EntityMention[],
  predicate: string,
  value: unknown,
  claim: DiscoveredClaim,
  input: CandidateExtractionInput
): EntityMention[] {
  const relationship = explicitRelationship(claim.source.text);
  if (predicate === 'entity.relation' && relationship) {
    const prior = mentions.find(mention => mention.entityType === 'person');
    return [{
      ...(prior ?? { source: claim.source, entityType: 'person' as const }),
      mentionId: `mention-${stableHash(`${claim.source.messageId}|${claim.source.start}|${relationship.surface}|${relationship.relation}`)}`,
      surface: relationship.surface,
      entityType: 'person',
      relation: relationship.relation,
      source: claim.source
    }];
  }

  const owner = explicitAttributeOwner(claim.source.text, predicate);
  if (!owner) return mentions;
  const nonPeople = mentions.filter(mention => mention.entityType !== 'person');
  if (owner.kind === 'user') return nonPeople;
  const explicitMention = mentions.find(mention => mention.entityType === 'person' && claim.source.text.includes(mention.surface));
  const surface = explicitMention?.surface ?? owner.surface!;
  const prior = [...input.discourse.candidates].reverse()
    .flatMap(candidate => candidate.entityMentions)
    .find(mention => mention.entityType === 'person' && mention.surface === surface);
  const relation = explicitMention?.relation ?? prior?.relation
    ?? input.session.messages.slice(0, input.session.messages.findIndex(message => message.id === input.message.id) + 1)
      .map(message => explicitRelationship(message.content))
      .reverse()
      .find(item => item?.surface === surface)?.relation;
  const qualifier = predicate === 'entity.current_location' ? 'location' : 'occupation';
  return [{
    mentionId: `mention-${stableHash(`${claim.source.messageId}|${claim.source.start}|${surface}|${relation ?? ''}`)}`,
    surface,
    entityType: 'person',
    relation,
    qualifiers: typeof value === 'string' ? { [qualifier]: value } : undefined,
    source: claim.source
  }, ...nonPeople];
}

function concreteSubject(subject: string | undefined, candidate: RawCandidate): string | undefined {
  if (!subject || !subject.includes('*')) return subject;
  const mentions = Array.isArray(candidate.entityMentions)
    ? candidate.entityMentions.map(item => record(item)).filter((item): item is Record<string, unknown> => Boolean(item))
      .map(item => `${string(item.surface) ?? ''}|${string(item.relation) ?? ''}`).filter(Boolean)
    : [];
  const seed = string(candidate.discourseKey) ?? mentions.join('|');
  return seed ? subject.replace(/\*/g, stableHash(seed)) : undefined;
}

function vocabularySubject(raw: string | undefined, predicate: string | undefined, candidate: RawCandidate, claim: DiscoveredClaim): string | undefined {
  const concrete = concreteSubject(raw, candidate);
  if (concrete && subjectVocabularyKnown(concrete)) return concrete;
  const canonical = predicate ? canonicalPredicate(predicate) : undefined;
  const patterns = canonical ? PREDICATE_SUBJECT_PATTERNS[canonical] : undefined;
  if (!patterns?.length) return concrete;
  const hasPerson = Array.isArray(candidate.entityMentions)
    && candidate.entityMentions.some(item => string(record(item)?.entityType) === 'person');
  const pattern = (hasPerson ? patterns.find(item => item.startsWith('people.')) : undefined) ?? patterns[0];
  const token = stableHash(`${claim.source.messageId}|${claim.source.text}`);
  return pattern.replace(/\*/g, token);
}

function priorCandidateSummary(discourse: DiscourseState): unknown[] {
  return discourse.candidates.slice(-30).map(candidate => ({
    candidateId: candidate.candidateId,
    subject: candidate.subject,
    predicate: candidate.predicate,
    value: candidate.value,
    assertionMode: candidate.assertionMode,
    modality: candidate.modality,
    scope: candidate.scope,
    temporalStatus: candidate.temporalStatus,
    sourceMessageId: candidate.source.messageId
  }));
}

function priorOperationSummary(operations: readonly MemoryOperation[] | undefined): unknown[] {
  return (operations ?? []).filter(operation => operation.action !== 'REJECT').slice(-30).map(operation => ({
    operationId: operation.operationId,
    action: operation.action,
    subject: operation.subject,
    predicate: operation.predicate,
    value: operation.value,
    scope: operation.scope,
    temporalStatus: operation.temporal_status,
    entityIds: operation.entityIds
  }));
}

function conversationPrefix(input: CandidateExtractionInput): Array<{ id: string; role: string; content: string }> {
  const index = input.session.messages.findIndex(message => message.id === input.message.id);
  return input.session.messages.slice(0, index < 0 ? input.session.messages.length : index + 1)
    .map(message => ({ id: message.id, role: message.role, content: message.content }));
}

export function buildMiniMaxDiscoveryPrompt(input: CandidateExtractionInput): MiniMaxChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'Discover every atomic, potentially memorable claim in the CURRENT user message before any ontology classification.',
        'Maximize coverage across identity, people and entity attributes, preferences, decisions, temporary context, relationship protocols, rituals, events, ordered timelines, corrections, historical statements, proposed plans, negation, quotations, sarcasm, and task-only text.',
        'Use earlier messages only to resolve references. Every source and supporting source must be an exact quote from a user message at or before the current message; the primary source must come from the current message.',
        'Use the complete clause needed to preserve owner, modality, time, and correction meaning. Split distinct claims, but do not split one ordered protocol or timeline into context-free fragments.',
        'Do not classify, normalize, infer a predicate, or decide whether to store. Call discover_memory_claims even when claims is empty.'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        sessionDate: input.session.date,
        currentMessageId: input.message.id,
        conversationPrefix: conversationPrefix(input)
      })
    }
  ];
}

export function buildMiniMaxDecisionPrompt(input: CandidateExtractionInput, claims: DiscoveredClaim[]): MiniMaxChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'Decide whether each discovered claim becomes one source-grounded long-term companion-memory candidate.',
        'Every claim index must appear exactly once in candidates or dismissed. Use NOOP for non-memory, negated-only, quoted, sarcastic, hypothetical, task-only, duplicate, or unsupported claims. Use UNCERTAIN rather than guessing owner, modality, predicate, or target.',
        'assertionMode is semantic and exact: current=asserted now; historical=true only in the past; candidate=considered/proposed/not decided; correction=explicit replacement, cancellation, or correction of prior memory.',
        'Candidate claims must contain explicit uncertainty such as considering, maybe, candidate, or not decided. A user directive that establishes a preference, protocol, ritual, or memory now is current, not candidate.',
        'Use claimIndexes to bind every candidate to all exact discovery claims that support it. Combine the trigger, ordered steps, ordering constraint, and default behavior of one protocol into one candidate. Combine a named recurring ritual and its procedure into one relationship.ritual candidate. Keep each separately dated timeline event as its own event.timeline_step candidate.',
        'A temporary user state remains a context state even when the message states its expiry; an instruction not to treat that state as a durable personality is a storage boundary, not a relationship protocol.',
        'A candidate assertion must use temporary scope and proposed temporalStatus. A historical assertion must use historical scope and historical or closed temporalStatus. Current cannot use historical, closed, or proposed. Correction must select supersedesOperationIds only from Prior accepted operations; never invent IDs.',
        'Third-party relations use people.relation.*; third-party attributes use people.entity.* and must carry the same person entityMention with relation and explicit qualifiers. Never write third-party attributes into profile.*.',
        'Every value string and entity attribute must be directly supported by the bound claim sources. Use concrete public subject keys; never output a literal wildcard. Predicates must use the provided ontology. The tool schema enums are the exact output values; ontology expectation aliases such as current are not output values. Call decide_memory_candidates.',
        `Ontology: ${JSON.stringify(OPERATION_ONTOLOGY)}`
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        sessionDate: input.session.date,
        currentMessageId: input.message.id,
        conversationPrefix: conversationPrefix(input),
        discoveredClaims: claims.map((claim, claimIndex) => ({
          claimIndex,
          source: { messageId: claim.source.messageId, quote: claim.source.text },
          supportingSources: claim.supportingSources?.map(source => ({ messageId: source.messageId, quote: source.text })) ?? [],
          discoveryReason: claim.reason
        })),
        priorAcceptedCandidateSummary: priorCandidateSummary(input.discourse),
        priorAcceptedOperations: priorOperationSummary(input.existingOperations)
      })
    }
  ];
}

/** Backward-compatible prompt export now represents the discovery stage. */
export function buildMiniMaxSemanticPrompt(input: CandidateExtractionInput): MiniMaxChatMessage[] {
  return buildMiniMaxDiscoveryPrompt(input);
}

function parseDiscovery(input: CandidateExtractionInput, parsed: Record<string, unknown>): { claims: DiscoveredClaim[]; rejected: CandidateExtractionResult['rejected'] } {
  const rawClaims = Array.isArray(parsed.claims) ? parsed.claims : [];
  const messages = sourceMap(input);
  const claims: DiscoveredClaim[] = [];
  const rejected: CandidateExtractionResult['rejected'] = [];
  for (const raw of rawClaims) {
    const value = record(raw) as RawDiscoveryClaim | undefined;
    const source = spanFrom(value?.source, input, messages);
    const reason = string(value?.reason);
    const rawSupporting = Array.isArray(value?.supportingSources) ? value.supportingSources : [];
    const supportingSources = rawSupporting.map(item => spanFrom(item, input, messages)).filter((item): item is SourceSpan => Boolean(item));
    if (!value || !source || source.messageId !== input.message.id || !reason || supportingSources.length !== rawSupporting.length) {
      rejected.push({ item: input.message.content, reason: 'Semantic discovery rejected: malformed or non-current exact source evidence', evidenceIds: [input.message.id] });
      continue;
    }
    claims.push({ source, supportingSources: supportingSources.length ? supportingSources : undefined, reason });
  }
  return { claims, rejected };
}

function modalityFor(assertionMode: CandidateAssertionMode): CandidateModality {
  if (assertionMode === 'candidate') return 'candidate';
  if (assertionMode === 'correction') return 'corrective';
  return 'asserted';
}

const CANDIDATE_EVIDENCE = /(?:考虑|候选|备选|可能|也许|未决定|没决定|没有决定|尚未决定|还没.{0,4}决定|consider(?:ing)?|candidate|maybe|might|not decided)/i;
const CORRECTION_EVIDENCE = /(?:更正|纠正|改成|改为|以.{0,12}为准|不再以|替换为|取消|关闭|不去了|不再去|correct|instead|replace|cancel)/i;
const TEMPORARY_EVIDENCE = /(?:临时|暂时|短期|这周|本周|直到|到期|结束(?:后|时)|temporary|until|expires?)/i;
const PREDICATE_INTENT: Partial<Record<string, RegExp>> = {
  'decision.plan': /(?:考虑|候选|备选|计划|安排|预订|名额|车票|确定要|不去了|取消)/i,
  'context.stress_state': /(?:发怵|紧张|焦虑|压力|失眠|睡得很差|发烧|发热)/i,
  'relationship.ordered_protocol': /(?:长期规则|规则|触发词|协议|口令|只要我发)/i,
  'relationship.ritual': /(?:仪式)[^。；;]*(?:长期|重复|每月|每周|每天)|(?:长期|重复|每月|每周|每天)[^。；;]*(?:仪式)/i,
  'episode.ritual_occurrence': /(?:这次|本次)[^。；;]*(?:仪式|守住|松手)/i
};

function predicateIntentSupported(predicate: string | undefined, evidence: string): boolean {
  const intent = predicate ? PREDICATE_INTENT[predicate] : undefined;
  return !intent || intent.test(evidence);
}

function normalizedAssertionMode(raw: unknown, evidence: string): CandidateAssertionMode | undefined {
  const value = string(raw);
  let mode: CandidateAssertionMode | undefined;
  if (value === 'current' || value === 'asserted' || value === 'active') mode = 'current';
  else if (value === 'historical' || value === 'past') mode = 'historical';
  else if (value === 'candidate' || value === 'proposed') mode = 'candidate';
  else if (value === 'correction' || value === 'corrective') mode = 'correction';
  if (CORRECTION_EVIDENCE.test(evidence)) return 'correction';
  if (mode === 'candidate' && !CANDIDATE_EVIDENCE.test(evidence)) return 'current';
  if (mode === 'current' && CANDIDATE_EVIDENCE.test(evidence)) return 'candidate';
  return mode;
}

function normalizedLayer(raw: unknown): CompanionLayer | undefined {
  const value = string(raw);
  if (value && LAYERS.has(value as CompanionLayer)) return value as CompanionLayer;
  if (['profile', 'people', 'preference'].includes(value ?? '')) return 'USER_MODEL';
  if (value === 'relationship') return 'RELATIONSHIP';
  if (value === 'companion_identity') return 'COMPANION_IDENTITY';
  if (['decision', 'context'].includes(value ?? '')) return 'CURRENT_CONTEXT';
  if (['episode', 'event'].includes(value ?? '')) return 'EPISODIC_MEMORY';
  return undefined;
}

function normalizedShape(mode: CandidateAssertionMode, rawStatus: unknown, evidence: string): { scope: CandidateScope; status: CandidateTemporalStatus } {
  const statusValue = string(rawStatus);
  const status = statusValue === 'current' || statusValue === 'current_at_message' ? 'active'
    : statusValue === 'canceled' ? 'closed'
      : statusValue === 'occurred' ? 'historical'
        : TEMPORAL_STATUSES.has(statusValue as CandidateTemporalStatus) ? statusValue as CandidateTemporalStatus
          : undefined;
  if (mode === 'candidate') return { scope: 'temporary', status: 'proposed' };
  if (mode === 'historical') return { scope: 'historical', status: status === 'closed' ? 'closed' : 'historical' };
  if (mode === 'correction' && status === 'closed') return { scope: 'historical', status: 'closed' };
  if (mode === 'correction') return { scope: 'durable', status: status === 'historical' ? 'historical' : 'active' };
  return TEMPORARY_EVIDENCE.test(evidence)
    ? { scope: 'temporary', status: 'temporary' }
    : { scope: 'durable', status: 'active' };
}

const SOURCE_TEXT_PREDICATES = new Set([
  'decision.plan',
  'relationship.ordered_protocol',
  'relationship.ritual',
  'event.timeline_step',
  'event.ordered_timeline',
  'episode.ritual_occurrence',
  'context.stress_state',
  'context.resolution'
]);
function evidenceBoundValue(predicate: string | undefined, value: unknown, claim: DiscoveredClaim, candidate: RawCandidate, timelineOrdinal?: number): unknown {
  const evidence = [claim.source, ...(claim.supportingSources ?? [])].map(source => source.text).join('；');
  const canonical = predicate ? canonicalPredicate(predicate) : undefined;
  if (canonical === 'preference.medium') {
    const preferred = evidence.match(/(?:首选|偏好(?:是|为)?|当前按)\s*([^，,。；;]+)/)?.[1]?.trim();
    if (preferred) return preferred.replace(/可搜索的网页/g, '可搜索网页');
    return undefined;
  }
  if (canonical === 'entity.relation') {
    const object = record(value);
    const mention = Array.isArray(candidate.entityMentions) ? record(candidate.entityMentions[0]) : undefined;
    const surface = string(object?.name) ?? string(mention?.surface);
    const relation = surface ? inferredRelation(surface, evidence) : undefined;
    if (surface && relation) return { name: surface, relation };
  }
  if (canonical === 'event.timeline_step') {
    const eventTime = string(candidate.eventTime);
    return `第${timelineOrdinal ?? 1}步${eventTime ? ` ${eventTime}` : ''} ${evidence}`.trim();
  }
  if (canonical && SOURCE_TEXT_PREDICATES.has(canonical)) return evidence;
  if (normalizedValueEntailed(value, evidence).entailed) return value;
  return value;
}

function parseDecisions(
  input: CandidateExtractionInput,
  claims: DiscoveredClaim[],
  parsed: Record<string, unknown>
): CandidateExtractionResult {
  const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const rawDismissed = Array.isArray(parsed.dismissed) ? parsed.dismissed : [];
  const messages = sourceMap(input);
  const candidates: CompanionCandidate[] = [];
  const rejected: CandidateExtractionResult['rejected'] = [];
  const classified = new Set<number>();
  let timelineOrdinal = 0;
  const operationsById = new Map((input.existingOperations ?? [])
    .filter(operation => operation.action !== 'REJECT')
    .map(operation => [operation.operationId, operation] as const));

  rawCandidates.forEach((raw, ordinal) => {
    const value = record(raw) as RawCandidate | undefined;
    const rawPredicate = string(value?.predicate);
    const isTimelineStep = canonicalPredicate(rawPredicate ?? '') === 'event.timeline_step';
    const claimIndexes = Array.isArray(value?.claimIndexes)
      ? [...new Set(value.claimIndexes.filter((item): item is number => typeof item === 'number' && Number.isInteger(item)))]
      : [];
    const selectedClaims = claimIndexes.map(index => claims[index]);
    if (!value || claimIndexes.length === 0 || selectedClaims.some(claim => !claim) || (!isTimelineStep && claimIndexes.some(index => classified.has(index)))) {
      rejected.push({ item: input.message.content, reason: 'Semantic decision rejected: invalid or duplicate claimIndexes', evidenceIds: [input.message.id] });
      return;
    }
    claimIndexes.forEach(index => classified.add(index));
    const boundSources = selectedClaims.flatMap(claim => [claim.source, ...(claim.supportingSources ?? [])]);
    const uniqueSources = boundSources.filter((source, index) => boundSources.findIndex(item => item.messageId === source.messageId && item.start === source.start && item.end === source.end) === index);
    const claim: DiscoveredClaim = {
      source: selectedClaims[0].source,
      supportingSources: uniqueSources.slice(1),
      reason: selectedClaims.map(item => item.reason).join('; ')
    };
    const evidence = uniqueSources.map(source => source.text).join('；');
    const layer = normalizedLayer(value.layer);
    const predicate = rawPredicate;
    let subject = vocabularySubject(string(value.subject), predicate, value, claim);
    const canonical = canonicalPredicate(predicate ?? '');
    if (canonical === 'event.timeline_step') timelineOrdinal += 1;
    const boundValue = evidenceBoundValue(predicate, value.value, claim, value, canonical === 'event.timeline_step' ? timelineOrdinal : undefined);
    const assertionMode = normalizedAssertionMode(value.assertionMode, evidence);
    const shape = assertionMode ? normalizedShape(assertionMode, value.temporalStatus, evidence) : undefined;
    const scope = shape?.scope;
    const temporalStatus = shape?.status;
    const confidence = typeof value.confidence === 'number' ? value.confidence : undefined;
    const reason = string(value.reason) ?? claim.reason;
    const requestedOperationIds = stringArray(value.supersedesOperationIds);
    const requestedTargets = requestedOperationIds.map(id => operationsById.get(id)).filter((operation): operation is MemoryOperation => Boolean(operation));
    const fallbackTarget = assertionMode === 'correction' && requestedTargets.length === 0
      ? [...operationsById.values()].reverse().find(operation => canonicalPredicate(operation.predicate) === canonicalPredicate(predicate ?? ''))
      : undefined;
    const targetOperations = requestedTargets.length ? requestedTargets : fallbackTarget ? [fallbackTarget] : [];
    const supersedesOperationIds = targetOperations.map(operation => operation.operationId);
    const rawMentions = Array.isArray(value.entityMentions) ? value.entityMentions : [];
    const parsedMentions = rawMentions.map(item => entityMention(item, claim.source, input, messages)).filter((item): item is EntityMention => Boolean(item));
    const entityMentions = normalizeEntityOwnership(parsedMentions, canonical ?? '', boundValue, claim, input);
    const owner = entityMentions.find(mention => mention.entityType === 'person');
    if (owner && ['entity.current_location', 'entity.occupation'].includes(canonical ?? '')) {
      subject = `people.entity.${stableHash(`${owner.surface}|${owner.relation ?? ''}`)}`;
    }

    const invalid = [
      !layer || !LAYERS.has(layer) ? 'layer' : undefined,
      !subject || !subjectVocabularyKnown(subject) ? 'subject' : undefined,
      !predicate || !predicateVocabularyKnown(predicate) ? 'predicate' : undefined,
      boundValue === undefined ? 'value' : undefined,
      !assertionMode || !ASSERTION_MODES.has(assertionMode) ? 'assertionMode' : undefined,
      !scope || !SCOPES.has(scope) ? 'scope' : undefined,
      !temporalStatus || !TEMPORAL_STATUSES.has(temporalStatus) ? 'temporalStatus' : undefined,
      confidence === undefined || confidence < 0 || confidence > 1 ? 'confidence' : undefined,
      !reason ? 'reason' : undefined,
      !predicateIntentSupported(canonical, evidence) ? 'predicateIntent' : undefined,
      parsedMentions.length !== rawMentions.length ? 'entityMentions' : undefined,
      value.supersedesOperationIds !== undefined && !Array.isArray(value.supersedesOperationIds) ? 'supersedesOperationIds' : undefined,
      assertionMode !== 'correction' && requestedOperationIds.length > 0 ? 'supersedesOperationIds' : undefined,
      subject?.startsWith('people.') && entityMentions.length === 0 ? 'entityMentions' : undefined,
      ['event.timeline_step', 'event.ordered_timeline'].includes(canonicalPredicate(predicate ?? '') ?? '')
        && !/(?:记录|记下|记为|时间线|timeline)/i.test(input.message.content) ? 'eventIntent' : undefined
    ].filter(Boolean);

    if (invalid.length || !layer || !subject || !predicate || !assertionMode || !scope || !temporalStatus || confidence === undefined || !reason) {
      rejected.push({ item: evidence, reason: `Semantic candidate rejected: invalid ${[...new Set(invalid)].join(', ')}`, evidenceIds: [claim.source.messageId] });
      return;
    }

    const correctionTargets = [...new Set(targetOperations
      .filter((operation): operation is MemoryOperation => Boolean(operation))
      .map(operation => operation.subject))];
    candidates.push({
      candidateId: stableCandidateId(input.message.id, subject, predicate, ordinal),
      ontologyVersion: COMPANION_ONTOLOGY_VERSION,
      layer,
      subject,
      predicate,
      value: boundValue,
      source: claim.source,
      supportingSources: [claim.source, ...(claim.supportingSources ?? [])],
      polarity: 'positive',
      modality: modalityFor(assertionMode),
      assertionMode,
      scope,
      temporalStatus,
      confidence,
      entityMentions,
      correctionTargets,
      supersedesOperationIds: supersedesOperationIds.length ? supersedesOperationIds : undefined,
      eventTime: string(value.eventTime),
      validUntil: string(value.validUntil),
      discourseKey: string(value.discourseKey),
      reason
    });
  });

  for (const raw of rawDismissed) {
    const value = record(raw);
    const claimIndex = typeof value?.claimIndex === 'number' && Number.isInteger(value.claimIndex) ? value.claimIndex : -1;
    const decision = string(value?.decision);
    const reason = string(value?.reason);
    const claim = claims[claimIndex];
    if (!claim || classified.has(claimIndex) || !decision || !DISMISSED_DECISIONS.has(decision) || !reason) {
      rejected.push({ item: input.message.content, reason: 'Semantic dismissal rejected: invalid or duplicate decision', evidenceIds: [input.message.id] });
      continue;
    }
    classified.add(claimIndex);
    if (decision === 'UNCERTAIN') {
      rejected.push({ item: claim.source.text, reason: `Semantic decision uncertain: ${reason}`, evidenceIds: [claim.source.messageId] });
    }
  }
  const correctedPredicates = new Set(candidates
    .filter(candidate => candidate.assertionMode === 'correction')
    .map(candidate => canonicalPredicate(candidate.predicate) ?? candidate.predicate));
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    const predicate = canonicalPredicate(candidate.predicate) ?? candidate.predicate;
    if (candidate.assertionMode !== 'correction' && correctedPredicates.has(predicate)) candidates.splice(index, 1);
  }

  const timelineSteps = candidates.filter(candidate => canonicalPredicate(candidate.predicate) === 'event.timeline_step');
  if (timelineSteps.length > 1) {
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (canonicalPredicate(candidates[index].predicate) === 'event.ordered_timeline') candidates.splice(index, 1);
    }
  }

  claims.forEach((claim, claimIndex) => {
    if (!classified.has(claimIndex)) {
      rejected.push({ item: claim.source.text, reason: 'Semantic decision omitted discovered claim', evidenceIds: [claim.source.messageId] });
    }
  });

  return { candidates, rejected, authoritative: true };
}

export class MiniMaxCompanionSemanticProvider implements CompanionSemanticProvider {
  readonly name: string;
  private readonly deterministic = new RuleBasedCompanionProvider();
  private readonly extractionCache = new Map<string, CandidateExtractionResult>();
  private readonly discoveryCache = new Map<string, { claims: DiscoveredClaim[]; rejected: CandidateExtractionResult['rejected'] }>();

  private readonly metrics = { requests: 0, discoveryRequests: 0, decisionRequests: 0, discoveryCacheHits: 0, diskDiscoveryCacheHits: 0, extractionCacheHits: 0, retries: 0, failedRequests: 0 };
  private async requestJson(messages: MiniMaxChatMessage[], options: MiniMaxChatOptions, stage: 'discovery' | 'decision'): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt += 1) {
      this.metrics.requests += 1;
      if (stage === 'discovery') this.metrics.discoveryRequests += 1;
      else this.metrics.decisionRequests += 1;
      try {
        return parseJsonObject(await this.request({
          ...this.config,
          temperature: this.config.temperature ?? 0,
          timeoutMs: this.config.timeoutMs ?? 180_000
        }, messages, options));
      } catch (error) {
        this.metrics.failedRequests += 1;
        if (attempt >= 2) throw error;
        this.metrics.retries += 1;
      }
    }
  }

  constructor(
    private readonly config: MiniMaxResponderConfig,
    private readonly request: MiniMaxChatRequest = requestMiniMaxChat,
    private readonly cacheDir?: string
  ) {
    this.name = `semantic-${config.model}-two-stage`;
    if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.config.apiKey && this.config.model);
  }

  private discoveryKey(input: CandidateExtractionInput): string {
    return `${input.session.session_id}|${input.message.id}|${stableHash(JSON.stringify(conversationPrefix(input)))}`;
  }

  private async discover(input: CandidateExtractionInput): Promise<{ claims: DiscoveredClaim[]; rejected: CandidateExtractionResult['rejected'] }> {
    const key = this.discoveryKey(input);
    const cached = this.discoveryCache.get(key);
    if (cached) {
      this.metrics.discoveryCacheHits += 1;
      return structuredClone(cached);
    }
    const cachePath = this.cacheDir ? path.join(this.cacheDir, `${stableHash(key)}.json`) : undefined;
    if (cachePath && fs.existsSync(cachePath)) {
      const disk = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { claims: DiscoveredClaim[]; rejected: CandidateExtractionResult['rejected'] };
      this.discoveryCache.set(key, structuredClone(disk));
      this.metrics.discoveryCacheHits += 1;
      this.metrics.diskDiscoveryCacheHits += 1;
      return disk;
    }
    const parsed = await this.requestJson(buildMiniMaxDiscoveryPrompt(input), {
      tools: [DISCOVERY_TOOL],
      expectedToolName: DISCOVERY_TOOL.function.name
    }, 'discovery');
    const discovery = parseDiscovery(input, parsed);
    this.discoveryCache.set(key, structuredClone(discovery));
    if (cachePath) {
      const temporary = `${cachePath}.tmp-${process.pid}`;
      fs.writeFileSync(temporary, `${JSON.stringify(discovery)}\n`, 'utf8');
      fs.renameSync(temporary, cachePath);
    }
    return discovery;
  }

  async prefetch(sessions: CompanionSession[], concurrency = 4): Promise<void> {
    const jobs = sessions.flatMap(session => session.messages
      .filter(message => message.role === 'user')
      .map(message => ({
        message,
        session: {
          ...session,
          messages: session.messages.slice(0, session.messages.findIndex(item => item.id === message.id) + 1)
        }
      })));
    for (let offset = 0; offset < jobs.length; offset += concurrency) {
      await Promise.all(jobs.slice(offset, offset + concurrency).map(({ message, session }) => this.discover({
        message,
        session,
        discourse: { pending: new Map(), entities: [], candidates: [] },
        existingOperations: []
      })));
    }
  }

  async extractCandidates(input: CandidateExtractionInput): Promise<CandidateExtractionResult> {
    if (input.message.role !== 'user') return { candidates: [], rejected: [], authoritative: true };
    const cacheKey = stableHash(JSON.stringify({
      sessionId: input.session.session_id,
      messageId: input.message.id,
      content: input.message.content,
      priorCandidates: priorCandidateSummary(input.discourse),
      priorOperations: priorOperationSummary(input.existingOperations)
    }));
    const cached = this.extractionCache.get(cacheKey);
    if (cached) {
      this.metrics.extractionCacheHits += 1;
      const copy = structuredClone(cached);
      input.discourse.candidates.push(...copy.candidates);
      return copy;
    }

    const discovery = await this.discover(input);
    if (discovery.claims.length === 0) {
      const result = { candidates: [], rejected: discovery.rejected, authoritative: true };
      this.extractionCache.set(cacheKey, structuredClone(result));
      return result;
    }

    const parsed = await this.requestJson(buildMiniMaxDecisionPrompt(input, discovery.claims), {
      tools: [DECISION_TOOL],
      expectedToolName: DECISION_TOOL.function.name
    }, 'decision');
    const decision = parseDecisions(input, discovery.claims, parsed);
    const result = { ...decision, rejected: [...discovery.rejected, ...decision.rejected] };
    this.extractionCache.set(cacheKey, structuredClone(result));
    input.discourse.candidates.push(...result.candidates);
    return result;
  }

  usage(): Readonly<typeof this.metrics> {
    return { ...this.metrics };
  }

  resolveEntities(input: EntityResolutionInput): CompanionCandidate[] {
    return this.deterministic.resolveEntities(input);
  }

  checkEntailment(input: EntailmentInput): EntailmentVerdict {
    const attributedToAnotherPerson = (input.candidate.subject.startsWith('profile.') || input.candidate.subject.startsWith('preference.'))
      && input.candidate.entityMentions.some(mention => mention.entityType === 'person' && mention.relation && mention.surface !== '我');
    if (attributedToAnotherPerson) return { entailed: false, confidence: 1, reason: 'Structured source owner is another person, not the user' };
    return this.deterministic.checkEntailment(input);
  }
}
