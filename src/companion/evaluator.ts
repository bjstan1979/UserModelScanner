import fs from 'node:fs';
import path from 'node:path';
import { FullCompanionSnapshot, MemoryOperation } from './schema.js';
import { runCompanionProbes, ProbeTestResult, CompanionResponder } from './probes.js';
import type { CompanionSession } from './engine.js';
import {
  COMPANION_ONTOLOGY_VERSION,
  layerVocabularyMatches,
  operationVocabularyMatches,
  predicateVocabularyMatches,
  subjectPatternMatches,
  validateOperationExpectationVocabulary
} from './ontology.js';
import { normalizedValueEntailed } from './semantic-provider.js';
import type { SourceSpan } from './ontology.js';

export type EvaluationStatus = 'TP' | 'FP' | 'FN' | 'TN' | 'NOT_EVALUATED';

export interface StructuredAssertion {
  assertionId: string;
  path: string;
  op: string;
  value?: unknown;
  values?: unknown[];
  clauses?: unknown[][];
  field?: string;
  where?: Record<string, unknown>;
  fieldAssertions?: Record<string, Omit<StructuredAssertion, 'assertionId' | 'path'>>;
  notEvaluatedReason?: string;
}

export interface ExpectedOperation {
  operationId: string;
  action: MemoryOperation['action'];
  layer: MemoryOperation['layer'];
  subject?: string;
  subjectPattern?: string;
  predicate: string;
  valueAssertion: Omit<StructuredAssertion, 'assertionId' | 'path'> & { messageId?: string };
  evidenceIdsAssertion: Omit<StructuredAssertion, 'assertionId' | 'path'>;
  relationAssertion?: { op: string; field: keyof MemoryOperation };
  scope?: string;
  temporalStatus?: string;
}

interface CanonicalGroundTruthItem {
  code: string;
  title: string;
  evidence?: string;
  assertions: StructuredAssertion[];
  forbiddenAssertions: StructuredAssertion[];
}

interface MessageGroundTruthItem {
  msg_id: string;
  expectedOperationCount: number;
  expectedOperations: ExpectedOperation[];
  forbiddenOperations: Array<{ actions?: MemoryOperation['action'][]; reason: string }>;
  finalStateAssertions: Array<{ gtId: string; assertionId: string }>;
}

interface ForbiddenGroundTruthItem {
  guardId: string;
  description: string;
  assertions: StructuredAssertion[];
}

interface GroundTruthFixture {
  version: string;
  ontologyVersion?: string;
  evaluationStatus: 'provisional' | 'final';
  metricPolicy: Record<string, string>;
  ignoredAtomicPaths: string[];
  canonical_state_items: CanonicalGroundTruthItem[];
  expected_snapshot: Record<string, unknown>;
  message_expectations: MessageGroundTruthItem[];
  forbidden_items: ForbiddenGroundTruthItem[];
}

export interface DetailedEvaluationResult {
  gtId: string;
  assertionId: string;
  expected: unknown;
  actual: unknown;
  status: EvaluationStatus;
  evidenceIds: string[];
  reason: string;
}

export interface MetricSummary {
  group_name: string;
  total_items: number;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  true_negatives: number;
  not_evaluated: number;
  precision: number | null;
  recall: number | null;
  f1_score: number | null;
  accuracy: number | null;
  specificity: number | null;
  false_positive_rate: number | null;
  violation_detection_rate: number | null;
}

export interface ComprehensiveCompanionEvaluationReport {
  evaluation_status: 'provisional' | 'final';
  ontology_contract_status: 'VALIDATED' | 'LEGACY_UNVALIDATED';
  overall_pass: boolean;
  total_score: number | null;
  precision_score: number | null;
  recall_score: number | null;
  f1_score: number | null;
  canonical_summary: MetricSummary;
  message_expectations_summary: MetricSummary;
  message_final_state_summary: MetricSummary;
  unsupported_output_summary: MetricSummary;
  forbidden_summary: MetricSummary;
  combined_summary: MetricSummary;
  probe_results: ProbeTestResult[];
  probe_evaluation_kind: 'MOCK_UNIT' | 'REAL_INTEGRATION' | 'NOT_RUN';
  item_evaluations: DetailedEvaluationResult[];
  failed_items: DetailedEvaluationResult[];
  not_evaluated_items: DetailedEvaluationResult[];
  critical_failures: string[];
}

