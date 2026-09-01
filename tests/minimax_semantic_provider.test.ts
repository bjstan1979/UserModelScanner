import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CompanionScannerEngine, type CompanionSession } from '../src/companion/engine.js';
import { HybridCompanionSemanticProvider } from '../src/companion/hybrid-semantic-provider.js';
import { MiniMaxCompanionSemanticProvider, type MiniMaxChatRequest } from '../src/companion/minimax-semantic-provider.js';

const config = { endpoint: 'https://invalid.local/v1', apiKey: 'test-key', model: 'MiniMax-M3' };

type DecisionPayload = {
  candidates: Array<Record<string, unknown>>;
  dismissed: Array<Record<string, unknown>>;
};

function session(messages: CompanionSession['messages']): CompanionSession {
  return { session_id: 'semantic-test', date: '2032-05-01', topic: 'generic', messages };
}

function emitted(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claimIndexes: [0],
    layer: 'USER_MODEL',
    subject: 'profile.residence.current',
    predicate: 'currentResidence',
    value: '乙城',
    assertionMode: 'current',
    scope: 'durable',
    temporalStatus: 'active',
    confidence: 0.98,
    entityMentions: [],
    supersedesOperationIds: [],
    reason: 'Directly asserted current fact',
    ...overrides
  };
}

function twoStageRequest(
  decide: (messageId: string, payload: Record<string, unknown>) => DecisionPayload,
  discoveryQuotes: Record<string, string[]> = {}
): MiniMaxChatRequest {
  return async (_config, messages, options) => {
    const payload = JSON.parse(messages.at(-1)!.content) as Record<string, unknown>;
    const messageId = String(payload.currentMessageId);
    if (options?.expectedToolName === 'discover_memory_claims') {
      const prefix = payload.conversationPrefix as Array<{ id: string; content: string }>;
      const content = prefix.find(message => message.id === messageId)?.content ?? '';
      const defaultQuote = content.replace(/[。.]$/, '');
      return JSON.stringify({
        claims: (discoveryQuotes[messageId] ?? [defaultQuote]).map(quote => ({
          source: { messageId, quote }, supportingSources: [], reason: 'Potentially memorable source claim'
        }))
      });
    }
    assert.equal(options?.expectedToolName, 'decide_memory_candidates');
    return JSON.stringify(decide(messageId, payload));
  };
}

