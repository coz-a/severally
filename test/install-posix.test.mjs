import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const posix = process.platform !== 'win32';
const root = fileURLToPath(new URL('../', import.meta.url));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-install-posix-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checkout = path.join(dir, 'checkout');
  for (const relative of [
    'scripts/install.mjs',
    'src/platform.mjs',
    'src/windows-job.mjs',
    'plugins/severally',
    '.agents',
    'package.json',
  ]) {
    const dest = path.join(checkout, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(root, relative), dest, { recursive: true });
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(checkout, 'node_modules'), 'dir');
  // The extensionless CLI fixtures are ESM. Node 22.0 does not infer that
  // from their syntax, so declare their format independently of the host.
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
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
if(cli==='opencode' && args[1]==='add' && args.includes('--global') && process.env.STUB_OPENCODE_NO_GLOBAL) {
  // opencode 1.19 has no --global: usage on stderr, exit 1.
  console.error('opencode mcp add [name]'); process.exit(1);
}
if(cli==='npm' && args[0]==='install' && process.env.STUB_NPM_FAIL) {
  // What npm says without write access to its global folder.
  console.error('npm error code EACCES'); process.exit(243);
} else if(cli==='npm') {
  process.stdout.write(execFileSync(process.execPath,[process.env.INSTALL_NPM_CLI,...args,'--prefix',process.env.INSTALL_PREFIX,
    '--ignore-scripts','--no-audit','--no-fund'],{stdio:'pipe'}));
} else if(cli==='claude' && args[0]==='plugin' && args[1]==='list') {
  // STUB_CLAUDE_PLUGINS: what \`claude plugin list --json\` reports.
  console.log(process.env.STUB_CLAUDE_PLUGINS ?? '[]');
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
  // STUB_LIST_EMPTY_FOR: how many 'mcp list' calls answer "No MCP servers
  // configured" before the real list -- what opencode did twice on the first
  // run after an upgrade, with the server in its config all along.
  if(args[1]==='list' && cli==='opencode' && Number(process.env.STUB_LIST_EMPTY_FOR ?? 0) > (state.emptyLists ?? 0)) {
    state.emptyLists = (state.emptyLists ?? 0) + 1;
    console.log('No MCP servers configured');
  } else if(args[1]==='list') {
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
// Real codex keeps each server as a [mcp_servers.<name>] table in
// $CODEX_HOME/config.toml: 'mcp add' writes it (with env = { ... } when --env
// was given), 'mcp remove' deletes it, and 'mcp get' reads it.
// STUB_CODEX_NO_TABLE makes 'mcp add' exit 0 without writing the table.
if(cli==='codex' && args[0]==='mcp') {
  const cfg = path.join(process.env.CODEX_HOME,'config.toml');
  const text = fs.existsSync(cfg) ? fs.readFileSync(cfg,'utf8') : '';
  let skip = false;
  const kept = text.split('\\n').filter((l) => { if (l.startsWith('[')) skip = l.startsWith('[mcp_servers.severally'); return !skip; });
  const has = kept.length !== text.split('\\n').length;
  if(args[1]==='get') process.exitCode = has ? 0 : 1;
  if(args[1]==='remove') fs.writeFileSync(cfg, kept.join('\\n'));
  if(args[1]==='add' && !process.env.STUB_ADD_SILENT && !process.env.STUB_CODEX_NO_TABLE) {
    const e = args.indexOf('--env');
    const rest = args.slice(args.indexOf('--')+1);
    const table = ['[mcp_servers.severally]', 'command = ' + JSON.stringify(rest[0]), 'args = ' + JSON.stringify(rest.slice(1)),
      ...(e >= 0 ? ['env = { ' + args[e+1].replace('=', ' = "') + '" }'] : [])];
    fs.writeFileSync(cfg, kept.join('\\n').replace(/\\n*$/, '\\n') + table.join('\\n') + '\\n');
  }
}
fs.writeFileSync(file,JSON.stringify(state));
`;
  for (const cli of ['codex', 'claude', 'agy', 'npm', 'opencode']) fs.writeFileSync(path.join(bin, cli), script, { mode: 0o755 });
  // Real npm, with a private prefix/cache and no dependencies to download.
  const npmCli = fs.realpathSync(execFileSync('which', ['npm'], { encoding: 'utf8' }).trim());
  const env = {
    ...process.env,
    HOME: dir,
    CODEX_HOME: path.join(dir, '.codex'),
    PATH: `${path.join(dir, 'prefix', 'bin')}:${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    INSTALL_LOG: log,
    INSTALL_REGISTRY: registry,
    INSTALL_PREFIX: path.join(dir, 'prefix'),
    INSTALL_NPM_CLI: npmCli,
    npm_config_cache: path.join(dir, 'npm-cache'),
    NPM_CONFIG_USERCONFIG: path.join(dir, 'npmrc'),
    NPM_CONFIG_GLOBALCONFIG: path.join(dir, 'global-npmrc'),
  };
  // The operator's own XDG override must not decide where the test writes.
  delete env.XDG_CONFIG_HOME;
  const install = (...args) =>
    execFileSync(process.execPath, [path.join(checkout, 'scripts', 'install.mjs'), ...args], {
      cwd: checkout,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  return { dir, checkout, registry, log, env, install };
}

test(
  'POSIX plugin installation survives checkout deletion, including npm command and marketplace',
  { skip: !posix },
  async (t) => {
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
      fs
        .readFileSync(f.log, 'utf8')
        .includes(
          JSON.stringify([
            'opencode',
            'mcp',
            'add',
            'severally',
            '--global',
            '--env',
            'SEVERALLY_MAX_WAIT_MS=600000',
            '--',
            process.execPath,
            runtime,
          ]),
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
    } finally {
      await client.close();
    }
  },
);

test('POSIX skip-global rejects commands that still depend on a checkout', { skip: !posix }, (t) => {
  const f = fixture(t);
  const prefixBin = path.join(f.dir, 'prefix', 'bin');
  fs.mkdirSync(prefixBin, { recursive: true });
  fs.symlinkSync(
    path.join(f.checkout, 'plugins', 'severally', 'dist', 'severally-mcp.mjs'),
    path.join(prefixBin, 'severally-mcp'),
  );
  assert.throws(
    () => f.install('--skip-global'),
    (err) => /Omit --skip-global or use --manual/.test(err.stderr),
  );
  assert.equal(fs.existsSync(f.log), false, 'must reject the old command before changing client registrations');
});

test('POSIX manual mode needs no global npm install and registers the copied runtime', { skip: !posix }, (t) => {
  const f = fixture(t);
  f.install('--manual', '--force');
  const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(
    calls.some((args) => args[0] === 'npm'),
    false,
  );
  const state = JSON.parse(fs.readFileSync(f.registry, 'utf8'));
  assert.equal(state.marketplace, undefined, 'manual mode must remove the old checkout marketplace');
  const backups = path.join(f.dir, '.severally', 'backups');
  const saved = fs.readdirSync(backups).map((stamp) => path.join(backups, stamp, 'codex_config.toml'));
  assert.ok(
    saved.some((file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8') === '# original configuration\n'),
    'later backup calls must preserve the configuration from before migration',
  );
  for (const cli of ['codex', 'claude', 'agy', 'opencode']) {
    assert.deepEqual(state[cli], [process.execPath, path.join(f.dir, '.severally', 'runtime', 'severally-mcp.mjs')]);
  }
  // Only a client known to outwait ten minutes gets the long consult_get wait.
  const adds = calls.filter((args) => args[1] === 'mcp' && args[2] === 'add');
  const longWait = (cli) => adds.find((args) => args[0] === cli).includes('SEVERALLY_MAX_WAIT_MS=600000');
  // OpenCode waited out a 610 s tool call; Antigravity stops one at 180 s.
  for (const cli of ['claude', 'opencode']) assert.equal(longWait(cli), true, cli);
  assert.ok(adds.find((args) => args[0] === 'agy').includes('SEVERALLY_MAX_WAIT_MS=165000'));
});

// A manually registered Codex gets the same long consult_get wait as the
// plugin: SEVERALLY_MAX_WAIT_MS on the server and tool_timeout_sec in
// config.toml, both or neither.
const codexAdds = (f) =>
  fs
    .readFileSync(f.log, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((args) => args[0] === 'codex' && args[1] === 'mcp' && args[2] === 'add');
const codexConfig = (f) => fs.readFileSync(path.join(f.dir, '.codex', 'config.toml'), 'utf8');
// No leftover marketplace either: removing one rewrites config.toml in the fake.
const setCodexTable = (f, lines) => {
  fs.writeFileSync(f.registry, '{}');
  fs.writeFileSync(
    path.join(f.dir, '.codex', 'config.toml'),
    `# mine\n[mcp_servers.severally]\ncommand = "old"\nargs = ["old.mjs"]\n${lines}\n[other]\nkey = 1\n`,
  );
};
const waitEnv = (ms) => `env = { SEVERALLY_MAX_WAIT_MS = "${ms}" }`;

test('POSIX manual Codex registration carries the long wait and tool_timeout_sec together', { skip: !posix }, (t) => {
  const f = fixture(t);
  f.install('--manual');
  const [add, ...more] = codexAdds(f);
  assert.equal(more.length, 0);
  assert.deepEqual(add.slice(3, 5), ['severally', '--env']);
  assert.equal(add[5], 'SEVERALLY_MAX_WAIT_MS=600000');
  const toml = codexConfig(f);
  assert.match(toml, /\[mcp_servers\.severally\]\ntool_timeout_sec = 660\ncommand = /);
  assert.ok(toml.includes(waitEnv(600000)));
});

test(
  'POSIX manual Codex keeps an existing registration without the long wait and says --force adds it',
  { skip: !posix },
  (t) => {
    const f = fixture(t);
    setCodexTable(f, '');
    const before = codexConfig(f);
    const out = f.install('--manual');
    assert.equal(codexAdds(f).length, 0);
    assert.equal(codexConfig(f), before);
    assert.match(out, /lacks the long consult_get wait.*--force adds it/);
    f.install('--manual', '--force');
    assert.equal(codexAdds(f).length, 1);
    assert.match(codexConfig(f), /tool_timeout_sec = 660\n/);
    assert.ok(codexConfig(f).includes(waitEnv(600000)));
    assert.match(codexConfig(f), /\[other\]\nkey = 1\n/, 'other tables survive the re-registration');
  },
);

test('POSIX manual Codex with the long wait already in place is left alone without a note', { skip: !posix }, (t) => {
  const f = fixture(t);
  setCodexTable(f, `tool_timeout_sec = 660\n${waitEnv(600000)}`);
  const before = codexConfig(f);
  const out = f.install('--manual');
  assert.equal(codexAdds(f).length, 0);
  assert.equal(codexConfig(f), before);
  assert.doesNotMatch(out, /lacks the long/);
});

test(
  "POSIX manual Codex --force keeps the user's own tool_timeout_sec and sets the wait 15 s under a short one",
  { skip: !posix },
  (t) => {
    const f = fixture(t);
    setCodexTable(f, `tool_timeout_sec = 120\n${waitEnv(45000)}`);
    f.install('--manual', '--force');
    assert.equal(codexAdds(f)[0][5], 'SEVERALLY_MAX_WAIT_MS=105000');
    const toml = codexConfig(f);
    assert.equal(toml.match(/tool_timeout_sec/g).length, 1);
    assert.match(toml, /tool_timeout_sec = 120\n/);
    assert.ok(toml.includes(waitEnv(105000)));
  },
);

test(
  "POSIX manual Codex --force with a long tool_timeout_sec of the user's keeps it and uses the full wait",
  { skip: !posix },
  (t) => {
    const f = fixture(t);
    setCodexTable(f, 'tool_timeout_sec = 900');
    f.install('--manual', '--force');
    assert.equal(codexAdds(f)[0][5], 'SEVERALLY_MAX_WAIT_MS=600000');
    assert.match(codexConfig(f), /tool_timeout_sec = 900\n/);
    assert.equal(codexConfig(f).match(/tool_timeout_sec/g).length, 1);
  },
);

test('POSIX manual Codex registers without the env when tool_timeout_sec cannot be written', { skip: !posix }, (t) => {
  const f = fixture(t);
  f.env.STUB_CODEX_NO_TABLE = '1'; // codex mcp add exits 0 but leaves no [mcp_servers.severally] table
  const out = f.install('--manual');
  const adds = codexAdds(f);
  assert.equal(adds.length, 2);
  assert.ok(adds[0].includes('--env'));
  assert.equal(adds[1].includes('--env'), false, 'the long wait is not left without its timeout');
  assert.deepEqual(adds[1].slice(-2), [process.execPath, path.join(f.dir, '.severally', 'runtime', 'severally-mcp.mjs')]);
  assert.match(out, /long consult_get wait was not set.*no \[mcp_servers\.severally\] table/);
  assert.doesNotMatch(codexConfig(f), /tool_timeout_sec/);
});

test('POSIX manual Codex dry-run changes nothing and says what it would write', { skip: !posix }, (t) => {
  const f = fixture(t);
  setCodexTable(f, '');
  const before = codexConfig(f);
  const out = f.install('--manual', '--dry-run', '--force');
  assert.equal(codexConfig(f), before);
  assert.equal(codexAdds(f).length, 0);
  assert.match(out, /\[dry-run\] codex mcp add severally --env SEVERALLY_MAX_WAIT_MS=600000/);
  assert.match(out, /\[dry-run\] write tool_timeout_sec = 660 into .*config\.toml under \[mcp_servers\.severally\]/);
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
  const added = fs
    .readFileSync(f.log, 'utf8')
    .slice(logBefore.length)
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse)
    .some((args) => args[0] === 'opencode' && args[1] === 'mcp' && args[2] === 'add');
  assert.equal(added, false, 'the exact server name must be recognised as already registered');
});

// opencode prints usage and exits 0 on flags a future version renames, so a
// zero exit from `mcp add` proves nothing: the installer must confirm the
// server is actually listed afterwards instead of trusting the exit code.
test('POSIX opencode add that did not register is reported as a failure', { skip: !posix }, (t) => {
  const f = fixture(t);
  f.env.STUB_ADD_SILENT = '1';
  assert.throws(
    () => f.install('--manual', '--force'),
    (err) => /not listed/.test(err.stdout),
  );
  const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(
    calls.some((args) => args[0] === 'opencode' && args[1] === 'mcp' && args[2] === 'add'),
    'the add must still have been attempted',
  );
});

// opencode's list can come back empty for a moment while the server is in its
// config: the installer asks again before calling it a failure.
test('POSIX opencode list that is briefly empty after add is asked again, not reported as a failure', { skip: !posix }, (t) => {
  const f = fixture(t);
  f.env.STUB_LIST_EMPTY_FOR = '3'; // the two checks before adding, and the first one after
  const out = f.install('--manual', '--force');
  assert.match(out, /Registering with OpenCode\n(?:.*\n)*? {3}registered\n/);
});

// If the list never shows it but the config holds exactly this install's
// command, the registration is in place: say so, with what the list said,
// and do not fail the install over it.
test('POSIX opencode registered in its config but missing from the list is a note, not a failure', { skip: !posix }, (t) => {
  const f = fixture(t);
  f.env.STUB_LIST_EMPTY_FOR = '99';
  const out = f.install('--manual', '--force');
  assert.match(out, /registered in OpenCode's global config, but `opencode mcp list` does not show it yet/);
  assert.match(out, /No MCP servers configured/);
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
  fs.writeFileSync(
    path.join(xdg, 'opencode', 'opencode.json'),
    JSON.stringify({ mcp: { servers: { severally: { command: stale } } } }),
  );
  f.env.STUB_ADD_SILENT = '1';
  assert.throws(
    () => f.install('--manual', '--force'),
    (err) => /not verified/.test(err.stdout),
  );
});

// A Claude Code that already has severally from the marketplace would load a
// second server and skill from the installer's copy (verified with claude
// 2.1.302: a user-scope registration and the plugin both connect). Claude Code
// is left to the marketplace, and the installer's earlier copy is removed.
for (const mode of [['--manual'], []]) {
  test(`POSIX ${mode[0] ?? 'plugin'} mode leaves Claude Code to a marketplace install`, { skip: !posix }, (t) => {
    const f = fixture(t);
    f.env.STUB_CLAUDE_PLUGINS = JSON.stringify([{ id: 'severally@severally', enabled: true }]);
    const skill = path.join(f.dir, '.claude', 'skills', 'severally');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'old copy');
    const out = f.install(...mode, '--force');
    const state = JSON.parse(fs.readFileSync(f.registry, 'utf8'));
    assert.equal(state.claude, undefined, 'no direct Claude Code registration');
    assert.equal(fs.existsSync(skill), false, 'the installer copy must not sit beside the marketplace plugin');
    assert.match(out, /marketplace/);
    // The marketplace copy is brought to this release in the same run.
    const calls = fs.readFileSync(f.log, 'utf8');
    assert.ok(calls.includes(JSON.stringify(['claude', 'plugin', 'marketplace', 'update', 'severally'])));
    assert.ok(calls.includes(JSON.stringify(['claude', 'plugin', 'update', 'severally@severally'])));
    assert.match(out, /updated severally@severally/);
    assert.deepEqual(state.agy, [process.execPath, path.join(f.dir, '.severally', 'runtime', 'severally-mcp.mjs')]);
  });
}

test('POSIX dry-run leaves runtime, marketplace and client configuration untouched', { skip: !posix }, (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.registry, 'utf8');
  f.install('--dry-run', '--force');
  assert.equal(fs.existsSync(path.join(f.dir, '.severally')), false);
  assert.equal(fs.existsSync(path.join(f.dir, '.claude')), false);
  assert.equal(fs.readFileSync(f.registry, 'utf8'), before);
});

// What `npx -p severally-mcp severally-install` runs: the package's bin, by a
// link in node_modules/.bin, from a folder npx may clear afterwards.
test(
  'POSIX severally-install through its npm bin link survives the package folder being removed',
  { skip: !posix },
  async (t) => {
    const f = fixture(t);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.bin['severally-install'], 'scripts/install.mjs');
    const link = path.join(f.dir, 'npx', 'node_modules', '.bin', 'severally-install');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(f.checkout, pkg.bin['severally-install']), link);
    const run = (...args) => execFileSync(link, args, { cwd: f.dir, env: f.env, encoding: 'utf8', stdio: 'pipe' });
    run('--dry-run', '--force');
    assert.equal(fs.existsSync(path.join(f.dir, '.severally')), false, '--dry-run changes nothing');
    run('--force');
    const after = JSON.parse(fs.readFileSync(f.registry, 'utf8'));
    run();
    assert.deepEqual(JSON.parse(fs.readFileSync(f.registry, 'utf8')), after, 'a second run registers nothing twice');
    fs.rmSync(f.checkout, { recursive: true, force: true });
    fs.rmSync(path.join(f.dir, 'npx'), { recursive: true, force: true });
    const client = new Client({ name: 'posix-npx-test', version: '1' });
    try {
      await client.connect(
        new StdioClientTransport({
          command: path.join(f.dir, 'prefix', 'bin', 'severally-mcp'),
          cwd: f.dir,
          env: f.env,
          stderr: 'pipe',
        }),
      );
      assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'consult_start'));
    } finally {
      await client.close();
    }
    assert.ok(fs.existsSync(path.join(f.dir, '.claude', 'skills', 'severally')), 'the Claude Code skill copy is in place');
  },
);

