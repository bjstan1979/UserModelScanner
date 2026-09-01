import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canonicalPredicate,
  predicateVocabularyMatches,
  subjectExpectationKnown,
  subjectVocabularyKnown,
  validateOperationExpectationVocabulary
} from './ontology.js';

describe('companion evaluation ontology contract', () => {
  it('normalizes public predicate aliases without changing Engine output', () => {
    assert.equal(canonicalPredicate('fullName'), 'identity.full_name');
    assert.equal(canonicalPredicate('name'), 'identity.full_name');
    assert.equal(predicateVocabularyMatches('currentResidence', 'location'), true);
    assert.equal(predicateVocabularyMatches('step', 'timeline_step'), true);
    assert.equal(predicateVocabularyMatches('occupation', 'location'), false);
  });

  it('allows concrete candidates but requires published subject families in Ground Truth', () => {
    assert.equal(subjectVocabularyKnown('preference.project_medium.current'), true);
    assert.equal(subjectVocabularyKnown('decision.travel.*'), true);
    assert.equal(subjectVocabularyKnown('user.profile.*'), false);
    assert.equal(subjectExpectationKnown('preference.project_medium.current'), false);
    assert.equal(subjectExpectationKnown('preference.project_medium.*'), false);
    assert.equal(subjectExpectationKnown('preference.*.*'), true);
  });

  it('rejects unknown contract vocabulary before scoring', () => {
    const valid = validateOperationExpectationVocabulary({
      action: 'upsert',
      layer: 'profile',
      subjectPattern: 'profile.identity.*',
      predicate: 'name',
      scope: 'durable',
      temporalStatus: 'current'
    });
    assert.deepEqual(valid, []);

    const wrongRelationFamily = validateOperationExpectationVocabulary({
      action: 'upsert', layer: 'people', subjectPattern: 'people.entity.*', predicate: 'entity.relation',
      scope: 'durable', temporalStatus: 'current'
    });
    assert.deepEqual(wrongRelationFamily, ['predicateSubject=entity.relation@people.entity.*']);

    const invalid = validateOperationExpectationVocabulary({
      action: 'invent',
      layer: 'profile',
      subjectPattern: 'user.profile.*',
      predicate: 'mystery_field',
      scope: 'durable',
      temporalStatus: 'current'
    });
    assert.deepEqual(invalid, ['action=invent', 'subjectPattern=user.profile.*', 'predicate=mystery_field']);

    const inheritedKeys = validateOperationExpectationVocabulary({
      action: 'toString',
      layer: 'constructor',
      subjectPattern: 'profile.identity.*',
      predicate: 'name',
      scope: '__proto__',
      temporalStatus: 'valueOf'
    });
    assert.deepEqual(inheritedKeys, ['action=toString', 'layer=constructor', 'scope=__proto__', 'temporalStatus=valueOf']);
  });
});
