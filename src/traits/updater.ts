import { SQLiteStorage, TraitRow } from '../storage/sqlite.js';
import { EvidenceCandidate, TraitCategory } from '../evidence/extract.js';
import { Trait, TraitStatus, OntologyLevel } from './schema.js';
import { computeTraitScore } from './scorer.js';
import { checkScopeSplit, generateDeterministicTraitId } from './scope-split.js';
import { applyTimeDecay } from './decay.js';
import { classifyTraitOntology } from './ontology.js';

export class TraitUpdater {
  constructor(private storage: SQLiteStorage) {}

  public processCandidates(candidates: EvidenceCandidate[]): {
    created: Trait[];
    updated: Trait[];
    disputed: Trait[];
    scopeSplit: Trait[];
  } {
    const created: Trait[] = [];
    const updated: Trait[] = [];
    const disputed: Trait[] = [];
    const scopeSplit: Trait[] = [];

    for (const cand of candidates) {
      // 1. Pre-classify ontology to normalize statement, category, and scope
      const ontologyClass = classifyTraitOntology(
        cand.category,
        cand.statement,
        cand.scope || 'global',
        cand.context.project ? 1 : 0,
        1
      );

      const canonicalStatement = ontologyClass.statement;
      const canonicalCategory = ontologyClass.category;
      const scope = ontologyClass.scope;
      const expectedTraitId = generateDeterministicTraitId(canonicalCategory, scope, cand.canonical_key);

      const existingTraits = this.storage.getAllTraits().map(r => this.rowToTrait(r));
      const sameCategoryTraits = existingTraits.filter(t => t.category === canonicalCategory);

      // 2. Check for exact statement match or deterministic semantic similarity match
      let matchedTrait = sameCategoryTraits.find(
        t => t.statement === canonicalStatement ||
             t.id === expectedTraitId ||
             (t.scope === scope && this.isSimilar(t.statement, canonicalStatement, canonicalCategory))
      );

      if (matchedTrait) {
        const res = this.applyEvidenceToTrait(
          matchedTrait,
          cand,
          cand.signal_type === 'contradiction' ? 'contradict' : 'support',
          'Evidence confirmation'
        );
        if (res.status === 'disputed') disputed.push(res);
        else updated.push(res);
        continue;
      }

      // 3. Check if this candidate triggers a scope split with an existing un-scoped global trait
      let splitHandled = false;
      for (const existingTrait of sameCategoryTraits) {
        if (existingTrait.scope !== 'global') continue; // only split global traits
        const splitCheck = checkScopeSplit(existingTrait, cand);
        if (splitCheck.isSplit && splitCheck.splitTraits) {
          this.storage.deleteTrait(existingTrait.id);
          for (const st of splitCheck.splitTraits) {
            this.upsertAndLinkTrait(st, cand.id, `Scope split: ${splitCheck.reason}`);
            scopeSplit.push(st);
          }
          splitHandled = true;
          break;
        }
      }

      if (splitHandled) {
        continue;
      }

      // 4. Create new candidate trait with deterministic ID and classified ontology
      const newTrait = this.createNewTrait(expectedTraitId, canonicalCategory, canonicalStatement, scope, cand);
      created.push(newTrait);
    }

    return { created, updated, disputed, scopeSplit };
  }

  private applyEvidenceToTrait(
    trait: Trait,
    cand: EvidenceCandidate,
    relation: 'support' | 'contradict',
    reason: string
  ): Trait {
    this.storage.linkTraitEvidence(trait.id, cand.id, relation);

    const allEv = this.storage.getEvidenceForTrait(trait.id);
    const distinctSessions = new Set(allEv.map(e => e.source_session_id)).size;
    const distinctProjects = new Set(
      allEv.map(e => {
        try { return JSON.parse(e.context_json).project; } catch { return null; }
      }).filter(Boolean)
    ).size;
    const distinctFrameworks = new Set(
      allEv.map(e => {
        const row = this.storage.getEvidenceEvent(e.id);
        return row?.source_session_id ? row.source_session_id.split('_')[0] : null;
      }).filter(Boolean)
    ).size;

    const supportCount = allEv.filter(e => e.relation === 'support').length;
    const contradictionCount = allEv.filter(e => e.relation === 'contradict').length;

    const score = computeTraitScore({
      category: trait.category,
      supportCount,
      contradictionCount,
      distinctSessions,
      distinctContexts: distinctProjects,
      hasExplicitDeclaration: cand.signal_type === 'explicit_statement',
      currentStatus: trait.status
    });

    const ontologyClass = classifyTraitOntology(
      trait.category,
      trait.statement,
      trait.scope,
      distinctProjects,
      distinctFrameworks
    );

    const oldJson = JSON.stringify(trait);
    trait.confidence = score.confidence;
    trait.status = score.status;
    trait.ontology = ontologyClass.ontology;
    trait.domain = ontologyClass.domain;
    trait.tool = ontologyClass.tool;
    trait.environment = ontologyClass.environment;
    trait.project_id = ontologyClass.project_id;
    trait.portability_score = ontologyClass.portability_score;
    trait.statement = ontologyClass.statement;
    trait.support_count = supportCount;
    trait.contradiction_count = contradictionCount;
    trait.distinct_sessions = distinctSessions;
    trait.distinct_contexts = distinctProjects;
    trait.last_confirmed = cand.timestamp;

    this.saveTrait(trait, `${reason}: ${score.reason}`, oldJson);
    return trait;
  }

