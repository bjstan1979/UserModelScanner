import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { ensureDirectory } from '../config.js';
import type { CanonicalEvent } from '../normalize/canonical-event.js';

export interface SourceRow {
  id: string;
  adapter: string;
  root_path: string;
  last_scan_at: string | null;
  config_json: string | null;
}

export interface SessionRow {
  id: string;
  source_id: string;
  external_id: string;
  fingerprint: string;
  started_at: string | null;
  project: string | null;
  processed_version: string | null;
  last_processed_at: string | null;
}

export interface EvidenceEventRow {
  id: string;
  category: string;
  statement: string;
  candidate?: string | null;
  signal_type: string;
  strength: number;
  timestamp: string;
  source_session_id: string;
  source_event_refs_json: string;
  context_json: string;
}

export interface TraitRow {
  id: string;
  category: string;
  ontology: string;
  statement: string;
  scope: string;
  domain: string | null;
  tool: string | null;
  environment: string | null;
  project_id: string | null;
  status: 'candidate' | 'working' | 'stable' | 'disputed' | 'retired' | 'revised';
  confidence: number;
  portability_score: number;
  behavioral_utility: number;
  entailment_score: number;
  semantic_strength: 'direct' | 'moderate-generalization' | 'strong-generalization';
  trait_role: 'ACTION_GUIDANCE' | 'BACKGROUND_FACT' | 'DOMAIN_CONVENTION' | 'ENVIRONMENT_FACT' | 'RELATIONSHIP_CONTEXT';
  support_count: number;
  contradiction_count: number;
  distinct_sessions: number;
  distinct_contexts: number;
  first_seen: string;
  last_confirmed: string;
}

export interface TraitEvidenceRow {
  trait_id: string;
  evidence_id: string;
  relation: 'support' | 'contradict';
}

export interface TraitHistoryRow {
  id?: number;
  trait_id: string;
  old_json: string | null;
  new_json: string | null;
  reason: string;
  changed_at: string;
}

export interface ScanRunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  mode: 'bootstrap' | 'incremental' | 'full';
  stats_json: string;
  extractor_version: string;
}

export class SQLiteStorage {
  private db: Database.Database;

