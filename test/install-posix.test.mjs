import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const posix = process.platform !== 'win32';
const root = fileURLToPath(new URL('../', import.meta.url));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-install-posix-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checkout = path.join(dir, 'checkout');
  for (const relative of ['scripts/install.mjs', 'src/platform.mjs', 'plugins/severally', '.agents', 'package.json']) {
    const dest = path.join(checkout, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(root, relative), dest, { recursive: true });
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(checkout, 'node_modules'), 'dir');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ marketplace: checkout }));
  fs.mkdirSync(path.join(dir, '.codex'));
  fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), '# original configuration\n');
  const log = path.join(dir, 'calls.jsonl');
  const script = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const cli = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.INSTALL_LOG, JSON.stringify([cli,...args])+'\\n');
const file = process.env.INSTALL_REGISTRY;
const state = JSON.parse(fs.readFileSync(file,'utf8'));
if(cli==='npm') {
  execFileSync(process.execPath,[process.env.INSTALL_NPM_CLI,...args,'--prefix',process.env.INSTALL_PREFIX,
    '--ignore-scripts','--no-audit','--no-fund'],{stdio:'pipe'});
} else if(args[0]==='plugin' && args[1]==='marketplace') {
  if(args[2]==='list' && state.marketplace) console.log('severally-local '+state.marketplace);
  if(args[2]==='remove') delete state.marketplace;
  if(args[2]==='add') state.marketplace=args[3];
  if(args[2]!=='list') fs.writeFileSync(path.join(process.env.CODEX_HOME,'config.toml'),'# changed configuration\\n');
} else if(args[0]==='mcp') {
  if(args[1]==='get') process.exitCode=1;
  // Faithful registration emulation: 'mcp list' shows the servers that were
  // actually added (recorded in the registry state), so a post-add
  // registration check has something real to find. STUB_MCP_LIST prepends
  // fixture-set lines; STUB_ADD_SILENT makes 'mcp add' exit 0 while recording
  // nothing and writing no config -- the opencode failure mode where flags
  // print usage instead. A real add also writes the global config file, which
  // is what the installer's command verification reads.
  if(args[1]==='list') {
    const registered = state[cli] ? [cli + ': severally connected'] : [];
    console.log([process.env.STUB_MCP_LIST ?? '', ...registered].filter(Boolean).join('\\n'));
  }
  if(args[1]==='add' && !process.env.STUB_ADD_SILENT) {
    state[cli]=args.slice(-2);
    if(cli==='opencode') {
      const cfgDir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME,'.config'),'opencode');
      fs.mkdirSync(cfgDir,{recursive:true});
      fs.writeFileSync(path.join(cfgDir,'opencode.json'), JSON.stringify({mcp:{servers:{severally:{command:args.slice(-2)}}}},null,2));
    }
  }
}
fs.writeFileSync(file,JSON.stringify(state));
`;
  for (const cli of ['codex', 'claude', 'agy', 'npm', 'opencode']) fs.writeFileSync(path.join(bin, cli), script, { mode: 0o755 });
  // Real npm, with a private prefix/cache and no dependencies to download.
  const npmCli = fs.realpathSync(execFileSync('which', ['npm'], { encoding: 'utf8' }).trim());
  const env = { ...process.env, HOME: dir, CODEX_HOME: path.join(dir, '.codex'),
    PATH: `${path.join(dir, 'prefix', 'bin')}:${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    INSTALL_LOG: log, INSTALL_REGISTRY: registry, INSTALL_PREFIX: path.join(dir, 'prefix'),
    INSTALL_NPM_CLI: npmCli, npm_config_cache: path.join(dir, 'npm-cache'),
    NPM_CONFIG_USERCONFIG: path.join(dir, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(dir, 'global-npmrc') };
  // The operator's own XDG override must not decide where the test writes.
  delete env.XDG_CONFIG_HOME;
  const install = (...args) => execFileSync(process.execPath, [path.join(checkout, 'scripts', 'install.mjs'), ...args],
    { cwd: checkout, env, encoding: 'utf8', stdio: 'pipe' });
  return { dir, checkout, registry, log, env, install };
}

