import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CompanionScannerEngine, CompanionSession } from './engine.js';
import { CompanionSemanticProvider, RuleBasedCompanionProvider } from './semantic-provider.js';

const input: CompanionSession[] = [{
  session_id: 'provider-unit',
  date: '2034-01-01T08:00:00+08:00',
  topic: 'unit',
  messages: [{ id: 'provider-message', role: 'user', content: '我叫简禾。' }]
}];

describe('injectable companion semantic provider', () => {
  it('lets a provider veto storage through entailment', () => {
    class RejectingProvider extends RuleBasedCompanionProvider {
      override checkEntailment() {
        return { entailed: false, confidence: 1, reason: 'test veto' };
      }
    }
    const snapshot = new CompanionScannerEngine(new RejectingProvider()).scanCompanionDataset(input);
    assert.equal(snapshot.fact_store?.length, 0);
    assert.match(snapshot.rejected_items[0].reason, /test veto/);
  });

  it('supports asynchronous providers only through the async entrypoint', async () => {
    const delegate = new RuleBasedCompanionProvider();
    const provider: CompanionSemanticProvider = {
      name: 'async-unit',
      isAvailable: () => Promise.resolve(true),
      extractCandidates: value => Promise.resolve(delegate.extractCandidates(value)),
      resolveEntities: value => Promise.resolve(delegate.resolveEntities(value)),
      checkEntailment: value => Promise.resolve(delegate.checkEntailment(value))
    };
    const engine = new CompanionScannerEngine(provider);
    assert.throws(() => engine.scanCompanionDataset(input), /asynchronous/);
    const snapshot = await engine.scanCompanionDatasetAsync(input);
    assert.equal(snapshot.user_model.name, '简禾');
  });
});
