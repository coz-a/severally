import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

// POLICY reads the config once per process, so this file has its own: the
// operator has turned the web off for every consultation.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-netoff-'));
const config = path.join(dir, 'config.json');
fs.writeFileSync(config, JSON.stringify({ server: { network: 'off' } }));
sandboxEnv({ SEVERALLY_CONFIG: config });
const { JobManager } = await import('../src/jobs.mjs');
const { limitsSummary, configProblem } = await import('../src/policy.mjs');
const { buildConsultants } = await import('../src/consultants.mjs');

test('with server.network "off", a request asking for the web still runs without it', async () => {
  assert.equal(configProblem(), null);
  assert.equal(limitsSummary().network, 'off');
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  for (const target of ['codex', 'claude-code']) {
    const argvOut = path.join(dir, `${target}-argv.json`);
    process.env.STUB_ARGV_OUT = argvOut;
    const started = mgr.start(reviewRequest({ target, network: 'on' }));
    await mgr.jobs.get(started.job_id).promise;
    assert.equal(mgr.view(started.job_id).network, 'off', target);
    const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8')).join(' ');
    if (target === 'codex') assert.match(argv, /tools\.web_search=false/);
    else assert.doesNotMatch(argv, /WebSearch|WebFetch/);
  }
  delete process.env.STUB_ARGV_OUT;
});

test('server.network takes only "on" or "off"', () => {
  assert.deepEqual(buildConsultants({ server: { network: 'off' } }).global, []);
  assert.match(buildConsultants({ server: { network: 'no' } }).global.join(), /server\.network/);
});

test('SEVERALLY_NETWORK can close the web but not reopen it, and a value that is neither is refused', async () => {
  const { execFileSync } = await import('node:child_process');
  const policyUrl = new URL('../src/policy.mjs', import.meta.url).href;
  const read = (value) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    const p = await import(${JSON.stringify(policyUrl)});
    console.log(JSON.stringify({ network: p.POLICY.network, problem: p.configProblem() }));
  `], { env: { ...process.env, SEVERALLY_NETWORK: value }, encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(read('on').network, 'off', 'the config file says off');
  assert.match(read('OFF').problem, /SEVERALLY_NETWORK/);
});