interface AssertionOutcome {
  passed: boolean;
  actual: unknown;
  reason: string;
}

interface Atom {
  path: string;
  value: string | number | boolean | null;
}

const ACTIVE_KEYS: Array<keyof FullCompanionSnapshot> = [
  'user_model',
  'relationship_model',
  'companion_identity',
  'episodic_memory',
  'current_context'
];

function activeSnapshot(snapshot: FullCompanionSnapshot): Record<string, unknown> {
  return Object.fromEntries(ACTIVE_KEYS.map(key => [key, snapshot[key]]));
}

function resolvePath(root: unknown, assertionPath: string): unknown {
  if (assertionPath === '$activeSnapshot') return root;
  let current: unknown = root;
  for (const part of assertionPath.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).sort().join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
    .join(',')}}`;
}

function includesValue(actual: unknown, expected: unknown): boolean {
  return String(actual ?? '').includes(String(expected ?? ''));
}

function evaluateInline(
  actual: unknown,
  assertion: Omit<StructuredAssertion, 'assertionId' | 'path'>,
  sourceText?: string,
  sourceSpans: SourceSpan[] = []
): AssertionOutcome {
  if ((assertion as StructuredAssertion).notEvaluatedReason) {
    return { passed: false, actual, reason: (assertion as StructuredAssertion).notEvaluatedReason! };
  }

  const values = assertion.values ?? [];
  switch (assertion.op) {
    case 'eq':
      return { passed: stable(actual) === stable(assertion.value), actual, reason: 'Exact value comparison' };
    case 'contains_all': {
      const missing = values.filter(value => !includesValue(actual, value));
      return { passed: missing.length === 0, actual, reason: missing.length ? `Missing values: ${missing.join(', ')}` : 'Contains every required value' };
    }
    case 'contains_any': {
      const passed = values.some(value => includesValue(actual, value));
      return { passed, actual, reason: passed ? 'Contains an allowed required value' : `Contains none of: ${values.join(', ')}` };
    }
    case 'not_contains': {
      const passed = !includesValue(actual, assertion.value);
      return { passed, actual, reason: passed ? 'Forbidden value absent' : `Forbidden value present: ${String(assertion.value)}` };
    }
    case 'not_contains_any': {
      const found = values.filter(value => includesValue(JSON.stringify(actual), value));
      return { passed: found.length === 0, actual, reason: found.length ? `Forbidden values present: ${found.join(', ')}` : 'Forbidden values absent' };
    }
    case 'regex': {
      const passed = new RegExp(String(assertion.value), 'u').test(String(actual ?? ''));
      return { passed, actual, reason: passed ? 'Regex matched' : 'Required regex did not match' };
    }
    case 'not_regex': {
      const passed = !new RegExp(String(assertion.value), 'u').test(String(actual ?? ''));
      return { passed, actual, reason: passed ? 'Forbidden regex absent' : 'Forbidden regex matched' };
    }
    case 'semantic_clauses': {
      const text = String(actual ?? '');
      const missing = (assertion.clauses ?? []).filter(clause => !clause.every(token => text.includes(String(token))));
      return { passed: missing.length === 0, actual, reason: missing.length ? `Missing semantic clauses: ${JSON.stringify(missing)}` : 'All semantic clauses satisfied' };
    }
    case 'ordered_contains': {
      const text = Array.isArray(actual) ? actual.map(String).join('\n') : String(actual ?? '');
      let cursor = -1;
      const missing: unknown[] = [];
      for (const value of values) {
        const next = text.indexOf(String(value), cursor + 1);
        if (next < 0) missing.push(value);
        else cursor = next;
      }
      return { passed: missing.length === 0, actual, reason: missing.length ? `Missing/out-of-order values: ${missing.join(', ')}` : 'Required values occur in order' };
    }
    case 'array_value_contains_all': {
      if (!Array.isArray(actual)) return { passed: false, actual, reason: 'Actual value is not an array' };
      const field = assertion.field ?? '';
      const passed = actual.some(item => {
        const candidate = item && typeof item === 'object' ? (item as Record<string, unknown>)[field] : item;
        return values.every(value => includesValue(candidate, value));
      });
      return { passed, actual, reason: passed ? 'Array contains a matching value' : `No array item contains all: ${values.join(', ')}` };
    }
    case 'array_object_match': {
      if (!Array.isArray(actual)) return { passed: false, actual, reason: 'Actual value is not an array' };
      const fieldAssertions = assertion.fieldAssertions ?? {};
      const where = assertion.where ?? {};
      const match = actual.find(item => {
        if (!item || typeof item !== 'object') return false;
        const object = item as Record<string, unknown>;
        const whereMatches = Object.entries(where).every(([field, expected]) => {
          if (expected && typeof expected === 'object' && 'op' in (expected as Record<string, unknown>)) {
            return evaluateInline(object[field], expected as Omit<StructuredAssertion, 'assertionId' | 'path'>).passed;
          }
          return stable(object[field]) === stable(expected);
        });
        return whereMatches && Object.entries(fieldAssertions).every(([field, fieldAssertion]) => evaluateInline(object[field], fieldAssertion).passed);
      });
      return { passed: Boolean(match), actual: match, reason: match ? 'Found matching array object' : 'No array object satisfies all field assertions' };
    }
    case 'array_object_forbidden': {
      if (!Array.isArray(actual)) return { passed: true, actual, reason: 'No array means no forbidden object' };
      const where = assertion.where ?? {};
      const match = actual.find(item => {
        if (!item || typeof item !== 'object') return false;
        const object = item as Record<string, unknown>;
        return Object.entries(where).every(([field, expected]) => {
          if (expected && typeof expected === 'object' && 'op' in (expected as Record<string, unknown>)) {
            return evaluateInline(object[field], expected as Omit<StructuredAssertion, 'assertionId' | 'path'>).passed;
          }
          return stable(object[field]) === stable(expected);
        });
      });
      return { passed: !match, actual: match, reason: match ? 'Forbidden array object found' : 'Forbidden array object absent' };
    }
    case 'exact_set': {
      const actualArray = Array.isArray(actual) ? actual : [];
      const passed = stable([...actualArray]) === stable(values);
      return { passed, actual, reason: passed ? 'Exact set matched' : `Expected exact set ${stable(values)}` };
    }
    case 'non_empty': {
      const passed = Array.isArray(actual) ? actual.length > 0 : actual !== undefined && actual !== null && actual !== '';
      return { passed, actual, reason: passed ? 'Required relation is present' : 'Required relation is missing' };
    }
    case 'source_supported': {
      if (!sourceText) return { passed: false, actual, reason: 'Source message was not found' };
      const relevantSpans = sourceSpans.filter(span => sourceText.slice(span.start, span.end) === span.text);
      if (relevantSpans.length > 0) {
        const evidence = sourceSpans.map(span => span.text).join(' ');
        const support = normalizedValueEntailed(actual, evidence);
        const passed = support.entailed;
        return {
          passed,
          actual,
          reason: passed
            ? 'Exact source spans entail normalized operation value'
            : `Source spans do not entail normalized fields: ${support.unsupported.join(', ')}`
        };
      }
      const object = actual && typeof actual === 'object' ? actual as Record<string, unknown> : undefined;
      const citedSource = object?.sourceText;
      if (typeof citedSource === 'string') {
        const normalized = object && 'normalized' in object ? object.normalized : citedSource;
        const exact = citedSource.length > 0 && sourceText.includes(citedSource);
        const support = normalizedValueEntailed(normalized, citedSource);
        return { passed: exact && support.entailed, actual, reason: exact && support.entailed ? 'Legacy source excerpt entails normalized value' : 'Legacy source grounding failed' };
      }
      if (typeof actual === 'string') {
        const passed = actual.length > 0 && sourceText.includes(actual);
        return { passed, actual, reason: passed ? 'Operation value is an exact source excerpt' : 'String value is not source-grounded' };
      }
      return { passed: false, actual, reason: 'Structured value lacks exact source-span provenance' };
    }
    default:
      return { passed: false, actual, reason: `Unsupported assertion operator: ${assertion.op}` };
  }
}

function evaluateAssertion(root: Record<string, unknown>, assertion: StructuredAssertion): AssertionOutcome {
  const actual = resolvePath(root, assertion.path);
  return evaluateInline(actual, assertion);
}

function assertionExpected(assertion: StructuredAssertion | Omit<StructuredAssertion, 'assertionId' | 'path'>): unknown {
  return assertion.value ?? assertion.values ?? assertion.clauses ?? assertion.fieldAssertions ?? assertion.where ?? assertion.op;
}

function flattenAtoms(value: unknown, pathPrefix = ''): Atom[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== 'object') return [{ path: pathPrefix, value: value as Atom['value'] }];
  if (Array.isArray(value)) return value.flatMap(item => flattenAtoms(item, `${pathPrefix}[]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => flattenAtoms(child, pathPrefix ? `${pathPrefix}.${key}` : key));
}

