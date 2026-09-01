import { buildSessionDigest } from '../normalize/session-digest.js';
import { triageSession } from '../evidence/extract.js';
import type { CanonicalEvent } from '../normalize/canonical-event.js';
import { canonicalPredicate, type CompanionCandidate } from './ontology.js';
import type { CandidateExtractionResult } from './candidate-extractor.js';
import {
  CompanionSemanticProvider,
  CandidateExtractionInput,
  EntityResolutionInput,
  EntailmentInput,
  RuleBasedCompanionProvider
} from './semantic-provider.js';
import type { EntailmentVerdict } from './resolver.js';
import { canonicalizeCompanionCandidates } from './canonicalizer.js';
const LIFECYCLE_SUPPLEMENTS = new Set([
  'decision.plan',
  'context.stress_state',
  'relationship.ordered_protocol',
  'relationship.ritual',
  'episode.ritual_occurrence'
]);

const DETERMINISTIC_FIRST = new Set([
  'identity.full_name',
  'entity.current_location',
  'entity.occupation',
  'entity.relation',
  'preference.medium',
  ...LIFECYCLE_SUPPLEMENTS
]);

const SEMANTIC_MEMORY_SIGNAL = /(?:我叫|我的名字|我[^。；;]{0,20}(?:住在|居住|工作|职业|偏好|喜欢|不喜欢|考虑|决定|临时|紧张|焦虑|压力)|(?:更正|纠正|取消|关闭)[^。；;]{0,24}(?:资料|状态|计划|偏好|记忆)|[^，,。；;\s]{1,12}是我(?:的)?(?:同事|朋友|家人|亲属|伴侣|兄弟|姐妹)|长期规则|规则是|协议|触发词|仪式|每月|每周|请记住|可以记住|长期偏好)/i;

function deterministicFirst(candidates: CompanionCandidate[]): boolean {
  return candidates.length > 0 && candidates.every(candidate => DETERMINISTIC_FIRST.has(canonicalPredicate(candidate.predicate) ?? ''));
}

function supplementalCandidates(fallback: CompanionCandidate[]): CompanionCandidate[] {
  const seen = new Set<string>();
  return fallback.filter(candidate => {
    const predicate = canonicalPredicate(candidate.predicate);
    if (!predicate || !LIFECYCLE_SUPPLEMENTS.has(predicate)) return false;
    const key = `${predicate}|${candidate.source.messageId}|${candidate.source.start}|${candidate.temporalStatus}|${candidate.modality}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function passesCompanionStageA(input: CandidateExtractionInput): boolean {
  const messageIndex = input.session.messages.findIndex(message => message.id === input.message.id);
  const prefix = input.session.messages.slice(0, messageIndex < 0 ? input.session.messages.length : messageIndex + 1);
  const events: CanonicalEvent[] = prefix.map(message => ({
    session_id: input.session.session_id,
    event_id: message.id,
    timestamp: `${input.session.date}T00:00:00.000Z`,
    project: input.session.topic || null,
    role: message.role,
    content: message.content
  }));
  return triageSession(buildSessionDigest(input.session.session_id, 'companion', events));
}

/** Original scanner flow: deterministic gate, semantic extraction, offline fallback and governance. */
export class HybridCompanionSemanticProvider implements CompanionSemanticProvider {
  readonly name: string;
  private readonly routing = { deterministicFirst: 0, definitiveNoop: 0, lowSignal: 0, stageAOrUnavailable: 0, semantic: 0 };

  constructor(
    private readonly semantic: CompanionSemanticProvider,
    private readonly offline: CompanionSemanticProvider = new RuleBasedCompanionProvider()
  ) {
    this.name = `hybrid-${semantic.name}`;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async extractCandidates(input: CandidateExtractionInput): Promise<CandidateExtractionResult> {
    const priorCount = input.discourse.candidates.length;
    const offline = await this.offline.extractCandidates(input);
    const canonicalOffline = canonicalizeCompanionCandidates(offline.candidates, input.discourse.candidates.slice(0, priorCount));
    const definitiveNoop = canonicalOffline.length === 0 && offline.rejected.length > 0;
    const lowSignal = canonicalOffline.length === 0 && !SEMANTIC_MEMORY_SIGNAL.test(input.message.content);
    const deterministic = deterministicFirst(canonicalOffline);
    const stageAOrUnavailable = !passesCompanionStageA(input) || !(await this.semantic.isAvailable());
    if (deterministic || definitiveNoop || lowSignal || stageAOrUnavailable) {
      if (deterministic) this.routing.deterministicFirst += 1;
      else if (definitiveNoop) this.routing.definitiveNoop += 1;
      else if (lowSignal) this.routing.lowSignal += 1;
      else this.routing.stageAOrUnavailable += 1;
      input.discourse.candidates.splice(priorCount, input.discourse.candidates.length - priorCount, ...canonicalOffline);
      return { ...offline, candidates: canonicalOffline, authoritative: definitiveNoop || lowSignal };
    }
    input.discourse.candidates.splice(priorCount);
    this.routing.semantic += 1;

    try {
      const semantic = await this.semantic.extractCandidates(input);
      if (semantic.candidates.length > 0 || semantic.authoritative) {
        const canonical = canonicalizeCompanionCandidates(semantic.candidates, input.discourse.candidates.slice(0, priorCount));
        input.discourse.candidates.splice(priorCount, input.discourse.candidates.length - priorCount, ...canonical);
        const fallback = await this.offline.extractCandidates(input);
        const rawSupplements = supplementalCandidates(fallback.candidates);
        const replacedPredicates = new Set(rawSupplements.map(candidate => canonicalPredicate(candidate.predicate)));
        const keptSemantic = canonical.filter(candidate => !replacedPredicates.has(canonicalPredicate(candidate.predicate)));
        const supplements = canonicalizeCompanionCandidates(
          rawSupplements,
          [...input.discourse.candidates.slice(0, priorCount), ...keptSemantic]
        );
        input.discourse.candidates.splice(priorCount, input.discourse.candidates.length - priorCount, ...keptSemantic, ...supplements);
        return {
          ...semantic,
          candidates: [...keptSemantic, ...supplements],
          rejected: [...semantic.rejected, ...fallback.rejected]
        };
      }
      input.discourse.candidates.splice(priorCount);
      const fallback = await this.offline.extractCandidates(input);
      return { candidates: fallback.candidates, rejected: [...semantic.rejected, ...fallback.rejected] };
    } catch {
      input.discourse.candidates.splice(priorCount);
      const fallback = await this.offline.extractCandidates(input);
      return {
        candidates: fallback.candidates,
        rejected: [
          { item: input.message.content, reason: 'Semantic extraction unavailable; offline fallback used', evidenceIds: [input.message.id] },
          ...fallback.rejected
        ]
      };
    }
  }

  routingUsage(): Readonly<typeof this.routing> {
    return { ...this.routing };
  }

  resolveEntities(input: EntityResolutionInput): CompanionCandidate[] | Promise<CompanionCandidate[]> {
    return this.semantic.resolveEntities(input);
  }

  checkEntailment(input: EntailmentInput): EntailmentVerdict | Promise<EntailmentVerdict> {
    return this.semantic.checkEntailment(input);
  }
}
