import { CompanionScannerEngine, CompanionSession } from '../../src/companion/engine.js';
import {
  COMPANION_ONTOLOGY_VERSION,
  layerVocabularyMatches,
  operationVocabularyMatches,
  predicateVocabularyMatches,
  scopeVocabularyMatches,
  subjectPatternMatches,
  temporalVocabularyMatches,
  validateOperationExpectationVocabulary,
  validateSemanticExpectationVocabulary
} from '../../src/companion/ontology.js';
import { FullCompanionSnapshot, MemoryOperation } from '../../src/companion/schema.js';

export interface AssertionSpec {
  assertionId?: string;
  path?: string;
  op: string;
  value?: unknown;
  values?: unknown[];
}

export interface BlindFixture {
  metadata: {
    fixtureId?: string;
    createdAfterEngineCommit: string;
    canonicalizerFreezeCommit?: string;
    engineMutableAfterCreation: false;
    authorDidNotInspectEngine: true;
    status: string;
    ontologyVersion?: string;
  };
  sessions: Array<{
    sessionId: string;
    startedAt?: string;
    sessionDate?: string;
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

export interface BlindFinding {
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
  const collection = assertion.values ?? (Array.isArray(assertion.value) ? assertion.value : []);
  switch (assertion.op) {
    case 'eq': return stable(actual) === stable(assertion.value);
    case 'contains_all': return collection.every(value => serialized.includes(String(value)));
    case 'contains_any': return collection.some(value => serialized.includes(String(value)));
    case 'not_contains': {
      const forbidden = collection.length ? collection : [assertion.value];
      return forbidden.every(value => !serialized.includes(String(value)));
    }
    case 'array_object_match': {
      if (!Array.isArray(actual)) return false;
      const expected = assertion.value as Record<string, unknown>;
      return actual.some(item => item && typeof item === 'object' && Object.entries(expected).every(([key, value]) => stable((item as Record<string, unknown>)[key]) === stable(value)));
    }
    default: return false;
  }
}

function operationValue(operation: MemoryOperation): unknown {
  return operation.value && typeof operation.value === 'object' && 'normalized' in operation.value
    ? operation.value.normalized
    : operation.value;
}

function conceptualSnapshot(snapshot: FullCompanionSnapshot): Record<string, unknown> {
  const facts = snapshot.fact_store ?? [];
  const active = facts.filter(fact => fact.active);
  const values = (prefix: string, includeInactive = false) => (includeInactive ? facts : active)
    .filter(fact => fact.subject.startsWith(prefix))
    .map(fact => fact.value);
  const value = (subject: string) => [...active].reverse().find(fact => fact.subject === subject)?.value;
  const firstValue = (prefix: string) => [...active].reverse().find(fact => fact.subject.startsWith(prefix))?.value;
  const name = snapshot.user_model.name;
  return {
    profile: {
      identity: { fullName: name, surname: value('profile.identity.surname') ?? name?.slice(0, 1) },
      residence: { current: value('profile.residence.current') ?? snapshot.user_model.location },
      occupation: { current: value('profile.occupation.current') ?? snapshot.user_model.occupation },
      childhoodPlace: { current: value('profile.childhood_place.current') }
    },
    people: snapshot.user_model.important_relations,
    entities: snapshot.entities ?? [],
    preference: {
      reading: { current: value('preference.reading.long_form'), history: values('preference.reading.long_form', true) },
      activity: { current: firstValue('preference.activity.') },
      shopping: { current: firstValue('preference.shopping.') },
      meetingTime: { positive: firstValue('preference.meeting_time.') },
      beverage: { current: firstValue('preference.beverage.') ?? snapshot.user_model.coffee_preference },
      voice: { current: value('preference.communication.voice_message') ?? snapshot.user_model.audio_message_preference }
    },
    decision: { current: values('decision.') },
    context: {
      current: active.filter(fact => fact.layer === 'CURRENT_CONTEXT').map(fact => fact.value),
      closed: snapshot.current_context.closed_states,
      relationshipProtocol: snapshot.relationship_model.communication_protocols
    },
    episodes: snapshot.episodic_memory,
    facts,
    snapshot
  };
}

function operationMatches(operation: MemoryOperation, expected: BlindFixture['messageExpectations'][number]['expectedOperations'][number]): boolean {
  if (!operationVocabularyMatches(operation, expected)) return false;
  if (!subjectPatternMatches(operation.subject, expected.subjectPattern)) return false;
  if (!predicateVocabularyMatches(operation.predicate, expected.predicate)) return false;
  if (expected.requiresSupersedes && !(operation.supersedes?.length)) return false;
  return expected.valueAssertions.every(assertion => assertValue(operationValue(operation), assertion));
}

function summarize(findings: BlindFinding[]) {
  const count = (status: BlindFinding['status']) => findings.filter(finding => finding.status === status).length;
  const tp = count('TP');
  const fp = count('FP');
  const fn = count('FN');
  const tn = count('TN');
  const divide = (numerator: number, denominator: number) => denominator === 0 ? null : numerator / denominator;
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

export function normalizeSessions(fixture: BlindFixture): CompanionSession[] {
  return fixture.sessions.map(session => ({
    session_id: session.sessionId,
    date: (session.startedAt ?? session.sessionDate ?? '').slice(0, 10),
    topic: 'post-freeze-blind',
    messages: session.messages
  }));
}

export function evaluateBlind(fixture: BlindFixture) {
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

  const forbiddenTn = forbiddenFindings.filter(finding => finding.status === 'TN').length;
  const forbiddenFp = forbiddenFindings.filter(finding => finding.status === 'FP').length;
  return {
    status: 'provisional' as const,
    engineCommit: fixture.metadata.createdAfterEngineCommit,
    fixtureStatus: fixture.metadata.status,
    finalState: { summary: summarize(finalFindings), failures: finalFindings.filter(finding => finding.status !== 'TP') },
    messageOperations: { summary: summarize(operationFindings), failures: operationFindings.filter(finding => finding.status !== 'TP') },
    forbiddenGuards: {
      summary: {
        total: forbiddenFindings.length,
        tn: forbiddenTn,
        fp: forbiddenFp,
        specificity: forbiddenTn + forbiddenFp === 0 ? null : forbiddenTn / (forbiddenTn + forbiddenFp),
        falsePositiveRate: forbiddenTn + forbiddenFp === 0 ? null : forbiddenFp / (forbiddenTn + forbiddenFp),
        precision: null,
        recall: null,
        f1: null
      },
      failures: forbiddenFindings.filter(finding => finding.status === 'FP')
    },
    deletionChecks: { summary: summarize(deletionFindings), failures: deletionFindings.filter(finding => finding.status !== 'TP') }
  };
}

export interface SemanticStateAssertion {
  id: string;
  layer: string;
  subjectPattern: string;
  predicate: string;
  valueAssertions: AssertionSpec[];
  scope: string;
  temporalStatus: string;
}

export interface BlindV2Fixture {
  metadata: BlindFixture['metadata'] & {
    expectedOperationCount: number;
    finalStateAssertionCount: number;
    forbiddenSnapshotAssertionCount: number;
    deletionCheckCount: number;
  } & Record<string, unknown>;
  sessions: BlindFixture['sessions'];
  messageExpectations: BlindFixture['messageExpectations'];
  finalStateAssertions: SemanticStateAssertion[];
  forbiddenSnapshotAssertions: SemanticStateAssertion[];
  deletionChecks: Array<{
    id: string;
    afterMessageId: string;
    description: string;
    mustBeAbsent: Array<Omit<SemanticStateAssertion, 'id'>>;
    mustRemainFinalStateAssertionIds: string[];
  }>;
}

function semanticCandidates(snapshot: FullCompanionSnapshot, assertion: Omit<SemanticStateAssertion, 'id'>) {
  return (snapshot.fact_store ?? []).filter(fact =>
    layerVocabularyMatches(fact.layer, assertion.layer)
    && subjectPatternMatches(fact.subject, assertion.subjectPattern)
    && predicateVocabularyMatches(fact.predicate, assertion.predicate)
    && scopeVocabularyMatches(fact.scope, assertion.scope)
    && temporalVocabularyMatches(fact.temporalStatus, assertion.temporalStatus)
  );
}

function semanticStatePass(snapshot: FullCompanionSnapshot, assertion: SemanticStateAssertion | Omit<SemanticStateAssertion, 'id'>): { passed: boolean; actual: unknown } {
  const candidates = semanticCandidates(snapshot, assertion);
  const match = candidates.find(fact => assertion.valueAssertions.every(valueAssertion => {
    const actual = valueAssertion.path && valueAssertion.path !== '$' ? resolve(fact.value, valueAssertion.path) : fact.value;
    return assertValue(actual, valueAssertion);
  }));
  return { passed: Boolean(match), actual: match ?? candidates };
}

function semanticForbiddenPass(snapshot: FullCompanionSnapshot, assertion: SemanticStateAssertion | Omit<SemanticStateAssertion, 'id'>): { passed: boolean; actual: unknown } {
  const candidates = semanticCandidates(snapshot, assertion);
  const violating = candidates.find(fact => !assertion.valueAssertions.every(valueAssertion => {
    const actual = valueAssertion.path && valueAssertion.path !== '$' ? resolve(fact.value, valueAssertion.path) : fact.value;
    return assertValue(actual, valueAssertion);
  }));
  return { passed: !violating, actual: violating ?? candidates };
}

function sessionsThroughMessage(fixture: BlindV2Fixture, afterMessageId: string): CompanionSession[] {
  const sessions: CompanionSession[] = [];
  let reached = false;
  for (const session of normalizeSessions(fixture as unknown as BlindFixture)) {
    if (reached) break;
    const messages = [];
    for (const message of session.messages) {
      messages.push(message);
      if (message.id === afterMessageId) {
        reached = true;
        break;
      }
    }
    sessions.push({ ...session, messages });
  }
  return sessions;
}
export function validateBlindV2Ontology(fixture: BlindV2Fixture): void {
  const issues: string[] = [];
  if (fixture.metadata.ontologyVersion !== COMPANION_ONTOLOGY_VERSION) {
    issues.push(`metadata.ontologyVersion=${fixture.metadata.ontologyVersion ?? 'missing'}`);
  }
  fixture.messageExpectations.forEach((expectation, messageIndex) => {
    expectation.expectedOperations.forEach((expected, operationIndex) => {
      for (const issue of validateOperationExpectationVocabulary(expected)) {
        issues.push(`messageExpectations[${messageIndex}].expectedOperations[${operationIndex}].${issue}`);
      }
    });
  });
  const semanticGroups: Array<[string, Array<SemanticStateAssertion | Omit<SemanticStateAssertion, 'id'>>]> = [
    ['finalStateAssertions', fixture.finalStateAssertions],
    ['forbiddenSnapshotAssertions', fixture.forbiddenSnapshotAssertions],
    ['deletionChecks.mustBeAbsent', fixture.deletionChecks.flatMap(check => check.mustBeAbsent)]
  ];
  for (const [group, assertions] of semanticGroups) {
    assertions.forEach((assertion, index) => {
      for (const issue of validateSemanticExpectationVocabulary(assertion)) issues.push(`${group}[${index}].${issue}`);
    });
  }
  if (issues.length) throw new Error(`INVALID_EVALUATION: ontology contract violations: ${issues.join('; ')}`);
}



export type BlindScanner = (sessions: CompanionSession[]) => FullCompanionSnapshot | Promise<FullCompanionSnapshot>;

export async function evaluateBlindV2(
  fixture: BlindV2Fixture,
  scan: BlindScanner = sessions => new CompanionScannerEngine().scanCompanionDataset(sessions)
) {
  validateBlindV2Ontology(fixture);
  const sessions = normalizeSessions(fixture as unknown as BlindFixture);
  const snapshot = await scan(sessions);
  const finalFindings: BlindFinding[] = fixture.finalStateAssertions.map(assertion => {
    const outcome = semanticStatePass(snapshot, assertion);
    return {
      id: assertion.id,
      status: outcome.passed ? 'TP' : 'FN',
      expected: assertion,
      actual: outcome.actual,
      reason: outcome.passed ? 'Ontology final-state assertion matched' : 'No logical fact matched complete ontology semantics'
    };
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
        reason: index === undefined ? 'No operation matched complete blind-v2 semantics' : 'Matched complete ontology operation semantics'
      });
    });
    for (const index of unmatched) {
      operationFindings.push({
        id: `${expectation.messageId}/extra-${index + 1}`,
        status: 'FP',
        expected: `exactly ${expectation.expectedOperationCount} operations`,
        actual: actual[index],
        reason: 'Unexpected extra operation'
      });
    }
  }

