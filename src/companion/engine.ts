import type { FullCompanionSnapshot } from './schema.js';
import type { CanonicalEvent } from '../normalize/canonical-event.js';
import { createDiscourseState } from './candidate-extractor.js';
import { projectCompanionState } from './reducer.js';
import { createResolverState, EntailmentVerdict, resolveCandidates, type ResolverState } from './resolver.js';
import {
  CompanionSemanticProvider,
  createCompanionSemanticProvider,
  isPromiseLike
} from './semantic-provider.js';

export const COMPANION_PROJECTION_VERSION = 'companion-projector/entity-first-lifecycle-runtime-v1';

export interface CompanionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface CompanionSession {
  session_id: string;
  date: string;
  topic: string;
  messages: CompanionMessage[];
}

export function companionSessionsFromCanonicalEvents(events: readonly CanonicalEvent[]): CompanionSession[] {
  const grouped = new Map<string, CanonicalEvent[]>();
  for (const event of events) {
    if (event.role === 'tool') continue;
    const current = grouped.get(event.session_id) ?? [];
    current.push(event);
    grouped.set(event.session_id, current);
  }
  return [...grouped.entries()].map(([sessionId, sessionEvents]) => {
    const sorted = [...sessionEvents].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return {
      session_id: sessionId,
      date: sorted[0]?.timestamp.slice(0, 10) ?? '',
      topic: sorted.find(event => event.project)?.project ?? 'companion',
      messages: sorted.map(event => ({ id: event.event_id, role: event.role as CompanionMessage['role'], content: event.content }))
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.session_id.localeCompare(b.session_id));
}
/**
 * Candidate-first companion memory pipeline.
 *
 * Extraction, entity linking and entailment are provided through an injectable
 * semantic provider. The default provider is deterministic and offline. The engine
 * accepts only entailed candidates, resolves temporal conflicts into an open fact
 * store, and projects the five compatibility views from that store.
 */
export class CompanionScannerEngine {
  constructor(
    private readonly provider: CompanionSemanticProvider = createCompanionSemanticProvider(),
    private readonly initialSnapshot?: FullCompanionSnapshot
  ) {}

  private resolverState(): ResolverState {
    const resolver = createResolverState();
    for (const fact of structuredClone(this.initialSnapshot?.fact_store ?? [])) resolver.facts.set(fact.factId, fact);
    for (const entity of structuredClone(this.initialSnapshot?.entities ?? [])) resolver.entities.set(entity.entityId, entity);
    resolver.operations.push(...structuredClone(this.initialSnapshot?.operations_log ?? []));
    return resolver;
  }

  private rejectedItems(): Array<{ item: string; reason: string }> {
    return structuredClone(this.initialSnapshot?.rejected_items ?? []);
  }
  public scanCompanionDataset(sessions: CompanionSession[]): FullCompanionSnapshot {
    const discourse = createDiscourseState();
    const resolver = this.resolverState();
    const rejectedItems = this.rejectedItems();
    const sourceMessages = new Map<string, string>();

    for (const session of sessions) {
      for (const message of session.messages) {
        sourceMessages.set(message.id, message.content);
        const extraction = this.provider.extractCandidates({ message, session, discourse, existingOperations: resolver.operations });
        if (isPromiseLike(extraction)) throw new Error(`Provider ${this.provider.name} is asynchronous; use scanCompanionDatasetAsync()`);
        rejectedItems.push(...extraction.rejected.map(item => ({ item: item.item, reason: item.reason })));

        const linked = this.provider.resolveEntities({ candidates: extraction.candidates, existingEntities: resolver.entities });
        if (isPromiseLike(linked)) throw new Error(`Provider ${this.provider.name} is asynchronous; use scanCompanionDatasetAsync()`);

        const verdicts = new Map<string, EntailmentVerdict>();
        for (const candidate of linked) {
          const verdict = this.provider.checkEntailment({ candidate, sourceMessages });
          if (isPromiseLike(verdict)) throw new Error(`Provider ${this.provider.name} is asynchronous; use scanCompanionDatasetAsync()`);
          verdicts.set(candidate.candidateId, verdict);
        }
        resolveCandidates(linked, resolver, candidate => verdicts.get(candidate.candidateId) ?? {
          entailed: false,
          confidence: 1,
          reason: 'Semantic provider returned no entailment verdict'
        });
      }
    }

    return projectCompanionState(resolver, rejectedItems, sessions.at(-1)?.date);
  }

  public async scanCompanionDatasetAsync(sessions: CompanionSession[]): Promise<FullCompanionSnapshot> {
    if (!(await this.provider.isAvailable())) throw new Error(`Provider ${this.provider.name} is unavailable`);
    const discourse = createDiscourseState();
    const resolver = this.resolverState();
    const rejectedItems = this.rejectedItems();
    const sourceMessages = new Map<string, string>();

    for (const session of sessions) {
      for (const message of session.messages) {
        sourceMessages.set(message.id, message.content);
        const extraction = await this.provider.extractCandidates({ message, session, discourse, existingOperations: resolver.operations });
        rejectedItems.push(...extraction.rejected.map(item => ({ item: item.item, reason: item.reason })));
        const linked = await this.provider.resolveEntities({ candidates: extraction.candidates, existingEntities: resolver.entities });
        const verdicts = new Map<string, EntailmentVerdict>();
        for (const candidate of linked) {
          verdicts.set(candidate.candidateId, await this.provider.checkEntailment({ candidate, sourceMessages }));
        }
        resolveCandidates(linked, resolver, candidate => verdicts.get(candidate.candidateId) ?? {
          entailed: false,
          confidence: 1,
          reason: 'Semantic provider returned no entailment verdict'
        });
      }
    }

    return projectCompanionState(resolver, rejectedItems, sessions.at(-1)?.date);
  }
}
