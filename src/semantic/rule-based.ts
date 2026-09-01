import { SemanticProvider, TraitMatchDecision } from './interface.js';
import { CanonicalEvent } from '../normalize/canonical-event.js';
import { SessionDigest } from '../normalize/session-digest.js';
import { EvidenceCandidate, extractCandidatesFromSession } from '../evidence/extract.js';
import { Trait } from '../traits/schema.js';
import { EvidenceEventRow } from '../storage/sqlite.js';
import { checkScopeSplit, generateDeterministicTraitId } from '../traits/scope-split.js';

export class RuleBasedProvider implements SemanticProvider {
  readonly name = 'rule-based';

  public async isAvailable(): Promise<boolean> {
    return true;
  }

  public async extractEvidence(
    digest: SessionDigest,
    events: CanonicalEvent[]
  ): Promise<EvidenceCandidate[]> {
    return extractCandidatesFromSession(digest.adapter, events, digest);
  }

  public async matchEvidenceToTraits(
    evidence: EvidenceCandidate,
    existingTraits: Trait[]
  ): Promise<TraitMatchDecision> {
    const scope = evidence.scope || 'global';
    const expectedTraitId = generateDeterministicTraitId(evidence.category, scope, evidence.canonical_key);

    const sameCategoryTraits = existingTraits.filter(t => t.category === evidence.category);

    // 1. Check for scope split with existing global traits
    for (const t of sameCategoryTraits) {
      if (t.scope === 'global') {
        const splitCheck = checkScopeSplit(t, evidence);
        if (splitCheck.isSplit && splitCheck.splitTraits) {
          const matchingSplit = splitCheck.splitTraits.find(st => st.scope === scope) || splitCheck.splitTraits[0];
          return {
            type: 'scope_variant',
            traitId: t.id,
            scope: matchingSplit.scope,
            statement: matchingSplit.statement,
            reason: splitCheck.reason
          };
        }
      }
    }

    // 2. Check for exact deterministic ID match
    const exactMatch = sameCategoryTraits.find(t => t.id === expectedTraitId);
    if (exactMatch) {
      return {
        type: 'support',
        traitId: exactMatch.id,
        reason: 'Exact canonical key and scope match'
      };
    }

    // 3. Check for statement similarity
    const similarMatch = sameCategoryTraits.find(t => t.scope === scope && this.isSimilar(t.statement, evidence.statement));
    if (similarMatch) {
      return {
        type: 'support',
        traitId: similarMatch.id,
        reason: 'Semantic statement similarity match'
      };
    }

    // 4. Genuinely new trait
    return {
      type: 'new_trait',
      statement: evidence.statement,
      category: evidence.category,
      scope,
      canonical_key: evidence.canonical_key,
      reason: 'No existing trait matches this pattern'
    };
  }

  public async synthesizeTrait(
    evidence: EvidenceEventRow[],
    existingTrait?: Trait
  ): Promise<string> {
    if (existingTrait) return existingTrait.statement;
    if (evidence.length > 0) return evidence[0].statement;
    return 'User trait';
  }

  private isSimilar(a: string, b: string): boolean {
    const normA = a.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
    const normB = b.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
    if (normA === normB) return true;
    if (normA.includes(normB) || normB.includes(normA)) return true;
    return false;
  }
}
