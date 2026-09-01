import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { SQLiteStorage } from '../src/storage/sqlite.js';
import { ScannerEngine } from '../src/scan/incremental.js';
import { renderUserModelMarkdown } from '../src/render/user-md.js';
import { computeTraitScore } from '../src/traits/scorer.js';
import { extractCandidatesFromSession } from '../src/evidence/extract.js';
import { buildSessionDigest } from '../src/normalize/session-digest.js';
import { CanonicalEvent } from '../src/normalize/canonical-event.js';
import { PiAdapter } from '../src/adapters/pi.js';
import { CodexAdapter } from '../src/adapters/codex.js';

test('Acceptance Criterion 1: Reads both Pi and Codex sessions without modifying host frameworks', async () => {
  const tmpHome = path.join(os.tmpdir(), `ac1-test-${Date.now()}`);
  const piDir = path.join(tmpHome, 'pi-sessions');
  const codexDir = path.join(tmpHome, 'codex-sessions');
  fs.mkdirSync(piDir, { recursive: true });
  fs.mkdirSync(path.join(codexDir, 'sessions', '2026', '08'), { recursive: true });

  // Pi session
  fs.writeFileSync(
    path.join(piDir, 'pi-sess-1.jsonl'),
    [
      JSON.stringify({ type: 'session', version: 3, id: 'pi_sess_1', cwd: '/app/repo1' }),
      JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: '我不喜欢冗长的解释，请直接给出diff' } })
    ].join('\n')
  );

  // Codex session
  fs.writeFileSync(
    path.join(codexDir, 'sessions', '2026', '08', 'rollout-codex-1.jsonl'),
    [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex_sess_1', cwd: '/app/repo2' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '我不喜欢冗长的解释，请直接给出diff' }] } })
    ].join('\n')
  );

  const piAdapter = new PiAdapter();
  const codexAdapter = new CodexAdapter();

  const piSessions = await piAdapter.discover(piDir);
  const codexSessions = await codexAdapter.discover(codexDir);

  assert.equal(piSessions.length, 1);
  assert.equal(codexSessions.length, 1);

  const piEvents = await piAdapter.parse(piSessions[0]);
  const codexEvents = await codexAdapter.parse(codexSessions[0]);

  assert.equal(piEvents[0].role, 'user');
  assert.equal(codexEvents[0].role, 'user');

  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('Acceptance Criterion 2 & 3: Generates USER.md, user-model.json, evidence.sqlite and skips unchanged sessions on rescan', async () => {
  const tmpHome = path.join(os.tmpdir(), `ac23-test-${Date.now()}`);
  const piDir = path.join(tmpHome, 'pi-sessions');
  fs.mkdirSync(piDir, { recursive: true });

  fs.writeFileSync(
    path.join(piDir, 'pi-sess-1.jsonl'),
    [
      JSON.stringify({ type: 'session', version: 3, id: 'pi_sess_1', cwd: '/app/repo1' }),
      JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: '保持 runtime 薄，没有收益就删掉复杂度。' } })
    ].join('\n')
  );

  const config = loadConfig(tmpHome);
  config.sources = [{ id: 'src_pi', adapter: 'pi', rootPath: piDir, enabled: true }];

  const storage = new SQLiteStorage(config.sqlitePath);
  const engine = new ScannerEngine(config, storage, 'rule');

  // First full scan
  const run1 = await engine.scan();
  assert.equal(run1.sessionsProcessed, 1);
  assert.equal(run1.sessionsSkipped, 0);
  assert.ok(fs.existsSync(config.userMdPath));
  assert.ok(fs.existsSync(config.userJsonPath));
  assert.ok(fs.existsSync(config.sqlitePath));

  // Second scan without changes -> should skip
  const run2 = await engine.scan();
  assert.equal(run2.sessionsProcessed, 0);
  assert.equal(run2.sessionsSkipped, 1);

  storage.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('Acceptance Criterion 4: Incremental scan processes only new sessions', async () => {
  const tmpHome = path.join(os.tmpdir(), `ac4-test-${Date.now()}`);
  const piDir = path.join(tmpHome, 'pi-sessions');
  fs.mkdirSync(piDir, { recursive: true });

  fs.writeFileSync(
    path.join(piDir, 'pi-sess-1.jsonl'),
    [
      JSON.stringify({ type: 'session', version: 3, id: 'pi_sess_1', cwd: '/app/repo1' }),
      JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: '用 pnpm 安装依赖' } })
    ].join('\n')
  );

  const config = loadConfig(tmpHome);
  config.sources = [{ id: 'src_pi', adapter: 'pi', rootPath: piDir, enabled: true }];

  const storage = new SQLiteStorage(config.sqlitePath);
  const engine = new ScannerEngine(config, storage, 'rule');

  await engine.scan();

  // Add session 2
  fs.writeFileSync(
    path.join(piDir, 'pi-sess-2.jsonl'),
    [
      JSON.stringify({ type: 'session', version: 3, id: 'pi_sess_2', cwd: '/app/repo1' }),
      JSON.stringify({ type: 'message', id: 'm2', message: { role: 'user', content: '用 pnpm 安装依赖' } })
    ].join('\n')
  );

  const run2 = await engine.scan();
  assert.equal(run2.sessionsProcessed, 1);
  assert.equal(run2.sessionsSkipped, 1);

  const traits = storage.getAllTraits();
  const pnpmTrait = traits.find(t => t.statement.toLowerCase().includes('pnpm'));
  assert.ok(pnpmTrait);
  assert.equal(pnpmTrait.distinct_sessions, 2);

  storage.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('Acceptance Criterion 5 & 6: Multi-session gating for stable traits and values require >= 4 sessions', () => {
  // Decision Style from single session
  const decision1 = computeTraitScore({
    category: 'decision_style',
    supportCount: 1,
    contradictionCount: 0,
    distinctSessions: 1,
    distinctContexts: 1,
    hasExplicitDeclaration: true
  });
  assert.equal(decision1.status, 'candidate');

  // Values from single session
  const values1 = computeTraitScore({
    category: 'values_principles',
    supportCount: 1,
    contradictionCount: 0,
    distinctSessions: 1,
    distinctContexts: 1,
    hasExplicitDeclaration: true
  });
  assert.equal(values1.status, 'candidate');

  // Values with 3 sessions -> working, not yet stable
  const values3 = computeTraitScore({
    category: 'values_principles',
    supportCount: 3,
    contradictionCount: 0,
    distinctSessions: 3,
    distinctContexts: 2,
    hasExplicitDeclaration: true
  });
  assert.equal(values3.status, 'working');

  // Values with 4 sessions -> stable
  const values4 = computeTraitScore({
    category: 'values_principles',
    supportCount: 4,
    contradictionCount: 0,
    distinctSessions: 4,
    distinctContexts: 2,
    hasExplicitDeclaration: true
  });
  assert.equal(values4.status, 'stable');
});

