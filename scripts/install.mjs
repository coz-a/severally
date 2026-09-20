#!/usr/bin/env node
// Installs severally into all four clients: Claude Code, Codex, Antigravity,
// OpenCode.
//
// Two modes:
//   plugin (default) - installs plugins/severally as a plugin in Claude Code
//                      (~/.claude/skills/severally, skills-dir plugin, no
//                      marketplace) and in Codex (a copied local marketplace
//                      under ~/.severally/marketplace). Antigravity has no verified
//                      plugin-install path yet, and OpenCode has no plugin
//                      mechanism at all, so both are registered directly
//                      in both modes: `agy mcp add` / `opencode mcp add`
//                      plus a skill copy, same as --manual mode below.
//   --manual         - (default on Windows) register the MCP server with each client's own `mcp
//                      add` (`agy mcp add` for Antigravity) and copy each
//                      client's skill by hand.
//
// In plugin mode the global npm install happens unless --skip-global is set:
// Codex can only launch a plugin MCP
// server by bare executable name from PATH (verified: contained "./" paths and
// ${PLUGIN_ROOT} substitution do not work in codex 0.153.4).
// All platforms copy the bundle into ~/.severally/runtime. Plugin mode also
// copies its marketplace into ~/.severally/marketplace; no installed path
// points back to this checkout.
//
// Existing configuration is preserved: client config is changed through each
// client's own CLI rather than hand-edited, and every file this touches is
// backed up first under ~/.severally/backups/<timestamp>/.
//
//   node scripts/install.mjs [--dry-run] [--manual] [--skip-global] [--force]

import { copyTree, execCommandSync, findCommand } from '../src/platform.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(root, 'plugins', 'severally');
const argv = new Set(process.argv.slice(2));
const dryRun = argv.has('--dry-run');
const skipGlobal = argv.has('--skip-global');
const force = argv.has('--force');
// Native Windows clients cannot all launch npm .cmd shims as MCP servers.
// Direct registration uses node.exe plus an absolute script path instead.
const mode = argv.has('--manual') || process.platform === 'win32' ? 'manual' : 'plugin';

const home = os.homedir();
// opencode resolves its global paths through xdg-basedir: XDG_CONFIG_HOME, when
// set, decides where opencode.json and its skills live. The installer must read
// and write the same place the CLI resolves, or it would back up and edit a
// file opencode never looks at. The other clients keep their own conventions
// (~/.claude, ~/.codex/CODEX_HOME, ~/.gemini), which no XDG variable redirects.
const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(home, '.severally', 'backups', stamp);
let keptRegistrations = false;

const log = (...a) => console.log(...a);
const step = (s) => log(`\n== ${s}`);

function run(cmd, args, opts = {}) {
  const { real, ...spawnOpts } = opts;
  if (dryRun && !real) {
    log(`   [dry-run] ${cmd} ${args.join(' ')}`);
    return '';
  }
  return execCommandSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOpts });
}

function tryRun(cmd, args, opts) {
  try {
    return { ok: true, out: run(cmd, args, opts) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || String(err.message) };
  }
}

// Backup names are derived from the whole path: two different clients both
// hold a "severally" directory, and one must not overwrite the other.
function backupName(target) {
  return path
    .relative(home, target)
    .replace(/^\.\.[\\/]/, 'abs/')
    .replace(/[\\/]/g, '_')
    .replace(/^\./, '');
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  if (dryRun) { log(`   [dry-run] backup ${file}`); return null; }
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const dest = path.join(backupDir, backupName(file));
  // Several client operations can touch the same config in one install.
  // Keep the first snapshot, before any of those operations changed it.
  if (fs.existsSync(dest)) return dest;
  fs.copyFileSync(file, dest);
  return dest;
}

function backupTree(dir) {
  if (!fs.existsSync(dir)) return null;
  if (dryRun) { log(`   [dry-run] backup ${dir}`); return null; }
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const dest = path.join(backupDir, backupName(dir));
  copyTree(dir, dest);
  return dest;
}

