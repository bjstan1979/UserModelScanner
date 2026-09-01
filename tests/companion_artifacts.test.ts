import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliController } from '../src/cli/commands.js';

test('single-user companion scan writes portable Markdown under the configured home', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-artifacts-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'sessions');
  const home = path.join(temp, 'home');
  fs.mkdirSync(source);
  const messages = [
    { id: 'm1', session_id: 's1', timestamp: '2030-01-01T00:00:00.000Z', cwd: '/companion', role: 'user', content: '我叫林青。' },
    { id: 'm2', session_id: 's1', timestamp: '2030-01-01T00:01:00.000Z', cwd: '/companion', role: 'assistant', content: '你好，林青。' },
    { id: 'm3', session_id: 's1', timestamp: '2030-01-01T00:02:00.000Z', cwd: '/companion', role: 'user', content: '接收长篇资料时，我目前首选可搜索网页长文。' },
    { id: 'm4', session_id: 's1', timestamp: '2030-01-01T00:03:00.000Z', cwd: '/companion', role: 'assistant', content: '记住了。' }
  ];
  fs.writeFileSync(path.join(source, 's1.jsonl'), `${messages.map(message => JSON.stringify(message)).join('\n')}\n`);

  const controller = new CliController(home);
  try {
    await controller.runCompanionScan({ source, adapter: 'openclaw', provider: 'rule' });
  } finally {
    controller.close();
  }

  const companionDir = path.join(home, 'companion');
  const userMarkdown = fs.readFileSync(path.join(companionDir, 'USER.md'), 'utf8');
  assert.match(userMarkdown, /^# USER/m);
  assert.match(userMarkdown, /林青/);
  assert.doesNotMatch(userMarkdown, /undefined/);
  assert.equal(userMarkdown, fs.readFileSync(path.join(companionDir, 'USER_MODEL.md'), 'utf8'));
  for (const file of ['RELATIONSHIP.md', 'COMPANION_IDENTITY.md', 'EPISODIC_MEMORY.md', 'CURRENT_CONTEXT.md', 'companion-model.json']) {
    assert.ok(fs.existsSync(path.join(companionDir, file)), file);
  }
});
