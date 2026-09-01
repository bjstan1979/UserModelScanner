import type { MemoryOperation } from './schema.js';
import { RuleBasedProvider } from '../semantic/rule-based.js';
import {
  CompanionCandidate,
  CompanionEntity,
  DiscourseState,
  stableHash
} from './ontology.js';
import type { CompanionMessage, CompanionSession } from './engine.js';
import {
  CandidateExtractionResult,
  extractCandidatesFromMessage
} from './candidate-extractor.js';
import type { EntailmentVerdict } from './resolver.js';

export type MaybePromise<T> = T | Promise<T>;

export interface CandidateExtractionInput {
  message: CompanionMessage;
  session: CompanionSession;
  discourse: DiscourseState;
  existingOperations?: readonly MemoryOperation[];
}

export interface EntityResolutionInput {
  candidates: CompanionCandidate[];
  existingEntities: ReadonlyMap<string, CompanionEntity>;
}

export interface EntailmentInput {
  candidate: CompanionCandidate;
  sourceMessages: ReadonlyMap<string, string>;
}

export interface CompanionSemanticProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  extractCandidates(input: CandidateExtractionInput): MaybePromise<CandidateExtractionResult>;
  resolveEntities(input: EntityResolutionInput): MaybePromise<CompanionCandidate[]>;
  checkEntailment(input: EntailmentInput): MaybePromise<EntailmentVerdict>;
}

const NORMALIZED_TOKEN_SUPPORT: Record<string, string[]> = {
  active: [],
  historical: ['过去', '以前', '曾经', '历史'],
  temporary: ['临时', '最近', '这周', '短期'],
  closed: ['结束', '取消', '作废', '恢复', '关闭', '完成'],
  proposed: ['候选', '考虑', '可能', '还没有做决定', '未决定'],
  candidate: ['候选', '考虑', '可能'],
  canceled: ['取消', '作废', '不再有效', '不去了'],
  annual: ['每年', '一年一次'],
  only: ['只', '仅', '唯一'],
  timeline_step: [],
  relocation: ['搬', '迁'],
  none: ['无', '不含'],
  low: ['低因', '低咖啡因'],
  oat: ['燕麦奶'],
  not_iced: ['非冰', '不加冰', '温热']
};

function scalarStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [];
  if (Array.isArray(value)) return value.flatMap(scalarStrings);
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(scalarStrings);
  return [];
}

function tokenSupported(token: string, evidence: string): boolean {
  if (!token) return true;
  if (evidence.includes(token)) return true;
  const alternatives = NORMALIZED_TOKEN_SUPPORT[token];
  return alternatives !== undefined && (alternatives.length === 0 || alternatives.some(item => evidence.includes(item)));
}

export function normalizedValueEntailed(value: unknown, evidence: string): { entailed: boolean; unsupported: string[] } {
  const unsupported = scalarStrings(value)
    .filter(token => token.length > 1)
    .filter(token => !tokenSupported(token, evidence));
  return { entailed: unsupported.length === 0, unsupported };
}

function validateSpans(candidate: CompanionCandidate, sourceMessages: ReadonlyMap<string, string>): EntailmentVerdict | undefined {
  const spans = candidate.supportingSources ?? [candidate.source];
  if (spans.length === 0) return { entailed: false, confidence: 1, reason: 'No source span' };
  for (const span of spans) {
    const source = sourceMessages.get(span.messageId);
    if (source === undefined) return { entailed: false, confidence: 1, reason: `Source message not found: ${span.messageId}` };
    if (span.start < 0 || span.end < span.start || source.slice(span.start, span.end) !== span.text) {
      return { entailed: false, confidence: 1, reason: `Source span mismatch: ${span.messageId}` };
    }
  }
  return undefined;
}

function rejectUnsupportedModality(candidate: CompanionCandidate): EntailmentVerdict | undefined {
  if (candidate.polarity === 'negative') {
    return { entailed: false, confidence: 1, reason: 'Explicit negation cannot create a positive fact' };
  }
  if (['quoted', 'sarcastic', 'task_only', 'hypothetical'].includes(candidate.modality)) {
    return { entailed: false, confidence: 1, reason: `${candidate.modality} content is not an asserted memory` };
  }
  if (candidate.modality === 'candidate' && candidate.temporalStatus !== 'proposed') {
    return { entailed: false, confidence: 1, reason: 'A candidate plan must remain proposed' };
  }
  if (candidate.temporalStatus === 'proposed' && candidate.layer === 'EPISODIC_MEMORY') {
    return { entailed: false, confidence: 1, reason: 'A proposed plan cannot be materialized as an episode' };
  }
  return undefined;
}

