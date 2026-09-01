import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CompanionScannerEngine, CompanionSession } from '../src/companion/engine.js';
import { CompanionBenchmarkEvaluator } from '../src/companion/evaluator.js';
import { loadMiniMaxResponderConfig, MiniMaxCompanionResponder } from '../src/companion/minimax-responder.js';

const FROZEN_ENGINE_COMMIT = '04ab5777d358a4df55858d9a2def7119c87dc594';

test('real MiniMax companion probes execute against the generated snapshot', async () => {
  const config = loadMiniMaxResponderConfig();
  assert.ok(config, 'MiniMax real-probe configuration is required');
  assert.match(config.model, /MiniMax-M3/i, 'Real probes must use MiniMax-M3');

  const sessions: CompanionSession[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'companion_sessions.json'), 'utf8'));
  const snapshot = new CompanionScannerEngine().scanCompanionDataset(sessions);
  const responder = new MiniMaxCompanionResponder(config);
  const report = await new CompanionBenchmarkEvaluator().evaluateSnapshot(snapshot, sessions, responder, 'REAL_INTEGRATION');

  assert.equal(report.probe_evaluation_kind, 'REAL_INTEGRATION');
  assert.equal(report.probe_results.length, 8);
  assert.ok(report.probe_results.every(result => result.status !== 'NOT_RUN'));
  assert.ok(report.probe_results.every(result => !result.violations.some(violation => violation.startsWith('RESPONDER_EXECUTION_ERROR'))), 'Every real API request must complete');

  const artifact = {
    evaluation_status: 'provisional',
    generated_at: new Date().toISOString(),
    frozen_engine_commit: FROZEN_ENGINE_COMMIT,
    responder: responder.name,
    probe_evaluation_kind: report.probe_evaluation_kind,
    probe_summary: {
      total: report.probe_results.length,
      passed: report.probe_results.filter(result => result.status === 'PASSED').length,
      failed: report.probe_results.filter(result => result.status === 'FAILED').length,
      not_run: report.probe_results.filter(result => result.status === 'NOT_RUN').length
    },
    overall_pass: report.overall_pass,
    canonical_summary: report.canonical_summary,
    message_operations_summary: report.message_expectations_summary,
    message_final_state_summary: report.message_final_state_summary,
    unsupported_output_summary: report.unsupported_output_summary,
    forbidden_summary: report.forbidden_summary,
    combined_summary: report.combined_summary,
    probe_results: report.probe_results,
    disclosure: 'Real MiniMax-M3 responses were executed. Metrics remain provisional; probe success does not erase extraction/evaluation failures.'
  };
  const outputPath = path.join(process.cwd(), 'reports', 'companion-evaluation-real-probe.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`REAL_PROBE_SUMMARY ${JSON.stringify(artifact.probe_summary)} provider=${artifact.responder} report=${path.relative(process.cwd(), outputPath)}`);
});
