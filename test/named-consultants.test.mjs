import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

// Two consultants on one CLI. POLICY reads the config once per process, so
// this file has its own.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-named-'));
const config = path.join(dir, 'config.json');
fs.writeFileSync(config, JSON.stringify({
  consultants: {
    glm: { cli: 'opencode', model: 'zai-coding-plan/glm-5.3' },
    deepseek: { cli: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' },
  },
}));
sandboxEnv({ SEVERALLY_CONFIG: config });
const { JobManager } = await import('../src/jobs.mjs');

const finishAll = (mgr, ids) => Promise.all(ids.map((id) => mgr.jobs.get(id).promise)).then(() => ids.map((id) => mgr.view(id)));

test('two consultants on one CLI each run on their own model', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['all'] }));
  assert.deepEqual(started.jobs.map((j) => [j.target, j.cli, j.model]), [
    ['glm', 'opencode', 'zai-coding-plan/glm-5.3'],
    ['deepseek', 'opencode', 'opencode/deepseek-v4.1-flash-free'],
  ]);
  const views = await finishAll(mgr, started.jobs.map((j) => j.job_id));
  assert.deepEqual(views.map((v) => v.status), ['completed', 'completed']);
  assert.deepEqual(views.map((v) => [v.cli, v.vendor]), [['opencode', 'zai'], ['opencode', 'deepseek']]);
});

test('each consultant is launched with its own -m', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const models = [];
  for (const target of ['glm', 'deepseek']) {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'severally-argv-')), 'argv.json');
    process.env.STUB_ARGV_OUT = out;
    const { job_id } = mgr.start(reviewRequest({ target }));
    await mgr.jobs.get(job_id).promise;
    const argv = JSON.parse(fs.readFileSync(out, 'utf8'));
    models.push(argv[argv.indexOf('-m') + 1]);
  }
  delete process.env.STUB_ARGV_OUT;
  assert.deepEqual(models, ['zai-coding-plan/glm-5.3#high', 'opencode/deepseek-v4.1-flash-free#high']);
});

test('the same-lineage caveat follows the consultant\'s model, not its CLI', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const ask = async (target) => {
    const { job_id } = mgr.start(reviewRequest({ target, caller: 'opencode', caller_model: 'glm-5.3' }));
    await mgr.jobs.get(job_id).promise;
    return mgr.view(job_id).quality.caveat ?? '';
  };
  assert.match(await ask('glm'), /same model/);
  assert.doesNotMatch(await ask('deepseek'), /same vendor/i);
});

test('a follow-up may name the consultant by its model, and not another one', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const first = mgr.start(reviewRequest({ target: 'glm' }));
  await mgr.jobs.get(first.job_id).promise;
  const followup = (target) => reviewRequest({ target, followup_to: first.job_id });
  const ok = mgr.start(followup('glm-5.3'));
  assert.equal(ok.target, 'glm');
  await mgr.jobs.get(ok.job_id).promise;
  assert.throws(() => mgr.start(reviewRequest({ target: 'deepseek', followup_to: ok.job_id })),
    (e) => e.code === 'followup_target_mismatch');
});

test('with a config mistake nothing can be started, but the history can still be read', () => {
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'severally-bad-')), 'config.json');
  fs.writeFileSync(bad, JSON.stringify({ targets: { codex: {} } }));
  const jobsUrl = new URL('../src/jobs.mjs', import.meta.url).href;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { JobManager } = await import(${JSON.stringify(jobsUrl)});
    const mgr = new JobManager();
    let start;
    try { mgr.start(${JSON.stringify(reviewRequest())}); start = { threw: false }; }
    catch (err) { start = { code: err.code, message: err.message }; }
    console.log(JSON.stringify({ start, list: Array.isArray(mgr.list()) }));
  `], { env: { ...process.env, SEVERALLY_CONFIG: bad }, encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.start.code, 'config_invalid');
  assert.match(r.start.message, /targets/);
  assert.equal(r.list, true);
});
