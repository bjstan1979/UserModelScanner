import crypto from 'node:crypto';
import { UserModelConfig } from '../config.js';
import { SQLiteStorage } from '../storage/sqlite.js';
import type { SessionDigest } from '../normalize/session-digest.js';
import { extractCandidatesFromSession, EvidenceCandidate, triageSession } from '../evidence/extract.js';
import { EvidenceRegistry } from '../evidence/registry.js';
import { TraitUpdater } from '../traits/updater.js';
import { writeAllUserModelArtifacts } from '../render/user-md.js';
import { writeUserModelJson } from '../render/json.js';
import { Trait, TraitStatus } from '../traits/schema.js';
import { SemanticProvider } from '../semantic/interface.js';
import { createSemanticProvider } from '../semantic/factory.js';
import type { CanonicalEvent } from '../normalize/canonical-event.js';
import { ingestConfiguredSessions } from './ingest.js';

export interface ScanOptions {
  full?: boolean;
  concurrency?: number;
  provider?: string | SemanticProvider;
}

export interface ScanResult {
  runId: string;
  mode: 'bootstrap' | 'incremental' | 'full';
  providerName: string;
  startedAt: string;
  finishedAt: string;
  sessionsDiscovered: number;
  sessionsProcessed: number;
  sessionsSkipped: number;
  evidenceExtracted: number;
  traitsCreated: number;
  traitsUpdated: number;
  traitsDisputed: number;
  traitsScopeSplit: number;
  traitsRetired: number;
  totalTraits: number;
  durationMs: number;
}

interface QueuedSessionWork {
  sessionDbId: string;
  adapterName: string;
  digest: SessionDigest;
  remappedEvents: CanonicalEvent[];
}

export class ScannerEngine {
  private registry: EvidenceRegistry;
  private traitUpdater: TraitUpdater;
  private provider: SemanticProvider;

  constructor(
    private config: UserModelConfig,
    private storage: SQLiteStorage,
    provider?: SemanticProvider | string
  ) {
    this.registry = new EvidenceRegistry(this.storage);
    
    if (provider && typeof provider !== 'string') {
      this.provider = provider;
    } else {
      this.provider = createSemanticProvider(this.config, typeof provider === 'string' ? provider : undefined);
    }
    
    this.traitUpdater = new TraitUpdater(this.storage);
  }

  public async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const startTime = Date.now();
    const startedAt = new Date(startTime).toISOString();
    const runId = `run_${crypto.createHash('md5').update(`${startedAt}-${Math.random()}`).digest('hex').slice(0, 10)}`;

    const isFull = Boolean(options.full);
    const mode = isFull ? 'full' : (this.storage.getAllSessions().length === 0 ? 'bootstrap' : 'incremental');

    if (options.provider) {
      if (typeof options.provider !== 'string') {
        this.provider = options.provider;
      } else {
        this.provider = createSemanticProvider(this.config, options.provider);
      }
      this.traitUpdater = new TraitUpdater(this.storage);
    }

    // 1. Shared adapter discovery, fingerprinting, cursor, and canonical-event persistence.
    const ingestion = await ingestConfiguredSessions(this.config, this.storage, { full: isFull, now: startedAt });
    const sessionsDiscovered = ingestion.sessionsDiscovered;
    const sessionsProcessed = ingestion.sessionsProcessed;
    const sessionsSkipped = ingestion.sessionsSkipped;
    const triagePassedQueue: QueuedSessionWork[] = [];
    const allExtractedCandidates: EvidenceCandidate[] = [];

    for (const ingested of ingestion.sessions) {
      if (!triageSession(ingested.digest)) continue;
      triagePassedQueue.push({
        sessionDbId: ingested.sessionDbId,
        adapterName: ingested.adapterName,
        digest: ingested.digest,
        remappedEvents: ingested.events
      });
    }

    // 2. Parallel / Concurrent Evidence Extraction for triage-passed sessions
    const concurrency = options.concurrency || (this.provider.name === 'rule-based' ? 50 : 12);
    let completedCount = 0;

