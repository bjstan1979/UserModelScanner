import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CompanionScannerEngine, CompanionSession } from '../src/companion/engine.js';
import { FullCompanionSnapshot, MemoryOperation } from '../src/companion/schema.js';
import { operationVocabularyMatches, subjectPatternMatches } from '../src/companion/ontology.js';

interface AssertionSpec {
  assertionId?: string;
  path?: string;
  op: string;
  value?: unknown;
  values?: unknown[];
}

interface BlindFixture {
  metadata: {
    createdAfterEngineCommit: string;
    engineMutableAfterCreation: false;
    authorDidNotInspectEngine: true;
    status: 'post-freeze-blind';
  };
  sessions: Array<{
    sessionId: string;
    startedAt: string;
    messages: CompanionSession['messages'];
  }>;
  finalStateAssertions: Array<AssertionSpec & { assertionId: string; path: string }>;
  messageExpectations: Array<{
    messageId: string;
    expectedOperationCount: number;
    expectedOperations: Array<{
      action: string;
      layer: string;
      subjectPattern: string;
      predicate: string;
      valueAssertions: AssertionSpec[];
      scope: string;
      temporalStatus: string;
      requiresSupersedes: boolean;
    }>;
    forbiddenActions: string[];
    finalStateAssertionIds: string[];
  }>;
  deletionChecks: Array<{
    removeMessageId: string;
    assertionsAfterDeletion: Array<AssertionSpec & { assertionId: string; path: string }>;
  }>;
  forbiddenSnapshotAssertions: Array<AssertionSpec & { assertionId: string; path: string; category: string }>;
}

interface BlindFinding {
  id: string;
  status: 'TP' | 'FP' | 'FN' | 'TN';
  expected: unknown;
  actual: unknown;
  reason: string;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).sort().join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${key}:${stable(child)}`).join(',')}}`;
}

