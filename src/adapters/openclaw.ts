import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { SessionAdapter, SessionRef } from './interface.js';
import { CanonicalEvent, CanonicalRole, extractProjectFromCwd } from '../normalize/canonical-event.js';

export class OpenClawAdapter implements SessionAdapter {
  readonly name = 'openclaw';

  public async discover(customRoot?: string): Promise<SessionRef[]> {
    const defaultRoots = [customRoot ?? path.join(os.homedir(), '.openclaw')];
    const sessions: SessionRef[] = [];
    for (const rootDir of defaultRoots) {
      if (!fs.existsSync(rootDir)) continue;
      const findSessions = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== 'node_modules' && entry.name !== '.git') {
              findSessions(fullPath);
            }
          } else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.log'))) {
            try {
              const stat = fs.statSync(fullPath);
              sessions.push({
                id: entry.name.replace(/\.(jsonl|log)$/, ''),
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
    const fileStream = fs.createReadStream(session.path);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    let lineNumber = 0;

    for await (const line of rl) {
      lineNumber += 1;
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.type && record.type !== 'message') continue;
        const message = record.message && typeof record.message === 'object' ? record.message : record;
        const rawRole = message.role ?? message.from;
        if (rawRole !== 'user' && rawRole !== 'assistant') continue;
        const rawContent = message.content ?? message.text ?? message.msg;
        const content = typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
            : '';
        if (!content.trim()) continue;
        const timestamp = record.timestamp ?? message.timestamp;

        events.push({
          session_id: record.session_id ?? record.sessionId ?? message.session_id ?? session.id,
          event_id: record.id ?? message.id ?? `${session.id}-${lineNumber}`,
          timestamp: timestamp ? new Date(timestamp).toISOString() : new Date(session.mtime ?? fs.statSync(session.path).mtimeMs).toISOString(),
          project: extractProjectFromCwd(message.cwd ?? record.cwd ?? record.workspaceDir),
          role: rawRole as CanonicalRole,
          content: content.trim(),
          metadata: { raw_path: session.path }
        });
      } catch {}
    }

    return events;
  }
}