function ignoredPath(pathValue: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    if (pattern.startsWith('**.')) return pathValue.endsWith(pattern.slice(2));
    return pathValue === pattern;
  });
}

function countStatuses(results: DetailedEvaluationResult[], groupName: string, negativeOnly = false): MetricSummary {
  const count = (status: EvaluationStatus) => results.filter(result => result.status === status).length;
  const tp = count('TP');
  const fp = count('FP');
  const fn = count('FN');
  const tn = count('TN');
  const notEvaluated = count('NOT_EVALUATED');
  const divide = (numerator: number, denominator: number): number | null => denominator === 0 ? null : numerator / denominator;
  const precision = negativeOnly ? null : divide(tp, tp + fp);
  const recall = negativeOnly ? null : divide(tp, tp + fn);
  const f1 = negativeOnly || precision === null || recall === null || precision + recall === 0 ? null : 2 * precision * recall / (precision + recall);
  return {
    group_name: groupName,
    total_items: results.length,
    true_positives: tp,
    false_positives: fp,
    false_negatives: fn,
    true_negatives: tn,
    not_evaluated: notEvaluated,
    precision,
    recall,
    f1_score: f1,
    accuracy: divide(tp + tn, tp + fp + fn + tn),
    specificity: divide(tn, tn + fp),
    false_positive_rate: divide(fp, fp + tn),
    violation_detection_rate: null
  };
}

