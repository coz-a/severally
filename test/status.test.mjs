import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandboxEnv } from './helpers.mjs';

// `severally-mcp status` in a home of its own: a config with one mistake, an
// older runtime copy, and fake clients on PATH that know (or not) about severally.
const bin = new URL('../bin/severally-mcp.mjs', import.meta.url).pathname;

function fixture({ registered }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-status-'));
  const sev = path.join(home, '.severally');
  fs.mkdirSync(path.join(sev, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(sev, 'runtime', 'severally-mcp.mjs'), "export const SEVERALLY_VERSION = '0.0.1';\n");
  fs.writeFileSync(path.join(sev, 'config.json'), JSON.stringify({
    consultants: { codex: { cli: 'codex', model: 'gpt-6-astra' }, gemini: { cli: 'antigravity', model: 'g-high', effort: 'high' } },
  }));
  const pathDir = path.join(home, 'bin');
  fs.mkdirSync(pathDir);
  // Each fake client lists severally when told to; a missing one is not on PATH at all.
  for (const [name, list] of [['claude', 'plugin list'], ['codex', 'mcp get']]) {
    fs.writeFileSync(path.join(pathDir, name), `#!/bin/sh\n${registered.includes(name) ? `echo "severally@skills-dir ${list}"` : 'echo nothing; exit 1'}\n`, { mode: 0o755 });
  }
  return { home, sev, pathDir };
}

const run = (f) => spawnSync(process.execPath, [bin, 'status'], {
  encoding: 'utf8',
  env: { ...process.env, HOME: f.home, SEVERALLY_HOME: f.sev, SEVERALLY_CONFIG: '', PATH: `${f.pathDir}:${path.dirname(process.execPath)}` },
});

test('status says what is set up, without starting a consultation', { skip: process.platform === 'win32' }, () => {
  sandboxEnv();
  const f = fixture({ registered: ['claude'] });
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /^severally \d+\.\d+\.\d+/m);
  assert.match(out, /codex: codex, gpt-6-astra +available/);
  assert.match(out, /gemini: .*not available: .*consultants\.gemini\.effort/);
  assert.match(out, /runtime 0\.0\.1 .*behind/);
  assert.match(out, /Claude Code +registered/);
  assert.match(out, /Codex +not registered/);
  assert.match(out, /Antigravity +not installed/);
  assert.match(out, /not checked/i, 'it never claims a CLI is logged in');
});

test('status exits 1 when the config file as a whole needs fixing', { skip: process.platform === 'win32' }, () => {
  const f = fixture({ registered: [] });
  fs.writeFileSync(path.join(f.sev, 'config.json'), '{ "targets": {} }');
  const r = run(f);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /needs fixing.*targets/);
});
