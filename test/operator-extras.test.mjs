import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnv, reviewRequest, exploreRequest, opencodeRequest } from './helpers.mjs';

// The per-CLI `args` and `env` config keys, and per-consultant effort. POLICY
// reads the file once, at import, so the config is written before the first
// import of jobs.mjs.
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-extras-'));
const cfgFile = path.join(cfgDir, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({
  clis: {
    'claude-code': { args: ['--disallowedTools', 'WebFetch'], env: { HTTPS_PROXY: 'http://proxy:3128' } },
    codex: { args: ['--sandbox', 'danger-full-access'] },
    opencode: { env: { HOME: '/tmp/elsewhere' },
      provider: { router: { npm: '@ai-sdk/openai-compatible', options: { apiKey: '{env:ROUTER_API_KEY}' } } } },
  },
  consultants: {
    'claude-code': { cli: 'claude-code', model: 'claude-opus-5-5', effort: 'max' },
    codex: { cli: 'codex', model: 'gpt-6-astra', effort: 'low' },
    antigravity: { cli: 'antigravity', model: 'gemini-4-argon-high' },
    opencode: { cli: 'opencode', model: 'zai-coding-plan/glm-5.3' },
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
  assert.match(view.failure.message, /clis\.codex\.args: --sandbox/);
});

test('an env var the sandbox controls fails the job before launch', async () => {
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(opencodeRequest()).job_id);
  assert.equal(view.status, 'failed');
  assert.match(view.failure.message, /clis\.opencode\.env: HOME/);
});

test('every consultant defaults to high effort, and the effort key overrides it', async () => {
  const { consultantByName } = await import('../src/policy.mjs');
  const codex = await import('../src/adapters/codex.mjs');
  const opencode = await import('../src/adapters/opencode.mjs');
  const claude = await import('../src/adapters/claude-code.mjs');
  const args = (adapter, name) => adapter.buildInvocation({ consultant: consultantByName(name), workdir: '/tmp/w', schemaPath: '/tmp/s' }).args;
  assert.ok(args(codex, 'codex').includes('model_reasoning_effort="low"'));
  const c = args(claude, 'claude-code');
  assert.equal(c[c.indexOf('--effort') + 1], 'max');
  const o = args(opencode, 'opencode');
  assert.equal(o[o.indexOf('-m') + 1], 'zai-coding-plan/glm-5.3#high', 'no effort set: high');
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

test('other services\' credentials do not reach a consultant, its own vendor\'s and the operator\'s do', async () => {
  const { childEnv } = await import('../src/run.mjs');
  const saved = { ...process.env };
  Object.assign(process.env, {
    AWS_SECRET_ACCESS_KEY: 'a', GITHUB_TOKEN: 'b', SSH_AUTH_SOCK: '/tmp/agent', MY_SERVICE_API_KEY: 'c',
    OPENAI_API_KEY: 'own', GEMINI_API_KEY: 'g', HTTPS_PROXY: 'http://proxy:3128', LANG: 'C.UTF-8',
  });
  try {
    const codexEnv = childEnv('codex');
    for (const k of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'MY_SERVICE_API_KEY', 'GEMINI_API_KEY']) {
      assert.equal(codexEnv[k], undefined, `${k} must not reach codex`);
    }
    assert.equal(codexEnv.OPENAI_API_KEY, 'own');
    assert.equal(codexEnv.HTTPS_PROXY, 'http://proxy:3128');
    assert.equal(codexEnv.LANG, 'C.UTF-8');
    assert.equal(childEnv('antigravity').GEMINI_API_KEY, 'g');
    assert.equal(childEnv('opencode', {}, { MY_SERVICE_API_KEY: 'set-by-operator' }).MY_SERVICE_API_KEY, 'set-by-operator');
    process.env.ROUTER_API_KEY = 'r';
    assert.equal(childEnv('opencode').ROUTER_API_KEY, 'r', 'a key the provider config reads as {env:...} is passed');
    assert.equal(childEnv('codex').ROUTER_API_KEY, undefined);
    process.env.github_token = 'lower';
    assert.equal(childEnv('codex').github_token, undefined, 'a lowercase name is caught too');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
