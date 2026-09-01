import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BlindV2Fixture, evaluateBlindV2 } from './helpers/blind-holdout-evaluator.js';

const FROZEN_COMMIT = '04ab5777d358a4df55858d9a2def7119c87dc594';

for (const fixtureId of ['blind-holdout-v2', 'blind-holdout-v2b']) {
  test(`${fixtureId} is rejected before scoring under the current ontology contract`, async () => {
    const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', `${fixtureId}.json`);
    const fixture: BlindV2Fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    assert.equal(fixture.metadata.createdAfterEngineCommit, FROZEN_COMMIT);
    assert.equal(fixture.metadata.engineMutableAfterCreation, false);
    assert.equal(fixture.metadata.authorDidNotInspectEngine, true);
    assert.equal(fixture.metadata.status, `post-freeze-${fixtureId.replace('holdout-', '')}`);
    assert.equal(fixture.metadata.ontologyVersion, 'companion-memory/v1');


    const userMessageIds = new Set(fixture.sessions.flatMap(session => session.messages.filter(message => message.role === 'user').map(message => message.id)));
    assert.deepEqual(new Set(fixture.messageExpectations.map(expectation => expectation.messageId)), userMessageIds);
    assert.equal(fixture.messageExpectations.reduce((sum, item) => sum + item.expectedOperations.length, 0), fixture.metadata.expectedOperationCount);
    assert.equal(fixture.finalStateAssertions.length, fixture.metadata.finalStateAssertionCount);
    assert.equal(fixture.forbiddenSnapshotAssertions.length, fixture.metadata.forbiddenSnapshotAssertionCount);
    assert.equal(fixture.deletionChecks.length, fixture.metadata.deletionCheckCount);

    if (fixtureId === 'blind-holdout-v2' || fixtureId === 'blind-holdout-v2b') {
      await assert.rejects(evaluateBlindV2(fixture), /INVALID_EVALUATION: ontology contract violations/);
      console.log(`BLIND_V2_INVALID ${JSON.stringify({ fixtureId, reason: 'ontology contract violations; metrics suppressed' })}`);
      return;
    }

    const report = await evaluateBlindV2(fixture);
    assert.equal(report.status, 'provisional');
    assert.equal(report.forbiddenGuards.summary.total, fixture.forbiddenSnapshotAssertions.length);
    assert.equal(report.forbiddenGuards.summary.precision, null);
    assert.equal(report.forbiddenGuards.summary.recall, null);
    assert.equal(report.forbiddenGuards.summary.f1, null);

    const resultPath = path.join(process.cwd(), 'tests', 'fixtures', `${fixtureId}-result.json`);
    const serializable = JSON.parse(JSON.stringify(report));
    if (process.env.UPDATE_BLIND_V2_RESULT === '1') {
      fs.writeFileSync(resultPath, `${JSON.stringify(serializable, null, 2)}\n`);
    } else {
      const recorded = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      assert.deepEqual(serializable, recorded, 'Frozen blind result must not drift');
    }

    console.log(`BLIND_V2_SUMMARY ${JSON.stringify({
      fixtureId,
      status: report.status,
      engineCommit: report.engineCommit,
      finalState: report.finalState.summary,
      messageOperations: report.messageOperations.summary,
      forbiddenGuards: report.forbiddenGuards.summary,
      deletionChecks: report.deletionChecks.summary,
      result: path.relative(process.cwd(), resultPath)
    })}`);
  });
}