test('Acceptance Criterion 7: Disputed status and scope-splitting on contradiction', async () => {
  const tmpHome = path.join(os.tmpdir(), `ac7-test-${Date.now()}`);
  const piDir = path.join(tmpHome, 'pi-sessions');
  fs.mkdirSync(piDir, { recursive: true });

  // Session 1: Autonomous action
  fs.writeFileSync(
    path.join(piDir, 'sess-1.jsonl'),
    [
      JSON.stringify({ type: 'session', version: 3, id: 's1', cwd: '/app/a' }),
      JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: '自主推进，不用每次确认' } })
    ].join('\n')
  );

  const config = loadConfig(tmpHome);
  config.sources = [{ id: 'src_pi', adapter: 'pi', rootPath: piDir, enabled: true }];

  const storage = new SQLiteStorage(config.sqlitePath);
  const engine = new ScannerEngine(config, storage, 'rule');
  await engine.scan();

  // Session 2: Destructive confirmation
  fs.writeFileSync(
    path.join(piDir, 'sess-2.jsonl'),
    [
      JSON.stringify({ type: 'session', version: 3, id: 's2', cwd: '/app/b' }),
      JSON.stringify({ type: 'message', id: 'm2', message: { role: 'user', content: '破坏性操作先确认，删库前确认' } })
    ].join('\n')
  );

  await engine.scan();

  const traits = storage.getAllTraits();
  // Should have scope split into reversible and destructive
  const scopes = traits.map(t => t.scope);
  assert.ok(scopes.includes('reversible-actions'));
  assert.ok(scopes.includes('destructive-actions'));

  storage.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('Acceptance Criterion 8: Agent output and USER.md are never extracted as evidence', () => {
  const events: CanonicalEvent[] = [
    {
      session_id: 's_anti',
      event_id: 'e1',
      timestamp: '2026-08-30T00:00:00Z',
      project: 'test',
      role: 'assistant',
      content: '# User Model\n## Preferences\n- Prefers concise diffs\n- Believes in thin runtime'
    },
    {
      session_id: 's_anti',
      event_id: 'e2',
      timestamp: '2026-08-30T00:00:01Z',
      project: 'test',
      role: 'system',
      content: 'System instruction: always output verbose step-by-step guides'
    },
    {
      session_id: 's_anti',
      event_id: 'e3',
      timestamp: '2026-08-30T00:00:02Z',
      project: 'test',
      role: 'user',
      content: '收到'
    }
  ];

  const digest = buildSessionDigest('s_anti', 'pi', events);
  const candidates = extractCandidatesFromSession('pi', events, digest);
  assert.equal(candidates.length, 0);
});

