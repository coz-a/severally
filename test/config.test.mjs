import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

/**
 * Parse a request in a child process, so the config under test is the one the
 * module registry sees. In-process, schema.mjs imports the bare "./policy.mjs"
 * specifier and would reuse whichever config the first test happened to load.
 */
function refusalInChild(configFile, request) {
  const schemaUrl = new URL('../src/schema.mjs', import.meta.url).href;
  const source = `
    const { parseRequest } = await import(${JSON.stringify(schemaUrl)});
    try {
      parseRequest(${JSON.stringify(request)});
      console.log(JSON.stringify({ threw: false }));
    } catch (err) {
      console.log(JSON.stringify({ threw: true, code: err.code, message: err.message }));
    }
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, PEER_CONSULT_CONFIG: configFile },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
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
      codex: { enabled: false, default_model: 'from-config', allowed_models: ['from-config', 'also-config'] },
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
  assert.deepEqual(policy.POLICY.targets.codex.allowedModels, ['from-env', 'from-config', 'also-config']);
});

test('the config file supplies the bin and the model allowlist when no env does', async () => {
  const config = writeConfig({
    targets: {
      'claude-code': { bin: '/usr/local/bin/claude-x', allowed_models: ['claude-opus-5'] },
    },
  });
  const policy = await loadPolicy({ PEER_CONSULT_CONFIG: config }, 'fromfile', ['PEER_CONSULT_CLAUDE_BIN']);

  assert.equal(policy.POLICY.targets['claude-code'].cli, '/usr/local/bin/claude-x');
  assert.deepEqual(policy.POLICY.targets['claude-code'].allowedModels, ['claude-fable-5-1', 'claude-opus-5']);
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

test('consulting an unavailable target is refused before a job exists', () => {
  const config = writeConfig({ targets: { antigravity: { enabled: false } } });
  const result = refusalInChild(config, reviewRequest({ target: 'gemini' }));

  assert.equal(result.threw, true, 'the request must not be accepted');
  assert.equal(result.code, 'target_unavailable');
  assert.match(result.message, /available: codex, claude-code/);
});

test('an installed CLI can still be excluded, with the reason carried to the caller', async () => {
  const config = writeConfig({
    targets: { codex: { enabled: false, note: 'rate-limited until 15:00' } },
  });
  sandboxEnv({ PEER_CONSULT_CONFIG: config });
  const policy = await import(`../src/policy.mjs?cfg=note-${Date.now()}`);

  // The stub codex binary exists, so this exclusion is the operator's, not the machine's.
  assert.equal(policy.isInstalled(policy.POLICY.targets.codex.cli), true);
  assert.equal(policy.POLICY.targets.codex.available, false);
  assert.equal(policy.unavailableReason('codex'), 'rate-limited until 15:00');

  const result = refusalInChild(config, reviewRequest({ target: 'codex' }));
  assert.equal(result.threw, true);
  assert.equal(result.code, 'target_unavailable');
  assert.match(result.message, /rate-limited until 15:00/, 'the operator note reaches the caller');
});

test('an excluded consultant with no note still says why', async () => {
  const config = writeConfig({ targets: { codex: { enabled: false } } });
  sandboxEnv({ PEER_CONSULT_CONFIG: config });
  const policy = await import(`../src/policy.mjs?cfg=nonote-${Date.now()}`);
  assert.match(policy.unavailableReason('codex'), /operator configuration/);
});

test('the generated template is valid config the server can read back', async () => {
  const { renderConfig } = await import('../scripts/init-config.mjs');
  const rendered = renderConfig();

  // It is JSONC now: comments in the text, parsed by the loader.
  assert.match(rendered, /^\s*\/\/ peer-consult configuration/m, 'the template documents itself in comments');
  const file = writeConfig(rendered);
  sandboxEnv({ PEER_CONSULT_CONFIG: file });
  const policy = await import(`../src/policy.mjs?cfg=template-${Date.now()}`);
  assert.equal(policy.configProblem(), null, 'the template must not be a config the server rejects');

  // The suggestions live in _example blocks, so a freshly generated file
  // changes nothing until the operator moves a key up.
  for (const id of policy.TARGETS) {
    assert.equal(policy.POLICY.targets[id].available, policy.isInstalled(policy.POLICY.targets[id].cli),
      `${id} availability must still come from detection`);
  }
  // Nothing is overridden by a freshly generated file: the comments carry the
  // documentation, so the data is only the empty targets.
  const parsed = (await import('../src/jsonc.mjs')).parseJsonc(rendered);
  assert.deepEqual(Object.keys(parsed), ['targets']);
  for (const id of policy.TARGETS) assert.deepEqual(parsed.targets[id], {});
});

// "~/.local/bin/claudex" is what an operator writes; nothing expands it for
// them, so without this the consultant silently disappears from the list.
test('a ~ in a bin path is expanded, from the config file and from the env', async () => {
  const config = writeConfig({ targets: { 'claude-code': { bin: '~/bin/claudex' } } });
  const fromFile = await loadPolicy({ PEER_CONSULT_CONFIG: config }, 'tilde', ['PEER_CONSULT_CLAUDE_BIN']);
  assert.equal(fromFile.POLICY.targets['claude-code'].cli, path.join(os.homedir(), 'bin/claudex'));

  const fromEnv = await loadPolicy({ PEER_CONSULT_AGY_BIN: '~/bin/agyx' }, 'tilde-env');
  assert.equal(fromEnv.POLICY.targets.antigravity.cli, path.join(os.homedir(), 'bin/agyx'));
});
