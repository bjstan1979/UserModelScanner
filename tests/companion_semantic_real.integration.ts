import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CompanionScannerEngine } from '../src/companion/engine.js';
import { loadMiniMaxResponderConfig, requestMiniMaxChat } from '../src/companion/minimax-responder.js';
import { MiniMaxCompanionSemanticProvider } from '../src/companion/minimax-semantic-provider.js';
import { HybridCompanionSemanticProvider } from '../src/companion/hybrid-semantic-provider.js';
import {
  type BlindV2Fixture,
  evaluateBlindV2,
  normalizeSessions,
  validateBlindV2Ontology
} from './helpers/blind-holdout-evaluator.js';

const PROVIDER_FREEZE_COMMIT = '4e97347e0776cf5bc61bb273e79ab099d7ce3982';
const PROVIDER_BASE_COMMIT = '4dd40d4c20701f3e3475ee1ab15b67d28510a3a3';
const DEFAULT_FIXTURE_SHA256 = '8178f68fbc24941aea7dc702b5e1d6a8f06b9d148e366c06680bbcb8102eb67e';
const CANONICALIZER_FREEZE_COMMIT = '31a6bc74580cceb4cb3b04badafe1dddde6a579c';
const FROZEN_PATHS = [
  'src/companion/minimax-semantic-provider.ts',
  'src/companion/minimax-responder.ts',
  'src/companion/engine.ts',
  'src/companion/resolver.ts',
  'src/companion/reducer.ts'
];
const CANONICAL_PATHS = [
  'src/companion/canonicalizer.ts',
  'src/companion/hybrid-semantic-provider.ts',
  'src/companion/engine.ts',
  'src/companion/resolver.ts',
  'src/companion/reducer.ts',
  'src/companion/minimax-semantic-provider.ts'
];
const PIPELINE = process.env.COMPANION_PIPELINE === 'hybrid' ? 'hybrid' : 'semantic';
const BLIND = process.env.COMPANION_BLIND === '1';
const FIXTURE_LABEL = path.basename(process.env.COMPANION_FIXTURE ?? 'blind-holdout-v3c.json', '.json');

