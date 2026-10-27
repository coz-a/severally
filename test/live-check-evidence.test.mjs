import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnv } from './helpers.mjs';

function run(mode, extra = {}) {
  sandboxEnv({ STUB_BEHAVIOR: 'ok', ...extra });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-evidence-'));
  const cli = path.join(dir, 'cli.mjs');
  fs.writeFileSync(
    cli,
    `#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('synthetic-codex 1.0'); } else { await import(${JSON.stringify(new URL('./fixtures/stub-codex.mjs', import.meta.url).href)}); }\n`,
    { mode: 0o755 },
  );
  process.env.SEVERALLY_CODEX_BIN = cli;
  const result = spawnSync(process.execPath, ['scripts/live-check.mjs', '--target', 'codex', '--mode', mode], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
    env: process.env,
    timeout: 15000,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split('\n').find((l) => l.startsWith('compatibility: '));
  assert.ok(line, result.stdout);
  return JSON.parse(line.slice('compatibility: '.length));
}

test('ordinary live check reports common evidence without inventing read or effective-model evidence', () => {
  const evidence = run('review');
  assert.equal(evidence.runner, 'live-check');
  assert.equal(evidence.checks.consultation.status, 'passed');
  assert.equal(evidence.checks.read.status, 'not_run');
  assert.equal(evidence.observed.model, null);
  assert.equal(evidence.observed.effort, null);
});

test('explicit followup mode exercises a second round and records its outcome', () => {
  const evidence = run('followup');
  assert.equal(evidence.checks.followup.status, 'passed');
  assert.match(evidence.checks.followup.detail, /completed/);
});

test('explicit cancel mode records job cancellation without claiming descendant cleanup', () => {
  const evidence = run('cancel', { STUB_BEHAVIOR: 'hang' });
  assert.equal(evidence.checks.cancel.status, 'passed');
  assert.match(evidence.checks.cancel.detail, /descendant cleanup not checked/);
});

test('doctor uses the same evidence format and marks an unquoted read as inconclusive', () => {
  sandboxEnv({ STUB_BEHAVIOR: 'ok' });
  const result = spawnSync(process.execPath, ['scripts/doctor.mjs', '--target', 'codex'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
    env: process.env,
    timeout: 15000,
  });
  assert.equal(result.status, 1, result.stderr);
  const [row] = JSON.parse(result.stdout);
  assert.match(row.protected_history_read, /^inconclusive: the control file was not quoted/);
  assert.equal(row.evidence.runner, 'doctor');
  assert.equal(row.evidence.schema_version, 1);
  assert.equal(row.evidence.checks.read.status, 'inconclusive');
  assert.equal(row.evidence.checks.forbidden_operations.status, 'inconclusive');
  assert.equal(row.evidence.observed.effort, null);
});