function rejectInconsistentAssertionMode(candidate: CompanionCandidate): EntailmentVerdict | undefined {
  if (!candidate.assertionMode) return undefined;
  if (candidate.assertionMode === 'candidate' && (candidate.modality !== 'candidate' || candidate.temporalStatus !== 'proposed')) {
    return { entailed: false, confidence: 1, reason: 'Candidate assertion mode must remain candidate/proposed' };
  }
  if (candidate.assertionMode === 'historical' && candidate.scope !== 'historical') {
    return { entailed: false, confidence: 1, reason: 'Historical assertion mode must remain historical scope' };
  }
  if (candidate.assertionMode === 'correction' && candidate.modality !== 'corrective') {
    return { entailed: false, confidence: 1, reason: 'Correction assertion mode must remain corrective' };
  }
  if (candidate.assertionMode === 'current' && ['historical', 'closed', 'proposed'].includes(candidate.temporalStatus)) {
    return { entailed: false, confidence: 1, reason: 'Current assertion mode cannot use historical, closed, or proposed status' };
  }
  return undefined;
}

function rejectAttributionError(candidate: CompanionCandidate, evidence: string): EntailmentVerdict | undefined {
  if (!candidate.subject.startsWith('profile.') && !candidate.subject.startsWith('preference.')) return undefined;
  const familyMarker = evidence.match(/(?:我)?(父亲|母亲|爸爸|妈妈|伴侣|同事|朋友)[^。；;]{0,24}/)?.[0];
  if (!familyMarker) return undefined;
  const values = scalarStrings(candidate.value).filter(value => value.length > 1);
  const attributedOnlyToOther = values.some(value => familyMarker.includes(value))
    && !values.some(value => new RegExp(`我(?:是|在|叫|喜欢|偏好|只选)[^。；;]{0,16}${value}`).test(evidence));
  return attributedOnlyToOther
    ? { entailed: false, confidence: 0.95, reason: 'Source attributes the value to another person, not the user' }
    : undefined;
}

export class RuleBasedCompanionProvider implements CompanionSemanticProvider {
  readonly name = 'companion-rule-based';
  private readonly scannerProvider = new RuleBasedProvider();

  async isAvailable(): Promise<boolean> {
    return this.scannerProvider.isAvailable();
  }

  extractCandidates(input: CandidateExtractionInput): CandidateExtractionResult {
    return extractCandidatesFromMessage(input.message, input.session, input.discourse);
  }

  resolveEntities(input: EntityResolutionInput): CompanionCandidate[] {
    return input.candidates.map(candidate => {
      const seen = new Set<string>();
      const entityMentions = candidate.entityMentions.filter(item => {
        const key = `${item.entityType}|${item.surface}|${item.relation ?? ''}|${stableHash(JSON.stringify(item.qualifiers ?? {}))}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { ...candidate, entityMentions };
    });
  }

  checkEntailment(input: EntailmentInput): EntailmentVerdict {
    const { candidate, sourceMessages } = input;
    const invalidSpan = validateSpans(candidate, sourceMessages);
    if (invalidSpan) return invalidSpan;
    const invalidModality = rejectUnsupportedModality(candidate);
    if (invalidModality) return invalidModality;
    const invalidAssertionMode = rejectInconsistentAssertionMode(candidate);
    if (invalidAssertionMode) return invalidAssertionMode;

    const spans = candidate.supportingSources ?? [candidate.source];
    const evidence = spans.map(span => span.text).join(' ');
    const attribution = rejectAttributionError(candidate, evidence);
    if (attribution) return attribution;

    const support = normalizedValueEntailed(candidate.value, evidence);
    if (!support.entailed) {
      return {
        entailed: false,
        confidence: 0.95,
        reason: `Normalized value is not entailed by source span: ${support.unsupported.join(', ')}`
      };
    }
    return { entailed: true, confidence: 0.98, reason: 'Source spans entail normalized candidate' };
  }
}

export function createCompanionSemanticProvider(): CompanionSemanticProvider {
  return new RuleBasedCompanionProvider();
}

export function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return Boolean(value && typeof (value as Promise<T>).then === 'function');
}