function resolve(root: unknown, assertionPath: string): unknown {
  let value = root;
  for (const part of assertionPath.split('.')) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function assertValue(actual: unknown, assertion: AssertionSpec): boolean {
  const serialized = typeof actual === 'string' ? actual : JSON.stringify(actual) ?? '';
  switch (assertion.op) {
    case 'eq': return stable(actual) === stable(assertion.value);
    case 'contains_all': return (assertion.values ?? []).every(value => serialized.includes(String(value)));
    case 'contains_any': return (assertion.values ?? []).some(value => serialized.includes(String(value)));
    case 'not_contains': return !serialized.includes(typeof assertion.value === 'string' ? assertion.value : JSON.stringify(assertion.value));
    case 'array_object_match': {
      if (!Array.isArray(actual)) return false;
      const expected = assertion.value as Record<string, unknown>;
      return actual.some(item => item && typeof item === 'object' && Object.entries(expected).every(([key, value]) => stable((item as Record<string, unknown>)[key]) === stable(value)));
    }
    default: return false;
  }
}

function operationValue(operation: MemoryOperation): unknown {
  return operation.value && typeof operation.value === 'object' && 'normalized' in operation.value ? operation.value.normalized : operation.value;
}

function conceptualSnapshot(snapshot: FullCompanionSnapshot): Record<string, unknown> {
  const facts = snapshot.fact_store ?? [];
  const active = facts.filter(fact => fact.active);
  const values = (prefix: string, includeInactive = false) => (includeInactive ? facts : active)
    .filter(fact => fact.subject.startsWith(prefix))
    .map(fact => fact.value);
  const value = (subject: string) => [...active].reverse().find(fact => fact.subject === subject)?.value;
  const name = snapshot.user_model.name;
  return {
    profile: {
      identity: { fullName: name, surname: value('profile.identity.surname') ?? name?.slice(0, 1) },
      residence: { current: value('profile.residence.current') ?? snapshot.user_model.location },
      occupation: { current: value('profile.occupation.current') ?? snapshot.user_model.occupation },
      childhoodPlace: { current: value('profile.childhood_place.current') }
    },
    people: snapshot.user_model.important_relations,
    preference: {
      reading: { current: value('preference.reading.long_form'), history: values('preference.reading.long_form', true) },
      activity: { current: value('preference.activity.') },
      shopping: { current: value('preference.shopping.') },
      meetingTime: { positive: value('preference.meeting_time.') },
      beverage: { current: value('preference.beverage.') ?? snapshot.user_model.coffee_preference },
      voice: { current: value('preference.communication.voice_message') ?? snapshot.user_model.audio_message_preference }
    },
    decision: { current: values('decision.') },
    context: {
      current: active.filter(fact => fact.layer === 'CURRENT_CONTEXT').map(fact => fact.value),
      closed: snapshot.current_context.closed_states,
      relationshipProtocol: snapshot.relationship_model.communication_protocols
    },
    episodes: snapshot.episodic_memory,
    snapshot
  };
}
function operationMatches(operation: MemoryOperation, expected: BlindFixture['messageExpectations'][number]['expectedOperations'][number]): boolean {
  if (!operationVocabularyMatches(operation, expected)) return false;
  if (!subjectPatternMatches(operation.subject, expected.subjectPattern)) return false;
  if (operation.predicate !== expected.predicate) return false;
  if (expected.requiresSupersedes && !(operation.supersedes?.length)) return false;
  return expected.valueAssertions.every(assertion => assertValue(operationValue(operation), assertion));
}

function summarize(findings: BlindFinding[]) {
  const count = (status: BlindFinding['status']) => findings.filter(finding => finding.status === status).length;
  const tp = count('TP');
  const fp = count('FP');
  const fn = count('FN');
  const tn = count('TN');
  const divide = (a: number, b: number) => b === 0 ? null : a / b;
  const precision = divide(tp, tp + fp);
  const recall = divide(tp, tp + fn);
  return {
    total: findings.length,
    tp,
    fp,
    fn,
    tn,
    precision,
    recall,
    f1: precision === null || recall === null || precision + recall === 0 ? null : 2 * precision * recall / (precision + recall)
  };
}

function normalizeSessions(fixture: BlindFixture): CompanionSession[] {
  return fixture.sessions.map(session => ({
    session_id: session.sessionId,
    date: session.startedAt.slice(0, 10),
    topic: 'post-freeze-blind',
    messages: session.messages
  }));
}

function evaluateBlind(fixture: BlindFixture) {
  const snapshot = new CompanionScannerEngine().scanCompanionDataset(normalizeSessions(fixture));
  const conceptual = conceptualSnapshot(snapshot);
  const finalFindings: BlindFinding[] = fixture.finalStateAssertions.map(assertion => {
    const actual = resolve(conceptual, assertion.path);
    const passed = assertValue(actual, assertion);
    return { id: assertion.assertionId, status: passed ? 'TP' : 'FN', expected: assertion, actual, reason: passed ? 'Final-state assertion matched' : 'Final-state assertion did not match' };
  });

  const operationFindings: BlindFinding[] = [];
  for (const expectation of fixture.messageExpectations) {
    const actual = snapshot.operations_log.filter(operation => operation.action !== 'REJECT' && operation.evidenceIds.includes(expectation.messageId));
    const unmatched = new Set(actual.map((_, index) => index));
    expectation.expectedOperations.forEach((expected, expectedIndex) => {
      const index = [...unmatched].find(candidate => operationMatches(actual[candidate], expected));
      if (index !== undefined) unmatched.delete(index);
      operationFindings.push({
        id: `${expectation.messageId}/expected-${expectedIndex + 1}`,
        status: index === undefined ? 'FN' : 'TP',
        expected,
        actual: index === undefined ? actual : actual[index],
        reason: index === undefined ? 'No operation matched complete blind semantics' : 'Matched action/layer/subject/predicate/value/scope/temporal/provenance'
      });
    });
    for (const index of unmatched) {
      operationFindings.push({ id: `${expectation.messageId}/extra-${index + 1}`, status: 'FP', expected: `exactly ${expectation.expectedOperationCount} operations`, actual: actual[index], reason: 'Unexpected extra operation' });
    }
  }

  const forbiddenFindings: BlindFinding[] = fixture.forbiddenSnapshotAssertions.map(assertion => {
    const actual = resolve(conceptual, assertion.path);
    const passed = assertValue(actual, assertion);
    return { id: assertion.assertionId, status: passed ? 'TN' : 'FP', expected: assertion, actual, reason: passed ? 'Forbidden output absent' : `Forbidden output present (${assertion.category})` };
  });

  const deletionFindings: BlindFinding[] = [];
  for (const check of fixture.deletionChecks) {
    const reducedSessions = normalizeSessions(fixture).map(session => ({ ...session, messages: session.messages.filter(message => message.id !== check.removeMessageId) }));
    const reduced = conceptualSnapshot(new CompanionScannerEngine().scanCompanionDataset(reducedSessions));
    for (const assertion of check.assertionsAfterDeletion) {
      const actual = resolve(reduced, assertion.path);
      const passed = assertValue(actual, assertion);
      deletionFindings.push({ id: `${check.removeMessageId}/${assertion.assertionId}`, status: passed ? 'TP' : 'FN', expected: assertion, actual, reason: passed ? 'Deletion assertion matched' : 'Removing evidence did not produce expected state change' });
    }
  }

  return {
    status: 'provisional' as const,
    engineCommit: fixture.metadata.createdAfterEngineCommit,
    fixtureStatus: fixture.metadata.status,
    finalState: { summary: summarize(finalFindings), failures: finalFindings.filter(finding => finding.status !== 'TP') },
    messageOperations: { summary: summarize(operationFindings), failures: operationFindings.filter(finding => finding.status !== 'TP') },
    forbiddenGuards: {
      summary: { total: forbiddenFindings.length, tn: forbiddenFindings.filter(finding => finding.status === 'TN').length, fp: forbiddenFindings.filter(finding => finding.status === 'FP').length },
      failures: forbiddenFindings.filter(finding => finding.status === 'FP')
    },
    deletionChecks: { summary: summarize(deletionFindings), failures: deletionFindings.filter(finding => finding.status !== 'TP') }
  };
}

test('historical blind v1 remains a provisional regression corpus after the next approved engine revision', () => {
  const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'blind-holdout-v1.json');
  const fixture: BlindFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  assert.equal(fixture.metadata.engineMutableAfterCreation, false);
  assert.equal(fixture.metadata.authorDidNotInspectEngine, true);
  assert.equal(fixture.metadata.status, 'post-freeze-blind');
  execFileSync('git', ['cat-file', '-e', `${fixture.metadata.createdAfterEngineCommit}^{commit}`], { cwd: process.cwd() });

  const userMessageIds = new Set(fixture.sessions.flatMap(session => session.messages.filter(message => message.role === 'user').map(message => message.id)));
  assert.deepEqual(new Set(fixture.messageExpectations.map(expectation => expectation.messageId)), userMessageIds, 'Every blind user message must have an operation expectation');

  const report = evaluateBlind(fixture);
  assert.equal(report.status, 'provisional');
  assert.ok(report.finalState.summary.total > 0);
  assert.ok(report.messageOperations.summary.total > 0);
  assert.equal(report.forbiddenGuards.summary.total, fixture.forbiddenSnapshotAssertions.length);

  const recordedPath = path.join(process.cwd(), 'tests', 'fixtures', 'blind-holdout-v1-result.json');
  assert.ok(fs.existsSync(recordedPath), 'The immutable result produced by the frozen v1 engine must remain recorded');
  console.log(`BLIND_V1_REGRESSION_SUMMARY ${JSON.stringify({
    status: report.status,
    historicalEngineCommit: report.engineCommit,
    finalState: report.finalState.summary,
    messageOperations: report.messageOperations.summary,
    forbiddenGuards: report.forbiddenGuards.summary,
    deletionChecks: report.deletionChecks.summary,
    historicalFrozenResult: path.relative(process.cwd(), recordedPath)
  })}`);
});