// Read-only probes run even under --dry-run, so the plan it prints is accurate.
function which(bin) {
  return findCommand(bin);
}

// ---------------------------------------------------------------- server install
function installRuntime() {
  const source = path.join(PLUGIN, 'dist', 'severally-mcp.mjs');
  const installed = path.join(home, '.severally', 'runtime', 'severally-mcp.mjs');
  if (!fs.existsSync(source)) throw new Error(`Missing server bundle: ${source}. Run npm run build first.`);
  if (dryRun) {
    backup(installed);
    log(`   [dry-run] copy ${source} -> ${installed}`);
    return installed;
  }
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  // Validate a staged copy before replacing the working runtime. The bundle
  // contains its dependencies, so it needs neither the checkout nor npm.
  const stagedDir = fs.mkdtempSync(path.join(path.dirname(installed), '.install-'));
  const staged = path.join(stagedDir, 'severally-mcp.mjs');
  try {
    fs.copyFileSync(source, staged);
    run(process.execPath, ['--check', staged], { real: true });
    backup(installed);
    fs.renameSync(staged, installed);
  } finally {
    fs.rmSync(stagedDir, { recursive: true, force: true });
  }
  log(`   installed: ${installed}`);
  return installed;
}

step(`Installing the standalone MCP server (mode: ${mode})`);
const serverCommand = [process.execPath, installRuntime()];
const runtimeDir = path.dirname(serverCommand[1]);
const marketplaceRoot = path.join(home, '.severally', 'marketplace');

if (mode === 'plugin') {
  // npm may symlink a directory install. Its source must therefore be the
  // persistent runtime, never the user's disposable checkout.
  const packageFile = path.join(runtimeDir, 'package.json');
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!dryRun) {
    backup(packageFile);
    fs.writeFileSync(packageFile, `${JSON.stringify({ name: metadata.name, version: metadata.version,
      type: 'module', bin: { 'severally-mcp': 'severally-mcp.mjs' } }, null, 2)}\n`);
    fs.chmodSync(serverCommand[1], 0o755);
  }
  if (skipGlobal) {
    const existing = which('severally-mcp');
    if (!dryRun && (!existing || fs.realpathSync(existing) !== fs.realpathSync(serverCommand[1]))) {
      throw new Error('--skip-global requires severally-mcp on PATH to point to the installed runtime. Omit --skip-global or use --manual.');
    }
    log('   --skip-global: using the existing runtime command');
  } else {
    run('npm', ['install', '-g', runtimeDir, '--install-links=false'], { cwd: dryRun ? root : runtimeDir });
    if (which('nodenv')) tryRun('nodenv', ['rehash']);
    if (!dryRun) {
      const installedCommand = which('severally-mcp');
      if (!installedCommand || fs.realpathSync(installedCommand) !== fs.realpathSync(serverCommand[1])) {
        throw new Error('The installed severally-mcp runtime command is not first on PATH. Fix PATH and rerun, or use --manual.');
      }
    }
  }
  if (dryRun) {
    backupTree(marketplaceRoot);
    log(`   [dry-run] copy plugin and marketplace -> ${marketplaceRoot}`);
  } else {
    // Replace the complete owned tree: merging would retain hooks or skills
    // removed in a newer release. Keep the old tree until the new one lands.
    const staging = fs.mkdtempSync(path.join(home, '.severally', '.marketplace-'));
    const next = path.join(staging, 'next');
    const previous = path.join(staging, 'previous');
    let installed = false;
    try {
      fs.mkdirSync(path.join(next, '.agents', 'plugins'), { recursive: true });
      copyTree(PLUGIN, path.join(next, 'plugins', 'severally'));
      fs.copyFileSync(path.join(root, '.agents', 'plugins', 'marketplace.json'),
        path.join(next, '.agents', 'plugins', 'marketplace.json'));
      backupTree(marketplaceRoot);
      if (fs.existsSync(marketplaceRoot)) fs.renameSync(marketplaceRoot, previous);
      try {
        fs.renameSync(next, marketplaceRoot);
      } catch (error) {
        if (fs.existsSync(previous)) fs.renameSync(previous, marketplaceRoot);
        throw error;
      }
      installed = true;
    } finally {
      if (installed || !fs.existsSync(previous)) fs.rmSync(staging, { recursive: true, force: true });
      else log(`   Previous marketplace preserved for recovery: ${previous}`);
    }
  }
} else {
  log('   Global npm installation is not needed in manual mode (--skip-global is optional).');
}
log(`   server command: ${JSON.stringify(serverCommand)}`);

