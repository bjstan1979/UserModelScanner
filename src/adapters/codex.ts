import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { SessionAdapter, SessionRef } from './interface.js';
import { CanonicalEvent, CanonicalRole, extractProjectFromCwd, normalizeTimestamp } from '../normalize/canonical-event.js';

export class CodexAdapter implements SessionAdapter {
  readonly name = 'codex';

  public async discover(customRoot?: string): Promise<SessionRef[]> {
    let candidateRoots: string[] = [];

    if (customRoot) {
      candidateRoots = [customRoot];
    } else {
      candidateRoots = [
        path.join(os.homedir(), '.codex'),
        '/mnt/c/Users/Administrator/.codex',
        '/mnt/c/Users/Default/.codex',
      ].filter(Boolean) as string[];

      if (fs.existsSync('/mnt/c/Users')) {
        try {
          const users = fs.readdirSync('/mnt/c/Users');
          for (const u of users) {
            try {
              const userCodex = path.join('/mnt/c/Users', u, '.codex');
              if (!candidateRoots.includes(userCodex) && fs.existsSync(userCodex)) {
                candidateRoots.push(userCodex);
              }
            } catch {}
          }
        } catch {}
      }
    }

    const sessions: SessionRef[] = [];

    for (const rootDir of candidateRoots) {
      try {
        if (!fs.existsSync(rootDir)) continue;

        // 1. Discover sessions inside .codex/sessions/
        const sessionsDir = path.join(rootDir, 'sessions');
        const scanDir = fs.existsSync(sessionsDir) ? sessionsDir : rootDir;

        const findRollouts = (dir: string) => {
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              try {
                if (entry.isDirectory()) {
                  findRollouts(fullPath);
                } else if (entry.isFile() && (entry.name.startsWith('rollout-') || entry.name.endsWith('.jsonl'))) {
                  const stat = fs.statSync(fullPath);
                  sessions.push({
                    id: entry.name.replace(/\.jsonl$/, ''),
                    adapter: this.name,
                    path: fullPath,
                    size: stat.size,
                    mtime: stat.mtimeMs,
                  });
                }
              } catch {}
            }
          } catch {}
        };
        findRollouts(scanDir);

        // 2. Discover history.jsonl
        const historyFile = path.join(rootDir, 'history.jsonl');
        if (fs.existsSync(historyFile)) {
          try {
            const stat = fs.statSync(historyFile);
            sessions.push({
              id: `codex_history_${path.basename(rootDir)}`,
              adapter: this.name,
              path: historyFile,
              size: stat.size,
              mtime: stat.mtimeMs,
            });
          } catch {}
        }
      } catch {}
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
    if (!fs.existsSync(session.path)) {
      return [];
    }

    if (session.id.startsWith('codex_history') || session.path.endsWith('history.jsonl')) {
      return this.parseHistoryFile(session);
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
        if (record.type === 'session_meta' && record.payload) {
          const p = record.payload;
          if (p.session_id || p.id) defaultSessionId = p.session_id || p.id;
          if (p.cwd) {
            defaultCwd = p.cwd;
            defaultProject = extractProjectFromCwd(p.cwd);
          }
          continue;
        }

        if (record.type === 'turn_context' && record.payload?.cwd) {
          defaultCwd = record.payload.cwd;
          defaultProject = extractProjectFromCwd(record.payload.cwd);
        }

        if (record.type === 'response_item' && record.payload) {
          const item = record.payload;
          if (item.type === 'message' || item.role) {
            let role: CanonicalRole = 'user';
            if (item.role === 'assistant') role = 'assistant';
            else if (item.role === 'developer' || item.role === 'system') role = 'system';
            else if (item.role === 'tool') role = 'tool';
            else if (item.role === 'user') role = 'user';

            let content = '';
            if (typeof item.content === 'string') {
              content = item.content;
            } else if (Array.isArray(item.content)) {
              content = item.content
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

            const timestamp = record.timestamp
              ? normalizeTimestamp(record.timestamp)
              : new Date().toISOString();

            events.push({
              session_id: defaultSessionId,
              event_id: `ev_${Math.random().toString(36).slice(2, 9)}`,
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
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return events;
  }

  private async parseHistoryFile(session: SessionRef): Promise<CanonicalEvent[]> {
    const events: CanonicalEvent[] = [];
    const fileStream = fs.createReadStream(session.path);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.text && typeof record.text === 'string') {
          const ts = normalizeTimestamp(record.ts);
          events.push({
            session_id: record.session_id || 'codex_history',
            event_id: `ev_${Math.random().toString(36).slice(2, 9)}`,
            timestamp: ts,
            project: null,
            role: 'user',
            content: record.text.trim(),
            metadata: {
              raw_path: session.path,
            }
          });
        }
      } catch {}
    }

    return events;
  }
}
