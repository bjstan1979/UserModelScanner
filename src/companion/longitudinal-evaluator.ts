import type { LongitudinalCorpusManifest } from '../simulation/companion-longitudinal.js';
import { canonicalPredicate } from './ontology.js';
import type { FullCompanionSnapshot } from './schema.js';

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(strings);
  return [];
}
function comparable(value: string): string {
  return value.normalize('NFKC').replace(/我有点/g, '').replace(/[\s，,。；;：“”"'‘’]/g, '');
}

function valueMatches(actual: unknown, expected: string): boolean {
  const actualValues = strings(actual).map(comparable);
  const expectedValues = expected.split(':').map(comparable);
  return expectedValues.length > 1
    ? expectedValues.every(expectedValue => actualValues.some(value => value.includes(expectedValue)))
    : actualValues.some(value => value === expectedValues[0] || value.includes(expectedValues[0]));
}

function metrics(tp: number, fp: number, fn: number): Record<string, number | null> {
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 = precision === null || recall === null || precision + recall === 0 ? null : 2 * precision * recall / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}
export function evaluateLongitudinalCompanionCorpus(
  manifest: LongitudinalCorpusManifest,
  snapshots: ReadonlyMap<string, FullCompanionSnapshot>
): Record<string, unknown> {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let operationTp = 0;
  let operationFp = 0;
  let operationFn = 0;
  const attributionErrors: Array<{ userId: string; subject: string; value: unknown }> = [];
  const users = manifest.users.map(user => {
    const snapshot = snapshots.get(user.userId);
    const activeFacts = snapshot?.fact_store?.filter(fact => fact.active) ?? [];
    const matched = new Set<string>();
    let userTp = 0;

    for (const expected of user.finalActive) {
      const fact = activeFacts.find(candidate => {
        const predicate = canonicalPredicate(candidate.predicate) ?? candidate.predicate;
        return !matched.has(candidate.factId)
          && predicate === expected.predicate
          && valueMatches(candidate.value, expected.value);
      });
      if (fact) {
        matched.add(fact.factId);
        userTp += 1;
      }
    }

    const expectedLocation = user.finalActive.find(item => item.predicate === 'entity.current_location' && !item.value.includes(':'))?.value;
    for (const fact of activeFacts) {
      if ((canonicalPredicate(fact.predicate) ?? fact.predicate) !== 'entity.current_location') continue;
      if (!fact.subject.startsWith('profile.') || !expectedLocation) continue;
      if (!strings(fact.value).includes(expectedLocation)) attributionErrors.push({ userId: user.userId, subject: fact.subject, value: fact.value });
    }

    const userFp = activeFacts.length - matched.size;
    const userFn = user.finalActive.length - userTp;
    const operations = snapshot?.operations_log.filter(operation => operation.action !== 'REJECT') ?? [];
    const matchedOperations = new Set<number>();
    let userOperationTp = 0;
    for (const expected of user.events) {
      const index = operations.findIndex((operation, operationIndex) => {
        const entityNames = (operation.entityIds ?? []).flatMap(entityId => {
          const entity = snapshot?.entities?.find(item => item.entityId === entityId);
          return entity ? [entity.canonicalName, ...entity.aliases] : [];
        });
        return !matchedOperations.has(operationIndex)
          && operation.action === expected.action
          && (canonicalPredicate(operation.predicate) ?? operation.predicate) === expected.predicate
          && valueMatches([operation.value, ...entityNames], expected.value);
      });
      if (index >= 0) {
        matchedOperations.add(index);
        userOperationTp += 1;
      }
    }
    const userOperationFp = operations.length - matchedOperations.size;
    const userOperationFn = user.events.length - userOperationTp;
    tp += userTp;
    fp += userFp;
    fn += userFn;
    operationTp += userOperationTp;
    operationFp += userOperationFp;
    operationFn += userOperationFn;
    return {
      userId: user.userId,
      finalState: { expected: user.finalActive.length, actual: activeFacts.length, tp: userTp, fp: userFp, fn: userFn },
      operations: { expected: user.events.length, actual: operations.length, tp: userOperationTp, fp: userOperationFp, fn: userOperationFn }
    };
  });

  const summary = metrics(tp, fp, fn);
  const operationSummary = metrics(operationTp, operationFp, operationFn);
  return {
    evaluation_kind: 'LONGITUDINAL_SIMULATION_BASELINE',
    evaluation_status: 'development_simulation',
    corpus_version: manifest.version,
    users: manifest.users.length,
    sessions: manifest.generatedSessionCount,
    messages: manifest.generatedMessageCount,
    summary: { ...summary, attribution_errors: attributionErrors.length },
    operation_summary: operationSummary,
    per_user: users,
    attribution_errors: attributionErrors,
    accepted_for_production: false,
    caveat: 'Synthetic longitudinal evidence is a development baseline, not a fresh blind or real-user evaluation.'
  };
}