function validateFixture(value: unknown): GroundTruthFixture {
  if (!value || typeof value !== 'object') throw new Error('Ground Truth fixture must be an object');
  const fixture = value as GroundTruthFixture;
  if (!fixture.version?.includes('structured')) throw new Error('Ground Truth fixture must use a structured version');
  if (fixture.version.includes('ontology') && fixture.ontologyVersion === undefined) {
    throw new Error('Ground Truth claiming ontology evaluation must declare ontologyVersion');
  }
  for (const [name, items] of [
    ['canonical_state_items', fixture.canonical_state_items],
    ['message_expectations', fixture.message_expectations],
    ['forbidden_items', fixture.forbidden_items]
  ] as const) {
    if (!Array.isArray(items) || items.length === 0) throw new Error(`Ground Truth ${name} must be a non-empty array`);
  }
  for (const item of fixture.canonical_state_items) {
    if (!Array.isArray(item.assertions) || item.assertions.length === 0) throw new Error(`Canonical item ${item.code} has no structured assertions`);
  }
  for (const item of fixture.message_expectations) {
    if (!Array.isArray(item.expectedOperations) || item.expectedOperationCount !== item.expectedOperations.length) {
      throw new Error(`Message ${item.msg_id} operation count does not match structured expectations`);
    }
  }
  if (fixture.ontologyVersion !== undefined) {
    if (fixture.ontologyVersion !== COMPANION_ONTOLOGY_VERSION) {
      throw new Error(`Ground Truth ontology version ${fixture.ontologyVersion} is not ${COMPANION_ONTOLOGY_VERSION}`);
    }
    for (const item of fixture.message_expectations) {
      for (const expected of item.expectedOperations) {
        if (!expected.subjectPattern) throw new Error(`Message ${item.msg_id}/${expected.operationId} requires subjectPattern under ${COMPANION_ONTOLOGY_VERSION}`);
        const invalid = validateOperationExpectationVocabulary({
          action: expected.action,
          layer: expected.layer,
          subjectPattern: expected.subjectPattern,
          predicate: expected.predicate,
          scope: expected.scope ?? '',
          temporalStatus: expected.temporalStatus ?? ''
        });
        if (invalid.length) throw new Error(`Invalid Ground Truth ontology vocabulary at ${item.msg_id}/${expected.operationId}: ${invalid.join(', ')}`);
      }
    }
  }
  return fixture;
}

