import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { SessionAdapter, SessionRef } from './interface.js';
import { CanonicalEvent, extractProjectFromCwd } from '../normalize/canonical-event.js';

export class PiAdapter implements SessionAdapter {
  readonly name = 'pi';

  public async discover(customRoot?: string): Promise<SessionRef[]> {
    const rootDir = customRoot || path.join(os.homedir(), '.pi', 'agent', 'sessions');
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
            const sessionId = entry.name.replace(/\.jsonl$/, '');
            sessions.push({
              id: sessionId,
              adapter: this.name,
              path: fullPath,
              size: stat.size,
              mtime: stat.mtimeMs,
            });
          } catch {
            // ignore unreadable files
          }
        }
      }
    };

    findJsonlFiles(rootDir);
    return sessions;
  }

  public async fingerprint(session: SessionRef): Promise<string> {
    try {
      const stat = fs.statSync(session.path);
      // Fast fingerprint from size + mtime, plus first & last 512 bytes hash
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
        if (record.type === 'session') {
          if (record.id) defaultSessionId = record.id;
          if (record.cwd) {
            defaultCwd = record.cwd;
            defaultProject = extractProjectFromCwd(record.cwd);
          }
          continue;
        }

        if (record.type === 'message' && record.message) {
          const role = record.message.role;
          if (!role || !['user', 'assistant', 'tool', 'system'].includes(role)) {
            continue;
          }

          let content = '';
          if (typeof record.message.content === 'string') {
            content = record.message.content;
          } else if (Array.isArray(record.message.content)) {
            content = record.message.content
              .map((c: any) => {
                if (typeof c === 'string') return c;
                if (c && typeof c.text === 'string') return c.text;
                if (c && c.type === 'text') return c.text || '';
                return '';
              })
              .filter(Boolean)
              .join('\n');
          }

          if (!content.trim()) continue;

          const timestamp = record.timestamp
            ? new Date(record.timestamp).toISOString()
            : (record.message.timestamp ? new Date(record.message.timestamp).toISOString() : new Date().toISOString());

          events.push({
            session_id: defaultSessionId,
            event_id: record.id || `ev_${Math.random().toString(36).slice(2, 9)}`,
            timestamp,
            project: defaultProject,
            role,
            content: content.trim(),
            metadata: {
              cwd: defaultCwd || undefined,
              raw_path: session.path,
            }
          });
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return events;
  }
}
