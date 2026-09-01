export type CanonicalRole = 'user' | 'assistant' | 'tool' | 'system';

export interface CanonicalEvent {
  session_id: string;
  event_id: string;
  timestamp: string; // ISO-8601 string
  project: string | null;
  role: CanonicalRole;
  content: string;
  metadata?: {
    model?: string;
    cwd?: string;
    tool_name?: string;
    raw_path?: string;
    [key: string]: any;
  };
}

export function extractProjectFromCwd(cwd?: string | null): string | null {
  if (!cwd) return null;
  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || null;
}

export function normalizeTimestamp(raw?: string | number | null): string {
  if (!raw) return new Date().toISOString();
  if (typeof raw === 'number') {
    // If microseconds (> 1e14)
    if (raw > 1e14) {
      return new Date(Math.floor(raw / 1000)).toISOString();
    }
    // If milliseconds (> 1e11)
    if (raw > 1e11) {
      return new Date(raw).toISOString();
    }
    // If seconds
    return new Date(raw * 1000).toISOString();
  }
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      // Check year range
      if (d.getFullYear() > 2100) {
        // likely epoch with extra precision in string
        const num = Number(raw);
        if (!isNaN(num)) return normalizeTimestamp(num);
      }
      return d.toISOString();
    }
  } catch {}
  return new Date().toISOString();
}
