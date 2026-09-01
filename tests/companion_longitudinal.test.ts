import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompanionScannerEngine, companionSessionsFromCanonicalEvents } from '../src/companion/engine.js';
import { generateLongitudinalCompanionCorpus } from '../src/simulation/companion-longitudinal.js';
import { evaluateLongitudinalCompanionCorpus } from '../src/companion/longitudinal-evaluator.js';
import { loadConfig } from '../src/config.js';
import { ingestConfiguredSessions } from '../src/scan/ingest.js';
import { SQLiteStorage } from '../src/storage/sqlite.js';

test('longitudinal companion corpus uses shared adapters, cursors, and canonical-event storage', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-longitudinal-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const sourceRoot = path.join(temp, 'sessions');
  const home = path.join(temp, 'home');
  const manifest = generateLongitudinalCompanionCorpus(sourceRoot);

  const committedRoot = path.resolve('tests/fixtures/companion-longitudinal-v2');
  assert.deepEqual(manifest, JSON.parse(fs.readFileSync(path.join(committedRoot, 'truth-ledger.json'), 'utf8')));
  assert.equal(
    fs.readFileSync(path.join(sourceRoot, 'user-lin', 'user-lin-s01.jsonl'), 'utf8'),
    fs.readFileSync(path.join(committedRoot, 'user-lin', 'user-lin-s01.jsonl'), 'utf8')
  );
  assert.equal(manifest.users.length, 4);
  assert.equal(manifest.generatedSessionCount, 48);
  assert.equal(manifest.generatedMessageCount, 416);
  assert.equal(new Set(manifest.users.flatMap(user => user.sessions)).size, 48);
  assert.throws(() => generateLongitudinalCompanionCorpus(sourceRoot), /Refusing to overwrite/);

  const config = loadConfig(home);
  config.sources = [{ id: 'companion', adapter: 'openclaw', rootPath: sourceRoot }];
  const storage = new SQLiteStorage(config.sqlitePath);
  t.after(() => storage.close());

  const first = await ingestConfiguredSessions(config, storage, { now: '2031-01-01T00:00:00.000Z', persistCanonicalEvents: true });
  assert.deepEqual(
    { discovered: first.sessionsDiscovered, processed: first.sessionsProcessed, skipped: first.sessionsSkipped },
    { discovered: 48, processed: 48, skipped: 0 }
  );
  assert.equal(storage.getCanonicalEventsBySource('src_companion').length, 416);

  const second = await ingestConfiguredSessions(config, storage, { now: '2031-01-02T00:00:00.000Z', persistCanonicalEvents: true });
  assert.deepEqual(
    { discovered: second.sessionsDiscovered, processed: second.sessionsProcessed, skipped: second.sessionsSkipped },
    { discovered: 48, processed: 0, skipped: 48 }
  );
  assert.equal(storage.getCanonicalEventsBySource('src_companion').length, 416);

  const changedSession = path.join(sourceRoot, 'user-lin', 'user-lin-s12.jsonl');
  fs.appendFileSync(changedSession, `${JSON.stringify({
    id: 'user-lin-s12-m09', session_id: 'user-lin-s12', timestamp: '2030-06-10T10:30:00.000Z',
    cwd: '/simulated-companion/user-lin', role: 'user', content: '补充一句：当前偏好没有再次变化。'
  })}\n`);
  const third = await ingestConfiguredSessions(config, storage, { now: '2031-01-03T00:00:00.000Z', persistCanonicalEvents: true });
  assert.equal(third.sessionsProcessed, 1);
  assert.equal(third.sessionsSkipped, 47);
  assert.equal(storage.getCanonicalEventsBySource('src_companion').length, 417);

  const sessions = companionSessionsFromCanonicalEvents(storage.getCanonicalEventsBySource('src_companion'));
  assert.equal(sessions.length, 48);
  assert.deepEqual([...new Set(sessions.map(session => session.topic))].sort(), ['user-chen', 'user-lin', 'user-shen', 'user-zhou']);
  const snapshots = new Map();
  for (const user of manifest.users) {
    const userSessions = sessions.filter(session => session.topic === user.userId);
    snapshots.set(user.userId, new CompanionScannerEngine().scanCompanionDataset(userSessions));
  }
  const report = evaluateLongitudinalCompanionCorpus(manifest, snapshots);
  const summary = report.summary as { tp: number; fp: number; fn: number; recall: number; f1: number; attribution_errors: number };
  assert.equal(summary.fn, 0);
  assert.equal(summary.recall, 1);
  assert.ok(summary.f1 > 0.9);
  assert.equal(summary.attribution_errors, 0);
  const linSessions = sessions.filter(session => session.topic === 'user-lin');
  const firstSnapshot = new CompanionScannerEngine().scanCompanionDataset(linSessions.slice(0, -1));
  const incrementalSnapshot = new CompanionScannerEngine(undefined, firstSnapshot).scanCompanionDataset(linSessions.slice(-1));
  const fullSnapshot = snapshots.get('user-lin')!;
  assert.deepEqual(incrementalSnapshot.operations_log, fullSnapshot.operations_log);
  assert.deepEqual(incrementalSnapshot.fact_store, fullSnapshot.fact_store);

  const operationSummary = report.operation_summary as { tp: number; fn: number; f1: number };
  assert.ok(operationSummary.tp >= 47);
  assert.ok(operationSummary.fn <= 5);
  assert.ok(operationSummary.f1 > 0.85);
});