const codexHome = process.env.CODEX_HOME ?? path.join(home, '.codex');
const claudeSkillsDir = path.join(home, '.claude', 'skills');

// ---------------------------------------------------------------- clients
// Each row fully describes how to register a client's MCP server directly
// (through the client's own `mcp add`) and place its skill. This is the one
// place that knows how severally is installed outside of a bundled
// plugin: --manual mode installs every row this way, and the default plugin
// mode falls back to the Antigravity and OpenCode rows alone, since those
// two have no verified plugin-install path.
const CLIENTS = [
  {
    bin: 'claude',
    label: 'Claude Code',
    backup: [path.join(home, '.claude.json')],
    // `claude mcp get` exits non-zero when the server is not registered.
    isRegistered: () => tryRun('claude', ['mcp', 'get', 'severally'], { real: true }).ok,
    remove: () => tryRun('claude', ['mcp', 'remove', '--scope', 'user', 'severally']),
    add: (bin) => tryRun('claude', ['mcp', 'add', '--scope', 'user', 'severally', '--', ...bin]),
    skillFrom: path.join(PLUGIN, 'skills', 'claude', 'severally'),
    skillTo: path.join(claudeSkillsDir, 'severally'),
  },
  {
    bin: 'codex',
    label: 'Codex',
    backup: [path.join(codexHome, 'config.toml')],
    isRegistered: () => tryRun('codex', ['mcp', 'get', 'severally'], { real: true }).ok,
    remove: () => tryRun('codex', ['mcp', 'remove', 'severally']),
    add: (bin) => tryRun('codex', ['mcp', 'add', 'severally', '--', ...bin]),
    skillFrom: path.join(PLUGIN, 'skills', 'codex', 'severally'),
    skillTo: path.join(codexHome, 'skills', 'severally'),
  },
  {
    bin: 'agy',
    label: 'Antigravity',
    backup: [
      path.join(home, '.gemini', 'config', 'mcp_config.json'),
      path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    ],
    // agy has no `mcp get`; list and look for the name.
    isRegistered: () => {
      const r = tryRun('agy', ['mcp', 'list'], { real: true });
      return r.ok && /severally/.test(r.out);
    },
    remove: () => tryRun('agy', ['mcp', 'remove', 'severally']),
    add: (bin) => tryRun('agy', ['mcp', 'add', 'severally', ...bin]),
    skillFrom: path.join(PLUGIN, 'skills', 'antigravity', 'severally'),
    skillTo: path.join(home, '.gemini', 'config', 'skills', 'severally'),
  },
  {
    bin: 'opencode',
    label: 'OpenCode',
    backup: [
      path.join(xdgConfig, 'opencode', 'opencode.json'),
      path.join(xdgConfig, 'opencode', 'opencode.jsonc'),
    ],
    // opencode has no `mcp get`; list and look for the exact server name.
    // `mcp list` prints through the prompt library, but the per-server lines
    // still reach stdout when stdout is not a TTY ("✓ severally  connected").
    // The name must stand alone: a substring match would accept a lookalike
    // server such as "severally-old" as this one.
    isRegistered: () => {
      const r = tryRun('opencode', ['mcp', 'list'], { real: true });
      return r.ok && /(^|\s)severally(\s|$)/.test(r.out);
    },
    // opencode has no `mcp remove`; `mcp add` with the same name replaces
    // the entry, so a --force re-registration needs no removal first.
    // Uninstall is a hand edit of the global config (see the README).
    // --global matters: without it opencode 1.18.31 writes the registration
    // into the current project's opencode.json, and the server would be
    // reachable only inside whatever directory the installer happened to
    // run from.
    remove: () => ({ ok: true, out: 'opencode has no mcp remove; re-adding replaces the entry' }),
    add: (bin) => tryRun('opencode', ['mcp', 'add', 'severally', '--global', '--', ...bin]),
    skillFrom: path.join(PLUGIN, 'skills', 'opencode', 'severally'),
    skillTo: path.join(xdgConfig, 'opencode', 'skills', 'severally'),
  },
];
const antigravityClient = CLIENTS.find((c) => c.bin === 'agy');
const opencodeClient = CLIENTS.find((c) => c.bin === 'opencode');

