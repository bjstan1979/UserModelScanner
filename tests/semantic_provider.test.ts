import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { RuleBasedProvider } from '../src/semantic/rule-based.js';
import { OpenAICompatibleProvider } from '../src/semantic/openai-compatible.js';
import { createSemanticProvider } from '../src/semantic/factory.js';
import { buildSessionDigest } from '../src/normalize/session-digest.js';
import { CanonicalEvent } from '../src/normalize/canonical-event.js';
import { Trait } from '../src/traits/schema.js';

test('RuleBasedProvider extracts evidence, matches traits, and synthesizes statements', async () => {
  const provider = new RuleBasedProvider();
  assert.equal(await provider.isAvailable(), true);
  assert.equal(provider.name, 'rule-based');

  const events: CanonicalEvent[] = [
    { session_id: 's_sem_1', event_id: 'e1', timestamp: '2026-08-30T00:00:00Z', project: 'test', role: 'user', content: '我不喜欢冗长的解释，请直接给出diff。' }
  ];
  const digest = buildSessionDigest('s_sem_1', 'pi', events);

  const candidates = await provider.extractEvidence(digest, events);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].category, 'preferences');

  // Match against empty traits -> new_trait
  const matchNew = await provider.matchEvidenceToTraits(candidates[0], []);
  assert.equal(matchNew.type, 'new_trait');

  // Match against existing matching trait -> support
  const existingTrait: Trait = {
    id: 'trait_pref_concise',
    category: 'preferences',
    statement: 'Prefers concise, direct output and code diffs rather than lengthy explanations.',
    scope: 'global',
    status: 'working',
    confidence: 0.8,
    support_count: 1,
    contradiction_count: 0,
    distinct_sessions: 1,
    distinct_contexts: 1,
    first_seen: '2026-08-30T00:00:00Z',
    last_confirmed: '2026-08-30T00:00:00Z',
    evidence_ids: []
  };

  const matchExisting = await provider.matchEvidenceToTraits(candidates[0], [existingTrait]);
  assert.equal(matchExisting.type, 'support');

  const synthesis = await provider.synthesizeTrait([], existingTrait);
  assert.equal(synthesis, existingTrait.statement);
});

test('createSemanticProvider auto-detects MiniMax configuration or falls back', () => {
  const config = loadConfig();
  const provider = createSemanticProvider(config);
  assert.ok(provider);
  assert.ok(provider.name.includes('MiniMax') || provider.name === 'rule-based');

  const ruleProvider = createSemanticProvider(config, 'rule');
  assert.equal(ruleProvider.name, 'rule-based');
});

test('OpenAICompatibleProvider handles thinking tags and parses structured json', async () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: 'mock-key',
    endpoint: 'https://mock.example.com',
    model: 'mock-model'
  });

  // Verify stripThinking and parseJsonFromResponse internal behaviors via reflection
  const rawWithThink = '<think>I need to format as JSON</think>\n```json\n{"candidates":[{"category":"preferences","statement":"Prefers pnpm","scope":"global","canonical_key":"use_pnpm","signal_type":"explicit_statement","strength":0.9}]}\n```';
  const parsed = (provider as any).parseJsonFromResponse(rawWithThink);
  assert.ok(parsed);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].canonical_key, 'use_pnpm');
});
