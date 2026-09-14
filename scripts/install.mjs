#!/usr/bin/env node
// Installs severally into all three clients: Claude Code, Codex, Antigravity.
//
// Two modes:
//   plugin (default) - installs plugins/severally as a plugin in Claude Code
//                      (~/.claude/skills/severally, skills-dir plugin, no
//                      marketplace) and in Codex (repo-local marketplace in
//                      .agents/plugins). Antigravity has no verified
//                      plugin-install path yet, so it is registered directly
//                      in both modes: `agy mcp add` plus a skill copy, same
//                      as --manual mode below.
//   --manual         - register the MCP server with each client's own `mcp
//                      add` (`agy mcp add` for Antigravity) and copy each
//                      client's skill by hand.
//
// Either way the global npm install happens: Codex can only launch a plugin MCP
// server by bare executable name from PATH (verified: contained "./" paths and
// ${PLUGIN_ROOT} substitution do not work in codex 0.153.4).
//
// Existing configuration is preserved: client config is changed through each
// client's own CLI rather than hand-edited, and every file this touches is
// backed up first under ~/.severally/backups/<timestamp>/.
//
//   node scripts/install.mjs [--dry-run] [--manual] [--skip-global] [--force]

import { execFileSync } from 'node:child_process';
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
const mode = argv.has('--manual') ? 'manual' : 'plugin';

const home = os.homedir();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(home, '.severally', 'backups', stamp);

const log = (...a) => console.log(...a);
const step = (s) => log(`\n== ${s}`);

function run(cmd, args, opts = {}) {
  const { real, ...spawnOpts } = opts;
  if (dryRun && !real) {
    log(`   [dry-run] ${cmd} ${args.join(' ')}`);
    return '';
  }
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...spawnOpts });
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
  fs.copyFileSync(file, dest);
  return dest;
}

function backupTree(dir) {
  if (!fs.existsSync(dir)) return null;
  if (dryRun) { log(`   [dry-run] backup ${dir}`); return null; }
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const dest = path.join(backupDir, backupName(dir));
  fs.cpSync(dir, dest, { recursive: true });
  return dest;
}

// Read-only probes run even under --dry-run, so the plan it prints is accurate.
function which(bin) {
  const r = tryRun('sh', ['-c', `command -v ${bin}`], { real: true });
  return r.ok ? r.out.trim() : null;
}

// ---------------------------------------------------------------- global install
step(`Installing the MCP server globally (mode: ${mode})`);
let serverBin = which('severally-mcp');
if (skipGlobal) {
  log('   --skip-global: leaving the global install alone');
} else {
  const r = tryRun('npm', ['install', '-g', root], { cwd: root });
  if (!r.ok) {
    log(`   npm install -g failed:\n${r.out}`);
    process.exitCode = 1;
  } else {
    log('   npm install -g ok');
    if (which('nodenv')) tryRun('nodenv', ['rehash']);
    serverBin = which('severally-mcp') ?? serverBin;
  }
}
if (!serverBin) {
  // Fall back to the checkout so registration still points at something runnable.
  serverBin = path.join(root, 'bin', 'severally-mcp.mjs');
  log(`   ${dryRun ? 'note' : 'WARNING'}: severally-mcp is not on PATH; registering ${serverBin} instead`);
}
log(`   server command: ${serverBin}`);

const codexHome = process.env.CODEX_HOME ?? path.join(home, '.codex');
const claudeSkillsDir = path.join(home, '.claude', 'skills');

// ---------------------------------------------------------------- clients
// Each row fully describes how to register a client's MCP server directly
// (through the client's own `mcp add`) and place its skill. This is the one
// place that knows how severally is installed outside of a bundled
// plugin: --manual mode installs every row this way, and the default plugin
// mode falls back to the Antigravity row alone, since agy has no verified
// plugin-install path yet.
const CLIENTS = [
  {
    bin: 'claude',
    label: 'Claude Code',
    backup: [path.join(home, '.claude.json')],
    // `claude mcp get` exits non-zero when the server is not registered.
    isRegistered: () => tryRun('claude', ['mcp', 'get', 'severally'], { real: true }).ok,
    remove: () => tryRun('claude', ['mcp', 'remove', '--scope', 'user', 'severally']),
    add: (bin) => tryRun('claude', ['mcp', 'add', '--scope', 'user', 'severally', '--', bin]),
    skillFrom: path.join(PLUGIN, 'skills', 'claude', 'severally'),
    skillTo: path.join(claudeSkillsDir, 'severally'),
  },
  {
    bin: 'codex',
    label: 'Codex',
    backup: [path.join(codexHome, 'config.toml')],
    isRegistered: () => tryRun('codex', ['mcp', 'get', 'severally'], { real: true }).ok,
    remove: () => tryRun('codex', ['mcp', 'remove', 'severally']),
    add: (bin) => tryRun('codex', ['mcp', 'add', 'severally', '--', bin]),
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
    add: (bin) => tryRun('agy', ['mcp', 'add', 'severally', bin]),
    skillFrom: path.join(PLUGIN, 'skills', 'antigravity', 'severally'),
    skillTo: path.join(home, '.gemini', 'config', 'skills', 'severally'),
  },
];
const antigravityClient = CLIENTS.find((c) => c.bin === 'agy');

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
  fs.cpSync(client.skillFrom, client.skillTo, { recursive: true });
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
    fs.cpSync(PLUGIN, target, { recursive: true });
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

  step('Installing the plugin into Codex (repo-local marketplace)');
  if (!which('codex')) {
    log('   codex CLI not found on PATH — skipped');
  } else {
    backup(path.join(codexHome, 'config.toml'));
    const marketplace = 'severally-local';
    const known = tryRun('codex', ['plugin', 'marketplace', 'list'], { real: true });
    if (!known.out.includes(marketplace)) {
      const r = tryRun('codex', ['plugin', 'marketplace', 'add', root]);
      log(r.ok ? `   marketplace added: ${marketplace} -> ${root}` : `   marketplace add failed: ${r.out}`);
    } else {
      log(`   marketplace ${marketplace} already configured`);
    }
    tryRun('codex', ['plugin', 'remove', 'severally', '--marketplace', marketplace]);
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
  // plugin-add path confirmed against agy 1.1.28), so it is registered
  // directly here too -- the same `mcp add` + skill copy that --manual mode
  // uses for every client.
  log('\nAntigravity has no verified plugin-install path yet; registering it directly.');
  installClientDirectly(antigravityClient, serverBin);
} else {
  // ------------------------------------------------------------- manual mode
  for (const client of CLIENTS) installClientDirectly(client, serverBin);
}

// ---------------------------------------------------------------- summary
step('Done');
if (fs.existsSync(backupDir)) log(`   backups: ${backupDir}`);
log(mode === 'plugin' ? `
Verify with:
  claude plugin details severally
  codex  plugin list
  agy    mcp list
  node ${path.join(root, 'scripts', 'live-check.mjs')} --target claude-code

Restart any running client session to pick the plugin up. In Claude Code the tools then appear as
mcp__plugin_severally_severally__consult_start / _get / _cancel / _list.

Re-run this after "npm run build" to push an updated plugin to both clients (Antigravity is
registered directly each run, so a re-run always refreshes it too).` : `
Verify with:
  claude mcp get severally
  codex  mcp get severally
  agy    mcp list
  node ${path.join(root, 'scripts', 'live-check.mjs')} --target antigravity

In a new Claude Code session the tools appear as mcp__severally__consult_start / _get / _cancel / _list.
Restart any running client session to pick the server up.`);