describe('MiniMax two-stage semantic provider', () => {
  it('uses discovery then decision and caches both across checkpoint rescans', async () => {
    let calls = 0;
    const request = twoStageRequest(() => ({ candidates: [emitted()], dismissed: [] }));
    const counted: MiniMaxChatRequest = async (...args) => {
      calls += 1;
      return request(...args);
    };
    const provider = new MiniMaxCompanionSemanticProvider(config, counted);
    const engine = new CompanionScannerEngine(provider);
    const sessions = [session([{ id: 'm1', role: 'user', content: '我住在乙城。' }])];

    await engine.scanCompanionDatasetAsync(sessions);
    await engine.scanCompanionDatasetAsync(sessions);

    assert.equal(calls, 2);
  });
  it('reuses discovery evidence across provider instances', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-discovery-cache-'));
    let calls = 0;
    const base = twoStageRequest(() => ({ candidates: [emitted()], dismissed: [] }));
    const counted: MiniMaxChatRequest = async (...args) => {
      calls += 1;
      return base(...args);
    };
    const sessions = [session([{ id: 'm1', role: 'user', content: '我住在乙城。' }])];
    try {
      await new CompanionScannerEngine(new MiniMaxCompanionSemanticProvider(config, counted, cacheDir)).scanCompanionDatasetAsync(sessions);
      const second = new MiniMaxCompanionSemanticProvider(config, counted, cacheDir);
      await new CompanionScannerEngine(second).scanCompanionDatasetAsync(sessions);

      assert.equal(calls, 3);
      assert.equal(second.usage().requests, 1);
      assert.equal(second.usage().diskDiscoveryCacheHits, 1);
    } finally {
      for (const file of fs.readdirSync(cacheDir)) fs.unlinkSync(path.join(cacheDir, file));
      fs.rmdirSync(cacheDir);
    }
  });

  it('retries transient semantic request failures and records attempts', async () => {
    let calls = 0;
    const base = twoStageRequest(() => ({ candidates: [emitted()], dismissed: [] }));
    const flaky: MiniMaxChatRequest = async (...args) => {
      calls += 1;
      if (calls === 1) throw new DOMException('timed out', 'AbortError');
      return base(...args);
    };
    const provider = new MiniMaxCompanionSemanticProvider(config, flaky);
    const snapshot = await new CompanionScannerEngine(provider).scanCompanionDatasetAsync([session([
      { id: 'm1', role: 'user', content: '我住在乙城。' }
    ])]);

    assert.equal(snapshot.fact_store?.length, 1);
    assert.equal(calls, 3);
    assert.deepEqual(provider.usage(), {
      requests: 3, discoveryRequests: 2, decisionRequests: 1,
      discoveryCacheHits: 0, diskDiscoveryCacheHits: 0, extractionCacheHits: 0, retries: 1, failedRequests: 1
    });
  });

  it('prefetches discovery and performs only the decision during the scan', async () => {
    let calls = 0;
    const base = twoStageRequest(() => ({ candidates: [emitted()], dismissed: [] }));
    const request: MiniMaxChatRequest = async (...args) => {
      calls += 1;
      return base(...args);
    };
    const provider = new MiniMaxCompanionSemanticProvider(config, request);
    const sessions = [session([{ id: 'm1', role: 'user', content: '我住在乙城。' }])];

    await provider.prefetch(sessions);
    const snapshot = await new CompanionScannerEngine(provider).scanCompanionDatasetAsync(sessions);

    assert.equal(calls, 2);
    assert.equal(snapshot.fact_store?.length, 1);
  });

  it('binds decisions to discovery evidence and keeps third-party attributes off the user profile', async () => {
    const source = '我的同事甲住在乙城，职业是工程师';
    const provider = new MiniMaxCompanionSemanticProvider(config, twoStageRequest(() => ({
      candidates: [
        emitted({
          claimIndexes: [0], subject: 'people.entity.peer-one', predicate: 'location', value: '乙城',
          entityMentions: [{ surface: '甲', entityType: 'person', relation: '同事', qualifiers: { location: '乙城', occupation: '工程师' } }]
        }),
        emitted({
          claimIndexes: [1], subject: 'people.entity.peer-one', predicate: 'occupation', value: '工程师',
          entityMentions: [{ surface: '甲', entityType: 'person', relation: '同事', qualifiers: { location: '乙城', occupation: '工程师' } }]
        })
      ],
      dismissed: []
    }), { m1: [source, source] }));

    const snapshot = await new CompanionScannerEngine(provider).scanCompanionDatasetAsync([session([
      { id: 'm1', role: 'user', content: `${source}。` }
    ])]);

    assert.equal(snapshot.fact_store?.length, 2);
    assert.equal(snapshot.user_model.location, undefined);
    assert.equal(snapshot.user_model.occupation, undefined);
    assert.deepEqual(snapshot.fact_store?.map(fact => fact.sourceSpans[0].text), [source, source]);
  });

  it('repairs relation-name surfaces and links later attributes to that entity', async () => {
    const provider = new MiniMaxCompanionSemanticProvider(config, twoStageRequest(messageId => ({
      candidates: messageId === 'm1'
        ? [emitted({ subject: 'people.relation.one', predicate: 'relation', value: '表姐', entityMentions: [{ surface: '表姐', entityType: 'person' }] })]
        : [emitted({ subject: 'profile.residence.current', predicate: 'currentResidence', value: '宁波', entityMentions: [] })],
      dismissed: []
    })));

    const snapshot = await new CompanionScannerEngine(provider).scanCompanionDatasetAsync([session([
      { id: 'm1', role: 'user', content: '顾青是我的表姐。' },
      { id: 'm2', role: 'user', content: '顾青住在宁波，那是顾青的所在地，不是我的。' }
    ])]);

    assert.equal(snapshot.user_model.location, undefined);
    assert.equal(snapshot.entities?.length, 1);
    assert.equal(snapshot.entities?.[0].canonicalName, '顾青');
    assert.equal(snapshot.entities?.[0].relation, '表姐');
    assert.equal(snapshot.entities?.[0].qualifiers.location, '宁波');
    assert.ok(snapshot.fact_store?.every(fact => fact.subject.startsWith('people.')));
  });

  it('treats explicit NOOP as authoritative instead of invoking the hybrid offline fallback', async () => {
    const semantic = new MiniMaxCompanionSemanticProvider(config, twoStageRequest(() => ({
      candidates: [], dismissed: [{ claimIndex: 0, decision: 'NOOP', reason: 'Task-only request' }]
    })));
    const provider = new HybridCompanionSemanticProvider(semantic);

    const snapshot = await new CompanionScannerEngine(provider).scanCompanionDatasetAsync([session([
      { id: 'm1', role: 'user', content: '我叫顾明，请只改一下这句话，不要提取。' }
    ])]);

    assert.equal(snapshot.fact_store?.length, 0);
    assert.equal(snapshot.operations_log.length, 0);
  });

  it('rejects lifecycle predicates without explicit lifecycle intent', async () => {
    const semantic = new MiniMaxCompanionSemanticProvider(config, twoStageRequest(() => ({
      candidates: [emitted({
        layer: 'RELATIONSHIP', subject: 'relationship.protocol.filler', predicate: 'orderedResponseProtocol',
        value: '晚点有新情况我再告诉你', entityMentions: []
      })],
      dismissed: []
    })));
    const snapshot = await new CompanionScannerEngine(semantic).scanCompanionDatasetAsync([session([
      { id: 'm1', role: 'user', content: '先聊到这里，晚点有新情况我再告诉你。' }
    ])]);

    assert.equal(snapshot.operations_log.length, 0);
    assert.ok(snapshot.rejected_items.some(item => item.reason.includes('predicateIntent')));
  });

  it('supplements authoritative semantic NOOP with high-confidence lifecycle rules', async () => {
    const semantic = new MiniMaxCompanionSemanticProvider(config, twoStageRequest(() => ({
      candidates: [], dismissed: [{ claimIndex: 0, decision: 'NOOP', reason: 'No semantic memory candidate' }]
    })));
    const provider = new HybridCompanionSemanticProvider(semantic);
    const snapshot = await new CompanionScannerEngine(provider).scanCompanionDatasetAsync([session([
      { id: 'm1', role: 'user', content: '我们建立一个长期规则，触发词是“慢灯检查”。' }
    ])]);

    assert.ok(snapshot.operations_log.some(operation => operation.predicate === 'relationship.ordered_protocol'));
  });

  it('lets deterministic lifecycle evidence replace a weaker semantic lifecycle candidate', async () => {
    const semantic = new MiniMaxCompanionSemanticProvider(config, twoStageRequest(() => ({
      candidates: [emitted({
        layer: 'RELATIONSHIP', subject: 'relationship.protocol.semantic', predicate: 'orderedResponseProtocol',
        value: '我们建立一个长期规则', entityMentions: []
      })],
      dismissed: []
    }), { m1: ['我们建立一个长期规则'] }));
    const snapshot = await new CompanionScannerEngine(new HybridCompanionSemanticProvider(semantic)).scanCompanionDatasetAsync([session([
      { id: 'm1', role: 'user', content: '我们建立一个长期规则，触发词是“慢灯检查”。' }
    ])]);
    const protocols = snapshot.operations_log.filter(operation => operation.predicate === 'relationship.ordered_protocol' && operation.action !== 'REJECT');

    assert.equal(protocols.length, 1);
    assert.match(String(protocols[0].value), /慢灯检查/);
  });
  it('routes high-confidence messages without semantic requests', async () => {
    let calls = 0;
    const request = twoStageRequest(() => ({ candidates: [emitted()], dismissed: [] }));
    const semantic = new MiniMaxCompanionSemanticProvider(config, async (...args) => {
      calls += 1;
      return request(...args);
    });
    const hybrid = new HybridCompanionSemanticProvider(semantic);
    const snapshot = await new CompanionScannerEngine(hybrid).scanCompanionDatasetAsync([session([
      { id: 'm1', role: 'user', content: '我叫林澈。' },
      { id: 'm2', role: 'user', content: '我现在住在杭州。' },
      { id: 'm3', role: 'user', content: '我的工作是古建修复师。' },
      { id: 'm4', role: 'user', content: '先聊到这里。' }
    ])]);

    assert.equal(calls, 0);
    assert.equal(snapshot.operations_log.filter(operation => operation.action !== 'REJECT').length, 3);
    assert.deepEqual(hybrid.routingUsage(), { deterministicFirst: 3, definitiveNoop: 0, lowSignal: 1, stageAOrUnavailable: 0, semantic: 0 });
  });

  it('rejects malformed discovery evidence and normalizes evidence-backed assertion aliases', async () => {
    const malformed = new MiniMaxCompanionSemanticProvider(config, twoStageRequest(() => ({ candidates: [emitted()], dismissed: [] }), {
      m1: ['不存在的原文']
    }));
    const malformedSnapshot = await new CompanionScannerEngine(malformed).scanCompanionDatasetAsync([session([
      { id: 'm1', role: 'user', content: '我住在乙城。' }
    ])]);
    assert.equal(malformedSnapshot.fact_store?.length, 0);
    assert.ok(malformedSnapshot.rejected_items.some(item => item.reason.includes('malformed')));

    const inconsistent = new MiniMaxCompanionSemanticProvider(config, twoStageRequest(() => ({
      candidates: [emitted({ assertionMode: 'current', scope: 'durable', temporalStatus: 'current' })],
      dismissed: []
    })));
    const inconsistentSnapshot = await new CompanionScannerEngine(inconsistent).scanCompanionDatasetAsync([session([
      { id: 'm1', role: 'user', content: '我可能搬去乙城，还没决定。' }
    ])]);
    assert.equal(inconsistentSnapshot.fact_store?.length, 1);
    assert.equal(inconsistentSnapshot.operations_log[0].scope, 'temporary');
    assert.equal(inconsistentSnapshot.operations_log[0].temporal_status, 'temporary');
  });

  it('expands one bound timeline claim into ordered atomic events', async () => {
    const source = '请记录时间线：2032-01-01完成甲；2032-01-02完成乙；2032-01-03完成丙，项目完成';
    const timeline = (eventTime: string) => emitted({
      claimIndexes: [0], layer: 'EPISODIC_MEMORY', subject: 'event.timeline.project', predicate: 'timeline_step',
      value: `完成${eventTime.at(-1)}`, assertionMode: 'historical', scope: 'historical', temporalStatus: 'historical', eventTime
    });
    const provider = new MiniMaxCompanionSemanticProvider(config, twoStageRequest(() => ({
      candidates: [timeline('2032-01-01'), timeline('2032-01-02'), timeline('2032-01-03')], dismissed: []
    }), { m1: [source] }));

    const snapshot = await new CompanionScannerEngine(provider).scanCompanionDatasetAsync([session([
      { id: 'm1', role: 'user', content: `${source}。` }
    ])]);

    assert.equal(snapshot.operations_log.length, 3);
    assert.deepEqual(snapshot.operations_log.map(operation => String(operation.value).slice(0, 3)), ['第1步', '第2步', '第3步']);
  });

  it('uses an existing immutable operation ID to supersede the exact prior subject', async () => {
    const request = twoStageRequest((messageId, payload) => {
      if (messageId === 'm1') return {
        candidates: [emitted({
          subject: 'people.relation.person-a', predicate: 'relation', value: { name: '甲', relation: '表姐' },
          entityMentions: [{ surface: '甲', entityType: 'person', relation: '表姐' }]
        })],
        dismissed: []
      };
      const prior = payload.priorAcceptedOperations as Array<{ operationId: string }>;
      assert.equal(prior.length, 1);
      return {
        candidates: [emitted({
          subject: 'people.relation.person-a', predicate: 'relation', value: { name: '甲', relation: '堂姐' },
          assertionMode: 'correction', entityMentions: [{ surface: '甲', entityType: 'person', relation: '堂姐' }],
          supersedesOperationIds: [prior[0].operationId]
        })],
        dismissed: []
      };
    });
    const provider = new MiniMaxCompanionSemanticProvider(config, request);
    const snapshot = await new CompanionScannerEngine(provider).scanCompanionDatasetAsync([session([
      { id: 'm1', role: 'user', content: '甲是我表姐。' },
      { id: 'm2', role: 'user', content: '更正：甲不是我表姐，是我堂姐。' }
    ])]);

    assert.deepEqual(snapshot.operations_log.map(operation => operation.action), ['ADD', 'SUPERSEDE']);
    assert.equal(snapshot.operations_log[1].supersedes?.length, 1);
    assert.equal(snapshot.fact_store?.filter(fact => fact.active).length, 1);
  });
});
