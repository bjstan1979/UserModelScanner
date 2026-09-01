import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidatesFromSession, triageSession } from '../src/evidence/extract.js';
import { buildSessionDigest } from '../src/normalize/session-digest.js';
import { CanonicalEvent } from '../src/normalize/canonical-event.js';

test('Triage skips trivial single-command sessions', () => {
  const events: CanonicalEvent[] = [
    { session_id: 's1', event_id: 'e1', timestamp: '2026-08-30T00:00:00Z', project: 'proj', role: 'user', content: 'ls' },
    { session_id: 's1', event_id: 'e2', timestamp: '2026-08-30T00:00:01Z', project: 'proj', role: 'assistant', content: 'file1.txt file2.txt' }
  ];
  const digest = buildSessionDigest('s1', 'pi', events);
  assert.equal(triageSession(digest), false);
  const candidates = extractCandidatesFromSession('pi', events, digest);
  assert.equal(candidates.length, 0);
});

test('Anti-self-reinforcement ignores assistant and system outputs', () => {
  const events: CanonicalEvent[] = [
    { session_id: 's2', event_id: 'e1', timestamp: '2026-08-30T00:00:00Z', project: 'proj', role: 'system', content: 'User prefers concise output and strict typescript' },
    { session_id: 's2', event_id: 'e2', timestamp: '2026-08-30T00:00:01Z', project: 'proj', role: 'assistant', content: 'I notice you prefer concise diffs and pnpm. I will keep runtime thin.' },
    { session_id: 's2', event_id: 'e3', timestamp: '2026-08-30T00:00:02Z', project: 'proj', role: 'user', content: 'ok' }
  ];
  const digest = buildSessionDigest('s2', 'pi', events);
  const candidates = extractCandidatesFromSession('pi', events, digest);
  // Should not extract anything from assistant or system!
  assert.equal(candidates.length, 0);
});

test('Sensitive information is filtered out', () => {
  const events: CanonicalEvent[] = [
    { session_id: 's3', event_id: 'e1', timestamp: '2026-08-30T00:00:00Z', project: 'proj', role: 'user', content: 'My password is secret123, keep it in mind.' }
  ];
  const digest = buildSessionDigest('s3', 'pi', events);
  const candidates = extractCandidatesFromSession('pi', events, digest);
  assert.equal(candidates.length, 0);
});

test('Extracts valid user preferences, decision style, and principles', () => {
  const events: CanonicalEvent[] = [
    { session_id: 's4', event_id: 'e1', timestamp: '2026-08-30T00:00:00Z', project: 'proj', role: 'user', content: '我不喜欢冗长的解释，请直接给出diff。另外在项目中保持 runtime 薄，没有收益就删掉复杂度。' }
  ];
  const digest = buildSessionDigest('s4', 'pi', events);
  assert.equal(triageSession(digest), true);
  const candidates = extractCandidatesFromSession('pi', events, digest);
  assert.ok(candidates.length >= 2);

  const categories = candidates.map(c => c.category);
  assert.ok(categories.includes('preferences'));
  assert.ok(categories.includes('values_principles'));
});