  const forbiddenFindings: BlindFinding[] = fixture.forbiddenSnapshotAssertions.map(assertion => {
    const outcome = semanticForbiddenPass(snapshot, assertion);
    return {
      id: assertion.id,
      status: outcome.passed ? 'TN' : 'FP',
      expected: assertion,
      actual: outcome.actual,
      reason: outcome.passed ? 'Forbidden logical fact absent' : 'Forbidden logical fact present'
    };
  });

  const checkpointFindings: BlindFinding[] = [];
  const finalById = new Map(fixture.finalStateAssertions.map(assertion => [assertion.id, assertion]));
  for (const checkpoint of fixture.deletionChecks) {
    const checkpointSnapshot = await scan(sessionsThroughMessage(fixture, checkpoint.afterMessageId));
    checkpoint.mustBeAbsent.forEach((assertion, index) => {
      const outcome = semanticForbiddenPass(checkpointSnapshot, assertion);
      checkpointFindings.push({
        id: `${checkpoint.id}/absent-${index + 1}`,
        status: outcome.passed ? 'TP' : 'FN',
        expected: assertion,
        actual: outcome.actual,
        reason: outcome.passed ? 'Checkpoint forbidden state absent' : 'Checkpoint retained a forbidden state'
      });
    });
    for (const assertionId of checkpoint.mustRemainFinalStateAssertionIds) {
      const assertion = finalById.get(assertionId);
      if (!assertion) {
        checkpointFindings.push({ id: `${checkpoint.id}/${assertionId}`, status: 'FN', expected: assertionId, actual: undefined, reason: 'Referenced final-state assertion does not exist' });
        continue;
      }
      const outcome = semanticStatePass(checkpointSnapshot, assertion);
      checkpointFindings.push({
        id: `${checkpoint.id}/${assertionId}`,
        status: outcome.passed ? 'TP' : 'FN',
        expected: assertion,
        actual: outcome.actual,
        reason: outcome.passed ? 'Required checkpoint fact remains' : 'Required checkpoint fact is missing'
      });
    }
  }

