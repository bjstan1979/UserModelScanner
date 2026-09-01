import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CompanionScannerEngine, CompanionSession } from '../src/companion/engine.js';

function scan(sessions: CompanionSession[]) {
  return new CompanionScannerEngine().scanCompanionDataset(sessions);
}

function session(session_id: string, date: string, content: string, assistantContent?: string): CompanionSession {
  return {
    session_id,
    date,
    topic: 'mutation',
    messages: [
      { id: `${session_id}-U01`, role: 'user', content },
      ...(assistantContent ? [{ id: `${session_id}-A01`, role: 'assistant' as const, content: assistantContent }] : [])
    ]
  };
}

test('legacy known holdout is regression-only, not evidence of blind generalization', () => {
  const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'holdout-companion-sessions.json');
  const sessions: CompanionSession[] = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const snapshot = scan(sessions);
  const evidenceText = new Map(sessions.flatMap(item => item.messages.map(message => [message.id, message.content] as const)));

  assert.ok(snapshot.operations_log.length > 0, 'Known holdout remains useful as a non-blind regression fixture');
  for (const operation of snapshot.operations_log) {
    assert.ok(operation.sourceSpans && operation.sourceSpans.length > 0);
    for (const span of operation.sourceSpans ?? []) {
      const source = evidenceText.get(span.messageId);
      assert.equal(source?.slice(span.start, span.end), span.text, 'Every operation must carry an exact source span');
    }
  }
  assert.ok(snapshot.episodic_memory.every(episode => episode.id.startsWith('event-')));
  assert.ok(snapshot.episodic_memory.every(episode => !/^EM-/.test(episode.id)), 'Episode IDs must not use benchmark numbering');

  const serialized = JSON.stringify(snapshot);
  for (const leaked of ['林屿', '阿岚', '小屿', '团子', '桥灯']) {
    assert.ok(!serialized.includes(leaked), `Known holdout must not leak ${leaked}`);
  }
});

test('paraphrased identity and order variation preserve extracted atoms', () => {
  const first = scan([session('P01', '2031-01-01', '我叫苏云，25岁，住在南京从事建筑设计。')]);
  const second = scan([session('P02', '2031-01-01', '我叫何清，31岁，在武汉做前端开发。')]);

  assert.equal(first.user_model.name, '苏云');
  assert.equal(first.user_model.age, 25);
  assert.ok(first.user_model.location?.includes('南京'));
  assert.equal(second.user_model.name, '何清');
  assert.equal(second.user_model.age, 31);
  assert.ok(second.user_model.location?.includes('武汉'));
});

test('assistant claims never become user-model evidence', () => {
  const snapshot = scan([
    session('A01', '2031-02-01', '我叫顾言，29岁，在西安做数据分析。', '我记得你在海边长大，而且天生害怕失败。')
  ]);
  const serializedActive = JSON.stringify({
    user_model: snapshot.user_model,
    relationship_model: snapshot.relationship_model,
    companion_identity: snapshot.companion_identity,
    episodic_memory: snapshot.episodic_memory,
    current_context: snapshot.current_context
  });
  assert.ok(!serializedActive.includes('海边长大'));
  assert.ok(!serializedActive.includes('天生害怕失败'));
  assert.ok(snapshot.operations_log.every(operation => !operation.evidenceIds.some(id => id.endsWith('-A01'))));
});

test('removing arbitrary evidence removes the corresponding derived state', () => {
  const identity = session('D01', '2031-03-01', '我叫黎川，26岁，在长沙做工业设计。');
  const preference = session('D02', '2031-03-02', '现在咖啡偏好低因、燕麦奶、非冰。');
  const full = scan([identity, preference]);
  const withoutIdentity = scan([preference]);
  const withoutPreference = scan([identity]);

  assert.equal(full.user_model.name, '黎川');
  assert.ok(full.user_model.coffee_preference);
  assert.equal(withoutIdentity.user_model.name, undefined);
  assert.equal(withoutIdentity.user_model.age, undefined);
  assert.equal(withoutPreference.user_model.coffee_preference, undefined);
});

test('candidate cancellation and temporary-state closure carry explicit supersession provenance', () => {
  const snapshot = scan([
    session('T01', '2031-04-01', '我可能考虑搬去苏州，这只是候选。'),
    session('T02', '2031-04-03', '苏州不去了，计划取消。'),
    session('T03', '2031-04-04', '最近发烧，属于暂时状态。'),
    session('T04', '2031-04-06', '已经退烧，发烧好了。')
  ]);

  const closes = snapshot.operations_log.filter(operation => operation.action === 'CLOSE');
  assert.ok(closes.length >= 2);
  assert.ok(closes.every(operation => operation.supersedes && operation.supersedes.length > 0));
  assert.ok(closes.every(operation => operation.temporal_status === 'closed'));
  assert.ok(snapshot.current_context.closed_states.length >= 2);
  assert.ok(!snapshot.current_context.sleep_and_health?.includes('发烧'));
});

test('task-only, quoted, and sarcastic content creates no durable operation', () => {
  const samples = [
    session('I01', '2031-05-01', '请只帮我写个正则检查端口号。'),
    session('I02', '2031-05-02', '她说我不适合创作，这是她的原话，不代表我。'),
    session('I03', '2031-05-03', '我可太喜欢通宵加班了，最好没有加班费。')
  ];
  const snapshot = scan(samples);
  assert.equal(snapshot.operations_log.length, 0);
  assert.equal(snapshot.rejected_items.length, 3);
});
