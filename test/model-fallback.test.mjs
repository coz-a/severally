import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sandboxEnv, antigravityRequest } from './helpers.mjs';

// POLICY freezes at first import, so the consultants are in place before it.
// Both are on Antigravity, whose stub fails the model named in STUB_QUOTA_MODEL.
const cfgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'severally-fallback-')), 'config.json');
fs.writeFileSync(
  cfgFile,
  JSON.stringify({
    consultants: {
      gemini: { cli: 'antigravity', model: 'gemini-4-argon-high', fallback_model: 'gemini-3.8-flash-high' },
      plain: { cli: 'antigravity', model: 'gemini-4-argon-low' },
    },
  }),
);
sandboxEnv({ SEVERALLY_CONFIG: cfgFile });
const { JobManager } = await import('../src/jobs.mjs');
const { buildConsultants } = await import('../src/consultants.mjs');

const run = async (target, behavior, quotaModel) => {
  process.env.STUB_BEHAVIOR = behavior;
  process.env.STUB_QUOTA_MODEL = quotaModel ?? '';
  const mgr = new JobManager();
  const started = mgr.start(antigravityRequest({ target }));
  await mgr.jobs.get(started.job_id).promise;
  return mgr.view(started.job_id);
};

test('a used-up quota is re-run once on the fallback model, and the answer says so', async () => {
  const view = await run('gemini', 'quota_by_model', 'gemini-4-argon-high');
  assert.equal(view.status, 'completed');
  assert.equal(view.model, 'gemini-3.8-flash-high', 'the model that answered');
  assert.equal(view.retries.length, 1);
  assert.equal(view.retries[0].failure_kind, 'usage_limit');
  assert.match(view.retries[0].reason, /gemini-4-argon-high quota used up; re-run on gemini-3\.8-flash-high/);
  assert.match(view.quality.caveat, /answered by gemini-3\.8-flash-high: gemini-4-argon-high's quota was used up/);
});

test('the fallback failing too is reported, not looped', async () => {
  const view = await run('gemini', 'usage_limit');
  assert.equal(view.status, 'failed');
  assert.equal(view.failure.kind, 'usage_limit');
  assert.equal(view.retries.length, 1, 'switched once');
});

test('without a fallback_model a used-up quota fails as usage_limit', async () => {
  const view = await run('plain', 'quota_by_model', 'gemini-4-argon-low');
  assert.equal(view.status, 'failed');
  assert.equal(view.failure.kind, 'usage_limit');
  assert.equal(view.retries.length, 0);
  assert.equal(view.model, 'gemini-4-argon-low');
});

test('a fallback_model must be a non-empty string that differs from model', () => {
  const problemsFor = (fallback_model) =>
    buildConsultants({ consultants: { x: { cli: 'codex', model: 'gpt-6-astra', fallback_model } } }).problems.join('\n');
  assert.match(problemsFor(5), /fallback_model: must be a string/);
  assert.match(problemsFor('  '), /fallback_model: must not be empty/);
  assert.match(problemsFor('gpt-6-astra'), /fallback_model: must differ from model/);
  assert.equal(problemsFor('gpt-6-astra-mini'), '');
});
