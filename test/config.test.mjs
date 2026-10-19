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
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'severally-cfg-'));

test('round budget defaults to five and can be configured up to twenty', async () => {
  for (const [value, expected] of [[undefined, 5], ['20', 20], ['99', 20], ['0', 1], ['invalid', 5]]) {
    const env = value === undefined ? {} : { SEVERALLY_MAX_ROUNDS: value };
    const policy = await loadPolicy(env, `rounds-${value}`);
    assert.equal(policy.POLICY.maxRounds, expected, `round setting ${value}`);
    assert.equal(policy.limitsSummary().max_rounds_per_chain, expected);
  }
});

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
    env: { ...process.env, SEVERALLY_CONFIG: configFile },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const names = (policy) => policy.availableConsultants().map((c) => c.name);

test('a CLI the config file disables takes its consultants out, even though it is installed', async () => {
  const config = writeConfig({ clis: { codex: { enabled: false } } });
  const policy = await loadPolicy({ SEVERALLY_CONFIG: config }, 'disabled');

  assert.equal(policy.POLICY.clis.codex.available, false);
  assert.ok(!names(policy).includes('codex'));
  assert.ok(names(policy).includes('claude-code'), 'the others stay available');
  assert.ok(!Object.hasOwn(policy.limitsSummary().models, 'codex'), 'limits advertise only what is reachable');
});

test('a CLI that is not installed makes its consultant unavailable with no configuration at all', async () => {
  const policy = await loadPolicy({ SEVERALLY_AGY_BIN: '/nonexistent/agy' }, 'autodetect');
  assert.equal(policy.POLICY.clis.antigravity.available, false);
  assert.deepEqual(names(policy), ['codex', 'claude-code', 'opencode']);
});