    const worker = async (work: QueuedSessionWork) => {
      let candidates: EvidenceCandidate[] = [];
      if (this.provider.name !== 'rule-based' && await this.provider.isAvailable()) {
        try {
          const semanticCandidates = await this.provider.extractEvidence(work.digest, work.remappedEvents);
          if (semanticCandidates && semanticCandidates.length > 0) {
            candidates = semanticCandidates.map(c => ({
              ...c,
              source: { ...c.source, session_id: work.sessionDbId }
            }));
          } else {
            candidates = extractCandidatesFromSession(work.adapterName, work.remappedEvents, work.digest);
          }
        } catch {
          candidates = extractCandidatesFromSession(work.adapterName, work.remappedEvents, work.digest);
        }
      } else {
        candidates = extractCandidatesFromSession(work.adapterName, work.remappedEvents, work.digest);
      }

      const normalizedCandidates = candidates.map(c => ({
        ...c,
        source: { ...c.source, session_id: work.sessionDbId }
      }));

      if (normalizedCandidates.length > 0) {
        this.registry.recordCandidates(normalizedCandidates);
        allExtractedCandidates.push(...normalizedCandidates);
      }

      completedCount++;
      if (completedCount % 50 === 0 || completedCount === triagePassedQueue.length) {
        process.stdout.write(`\r  Extracted evidence: ${completedCount}/${triagePassedQueue.length} candidate sessions...`);
      }
    };

    // Run pool
    const queue = [...triagePassedQueue];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item) await worker(item);
      }
    });

    await Promise.all(workers);
    if (triagePassedQueue.length > 0) {
      process.stdout.write('\n');
    }

    // 3. Trait Update & State Machine (governed deterministically)
    const traitChanges = await this.traitUpdater.processCandidates(allExtractedCandidates);

    // 4. Time Decay Check
    const decayedTraits = this.traitUpdater.runDecayCheck();

    // 5. Get all current traits from DB
    const allTraits: Trait[] = this.storage.getAllTraits().map(r => {
      const evList = this.storage.getEvidenceForTrait(r.id);
      return {
        id: r.id,
        category: r.category as any,
        ontology: (r.ontology as any) || 'USER_GLOBAL',
        statement: r.statement,
        scope: r.scope,
        domain: r.domain,
        tool: r.tool,
        environment: r.environment,
        project_id: r.project_id,
        status: r.status as TraitStatus,
        confidence: r.confidence,
        portability_score: r.portability_score ?? 0.5,
        behavioral_utility: r.behavioral_utility ?? 0.5,
        entailment_score: r.entailment_score ?? 0.8,
        semantic_strength: r.semantic_strength || 'moderate-generalization',
        trait_role: r.trait_role || 'ACTION_GUIDANCE',
        support_count: r.support_count,
        contradiction_count: r.contradiction_count,
        distinct_sessions: r.distinct_sessions,
        distinct_contexts: r.distinct_contexts,
        first_seen: r.first_seen,
        last_confirmed: r.last_confirmed,
        evidence_ids: evList.map(e => e.id)
      };
    });

    // 6. Render outputs
    writeAllUserModelArtifacts(this.config, allTraits);
    writeUserModelJson(this.config.userJsonPath, allTraits, this.config.extractorVersion);

    const finishTime = Date.now();
    const finishedAt = new Date(finishTime).toISOString();
    const durationMs = finishTime - startTime;

    const result: ScanResult = {
      runId,
      mode,
      providerName: this.provider.name,
      startedAt,
      finishedAt,
      sessionsDiscovered,
      sessionsProcessed,
      sessionsSkipped,
      evidenceExtracted: allExtractedCandidates.length,
      traitsCreated: traitChanges.created.length,
      traitsUpdated: traitChanges.updated.length,
      traitsDisputed: traitChanges.disputed.length,
      traitsScopeSplit: traitChanges.scopeSplit.length,
      traitsRetired: decayedTraits.filter(t => t.status === 'retired').length,
      totalTraits: allTraits.length,
      durationMs
    };

    // 7. Record Scan Run
    this.storage.insertScanRun({
      id: runId,
      started_at: startedAt,
      finished_at: finishedAt,
      mode,
      stats_json: JSON.stringify(result),
      extractor_version: this.config.extractorVersion
    });

    return result;
  }
}
