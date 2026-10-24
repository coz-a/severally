import test from 'node:test';
import assert from 'node:assert/strict';
import * as evidence from '../src/compatibility-evidence.mjs';

test('evidence separates configured and launched values from unobserved effective values', () => {
  assert.equal(typeof evidence.compatibilityEvidence, 'function');
  const record = evidence.compatibilityEvidence({
    runner: 'doctor',
    consultant: { name: 'example', cli: 'codex', model: 'configured', effort: 'high' },
    cliVersion: 'codex 1.2.3',
    view: { job_id: 'job', status: 'completed', model: 'fallback', result: {} },
    checks: { read: { status: 'inconclusive', detail: 'control not quoted' } },
  });
  assert.equal(record.schema_version, 1);
  assert.equal(record.cli.version, 'codex 1.2.3');
  assert.equal(record.runtime.platform, process.platform);
  assert.equal(record.runtime.node, process.version);
  assert.deepEqual(record.configured, { model: 'configured', effort: 'high' });
  assert.equal(record.launched.model, 'fallback');
  assert.deepEqual(record.observed, { model: null, effort: null });
  assert.equal(record.checks.consultation.status, 'passed');
  assert.equal(record.checks.read.status, 'inconclusive');
  for (const key of ['forbidden_operations', 'followup', 'cancel']) assert.equal(record.checks[key].status, 'not_run');
});

test('effective values require an explicit observation with its source', () => {
  const record = evidence.compatibilityEvidence({
    runner: 'live-check',
    consultant: { name: 'example', cli: 'codex', model: 'configured', effort: null },
    observed: { model: { value: 'observed', source: 'CLI session event' } },
    checks: { cancel: { status: 'passed', detail: 'job is cancelled; descendants not checked' } },
  });
  assert.deepEqual(record.observed.model, { value: 'observed', source: 'CLI session event' });
  assert.equal(record.observed.effort, null);
  assert.equal(record.checks.consultation.status, 'not_run');
  assert.equal(record.checks.cancel.status, 'passed');
});
