import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

// One config file per machine is the point of this feature, so each case gets
// its own file and its own module registry: POLICY reads the file once, at
// import, exactly as the running server does.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'peer-consult-cfg-'));

function writeConfig(body) {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  return file;
}

/**
 * Import policy.mjs fresh, with the environment this case needs. `unset` drops
 * the pins sandboxEnv() adds, for cases that test what happens when the env
 * says nothing and the config file has to answer.
 */
async function loadPolicy(env, tag, unset = []) {
  sandboxEnv(env);
  for (const name of unset) delete process.env[name];
  return import(`../src/policy.mjs?cfg=${tag}-${Date.now()}-${Math.random()}`);
}

test('a target the config file disables is not offered, even though its CLI exists', async () => {
  const config = writeConfig({ targets: { codex: { enabled: false } } });
  const policy = await loadPolicy({ PEER_CONSULT_CONFIG: config }, 'disabled');

  assert.equal(policy.POLICY.targets.codex.available, false);
  assert.ok(!policy.availableTargets().includes('codex'));
  assert.ok(policy.availableTargets().includes('claude-code'), 'the others stay available');
  assert.ok(!Object.hasOwn(policy.limitsSummary().models, 'codex'), 'limits advertise only what is reachable');
});

test('a CLI that is not installed makes its consultant unavailable with no configuration at all', async () => {
  const policy = await loadPolicy({ PEER_CONSULT_AGY_BIN: '/nonexistent/agy' }, 'autodetect');
  assert.equal(policy.POLICY.targets.antigravity.available, false);
  assert.deepEqual(policy.availableTargets(), ['codex', 'claude-code']);
});

test('the environment overrides the config file, target by target', async () => {
  const config = writeConfig({
    targets: {
      codex: { enabled: false, model: 'from-config', models: ['from-config', 'also-config'] },
    },
  });
  const policy = await loadPolicy({
    PEER_CONSULT_CONFIG: config,
    PEER_CONSULT_TARGETS: 'codex,claude-code',
    PEER_CONSULT_CODEX_MODEL: 'from-env',
  }, 'override');

  assert.equal(policy.POLICY.targets.codex.available, true, 'PEER_CONSULT_TARGETS wins over enabled:false');
  assert.equal(policy.POLICY.targets.antigravity.available, false, 'and it is the whole enabled set');
  assert.equal(policy.POLICY.targets.codex.model, 'from-env', 'env model wins over the config file');
  // PEER_CONSULT_CODEX_MODEL (the default) came from the env; the config's
  // `models` list is a different knob and still contributes the extras.
  assert.deepEqual(policy.POLICY.targets.codex.models, ['from-env', 'from-config', 'also-config']);
});

test('the config file supplies the bin and the model allowlist when no env does', async () => {
  const config = writeConfig({
    targets: {
      'claude-code': { bin: '/usr/local/bin/claude-x', models: ['claude-opus-5'] },
    },
  });
  const policy = await loadPolicy({ PEER_CONSULT_CONFIG: config }, 'fromfile', ['PEER_CONSULT_CLAUDE_BIN']);

  assert.equal(policy.POLICY.targets['claude-code'].cli, '/usr/local/bin/claude-x');
  assert.deepEqual(policy.POLICY.targets['claude-code'].models, ['claude-fable-5-1', 'claude-opus-5']);
  assert.equal(policy.POLICY.targets['claude-code'].available, false, 'that bin does not exist here');
});

test('a malformed config file is reported rather than silently ignored', async () => {
  const config = writeConfig('{ not json');
  const policy = await loadPolicy({ PEER_CONSULT_CONFIG: config }, 'broken');

  assert.match(policy.configProblem(), /config\.json/);
  assert.equal(policy.POLICY.targets.codex.model, 'gpt-6-astra', 'and the defaults still apply');
});

test('a missing config file is the normal case, not a problem', async () => {
  const policy = await loadPolicy({ PEER_CONSULT_CONFIG: path.join(tmp(), 'absent.json') }, 'absent');
  assert.equal(policy.configProblem(), null);
});

test('consulting an unavailable target is refused before a job exists', async () => {
  const config = writeConfig({ targets: { antigravity: { enabled: false } } });
  sandboxEnv({ PEER_CONSULT_CONFIG: config });
  const { parseRequest, RequestError } = await import(`../src/schema.mjs?cfg=refuse-${Date.now()}`);

  try {
    parseRequest(reviewRequest({ target: 'gemini' }));
    assert.fail('expected the consultation to be refused');
  } catch (err) {
    assert.ok(err instanceof RequestError);
    assert.equal(err.code, 'target_unavailable');
    assert.match(err.message, /available: codex, claude-code/);
  }
});