// Registers one client's MCP server directly (through its own `mcp add`) and
// copies its skill, backing up everything it touches first. Shared by plugin
// mode (Antigravity only) and --manual mode (all three clients).
function installClientDirectly(client, bin) {
  step(`Registering with ${client.label}`);
  if (!which(client.bin)) {
    log(`   ${client.bin} CLI not found on PATH — skipped`);
    return;
  }
  for (const f of client.backup) backup(f);
  if (client.isRegistered() && !force) {
    keptRegistrations = true;
    log('   already registered; leaving it as it is (use --force to re-register)');
  } else {
    if (client.isRegistered()) client.remove();
    const r = client.add(bin);
    log(r.ok ? '   registered' : `   failed: ${r.out}`);
    if (!r.ok) process.exitCode = 1;
  }

  const parent = path.dirname(client.skillTo);
  if (!fs.existsSync(parent) && !dryRun) fs.mkdirSync(parent, { recursive: true });
  const saved = backupTree(client.skillTo);
  if (saved) log(`   backed up the existing ${client.label} skill to ${saved}`);
  if (dryRun) { log(`   [dry-run] copy ${client.skillFrom} -> ${client.skillTo}`); return; }
  fs.rmSync(client.skillTo, { recursive: true, force: true });
  copyTree(client.skillFrom, client.skillTo);
  log(`   skill: ${client.skillTo}`);
}