  const forbiddenTn = forbiddenFindings.filter(finding => finding.status === 'TN').length;
  const forbiddenFp = forbiddenFindings.filter(finding => finding.status === 'FP').length;
  return {
    status: 'provisional' as const,
    engineCommit: fixture.metadata.createdAfterEngineCommit,
    fixtureStatus: fixture.metadata.status,
    finalState: { summary: summarize(finalFindings), failures: finalFindings.filter(finding => finding.status !== 'TP') },
    messageOperations: { summary: summarize(operationFindings), failures: operationFindings.filter(finding => finding.status !== 'TP') },
    forbiddenGuards: {
      summary: {
        total: forbiddenFindings.length,
        tn: forbiddenTn,
        fp: forbiddenFp,
        specificity: forbiddenTn + forbiddenFp === 0 ? null : forbiddenTn / (forbiddenTn + forbiddenFp),
        falsePositiveRate: forbiddenTn + forbiddenFp === 0 ? null : forbiddenFp / (forbiddenTn + forbiddenFp),
        precision: null,
        recall: null,
        f1: null
      },
      failures: forbiddenFindings.filter(finding => finding.status === 'FP')
    },
    deletionChecks: { summary: summarize(checkpointFindings), failures: checkpointFindings.filter(finding => finding.status !== 'TP') }
  };
}