  private createNewTrait(
    traitId: string,
    category: TraitCategory,
    statement: string,
    scope: string,
    cand: EvidenceCandidate
  ): Trait {
    const initialScore = computeTraitScore({
      category,
      supportCount: 1,
      contradictionCount: 0,
      distinctSessions: 1,
      distinctContexts: cand.context.project ? 1 : 0,
      hasExplicitDeclaration: cand.signal_type === 'explicit_statement'
    });

    const ontologyClass = classifyTraitOntology(
      category,
      statement,
      scope,
      cand.context.project ? 1 : 0,
      1
    );

    const newTrait: Trait = {
      id: traitId,
      category,
      ontology: ontologyClass.ontology,
      statement: ontologyClass.statement,
      scope: ontologyClass.scope,
      domain: ontologyClass.domain,
      tool: ontologyClass.tool,
      environment: ontologyClass.environment,
      project_id: ontologyClass.project_id,
      status: initialScore.status,
      confidence: initialScore.confidence,
      portability_score: ontologyClass.portability_score,
      behavioral_utility: ontologyClass.behavioral_utility,
      entailment_score: ontologyClass.entailment_score,
      semantic_strength: ontologyClass.semantic_strength,
      trait_role: ontologyClass.trait_role,
      support_count: 1,
      contradiction_count: 0,
      distinct_sessions: 1,
      distinct_contexts: cand.context.project ? 1 : 0,
      first_seen: cand.timestamp,
      last_confirmed: cand.timestamp,
      evidence_ids: [cand.id]
    };

    this.saveTrait(newTrait, initialScore.reason);
    this.storage.linkTraitEvidence(newTrait.id, cand.id, 'support');
    return newTrait;
  }

  private upsertAndLinkTrait(trait: Trait, evidenceId: string, reason: string): void {
    const existing = this.storage.getTrait(trait.id);
    if (existing) {
      this.storage.linkTraitEvidence(trait.id, evidenceId, 'support');
      const allEv = this.storage.getEvidenceForTrait(trait.id);
      const distinctSessions = new Set(allEv.map(e => e.source_session_id)).size;
      const distinctContexts = new Set(
        allEv.map(e => {
          try { return JSON.parse(e.context_json).project; } catch { return null; }
        }).filter(Boolean)
      ).size;
      const score = computeTraitScore({
        category: trait.category,
        supportCount: allEv.length,
        contradictionCount: 0,
        distinctSessions,
        distinctContexts,
        hasExplicitDeclaration: true,
        currentStatus: existing.status as TraitStatus
      });
      const updatedTrait: Trait = {
        ...this.rowToTrait(existing),
        confidence: score.confidence,
        status: score.status,
        support_count: allEv.length,
        distinct_sessions: distinctSessions,
        distinct_contexts: distinctContexts,
        last_confirmed: new Date().toISOString()
      };
      this.saveTrait(updatedTrait, reason);
    } else {
      this.saveTrait(trait, reason);
      this.storage.linkTraitEvidence(trait.id, evidenceId, 'support');
    }
  }

  public runDecayCheck(): Trait[] {
    const allTraits = this.storage.getAllTraits().map(r => this.rowToTrait(r));
    const modified: Trait[] = [];

    for (const t of allTraits) {
      const decay = applyTimeDecay(t);
      if (decay.hasChanged) {
        const oldJson = JSON.stringify(t);
        this.saveTrait(decay.updatedTrait, decay.reason || 'Time decay applied', oldJson);
        modified.push(decay.updatedTrait);
      }
    }

    return modified;
  }

