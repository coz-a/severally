import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandboxEnv } from './helpers.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

let sqliteAvailable = false;
try {
  sqliteAvailable = typeof createRequire(import.meta.url)('node:sqlite').DatabaseSync === 'function';
} catch {
  /* optional */
}
const noSqlite = process.allowedNodeEnvironmentFlags.has('--no-experimental-sqlite') ? ['--no-experimental-sqlite'] : [];

// `severally-mcp status` in a home of its own: a config with one mistake, an
// older runtime copy, and fake clients on PATH that know (or not) about severally.
const bin = fileURLToPath(new URL('../bin/severally-mcp.mjs', import.meta.url));

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
      SEVERALLY_CODEX_BIN: 'codex',
      SEVERALLY_CLAUDE_BIN: 'claude',
      SEVERALLY_AGY_BIN: 'agy',
      SEVERALLY_OPENCODE_BIN: 'opencode',
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

test('status shows effective effort and timeout while distinguishing availability from live verification', () => {
  const home = sandboxEnv({ SEVERALLY_TIMEOUT_MS: '45000' });
  const config = path.join(home, 'config.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      consultants: {
        codex: { cli: 'codex', model: 'gpt-6-astra', effort: 'low', timeout_ms: 12000 },
        claude: { cli: 'claude-code', model: 'claude-opus-5-5' },
        agy: { cli: 'antigravity', model: 'gemini-test-high' },
        open: { cli: 'opencode', model: 'provider/model#' },
      },
    }),
  );
  const result = spawnSync(process.execPath, [bin, 'status'], {
    encoding: 'utf8',
    env: { ...process.env, SEVERALLY_CONFIG: config, PATH: path.dirname(process.execPath) },
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex: codex, gpt-6-astra.*effort: low.*timeout: 12000 ms/);
  assert.match(result.stdout, /claude: claude-code, claude-opus-5-5.*effort: high.*timeout: 45000 ms/);
  assert.match(result.stdout, /agy: antigravity, gemini-test-high.*effort: in model name/);
  assert.match(result.stdout, /open: opencode, provider\/model#.*effort: no variant/);
  assert.match(result.stdout, /availability.*CLI.*live consultation.*not verified/i);
});

test('status warns when the configured Codex executable is inside a protected root', () => {
  const home = sandboxEnv();
  const credentials = path.join(home, 'codex-credentials');
  const outside = path.join(home, 'outside');
  fs.mkdirSync(credentials, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const insideExecutable = path.join(credentials, executableName);
  const outsideExecutable = path.join(outside, executableName);
  fs.writeFileSync(insideExecutable, '', { mode: 0o755 });
  fs.writeFileSync(outsideExecutable, '', { mode: 0o755 });
  const config = path.join(home, 'config.json');
  const statusFor = (binPath) => {
    fs.writeFileSync(config, JSON.stringify({ clis: { codex: { bin: binPath, env: { CODEX_HOME: credentials } } } }));
    return spawnSync(process.execPath, [bin, 'status'], {
      encoding: 'utf8',
      env: { ...process.env, SEVERALLY_CONFIG: config, SEVERALLY_CODEX_BIN: binPath, PATH: path.dirname(process.execPath) },
      timeout: 15000,
    });
  };
  const inside = statusFor(insideExecutable);
  assert.equal(inside.status, 0, inside.stderr);
  assert.match(inside.stdout, /Codex executable.*inside a protected root/i);
  assert.match(inside.stdout, /new files.*readable/i);
  const safe = statusFor(outsideExecutable);
  assert.equal(safe.status, 0, safe.stderr);
  assert.doesNotMatch(safe.stdout, /Codex executable.*inside a protected root/i);
});

function configuredProbe(t, source) {
  const home = sandboxEnv();
  const dir = path.join(home, '相談 CLI with spaces');
  fs.mkdirSync(dir);
  const script = path.join(dir, 'probe.mjs');
  fs.writeFileSync(script, source);
  const command = path.join(dir, process.platform === 'win32' ? 'consultant.cmd' : 'consultant');
  fs.writeFileSync(
    command,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "%~dp0probe.mjs" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    { mode: 0o755 },
  );
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, 'config.json');
  const runStatus = (settings, extraEnv = {}) => {
    fs.writeFileSync(config, JSON.stringify(settings));
    return spawnSync(process.execPath, [bin, 'status'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: path.dirname(process.execPath),
        SEVERALLY_CONFIG: config,
        SEVERALLY_CODEX_BIN: '',
        SEVERALLY_CLAUDE_BIN: '',
        SEVERALLY_AGY_BIN: '',
        SEVERALLY_OPENCODE_BIN: '',
        ...extraEnv,
      },
      timeout: 25000,
      windowsHide: true,
    });
  };
  return { home, command, runStatus };
}

