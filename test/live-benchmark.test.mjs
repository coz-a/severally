import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { sandboxEnv, reviewRequest } from './helpers.mjs';
import { expectedLaunchEffort } from '../scripts/live-benchmark.mjs';

function runManifest(manifest, extra = {}, failClaude = false) {
  sandboxEnv({ STUB_BEHAVIOR: 'ok', SEVERALLY_TIMEOUT_MS: '3000', ...extra });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-benchmark-'));
  const input = path.join(dir, 'manifest.json');
  const output = path.join(dir, 'receipt.json');
  if (failClaude) {
    const cli = path.join(dir, 'failing-claude.mjs');
    fs.writeFileSync(
      cli,
      `#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('synthetic-claude 1.0'); } else { process.env.STUB_BEHAVIOR='invalid'; await import(${JSON.stringify(new URL('./fixtures/stub-claude.mjs', import.meta.url).href)}); }`,
      { mode: 0o755 },
    );
    process.env.SEVERALLY_CLAUDE_BIN = cli;
  }
  fs.writeFileSync(input, JSON.stringify(manifest));
  const proc = spawnSync(process.execPath, ['scripts/live-check.mjs', '--benchmark-manifest', input, '--output', output], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
    env: process.env,
    timeout: 15000,
  });
  const receipt = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { proc, receipt };
}

function manifest(scenario = 'S1') {
  return {
    scenario,
    request: reviewRequest(),
    useful_conditions: ['Names a reproducible outage risk'],
    acceptable_findings: ['Retry amplification'],
    material: { kind: 'excerpt', revision: null, description: 'fixed retry example' },
    cache: 'disabled',
    evaluator: 'manual',
  };
}

test('benchmark requires predeclared evaluation criteria before running', () => {
  const input = manifest();
  input.useful_conditions = [];
  const { proc, receipt } = runManifest(input);
  assert.notEqual(proc.status, 0);
  assert.equal(receipt, null);
});

test('planned effort follows adapter defaults and explicit OpenCode variants', () => {
  assert.equal(expectedLaunchEffort({ cli: 'codex', model: 'x', effort: null }), 'high');
  assert.equal(expectedLaunchEffort({ cli: 'claude-code', model: 'x', effort: 'low' }), 'low');
  assert.equal(expectedLaunchEffort({ cli: 'opencode', model: 'provider/model#medium', effort: 'high' }), 'medium');
  assert.equal(expectedLaunchEffort({ cli: 'opencode', model: 'provider/model#', effort: 'high' }), null);
  assert.equal(expectedLaunchEffort({ cli: 'antigravity', model: 'gemini-high', effort: null }), null);
});

test('S4 refuses to start without a fixed follow-up question', () => {
  const { proc, receipt } = runManifest(manifest('S4'));
  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr, /follow-up question/i);
  assert.equal(receipt, null);
});

test('S3 records verified fixed repository material but leaves usefulness unassessed', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 's3-live-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const file = path.join(repo, 'source.mjs');
  fs.writeFileSync(file, 'export const value = 1;\n');
  git('add', 'source.mjs');
  git('-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', 'fixture');
  const input = manifest('S3');
  input.request = reviewRequest({ context: { proposal: 'Keep it.', expose_paths: [file] } });
  input.material = {
    kind: 'repository',
    description: 'fixed repository',
    repo,
    commit: git('rev-parse', 'HEAD'),
    files: [{ path: 'source.mjs', sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }],
  };
  const { proc, receipt } = runManifest(input);
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(receipt.material_verified.verified, true);
  assert.equal(receipt.material_verified.files[0].path, 'source.mjs');
  assert.equal(receipt.members[0].useful, null);
  assert.equal(receipt.scenario_assessment, null);
});

test('S3 receipt and stdout do not expose a secret-shaped material path', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 's3-redaction-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const name = 'ghp_abcdefghijklmnopqrstuvwxyz0123.mjs';
  const file = path.join(repo, name);
  fs.writeFileSync(file, 'export const value = 1;\n');
  git('add', name);
  git('-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', 'fixture');
  const input = manifest('S3');
  input.request = reviewRequest({ context: { proposal: 'Keep it.', expose_paths: [file] } });
  input.material = {
    kind: 'repository',
    description: 'fixed repository',
    repo,
    commit: git('rev-parse', 'HEAD'),
    files: [{ path: name, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }],
  };
  const { proc, receipt } = runManifest(input);
  assert.ok(receipt);
  assert.doesNotMatch(JSON.stringify(receipt), /ghp_abcdefghijklmnopqrstuvwxyz0123/);
  assert.doesNotMatch(proc.stdout, /ghp_abcdefghijklmnopqrstuvwxyz0123/);
});

test('S1 rejects multiple consultants before starting', () => {
  const input = manifest('S1');
  input.request = reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] });
  const { proc, receipt } = runManifest(input);
  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr, /S1.*one/i);
  assert.equal(receipt, null);
});

test('S2 rejects aliases that resolve to the same consultant before starting', () => {
  const input = manifest('S2');
  input.request = reviewRequest({ target: undefined, targets: ['codex', 'codex'] });
  const { proc, receipt } = runManifest(input);
  assert.notEqual(proc.status, 0);
  assert.equal(receipt, null);
});

test('benchmark records terminal status and usage but leaves usefulness and serving model unassessed', () => {
  const { proc, receipt } = runManifest(manifest());
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(receipt.scenario, 'S1');
  assert.equal(receipt.route, 'direct_job_manager');
  assert.equal(receipt.outcome, 'completed');
  assert.equal(receipt.members[0].status, 'completed');
  assert.equal(receipt.members[0].useful, null);
  assert.equal(receipt.members[0].observed_model, null);
  assert.equal(receipt.members[0].configured_effort, null);
  assert.equal(receipt.members[0].expected_launch_effort, 'high');
  assert.equal(receipt.members[0].observed_effort, null);
  assert.ok(receipt.members[0].usage);
  assert.equal(receipt.adoption, null);
  assert.match(receipt.manifest_sha256, /^[0-9a-f]{64}$/);
});

test('S2 records each member including failures and does not infer independent views', () => {
  const input = manifest('S2');
  input.request = reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] });
  const { proc, receipt } = runManifest(input, {}, true);
  assert.ok(receipt, proc.stderr);
  assert.equal(receipt.members.length, 2);
  assert.deepEqual(receipt.members.map((m) => m.target).sort(), ['claude-code', 'codex']);
  assert.equal(receipt.members.find((m) => m.target === 'codex').status, 'completed');
  assert.equal(receipt.members.find((m) => m.target === 'claude-code').status, 'failed');
  assert.equal(receipt.members.find((m) => m.target === 'claude-code').failure_kind, 'invalid_output');
  assert.equal(receipt.outcome, 'failed');
  assert.equal(proc.status, 1);
  assert.equal(receipt.independence_verified, null);
});