// The real route, against the packed tarball: npm pack, then npx with its own
// empty cache, which fetches the dependencies from the registry. Off by
// default for that reason; run it with SEVERALLY_NPX_CHECK=1 before a release.
test(
  'POSIX npx -p <packed tarball> severally-install installs, reruns, and outlives the npx cache',
  { skip: !posix || !process.env.SEVERALLY_NPX_CHECK },
  async (t) => {
    const f = fixture(t);
    const npmCli = f.env.INSTALL_NPM_CLI;
    // prepack (the build) prints to stdout too; the JSON is what follows it.
    const packed = execFileSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', f.dir], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = JSON.parse(packed.slice(packed.search(/^\[/m)));
    const tarball = path.join(f.dir, out[0].filename);
    const npx = (...args) =>
      execFileSync(
        process.execPath,
        [path.join(path.dirname(npmCli), 'npx-cli.js'), '-y', '-p', tarball, 'severally-install', ...args],
        { cwd: f.dir, env: f.env, encoding: 'utf8', stdio: 'pipe' },
      );
    npx('--dry-run', '--force');
    assert.equal(fs.existsSync(path.join(f.dir, '.severally')), false, '--dry-run changes nothing');
    npx('--force');
    const after = JSON.parse(fs.readFileSync(f.registry, 'utf8'));
    npx();
    assert.deepEqual(JSON.parse(fs.readFileSync(f.registry, 'utf8')), after, 'a second run registers nothing twice');
    fs.rmSync(path.join(f.dir, 'npm-cache'), { recursive: true, force: true });
    fs.rmSync(f.checkout, { recursive: true, force: true });
    const client = new Client({ name: 'posix-npx-real', version: '1' });
    try {
      await client.connect(
        new StdioClientTransport({
          command: path.join(f.dir, 'prefix', 'bin', 'severally-mcp'),
          cwd: f.dir,
          env: f.env,
          stderr: 'pipe',
        }),
      );
      assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'consult_start'));
    } finally {
      await client.close();
    }
    for (const skill of [
      '.claude/skills/severally/skills/claude/severally/SKILL.md',
      '.config/opencode/skills/severally/SKILL.md',
    ]) {
      assert.ok(fs.existsSync(path.join(f.dir, skill)), `${skill} is in place`);
    }
  },
);

