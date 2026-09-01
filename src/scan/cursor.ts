import { SQLiteStorage } from '../storage/sqlite.js';
import { SessionRef } from '../adapters/interface.js';

export class ScanCursorManager {
  constructor(private storage: SQLiteStorage, private extractorVersion: string) {}

  public shouldProcessSession(session: SessionRef, currentFingerprint: string, forceFull = false, sourceId = `src_${session.adapter}`): boolean {
    if (forceFull) return true;
    const existing = this.storage.getSessionByExternalId(sourceId, session.id);
    if (!existing) {
      return true;
    }

    if (existing.fingerprint !== currentFingerprint) {
      return true;
    }

    if (existing.processed_version !== this.extractorVersion) {
      return true;
    }

    return false;
  }
}