test('status probes the configured executable and relocated credentials without exposing account details', (t) => {
  const f = configuredProbe(
    t,
    `
    import fs from 'node:fs';
    import path from 'node:path';
    if (process.argv.slice(2).join(' ') !== 'auth status --json') process.exit(8);
    console.log(JSON.stringify({
      loggedIn: fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'auth-test'), 'utf8') === 'test-credential',
      email: 'private@example.com', token: 'must-not-print-this-token'
    }));
  `,
  );
  const auth = path.join(f.home, '認証情報');
  fs.mkdirSync(auth);
  fs.writeFileSync(path.join(auth, 'auth-test'), 'test-credential');
  const r = f.runStatus({
    consultants: { review: { cli: 'claude-code', model: 'claude-opus-5-5' } },
    clis: { 'claude-code': { bin: f.command, env: { CLAUDE_CONFIG_DIR: auth } } },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude-code +logged in/);
  assert.match(r.stdout, /Claude Code +not installed/, 'host registration is checked separately on PATH');
  assert.doesNotMatch(r.stdout, /private@example|must-not-print/);
});

test('status distinguishes an unsupported login command from a logged-out account', (t) => {
  const f = configuredProbe(t, `console.error('unknown subcommand login: private@example.com'); process.exitCode = 2;`);
  const r = f.runStatus({
    consultants: { review: { cli: 'codex', model: 'gpt-6-astra' } },
    clis: { codex: { bin: f.command } },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /codex +could not tell/);
  assert.doesNotMatch(r.stdout, /not logged in|private@example/);
});

test('status checks OpenCode credentials from the consultation credential source', (t) => {
  const f = configuredProbe(
    t,
    `
    import fs from 'node:fs';
    import path from 'node:path';
    if (process.argv.slice(2).join(' ') !== 'auth list') process.exit(8);
    const auth = JSON.parse(fs.readFileSync(path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8'));
    for (const _ of Object.keys(auth)) console.log('provider stored credential');
  `,
  );
  const credentials = path.join(f.home, '移設した認証', '.local', 'share', 'opencode');
  fs.mkdirSync(credentials, { recursive: true });
  fs.writeFileSync(path.join(credentials, 'auth.json'), '{"provider-a":{},"provider-b":{}}');
  const r = f.runStatus(
    {
      consultants: { review: { cli: 'opencode', model: 'provider/model' } },
      clis: { opencode: { bin: f.command } },
    },
    { SEVERALLY_OPENCODE_CRED_HOME: path.join(f.home, '移設した認証') },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /opencode +2 saved credentials/);
});

test('status reports a configured logged-out CLI without confusing it with probe failure', (t) => {
  const f = configuredProbe(t, `console.error('Not logged in'); process.exitCode = 1;`);
  const r = f.runStatus({
    consultants: { review: { cli: 'codex', model: 'gpt-6-astra' } },
    clis: { codex: { bin: f.command } },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /codex +not logged in/);
});

test('status does not execute a disabled consultant CLI', (t) => {
  const f = configuredProbe(t, `import fs from 'node:fs'; fs.writeFileSync(process.env.PROBE_MARKER, 'called');`);
  const marker = path.join(f.home, 'disabled-probe-called');
  const r = f.runStatus({
    consultants: { review: { cli: 'codex', model: 'gpt-6-astra' } },
    clis: { codex: { bin: f.command, enabled: false, env: { PROBE_MARKER: marker } } },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /codex +not checked.*disabled/);
  assert.equal(fs.existsSync(marker), false);
});

test('status probes independent logins concurrently and bounds silent CLI waits', (t) => {
  const f = configuredProbe(t, `setInterval(() => {}, 1000);`);
  const started = Date.now();
  const r = f.runStatus({
    consultants: {
      codex: { cli: 'codex', model: 'gpt-6-astra' },
      claude: { cli: 'claude-code', model: 'claude-opus-5-5' },
    },
    clis: { codex: { bin: f.command }, 'claude-code': { bin: f.command } },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /codex +could not tell.*timed out/);
  assert.match(r.stdout, /claude-code +could not tell.*timed out/);
  assert.ok(Date.now() - started < 10000, 'two silent probes share the wait rather than each consuming it');
});
