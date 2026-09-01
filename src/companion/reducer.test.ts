import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDiscourseState, extractCandidatesFromMessage } from './candidate-extractor.js';
import type { CompanionSession } from './engine.js';
import { projectCompanionState } from './reducer.js';
import { createResolverState, resolveCandidates } from './resolver.js';

function scan(contents: string[]) {
  const discourse = createDiscourseState();
  const resolver = createResolverState();
  contents.forEach((content, index) => {
    const session: CompanionSession = {
      session_id: 'reducer-unit',
      date: `2033-05-${String(index + 1).padStart(2, '0')}T08:00:00+08:00`,
      topic: 'unit',
      messages: [{ id: `reducer-message-${index}`, role: 'user', content }]
    };
    const candidates = extractCandidatesFromMessage(session.messages[0], session, discourse).candidates;
    resolveCandidates(candidates, resolver);
  });
  return projectCompanionState(resolver, [], '2033-05-02');
}

describe('open fact reducer', () => {
  it('retains every fact while projecting known profile fields', () => {
    const snapshot = scan(['我叫简禾，现在常住北港。', '现在长篇阅读我只选电子墨水屏。']);
    assert.equal(snapshot.user_model.name, '简禾');
    assert.equal(snapshot.user_model.location, '北港');
    assert.ok(snapshot.fact_store?.some(fact => fact.subject === 'preference.reading.long_form'));
    assert.equal(snapshot.ontology_version, 'companion-memory/v1');
  });

  it('does not project proposed plans into current home or episodes', () => {
    const snapshot = scan(['我在考虑年底搬去海港城，目前只是候选方案，还没有做决定。']);
    assert.equal(snapshot.current_context.location_and_home, undefined);
    assert.deepEqual(snapshot.episodic_memory, []);
    assert.equal(snapshot.fact_store?.[0].temporalStatus, 'proposed');
  });
});
