import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandboxEnv } from './helpers.mjs';

const home = sandboxEnv();
const credentials = process.env.SEVERALLY_AGY_CRED_HOME;
const codexHome = path.join(home, 'relocated-codex');
const claudeHome = path.join(home, 'relocated-claude');
const inheritedCodexHome = path.join(home, 'inherited-codex');
const xdgData = path.join(home, 'xdg-data');
const googleCredentials = path.join(home, 'google-account.json');
process.env.CODEX_HOME = inheritedCodexHome;
process.env.XDG_DATA_HOME = xdgData;
process.env.GOOGLE_APPLICATION_CREDENTIALS = googleCredentials;
fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(path.join(codexHome, 'auth.json'), 'synthetic-codex-secret');
const config = path.join(home, 'operator-config.json');
fs.writeFileSync(
  config,
  JSON.stringify({
    clis: {
      codex: { env: { CODEX_HOME: codexHome } },
      'claude-code': { env: { CLAUDE_CONFIG_DIR: claudeHome } },
    },
  }),
);
process.env.SEVERALLY_CONFIG = config;
const policy = await import('../src/policy.mjs');
const codex = await import('../src/adapters/codex.mjs');
const claude = await import('../src/adapters/claude-code.mjs');
const { prepareSandbox } = await import('../src/adapters/opencode-sandbox.mjs');
const fwd = (p) => p.replaceAll('\\', '/');

test('configured credential locations and the external operator config are excluded from exposure', () => {
  for (const file of [
    path.join(credentials, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    path.join(credentials, '.local', 'share', 'opencode', 'auth.json'),
    path.join(codexHome, 'auth.json'),
    path.join(inheritedCodexHome, 'auth.json'),
    path.join(claudeHome, '.credentials.json'),
    path.join(xdgData, 'opencode', 'opencode.db'),
    googleCredentials,
    config,
  ])
    assert.equal(policy.isProtectedPath(file), true, file);
  assert.equal(policy.isProtectedPath(path.join(home, 'ordinary.txt')), false);
});

test('configured paths reach the Codex and Claude CLI deny mechanisms', () => {
  const permissions = codex.filesystemPermissions();
  assert.ok(
    permissions.includes(`${JSON.stringify(fwd(codexHome))} = "none"`),
    'the relocated Codex home can be denied as a directory when the executable lives elsewhere',
  );
  assert.ok(permissions.includes(`${JSON.stringify(fwd(path.join(credentials, '.gemini')))} = "none"`));
  const rules = claude.protectedReadRules();
  assert.ok(
    rules.some((r) => r.includes(claude.posixAbsolute(claudeHome))),
    'Claude receives its relocated config directory',
  );
  assert.ok(
    rules.some((r) => r.includes(claude.posixAbsolute(codexHome))),
    'each consultant denies other configured credential stores',
  );
});

test('OpenCode read permissions deny configured credential directories', () => {
  const workdir = path.join(home, 'jobs', 'credential-rules', 'work');
  fs.mkdirSync(workdir, { recursive: true });
  const sandbox = prepareSandbox({ workdir });
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(sandbox.root, '.config', 'opencode', 'opencode.json'), 'utf8'));
    for (const permission of [cfg.permission.read, cfg.permission.external_directory]) {
      assert.equal(permission[`${fwd(codexHome)}/**`], 'deny');
      assert.equal(permission[`${fwd(path.join(credentials, '.local', 'share', 'opencode'))}/**`], 'deny');
      assert.equal(permission['ordinary.txt'], undefined);
    }
  } finally {
    sandbox.cleanup();
  }
});

test('a configured symlink credential root also protects its canonical target', { skip: process.platform === 'win32' }, () => {
  const actual = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-security-target-'));
  const alias = path.join(home, 'credential-alias');
  fs.symlinkSync(actual, alias, 'dir');
  const previous = process.env.SEVERALLY_AGY_CRED_HOME;
  process.env.SEVERALLY_AGY_CRED_HOME = alias;
  try {
    fs.mkdirSync(path.join(actual, '.gemini'));
    fs.writeFileSync(path.join(actual, '.gemini', 'token'), 'synthetic-token');
    assert.equal(policy.isProtectedPath(path.join(actual, '.gemini', 'token')), true);
    assert.ok(policy.protectedRoots().includes(fwd(fs.realpathSync.native(path.join(actual, '.gemini')))));
  } finally {
    process.env.SEVERALLY_AGY_CRED_HOME = previous;
    fs.rmSync(actual, { recursive: true, force: true });
  }
});

for (const linked of [false, true]) {
  test(`a Codex binary inside a ${linked ? 'linked' : 'direct'} credential home keeps only its executable entry readable`, () => {
    const actual = path.join(home, linked ? 'codex-linked-target' : 'codex-with-binary');
    fs.mkdirSync(actual, { recursive: true });
    const relocated = linked ? path.join(home, 'codex-linked-home') : actual;
    if (linked) fs.symlinkSync(actual, relocated, process.platform === 'win32' ? 'junction' : 'dir');
    const executable = path.join(relocated, 'packages', 'codex.mjs');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o700 });
    fs.writeFileSync(path.join(relocated, 'auth.json'), 'synthetic-auth');
    fs.mkdirSync(path.join(relocated, 'sessions'));
    const file = path.join(home, 'binary-config.json');
    fs.writeFileSync(file, JSON.stringify({ clis: { codex: { bin: executable, env: { CODEX_HOME: relocated } } } }));
    const moduleUrl = new URL('../src/adapters/codex.mjs', import.meta.url).href;
    const env = { ...process.env, SEVERALLY_CONFIG: file };
    delete env.SEVERALLY_CODEX_BIN;
    const rules = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const adapter = await import(${JSON.stringify(moduleUrl)}); console.log(adapter.filesystemPermissions());`,
      ],
      { env, encoding: 'utf8' },
    );
    assert.ok(rules.includes(`${JSON.stringify(fwd(path.join(relocated, 'auth.json')))} = "none"`));
    assert.ok(rules.includes(`${JSON.stringify(fwd(path.join(relocated, 'sessions')))} = "none"`));
    assert.ok(!rules.includes(`${JSON.stringify(fwd(relocated))} = "none"`));
    assert.ok(!rules.includes(`${JSON.stringify(fwd(path.join(relocated, 'packages')))} = "none"`));
    const canonical = fs.realpathSync.native(relocated);
    assert.ok(rules.includes(`${JSON.stringify(fwd(path.join(canonical, 'auth.json')))} = "none"`));
    assert.ok(!rules.includes(`${JSON.stringify(fwd(canonical))} = "none"`));
    assert.ok(!rules.includes(`${JSON.stringify(fwd(path.join(canonical, 'packages')))} = "none"`));
  });
}