if (mode === 'plugin') {
  // ------------------------------------------------------------- plugin mode
  step('Installing the plugin into Claude Code (skills-dir plugin, no marketplace)');
  const target = path.join(claudeSkillsDir, 'severally');
  const saved = backupTree(target);
  if (saved) log(`   backed up the existing ${target} to ${saved}`);
  if (dryRun) {
    log(`   [dry-run] copy ${PLUGIN} -> ${target}`);
  } else {
    fs.mkdirSync(claudeSkillsDir, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    copyTree(PLUGIN, target);
    log(`   installed: ${target} (loads as severally@skills-dir)`);
  }
  // A user-scope MCP registration would duplicate the one the plugin provides.
  if (which('claude')) {
    const dup = tryRun('claude', ['mcp', 'get', 'severally'], { real: true });
    if (dup.ok) {
      backup(path.join(home, '.claude.json'));
      const r = tryRun('claude', ['mcp', 'remove', '--scope', 'user', 'severally']);
      log(r.ok ? '   removed the duplicate user-scope MCP registration' : `   could not remove the duplicate registration: ${r.out}`);
    }
  }

  step('Installing the plugin into Codex (managed local marketplace)');
  if (!which('codex')) {
    log('   codex CLI not found on PATH — skipped');
  } else {
    backup(path.join(codexHome, 'config.toml'));
    const marketplace = 'severally-local';
    const known = tryRun('codex', ['plugin', 'marketplace', 'list'], { real: true });
    if (!known.ok) throw new Error(`Could not inspect Codex marketplaces: ${known.out}`);
    // Refresh our own registration even when already present: older installs
    // registered the checkout here. Reusing it would retain that dependency.
    if (known.out.includes(marketplace)) {
      tryRun('codex', ['plugin', 'remove', 'severally', '--marketplace', marketplace]);
      run('codex', ['plugin', 'marketplace', 'remove', marketplace]);
    }
    run('codex', ['plugin', 'marketplace', 'add', marketplaceRoot]);
    log(`   marketplace added: ${marketplace} -> ${marketplaceRoot}`);
    const r = tryRun('codex', ['plugin', 'add', `severally@${marketplace}`]);
    log(r.ok ? '   plugin installed' : `   plugin install failed: ${r.out}`);
    if (!r.ok) process.exitCode = 1;
    // Same duplication concern on the Codex side.
    const dup = tryRun('codex', ['mcp', 'get', 'severally'], { real: true });
    if (dup.ok) {
      const rm = tryRun('codex', ['mcp', 'remove', 'severally']);
      log(rm.ok ? '   removed the duplicate global MCP registration' : `   could not remove the duplicate registration: ${rm.out}`);
    }
    const strayCodexSkill = path.join(codexHome, 'skills', 'severally');
    if (fs.existsSync(strayCodexSkill)) {
      const s2 = backupTree(strayCodexSkill);
      if (!dryRun) fs.rmSync(strayCodexSkill, { recursive: true, force: true });
      log(`   removed the hand-copied skill (the plugin supplies it); backup: ${s2}`);
    }
  }

  // Antigravity has no verified plugin-install mechanism (no marketplace or
  // plugin-add path confirmed against agy 1.1.28), and OpenCode has no plugin
  // mechanism at all, so both are registered directly here too -- the same
  // `mcp add` + skill copy that --manual mode uses for every client.
  log('\nAntigravity and OpenCode have no plugin-install path; registering them directly.');
  installClientDirectly(antigravityClient, serverCommand);
  installClientDirectly(opencodeClient, serverCommand);
} else {
  // ------------------------------------------------------------- manual mode
  // A previous plugin installation would otherwise retain its old checkout
  // marketplace alongside the new direct server registration.
  if (which('codex')) {
    const known = tryRun('codex', ['plugin', 'marketplace', 'list'], { real: true });
    if (known.ok && known.out.includes('severally-local')) {
      backup(path.join(codexHome, 'config.toml'));
      tryRun('codex', ['plugin', 'remove', 'severally', '--marketplace', 'severally-local']);
      run('codex', ['plugin', 'marketplace', 'remove', 'severally-local']);
    }
  }
  for (const client of CLIENTS) installClientDirectly(client, serverCommand);
}

// ---------------------------------------------------------------- summary
step('Done');
if (fs.existsSync(backupDir)) log(`   backups: ${backupDir}`);
if (keptRegistrations) {
  log('   Existing MCP registrations were kept. Rerun with --force before deleting the source checkout.');
} else if (!dryRun && !process.exitCode) {
  log('   The registered server and skills no longer depend on the source checkout.');
}
log(mode === 'plugin' ? `
Verify with:
  claude plugin details severally
  codex  plugin list
  agy    mcp list
  opencode mcp list

Restart any running client session to pick the plugin up. In Claude Code the tools then appear as
mcp__plugin_severally_severally__consult_start / _get / _cancel / _list.

Re-run this after "npm run build" to push an updated plugin to both clients (Antigravity and
OpenCode are registered directly each run, so a re-run always refreshes them too).` : `
Verify with:
  claude mcp get severally
  codex  mcp get severally
  agy    mcp list
  opencode mcp list

In a new Claude Code session the tools appear as mcp__severally__consult_start / _get / _cancel / _list.
Restart any running client session to pick the server up.`);
