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
  if(args[1]==='add') state[cli]=args.slice(-2);
}
fs.writeFileSync(file,JSON.stringify(state));
`;
  for (const cli of ['codex', 'claude', 'agy', 'npm']) fs.writeFileSync(path.join(bin, cli), script, { mode: 0o755 });
  // Real npm, with a private prefix/cache and no dependencies to download.
  const npmCli = fs.realpathSync(execFileSync('which', ['npm'], { encoding: 'utf8' }).trim());
  const env = { ...process.env, HOME: dir, CODEX_HOME: path.join(dir, '.codex'),
    PATH: `${path.join(dir, 'prefix', 'bin')}:${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    INSTALL_LOG: log, INSTALL_REGISTRY: registry, INSTALL_PREFIX: path.join(dir, 'prefix'),
    INSTALL_NPM_CLI: npmCli, npm_config_cache: path.join(dir, 'npm-cache'),
    NPM_CONFIG_USERCONFIG: path.join(dir, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(dir, 'global-npmrc') };
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
  const manifest = JSON.parse(fs.readFileSync(path.join(marketplace, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.ok(fs.existsSync(path.resolve(marketplace, manifest.plugins[0].source.path, 'dist', 'severally-mcp.mjs')));
  const command = path.join(f.dir, 'prefix', 'bin', 'severally-mcp');
  assert.equal(fs.realpathSync(command), runtime);
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
  for (const cli of ['codex', 'claude', 'agy']) {
    assert.deepEqual(state[cli], [process.execPath, path.join(f.dir, '.severally', 'runtime', 'severally-mcp.mjs')]);
  }
});

test('POSIX dry-run leaves runtime, marketplace and client configuration untouched', { skip: !posix }, (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.registry, 'utf8');
  f.install('--dry-run', '--force');
  assert.equal(fs.existsSync(path.join(f.dir, '.severally')), false);
  assert.equal(fs.existsSync(path.join(f.dir, '.claude')), false);
  assert.equal(fs.readFileSync(f.registry, 'utf8'), before);
});