test('named consultants can share one CLI', async () => {
  const config = writeConfig({
    consultants: {
      glm: { cli: 'opencode', model: 'zai-coding-plan/glm-5.3' },
      deepseek: { cli: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' },
    },
  });
  const policy = await loadPolicy({ SEVERALLY_CONFIG: config }, 'named');
  assert.equal(policy.configProblem(), null);
  assert.deepEqual(names(policy), ['glm', 'deepseek']);
  assert.deepEqual(policy.availableConsultants().map((c) => c.cli), ['opencode', 'opencode']);
  assert.deepEqual(policy.limitsSummary().clis, { glm: 'opencode', deepseek: 'opencode' });
});

test('a consultant name longer than 64 characters is a config problem', async () => {
  const config = writeConfig({ consultants: { ['a'.repeat(65)]: { cli: 'codex', model: 'gpt-6-astra' } } });
  const policy = await loadPolicy({ SEVERALLY_CONFIG: config }, 'longname');
  assert.match(policy.configProblem(), /at most 64 characters/);
});

test('the old targets key is a config problem, not a silently ignored one', async () => {
  const config = writeConfig({ targets: { codex: {} } });
  const policy = await loadPolicy({ SEVERALLY_CONFIG: config }, 'oldkey');
  assert.match(policy.configProblem(), /targets/);
});

test('a removed per-model environment variable has no effect', async () => {
  const policy = await loadPolicy({ SEVERALLY_CODEX_MODEL: 'foo' }, 'removed-env');
  assert.equal(policy.consultantByName('codex').model, 'gpt-6-astra');
});

test('server-wide limits come from the config file, clamped, and the env still wins', async () => {
  const config = writeConfig({
    server: { max_rounds: 12, max_concurrent: 99, max_wait_ms: 10_000, timeout_ms: 900_000 },
    consultants: {
      opus: { cli: 'claude-code', model: 'claude-opus-5-5', max_budget_usd: 3 },
      quick: { cli: 'codex', model: 'gpt-6-astra', timeout_ms: 99 },
    },
  });
  const fromFile = await loadPolicy({ SEVERALLY_CONFIG: config }, 'server-file', ['SEVERALLY_TIMEOUT_MS']);
  assert.equal(fromFile.POLICY.maxRounds, 12);
  assert.equal(fromFile.POLICY.maxConcurrent, 9, 'clamped to the same ceiling as the env');
  assert.equal(fromFile.POLICY.maxWaitMs, 10_000);
  assert.equal(fromFile.POLICY.maxJobsRetained, 200, 'unset keys keep their default');
  assert.equal(fromFile.timeoutMs(fromFile.consultantByName('opus')), 900_000, 'no own timeout: the shared one');
  assert.equal(fromFile.timeoutMs(fromFile.consultantByName('quick')), 1_000, 'its own, clamped');
  assert.equal(fromFile.consultantByName('opus').maxBudgetUsd, 3);

  const fromEnv = await loadPolicy({ SEVERALLY_CONFIG: config, SEVERALLY_MAX_ROUNDS: '3' }, 'server-env');
  assert.equal(fromEnv.POLICY.maxRounds, 3, 'env wins over the config file');
});

test('the config file supplies the bin when no env does', async () => {
  const config = writeConfig({ clis: { 'claude-code': { bin: '/usr/local/bin/claude-x' } } });
  const policy = await loadPolicy({ SEVERALLY_CONFIG: config }, 'fromfile', ['SEVERALLY_CLAUDE_BIN']);

  assert.equal(policy.POLICY.clis['claude-code'].cli, '/usr/local/bin/claude-x');
  assert.equal(policy.POLICY.clis['claude-code'].available, false, 'that bin does not exist here');
});

test('a malformed config file is reported, and nothing can be started on it', async () => {
  const config = writeConfig('{ not json');
  const policy = await loadPolicy({ SEVERALLY_CONFIG: config }, 'broken');

  assert.match(policy.configProblem(), /config\.json/);
});

test('a missing config file is the normal case, not a problem', async () => {
  const policy = await loadPolicy({ SEVERALLY_CONFIG: path.join(tmp(), 'absent.json') }, 'absent');
  assert.equal(policy.configProblem(), null);
});

test('consulting an unavailable consultant is refused before a job exists', () => {
  const config = writeConfig({ clis: { antigravity: { enabled: false } } });
  const result = refusalInChild(config, reviewRequest({ target: 'antigravity' }));

  assert.equal(result.threw, true, 'the request must not be accepted');
  assert.equal(result.code, 'target_unavailable');
  assert.match(result.message, /available: codex \(codex, gpt-6-astra\), claude-code \(claude-code, claude-opus-5-5\), opencode /);
});

test('an installed CLI can still be excluded, with the reason carried to the caller', async () => {
  const config = writeConfig({ clis: { codex: { enabled: false, note: 'rate-limited until 15:00' } } });
  sandboxEnv({ SEVERALLY_CONFIG: config });
  const policy = await import(`../src/policy.mjs?cfg=note-${Date.now()}`);

  // The stub codex binary exists, so this exclusion is the operator's, not the machine's.
  assert.equal(policy.isInstalled(policy.POLICY.clis.codex.cli), true);
  assert.equal(policy.POLICY.clis.codex.available, false);
  assert.equal(policy.unavailableReason(policy.consultantByName('codex')), 'rate-limited until 15:00');

  const result = refusalInChild(config, reviewRequest({ target: 'codex' }));
  assert.equal(result.threw, true);
  assert.equal(result.code, 'target_unavailable');
  assert.match(result.message, /rate-limited until 15:00/, 'the operator note reaches the caller');
});

test('a consultant turned off on its own carries its own note', async () => {
  const config = writeConfig({
    consultants: { sol: { cli: 'codex', model: 'gpt-6.1-sol', enabled: false, note: 'quota' }, astra: { cli: 'codex', model: 'gpt-6-astra' } },
  });
  const policy = await loadPolicy({ SEVERALLY_CONFIG: config }, 'own-note');
  assert.deepEqual(names(policy), ['astra']);
  assert.equal(policy.unavailableReason(policy.consultantByName('sol')), 'quota');
});

test('an excluded consultant with no note still says why', async () => {
  const config = writeConfig({ clis: { codex: { enabled: false } } });
  sandboxEnv({ SEVERALLY_CONFIG: config });
  const policy = await import(`../src/policy.mjs?cfg=nonote-${Date.now()}`);
  assert.match(policy.unavailableReason(policy.consultantByName('codex')), /operator configuration/);
});

test('the generated template is valid config the server can read back', async () => {
  const { renderConfig } = await import('../scripts/init-config.mjs');
  const rendered = renderConfig();

  assert.match(rendered, /^\s*\/\/ severally configuration/m, 'the template documents itself in comments');
  const file = writeConfig(rendered);
  sandboxEnv({ SEVERALLY_CONFIG: file });
  const policy = await import(`../src/policy.mjs?cfg=template-${Date.now()}`);
  assert.equal(policy.configProblem(), null, 'the template must not be a config the server rejects');
  const parsed = (await import('../src/jsonc.mjs')).parseJsonc(rendered);
  assert.deepEqual(Object.keys(parsed), ['clis', 'consultants']);
  for (const c of policy.POLICY.consultants) assert.equal(c.name, c.cli, 'one consultant per CLI, named after it');
});

// "~/.local/bin/claudex" is what an operator writes; nothing expands it for
// them, so without this the consultant silently disappears from the list.
test('a ~ in a bin path is expanded, from the config file and from the env', async () => {
  const config = writeConfig({ clis: { 'claude-code': { bin: '~/bin/claudex' } } });
  const fromFile = await loadPolicy({ SEVERALLY_CONFIG: config }, 'tilde', ['SEVERALLY_CLAUDE_BIN']);
  assert.equal(fromFile.POLICY.clis['claude-code'].cli, path.join(os.homedir(), 'bin/claudex'));

  const fromEnv = await loadPolicy({ SEVERALLY_AGY_BIN: '~/bin/agyx' }, 'tilde-env');
  assert.equal(fromEnv.POLICY.clis.antigravity.cli, path.join(os.homedir(), 'bin/agyx'));
});

test('config.example.json is a config the server accepts', async () => {
  const { parseJsonc } = await import('../src/jsonc.mjs');
  const { buildConsultants } = await import('../src/consultants.mjs');
  const text = fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8');
  assert.deepEqual(buildConsultants(parseJsonc(text)).problems, []);
});

test('OpenCode provider definitions reach the sandbox config and nowhere else', async () => {
  const provider = { local: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:11434/v1' }, models: { 'qwen3:8b': {} } } };
  const config = writeConfig({ clis: { opencode: { provider } } });
  const policy = await loadPolicy({ SEVERALLY_CONFIG: config }, 'oc-provider');
  assert.equal(policy.configProblem(), null);
  assert.deepEqual(policy.POLICY.clis.opencode.provider, provider);

  // In a child, so the sandbox module sees this config rather than the first one loaded here.
  const sandboxUrl = new URL('../src/adapters/opencode-sandbox.mjs', import.meta.url).href;
  const work = path.join(tmp(), 'job_x', 'work');
  fs.mkdirSync(work, { recursive: true });
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const fs = await import('node:fs'); const path = await import('node:path');
    const { prepareSandbox } = await import(${JSON.stringify(sandboxUrl)});
    const sb = prepareSandbox({ workdir: ${JSON.stringify(work)} });
    console.log(fs.readFileSync(path.join(sb.root, '.config', 'opencode', 'opencode.json'), 'utf8'));
  `], { env: { ...process.env, SEVERALLY_CONFIG: config }, encoding: 'utf8' });
  const written = JSON.parse(out);
  assert.deepEqual(written.provider, provider);
  assert.deepEqual(written.mcp, {}, 'providers do not bring anything else across');
  assert.equal(written.permission['*'], 'deny');

  for (const [bad, why] of [[{ codex: { provider } }, /only OpenCode/], [{ opencode: { provider: { local: 'x' } } }, /provider objects/]]) {
    const p = await loadPolicy({ SEVERALLY_CONFIG: writeConfig({ clis: bad }) }, `oc-provider-bad-${Math.random()}`);
    assert.match(p.configProblem(), why);
  }
});