  private isSimilar(a: string, b: string, category?: string): boolean {
    const normA = a.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5\s]/g, ' ').trim();
    const normB = b.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5\s]/g, ' ').trim();
    if (normA === normB) return true;
    if (normA.includes(normB) || normB.includes(normA)) return true;

    // Domain-specific semantic equivalence
    if (category === 'collaboration_style') {
      const isAAutonomy = normA.includes('autonomous') || normA.includes('without asking') || normA.includes('confirmation') || normA.includes('proceed directly') || normA.includes('自主') || normA.includes('直接');
      const isBAutonomy = normB.includes('autonomous') || normB.includes('without asking') || normB.includes('confirmation') || normB.includes('proceed directly') || normB.includes('自主') || normB.includes('直接');

      const isADestructive = normA.includes('destructive') || normA.includes('irreversible') || normA.includes('破坏') || normA.includes('高危') || normA.includes('删库');
      const isBDestructive = normB.includes('destructive') || normB.includes('irreversible') || normB.includes('破坏') || normB.includes('高危') || normB.includes('删库');

      if (isAAutonomy && isBAutonomy && !isADestructive && !isBDestructive) return true;
      if (isADestructive && isBDestructive) return true;
    }

    if (category === 'decision_style') {
      const isAEmpirical = normA.includes('empirical') || normA.includes('runtime validation') || normA.includes('test evidence') || normA.includes('验证');
      const isBEmpirical = normB.includes('empirical') || normB.includes('runtime validation') || normB.includes('test evidence') || normB.includes('验证');
      if (isAEmpirical && isBEmpirical) return true;
    }

    if (category === 'values_principles') {
      const isAThin = normA.includes('thin runtime') || normA.includes('decoupled');
      const isBThin = normB.includes('thin runtime') || normB.includes('decoupled');
      if (isAThin && isBThin) return true;

      const isAComplexity = normA.includes('complexity') || normA.includes('pruning') || normA.includes('收益');
      const isBComplexity = normB.includes('complexity') || normB.includes('pruning') || normB.includes('收益');
      if (isAComplexity && isBComplexity) return true;
    }

    if (category === 'preferences') {
      if (normA.includes('concise') && normB.includes('concise')) return true;
      if (normA.includes('pnpm') && normB.includes('pnpm')) return true;
      if (normA.includes('typescript') && normB.includes('typescript')) return true;
    }

    // Token overlap check
    const wordsA = new Set(normA.split(/\s+/).filter(w => w.length > 2));
    const wordsB = new Set(normB.split(/\s+/).filter(w => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) return false;

    let overlap = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) overlap++;
    }
    const overlapRatio = overlap / Math.min(wordsA.size, wordsB.size);
    return overlapRatio >= 0.4;
  }

  private saveTrait(trait: Trait, reason: string, oldJson: string | null = null): void {
    const row: TraitRow = {
      id: trait.id,
      category: trait.category,
      ontology: trait.ontology || 'USER_GLOBAL',
      statement: trait.statement,
      scope: trait.scope,
      domain: trait.domain || null,
      tool: trait.tool || null,
      environment: trait.environment || null,
      project_id: trait.project_id || null,
      status: trait.status,
      confidence: trait.confidence,
      portability_score: trait.portability_score ?? 0.5,
      behavioral_utility: trait.behavioral_utility ?? 0.5,
      entailment_score: trait.entailment_score ?? 0.8,
      semantic_strength: trait.semantic_strength || 'moderate-generalization',
      trait_role: trait.trait_role || 'ACTION_GUIDANCE',
      support_count: trait.support_count,
      contradiction_count: trait.contradiction_count,
      distinct_sessions: trait.distinct_sessions,
      distinct_contexts: trait.distinct_contexts,
      first_seen: trait.first_seen,
      last_confirmed: trait.last_confirmed
    };
    this.storage.upsertTrait(row);
    this.storage.recordTraitHistory({
      trait_id: trait.id,
      old_json: oldJson,
      new_json: JSON.stringify(trait),
      reason,
      changed_at: new Date().toISOString()
    });
  }

  private rowToTrait(row: TraitRow): Trait {
    const evidenceList = this.storage.getEvidenceForTrait(row.id);
    return {
      id: row.id,
      category: row.category as TraitCategory,
      ontology: (row.ontology as OntologyLevel) || 'USER_GLOBAL',
      statement: row.statement,
      scope: row.scope,
      domain: row.domain || null,
      tool: row.tool || null,
      environment: row.environment || null,
      project_id: row.project_id || null,
      status: row.status,
      confidence: row.confidence,
      portability_score: row.portability_score ?? 0.5,
      behavioral_utility: row.behavioral_utility ?? 0.5,
      entailment_score: row.entailment_score ?? 0.8,
      semantic_strength: row.semantic_strength || 'moderate-generalization',
      trait_role: row.trait_role || 'ACTION_GUIDANCE',
      support_count: row.support_count,
      contradiction_count: row.contradiction_count,
      distinct_sessions: row.distinct_sessions,
      distinct_contexts: row.distinct_contexts,
      first_seen: row.first_seen,
      last_confirmed: row.last_confirmed,
      evidence_ids: evidenceList.map(e => e.id)
    };
  }
}
