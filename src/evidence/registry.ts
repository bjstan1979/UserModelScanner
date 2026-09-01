import { SQLiteStorage, EvidenceEventRow } from '../storage/sqlite.js';
import { EvidenceCandidate } from './extract.js';

export class EvidenceRegistry {
  constructor(private storage: SQLiteStorage) {}

  public recordCandidate(cand: EvidenceCandidate): void {
    const row: EvidenceEventRow = {
      id: cand.id,
      category: cand.category,
      statement: cand.statement,
      candidate: cand.candidate,
      signal_type: cand.signal_type,
      strength: cand.strength,
      timestamp: cand.timestamp,
      source_session_id: cand.source.session_id,
      source_event_refs_json: JSON.stringify(cand.source.event_ids),
      context_json: JSON.stringify(cand.context)
    };
    this.storage.insertEvidenceEvent(row);
  }

  public recordCandidates(cands: EvidenceCandidate[]): void {
    this.storage.transaction(() => {
      for (const cand of cands) {
        this.recordCandidate(cand);
      }
    });
  }

  public getEvidenceBySession(sessionId: string): EvidenceEventRow[] {
    return this.storage.getEvidenceEventsBySession(sessionId);
  }

  public getAllEvidence(): EvidenceEventRow[] {
    return this.storage.getAllEvidenceEvents();
  }
}
