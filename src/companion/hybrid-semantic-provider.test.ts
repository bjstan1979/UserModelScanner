import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDiscourseState } from './candidate-extractor.js';
import type { CandidateExtractionInput } from './semantic-provider.js';
import { RuleBasedCompanionProvider, type CompanionSemanticProvider } from './semantic-provider.js';
import type { EntailmentVerdict } from './resolver.js';
import type { CompanionCandidate } from './ontology.js';
import { HybridCompanionSemanticProvider } from './hybrid-semantic-provider.js';

function input(content: string): CandidateExtractionInput {
  const message = { id: 'm1', role: 'user' as const, content };
  return {
    message,
    session: { session_id: 's1', date: '2026-09-01', topic: 'test', messages: [message] },
    discourse: createDiscourseState()
  };
}

class StubSemanticProvider implements CompanionSemanticProvider {
  readonly name = 'stub-semantic';
  calls = 0;
  available = true;
  mode: 'success' | 'empty' | 'throw' = 'success';
  private readonly offline = new RuleBasedCompanionProvider();

  async isAvailable(): Promise<boolean> { return this.available; }

  async extractCandidates(value: CandidateExtractionInput) {
    this.calls += 1;
    if (this.mode === 'throw') throw new Error('network failure');
    if (this.mode === 'empty') return { candidates: [], rejected: [] };
    const result = this.offline.extractCandidates(value);
    return { ...result, rejected: [{ item: value.message.content, reason: 'semantic-result', evidenceIds: [value.message.id] }] };
  }

  resolveEntities(value: { candidates: CompanionCandidate[]; existingEntities: ReadonlyMap<string, never> }): CompanionCandidate[] {
    return value.candidates;
  }

  checkEntailment(): EntailmentVerdict {
    return { entailed: true, confidence: 1, reason: 'test' };
  }
}

describe('hybrid companion semantic provider', () => {
  it('uses the deterministic Stage A gate before calling the model', async () => {
    const semantic = new StubSemanticProvider();
    const result = await new HybridCompanionSemanticProvider(semantic).extractCandidates(input('你好'));
    assert.equal(semantic.calls, 0);
    assert.deepEqual(result.candidates, []);
  });

  it('prefers non-empty semantic extraction for ambiguous durable values', async () => {
    const semantic = new StubSemanticProvider();
    const result = await new HybridCompanionSemanticProvider(semantic).extractCandidates(input('我长期重视选择权和自主性，这对我很重要。'));
    assert.equal(semantic.calls, 1);
    assert.ok(result.candidates.length > 0);
    assert.ok(result.rejected.some(item => item.reason === 'semantic-result'));
  });

  it('falls back offline for empty, unavailable, and failed semantic extraction', async () => {
    for (const mode of ['empty', 'throw', 'unavailable'] as const) {
      const semantic = new StubSemanticProvider();
      if (mode === 'unavailable') semantic.available = false;
      else semantic.mode = mode;
      const result = await new HybridCompanionSemanticProvider(semantic).extractCandidates(input('我长期重视选择权和自主性，这对我很重要。'));
      assert.ok(result.candidates.length > 0, mode);
      assert.equal(semantic.calls, mode === 'unavailable' ? 0 : 1, mode);
    }
  });
});
