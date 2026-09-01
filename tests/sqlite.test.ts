import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SQLiteStorage } from '../src/storage/sqlite.js';

test('SQLiteStorage schema initialization and basic CRUD', () => {
  const tmpDb = path.join(os.tmpdir(), `test-user-model-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const storage = new SQLiteStorage(tmpDb);

  // 1. Source
  storage.upsertSource({
    id: 'src_pi_local',
    adapter: 'pi',
    root_path: '/tmp/pi-sessions',
    last_scan_at: '2026-08-30T00:00:00Z',
    config_json: JSON.stringify({ pattern: '*.jsonl' })
  });
  const source = storage.getSource('src_pi_local');
  assert.ok(source);
  assert.equal(source.adapter, 'pi');

  // 2. Session
  storage.upsertSession({
    id: 'sess_1',
    source_id: 'src_pi_local',
    external_id: 'ext_pi_1',
    fingerprint: 'fp_abc123',
    started_at: '2026-08-30T01:00:00Z',
    project: 'proj-a',
    processed_version: '2.0.0',
    last_processed_at: '2026-08-30T01:05:00Z'
  });
  const session = storage.getSession('sess_1');
  assert.ok(session);
  assert.equal(session.fingerprint, 'fp_abc123');

  // 3. Evidence Event
  storage.insertEvidenceEvent({
    id: 'ev_1',
    category: 'decision_style',
    statement: 'Prefers empirical validation over initial design assumptions',
    candidate: 'prefers empirical validation',
    signal_type: 'explicit_statement',
    strength: 0.9,
    timestamp: '2026-08-30T01:02:00Z',
    source_session_id: 'sess_1',
    source_event_refs_json: JSON.stringify(['msg_1']),
    context_json: JSON.stringify({ project: 'proj-a', task: 'refactor' })
  });
  const ev = storage.getEvidenceEvent('ev_1');
  assert.ok(ev);
  assert.equal(ev.category, 'decision_style');

  // 4. Trait
  storage.upsertTrait({
    id: 'trait_1',
    category: 'decision_style',
    ontology: 'USER_GLOBAL',
    statement: 'Prefers empirical validation over initial design assumptions',
    scope: 'global',
    domain: null,
    tool: null,
    environment: null,
    project_id: null,
    portability_score: 0.95,
    status: 'working',
    confidence: 0.85,
    support_count: 1,
    contradiction_count: 0,
    distinct_sessions: 1,
    distinct_contexts: 1,
    first_seen: '2026-08-30T01:02:00Z',
    last_confirmed: '2026-08-30T01:02:00Z'
  });
  const trait = storage.getTrait('trait_1');
  assert.ok(trait);
  assert.equal(trait.status, 'working');

  // 5. Link Trait & Evidence
  storage.linkTraitEvidence('trait_1', 'ev_1', 'support');
  const evList = storage.getEvidenceForTrait('trait_1');
  assert.equal(evList.length, 1);
  assert.equal(evList[0].relation, 'support');

  // 6. Trait History
  storage.recordTraitHistory({
    trait_id: 'trait_1',
    old_json: null,
    new_json: JSON.stringify(trait),
    reason: 'Initial creation from session sess_1',
    changed_at: '2026-08-30T01:05:00Z'
  });
  const history = storage.getTraitHistory('trait_1');
  assert.equal(history.length, 1);

  // 7. Scan Runs
  storage.insertScanRun({
    id: 'run_1',
    started_at: '2026-08-30T01:00:00Z',
    finished_at: '2026-08-30T01:05:00Z',
    mode: 'bootstrap',
    stats_json: JSON.stringify({ sessionsProcessed: 1, traitsCreated: 1 }),
    extractor_version: '2.0.0'
  });
  const latestRun = storage.getLatestScanRun();
  assert.ok(latestRun);
  assert.equal(latestRun.id, 'run_1');

  storage.close();
  try { fs.unlinkSync(tmpDb); } catch {}
});
