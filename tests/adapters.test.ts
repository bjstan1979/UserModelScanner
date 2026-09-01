import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PiAdapter } from '../src/adapters/pi.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { WorkBuddyAdapter } from '../src/adapters/workbuddy.js';

test('PiAdapter discovers and parses pi sessions', async () => {
  const tmpDir = path.join(os.tmpdir(), `test-pi-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const sampleSession = path.join(tmpDir, '2026-08-30T00-00-00Z_sample-pi-1.jsonl');
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'pi_sess_001', timestamp: '2026-08-30T00:00:00.000Z', cwd: '/projects/my-app' }),
    JSON.stringify({ type: 'message', id: 'm1', timestamp: '2026-08-30T00:01:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '我不喜欢冗长的解释，请直接给出diff' }] } }),
    JSON.stringify({ type: 'message', id: 'm2', timestamp: '2026-08-30T00:02:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '好的，这是diff...' }] } })
  ];
  fs.writeFileSync(sampleSession, lines.join('\n'));

  const adapter = new PiAdapter();
  const discovered = await adapter.discover(tmpDir);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].adapter, 'pi');

  const fp = await adapter.fingerprint(discovered[0]);
  assert.ok(fp && fp.length > 10);

  const events = await adapter.parse(discovered[0]);
  assert.equal(events.length, 2);
  assert.equal(events[0].role, 'user');
  assert.equal(events[0].content, '我不喜欢冗长的解释，请直接给出diff');
  assert.equal(events[0].project, 'my-app');
  assert.equal(events[1].role, 'assistant');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('CodexAdapter discovers and parses codex rollout and history sessions', async () => {
  const tmpDir = path.join(os.tmpdir(), `test-codex-${Date.now()}`);
  const sessionsDir = path.join(tmpDir, 'sessions', '2026', '08');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const rolloutFile = path.join(sessionsDir, 'rollout-2026-08-30-019f-sample.jsonl');
  const lines = [
    JSON.stringify({ timestamp: '2026-08-30T10:00:00.000Z', type: 'session_meta', payload: { session_id: 'codex_sess_001', cwd: '/work/backend-api' } }),
    JSON.stringify({ timestamp: '2026-08-30T10:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Always run tests before finishing any task' }] } }),
    JSON.stringify({ timestamp: '2026-08-30T10:02:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Running test suite now...' }] } })
  ];
  fs.writeFileSync(rolloutFile, lines.join('\n'));

  const adapter = new CodexAdapter();
  const discovered = await adapter.discover(tmpDir);
  assert.ok(discovered.length >= 1);

  const rolloutRef = discovered.find(d => d.path.includes('rollout-'));
  assert.ok(rolloutRef);

  const events = await adapter.parse(rolloutRef);
  assert.equal(events.length, 2);
  assert.equal(events[0].role, 'user');
  assert.equal(events[0].content, 'Always run tests before finishing any task');
  assert.equal(events[0].project, 'backend-api');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('WorkBuddyAdapter discovers and parses workbuddy project sessions', async () => {
  const tmpDir = path.join(os.tmpdir(), `test-wb-${Date.now()}`);
  const projDir = path.join(tmpDir, 'projects', 'my-wb-proj');
  fs.mkdirSync(projDir, { recursive: true });

  const sessionFile = path.join(projDir, 'wb-sess-001.jsonl');
  const lines = [
    JSON.stringify({
      id: 'm1',
      timestamp: 1785862587708,
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<system-reminder data-role="user-context">Injected context</system-reminder><user_query>叫我老肖，我的风格是干脆利落</user_query>' }],
      cwd: 'C:\\Users\\Administrator\\WorkBuddy\\Claw'
    }),
    JSON.stringify({
      id: 'm2',
      timestamp: 1785862600000,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '好的老肖！' }],
      cwd: 'C:\\Users\\Administrator\\WorkBuddy\\Claw'
    })
  ];
  fs.writeFileSync(sessionFile, lines.join('\n'));

  const adapter = new WorkBuddyAdapter();
  const discovered = await adapter.discover(tmpDir);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].adapter, 'workbuddy');

  const events = await adapter.parse(discovered[0]);
  assert.equal(events.length, 2);
  assert.equal(events[0].role, 'user');
  assert.equal(events[0].content, '叫我老肖，我的风格是干脆利落');
  assert.equal(events[0].project, 'Claw');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
