import crypto from 'node:crypto';
import type { UserModelConfig } from '../config.js';
import type { CanonicalEvent } from '../normalize/canonical-event.js';
import { buildSessionDigest, type SessionDigest } from '../normalize/session-digest.js';
import type { SQLiteStorage } from '../storage/sqlite.js';
import { ScanCursorManager } from './cursor.js';
import { SessionDiscoverer } from './discover.js';
import { computeSessionFingerprint } from './fingerprints.js';

export interface IngestedSession {
  sourceId: string;
  sessionDbId: string;
  adapterName: string;
  isNew: boolean;
  digest: SessionDigest;
  events: CanonicalEvent[];
}

export interface SessionIngestionResult {
  sessionsDiscovered: number;
  sessionsProcessed: number;
  sessionsSkipped: number;
  sessions: IngestedSession[];
}

export async function ingestConfiguredSessions(
  config: UserModelConfig,
  storage: SQLiteStorage,
  options: { full?: boolean; now?: string; persistCanonicalEvents?: boolean } = {}
): Promise<SessionIngestionResult> {
  const now = options.now ?? new Date().toISOString();
  const cursor = new ScanCursorManager(storage, config.extractorVersion);
  const groups = await new SessionDiscoverer().discoverAll(config);
  const ingested: IngestedSession[] = [];
  let sessionsDiscovered = 0;
  let sessionsSkipped = 0;

  for (const group of groups) {
    storage.upsertSource({
      id: group.sourceId,
      adapter: group.adapter.name,
      root_path: group.rootPath,
      last_scan_at: now,
      config_json: null
    });
    sessionsDiscovered += group.sessions.length;

    for (const sessionRef of [...group.sessions].sort((a, b) => (a.mtime ?? 0) - (b.mtime ?? 0))) {
      const existingSession = storage.getSessionByExternalId(group.sourceId, sessionRef.id);
      const fingerprint = await computeSessionFingerprint(group.adapter, sessionRef);
      if (!cursor.shouldProcessSession(sessionRef, fingerprint, Boolean(options.full), group.sourceId)) {
        sessionsSkipped += 1;
        continue;
      }

      const sessionDbId = `sess_${crypto.createHash('md5').update(`${group.sourceId}-${sessionRef.id}`).digest('hex').slice(0, 12)}`;
      const events = (await group.adapter.parse(sessionRef)).map(event => ({ ...event, session_id: sessionDbId }));
      const digest = buildSessionDigest(sessionDbId, group.adapter.name, events);
      storage.upsertSession({
        id: sessionDbId,
        source_id: group.sourceId,
        external_id: sessionRef.id,
        fingerprint,
        started_at: digest.started_at,
        project: digest.project,
        processed_version: config.extractorVersion,
        last_processed_at: now
      });
      if (options.persistCanonicalEvents) storage.replaceCanonicalEvents(sessionDbId, events);
      ingested.push({ sourceId: group.sourceId, sessionDbId, adapterName: group.adapter.name, isNew: !existingSession, digest, events });
    }
  }

  return {
    sessionsDiscovered,
    sessionsProcessed: ingested.length,
    sessionsSkipped,
    sessions: ingested
  };
}
