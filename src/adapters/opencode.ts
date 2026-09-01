import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { SessionAdapter, SessionRef } from './interface.js';
import { CanonicalEvent, CanonicalRole, extractProjectFromCwd } from '../normalize/canonical-event.js';

export class OpenCodeAdapter implements SessionAdapter {
  readonly name = 'opencode';

  public async discover(customRoot?: string): Promise<SessionRef[]> {
    const defaultRoots = [
      customRoot,
      path.join(os.homedir(), '.local', 'share', 'opencode'),
      path.join(os.homedir(), '.config', 'opencode'),
    ].filter(Boolean) as string[];

    const sessions: SessionRef[] = [];
    for (const rootDir of defaultRoots) {
      if (!fs.existsSync(rootDir)) continue;
      const findSessions = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            findSessions(fullPath);
          } else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl'))) {
            try {
              const stat = fs.statSync(fullPath);
              sessions.push({
                id: entry.name.replace(/\.(json|jsonl)$/, ''),
                adapter: this.name,
                path: fullPath,
                size: stat.size,
                mtime: stat.mtimeMs,
              });
            } catch {}
          }
        }
      };
      findSessions(rootDir);
    }
    return sessions;
  }

  public async fingerprint(session: SessionRef): Promise<string> {
    try {
      const stat = fs.statSync(session.path);
      const fd = fs.openSync(session.path, 'r');
      const buffer = Buffer.alloc(1024);
      const bytesRead = fs.readSync(fd, buffer, 0, 1024, 0);
      fs.closeSync(fd);

      const hash = crypto.createHash('sha256');
      hash.update(`${stat.size}-${stat.mtimeMs}-`);
      hash.update(buffer.subarray(0, bytesRead));
      return hash.digest('hex');
    } catch {
      return `missing-${session.id}`;
    }
  }

  public async parse(session: SessionRef): Promise<CanonicalEvent[]> {
    if (!fs.existsSync(session.path)) return [];

    const events: CanonicalEvent[] = [];
    if (session.path.endsWith('.json')) {
      try {
        const data = JSON.parse(fs.readFileSync(session.path, 'utf-8'));
        const messages = Array.isArray(data) ? data : (data.messages || data.events || []);
        const defaultProject = extractProjectFromCwd(data.cwd || data.workspace);
        for (const m of messages) {
          const role: CanonicalRole = m.role === 'user' ? 'user' : (m.role === 'assistant' ? 'assistant' : 'system');
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          if (!content) continue;
          events.push({
            session_id: session.id,
            event_id: m.id || `ev_${Math.random().toString(36).slice(2, 9)}`,
            timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString(),
            project: defaultProject,
            role,
            content: content.trim(),
            metadata: { raw_path: session.path }
          });
        }
      } catch {}
      return events;
    }

    const fileStream = fs.createReadStream(session.path);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const role: CanonicalRole = record.role === 'user' || record.type === 'user' ? 'user' : 'assistant';
        const content = record.content || record.text || record.message;
        if (!content || typeof content !== 'string') continue;
        events.push({
          session_id: session.id,
          event_id: record.id || `ev_${Math.random().toString(36).slice(2, 9)}`,
          timestamp: record.timestamp ? new Date(record.timestamp).toISOString() : new Date().toISOString(),
          project: extractProjectFromCwd(record.cwd),
          role,
          content: content.trim(),
          metadata: { raw_path: session.path }
        });
      } catch {}
    }

    return events;
  }
}
