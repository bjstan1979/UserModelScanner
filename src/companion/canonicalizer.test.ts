import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalizeCompanionCandidates } from './canonicalizer.js';
import { COMPANION_ONTOLOGY_VERSION, type CompanionCandidate, type EntityMention } from './ontology.js';
import { createResolverState, resolveCandidates } from './resolver.js';
import { projectCompanionState } from './reducer.js';

function candidate(overrides: Partial<CompanionCandidate> & Pick<CompanionCandidate, 'subject' | 'predicate' | 'value'>): CompanionCandidate {
  const text = overrides.source?.text ?? '测试来源文本';
  return {
    candidateId: 'raw-candidate',
    ontologyVersion: COMPANION_ONTOLOGY_VERSION,
    layer: 'USER_MODEL',
    source: {
      messageId: 'm1', sessionId: 's1', sessionDate: '2026-09-01', role: 'user',
      start: 0, end: text.length, text
    },
    polarity: 'positive',
    modality: 'asserted',
    scope: 'durable',
    temporalStatus: 'active',
    confidence: 0.95,
    entityMentions: [],
    correctionTargets: [],
    reason: 'test',
    ...overrides
  };
}

function person(surface: string, relation: string, text = `${surface}是我的${relation}`): EntityMention {
  return {
    mentionId: `${surface}-${relation}`,
    surface,
    entityType: 'person',
    relation,
    source: { messageId: 'm1', sessionId: 's1', sessionDate: '2026-09-01', role: 'user', start: 0, end: text.length, text }
  };
}

describe('companion candidate canonicalizer', () => {
  it('canonicalizes predicate, subject, scalar values, and source-stable IDs', () => {
    const source = { messageId: 'm1', sessionId: 's1', sessionDate: '2026-09-01', role: 'user' as const, start: 0, end: 5, text: '我叫顾明。' };
    const [result] = canonicalizeCompanionCandidates([candidate({
      layer: 'RELATIONSHIP', subject: 'profile.identity.arbitrary-slug', predicate: 'fullName', value: { name: '顾明' }, source
    })]);
    assert.equal(result.layer, 'USER_MODEL');
    assert.equal(result.subject, 'profile.identity.full_name');
    assert.equal(result.predicate, 'identity.full_name');
    assert.equal(result.value, '顾明');
    assert.deepEqual(result.source, source);
    assert.match(result.candidateId, /^candidate-/);
  });

  it('keeps same-surface people distinct while sharing one entity suffix across their attributes', () => {
    const colleague = person('甲', '同事');
    const neighbor = person('甲', '邻居');
    const [relation, location, otherRelation] = canonicalizeCompanionCandidates([
      candidate({ subject: 'people.relation.one', predicate: 'relation', value: { name: '甲', relation: '同事' }, entityMentions: [colleague] }),
      candidate({ subject: 'people.entity.location', predicate: 'location', value: { location: '北城' }, entityMentions: [colleague] }),
      candidate({ subject: 'people.relation.two', predicate: 'relation', value: { name: '甲', relation: '邻居' }, entityMentions: [neighbor] })
    ]);
    assert.equal(relation.subject.replace('people.relation.', ''), location.subject.replace('people.entity.', ''));
    assert.notEqual(relation.subject, otherRelation.subject);
    assert.equal(relation.value, '同事');
    assert.equal(location.value, '北城');

    const state = createResolverState();
    resolveCandidates([relation, location, otherRelation], state, () => ({ entailed: true, confidence: 1, reason: 'test' }));
    assert.equal(state.entities.size, 2);
    assert.deepEqual(projectCompanionState(state).user_model.important_relations.map(item => item.relation).sort(), ['同事', '邻居']);
  });

  it('maps corrective candidates back to the prior canonical subject', () => {
    const mention = person('乙', '同事');
    const [prior] = canonicalizeCompanionCandidates([
      candidate({ subject: 'people.relation.old-model-slug', predicate: 'relation', value: { name: '乙', relation: '同事' }, entityMentions: [mention] })
    ]);
    const correctionText = '乙不是我的同事，他是我舅舅，旧关系作废。';
    const [correction] = canonicalizeCompanionCandidates([candidate({
      subject: 'people.relation.new-model-slug', predicate: 'relation', value: '舅舅',
      source: { messageId: 'm2', sessionId: 's2', sessionDate: '2026-09-02', role: 'user', start: 0, end: correctionText.length, text: correctionText },
      entityMentions: [person('乙', '舅舅', correctionText)], modality: 'corrective', correctionTargets: ['unreliable-model-target']
    })], [prior]);
    assert.equal(correction.subject, prior.subject);
    assert.deepEqual(correction.correctionTargets, [prior.subject]);
    assert.equal(correction.value, '舅舅');

    const state = createResolverState();
    resolveCandidates([prior], state, () => ({ entailed: true, confidence: 1, reason: 'test' }));
    const result = resolveCandidates([correction], state, () => ({ entailed: true, confidence: 1, reason: 'test' }));
    assert.equal(result.operations[0].action, 'SUPERSEDE');
    assert.equal([...state.facts.values()].filter(fact => fact.active).length, 1);
    assert.equal([...state.facts.values()].filter(fact => !fact.active).length, 1);
  });

  it('moves timeline aliases into the canonical timeline family', () => {
    const [result] = canonicalizeCompanionCandidates([candidate({
      layer: 'EPISODIC_MEMORY', subject: 'episode.event.model-slug', predicate: 'timeline_step', value: '第一步完成', eventTime: '2026-09-03'
    })]);
    assert.equal(result.predicate, 'event.timeline_step');
    assert.match(result.subject, /^event\.timeline\./);
  });
});
