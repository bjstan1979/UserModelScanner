import { SessionAdapter, SessionRef } from '../adapters/interface.js';

export async function computeSessionFingerprint(adapter: SessionAdapter, session: SessionRef): Promise<string> {
  return adapter.fingerprint(session);
}
