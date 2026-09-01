import { CanonicalEvent } from '../normalize/canonical-event.js';

export interface SessionRef {
  id: string;
  adapter: string;
  path: string;
  started_at?: string;
  project?: string | null;
  size?: number;
  mtime?: number;
  source_id?: string;
}

export interface SessionAdapter {
  readonly name: string;
  discover(customRoot?: string): Promise<SessionRef[]>;
  fingerprint(session: SessionRef): Promise<string>;
  parse(session: SessionRef): Promise<CanonicalEvent[]>;
}
