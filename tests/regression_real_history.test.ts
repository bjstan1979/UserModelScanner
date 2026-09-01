import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { SQLiteStorage } from '../src/storage/sqlite.js';
import { ScannerEngine } from '../src/scan/incremental.js';
import { extractCandidatesFromSession } from '../src/evidence/extract.js';
import { buildSessionDigest } from '../src/normalize/session-digest.js';
import { CanonicalEvent } from '../src/normalize/canonical-event.js';

test('Regression 1: "端口改成9800" must NOT enter USER MODEL', () => {
  const events: CanonicalEvent[] = [
    { session_id: 's_port', event_id: 'e1', timestamp: '2026-08-30T00:00:00Z', project: 'api', role: 'user', content: '端口改成9800，服务重新启动一下' }
  ];
  const digest = buildSessionDigest('s_port', 'pi', events);
  const candidates = extractCandidatesFromSession('pi', events, digest);
  assert.equal(candidates.length, 0);
});

test('Regression 2: "按钮不要用纯红色" (one-off UI/styling requirement) must NOT become durable preference', () => {
  const events: CanonicalEvent[] = [
    { session_id: 's_ui', event_id: 'e1', timestamp: '2026-08-30T00:00:00Z', project: 'web', role: 'user', content: '按钮不要用纯红色，改成深蓝色，padding改成16px居中' }
  ];
  const digest = buildSessionDigest('s_ui', 'pi', events);
  const candidates = extractCandidatesFromSession('pi', events, digest);
  assert.equal(candidates.length, 0);
});

test('Regression 3: "以后这种可逆任务不要每次问我，直接做" enters Collaboration Style', () => {
  const events: CanonicalEvent[] = [
    { session_id: 's_collab', event_id: 'e1', timestamp: '2026-08-30T00:00:00Z', project: 'web', role: 'user', content: '以后这种可逆任务不要每次问我，直接做' }
  ];
  const digest = buildSessionDigest('s_collab', 'pi', events);
  const candidates = extractCandidatesFromSession('pi', events, digest);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].category, 'collaboration_style');
  assert.equal(candidates[0].scope, 'reversible-actions');
  assert.ok(candidates[0].statement.includes('reversible local engineering work'));
});

test('Regression 4: "实验没收益就删掉，不因为是我提的就保留" enters Values / Principles', () => {
  const events: CanonicalEvent[] = [
    { session_id: 's_val', event_id: 'e1', timestamp: '2026-08-30T00:00:00Z', project: 'core', role: 'user', content: '实验没收益就删掉，不因为是我提的就保留' }
  ];
  const digest = buildSessionDigest('s_val', 'pi', events);
  const candidates = extractCandidatesFromSession('pi', events, digest);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].category, 'values_principles');
  assert.ok(candidates[0].statement.includes('pruning unnecessary complexity'));
});

test('Regression 5: Quoted previous-session summary / memory summary cannot be extracted as new user evidence', () => {
  const quotedContent = `
<claude-mem-context>
# Memory Context
# $CMEM .openclaw 2026-04-25 5:09pm GMT+8
5228 1:51p OpenClaw Configuration File Differences
5574 4:38p User Requested Avoidance of Sandbox Execution
</claude-mem-context>
<INSTRUCTIONS>
User prefers concise output and direct diffs.
</INSTRUCTIONS>
请帮我看下这个项目的日志报错。
`;

  const events: CanonicalEvent[] = [
    { session_id: 's_quote', event_id: 'e1', timestamp: '2026-08-30T00:00:00Z', project: 'openclaw', role: 'user', content: quotedContent }
  ];
  const digest = buildSessionDigest('s_quote', 'pi', events);
  const candidates = extractCandidatesFromSession('pi', events, digest);
  assert.equal(candidates.length, 0);
});

test('Regression 6: 4 different sessions supporting the same reversible-actions trait generate exactly ONE trait with accumulated evidence/session count', async () => {
  const tmpHome = path.join(os.tmpdir(), `reg6-test-${Date.now()}`);
  const piDir = path.join(tmpHome, 'pi-sessions');
  fs.mkdirSync(piDir, { recursive: true });

  for (let i = 1; i <= 4; i++) {
    fs.writeFileSync(
      path.join(piDir, `sess-${i}.jsonl`),
      [
        JSON.stringify({ type: 'session', version: 3, id: `s_${i}`, cwd: `/app/proj_${i}` }),
        JSON.stringify({ type: 'message', id: `m_${i}`, message: { role: 'user', content: '以后这种可逆任务不要每次问我，直接做' } })
      ].join('\n')
    );
  }

  const config = loadConfig(tmpHome);
  config.sources = [{ id: 'src_pi', adapter: 'pi', rootPath: piDir, enabled: true }];

  const storage = new SQLiteStorage(config.sqlitePath);
  const engine = new ScannerEngine(config, storage, 'rule');

  const result = await engine.scan();
  assert.equal(result.sessionsProcessed, 4);

  const traits = storage.getAllTraits();
  const reversibleTraits = traits.filter(t => t.scope === 'reversible-actions');

  // Must be EXACTLY ONE trait, NOT 4 duplicates!
  assert.equal(reversibleTraits.length, 1);
  assert.equal(reversibleTraits[0].distinct_sessions, 4);
  assert.equal(reversibleTraits[0].support_count, 4);
  assert.equal(reversibleTraits[0].status, 'stable');

  storage.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('Regression 7: Raw task corrections never appear in USER.md', async () => {
  const tmpHome = path.join(os.tmpdir(), `reg7-test-${Date.now()}`);
  const piDir = path.join(tmpHome, 'pi-sessions');
  fs.mkdirSync(piDir, { recursive: true });

  fs.writeFileSync(
    path.join(piDir, 'sess-raw.jsonl'),
    [
      JSON.stringify({ type: 'session', version: 3, id: 's_raw', cwd: '/app/a' }),
      JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: '端口改成9800，按钮不要用纯红色，那你修一下' } }),
      JSON.stringify({ type: 'message', id: 'm2', message: { role: 'user', content: '保持 runtime 薄，没有收益就删掉复杂度。' } })
    ].join('\n')
  );

  const config = loadConfig(tmpHome);
  config.sources = [{ id: 'src_pi', adapter: 'pi', rootPath: piDir, enabled: true }];

  const storage = new SQLiteStorage(config.sqlitePath);
  const engine = new ScannerEngine(config, storage, 'rule');
  await engine.scan();

  const userMd = fs.readFileSync(config.userMdPath, 'utf-8');
  assert.ok(!userMd.includes('Correction noted'));
  assert.ok(!userMd.includes('9800'));
  assert.ok(!userMd.includes('纯红色'));
  assert.ok(!userMd.includes('那你修一下'));

  storage.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
