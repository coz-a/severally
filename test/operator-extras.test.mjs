import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnv, reviewRequest, exploreRequest, opencodeRequest } from './helpers.mjs';

// The per-target `args` and `env` config keys. POLICY reads the file once, at
// import, so the config is written before the first import of jobs.mjs.
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-extras-'));
const cfgFile = path.join(cfgDir, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({
  targets: {
    'claude-code': { args: ['--disallowedTools', 'WebFetch'], env: { HTTPS_PROXY: 'http://proxy:3128' }, effort: 'max' },
    codex: { args: ['--sandbox', 'danger-full-access'], effort: 'low' },
    antigravity: { effort: 'low' },
    opencode: { env: { HOME: '/tmp/elsewhere' } },
  },
}));
sandboxEnv({ SEVERALLY_CONFIG: cfgFile });
const { JobManager, extraArgsProblem, withExtraArgs } = await import('../src/jobs.mjs');
const { operatorEnvProblem } = await import('../src/run.mjs');

const finish = async (mgr, jobId) => {
  await mgr.jobs.get(jobId).promise;
  return mgr.view(jobId);
};

test('configured args and env reach the consultant', async () => {
  const argvOut = path.join(cfgDir, 'argv.json');
  const envOut = path.join(cfgDir, 'env.json');
  process.env.STUB_BEHAVIOR = 'ok';
  process.env.STUB_ARGV_OUT = argvOut;
  process.env.STUB_ENV_OUT = envOut;
  try {
    const mgr = new JobManager();
    const view = await finish(mgr, mgr.start(exploreRequest()).job_id);
    assert.equal(view.status, 'completed');
    const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
    assert.deepEqual(argv.slice(-2), ['--disallowedTools', 'WebFetch']);
    assert.equal(argv[argv.indexOf('--effort') + 1], 'max', 'the effort key reaches claude as --effort');
    assert.ok(argv.includes('--restricted'), 'the isolation flags stay');
    const env = JSON.parse(fs.readFileSync(envOut, 'utf8'));
    assert.equal(env.HTTPS_PROXY, 'http://proxy:3128');
    assert.equal(env.SEVERALLY_ACTIVE, '1');
  } finally {
    delete process.env.STUB_ARGV_OUT;
    delete process.env.STUB_ENV_OUT;
  }
});

test('an arg that overrides an isolation flag fails the job before launch', async () => {
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(reviewRequest()).job_id);
  assert.equal(view.status, 'failed');
  assert.equal(view.failure.kind, 'spawn_error');
  assert.match(view.failure.message, /targets\.codex\.args: --sandbox/);
});

test('an env var the sandbox controls fails the job before launch', async () => {
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(opencodeRequest()).job_id);
  assert.equal(view.status, 'failed');
  assert.match(view.failure.message, /targets\.opencode\.env: HOME/);
});

test('effort on antigravity fails the job before launch', async () => {
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start({ ...exploreRequest(), target: 'antigravity' }).job_id);
  assert.equal(view.status, 'failed');
  assert.equal(view.failure.kind, 'spawn_error');
  assert.match(view.failure.message, /targets\.antigravity\.effort: .*model name/);
});

test('every consultant defaults to high effort, and the effort key overrides it', async () => {
  const { POLICY } = await import('../src/policy.mjs');
  assert.equal(POLICY.targets.codex.effort, 'low');
  assert.equal(POLICY.targets['claude-code'].effort, 'max');
  assert.equal(POLICY.targets.opencode.effort, 'high');
  const codex = await import('../src/adapters/codex.mjs');
  assert.ok(codex.buildInvocation({ workdir: '/tmp/w', schemaPath: '/tmp/s' }).args.includes('model_reasoning_effort="low"'));
});

test('extraArgsProblem refuses every spelling of a taken flag and passes the rest', () => {
  const codexArgs = ['exec', '-s', 'read-only', '-c', 'hooks.enabled=false', '-'];
  for (const bad of [['-s', 'x'], ['--sandbox=x'], ['-sdanger-full-access'], ['-c', 'k=v'], ['--config', 'k=v'],
    ['--dangerously-bypass-approvals-and-sandbox'], ['--full-auto'], ['--add-dir', '/']]) {
    assert.ok(extraArgsProblem('codex', codexArgs, bad), `codex must refuse ${bad.join(' ')}`);
  }
  assert.ok(extraArgsProblem('antigravity', ['--model', 'm'], ['-dangerously-skip-permissions']), 'Go-style single dash');
  assert.ok(extraArgsProblem('claude-code', ['-p', '--tools', 'Read'], ['--settings', '{}']));
  assert.equal(extraArgsProblem('claude-code', ['-p', '--tools', 'Read'], ['--disallowedTools', 'WebFetch']), null);
  assert.ok(extraArgsProblem('claude-code', ['-p', '--effort', 'high'], ['--effort', 'max']), 'effort has one place: the effort key');
  assert.ok(extraArgsProblem('antigravity', ['--model', 'm'], ['--effort', 'low']), 'agy takes effort from the model name');
  assert.equal(extraArgsProblem('codex', codexArgs, ['--oss']), null);
  assert.ok(extraArgsProblem('codex', codexArgs, '--oss'), 'a string is not an array');
  assert.ok(extraArgsProblem('codex', codexArgs, [1]));
});

test('withExtraArgs keeps the stdin marker last', () => {
  assert.deepEqual(withExtraArgs(['exec', '-'], ['--oss']), ['exec', '--oss', '-']);
  assert.deepEqual(withExtraArgs(['-p'], ['--effort', 'high']), ['-p', '--effort', 'high']);
});

test('operatorEnvProblem refuses what isolation strips and accepts the rest', () => {
  assert.equal(operatorEnvProblem('claude-code', { HTTPS_PROXY: 'x', ANTHROPIC_BASE_URL: 'y' }), null);
  for (const [target, env] of [
    ['claude-code', { OPENAI_API_KEY: 'x' }],
    ['claude-code', { CLAUDE_CODE_ENTRYPOINT: 'x' }],
    ['codex', { SEVERALLY_ACTIVE: '0' }],
    ['antigravity', { XDG_CONFIG_HOME: '/x' }],
    ['opencode', { OPENCODE_CONFIG: '/x' }],
  ]) {
    assert.ok(operatorEnvProblem(target, env), `${target} must refuse ${Object.keys(env)}`);
  }
  assert.ok(operatorEnvProblem('opencode', { HOME: '/x' }, ['HOME']));
  assert.ok(operatorEnvProblem('codex', { A: 1 }));
  assert.ok(operatorEnvProblem('codex', ['A=1']));
});