test('POSIX plugin installation survives checkout deletion, including npm command and marketplace', { skip: !posix }, async (t) => {
  const f = fixture(t);
  const obsolete = path.join(f.dir, '.severally', 'marketplace', 'plugins', 'severally', 'hooks.json');
  fs.mkdirSync(path.dirname(obsolete), { recursive: true });
  fs.writeFileSync(obsolete, '{"obsolete":true}');
  f.install('--force');
  assert.equal(fs.existsSync(obsolete), false, 'removed plugin files must not survive an upgrade');
  const runtime = path.join(f.dir, '.severally', 'runtime', 'severally-mcp.mjs');
  const marketplace = path.join(f.dir, '.severally', 'marketplace');
  const state = JSON.parse(fs.readFileSync(f.registry, 'utf8'));
  assert.equal(state.marketplace, marketplace);
  assert.deepEqual(state.agy, [process.execPath, runtime]);
  // OpenCode has no plugin route either: it is registered directly, and its
  // add carries --global (a project-scope write would bind the server to
  // whatever directory the installer ran from) plus the `--` separator
  // before the command.
  assert.deepEqual(state.opencode, [process.execPath, runtime]);
  assert.ok(
    fs.readFileSync(f.log, 'utf8').includes(
      JSON.stringify(['opencode', 'mcp', 'add', 'severally', '--global', '--', process.execPath, runtime]),
    ),
    'opencode must be registered through its own mcp add, globally',
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(marketplace, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.ok(fs.existsSync(path.resolve(marketplace, manifest.plugins[0].source.path, 'dist', 'severally-mcp.mjs')));
  const command = path.join(f.dir, 'prefix', 'bin', 'severally-mcp');
  assert.equal(fs.realpathSync(command), fs.realpathSync(runtime));
  f.install('--force', '--skip-global');
  fs.rmSync(f.checkout, { recursive: true, force: true });
  const client = new Client({ name: 'posix-installed-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command, cwd: f.dir, env: f.env, stderr: 'pipe' }));
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'consult_start'));
  } finally { await client.close(); }
});

test('POSIX skip-global rejects commands that still depend on a checkout', { skip: !posix }, (t) => {
  const f = fixture(t);
  const prefixBin = path.join(f.dir, 'prefix', 'bin');
  fs.mkdirSync(prefixBin, { recursive: true });
  fs.symlinkSync(path.join(f.checkout, 'plugins', 'severally', 'dist', 'severally-mcp.mjs'),
    path.join(prefixBin, 'severally-mcp'));
  assert.throws(() => f.install('--skip-global'), (err) => /Omit --skip-global or use --manual/.test(err.stderr));
  assert.equal(fs.existsSync(f.log), false, 'must reject the old command before changing client registrations');
});

test('POSIX manual mode needs no global npm install and registers the copied runtime', { skip: !posix }, (t) => {
  const f = fixture(t);
  f.install('--manual', '--force');
  const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.some((args) => args[0] === 'npm'), false);
  const state = JSON.parse(fs.readFileSync(f.registry, 'utf8'));
  assert.equal(state.marketplace, undefined, 'manual mode must remove the old checkout marketplace');
  const backups = path.join(f.dir, '.severally', 'backups');
  const saved = fs.readdirSync(backups).map((stamp) => path.join(backups, stamp, 'codex_config.toml'));
  assert.ok(saved.some((file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8') === '# original configuration\n'),
    'later backup calls must preserve the configuration from before migration');
  for (const cli of ['codex', 'claude', 'agy', 'opencode']) {
    assert.deepEqual(state[cli], [process.execPath, path.join(f.dir, '.severally', 'runtime', 'severally-mcp.mjs')]);
  }
});

// opencode resolves its global config from XDG_CONFIG_HOME when set (its own
// xdg-basedir), and a registration check that merely greps for "severally"
// would accept a lookalike server like "severally-old" as ours.
test('POSIX opencode registration follows XDG_CONFIG_HOME and matches the exact server name', { skip: !posix }, (t) => {
  const f = fixture(t);
  const xdg = path.join(f.dir, 'xdg-config');
  f.env.XDG_CONFIG_HOME = xdg;
  f.env.STUB_MCP_LIST = '✓ severally-old  connected';
  f.install('--manual');
  const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(
    calls.some((args) => args[0] === 'opencode' && args[1] === 'mcp' && args[2] === 'add'),
    'a lookalike server name must not satisfy isRegistered',
  );
  assert.ok(
    fs.existsSync(path.join(xdg, 'opencode', 'skills', 'severally', 'SKILL.md')),
    'the skill must land under XDG_CONFIG_HOME when the CLI resolves config there',
  );
  assert.equal(
    fs.existsSync(path.join(f.dir, '.config', 'opencode', 'skills', 'severally')),
    false,
    'nothing may be written to the ~/.config fallback when XDG_CONFIG_HOME is set',
  );

  // The exact name DOES satisfy isRegistered: a second run without --force
  // keeps the registration (no further mcp add call).
  f.env.STUB_MCP_LIST = '✓ severally  connected';
  const logBefore = fs.readFileSync(f.log, 'utf8');
  f.install('--manual');
  const added = fs.readFileSync(f.log, 'utf8').slice(logBefore.length)
    .split('\n').filter(Boolean).map(JSON.parse)
    .some((args) => args[0] === 'opencode' && args[1] === 'mcp' && args[2] === 'add');
  assert.equal(added, false, 'the exact server name must be recognised as already registered');
});

// opencode prints usage and exits 0 on flags a future version renames, so a
// zero exit from `mcp add` proves nothing: the installer must confirm the
// server is actually listed afterwards instead of trusting the exit code.
test('POSIX opencode add that did not register is reported as a failure', { skip: !posix }, (t) => {
  const f = fixture(t);
  f.env.STUB_ADD_SILENT = '1';
  assert.throws(() => f.install('--manual', '--force'), (err) => /not listed/.test(err.stdout));
  const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(
    calls.some((args) => args[0] === 'opencode' && args[1] === 'mcp' && args[2] === 'add'),
    'the add must still have been attempted',
  );
});

// --force replaces a registration, and opencode has no `mcp remove`, so a
// silent add leaves the OLD entry listed: the name-only check would pass
// while the obsolete command stays. The registered command itself must match
// this install's server command.
test('POSIX opencode --force over a stale registration verifies the command, not just the name', { skip: !posix }, (t) => {
  const f = fixture(t);
  const xdg = path.join(f.dir, 'xdg-config');
  f.env.XDG_CONFIG_HOME = xdg;
  const stale = ['old-node', 'old-runtime.mjs'];
  const registry = JSON.parse(fs.readFileSync(f.registry, 'utf8'));
  registry.opencode = stale;
  fs.writeFileSync(f.registry, JSON.stringify(registry));
  fs.mkdirSync(path.join(xdg, 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'opencode', 'opencode.json'),
    JSON.stringify({ mcp: { servers: { severally: { command: stale } } } }));
  f.env.STUB_ADD_SILENT = '1';
  assert.throws(() => f.install('--manual', '--force'), (err) => /not verified/.test(err.stdout));
});

test('POSIX dry-run leaves runtime, marketplace and client configuration untouched', { skip: !posix }, (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.registry, 'utf8');
  f.install('--dry-run', '--force');
  assert.equal(fs.existsSync(path.join(f.dir, '.severally')), false);
  assert.equal(fs.existsSync(path.join(f.dir, '.claude')), false);
  assert.equal(fs.readFileSync(f.registry, 'utf8'), before);
});
