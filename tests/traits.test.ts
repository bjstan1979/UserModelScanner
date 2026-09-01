import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SQLiteStorage } from '../src/storage/sqlite.js';
import { TraitUpdater } from '../src/traits/updater.js';
import { computeTraitScore } from '../src/traits/scorer.js';
import { applyTimeDecay } from '../src/traits/decay.js';
import { EvidenceCandidate } from '../src/evidence/extract.js';

test('Decision style / Values do not become stable from a single session', () => {
  const scoreValues1 = computeTraitScore({
    category: 'values_principles',
    supportCount: 5,
    contradictionCount: 0,
    distinctSessions: 1,
    distinctContexts: 1,
    hasExplicitDeclaration: true
  });
  assert.notEqual(scoreValues1.status, 'stable');
  assert.equal(scoreValues1.status, 'candidate');

  const scoreDecision1 = computeTraitScore({
    category: 'decision_style',
    supportCount: 3,
    contradictionCount: 0,
    distinctSessions: 1,
    distinctContexts: 1,
    hasExplicitDeclaration: true
  });
  assert.notEqual(scoreDecision1.status, 'stable');
});

test('Multi-session gating requirements for stable traits', () => {
  // Preferences: requires >= 3 distinct sessions
  const prefScore = computeTraitScore({
    category: 'preferences',
    supportCount: 3,
    contradictionCount: 0,
    distinctSessions: 3,
    distinctContexts: 2,
    hasExplicitDeclaration: true
  });
  assert.equal(prefScore.status, 'stable');

  // Values: requires >= 4 distinct sessions
  const val3Sessions = computeTraitScore({
    category: 'values_principles',
    supportCount: 3,
    contradictionCount: 0,
    distinctSessions: 3,
    distinctContexts: 2,
    hasExplicitDeclaration: true
  });
  assert.notEqual(val3Sessions.status, 'stable');

  const val4Sessions = computeTraitScore({
    category: 'values_principles',
    supportCount: 4,
    contradictionCount: 0,
    distinctSessions: 4,
    distinctContexts: 2,
    hasExplicitDeclaration: true
  });
  assert.equal(val4Sessions.status, 'stable');
});

test('Contradiction causes disputed status or scope-split', () => {
  const disputedScore = computeTraitScore({
    category: 'preferences',
    supportCount: 2,
    contradictionCount: 2,
    distinctSessions: 2,
    distinctContexts: 1,
    hasExplicitDeclaration: false
  });
  assert.equal(disputedScore.status, 'disputed');
});

test('Time decay retires expired current goals and decays stale preferences', () => {
  const oldDate = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString(); // 40 days ago
  const goalTrait = {
    id: 'trait_goal_1',
    category: 'current_goals' as const,
    ontology: 'CURRENT_CONTEXT' as const,
    statement: 'Active priority / focus: migration to sqlite',
    portability_score: 0.1,
    scope: 'global',
    status: 'working' as const,
    confidence: 0.8,
    support_count: 2,
    contradiction_count: 0,
    distinct_sessions: 2,
    distinct_contexts: 1,
    first_seen: oldDate,
    last_confirmed: oldDate,
    evidence_ids: ['ev_1']
  };

  const decay = applyTimeDecay(goalTrait);
  assert.equal(decay.hasChanged, true);
  assert.equal(decay.updatedTrait.status, 'retired');
});