test('POSIX an argument the installer does not know is refused before anything changes', { skip: !posix }, (t) => {
  const f = fixture(t);
  // What zsh or cmd.exe pass on from a pasted "# add --dry-run ..." comment.
  assert.throws(
    () => f.install('#', 'add', '--dry-run'),
    (err) => /unknown argument/.test(err.stderr),
  );
  assert.equal(fs.existsSync(path.join(f.dir, '.severally')), false);
});

test('POSIX an older severally-mcp in a node_modules/.bin on PATH does not stop the install', { skip: !posix }, async (t) => {
  // npx and npm run put the current folder's node_modules/.bin, and its
  // parents', first on PATH; the 1.11 README installed severally-mcp into one.
  const f = fixture(t);
  const projectBin = path.join(f.dir, 'old', 'node_modules', '.bin');
  fs.mkdirSync(projectBin, { recursive: true });
  fs.writeFileSync(path.join(projectBin, 'severally-mcp'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const env = { ...f.env, PATH: `${projectBin}:${f.env.PATH}` };
  execFileSync(process.execPath, [path.join(f.checkout, 'scripts', 'install.mjs'), '--force'], {
    cwd: f.checkout,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  assert.ok(fs.existsSync(path.join(f.dir, '.severally', 'marketplace')), 'the install ran to the end');
});

test(
  'POSIX the installer run from a global npm install of the package refuses before changing anything',
  { skip: !posix },
  (t) => {
    const f = fixture(t);
    const globalPkg = path.join(f.dir, 'prefix', 'lib', 'node_modules', 'severally-mcp');
    fs.mkdirSync(path.dirname(globalPkg), { recursive: true });
    fs.cpSync(f.checkout, globalPkg, { recursive: true, verbatimSymlinks: true });
    assert.throws(
      () =>
        execFileSync(process.execPath, [path.join(globalPkg, 'scripts', 'install.mjs')], {
          cwd: f.dir,
          env: f.env,
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      (err) => /global npm install of severally-mcp/.test(err.stderr),
    );
    assert.equal(fs.existsSync(path.join(f.dir, '.severally')), false);
  },
);

// `npx -y severally-mcp@latest install` runs the package's severally-mcp bin
// with `install`: the npm package hands it to the installer, while a bundled
// server copy, which has no installer beside it, says what to run instead.
test('severally-mcp install runs the installer from the package, and points elsewhere from a server copy', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.throws(
    () =>
      execFileSync(process.execPath, [path.join(root, 'bin', 'severally-mcp.mjs'), 'install', '--bogus'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    (err) => err.status === 2 && /severally-install: unknown argument\(s\) "--bogus"/.test(err.stderr),
  );
  assert.throws(
    () =>
      execFileSync(process.execPath, [path.join(root, 'plugins', 'severally', 'dist', 'severally-mcp.mjs'), 'install'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    (err) => err.status === 1 && /npx -y severally-mcp@latest install/.test(err.stderr),
  );
});

test('POSIX OpenCode registered before the long wait is kept, and the installer says --force adds it', { skip: !posix }, (t) => {
  const f = fixture(t);
  const cfgDir = path.join(f.dir, '.config', 'opencode');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'opencode.json'), JSON.stringify({ mcp: { severally: { command: ['node', 'x'] } } }));
  fs.writeFileSync(f.registry, JSON.stringify({ opencode: ['node', 'x'] }));
  const out = f.install('--manual');
  assert.match(out, /OpenCode[\s\S]*lacks the long consult_get wait[\s\S]*--force adds it/);
});

// Without a global severally-mcp command (npm needs sudo, or its folder is not
// on PATH) the install still finishes: Codex is registered directly, as
// --manual does, since only its plugin needs the global command.
for (const [why, setup] of [
  [
    'npm cannot install globally',
    (f) => {
      f.env.STUB_NPM_FAIL = '1';
    },
  ],
  [
    "npm's global folder is not on PATH",
    (f) => {
      f.env.PATH = f.env.PATH.replace(`${path.join(f.dir, 'prefix', 'bin')}:`, '');
    },
  ],
]) {
  test(`POSIX plugin mode registers Codex directly when ${why}`, { skip: !posix }, (t) => {
    const f = fixture(t);
    setup(f);
    const out = f.install('--force');
    const state = JSON.parse(fs.readFileSync(f.registry, 'utf8'));
    const runtime = path.join(f.dir, '.severally', 'runtime', 'severally-mcp.mjs');
    assert.deepEqual(state.codex, [process.execPath, runtime], 'Codex is registered with the runtime itself');
    assert.equal(state.marketplace, undefined, 'and not through the plugin that would need the global command');
    assert.match(out, /Codex will be registered directly/);
    assert.ok(fs.existsSync(path.join(f.dir, '.codex', 'skills', 'severally', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(f.dir, '.claude', 'skills', 'severally')), 'Claude Code still gets the plugin');
  });
}

// The runtime goes global under its own name, so npx never mistakes it for the
// npm package; the copy an older install put there under the package's name goes.
test('POSIX the runtime replaces a global severally-mcp package with severally-runtime', { skip: !posix }, (t) => {
  const f = fixture(t);
  const lib = path.join(f.dir, 'prefix', 'lib', 'node_modules');
  const old = path.join(f.dir, 'old-runtime');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(
    path.join(old, 'package.json'),
    JSON.stringify({ name: 'severally-mcp', version: '2.3.1', bin: { 'severally-mcp': 'x.mjs' } }),
  );
  fs.writeFileSync(path.join(old, 'x.mjs'), '');
  execFileSync(
    process.execPath,
    [f.env.INSTALL_NPM_CLI, 'install', '-g', old, '--install-links=false', '--prefix', path.join(f.dir, 'prefix')],
    { env: f.env, stdio: 'pipe' },
  );
  assert.ok(fs.existsSync(path.join(lib, 'severally-mcp')));
  f.install('--force');
  assert.equal(fs.existsSync(path.join(lib, 'severally-mcp')), false);
  assert.equal(fs.realpathSync(path.join(lib, 'severally-runtime')), fs.realpathSync(path.join(f.dir, '.severally', 'runtime')));
  assert.equal(
    fs.realpathSync(path.join(f.dir, 'prefix', 'bin', 'severally-mcp')),
    fs.realpathSync(path.join(f.dir, '.severally', 'runtime', 'severally-mcp.mjs')),
  );
});

// The five tools that send nothing out are allowed in Claude Code only when
// asked (a prompt at a terminal, or --allow-local-tools); consult_start never.
test(
  'POSIX --allow-local-tools allows the five local tools in Claude Code, once, keeping other settings',
  { skip: !posix },
  (t) => {
    const f = fixture(t);
    const settings = path.join(f.dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ model: 'sonnet', permissions: { allow: ['Bash(ls)'] } }));
    const out = f.install('--allow-local-tools');
    const saved = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.equal(saved.model, 'sonnet');
    assert.deepEqual(saved.permissions.allow, [
      'Bash(ls)',
      ...['get', 'list', 'cancel', 'record', 'export'].map((t) => `mcp__plugin_severally_severally__consult_${t}`),
    ]);
    assert.match(out, /allowed in/);
    f.install('--allow-local-tools');
    assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow.length, 6, 'a rerun adds nothing twice');
    const manual = fixture(t);
    manual.install('--manual', '--allow-local-tools');
    const allow = JSON.parse(fs.readFileSync(path.join(manual.dir, '.claude', 'settings.json'), 'utf8')).permissions.allow;
    assert.ok(allow.includes('mcp__severally__consult_get') && !allow.some((a) => a.endsWith('consult_start')));
  },
);

test(
  'POSIX without a terminal or --allow-local-tools, Claude Code settings are left alone and the flag is named',
  { skip: !posix },
  (t) => {
    const f = fixture(t);
    const out = f.install();
    assert.equal(fs.existsSync(path.join(f.dir, '.claude', 'settings.json')), false);
    assert.match(out, /rerun with --allow-local-tools/);
  },
);

test('POSIX an opencode without --global is registered by a second add without it', { skip: !posix }, (t) => {
  const f = fixture(t);
  f.env.STUB_OPENCODE_NO_GLOBAL = '1';
  const out = f.install('--force');
  const runtime = path.join(f.dir, '.severally', 'runtime', 'severally-mcp.mjs');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.registry, 'utf8')).opencode, [process.execPath, runtime]);
  assert.doesNotMatch(out, /OpenCode[\s\S]*failed/);
  assert.ok(
    fs
      .readFileSync(f.log, 'utf8')
      .includes(
        JSON.stringify([
          'opencode',
          'mcp',
          'add',
          'severally',
          '--env',
          'SEVERALLY_MAX_WAIT_MS=600000',
          '--',
          process.execPath,
          runtime,
        ]),
      ),
  );
});

// The next step must refer to clients this run actually registered.
test('POSIX install summary guides the installed client to a first consultation', { skip: !posix }, (t) => {
  const f = fixture(t);
  for (const cli of ['claude', 'agy', 'opencode']) fs.rmSync(path.join(f.dir, 'bin', cli));
  const out = f.install('--manual', '--force');
  const summary = out.slice(out.lastIndexOf('Done'));
  assert.match(summary, /Ready clients: Codex/);
  assert.match(summary, /Restart.*Codex/);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.ok(summary.includes(`severally-mcp@${version} status`));
  assert.match(summary, /ask Codex.*100.*requests.*minute/i);
  assert.doesNotMatch(summary, /claude|agy|opencode|npm run build/);
});

test('POSIX dry-run summary describes planned clients without claiming an install', { skip: !posix }, (t) => {
  const f = fixture(t);
  const out = f.install('--manual', '--dry-run', '--force');
  const summary = out.slice(out.lastIndexOf('Done'));
  assert.match(summary, /Planned clients:/);
  assert.doesNotMatch(summary, /Ready clients:/);
});
