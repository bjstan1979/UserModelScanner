import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDiscourseState, extractCandidatesFromMessage } from './candidate-extractor.js';
import type { CompanionSession } from './engine.js';
import { activeFacts, createResolverState, resolveCandidates } from './resolver.js';

function runMessages(contents: string[]) {
  const discourse = createDiscourseState();
  const resolver = createResolverState();
  const operations = [];
  contents.forEach((content, index) => {
    const session: CompanionSession = {
      session_id: 'resolver-unit',
      date: `2032-03-${String(index + 1).padStart(2, '0')}T09:00:00+08:00`,
      topic: 'unit',
      messages: [{ id: `resolver-message-${index + 1}`, role: 'user', content }]
    };
    const extracted = extractCandidatesFromMessage(session.messages[0], session, discourse);
    operations.push(...resolveCandidates(extracted.candidates, resolver).operations);
  });
  return { resolver, operations };
}

describe('entity-aware temporal resolver', () => {
  it('closes a proposed plan without turning it into an event', () => {
    const { resolver, operations } = runMessages([
      '我在考虑年底搬去海港城，目前只是候选方案，还没有做决定。',
      '搬去海港城的方案取消了，这个候选计划不再有效。'
    ]);
    assert.deepEqual(operations.map(operation => operation.action), ['ADD', 'CLOSE']);
    assert.equal(activeFacts(resolver).length, 0);
    assert.equal([...resolver.facts.values()][0].temporalStatus, 'closed');
    assert.equal(operations.some(operation => operation.layer === 'EPISODIC_MEMORY'), false);
  });

  it('supersedes a corrected current fact in the same ontology domain', () => {
    const { resolver, operations } = runMessages([
      '我一直在甲城长大。',
      '更正：我是在乙城长大的，请以这条为准。'
    ]);
    assert.equal(operations.at(-1)?.action, 'SUPERSEDE');
    const current = activeFacts(resolver);
    assert.equal(current.length, 1);
    assert.equal(current[0].value, '乙城');
    assert.equal([...resolver.facts.values()].filter(fact => !fact.active).length, 1);
  });

  it('uses relation and contextual qualifiers to disambiguate equal names', () => {
    const { resolver } = runMessages([
      '我表姐叫简宁，在北港做产品设计。',
      '给我看牙的医生也叫简宁，在南湾执业，她和我没有亲属关系。'
    ]);
    const named = [...resolver.entities.values()].filter(entity => entity.canonicalName === '简宁');
    assert.equal(named.length, 2);
    assert.notEqual(named[0].entityId, named[1].entityId);
  });
});
