import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { SessionAdapter, SessionRef } from './interface.js';
import { CanonicalEvent, CanonicalRole, extractProjectFromCwd } from '../normalize/canonical-event.js';

export class ClaudeAdapter implements SessionAdapter {
  readonly name = 'claude';

  public async discover(customRoot?: string): Promise<SessionRef[]> {
    const rootDir = customRoot || path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(rootDir)) {
      return [];
    }

    const sessions: SessionRef[] = [];
    const findJsonlFiles = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          findJsonlFiles(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try {
            const stat = fs.statSync(fullPath);
            sessions.push({
              id: entry.name.replace(/\.jsonl$/, ''),
              adapter: this.name,
              path: fullPath,
              size: stat.size,
              mtime: stat.mtimeMs,
            });
          } catch {}
        }
      }
    };

    findJsonlFiles(rootDir);
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
    if (!fs.existsSync(session.path)) {
      return [];
    }

    const events: CanonicalEvent[] = [];
    const fileStream = fs.createReadStream(session.path);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let defaultSessionId = session.id;
    let defaultCwd: string | null = null;
    let defaultProject: string | null = null;

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.sessionId) {
          defaultSessionId = record.sessionId;
        }
        if (record.cwd) {
          defaultCwd = record.cwd;
          defaultProject = extractProjectFromCwd(record.cwd);
        }

        // Check if this record is a message
        if (record.type === 'message' || record.message || (record.role && record.content)) {
          const msgObj = record.message || record;
          const role: CanonicalRole = msgObj.role === 'human' || msgObj.role === 'user'
            ? 'user'
            : (msgObj.role === 'assistant' ? 'assistant' : 'system');

          let content = '';
          if (typeof msgObj.content === 'string') {
            content = msgObj.content;
          } else if (Array.isArray(msgObj.content)) {
            content = msgObj.content
              .map((c: any) => (typeof c === 'string' ? c : (c?.text || '')))
              .filter(Boolean)
              .join('\n');
          }

          if (!content.trim()) continue;

          const timestamp = record.timestamp || msgObj.timestamp || new Date().toISOString();

          events.push({
            session_id: defaultSessionId,
            event_id: record.uuid || record.id || `ev_${Math.random().toString(36).slice(2, 9)}`,
            timestamp: new Date(timestamp).toISOString(),
            project: defaultProject,
            role,
            content: content.trim(),
            metadata: {
              cwd: defaultCwd || undefined,
              raw_path: session.path,
            }
          });
        }
      } catch {}
    }

    return events;
  }
}
