import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { SessionAdapter, SessionRef } from './interface.js';
import { CanonicalEvent, CanonicalRole, extractProjectFromCwd, normalizeTimestamp } from '../normalize/canonical-event.js';

export class WorkBuddyAdapter implements SessionAdapter {
  readonly name = 'workbuddy';

  public async discover(customRoot?: string): Promise<SessionRef[]> {
    let candidateRoots: string[] = [];

    if (customRoot) {
      candidateRoots = [customRoot];
    } else {
      candidateRoots = [
        path.join(os.homedir(), '.workbuddy'),
        '/mnt/c/Users/Administrator/.workbuddy',
        '/mnt/c/Users/Default/.workbuddy',
      ].filter(Boolean) as string[];

      if (fs.existsSync('/mnt/c/Users')) {
        try {
          const users = fs.readdirSync('/mnt/c/Users');
          for (const u of users) {
            const userWb = path.join('/mnt/c/Users', u, '.workbuddy');
            if (!candidateRoots.includes(userWb) && fs.existsSync(userWb)) {
              candidateRoots.push(userWb);
            }
          }
        } catch {}
      }
    }

    const sessions: SessionRef[] = [];

    for (const rootDir of candidateRoots) {
      if (!fs.existsSync(rootDir)) continue;

      const projectsDir = path.join(rootDir, 'projects');
      const scanDir = fs.existsSync(projectsDir) ? projectsDir : rootDir;

      const findJsonl = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            findJsonl(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            try {
              const stat = fs.statSync(fullPath);
              sessions.push({
                id: entry.name.replace(/\.jsonl$/, ''),
                adapter: this.name,
                path: fullPath,
                size: stat.size,
                mtime: stat.mtimeMs
              });
            } catch {}
          }
        }
      };
      findJsonl(scanDir);
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
    const fileStream = fs.createReadStream(session.path);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let defaultCwd: string | null = null;
    let defaultProject: string | null = null;

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.cwd) {
          defaultCwd = record.cwd;
          defaultProject = extractProjectFromCwd(record.cwd);
        }

        if (record.type === 'message') {
          const role: CanonicalRole = record.role === 'user' ? 'user' : 'assistant';
          let content = '';

          if (typeof record.content === 'string') {
            content = record.content;
          } else if (Array.isArray(record.content)) {
            content = record.content
              .map((c: any) => {
                if (typeof c === 'string') return c;
                if (c && typeof c.text === 'string') return c.text;
                if (c && typeof c.input_text === 'string') return c.input_text;
                return '';
              })
              .filter(Boolean)
              .join('\n');
          }

          if (!content.trim()) continue;

          // Strip WorkBuddy <system-reminder> and extract <user_query> if present
          if (role === 'user' && content.includes('<system-reminder')) {
            const match = content.match(/<user_query>([\s\S]*?)<\/user_query>/i);
            if (match) {
              content = match[1].trim();
            } else {
              content = content.replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, '').trim();
            }
          }

          if (!content.trim()) continue;

          events.push({
            session_id: record.sessionId || session.id,
            event_id: record.id || `ev_${Math.random().toString(36).slice(2, 9)}`,
            timestamp: normalizeTimestamp(record.timestamp),
            project: defaultProject,
            role,
            content: content.trim(),
            metadata: {
              cwd: defaultCwd || undefined,
              raw_path: session.path
            }
          });
        }
      } catch {}
    }

    return events;
  }
}
