import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandboxEnv } from './helpers.mjs';
import { createRequire } from 'node:module';

let sqliteAvailable = false;
try {
  sqliteAvailable = typeof createRequire(import.meta.url)('node:sqlite').DatabaseSync === 'function';
} catch {
  /* optional */
}
const noSqlite = process.allowedNodeEnvironmentFlags.has('--no-experimental-sqlite') ? ['--no-experimental-sqlite'] : [];

// `severally-mcp status` in a home of its own: a config with one mistake, an
// older runtime copy, and fake clients on PATH that know (or not) about severally.
const bin = new URL('../bin/severally-mcp.mjs', import.meta.url).pathname;

function fixture({ registered }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-status-'));
  const sev = path.join(home, '.severally');
  fs.mkdirSync(path.join(sev, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(sev, 'runtime', 'severally-mcp.mjs'), "export const SEVERALLY_VERSION = '0.0.1';\n");
  fs.writeFileSync(
    path.join(sev, 'config.json'),
    JSON.stringify({
      consultants: {
        codex: { cli: 'codex', model: 'gpt-6-astra' },
        gemini: { cli: 'antigravity', model: 'g-high', effort: 'high' },
        opus: { cli: 'claude-code', model: 'claude-opus-5-5' },
        flash: { cli: 'antigravity', model: 'gemini-x-flash-high' },
      },
    }),
  );
  const pathDir = path.join(home, 'bin');
  fs.mkdirSync(pathDir);
  // Each fake client lists severally when told to; a missing one is not on PATH at all.
  // Login: claude answers its JSON (with an email that must not be shown), codex says no.
  const login = {
    claude: `if [ "$1" = auth ]; then echo '{"loggedIn":true,"email":"someone@example.com"}'; exit 0; fi`,
    codex: 'if [ "$1" = login ]; then echo "Not logged in" >&2; exit 1; fi',
  };
  for (const [name, list] of [
    ['claude', 'plugin list'],
    ['codex', 'mcp get'],
  ]) {
    fs.writeFileSync(
      path.join(pathDir, name),
      `#!/bin/sh\n${login[name]}\n${registered.includes(name) ? `echo "severally@skills-dir ${list}"` : 'echo nothing; exit 1'}\n`,
      { mode: 0o755 },
    );
  }
  return { home, sev, pathDir };
}

const run = (f, flags = []) =>
  spawnSync(process.execPath, [...flags, bin, 'status'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: f.home,
      SEVERALLY_HOME: f.sev,
      SEVERALLY_CONFIG: '',
      PATH: `${f.pathDir}:${path.dirname(process.execPath)}`,
    },
  });

test('status says what is set up, without starting a consultation', { skip: process.platform === 'win32' }, () => {
  sandboxEnv();
  const f = fixture({ registered: ['claude'] });
  const r = run(f, sqliteAvailable ? [] : noSqlite);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /^severally \d+\.\d+\.\d+/m);
  assert.match(out, /codex: codex, gpt-6-astra +available/);
  assert.match(out, /gemini: .*not available: .*consultants\.gemini\.effort/);
  assert.match(out, /runtime 0\.0\.1 .*behind/);
  assert.match(out, /Claude Code +registered \(listed/);
  assert.match(out, /Codex +not registered/);
  assert.match(out, /Antigravity +not installed/);
  // Login comes from each CLI's own status command, and only the verdict is shown.
  assert.match(out, /claude-code +logged in/);
  assert.match(out, /codex +not logged in/);
  assert.match(out, /antigravity +not checked/, 'a CLI without a status command is never claimed logged in');
  assert.doesNotMatch(out, /someone@example\.com/);
  assert.match(
    out,
    sqliteAvailable
      ? /OpenCode credential recovery: available \(node:sqlite\)/
      : /OpenCode credential recovery: unavailable.*node:sqlite/,
  );
});

test(
  'missing SQLite disables only OpenCode credential recovery, not status or login',
  { skip: process.platform === 'win32' },
  () => {
    sandboxEnv();
    const f = fixture({ registered: ['claude'] });
    const r = run(f, noSqlite);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OpenCode credential recovery: unavailable.*node:sqlite/);
    assert.match(r.stdout, /update Node\.js/);
    assert.match(r.stdout, /claude-code +logged in/);
  },
);

test('status exits 1 when the config file as a whole needs fixing', { skip: process.platform === 'win32' }, () => {
  const f = fixture({ registered: [] });
  fs.writeFileSync(path.join(f.sev, 'config.json'), '{ "targets": {} }');
  const r = run(f);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /needs fixing.*targets/);
});