  constructor(dbPath: string) {
    ensureDirectory(path.dirname(dbPath));
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        root_path TEXT NOT NULL,
        last_scan_at TEXT,
        config_json TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        started_at TEXT,
        project TEXT,
        processed_version TEXT,
        last_processed_at TEXT,
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_fingerprint ON sessions(fingerprint);
      CREATE TABLE IF NOT EXISTS canonical_events (
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        project TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY (session_id, event_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_canonical_events_session ON canonical_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_canonical_events_timestamp ON canonical_events(timestamp);
      CREATE TABLE IF NOT EXISTS evidence_events (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        statement TEXT NOT NULL,
        candidate TEXT,
        signal_type TEXT NOT NULL,
        strength REAL NOT NULL,
        timestamp TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_event_refs_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        FOREIGN KEY (source_session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_session ON evidence_events(source_session_id);
      CREATE INDEX IF NOT EXISTS idx_evidence_category ON evidence_events(category);

      CREATE TABLE IF NOT EXISTS traits (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        ontology TEXT NOT NULL DEFAULT 'USER_GLOBAL',
        statement TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        domain TEXT,
        tool TEXT,
        environment TEXT,
        project_id TEXT,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        portability_score REAL NOT NULL DEFAULT 0.5,
        behavioral_utility REAL NOT NULL DEFAULT 0.5,
        entailment_score REAL NOT NULL DEFAULT 0.8,
        semantic_strength TEXT NOT NULL DEFAULT 'moderate-generalization',
        trait_role TEXT NOT NULL DEFAULT 'ACTION_GUIDANCE',
        support_count INTEGER NOT NULL DEFAULT 0,
        contradiction_count INTEGER NOT NULL DEFAULT 0,
        distinct_sessions INTEGER NOT NULL DEFAULT 0,
        distinct_contexts INTEGER NOT NULL DEFAULT 0,
        first_seen TEXT NOT NULL,
        last_confirmed TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_traits_category ON traits(category);
      CREATE INDEX IF NOT EXISTS idx_traits_ontology ON traits(ontology);
      CREATE INDEX IF NOT EXISTS idx_traits_status ON traits(status);

      CREATE TABLE IF NOT EXISTS trait_evidence (
        trait_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        PRIMARY KEY (trait_id, evidence_id),
        FOREIGN KEY (trait_id) REFERENCES traits(id) ON DELETE CASCADE,
        FOREIGN KEY (evidence_id) REFERENCES evidence_events(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS trait_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trait_id TEXT NOT NULL,
        old_json TEXT,
        new_json TEXT,
        reason TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trait_history_trait ON trait_history(trait_id);

      CREATE TABLE IF NOT EXISTS scan_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        mode TEXT NOT NULL,
        stats_json TEXT NOT NULL,
        extractor_version TEXT NOT NULL
      );
    `);
  }

  // --- Source Operations ---
  public upsertSource(source: SourceRow): void {
    const stmt = this.db.prepare(`
      INSERT INTO sources (id, adapter, root_path, last_scan_at, config_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        adapter = excluded.adapter,
        root_path = excluded.root_path,
        last_scan_at = excluded.last_scan_at,
        config_json = excluded.config_json
    `);
    stmt.run(source.id, source.adapter, source.root_path, source.last_scan_at, source.config_json);
  }

  public getSources(): SourceRow[] {
    return this.db.prepare('SELECT * FROM sources').all() as SourceRow[];
  }

  public getSource(id: string): SourceRow | undefined {
    return this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined;
  }

  // --- Session Operations ---
  public upsertSession(session: SessionRow): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, source_id, external_id, fingerprint, started_at, project, processed_version, last_processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_id = excluded.source_id,
        external_id = excluded.external_id,
        fingerprint = excluded.fingerprint,
        started_at = excluded.started_at,
        project = excluded.project,
        processed_version = excluded.processed_version,
        last_processed_at = excluded.last_processed_at
    `);
    stmt.run(
      session.id,
      session.source_id,
      session.external_id,
      session.fingerprint,
      session.started_at,
      session.project,
      session.processed_version,
      session.last_processed_at
    );
  }

  public getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  public getSessionByExternalId(sourceId: string, externalId: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE source_id = ? AND external_id = ?').get(sourceId, externalId) as SessionRow | undefined;
  }

  public getAllSessions(): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions').all() as SessionRow[];
  }

  public replaceCanonicalEvents(sessionId: string, events: CanonicalEvent[]): void {
    const replace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM canonical_events WHERE session_id = ?').run(sessionId);
      const insert = this.db.prepare(`
        INSERT INTO canonical_events (session_id, event_id, timestamp, project, role, content, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of events) {
        insert.run(sessionId, event.event_id, event.timestamp, event.project, event.role, event.content, JSON.stringify(event.metadata ?? {}));
      }
    });
    replace();
  }

  public getCanonicalEventsBySource(sourceId: string): CanonicalEvent[] {
    const rows = this.db.prepare(`
      SELECT e.* FROM canonical_events e
      JOIN sessions s ON s.id = e.session_id
      WHERE s.source_id = ?
      ORDER BY e.timestamp, e.session_id, e.event_id
    `).all(sourceId) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      session_id: String(row.session_id),
      event_id: String(row.event_id),
      timestamp: String(row.timestamp),
      project: row.project === null ? null : String(row.project),
      role: String(row.role) as CanonicalEvent['role'],
      content: String(row.content),
      metadata: JSON.parse(String(row.metadata_json))
    }));
  }

  // --- Evidence Operations ---
  public insertEvidenceEvent(ev: EvidenceEventRow): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO evidence_events (
        id, category, statement, candidate, signal_type, strength, timestamp,
        source_session_id, source_event_refs_json, context_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      ev.id,
      ev.category,
      ev.statement,
      ev.candidate ?? ev.statement,
      ev.signal_type,
      ev.strength,
      ev.timestamp,
      ev.source_session_id,
      ev.source_event_refs_json,
      ev.context_json
    );
  }

  public getEvidenceEvent(id: string): EvidenceEventRow | undefined {
    return this.db.prepare('SELECT * FROM evidence_events WHERE id = ?').get(id) as EvidenceEventRow | undefined;
  }

  public getEvidenceEventsBySession(sessionId: string): EvidenceEventRow[] {
    return this.db.prepare('SELECT * FROM evidence_events WHERE source_session_id = ?').all(sessionId) as EvidenceEventRow[];
  }

  public getAllEvidenceEvents(): EvidenceEventRow[] {
    return this.db.prepare('SELECT * FROM evidence_events').all() as EvidenceEventRow[];
  }

  // --- Trait Operations ---
  public upsertTrait(trait: TraitRow): void {
    const stmt = this.db.prepare(`
      INSERT INTO traits (
        id, category, ontology, statement, scope, domain, tool, environment, project_id,
        status, confidence, portability_score, behavioral_utility, entailment_score,
        semantic_strength, trait_role, support_count, contradiction_count,
        distinct_sessions, distinct_contexts, first_seen, last_confirmed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        category = excluded.category,
        ontology = excluded.ontology,
        statement = excluded.statement,
        scope = excluded.scope,
        domain = excluded.domain,
        tool = excluded.tool,
        environment = excluded.environment,
        project_id = excluded.project_id,
        status = excluded.status,
        confidence = excluded.confidence,
        portability_score = excluded.portability_score,
        behavioral_utility = excluded.behavioral_utility,
        entailment_score = excluded.entailment_score,
        semantic_strength = excluded.semantic_strength,
        trait_role = excluded.trait_role,
        support_count = excluded.support_count,
        contradiction_count = excluded.contradiction_count,
        distinct_sessions = excluded.distinct_sessions,
        distinct_contexts = excluded.distinct_contexts,
        first_seen = excluded.first_seen,
        last_confirmed = excluded.last_confirmed
    `);
    stmt.run(
      trait.id,
      trait.category,
      trait.ontology || 'USER_GLOBAL',
      trait.statement,
      trait.scope,
      trait.domain || null,
      trait.tool || null,
      trait.environment || null,
      trait.project_id || null,
      trait.status,
      trait.confidence,
      trait.portability_score ?? 0.5,
      trait.behavioral_utility ?? 0.5,
      trait.entailment_score ?? 0.8,
      trait.semantic_strength || 'moderate-generalization',
      trait.trait_role || 'ACTION_GUIDANCE',
      trait.support_count,
      trait.contradiction_count,
      trait.distinct_sessions,
      trait.distinct_contexts,
      trait.first_seen,
      trait.last_confirmed
    );
  }

  public getTrait(id: string): TraitRow | undefined {
    return this.db.prepare('SELECT * FROM traits WHERE id = ?').get(id) as TraitRow | undefined;
  }

  public getAllTraits(): TraitRow[] {
    return this.db.prepare('SELECT * FROM traits ORDER BY ontology, category, confidence DESC').all() as TraitRow[];
  }

  public deleteTrait(id: string): void {
    this.db.prepare('DELETE FROM traits WHERE id = ?').run(id);
  }

  // --- Trait Evidence Links ---
  public linkTraitEvidence(traitId: string, evidenceId: string, relation: 'support' | 'contradict'): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO trait_evidence (trait_id, evidence_id, relation)
      VALUES (?, ?, ?)
    `);
    stmt.run(traitId, evidenceId, relation);
  }

  public getEvidenceForTrait(traitId: string): Array<EvidenceEventRow & { relation: 'support' | 'contradict' }> {
    const stmt = this.db.prepare(`
      SELECT e.*, te.relation
      FROM evidence_events e
      JOIN trait_evidence te ON e.id = te.evidence_id
      WHERE te.trait_id = ?
    `);
    return stmt.all(traitId) as Array<EvidenceEventRow & { relation: 'support' | 'contradict' }>;
  }

  public getTraitsForEvidence(evidenceId: string): Array<TraitRow & { relation: 'support' | 'contradict' }> {
    const stmt = this.db.prepare(`
      SELECT t.*, te.relation
      FROM traits t
      JOIN trait_evidence te ON t.id = te.trait_id
      WHERE te.evidence_id = ?
    `);
    return stmt.all(evidenceId) as Array<TraitRow & { relation: 'support' | 'contradict' }>;
  }

  // --- Trait History ---
  public recordTraitHistory(history: TraitHistoryRow): void {
    const stmt = this.db.prepare(`
      INSERT INTO trait_history (trait_id, old_json, new_json, reason, changed_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(history.trait_id, history.old_json, history.new_json, history.reason, history.changed_at);
  }

  public getTraitHistory(traitId?: string): TraitHistoryRow[] {
    if (traitId) {
      return this.db.prepare('SELECT * FROM trait_history WHERE trait_id = ? ORDER BY id DESC').all(traitId) as TraitHistoryRow[];
    }
    return this.db.prepare('SELECT * FROM trait_history ORDER BY id DESC').all() as TraitHistoryRow[];
  }

  // --- Scan Runs ---
  public insertScanRun(run: ScanRunRow): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO scan_runs (id, started_at, finished_at, mode, stats_json, extractor_version)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(run.id, run.started_at, run.finished_at, run.mode, run.stats_json, run.extractor_version);
  }

  public getScanRuns(limit = 10): ScanRunRow[] {
    return this.db.prepare('SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT ?').all(limit) as ScanRunRow[];
  }

  public getLatestScanRun(): ScanRunRow | undefined {
    return this.db.prepare('SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 1').get() as ScanRunRow | undefined;
  }

  // --- Transactions & Utility ---
  public transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  public close(): void {
    this.db.close();
  }
}
