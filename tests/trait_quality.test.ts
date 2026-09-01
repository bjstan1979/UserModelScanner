import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTraitQuality } from '../src/traits/quality.js';
import { renderUserModelMarkdown, scoreTraitForUserMd } from '../src/render/user-md.js';
import { Trait } from '../src/traits/schema.js';

test('evaluateTraitQuality distinguishes actionable guidance from descriptive pleasantries', () => {
  // High utility: empirical validation
  const highQuality = evaluateTraitQuality(
    'decision_style',
    'Favors empirical runtime validation and test evidence over unverified design assumptions.',
    'USER_GLOBAL',
    3
  );
  assert.ok(highQuality.behavioral_utility >= 0.85);
  assert.ok(highQuality.entailment_score >= 0.90);
  assert.equal(highQuality.trait_role, 'ACTION_GUIDANCE');

  // Low utility: pleasantries / descriptive mannerisms
  const lowQuality = evaluateTraitQuality(
    'collaboration_style',
    'Communicates in a polite, appreciative tone (frequent 谢谢)',
    'USER_GLOBAL',
    2
  );
  assert.ok(lowQuality.behavioral_utility <= 0.40);
});

test('evaluateTraitQuality calibrates wording to prevent semantic overreach', () => {
  const overreachWording = 'Always require explicit confirmation before deleting files';
  const calibrated = evaluateTraitQuality('collaboration_style', overreachWording, 'USER_GLOBAL', 2);
  assert.ok(!calibrated.calibratedStatement.startsWith('Always require'));
  assert.ok(calibrated.calibratedStatement.startsWith('Prefers'));
});

test('renderUserModelMarkdown filters low utility traits and compresses duplicates', () => {
  const traits: Trait[] = [
    {
      id: 't_high_1',
      category: 'decision_style',
      ontology: 'USER_GLOBAL',
      statement: 'Favors empirical runtime validation over unverified design assumptions.',
      scope: 'global',
      status: 'stable',
      confidence: 0.98,
      portability_score: 0.95,
      behavioral_utility: 0.95,
      entailment_score: 0.95,
      semantic_strength: 'direct',
      trait_role: 'ACTION_GUIDANCE',
      support_count: 4,
      contradiction_count: 0,
      distinct_sessions: 4,
      distinct_contexts: 2,
      first_seen: '2026-08-01T00:00:00Z',
      last_confirmed: '2026-08-30T00:00:00Z',
      evidence_ids: []
    },
    {
      id: 't_high_2',
      category: 'collaboration_style',
      ontology: 'USER_GLOBAL',
      statement: 'For reversible local engineering work, prefers autonomous progress without redundant confirmation.',
      scope: 'reversible-actions',
      status: 'stable',
      confidence: 0.98,
      portability_score: 0.90,
      behavioral_utility: 0.95,
      entailment_score: 0.95,
      semantic_strength: 'direct',
      trait_role: 'ACTION_GUIDANCE',
      support_count: 4,
      contradiction_count: 0,
      distinct_sessions: 4,
      distinct_contexts: 2,
      first_seen: '2026-08-01T00:00:00Z',
      last_confirmed: '2026-08-30T00:00:00Z',
      evidence_ids: []
    },
    {
      id: 't_low_utility',
      category: 'collaboration_style',
      ontology: 'USER_GLOBAL',
      statement: 'Communicates with polite tone and frequent 谢谢',
      scope: 'global',
      status: 'stable',
      confidence: 0.98,
      portability_score: 0.90,
      behavioral_utility: 0.25, // Low utility
      entailment_score: 0.95,
      semantic_strength: 'direct',
      trait_role: 'ACTION_GUIDANCE',
      support_count: 4,
      contradiction_count: 0,
      distinct_sessions: 4,
      distinct_contexts: 2,
      first_seen: '2026-08-01T00:00:00Z',
      last_confirmed: '2026-08-30T00:00:00Z',
      evidence_ids: []
    }
  ];

  const userMd = renderUserModelMarkdown(traits);
  assert.ok(userMd.includes('Favors empirical runtime validation'));
  assert.ok(userMd.includes('autonomous progress'));
  // Low utility pleasantry should NOT be in USER.md!
  assert.ok(!userMd.includes('谢谢'));
});
