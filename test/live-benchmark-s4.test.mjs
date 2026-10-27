import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

sandboxEnv({ STUB_BEHAVIOR: 'ok' });
const { JobManager } = await import('../src/jobs.mjs');
const { resumeS4 } = await import('../scripts/live-benchmark-s4.mjs');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-s4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.STUB_BRIEF_DIR = dir;
  t.after(() => {
    delete process.env.STUB_BRIEF_DIR;
  });
  const manager = new JobManager();
  const started = manager.start(reviewRequest());
  await manager.jobs.get(started.job_id).promise;
  const receiptPath = path.join(dir, 'receipt.json');
  const assessmentPath = path.join(dir, 'assessment.json');
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.stringify({ scenario: 'S4', followup_question: 'Recheck f1 against the recorded evidence.' });
  fs.writeFileSync(manifestPath, manifest);
  const receipt = {
    scenario: 'S4',
    outcome: 'awaiting_assessment',
    job_id: started.job_id,
    manifest_sha256: crypto.createHash('sha256').update(manifest).digest('hex'),
    followup_question_sha256: crypto.createHash('sha256').update('Recheck f1 against the recorded evidence.').digest('hex'),
    followup: null,
    adoption: null,
    scenario_assessment: null,
  };
  const assessment = {
    job_id: started.job_id,
    manifest_sha256: receipt.manifest_sha256,
    entries: [
      {
        id: 'f1',
        verdict: 'confirmed',
        method: 'replay test',
        result: 'reproduced',
        scope: 'test environment',
        adoption: 'revise',
      },
    ],
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  fs.writeFileSync(assessmentPath, JSON.stringify(assessment));
  return { dir, manager, receipt, receiptPath, assessment, assessmentPath, manifestPath };
}

test('S4 stores a real verification then follows up, without inferring adoption or overall success', async (t) => {
  const f = await fixture(t);
  const result = await resumeS4({
    receiptPath: f.receiptPath,
    assessmentPath: f.assessmentPath,
    manifestPath: f.manifestPath,
    manager: f.manager,
  });
  assert.equal(result.followup.status, 'completed');
  assert.equal(typeof result.followup.duration_ms, 'number');
  assert.equal(result.scenario_assessment, null);
  assert.equal(Object.hasOwn(result, 'followup_question'), false);
  assert.doesNotMatch(fs.readFileSync(f.receiptPath, 'utf8'), /Recheck f1 against the recorded evidence/);
  assert.deepEqual(result.adoption, { adopt: 0, revise: 1, reject: 0 });
  const recorded = f.manager.view(f.receipt.job_id, { detail: 'full' });
  assert.equal(recorded.record.entries[0].verdict, 'confirmed');
  const text = fs.readFileSync(path.join(f.dir, 'codex.txt'), 'utf8');
  assert.match(text, /replay test/);
  assert.match(text, /reproduced/);
});

test('S4 rejects an invalid point before starting a follow-up', async (t) => {
  const f = await fixture(t);
  f.assessment.entries[0].id = 'f999';
  fs.writeFileSync(f.assessmentPath, JSON.stringify(f.assessment));
  await assert.rejects(
    resumeS4({ receiptPath: f.receiptPath, assessmentPath: f.assessmentPath, manifestPath: f.manifestPath, manager: f.manager }),
  );
  assert.equal(f.manager.jobs.size, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.receiptPath, 'utf8')).outcome, 'awaiting_assessment');
});

test('S4 does not replay a follow-up whose submission may already have happened', async (t) => {
  const f = await fixture(t);
  f.receipt.outcome = 'followup_submission_uncertain';
  fs.writeFileSync(f.receiptPath, JSON.stringify(f.receipt));
  await assert.rejects(
    resumeS4({ receiptPath: f.receiptPath, assessmentPath: f.assessmentPath, manifestPath: f.manifestPath, manager: f.manager }),
    /reconcil|state/i,
  );
  assert.equal(f.manager.jobs.size, 1);
});

test('S4 refuses a follow-up question changed after the manifest was fixed', async (t) => {
  const f = await fixture(t);
  f.receipt.followup_question_sha256 = crypto.createHash('sha256').update('A different question').digest('hex');
  fs.writeFileSync(f.receiptPath, JSON.stringify(f.receipt));
  await assert.rejects(
    resumeS4({ receiptPath: f.receiptPath, assessmentPath: f.assessmentPath, manifestPath: f.manifestPath, manager: f.manager }),
    /manifest|question/i,
  );
  assert.equal(f.manager.jobs.size, 1);
});

