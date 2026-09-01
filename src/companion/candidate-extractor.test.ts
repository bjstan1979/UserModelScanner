import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDiscourseState, extractCandidatesFromMessage } from './candidate-extractor.js';
import type { CompanionSession } from './engine.js';

function session(content: string, id = 'm-1'): CompanionSession {
  return {
    session_id: 'candidate-unit',
    date: '2031-04-05T10:00:00+08:00',
    topic: 'unit',
    messages: [{ id, role: 'user', content }]
  };
}

function extract(content: string) {
  const input = session(content);
  return extractCandidatesFromMessage(input.messages[0], input, createDiscourseState());
}

describe('discourse candidate extraction', () => {
  it('retains explicit negation instead of converting it to a positive fact', () => {
    const result = extract('我不是在甲城长大的，我的童年一直在乙城。');
    const facts = result.candidates.filter(candidate => candidate.subject === 'profile.childhood_place.current');
    assert.equal(facts.length, 2);
    assert.equal(facts[0].polarity, 'negative');
    assert.equal(facts[0].value, '甲城');
    assert.equal(facts[1].polarity, 'positive');
    assert.equal(facts[1].value, '乙城');
  });

  it('rejects quoted third-party beliefs at candidate level', () => {
    const result = extract('同事原话是：“越忙越该熬夜。”我只是转述，别把这算成我的看法。');
    assert.deepEqual(result.candidates, []);
    assert.match(result.rejected[0].reason, /third-party/);
  });

  it('marks an undecided relocation as proposed rather than completed', () => {
    const result = extract('我在考虑年底搬去海港城，目前只是候选方案，还没有做决定。');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].modality, 'candidate');
    assert.equal(result.candidates[0].temporalStatus, 'proposed');
    assert.equal(result.candidates[0].layer, 'CURRENT_CONTEXT');
  });

  it('keeps same-name people separate when relation and context differ', () => {
    const state = createDiscourseState();
    const first = session('我表姐叫简宁，在北港做产品设计。', 'person-1');
    const second = session('给我看牙的医生也叫简宁，在南湾执业，她和我没有亲属关系。', 'person-2');
    const a = extractCandidatesFromMessage(first.messages[0], first, state).candidates;
    const b = extractCandidatesFromMessage(second.messages[0], second, state).candidates;
    assert.notEqual(a[0].subject, b[0].subject);
    assert.notEqual(a[0].entityMentions[0].relation, b[0].entityMentions[0].relation);
  });

  it('keeps a named person location off the user profile', () => {
    const state = createDiscourseState();
    const relation = session('顾青是我的表姐，我们刚聊完。', 'relation');
    const location = session('顾青住在宁波，那是顾青的所在地，不是我的。', 'location');
    extractCandidatesFromMessage(relation.messages[0], relation, state);
    const candidates = extractCandidatesFromMessage(location.messages[0], location, state).candidates;
    const owned = candidates.find(candidate => candidate.predicate === 'currentResidence');
    assert.equal(owned?.value, '宁波');
    assert.equal(owned?.entityMentions[0].surface, '顾青');
    assert.equal(owned?.entityMentions[0].relation, '表姐');
    assert.ok(!candidates.some(candidate => candidate.subject === 'profile.residence.current'));
  });

  it('ignores a negated location before the corrected user location', () => {
    const result = extract('不是我住在宁波，我仍然住在苏州。');
    const residence = result.candidates.find(candidate => candidate.subject === 'profile.residence.current');
    assert.equal(residence?.value, '苏州');
  });

  it('extracts explicit plan, temporary-state, protocol, and ritual lifecycles', () => {
    const state = createDiscourseState();
    const messages = [
      session('我在考虑下个月去泉州参加木偶修复课，目前只是候选，车票没订。', 'plan-add'),
      session('之前考虑的泉州木偶修复课不去了。', 'plan-close'),
      session('这周交付前我有点临时发怵。', 'stress-add'),
      session('请把之前那段临时发怵关闭。', 'stress-close'),
      session('我们建立一个长期规则，触发词是“慢灯检查”。', 'protocol'),
      session('我们设一个长期重复的小仪式，叫“雨窗清单”。', 'ritual'),
      session('另外，这次雨窗清单里我想守住规律散步，愿意松手的是旧票据。', 'occurrence')
    ];
    const extracted = messages.flatMap(item => extractCandidatesFromMessage(item.messages[0], item, state).candidates);
    const byPredicate = (predicate: string) => extracted.filter(candidate => candidate.predicate === predicate);

    assert.equal(byPredicate('decision.plan').length, 2);
    assert.equal(byPredicate('decision.plan')[0].temporalStatus, 'proposed');
    assert.equal(byPredicate('decision.plan')[1].temporalStatus, 'closed');
    assert.equal(byPredicate('context.stress_state').length, 2);
    assert.equal(byPredicate('orderedResponseProtocol').length, 1);
    assert.equal(byPredicate('ritual').length, 1);
    assert.equal(byPredicate('episode.ritual_occurrence').length, 1);
  });
});