function diffStats(paths: string[]): { source_insertions: number; source_deletions: number; net_source_lines: number; source_files: number } {
  const output = execFileSync('git', ['diff', '--numstat', 'HEAD', '--', ...paths], { cwd: process.cwd(), encoding: 'utf8' }).trim();
  const rows = output ? output.split('\n').map(row => row.split('\t')) : [];
  const sourceInsertions = rows.reduce((sum, [insertions]) => sum + Number(insertions || 0), 0);
  const sourceDeletions = rows.reduce((sum, [, deletions]) => sum + Number(deletions || 0), 0);
  return {
    source_insertions: sourceInsertions,
    source_deletions: sourceDeletions,
    net_source_lines: sourceInsertions - sourceDeletions,
    source_files: rows.length
  };
}
test(`real ${PIPELINE} provider runs ${FIXTURE_LABEL} A/B`, { timeout: 1_800_000 }, async () => {
  const fixturePath = path.resolve(process.cwd(), process.env.COMPANION_FIXTURE ?? 'tests/fixtures/blind-holdout-v3c.json');
  const fixtureText = fs.readFileSync(fixturePath, 'utf8');
  const expectedFixtureHash = process.env.COMPANION_FIXTURE_SHA256 ?? DEFAULT_FIXTURE_SHA256;
  assert.equal(crypto.createHash('sha256').update(fixtureText).digest('hex'), expectedFixtureHash);
  const fixture: BlindV2Fixture = JSON.parse(fixtureText);
  validateBlindV2Ontology(fixture);
  assert.equal(fixture.metadata.engineMutableAfterCreation, false);
  assert.equal(fixture.metadata.authorDidNotInspectEngine, true);
  if (BLIND) assert.equal(fixture.metadata.canonicalizerFreezeCommit, CANONICALIZER_FREEZE_COMMIT);
  if (PIPELINE === 'semantic') {
    for (const args of [
      ['diff', `${PROVIDER_FREEZE_COMMIT}..HEAD`, '--', ...FROZEN_PATHS],
      ['diff', '--', ...FROZEN_PATHS],
      ['diff', '--cached', '--', ...FROZEN_PATHS]
    ]) {
      assert.equal(execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }), '', 'Frozen semantic provider or Engine changed after blind-v3');
    }
  }
  if (BLIND) {
    for (const args of [
      ['diff', `${CANONICALIZER_FREEZE_COMMIT}..HEAD`, '--', ...CANONICAL_PATHS],
      ['diff', '--', ...CANONICAL_PATHS],
      ['diff', '--cached', '--', ...CANONICAL_PATHS]
    ]) {
      assert.equal(execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }), '', 'Canonical pipeline changed after blind fixture creation');
    }
  }

  const config = loadMiniMaxResponderConfig(process.env.COMPANION_MODEL_CONFIG);
  assert.ok(config, 'OpenAI-compatible credentials are required for the real semantic A/B');
  if (PIPELINE === 'semantic') assert.match(config.model, /MiniMax-M3/i);

  let transportAttempts = 0;
  let transportRetries = 0;
  const retryingRequest: typeof requestMiniMaxChat = async (requestConfig, messages, options) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      transportAttempts += 1;
      try {
        const raw = await requestMiniMaxChat(requestConfig, messages, options);
        const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        JSON.parse(unfenced.slice(unfenced.indexOf('{'), unfenced.lastIndexOf('}') + 1));
        return raw;
      } catch (error) {
        lastError = error;
        if (attempt < 2) transportRetries += 1;
      }
    }
    throw lastError;
  };

  const baseline = await evaluateBlindV2(fixture);
  const sessions = normalizeSessions(fixture);
  const semanticProvider = new MiniMaxCompanionSemanticProvider(config, retryingRequest);
  // Discovery is prefetched through tool calls; decisions run with the actual prior operation shortlist.
  await semanticProvider.prefetch(sessions, 4);
  const provider = PIPELINE === 'hybrid'
    ? new HybridCompanionSemanticProvider(semanticProvider)
    : semanticProvider;
  const engine = new CompanionScannerEngine(provider);
  const semantic = await evaluateBlindV2(fixture, input => engine.scanCompanionDatasetAsync(input));
  const report = {
    evaluation_status: BLIND ? 'provisional' : PIPELINE === 'hybrid' ? 'posthoc_regression' : 'provisional',
    predecessor_evaluation: BLIND ? 'post-canonical independent holdout' : 'blind-holdout-v3 and v3b invalid_evaluation',
    evaluation_kind: BLIND ? 'CANONICAL_BLIND_INTEGRATION' : PIPELINE === 'hybrid' ? 'HYBRID_REGRESSION' : 'REAL_INTEGRATION',
    model: config.model,
    provider: provider.name,
    fixture: path.relative(process.cwd(), fixturePath),
    fixture_sha256: expectedFixtureHash,
    baseline_engine_commit: fixture.metadata.createdAfterEngineCommit,
    semantic_provider_commit: PROVIDER_FREEZE_COMMIT,
    semantic_provider_base_commit: !BLIND ? PROVIDER_BASE_COMMIT : undefined,
    evaluated_head_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim(),
    evaluated_worktree_dirty: Boolean(execFileSync('git', ['status', '--porcelain', '--', 'src/companion', 'tests/companion_semantic_real.integration.ts', 'tests/minimax_semantic_provider.test.ts'], { cwd: process.cwd(), encoding: 'utf8' }).trim()),
    canonicalizer_commit: PIPELINE === 'hybrid' ? CANONICALIZER_FREEZE_COMMIT : undefined,
    complexity_delta: diffStats(['src/companion']),
    test_delta: diffStats(['tests/companion_semantic_real.integration.ts', 'tests/minimax_semantic_provider.test.ts']),
    canonicalizer_delta: PIPELINE === 'hybrid' ? { source_insertions: 150, source_deletions: 8, net_source_lines: 142, test_lines: 103 } : undefined,
    transport: { attempts: transportAttempts, retries: transportRetries, max_attempts_per_message: 3 },
    baseline,
    semantic,
    comparison: {
      operation_tp_delta: semantic.messageOperations.summary.tp - baseline.messageOperations.summary.tp,
      operation_fp_delta: semantic.messageOperations.summary.fp - baseline.messageOperations.summary.fp,
      operation_f1_delta: (semantic.messageOperations.summary.f1 ?? 0) - (baseline.messageOperations.summary.f1 ?? 0),
      final_state_tp_delta: semantic.finalState.summary.tp - baseline.finalState.summary.tp,
      final_state_f1_delta: (semantic.finalState.summary.f1 ?? 0) - (baseline.finalState.summary.f1 ?? 0)
    }
  };
  const hasIndependentGain = report.comparison.operation_tp_delta > 0 && report.comparison.operation_f1_delta > 0;
  Object.assign(report, {
    evaluation_status: BLIND
      ? hasIndependentGain ? 'validated_independent_holdout' : 'no_independent_gain'
      : PIPELINE === 'hybrid'
        ? 'posthoc_regression'
        : hasIndependentGain ? 'validated_independent_holdout' : 'no_independent_gain',
    complexity_decision: BLIND
      ? hasIndependentGain ? 'KEEP_CANONICAL_PIPELINE' : 'REASSESS_CANONICAL_PIPELINE'
      : PIPELINE === 'hybrid'
        ? 'REQUIRES_NEW_BLIND_HOLDOUT'
        : hasIndependentGain ? 'KEEP_EXPERIMENTAL_OPT_IN_ONLY' : 'REMOVE_SEMANTIC_PROVIDER',
    accepted_for_production: false,
    production_decision: 'REJECT_PENDING_NEW_BLIND_HOLDOUT_AND_STABILITY_RUNS',
    default_mode: 'experimental auto semantic when configured; --provider rule is the offline escape hatch',
    caveats: [
      'The CLI auto mode may select the hybrid semantic provider when MiniMax is configured; deterministic rule mode remains the explicit offline escape hatch and the default for tests/CI.',
      `Forbidden-guard specificity changed from ${baseline.forbiddenGuards.summary.specificity} to ${semantic.forbiddenGuards.summary.specificity}.`,
      'This known-fixture post-hoc regression is development evidence only; it is not a fresh blind evaluation or a stability claim.'
    ]
  });
  const modelSlug = config.model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const fixtureSlug = path.basename(fixturePath, '.json').replace('blind-holdout-', '');
  const reportName = BLIND
    ? `companion-canonical-blind-${fixtureSlug}-${modelSlug}-ab.json`
    : PIPELINE === 'hybrid'
      ? `companion-hybrid-${fixtureSlug}-${modelSlug}-two-stage-regression.json`
      : 'companion-semantic-blind-v3c-ab.json';
  const reportPath = path.join(process.cwd(), 'reports', reportName);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  assert.ok(hasIndependentGain, 'semantic provider did not improve both operation TP and operation F1');
  console.log(`COMPANION_${PIPELINE.toUpperCase()}_${fixtureSlug.toUpperCase()}_AB ${JSON.stringify({ baseline: baseline.messageOperations.summary, semantic: semantic.messageOperations.summary, report: path.relative(process.cwd(), reportPath) })}`);
});