test('S4 does not start a follow-up if verification could not be saved', async (t) => {
  const f = await fixture(t);
  f.manager.record = () => ({ error: 'record_not_saved' });
  await assert.rejects(
    resumeS4({ receiptPath: f.receiptPath, assessmentPath: f.assessmentPath, manifestPath: f.manifestPath, manager: f.manager }),
    /not saved/i,
  );
  assert.equal(f.manager.jobs.size, 1);
});

test('S4 does not use a verification record changed before readback', async (t) => {
  const f = await fixture(t);
  const view = f.manager.view.bind(f.manager);
  let reads = 0;
  f.manager.view = (...args) => {
    const result = view(...args);
    reads++;
    if (reads === 2 && result?.record?.entries[0]) result.record.entries[0].verdict = 'refuted';
    return result;
  };
  await assert.rejects(
    resumeS4({ receiptPath: f.receiptPath, assessmentPath: f.assessmentPath, manifestPath: f.manifestPath, manager: f.manager }),
    /record.*(changed|match)/i,
  );
  assert.equal(f.manager.jobs.size, 1);
});

test('S4 retains a failed follow-up and does not infer scenario success', async (t) => {
  const f = await fixture(t);
  process.env.STUB_BEHAVIOR = 'invalid';
  t.after(() => {
    process.env.STUB_BEHAVIOR = 'ok';
  });
  const result = await resumeS4({
    receiptPath: f.receiptPath,
    assessmentPath: f.assessmentPath,
    manifestPath: f.manifestPath,
    manager: f.manager,
  });
  assert.equal(result.outcome, 'followup_failed');
  assert.equal(result.followup.status, 'failed');
  assert.equal(result.scenario_assessment, null);
});

test('S4 records which verification notes were shortened before the follow-up', async (t) => {
  const f = await fixture(t);
  f.assessment.entries[0].result = 'x'.repeat(600);
  fs.writeFileSync(f.assessmentPath, JSON.stringify(f.assessment));
  const result = await resumeS4({
    receiptPath: f.receiptPath,
    assessmentPath: f.assessmentPath,
    manifestPath: f.manifestPath,
    manager: f.manager,
  });
  assert.deepEqual(result.followup_notes_truncated, ['f1']);
});

test('S4 CLI starts and resumes using the fixed manifest without exposing the question in its receipt', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-s4-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, 'manifest.json');
  const receiptPath = path.join(dir, 'receipt.json');
  const assessmentPath = path.join(dir, 'assessment.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      scenario: 'S4',
      request: reviewRequest(),
      useful_conditions: ['A concrete risk'],
      acceptable_findings: ['Retry amplification'],
      material: { description: 'fixed retry excerpt' },
      cache: 'disabled',
      evaluator: 'reviewer',
      followup_question: 'Recheck f1 with the recorded check.',
    }),
  );
  const invoke = (args) =>
    spawnSync(process.execPath, ['scripts/live-check.mjs', ...args], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      env: process.env,
      timeout: 15000,
    });
  const initial = invoke(['--benchmark-manifest', manifestPath, '--output', receiptPath]);
  assert.equal(initial.status, 0, initial.stderr);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'awaiting_assessment');
  assert.equal(receipt.finished_at, null);
  assert.ok(receipt.initial_consultation.duration_ms >= 0);
  assert.doesNotMatch(fs.readFileSync(receiptPath, 'utf8'), /Recheck f1 with the recorded check/);
  fs.writeFileSync(
    assessmentPath,
    JSON.stringify({
      job_id: receipt.job_id,
      manifest_sha256: receipt.manifest_sha256,
      entries: [{ id: 'f1', verdict: 'confirmed', method: 'replay', result: 'reproduced', scope: 'test', adoption: 'revise' }],
    }),
  );
  const resumed = invoke([
    '--benchmark-resume',
    receiptPath,
    '--benchmark-manifest',
    manifestPath,
    '--assessment',
    assessmentPath,
  ]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const final = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(final.outcome, 'followup_completed');
  assert.equal(final.scenario_assessment, null);
  assert.equal(final.followup_evidence_delivery_verified, null);
  assert.match(final.followup_evidence_note, /concurrent record updates and history limits/);
  assert.equal(final.finished_at, null);
  assert.equal(typeof final.followup.duration_ms, 'number');
});