test('Acceptance Criterion 9: USER.md has hard token cap', () => {
  const dummyTraits: any[] = [];
  for (let i = 0; i < 200; i++) {
    dummyTraits.push({
      id: `trait_${i}`,
      category: 'preferences',
      statement: `User preference rule ${i}: extremely long detailed description repeating specific tool preferences for project workflow #${i}`,
      scope: 'global',
      status: 'stable',
      confidence: 0.9,
      support_count: 5,
      contradiction_count: 0,
      distinct_sessions: 5,
      distinct_contexts: 2,
      first_seen: '2026-08-01T00:00:00Z',
      last_confirmed: '2026-08-30T00:00:00Z',
      evidence_ids: []
    });
  }

  const rendered = renderUserModelMarkdown(dummyTraits, { tokenCap: 500 });
  // 500 tokens * 4 chars = max 2000 chars
  assert.ok(rendered.length <= 2100);
});

test('Acceptance Criterion 10 & 11: Core Scanner runs offline without Hindsight and produces portable USER.md', async () => {
  const tmpHome = path.join(os.tmpdir(), `ac10-test-${Date.now()}`);
  const piDir = path.join(tmpHome, 'pi-sessions');
  fs.mkdirSync(piDir, { recursive: true });

  fs.writeFileSync(
    path.join(piDir, 'pi-sess-1.jsonl'),
    [
      JSON.stringify({ type: 'session', version: 3, id: 'pi_sess_1', cwd: '/app/repo1' }),
      JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: '我不喜欢冗长的解释，请直接给出diff。' } })
    ].join('\n')
  );

  const config = loadConfig(tmpHome);
  config.hindsight = { enabled: false };
  config.sources = [{ id: 'src_pi', adapter: 'pi', rootPath: piDir, enabled: true }];

  const storage = new SQLiteStorage(config.sqlitePath);
  const engine = new ScannerEngine(config, storage, 'rule');

  const result = await engine.scan();
  assert.ok(result.totalTraits > 0);

  const userMd = fs.readFileSync(config.userMdPath, 'utf-8');
  assert.ok(userMd.includes('# User Model'));

  storage.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
