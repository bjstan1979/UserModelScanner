import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompanionScannerEngine, CompanionSession } from '../src/companion/engine.js';
import { CompanionBenchmarkEvaluator } from '../src/companion/evaluator.js';
import { CompanionResponder, runCompanionProbes } from '../src/companion/probes.js';
import { FullCompanionSnapshot, MemoryOperation } from '../src/companion/schema.js';

const emptyRelationship = {
  communication_protocols: [],
  shared_rituals: [],
  shared_memes: []
};

function syntheticSnapshot(operation: MemoryOperation): FullCompanionSnapshot {
  return {
    user_model: {
      name: '测试用户',
      location: '测试城',
      coffee_preference: '低因、燕麦奶、非冰',
      important_relations: [],
      pets: [],
      boundaries: []
    },
    relationship_model: { ...emptyRelationship },
    companion_identity: {},
    episodic_memory: [],
    current_context: {
      as_of_date: '2030-01-01',
      priorities: ['休息', '交接', '准备'],
      closed_states: []
    },
    operations_log: [operation],
    rejected_items: []
  };
}

function syntheticFixture(snapshot: FullCompanionSnapshot): string {
  const fixture = {
    version: 'test-ontology-structured',
    ontologyVersion: 'companion-memory/v1',
    evaluationStatus: 'provisional',
    metricPolicy: { zeroDenominator: 'null', unexpectedSnapshotAtoms: 'false_positive' },
    ignoredAtomicPaths: ['current_context.as_of_date'],
    canonical_state_items: [{
      code: 'identity-test',
      title: 'Identity',
      evidence: 'M01-U01',
      assertions: [{ assertionId: 'name', path: 'user_model.name', op: 'eq', value: '测试用户' }],
      forbiddenAssertions: []
    }],
    expected_snapshot: {
      user_model: snapshot.user_model,
      relationship_model: snapshot.relationship_model,
      companion_identity: snapshot.companion_identity,
      episodic_memory: snapshot.episodic_memory,
      current_context: snapshot.current_context
    },
    message_expectations: [{
      msg_id: 'M01-U01',
      expectedOperationCount: 1,
      expectedOperations: [{
        operationId: 'expected-name',
        action: 'upsert',
        layer: 'profile',
        subjectPattern: 'profile.identity.*',
        predicate: 'fullName',
        valueAssertion: { op: 'source_supported', messageId: 'M01-U01' },
        evidenceIdsAssertion: { op: 'exact_set', values: ['M01-U01'] },
        scope: 'durable',
        temporalStatus: 'current'
      }],
      forbiddenOperations: [],
      finalStateAssertions: [{ gtId: 'identity-test', assertionId: 'name' }]
    }],
    forbidden_items: [{
      guardId: 'guard-test',
      description: 'Unsupported name must be absent',
      assertions: [{ assertionId: 'forbidden-name', path: 'user_model.name', op: 'not_contains', value: '不存在' }]
    }]
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-evaluator-'));
  const fixturePath = path.join(directory, 'fixture.json');
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  return fixturePath;
}

const validOperation: MemoryOperation = {
  operationId: 'op-name',
  action: 'ADD',
  layer: 'USER_MODEL',
  subject: 'profile.identity.full_name',
  predicate: 'fullName',
  value: '测试用户',
  evidenceIds: ['M01-U01'],
  sourceSpans: [{
    messageId: 'M01-U01', sessionId: 'M01', sessionDate: '2030-01-01', role: 'user', start: 2, end: 6, text: '测试用户'
  }],
  confidence: 1,
  validFrom: '2030-01-01',
  scope: 'durable',
  temporal_status: 'active'
};
const syntheticSessions: CompanionSession[] = [{
  session_id: 'M01',
  date: '2030-01-01',
  topic: 'synthetic',
  messages: [{ id: 'M01-U01', role: 'user', content: '我叫测试用户' }]
}];

test('structured evaluator rejects wrong operation semantics even with the correct evidence ID', async () => {
  const validSnapshot = syntheticSnapshot(validOperation);
  const evaluator = new CompanionBenchmarkEvaluator(syntheticFixture(validSnapshot));
  const validReport = await evaluator.evaluateSnapshot(validSnapshot, syntheticSessions, null);
  assert.equal(validReport.ontology_contract_status, 'VALIDATED');
  const validOperationResult = validReport.item_evaluations.find(result => result.assertionId === 'expected-name');
  assert.equal(validOperationResult?.status, 'TP');

  const wrongOperation: MemoryOperation = {
    ...validOperation,
    operationId: 'op-wrong',
    layer: 'CURRENT_CONTEXT',
    subject: 'context.unrelated',
    predicate: 'unrelated',
    value: '错误值'
  };
  const wrongReport = await evaluator.evaluateSnapshot({ ...validSnapshot, operations_log: [wrongOperation] }, syntheticSessions, null);
  assert.equal(wrongReport.item_evaluations.find(result => result.assertionId === 'expected-name')?.status, 'FN');
  assert.ok(wrongReport.item_evaluations.some(result => result.gtId === 'M01-U01' && result.status === 'FP' && result.assertionId.startsWith('unexpected-operation')));

  const unsupportedNormalization = { ...validOperation, value: '不存在的名字' };
  const groundingReport = await evaluator.evaluateSnapshot({ ...validSnapshot, operations_log: [unsupportedNormalization] }, syntheticSessions, null);
  assert.equal(groundingReport.item_evaluations.find(result => result.assertionId === 'expected-name')?.status, 'FN', 'Exact provenance is insufficient when the normalized value is not entailed');
});

test('ontology fixtures fail before scoring when version or vocabulary is invalid', () => {
  const snapshot = syntheticSnapshot(validOperation);
  const missingVersionPath = syntheticFixture(snapshot);
  const missingVersion = JSON.parse(fs.readFileSync(missingVersionPath, 'utf8'));
  delete missingVersion.ontologyVersion;
  fs.writeFileSync(missingVersionPath, JSON.stringify(missingVersion));
  assert.throws(() => new CompanionBenchmarkEvaluator(missingVersionPath), /must declare ontologyVersion/);

  const unknownPredicatePath = syntheticFixture(snapshot);
  const unknownPredicate = JSON.parse(fs.readFileSync(unknownPredicatePath, 'utf8'));
  unknownPredicate.message_expectations[0].expectedOperations[0].predicate = 'unknown_predicate';
  fs.writeFileSync(unknownPredicatePath, JSON.stringify(unknownPredicate));
  assert.throws(() => new CompanionBenchmarkEvaluator(unknownPredicatePath), /Invalid Ground Truth ontology vocabulary.*predicate=unknown_predicate/);
});

test('structured evaluator reports extra operations and unsupported snapshot atoms as false positives', async () => {
  const snapshot = syntheticSnapshot(validOperation);
  const evaluator = new CompanionBenchmarkEvaluator(syntheticFixture(snapshot));
  const extraOperation: MemoryOperation = {
    ...validOperation,
    operationId: 'op-extra',
    subject: 'profile.unsupported',
    predicate: 'unsupported'
  };
  const withExtra = await evaluator.evaluateSnapshot({ ...snapshot, operations_log: [validOperation, extraOperation] }, syntheticSessions, null);
  assert.ok(withExtra.message_expectations_summary.false_positives >= 1);

  const unsupported = {
    ...snapshot,
    user_model: { ...snapshot.user_model, occupation: '未被 Ground Truth 支持的职业' }
  };
  const unsupportedReport = await evaluator.evaluateSnapshot(unsupported, syntheticSessions, null);
  assert.ok(unsupportedReport.unsupported_output_summary.false_positives >= 1);
});

test('forbidden negative-only metrics are N/A and no-responder probes are NOT_RUN', async () => {
  const snapshot = syntheticSnapshot(validOperation);
  const evaluator = new CompanionBenchmarkEvaluator(syntheticFixture(snapshot));
  const report = await evaluator.evaluateSnapshot(snapshot, syntheticSessions, null);
  assert.equal(report.forbidden_summary.precision, null);
  assert.equal(report.forbidden_summary.recall, null);
  assert.equal(report.forbidden_summary.f1_score, null);
  assert.equal(report.forbidden_summary.specificity, 1);
  assert.equal(report.probe_evaluation_kind, 'NOT_RUN');
  assert.ok(report.probe_results.every(result => result.status === 'NOT_RUN' && result.passed === false));
  assert.equal(report.overall_pass, false, 'No real integration probe means overall integration cannot pass');
});

test('mock responder is labeled unit-only; empty, boilerplate, and off-topic responses fail every probe', async () => {
  const snapshot = syntheticSnapshot(validOperation);
  const evaluator = new CompanionBenchmarkEvaluator(syntheticFixture(snapshot));
  const compliantMock: CompanionResponder = {
    respond(_snapshot, query) {
      if (query.includes('难受')) return '我在听，你现在很难受。想先说说，还是一起分析？';
      if (query.includes('错别字')) return '这段文字的错别字、标点与段落格式都需要逐项检查。';
      if (query.includes('隔了')) return '好久不见，最近怎么样？现在想聊什么？';
      if (query.includes('成长地')) return '记录显示你在测试城成长。';
      if (query.includes('优先事项')) return '当前优先事项是休息、交接、准备。';
      if (query.includes('目标')) return '恭喜你完成这个目标，这是你的努力一步步带来的。';
      if (query.includes('紧急任务')) return '任务出问题确实会让人紧张，我们一起处理眼前的问题。';
      if (query.includes('饮品偏好')) return '推荐来一杯低因、燕麦奶、非冰的拿铁。';
      return '未记录。';
    }
  };
  const report = await evaluator.evaluateSnapshot(snapshot, syntheticSessions, compliantMock, 'MOCK_UNIT');
  assert.equal(report.probe_evaluation_kind, 'MOCK_UNIT');
  assert.ok(report.probe_results.every(result => result.status === 'PASSED'));
  assert.equal(report.overall_pass, false, 'Mock unit probes cannot satisfy real-integration acceptance');

  for (const response of ['', '收到。', '今天天气不错，我们聊电影吧。']) {
    const probeResults = await runCompanionProbes(snapshot, { respond: () => response });
    assert.ok(probeResults.every(result => result.status === 'FAILED'), `Every probe must reject ${JSON.stringify(response)}`);
  }
});

test('main benchmark report remains provisional and enumerates every failure instead of claiming perfect metrics', async () => {
  const sessions: CompanionSession[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'companion_sessions.json'), 'utf8'));
  const snapshot = new CompanionScannerEngine().scanCompanionDataset(sessions);
  const report = await new CompanionBenchmarkEvaluator().evaluateSnapshot(snapshot, sessions, null);
  const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'companion-ground-truth.json'), 'utf8'));

  assert.equal(fixture.canonical_state_items.length, 37);
  assert.equal(fixture.message_expectations.length, 78);
  assert.equal(fixture.forbidden_items.length, 12);
  assert.ok(fixture.canonical_state_items.every((item: { assertions?: unknown[] }) => item.assertions && item.assertions.length > 0));
  assert.ok(fixture.message_expectations.every((item: { expectedOperations?: unknown[]; expectedOperationCount?: number }) => item.expectedOperations && item.expectedOperations.length === item.expectedOperationCount));

  assert.equal(report.evaluation_status, 'provisional');
  assert.equal(report.overall_pass, false);
  assert.equal(report.probe_evaluation_kind, 'NOT_RUN');
  assert.equal(report.failed_items.length, report.item_evaluations.filter(item => item.status === 'FP' || item.status === 'FN').length);
  assert.equal(report.not_evaluated_items.length, report.item_evaluations.filter(item => item.status === 'NOT_EVALUATED').length);
  for (const result of report.item_evaluations) {
    assert.equal(typeof result.gtId, 'string');
    assert.equal(typeof result.assertionId, 'string');
    assert.ok(['TP', 'FP', 'FN', 'TN', 'NOT_EVALUATED'].includes(result.status));
    assert.ok(Array.isArray(result.evidenceIds));
    assert.equal(typeof result.reason, 'string');
    assert.ok('expected' in result);
    assert.ok('actual' in result);
  }
});