export class CompanionBenchmarkEvaluator {
  private readonly groundTruth: GroundTruthFixture;

  constructor(fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'companion-ground-truth.json')) {
    if (!fs.existsSync(fixturePath)) throw new Error(`Ground Truth fixture not found at: ${fixturePath}`);
    this.groundTruth = validateFixture(JSON.parse(fs.readFileSync(fixturePath, 'utf-8')));
  }

  public async evaluateSnapshot(
    snapshot: FullCompanionSnapshot,
    sessions: CompanionSession[],
    responder?: CompanionResponder | null,
    probeKind: 'MOCK_UNIT' | 'REAL_INTEGRATION' = 'REAL_INTEGRATION'
  ): Promise<ComprehensiveCompanionEvaluationReport> {
    const root = activeSnapshot(snapshot);
    const messageMap = new Map(sessions.flatMap(session => session.messages.map(message => [message.id, message] as const)));
    const canonicalResults: DetailedEvaluationResult[] = [];
    const assertionIndex = new Map<string, { item: CanonicalGroundTruthItem; assertion: StructuredAssertion }>();

    for (const item of this.groundTruth.canonical_state_items) {
      for (const assertion of [...item.assertions, ...item.forbiddenAssertions]) {
        assertionIndex.set(`${item.code}/${assertion.assertionId}`, { item, assertion });
        if (assertion.notEvaluatedReason) {
          canonicalResults.push({
            gtId: item.code,
            assertionId: assertion.assertionId,
            expected: assertionExpected(assertion),
            actual: resolvePath(root, assertion.path),
            status: 'NOT_EVALUATED',
            evidenceIds: item.evidence?.match(/[A-Z]\d+-[A-Z]\d+/g) ?? [],
            reason: assertion.notEvaluatedReason
          });
          continue;
        }
        const outcome = evaluateAssertion(root, assertion);
        const forbidden = item.forbiddenAssertions.includes(assertion);
        canonicalResults.push({
          gtId: item.code,
          assertionId: assertion.assertionId,
          expected: assertionExpected(assertion),
          actual: outcome.actual,
          status: outcome.passed ? (forbidden ? 'TN' : 'TP') : (forbidden ? 'FP' : 'FN'),
          evidenceIds: item.evidence?.match(/[A-Z]\d+-[A-Z]\d+/g) ?? [],
          reason: outcome.reason
        });
      }
    }

    const messageOperationResults: DetailedEvaluationResult[] = [];
    const messageFinalStateResults: DetailedEvaluationResult[] = [];
    for (const item of this.groundTruth.message_expectations) {
      const message = messageMap.get(item.msg_id);
      const sourceText = message?.content;
      const actualOperations = snapshot.operations_log.filter(operation => operation.evidenceIds.includes(item.msg_id));
      const unmatched = new Set(actualOperations.map((_, index) => index));

      for (const expectedOperation of item.expectedOperations) {
        let matchIndex = -1;
        let mismatchReasons: string[] = [];
        for (const index of unmatched) {
          const operation = actualOperations[index];
          if (!operationVocabularyMatches(operation, {
            action: expectedOperation.action,
            layer: expectedOperation.layer,
            scope: expectedOperation.scope ?? String(operation.scope ?? ''),
            temporalStatus: expectedOperation.temporalStatus ?? String(operation.temporal_status ?? '')
          }) || !subjectPatternMatches(operation.subject, expectedOperation.subjectPattern ?? expectedOperation.subject ?? '') || !predicateVocabularyMatches(operation.predicate, expectedOperation.predicate)) continue;
          const valueOutcome = evaluateInline(operation.value, expectedOperation.valueAssertion, sourceText, operation.sourceSpans ?? []);
          const evidenceOutcome = evaluateInline(operation.evidenceIds, expectedOperation.evidenceIdsAssertion);
          const relationOutcome = expectedOperation.relationAssertion
            ? evaluateInline(operation[expectedOperation.relationAssertion.field], { op: expectedOperation.relationAssertion.op })
            : { passed: true, actual: undefined, reason: '' };
          mismatchReasons = [valueOutcome, evidenceOutcome, relationOutcome].filter(outcome => !outcome.passed).map(outcome => outcome.reason);
          if (mismatchReasons.length === 0) {
            matchIndex = index;
            break;
          }
        }

        if (matchIndex >= 0) unmatched.delete(matchIndex);
        messageOperationResults.push({
          gtId: item.msg_id,
          assertionId: expectedOperation.operationId,
          expected: expectedOperation,
          actual: matchIndex >= 0 ? actualOperations[matchIndex] : actualOperations,
          status: matchIndex >= 0 ? 'TP' : 'FN',
          evidenceIds: [item.msg_id],
          reason: matchIndex >= 0 ? 'Found one unique operation satisfying complete semantics' : `No operation satisfied action/layer/subject/predicate/value/provenance/relations${mismatchReasons.length ? `: ${mismatchReasons.join('; ')}` : ''}`
        });
      }

      for (const index of unmatched) {
        const operation = actualOperations[index];
        messageOperationResults.push({
          gtId: item.msg_id,
          assertionId: `unexpected-operation-${index + 1}`,
          expected: `Exactly ${item.expectedOperationCount} operations and no extras`,
          actual: operation,
          status: 'FP',
          evidenceIds: operation.evidenceIds,
          reason: 'Unexpected extra operation; one correct operation cannot mask additional output'
        });
      }

      for (const reference of item.finalStateAssertions) {
        const indexed = assertionIndex.get(`${reference.gtId}/${reference.assertionId}`);
        if (!indexed) {
          messageFinalStateResults.push({
            gtId: item.msg_id,
            assertionId: `final/${reference.gtId}/${reference.assertionId}`,
            expected: reference,
            actual: undefined,
            status: 'NOT_EVALUATED',
            evidenceIds: [item.msg_id],
            reason: 'Referenced canonical assertion does not exist'
          });
          continue;
        }
        const outcome = evaluateAssertion(root, indexed.assertion);
        messageFinalStateResults.push({
          gtId: item.msg_id,
          assertionId: `final/${reference.gtId}/${reference.assertionId}`,
          expected: assertionExpected(indexed.assertion),
          actual: outcome.actual,
          status: outcome.passed ? 'TP' : 'FN',
          evidenceIds: [item.msg_id],
          reason: `Final snapshot effect: ${outcome.reason}`
        });
      }
    }

    const actualAtoms = flattenAtoms(root).filter(atom => !ignoredPath(atom.path, this.groundTruth.ignoredAtomicPaths));
    const expectedAtoms = flattenAtoms(this.groundTruth.expected_snapshot).filter(atom => !ignoredPath(atom.path, this.groundTruth.ignoredAtomicPaths));
    const expectedPool = expectedAtoms.map((atom, index) => ({ atom, index, matched: false }));
    const unsupportedResults: DetailedEvaluationResult[] = [];

    actualAtoms.forEach((atom, actualIndex) => {
      const match = expectedPool.find(candidate => !candidate.matched && candidate.atom.path === atom.path && stable(candidate.atom.value) === stable(atom.value));
      if (match) {
        match.matched = true;
        unsupportedResults.push({
          gtId: 'SNAPSHOT-ATOMS',
          assertionId: `actual-${actualIndex + 1}`,
          expected: match.atom,
          actual: atom,
          status: 'TP',
          evidenceIds: [],
          reason: 'Produced atom is explicitly supported by structured Ground Truth snapshot'
        });
      } else {
        unsupportedResults.push({
          gtId: 'SNAPSHOT-ATOMS',
          assertionId: `unexpected-${actualIndex + 1}`,
          expected: 'No unsupported atom',
          actual: atom,
          status: 'FP',
          evidenceIds: [],
          reason: 'Produced snapshot atom has no exact Ground Truth support'
        });
      }
    });
    expectedPool.filter(candidate => !candidate.matched).forEach(candidate => unsupportedResults.push({
      gtId: 'SNAPSHOT-ATOMS',
      assertionId: `missing-${candidate.index + 1}`,
      expected: candidate.atom,
      actual: undefined,
      status: 'FN',
      evidenceIds: [],
      reason: 'Ground Truth atomic fact is missing from the produced snapshot'
    }));
    const expectedFactSpecs = this.groundTruth.message_expectations.flatMap(item =>
      item.expectedOperations.map(expected => ({ messageId: item.msg_id, expected }))
    );
    const supportedFactIds = new Set<string>();
    for (const fact of snapshot.fact_store ?? []) {
      const expectation = expectedFactSpecs.find(spec =>
        fact.evidenceIds.includes(spec.messageId)
        && layerVocabularyMatches(fact.layer, spec.expected.layer)
        && subjectPatternMatches(fact.subject, spec.expected.subjectPattern ?? spec.expected.subject ?? '')
        && predicateVocabularyMatches(fact.predicate, spec.expected.predicate)
      );
      const spansExact = fact.sourceSpans.length > 0 && fact.sourceSpans.every(span => {
        const message = messageMap.get(span.messageId)?.content;
        return message !== undefined && message.slice(span.start, span.end) === span.text;
      });
      const support = normalizedValueEntailed(fact.value, fact.sourceSpans.map(span => span.text).join(' '));
      const passed = Boolean(expectation) && spansExact && support.entailed;
      if (passed) supportedFactIds.add(fact.factId);
      unsupportedResults.push({
        gtId: 'FACT-STORE',
        assertionId: fact.factId,
        expected: expectation?.expected ?? 'A structured Ground Truth operation supporting this fact',
        actual: fact,
        status: passed ? 'TP' : 'FP',
        evidenceIds: fact.evidenceIds,
        reason: passed
          ? 'Logical fact matches ontology Ground Truth and exact source spans entail its value'
          : !expectation
            ? 'No ontology Ground Truth operation supports this logical fact'
            : !spansExact
              ? 'Logical fact source span is not an exact excerpt'
              : `Logical fact normalization is not entailed: ${support.unsupported.join(', ')}`
      });
    }
    for (const entity of snapshot.entities ?? []) {
      const supportingFacts = (snapshot.fact_store ?? []).filter(fact => fact.entityIds.includes(entity.entityId));
      const passed = supportingFacts.length > 0 && supportingFacts.every(fact => supportedFactIds.has(fact.factId));
      unsupportedResults.push({
        gtId: 'ENTITY-REGISTRY',
        assertionId: entity.entityId,
        expected: 'Entity linked only from supported logical facts',
        actual: entity,
        status: passed ? 'TP' : 'FP',
        evidenceIds: entity.evidenceIds,
        reason: passed ? 'Entity identity is grounded in supported facts' : 'Entity has no fully supported ontology fact'
      });
    }
    if (snapshot.ontology_version !== undefined) {
      const passed = snapshot.ontology_version === 'companion-memory/v1';
      unsupportedResults.push({
        gtId: 'ONTOLOGY-CONTRACT',
        assertionId: 'version',
        expected: 'companion-memory/v1',
        actual: snapshot.ontology_version,
        status: passed ? 'TP' : 'FP',
        evidenceIds: [],
        reason: passed ? 'Snapshot declares the evaluated ontology contract' : 'Unknown ontology contract version'
      });
    }

    const forbiddenResults: DetailedEvaluationResult[] = [];
    for (const guard of this.groundTruth.forbidden_items) {
      for (const assertion of guard.assertions) {
        if (assertion.notEvaluatedReason) {
          forbiddenResults.push({ gtId: guard.guardId, assertionId: assertion.assertionId, expected: assertionExpected(assertion), actual: resolvePath(root, assertion.path), status: 'NOT_EVALUATED', evidenceIds: [], reason: assertion.notEvaluatedReason });
          continue;
        }
        const outcome = evaluateAssertion(root, assertion);
        forbiddenResults.push({
          gtId: guard.guardId,
          assertionId: assertion.assertionId,
          expected: assertionExpected(assertion),
          actual: outcome.actual,
          status: outcome.passed ? 'TN' : 'FP',
          evidenceIds: [],
          reason: outcome.reason
        });
      }
    }

    const probeResults = await runCompanionProbes(snapshot, responder);
    const actualProbeKind = responder ? probeKind : 'NOT_RUN';
    const canonicalMetricResults = [...canonicalResults, ...unsupportedResults.filter(result => result.status === 'FP')];
    const canonicalSummary = countStatuses(canonicalMetricResults, 'Canonical Atomic Facts + Unsupported Output FP');
    const messageSummary = countStatuses(messageOperationResults, 'Message Operation Assertions');
    const messageFinalStateSummary = countStatuses(messageFinalStateResults, 'Message Final-State Assertions');
    const unsupportedSummary = countStatuses(unsupportedResults, 'Unsupported Snapshot Output');
    const forbiddenSummary = countStatuses(forbiddenResults, 'Forbidden Guards', true);
    const combinedResults = [...canonicalResults, ...messageOperationResults, ...messageFinalStateResults, ...unsupportedResults, ...forbiddenResults];
    const combinedSummary = countStatuses(combinedResults, 'Combined Structured Evaluation');
    const failedItems = combinedResults.filter(result => result.status === 'FP' || result.status === 'FN');
    const notEvaluatedItems = combinedResults.filter(result => result.status === 'NOT_EVALUATED');
    const criticalFailures = forbiddenResults.filter(result => result.status === 'FP').map(result => `${result.gtId}/${result.assertionId}: ${result.reason}`);
    const probeFailures = probeResults.filter(result => result.status === 'FAILED');
    const overallPass = failedItems.length === 0 && notEvaluatedItems.length === 0 && criticalFailures.length === 0 && probeFailures.length === 0 && actualProbeKind === 'REAL_INTEGRATION';

    return {
      evaluation_status: this.groundTruth.evaluationStatus,
      ontology_contract_status: this.groundTruth.ontologyVersion ? 'VALIDATED' : 'LEGACY_UNVALIDATED',
      overall_pass: overallPass,
      total_score: combinedSummary.accuracy === null ? null : combinedSummary.accuracy * 100,
      precision_score: combinedSummary.precision,
      recall_score: combinedSummary.recall,
      f1_score: combinedSummary.f1_score,
      canonical_summary: canonicalSummary,
      message_expectations_summary: messageSummary,
      message_final_state_summary: messageFinalStateSummary,
      unsupported_output_summary: unsupportedSummary,
      forbidden_summary: forbiddenSummary,
      combined_summary: combinedSummary,
      probe_results: probeResults,
      probe_evaluation_kind: actualProbeKind,
      item_evaluations: combinedResults,
      failed_items: failedItems,
      not_evaluated_items: notEvaluatedItems,
      critical_failures: criticalFailures
    };
  }
}

export { CompanionBenchmarkEvaluator as IndependentCompanionEvaluator };
